"""Unit tests for TDengineHistoryRepository & TDengineModelSnapshotProvider (S09)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest

from factorix.modules.history_repository import (
    TDengineHistoryRepository,
    TDengineModelSnapshotProvider,
    _format_cursor,
    _parse_cursor,
)
from factorix.modules.providers import ModelSnapshotRecord
from factorix.platform.errors import AppError
from factorix.platform.tdengine import (
    TDEngineConfig,
    TDEngineError,
    TDEngineHealth,
)

T0 = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
TENANT = uuid4()
SIG_F = uuid4()
SIG_S = uuid4()
GROUP_1 = uuid4()


def _fake_client() -> Any:
    cfg = TDEngineConfig(dsn="ws://root:taosdata@127.0.0.1:16041", db_prefix="fx_t_")
    client = AsyncMock()
    client.config = cfg
    client.query_rows = AsyncMock(return_value=[])
    client.execute_sql = AsyncMock(return_value=0)
    client.list_subtables = AsyncMock(return_value=[f"op_float64_{SIG_F.hex}", f"op_string_{SIG_S.hex}"])
    client.write_batch = AsyncMock()
    client.ensure_operational_schema = AsyncMock(return_value=f"fx_t_{TENANT.hex}")
    client.health_probe = AsyncMock(
        return_value=TDEngineHealth(
            reachable=True,
            server_version="3.3.6.13",
            edition="OSS",
            server_now_utc=T0,
            dnode_status="ready",
            tenant_db_count=1,
            disk_used_bytes=2_048_576,
        )
    )
    return client


def test_cursor_round_trip_preserves_microseconds_and_rejects_bad_input() -> None:
    ts = T0 + timedelta(microseconds=4321)
    pt_id = str(uuid4())
    cur = _format_cursor(ts, pt_id)
    parsed = _parse_cursor(cur)
    assert parsed is not None
    assert parsed[1] == pt_id
    with pytest.raises(AppError) as err:
        _parse_cursor("not-a-timestamp|not-a-uuid")
    assert err.value.code == "INVALID_CURSOR"


async def test_snapshot_provider_clamps_oversized_body_and_errors_safely() -> None:
    client = _fake_client()
    from factorix.platform.tdengine import BatchWriteResult

    client.write_batch.return_value = BatchWriteResult(succeeded_ids=("ok",), failures=())
    provider = TDengineModelSnapshotProvider(client)

    big_body = "x" * 60_000
    big_errors = [{"path": f"/f{i}", "code": "ERR", "message": "m" * 300} for i in range(40)]
    rec = ModelSnapshotRecord(
        group_id=GROUP_1,
        sampled_at=T0,
        body=big_body,
        errors=big_errors,
        error_count=len(big_errors),
        data_epoch=2,
    )
    await provider.append_snapshot(TENANT, rec)

    client.write_batch.assert_awaited_once()
    items = client.write_batch.call_args.args[1]
    assert len(items) == 1
    body_val = items[0].values[1]
    errors_val = items[0].values[2]
    assert len(body_val.encode("utf-8")) <= 47_000
    assert len(errors_val.encode("utf-8")) <= 7_800
    decoded = json.loads(errors_val)
    assert decoded[-1]["code"] == "TRUNCATED"


async def test_snapshot_provider_missing_table_returns_empty_and_prune_deletes_tail() -> None:
    client = _fake_client()
    client.query_rows.side_effect = [
        TDEngineError("TDENGINE_QUERY_FAILED", "Table does not exist"),
        [{"ts": T0 + timedelta(seconds=5)}, {"ts": T0 + timedelta(seconds=4)}, {"ts": T0 + timedelta(seconds=3)}, {"ts": T0 + timedelta(seconds=2)}],
    ]
    client.execute_sql.return_value = 7
    provider = TDengineModelSnapshotProvider(client)

    assert await provider.list_snapshots(TENANT, GROUP_1, limit=20) == []
    deleted = await provider.prune_snapshots(TENANT, [GROUP_1], keep=3)
    assert deleted == 7
    sql_del = client.execute_sql.call_args.args[0]
    assert "DELETE FROM" in sql_del and "WHERE `ts` <=" in sql_del


async def test_history_repository_operational_zero_and_pagination() -> None:
    client = _fake_client()
    client.query_rows.return_value = [
        {
            "ts": T0 + timedelta(seconds=1),
            "val": 0.0,
            "acquired_at": T0 + timedelta(seconds=1),
            "source_time": T0 + timedelta(seconds=1),
            "raw_quality": "GOOD",
            "reason_code": None,
            "origin": "LIVE",
            "unit": "Cel",
            "event_uid": "u1",
            "config_rev": 1,
            "data_epoch": 2,
            "record_kind": "RAW_OPERATIONAL",
        },
        {
            "ts": T0 + timedelta(seconds=2),
            "val": 12.5,
            "acquired_at": T0 + timedelta(seconds=2),
            "source_time": None,
            "raw_quality": "GOOD",
            "reason_code": None,
            "origin": "LIVE",
            "unit": "Cel",
            "event_uid": "u2",
            "config_rev": 1,
            "data_epoch": 2,
            "record_kind": "RAW_OPERATIONAL",
        },
    ]
    repo = TDengineHistoryRepository(client)
    page = await repo.query_raw(
        TENANT,
        signal_id=SIG_F,
        start=T0,
        end=T0 + timedelta(minutes=5),
        limit=1,
        mode="operational",
        value_type="float64",
        active_epoch=2,
    )
    assert len(page.items) == 1
    assert page.items[0].value == 0.0
    assert isinstance(page.items[0].value, float)
    assert page.next_cursor is not None
    assert page.fidelity == "operational_full"
    sql = client.query_rows.call_args.args[0]
    assert "`data_epoch` >= 2" in sql


async def test_history_repository_reconstructed_pre_seed_and_gap_truncation() -> None:
    client = _fake_client()
    repo = TDengineHistoryRepository(client)
    # Mock a Managed binding without a live PG session
    repo._managed_binding = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "td_database": f"fx_t_{TENANT.hex}",
            "td_stable": "ds_test",
            "td_subtable": "md_sub1",
            "dataset_id": uuid4(),
            "field_key": "temp",
            "value_type": "float64",
            "registry_status": "ACTIVE",
            "dataset_status": "RUNNING",
            "design_status": "RUNNING",
            "recording_mode": "ON_CHANGE",
            "policy_json": {"mode": "ON_CHANGE"},
            "expected_interval_ms": 1000,  # canonical stale_after_ms = 12000ms
        }
    )
    start = T0 + timedelta(minutes=1)
    end = T0 + timedelta(minutes=2)

    # First query: managed rows inside [start, end) with a 30s gap after start+5s and a BAD sample at +50s
    # Second query: pre-window seed 4s before `start` (within 12s stale_after_ms!)
    client.query_rows.side_effect = [
        [
            {
                "ts": start + timedelta(seconds=5),
                "val": 45.0,
                "acquired_at": start + timedelta(seconds=5),
                "source_time": start + timedelta(seconds=5),
                "raw_quality": "GOOD",
                "reason_code": None,
                "event_uid": "e1",
                "data_epoch": 1,
                "record_kind": "MANAGED_RECORDED",
            },
            {
                "ts": start + timedelta(seconds=35),
                "val": 47.0,
                "acquired_at": start + timedelta(seconds=35),
                "source_time": start + timedelta(seconds=35),
                "raw_quality": "GOOD",
                "reason_code": None,
                "event_uid": "e2",
                "data_epoch": 1,
                "record_kind": "MANAGED_RECORDED",
            },
            {
                "ts": start + timedelta(seconds=40),
                "val": None,
                "acquired_at": start + timedelta(seconds=40),
                "source_time": None,
                "raw_quality": "BAD",
                "reason_code": "COMM_TIMEOUT",
                "event_uid": "e3",
                "data_epoch": 1,
                "record_kind": "MANAGED_RECORDED",
            },
        ],
        [
            {
                "ts": start - timedelta(seconds=4),
                "val": 44.0,
                "acquired_at": start - timedelta(seconds=4),
                "source_time": start - timedelta(seconds=4),
                "raw_quality": "GOOD",
                "reason_code": None,
                "event_uid": "pre0",
                "data_epoch": 1,
                "record_kind": "MANAGED_RECORDED",
            }
        ],
    ]
    page = await repo.query_raw(
        TENANT,
        signal_id=SIG_F,
        start=start,
        end=end,
        limit=100,
        mode="reconstructed",
        value_type="float64",
        active_epoch=1,
    )
    assert page.fidelity == "reconstructed"
    # Expected timeline:
    # 1. Pre-window carry-in virtual point at `start` (val=44.0, reason=RECONSTRUCTED_PRE_WINDOW_SEED)
    # 2. e1 at +5s (val=45.0)
    # 3. Gap truncation at +17s (start+5s + 12s, val=None, quality=STALE)
    # 4. e2 at +35s (val=47.0)
    # 5. e3 at +40s (val=None, quality=BAD) -- does NOT insert trailing STALE after BAD!
    assert len(page.items) == 5
    assert page.items[0].virtual is True and page.items[0].value == 44.0 and page.items[0].event_time == start
    assert page.items[1].virtual is False and page.items[1].value == 45.0
    assert page.items[2].virtual is True and page.items[2].quality == "STALE" and page.items[2].value is None
    assert page.items[2].event_time == start + timedelta(seconds=17)
    assert page.items[3].value == 47.0
    assert page.items[4].quality == "BAD" and page.items[4].value is None


async def test_aggregate_excludes_non_numeric_and_uses_good_filter() -> None:
    client = _fake_client()
    repo = TDengineHistoryRepository(client)
    repo._signal_meta_map = AsyncMock(  # type: ignore[method-assign]
        return_value={
            SIG_F: {"id": SIG_F, "data_type": "float64"},
            SIG_S: {"id": SIG_S, "data_type": "string"},
        }
    )
    client.query_rows.return_value = [
        {"bucket": T0, "value": 25.5, "sample_count": 4},
    ]
    buckets = await repo.aggregate(
        TENANT,
        signal_ids=[SIG_F, SIG_S],
        start=T0,
        end=T0 + timedelta(minutes=5),
        bucket_ms=60_000,
        fn="avg",
        active_epoch=1,
    )
    assert len(buckets) == 1
    assert buckets[0].signal_id == SIG_F
    assert buckets[0].value == 25.5
    assert buckets[0].good_count == 4
    sql = client.query_rows.call_args.args[0]
    assert "`raw_quality` = 'GOOD' AND `val` IS NOT NULL" in sql
    assert "INTERVAL(60000a) FILL(NONE)" in sql


async def test_storage_overview_metrics_uses_first_last_and_probes_disk() -> None:
    client = _fake_client()
    client.query_rows.side_effect = [
        [{"cnt": 100, "oldest": T0, "newest": T0 + timedelta(minutes=10)}],
        [{"cnt": 25, "oldest": T0 - timedelta(minutes=5), "newest": T0 + timedelta(minutes=2)}],
        [{"cnt": 0, "oldest": None, "newest": None}],
        TDEngineError("TDENGINE_QUERY_FAILED", "Table does not exist"),
        [{"cnt": 5, "oldest": T0, "newest": T0 + timedelta(minutes=1)}],
    ]
    repo = TDengineHistoryRepository(client)
    metrics = await repo.storage_overview_metrics(TENANT, active_epoch=2)
    assert metrics["observations"] == 130
    assert metrics["oldest"] == T0 - timedelta(minutes=5)
    assert metrics["newest"] == T0 + timedelta(minutes=10)
    assert metrics["disk_bytes"] == 2_048_576
    assert metrics["approximate"] is False
    queried_sql = [call.args[0] for call in client.query_rows.call_args_list]
    for st in ("op_float64", "op_int64", "op_bool", "op_string", "op_json"):
        assert any(f".`{st}` " in sql for sql in queried_sql)
