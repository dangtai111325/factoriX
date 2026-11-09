"""Data Model v2 body (factorix.domain.body): spec validation, resolution, rendering, evaluation."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from factorix.domain import body as B
from factorix.domain import rules as R

NOW = datetime(2026, 11, 9, 10, 0, 0, 5000, tzinfo=timezone.utc)
M1 = "00000000-0000-0000-0000-00000000c001"
S_INT = "00000000-0000-0000-0000-00000000d001"
S_FLOAT = "00000000-0000-0000-0000-00000000d002"
S_TEXT = "00000000-0000-0000-0000-00000000d003"
S_JSON = "00000000-0000-0000-0000-00000000d004"
S_GONE = "00000000-0000-0000-0000-00000000d0ff"
CAT = R.Catalog(
    [{"id": M1, "type_key": "machine", "name": "M1", "code": "M1", "parent_id": None}],
    [
        {"id": S_INT, "resource_id": M1, "key": "count", "data_type": "int64"},
        {"id": S_FLOAT, "resource_id": M1, "key": "temp", "data_type": "float64"},
        {"id": S_TEXT, "resource_id": M1, "key": "label", "data_type": "string"},
        {"id": S_JSON, "resource_id": M1, "key": "doc", "data_type": "json"},
        {"id": S_GONE, "resource_id": M1, "key": "gone", "data_type": "float64", "active": False},
    ],
    types=["machine"],
)


def f(key: str | None, expr: str, value_type: str = "auto", **extra: Any) -> dict[str, Any]:
    node = {"type": "field", "mode": "calculated", "expr": expr, "value_type": value_type, **extra}
    if key is not None:
        node["key"] = key
    return node


def m(key: str | None, signal: str, value_type: str | None = None) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "field", "mode": "mapping", "ref": {"signal_id": signal}}
    if value_type:
        node["value_type"] = value_type
    if key is not None:
        node["key"] = key
    return node


def spec(*children: dict[str, Any]) -> dict[str, Any]:
    return {"version": 2, "root": {"type": "object", "children": list(children)}}


def run(raw: dict[str, Any], values: dict[str, Any] | None = None) -> tuple[Any, list[dict[str, Any]], str]:
    stored, issues = B.resolve_spec(raw, CAT)
    assert not B.has_errors(issues), issues
    samples = {k: R.Sample(v) for k, v in (values or {}).items()}
    text, errors = B.evaluate(stored, samples, B.BodyContext(catalog=CAT), NOW)
    return json.loads(text), errors, text


def test_nested_objects_and_arrays_keep_order() -> None:
    raw = spec(
        f("z", "1"),
        {"key": "electrical", "type": "object", "children": [f("b", "2"), f("a", "3"), {"key": "deep", "type": "object", "children": [f("x", "'x'")]}]},
        {"key": "temps", "type": "array", "children": [m(None, S_FLOAT), f(None, "$machine[M1].temp * 2"), {"type": "object", "children": [f("k", "true")]}]},
        f("a", "null"),
    )
    body, errors, text = run(raw, {S_FLOAT: 1.5})
    assert errors == []
    assert text == '{"z":1,"electrical":{"b":2,"a":3,"deep":{"x":"x"}},"temps":[1.5,3.0,{"k":true}],"a":null}'
    assert list(body) == ["z", "electrical", "temps", "a"]


def test_array_children_lose_their_keys_and_paths_use_indexes() -> None:
    stored, issues = B.normalize_spec(spec({"key": "arr", "type": "array", "children": [f("ignored", "1"), f(None, "1 / 0")]}))
    assert issues == [] and "key" not in stored["root"]["children"][0]["children"][0]
    _body, errors, _text = run(spec({"key": "arr", "type": "array", "children": [f(None, "1"), f(None, "1 / 0")]}))
    assert errors == [{"path": "/arr/1", "code": "DIV0", "message": "Division by zero."}]


@pytest.mark.parametrize(
    ("value", "value_type", "expected"),
    [
        ("12", "int", 12),
        (12.9, "int", 12),
        (True, "int", 1),
        ("1.5", "float", 1.5),
        (3, "float", 3.0),
        (12, "string", "12"),
        (True, "string", "true"),
        ({"a": 1}, "string", '{"a":1}'),
        ("on", "bool", True),
        (0, "bool", False),
        ("2026-01-02T03:04:05.6Z", "timestamp", "2026-01-02T03:04:05.600Z"),
        ("2026-01-02T05:04:05+02:00", "timestamp", "2026-01-02T03:04:05.000Z"),
        (1767323045600, "timestamp", "2026-01-02T03:04:05.600Z"),
        ('{"a":[1,2]}', "json", {"a": [1, 2]}),
        ([1, 2], "json", [1, 2]),
        ("x", "auto", "x"),
        (None, "int", None),
    ],
)
def test_value_type_casting(value: Any, value_type: str, expected: Any) -> None:
    assert B.cast_value(value, value_type) == expected


@pytest.mark.parametrize(("value", "value_type"), [("abc", "int"), ("x", "float"), ("maybe", "bool"), ("yesterday", "timestamp"), ("{bad", "json"), (float("inf"), "auto")])
def test_cast_failures_raise_cast(value: Any, value_type: str) -> None:
    with pytest.raises(R.RuleRuntimeError) as info:
        B.cast_value(value, value_type)
    assert info.value.code == "CAST"


def test_timestamps_are_emitted_with_milliseconds() -> None:
    body, _errors, _text = run(spec(f("p", "now()", "timestamp"), f("q", "now()"), f("r", "str(now())", "timestamp")))
    assert body == {"p": "2026-11-09T10:00:00.005Z", "q": "2026-11-09T10:00:00.005Z", "r": "2026-11-09T10:00:00.005Z"}


def test_per_field_errors_do_not_stop_other_fields() -> None:
    raw = spec(f("ok", "1 + 1"), f("div", "1 / 0"), f("cast", "'abc'", "int"), m("label", S_TEXT, "int"), f("after", "'still here'", node_id="row-9"))
    body, errors, _text = run(raw, {S_TEXT: "x"})
    assert body == {"ok": 2, "div": None, "cast": None, "label": None, "after": "still here"}
    assert [(e["path"], e["code"]) for e in errors] == [("/div", "DIV0"), ("/cast", "CAST"), ("/label", "CAST")]


def test_mapping_defaults_to_the_signal_type_and_reads_latest_value() -> None:
    stored, issues = B.resolve_spec(spec(m("count", S_INT), m("temp", S_FLOAT), m("doc", S_JSON), m("raw", S_INT, "auto")), CAT)
    assert issues == []
    assert [n["value_type"] for _p, n in B.iter_fields(stored)] == ["int", "float", "json", "auto"]
    text, errors = B.evaluate(stored, {S_INT: R.Sample("7"), S_FLOAT: R.Sample(2), S_JSON: R.Sample({"k": [1]})}, B.BodyContext(catalog=CAT), NOW)
    assert text == '{"count":7,"temp":2.0,"doc":{"k":[1]},"raw":"7"}' and errors == []
    text, errors = B.evaluate(stored, {}, B.BodyContext(catalog=CAT), NOW)  # no data yet: null, no error
    assert text == '{"count":null,"temp":null,"doc":null,"raw":null}' and errors == []


def test_mapping_by_text_and_assignment_prefix_are_resolved() -> None:
    stored, issues = B.resolve_spec(
        spec({"key": "t", "type": "field", "mode": "mapping", "ref": {"text": "$machine[M1].temp"}}, f("x", "x = $machine[M1].count + 1"), f("y", "y == 1")),
        CAT,
    )
    assert [(i["path"], i["code"]) for i in issues] == [("/y", "UNKNOWN_NAME")]  # 'y == 1' is a comparison, not stripped
    nodes = [n for _p, n in B.iter_fields(stored)]
    assert nodes[0]["ref"] == {"signal_id": S_FLOAT} and nodes[0]["value_type"] == "float"
    assert nodes[1]["expr"] == f"{{{{sig:{S_INT}}}}} + 1"
    assert nodes[2]["expr"] == "y == 1"  # a comparison is not an assignment
    assert stored["labels"] == {f"sig:{S_FLOAT}": "$machine[M1].temp", f"sig:{S_INT}": "$machine[M1].count"}


@pytest.mark.parametrize(
    ("raw", "code", "path"),
    [
        ([], "INVALID_SPEC", ""),
        ({"version": 1, "root": {"type": "object", "children": []}}, "INVALID_SPEC", ""),
        ({"version": 2, "root": {"type": "array", "children": []}}, "INVALID_SPEC", ""),
        (spec(f("", "1")), "KEY_EMPTY", "/0"),
        (spec(f("   ", "1")), "KEY_EMPTY", "/0"),
        (spec(f("k" * 129, "1")), "KEY_TOO_LONG", "/" + "k" * 129),
        (spec(f("a", "1"), f("a", "2")), "KEY_DUPLICATE", "/a"),
        (spec({"key": "a", "type": "thing"}), "INVALID_NODE", "/a"),
        (spec({"key": "a", "type": "field", "mode": "magic"}), "INVALID_MODE", "/a"),
        (spec(f("a", "1", "decimal")), "INVALID_VALUE_TYPE", "/a"),
        (spec(f("a", "")), "EXPR_EMPTY", "/a"),
        (spec(f("a", "1" * 4001)), "EXPR_TOO_LONG", "/a"),
        (spec({"key": "a", "type": "field", "mode": "mapping", "ref": {}}), "BAD_REF", "/a"),
        (spec(f("a/b~c", "1 +")), "SYNTAX", "/a~1b~0c"),
        (spec(f("a", "$machine[M2].temp")), "UNKNOWN_RESOURCE", "/a"),
    ],
)
def test_structural_and_rule_issues_have_paths(raw: Any, code: str, path: str) -> None:
    _stored, issues = B.resolve_spec(raw, CAT)
    assert any(i["code"] == code and i["path"] == path and i["severity"] == "error" for i in issues), issues


def test_case_sensitive_keys_are_distinct() -> None:
    _stored, issues = B.normalize_spec(spec(f("A", "1"), f("a", "2")))
    assert issues == []


def test_depth_and_field_limits() -> None:
    node: dict[str, Any] = f("leaf", "1")
    for level in range(17):
        node = {"key": f"o{level}", "type": "object", "children": [node]}
    _stored, issues = B.normalize_spec(spec(node))
    assert [i["code"] for i in issues] == ["DEPTH_LIMIT"]
    many = spec(*[f(f"k{i}", "1") for i in range(B.MAX_FIELDS + 5)])
    stored, issues = B.normalize_spec(many)
    assert [i["code"] for i in issues] == ["FIELD_LIMIT"] and B.field_count(stored) == B.MAX_FIELDS


def test_missing_targets_warn_on_save_and_error_at_runtime() -> None:
    labels = {f"sig:{S_GONE}": "$machine[M1].gone"}
    raw = {**spec(m("gone", S_GONE), f("calc", f"{{{{sig:{S_GONE}}}}} * 2"), f("ok", "1")), "labels": labels}
    stored, issues = B.resolve_spec(raw, CAT)
    assert not B.has_errors(issues) and {i["code"] for i in issues} == {"MISSING_REF"} and all(i["severity"] == "warning" for i in issues)
    rendered, render_issues = B.render_spec(stored, CAT)
    fields = {n["key"]: n for _p, n in B.iter_fields(rendered)}
    assert fields["gone"]["missing"] is True and fields["gone"]["ref_display"] == "$⚠missing[$machine[M1].gone]"
    assert fields["calc"]["expr_display"] == "$⚠missing[$machine[M1].gone] * 2" and fields["ok"]["missing"] is False
    assert len(render_issues) == 2
    text, errors = B.evaluate(stored, {S_GONE: R.Sample(5.0)}, B.BodyContext(catalog=CAT), NOW)
    assert text == '{"gone":null,"calc":null,"ok":1}'  # the model keeps running; the fields are null
    assert {e["code"] for e in errors} == {"MISSING_REF"}
    # saving the rendered display text again keeps the tokens (labels round-trip)
    again, again_issues = B.resolve_spec({**rendered, "root": {"type": "object", "children": [f("calc", fields["calc"]["expr_display"])]}}, CAT, labels)
    assert not B.has_errors(again_issues) and next(B.iter_fields(again))[1]["expr"] == f"{{{{sig:{S_GONE}}}}} * 2"


def test_render_includes_ref_info() -> None:
    stored, _ = B.resolve_spec(spec(m("temp", S_FLOAT)), CAT)
    rendered, _ = B.render_spec(stored, CAT, {S_FLOAT: {"protocol": "mqtt", "connection_name": "Broker"}})
    node = next(B.iter_fields(rendered))[1]
    assert node["ref_display"] == "$machine[M1].temp"
    assert node["ref_info"]["signal_key"] == "temp" and node["ref_info"]["protocol"] == "mqtt" and node["ref_info"]["path"] == "M1"


def test_spec_refs_and_retarget() -> None:
    stored, _ = B.resolve_spec(spec(m("a", S_INT), f("b", "$machine[M1].temp + 1"), f("c", "$machine[M1].@name")), CAT)
    signals, resources = B.spec_refs(stored)
    assert signals == {S_INT, S_FLOAT} and resources == {M1}
    moved = B.retarget_spec(stored, {f"sig:{S_INT}": S_TEXT, f"res:{M1}": S_JSON})
    assert B.spec_refs(moved) == ({S_TEXT, S_FLOAT}, {S_JSON})
    assert B.spec_refs(stored) == ({S_INT, S_FLOAT}, {M1})  # the original is untouched


def test_pending_lookups_discard_filter_state_until_resolved() -> None:
    stored, _ = B.resolve_spec(spec(f("n", "count_changes($machine[M1].temp)"), f("v", "value_at($machine[M1].count, now() - 60)")), CAT)
    compiled = B.compile_spec(stored)
    state = R.FilterState()
    cache: dict[tuple[str, datetime], R.Sample] = {}

    def lookup(signal_id: str, at: datetime) -> R.Sample | None:
        if (signal_id, at) not in cache:
            raise R.LookupPending(signal_id, at)
        return cache[(signal_id, at)]

    first = B.evaluate_detailed(compiled, {S_FLOAT: R.Sample(1.0)}, B.BodyContext(catalog=CAT, lookup=lookup), NOW, state)
    assert first.pending == [(S_INT, NOW - timedelta(seconds=60))] and state.base == {}
    cache[(S_INT, NOW - timedelta(seconds=60))] = R.Sample(41)
    second = B.evaluate_detailed(compiled, {S_FLOAT: R.Sample(1.0)}, B.BodyContext(catalog=CAT, lookup=lookup), NOW, state)
    assert second.pending == [] and json.loads(second.text) == {"n": 0, "v": 41} and len(state.base) == 1
    assert [row["path"] for row in second.fields] == ["/n", "/v"]


def test_compile_spec_never_raises_on_broken_fields() -> None:
    compiled = B.compile_spec(spec(f("bad", "1 +"), m("nosig", "not-a-uuid"), f("good", "2")))
    text, errors = B.evaluate(compiled, {}, None, NOW)
    assert json.loads(text) == {"bad": None, "nosig": None, "good": 2}
    assert [e["code"] for e in errors] == ["SYNTAX", "BAD_REF"]
