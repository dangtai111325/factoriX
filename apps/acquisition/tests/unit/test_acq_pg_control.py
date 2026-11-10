"""Unit tests for PgControlPlane connection health reporting & audit transitions."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import pytest

from factorix_acquisition.pg_control import PgControlPlane


class _TxCtx:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        return False


class _FakeConn:
    def __init__(self, rows: list[dict[str, Any]], counts: list[dict[str, Any]] | None = None) -> None:
        self._rows = rows
        self._counts = counts or []
        self.executed: list[tuple[str, tuple[Any, ...]]] = []

    def transaction(self) -> _TxCtx:
        return _TxCtx()

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        if "FROM connections" in sql:
            return self._rows
        if "active_bindings" in sql:
            return self._counts
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        self.executed.append((sql.strip(), args))
        return "OK"


class _AcquireCtx:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        return False


class _FakePool:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    def acquire(self) -> _AcquireCtx:
        return _AcquireCtx(self._conn)


@pytest.mark.asyncio
async def test_flush_connection_reports_handles_down_before_first_success() -> None:
    cid = uuid4()
    tid = uuid4()
    now = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
    conn = _FakeConn(
        rows=[
            {
                "id": cid,
                "tenant_id": tid,
                "status": "ACTIVE",
                "health": "UNKNOWN",
                "last_error": None,
                "last_success_at": None,
            }
        ],
        counts=[{"connection_id": cid, "active_bindings": 2}],
    )
    plane = PgControlPlane(_FakePool(conn))  # type: ignore[arg-type]

    updated = await plane.flush_connection_reports(
        {
            str(cid): {
                "state": "DOWN",
                "last_ok_at": None,
                "last_error": "MQTT broker connecting",
            }
        },
        now=now,
    )

    assert updated == 1
    update_calls = [(sql, args) for sql, args in conn.executed if sql.startswith("UPDATE connections")]
    assert len(update_calls) == 1
    _sql, args = update_calls[0]
    assert args[0] == "DEGRADED"
    assert args[1] == "MQTT broker connecting"
    assert args[2] is None
    assert args[3] == cid

    audit_calls = [(sql, args) for sql, args in conn.executed if "CONNECTION_DEGRADED" in sql]
    assert len(audit_calls) == 1

    notify_calls = [(sql, args) for sql, args in conn.executed if "pg_notify('factorix_health_changed'" in sql]
    assert len(notify_calls) == 1
    notify_payload = json.loads(notify_calls[0][1][0])
    assert notify_payload["event"]["health"] == "DEGRADED"
    assert notify_payload["event"]["last_success_at"] is None


@pytest.mark.asyncio
async def test_flush_connection_reports_recovers_from_degraded_to_healthy() -> None:
    cid = uuid4()
    tid = uuid4()
    ok_ts = datetime(2026, 11, 10, 12, 1, 5, 123000, tzinfo=timezone.utc)
    conn = _FakeConn(
        rows=[
            {
                "id": cid,
                "tenant_id": tid,
                "status": "ACTIVE",
                "health": "DEGRADED",
                "last_error": "timeout",
                "last_success_at": None,
            }
        ],
        counts=[{"connection_id": cid, "active_bindings": 3}],
    )
    plane = PgControlPlane(_FakePool(conn))  # type: ignore[arg-type]

    updated = await plane.flush_connection_reports(
        {
            str(cid): {
                "state": "UP",
                "last_ok_at": ok_ts.isoformat(),
                "last_error": None,
            }
        },
        now=ok_ts,
    )

    assert updated == 1
    update_calls = [(sql, args) for sql, args in conn.executed if sql.startswith("UPDATE connections")]
    assert update_calls[0][1][0] == "HEALTHY"
    assert update_calls[0][1][1] is None
    assert update_calls[0][1][2] == ok_ts

    audit_calls = [(sql, args) for sql, args in conn.executed if "CONNECTION_RECOVERED" in sql]
    assert len(audit_calls) == 1

    notify_calls = [(sql, args) for sql, args in conn.executed if "pg_notify('factorix_health_changed'" in sql]
    notify_payload = json.loads(notify_calls[0][1][0])
    assert notify_payload["event"]["health"] == "HEALTHY"
    assert notify_payload["event"]["last_success_at"] == "2026-11-10T12:01:05.123Z"
