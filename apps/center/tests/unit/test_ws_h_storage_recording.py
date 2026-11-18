"""WS-H (v6): storage objects, binding resolution, publish saga, model-field recording, historian sources.

Covers the review P0/P1 items and the tdengine_guide gates G-00, G-02..G-06, G-09, G-10 and the
ON_CHANGE / ON_NEW_EVENT cases OC-001..OC-015 / PR-004..PR-006 at the unit level (no live system).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.modules import historian_sources as HSRC
from factorix.modules import storage_bindings as SB
from factorix.modules import storage_model_recorder as REC
from factorix.modules import storage_objects as SO
from factorix.modules import storage_revisions as SR

TENANT = UUID("9ed2d4e8-1f0c-46f9-a9e0-d25a18492265")
DB = f"fx_t_{TENANT.hex}"
MODEL = uuid4()
T0 = datetime(2026, 11, 18, 1, 0, tzinfo=timezone.utc)

E1_COLUMNS = [
    {"name": "ts", "td_type": "TIMESTAMP", "role": "timestamp"},
    {"name": "event_key", "td_type": "VARCHAR", "length": 64, "primary_key": True},
    {"name": "source_timestamp", "td_type": "TIMESTAMP"},
    {"name": "publish_timestamp", "td_type": "TIMESTAMP"},
    {"name": "quality", "td_type": "VARCHAR", "length": 16},
    {"name": "is_null", "td_type": "BOOL"},
    {"name": "model_ref", "td_type": "VARCHAR", "length": 36},
    {"name": "data_epoch", "td_type": "BIGINT"},
    {"name": "value_i64", "td_type": "BIGINT"},
    {"name": "value_text", "td_type": "VARCHAR", "length": 256},
]
TAGS = [{"name": "machine_ref", "td_type": "VARCHAR", "length": 36},
        {"name": "line_ref", "td_type": "VARCHAR", "length": 36},
        {"name": "field_key", "td_type": "VARCHAR", "length": 64}]


# ---------------------------------------------------------------------------------------------
# G-00: composite key DDL (verified on tdengine/tsdb:3.4.3.9) and validation
# ---------------------------------------------------------------------------------------------

def test_stable_ddl_emits_composite_key_and_wizard_payload_is_normalized():
    spec = SR.stable_spec_from({"database": DB, "name": "st_machine_state_change", "columns": E1_COLUMNS, "tags": TAGS})
    assert spec.columns[0].role == "time_key"  # wizard sends role 'timestamp' (R1-04 root cause)
    assert SO.validate_stable_spec(spec).valid
    ddl = SO.generate_create_stable_ddl(spec)
    assert ddl.startswith(f"CREATE STABLE `{DB}`.`st_machine_state_change` (")
    assert "`event_key` VARCHAR(64) COMPOSITE KEY" in ddl
    assert "IF NOT EXISTS" not in ddl  # a clash is reported, never hidden
    assert ddl.endswith("TAGS (`machine_ref` VARCHAR(36), `line_ref` VARCHAR(36), `field_key` VARCHAR(64))")


@pytest.mark.parametrize(
    ("columns", "code"),
    [
        ([{"name": "ts", "td_type": "TIMESTAMP"}, {"name": "v", "td_type": "DOUBLE"},
          {"name": "k", "td_type": "VARCHAR", "length": 8, "primary_key": True}], "COMPOSITE_KEY_POSITION"),
        ([{"name": "ts", "td_type": "TIMESTAMP"}, {"name": "k", "td_type": "DOUBLE", "primary_key": True}], "COMPOSITE_KEY_TYPE"),
        ([{"name": "ts", "td_type": "TIMESTAMP"}, {"name": "txt", "td_type": "VARCHAR"}], "LENGTH_REQUIRED"),
    ],
)
def test_stable_validation_rejects_bad_composite_keys_and_lengths(columns, code):
    res = SO.validate_stable_spec(SR.stable_spec_from({"database": DB, "name": "st_x", "columns": columns, "tags": TAGS}))
    assert not res.valid and any(e["code"] == code for e in res.errors)


def test_system_objects_and_reserved_names_are_rejected():
    assert any(e["code"] == "SYSTEM_OBJECT" for e in SO.validate_stable_spec(
        SR.stable_spec_from({"database": DB, "name": "op_int64", "columns": E1_COLUMNS, "tags": TAGS})).errors)
    sub = SO.SubtableSpec(DB, "op_bool", "zz_x", {"m": "1"})
    assert any(e["code"] == "SYSTEM_PARENT" for e in SO.validate_subtable_spec(sub, [SO.TagSpec("m", "VARCHAR", 8)]).errors)
    assert any(e["code"] == "RESERVED_PREFIX" for e in SO.validate_database_spec(SO.DatabaseSpec("fx_t_other")).errors)
    assert any(e["code"] == "RESERVED_NAME" for e in SO.validate_database_spec(SO.DatabaseSpec("log")).errors)
    with pytest.raises(SO.StorageObjectError) as err:
        SO.validate_identifier("a" * 20008, "supertable name")
    assert err.value.code == "IDENTIFIER_TOO_LONG"  # R1-29: length, not "must start with a letter"


def test_database_spec_accepts_null_wizard_fields_and_defaults_to_us():
    spec = SR._database_spec({"name": "mes_hist", "vgroups": None, "replica": None, "retention_days": 3650})
    assert (spec.vgroups, spec.replica, spec.precision, spec.keep) == (1, 1, "us", "3650d")


def test_subtable_requires_every_tag_value_and_respects_tag_length():
    tags = [SO.TagSpec("machine_ref", "VARCHAR", 36), SO.TagSpec("field_key", "VARCHAR", 8)]
    res = SO.validate_subtable_spec(SO.SubtableSpec(DB, "st_a", "s1", {"machine_ref": "x", "field_key": "too_long_key"}), tags)
    assert any(e["code"] == "TAG_TOO_LONG" for e in res.errors)
    res = SO.validate_subtable_spec(SO.SubtableSpec(DB, "st_a", "s1", {"machine_ref": "x"}), tags)
    assert any(e["code"] == "MISSING_TAG_VALUES" for e in res.errors)


# ---------------------------------------------------------------------------------------------
# G-02 / G-04: model field leaves
# ---------------------------------------------------------------------------------------------

SPEC = {
    "version": 2,
    "root": {"type": "object", "children": [
        {"type": "field", "key": "status", "mode": "mapping", "ref": {"signal_id": str(uuid4())}, "value_type": "int"},
        {"type": "field", "key": "stop_error", "mode": "mapping", "ref": {"signal_id": str(uuid4())}, "value_type": "string"},
        {"type": "object", "key": "electrical", "children": [
            {"type": "field", "key": "voltage_1", "mode": "calculated", "expr": "1", "value_type": "float"},
        ]},
        {"type": "field", "key": "source_timestamp", "mode": "calculated", "expr": "now()", "value_type": "timestamp"},
    ]},
}


def test_model_leaf_fields_lists_leaves_with_paths_and_types_not_containers():
    leaves = {leaf["path"]: leaf for leaf in SB.model_leaf_fields(SPEC)}
    assert set(leaves) == {"status", "stop_error", "electrical/voltage_1", "source_timestamp"}
    assert leaves["status"]["value_type"] == "int" and leaves["electrical/voltage_1"]["data_type"] == "float64"
    assert leaves["source_timestamp"]["is_timestamp"] is True
    assert SB.extract_field({"electrical": {"voltage_1": 1.5}}, "/electrical/voltage_1") == (True, 1.5)
    assert SB.extract_field({"status": None}, "status") == (True, None)  # null is a value
    assert SB.extract_field({}, "status") == (False, None)  # missing = not sampled
    assert SB.suggest_value_column("int", ["value_f64", "value_i64"]) == "value_i64"
    assert not SB.model_type_compatible("string", "BIGINT")


# ---------------------------------------------------------------------------------------------
# Binding resolution + publish saga with fakes
# ---------------------------------------------------------------------------------------------


class FakeDb:
    """Minimal SQL fake for storage_revisions (patched fetch_one / fetch_all / execute)."""

    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self.bindings: list[dict[str, Any]] = []
        self.ops: dict[str, dict[str, Any]] = {}
        self.objects: list[dict[str, Any]] = []
        self.fail_on: str | None = None

    async def fetch_one(self, _s: Any, sql: str, p: dict[str, Any]) -> dict[str, Any] | None:
        low = " ".join(sql.lower().split())
        if "from storage_object_drafts" in low:
            return None
        if "from storage_operations" in low:
            for op in self.ops.values():
                if op["idempotency_key"] == p["key"]:
                    return op
            return None
        if low.startswith("insert into storage_objects"):
            self.objects.append(dict(p))
            return {"id": p["id"]}
        if "from storage_objects" in low:
            return None
        return None

    async def fetch_all(self, _s: Any, sql: str, p: dict[str, Any]) -> list[dict[str, Any]]:
        low = " ".join(sql.lower().split())
        if "from output_groups" in low:
            return [{"id": MODEL, "display_name": "AA10-01 · State", "kind": "STATE", "version": 3,
                     "spec_json": SPEC, "resource_id": None}]
        if "from storage_bindings" in low:
            return self.bindings
        return []

    async def execute(self, _s: Any, sql: str, p: dict[str, Any]) -> None:
        low = " ".join(sql.lower().split())
        if self.fail_on and self.fail_on in low:
            raise RuntimeError("registry write failed")
        self.executed.append((low, p))
        if low.startswith("insert into storage_operations"):
            self.ops[str(p["id"])] = {"id": p["id"], "status": "PREPARING", "idempotency_key": p["key"],
                                      "started_at": p["now"], "requested_at": p["now"]}
        if low.startswith("update storage_operations set status = 'applied'"):
            self.ops[str(p["id"])]["status"] = "APPLIED"


class FakeSession:
    async def commit(self) -> None:
        pass

    async def rollback(self) -> None:
        pass


class FakeTd:
    def __init__(self, *, existing: set[str] | None = None, tag_values: dict[str, str] | None = None) -> None:
        self.existing = set(existing or ())
        self.sql: list[str] = []
        self.tag_values = tag_values

    async def query_rows(self, sql: str) -> list[dict[str, Any]]:
        if sql.startswith("DESCRIBE"):
            rows = [{"field": c["name"], "type": c["td_type"], "length": c.get("length") or 8,
                     "note": "COMPOSITE KEY" if c.get("primary_key") else ""} for c in E1_COLUMNS]
            rows += [{"field": t["name"], "type": "VARCHAR", "length": t["length"], "note": "TAG"} for t in TAGS]
            return rows
        m = re.search(r"table_name = '([A-Za-z0-9_]+)'", sql) or re.search(r"stable_name = '([A-Za-z0-9_]+)'", sql)
        name = m.group(1) if m else ""
        if "ins_tags" in sql:
            return [{"tag_name": k, "tag_value": v} for k, v in (self.tag_values or {}).items()]
        if "ins_tables" in sql and "stable_name" in sql.split("FROM")[0]:
            return [{"table_name": name, "stable_name": "st_machine_state_change"}] if name in self.existing else []
        if name in self.existing:
            return [{"name": name}]
        return []

    async def execute_sql(self, sql: str) -> int:
        self.sql.append(sql)
        m = re.match(r"CREATE TABLE `[^`]+`\.`([^`]+)`", sql)
        if m:
            self.existing.add(m.group(1))
        return 0


@pytest.fixture
def fakedb(monkeypatch: pytest.MonkeyPatch) -> FakeDb:
    db = FakeDb()
    for mod in (SR, SB):
        monkeypatch.setattr(mod, "fetch_one", db.fetch_one, raising=False)
        monkeypatch.setattr(mod, "fetch_all", db.fetch_all, raising=False)
    monkeypatch.setattr(SR, "execute", db.execute)
    return db


def _sub_spec(**over: Any) -> dict[str, Any]:
    spec = {
        "database": DB, "stable": "st_machine_state_change", "name": "state_aa10_01_status",
        "tag_values": [{"name": "machine_ref", "value": "m-uuid"}, {"name": "line_ref", "value": "l-uuid"},
                       {"name": "field_key", "value": "status"}],
        "bindings": [{"source_kind": "model_field", "model_id": str(MODEL), "field_path": "status",
                      "column_name": "value_i64"}],
        "recording": {"mode": "ON_CHANGE", "start_recording": False},
    }
    spec.update(over)
    return spec


async def _draft(service: SR.StorageRevisionService, spec: dict[str, Any]) -> UUID:
    rec = await service.create_draft(FakeSession(), TENANT, None, {"kind": "subtable", "spec": spec})
    return UUID(rec["id"])


@pytest.mark.asyncio
async def test_bindings_require_a_field_leaf_a_value_column_and_one_owner(fakedb: FakeDb):
    service = SR.StorageRevisionService(FakeTd())
    cols, _tags = await service.stable_schema(FakeSession(), TENANT, DB, "st_machine_state_change")
    sub = SR.subtable_spec_from(_sub_spec())

    async def codes(**over: Any) -> set[str]:
        try:
            await service.resolve_bindings(FakeSession(), TENANT, sub, cols, _sub_spec(**over))
        except SO.StorageObjectError as exc:
            return {e["code"] for e in exc.field_errors}
        return set()

    model_only = [{"source_id": str(MODEL), "source_kind": "model_field", "column_name": "value_i64"}]
    assert "FIELD_NOT_FOUND" in await codes(bindings=model_only)  # P0-1: a model is not a field
    assert "RESERVED_COLUMN" in await codes(bindings=[{**_sub_spec()["bindings"][0], "column_name": "event_key"}])
    assert "TYPE_MISMATCH" in await codes(bindings=[{**_sub_spec()["bindings"][0], "field_path": "stop_error"}])
    assert "BINDING_REQUIRED" in await codes(bindings=[])
    assert await codes(bindings=[], no_binding=True) == set()
    fakedb.bindings = [{"model_id": MODEL, "model_field_path": "status", "physical_db": DB,
                        "physical_subtable": "state_other", "target_column": "value_i64"}]
    assert "FIELD_ALREADY_RECORDED" in await codes()
    fakedb.bindings = []
    resolved = await service.resolve_bindings(FakeSession(), TENANT, sub, cols, _sub_spec())
    assert resolved[0]["model_id"] == str(MODEL) and resolved[0]["model_field_path"] == "status"
    assert resolved[0]["source_kind"] == "model_field" and resolved[0]["canonical_id"] == f"mod:{MODEL}:status"


@pytest.mark.asyncio
async def test_publish_subtable_registers_model_field_binding_and_is_idempotent(fakedb: FakeDb):
    td = FakeTd(tag_values={"machine_ref": "m-uuid", "line_ref": "l-uuid", "field_key": "status"})
    service = SR.StorageRevisionService(td)
    draft_id = await _draft(service, _sub_spec())
    res = await service.publish_draft(FakeSession(), TENANT, draft_id, None)
    assert res["status"] == "APPLIED" and res["verification"]["read_back_ok"] is True
    assert td.sql == [
        f"CREATE TABLE `{DB}`.`state_aa10_01_status` USING `{DB}`.`st_machine_state_change` "
        "(`machine_ref`, `line_ref`, `field_key`) TAGS ('m-uuid', 'l-uuid', 'status')"
    ]
    binding = next(p for sql, p in fakedb.executed if sql.startswith("insert into storage_bindings"))
    assert binding["kind"] == "model_field" and binding["mid"] == MODEL and binding["path"] == "status"
    assert fakedb.objects[0]["status"] == "PAUSED"  # recording is off until explicitly started
    # Same request again (double click / retry after timeout): replay, no second CREATE.
    again = await service.publish_draft(FakeSession(), TENANT, await _draft(service, _sub_spec()), None)
    assert again["idempotent_replay"] is True and len(td.sql) == 1


@pytest.mark.asyncio
async def test_publish_detects_name_clash_instead_of_if_not_exists(fakedb: FakeDb):
    service = SR.StorageRevisionService(FakeTd(existing={"state_aa10_01_status"}))
    with pytest.raises(SO.StorageObjectError) as err:
        await service.publish_draft(FakeSession(), TENANT, await _draft(service, _sub_spec()), None)
    assert err.value.code == "NAME_CONFLICT" and err.value.http_status == 409


@pytest.mark.asyncio
async def test_failed_read_back_drops_the_new_object_and_fails_the_operation(fakedb: FakeDb):
    td = FakeTd(tag_values={"machine_ref": "WRONG", "line_ref": "l-uuid", "field_key": "status"})
    service = SR.StorageRevisionService(td)
    with pytest.raises(SO.StorageObjectError) as err:
        await service.publish_draft(FakeSession(), TENANT, await _draft(service, _sub_spec()), None)
    assert err.value.code == "VERIFICATION_FAILED"
    assert td.sql[-1] == f"DROP TABLE IF EXISTS `{DB}`.`state_aa10_01_status`"  # R1-05: no orphan
    assert any(sql.startswith("update storage_operations set status = 'failed'") for sql, _ in fakedb.executed)
    assert not any(sql.startswith("insert into storage_bindings") for sql, _ in fakedb.executed)


@pytest.mark.asyncio
async def test_registry_error_is_not_swallowed_and_compensates(fakedb: FakeDb):
    td = FakeTd(tag_values={"machine_ref": "m-uuid", "line_ref": "l-uuid", "field_key": "status"})
    fakedb.fail_on = "insert into storage_bindings"
    service = SR.StorageRevisionService(td)
    with pytest.raises(SO.StorageObjectError) as err:
        await service.publish_draft(FakeSession(), TENANT, await _draft(service, _sub_spec()), None)
    assert err.value.code == "REGISTRY_FAILED"  # G-03: never APPLIED with a missing binding
    assert td.sql[-1].startswith("DROP TABLE IF EXISTS")
    assert all(op["status"] != "APPLIED" for op in fakedb.ops.values())


@pytest.mark.asyncio
async def test_simulate_returns_no_synthetic_rows(fakedb: FakeDb):
    service = SR.StorageRevisionService(None)
    res = await service.simulate_draft(FakeSession(), TENANT, uuid4())
    assert res["sample_rows"] == []  # G-09 / R1-18b


# ---------------------------------------------------------------------------------------------
# ON_CHANGE / ON_NEW_EVENT decisions (pure)
# ---------------------------------------------------------------------------------------------

def _target(col: str = "value_i64", path: str = "status", mode: str = "ON_CHANGE") -> dict[str, list[REC.RecordingTarget]]:
    rows = [{"id": uuid4(), "physical_db": DB, "physical_subtable": f"state_{path}", "target_column": col,
             "model_id": MODEL, "model_field_path": path, "row_assembly_policy": "INDEPENDENT_EVENTS",
             "policy_config_json": {"mode": mode}, "parent_name": "st_machine_state_change"}]
    return REC.targets_from_rows(rows)


def _result(body: dict[str, Any], at: datetime, quality: str = "GOOD") -> REC.ModelResult:
    return REC.ModelResult(str(MODEL), 3, at, body, {p: (quality, None) for p in ("status", "speed", "stop_error")})


def _run(targets, bodies: list[Any], quality: list[str] | None = None, epoch: int = 1):
    states: dict[str, REC.FieldState] = {}
    written: list[REC.PlannedRecord] = []
    for i, body in enumerate(bodies):
        q = quality[i] if quality else "GOOD"
        recs, new = REC.plan_records(str(TENANT), epoch, [_result(body, T0 + timedelta(seconds=i), q)], targets, states)
        states.update(new)
        written.extend(recs)
    return written, states


def test_on_change_baseline_no_repeat_and_transitions():
    t = _target()
    ts = "2026-11-18T01:00:00.000Z"
    written, _ = _run(t, [
        {"status": 2, "source_timestamp": ts, "publish_timestamp": "a"},   # OC-001 baseline
        {"status": 2, "source_timestamp": ts, "publish_timestamp": "b"},   # OC-002/003 republish only
        {"status": 5, "source_timestamp": ts, "publish_timestamp": "c"},   # OC-004 2->5
        {"status": 2, "source_timestamp": ts, "publish_timestamp": "d"},   # OC-014 A->B->A
        {"publish_timestamp": "e"},                                        # field missing: not sampled
        {"status": 2},
    ])
    assert [r.columns["value_i64"] for r in written] == [2, 5, 2]
    assert len({r.event_key for r in written}) == 3  # OC-015: distinct keys even with the same ts
    assert written[0].columns["time_basis"] == "MODEL_BODY" and written[0].columns["model_ref"] == str(MODEL)
    assert written[0].ts == datetime(2026, 11, 18, 1, 0, tzinfo=timezone.utc)  # body source_timestamp


def test_on_change_type_semantics_null_zero_empty_and_quality():
    t = _target("value_text", "stop_error")
    written, _ = _run(t, [{"stop_error": "E1"}, {"stop_error": None}, {"stop_error": ""}, {"stop_error": None},
                          {"stop_error": "E1"}])  # OC-009
    assert [(r.columns["value_text"], r.columns["is_null"]) for r in written] == [
        ("E1", False), (None, True), ("", False), (None, True), ("E1", False)]
    t = _target("value_i64", "status")
    written, _ = _run(t, [{"status": 0}, {"status": 0.0}, {"status": False}])  # OC-010, D3.1
    assert [r.columns["value_i64"] for r in written] == [0, False]  # 0 == 0.0, but False != 0
    written, _ = _run(t, [{"status": 1}, {"status": 1}], quality=["GOOD", "BAD"])  # OC-017
    assert [r.columns["quality"] for r in written] == ["GOOD", "BAD"]


def test_on_change_state_is_durable_and_epoch_aware():
    t = _target()
    _w, states = _run(t, [{"status": 1}])
    # Engine restart: same durable state -> unchanged value writes nothing (OC-016)
    recs, _ = REC.plan_records(str(TENANT), 1, [_result({"status": 1}, T0 + timedelta(minutes=1))], t, states)
    assert recs == []
    # After a reset the new epoch writes a fresh baseline (OC-018 counterpart)
    recs, _ = REC.plan_records(str(TENANT), 2, [_result({"status": 1}, T0 + timedelta(minutes=2))], t, states)
    assert len(recs) == 1 and recs[0].data_epoch == 2
    assert REC.event_key_for(str(TENANT), "k", 1, 7) == REC.event_key_for(str(TENANT), "k", 1, 7)  # OC-013 replay


def test_every_acquisition_writes_each_sample():
    written, _ = _run(_target(mode="EVERY_ACQUISITION"), [{"status": 1}, {"status": 1}])
    assert len(written) == 2


def test_atomic_event_records_new_events_once_with_all_fields():
    rows = [{"id": uuid4(), "physical_db": DB, "physical_subtable": "progress_line_aa10_01", "target_column": c,
             "model_id": MODEL, "model_field_path": c, "row_assembly_policy": "ATOMIC_EVENT",
             "policy_config_json": {"mode": "ON_NEW_EVENT"}, "parent_name": "st_production_order_progress"}
            for c in ("so", "wo", "qty", "lot_serial")]
    targets = REC.targets_from_rows(rows)
    a = {"so": 1, "wo": 10, "qty": 1, "lot_serial": "A", "source_timestamp": "2026-11-18T01:00:00Z"}
    b = {"so": 1, "wo": 10, "qty": 1, "lot_serial": "B", "source_timestamp": "2026-11-18T01:00:05Z"}
    written, _ = _run(targets, [a, a, b, b])  # PR-004, PR-006 (redelivery), PR-005 (same qty)
    assert [(r.columns["lot_serial"], r.columns["qty"], r.columns["wo"]) for r in written] == [("A", 1, 10), ("B", 1, 10)]
    assert "is_null" not in written[0].columns and "model_field_path" not in written[0].columns


# ---------------------------------------------------------------------------------------------
# Writer SQL: only existing columns, typed, precision-aware, no silent truncation
# ---------------------------------------------------------------------------------------------

SCHEMA = [("ts", "TIMESTAMP", None), ("event_key", "VARCHAR", 64), ("quality", "VARCHAR", 16),
          ("value_i64", "BIGINT", None), ("value_text", "VARCHAR", 4)]


def test_row_sql_writes_only_existing_columns_with_db_precision():
    cols = {"ts": T0, "event_key": "k1", "quality": "GOOD", "value_i64": 5, "time_basis": "MODEL_BODY", "model_ref": "x"}
    sql = REC.build_row_sql(DB, "state_a", cols, SCHEMA, "ms")
    assert sql == f"`{DB}`.`state_a` (`ts`, `event_key`, `quality`, `value_i64`) VALUES (1794963600000, 'k1', 'GOOD', 5)"
    assert "1794963600000000" in REC.build_row_sql(DB, "state_a", cols, SCHEMA, "us")


@pytest.mark.parametrize(("value", "td_type", "length"), [
    ("abcdef", "VARCHAR", 4), (1.5, "BIGINT", None), ("12", "DOUBLE", None), (True, "BIGINT", None),
])
def test_value_literal_rejects_instead_of_truncating(value, td_type, length):
    with pytest.raises(REC.ValueRejected):
        REC.value_literal(value, td_type, length, "us")


def test_outbox_payload_round_trips_timestamps():
    cols = {"ts": T0 + timedelta(microseconds=7), "value_i64": 1}
    assert REC.decode_columns(json.loads(json.dumps(REC.encode_columns(cols)))) == cols


def test_field_quality_map_uses_signal_status_and_errors():
    from factorix.domain.body import compile_spec, evaluate_detailed

    compiled = compile_spec(SPEC)
    result = evaluate_detailed(compiled, {}, now=T0)
    sid = SPEC["root"]["children"][0]["ref"]["signal_id"]
    q = REC.field_quality_map(compiled, result, {sid: "STALE"})
    assert q["status"][0] == "STALE"
    assert q["electrical/voltage_1"] == ("GOOD", None)
    assert q["stop_error"][0] == "NO_DATA"


# ---------------------------------------------------------------------------------------------
# Historian sources and long ranges
# ---------------------------------------------------------------------------------------------

def test_historian_source_tokens():
    sid = uuid4()
    assert HSRC.parse_source_token(f"sig:{sid}").kind == "signal"
    src = HSRC.parse_source_token(f"mod:{MODEL}:electrical/voltage_1")
    assert (src.kind, src.model_id, src.field_path) == ("model_field", MODEL, "electrical/voltage_1")
    src = HSRC.parse_source_token(f"subtable:{DB}.state_a:value_i64")
    assert (src.database, src.table, src.column) == (DB, "state_a", "value_i64")
    assert HSRC.parse_source_token("subtable:db.x;drop") is None
    assert HSRC.choose_bucket_ms(T0, T0 + timedelta(days=7), 1000) == 900_000


class FakeHistClient:
    def __init__(self, total: int) -> None:
        self.total = total
        self.sql: list[str] = []

    async def query_rows(self, sql: str) -> list[dict[str, Any]]:
        self.sql.append(sql)
        if sql.startswith("DESCRIBE"):
            return [{"field": "ts", "type": "TIMESTAMP", "note": ""}, {"field": "val", "type": "DOUBLE", "note": ""},
                    {"field": "raw_quality", "type": "VARCHAR", "note": ""}, {"field": "data_epoch", "type": "BIGINT", "note": ""}]
        if "COUNT(*)" in sql:
            return [{"n": self.total}]
        if "INTERVAL(" in sql:
            return [{"bucket": T0, "avg": 2.0, "min": 1.0, "max": 3.0, "count": 10, "last": 3.0}]
        return [{"ts": T0 + timedelta(seconds=i), "value": float(i), "quality": "GOOD"} for i in range(3)]


class FakeProvider:
    def __init__(self, client: FakeHistClient) -> None:
        self.client = client


@pytest.mark.asyncio
@pytest.mark.parametrize(("total", "downsampled"), [(3, False), (50_000, True)])
async def test_historian_query_is_complete_or_explicitly_downsampled(monkeypatch, total, downsampled):
    from factorix.modules import historian_service as HS

    sid = uuid4()

    async def fetch_all(_s, sql, p):
        if "from signal_definitions" in sql.lower():
            return [{"id": sid, "key": "speed_1", "display_name": "speed_1", "unit": "rpm", "data_type": "float64",
                     "expected_interval_ms": 1000, "resource_id": None, "resource_name": "AA10-01"}]
        return []

    async def epoch(_s, _t):
        return 1

    monkeypatch.setattr(HS, "fetch_all", fetch_all)
    monkeypatch.setattr(HS, "_active_epoch", epoch)
    client = FakeHistClient(total)
    res = await HS.query_historian(object(), TENANT, {"signal_ids": [str(sid)], "range": "7d"},
                                   history_provider=FakeProvider(client))
    series = res["series"][str(sid)]
    assert series["total"] == total and series["downsampled"] is downsampled
    assert series["display_name"] == "AA10-01 · speed_1"
    assert all("value" in p and "values" not in p for p in series["points"])  # P0-3 contract
    if downsampled:
        assert series["bucket_ms"] == 600_000 and series["points"][0]["min"] == 1.0
        assert any("INTERVAL(600000a)" in q for q in client.sql)
    else:
        assert [p["value"] for p in series["points"]] == [0.0, 1.0, 2.0]


@pytest.mark.asyncio
async def test_operational_history_newest_order_returns_the_end_of_the_window():
    from unittest.mock import AsyncMock, MagicMock

    from factorix.modules.history_repository import TDengineHistoryRepository
    from factorix.platform.tdengine import TDEngineConfig

    client = MagicMock()
    client.config = TDEngineConfig(dsn="ws://td.test:6041")
    rows = [{"ts": T0 + timedelta(seconds=i), "val": float(i), "raw_quality": "GOOD", "event_uid": f"u{i}", "data_epoch": 1}
            for i in (9, 8, 7)]
    client.query_rows = AsyncMock(return_value=rows)
    repo = TDengineHistoryRepository(client)
    repo._signal_meta_map = AsyncMock(return_value={})  # type: ignore[method-assign]
    page = await repo.query_raw(TENANT, signal_id=uuid4(), start=T0, end=T0 + timedelta(minutes=1), limit=2,
                                mode="operational", value_type="float64", active_epoch=1, order="newest")
    assert [p.value for p in page.items] == [8.0, 9.0]  # R1-A P1-10: not the oldest minutes
    assert "ORDER BY `ts` DESC" in client.query_rows.call_args.args[0]
    assert page.next_cursor is None and page.coverage_notes


# ---------------------------------------------------------------------------------------------
# Round 2
# ---------------------------------------------------------------------------------------------

def test_model_machine_is_derived_from_rule_references_when_resource_id_is_empty():
    machine, line = str(uuid4()), str(uuid4())
    resources = {machine: {"id": machine, "parent_id": line, "name": "AA10-01", "code": "AA10-01", "type_key": "machine"},
                 line: {"id": line, "parent_id": None, "name": "Line A1", "code": "A1", "type_key": "line"}}
    spec = {"version": 2, "root": {"type": "object", "children": [
        {"type": "field", "key": "line_name", "mode": "calculated", "expr": f"{{{{res:{machine}}}}}.@line.@name", "value_type": "string"},
        {"type": "field", "key": "machine_name", "mode": "calculated", "expr": f"{{{{res:{machine}}}}}.@name", "value_type": "string"},
    ]}}
    assert SB.model_resource_id(spec, resources, {}) == machine
    ctx = SB.resource_context(resources, machine)
    assert ctx["ancestors"][0]["type_key"] == "line"
    assert SB.model_resource_id({"version": 2, "root": {"type": "object", "children": []}}, resources, {}) is None


def test_parent_given_as_db_dot_stable_wins_over_defaulted_database():
    sub = SR.subtable_spec_from({"database": "fx_t_default", "stable": "zz_db.st_a", "name": "s"})
    assert (sub.database, sub.stable) == ("zz_db", "st_a")


def test_alter_stable_plan_is_additive_and_validated():
    service = SR.StorageRevisionService(None)
    existing = ([SO.ColumnSpec("ts", "TIMESTAMP", role="time_key"), SO.ColumnSpec("v", "DOUBLE")], [SO.TagSpec("m", "VARCHAR", 36)])
    ddl, errors, _c, _t = service.plan_alter_stable(DB, "st_a", existing, {
        "add_columns": [{"name": "value_text", "td_type": "VARCHAR(256)"}], "add_tags": [{"name": "zone_ref", "td_type": "VARCHAR", "length": 36}]})
    assert not errors
    assert ddl == [f"ALTER STABLE `{DB}`.`st_a` ADD COLUMN `value_text` VARCHAR(256)",
                   f"ALTER STABLE `{DB}`.`st_a` ADD TAG `zone_ref` VARCHAR(36)"]
    _ddl, errors, _c, _t = service.plan_alter_stable(DB, "op_int64", existing, {"add_columns": [{"name": "v", "td_type": "DOUBLE"},
                                                                                              {"name": "x", "td_type": "VARCHAR"}]})
    assert {e["code"] for e in errors} >= {"SYSTEM_OBJECT", "DUPLICATE_NAME", "LENGTH_REQUIRED"}


@pytest.mark.asyncio
async def test_subtable_plan_can_use_the_parent_spec_before_the_parent_exists(fakedb):
    service = SR.StorageRevisionService(FakeTd(existing=set()))
    service.describe = lambda *_a: _empty()  # type: ignore[assignment]
    spec = _sub_spec(parent_stable_spec={"columns": E1_COLUMNS, "tags": TAGS})
    plan = await service.plan_draft(FakeSession(), TENANT, None, custom_spec={"kind": "subtable", "spec": spec})
    assert plan["ddl"][0].startswith(f"CREATE TABLE `{DB}`.`state_aa10_01_status` USING")
    assert plan["bindings"][0]["target_column"] == "value_i64" and not plan["warnings"]


async def _empty():
    return [], []


def test_gap_stats_and_compare_offsets():
    times = [T0 + timedelta(seconds=s) for s in (0, 1, 2, 30, 31)]
    g = HSRC.gap_stats(times, T0, T0 + timedelta(seconds=32), 12_000)
    assert g["gap_count"] == 1 and g["longest_gap_ms"] == 28_000 and 0 < g["coverage_pct"] < 20
    assert HSRC.gap_stats(times, T0, T0 + timedelta(seconds=32), None)["gap_count"] is None
    assert HSRC.parse_offset_ms("1d") == 86_400_000 and HSRC.parse_offset_ms("7d") == 604_800_000
    with pytest.raises(ValueError):
        HSRC.parse_offset_ms("yesterday")


def test_saved_view_query_spec_keeps_tokens_and_drops_sql():
    from factorix.modules import historian_views as HV
    from factorix.platform.errors import AppError

    sid = uuid4()
    spec = HV.normalize_query_spec({"signal_ids": [f"sig:{sid}"], "range": "24h", "sql": "DROP TABLE x", "mode": "recorded"})
    assert spec == {"range": "24h", "mode": "recorded", "sources": [str(sid)]}
    with pytest.raises(AppError):
        HV.normalize_query_spec({"sources": ["not a token;"]})


@pytest.mark.asyncio
async def test_historian_compare_period_shifts_previous_window(monkeypatch):
    from factorix.modules import historian_service as HS

    sid = uuid4()

    async def fetch_all(_s, sql, p):
        if "from signal_definitions" in sql.lower():
            return [{"id": sid, "key": "speed_1", "display_name": "speed_1", "unit": None, "data_type": "float64",
                     "expected_interval_ms": 1000, "resource_id": None, "resource_name": None}]
        return []

    async def epoch(_s, _t):
        return 1

    monkeypatch.setattr(HS, "fetch_all", fetch_all)
    monkeypatch.setattr(HS, "_active_epoch", epoch)
    res = await HS.query_historian(object(), TENANT, {"signal_ids": [str(sid)], "start": "2026-11-18T01:00:00Z",
                                                      "end": "2026-11-18T01:05:00Z", "compare_offset": "1d"},
                                   history_provider=FakeProvider(FakeHistClient(3)))
    prev = res["compare"]
    assert prev["offset_ms"] == 86_400_000 and prev["start"].startswith("2026-11-17T01:00:00")
    pt = prev["series_list"][0]["points"][0]
    assert pt["original_ts"] != pt["ts"]
    assert "gap_count" in res["series_list"][0]["stats"]
