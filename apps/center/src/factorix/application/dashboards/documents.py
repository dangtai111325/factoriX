"""Dashboard document schema v1: strict models, legacy upgrade and structural validation (contract ``dashboard.md`` §1–§3).

Validation never raises for user input: it returns a list of *issues*
``{severity, code, message, widget_id?, binding_id?, path?}``. A document is structurally valid when no issue
has severity ``error``; :func:`validate_structure` then also returns the *normalized* document (every key
present, option defaults filled, identifiers canonical), which is what the API stores.

Two levels of checks live here (both without database access):

* **structural** (:func:`validate_structure`) — shape, types, bounds, unknown keys, ids, layout, limits. A
  draft with structural errors is rejected (``PATCH`` → 422 ``VALIDATION``).
* **completeness** (:func:`completeness_issues`) — what a draft may lack but a published dashboard may not
  (bindings below the widget minimum, required roles, unbound template roles, link targets). Source
  resolution and value-kind fit need the database and live in :mod:`.validation`.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal, Union

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, model_validator

from factorix.application.dashboards import registry as R
from factorix.modules.common import iso_ms
from factorix.modules.storage_bindings import normalize_field_path

WIDGET_ID_RE = re.compile(r"^[a-z0-9_]{3,40}$")
BINDING_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
VARIABLE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
ROLE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
SOURCE_KINDS = ("signal", "model_field", "signal_key", "role")
TOP_LEVEL_KEYS = ("schema_version", "settings", "variables", "widgets")

#: Legacy (pre-v1) widget types that have a direct v1 equivalent; any other legacy type becomes ``text``.
LEGACY_TYPE_MAP = {
    "kpi": "kpi", "gauge": "gauge", "timeseries": "timeseries", "chart": "timeseries",
    "latest_table": "latest_table", "machine_status": "status",
}


# ---------------------------------------------------------------------------------------------------------
# Issues
# ---------------------------------------------------------------------------------------------------------


def issue(severity: str, code: str, message: str, *, widget_id: Any = None, binding_id: Any = None,
          path: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"severity": severity, "code": code, "message": message}
    if isinstance(widget_id, str) and widget_id:
        out["widget_id"] = widget_id[:80]
    if isinstance(binding_id, str) and binding_id:
        out["binding_id"] = binding_id[:80]
    if path:
        out["path"] = path
    return out


def has_errors(issues: list[dict[str, Any]]) -> bool:
    return any(i["severity"] == "error" for i in issues)


_PYDANTIC_CODES = {
    "extra_forbidden": "UNKNOWN_KEY", "missing": "REQUIRED", "literal_error": "INVALID_VALUE",
    "string_too_long": "TOO_LONG", "string_too_short": "REQUIRED", "too_long": "LIMIT",
    "greater_than_equal": "OUT_OF_RANGE", "less_than_equal": "OUT_OF_RANGE", "greater_than": "OUT_OF_RANGE",
    "less_than": "OUT_OF_RANGE", "union_tag_invalid": "INVALID_VALUE", "union_tag_not_found": "REQUIRED",
    "finite_number": "INVALID_VALUE",
}


def _path(prefix: str, loc: tuple[Any, ...]) -> str:
    out = prefix
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out


def _pydantic_issues(exc: ValidationError, prefix: str, *, widget_id: Any = None, binding_id: Any = None) -> list[dict[str, Any]]:
    out = []
    for err in exc.errors(include_url=False):
        loc = tuple(err.get("loc") or ())
        code = _PYDANTIC_CODES.get(err.get("type", ""), "INVALID_VALUE")
        if err.get("type", "").endswith("_type"):
            code = "INVALID_TYPE"
        path = _path(prefix, loc)
        msg = str(err.get("msg") or "Invalid value.")
        if msg.startswith("Value error, "):
            msg = msg[len("Value error, "):]
        out.append(issue("error", code, f"{path}: {msg}" if path else msg, widget_id=widget_id, binding_id=binding_id, path=path))
    return out


# ---------------------------------------------------------------------------------------------------------
# Strict models
# ---------------------------------------------------------------------------------------------------------


def _color(value: str) -> str:
    if not R.COLOR_RE.match(value):
        raise ValueError("must be a #RRGGBB color")
    return value


def _uuid(value: str) -> str:
    canonical = R.canonical_uuid(value)
    if canonical is None:
        raise ValueError("must be a UUID")
    return canonical


def _timestamp(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("must be an ISO-8601 timestamp") from None
    if parsed.tzinfo is None:
        raise ValueError("must include a timezone")
    return str(iso_ms(parsed))


def _pattern(regex: re.Pattern[str], what: str) -> Any:
    def check(value: str) -> str:
        if not regex.match(value):
            raise ValueError(f"must be a valid {what} ({regex.pattern})")
        return value

    return AfterValidator(check)


Color = Annotated[str, AfterValidator(_color)]
Uuid = Annotated[str, AfterValidator(_uuid)]
Timestamp = Annotated[str, AfterValidator(_timestamp)]
VariableId = Annotated[str, _pattern(VARIABLE_ID_RE, "variable id")]
RoleId = Annotated[str, _pattern(ROLE_ID_RE, "role id")]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Theme(_Strict):
    preset: Literal["factorix_light", "control_room_dark", "industrial_neutral"] = "factorix_light"
    accent: Color | None = None
    canvas: Color | None = None
    surface: Color | None = None
    text: Color | None = None
    radius: int = Field(12, ge=0, le=24)
    gap: int = Field(12, ge=4, le=32)
    font_scale: float = Field(1.0, ge=0.8, le=1.4)


class RelativeRange(_Strict):
    kind: Literal["relative"]
    last: Literal["5m", "15m", "30m", "1h", "3h", "6h", "12h", "24h", "2d", "7d", "30d"] = "1h"


class AbsoluteRange(_Strict):
    kind: Literal["absolute"]
    start: Timestamp
    end: Timestamp

    @model_validator(mode="after")
    def _ordered(self) -> "AbsoluteRange":
        start = datetime.fromisoformat(self.start.replace("Z", "+00:00"))
        end = datetime.fromisoformat(self.end.replace("Z", "+00:00"))
        if start >= end:
            raise ValueError("the start of the range must be before its end")
        if end - start > timedelta(days=R.MAX_WINDOW_DAYS):
            raise ValueError(f"the range is limited to {R.MAX_WINDOW_DAYS} days")
        return self


TimeRange = Annotated[Union[RelativeRange, AbsoluteRange], Field(discriminator="kind")]


def _default_range() -> RelativeRange:
    return RelativeRange(kind="relative", last="1h")


class Settings(_Strict):
    theme: Theme = Field(default_factory=Theme)
    time_range: TimeRange = Field(default_factory=_default_range)
    refresh: Literal["live", "10s", "30s", "1m", "5m", "off"] = "live"
    row_height: int = Field(40, ge=24, le=96)


class Variable(_Strict):
    id: VariableId
    label: str = Field("", max_length=80)
    type: Literal["resource"] = "resource"
    resource_type: str | None = Field(None, min_length=1, max_length=80)
    default: Uuid | None = None


class Cell(_Strict):
    x: int = Field(ge=0)
    y: int = Field(ge=0, le=R.MAX_Y)
    w: int = Field(ge=1)
    h: int = Field(ge=1, le=R.MAX_WIDGET_HEIGHT)


class Layout(_Strict):
    lg: Cell
    md: Cell | None = None
    sm: Cell | None = None


class Hidden(_Strict):
    lg: bool = False
    md: bool = False
    sm: bool = False


class DashboardTime(_Strict):
    mode: Literal["dashboard"]


class CustomTime(_Strict):
    mode: Literal["custom"]
    range: TimeRange


WidgetTime = Annotated[Union[DashboardTime, CustomTime], Field(discriminator="mode")]


class SignalSource(_Strict):
    kind: Literal["signal"]
    signal_id: Uuid


class ModelFieldSource(_Strict):
    kind: Literal["model_field"]
    model_id: Uuid
    field_path: str = Field(min_length=1, max_length=512)


class SignalKeySource(_Strict):
    kind: Literal["signal_key"]
    variable: VariableId
    key: str = Field(min_length=1, max_length=120)


class RoleSource(_Strict):
    kind: Literal["role"]
    role: RoleId


_SOURCE_MODELS: dict[str, type[_Strict]] = {
    "signal": SignalSource, "model_field": ModelFieldSource, "signal_key": SignalKeySource, "role": RoleSource,
}


class Binding(_Strict):
    id: Annotated[str, _pattern(BINDING_ID_RE, "binding id")]
    role: str | None = None
    source: dict[str, Any]
    label: str | None = Field(None, max_length=120)
    color: Color | None = None
    unit: str | None = Field(None, max_length=24)
    scale: float = 1.0
    offset: float = 0.0


class Widget(_Strict):
    id: Annotated[str, _pattern(WIDGET_ID_RE, "widget id")]
    type: str = Field(min_length=1, max_length=40)
    version: int = 1
    title: str = Field("", max_length=120)
    layout: Layout
    hidden: Hidden = Field(default_factory=Hidden)
    time: WidgetTime = Field(default_factory=lambda: DashboardTime(mode="dashboard"))
    bindings: list[dict[str, Any]] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------------------------------------


def normalize_source(raw: Any) -> tuple[dict[str, Any] | None, str | None, str]:
    """``(normalized source, error code, message)`` of one binding source (structural only)."""
    if not isinstance(raw, dict):
        return None, "INVALID_REF", "The source must be an object."
    kind = raw.get("kind")
    model = _SOURCE_MODELS.get(kind) if isinstance(kind, str) else None
    if model is None:
        return None, "INVALID_SOURCE_KIND", (
            f"Unsupported source kind {kind!r}: only signal, model_field and signal_key sources exist "
            "(no URL, SQL, table or script source)."
        )
    try:
        parsed = model.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        where = ".".join(str(p) for p in first.get("loc") or ())
        return None, "INVALID_REF", f"Invalid {kind} source{f' ({where})' if where else ''}: {first.get('msg')}"
    out = parsed.model_dump(mode="json")
    if kind == "model_field":
        path = normalize_field_path(out["field_path"])
        if not path:
            return None, "INVALID_REF", "The field path is empty."
        out["field_path"] = path
    return out, None, ""


def source_key(source: dict[str, Any]) -> str:
    return json.dumps(source, sort_keys=True, separators=(",", ":"))


def default_document() -> dict[str, Any]:
    return {"schema_version": R.SCHEMA_VERSION, "settings": Settings().model_dump(mode="json"), "variables": [], "widgets": []}


def document_bytes(document: Any) -> int:
    return len(json.dumps(document, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8"))


# ---------------------------------------------------------------------------------------------------------
# Legacy upgrade
# ---------------------------------------------------------------------------------------------------------


def _clamp(value: Any, lo: int, hi: int, fallback: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        value = fallback
    return max(lo, min(hi, value))


def _legacy_id(raw: Any, index: int, taken: set[str]) -> str:
    text = re.sub(r"[^a-z0-9_]", "_", str(raw or "").strip().lower())[:40]
    if not WIDGET_ID_RE.match(text) or text in taken:
        text = f"w_legacy_{index + 1}"
    while text in taken:
        text += "_"
    taken.add(text)
    return text


def _legacy_cell(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    if isinstance(raw.get("lg"), dict):
        raw = raw["lg"]
    if all(isinstance(raw.get(k), int) and not isinstance(raw.get(k), bool) for k in ("x", "y", "w", "h")):
        return {k: raw[k] for k in ("x", "y", "w", "h")}
    return None


def _legacy_binding(raw: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    source: dict[str, Any] | None = None
    if isinstance(raw.get("source"), dict):
        source = raw["source"]
    elif R.canonical_uuid(raw.get("signal_id")):
        source = {"kind": "signal", "signal_id": R.canonical_uuid(raw["signal_id"])}
    elif R.canonical_uuid(raw.get("model_id")) and isinstance(raw.get("field_path"), str):
        source = {"kind": "model_field", "model_id": R.canonical_uuid(raw["model_id"]), "field_path": raw["field_path"]}
    if source is None:
        return None
    out: dict[str, Any] = {"id": f"b_{index + 1}", "source": source}
    for key, limit in (("label", 120), ("unit", 24)):
        if isinstance(raw.get(key), str):
            out[key] = raw[key][:limit]
    if R.is_color(raw.get("color")):
        out["color"] = raw["color"]
    return out


def upgrade_document(raw: Any) -> tuple[Any, list[str]]:
    """Upgrade a pre-v1 draft (``{"widgets": [...]}``, no ``schema_version``) to schema v1.

    Deterministic (the same legacy draft always gives the same v1 document, so ids are stable across reads).
    Widgets and their bindings are kept; a legacy widget type without a v1 equivalent becomes a ``text``
    widget that quotes its legacy configuration. A v1 (or unknown-version) document is returned unchanged.
    """
    if not isinstance(raw, dict) or "schema_version" in raw:
        return raw, []
    notes: list[str] = []
    doc = default_document()
    legacy_widgets = raw.get("widgets") if isinstance(raw.get("widgets"), list) else []
    dropped_keys = sorted(str(k) for k in raw if k != "widgets")
    if dropped_keys:
        notes.append(f"Legacy draft keys not used by schema v1 were dropped: {', '.join(dropped_keys)}.")
    taken: set[str] = set()
    placed: list[tuple[int, dict[str, Any], dict[str, Any] | None]] = []
    for index, w in enumerate(legacy_widgets):
        if not isinstance(w, dict):
            notes.append(f"Legacy widget #{index + 1} is not an object and was skipped.")
            continue
        legacy_type = str(w.get("type") or "")
        new_type = LEGACY_TYPE_MAP.get(legacy_type, "text")
        raw_bindings = w.get("bindings") if isinstance(w.get("bindings"), list) else []
        bindings = [b for b in (_legacy_binding(item, j) for j, item in enumerate(raw_bindings)) if b]
        if len(bindings) < len(raw_bindings) and new_type != "text":
            notes.append(f"Legacy widget '{w.get('id')}': {len(raw_bindings) - len(bindings)} binding(s) without a signal or model field were dropped.")
        wt = R.WIDGET_TYPES[new_type]
        if new_type != "text" and len(bindings) > wt.max_bindings:
            notes.append(f"Legacy widget '{w.get('id')}' has {len(bindings)} sources; it became a latest_table to keep them all.")
            new_type, wt = "latest_table", R.WIDGET_TYPES["latest_table"]
            bindings = bindings[: wt.max_bindings]
        widget: dict[str, Any] = {
            "id": _legacy_id(w.get("id"), index, taken), "type": new_type, "version": 1,
            "title": str(w.get("title") or w.get("name") or "")[:120], "bindings": bindings, "options": {},
        }
        if new_type == "text":
            quoted = json.dumps(w, ensure_ascii=False, indent=2, default=str)
            content = (f"**Legacy widget `{legacy_type or 'unknown'}`** is not available in this version. "
                       f"Its configuration is kept below.\n\n```json\n{quoted}\n```")
            if len(content) > 10_000:
                content = content[:9_980] + "\n…(truncated)\n```"
                notes.append(f"Legacy widget '{w.get('id')}': its quoted configuration was truncated.")
            widget["options"] = {"content": content}
            widget["bindings"] = []
            notes.append(f"Legacy widget type '{legacy_type or 'unknown'}' is not available; widget '{widget['id']}' became a text widget.")
        else:
            options = w.get("options") if isinstance(w.get("options"), dict) else (w.get("config") if isinstance(w.get("config"), dict) else {})
            kept = {}
            for key, value in options.items():
                spec = wt.option(str(key))
                if spec is None:
                    continue
                try:
                    kept[spec.key] = R.validate_option(spec, value)
                except R.OptionError:
                    continue
            if len(kept) < len(options):
                notes.append(f"Legacy widget '{widget['id']}': unsupported settings were dropped.")
            widget["options"] = kept
        placed.append((index, widget, _legacy_cell(w.get("layout")) or _legacy_cell(w)))
    bottom = max((c["y"] + c["h"] for _i, _w, c in placed if c), default=0)
    cursor_x, cursor_y, row_h = 0, bottom, 0
    for _index, widget, cell in placed:
        wt = R.WIDGET_TYPES[widget["type"]]
        min_w, min_h = wt.min_size
        if cell is None:
            w, h = wt.default_size
            if cursor_x + w > R.COLUMNS["lg"]:
                cursor_x, cursor_y, row_h = 0, cursor_y + row_h, 0
            cell = {"x": cursor_x, "y": cursor_y, "w": w, "h": h}
            cursor_x += w
            row_h = max(row_h, h)
        w = _clamp(cell["w"], min_w, R.COLUMNS["lg"], wt.default_size[0])
        h = _clamp(cell["h"], min_h, R.MAX_WIDGET_HEIGHT, wt.default_size[1])
        widget["layout"] = {"lg": {"x": _clamp(cell["x"], 0, R.COLUMNS["lg"] - w, 0), "y": _clamp(cell["y"], 0, R.MAX_Y, 0), "w": w, "h": h},
                            "md": None, "sm": None}
        doc["widgets"].append(widget)
    if legacy_widgets:
        notes.insert(0, "Upgraded from the legacy dashboard draft format to schema v1.")
    return doc, notes


# ---------------------------------------------------------------------------------------------------------
# Structural validation
# ---------------------------------------------------------------------------------------------------------


def _validate_binding(wt: R.WidgetType, raw: Any, index: int, widget_id: str, prefix: str,
                      variable_ids: set[str], issues: list[dict[str, Any]]) -> dict[str, Any] | None:
    path = f"{prefix}.bindings[{index}]"
    if not isinstance(raw, dict):
        issues.append(issue("error", "INVALID_TYPE", f"{path}: a binding must be an object.", widget_id=widget_id, path=path))
        return None
    bid = raw.get("id") if isinstance(raw.get("id"), str) else None
    try:
        b = Binding.model_validate(raw)
    except ValidationError as exc:
        issues.extend(_pydantic_issues(exc, path, widget_id=widget_id, binding_id=bid))
        return None
    ok = True
    source, code, message = normalize_source(b.source)
    if source is None:
        issues.append(issue("error", code or "INVALID_REF", message, widget_id=widget_id, binding_id=b.id, path=f"{path}.source"))
        ok = False
    elif source["kind"] == "signal_key" and source["variable"] not in variable_ids:
        issues.append(issue("error", "VARIABLE_UNKNOWN", f"Variable '{source['variable']}' is not defined in this dashboard.",
                            widget_id=widget_id, binding_id=b.id, path=f"{path}.source.variable"))
        ok = False
    if wt.roles is not None:
        if b.role is None:
            issues.append(issue("error", "ROLE_REQUIRED", f"Widget type {wt.type} needs a role on every binding "
                                f"({', '.join(r.id for r in wt.roles)}).", widget_id=widget_id, binding_id=b.id, path=f"{path}.role"))
            ok = False
        elif wt.role(b.role) is None:
            issues.append(issue("error", "ROLE_UNKNOWN", f"Role '{b.role}' is not a role of widget type {wt.type}.",
                                widget_id=widget_id, binding_id=b.id, path=f"{path}.role"))
            ok = False
    elif b.role is not None:
        issues.append(issue("error", "ROLE_UNKNOWN", f"Widget type {wt.type} has no roles; remove 'role'.",
                            widget_id=widget_id, binding_id=b.id, path=f"{path}.role"))
        ok = False
    if not ok or source is None:
        return None
    out: dict[str, Any] = {"id": b.id}
    if wt.roles is not None:
        out["role"] = b.role
    out.update(source=source, label=b.label, color=b.color, unit=b.unit, scale=b.scale, offset=b.offset)
    return out


def _validate_widget(raw: Any, index: int, variable_ids: set[str], issues: list[dict[str, Any]]) -> dict[str, Any] | None:
    prefix = f"widgets[{index}]"
    if not isinstance(raw, dict):
        issues.append(issue("error", "INVALID_TYPE", f"{prefix}: a widget must be an object.", path=prefix))
        return None
    wid = raw.get("id") if isinstance(raw.get("id"), str) else None
    try:
        w = Widget.model_validate(raw)
    except ValidationError as exc:
        issues.extend(_pydantic_issues(exc, prefix, widget_id=wid))
        return None
    wt = R.widget_type(w.type)
    if wt is None:
        issues.append(issue("error", "UNKNOWN_WIDGET_TYPE", f"Unknown widget type '{w.type}'.", widget_id=w.id, path=f"{prefix}.type"))
        return None
    if w.version != wt.version:
        issues.append(issue("error", "UNSUPPORTED_VERSION", f"Widget type {wt.type} version {w.version} is not supported "
                            f"(supported: {wt.version}).", widget_id=w.id, path=f"{prefix}.version"))
        return None
    ok = True
    for bp, cell in (("lg", w.layout.lg), ("md", w.layout.md), ("sm", w.layout.sm)):
        if cell is None:
            continue
        cols = R.COLUMNS[bp]
        min_w, min_h = min(wt.min_size[0], cols), wt.min_size[1]
        problems = []
        if cell.w < min_w:
            problems.append(f"w ≥ {min_w}")
        if cell.h < min_h:
            problems.append(f"h ≥ {min_h}")
        if cell.x + cell.w > cols:
            problems.append(f"x + w ≤ {cols}")
        if problems:
            issues.append(issue("error", "LAYOUT", f"Layout {bp} of widget '{w.id}' must satisfy {', '.join(problems)}.",
                                widget_id=w.id, path=f"{prefix}.layout.{bp}"))
            ok = False
    if len(w.bindings) > wt.max_bindings:
        issues.append(issue("error", "TOO_MANY_BINDINGS", f"Widget type {wt.type} accepts at most {wt.max_bindings} binding(s).",
                            widget_id=w.id, path=f"{prefix}.bindings"))
        ok = False
    bindings = []
    seen: set[str] = set()
    for j, raw_b in enumerate(w.bindings):
        b = _validate_binding(wt, raw_b, j, w.id, prefix, variable_ids, issues)
        if b is None:
            ok = False
            continue
        if b["id"] in seen:
            issues.append(issue("error", "DUPLICATE_ID", f"Binding id '{b['id']}' is used twice in widget '{w.id}'.",
                                widget_id=w.id, binding_id=b["id"], path=f"{prefix}.bindings[{j}].id"))
            ok = False
        seen.add(b["id"])
        bindings.append(b)
    for role in wt.roles or ():
        count = sum(1 for b in bindings if b.get("role") == role.id)
        if count > role.max:
            issues.append(issue("error", "ROLE_LIMIT", f"Role '{role.id}' of widget '{w.id}' accepts at most {role.max} binding(s).",
                                widget_id=w.id, path=f"{prefix}.bindings"))
            ok = False
    options, problems = R.normalize_options(wt, w.options, variable_ids=variable_ids)
    for severity, code, key, message in problems:
        opt_path = f"{prefix}.options.{key}" if key else f"{prefix}.options"
        issues.append(issue(severity, code, message, widget_id=w.id, path=opt_path))
        if severity == "error":
            ok = False
    if not ok:
        return None
    return {
        "id": w.id, "type": wt.type, "version": wt.version, "title": w.title,
        "layout": w.layout.model_dump(mode="json"), "hidden": w.hidden.model_dump(mode="json"),
        "time": w.time.model_dump(mode="json"), "bindings": bindings, "options": options,
    }


def validate_structure(raw: Any) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Structural validation of a dashboard document.

    Returns ``(normalized document or None, issues)``. A legacy draft is upgraded first (its upgrade notes are
    reported as ``LEGACY_UPGRADED`` warnings). The normalized document is returned only without errors.
    """
    issues: list[dict[str, Any]] = []
    if not isinstance(raw, dict):
        return None, [issue("error", "INVALID_TYPE", "The document must be a JSON object.")]
    size = document_bytes(raw)
    if size > R.MAX_DOCUMENT_BYTES:
        return None, [issue("error", "DOCUMENT_TOO_LARGE", f"The document is {size} bytes; the limit is {R.MAX_DOCUMENT_BYTES} bytes.")]
    doc, notes = upgrade_document(raw)
    issues.extend(issue("warning", "LEGACY_UPGRADED", note) for note in notes)
    if doc.get("schema_version") != R.SCHEMA_VERSION:
        return None, issues + [issue("error", "UNSUPPORTED_SCHEMA_VERSION",
                                     f"Unsupported schema_version {doc.get('schema_version')!r} (supported: {R.SCHEMA_VERSION}).",
                                     path="schema_version")]
    for key in sorted(set(doc) - set(TOP_LEVEL_KEYS), key=str):
        issues.append(issue("error", "UNKNOWN_KEY", f"Unknown document key '{key}'.", path=str(key)))

    settings: dict[str, Any] = Settings().model_dump(mode="json")
    try:
        settings = Settings.model_validate(doc.get("settings", {}) if doc.get("settings") is not None else {}).model_dump(mode="json")
    except ValidationError as exc:
        issues.extend(_pydantic_issues(exc, "settings"))

    raw_vars = doc.get("variables", [])
    variables: list[dict[str, Any]] = []
    if not isinstance(raw_vars, list):
        issues.append(issue("error", "INVALID_TYPE", "variables must be a list.", path="variables"))
        raw_vars = []
    if len(raw_vars) > R.MAX_VARIABLES:
        issues.append(issue("error", "LIMIT", f"At most {R.MAX_VARIABLES} variables per dashboard.", path="variables"))
    variable_ids: set[str] = set()
    for i, rv in enumerate(raw_vars):
        try:
            v = Variable.model_validate(rv)
        except ValidationError as exc:
            issues.extend(_pydantic_issues(exc, f"variables[{i}]"))
            continue
        if v.id in variable_ids:
            issues.append(issue("error", "DUPLICATE_ID", f"Variable id '{v.id}' is used twice.", path=f"variables[{i}].id"))
            continue
        variable_ids.add(v.id)
        variables.append(v.model_dump(mode="json"))

    raw_widgets = doc.get("widgets", [])
    if not isinstance(raw_widgets, list):
        issues.append(issue("error", "INVALID_TYPE", "widgets must be a list.", path="widgets"))
        raw_widgets = []
    if len(raw_widgets) > R.MAX_WIDGETS:
        issues.append(issue("error", "LIMIT", f"At most {R.MAX_WIDGETS} widgets per dashboard ({len(raw_widgets)} given).", path="widgets"))
    widgets: list[dict[str, Any]] = []
    widget_ids: set[str] = set()
    for i, rw in enumerate(raw_widgets):
        w = _validate_widget(rw, i, variable_ids, issues)
        if w is None:
            continue
        if w["id"] in widget_ids:
            issues.append(issue("error", "DUPLICATE_ID", f"Widget id '{w['id']}' is used twice.", widget_id=w["id"], path=f"widgets[{i}].id"))
            continue
        widget_ids.add(w["id"])
        widgets.append(w)
    total = sum(len(w["bindings"]) for w in widgets)
    if total > R.MAX_BINDINGS_PER_DOCUMENT:
        issues.append(issue("error", "LIMIT", f"At most {R.MAX_BINDINGS_PER_DOCUMENT} bindings per dashboard ({total} given).", path="widgets"))
    if has_errors(issues):
        return None, issues
    return {"schema_version": R.SCHEMA_VERSION, "settings": settings, "variables": variables, "widgets": widgets}, issues


# ---------------------------------------------------------------------------------------------------------
# Completeness (publish requirements that need no database)
# ---------------------------------------------------------------------------------------------------------


def iter_bindings(document: dict[str, Any]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    return [(w, b) for w in document.get("widgets", []) for b in w.get("bindings", [])]


def completeness_issues(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Issues of a *normalized* document that block publishing but not saving a draft."""
    issues: list[dict[str, Any]] = []
    widgets = document.get("widgets", [])
    if not widgets:
        issues.append(issue("error", "EMPTY_DASHBOARD", "The dashboard has no widgets yet."))
    for w in widgets:
        wt = R.WIDGET_TYPES[w["type"]]
        bindings = w["bindings"]
        if len(bindings) < wt.min_bindings:
            issues.append(issue("error", "TOO_FEW_BINDINGS", f"Widget '{w['title'] or w['id']}' needs at least {wt.min_bindings} "
                                f"source(s).", widget_id=w["id"]))
        for role in wt.roles or ():
            if role.required and not any(b.get("role") == role.id for b in bindings):
                issues.append(issue("error", "ROLE_MISSING", f"Widget '{w['title'] or w['id']}' needs a source for role "
                                    f"'{role.label}'.", widget_id=w["id"]))
        for b in bindings:
            if b["source"]["kind"] == "role":
                issues.append(issue("error", "UNBOUND", f"Template role '{b['source']['role']}' is not mapped to a source yet.",
                                    widget_id=w["id"], binding_id=b["id"]))
        opts = w["options"]
        if wt.type == "equipment":
            if opts.get("resource_source") == "variable" and not opts.get("variable"):
                issues.append(issue("error", "OPTION_MISSING", "Choose the variable that selects the equipment resource.", widget_id=w["id"]))
            if opts.get("resource_source") == "fixed" and not opts.get("resource_id"):
                issues.append(issue("warning", "OPTION_MISSING", "No resource is selected for this equipment tile.", widget_id=w["id"]))
        if wt.type == "link" and opts.get("target_type") == "dashboard" and not opts.get("dashboard_id"):
            issues.append(issue("error", "LINK_TARGET_MISSING", "Choose the dashboard this link opens.", widget_id=w["id"]))
        if wt.type == "image" and not opts.get("image_data"):
            issues.append(issue("warning", "IMAGE_EMPTY", "The image widget has no image.", widget_id=w["id"]))
    return issues
