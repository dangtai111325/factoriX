"""Round-4 acceptance fixes of the Data Model (R4-DM-02, -08, -12, -15, -17)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import pytest

from factorix.domain import body as B
from factorix.domain import rules as R
from factorix.modules import data_models as DM

from test_dm2_api import ACTOR, M1, M2, M3, S1, TENANT, Session, Store, create, spec, store  # noqa: F401 - fixture re-export

NOW = datetime(2026, 11, 9, 10, 0, 0, tzinfo=timezone.utc)
ZONE = "00000000-0000-0000-0000-00000000a000"


def big_catalog(machines: int = 6, signals: int = 56) -> tuple[R.Catalog, list[str]]:
    resources = [{"id": ZONE, "type_key": "zone", "name": "ASSY", "code": "ASSY", "parent_id": None}]
    sigs: list[dict[str, Any]] = []
    for m in range(machines):
        mid = f"00000000-0000-0000-0000-0000000{m + 1:02d}000"
        resources.append({"id": mid, "type_key": "machine", "name": f"AA10-{m + 1:02d}", "code": f"AA10-{m + 1:02d}", "parent_id": ZONE})
        for k in range(signals):
            sigs.append({"id": f"00000000-0000-0000-0000-0000000{m + 1:02d}{k + 1:03d}", "resource_id": mid, "key": f"machine_temp_{k + 1}", "data_type": "float64"})
    cat = R.Catalog(resources, sigs, types=["zone", "machine"])
    refs = [f"$machine[AA10-{m + 1:02d}].machine_temp_{k + 1}" for m in range(machines) for k in range(signals)]
    return cat, refs


# ---------------------------------------------------------------- R4-DM-02 rule size


def test_map_all_latest_ts_over_336_references_is_valid_and_saves() -> None:
    cat, refs = big_catalog()
    text = f"latest_ts({', '.join(refs)})"
    assert len(refs) == 336 and len(text) > R.MAX_EXPR_LEN  # what Map all generated for ASSY
    raw = {"version": 2, "root": {"type": "object", "children": [{"key": "source_timestamp", "type": "field", "mode": "calculated", "expr": text, "value_type": "timestamp"}]}}
    stored, issues = B.resolve_spec(raw, cat)
    assert not B.has_errors(issues), issues[:2]
    expr = stored["root"]["children"][0]["expr"]
    assert len(expr) > 3 * R.MAX_EXPR_LEN  # canonical tokens are long; they do not count against the budget
    program = R.compile_rule(expr)
    assert len(program.signal_ids) == 336
    # and the engine evaluates it: the latest ts of all
    sid = sorted(program.signal_ids)[-1]
    samples = {s: R.Sample(1.0, source_time=datetime(2026, 11, 9, 9, 0, tzinfo=timezone.utc)) for s in program.signal_ids}
    samples[sid] = R.Sample(1.0, source_time=datetime(2026, 11, 9, 9, 30, tzinfo=timezone.utc))
    body, errors = B.evaluate(stored, samples, B.BodyContext(catalog=cat), NOW)
    assert errors == [] and json.loads(body) == {"source_timestamp": "2026-11-09T09:30:00.000Z"}


def test_rule_budget_counts_characters_not_reference_tokens() -> None:
    cat, refs = big_catalog(1, 3)
    long_literal = "'" + "a" * (R.MAX_EXPR_LEN + 10) + "'"
    assert R.resolve(long_literal, cat).issues[0].code == "EXPR_TOO_LONG"
    with pytest.raises(R.RuleError) as info:
        R.compile_rule(long_literal)
    assert info.value.code == "EXPR_TOO_LONG" and "counts as one" in info.value.message
    too_many = "latest_ts(" + ", ".join([refs[0]] * (R.MAX_REFS + 1)) + ")"
    assert R.expr_too_long(too_many).code == "LIMIT"  # type: ignore[union-attr]
    # Non-reference complexity keeps its node cap.
    with pytest.raises(R.RuleError) as info:
        R.compile_rule(" + ".join(["1"] * (R.MAX_NODES + 5)))
    assert info.value.code == "LIMIT"


def test_spec_level_expr_limit_uses_the_same_budget() -> None:
    cat, refs = big_catalog(2, 56)
    ok = {"key": "ts", "type": "field", "mode": "calculated", "expr": f"latest_ts({', '.join(refs)})"}
    _spec, issues = B.normalize_spec({"version": 2, "root": {"type": "object", "children": [ok]}})
    assert issues == []
    bad = {"key": "t", "type": "field", "mode": "calculated", "expr": "1" * (R.MAX_EXPR_LEN + 1)}
    _spec, issues = B.normalize_spec({"version": 2, "root": {"type": "object", "children": [bad]}})
    assert [i["code"] for i in issues] == ["EXPR_TOO_LONG"]


# ---------------------------------------------------------------- R4-DM-17 float noise + round digits


def _calc(key: str, expr: str, **extra: Any) -> dict[str, Any]:
    return {"key": key, "type": "field", "mode": "calculated", "expr": expr, "value_type": "auto", **extra}


def test_calculated_floats_have_no_binary_noise_mapping_untouched() -> None:
    cat, _refs = big_catalog(1, 1)
    sid = next(iter(cat.signals))
    raw = {
        "version": 2,
        "root": {
            "type": "object",
            "children": [
                _calc("sum", "0.1 + 0.2"),
                _calc("avg", "avg($machine[AA10-01].machine_temp_1, 5)"),
                {"key": "raw", "type": "field", "mode": "mapping", "ref": {"signal_id": sid}},
            ],
        },
    }
    stored, issues = B.resolve_spec(raw, cat)
    assert not B.has_errors(issues)
    state = R.FilterState()
    values = [30.1, 30.5, 30.2, 30.6, 30.424]
    for v in values:
        text, errors = B.evaluate(stored, {sid: R.Sample(v)}, B.BodyContext(catalog=cat), NOW, state)
    body = json.loads(text)
    assert errors == []
    assert body["sum"] == 0.3 and "0.30000000000000004" not in text
    assert body["avg"] == 30.3648 and "30.364800000000002" not in text
    assert body["raw"] == 30.424  # mapping values are the signal's own value


def test_round_digits_field_option() -> None:
    cat, _refs = big_catalog(1, 1)
    sid = next(iter(cat.signals))
    raw = {
        "version": 2,
        "root": {
            "type": "object",
            "children": [
                {"key": "speed", "type": "field", "mode": "mapping", "ref": {"signal_id": sid}, "round_digits": 1},
                _calc("ratio", "2 / 3", round_digits=3),
                _calc("n", "7", round_digits=0),
                _calc("txt", "'a'", round_digits=2),
            ],
        },
    }
    stored, issues = B.resolve_spec(raw, cat)
    assert not B.has_errors(issues)
    assert [n.get("round_digits") for n in stored["root"]["children"]] == [1, 3, 0, 2]  # stored and echoed
    text, errors = B.evaluate(stored, {sid: R.Sample(321.3999938964844)}, B.BodyContext(catalog=cat), NOW)
    assert errors == [] and json.loads(text) == {"speed": 321.4, "ratio": 0.667, "n": 7, "txt": "a"}
    bad = {"version": 2, "root": {"type": "object", "children": [_calc("x", "1", round_digits=13), _calc("y", "1", round_digits="2")]}}
    _s, issues = B.normalize_spec(bad)
    assert [i["code"] for i in issues] == ["INVALID_ROUND", "INVALID_ROUND"]
    # Specs without the option (the 36 existing models) are unchanged.
    plain = {"version": 2, "root": {"type": "object", "children": [_calc("x", "1")]}}
    assert "round_digits" not in B.normalize_spec(plain)[0]["root"]["children"][0]


# ---------------------------------------------------------------- R4-DM-08 per-field quality


def test_field_qualities_report_paused_stale_missing_and_good() -> None:
    cat, _refs = big_catalog(1, 4)
    ids = sorted(cat.signals)
    gone = ids[3]
    cat.signals[gone] = R.SignalInfo(id=gone, resource_id=cat.signals[gone].resource_id, key="machine_temp_4", name="", data_type="float64", unit=None, active=False)
    raw = {
        "version": 2,
        "root": {
            "type": "object",
            "children": [
                _calc("zone", "'ASSY'"),
                {"key": "a", "type": "field", "mode": "mapping", "ref": {"signal_id": ids[0]}, "id": "na"},
                {"key": "b", "type": "field", "mode": "mapping", "ref": {"signal_id": ids[1]}},
                _calc("c", f"{{{{sig:{ids[0]}}}}} + {{{{sig:{ids[2]}}}}}"),
                {"key": "d", "type": "field", "mode": "mapping", "ref": {"signal_id": gone}},
            ],
        },
    }
    compiled = B.compile_spec(B.normalize_spec(raw)[0])
    states = {
        ids[0]: B.SignalStatus("PAUSED", "CONNECTION_PAUSED", "c1", "Modbus 502"),
        ids[1]: B.SignalStatus("GOOD"),
        ids[2]: B.SignalStatus("STALE", "NO_FRESH_ACQUISITION", "c2", "OPC UA"),
    }
    rows, summary = B.field_qualities(compiled, states, cat)
    assert [(r["path"], r["quality"]) for r in rows] == [("/zone", "good"), ("/a", "paused"), ("/b", "good"), ("/c", "paused"), ("/d", "missing")]
    assert rows[1]["node_id"] == "na" and "paused" in rows[1]["reason"]
    assert summary["status"] == "missing" and summary["affected_fields"] == 3
    assert summary["paused_sources"] == ["Modbus 502"] and summary["stale_sources"] == ["OPC UA"]
    rows, summary = B.field_qualities(compiled, {k: B.SignalStatus("GOOD") for k in ids}, None)
    assert summary["status"] == "good" and summary["counts"] == {"good": 5}


async def test_latest_and_preview_carry_quality(store: Store, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    model = await create(store)

    async def states(_s: Any, _t: Any, ids: Any) -> dict[str, B.SignalStatus]:
        return {i: B.SignalStatus("PAUSED", "CONNECTION_PAUSED", "c1", "Modbus") for i in ids}

    monkeypatch.setattr(DM, "signal_states", states)
    latest = await DM.latest(Session(), TENANT, UUID(model["id"]))  # type: ignore[arg-type]
    assert [f["quality"] for f in latest["fields"]] == ["good", "paused", "paused"]
    assert latest["quality"]["status"] == "paused" and latest["quality"]["paused_sources"] == ["Modbus"]
    preview = await DM.preview(Session(), TENANT, DM.SpecIn(spec=model["spec"]))  # type: ignore[arg-type]
    assert [f["quality"] for f in preview["fields"]] == ["good", "paused", "paused"] and preview["quality"]["status"] == "paused"


# ---------------------------------------------------------------- R4-DM-12 friendly missing messages


def test_missing_signal_message_uses_current_names_without_internal_syntax() -> None:
    cat, _refs = big_catalog(1, 1)
    sid = next(iter(cat.signals))
    stored, _issues = B.resolve_spec({"version": 2, "root": {"type": "object", "children": [{"key": "h", "type": "field", "mode": "mapping", "ref": {"signal_id": sid}}]}}, cat)
    assert stored["labels"][f"sig:{sid}"] == "$machine[AA10-01].machine_temp_1"
    # Machine renamed, then the signal deleted.
    mid = cat.signals[sid].resource_id
    renamed = R.Catalog(
        [{"id": ZONE, "type_key": "zone", "name": "ASSY", "code": "ASSY", "parent_id": None}, {"id": mid, "type_key": "machine", "name": "AA10-99", "code": "X", "parent_id": ZONE}],
        [{"id": sid, "resource_id": mid, "key": "machine_temp_1", "data_type": "float64", "active": False}],
        types=["zone", "machine"],
    )
    text, errors = B.evaluate(stored, {}, B.BodyContext(catalog=renamed), NOW)
    assert errors[0]["code"] == "MISSING_REF"
    assert "AA10-99" in errors[0]["message"] and "AA10-01" not in errors[0]["message"] and "⚠" not in errors[0]["message"]
    rendered, issues = B.render_spec(stored, renamed)
    node = rendered["root"]["children"][0]
    assert node["missing"] is True and "AA10-99" in node["missing_reason"] and "⚠" not in issues[0]["message"]
    assert node["ref_display"] == "$⚠missing[$machine[AA10-99].machine_temp_1]"
    # The refreshed display round-trips on save.
    again, issues = B.resolve_spec({**rendered, "root": {"type": "object", "children": [_calc("h2", node["ref_display"])]}}, renamed, B.refresh_labels(stored["labels"], renamed))
    assert not B.has_errors(issues) and again["root"]["children"][0]["expr"] == f"{{{{sig:{sid}}}}}"
    # Signal row gone entirely: the last label, still readable.
    assert R.missing_message(R.Catalog([]), "sig", sid, "$machine[AA10-01].humidity") == "Data point 'humidity' on AA10-01 was deleted or disabled. Pick another one in the data tree."


# ---------------------------------------------------------------- R4-DM-15 duplicate to machines


def test_unmatched_references_are_listed_once_with_their_fields() -> None:
    cat, _refs = big_catalog(2, 2)
    target_cat = R.Catalog(
        list(cat.resources.values()),
        [s for s in cat.signals.values() if not (s.resource_id.endswith("02000") and s.key == "machine_temp_2")],
        types=["zone", "machine"],
    )
    raw = {
        "version": 2,
        "root": {
            "type": "object",
            "children": [
                {"key": "t2", "type": "field", "mode": "mapping", "ref": {"text": "$machine[AA10-01].machine_temp_2"}},
                _calc("ts", "latest_ts($machine[AA10-01].machine_temp_1, $machine[AA10-01].machine_temp_2)"),
                _calc("twice", "$machine[AA10-01].machine_temp_2 * 2"),
            ],
        },
    }
    stored, issues = B.resolve_spec(raw, cat)
    assert not B.has_errors(issues)
    src = next(r.id for r in cat.resources.values() if r.name == "AA10-01")
    dst = next(r.id for r in cat.resources.values() if r.name == "AA10-02")
    mapping, unmatched, replaced = DM.retarget_plan(stored, target_cat, [(src, dst)])
    assert len(unmatched) == 1 and unmatched[0]["ref"] == "$machine[AA10-01].machine_temp_2"
    assert unmatched[0]["paths"] == ["/t2", "/ts", "/twice"] and unmatched[0]["count"] == 3 and unmatched[0]["path"] == "/t2"
    assert replaced == len(mapping) == 1


async def test_duplicate_skip_unmatched_does_not_create_copies_reading_the_source(store: Store) -> None:  # noqa: F811
    model = await create(store)
    body = DM.DuplicateIn(targets=[M2, M3], skip_unmatched=True)
    out = await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), body, "c")  # type: ignore[arg-type]
    full, partial = out["created"]
    assert full["id"] is not None and full["skipped"] is False and full["unmatched_fields"] == 0
    assert partial["id"] is None and partial["skipped"] is True and partial["unmatched_fields"] == 1  # AA10-03 has no temp
    assert len(store.models) == 2 and store.audits.count("DATA_MODEL_DUPLICATED") == 1
    # Without the flag the old behaviour stays (explicitly confirmed in the UI).
    out = await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), DM.DuplicateIn(targets=[M3]), "c")  # type: ignore[arg-type]
    assert out["created"][0]["id"] is not None and out["created"][0]["skipped"] is False
    assert S1["temp"] in {r for _k, r in store.refs[out["created"][0]["id"]]}
