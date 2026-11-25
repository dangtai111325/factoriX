"""Dashboard document schema v1: structural validation, normalization, legacy upgrade, completeness (contract §1–§3)."""

from __future__ import annotations

import base64
import copy
import json
from typing import Any

import pytest

from factorix.application.dashboards import registry as R
from factorix.application.dashboards.documents import (
    completeness_issues,
    default_document,
    normalize_source,
    upgrade_document,
    validate_structure,
)

SIG = "00000000-0000-0000-0000-000000000301"
MODEL = "00000000-0000-0000-0000-000000000401"
PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16).decode()


def widget(wid: str = "w_kpi", type_: str = "kpi", *, bindings: list[dict[str, Any]] | None = None, x: int = 0, y: int = 0,
           w: int | None = None, h: int | None = None, **options: Any) -> dict[str, Any]:
    wt = R.WIDGET_TYPES[type_]
    return {"id": wid, "type": type_, "layout": {"lg": {"x": x, "y": y, "w": w or wt.default_size[0], "h": h or wt.default_size[1]}},
            "bindings": bindings if bindings is not None else [], "options": options}


def sig(bid: str = "b_1", signal_id: str = SIG, **extra: Any) -> dict[str, Any]:
    return {"id": bid, "source": {"kind": "signal", "signal_id": signal_id}, **extra}


def doc(*widgets: dict[str, Any], **top: Any) -> dict[str, Any]:
    out = {"schema_version": 1, "widgets": list(widgets)}
    out.update(top)
    return out


def codes(issues: list[dict[str, Any]], severity: str | None = "error") -> list[str]:
    return [i["code"] for i in issues if severity is None or i["severity"] == severity]


def check(raw: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    normalized, issues = validate_structure(raw)
    return normalized, codes(issues)


# ---- normalization -------------------------------------------------------------------------------------


def test_minimal_document_is_normalized_with_every_default() -> None:
    normalized, issues = validate_structure({"schema_version": 1})
    assert issues == []
    assert normalized == default_document()
    assert normalized["settings"] == {
        "theme": {"preset": "factorix_light", "accent": None, "canvas": None, "surface": None, "text": None,
                  "radius": 12, "gap": 12, "font_scale": 1.0},
        "time_range": {"kind": "relative", "last": "1h"}, "refresh": "live", "row_height": 40,
    }


def test_widget_defaults_are_filled_and_ids_canonical() -> None:
    raw = doc(widget(bindings=[sig(signal_id=SIG.upper())]))
    normalized, errors = check(raw)
    assert errors == []
    w = normalized["widgets"][0]
    assert w["version"] == 1 and w["title"] == "" and w["time"] == {"mode": "dashboard"}
    assert w["hidden"] == {"lg": False, "md": False, "sm": False}
    assert w["layout"] == {"lg": {"x": 0, "y": 0, "w": 3, "h": 3}, "md": None, "sm": None}
    assert w["options"] == R.default_options(R.WIDGET_TYPES["kpi"])
    b = w["bindings"][0]
    assert b == {"id": "b_1", "source": {"kind": "signal", "signal_id": SIG}, "label": None, "color": None, "unit": None,
                 "scale": 1.0, "offset": 0.0}
    assert "role" not in b  # only for widgets that declare roles
    # Normalizing a normalized document is the identity.
    again, errors = check(normalized)
    assert errors == [] and again == normalized


def test_settings_bounds_and_choices() -> None:
    for settings, code in (
        ({"theme": {"preset": "neon"}}, "INVALID_VALUE"),
        ({"theme": {"radius": 25}}, "OUT_OF_RANGE"),
        ({"theme": {"gap": 3}}, "OUT_OF_RANGE"),
        ({"theme": {"font_scale": 1.5}}, "OUT_OF_RANGE"),
        ({"theme": {"accent": "red"}}, "INVALID_VALUE"),
        ({"theme": {"css": "body{}"}}, "UNKNOWN_KEY"),
        ({"row_height": 23}, "OUT_OF_RANGE"),
        ({"row_height": 40.0}, "INVALID_TYPE"),
        ({"refresh": "1s"}, "INVALID_VALUE"),
        ({"time_range": {"kind": "relative", "last": "2h"}}, "INVALID_VALUE"),
        ({"time_range": {"kind": "absolute", "start": "2026-11-25T08:00:00Z", "end": "2026-11-25T07:00:00Z"}}, "INVALID_VALUE"),
        ({"time_range": {"kind": "absolute", "start": "2026-11-25T08:00:00", "end": "2026-11-26T08:00:00Z"}}, "INVALID_VALUE"),
        ({"time_range": {"kind": "absolute", "start": "2025-01-01T00:00:00Z", "end": "2026-11-26T00:00:00Z"}}, "INVALID_VALUE"),
        ({"time_range": {"kind": "sql", "query": "SELECT 1"}}, "INVALID_VALUE"),
    ):
        _n, errors = check(doc(settings=settings))
        assert code in errors, (settings, errors)
    ok, errors = check(doc(settings={"time_range": {"kind": "absolute", "start": "2026-11-25T00:00:00+07:00",
                                                    "end": "2026-11-25T08:00:00Z"}}))
    assert errors == [] and ok["settings"]["time_range"]["start"] == "2026-11-24T17:00:00.000Z"


def test_unknown_keys_are_rejected_everywhere() -> None:
    base = widget(bindings=[sig()])
    cases = [
        doc(base, extra=1),
        doc({**base, "script": "alert(1)"}),
        doc({**base, "layout": {"lg": {"x": 0, "y": 0, "w": 3, "h": 3, "z": 1}}}),
        doc({**base, "bindings": [{**sig(), "query": "SELECT 1"}]}),
        doc({**base, "bindings": [{"id": "b_1", "source": {"kind": "signal", "signal_id": SIG, "table": "op_x"}}]}),
        doc(widget(bindings=[sig()], unknown_option=True)),
        doc(base, variables=[{"id": "machine", "type": "resource", "sql": "x"}]),
    ]
    for raw in cases:
        normalized, errors = check(raw)
        assert normalized is None and errors, raw
        assert set(errors) & {"UNKNOWN_KEY", "OPTION_UNKNOWN", "INVALID_REF"}, errors


@pytest.mark.parametrize("kind", ["url", "http", "sql", "table", "tdengine_table", "script", "subtable", None, 3])
def test_no_url_sql_or_table_source_kind_is_accepted(kind: Any) -> None:
    raw = doc(widget(bindings=[{"id": "b_1", "source": {"kind": kind, "url": "http://x", "sql": "SELECT 1"}}]))
    normalized, issues = validate_structure(raw)
    assert normalized is None
    assert codes(issues) == ["INVALID_SOURCE_KIND"]


def test_source_shapes() -> None:
    assert normalize_source({"kind": "model_field", "model_id": MODEL.upper(), "field_path": "/spindle/speed"})[0] == {
        "kind": "model_field", "model_id": MODEL, "field_path": "spindle/speed"}
    assert normalize_source({"kind": "signal", "signal_id": "nope"})[1] == "INVALID_REF"
    assert normalize_source({"kind": "model_field", "model_id": MODEL, "field_path": "/"})[1] == "INVALID_REF"
    assert normalize_source({"kind": "model_field", "model_id": MODEL, "field_path": "x" * 513})[1] == "INVALID_REF"
    assert normalize_source({"kind": "signal_key", "variable": "Machine", "key": "k"})[1] == "INVALID_REF"
    assert normalize_source({"kind": "signal_key", "variable": "machine", "key": ""})[1] == "INVALID_REF"
    assert normalize_source({"kind": "role", "role": "main_value"})[0] == {"kind": "role", "role": "main_value"}
    assert normalize_source("signal")[1] == "INVALID_REF"


def test_signal_key_needs_a_declared_variable() -> None:
    b = {"id": "b_1", "source": {"kind": "signal_key", "variable": "machine", "key": "speed_1"}}
    assert "VARIABLE_UNKNOWN" in check(doc(widget(bindings=[b])))[1]
    ok, errors = check(doc(widget(bindings=[b]), variables=[{"id": "machine", "label": "Machine", "resource_type": "machine"}]))
    assert errors == [] and ok["variables"] == [{"id": "machine", "label": "Machine", "type": "resource", "resource_type": "machine", "default": None}]


def test_variables_rules() -> None:
    assert "DUPLICATE_ID" in check(doc(variables=[{"id": "m"}, {"id": "m"}]))[1]
    assert "LIMIT" in check(doc(variables=[{"id": f"v{i}"} for i in range(R.MAX_VARIABLES + 1)]))[1]
    assert "INVALID_VALUE" in check(doc(variables=[{"id": "m", "type": "signal"}]))[1]
    assert "INVALID_VALUE" in check(doc(variables=[{"id": "m", "default": "not-a-uuid"}]))[1]


# ---- ids, counts, limits -------------------------------------------------------------------------------


def test_widget_and_binding_ids() -> None:
    assert "INVALID_VALUE" in check(doc(widget("w1")))[1]  # too short
    assert "INVALID_VALUE" in check(doc(widget("W_KPI")))[1]  # upper case
    assert "DUPLICATE_ID" in check(doc(widget("w_a"), widget("w_a", x=3)))[1]
    assert "DUPLICATE_ID" in check(doc(widget("w_a", "latest_table", bindings=[sig("b_1"), sig("b_1")])))[1]
    assert "INVALID_VALUE" in check(doc(widget(bindings=[sig("b 1")])))[1]


def test_widget_type_and_version() -> None:
    assert check(doc(widget(type_="kpi") | {"type": "process_diagram"}))[1] == ["UNKNOWN_WIDGET_TYPE"]
    assert check(doc(widget() | {"version": 2}))[1] == ["UNSUPPORTED_VERSION"]
    assert check({"schema_version": 2})[1] == ["UNSUPPORTED_SCHEMA_VERSION"]


def test_widget_cap_is_40() -> None:
    forty = [widget(f"w_{i:02d}", "text", x=0, y=i, w=1, h=1) for i in range(40)]
    assert check(doc(*forty))[1] == []
    assert "LIMIT" in check(doc(*forty, widget("w_extra", "text", y=50, w=1, h=1)))[1]


def test_binding_counts_by_type() -> None:
    assert "TOO_MANY_BINDINGS" in check(doc(widget(bindings=[sig("b_1"), sig("b_2")])))[1]
    assert "TOO_MANY_BINDINGS" in check(doc(widget("w_text", "text", bindings=[sig()])))[1]
    many = [sig(f"b_{i}") for i in range(21)]
    assert "TOO_MANY_BINDINGS" in check(doc(widget("w_ts", "timeseries", bindings=many)))[1]
    assert check(doc(widget("w_ts", "timeseries", bindings=many[:20])))[1] == []
    # Saving a draft with fewer bindings than the minimum is allowed; publishing is not.
    normalized, errors = check(doc(widget("w_ts", "timeseries")))
    assert errors == [] and "TOO_FEW_BINDINGS" in codes(completeness_issues(normalized))


def test_document_binding_cap() -> None:
    tables = [widget(f"w_t{i}", "latest_table", bindings=[sig(f"b_{j}") for j in range(50)], y=i * 6) for i in range(8)]
    assert check(doc(*tables))[1] == []  # 400 bindings
    tables.append(widget("w_t8", "latest_table", bindings=[sig("b_0")], y=60))
    assert "LIMIT" in check(doc(*tables))[1]


def test_document_size_cap() -> None:
    big = doc(widget("w_text", "text", content="x" * 9_000))
    big["padding"] = "y" * (R.MAX_DOCUMENT_BYTES + 1)
    normalized, issues = validate_structure(big)
    assert normalized is None and codes(issues) == ["DOCUMENT_TOO_LARGE"]


def test_roles() -> None:
    actual = sig("b_a", role="actual")
    assert check(doc(widget("w_p", "progress", bindings=[actual])))[1] == []
    assert "ROLE_REQUIRED" in check(doc(widget("w_p", "progress", bindings=[sig("b_a")])))[1]
    assert "ROLE_UNKNOWN" in check(doc(widget("w_p", "progress", bindings=[sig("b_a", role="x")])))[1]
    assert "ROLE_UNKNOWN" in check(doc(widget(bindings=[sig(role="actual")])))[1]
    assert "ROLE_LIMIT" in check(doc(widget("w_p", "progress", bindings=[actual, sig("b_b", role="actual")])))[1]
    values = [sig(f"b_{i}", role="value") for i in range(7)]
    assert "ROLE_LIMIT" in check(doc(widget("w_e", "equipment", bindings=values)))[1]
    normalized, _ = check(doc(widget("w_p", "progress", bindings=[sig("b_t", role="target")])))
    assert "ROLE_MISSING" in codes(completeness_issues(normalized))
    normalized, _ = check(doc(widget("w_sc", "scatter", bindings=[sig("b_x", role="x"), sig("b_y", role="y")])))
    assert normalized["widgets"][0]["bindings"][0]["role"] == "x"


def test_binding_display_fields() -> None:
    assert "TOO_LONG" in check(doc(widget(bindings=[sig(label="x" * 121)])))[1]
    assert "TOO_LONG" in check(doc(widget(bindings=[sig(unit="x" * 25)])))[1]
    assert "INVALID_VALUE" in check(doc(widget(bindings=[sig(color="#12345")])))[1]
    assert "INVALID_VALUE" in check(doc(widget(bindings=[sig(scale=float("inf"))])))[1]
    assert "INVALID_TYPE" in check(doc(widget(bindings=[sig(scale="2")])))[1]
    ok, errors = check(doc(widget(bindings=[sig(label="Spindle", color="#AABBCC", unit="rpm", scale=2, offset=-1.5)])))
    assert errors == [] and ok["widgets"][0]["bindings"][0]["scale"] == 2.0


# ---- layout ----------------------------------------------------------------------------------------------


def test_layout_bounds() -> None:
    def lay(**cells: Any) -> list[str]:
        w = widget()
        w["layout"] = cells
        return check(doc(w))[1]

    assert lay(lg={"x": 0, "y": 0, "w": 2, "h": 2}) == []
    assert "LAYOUT" in lay(lg={"x": 0, "y": 0, "w": 1, "h": 3})  # below min width
    assert "LAYOUT" in lay(lg={"x": 0, "y": 0, "w": 3, "h": 1})  # below min height
    assert "LAYOUT" in lay(lg={"x": 10, "y": 0, "w": 3, "h": 3})  # x + w > 12
    assert "OUT_OF_RANGE" in lay(lg={"x": -1, "y": 0, "w": 3, "h": 3})
    assert "OUT_OF_RANGE" in lay(lg={"x": 0, "y": 0, "w": 3, "h": 41})
    assert "OUT_OF_RANGE" in lay(lg={"x": 0, "y": R.MAX_Y + 1, "w": 3, "h": 3})
    assert "INVALID_TYPE" in lay(lg={"x": 0.5, "y": 0, "w": 3, "h": 3})
    assert "REQUIRED" in lay(md={"x": 0, "y": 0, "w": 3, "h": 3})
    assert "LAYOUT" in lay(lg={"x": 0, "y": 0, "w": 3, "h": 3}, md={"x": 4, "y": 0, "w": 3, "h": 3})  # md has 6 columns
    # sm has one column: the minimum width is capped to the column count.
    assert lay(lg={"x": 0, "y": 0, "w": 6, "h": 6}, sm={"x": 0, "y": 0, "w": 1, "h": 6}) == []
    assert "LAYOUT" in lay(lg={"x": 0, "y": 0, "w": 3, "h": 3}, sm={"x": 0, "y": 0, "w": 2, "h": 3})


def test_custom_widget_time() -> None:
    w = widget(bindings=[sig()])
    w["time"] = {"mode": "custom", "range": {"kind": "relative", "last": "7d"}}
    assert check(doc(w))[1] == []
    w["time"] = {"mode": "custom"}
    assert "REQUIRED" in check(doc(w))[1]
    w["time"] = {"mode": "browser"}
    assert "INVALID_VALUE" in check(doc(w))[1]


# ---- options ---------------------------------------------------------------------------------------------


def test_option_types_ranges_and_choices() -> None:
    def opt(type_: str, **options: Any) -> list[str]:
        return check(doc(widget("w_x", type_, **options)))[1]

    assert opt("kpi", value_mode="median") == ["INVALID_CHOICE"]
    assert opt("kpi", decimals=9) == ["OUT_OF_RANGE"]
    assert opt("kpi", decimals=2.0) == ["INVALID_TYPE"]
    assert opt("kpi", decimals=None) == []
    assert opt("kpi", compact="yes") == ["INVALID_TYPE"]
    assert opt("kpi", prefix="x" * 25) == ["TOO_LONG"]
    assert opt("kpi", show_quality=None) == ["REQUIRED"]
    assert opt("timeseries", max_points=99) == ["OUT_OF_RANGE"]
    assert opt("timeseries", max_points=5001) == ["OUT_OF_RANGE"]
    assert opt("timeseries", y_min=10, y_max=5) == ["OUT_OF_RANGE"]
    assert opt("gauge", min=100, max=100) == ["OUT_OF_RANGE"]
    assert opt("gauge", max=float("nan")) == ["INVALID_TYPE"]
    assert opt("pie", inner_radius=91) == ["OUT_OF_RANGE"]
    assert opt("scatter", pair_tolerance_ms=600_001) == ["OUT_OF_RANGE"]
    assert opt("status", unknown_color=None) == ["REQUIRED"]
    assert opt("status", unknown_color="#xyzxyz") == ["INVALID_COLOR"]
    assert opt("kpi", background="custom", background_color="#112233") == []
    assert opt("link", page="admin") == ["INVALID_CHOICE"]
    assert opt("link", dashboard_id="not-a-uuid") == ["INVALID_REF"]
    assert opt("equipment", variable="machine") == ["VARIABLE_UNKNOWN"]
    _n, issues = validate_structure(doc(widget("w_x", "gauge", target=150)))
    assert codes(issues, "warning") == ["OUT_OF_RANGE"]


def test_thresholds_rules() -> None:
    def thr(value: Any) -> list[str]:
        return check(doc(widget(thresholds=value)))[1]

    assert thr([{"value": 10, "color": "#FF0000"}, {"value": 20.5, "color": "#00FF00", "label": "High"}]) == []
    assert thr({"value": 1}) == ["THRESHOLD_INVALID"]
    assert thr([{"value": "10", "color": "#FF0000"}]) == ["THRESHOLD_INVALID"]
    assert thr([{"value": 10, "color": "red"}]) == ["THRESHOLD_INVALID"]
    assert thr([{"value": 10, "color": "#FF0000", "label": "x" * 41}]) == ["THRESHOLD_INVALID"]
    assert thr([{"value": 10, "color": "#FF0000", "op": "gt"}]) == ["THRESHOLD_INVALID"]
    assert thr([{"value": 10, "color": "#FF0000"}, {"value": 10, "color": "#00FF00"}]) == ["THRESHOLD_INVALID"]
    assert thr([{"value": i, "color": "#FF0000"} for i in range(11)]) == ["THRESHOLD_INVALID"]
    normalized, _ = check(doc(widget(thresholds=[{"value": 1, "color": "#FF0000"}])))
    assert normalized["widgets"][0]["options"]["thresholds"] == [{"value": 1, "color": "#FF0000", "label": ""}]


def test_mappings_rules() -> None:
    def mp(value: Any) -> list[str]:
        return check(doc(widget("w_s", "status", mappings=value)))[1]

    assert mp([{"kind": "value", "value": "true", "label": "Running", "color": "#00FF00"},
               {"kind": "range", "from": None, "to": 10, "label": "Low", "color": None},
               {"kind": "range", "from": 10, "to": None, "label": "High"}]) == []
    assert mp([{"kind": "value", "value": True, "label": "x"}]) == ["MAPPING_INVALID"]  # value is the string form
    assert mp([{"kind": "value", "value": "x" * 81}]) == ["MAPPING_INVALID"]
    assert mp([{"kind": "range", "from": 10, "to": 10}]) == ["MAPPING_INVALID"]
    assert mp([{"kind": "range", "from": "a", "to": 10}]) == ["MAPPING_INVALID"]
    assert mp([{"kind": "regex", "value": ".*"}]) == ["MAPPING_INVALID"]
    assert mp([{"kind": "value", "value": "1", "expr": "x"}]) == ["MAPPING_INVALID"]
    assert mp([{"kind": "value", "value": str(i)} for i in range(31)]) == ["MAPPING_INVALID"]


def test_image_data_rules() -> None:
    def img(value: Any) -> list[str]:
        return check(doc(widget("w_i", "image", image_data=value)))[1]

    assert img(PNG) == []
    assert img(None) == []
    gif = "data:image/gif;base64," + base64.b64encode(b"GIF89a" + b"\x00" * 8).decode()
    webp = "data:image/webp;base64," + base64.b64encode(b"RIFF\x00\x00\x00\x00WEBPVP8 ").decode()
    jpeg = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 8).decode()
    assert img(gif) == [] and img(webp) == [] and img(jpeg) == []
    svg = "data:image/svg+xml;base64," + base64.b64encode(b"<svg onload='alert(1)'/>").decode()
    assert img(svg) == ["IMAGE_INVALID"]
    assert img("https://example.com/logo.png") == ["IMAGE_INVALID"]
    assert img("data:image/png;base64,!!!") == ["IMAGE_INVALID"]
    assert img("data:image/png;base64," + base64.b64encode(b"GIF89a....").decode()) == ["IMAGE_INVALID"]  # content mismatch
    assert img("data:image/png;base64," + "A" * R.MAX_IMAGE_CHARS) == ["IMAGE_TOO_LARGE"]


def test_text_links_are_restricted() -> None:
    ok = "# Title\n**bold** [docs](https://example.com) [home](/dashboards) [top](#top) <https://example.org>"
    assert check(doc(widget("w_t", "text", content=ok)))[1] == []
    for bad in ("[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](//evil.example)", "<javascript:alert(1)>"):
        assert check(doc(widget("w_t", "text", content=bad)))[1] == ["LINK_INVALID"], bad
    assert check(doc(widget("w_t", "text", content="x" * 10_001)))[1] == ["TOO_LONG"]


def test_completeness_rules() -> None:
    assert codes(completeness_issues(default_document())) == ["EMPTY_DASHBOARD"]
    normalized, _ = check(doc(widget("w_l", "link"), widget("w_e", "equipment", y=3, resource_source="variable"),
                              widget("w_r", "kpi", y=8, bindings=[{"id": "b_1", "source": {"kind": "role", "role": "main"}}])))
    found = codes(completeness_issues(normalized))
    assert found == ["LINK_TARGET_MISSING", "OPTION_MISSING", "UNBOUND"]
    normalized, _ = check(doc(widget("w_i", "image")))
    assert codes(completeness_issues(normalized), "warning") == ["IMAGE_EMPTY"]


# ---- legacy upgrade --------------------------------------------------------------------------------------


def test_legacy_draft_is_upgraded_without_losing_widgets_or_bindings() -> None:
    legacy = {"widgets": [
        {"id": "w1", "type": "kpi", "bindings": [{"signal_id": SIG}]},
        {"id": "trend", "type": "chart", "title": "Trend", "bindings": [{"signal_id": SIG}, {"model_id": MODEL, "field_path": "a/b"}]},
        {"id": "Energy-1", "type": "energy", "bindings": [{"signal_id": SIG}], "config": {"period": "day"}},
        {"id": "multi", "type": "kpi", "bindings": [{"signal_id": SIG}, {"signal_id": SIG}], "options": {"prefix": "≈", "bogus": 1}},
        "not a widget",
    ], "theme": "dark"}
    upgraded, notes = upgrade_document(copy.deepcopy(legacy))
    assert upgraded == upgrade_document(copy.deepcopy(legacy))[0]  # deterministic
    normalized, issues = validate_structure(legacy)
    assert normalized is not None, issues
    assert set(codes(issues, None)) == {"LEGACY_UPGRADED"}
    types = [(w["id"], w["type"]) for w in normalized["widgets"]]
    assert types == [("w_legacy_1", "kpi"), ("trend", "timeseries"), ("energy_1", "text"), ("multi", "latest_table")]
    assert normalized["widgets"][0]["bindings"][0]["source"] == {"kind": "signal", "signal_id": SIG}
    assert normalized["widgets"][1]["bindings"][1]["source"] == {"kind": "model_field", "model_id": MODEL, "field_path": "a/b"}
    content = normalized["widgets"][2]["options"]["content"]
    assert "energy" in content and json.dumps(SIG) in content and '"period": "day"' in content
    assert normalized["widgets"][3]["options"]["show_quality"] is True and len(normalized["widgets"][3]["bindings"]) == 2
    assert any("theme" in n for n in notes)
    for w in normalized["widgets"]:  # auto-placed inside the 12-column grid
        cell = w["layout"]["lg"]
        assert cell["x"] + cell["w"] <= 12


def test_legacy_layout_is_kept_and_clamped() -> None:
    legacy = {"widgets": [{"id": "w_a", "type": "gauge", "layout": {"x": 11, "y": 2, "w": 1, "h": 99}, "bindings": []}]}
    normalized, _issues = validate_structure(legacy)
    assert normalized["widgets"][0]["layout"]["lg"] == {"x": 10, "y": 2, "w": 2, "h": 40}


def test_v1_documents_are_not_upgraded() -> None:
    raw = {"schema_version": 1, "widgets": []}
    assert upgrade_document(raw) == (raw, [])
    assert validate_structure({})[0] == default_document()  # empty legacy draft: nothing to note
    assert validate_structure({})[1] == []
