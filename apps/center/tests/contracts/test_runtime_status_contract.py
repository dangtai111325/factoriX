"""Characterization: heartbeat rows (`collector_runtime_status.queues_json`), the acquisition connection report
and the config snapshot revision (contracts runtime-status.md, collector-report.md, config-revision.md).
"""

from __future__ import annotations

import ast
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from factorix.domain import health as H

REPO = Path(__file__).resolve().parents[4]
ACQ = REPO / "apps" / "acquisition" / "src" / "factorix_acquisition"
CENTER = REPO / "apps" / "center" / "src" / "factorix"
NOW = datetime(2026, 11, 18, 6, 0, 0, tzinfo=timezone.utc)


def _function(path: Path, name: str) -> ast.AST:
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"{name} not found in {path.name}; update the contract test")


# ---------------------------------------------------------------------------- queues_json


def test_acquisition_queues_json_top_level_keys() -> None:
    """CT-18: besides ``publisher`` and ``runtime`` the top level holds MQTT counters keyed by connection UUID."""
    fn = _function(ACQ / "runtime.py", "send_heartbeat")
    subscripts = {
        node.slice.value
        for node in ast.walk(fn)
        if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Store)
        and isinstance(node.value, ast.Name) and node.value.id == "queues" and isinstance(node.slice, ast.Constant)
    }
    assert subscripts == {"publisher", "runtime"}


def test_acquisition_runtime_block_round_trips_to_the_center_sweep() -> None:
    from factorix_acquisition.runtime import AcquisitionRuntime
    from factorix.transport.app import _acquisition_runtime_info

    running = SimpleNamespace(done=lambda: False)
    stub = SimpleNamespace(
        specs={"j1": SimpleNamespace(connection_id="c1", job_id="j1"), "j2": SimpleNamespace(connection_id="c2", job_id="j2")},
        job_tasks={"j1": running},
        started_at="2026-11-18T05:00:00.000Z",
        leader_since="2026-11-18T05:00:01.000Z",
    )
    produced = AcquisitionRuntime.runtime_info(stub)  # type: ignore[arg-type]
    assert produced == {"started_at": "2026-11-18T05:00:00.000Z", "leader_since": "2026-11-18T05:00:01.000Z",
                        "jobs_expected": 2, "jobs_running": 1, "connections_running": ["c1"]}
    row = {"queues_json": json.dumps({"publisher": {}, "runtime": produced, "c9": {"pending": 0}})}
    assert _acquisition_runtime_info(row) == produced
    assert _acquisition_runtime_info({"queues_json": "not json"}) == {}
    assert _acquisition_runtime_info(None) == {}


def test_ingestion_heartbeat_writes_every_key_the_api_reads() -> None:
    fn = _function(CENTER / "application" / "ingestion" / "worker.py", "_heartbeat_loop")  # moved from modules/ingestion_worker.py (R2-E B4)
    keys: set[str] = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "queues_json" for t in node.targets) and isinstance(node.value, ast.Dict):
            keys = {k.value for k in node.value.keys if isinstance(k, ast.Constant)}
    # Readers: collect.list_connections (conn_rates), telemetry.storage_overview (tenant_rates),
    # live_state.extract_runtime_health (tdengine_ok).
    assert {"conn_rates", "tenant_rates", "tdengine_ok", "lanes", "acked_total", "dlq_total"} <= keys


def test_heartbeat_liveness_window_is_15_s() -> None:
    assert H.EDGE_OFFLINE_AFTER_S == 15
    assert H.heartbeat_fresh(NOW - timedelta(seconds=15), NOW)
    assert not H.heartbeat_fresh(NOW - timedelta(seconds=16), NOW)
    assert not H.heartbeat_fresh(None, NOW)


# ---------------------------------------------------------------------------- connection report (Q5)


def test_acquisition_report_states_are_the_states_center_accepts() -> None:
    fn = _function(ACQ / "runtime.py", "connection_report")
    reported: set[str] = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "severity" for t in node.targets):
            reported |= {k.value for k in node.value.keys if isinstance(k, ast.Constant)}  # type: ignore[attr-defined]
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if isinstance(k, ast.Constant) and k.value == "state" and isinstance(v, ast.Constant):
                    reported.add(v.value)
    assert reported == {"AUTH_FAILED", "DOWN", "SILENT", "RATE_LIMITED", "UP", "IDLE"}
    assert reported == H._REPORT_STATES


@pytest.mark.parametrize(
    ("state", "last_ok_age_s", "expected_health", "error_kept"),
    [
        ("UP", 1, "HEALTHY", False),
        ("RATE_LIMITED", 1, "HEALTHY", True),
        ("DOWN", 60, "DEGRADED", True),
        ("AUTH_FAILED", 60, "DEGRADED", True),
        ("SILENT", 60, "DEGRADED", True),
        ("DOWN", 2, "HEALTHY", True),  # successful reads inside the window: stays HEALTHY, error kept as warning
        ("IDLE", None, "UNKNOWN", False),
    ],
)
def test_report_state_to_connection_health(state: str, last_ok_age_s: float | None, expected_health: str, error_kept: bool) -> None:
    current = {"status": "ACTIVE", "health": "HEALTHY", "last_error": None, "last_success_at": None}
    report = {"state": state, "last_ok_at": (NOW - timedelta(seconds=last_ok_age_s)).isoformat() if last_ok_age_s else None,
              "last_error_code": "E" if state not in {"UP", "IDLE"} else None, "last_error": "boom" if state not in {"UP", "IDLE"} else None,
              "window_s": 10}
    update = H.apply_connection_report(current, report, NOW)
    assert update is not None and update.health == expected_health
    assert bool(update.last_error) is error_kept


def test_report_never_moves_last_success_backwards_or_into_the_future() -> None:
    current = {"status": "ACTIVE", "health": "HEALTHY", "last_error": None, "last_success_at": NOW - timedelta(seconds=5)}
    older = H.apply_connection_report(current, {"state": "UP", "last_ok_at": (NOW - timedelta(seconds=50)).isoformat()}, NOW)
    assert older is None  # nothing changes
    future = H.apply_connection_report(current, {"state": "UP", "last_ok_at": (NOW + timedelta(hours=1)).isoformat()}, NOW)
    assert future is not None and future.last_success_at == NOW


# ---------------------------------------------------------------------------- config snapshot revision


class _FakeConn:
    """Minimal asyncpg connection for ``load_pg_snapshot``: one connection row, no other entities."""

    def __init__(self, name: str, version: int = 2) -> None:
        self.row = {"id": "c0000000-0000-0000-0000-000000000001", "tenant_id": "a0000000-0000-0000-0000-000000000001", "site_id": None,
                    "edge_id": None, "protocol": "modbus_tcp", "name": name, "endpoint_redacted": "plc:502", "secret_ref": None,
                    "secret_hash": None, "config_json": {"host": "plc", "port": 502}, "status": "ACTIVE", "version": version}

    def transaction(self, **_kw: Any):
        @asynccontextmanager
        async def tx():
            yield None

        return tx()

    async def fetch(self, sql: str, *_args: Any) -> list[dict[str, Any]]:
        return [self.row] if "FROM connections c" in sql and "secret_hash" in sql else []

    async def fetchval(self, _sql: str, *_args: Any) -> Any:
        return False  # optional tables (telemetry_generations, configuration_releases) absent


async def _revision(conn: _FakeConn, prev_rev: int, prev_digest: str) -> tuple[int, str]:
    from factorix_acquisition.config_provider import load_pg_snapshot

    snap = await load_pg_snapshot(conn, prev_revision=prev_rev, prev_digest=prev_digest)  # type: ignore[arg-type]
    assert snap["schema_version"] == "fx.acquisition.config.v1"
    return int(snap["revision"]), str(snap["structure_sha256"])


async def test_config_revision_derivation() -> None:
    rev1, digest1 = await _revision(_FakeConn("Line 1"), 0, "")
    assert rev1 == 2  # max(entity counters) on a cold start
    assert await _revision(_FakeConn("Line 1"), rev1, digest1) == (2, digest1)  # unchanged
    rev2, digest2 = await _revision(_FakeConn("Line 1 renamed"), rev1, digest1)  # structure changed, no counter bumped
    assert rev2 == 3 and digest2 != digest1


@pytest.mark.xfail(strict=True, raises=AssertionError, reason="CT-07: revision is process-local; after an acquisition restart it falls back to max(entity counters)")
async def test_config_revision_monotonic_across_restart() -> None:
    rev1, digest1 = await _revision(_FakeConn("Line 1"), 0, "")
    rev2, _ = await _revision(_FakeConn("Line 1 renamed"), rev1, digest1)
    after_restart, _ = await _revision(_FakeConn("Line 1 renamed"), 0, "")
    assert after_restart >= rev2
