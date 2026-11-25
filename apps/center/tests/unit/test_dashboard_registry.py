"""Widget registry vs. its own specs and vs. the contract table (``docs/architecture/contracts/dashboard.md`` §4)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from factorix.application.dashboards import registry as R
from factorix.application.dashboards.documents import validate_structure

CONTRACT = Path(__file__).resolve().parents[4] / "docs" / "architecture" / "contracts" / "dashboard.md"
COMMON_KEYS = {o.key for o in R.COMMON_OPTIONS}
DATA_KEYS = {o.key for o in R.DATA_OPTIONS}


def _contract() -> str:
    return CONTRACT.read_text(encoding="utf-8")


def _table_rows() -> dict[str, list[str]]:
    rows: dict[str, list[str]] = {}
    for line in _contract().splitlines():
        m = re.match(r"^\|\s*`([a-z_]+)`\s*\|(.*)\|\s*$", line)
        if m:
            rows[m.group(1)] = [c.strip() for c in m.group(2).split("|")]
    return rows


def _parse_default(text: str) -> Any:
    text = text.strip()
    if text.startswith('"'):
        return text[1:text.index('"', 1)]
    token = text.split()[0] if text else ""
    if token in ("true", "false"):
        return token == "true"
    if token == "null":
        return None
    if token == "[]":
        return []
    if re.fullmatch(r"-?\d+", token):
        return int(token)
    if re.fullmatch(r"-?\d+\.\d+", token):
        return float(token)
    return token


def _options_cell(cell: str) -> dict[str, tuple[Any, str]]:
    """``key -> (default, parenthesised text)`` of a "type-specific options" cell."""
    out: dict[str, tuple[Any, str]] = {}
    for segment in cell.split(" · "):
        m = re.match(r"^\s*((?:`[a-z_]+`\s*)+)=(.*)$", segment)
        assert m, f"unparseable option segment: {segment!r}"
        keys = re.findall(r"`([a-z_]+)`", m.group(1))
        rest = m.group(2).strip()
        default = _parse_default(rest)
        paren = re.search(r"\(([^()]*)\)\s*$", rest)
        for key in keys:
            out[key] = (default, paren.group(1) if paren else "")
    return out


def test_every_widget_type_is_in_the_contract_table_and_back() -> None:
    assert set(_table_rows()) == set(R.WIDGET_TYPES)


@pytest.mark.parametrize("type_key", sorted(R.WIDGET_TYPES))
def test_contract_table_matches_the_registry(type_key: str) -> None:
    wt = R.WIDGET_TYPES[type_key]
    category, bindings, history, options = _table_rows()[type_key]
    assert category == wt.category
    assert history == wt.history
    listed = _options_cell(options)
    specific = {o.key for o in wt.options}
    # Every type-specific registry option is listed; listed keys are type-specific or (marked) common ones.
    assert specific <= set(listed), specific - set(listed)
    assert set(listed) - specific <= COMMON_KEYS | DATA_KEYS
    for key, (default, paren) in listed.items():
        spec = wt.option(key)
        assert spec is not None, key
        if key in specific:
            assert spec.default == default, (key, spec.default, default)
        rng = re.search(r"(-?\d+)\.\.(-?\d+)", paren)
        if rng and spec.type in ("integer", "number"):
            assert (spec.min, spec.max) == (int(rng.group(1)), int(rng.group(2))), key
        words = paren.split()
        if spec.type == "enum" and len(words) >= 2 and all(re.fullmatch(r"[a-z_]+", w) for w in words):
            assert tuple(words) == spec.choices, key
    # Binding counts / roles.
    m = re.match(r"^(\d+)(?:\.\.(\d+))?(?:,|$)", bindings)
    if wt.roles is None:
        assert m, bindings
        lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
        assert (wt.min_bindings, wt.max_bindings) == (lo, hi)
    else:
        assert bindings.startswith("roles"), bindings
        listed_roles = re.findall(r"\b([a-z_]+) (?:\((req|opt)\)|×(\d+)\.\.(\d+))", bindings)
        assert [r[0] for r in listed_roles] == [r.id for r in wt.roles]
        for (rid, req, _lo, hi), role in zip(listed_roles, wt.roles, strict=True):
            assert role.id == rid
            if req:
                assert role.required == (req == "req")
            else:
                assert not role.required and role.max == int(hi)


def test_common_options_paragraphs_match() -> None:
    text = _contract()
    common = re.search(r"\*\*Common options \(every type\):\*\*(.*?)\n\n", text, re.S).group(1)
    data = re.search(r"\*\*Common data-widget options\*\*(.*?)\n\n", text, re.S).group(1)
    assert set(re.findall(r"`([a-z_]+)` \(", common)) == COMMON_KEYS
    assert set(re.findall(r"`([a-z_]+)` \(", data)) == DATA_KEYS


def test_sizes_line_matches() -> None:
    text = _contract()
    sizes = {m[0]: ((int(m[1]), int(m[2])), (int(m[3]), int(m[4])))
             for m in re.findall(r"\b([a-z_]+) (\d+)×(\d+) \((?:min )?(\d+)×(\d+)\)", text)}
    assert set(sizes) == set(R.WIDGET_TYPES)
    for key, (default, minimum) in sizes.items():
        wt = R.WIDGET_TYPES[key]
        assert (wt.default_size, wt.min_size) == (default, minimum), key


@pytest.mark.parametrize("type_key", sorted(R.WIDGET_TYPES))
def test_every_default_passes_its_own_spec(type_key: str) -> None:
    wt = R.WIDGET_TYPES[type_key]
    for spec in wt.all_options:
        assert spec.group in R.OPTION_GROUPS and spec.type in R.OPTION_TYPES, spec
        if spec.type == "variable_ref":
            assert spec.default is None and spec.nullable
            continue
        assert R.validate_option(spec, spec.default) == spec.default, spec.key
    normalized, problems = R.normalize_options(wt, {})
    assert normalized == R.default_options(wt)
    assert [p for p in problems if p[0] == "error"] == []
    # A widget made only of defaults is a valid document.
    w = {"id": "w_default", "type": type_key, "layout": {"lg": {"x": 0, "y": 0, "w": wt.default_size[0], "h": wt.default_size[1]},
                                                         "md": {"x": 0, "y": 0, "w": min(wt.default_size[0], 6), "h": wt.min_size[1]},
                                                         "sm": {"x": 0, "y": 0, "w": 1, "h": wt.min_size[1]}}}
    doc, issues = validate_structure({"schema_version": 1, "widgets": [w]})
    assert doc is not None, issues


@pytest.mark.parametrize("type_key", sorted(R.WIDGET_TYPES))
def test_type_shape(type_key: str) -> None:
    wt = R.WIDGET_TYPES[type_key]
    assert set(wt.value_kinds) <= set(R.VALUE_KINDS)
    assert wt.history in ("none", "optional", "required")
    assert 1 <= wt.min_size[0] <= wt.default_size[0] <= 12 and 1 <= wt.min_size[1] <= wt.default_size[1] <= R.MAX_WIDGET_HEIGHT
    assert 0 <= wt.min_bindings <= wt.max_bindings
    if wt.max_bindings == 0:
        assert wt.value_kinds == () and wt.history == "none"
        assert not (DATA_KEYS & {o.key for o in wt.all_options})
    else:
        assert DATA_KEYS <= {o.key for o in wt.all_options}
    assert COMMON_KEYS <= {o.key for o in wt.all_options}
    if wt.roles is not None:
        assert wt.max_bindings == sum(r.max for r in wt.roles)
        assert wt.min_bindings == sum(1 for r in wt.roles if r.required)
    for spec in wt.all_options:
        if spec.show_if:
            assert wt.option(spec.show_if["key"]) is not None, spec.key
            target = wt.option(spec.show_if["key"])
            allowed = {True, False} if target.type == "boolean" else set(target.choices or ())
            assert set(spec.show_if["in"]) <= allowed, spec.key


def test_payloads_are_json_and_complete() -> None:
    payload = R.widget_types_payload()
    json.dumps(payload)
    assert payload["schema_version"] == 1
    limits = payload["limits"]
    assert limits["max_widgets"] == 40 and limits["max_series_per_query"] == 20 and limits["default_max_points"] == 1500
    assert limits["max_points"] == 5000 and limits["max_window_days"] == 366 and limits["max_resolve_refs"] == 400
    assert limits["max_document_bytes"] == 1_500_000
    kpi = next(t for t in payload["widget_types"] if t["type"] == "kpi")
    assert kpi["data"] == {"min_bindings": 1, "max_bindings": 1, "value_kinds": ["number", "any"], "history": "optional", "roles": None}
    assert kpi["default_size"] == {"w": 3, "h": 3} and kpi["min_size"] == {"w": 2, "h": 2}
    bg = next(o for o in kpi["options"] if o["key"] == "background_color")
    assert bg["show_if"] == {"key": "background", "in": ["custom"]} and bg["nullable"] is True
    themes = R.themes_payload()["items"]
    assert [t["id"] for t in themes] == list(R.THEME_PRESETS)
    token_keys = {"canvas", "surface", "surface_alt", "text", "text_muted", "border", "accent", "good", "warning", "bad", "stale",
                  "palette", "chart_grid", "chart_axis", "radius", "gap", "font_scale", "dark"}
    for theme in themes:
        tokens = theme["tokens"]
        assert set(tokens) == token_keys
        assert len(tokens["palette"]) == 8 and all(R.is_color(c) for c in tokens["palette"])
        assert all(R.is_color(tokens[k]) for k in token_keys - {"palette", "radius", "gap", "font_scale", "dark"})
    light = themes[0]["tokens"]
    assert (light["canvas"], light["surface"], light["text"], light["accent"]) == ("#F6F8FC", "#FFFFFF", "#111B37", "#2A82E7")
    for theme in themes:  # accent = default data fill and series 1; red/amber/green/grey stay status colors
        tokens = theme["tokens"]
        assert tokens["accent"] == tokens["palette"][0]
        assert tokens["accent"] not in (tokens["bad"], tokens["warning"], tokens["good"], tokens["stale"], "#EF1B24")
        assert "#EF1B24" not in tokens["palette"]
    assert themes[1]["tokens"]["dark"] is True
    # The payload is a copy: mutating it never changes the registry.
    payload["widget_types"][0]["options"][0]["default"] = "changed"
    assert R.widget_types_payload()["widget_types"][0]["options"][0]["default"] != "changed"


def test_contract_limits_line_matches() -> None:
    text = _contract()
    assert "40 widgets" in text and "400 resolve refs per call" in text and "1.5 MB document" in text
    assert f"{R.MAX_BINDINGS_PER_DOCUMENT} bindings per document" in text


def test_dependent_options_are_hidden_when_they_have_no_effect() -> None:
    from factorix.application.dashboards import registry as R

    types = {t["type"]: t for t in R.widget_types_payload()["widget_types"]}
    pie = {o["key"]: o for o in types["pie"]["options"]}
    ts = {o["key"]: o for o in types["timeseries"]["options"]}
    assert pie["inner_radius"]["show_if"] == {"key": "doughnut", "in": [True]}
    assert ts["legend_values"]["show_if"] == {"key": "legend", "in": ["top", "bottom", "right"]}
