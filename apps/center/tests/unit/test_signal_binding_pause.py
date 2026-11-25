"""Contract H7 (B-01 / OP-02): Pause / Retire in Storage Management stops writes for subtables bound to a signal.

The ingestion catalog is the single place that decides which ``storage_bindings`` rows become write targets.
These tests drive the real ``PgIngestionStore.load_tenant_catalog`` over a fake asyncpg pool and the real
``IngestionWorker`` catalog cache, plus the real pause/resume routes (they must announce the change on
``factorix_config_changed`` so the ingestion process reloads without waiting for its TTL).
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from factorix.application.ingestion.catalog import signal_binding_write_active
from factorix.application.ingestion.pg_store import PgIngestionStore
from factorix.modules.ingestion_worker import IngestionWorker
from factorix_core.contracts.notify import Channel

TENANT = UUID("00000000-0000-0000-0000-000000000001")
DB = f"fx_t_{TENANT.hex}"


def _sb_row(subtable: str, signal_id: UUID, *, subtable_status: str | None, stable_status: str | None = "ACTIVE") -> dict[str, Any]:
    return {
        "binding_id": uuid4(),
        "tenant_id": TENANT,
        "physical_db": DB,
        "physical_subtable": subtable,
        "target_column": "value_f64",
        "signal_id": signal_id,
        "model_id": None,
        "model_field_path": None,
        "row_assembly_policy": "SINGLE_FIELD",
        "policy_config_json": {"mode": "ON_CHANGE"},
        "binding_revision": 1,
        "binding_status": "ACTIVE",
        "subtable_status": subtable_status,
        "stable_status": stable_status,
        "td_stable": "st_user",
        "data_type": "FLOAT64",
        "resource_id": uuid4(),
        "subtable_tags_json": {},
        "stable_tags_json": [],
        "stable_columns_json": [{"name": "ts"}, {"name": "value_f64"}],
    }


class _FakeConn:
    def __init__(self, sb_rows: list[dict[str, Any]]) -> None:
        self.sb_rows = sb_rows
        self.sb_sql: list[str] = []

    def transaction(self, **_kw: Any) -> "_FakeConn":
        return self

    async def __aenter__(self) -> "_FakeConn":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        return None

    async def fetchrow(self, _sql: str, *_args: Any) -> dict[str, Any]:
        return {"active_epoch": 1, "lifecycle_state": "ACTIVE"}

    async def fetch(self, sql: str, *_args: Any) -> list[dict[str, Any]]:
        if "FROM storage_bindings sb" in sql:
            self.sb_sql.append(sql)
            return list(self.sb_rows)
        return []


class _FakePool:
    def __init__(self, conn: _FakeConn) -> None:
        self.conn = conn

    def acquire(self) -> _FakeConn:
        return self.conn


def _store(sb_rows: list[dict[str, Any]]) -> tuple[PgIngestionStore, _FakeConn]:
    store = PgIngestionStore("postgresql://unused@localhost/unused")
    conn = _FakeConn(sb_rows)
    store._pool = _FakePool(conn)  # type: ignore[assignment]
    return store, conn


@pytest.mark.parametrize(
    ("subtable_status", "stable_status", "expected"),
    [
        ("ACTIVE", "ACTIVE", True),
        (None, None, True),  # legacy binding without a storage_objects row keeps writing
        ("ACTIVE", None, True),
        ("PAUSED", "ACTIVE", False),
        ("RETIRED", "ACTIVE", False),
        ("PURGED", "ACTIVE", False),
        ("ACTIVE", "PAUSED", False),  # paused through its STABLE
        ("paused", "ACTIVE", False),
    ],
)
def test_signal_binding_write_active_matrix(subtable_status: str | None, stable_status: str | None, expected: bool) -> None:
    row = _sb_row("sub_x", uuid4(), subtable_status=subtable_status, stable_status=stable_status)
    assert signal_binding_write_active(row) is expected


async def test_catalog_excludes_paused_signal_subtable_and_selects_object_status() -> None:
    sig_active, sig_paused = uuid4(), uuid4()
    store, conn = _store([
        _sb_row("sub_active", sig_active, subtable_status="ACTIVE"),
        _sb_row("sub_paused", sig_paused, subtable_status="PAUSED"),
    ])
    cat = await store.load_tenant_catalog(TENANT)

    assert set(cat.managed_targets_by_signal) == {sig_active}
    assert [t.td_subtable for t in cat.all_managed_targets] == ["sub_active"]
    # The decision needs the object states from the query itself.
    assert "so.status AS subtable_status" in conn.sb_sql[0]
    assert "pso.status AS stable_status" in conn.sb_sql[0]


async def test_resume_plus_config_notify_restores_the_target_in_the_worker_cache() -> None:
    sig = uuid4()
    row = _sb_row("sub_1", sig, subtable_status="PAUSED")
    store, _conn = _store([row])
    worker = IngestionWorker(pg_store=store, tdengine=MagicMock())  # type: ignore[arg-type]

    cat = await worker._get_catalog(TENANT)
    assert sig not in cat.managed_targets_by_signal

    # Resume in Storage Management flips storage_objects.status and announces factorix_config_changed.
    row["subtable_status"] = "ACTIVE"
    worker._on_pg_notify(None, 0, Channel.CONFIG_CHANGED.value, json.dumps({"tenant_id": str(TENANT)}))
    cat = await worker._get_catalog(TENANT)
    assert [t.td_subtable for t in cat.managed_targets_by_signal[sig]] == ["sub_1"]

    # Pause again: gone after the next notify.
    row["subtable_status"] = "PAUSED"
    worker._on_pg_notify(None, 0, Channel.CONFIG_CHANGED.value, json.dumps({"tenant_id": str(TENANT)}))
    cat = await worker._get_catalog(TENANT)
    assert sig not in cat.managed_targets_by_signal


class _FakeTd:
    """TDengine stand-in: no STABLE named like the target, so ``db.name`` resolves to a subtable."""

    async def run_read(self, _sql: str) -> list[Any]:
        return []

    async def run_write(self, _sql: str) -> None:
        return None


class _RecordingSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def execute(self, statement: Any, params: dict[str, Any] | None = None, *_a: Any, **_kw: Any) -> Any:
        self.calls.append((str(statement), dict(params or {})))

        class _Result:
            rowcount = 1

            def mappings(self) -> "_Result":
                return self

            def first(self) -> None:
                return None

            def all(self) -> list[Any]:
                return []

        return _Result()

    async def commit(self) -> None:
        return None


@pytest.mark.parametrize("action", ["pause", "resume", "retire"])
async def test_lifecycle_routes_announce_config_changed(action: str) -> None:
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from factorix.transport.storage_api import build_router

    session = _RecordingSession()

    async def fake_admin() -> dict[str, str]:
        return {"tenant_id": str(TENANT), "admin_id": "00000000-0000-0000-0000-000000000002", "role": "admin"}

    async def fake_db() -> Any:
        yield session

    app = FastAPI()
    app.include_router(build_router(admin=fake_admin, db_session=fake_db, td_client=_FakeTd()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        resp = await client.post(f"/api/v1/storage/td/objects/{DB}.sub_001/{action}")
    assert resp.status_code == 200, resp.text

    notifies = [p for sql, p in session.calls if "pg_notify" in sql]
    assert notifies == [{"channel": "factorix_config_changed", "payload": json.dumps({"tenant_id": str(TENANT)})}]
    # The notify follows the status update (same transaction, delivered on commit).
    idx_update = next(i for i, (sql, _p) in enumerate(session.calls) if sql.startswith("UPDATE storage_objects"))
    idx_notify = next(i for i, (sql, _p) in enumerate(session.calls) if "pg_notify" in sql)
    assert idx_update < idx_notify
