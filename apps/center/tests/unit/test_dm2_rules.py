"""Data Model v2 Custom Rule language (factorix.domain.rules): parsing, evaluation, references, hostile input."""

from __future__ import annotations

import math
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from factorix.domain import rules as R

NOW = datetime(2026, 11, 9, 10, 0, 0, 123456, tzinfo=timezone.utc)

ZONE = "00000000-0000-0000-0000-00000000a001"
LINE1 = "00000000-0000-0000-0000-00000000b001"
LINE2 = "00000000-0000-0000-0000-00000000b002"
M1 = "00000000-0000-0000-0000-00000000c001"
M2 = "00000000-0000-0000-0000-00000000c002"
DUP_A = "00000000-0000-0000-0000-00000000c00a"
DUP_B = "00000000-0000-0000-0000-00000000c00b"
S_STATUS = "00000000-0000-0000-0000-00000000d001"
S_TEMP = "00000000-0000-0000-0000-00000000d002"
S_ODD = "00000000-0000-0000-0000-00000000d003"
S_DUP_A = "00000000-0000-0000-0000-00000000d00a"
S_DUP_B = "00000000-0000-0000-0000-00000000d00b"
S_GONE = "00000000-0000-0000-0000-00000000d0ff"


def catalog(m1_name: str = "AA10-01", status_key: str = "status") -> R.Catalog:
    return R.Catalog(
        [
            {"id": ZONE, "type_key": "zone", "name": "ASSY", "code": "ASSY", "parent_id": None},
            {"id": LINE1, "type_key": "line", "name": "Assembly - AA10-01 (A1)", "code": "L1", "parent_id": ZONE},
            {"id": LINE2, "type_key": "line", "name": "Assembly - AA10-02 (AB)", "code": "L2", "parent_id": ZONE},
            {"id": M1, "type_key": "machine", "name": m1_name, "code": "M-01", "parent_id": LINE1},
            {"id": M2, "type_key": "machine", "name": "AA10-02", "code": "M-02", "parent_id": LINE2},
            {"id": DUP_A, "type_key": "machine", "name": "Press", "code": "PA", "parent_id": LINE1},
            {"id": DUP_B, "type_key": "machine", "name": "Press", "code": "PB", "parent_id": LINE2},
        ],
        [
            {"id": S_STATUS, "resource_id": M1, "key": status_key, "data_type": "int64"},
            {"id": S_TEMP, "resource_id": M1, "key": "temp_1", "data_type": "float64"},
            {"id": S_ODD, "resource_id": M1, "key": "temp-2 (C)", "data_type": "float64"},
            {"id": S_DUP_A, "resource_id": DUP_A, "key": "speed", "data_type": "float64"},
            {"id": S_DUP_B, "resource_id": DUP_B, "key": "speed", "data_type": "float64"},
            {"id": S_GONE, "resource_id": M1, "key": "gone", "data_type": "float64", "active": False},
        ],
        types=["enterprise", "site", "area", "zone", "line", "machine"],
    )


CAT = catalog()


def ev(text: str, samples: dict[str, Any] | None = None, *, now: datetime = NOW, cat: R.Catalog | None = CAT, **ctx: Any) -> Any:
    context = R.EvalContext(now=now, samples={k: (v if isinstance(v, R.Sample) or v is None else R.Sample(v)) for k, v in (samples or {}).items()}, **ctx)
    return R.evaluate_text(text, context, cat)


def err(text: str, **kw: Any) -> R.RuleError | R.RuleRuntimeError:
    with pytest.raises((R.RuleError, R.RuleRuntimeError)) as info:
        ev(text, **kw)
    return info.value


# ---- arithmetic, precedence, operators -------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1 + 2 * 3", 7),
        ("(1 + 2) * 3", 9),
        ("2 + 3 * 4 ** 2 / 8", 8.0),
        ("-2 ** 2", -4),
        ("2 ** 3 ** 2", 512),
        ("2 ** -1", 0.5),
        ("10 / 4", 2.5),
        ("7 // 2", 3),
        ("-7 // 2", -4),
        ("7 % 3", 1),
        ("-7 % 3", 2),
        ("+5", 5),
        ("--5", 5),
        ("1.5e3", 1500.0),
        ("0x10", 16),
        ("1 < 2 < 3", True),
        ("1 < 3 < 2", False),
        ("3 >= 3", True),
        ("2 != 2", False),
        ("'a' < 'b'", True),
        ("not 0", True),
        ("not 'x'", False),
        ("1 and 2", 2),
        ("0 and 2", 0),
        ("0 or 'x'", "x"),
        ("null or 5", 5),
        ("1 if true else 2", 1),
        ("1 if False else 2", 2),
        ("'yes' if 3 > 2 and 2 > 1 else 'no'", "yes"),
        ("true + 1", 2),
        ("'ab' + 'cd'", "abcd"),
        ("'ab' * 3", "ababab"),
        ("3 * 'ab'", "ababab"),
        ("1 == 1.0", True),
        ("1 == '1'", False),
        ("true", True),
        ("True", True),
        ("None", None),
        ("'multi\\nline'", "multi\nline"),
        ("1 +\n 2", 3),
        ("1 + 2  # comment with $ and {{", 3),
    ],
)
def test_arithmetic_and_precedence(text: str, expected: Any) -> None:
    result = ev(text)
    assert result == expected and type(result) is type(expected)


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("1 / 0", "DIV0"),
        ("1 // 0", "DIV0"),
        ("1 % 0", "DIV0"),
        ("0 ** -1", "DIV0"),
        ("'a' + 1", "TYPE"),
        ("'a' - 'b'", "TYPE"),
        ("'a' < 1", "TYPE"),
        ("-'a'", "TYPE"),
        ("'a' % 2", "TYPE"),
        ("(-8) ** 0.5", "RUNTIME"),
        ("1e308 * 10", "RUNTIME"),
    ],
)
def test_runtime_errors(text: str, code: str) -> None:
    assert err(text).code == code


# ---- null handling -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("null + 1", None),
        ("1 - null", None),
        ("null * 'a'", None),
        ("null > 1", None),
        ("1 < null < 3", None),
        ("null == null", True),
        ("null != 1", True),
        ("-null", None),
        ("not null", True),
        ("isnull(null)", True),
        ("isnull(0)", False),
        ("coalesce(null, null, 3, 4)", 3),
        ("coalesce(null)", None),
        ("if(null, 1, 2)", 2),
        ("min(null, 3, 1)", 1),
        ("max(null, null)", None),
        ("concat('a', null, 1)", "a1"),
        ("str(null)", None),
        ("int(null)", None),
        ("sqrt(null)", None),
        ("round(null, 2)", None),
        ("upper(null)", None),
        ("len(null)", None),
        ("format(null, 2)", None),
    ],
)
def test_null_handling(text: str, expected: Any) -> None:
    assert ev(text) == expected


# ---- functions ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("abs(-3)", 3),
        ("floor(2.7)", 2),
        ("floor(-2.1)", -3),
        ("ceil(2.1)", 3),
        ("sqrt(16)", 4.0),
        ("pow(2, 10)", 1024),
        ("exp(0)", 1.0),
        ("log(math_e)".replace("math_e", repr(math.e)), 1.0),
        ("log(8, 2)", 3.0),
        ("log10(1000)", 3.0),
        ("log2(8)", 3.0),
        ("sin(0)", 0.0),
        ("cos(0)", 1.0),
        ("tan(0)", 0.0),
        ("asin(0)", 0.0),
        ("acos(1)", 0.0),
        ("atan(0)", 0.0),
        ("atan2(0, 1)", 0.0),
        ("degrees(0)", 0.0),
        ("radians(180)", math.pi),
        ("clamp(15, 0, 10)", 10),
        ("clamp(-1, 0, 10)", 0),
        ("sign(-2.5)", -1),
        ("sign(0)", 0),
        ("hypot(3, 4)", 5.0),
        ("min(3, 1, 2)", 1),
        ("max(3, 1, 2)", 3),
        ("min('b', 'a')", "a"),
        ("round(2.5)", 3),
        ("round(-2.5)", -3),
        ("round(1.005, 2)", 1.01),
        ("round(1234, -2)", 1200),
        ("if(1 > 0, 'a', 'b')", "a"),
        ("if (0, 'a', 'b')", "b"),
        ("str(1.5)", "1.5"),
        ("str(true)", "true"),
        ("int('12')", 12),
        ("int(' 3.7 ')", 3),
        ("int(3.9)", 3),
        ("int(-3.9)", -3),
        ("int(true)", 1),
        ("float('1.5')", 1.5),
        ("float(2)", 2.0),
        ("bool('yes')", True),
        ("bool('OFF')", False),
        ("bool(0)", False),
        ("bool(2)", True),
        ("upper('ab')", "AB"),
        ("lower('AB')", "ab"),
        ("upper(12)", "12"),
        ("concat('a', 'b', 'c')", "abc"),
        ("len('abc')", 3),
        ("substr('abcdef', 2, 3)", "cde"),
        ("substr('abcdef', 2)", "cdef"),
        ("substr('abcdef', -2)", "ef"),
        ("replace('a-b-c', '-', '+')", "a+b+c"),
        ("format(3.14159, 2)", "3.14"),
        ("format(2.5, 0)", "3"),
        ("format(1, 3)", "1.000"),
    ],
)
def test_functions(text: str, expected: Any) -> None:
    result = ev(text)
    if isinstance(expected, float):
        assert result == pytest.approx(expected)
    else:
        assert result == expected and type(result) is type(expected)


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("sqrt(-1)", "RUNTIME"),
        ("log(0)", "RUNTIME"),
        ("exp(1000)", "LIMIT"),
        ("int('abc')", "CAST"),
        ("float('x')", "CAST"),
        ("bool('maybe')", "CAST"),
        ("len(5)", "TYPE"),
        ("abs('x')", "TYPE"),
        ("clamp(1, 5, 0)", "ARGS"),
        ("format(1, 99)", "ARGS"),
        ("substr('abc', 'x')", "ARGS"),
        ("replace('abc', '', 'x')", "ARGS"),
    ],
)
def test_function_errors(text: str, code: str) -> None:
    assert err(text).code == code


def test_every_listed_function_is_documented_and_callable() -> None:
    names = {f["name"] for f in R.function_catalog()}
    expected = set(
        "abs min max round floor ceil sqrt pow exp log log10 log2 sin cos tan asin acos atan atan2 degrees radians clamp sign hypot "
        "if coalesce isnull str int float bool upper lower concat len substr replace format now ts latest_ts age quality value_at "
        "debounce hold avg ema delta rate hysteresis changed count_changes".split()
    )
    assert names == expected
    assert all(f["signature"].startswith(f["name"] + "(") for f in R.function_catalog())


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("abs()", "ARGS"),
        ("abs(1, 2)", "ARGS"),
        ("now(1)", "ARGS"),
        ("round(x=1)", "ARGS"),
        ("foo(1)", "UNKNOWN_FUNCTION"),
        ("ts(1)", "ARGS"),
        ("latest_ts($machine[AA10-01].status, 1)", "ARGS"),
        ("value_at(5, now())", "ARGS"),
        ("abs", "SYNTAX"),
        ("speed + 1", "UNKNOWN_NAME"),
    ],
)
def test_compile_errors(text: str, code: str) -> None:
    error = err(text)
    assert isinstance(error, R.RuleError) and error.code == code


def test_unknown_function_suggests_close_names() -> None:
    error = err("roud(1.2)")
    assert error.code == "UNKNOWN_FUNCTION" and any(s.startswith("round(") for s in error.suggestions)


def test_syntax_error_position_points_into_the_typed_text() -> None:
    text = "$machine[AA10-01].status + * 2"
    error = err(text)
    assert error.code == "SYNTAX" and error.pos is not None and text.index("$") <= error.pos <= len(text)
    resolved = R.resolve(text, CAT)
    with pytest.raises(R.RuleError) as info:
        R.compile_rule(resolved.stored)
    assert resolved.original_pos(info.value.pos) is not None
    assert resolved.original_pos(info.value.pos) >= text.index("+")


# ---- timestamps --------------------------------------------------------------------------------


def test_now_and_timestamp_arithmetic() -> None:
    assert ev("now()") == NOW
    t1 = NOW - timedelta(seconds=30)
    samples = {S_STATUS: R.Sample(1, source_time=t1, received_time=NOW), S_TEMP: R.Sample(2.0, source_time=None, received_time=NOW - timedelta(seconds=5))}
    assert ev("ts($machine[AA10-01].status)", samples) == t1
    assert ev("ts($machine[AA10-01].temp_1)", samples) == NOW - timedelta(seconds=5)  # falls back to received_time
    assert ev("now() - ts($machine[AA10-01].status)", samples) == 30.0
    assert ev("ts($machine[AA10-01].status) + 30 == now()", samples) is True
    assert ev("ts($machine[AA10-01].status) - 0.5 < ts($machine[AA10-01].status)", samples) is True
    assert ev("age($machine[AA10-01].temp_1)", samples) == 5.0
    assert ev("int(now())", samples) == int(round(NOW.timestamp() * 1000))
    assert ev("str(now())") == "2026-11-09T10:00:00.123Z"
    assert R.fmt_ts(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)) == "2026-01-02T03:04:05.000Z"
    assert err("now() + 'x'").code == "TYPE"
    assert err("now() < 5").code == "TYPE"


def test_latest_ts_picks_the_later_group_timestamp() -> None:
    t1, t2 = NOW - timedelta(seconds=10), NOW - timedelta(seconds=3)
    expr = "latest_ts($machine[AA10-01].status, $machine[AA10-01].temp_1)"
    assert ev(expr, {S_STATUS: R.Sample(1, source_time=t1), S_TEMP: R.Sample(1, source_time=t2)}) == t2
    assert ev(expr, {S_STATUS: R.Sample(1, source_time=t2), S_TEMP: R.Sample(1, source_time=t1)}) == t2
    assert ev(expr, {S_STATUS: R.Sample(1, source_time=t1), S_TEMP: R.Sample(1, source_time=t1)}) == t1  # equal
    assert ev(expr, {S_STATUS: R.Sample(1, source_time=t1)}) == t1  # one group has no data yet
    assert ev(expr, {}) is None


def test_quality_reports_actual_latest_quality() -> None:
    samples = {S_STATUS: R.Sample(1, quality="UNCERTAIN")}
    assert ev("quality($machine[AA10-01].status)", samples) == "UNCERTAIN"
    assert ev("quality($machine[AA10-01].status)", samples, qualities={S_STATUS: "BAD"}) == "BAD"
    assert ev("quality($machine[AA10-01].temp_1)") is None


def test_value_at_uses_the_injected_lookup() -> None:
    at = NOW - timedelta(minutes=5)
    calls: list[tuple[str, datetime]] = []

    def lookup(signal_id: str, when: datetime) -> R.Sample | None:
        calls.append((signal_id, when))
        return R.Sample("SO-1") if when <= at else R.Sample("SO-2")

    samples = {S_TEMP: R.Sample(9, source_time=at)}
    assert ev("value_at($machine[AA10-01].status, ts($machine[AA10-01].temp_1))", samples, lookup=lookup) == "SO-1"
    assert calls == [(S_STATUS, at)]
    assert ev("value_at($machine[AA10-01].status, '2026-11-09T09:55:00.123Z')", lookup=lookup) == "SO-1"
    assert ev("value_at($machine[AA10-01].status, null)", lookup=lookup) is None
    assert ev("value_at($machine[AA10-01].status, now())", lookup=lambda s, w: None) is None
    assert err("value_at($machine[AA10-01].status, 'soon')", lookup=lookup).code == "TYPE"
    assert err("value_at($machine[AA10-01].status, now())").code == "UNSUPPORTED"

    def pending(signal_id: str, when: datetime) -> R.Sample | None:
        raise R.LookupPending(signal_id, when)

    with pytest.raises(R.LookupPending):
        ev("value_at($machine[AA10-01].status, now())", lookup=pending)


# ---- stateful filters --------------------------------------------------------------------------


def run_filter(expr: str, xs: list[Any], step_ms: int = 1000) -> list[Any]:
    program = R.compile_rule(R.resolve(expr, CAT).stored)
    state = R.FilterState()
    out = []
    for i, x in enumerate(xs):
        ctx = R.EvalContext(now=NOW + timedelta(milliseconds=i * step_ms), samples={S_TEMP: None if x is None else R.Sample(x)}, catalog=CAT, state=state)
        out.append(R.evaluate_rule(program, ctx, scope="/f"))
        state.commit()
    return out


def test_debounce() -> None:
    xs = [0, 1, 1, 1, 0, 1, 1, 1, 1]
    assert run_filter("debounce($machine[AA10-01].temp_1, 2000)", xs) == [0, 0, 0, 1, 1, 1, 1, 1, 1]


def test_hold() -> None:
    assert run_filter("hold($machine[AA10-01].temp_1, 2000)", [5, None, None, None, 7, None]) == [5, 5, 5, None, 7, 7]


def test_avg_ema_delta_rate() -> None:
    assert run_filter("avg($machine[AA10-01].temp_1, 3)", [1, 2, 3, 4, None, 9]) == [1.0, 1.5, 2.0, 3.0, 3.0, pytest.approx(16 / 3)]
    assert run_filter("ema($machine[AA10-01].temp_1, 0.5)", [10, 20, None, 0]) == [10.0, 15.0, 15.0, 7.5]
    assert run_filter("delta($machine[AA10-01].temp_1)", [1, 4, None, 10]) == [None, 3, None, 6]
    assert run_filter("rate($machine[AA10-01].temp_1)", [0, 10, 30], step_ms=2000) == [None, 5.0, 10.0]


def test_hysteresis_changed_count_changes() -> None:
    assert run_filter("hysteresis($machine[AA10-01].temp_1, 10, 20)", [5, 15, 25, 15, 10, 15]) == [False, False, True, True, False, False]
    assert run_filter("changed($machine[AA10-01].temp_1)", [1, 1, 2, 2, 1]) == [False, False, True, False, True]
    assert run_filter("count_changes($machine[AA10-01].temp_1)", [1, 1, 2, 2, 1]) == [0, 0, 1, 1, 2]


def test_filter_state_is_per_call_site_and_discardable() -> None:
    program = R.compile_rule(R.resolve("delta($machine[AA10-01].temp_1) + 0 * count_changes($machine[AA10-01].temp_1)", CAT).stored)
    assert program.stateful_calls == 2
    state = R.FilterState()
    ctx = R.EvalContext(now=NOW, samples={S_TEMP: R.Sample(1)}, catalog=CAT, state=state)
    R.evaluate_rule(program, ctx, scope="/a")
    state.discard()  # a discarded pass leaves no trace
    assert state.base == {}
    R.evaluate_rule(program, ctx, scope="/a")
    state.commit()
    assert {key[1] for key in state.base} == {0, 1}


@pytest.mark.parametrize(
    "text",
    ["avg($machine[AA10-01].temp_1, 0)", "avg($machine[AA10-01].temp_1, 5000)", "ema($machine[AA10-01].temp_1, 2)", "debounce($machine[AA10-01].temp_1, -1)", "hysteresis($machine[AA10-01].temp_1, 5, 1)"],
)
def test_filter_parameter_errors(text: str) -> None:
    assert err(text, samples={S_TEMP: R.Sample(1)}).code == "ARGS"


# ---- references --------------------------------------------------------------------------------


def test_resolve_to_tokens_and_render_with_current_names() -> None:
    text = "latest_ts($machine[AA10-01].status, $machine[AA10-01].temp_1) "
    resolved = R.resolve(text, CAT)
    assert resolved.ok and resolved.stored == f"latest_ts({{{{sig:{S_STATUS}}}}}, {{{{sig:{S_TEMP}}}}}) "
    assert resolved.labels == {f"sig:{S_STATUS}": "$machine[AA10-01].status", f"sig:{S_TEMP}": "$machine[AA10-01].temp_1"}
    assert R.render(resolved.stored, CAT, resolved.labels) == (text, [])
    # auto-fix: rename the machine and the signal key; the stored rule renders the new names
    renamed = catalog(m1_name="AA10-01X", status_key="state")
    assert R.render(resolved.stored, renamed)[0] == "latest_ts($machine[AA10-01X].state, $machine[AA10-01X].temp_1) "


def test_resource_attributes() -> None:
    assert ev("$machine[AA10-01].@name") == "AA10-01"
    assert ev("$machine[AA10-01].@code") == "M-01"
    assert ev("$machine[AA10-01].@type") == "machine"
    assert ev("$machine[AA10-01].@zone.@name") == "ASSY"
    assert ev("$machine[AA10-01].@line.@name") == "Assembly - AA10-01 (A1)"
    assert ev("$machine[AA10-01].@line.@zone.@code") == "ASSY"
    assert ev("$zone[ASSY].@zone.@name") == "ASSY"  # the resource itself counts
    resolved = R.resolve("$machine[AA10-01].@zone.@name", CAT)
    assert resolved.stored == f"{{{{res:{M1}}}}}.@zone.@name"
    assert R.render(resolved.stored, catalog(m1_name="Renamed"))[0] == "$machine[Renamed].@zone.@name"


def test_match_by_code_and_case_insensitively() -> None:
    assert R.resolve("$machine[M-01].status", CAT).stored == f"{{{{sig:{S_STATUS}}}}}"
    assert R.resolve("$machine[aa10-01].status", CAT).stored == f"{{{{sig:{S_STATUS}}}}}"


def test_ambiguous_reference_suggests_disambiguated_chains() -> None:
    resolved = R.resolve("$machine[Press].speed", CAT)
    assert not resolved.ok
    issue = resolved.issues[0]
    assert issue.code == "AMBIGUOUS_REF" and issue.pos == 0
    assert issue.suggestions == ["$line[Assembly - AA10-01 (A1)].machine[Press].speed", "$line[Assembly - AA10-02 (AB)].machine[Press].speed"]
    chained = R.resolve("$line[Assembly - AA10-02 (AB)].machine[Press].speed", CAT)
    assert chained.ok and chained.refs[0].id == S_DUP_B
    assert R.resolve("$zone[ASSY].machine[AA10-01].status", CAT).ok  # any ancestor, not only the parent
    assert R.render(chained.stored, CAT)[0] == "$line[Assembly - AA10-02 (AB)].machine[Press].speed"


@pytest.mark.parametrize(
    ("text", "code", "suggestion"),
    [
        ("$machin[AA10-01].status", "UNKNOWN_TYPE", "$machine[...]"),
        ("$machine[AA10-0l].status", "UNKNOWN_RESOURCE", "$machine[AA10-01].status"),
        ("$machine[AA10-01].staus", "UNKNOWN_SIGNAL", "$machine[AA10-01].status"),
        ("$machine[AA10-01].@nam", "UNKNOWN_ATTRIBUTE", ".@name"),
        ("$machine[AA10-01].@zone", "UNKNOWN_ATTRIBUTE", "$machine[AA10-01].@zone.@name"),
        ("$machine[AA10-01]", "BAD_REF", "$machine[AA10-01].@name"),
        ("$line[Assembly - AA10-02 (AB)].machine[AA10-01].status", "UNKNOWN_RESOURCE", None),
        ("$zone[ASSY].@site.@name", "NO_ANCESTOR", None),
        ("$machine[AA10-01", "BAD_REF", None),
        ("$ + 1", "BAD_REF", None),
        ("$machine[AA10-01].status.@name", "BAD_REF", None),
    ],
)
def test_reference_errors_are_precise(text: str, code: str, suggestion: str | None) -> None:
    resolved = R.resolve(text, CAT)
    assert not resolved.ok
    issue = next(i for i in resolved.issues if i.severity == "error")
    assert issue.code == code and issue.pos is not None
    if suggestion:
        assert suggestion in issue.suggestions


def test_backquoted_keys_and_escaped_names() -> None:
    assert R.resolve("$machine[AA10-01].`temp-2 (C)` * 2", CAT).refs[0].id == S_ODD
    assert CAT.signal_text(S_ODD) == "$machine[AA10-01].`temp-2 (C)`"
    odd = R.Catalog([{"id": M1, "type_key": "machine", "name": "A]B[C\\", "code": "x", "parent_id": None}], [{"id": S_STATUS, "resource_id": M1, "key": "k"}])
    text = odd.signal_text(S_STATUS)
    assert text == "$machine[A\\]B\\[C\\\\].k"
    assert R.resolve(text, odd).refs[0].id == S_STATUS


def test_references_inside_strings_are_text() -> None:
    assert ev("'$machine[AA10-01].status'") == "$machine[AA10-01].status"
    assert ev('concat("{{sig:x}}", "")') == "{{sig:x}}"


def test_missing_targets_render_with_last_label_and_round_trip() -> None:
    stored = f"{{{{sig:{S_GONE}}}}} + 1"
    labels = {f"sig:{S_GONE}": "$machine[AA10-01].gone"}
    display, missing = R.render(stored, CAT, labels)
    assert display == "$⚠missing[$machine[AA10-01].gone] + 1" and missing == [f"sig:{S_GONE}"]
    back = R.resolve(display, CAT, labels)
    assert back.stored == stored and back.ok and back.issues[0].code == "MISSING_REF" and back.issues[0].severity == "warning"
    unknown = R.resolve("$⚠missing[$machine[X].y] + 1", CAT)
    assert not unknown.ok and unknown.issues[0].code == "MISSING_REF"
    with pytest.raises(R.RuleRuntimeError) as info:
        R.evaluate_rule(R.compile_rule(stored), R.EvalContext(now=NOW, catalog=CAT, labels=labels))
    assert info.value.code == "MISSING_REF" and "$machine[AA10-01].gone" in info.value.message
    assert R.missing_text("a\\]b") == "$⚠missing[a\\\\\\]b]"
    assert R.resolve(R.missing_text("a\\]b"), CAT, {f"sig:{S_GONE}": "a\\]b"}).stored == f"{{{{sig:{S_GONE}}}}}"


def test_tokens_are_kept_as_typed_and_retargetable() -> None:
    stored = f"{{{{sig:{S_STATUS}}}}} + {{{{res:{M1}}}}}.@name"
    assert R.resolve(stored, CAT).stored == stored
    moved = R.replace_tokens(stored, {f"sig:{S_STATUS}": S_TEMP, f"res:{M1}": M2})
    assert moved == f"{{{{sig:{S_TEMP}}}}} + {{{{res:{M2}}}}}.@name"
    assert [t.label_key for t in R.token_refs(moved)] == [f"sig:{S_TEMP}", f"res:{M2}"]


# ---- hostile input -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "codes"),
    [
        ("__import__('os')", {"NOT_ALLOWED"}),
        ("__fxr0__", {"NOT_ALLOWED"}),
        ("().__class__", {"NOT_ALLOWED"}),
        ("(1).real", {"NOT_ALLOWED"}),
        ("'abc'.upper()", {"NOT_ALLOWED"}),
        ("open('/etc/passwd')", {"UNKNOWN_FUNCTION"}),
        ("eval('1')", {"UNKNOWN_FUNCTION"}),
        ("exec('x=1')", {"UNKNOWN_FUNCTION"}),
        ("globals()", {"UNKNOWN_FUNCTION"}),
        ("lambda: 1", {"NOT_ALLOWED", "SYNTAX"}),
        ("[x for x in 'ab']", {"NOT_ALLOWED", "UNKNOWN_NAME"}),
        ("'abc'[0]", {"NOT_ALLOWED"}),
        ("f'{1}'", {"NOT_ALLOWED"}),
        ("(x := 1)", {"NOT_ALLOWED", "SYNTAX", "UNKNOWN_NAME"}),
        ("import os", {"SYNTAX"}),
        ("1; 2", {"SYNTAX"}),
        ("x = 1", {"SYNTAX"}),
        ("1) + (2", {"SYNTAX"}),
        ("{'a': 1}", {"NOT_ALLOWED"}),
        ("(1, 2)", {"NOT_ALLOWED"}),
        ("max(*'ab')", {"NOT_ALLOWED"}),
        ("b'x'", {"NOT_ALLOWED"}),
        ("1j", {"NOT_ALLOWED"}),
        ("...", {"NOT_ALLOWED"}),
        ("1 @ 2", {"NOT_ALLOWED"}),
        ("1 << 2", {"NOT_ALLOWED"}),
        ("1 in 'a'", {"NOT_ALLOWED"}),
        ("await x", {"NOT_ALLOWED", "SYNTAX", "UNKNOWN_NAME"}),
        ("yield 1", {"NOT_ALLOWED", "SYNTAX"}),
        ("9 ** 9 ** 9", {"LIMIT"}),
        ("2 ** 100000", {"LIMIT"}),
        ("10.0 ** 400", {"LIMIT"}),
        ("pow(10, 5000)", {"LIMIT"}),
        ("'a' * 100000", {"LIMIT"}),
        ("1" + "0" * 400, {"LIMIT"}),
        ("(" * 200 + "1" + ")" * 200, {"LIMIT"}),
        ("-" * 3000 + "1", {"LIMIT", "SYNTAX"}),
        ("not " * 900 + "1", {"LIMIT", "SYNTAX"}),
        ("1" + "+1" * 1500, {"LIMIT"}),
        ("abs(" * 100 + "1" + ")" * 100, {"LIMIT"}),
        ("'" + "a" * 5000 + "'", {"EXPR_TOO_LONG"}),
        ("x" * 5000, {"EXPR_TOO_LONG"}),
    ],
)
def test_hostile_inputs_fail_cleanly_and_fast(text: str, codes: set[str]) -> None:
    started = time.perf_counter()
    error = err(text)
    assert error.code in codes, (error.code, error.message)
    assert time.perf_counter() - started < 1.0


def test_large_but_legal_text_results_are_bounded() -> None:
    with pytest.raises(R.RuleRuntimeError) as info:
        ev("concat('a' * 2600, 'a' * 2600, 'a' * 2600, 'a' * 2600)")
    assert info.value.code == "LIMIT"
    with pytest.raises(R.RuleRuntimeError) as info:
        ev("replace('a' * 2000, 'a', 'bbbbbbbbbb')")
    assert info.value.code == "LIMIT"
    with pytest.raises(R.RuleRuntimeError):
        ev("'ab' * 3000 + 'ab' * 3000")
    assert len(ev("'ab' * 5000")) == 10000


def test_no_python_eval_or_builtins_reachable() -> None:
    import ast as _ast

    source = open(R.__file__, encoding="utf-8").read()
    tree = _ast.parse(source)
    called = {n.func.id for n in _ast.walk(tree) if isinstance(n, _ast.Call) and isinstance(n.func, _ast.Name)}
    assert not called & {"eval", "exec", "compile", "__import__", "globals", "locals", "vars", "setattr"}
