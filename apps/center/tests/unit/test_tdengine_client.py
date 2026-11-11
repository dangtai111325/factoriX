"""Unit tests for TDEngineClient config, VGROUPS DDL, timeouts, probe isolation, and disk probe SQL."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import threading
from typing import Any
from uuid import uuid4

import pytest

from factorix.platform.tdengine import TDEngineClient, TDEngineConfig, TDEngineError


class _FakeCursor:
    def __init__(self, handler: Any) -> None:
        self._handler = handler
        self.description: list[tuple[str, ...]] = []
        self._rows: list[tuple[Any, ...]] = []

    def execute(self, sql: str) -> None:
        cols, rows = self._handler(sql)
        self.description = [(c,) for c in cols]
        self._rows = rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows

    def close(self) -> None:
        return None


class _FakeConn:
    def __init__(self, sql_log: list[str], handler: Any) -> None:
        self.sql_log = sql_log
        self.handler = handler
        self.closed = False

    def execute(self, sql: str) -> int:
        self.sql_log.append(sql)
        return 0

    def cursor(self) -> _FakeCursor:
        def _wrapped(sql: str) -> tuple[list[str], list[tuple[Any, ...]]]:
            self.sql_log.append(sql)
            return self.handler(sql)

        return _FakeCursor(_wrapped)

    def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_ensure_tenant_database_emits_vgroups_1_by_default_and_honors_override() -> None:
    sql_log: list[str] = []
    client = TDEngineClient(TDEngineConfig(dsn="ws://root:taosdata@127.0.0.1:6041"))
    fake = _FakeConn(sql_log, lambda _s: ([], []))
    client._get_conn = lambda: fake  # type: ignore[method-assign]
    try:
        tid = uuid4()
        await client.ensure_tenant_database(tid)
        assert "VGROUPS 1" in sql_log[-1]

        await client.ensure_tenant_database(tid, vgroups=3)
        assert "VGROUPS 3" in sql_log[-1]

        with pytest.raises(TDEngineError) as bad_vg:
            await client.ensure_tenant_database(tid, vgroups=0)
        assert bad_vg.value.code == "INVALID_VGROUPS"
    finally:
        await client.close()

    sql_log2: list[str] = []
    client_none = TDEngineClient(TDEngineConfig(dsn="ws://root:taosdata@127.0.0.1:6041", default_vgroups=None))
    fake2 = _FakeConn(sql_log2, lambda _s: ([], []))
    client_none._get_conn = lambda: fake2  # type: ignore[method-assign]
    try:
        await client_none.ensure_tenant_database(uuid4())
        assert "VGROUPS" not in sql_log2[-1]
    finally:
        await client_none.close()


@pytest.mark.asyncio
async def test_health_probe_avoids_coalesce_and_runs_on_separate_probe_executor() -> None:
    sql_log: list[str] = []
    probe_threads: list[str] = []
    release_main = threading.Event()
    main_entered = threading.Event()

    def _handler(sql: str) -> tuple[list[str], list[tuple[Any, ...]]]:
        probe_threads.append(threading.current_thread().name)
        assert "COALESCE" not in sql.upper()
        if "SERVER_VERSION" in sql:
            return ["ver", "now_ts"], [("3.3.6.13", datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc))]
        if "ins_cluster" in sql:
            return ["edition"], [("community",)]
        if "ins_dnodes" in sql:
            return ["status"], [("ready",)]
        if "ins_databases" in sql:
            return ["cnt"], [(2,)]
        if "ins_disk_usage" in sql:
            return (
                ["wal", "data1", "data2", "data3", "cache_rdb", "table_meta"],
                [(10, 20, None, 0, 5, 1), (0, 4, None, None, None, None)],
            )
        raise AssertionError(f"Unexpected probe SQL: {sql}")

    client = TDEngineClient(TDEngineConfig(dsn="ws://root:taosdata@127.0.0.1:6041", max_workers=1, probe_timeout_s=2.0))
    fake = _FakeConn(sql_log, _handler)
    client._get_conn = lambda: fake  # type: ignore[method-assign]
    try:
        def _blocking_write(_conn: Any) -> int:
            main_entered.set()
            release_main.wait(timeout=2.0)
            return 1

        # Occupy all 1 workers on main _executor; health_probe must still succeed on _probe_executor!
        busy_task = asyncio.create_task(client._run_in_pool(_blocking_write, timeout_s=5.0, use_probe_pool=False))
        await asyncio.to_thread(main_entered.wait, 1.0)

        health = await asyncio.wait_for(client.health_probe(), timeout=2.0)
        assert health.reachable is True
        assert health.disk_used_bytes == (10 + 20 + 5 + 1 + 4) * 1024
        assert health.tenant_db_count == 2
        assert probe_threads and all(name.startswith("fx-td-probe") for name in probe_threads)

        release_main.set()
        assert await busy_task == 1
    finally:
        release_main.set()
        await client.close()


@pytest.mark.asyncio
async def test_execute_sql_timeout_raises_retryable_tdengine_error() -> None:
    gate = threading.Event()

    class _SlowConn:
        def execute(self, _sql: str) -> int:
            gate.wait(timeout=2.0)
            return 0

        def close(self) -> None:
            return None

    client = TDEngineClient(TDEngineConfig(dsn="ws://root:taosdata@127.0.0.1:6041", query_timeout_s=0.1, ddl_timeout_s=0.1))
    slow = _SlowConn()
    client._get_conn = lambda: slow  # type: ignore[method-assign]
    try:
        assert client._effective_timeout("INSERT INTO t VALUES (now, 1)", None) == pytest.approx(1.0)
        assert client._effective_timeout("INSERT INTO t VALUES (now, 1)", 0.2) == pytest.approx(0.5)
        assert client._effective_timeout("CREATE DATABASE x", None) == pytest.approx(1.0)
        with pytest.raises(TDEngineError) as exc:
            await client.execute_sql("SELECT 1", timeout_s=0.5)
        assert exc.value.code == "TDENGINE_TIMEOUT"
        assert exc.value.retryable is True
    finally:
        gate.set()
        await client.close()
