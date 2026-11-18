"""WS-Q: connection health is windowed evidence with a single owner.

Owner bug: "the data source keeps arriving but the system records lost connection". These tests pin
the invariants that make it impossible by construction.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pytest

from factorix.domain.health import apply_connection_report

NOW = datetime(2026, 11, 18, 2, 0, 0, tzinfo=timezone.utc)


def _row(health: str = "HEALTHY", last_ok: datetime | None = None, last_error: str | None = None) -> dict[str, Any]:
    return {"status": "ACTIVE", "health": health, "last_error": last_error, "last_success_at": last_ok}


def test_down_report_with_recent_successful_read_stays_healthy() -> None:
    report = {"state": "DOWN", "last_error_code": "TIMEOUT", "last_error": "OPC UA server did not answer in time.",
              "last_ok_at": (NOW - timedelta(seconds=2)).isoformat(), "window_s": 10}
    update = apply_connection_report(_row(last_ok=NOW - timedelta(seconds=7)), report, NOW)
    assert update is not None and update.health == "HEALTHY"
    assert update.last_error and "did not answer" in update.last_error  # kept as a warning
    assert update.last_success_at == NOW - timedelta(seconds=2)


def test_legacy_report_without_window_uses_default_window() -> None:
    report = {"state": "DOWN", "last_error_code": "TIMEOUT", "last_error": "late", "last_ok_at": (NOW - timedelta(seconds=3)).isoformat()}
    update = apply_connection_report(_row(), report, NOW)
    assert update is not None and update.health == "HEALTHY"


def test_down_report_without_recent_read_degrades() -> None:
    report = {"state": "DOWN", "last_error_code": "NETWORK", "last_error": "Cannot connect.",
              "last_ok_at": (NOW - timedelta(seconds=40)).isoformat(), "window_s": 10}
    update = apply_connection_report(_row(), report, NOW)
    assert update is not None and update.health == "DEGRADED" and update.last_error == "NETWORK: Cannot connect."


def test_silent_source_is_degraded_with_its_own_text() -> None:
    report = {"state": "SILENT", "last_error_code": "NO_DATA", "last_error": "Connected, but the source sent no data for 30 s.",
              "last_ok_at": (NOW - timedelta(seconds=30)).isoformat(), "window_s": 10}
    update = apply_connection_report(_row(), report, NOW)
    assert update is not None and update.health == "DEGRADED"
    assert update.last_error == "Connected, but the source sent no data for 30 s."


def test_auth_failure_is_never_masked() -> None:
    report = {"state": "AUTH_FAILED", "last_error_code": "AUTH", "last_error": "rejected", "last_ok_at": (NOW - timedelta(seconds=1)).isoformat()}
    update = apply_connection_report(_row(), report, NOW)
    assert update is not None and update.health == "DEGRADED"


# --------------------------------------------------------------------------- Center sweep


class _Recorder:
    def __init__(self, rows: list[dict[str, Any]], runtime: dict[str, Any]) -> None:
        self.rows = rows
        self.runtime = runtime
        self.updates: list[tuple[str, dict[str, Any]]] = []
        self.changed = 0
        # What the UPDATE sees (the database at UPDATE time); defaults to what the SELECT saw.
        self.live: dict[Any, Any] = {r["id"]: r.get("last_success_at") for r in rows}


@pytest.fixture()
def sweep(monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    from factorix.transport import app as app_mod

    state: dict[str, Any] = {}

    async def fake_fetch_one(session: Any, sql: str, params: dict[str, Any]) -> Any:
        return state["rec"].runtime

    async def fake_fetch_all(session: Any, sql: str, params: dict[str, Any]) -> Any:
        return [dict(r) for r in state["rec"].rows]

    async def fake_rowcount(session: Any, sql: str, params: dict[str, Any]) -> int:
        rec = state["rec"]
        rec.updates.append((sql, params))
        # Emulate the atomic predicate of the UPDATE against the live row.
        last = rec.live.get(params["id"])
        hit = 1 if last is None or last < params["cutoff"] else 0
        rec.changed += hit
        return hit

    async def fake_audit(*args: Any, **kwargs: Any) -> None:
        return None

    class _Nested:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    class _Session:
        def begin_nested(self) -> _Nested:
            return _Nested()

    monkeypatch.setattr(app_mod, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(app_mod, "fetch_all", fake_fetch_all)
    monkeypatch.setattr(app_mod, "execute_rowcount", fake_rowcount)
    monkeypatch.setattr(app_mod, "audit", fake_audit)
    monkeypatch.setattr(app_mod, "queue_stream_event", lambda *a, **k: None)
    monkeypatch.setattr(app_mod, "utcnow", lambda: NOW)

    async def run(rec: _Recorder) -> _Recorder:
        state["rec"] = rec
        await app_mod._evaluate_connections(_Session())  # type: ignore[arg-type]
        return rec

    return run


def _conn(last_ok: datetime | None, created: datetime) -> dict[str, Any]:
    return {
        "id": uuid4(), "tenant_id": uuid4(), "edge_id": None, "health": "HEALTHY", "last_error": None,
        "last_success_at": last_ok, "created_at": created, "updated_at": created, "activated_at": None,
        "active_bindings": 3, "bindings_since": created, "interval_ms": 1000,
        "enrollment_status": None, "edge_health": None, "last_heartbeat": None, "desired_revision": None, "active_revision": None,
    }


def _runtime(**info: Any) -> dict[str, Any]:
    return {"health": "HEALTHY", "last_heartbeat": NOW - timedelta(seconds=2), "queues_json": json.dumps({"runtime": info})}


@pytest.mark.asyncio
async def test_sweep_ignores_connections_acquisition_runs(sweep) -> None:  # noqa: ANN001
    conn = _conn(NOW - timedelta(minutes=5), NOW - timedelta(days=3))
    rec = await sweep(_Recorder([conn], _runtime(connections_running=[str(conn["id"])], started_at=(NOW - timedelta(days=1)).isoformat())))
    assert rec.updates == []


@pytest.mark.asyncio
async def test_sweep_no_false_positive_right_after_acquisition_start(sweep) -> None:  # noqa: ANN001
    """01:39:48 incident: all connections DEGRADED the moment acquisition restarted."""
    conn = _conn(NOW - timedelta(minutes=20), NOW - timedelta(days=3))
    rec = await sweep(_Recorder([conn], _runtime(started_at=(NOW - timedelta(seconds=8)).isoformat(), leader_since=(NOW - timedelta(seconds=8)).isoformat())))
    assert rec.updates == []


@pytest.mark.asyncio
async def test_sweep_update_is_guarded_against_fresh_evidence(sweep) -> None:  # noqa: ANN001
    conn = _conn(NOW - timedelta(minutes=5), NOW - timedelta(days=3))
    rec = _Recorder([conn], _runtime(started_at=(NOW - timedelta(hours=1)).isoformat()))
    rec = await sweep(rec)
    assert len(rec.updates) == 1
    sql, params = rec.updates[0]
    assert "last_success_at < :cutoff" in sql and params["cutoff"] == NOW - timedelta(seconds=30)
    assert rec.changed == 1


@pytest.mark.asyncio
async def test_sweep_race_with_fresh_data_degrades_nothing(sweep) -> None:  # noqa: ANN001
    conn = _conn(NOW - timedelta(minutes=5), NOW - timedelta(days=3))
    rec = _Recorder([conn], _runtime(started_at=(NOW - timedelta(hours=1)).isoformat()))
    rec.live[conn["id"]] = NOW - timedelta(seconds=1)  # acquisition wrote fresh evidence after the SELECT
    rec = await sweep(rec)
    assert len(rec.updates) == 1 and rec.changed == 0
