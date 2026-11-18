"""Unit tests for TDEngineClient config, VGROUPS DDL, timeouts, probe isolation, and disk probe SQL."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import threading
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from factorix.platform.tdengine import SubtableWriteItem, TDEngineClient, TDEngineConfig, TDEngineError


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
async def test_retryable_batch_write_does_not_fan_out_to_single_row_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TDEngineClient(TDEngineConfig(dsn="ws://localhost:6041", batch_chunk_rows=2))
    execute = AsyncMock(side_effect=[0, TDEngineError("TIMEOUT", "Connection timed out", retryable=True)])
    monkeypatch.setattr(client, "execute_sql", execute)
    try:
        items = [
            SubtableWriteItem(str(i), "sensors", "motor", ("north",), ("ts", "val"), (i, 1.0))
            for i in range(7)
        ]
        result = await client.write_batch("plant", items)
        assert execute.await_count == 2
        assert result.succeeded_ids == ("0", "1")
        assert [failure.item_id for failure in result.failures] == ["2", "3", "4", "5", "6"]
        assert all(failure.retryable for failure in result.failures)
    finally:
        await client.close()


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

        health = await asyncio.wait_for(client.health_probe(), timeout=4.0)
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


def test_errors_are_classified_by_type_and_native_code_before_message_text() -> None:
    from factorix.platform.tdengine import _is_retryable_error, parse_native_code, td_error_is_schema_missing

    class QueryError(Exception):
        pass

    assert parse_native_code("[0x2603] Table does not exist") == 0x2603
    assert td_error_is_schema_missing("[0x2603] Table does not exist")
    assert td_error_is_schema_missing("[0x0388] Database not exist")
    # A deterministic parser error is permanent even if its text mentions "connection" / "closed".
    assert not td_error_is_schema_missing("[0x2600] syntax error near 'not exist'")
    assert _is_retryable_error(QueryError("[0x2600] syntax error near 'connection closed'")) is False
    # Transport / transient server states are retryable.
    assert _is_retryable_error(QueryError("[0xE001] Internal error: WebSocket IO error")) is True
    assert _is_retryable_error(QueryError("[0x0396] Database in creating status")) is True
    assert _is_retryable_error(ConnectionResetError()) is True
    # Code-less errors keep the legacy heuristics.
    assert _is_retryable_error(QueryError("websocket closed")) is True
    err = TDEngineError("TDENGINE_QUERY_FAILED", "[0x2603] Table does not exist")
    assert err.native_code == 0x2603 and err.schema_missing


@pytest.mark.asyncio
async def test_permanent_chunk_failure_is_isolated_by_bisection_not_row_by_row(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TDEngineClient(TDEngineConfig(dsn="ws://localhost:6041", batch_chunk_rows=1000))
    statements: list[str] = []

    async def execute(sql: str, **_kw: Any) -> int:
        statements.append(sql)
        if "'bad'" in sql:
            raise TDEngineError("TDENGINE_QUERY_FAILED", "[0x2600] syntax error", retryable=False)
        return 0

    monkeypatch.setattr(client, "execute_sql", execute)
    try:
        items = [
            SubtableWriteItem(str(i), "sensors", f"motor{i % 4}", ("north",), ("ts", "val"), (i, "bad" if i == 37 else "ok"))
            for i in range(64)
        ]
        result = await client.write_batch("plant", items)
        assert [failure.item_id for failure in result.failures] == ["37"]
        assert not result.failures[0].retryable
        assert sorted(result.succeeded_ids, key=int) == [str(i) for i in range(64) if i != 37]
        assert len(statements) <= 2 * 6 + 2  # 1 + 2*log2(64) + 1 statements instead of 64 single-row INSERTs
        assert statements[0].count("USING") == 4  # one header per subtable, rows grouped
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_operational_fast_values_render_identically_to_generic_literals(monkeypatch: pytest.MonkeyPatch) -> None:
    import dataclasses

    client = TDEngineClient(TDEngineConfig(dsn="ws://localhost:6041"))
    captured: list[Any] = []

    async def write_batch(database: str, items: Any) -> Any:
        captured.extend(items)
        return None

    monkeypatch.setattr(client, "write_batch", write_batch)
    now = datetime(2026, 11, 18, 1, 2, 3, 456789, tzinfo=timezone.utc)
    base = {"signal_id": uuid4(), "resource_id": uuid4(), "connection_id": uuid4(), "event_time": now, "acquired_at": now}
    records = [
        {**base, "event_uid": "a", "value_type": "float64", "value": -0.0, "source_time": now, "raw_quality": "GOOD", "unit": "°C", "source_seq": 7},
        {**base, "event_uid": "b", "value_type": "int64", "value": 2**62, "reason_code": "X'Y", "origin": "LIVE", "config_revision": 3, "data_epoch": 2},
        {**base, "event_uid": "c", "value_type": "bool", "value": True, "raw_quality": "UNCERTAIN"},
        {**base, "event_uid": "d", "value_type": "string", "value": "it's \ fine", "source_seq": None},
        {**base, "event_uid": "e", "value_type": "json", "value": {"k": [1, "ü"]}, "raw_quality": "BAD"},
        {**base, "event_uid": "f", "value_type": "float64", "value": None, "raw_quality": "BAD"},
    ]
    try:
        await client.write_operational_observations(uuid4(), records)
        assert len(captured) == len(records)
        for item in captured:
            assert item.values_sql is not None
            generic = client._format_values_tuple(dataclasses.replace(item, values_sql=None))
            assert item.values_sql == generic
    finally:
        await client.close()
