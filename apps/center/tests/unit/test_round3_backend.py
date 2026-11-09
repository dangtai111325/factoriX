"""Round-3 backend fixes: lock ordering (deadlock), PAUSED status, sibling names, archive impact,
signal usage hook, disabled-signal source, overview idle rule."""

from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from factorix.domain.health import data_collection_status
from factorix.domain.signal_state import evaluate_signal_state
from factorix.modules import collect, data_models, edge_sync, models_engine, resources, telemetry, usage
from factorix.platform.errors import AppError

NOW = datetime(2026, 11, 9, 3, 0, tzinfo=timezone.utc)
TENANT = uuid4()


# ---- P1 deadlock: every model_state writer locks rows in group_id order ----------------------


async def test_model_engine_is_the_single_writer_in_group_id_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """Data Model v2: one scheduler writes model_state/model_snapshots, rows sorted by group id."""
    calls: list[tuple[str, dict[str, Any]]] = []

    async def execute(_s: Any, sql: str, params: dict[str, Any]) -> None:
        calls.append((sql, params))

    monkeypatch.setattr(models_engine, "execute", execute)
    ids = [uuid4() for _ in range(6)]
    rows = [{"group_id": g, "tenant_id": TENANT, "body": "{}", "sampled_at": NOW, "errors_json": "[]", "error_count": 0} for g in reversed(ids)]
    await models_engine.write_samples(AsyncMock(), rows)
    assert [c[0].split()[2] for c in calls] == ["model_state", "model_snapshots"]
    assert calls[0][1]["ids"] == sorted(ids, key=str)
    assert "_notify_models" not in inspect.getsource(telemetry)


def test_connection_rows_are_locked_in_id_order_and_after_model_composition() -> None:
    ingest = inspect.getsource(telemetry.ingest_observations)
    # Data Model v2: ingest no longer composes models (the engine samples on its own schedule).
    assert "_notify_models" not in ingest and "on_signals_changed" not in inspect.getsource(telemetry)
    assert "_mark_connections_live(" in ingest
    assert "ORDER BY id\n            FOR UPDATE" in inspect.getsource(telemetry._mark_connections_live).replace("\r\n", "\n")
    assert "ORDER BY id\n        FOR UPDATE" in inspect.getsource(edge_sync._apply_connection_reports).replace("\r\n", "\n")
    store = inspect.getsource(telemetry._store_batch)
    assert "sorted(newest_per_signal(new_rows).values(), key=lambda row: str(row[1].signal_id))" in store


# ---- R3-CN-02: signals of a paused connection are PAUSED, not STALE --------------------------


def test_paused_connection_signal_is_paused_not_stale() -> None:
    old = NOW - timedelta(minutes=5)
    state = evaluate_signal_state(has_observation=True, raw_quality="GOOD", raw_value=2, event_time=old, last_acquired_at=old, expected_interval_ms=1000, now=NOW, connection_paused=True)
    assert state.effective_status == "PAUSED" and state.reason_code == "CONNECTION_PAUSED"
    stale = evaluate_signal_state(has_observation=True, raw_quality="GOOD", raw_value=2, event_time=old, last_acquired_at=old, expected_interval_ms=1000, now=NOW)
    assert stale.effective_status == "STALE"
    disabled = evaluate_signal_state(has_observation=True, raw_quality="GOOD", raw_value=2, event_time=old, now=NOW, binding_enabled=False, connection_paused=True)
    assert disabled.effective_status == "DISABLED"


async def test_latest_states_reports_paused_from_the_bound_connection() -> None:
    old = NOW - timedelta(minutes=5)
    row = {"signal_id": uuid4(), "value_json": {"v": 2}, "quality": "GOOD", "event_time": old, "received_time": old, "source_time": old,
           "expected_interval_ms": 1000, "raw_reason": None, "nullable": False, "connection_paused": True, "last_good_value_json": {"v": 2},
           "last_good_event_time": old, "updated_at": old}
    fetch = AsyncMock(return_value=[row])
    with patch.object(telemetry, "fetch_all", fetch):
        out = await telemetry.latest_states(AsyncMock(), TENANT, [row["signal_id"]])
    assert "c.status AS connection_status" in fetch.call_args.args[1]
    assert out[0]["effective_status"] == "PAUSED" and out[0]["quality"] == "PAUSED" and out[0]["value"] == 2
    assert "connection_paused" not in out[0]


# ---- R3-CN-03: idle connections never make the overview "Attention needed" -------------------


def test_idle_connections_do_not_degrade_collection_status() -> None:
    assert data_collection_status(["HEALTHY"] * 5 + ["IDLE"]) == "HEALTHY"
    assert data_collection_status(["HEALTHY", "PAUSED", "IDLE"]) == "HEALTHY"
    assert data_collection_status(["IDLE"]) == "IDLE"
    assert data_collection_status(["HEALTHY", "DEGRADED", "IDLE"]) == "DEGRADED"


# ---- R3-HS-02: duplicate sibling names -------------------------------------------------------


def test_sibling_name_key_is_trimmed_and_case_insensitive() -> None:
    assert resources.sibling_name_key("  Assembly - AA10-01 ") == resources.sibling_name_key("assembly - aa10-01")
    assert resources.sibling_name_key("Line 1") != resources.sibling_name_key("Line 2")


async def test_duplicate_sibling_name_is_409_duplicate_name() -> None:
    parent = uuid4()
    fetch = AsyncMock(return_value={"id": uuid4(), "code": "L1"})
    with patch.object(resources, "fetch_one", fetch):
        with pytest.raises(AppError) as err:
            await resources.assert_unique_sibling_name(AsyncMock(), TENANT, parent, " Line A ", parent_name="ASSY")
    assert err.value.status == 409 and err.value.code == "DUPLICATE_NAME"
    params = fetch.call_args.args[2]
    assert params["name_key"] == "line a" and params["parent_id"] == parent and params["exclude_id"] is None
    assert "lower(btrim(name)) = :name_key" in fetch.call_args.args[1] and "archived_at IS NULL" in fetch.call_args.args[1]
    with patch.object(resources, "fetch_one", AsyncMock(return_value=None)):
        await resources.assert_unique_sibling_name(AsyncMock(), TENANT, None, "Root", exclude_id=uuid4())


# ---- R3-DM-02 / R3-HS-01: usage hook and resource archive impact ------------------------------


async def test_signal_usage_hook_reads_model_refs_and_aggregates(monkeypatch: pytest.MonkeyPatch) -> None:
    a, b = uuid4(), uuid4()
    seen: list[tuple[str, dict[str, Any]]] = []

    async def fetch_all(_s: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        seen.append((sql, params))
        return [{"id": "m0", "display_name": "condition", "state": "PAUSED"}, {"id": "m1", "display_name": "Energy", "state": "RUNNING"}]

    monkeypatch.setattr(data_models, "fetch_all", fetch_all)
    merged = await usage.models_using_signals(AsyncMock(), TENANT, [a, b])
    assert [m["id"] for m in merged] == ["m0", "m1"]  # one entry per model, by name
    assert merged[1] == {"id": "m1", "name": "Energy", "display_name": "Energy", "status": "RUNNING", "state": "RUNNING"}
    sql, params = seen[-1]
    assert "FROM model_refs" in sql and "g.status = 'ACTIVE'" in sql and sorted(params["ids"], key=str) == sorted([a, b], key=str)
    assert await usage.models_using_signal(AsyncMock(), TENANT, a) == merged
    assert await usage.archive_models(AsyncMock(), TENANT, uuid4(), [], "c") == []


def _archive_patches(models: list[dict[str, Any]]):
    resource = {"id": uuid4(), "name": "R3-TMP-M1", "status": "ACTIVE", "properties_json": {}, "parent_id": None}
    sig = {"id": uuid4(), "enabled": True, "key": "status", "display_name": "Status", "collecting": True}
    return resource, sig, [
        patch.object(resources, "_resource", AsyncMock(return_value=resource)),
        patch.object(resources, "_active_children", AsyncMock(return_value=0)),
        patch.object(resources, "fetch_all", AsyncMock(return_value=[sig])),
        patch.object(resources, "execute", AsyncMock()),
        patch.object(resources, "audit", AsyncMock()),
        patch.object(resources, "get_resource", AsyncMock(return_value={"id": str(resource["id"])})),
        patch.object(usage, "models_using_resource", AsyncMock(return_value=models)),
        patch("factorix.modules.collect.bump_edge_release", AsyncMock()),
    ]


async def test_archive_with_models_is_blocked_unless_archive_models() -> None:
    models = [{"id": "m1", "display_name": "AA10-06 Energy", "status": "PUBLISHED"}]
    resource, _sig, patches = _archive_patches(models)
    for p in patches:
        p.start()
    try:
        with pytest.raises(AppError) as err:
            await resources.archive_resource(AsyncMock(), TENANT, uuid4(), resource["id"], "c")
        assert err.value.status == 409 and err.value.code == "RESOURCE_HAS_MODELS"
        assert err.value.extra["models"] == models
        archived = [{**models[0], "status": "ARCHIVED"}]
        with patch.object(usage, "archive_models", AsyncMock(return_value=archived)) as hook:
            out = await resources.archive_resource(AsyncMock(), TENANT, uuid4(), resource["id"], "c", archive_models=True)
        assert out["archived_models"] == archived and hook.await_args.args[3] == models
    finally:
        for p in patches:
            p.stop()


async def test_archive_impact_lists_children_signals_and_models() -> None:
    models = [{"id": "m1", "display_name": "AA10-06 Energy", "status": "PUBLISHED"}]
    resource, sig, patches = _archive_patches(models)
    for p in patches:
        p.start()
    try:
        impact = await resources.archive_impact(AsyncMock(), TENANT, resource["id"])
    finally:
        for p in patches:
            p.stop()
    assert impact["child_count"] == 0 and impact["can_archive"] is True
    assert impact["signal_count"] == 1 and impact["collecting_signal_count"] == 1
    assert impact["signals"] == [{"id": str(sig["id"]), "key": "status", "display_name": "Status"}]
    assert impact["models"] == models


# ---- R3-SG-01: a disabled signal keeps its connection and address ----------------------------


async def test_disabled_signal_keeps_its_source_in_the_list() -> None:
    conn = uuid4()
    row = {"id": uuid4(), "key": "status", "data_type": "int64", "connection_id": conn, "connection_name": "PC03 Modbus TCP 502",
           "connection_protocol": "modbus_tcp", "connection_status": "ACTIVE", "edge_id": None, "edge_name": None, "address_kind": "modbus",
           "address_json": {"unit_id": 16, "offset": 3151}, "job_id": uuid4(), "binding_enabled": False}
    fetch = AsyncMock(return_value=[row])
    with patch.object(collect, "fetch_all", fetch):
        out = await collect.list_signals(AsyncMock(), TENANT, resource_id=None, query=None, limit=100)
    sql = fetch.call_args.args[1]
    assert "b.enabled = TRUE AND b.valid_to IS NULL" not in sql and "ORDER BY b.enabled DESC" in sql
    assert out[0]["enabled"] is False and out[0]["binding_enabled"] is False
    assert out[0]["source"]["connection_name"] == "PC03 Modbus TCP 502" and out[0]["address_json"] == {"unit_id": 16, "offset": 3151}
    assert out[0]["source"]["binding_enabled"] is False
