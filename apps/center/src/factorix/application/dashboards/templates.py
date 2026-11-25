"""Dashboard templates: built-in, role-based layouts and tenant templates saved from a dashboard (contract §3, §5).

A template is a schema-v1 document whose binding sources are ``{"kind": "role", "role": "<role id>"}`` plus the
list of its *data roles*. Built-in templates contain no identifiers, no signal keys and no customer data:
the user maps every role to a real source when creating a dashboard (``role_map``). Nothing is matched by
name. Unmapped optional roles drop their binding (and a data widget left without bindings is removed);
unmapped required roles stay as role placeholders, are reported, and block publishing.
"""

from __future__ import annotations

import copy
from typing import Any

from factorix.application.dashboards import registry as R
from factorix.application.dashboards.documents import (
    default_document,
    issue,
    normalize_source,
    source_key,
    validate_structure,
)

NUMBER = ["number"]
ANY = ["any"]


def _role(role_id: str, label: str, kinds: list[str], required: bool, description: str = "") -> dict[str, Any]:
    return {"id": role_id, "label": label, "value_kinds": list(kinds), "required": required, "description": description}


def _b(binding_id: str, role: str, *, widget_role: str | None = None, label: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": binding_id, "source": {"kind": "role", "role": role}}
    if widget_role is not None:
        out["role"] = widget_role
    if label is not None:
        out["label"] = label
    return out


def _w(widget_id: str, type_: str, title: str, x: int, y: int, w: int, h: int, bindings: list[dict[str, Any]] | None = None,
       **options: Any) -> dict[str, Any]:
    return {"id": widget_id, "type": type_, "version": 1, "title": title, "layout": {"lg": {"x": x, "y": y, "w": w, "h": h}},
            "bindings": bindings or [], "options": options}


def _doc(widgets: list[dict[str, Any]], variables: list[dict[str, Any]] | None = None, **settings: Any) -> dict[str, Any]:
    doc = default_document()
    doc["variables"] = variables or []
    doc["widgets"] = widgets
    doc["settings"].update(settings)
    return doc


_MACHINE_VAR = {"id": "machine", "label": "Machine", "type": "resource", "resource_type": "machine", "default": None}

BUILTIN: tuple[dict[str, Any], ...] = (
    {
        "id": "machine_overview", "label": "Machine overview", "category": "machine",
        "description": "State, key values and trends of one machine; a Machine variable selects the machine when roles "
                       "are mapped to signal keys.",
        "roles": [
            _role("machine_state", "Machine state", ANY, False, "Run/idle/alarm state or any status value."),
            _role("main_value", "Main process value", NUMBER, True, "The value operators watch first (speed, flow, load…)."),
            _role("second_value", "Second process value", NUMBER, False),
            _role("third_value", "Third process value", NUMBER, False),
            _role("power", "Power", NUMBER, False, "Electrical power or another bounded value for the gauge."),
        ],
        "document": _doc([
            _w("w_machine", "equipment", "Machine", 0, 0, 3, 4, [
                _b("b_state", "machine_state", widget_role="status"),
                _b("b_main", "main_value", widget_role="value"),
                _b("b_second", "second_value", widget_role="value"),
            ], resource_source="variable", variable="machine"),
            _w("w_main", "kpi", "Main value", 3, 0, 3, 3, [_b("b_main", "main_value")], sparkline=True),
            _w("w_second", "kpi", "Second value", 6, 0, 3, 3, [_b("b_second", "second_value")]),
            _w("w_power", "gauge", "Power", 9, 0, 3, 4, [_b("b_power", "power")]),
            _w("w_trend", "timeseries", "Process trend", 0, 4, 8, 6, [
                _b("b_main", "main_value"), _b("b_second", "second_value"), _b("b_third", "third_value"),
            ]),
            _w("w_states", "state_timeline", "Machine state", 8, 4, 4, 6, [_b("b_state", "machine_state")]),
            _w("w_values", "latest_table", "Latest values", 0, 10, 12, 5, [
                _b("b_state", "machine_state"), _b("b_main", "main_value"), _b("b_second", "second_value"),
                _b("b_third", "third_value"), _b("b_power", "power"),
            ]),
        ], [dict(_MACHINE_VAR)]),
    },
    {
        "id": "process_trends", "label": "Process trends", "category": "trend",
        "description": "Up to four process values over time with averages, distribution and the raw rows.",
        "roles": [
            _role("trend_1", "Trend 1", NUMBER, True),
            _role("trend_2", "Trend 2", NUMBER, False),
            _role("trend_3", "Trend 3", NUMBER, False),
            _role("trend_4", "Trend 4", NUMBER, False),
        ],
        "document": _doc([
            _w("w_trend", "timeseries", "Trends", 0, 0, 12, 7, [
                _b("b_1", "trend_1"), _b("b_2", "trend_2"), _b("b_3", "trend_3"), _b("b_4", "trend_4"),
            ], legend_values="minmaxavg"),
            _w("w_avg_1", "kpi", "Trend 1 average", 0, 7, 3, 3, [_b("b_1", "trend_1")], value_mode="avg"),
            _w("w_avg_2", "kpi", "Trend 2 average", 3, 7, 3, 3, [_b("b_2", "trend_2")], value_mode="avg"),
            _w("w_dist", "histogram", "Trend 1 distribution", 6, 7, 6, 5, [_b("b_1", "trend_1")]),
            _w("w_rows", "history_table", "History", 0, 12, 12, 6, [
                _b("b_1", "trend_1"), _b("b_2", "trend_2"), _b("b_3", "trend_3"), _b("b_4", "trend_4"),
            ]),
        ], time_range={"kind": "relative", "last": "6h"}, refresh="30s"),
    },
    {
        "id": "line_status_board", "label": "Line status board", "category": "status",
        "description": "State tiles of up to four machines of a line, their state timeline and the line output.",
        "roles": [
            _role("machine_1_state", "Machine 1 state", ANY, True),
            _role("machine_2_state", "Machine 2 state", ANY, False),
            _role("machine_3_state", "Machine 3 state", ANY, False),
            _role("machine_4_state", "Machine 4 state", ANY, False),
            _role("line_output", "Line output counter", NUMBER, False, "A counter; the board shows its increase over the time range."),
        ],
        "document": _doc([
            _w("w_title", "text", "", 0, 0, 12, 1, content="## Line status", show_title=False, border=False, background="transparent"),
            _w("w_m1", "status", "Machine 1", 0, 1, 3, 2, [_b("b_1", "machine_1_state")], variant="tile"),
            _w("w_m2", "status", "Machine 2", 3, 1, 3, 2, [_b("b_2", "machine_2_state")], variant="tile"),
            _w("w_m3", "status", "Machine 3", 6, 1, 3, 2, [_b("b_3", "machine_3_state")], variant="tile"),
            _w("w_m4", "status", "Machine 4", 9, 1, 3, 2, [_b("b_4", "machine_4_state")], variant="tile"),
            _w("w_timeline", "state_timeline", "States", 0, 3, 8, 6, [
                _b("b_1", "machine_1_state"), _b("b_2", "machine_2_state"), _b("b_3", "machine_3_state"), _b("b_4", "machine_4_state"),
            ]),
            _w("w_output", "kpi", "Output in range", 8, 3, 4, 3, [_b("b_out", "line_output")], value_mode="delta", sparkline=True),
        ], time_range={"kind": "relative", "last": "12h"}),
    },
    {
        "id": "energy_monitoring", "label": "Energy monitoring", "category": "energy",
        "description": "Active power, consumed energy, power factor, voltage and current.",
        "roles": [
            _role("active_power", "Active power", NUMBER, True),
            _role("energy_counter", "Energy counter", NUMBER, False, "Cumulative energy; consumption = increase over the time range."),
            _role("power_factor", "Power factor", NUMBER, False),
            _role("voltage", "Voltage", NUMBER, False),
            _role("current", "Current", NUMBER, False),
        ],
        "document": _doc([
            _w("w_power", "kpi", "Active power", 0, 0, 3, 3, [_b("b_power", "active_power")], sparkline=True),
            _w("w_energy", "kpi", "Energy in range", 3, 0, 3, 3, [_b("b_energy", "energy_counter")], value_mode="delta"),
            _w("w_pf", "gauge", "Power factor", 6, 0, 3, 4, [_b("b_pf", "power_factor")], min=0, max=1, decimals=2),
            _w("w_vi", "bar", "Voltage and current", 9, 0, 3, 4, [_b("b_v", "voltage"), _b("b_i", "current")]),
            _w("w_trend", "timeseries", "Power trend", 0, 4, 12, 6, [_b("b_power", "active_power")], variant="area"),
            _w("w_values", "latest_table", "Latest values", 0, 10, 6, 5, [
                _b("b_power", "active_power"), _b("b_energy", "energy_counter"), _b("b_pf", "power_factor"),
                _b("b_v", "voltage"), _b("b_i", "current"),
            ]),
        ], time_range={"kind": "relative", "last": "24h"}, refresh="1m"),
    },
)

BUILTIN_BY_ID = {t["id"]: t for t in BUILTIN}


def template_item(*, template_id: str, label: str, description: str, category: str, builtin: bool,
                  roles: list[dict[str, Any]], document: dict[str, Any], created_at: Any = None) -> dict[str, Any]:
    return {
        "id": template_id, "label": label, "description": description, "category": category, "builtin": builtin,
        "roles": [{k: r.get(k) for k in ("id", "label", "value_kinds", "required", "description")} for r in roles],
        "widget_count": len(document.get("widgets") or []), "variables": copy.deepcopy(document.get("variables") or []),
        "created_at": created_at,
    }


def builtin_items() -> list[dict[str, Any]]:
    return [template_item(template_id=t["id"], label=t["label"], description=t["description"], category=t["category"],
                          builtin=True, roles=t["roles"], document=t["document"]) for t in BUILTIN]


class RoleMapError(ValueError):
    def __init__(self, issues: list[dict[str, Any]]) -> None:
        super().__init__("invalid role map")
        self.issues = issues


def instantiate(template_document: dict[str, Any], roles: list[dict[str, Any]], role_map: dict[str, Any] | None) -> dict[str, Any]:
    """The dashboard document of a template with ``role_map`` applied (see module docstring).

    Raises :class:`RoleMapError` for an unknown role or an invalid mapped source.
    """
    role_map = dict(role_map or {})
    by_id = {r["id"]: r for r in roles}
    doc = copy.deepcopy(template_document)
    variable_ids = {v.get("id") for v in doc.get("variables") or []}
    problems: list[dict[str, Any]] = []
    mapped: dict[str, dict[str, Any]] = {}
    for role_id, raw in role_map.items():
        if role_id not in by_id:
            problems.append(issue("error", "ROLE_UNKNOWN", f"'{role_id}' is not a role of this template.", path=f"role_map.{role_id}"))
            continue
        src, code, message = normalize_source(raw)
        if src is None:
            problems.append(issue("error", code or "INVALID_REF", message, path=f"role_map.{role_id}"))
        elif src["kind"] == "role":
            problems.append(issue("error", "INVALID_REF", "A role must be mapped to a signal, model field or signal key.",
                                  path=f"role_map.{role_id}"))
        elif src["kind"] == "signal_key" and src["variable"] not in variable_ids:
            problems.append(issue("error", "VARIABLE_UNKNOWN", f"Variable '{src['variable']}' is not defined by this template.",
                                  path=f"role_map.{role_id}"))
        else:
            mapped[role_id] = src
    if problems:
        raise RoleMapError(problems)
    widgets = []
    for w in doc.get("widgets") or []:
        kept = []
        dropped = 0
        for b in w.get("bindings") or []:
            src = b.get("source") or {}
            if src.get("kind") == "role":
                role_id = src.get("role")
                if role_id in mapped:
                    b = {**b, "source": dict(mapped[role_id])}
                elif not (by_id.get(role_id) or {}).get("required", True):
                    dropped += 1
                    continue
            kept.append(b)
        wt = R.widget_type(w.get("type"))
        if dropped and not kept and wt is not None and wt.min_bindings > 0:
            continue
        widgets.append({**w, "bindings": kept})
    doc["widgets"] = widgets
    return doc


def template_from_document(document: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Turn a (normalized) dashboard document into ``(template document, roles)``: every distinct source becomes a role."""
    doc = copy.deepcopy(document)
    roles: dict[str, dict[str, Any]] = {}
    by_source: dict[str, str] = {}
    for w in doc.get("widgets") or []:
        wt = R.WIDGET_TYPES[w["type"]]
        kinds = list(wt.value_kinds)
        for b in w.get("bindings") or []:
            src = b["source"]
            if src["kind"] == "role":
                role_id = src["role"]
                roles.setdefault(role_id, _role(role_id, role_id.replace("_", " ").capitalize(), ANY, True))
            else:
                key = source_key(src)
                role_id = by_source.get(key)
                if role_id is None:
                    role_id = f"r_{len(by_source) + 1}"
                    while role_id in roles:
                        role_id += "_"
                    by_source[key] = role_id
                    label = (b.get("label") or w.get("title") or f"Source {len(by_source)}")[:120]
                    roles[role_id] = _role(role_id, label, ANY, True)
                b["source"] = {"kind": "role", "role": role_id}
            role = roles[role_id]
            if "any" not in kinds:
                current = role["value_kinds"]
                role["value_kinds"] = kinds if current == ANY else [k for k in current if k in kinds] or kinds
    for v in doc.get("variables") or []:
        v["default"] = None
    return doc, list(roles.values())


def check_builtin_templates() -> list[dict[str, Any]]:
    """Structural issues of the built-in templates (used by tests and at import in debug runs)."""
    out = []
    for t in BUILTIN:
        _doc_ok, issues = validate_structure(t["document"])
        out.extend({**i, "template": t["id"]} for i in issues)
    return out
