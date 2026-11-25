"""Widget registry, option specs, theme presets and limits of the Dashboard Studio (contract ``dashboard.md`` §4).

The registry is the single source of truth for widget types: the API validates ``options`` with it
(:func:`normalize_options`) and the Studio renders its inspector from :func:`widget_types_payload`.
Every option has a spec (type, default, bounds, choices); unknown keys are rejected and missing keys are
filled from the defaults. Nothing here touches the database.
"""

from __future__ import annotations

import base64
import binascii
import math
import re
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from factorix.modules.historian_service import DEFAULT_MAX_POINTS, MAX_SERIES

SCHEMA_VERSION = 1

#: Grid columns per breakpoint (lg = 12, md = 6, sm = 1).
COLUMNS = {"lg": 12, "md": 6, "sm": 1}
MAX_WIDGET_HEIGHT = 40
MAX_Y = 2000
MAX_WIDGETS = 40
MAX_VARIABLES = 10
MAX_BINDINGS_PER_DOCUMENT = 400
MAX_RESOLVE_REFS = 400
MAX_DOCUMENT_BYTES = 1_500_000
MAX_POINTS = 5000
MAX_WINDOW_DAYS = 366
MAX_THRESHOLDS = 10
MAX_MAPPINGS = 30
MAX_IMAGE_CHARS = 400_000

LIMITS: dict[str, Any] = {
    "max_widgets": MAX_WIDGETS,
    "max_variables": MAX_VARIABLES,
    "max_bindings_per_document": MAX_BINDINGS_PER_DOCUMENT,
    "max_series_per_query": MAX_SERIES,
    "default_max_points": DEFAULT_MAX_POINTS,
    "max_points": MAX_POINTS,
    "max_window_days": MAX_WINDOW_DAYS,
    "max_resolve_refs": MAX_RESOLVE_REFS,
    "max_document_bytes": MAX_DOCUMENT_BYTES,
    "max_widget_height": MAX_WIDGET_HEIGHT,
    "max_y": MAX_Y,
    "columns": dict(COLUMNS),
    "row_height": {"min": 24, "max": 96, "default": 40},
    "max_thresholds": MAX_THRESHOLDS,
    "max_mappings": MAX_MAPPINGS,
    "max_image_chars": MAX_IMAGE_CHARS,
}

RELATIVE_RANGES = ("5m", "15m", "30m", "1h", "3h", "6h", "12h", "24h", "2d", "7d", "30d")
REFRESH_CHOICES = ("live", "10s", "30s", "1m", "5m", "off")
THEME_PRESETS = ("factorix_light", "control_room_dark", "industrial_neutral")
PAGES = ("overview", "factory_structure", "factory_graph", "connections", "signals", "models", "storage", "historian")
VALUE_KINDS = ("number", "boolean", "string", "any")
OPTION_GROUPS = ("general", "data", "display", "thresholds", "style")
OPTION_TYPES = (
    "boolean", "integer", "number", "string", "text", "color", "enum", "thresholds", "mappings", "image",
    "dashboard_ref", "page_ref", "resource_ref", "variable_ref",
)

COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_IMAGE_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$")
_VARIABLE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_MD_LINK_RE = re.compile(r"\]\(\s*<?([^)\s>]*)")
_MD_AUTOLINK_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*)>")
_SAFE_LINK_RE = re.compile(r"^(https?://|/(?!/)|#)", re.IGNORECASE)


# ---------------------------------------------------------------------------------------------------------
# Specs
# ---------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class OptionSpec:
    key: str
    label: str
    group: str
    type: str
    default: Any
    min: float | None = None
    max: float | None = None
    choices: tuple[Any, ...] | None = None
    max_length: int | None = None
    help: str | None = None
    show_if: dict[str, Any] | None = None
    nullable: bool = False

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "key": self.key, "label": self.label, "group": self.group, "type": self.type,
            "default": _copy(self.default), "nullable": self.nullable,
        }
        for name in ("min", "max", "max_length", "help"):
            value = getattr(self, name)
            if value is not None:
                out[name] = value
        if self.choices is not None:
            out["choices"] = list(self.choices)
        if self.show_if is not None:
            out["show_if"] = {"key": self.show_if["key"], "in": list(self.show_if["in"])}
        return out


@dataclass(frozen=True)
class RoleSpec:
    id: str
    label: str
    required: bool
    max: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "required": self.required, "max": self.max}


@dataclass(frozen=True)
class WidgetType:
    type: str
    label: str
    category: str
    description: str
    icon: str
    default_size: tuple[int, int]
    min_size: tuple[int, int]
    min_bindings: int
    max_bindings: int
    value_kinds: tuple[str, ...]
    history: str
    options: tuple[OptionSpec, ...] = ()
    roles: tuple[RoleSpec, ...] | None = None
    version: int = 1
    all_options: tuple[OptionSpec, ...] = field(default=(), compare=False)

    @property
    def is_data(self) -> bool:
        return self.max_bindings > 0

    def option(self, key: str) -> OptionSpec | None:
        for spec in self.all_options:
            if spec.key == key:
                return spec
        return None

    def role(self, role_id: str | None) -> RoleSpec | None:
        for role in self.roles or ():
            if role.id == role_id:
                return role
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type, "version": self.version, "label": self.label, "category": self.category,
            "description": self.description, "icon": self.icon,
            "default_size": {"w": self.default_size[0], "h": self.default_size[1]},
            "min_size": {"w": self.min_size[0], "h": self.min_size[1]},
            "data": {
                "min_bindings": self.min_bindings, "max_bindings": self.max_bindings,
                "value_kinds": list(self.value_kinds), "history": self.history,
                "roles": [r.to_dict() for r in self.roles] if self.roles is not None else None,
            },
            "options": [o.to_dict() for o in self.all_options],
        }


def _copy(value: Any) -> Any:
    if isinstance(value, list):
        return [_copy(v) for v in value]
    if isinstance(value, dict):
        return {k: _copy(v) for k, v in value.items()}
    return value


# Small constructors keep the table below readable.
def _bool(key: str, label: str, default: bool, group: str = "display", **kw: Any) -> OptionSpec:
    return OptionSpec(key, label, group, "boolean", default, **kw)


def _enum(key: str, label: str, choices: tuple[str, ...], default: str, group: str = "display", **kw: Any) -> OptionSpec:
    assert default in choices
    return OptionSpec(key, label, group, "enum", default, choices=choices, **kw)


def _int(key: str, label: str, default: int | None, lo: int, hi: int, group: str = "display", **kw: Any) -> OptionSpec:
    return OptionSpec(key, label, group, "integer", default, min=lo, max=hi, nullable=default is None, **kw)


def _num(key: str, label: str, default: float | None, group: str = "display", lo: float | None = None,
         hi: float | None = None, **kw: Any) -> OptionSpec:
    return OptionSpec(key, label, group, "number", default, min=lo, max=hi, nullable=default is None, **kw)


def _str(key: str, label: str, default: str, max_length: int, group: str = "display", **kw: Any) -> OptionSpec:
    return OptionSpec(key, label, group, "string", default, max_length=max_length, **kw)


def _color(key: str, label: str, default: str | None, group: str = "style", **kw: Any) -> OptionSpec:
    return OptionSpec(key, label, group, "color", default, nullable=default is None, **kw)


def _thresholds(help_text: str = "A value ≥ threshold takes its color; the highest matching threshold wins.") -> OptionSpec:
    return OptionSpec("thresholds", "Thresholds", "thresholds", "thresholds", [], help=help_text)


def _mappings() -> OptionSpec:
    return OptionSpec("mappings", "Value mappings", "thresholds", "mappings", [],
                      help="Map a value or a numeric range to a label and a color.")


def _ref(key: str, label: str, kind: str, group: str = "data", **kw: Any) -> OptionSpec:
    return OptionSpec(key, label, group, kind, None, nullable=True, **kw)


_VALUE_MODES = ("latest", "min", "max", "avg", "sum", "count", "delta", "first")
_HISTORY_MODE = _enum("history_mode", "History mode", ("operational", "recorded"), "operational", "data",
                      help="operational = every acquired sample; recorded = rows of a managed recording.")
_MAX_POINTS = _int("max_points", "Max points", DEFAULT_MAX_POINTS, 100, MAX_POINTS, "data")
_FONT_SIZES = ("sm", "md", "lg", "xl")

COMMON_OPTIONS: tuple[OptionSpec, ...] = (
    _bool("show_title", "Show title", True, "general"),
    _str("description", "Description", "", 300, "general", help="Shown as a tooltip on the title."),
    _enum("background", "Background", ("inherit", "transparent", "custom"), "inherit", "style"),
    _color("background_color", "Background color", None, show_if={"key": "background", "in": ["custom"]}),
    _color("accent_color", "Accent color", None),
    _bool("border", "Border", True, "style"),
    _enum("padding", "Padding", ("compact", "normal", "roomy"), "normal", "style"),
    _enum("title_align", "Title alignment", ("left", "center"), "left", "style"),
)

DATA_OPTIONS: tuple[OptionSpec, ...] = (
    _int("decimals", "Decimals", None, 0, 8, help="Empty = automatic."),
    _bool("show_quality", "Show quality", True),
)


def _wt(type_: str, label: str, category: str, description: str, icon: str, size: tuple[int, int], min_size: tuple[int, int],
        bindings: tuple[int, int], kinds: tuple[str, ...], history: str, options: tuple[OptionSpec, ...],
        roles: tuple[RoleSpec, ...] | None = None) -> WidgetType:
    base = WidgetType(type_, label, category, description, icon, size, min_size, bindings[0], bindings[1], kinds, history,
                      options, roles)
    shared = COMMON_OPTIONS + (DATA_OPTIONS if base.is_data else ())
    keys = [o.key for o in shared + options]
    assert len(keys) == len(set(keys)), f"duplicate option key in {type_}"
    object.__setattr__(base, "all_options", shared + options)
    return base


_TYPES: tuple[WidgetType, ...] = (
    _wt("kpi", "Value", "value", "One value with optional reduction over the time range, sparkline and thresholds.", "gauge",
        (3, 3), (2, 2), (1, 1), ("number", "any"), "optional", (
            _enum("value_mode", "Value", _VALUE_MODES, "latest", "data",
                  help="Anything but latest reduces the Historian points of the widget time range."),
            _str("prefix", "Prefix", "", 24),
            _str("suffix", "Suffix", "", 24),
            _bool("show_unit", "Show unit", True),
            _bool("compact", "Compact numbers", False),
            _bool("sparkline", "Sparkline", False),
            _enum("color_mode", "Color mode", ("value", "background", "none"), "value"),
            _enum("font_size", "Font size", _FONT_SIZES, "lg"),
            _enum("icon", "Icon", ("none", "activity", "gauge", "thermometer", "zap", "droplet", "fan", "cpu", "factory"), "none"),
            _str("null_text", "Text when no value", "—", 24),
            _thresholds(),
        )),
    _wt("gauge", "Gauge", "value", "Radial, semicircle or bar gauge of a numeric value.", "circle-gauge",
        (3, 4), (2, 3), (1, 1), ("number",), "none", (
            _enum("variant", "Variant", ("radial", "semicircle", "horizontal", "vertical"), "radial"),
            _num("min", "Minimum", 0, "data"),
            _num("max", "Maximum", 100, "data"),
            _num("target", "Target", None, "data"),
            _bool("show_value", "Show value", True),
            _bool("show_ticks", "Show ticks", True),
            _thresholds(),
        )),
    _wt("progress", "Progress", "value", "Actual against a target (binding or fixed value).", "percent",
        (3, 2), (2, 2), (1, 2), ("number",), "none", (
            _num("target_value", "Target value", 100, "data", help="Used when there is no target binding."),
            _num("min", "Minimum", 0, "data"),
            _enum("direction", "Direction", ("horizontal", "vertical"), "horizontal"),
            _bool("show_percent", "Show percent", True),
            _bool("show_values", "Show values", True),
            _thresholds("Applied to the percent of the target."),
        ), roles=(RoleSpec("actual", "Actual", True), RoleSpec("target", "Target", False))),
    _wt("status", "Status", "status", "State indicator with value mappings.", "circle-dot",
        (3, 2), (2, 2), (1, 1), ("any",), "none", (
            _enum("variant", "Variant", ("led", "pill", "tile", "text"), "pill"),
            _mappings(),
            _bool("show_raw", "Show raw value", False),
            _bool("show_time", "Show time", True),
            _str("unknown_label", "Unknown label", "Unknown", 40),
            _color("unknown_color", "Unknown color", "#94A3B8"),
            _enum("blink", "Blink", ("off", "slow"), "off"),
        )),
    _wt("timeseries", "Time series", "trend", "Line, area, step or bar chart of up to 20 series from the Historian.", "chart-line",
        (6, 6), (3, 4), (1, MAX_SERIES), ("number",), "required", (
            _enum("variant", "Variant", ("line", "area", "step", "bar"), "line"),
            _bool("smooth", "Smooth", False),
            _bool("show_points", "Show points", False),
            _bool("stack", "Stack", False),
            _enum("legend", "Legend", ("top", "bottom", "right", "hidden"), "bottom"),
            _enum("legend_values", "Legend values", ("none", "last", "minmaxavg"), "none",
                  show_if={"key": "legend", "in": ["top", "bottom", "right"]}),
            _num("y_min", "Y min", None),
            _num("y_max", "Y max", None),
            _bool("split_axes_by_unit", "One axis per unit", True),
            _thresholds(),
            _bool("live_append", "Append live values", True, "data"),
            _HISTORY_MODE,
            _enum("resolution", "Resolution", ("auto", "raw"), "auto", "data"),
            _MAX_POINTS,
            _bool("quality_marks", "Quality marks", True),
            _bool("zoom", "Zoom", True),
        )),
    _wt("state_timeline", "State timeline", "trend", "States over time, one lane per series.", "chart-gantt",
        (6, 4), (3, 3), (1, 10), ("any",), "required", (
            _mappings(),
            _bool("show_values", "Show values", True),
            _HISTORY_MODE,
            _MAX_POINTS,
        )),
    _wt("bar", "Bar chart", "compare", "Compare up to 20 values (latest or reduced over the time range).", "chart-column",
        (4, 5), (3, 3), (1, MAX_SERIES), ("number",), "optional", (
            _enum("value_mode", "Value", _VALUE_MODES, "latest", "data"),
            _enum("orientation", "Orientation", ("vertical", "horizontal"), "vertical"),
            _enum("sort", "Sort", ("none", "asc", "desc"), "none"),
            _bool("show_labels", "Show labels", True),
            _num("y_min", "Axis min", None),
            _num("y_max", "Axis max", None),
            _thresholds(),
        )),
    _wt("pie", "Pie chart", "compare", "Share of up to 12 values.", "chart-pie",
        (4, 5), (3, 4), (1, 12), ("number",), "optional", (
            _enum("value_mode", "Value", _VALUE_MODES, "latest", "data"),
            _bool("doughnut", "Doughnut", True),
            _int("inner_radius", "Inner radius (%)", 55, 0, 90, show_if={"key": "doughnut", "in": [True]}),
            _enum("label", "Slice label", ("percent", "value", "name", "none"), "percent"),
            _enum("legend", "Legend", ("right", "bottom", "hidden"), "right"),
            _bool("show_total", "Show total", True),
        )),
    _wt("histogram", "Histogram", "distribution", "Distribution of one series over the time range.", "chart-column-big",
        (4, 5), (3, 3), (1, 1), ("number",), "required", (
            _int("bin_count", "Bins", 0, 0, 100, "data", help="0 = automatic."),
            _bool("show_mean", "Show mean", True),
            _bool("show_median", "Show median", False),
            _HISTORY_MODE,
            _MAX_POINTS,
        )),
    _wt("scatter", "XY scatter", "distribution", "One series against another, paired by timestamp.", "chart-scatter",
        (4, 5), (3, 4), (2, 2), ("number",), "required", (
            _int("pair_tolerance_ms", "Pairing tolerance (ms)", 1000, 0, 600_000, "data"),
            _int("point_size", "Point size", 6, 2, 20),
            _num("x_min", "X min", None),
            _num("x_max", "X max", None),
            _num("y_min", "Y min", None),
            _num("y_max", "Y max", None),
            _HISTORY_MODE,
            _MAX_POINTS,
        ), roles=(RoleSpec("x", "X axis", True), RoleSpec("y", "Y axis", True))),
    _wt("latest_table", "Latest values", "table", "Latest value, quality and freshness of up to 50 sources.", "table",
        (4, 6), (3, 3), (1, 50), ("any",), "none", (
            _bool("show_resource", "Show resource", True),
            _bool("show_unit", "Show unit", True),
            _bool("show_freshness", "Show freshness", True),
            _bool("show_time", "Show time", True),
            _enum("sort", "Sort", ("none", "label", "value"), "none"),
            _enum("density", "Density", ("compact", "normal"), "normal"),
            _thresholds(),
            _mappings(),
        )),
    _wt("history_table", "History table", "table", "Historian rows of up to 10 series.", "table-2",
        (6, 6), (3, 4), (1, 10), ("any",), "required", (
            _int("page_size", "Rows per page", 25, 10, 200),
            _enum("order", "Order", ("newest", "oldest"), "newest"),
            _HISTORY_MODE,
            _MAX_POINTS,
        )),
    _wt("equipment", "Equipment", "industrial", "Resource tile: status and up to 6 values.", "factory",
        (3, 4), (2, 3), (0, 7), ("any",), "none", (
            _enum("resource_source", "Resource", ("fixed", "variable"), "fixed", "data"),
            _ref("resource_id", "Resource", "resource_ref", show_if={"key": "resource_source", "in": ["fixed"]}),
            _ref("variable", "Variable", "variable_ref", show_if={"key": "resource_source", "in": ["variable"]}),
            _mappings(),
            _bool("show_time", "Show time", True),
            _enum("layout", "Layout", ("compact", "standard"), "standard"),
            _ref("link_dashboard_id", "Open dashboard", "dashboard_ref", "general"),
        ), roles=(RoleSpec("status", "Status", False), RoleSpec("value", "Value", False, max=6))),
    _wt("text", "Text", "content", "Markdown subset: headings, bold, italic, lists, code, links.", "type",
        (4, 2), (1, 1), (0, 0), (), "none", (
            OptionSpec("content", "Content", "general", "text", "", max_length=10_000,
                       help="Links may point to http(s) URLs or internal paths only."),
            _enum("font_size", "Font size", _FONT_SIZES, "md"),
            _enum("align", "Alignment", ("left", "center", "right"), "left"),
            _color("text_color", "Text color", None),
        )),
    _wt("image", "Image", "content", "Embedded PNG/JPEG/WebP/GIF image (no SVG, no remote URL).", "image",
        (3, 3), (1, 1), (0, 0), (), "none", (
            OptionSpec("image_data", "Image", "general", "image", None, nullable=True,
                       help="data:image/(png|jpeg|webp|gif);base64,… at most 400 000 characters."),
            _enum("fit", "Fit", ("contain", "cover", "fill"), "contain"),
            _str("alt", "Alternative text", "", 300, "general"),
        )),
    _wt("divider", "Divider", "content", "Horizontal or vertical separator with an optional label.", "minus",
        (12, 1), (1, 1), (0, 0), (), "none", (
            _str("label", "Label", "", 80, "general"),
            _enum("orientation", "Orientation", ("horizontal", "vertical"), "horizontal"),
            _int("thickness", "Thickness", 1, 1, 8),
            _enum("line_style", "Line style", ("solid", "dashed"), "solid"),
            _color("color", "Color", None),
        )),
    _wt("link", "Link", "content", "Navigate to another dashboard or a FactoriX page.", "link",
        (2, 1), (1, 1), (0, 0), (), "none", (
            _enum("target_type", "Target", ("dashboard", "page"), "dashboard", "general"),
            _ref("dashboard_id", "Dashboard", "dashboard_ref", "general", show_if={"key": "target_type", "in": ["dashboard"]}),
            OptionSpec("page", "Page", "general", "page_ref", "overview", show_if={"key": "target_type", "in": ["page"]}),
            _str("label", "Label", "Open", 40, "general"),
            _bool("carry_variables", "Carry variables", True, "general"),
            _enum("style", "Style", ("button", "card", "text"), "button"),
        )),
)

WIDGET_TYPES: dict[str, WidgetType] = {t.type: t for t in _TYPES}


def widget_type(type_key: Any) -> WidgetType | None:
    return WIDGET_TYPES.get(type_key) if isinstance(type_key, str) else None


def widget_types_payload() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "widget_types": [t.to_dict() for t in _TYPES],
        "limits": _copy(LIMITS),
        "enums": {
            "relative_ranges": list(RELATIVE_RANGES), "refresh": list(REFRESH_CHOICES),
            "theme_presets": list(THEME_PRESETS), "pages": list(PAGES), "value_kinds": list(VALUE_KINDS),
            "option_groups": list(OPTION_GROUPS), "option_types": list(OPTION_TYPES),
        },
    }


# ---------------------------------------------------------------------------------------------------------
# Theme presets (design tokens; no CSS)
# ---------------------------------------------------------------------------------------------------------

THEMES: tuple[dict[str, Any], ...] = (
    {
        "id": "factorix_light", "label": "FactoriX Light",
        "description": "The FactoriX application palette on a light canvas.",
        "tokens": {
            "canvas": "#F6F8FC", "surface": "#FFFFFF", "surface_alt": "#F9FAFD", "text": "#111B37",
            "text_muted": "#657794", "border": "#E3EAF3", "accent": "#2A82E7", "good": "#0DBA67",
            "warning": "#FFAA23", "bad": "#F2343B", "stale": "#94A3B8",
            "palette": ["#2A82E7", "#21B5AE", "#8858EA", "#FFAA23", "#0DBA67", "#D9468F", "#334568", "#94A3B8"],
            "chart_grid": "#E3EAF3", "chart_axis": "#657794", "radius": 12, "gap": 12, "font_scale": 1.0, "dark": False,
        },
    },
    {
        "id": "control_room_dark", "label": "Control Room Dark",
        "description": "Low-glare dark theme for wall displays and control rooms.",
        "tokens": {
            "canvas": "#0B1220", "surface": "#111A2E", "surface_alt": "#18233B", "text": "#E6ECF5",
            "text_muted": "#8FA0BC", "border": "#24314D", "accent": "#3B9EFF", "good": "#22C55E",
            "warning": "#F5B638", "bad": "#F25560", "stale": "#64748B",
            "palette": ["#3B9EFF", "#2DD4BF", "#A78BFA", "#F5B638", "#22C55E", "#F472B6", "#F97316", "#94A3B8"],
            "chart_grid": "#1F2A44", "chart_axis": "#8FA0BC", "radius": 10, "gap": 10, "font_scale": 1.0, "dark": True,
        },
    },
    {
        "id": "industrial_neutral", "label": "Industrial Neutral",
        "description": "Neutral greys with restrained accents for dense engineering screens.",
        "tokens": {
            "canvas": "#EEF0F2", "surface": "#FFFFFF", "surface_alt": "#F5F6F7", "text": "#1F2933",
            "text_muted": "#616E7C", "border": "#D9DEE3", "accent": "#1F6FB2", "good": "#2F9E44",
            "warning": "#E8A317", "bad": "#D64545", "stale": "#9AA5B1",
            "palette": ["#1F6FB2", "#2F9E44", "#E8A317", "#7B5EA7", "#0F9D9A", "#D64545", "#52606D", "#B07A3F"],
            "chart_grid": "#E4E7EB", "chart_axis": "#616E7C", "radius": 6, "gap": 8, "font_scale": 1.0, "dark": False,
        },
    },
)

assert tuple(t["id"] for t in THEMES) == THEME_PRESETS
# ``accent`` is the default data fill (bars, gauges, progress, series 1): never an alarm color.
assert all(t["tokens"]["accent"] == t["tokens"]["palette"][0] != t["tokens"]["bad"] for t in THEMES)


def themes_payload() -> dict[str, Any]:
    return {"items": _copy(list(THEMES))}


# ---------------------------------------------------------------------------------------------------------
# Option validation
# ---------------------------------------------------------------------------------------------------------


class OptionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def is_color(value: Any) -> bool:
    return isinstance(value, str) and bool(COLOR_RE.match(value))


def canonical_uuid(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


_IMAGE_MAGIC = {
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpeg": (b"\xff\xd8\xff",),
    "gif": (b"GIF87a", b"GIF89a"),
}


def check_image(value: str) -> None:
    """Raise :class:`OptionError` unless ``value`` is a bounded base64 data URL of a raster image."""
    if len(value) > MAX_IMAGE_CHARS:
        raise OptionError("IMAGE_TOO_LARGE", f"The image is larger than {MAX_IMAGE_CHARS} characters.")
    match = _IMAGE_RE.match(value)
    if not match:
        raise OptionError("IMAGE_INVALID", "Only data:image/(png|jpeg|webp|gif);base64 images are accepted (no SVG, no URL).")
    kind, payload = match.group(1), match.group(2)
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise OptionError("IMAGE_INVALID", "The image is not valid base64.") from None
    if kind == "webp":
        ok = len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    else:
        ok = any(raw.startswith(m) for m in _IMAGE_MAGIC[kind])
    if not ok:
        raise OptionError("IMAGE_INVALID", f"The image content is not {kind.upper()}.")


def unsafe_links(content: str) -> list[str]:
    """Markdown link targets that are neither http(s) URLs nor internal paths (``/…``, ``#…``)."""
    targets = [m.group(1) for m in _MD_LINK_RE.finditer(content)] + [m.group(1) for m in _MD_AUTOLINK_RE.finditer(content)]
    return [t for t in targets if t and not _SAFE_LINK_RE.match(t)]


def _check_range(spec: OptionSpec, value: float) -> None:
    if spec.min is not None and value < spec.min:
        raise OptionError("OUT_OF_RANGE", f"Must be ≥ {spec.min}.")
    if spec.max is not None and value > spec.max:
        raise OptionError("OUT_OF_RANGE", f"Must be ≤ {spec.max}.")


def _thresholds_value(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise OptionError("THRESHOLD_INVALID", "Thresholds must be a list.")
    if len(value) > MAX_THRESHOLDS:
        raise OptionError("THRESHOLD_INVALID", f"At most {MAX_THRESHOLDS} thresholds.")
    out = []
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            raise OptionError("THRESHOLD_INVALID", f"Threshold {i + 1} must be an object.")
        extra = set(item) - {"value", "color", "label"}
        if extra:
            raise OptionError("THRESHOLD_INVALID", f"Threshold {i + 1}: unknown key(s) {', '.join(sorted(extra))}.")
        if not is_number(item.get("value")):
            raise OptionError("THRESHOLD_INVALID", f"Threshold {i + 1}: value must be a finite number.")
        if not is_color(item.get("color")):
            raise OptionError("THRESHOLD_INVALID", f"Threshold {i + 1}: color must be #RRGGBB.")
        label = item.get("label", "")
        if not isinstance(label, str) or len(label) > 40:
            raise OptionError("THRESHOLD_INVALID", f"Threshold {i + 1}: label must be a string of at most 40 characters.")
        out.append({"value": item["value"], "color": item["color"], "label": label})
    values = [t["value"] for t in out]
    if len(values) != len(set(values)):
        raise OptionError("THRESHOLD_INVALID", "Two thresholds have the same value.")
    return out


def _mappings_value(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise OptionError("MAPPING_INVALID", "Mappings must be a list.")
    if len(value) > MAX_MAPPINGS:
        raise OptionError("MAPPING_INVALID", f"At most {MAX_MAPPINGS} mappings.")
    out = []
    for i, item in enumerate(value):
        n = i + 1
        if not isinstance(item, dict):
            raise OptionError("MAPPING_INVALID", f"Mapping {n} must be an object.")
        kind = item.get("kind")
        label = item.get("label", "")
        color = item.get("color")
        if not isinstance(label, str) or len(label) > 40:
            raise OptionError("MAPPING_INVALID", f"Mapping {n}: label must be a string of at most 40 characters.")
        if color is not None and not is_color(color):
            raise OptionError("MAPPING_INVALID", f"Mapping {n}: color must be #RRGGBB or null.")
        if kind == "value":
            extra = set(item) - {"kind", "value", "label", "color"}
            if extra:
                raise OptionError("MAPPING_INVALID", f"Mapping {n}: unknown key(s) {', '.join(sorted(extra))}.")
            raw = item.get("value")
            if not isinstance(raw, str) or len(raw) > 80:
                raise OptionError("MAPPING_INVALID", f"Mapping {n}: value must be a string of at most 80 characters.")
            out.append({"kind": "value", "value": raw, "label": label, "color": color})
        elif kind == "range":
            extra = set(item) - {"kind", "from", "to", "label", "color"}
            if extra:
                raise OptionError("MAPPING_INVALID", f"Mapping {n}: unknown key(s) {', '.join(sorted(extra))}.")
            lo, hi = item.get("from"), item.get("to")
            for name, bound in (("from", lo), ("to", hi)):
                if bound is not None and not is_number(bound):
                    raise OptionError("MAPPING_INVALID", f"Mapping {n}: {name} must be a finite number or null.")
            if lo is not None and hi is not None and not lo < hi:
                raise OptionError("MAPPING_INVALID", f"Mapping {n}: from must be lower than to.")
            out.append({"kind": "range", "from": lo, "to": hi, "label": label, "color": color})
        else:
            raise OptionError("MAPPING_INVALID", f"Mapping {n}: kind must be 'value' or 'range'.")
    return out


def validate_option(spec: OptionSpec, value: Any, *, variable_ids: frozenset[str] | set[str] = frozenset()) -> Any:
    """Return the normalized value of one option or raise :class:`OptionError`."""
    if value is None:
        if spec.nullable:
            return None
        raise OptionError("REQUIRED", "A value is required.")
    t = spec.type
    if t == "boolean":
        if not isinstance(value, bool):
            raise OptionError("INVALID_TYPE", "Must be true or false.")
        return value
    if t == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            raise OptionError("INVALID_TYPE", "Must be an integer.")
        _check_range(spec, value)
        return value
    if t == "number":
        if not is_number(value):
            raise OptionError("INVALID_TYPE", "Must be a finite number.")
        _check_range(spec, float(value))
        return value
    if t in ("string", "text"):
        if not isinstance(value, str):
            raise OptionError("INVALID_TYPE", "Must be a string.")
        if spec.max_length is not None and len(value) > spec.max_length:
            raise OptionError("TOO_LONG", f"At most {spec.max_length} characters.")
        if t == "text":
            bad = unsafe_links(value)
            if bad:
                raise OptionError("LINK_INVALID", f"Links must point to http(s) URLs or internal paths: {bad[0][:60]}")
        return value
    if t == "color":
        if not is_color(value):
            raise OptionError("INVALID_COLOR", "Must be a #RRGGBB color.")
        return value
    if t == "enum":
        if value not in (spec.choices or ()):
            raise OptionError("INVALID_CHOICE", f"Must be one of: {', '.join(map(str, spec.choices or ()))}.")
        return value
    if t == "page_ref":
        if value not in PAGES:
            raise OptionError("INVALID_CHOICE", f"Must be one of: {', '.join(PAGES)}.")
        return value
    if t == "thresholds":
        return _thresholds_value(value)
    if t == "mappings":
        return _mappings_value(value)
    if t == "image":
        if not isinstance(value, str):
            raise OptionError("IMAGE_INVALID", "The image must be a data URL string.")
        check_image(value)
        return value
    if t in ("dashboard_ref", "resource_ref"):
        canonical = canonical_uuid(value)
        if canonical is None:
            raise OptionError("INVALID_REF", "Must be an identifier (UUID).")
        return canonical
    if t == "variable_ref":
        if not isinstance(value, str) or not _VARIABLE_ID_RE.match(value):
            raise OptionError("INVALID_REF", "Must be a variable id.")
        if value not in variable_ids:
            raise OptionError("VARIABLE_UNKNOWN", f"Variable '{value}' is not defined in this dashboard.")
        return value
    raise OptionError("INVALID_TYPE", f"Unsupported option type {t}.")  # pragma: no cover - registry invariant


def default_options(wt: WidgetType) -> dict[str, Any]:
    return {spec.key: _copy(spec.default) for spec in wt.all_options}


def normalize_options(wt: WidgetType, options: Any, *, variable_ids: frozenset[str] | set[str] = frozenset()
                      ) -> tuple[dict[str, Any], list[tuple[str, str, str, str]]]:
    """Validate ``options`` against the registry spec of ``wt``.

    Returns ``(normalized, problems)``; ``normalized`` has every declared key (missing ones from the defaults),
    ``problems`` is a list of ``(severity, code, option key, message)``. Unknown keys are errors.
    """
    problems: list[tuple[str, str, str, str]] = []
    if options is None:
        options = {}
    if not isinstance(options, dict):
        return default_options(wt), [("error", "INVALID_TYPE", "", "Options must be an object.")]
    out = default_options(wt)
    for key in sorted(set(options) - {s.key for s in wt.all_options}, key=str):
        problems.append(("error", "OPTION_UNKNOWN", str(key), f"Unknown option '{key}' for widget type {wt.type}."))
    for spec in wt.all_options:
        if spec.key not in options:
            continue
        try:
            out[spec.key] = validate_option(spec, options[spec.key], variable_ids=variable_ids)
        except OptionError as exc:
            problems.append(("error", exc.code, spec.key, f"{spec.label}: {exc.message}"))
    problems.extend(_cross_checks(wt, out))
    return out, problems


def _pair(out: dict[str, Any], lo_key: str, hi_key: str, label: str) -> list[tuple[str, str, str, str]]:
    lo, hi = out.get(lo_key), out.get(hi_key)
    if is_number(lo) and is_number(hi) and not lo < hi:
        return [("error", "OUT_OF_RANGE", hi_key, f"{label}: the maximum must be greater than the minimum.")]
    return []


def _cross_checks(wt: WidgetType, out: dict[str, Any]) -> list[tuple[str, str, str, str]]:
    problems: list[tuple[str, str, str, str]] = []
    if out.get("background") == "custom" and out.get("background_color") is None:
        problems.append(("warning", "OPTION_MISSING", "background_color", "Custom background without a color uses the theme surface."))
    if wt.type == "gauge":
        problems += _pair(out, "min", "max", "Gauge range")
        target = out.get("target")
        if is_number(target) and is_number(out.get("min")) and is_number(out.get("max")) and not out["min"] <= target <= out["max"]:
            problems.append(("warning", "OUT_OF_RANGE", "target", "The target is outside the gauge range."))
    elif wt.type == "progress":
        problems += _pair(out, "min", "target_value", "Progress range")
    elif wt.type in ("timeseries", "bar"):
        problems += _pair(out, "y_min", "y_max", "Y axis")
    elif wt.type == "scatter":
        problems += _pair(out, "x_min", "x_max", "X axis") + _pair(out, "y_min", "y_max", "Y axis")
    return problems
