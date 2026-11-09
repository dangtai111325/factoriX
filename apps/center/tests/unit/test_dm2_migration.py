"""Migration 0007: v1 model (members) -> v2 spec conversion and the downgrade mapping (pure helpers)."""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from factorix.domain import body as B
from factorix.domain import rules as R

_PATH = Path(__file__).resolve().parents[2] / "migrations" / "versions" / "0007_data_model_v2.py"
_spec = importlib.util.spec_from_file_location("migration_0007", _PATH)
assert _spec and _spec.loader
mig = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mig)

M1, LINE, ZONE = str(uuid4()), str(uuid4()), str(uuid4())
STATUS, EMPLOYEE, QTY, LOT, SO = (str(uuid4()) for _ in range(5))
SIGNALS = {
    sid: {"key": key, "resource_name": "AA10-01", "type_key": "machine"}
    for sid, key in ((STATUS, "status"), (EMPLOYEE, "employee"), (QTY, "qty"), (LOT, "lot_serial"), (SO, "so"))
}
CHAIN = [
    {"id": M1, "type_key": "machine", "name": "AA10-01", "code": "AA10-01"},
    {"id": LINE, "type_key": "line", "name": "Assembly - AA10-01 (A1)", "code": "L1"},
    {"id": ZONE, "type_key": "zone", "name": "ASSY", "code": "ASSY"},
]
CAT = R.Catalog(
    [
        {"id": ZONE, "type_key": "zone", "name": "ASSY", "code": "ASSY", "parent_id": None},
        {"id": LINE, "type_key": "line", "name": "Assembly - AA10-01 (A1)", "code": "L1", "parent_id": ZONE},
        {"id": M1, "type_key": "machine", "name": "AA10-01", "code": "AA10-01", "parent_id": LINE},
    ],
    [{"id": sid, "resource_id": M1, "key": info["key"]} for sid, info in SIGNALS.items()],
    types=["zone", "line", "machine"],
)


def member(kind: str, alias: str, **extra: object) -> dict[str, object]:
    return {"member_kind": kind, "output_alias": alias, "signal_id": None, "context_ref": None, "constant_json": None, "system_field": None,
            "contributes_ts": kind == "SIGNAL", "is_trigger": False, **extra}


STATE_MEMBERS = [
    member("CONTEXT", "zone_name", context_ref="zone.name"),
    member("CONTEXT", "line_name", context_ref="line.name"),
    member("CONTEXT", "machine_name", context_ref="self.name"),
    member("SYSTEM", "source_timestamp", system_field="source_timestamp"),
    member("SYSTEM", "publish_timestamp", system_field="publish_timestamp"),
    member("SIGNAL", "status", signal_id=STATUS),
    member("SIGNAL", "employee", signal_id=EMPLOYEE),
    member("CONSTANT", "plant", constant_json={"v": "P1"}),
    member("CONSTANT", "meta", constant_json={"v": {"a": [1]}}),
]


def test_state_model_converts_to_v2_spec_with_identical_output() -> None:
    spec = mig.spec_from_members(STATE_MEMBERS, SIGNALS, CHAIN)
    stored, issues = B.resolve_spec(spec, CAT)
    assert not B.has_errors(issues), issues
    nodes = {n["key"]: n for _p, n in B.iter_fields(stored)}
    assert nodes["zone_name"]["expr"] == '"ASSY"' and nodes["line_name"]["expr"] == '"Assembly - AA10-01 (A1)"'
    assert nodes["source_timestamp"]["expr"] == f"latest_ts({{{{sig:{STATUS}}}}}, {{{{sig:{EMPLOYEE}}}}})"
    assert nodes["publish_timestamp"]["expr"] == "now()"
    assert nodes["status"]["mode"] == "mapping" and nodes["status"]["ref"] == {"signal_id": STATUS}
    assert spec["labels"][f"sig:{STATUS}"] == "$machine[AA10-01].status"
    now = datetime(2026, 11, 9, 1, 2, 3, 456000, tzinfo=timezone.utc)
    t1, t2 = datetime(2026, 11, 9, 1, 0, tzinfo=timezone.utc), datetime(2026, 11, 9, 1, 1, tzinfo=timezone.utc)
    text, errors = B.evaluate(stored, {STATUS: R.Sample(1, source_time=t1), EMPLOYEE: R.Sample("E7", source_time=t2)}, B.BodyContext(catalog=CAT), now)
    assert errors == []
    assert text == (
        '{"zone_name":"ASSY","line_name":"Assembly - AA10-01 (A1)","machine_name":"AA10-01","source_timestamp":"2026-11-09T01:01:00.000Z",'
        '"publish_timestamp":"2026-11-09T01:02:03.456Z","status":1,"employee":"E7","plant":"P1","meta":{"a":[1]}}'
    )


def test_event_model_snapshots_become_value_at_of_the_first_trigger() -> None:
    members = [
        member("SYSTEM", "source_timestamp", system_field="source_timestamp"),
        member("SNAPSHOT", "so", signal_id=SO, contributes_ts=False),
        member("SIGNAL", "qty", signal_id=QTY, is_trigger=True),
        member("SIGNAL", "lot_serial", signal_id=LOT, is_trigger=True),
    ]
    spec = mig.spec_from_members(members, SIGNALS, CHAIN)
    nodes = {n["key"]: n for _p, n in B.iter_fields(spec)}
    assert nodes["so"]["expr"] == f"value_at({{{{sig:{SO}}}}}, ts({{{{sig:{QTY}}}}}))"
    assert nodes["source_timestamp"]["expr"] == f"latest_ts({{{{sig:{QTY}}}}}, {{{{sig:{LOT}}}}})"
    assert set(mig.spec_signal_ids(spec)) == {QTY, LOT, SO}
    kind, back = mig.members_from_spec(spec)
    assert kind == "EVENT"
    assert [(m["member_kind"], m["output_alias"]) for m in back] == [("SYSTEM", "source_timestamp"), ("SNAPSHOT", "so"), ("SIGNAL", "qty"), ("SIGNAL", "lot_serial")]
    assert [m["is_trigger"] for m in back if m["member_kind"] == "SIGNAL"] == [True, False]


def test_downgrade_maps_v2_fields_back_to_members() -> None:
    spec = mig.spec_from_members(STATE_MEMBERS, SIGNALS, CHAIN)
    spec["root"]["children"].append({"key": "electrical", "type": "object", "children": [{"key": "v1", "type": "field", "mode": "mapping", "ref": {"signal_id": STATUS}}]})
    spec["root"]["children"].append({"key": "calc", "type": "field", "mode": "calculated", "expr": "1 + 2"})
    kind, back = mig.members_from_spec(spec)
    assert kind == "STATE"
    by_alias = {m["output_alias"]: m for m in back}
    assert by_alias["zone_name"]["member_kind"] == "CONSTANT" and json.loads(by_alias["zone_name"]["constant_json"]) == {"v": "ASSY"}
    assert by_alias["source_timestamp"]["system_field"] == "source_timestamp"
    assert by_alias["publish_timestamp"]["system_field"] == "publish_timestamp"
    assert by_alias["electrical_v1"]["member_kind"] == "SIGNAL"
    assert "calc" not in by_alias  # an arbitrary rule has no v1 equivalent


def test_helpers() -> None:
    assert mig.resolve_context(CHAIN, "zone.name") == "ASSY" and mig.resolve_context(CHAIN, "self.code") == "AA10-01"
    assert mig.resolve_context(CHAIN, "site.name") is None and mig.resolve_context([], "zone.name") is None
    assert mig.literal(True) == ("true", "bool") and mig.literal(None) == ("null", "auto") and mig.literal(1.5) == ("1.5", "auto")
    assert mig.sample_ms_of({"republish_ms": 5000}) == 5000 and mig.sample_ms_of({"republish_ms": 50}) == 200
    assert mig.sample_ms_of('{"republish_ms": null}') == 1000 and mig.sample_ms_of(None) == 1000
    names = mig.unique_names([
        {"id": "a", "tenant_id": "t", "display_name": "State"},
        {"id": "b", "tenant_id": "t", "display_name": "state"},
        {"id": "c", "tenant_id": "u", "display_name": "State"},
    ])
    assert names == {"a": "State", "b": "state (2)", "c": "State"}
    assert mig.revision == "0007_data_model_v2" and mig.down_revision == "0006_data_model_v2"
