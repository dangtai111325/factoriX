"""Value coercion, JSON projection and the sibling source_timestamp rule."""

from __future__ import annotations

from factorix.domain.jsonpath import evaluate, evaluate_nodes
from factorix_edge.mapping import coerce, project_field, project_json

WS_FRAME = {
    "machines": {
        "AA10-01": {
            "http_post_order": {"source_timestamp": "2026-11-05T01:25:53.783Z", "so": 52280, "wo": 14428325, "item": "N3", "order_qty": 65},
            "http_get": {"source_timestamp": "2026-11-05T02:30:03.847Z", "employee": None, "program_name": "ASM-STD-01"},
        },
        "AA10-02": {"http_post_order": {"source_timestamp": "2026-11-05T02:25:21.111Z", "so": 52282}},
    },
    "overview": {"machines": 6},
}


def _field(path: str, **address: object) -> dict:
    return {"id": path, "address_json": {"jsonpath": path, **address}}


# ---- coerce


def test_coerce_string_and_numbers() -> None:
    assert coerce("string", "21113185", "GOOD") == ("21113185", "GOOD", None)
    assert coerce("string", 12345, "GOOD") == ("12345", "GOOD", None)
    assert coerce("int64", 105.0, "GOOD") == (105, "GOOD", None)
    assert coerce("int64", 105.5, "GOOD") == (None, "BAD", "TYPE_MISMATCH")
    assert coerce("bool", 0, "GOOD") == (False, "GOOD", None)
    assert coerce("bool", 1, "GOOD") == (True, "GOOD", None)


def test_null_is_bad_unless_nullable() -> None:
    assert coerce("string", None, "GOOD") == (None, "BAD", "NULL_VALUE")
    assert coerce("string", None, "GOOD", {"nullable": True}) == (None, "GOOD", None)
    assert coerce("float64", None, "GOOD", {"nullable": True}) == (None, "GOOD", None)


def test_round_digits() -> None:
    value, quality, _ = coerce("float64", 0.10000000149011612, "GOOD", {"round_digits": 1})
    assert value == 0.1 and quality == "GOOD"
    assert coerce("float64", 75.197851234, "GOOD", {"round_digits": 5})[0] == 75.19785
    assert coerce("int64", 4.0000001, "GOOD", {"round_digits": 0}) == (4, "GOOD", None)


def test_bad_quality_drops_value() -> None:
    assert coerce("float64", 1.0, "BAD") == (None, "BAD", None)


# ---- jsonpath


def test_jsonpath_bracket_quoted_keys() -> None:
    assert evaluate('$.machines["AA10-01"].http_post_order.so', WS_FRAME) == [52280]
    assert evaluate("$.machines['AA10-02'].http_post_order.so", WS_FRAME) == [52282]
    assert evaluate('$["machines"]["AA10-01"]["http_get"]["program_name"]', WS_FRAME) == ["ASM-STD-01"]
    assert evaluate('$["a]b"]', {"a]b": 1}) == [1]
    assert evaluate('$["say \\"hi\\""]', {'say "hi"': 2}) == [2]


def test_jsonpath_parent_is_returned() -> None:
    [(value, parent)] = evaluate_nodes('$.machines["AA10-01"].http_post_order.so', WS_FRAME)
    assert value == 52280
    assert parent["source_timestamp"] == "2026-11-05T01:25:53.783Z"
    [(root, root_parent)] = evaluate_nodes("$", WS_FRAME)
    assert root is WS_FRAME and root_parent is None


# ---- sibling source_timestamp


def test_sibling_source_timestamp_per_group() -> None:
    samples = project_json(
        [
            _field('$.machines["AA10-01"].http_post_order.so'),
            _field('$.machines["AA10-01"].http_get.program_name'),
            _field('$.machines["AA10-02"].http_post_order.so'),
        ],
        WS_FRAME,
        "2026-11-06T00:00:00.000Z",
    )
    by_id = {s.field_id: s for s in samples}
    assert by_id['$.machines["AA10-01"].http_post_order.so'].source_time == "2026-11-05T01:25:53.783Z"
    assert by_id['$.machines["AA10-01"].http_get.program_name'].source_time == "2026-11-05T02:30:03.847Z"
    assert by_id['$.machines["AA10-02"].http_post_order.so'].source_time == "2026-11-05T02:25:21.111Z"
    assert all(s.received_time == "2026-11-06T00:00:00.000Z" for s in samples)


def test_timestamp_field_itself_and_overrides() -> None:
    body = {"source_timestamp": "2026-11-05T08:41:25.123Z", "status": 2}
    ts = project_field(_field("$.source_timestamp"), body, "r")
    assert ts is not None and ts.value == "2026-11-05T08:41:25.123Z" and ts.source_time == "2026-11-05T08:41:25.123Z"
    disabled = project_field(_field("$.status", timestamp_path=""), body, "r")
    assert disabled is not None and disabled.source_time is None
    override = project_field(_field("$.status", timestamp_path="$.other"), {**body, "other": "2026-01-01T00:00:00Z"}, "r")
    assert override is not None and override.source_time == "2026-01-01T00:00:00.000Z"


def test_invalid_sibling_time_keeps_value_good() -> None:
    sample = project_field(_field("$.status"), {"source_timestamp": "not a time", "status": 2}, "r")
    assert sample is not None
    assert sample.value == 2 and sample.quality == "GOOD"
    assert sample.source_time is None and sample.reason == "SOURCE_TIME_INVALID"


def test_missing_field_skip_or_bad_and_invalid_path() -> None:
    assert project_field(_field("$.nope"), {"a": 1}, "r") is None
    bad = project_field(_field("$.nope", missing="BAD"), {"a": 1}, "r")
    assert bad is not None and bad.quality == "BAD" and bad.reason == "FIELD_MISSING"
    invalid = project_field(_field("$.machines.AA10-01"), WS_FRAME, "r")
    assert invalid is not None and invalid.quality == "BAD" and invalid.reason == "INVALID_PATH"


def test_null_json_value_is_a_value() -> None:
    sample = project_field(_field('$.machines["AA10-01"].http_get.employee'), WS_FRAME, "r")
    assert sample is not None and sample.value is None and sample.quality == "GOOD"
    assert coerce("string", sample.value, sample.quality, {"nullable": True}) == (None, "GOOD", None)

