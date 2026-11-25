"""WS-H round 4: recorder time basis / key order (R2-20) and the reset preview + R3 bookkeeping (R2-08, B-17)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.application.reset import inventory as INV
from factorix.application.reset import telemetry_reset as STAGES
from factorix.domain import rules as R
from factorix.modules import storage_model_recorder as REC

TENANT = UUID("9ed2d4e8-1f0c-46f9-a9e0-d25a18492265")
MODEL = UUID("44aedc33-697f-4f06-8db1-411040e6a7b5")
SIG = "8c7196b0-73a5-4ec9-9450-b88f5a856634"
DB = "fx_t_" + TENANT.hex
BODY_TS = datetime(2026, 11, 18, 6, 50, 25, 639000, tzinfo=timezone.utc)


def _targets(mode: str = "ON_CHANGE") -> dict[str, list[REC.RecordingTarget]]:
    rows = [{"id": uuid4(), "physical_db": DB, "physical_subtable": "condition_aa10_02_ambient_temp",
             "target_column": "value_f64", "model_id": MODEL, "model_field_path": "ambient_temp",
             "row_assembly_policy": "INDEPENDENT_EVENTS", "policy_config_json": {"mode": mode},
             "parent_name": "st_machine_condition_value"}]
    return REC.targets_from_rows(rows)


def _result(value: float, published: datetime, field_ts: datetime | None) -> REC.ModelResult:
    body = {"source_timestamp": BODY_TS.isoformat(), "publish_timestamp": published.isoformat(), "ambient_temp": value}
    return REC.ModelResult(str(MODEL), 1, published, body, {"ambient_temp": ("GOOD", None)},
                           {"ambient_temp": field_ts} if field_ts else {})


def _plan(results: list[REC.ModelResult]) -> list[REC.PlannedRecord]:
    states: dict[str, REC.FieldState] = {}
    out: list[REC.PlannedRecord] = []
    for res in results:
        recs, new = REC.plan_records(str(TENANT), 1, [res], _targets(), states)
        states.update(new)
        out.extend(recs)
    return out


# ------------------------------------------------------------------------------------------------
# R2-20
# ------------------------------------------------------------------------------------------------

def test_event_key_is_deterministic_hex_32_and_sorts_in_write_order() -> None:
    keys = [REC.event_key_for(str(TENANT), "b:value_f64", 1, seq) for seq in (1, 2, 9, 10, 11, 255, 4096)]
    assert all(re.fullmatch(r"[0-9a-f]{32}", k) for k in keys)
    assert keys == sorted(keys)  # TDengine orders one ts by the composite key -> write order
    assert REC.event_key_for(str(TENANT), "b:value_f64", 1, 7) == REC.event_key_for(str(TENANT), "b:value_f64", 1, 7)
    assert REC.event_key_for(str(TENANT), "b:value_f64", 1, 7) != REC.event_key_for(str(TENANT), "other", 1, 7)
    # a later epoch sorts after an earlier one
    assert REC.event_key_for(str(TENANT), "b", 2, 1) > REC.event_key_for(str(TENANT), "b", 1, 999)


def test_same_body_timestamp_two_values_use_the_field_source_time() -> None:
    """Live R2-20 case: body source_timestamp = latest_ts() of all model signals stays 06:50:25.639
    while ambient_temp (its own source time 06:50:24.239 / 06:50:25.239) changes 29.901 -> 29.916."""
    f1 = BODY_TS - timedelta(milliseconds=1400)
    f2 = BODY_TS - timedelta(milliseconds=400)
    recs = _plan([_result(29.901, BODY_TS + timedelta(seconds=1), f1), _result(29.916, BODY_TS + timedelta(seconds=2), f2)])
    assert [r.columns["value_f64"] for r in recs] == [29.901, 29.916]
    assert [r.ts for r in recs] == [f1, f2]  # distinct, ordered: the field's own change times
    assert all(r.columns["time_basis"] == "FIELD_SOURCE" for r in recs)
    assert [r.columns["field_source_timestamp"] for r in recs] == [f1, f2]
    assert all(r.columns["source_timestamp"] == BODY_TS for r in recs)  # body time kept as-is (guide D2)


def test_without_field_provenance_the_body_time_is_kept_and_rows_stay_ordered() -> None:
    recs = _plan([_result(29.901, BODY_TS + timedelta(seconds=1), None), _result(29.916, BODY_TS + timedelta(seconds=2), None)])
    assert [r.ts for r in recs] == [BODY_TS, BODY_TS]  # MODEL_BODY: two values at one body time (legal, OC-015)
    assert all(r.columns["time_basis"] == "MODEL_BODY" and r.columns["field_source_timestamp"] is None for r in recs)
    assert recs[0].event_key < recs[1].event_key  # the later change sorts last at that ts


@dataclass
class _Item:
    path: str
    mode: str
    signal_id: str | None = None


@dataclass
class _Compiled:
    fields: list[_Item]


def test_field_source_times_only_for_mapping_fields_with_a_sample() -> None:
    t = datetime(2026, 11, 18, 6, 50, 25, 239000, tzinfo=timezone.utc)
    compiled = _Compiled([
        _Item("ambient_temp", "mapping", SIG),
        _Item("machine_temp_1", "mapping", "00000000-0000-0000-0000-000000000001"),  # no sample
        _Item("source_timestamp", "calculated"),
        _Item("speed_ratio", "calculated", None),
    ])
    samples = {SIG: R.Sample(29.916, "GOOD", source_time=t, received_time=t + timedelta(milliseconds=687))}
    assert REC.field_source_times(compiled, samples) == {"ambient_temp": t}
    # received time when the source has no own time (same fallback as latest_ts)
    samples = {SIG: R.Sample(1.0, "GOOD", source_time=None, received_time=t)}
    assert REC.field_source_times(compiled, samples) == {"ambient_temp": t}


def test_model_result_without_field_times_is_still_constructible() -> None:
    res = REC.ModelResult(str(MODEL), 1, BODY_TS, {"x": 1}, {})
    assert res.field_source_ts == {}


# ------------------------------------------------------------------------------------------------
# R2-08 reset preview inventory
# ------------------------------------------------------------------------------------------------

class _Res:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def mappings(self) -> "_Res":
        return self

    def all(self) -> list[dict[str, Any]]:
        return self._rows

    def first(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None


class _Session:
    async def execute(self, stmt: Any, params: Any = None) -> _Res:
        low = " ".join(str(stmt).lower().split())
        if "from storage_objects" in low and "group by object_type" in low:
            return _Res([
                {"object_type": "database", "status": "ACTIVE", "n": 1},
                {"object_type": "stable", "status": "ACTIVE", "n": 2},
                {"object_type": "subtable", "status": "ACTIVE", "n": 5},
                {"object_type": "subtable", "status": "PAUSED", "n": 1},
            ])
        if "from storage_objects" in low and "object_type = 'stable'" in low:
            return _Res([{"physical_db": DB, "physical_name": "st_machine_condition_value"},
                         {"physical_db": DB, "physical_name": "st_energy_value"}])
        if "from storage_bindings" in low:
            return _Res([{"n": 9}])
        raise AssertionError(f"unexpected SQL {low}")


class _TD:
    def __init__(self, counts: dict[str, int | Exception]) -> None:
        self.counts = counts
        self.sql: list[str] = []

    async def query_rows(self, sql: str) -> list[dict[str, Any]]:
        self.sql.append(sql)
        for name, val in self.counts.items():
            if name in sql:
                if isinstance(val, Exception):
                    raise val
                return [{"n": val}]
        return [{"n": 0}]


@pytest.mark.asyncio
async def test_storage_inventory_counts_user_objects_and_rows_and_warns() -> None:
    td = _TD({"st_machine_condition_value": 131389, "st_energy_value": 71859})
    inv = await INV._collect_storage_inventory(_Session(), TENANT, td)
    assert inv["user_databases"] == 1 and inv["user_stables"] == 2
    assert inv["user_subtables"] == 6 and inv["user_subtables_recording"] == 5
    assert inv["recording_bindings"] == 9
    assert inv["user_rows_total"] == 131389 + 71859
    assert all(s.startswith("SELECT COUNT(*) AS n FROM `") for s in td.sql)  # read-only, quoted
    warn = INV._storage_warnings(inv)
    assert warn and warn[0]["code"] == "USER_RECORDED_HISTORY_CLEARED" and warn[0]["rows_total"] == 203248
    assert "DELETED" in warn[0]["message"] and "kept" in warn[0]["message"]


@pytest.mark.asyncio
async def test_storage_inventory_reports_unknown_row_counts_as_none() -> None:
    td = _TD({"st_machine_condition_value": RuntimeError("timeout"), "st_energy_value": 5})
    inv = await INV._collect_storage_inventory(_Session(), TENANT, td)
    assert inv["user_rows_total"] is None
    assert [s["rows"] for s in inv["user_stable_rows"]] == [None, 5]
    assert "unknown number" in INV._storage_warnings(inv)[0]["message"]


def test_no_user_stables_no_warning() -> None:
    assert INV._storage_warnings({"user_stables": 0}) == []


# ------------------------------------------------------------------------------------------------
# B-17 R3 bookkeeping is measured
# ------------------------------------------------------------------------------------------------

class _R3Session:
    async def execute(self, stmt: Any, params: Any = None) -> _Res:
        return _Res([])  # no extra user databases


class _R3TD:
    class config:  # noqa: N801 - mimics TDEngineConfig attribute access
        db_prefix = "fx_t_"

    def __init__(self, vanish: set[str]) -> None:
        self.calls = 0
        self.vanish = vanish
        self.subs = [f"op_float64_{'a' * 32}", "condition_aa10_02_ambient_temp", "energy_aa10_01_power"]

    async def list_subtables(self, db: str) -> list[str]:
        self.calls += 1
        return self.subs if self.calls == 1 else [s for s in self.subs if s not in self.vanish]

    async def query_rows(self, sql: str) -> list[dict[str, Any]]:
        return [{"stable_name": "op_float64"}, {"stable_name": "st_machine_condition_value"}]

    async def execute_sql(self, sql: str) -> None:
        assert sql.startswith("DELETE FROM `")

    async def ensure_operational_schema(self, tid: Any) -> None:
        return None


def _run(managed_before: list[str]) -> STAGES.ResetRun:
    return STAGES.ResetRun(
        tid=TENANT, aid=uuid4(), now=BODY_TS, previous_epoch=1, new_epoch=2, preserved_before={}, pg_before={},
        op_subs_before=[], managed_subs_before=managed_before, fingerprint_before="", manifest_hash="",
        operation_id=uuid4(), trace_id="t", stages_completed=[], stage_details={},
    )


@pytest.mark.asyncio
async def test_r3_reports_measured_preserved_and_missing_subtables() -> None:
    run = _run(["condition_aa10_02_ambient_temp", "energy_aa10_01_power"])
    await STAGES.stage_r3_clear_tdengine(_R3Session(), run, _R3TD(vanish=set()))
    r3 = run.stage_details["R3"]
    assert r3["cleared_subtables_total"] == 3
    assert r3["preserved_subtables_total"] == 3 and r3["preserved_managed_subtables"] == 2
    assert r3["dropped_subtables_total"] == 0 and r3["missing_subtables"] == []

    run = _run(["condition_aa10_02_ambient_temp", "energy_aa10_01_power"])
    await STAGES.stage_r3_clear_tdengine(_R3Session(), run, _R3TD(vanish={"energy_aa10_01_power"}))
    r3 = run.stage_details["R3"]
    assert r3["dropped_subtables_total"] == 1  # measured, no longer a constant 0
    assert r3["missing_subtables"] == [f"{DB}.energy_aa10_01_power"]
    assert r3["preserved_managed_subtables"] == 1  # no longer max(cleared, preflight)


class _RegSession:
    async def execute(self, stmt: Any, params: Any = None) -> _Res:
        return _Res([{"td_subtable": "condition_aa10_02_ambient_temp", "tier": "MANAGED"},
                     {"td_subtable": "zz_test_r2_purged_sub", "tier": "MANAGED"}])  # purged, row left behind


class _ListTD:
    class config:  # noqa: N801
        db_prefix = "fx_t_"

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    async def list_subtables(self, db: str) -> list[str]:
        if self.fail:
            raise RuntimeError("connection refused")
        return [f"op_float64_{'a' * 32}", "condition_aa10_02_ambient_temp"]


@pytest.mark.asyncio
async def test_stale_registry_rows_are_not_counted_when_tdengine_answers() -> None:
    op, managed = await INV._inspect_tdengine_subtables(_RegSession(), TENANT, _ListTD())
    assert op == [f"op_float64_{'a' * 32}"] and managed == ["condition_aa10_02_ambient_temp"]
    # TDengine unreachable -> the registry is the only inventory left (unchanged fallback)
    op, managed = await INV._inspect_tdengine_subtables(_RegSession(), TENANT, _ListTD(fail=True))
    assert managed == ["condition_aa10_02_ambient_temp", "zz_test_r2_purged_sub"]
