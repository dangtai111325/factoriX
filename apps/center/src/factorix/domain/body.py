"""Data Model v2 body: spec tree validation, reference resolution, rendering and evaluation.

Pure: no framework, database or network imports.

A model's body definition (``spec``) is a tree::

    {"version": 2, "root": {"type": "object", "children": [node, ...]}, "labels": {...}}

``object`` nodes have keyed children, ``array`` nodes have unkeyed children, ``field`` nodes
produce one value: ``mapping`` (latest valid value of one signal) or ``calculated`` (a Custom
Rule, see :mod:`factorix.domain.rules`). Node order is the key order of the output body, which
is serialized as ordered JSON text (never JSONB, which reorders keys).

``labels`` maps ``"sig:<id>"``/``"res:<id>"`` to the last known display text of each referenced
target, so a deleted target can still be shown as ``$⚠missing[<label>]``.
"""

from __future__ import annotations

import copy
import json
import math
import re
import uuid
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from factorix.domain import rules as R

SPEC_VERSION = 2
NODE_TYPES = ("object", "array", "field")
FIELD_MODES = ("mapping", "calculated")
VALUE_TYPES = ("auto", "float", "int", "string", "bool", "timestamp", "json")
MAX_DEPTH = 16
MAX_FIELDS = 2000
MAX_KEY_LEN = 128
MAX_NODE_ID_LEN = 64
MAX_LABEL_LEN = 1000
DATA_TYPE_VALUE_TYPE = {
    "bool": "bool",
    "boolean": "bool",
    "int64": "int",
    "float64": "float",
    "string": "string",
    "enum": "string",
    "json": "json",
}
_LABEL_KEY_RE = re.compile(r"^(sig|res):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def empty_spec() -> dict[str, Any]:
    return {"version": SPEC_VERSION, "root": {"type": "object", "children": []}, "labels": {}}


def pointer(parts: list[str | int]) -> str:
    """JSON pointer (RFC 6901) of a node: ``/electrical/voltage_1``, ``/temps/0``; root is ``""``."""
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def _issue(path: str, node_id: str | None, code: str, message: str, *, severity: str = "error", **extra: Any) -> dict[str, Any]:
    item: dict[str, Any] = {"path": path, "severity": severity, "code": code, "message": message}
    if node_id:
        item["node_id"] = node_id
    for key, value in extra.items():
        if value is not None and value != []:
            item[key] = value
    return item


def _rule_issue(path: str, node_id: str | None, err: R.RuleError, pos: int | None = None, end: int | None = None) -> dict[str, Any]:
    return _issue(
        path,
        node_id,
        err.code,
        err.message,
        severity=err.severity,
        pos=err.pos if pos is None else pos,
        end=err.end if end is None else end,
        suggestions=err.suggestions or None,
    )


def has_errors(issues: list[dict[str, Any]]) -> bool:
    return any(item.get("severity", "error") == "error" for item in issues)


def _uuid_text(value: Any) -> str | None:
    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        return None


# ============================================================================================
# Structure
# ============================================================================================


def normalize_spec(raw: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Validate the tree structure. Returns a clean copy (known keys only) and structural issues.

    Invalid nodes are dropped from the clean copy; every problem is reported with its path.
    """
    issues: list[dict[str, Any]] = []
    if not isinstance(raw, Mapping):
        return empty_spec(), [_issue("", None, "INVALID_SPEC", "The body definition must be an object.")]
    version = raw.get("version", SPEC_VERSION)
    if version != SPEC_VERSION:
        issues.append(_issue("", None, "INVALID_SPEC", f"Unsupported body definition version {version!r}; expected {SPEC_VERSION}."))
    root = raw.get("root")
    if not isinstance(root, Mapping) or root.get("type", "object") != "object" or not isinstance(root.get("children", []), list):
        issues.append(_issue("", None, "INVALID_SPEC", "The body root must be an object node with a children list."))
        return empty_spec(), issues
    counter = {"fields": 0}
    children = _children(root.get("children") or [], [], "object", 1, counter, issues)
    labels: dict[str, str] = {}
    raw_labels = raw.get("labels")
    if isinstance(raw_labels, Mapping):
        for key, label in raw_labels.items():
            key_text = str(key).lower()
            if _LABEL_KEY_RE.match(key_text) and isinstance(label, str) and 0 < len(label) <= MAX_LABEL_LEN:
                labels[key_text] = label
    return {"version": SPEC_VERSION, "root": {"type": "object", "children": children}, "labels": labels}, issues


def _children(
    items: list[Any], path: list[str | int], parent_type: str, depth: int, counter: dict[str, int], issues: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, Mapping):
            issues.append(_issue(pointer([*path, index]), None, "INVALID_NODE", "A node must be an object."))
            continue
        node_id = item.get("id")
        node_id = node_id if isinstance(node_id, str) and 0 < len(node_id) <= MAX_NODE_ID_LEN else None
        node_type = item.get("type")
        key = item.get("key")
        if parent_type == "object":
            if not isinstance(key, str) or not key.strip():
                issues.append(_issue(pointer([*path, index]), node_id, "KEY_EMPTY", "Every key must be non-empty."))
                continue
            node_path = [*path, key]
            if len(key) > MAX_KEY_LEN:
                issues.append(_issue(pointer(node_path), node_id, "KEY_TOO_LONG", f"Keys are limited to {MAX_KEY_LEN} characters."))
                continue
            if key in seen:
                issues.append(_issue(pointer(node_path), node_id, "KEY_DUPLICATE", f"Duplicate key '{key}' in the same object."))
                continue
            seen.add(key)
        else:
            key = None
            node_path = [*path, len(out)]
        where = pointer(node_path)
        if node_type not in NODE_TYPES:
            issues.append(_issue(where, node_id, "INVALID_NODE", f"Unknown node type {node_type!r}."))
            continue
        if depth > MAX_DEPTH:
            issues.append(_issue(where, node_id, "DEPTH_LIMIT", f"The body is limited to {MAX_DEPTH} levels."))
            continue
        node: dict[str, Any] = {"type": node_type}
        if key is not None:
            node["key"] = key
        if node_id:
            node["id"] = node_id
        if node_type in ("object", "array"):
            kids = item.get("children") or []
            if not isinstance(kids, list):
                issues.append(_issue(where, node_id, "INVALID_NODE", "children must be a list."))
                kids = []
            node["children"] = _children(kids, node_path, node_type, depth + 1, counter, issues)
            out.append(node)
            continue
        counter["fields"] += 1
        if counter["fields"] > MAX_FIELDS:
            if counter["fields"] == MAX_FIELDS + 1:
                issues.append(_issue(where, node_id, "FIELD_LIMIT", f"A model is limited to {MAX_FIELDS} fields."))
            continue
        mode = item.get("mode")
        if mode not in FIELD_MODES:
            issues.append(_issue(where, node_id, "INVALID_MODE", "A field is a mapping or a calculated rule."))
            continue
        value_type = item.get("value_type")
        if value_type is not None and value_type not in VALUE_TYPES:
            issues.append(_issue(where, node_id, "INVALID_VALUE_TYPE", f"value_type must be one of {', '.join(VALUE_TYPES)}."))
            value_type = None
        node["mode"] = mode
        if mode == "mapping":
            ref = item.get("ref")
            ref_out: dict[str, Any] = {}
            if isinstance(ref, Mapping):
                signal_id = _uuid_text(ref.get("signal_id")) if ref.get("signal_id") else None
                if signal_id:
                    ref_out["signal_id"] = signal_id
                elif isinstance(ref.get("text"), str) and ref["text"].strip():
                    ref_out["text"] = ref["text"].strip()
            if not ref_out:
                issues.append(_issue(where, node_id, "BAD_REF", "A mapping field needs a data point."))
            node["ref"] = ref_out
            node["value_type"] = value_type
        else:
            expr = item.get("expr")
            if not isinstance(expr, str) or not expr.strip():
                issues.append(_issue(where, node_id, "EXPR_EMPTY", "The rule is empty."))
                expr = ""
            elif len(expr) > R.MAX_EXPR_LEN:
                issues.append(_issue(where, node_id, "EXPR_TOO_LONG", f"A rule is limited to {R.MAX_EXPR_LEN} characters."))
            node["expr"] = expr
            node["value_type"] = value_type or "auto"
        out.append(node)
    return out


def iter_nodes(spec: Mapping[str, Any]) -> Iterator[tuple[list[str | int], dict[str, Any]]]:
    """Every node with its path parts, depth first in order."""
    stack: list[tuple[list[str | int], dict[str, Any]]] = []
    root = spec.get("root") or {}
    for index, child in reversed(list(enumerate(root.get("children") or []))):
        stack.append(([child.get("key", index)] if "key" in child else [index], child))
    while stack:
        path, node = stack.pop()
        yield path, node
        kids = node.get("children") or []
        for index, child in reversed(list(enumerate(kids))):
            stack.append(([*path, child["key"]] if node.get("type") == "object" and "key" in child else [*path, index], child))


def iter_fields(spec: Mapping[str, Any]) -> Iterator[tuple[list[str | int], dict[str, Any]]]:
    for path, node in iter_nodes(spec):
        if node.get("type") == "field":
            yield path, node


def field_count(spec: Mapping[str, Any]) -> int:
    return sum(1 for _ in iter_fields(spec))


def spec_refs(spec: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    """(signal ids, resource ids) referenced by a stored spec."""
    signals: set[str] = set()
    resources: set[str] = set()
    for _path, node in iter_fields(spec):
        if node.get("mode") == "mapping":
            sid = (node.get("ref") or {}).get("signal_id")
            if sid:
                signals.add(str(sid).lower())
        else:
            for ref in R.token_refs(str(node.get("expr") or "")):
                (signals if ref.kind == "sig" else resources).add(ref.id)
    return signals, resources


# ============================================================================================
# Resolution (on save / validate) and rendering (on load)
# ============================================================================================


def _strip_assignment(expr: str, key: str | None) -> str:
    if not key:
        return expr
    match = re.match(r"^\s*" + re.escape(key) + r"\s*=(?!=)", expr)
    return expr[match.end() :].lstrip() if match else expr


def resolve_spec(raw: Any, catalog: R.Catalog, labels: Mapping[str, str] | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Structural validation + reference resolution + compile check.

    Returns the stored spec (canonical tokens, mapping ``signal_id``s, default value types and
    refreshed ``labels``) and every issue (``severity`` error blocks a save, warning does not).
    """
    spec, issues = normalize_spec(raw)
    known = dict(labels or {})
    known.update(spec.get("labels") or {})
    new_labels: dict[str, str] = {}
    for path_parts, node in iter_fields(spec):
        path = pointer(path_parts)
        node_id = node.get("id")
        if node["mode"] == "mapping":
            ref = node.get("ref") or {}
            signal_id = ref.get("signal_id")
            if not signal_id and ref.get("text"):
                resolved = R.resolve(ref["text"], catalog, known)
                sig_tokens = [t for t in resolved.refs if t.kind == "sig"]
                if not resolved.ok:
                    issues.extend(_rule_issue(path, node_id, e) for e in resolved.issues)
                elif len(sig_tokens) != 1 or resolved.stored.strip() != sig_tokens[0].token():
                    issues.append(_issue(path, node_id, "BAD_REF", "A mapping field takes exactly one data point reference."))
                else:
                    signal_id = sig_tokens[0].id
                    issues.extend(_rule_issue(path, node_id, e) for e in resolved.issues)
            if signal_id:
                node["ref"] = {"signal_id": signal_id}
                label = R.current_label(catalog, "sig", signal_id) or known.get(f"sig:{signal_id}")
                if label:
                    new_labels[f"sig:{signal_id}"] = label
                if not catalog.signal_live(signal_id):
                    issues.append(
                        _issue(path, node_id, "MISSING_REF", f"The data point {label or signal_id} no longer exists.", severity="warning")
                    )
                if node.get("value_type") is None:
                    sig = catalog.signal(signal_id)
                    node["value_type"] = DATA_TYPE_VALUE_TYPE.get(sig.data_type, "auto") if sig else "auto"
            else:
                node["value_type"] = node.get("value_type") or "auto"
            continue
        expr = _strip_assignment(node.get("expr") or "", node.get("key"))
        if not expr.strip():
            node["expr"] = ""
            continue
        resolved = R.resolve(expr, catalog, known)
        node["expr"] = resolved.stored
        issues.extend(_rule_issue(path, node_id, e) for e in resolved.issues)
        new_labels.update(resolved.labels)
        if resolved.ok:
            try:
                R.compile_rule(resolved.stored)
            except R.RuleError as err:
                issues.append(_rule_issue(path, node_id, err, pos=resolved.original_pos(err.pos), end=resolved.original_pos(err.end)))
    spec["labels"] = new_labels
    return spec, issues


def render_spec(
    stored: Mapping[str, Any],
    catalog: R.Catalog,
    signal_meta: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Display copy of a stored spec: ``expr_display``, ``ref_display``, ``ref_info`` and ``missing``.

    Returns (rendered spec, warnings for missing targets).
    """
    spec = copy.deepcopy(dict(stored))
    labels = spec.get("labels") or {}
    issues: list[dict[str, Any]] = []
    meta = signal_meta or {}
    for path_parts, node in iter_fields(spec):
        path = pointer(path_parts)
        if node.get("mode") == "mapping":
            signal_id = (node.get("ref") or {}).get("signal_id")
            text = R.current_label(catalog, "sig", signal_id) if signal_id else None
            node["missing"] = text is None
            if text is None:
                text = R.missing_text(labels.get(f"sig:{signal_id}") or (node.get("ref") or {}).get("text") or "data point")
                issues.append(_issue(path, node.get("id"), "MISSING_REF", "The referenced data point no longer exists.", severity="warning"))
                node["ref_info"] = None
            else:
                sig = catalog.signal(signal_id)
                res = catalog.resource(sig.resource_id) if sig else None
                extra = meta.get(str(signal_id), {})
                node["ref_info"] = {
                    "signal_id": signal_id,
                    "signal_key": sig.key if sig else None,
                    "signal_name": sig.name if sig else None,
                    "data_type": sig.data_type if sig else None,
                    "unit": sig.unit if sig else None,
                    "resource_id": res.id if res else None,
                    "resource_name": res.name if res else None,
                    "resource_type": res.type_key if res else None,
                    "path": " › ".join(catalog.path_names(res.id)) if res else None,
                    "protocol": extra.get("protocol"),
                    "connection_name": extra.get("connection_name"),
                }
            node["ref_display"] = text
            continue
        display, missing = R.render(str(node.get("expr") or ""), catalog, labels)
        node["expr_display"] = display
        node["missing"] = bool(missing)
        if missing:
            issues.append(_issue(path, node.get("id"), "MISSING_REF", "A referenced target no longer exists.", severity="warning"))
    return spec, issues


def retarget_spec(stored: Mapping[str, Any], mapping: Mapping[str, str]) -> dict[str, Any]:
    """Copy of ``stored`` with tokens re-pointed (``{"sig:<old>": "<new>", "res:<old>": "<new>"}``)."""
    spec = copy.deepcopy(dict(stored))
    for _path, node in iter_fields(spec):
        if node.get("mode") == "mapping":
            signal_id = (node.get("ref") or {}).get("signal_id")
            if signal_id and f"sig:{signal_id}" in mapping:
                node["ref"] = {"signal_id": mapping[f"sig:{signal_id}"]}
        elif node.get("expr"):
            node["expr"] = R.replace_tokens(node["expr"], mapping)
    return spec


# ============================================================================================
# Compilation and evaluation
# ============================================================================================


@dataclass
class CompiledField:
    index: int
    path: str
    node_id: str | None
    mode: str
    value_type: str
    signal_id: str | None = None
    program: R.Program | None = None
    error: R.RuleError | None = None


@dataclass
class CompiledSpec:
    tree: tuple[Any, ...]
    fields: list[CompiledField]
    signal_ids: frozenset[str]
    resource_ids: frozenset[str]
    labels: dict[str, str]
    issues: list[dict[str, Any]] = field(default_factory=list)


def compile_spec(stored: Mapping[str, Any]) -> CompiledSpec:
    """Compile a stored spec (tokens only). Never raises: broken fields carry their error."""
    spec, issues = normalize_spec(stored)
    fields: list[CompiledField] = []
    signals: set[str] = set()
    resources: set[str] = set()

    def build(node: dict[str, Any], path: list[str | int]) -> tuple[Any, ...]:
        kind = node["type"]
        if kind == "object":
            return ("obj", tuple((child["key"], build(child, [*path, child["key"]])) for child in node.get("children", [])))
        if kind == "array":
            return ("arr", tuple(build(child, [*path, index]) for index, child in enumerate(node.get("children", []))))
        item = CompiledField(len(fields), pointer(path), node.get("id"), node["mode"], node.get("value_type") or "auto")
        if node["mode"] == "mapping":
            item.signal_id = (node.get("ref") or {}).get("signal_id")
            if item.signal_id:
                signals.add(item.signal_id)
            else:
                item.error = R.RuleError("BAD_REF", "A mapping field needs a data point.")
        else:
            try:
                item.program = R.compile_rule(node.get("expr") or "")
                signals.update(item.program.signal_ids)
                resources.update(item.program.resource_ids)
            except R.RuleError as err:
                item.error = err
        fields.append(item)
        return ("field", item.index)

    tree = ("obj", tuple((child["key"], build(child, [child["key"]])) for child in spec["root"]["children"]))
    return CompiledSpec(tree, fields, frozenset(signals), frozenset(resources), dict(spec.get("labels") or {}), issues)


@dataclass
class BodyContext:
    """Everything an evaluation may read besides the latest values."""

    catalog: R.Catalog | None = None
    lookup: Callable[[str, datetime], R.Sample | None] | None = None
    qualities: Mapping[str, str | None] = field(default_factory=dict)


@dataclass
class EvalResult:
    text: str
    body: Any
    errors: list[dict[str, Any]]
    fields: list[dict[str, Any]]
    pending: list[tuple[str, datetime]]


def cast_value(value: Any, value_type: str) -> Any:
    """Output value of a field (raises :class:`RuleRuntimeError` ``CAST`` on failure)."""
    if value is None:
        return None
    if value_type == "auto":
        if isinstance(value, datetime):
            return R.fmt_ts(value)
        if isinstance(value, float) and not math.isfinite(value):
            raise R.RuleRuntimeError("CAST", "The value is not a finite number.")
        return value
    if value_type == "float":
        return R.to_float(value)
    if value_type == "int":
        return R.to_int(value)
    if value_type == "string":
        return R.to_text(value)
    if value_type == "bool":
        return R.to_bool(value)
    if value_type == "timestamp":
        if isinstance(value, datetime):
            return R.fmt_ts(value)
        if isinstance(value, str):
            parsed = R.as_utc(value)
            if parsed is None:
                raise R.RuleRuntimeError("CAST", f"'{value[:40]}' is not a timestamp.")
            return R.fmt_ts(parsed)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            try:
                return R.fmt_ts(datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc))
            except (OverflowError, OSError, ValueError):
                raise R.RuleRuntimeError("CAST", "Timestamp out of range.") from None
        raise R.RuleRuntimeError("CAST", f"Cannot convert {R._tname(value)} to a timestamp.")
    if value_type == "json":
        if isinstance(value, str):
            try:
                return json.loads(value)
            except ValueError:
                raise R.RuleRuntimeError("CAST", "The text is not valid JSON.") from None
        if isinstance(value, datetime):
            return R.fmt_ts(value)
        return value
    raise R.RuleRuntimeError("CAST", f"Unknown value type {value_type}.")


def dumps_ordered(body: Any) -> str:
    """Exact output text: key order kept, compact, UTF-8 (no ASCII escaping)."""
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _field_error(item: CompiledField, code: str, message: str) -> dict[str, Any]:
    error: dict[str, Any] = {"path": item.path, "code": code, "message": message}
    if item.node_id:
        error["node_id"] = item.node_id
    return error


def evaluate_detailed(
    spec: CompiledSpec | Mapping[str, Any],
    values: Mapping[str, R.Sample | None],
    context: BodyContext | None = None,
    now: datetime | None = None,
    state: R.FilterState | None = None,
    *,
    commit: bool = True,
) -> EvalResult:
    """Evaluate every field once. Runtime problems make that field null and are listed in ``errors``.

    ``values`` maps signal id -> latest valid :class:`~factorix.domain.rules.Sample` (or None).
    When a ``value_at`` lookup is not available yet (``LookupPending`` from ``context.lookup``) the
    field is null and the request is listed in ``pending``; the caller fetches and evaluates again.
    The filter state is committed only when nothing is pending (and ``commit`` is true).
    """
    compiled = spec if isinstance(spec, CompiledSpec) else compile_spec(spec)
    ctx = context or BodyContext()
    moment = R.as_utc(now) or datetime.now(timezone.utc)
    filter_state = state if state is not None else R.FilterState()
    eval_ctx = R.EvalContext(
        now=moment,
        samples=values,
        qualities=ctx.qualities,
        catalog=ctx.catalog,
        lookup=ctx.lookup,
        state=filter_state,
        labels=compiled.labels,
    )
    outputs: list[Any] = [None] * len(compiled.fields)
    errors: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    pending: list[tuple[str, datetime]] = []
    for item in compiled.fields:
        value: Any = None
        error: dict[str, Any] | None = None
        if item.error is not None:
            error = _field_error(item, item.error.code, item.error.message)
        elif item.mode == "mapping":
            assert item.signal_id is not None
            if ctx.catalog is not None and not ctx.catalog.signal_live(item.signal_id):
                label = compiled.labels.get(f"sig:{item.signal_id}") or "data point"
                error = _field_error(item, "MISSING_REF", f"The referenced data point {label} no longer exists.")
            else:
                sample = values.get(item.signal_id)
                value = None if sample is None else sample.value
        else:
            assert item.program is not None
            try:
                value = R.evaluate_rule(item.program, eval_ctx, scope=item.path)
            except R.LookupPending as wait:
                pending.append((wait.signal_id, wait.at))
                value = None
            except R.RuleRuntimeError as exc:
                error = _field_error(item, exc.code, exc.message)
        if error is None:
            try:
                value = cast_value(value, item.value_type)
            except R.RuleRuntimeError as exc:
                error = _field_error(item, exc.code, exc.message)
        if error is not None:
            value = None
            errors.append(error)
        outputs[item.index] = value
        row: dict[str, Any] = {"path": item.path, "value": value, "error": None if error is None else error["message"]}
        if item.node_id:
            row["node_id"] = item.node_id
        rows.append(row)

    def build(node: tuple[Any, ...]) -> Any:
        if node[0] == "obj":
            return {key: build(child) for key, child in node[1]}
        if node[0] == "arr":
            return [build(child) for child in node[1]]
        return outputs[node[1]]

    body = build(compiled.tree)
    if commit and not pending:
        filter_state.commit()
    else:
        filter_state.discard()
    return EvalResult(dumps_ordered(body), body, errors, rows, pending)


def evaluate(
    spec: CompiledSpec | Mapping[str, Any],
    values: Mapping[str, R.Sample | None],
    context: BodyContext | None = None,
    now: datetime | None = None,
    state: R.FilterState | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Pure evaluation: ``(ordered_json_text, errors)``."""
    result = evaluate_detailed(spec, values, context, now, state)
    return result.text, result.errors
