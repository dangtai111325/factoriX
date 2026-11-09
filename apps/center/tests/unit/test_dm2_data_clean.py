"""Proof: the six AA10-01 clean bodies of data_clean.md are buildable as Data Model v2 specs.

The specs are written the way the UI writes them (typed references, resolved on save), evaluated by
the pure engine function, and compared with the exact key order, values and source_timestamp rule
of data_clean.md. Then "Duplicate to machines" re-points one model to AA10-02.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from factorix.domain import body as B
from factorix.domain import rules as R
from factorix.modules.data_models import copy_name, retarget_plan

NOW = datetime(2026, 11, 9, 8, 0, 0, 250000, tzinfo=timezone.utc)

GROUPS: dict[str, list[str]] = {
    "state": ["status", "mode", "stop_error", "speed_1", "speed_2", "uptime_1", "uptime_2"],
    "electrical": [f"voltage_{i}" for i in range(1, 5)] + [f"current_{i}" for i in range(1, 5)] + ["power", "frequency", "energy_1", "energy_2", "harmonic"],
    "condition": [f"machine_temp_{i}" for i in range(1, 8)] + ["ambient_temp"] + [f"pressure_{i}" for i in range(1, 8)] + ["liquid_level"]
    + [f"vibration_{i}" for i in range(1, 7)] + ["noise", "humidity"],
    "operator": ["employee", "program_name", "program_no"],
    "order": ["so", "wo", "item", "order_qty", "cycle_time", "motor_no"],
    "completion": ["qty", "lot_serial"],
}
GROUP_OF = {key: group for group, keys in GROUPS.items() for key in keys}
LINES = {"AA10-01": "Assembly - AA10-01 (A1)", "AA10-02": "Assembly - AA10-02 (AB)"}


def _id(*parts: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "/".join(parts)))


def build_catalog() -> R.Catalog:
    resources = [
        {"id": _id("ent"), "type_key": "enterprise", "name": "Factory", "code": "ENT", "parent_id": None},
        {"id": _id("site"), "type_key": "site", "name": "Site 1", "code": "S1", "parent_id": _id("ent")},
        {"id": _id("zone"), "type_key": "zone", "name": "ASSY", "code": "ASSY", "parent_id": _id("site")},
    ]
    signals = []
    for machine, line in LINES.items():
        resources.append({"id": _id("line", machine), "type_key": "line", "name": line, "code": f"L-{machine}", "parent_id": _id("zone")})
        resources.append({"id": _id("m", machine), "type_key": "machine", "name": machine, "code": machine, "parent_id": _id("line", machine)})
        for key in GROUP_OF:
            data_type = "string" if key in {"status", "mode", "stop_error", "employee", "program_name", "so", "wo", "item", "motor_no", "lot_serial"} else "float64"
            signals.append({"id": _id("s", machine, key), "resource_id": _id("m", machine), "key": key, "data_type": data_type})
    return R.Catalog(resources, signals, types=["enterprise", "site", "zone", "line", "machine"])


CAT = build_catalog()


def ref(key: str, machine: str = "AA10-01") -> str:
    return f"$machine[{machine}].{key}"


def mapping(key: str) -> dict[str, Any]:
    return {"key": key, "type": "field", "mode": "mapping", "ref": {"text": ref(key)}, "value_type": "auto"}


def rule(key: str, expr: str, value_type: str = "auto") -> dict[str, Any]:
    return {"key": key, "type": "field", "mode": "calculated", "expr": expr, "value_type": value_type}


def head(with_machine: bool, ts_keys: list[str]) -> list[dict[str, Any]]:
    nodes = [
        rule("zone_name", "zone_name = $machine[AA10-01].@zone.@name", "string"),  # editor "key = expr" form
        rule("line_name", "$machine[AA10-01].@line.@name", "string"),
    ]
    if with_machine:
        nodes.append(rule("machine_name", "$machine[AA10-01].@name", "string"))
    nodes.append(rule("source_timestamp", f"latest_ts({', '.join(ref(k) for k in ts_keys)})", "timestamp"))
    nodes.append(rule("publish_timestamp", "now()", "timestamp"))
    return nodes


BODY_KEYS: dict[str, list[str]] = {
    "state": ["status", "mode", "stop_error", "employee"],
    "process": ["speed_1", "speed_2", "program_name", "program_no", "uptime_1", "uptime_2", "status", "employee"],
    "energy": GROUPS["electrical"] + ["status"],
    "condition": GROUPS["condition"] + ["status"],
    "order": GROUPS["order"] + ["employee"],
}
TS_KEYS = {"state": ["status", "employee"], "process": ["status", "employee"], "energy": ["voltage_1", "status"], "condition": ["machine_temp_1", "status"], "order": ["so", "employee"]}


def raw_spec(body: str) -> dict[str, Any]:
    if body == "order_progress":
        children = head(False, ["lot_serial"]) + [
            rule("so", f"value_at({ref('so')}, ts({ref('lot_serial')}))"),
            rule("wo", f"value_at({ref('wo')}, ts({ref('lot_serial')}))"),
            mapping("qty"),
            mapping("lot_serial"),
        ]
    else:
        children = head(body not in ("order",), TS_KEYS[body]) + [mapping(k) for k in BODY_KEYS[body]]
    return {"version": 2, "root": {"type": "object", "children": children}}


def stored_spec(body: str) -> dict[str, Any]:
    stored, issues = B.resolve_spec(raw_spec(body), CAT)
    assert not B.has_errors(issues), issues
    return stored


EXPECTED_ORDER = {
    "state": ["zone_name", "line_name", "machine_name", "source_timestamp", "publish_timestamp", "status", "mode", "stop_error", "employee"],
    "process": ["zone_name", "line_name", "machine_name", "source_timestamp", "publish_timestamp", "speed_1", "speed_2", "program_name", "program_no", "uptime_1", "uptime_2", "status", "employee"],
    "energy": ["zone_name", "line_name", "machine_name", "source_timestamp", "publish_timestamp"]
    + [f"voltage_{i}" for i in range(1, 5)] + [f"current_{i}" for i in range(1, 5)] + ["power", "frequency", "energy_1", "energy_2", "harmonic", "status"],
    "condition": ["zone_name", "line_name", "machine_name", "source_timestamp", "publish_timestamp"]
    + [f"machine_temp_{i}" for i in range(1, 8)] + ["ambient_temp"] + [f"pressure_{i}" for i in range(1, 8)] + ["liquid_level"]
    + [f"vibration_{i}" for i in range(1, 7)] + ["noise", "humidity", "status"],
    "order": ["zone_name", "line_name", "source_timestamp", "publish_timestamp", "so", "wo", "item", "order_qty", "cycle_time", "motor_no", "employee"],
    "order_progress": ["zone_name", "line_name", "source_timestamp", "publish_timestamp", "so", "wo", "qty", "lot_serial"],
}


def value_of(machine: str, key: str) -> Any:
    if key in {"status"}:
        return "RUN"
    if key in {"so", "wo"}:
        return f"{key.upper()}-{machine}-CURRENT"
    if key in {"mode", "stop_error", "employee", "program_name", "item", "motor_no", "lot_serial"}:
        return f"{key}-{machine}"
    return round(len(key) * 1.5 + (2 if machine.endswith("2") else 1), 3)


def group_times(**overrides: datetime) -> dict[str, datetime]:
    base = {
        "state": NOW - timedelta(seconds=20),
        "electrical": NOW - timedelta(seconds=15),
        "condition": NOW - timedelta(seconds=5),
        "operator": NOW - timedelta(seconds=40),
        "order": NOW - timedelta(seconds=50),
        "completion": NOW - timedelta(seconds=30),
    }
    base.update(overrides)
    return base


def samples(times: dict[str, datetime], machine: str = "AA10-01") -> dict[str, R.Sample]:
    out = {}
    for key, group in GROUP_OF.items():
        out[_id("s", machine, key)] = R.Sample(value_of(machine, key), source_time=times[group], received_time=times[group] + timedelta(milliseconds=40))
    return out


def evaluate(spec: dict[str, Any], values: dict[str, R.Sample], *, now: datetime = NOW, lookup: Any = None) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
    text, errors = B.evaluate(spec, values, B.BodyContext(catalog=CAT, lookup=lookup), now)
    return text, json.loads(text), errors


def expected_body(body: str, times: dict[str, datetime], machine: str = "AA10-01", *, now: datetime = NOW) -> dict[str, Any]:
    out: dict[str, Any] = {"zone_name": "ASSY", "line_name": LINES[machine]}
    if body not in ("order", "order_progress"):
        out["machine_name"] = machine
    contributing = {"order_progress": ["completion"]}.get(body) or sorted({GROUP_OF[k] for k in TS_KEYS[body]})
    out["source_timestamp"] = R.fmt_ts(max(times[g] for g in contributing))
    out["publish_timestamp"] = R.fmt_ts(now)
    for key in EXPECTED_ORDER[body][len(out):]:
        out[key] = value_of(machine, key)
    return out


@pytest.mark.parametrize("body", ["state", "process", "energy", "condition", "order"])
def test_state_bodies_match_data_clean_exactly(body: str) -> None:
    times = group_times()
    text, parsed, errors = evaluate(stored_spec(body), samples(times))
    assert errors == []
    assert list(parsed) == EXPECTED_ORDER[body]
    expected = expected_body(body, times)
    assert text == json.dumps(expected, ensure_ascii=False, separators=(",", ":"))
    assert "machine_name" not in parsed if body == "order" else parsed["machine_name"] == "AA10-01"


@pytest.mark.parametrize(
    ("state_ts", "operator_ts", "winner"),
    [
        (NOW - timedelta(seconds=20), NOW - timedelta(seconds=10), "operator"),  # T2 later -> T2
        (NOW - timedelta(seconds=5), NOW - timedelta(seconds=10), "state"),  # T1 later -> T1
        (NOW - timedelta(seconds=7), NOW - timedelta(seconds=7), "state"),  # equal -> that instant
    ],
)
def test_source_timestamp_is_the_later_contributing_group(state_ts: datetime, operator_ts: datetime, winner: str) -> None:
    times = group_times(state=state_ts, operator=operator_ts)
    _text, parsed, _errors = evaluate(stored_spec("state"), samples(times))
    assert parsed["source_timestamp"] == R.fmt_ts(times[winner])
    # a group that does not contribute to the state body never moves its source_timestamp
    later = group_times(state=state_ts, operator=operator_ts, condition=NOW, electrical=NOW, order=NOW, completion=NOW)
    assert evaluate(stored_spec("state"), samples(later))[1]["source_timestamp"] == parsed["source_timestamp"]


def test_two_bodies_with_the_same_status_can_have_different_source_timestamps() -> None:
    times = group_times()
    state = evaluate(stored_spec("state"), samples(times))[1]
    energy = evaluate(stored_spec("energy"), samples(times))[1]
    assert state["status"] == energy["status"] == "RUN"
    assert state["source_timestamp"] == R.fmt_ts(times["state"])  # state(-20 s) > operator(-40 s)
    assert energy["source_timestamp"] == R.fmt_ts(times["electrical"])  # electrical(-15 s) > state(-20 s)


def test_republish_changes_only_publish_timestamp() -> None:
    times = group_times()
    spec = B.compile_spec(stored_spec("process"))
    first = evaluate(spec, samples(times))[1]  # type: ignore[arg-type]
    later = NOW + timedelta(seconds=1)
    second = evaluate(spec, samples(times), now=later)[1]  # type: ignore[arg-type]
    assert second["publish_timestamp"] == R.fmt_ts(later) != first["publish_timestamp"]
    assert {k: v for k, v in second.items() if k != "publish_timestamp"} == {k: v for k, v in first.items() if k != "publish_timestamp"}
    assert first["source_timestamp"] != first["publish_timestamp"]


def test_order_progress_snapshots_so_wo_at_completion_time() -> None:
    completion = NOW - timedelta(seconds=30)
    times = group_times(completion=completion, order=NOW - timedelta(seconds=10))  # order changed AFTER completion
    history = {  # so/wo observations by source_time
        _id("s", "AA10-01", "so"): [(NOW - timedelta(minutes=10), "SO-OLD"), (NOW - timedelta(seconds=10), "SO-AA10-01-CURRENT")],
        _id("s", "AA10-01", "wo"): [(NOW - timedelta(minutes=10), "WO-OLD"), (NOW - timedelta(seconds=10), "WO-AA10-01-CURRENT")],
    }
    asked: list[tuple[str, datetime]] = []

    def lookup(signal_id: str, at: datetime) -> R.Sample | None:
        asked.append((signal_id, at))
        rows = [(t, v) for t, v in history.get(signal_id, []) if t <= at]
        return R.Sample(rows[-1][1], source_time=rows[-1][0]) if rows else None

    text, parsed, errors = evaluate(stored_spec("order_progress"), samples(times), lookup=lookup)
    assert errors == []
    assert list(parsed) == EXPECTED_ORDER["order_progress"]
    assert parsed["so"] == "SO-OLD" and parsed["wo"] == "WO-OLD"  # the order the count belongs to
    assert evaluate(stored_spec("order"), samples(times))[1]["so"] == "SO-AA10-01-CURRENT"  # current order differs
    assert parsed["source_timestamp"] == R.fmt_ts(completion)  # one raw group: the completion instant
    assert parsed["qty"] == value_of("AA10-01", "qty") and parsed["lot_serial"] == "lot_serial-AA10-01"
    assert {at for _sid, at in asked} == {completion}
    assert text.startswith('{"zone_name":"ASSY","line_name":"Assembly - AA10-01 (A1)","source_timestamp":')


def test_specs_render_back_to_the_typed_text() -> None:
    rendered, issues = B.render_spec(stored_spec("order_progress"), CAT)
    assert issues == []
    exprs = {n["key"]: n.get("expr_display") or n.get("ref_display") for _p, n in B.iter_fields(rendered)}
    assert exprs["zone_name"] == "$machine[AA10-01].@zone.@name"
    assert exprs["source_timestamp"] == "latest_ts($machine[AA10-01].lot_serial)"
    assert exprs["so"] == "value_at($machine[AA10-01].so, ts($machine[AA10-01].lot_serial))"
    assert exprs["qty"] == "$machine[AA10-01].qty"


@pytest.mark.parametrize("body", list(EXPECTED_ORDER))
def test_duplicate_to_another_machine_repoints_every_reference(body: str) -> None:
    stored = stored_spec(body)
    mapping, unmatched, replaced = retarget_plan(stored, CAT, [(_id("m", "AA10-01"), _id("m", "AA10-02"))])
    assert unmatched == [] and replaced == len(mapping) > 0
    copy = B.retarget_spec(stored, mapping)
    signals, resources = B.spec_refs(copy)
    assert all(CAT.signal(s).resource_id == _id("m", "AA10-02") for s in signals)  # never another machine's field
    assert resources <= {_id("m", "AA10-02")}
    times = group_times()

    def lookup(signal_id: str, at: datetime) -> R.Sample | None:
        return R.Sample(f"{CAT.signal(signal_id).key}-at-completion")

    parsed = evaluate(copy, samples(times, "AA10-02"), lookup=lookup)[1]
    expected = expected_body(body, times, "AA10-02")
    if body == "order_progress":
        expected.update(so="so-at-completion", wo="wo-at-completion")
    assert parsed == expected and list(parsed) == EXPECTED_ORDER[body]
    assert copy_name("AA10-01 state", "AA10-01", "AA10-02") == "AA10-02 state"


def test_duplicate_reports_unmatched_signal_keys() -> None:
    stored = stored_spec("state")
    smaller = R.Catalog(
        list(CAT.resources.values()),
        [s for s in CAT.signals.values() if not (s.resource_id == _id("m", "AA10-02") and s.key == "stop_error")],
        types=CAT.types,
    )
    mapping, unmatched, _replaced = retarget_plan(stored, smaller, [(_id("m", "AA10-01"), _id("m", "AA10-02"))])
    assert [u["ref"] for u in unmatched] == ["$machine[AA10-01].stop_error"]
    assert unmatched[0]["path"] == "/stop_error" and "stop_error" in unmatched[0]["reason"]
    assert f"sig:{_id('s', 'AA10-01', 'stop_error')}" not in mapping
