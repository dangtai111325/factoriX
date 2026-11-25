"""Round-2 backend fixes: signal address edit (R2-SG-03), commissioning while the collector enrolls
(R2-CN-02), resource change history (R2-HS-05), Move (R2-HS-01) and asyncpg parameter typing."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from factorix.domain.source_address import validate_address_patch
from factorix.modules import collect, resources
from factorix.modules.protocols import validate_mqtt_topic
from factorix.platform.errors import AppError

# ---------------------------------------------------------------------------------------- R2-SG-03


def test_opc_address_patch_rewrites_source_time_node() -> None:
    current = {"node_id": "ns=3;s=Devices.AA10-02.Electrical.voltage_1", "timestamp_node_id": "ns=2;s=Devices.AA10-01.Electrical.source_timestamp"}
    check = validate_address_patch("opcua", current, {"timestamp_node_id": "ns=3;s=Devices.AA10-02.Electrical.source_timestamp"}, data_type="float64")
    assert check.ok
    assert check.address == {"node_id": current["node_id"], "timestamp_node_id": "ns=3;s=Devices.AA10-02.Electrical.source_timestamp"}
    removed = validate_address_patch("opcua", current, {"timestamp_node_id": None}, data_type="float64")
    assert removed.ok and "timestamp_node_id" not in removed.address
    bad = validate_address_patch("opcua", current, {"node_id": "Devices.AA10-02"}, data_type="float64")
    assert [e["code"] for e in bad.errors] == ["INVALID_NODE_ID"]


def test_address_patch_rejects_unknown_and_invalid_fields_per_protocol() -> None:
    unknown = validate_address_patch("opcua", {"node_id": "i=1"}, {"offset": 3}, data_type="float64")
    assert unknown.errors[0]["code"] == "UNKNOWN_FIELD"
    jp = validate_address_patch("mqtt", {"topic": "a/b", "jsonpath": "$.x"}, {"jsonpath": "x.y"}, data_type="float64", topic_error=validate_mqtt_topic)
    assert jp.errors[0]["code"] == "INVALID_JSONPATH"
    topic = validate_address_patch("mqtt", {"topic": "a/b", "jsonpath": "$.x"}, {"topic": "a/#/b"}, data_type="float64", topic_error=validate_mqtt_topic)
    assert topic.errors[0]["code"] == "TOPIC"
    ts_off = validate_address_patch("websocket", {"jsonpath": '$.machines["M-01"].order.so'}, {"timestamp_path": ""}, data_type="int64")
    assert ts_off.ok and ts_off.address["timestamp_path"] == ""
    http = validate_address_patch("http", {"path": "/a", "jsonpath": "$.x"}, {"path": "http://evil/x"}, data_type="string")
    assert http.errors[0]["code"] == "INVALID"


def test_modbus_address_patch_is_planned_and_type_checked() -> None:
    current = {"unit_id": 11, "offset": 100, "native_type": "uint16", "register_area": "holding"}
    ok = validate_address_patch("modbus_tcp", current, {"unit_id": 12, "offset": 140}, data_type="int64")
    assert ok.ok and ok.address["unit_id"] == 12 and ok.native_type == "uint16"
    ascii_needs_count = validate_address_patch("modbus_tcp", current, {"native_type": "ascii"}, data_type="string")
    assert ascii_needs_count.errors[0]["code"] == "ADDRESS"
    wrong_type = validate_address_patch("modbus_tcp", current, {"native_type": "float32"}, data_type="string")
    assert wrong_type.errors[0]["code"] == "TYPE"
    out_of_range = validate_address_patch("modbus_tcp", current, {"offset": 70000, "round_digits": 2, "nullable": True}, data_type="int64")
    assert [e["path"] for e in out_of_range.errors] == ["offset"]


class _SignalDB:
    """collect.fetch_all / fetch_one / execute for the address-edit paths."""

    def __init__(self, signals: dict[Any, dict[str, Any]], sources: dict[Any, dict[str, Any]]) -> None:
        self.signals = signals
        self.sources = sources
        self.executed: list[tuple[str, dict[str, Any]]] = []

    async def fetch_all(self, _session: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        if "FROM signal_definitions WHERE tenant_id" in sql:
            return [dict(row, id=sid) for sid, row in self.signals.items() if sid in params["ids"]]
        if "DISTINCT ON (b.signal_id)" in sql:
            return [dict(row, signal_id=sid) for sid, row in self.sources.items() if sid in params["ids"]]
        raise AssertionError(sql[:80])

    async def fetch_one(self, _session: Any, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        if sql.lstrip().startswith("UPDATE signal_definitions SET version"):
            row = self.signals[params["id"]]
            if int(row["version"]) != params["version"]:
                return None
            row["version"] = int(row["version"]) + 1
            return {"version": row["version"]}
        raise AssertionError(sql[:80])

    async def execute(self, _session: Any, sql: str, params: dict[str, Any]) -> None:
        self.executed.append((" ".join(sql.split()), params))


def _source(edge: Any, node: str, ts_node: str) -> dict[str, Any]:
    return {
        "binding_id": uuid4(), "revision": 1, "enabled": True, "transform_chain_json": [],
        "source_field_id": uuid4(), "acquisition_job_id": uuid4(), "address_kind": "opcua",
        "address_json": {"node_id": node, "timestamp_node_id": ts_node}, "native_datatype": "float64",
        "decode_json": {}, "ordinal": 0, "connection_id": uuid4(), "protocol": "opcua", "edge_id": edge, "connection_status": "ACTIVE",
    }


@pytest.mark.asyncio
async def test_bulk_address_is_all_or_nothing_with_per_item_errors() -> None:
    edge = uuid4()
    good, stale = uuid4(), uuid4()
    db = _SignalDB(
        {good: {"version": 3, "status": "ACTIVE", "data_type": "float64", "display_name": "V1"}, stale: {"version": 5, "status": "ACTIVE", "data_type": "float64", "display_name": "V2"}},
        {good: _source(edge, "ns=3;s=D.AA10-02.v1", "ns=2;s=D.AA10-01.ts"), stale: _source(edge, "ns=3;s=D.AA10-02.v2", "ns=2;s=D.AA10-01.ts")},
    )
    body = collect.SignalBulkAddressIn(
        items=[
            {"signal_id": str(good), "version": 3, "address_patch": {"timestamp_node_id": "ns=3;s=D.AA10-02.ts"}},
            {"signal_id": str(stale), "version": 4, "address_patch": {"timestamp_node_id": "ns=3;s=D.AA10-02.ts"}},
            {"signal_id": str(good), "version": 3, "address_patch": {"offset": 1}},
        ]
    )
    bump = AsyncMock()
    with patch.object(collect, "fetch_all", db.fetch_all), patch.object(collect, "fetch_one", db.fetch_one), patch.object(collect, "execute", db.execute), patch.object(collect, "bump_edge_release", bump), patch.object(collect, "audit", AsyncMock()):
        with pytest.raises(AppError) as exc:
            await collect.bulk_address_signals(None, uuid4(), uuid4(), body, "c")
        assert exc.value.status == 422 and exc.value.code == "BULK_ADDRESS_REJECTED"
        codes = {(e["index"], e["code"]) for e in exc.value.extra["item_errors"]}
        assert codes == {(1, "RESOURCE_VERSION_CONFLICT"), (2, "DUPLICATE"), (2, "UNKNOWN_FIELD")}
        assert db.executed == [] and bump.await_count == 0  # nothing written

        ok = collect.SignalBulkAddressIn(
            items=[
                {"signal_id": str(good), "version": 3, "address_patch": {"timestamp_node_id": "ns=3;s=D.AA10-02.ts"}},
                {"signal_id": str(stale), "version": 5, "address_patch": {"timestamp_node_id": "ns=2;s=D.AA10-01.ts"}},  # unchanged
            ]
        )
        result = await collect.bulk_address_signals(None, uuid4(), uuid4(), ok, "c")
    assert result["count"] == 1 and result["unchanged"] == [str(stale)]
    updated = result["updated"][0]
    assert updated["signal_id"] == str(good) and updated["version"] == 4
    assert updated["source"]["address_json"]["timestamp_node_id"] == "ns=3;s=D.AA10-02.ts"
    statements = [sql for sql, _ in db.executed]
    assert any(sql.startswith("UPDATE signal_bindings SET valid_to") for sql in statements)
    new_binding = next(params for sql, params in db.executed if sql.startswith("INSERT INTO signal_bindings"))
    assert new_binding["signal_id"] == good and new_binding["revision"] == 2  # same signal id, next revision
    assert bump.await_count == 1 and bump.await_args.kwargs["edge_id"] == edge


# ---------------------------------------------------------------------------------------- R2-CN-02


class _Settings:
    def __init__(self, appliance: bool) -> None:
        self.appliance = appliance


@pytest.mark.asyncio
async def test_test_command_is_accepted_while_the_collector_enrolls() -> None:
    edge = {"id": uuid4(), "enrollment_status": "UNENROLLED"}
    with patch("factorix.platform.settings.get_settings", return_value=_Settings(True)):
        await collect._assert_edge_can_run(None, edge)  # appliance: the built-in collector is enrolling
    with patch("factorix.platform.settings.get_settings", return_value=_Settings(False)):
        with patch.object(collect, "fetch_one", AsyncMock(return_value={"ok": 1})):
            await collect._assert_edge_can_run(None, edge)  # unused token issued: enrollment pending
        with patch.object(collect, "fetch_one", AsyncMock(return_value=None)):
            with pytest.raises(AppError) as exc:
                await collect._assert_edge_can_run(None, edge)
        assert exc.value.code == "EDGE_NOT_ENROLLED"
    with patch("factorix.platform.settings.get_settings", return_value=_Settings(True)):
        with pytest.raises(AppError):
            await collect._assert_edge_can_run(None, {"id": uuid4(), "enrollment_status": "REVOKED"})


def test_reaper_says_collector_did_not_start_for_pending_tests() -> None:
    from factorix.transport.app import commissioning_timeout

    code, text = commissioning_timeout("PENDING", 30)
    assert code == "EDGE_NOT_STARTED" and text.startswith("Collector did not start")
    code, text = commissioning_timeout("RUNNING", 30)
    assert code == "TIMEOUT" and "did not report a result" in text


# ---------------------------------------------------------------------------------------- R2-HS-05


def test_resource_edit_history_records_every_changed_field() -> None:
    current = {"name": "Line 1", "code": "L1", "description": "", "properties_json": {"a": 1}, "tags_json": []}
    before, after = resources.resource_changes(current, {"name": "Line 1", "code": "L1", "description": "Dây chuyền 1", "properties": {"a": 1, "b": "x"}, "tags": []})
    assert before == {"description": "", "properties": {"a": 1}}
    assert after == {"description": "Dây chuyền 1", "properties": {"a": 1, "b": "x"}}
    before, after = resources.resource_changes(current, {"name": "Line A", "code": "LA", "description": "", "properties": {"a": 1}, "tags": ["x"]})
    assert set(before) == set(after) == {"name", "code", "tags"}


# ---------------------------------------------------------------------------------------- R2-HS-01 (Move)


@pytest.mark.asyncio
async def test_move_rewrites_descendant_paths_with_typed_exact_prefix() -> None:
    tenant, actor, node, parent, site = uuid4(), uuid4(), uuid4(), uuid4(), uuid4()
    current = {"id": node, "code": "AA10_01", "name": "AA10-01", "path_code": "T/F/L_1/AA10_01", "site_id": site, "version": 2, "type_key": "machine", "parent_id": uuid4()}
    target = {"id": parent, "code": "L2", "name": "Line 2", "path_code": "T/F/L2", "site_id": site, "version": 1, "type_key": "line"}
    executed: list[tuple[str, dict[str, Any]]] = []

    async def execute(_session: Any, sql: str, params: dict[str, Any]) -> None:
        executed.append((" ".join(sql.split()), params))

    fetch_one = AsyncMock(side_effect=[{"hierarchy_mode": "guided"}, None, None, {"id": uuid4()}])
    with patch.object(resources, "_resource", AsyncMock(side_effect=[current, target])), patch.object(resources, "fetch_one", fetch_one), patch.object(resources, "fetch_all", AsyncMock(return_value=[])), patch.object(resources, "execute", execute), patch.object(resources, "_link", AsyncMock()), patch.object(resources, "audit", AsyncMock()), patch.object(resources, "get_resource", AsyncMock(return_value={"id": str(node)})), patch("factorix.modules.collect.bump_edge_release", AsyncMock()):
        await resources.move_resource(None, tenant, actor, node, resources.MoveIn(version=2, parent_id=str(parent)), "c")
    sql, params = next((sql, params) for sql, params in executed if "SUBSTRING" in sql)
    assert "SUBSTRING(path_code FROM CAST(:pos AS integer))" in sql and "LIKE" not in sql
    assert "left(path_code, CAST(:prefix_len AS integer)) = CAST(:old_prefix AS text)" in sql
    assert params["new_prefix"] == "T/F/L2/AA10_01"
    assert params["pos"] == len("T/F/L_1/AA10_01") + 1 and isinstance(params["pos"], int)
    assert params["old_prefix"] == "T/F/L_1/AA10_01/" and params["prefix_len"] == len(params["old_prefix"])


# ---------------------------------------------------------------------------------------- asyncpg typing

SRC = Path(__file__).resolve().parents[2] / "src" / "factorix"
# A bare bind parameter where Postgres infers ``text`` (or cannot infer a type): asyncpg then
# rejects the Python int/datetime at execution time (the Move 500 was SUBSTRING(... FROM :pos)).
HAZARDS = [
    re.compile(r"SUBSTRING\([^)]*\bFROM\s+:\w+", re.I),
    re.compile(r"SUBSTRING\([^)]*\bFOR\s+:\w+", re.I),
    re.compile(r"(?<!CAST\()(?<!\w):\w+\s*\|\|"),
    re.compile(r"\|\|\s*:\w+"),
    re.compile(r"\binterval\s+:\w+", re.I),
    re.compile(r"COALESCE\(\s*:\w+", re.I),
    re.compile(r"\bleft\([^,]+,\s*:\w+", re.I),
]


def test_sql_has_no_untyped_parameters_in_ambiguous_positions() -> None:
    problems = []
    for path in sorted(SRC.rglob("*.py")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            for hazard in HAZARDS:
                if hazard.search(line):
                    problems.append(f"{path.relative_to(SRC)}:{number}: {line.strip()}")
    assert problems == [], "Cast these parameters explicitly:\n" + "\n".join(problems)
