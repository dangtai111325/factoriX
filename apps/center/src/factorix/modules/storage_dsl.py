"""Declarative FactoriX Storage DSL (``factorix.io/storage/v1``), Validator & TDengine Schema Compiler.

Architectural invariants (§5.2, §8.1, ADR-002, ADR-008):
- Single canonical AST shared identically by Visual Designer and Code (YAML/JSON) mode.
- Lossless round-trip ``parse_storage_dsl(serialize_storage_dsl(ast)) == ast``.
- ``ui_meta`` (canvas node/edge coordinates) is serialized without affecting ``semantic_hash``.
- Strictly declarative: no Python/JS code execution, no arbitrary SQL/DDL/DML, no OS/path traversal.
- RabbitMQ is transport, never an allowed storage destination.
- Quality transitions are mandatory; numeric deadbands apply only to compatible numeric fields.
"""

from __future__ import annotations

import ast
import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID, uuid5

import yaml

COMPILER_VERSION = "1.0.0"
API_VERSION = "factorix.io/storage/v1"
DESIGN_KIND = "StorageDesign"

MAX_DSL_BYTES = 512 * 1024
MAX_DEPTH = 24
MAX_DATASETS = 32
MAX_FIELDS_PER_DATASET = 256
MAX_TAGS_PER_DATASET = 16
MAX_EXPR_NODES = 64
MAX_EXPR_DEPTH = 12
MIN_RETENTION_DAYS = 1
MAX_RETENTION_DAYS = 3650

ALLOWED_TYPES = ("bool", "int64", "float64", "string", "enum", "json", "timestamp")
ALLOWED_SEMANTICS = ("state_series", "event_stream", "structured_record")
ALLOWED_SOURCE_KINDS = ("signals", "model_fields", "mixed")
ALLOWED_TIME_AXIS = ("acquired_at", "source_time")
ALLOWED_RECORDING_MODES = ("ON_CHANGE", "EVERY_ACQUISITION", "INTERVAL")
ALLOWED_MISSING_POLICIES = ("GAP_MARKER", "NULL", "HOLD_LAST_WITH_QUALITY")

RESERVED_FIELD_KEYS = frozenset(
    {
        "ts",
        "acquired_at",
        "source_time",
        "raw_quality",
        "reason_code",
        "origin",
        "event_uid",
        "data_epoch",
        "source_seq",
        "record_kind",
    }
)

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_DATASET_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,47}$")
_TAG_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,31}$")
_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$", re.I)
_SIG_TOKEN_RE = re.compile(r"^\{\{sig:([0-9a-fA-F-]{36})\}\}$")
_RES_TOKEN_RE = re.compile(r"^\{\{res:([0-9a-fA-F-]{36})\}\}$")
_MODEL_TOKEN_RE = re.compile(r"^\{\{model:([0-9a-fA-F-]{36}):([^}]+)\}\}$")
_MODEL_DISPLAY_RE = re.compile(r"^\$model\[([^\]]+)\]\.(.+)$")
_SIG_DISPLAY_RE = re.compile(r"^\$([A-Za-z_][A-Za-z0-9_]*)\[((?:\\.|[^\]])+)\]\.(.+)$")
_RES_DISPLAY_RE = re.compile(r"^\$([A-Za-z_][A-Za-z0-9_]*)\[((?:\\.|[^\]])+)\]$")
_FORBIDDEN_TEXT_PATTERNS = (
    re.compile(r"!!python", re.I),
    re.compile(r"__\w+__"),
    re.compile(r"\b(DROP\s+TABLE|DROP\s+STABLE|DROP\s+DATABASE|DELETE\s+FROM|TRUNCATE\s+TABLE|ALTER\s+USER)\b", re.I),
)

_SERIES_NS = UUID("62d2b5c4-4f3d-4361-9a14-e7c5a18a9100")

_SAFE_MATH_FUNCS: dict[str, Any] = {
    "abs": abs,
    "min": min,
    "max": max,
    "round": round,
    "clamp": lambda v, lo, hi: max(lo, min(hi, v)),
    "sqrt": math.sqrt,
    "floor": math.floor,
    "ceil": math.ceil,
}


@dataclass(frozen=True, slots=True)
class DslIssue:
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    path: str = ""
    line: int | None = None
    column: int | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "path": self.path,
        }
        if self.line is not None:
            out["line"] = self.line
        if self.column is not None:
            out["column"] = self.column
        return out


class StorageDslError(ValueError):
    def __init__(self, issues: list[DslIssue]) -> None:
        self.issues = issues
        msg = "; ".join(f"{i.code}: {i.message}" for i in issues[:3])
        super().__init__(msg or "Invalid Storage DSL")


# ==============================================================================
# Duration & identifier helpers
# ==============================================================================


def parse_duration_ms(value: Any, *, field_path: str = "duration", allow_none: bool = False) -> int | None:
    if value is None or value == "":
        if allow_none:
            return None
        raise StorageDslError([DslIssue("error", "INVALID_DURATION", "Duration cannot be empty.", path=field_path)])
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Bare numbers represent seconds consistently across DSL duration fields.
        ms = int(round(float(value) * 1000.0))
        if ms < 0:
            raise StorageDslError([DslIssue("error", "INVALID_DURATION", "Duration must be non-negative.", path=field_path)])
        return ms
    if not isinstance(value, str):
        raise StorageDslError([DslIssue("error", "INVALID_DURATION", f"Unsupported duration {value!r}.", path=field_path)])
    m = _DURATION_RE.match(value)
    if not m:
        raise StorageDslError([DslIssue("error", "INVALID_DURATION", f"Invalid duration syntax {value!r} (expected e.g. 500ms, 60s, 5m, 1h).", path=field_path)])
    amount = float(m.group(1))
    unit = (m.group(2) or "s").lower()
    mult = {"ms": 1.0, "s": 1000.0, "m": 60_000.0, "h": 3_600_000.0, "d": 86_400_000.0}[unit]
    ms = int(round(amount * mult))
    if ms < 0:
        raise StorageDslError([DslIssue("error", "INVALID_DURATION", "Duration must be non-negative.", path=field_path)])
    return ms


def format_duration(ms: int | None) -> str | None:
    if ms is None:
        return None
    if ms % 86_400_000 == 0 and ms > 0:
        return f"{ms // 86_400_000}d"
    if ms % 3_600_000 == 0 and ms > 0:
        return f"{ms // 3_600_000}h"
    if ms % 60_000 == 0 and ms > 0:
        return f"{ms // 60_000}m"
    if ms % 1000 == 0:
        return f"{ms // 1000}s"
    return f"{ms}ms"


def validate_safe_transform(expr: str | None) -> tuple[ast.Expression | None, list[DslIssue]]:
    """Parse and strictly whitelist a scalar transform expression on ``value``."""
    if expr is None or not expr.strip():
        return None, []
    text = expr.strip()
    if len(text) > 512:
        return None, [DslIssue("error", "TRANSFORM_TOO_LONG", "Transform expression exceeds 512 characters.")]
    for pat in _FORBIDDEN_TEXT_PATTERNS:
        if pat.search(text):
            return None, [DslIssue("error", "UNSAFE_TRANSFORM", "Forbidden keyword or construct in transform expression.")]
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        return None, [DslIssue("error", "TRANSFORM_SYNTAX", f"Syntax error: {exc.msg}", line=exc.lineno, column=exc.offset)]

    nodes = 0
    allowed_nodes = (
        ast.Expression,
        ast.BinOp,
        ast.UnaryOp,
        ast.BoolOp,
        ast.Compare,
        ast.IfExp,
        ast.Call,
        ast.Name,
        ast.Load,
        ast.Constant,
        ast.Add,
        ast.Sub,
        ast.Mult,
        ast.Div,
        ast.FloorDiv,
        ast.Mod,
        ast.Pow,
        ast.UAdd,
        ast.USub,
        ast.Not,
        ast.And,
        ast.Or,
        ast.Eq,
        ast.NotEq,
        ast.Lt,
        ast.LtE,
        ast.Gt,
        ast.GtE,
    )

    def _walk(node: ast.AST, depth: int) -> list[DslIssue]:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_EXPR_NODES or depth > MAX_EXPR_DEPTH:
            return [DslIssue("error", "TRANSFORM_COMPLEXITY", "Transform expression exceeds complexity budget.")]
        if not isinstance(node, allowed_nodes):
            return [DslIssue("error", "UNSAFE_TRANSFORM", f"Disallowed syntax element {type(node).__name__}.")]
        if isinstance(node, ast.Name):
            if node.id not in {"value", "null", "true", "false"} and node.id not in _SAFE_MATH_FUNCS:
                return [DslIssue("error", "UNKNOWN_IDENTIFIER", f"Unknown transform identifier {node.id!r}; only 'value' and safe math functions are allowed.")]
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _SAFE_MATH_FUNCS or node.keywords:
                return [DslIssue("error", "UNSAFE_CALL", "Only direct math helper calls without keyword arguments are allowed.")]
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (bytes, complex)):
                return [DslIssue("error", "UNSAFE_CONSTANT", "Unsupported constant type.")]
            if isinstance(node.value, str) and len(node.value) > 256:
                return [DslIssue("error", "STRING_TOO_LONG", "Constant string exceeds 256 chars.")]
        issues: list[DslIssue] = []
        for child in ast.iter_child_nodes(node):
            issues.extend(_walk(child, depth + 1))
        return issues

    issues = _walk(tree, 0)
    return (None if issues else tree), issues


def eval_safe_transform(tree: ast.Expression, value: Any) -> Any:
    if value is None:
        return None
    env: dict[str, Any] = {"value": value, "null": None, "true": True, "false": False}

    def _ev(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return _ev(node.body)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            if node.id in env:
                return env[node.id]
            raise ValueError(node.id)
        if isinstance(node, ast.UnaryOp):
            v = _ev(node.operand)
            if isinstance(node.op, ast.UAdd):
                return +v
            if isinstance(node.op, ast.USub):
                return -v
            if isinstance(node.op, ast.Not):
                return not v
        if isinstance(node, ast.BinOp):
            l, r = _ev(node.left), _ev(node.right)
            if isinstance(node.op, ast.Add):
                return l + r
            if isinstance(node.op, ast.Sub):
                return l - r
            if isinstance(node.op, ast.Mult):
                return l * r
            if isinstance(node.op, ast.Div):
                return None if r == 0 else l / r
            if isinstance(node.op, ast.FloorDiv):
                return None if r == 0 else l // r
            if isinstance(node.op, ast.Mod):
                return None if r == 0 else l % r
            if isinstance(node.op, ast.Pow):
                return l**r
        if isinstance(node, ast.BoolOp):
            if isinstance(node.op, ast.And):
                res: Any = True
                for v in node.values:
                    res = _ev(v)
                    if not res:
                        return res
                return res
            for v in node.values:
                res = _ev(v)
                if res:
                    return res
            return False
        if isinstance(node, ast.Compare):
            left = _ev(node.left)
            for op, comp in zip(node.ops, node.comparators, strict=True):
                right = _ev(comp)
                ok = (
                    (left == right) if isinstance(op, ast.Eq)
                    else (left != right) if isinstance(op, ast.NotEq)
                    else (left < right) if isinstance(op, ast.Lt)
                    else (left <= right) if isinstance(op, ast.LtE)
                    else (left > right) if isinstance(op, ast.Gt)
                    else (left >= right)
                )
                if not ok:
                    return False
                left = right
            return True
        if isinstance(node, ast.IfExp):
            return _ev(node.body) if _ev(node.test) else _ev(node.orelse)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            fn = _SAFE_MATH_FUNCS[node.func.id]
            return fn(*[_ev(a) for a in node.args])
        raise ValueError(type(node).__name__)

    return _ev(tree)


# ==============================================================================
# Canonical AST Data Model
# ==============================================================================


@dataclass(frozen=True, slots=True)
class DesignMetadata:
    name: str
    description: str = ""
    owner: str | None = None
    labels: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ScopeSpec:
    mode: Literal["all_sites", "site", "subtree", "resources"] = "all_sites"
    resource: str | None = None
    site_id: str | None = None
    resource_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class DestinationSpec:
    engine: str = "tdengine"
    db_strategy: str = "tenant_isolated"


@dataclass(frozen=True, slots=True)
class TagSpec:
    key: str
    value: str = ""


@dataclass(frozen=True, slots=True)
class DeadbandSpec:
    kind: Literal["absolute", "percent"] = "absolute"
    value: float = 0.0


@dataclass(frozen=True, slots=True)
class RecordingSpec:
    mode: Literal["ON_CHANGE", "EVERY_ACQUISITION", "INTERVAL"] = "ON_CHANGE"
    quality_transitions: bool = True
    deadband: DeadbandSpec | None = None
    max_checkpoint_interval: str | None = "60s"
    interval: str | None = None
    late_tolerance: str | None = "300s"
    missing_policy: Literal["GAP_MARKER", "NULL", "HOLD_LAST_WITH_QUALITY"] = "GAP_MARKER"


@dataclass(frozen=True, slots=True)
class RetentionSpec:
    days: int = 90
    legal_hold: bool = False


@dataclass(frozen=True, slots=True)
class FieldAst:
    key: str
    from_ref: str
    type: str = "float64"
    display_name: str = ""
    description: str = ""
    nullable: bool = True
    required: bool = False
    unit: str | None = None
    max_length: int | None = None
    transform: str | None = None
    source_kind: Literal["signal", "model_field", "constant", "expression"] = "signal"
    signal_id: str | None = None
    model_id: str | None = None
    model_field_path: str | None = None
    resource_id: str | None = None
    source_revision: int = 1


@dataclass(frozen=True, slots=True)
class RelationshipAst:
    id: str
    from_node: str
    to_node: str
    kind: Literal["derived_from", "belongs_to", "references", "mapped_from"] = "mapped_from"
    description: str = ""


@dataclass(frozen=True, slots=True)
class DatasetAst:
    key: str
    semantics: Literal["state_series", "event_stream", "structured_record"] = "state_series"
    source_kind: Literal["signals", "model_fields", "mixed"] = "signals"
    time_axis: Literal["acquired_at", "source_time"] = "acquired_at"
    display_name: str = ""
    description: str = ""
    id: str | None = None
    tags: tuple[TagSpec, ...] = ()
    fields: tuple[FieldAst, ...] = ()
    relationships: tuple[RelationshipAst, ...] = ()
    recording: RecordingSpec = field(default_factory=RecordingSpec)
    retention: RetentionSpec = field(default_factory=RetentionSpec)


@dataclass(frozen=True, slots=True)
class DesignSpec:
    scope: ScopeSpec = field(default_factory=ScopeSpec)
    destination: DestinationSpec = field(default_factory=DestinationSpec)
    datasets: tuple[DatasetAst, ...] = ()
    ui_meta: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class StorageDesignAst:
    api_version: str
    kind: str
    metadata: DesignMetadata
    spec: DesignSpec

    def to_dict(self, *, include_ui_meta: bool = True) -> dict[str, Any]:
        datasets_out: list[dict[str, Any]] = []
        for ds in self.spec.datasets:
            fields_out: list[dict[str, Any]] = []
            for f in ds.fields:
                fd: dict[str, Any] = {
                    "key": f.key,
                    "from": f.from_ref,
                    "type": f.type,
                    "sourceKind": f.source_kind,
                    "nullable": f.nullable,
                    "required": f.required,
                }
                if f.display_name:
                    fd["displayName"] = f.display_name
                if f.description:
                    fd["description"] = f.description
                if f.unit is not None:
                    fd["unit"] = f.unit
                if f.max_length is not None:
                    fd["maxLength"] = f.max_length
                if f.transform is not None:
                    fd["transform"] = f.transform
                if f.signal_id is not None:
                    fd["signalId"] = f.signal_id
                if f.model_id is not None:
                    fd["modelId"] = f.model_id
                if f.model_field_path is not None:
                    fd["modelFieldPath"] = f.model_field_path
                if f.resource_id is not None:
                    fd["resourceId"] = f.resource_id
                if f.source_revision != 1:
                    fd["sourceRevision"] = f.source_revision
                fields_out.append(fd)

            rec_d: dict[str, Any] = {
                "mode": ds.recording.mode,
                "qualityTransitions": ds.recording.quality_transitions,
                "missingPolicy": ds.recording.missing_policy,
            }
            if ds.recording.deadband is not None:
                rec_d["deadband"] = {"kind": ds.recording.deadband.kind, "value": ds.recording.deadband.value}
            if ds.recording.max_checkpoint_interval is not None:
                rec_d["maxCheckpointInterval"] = ds.recording.max_checkpoint_interval
            if ds.recording.interval is not None:
                rec_d["interval"] = ds.recording.interval
            if ds.recording.late_tolerance is not None:
                rec_d["lateTolerance"] = ds.recording.late_tolerance

            ds_d: dict[str, Any] = {
                "key": ds.key,
                "semantics": ds.semantics,
                "sourceKind": ds.source_kind,
                "timeAxis": ds.time_axis,
                "fields": fields_out,
                "recording": rec_d,
                "retention": {"days": ds.retention.days, "legalHold": ds.retention.legal_hold},
            }
            if ds.id is not None:
                ds_d["id"] = ds.id
            if ds.display_name:
                ds_d["displayName"] = ds.display_name
            if ds.description:
                ds_d["description"] = ds.description
            if ds.tags:
                ds_d["tags"] = [{"key": t.key, "value": t.value} for t in ds.tags]
            if ds.relationships:
                ds_d["relationships"] = [
                    {
                        "id": r.id,
                        "from": r.from_node,
                        "to": r.to_node,
                        "kind": r.kind,
                        **({"description": r.description} if r.description else {}),
                    }
                    for r in ds.relationships
                ]
            datasets_out.append(ds_d)

        scope_d: dict[str, Any] = {"mode": self.spec.scope.mode}
        if self.spec.scope.resource is not None:
            scope_d["resource"] = self.spec.scope.resource
        if self.spec.scope.site_id is not None:
            scope_d["siteId"] = self.spec.scope.site_id
        if self.spec.scope.resource_ids:
            scope_d["resourceIds"] = list(self.spec.scope.resource_ids)

        meta_d: dict[str, Any] = {"name": self.metadata.name}
        if self.metadata.description:
            meta_d["description"] = self.metadata.description
        if self.metadata.owner is not None:
            meta_d["owner"] = self.metadata.owner
        if self.metadata.labels:
            meta_d["labels"] = dict(sorted(self.metadata.labels.items()))

        spec_d: dict[str, Any] = {
            "scope": scope_d,
            "destination": {
                "engine": self.spec.destination.engine,
                "dbStrategy": self.spec.destination.db_strategy,
            },
            "datasets": datasets_out,
        }
        if include_ui_meta and self.spec.ui_meta:
            spec_d["uiMeta"] = _canonicalize_obj(self.spec.ui_meta)

        return {
            "apiVersion": self.api_version,
            "kind": self.kind,
            "metadata": meta_d,
            "spec": spec_d,
        }

    def semantic_hash(self) -> str:
        raw = json.dumps(self.to_dict(include_ui_meta=False), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def full_hash(self) -> str:
        raw = json.dumps(self.to_dict(include_ui_meta=True), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _canonicalize_obj(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _canonicalize_obj(v) for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, list):
        return [_canonicalize_obj(v) for v in value]
    return value


def _check_depth(obj: Any, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise StorageDslError([DslIssue("error", "MAX_DEPTH_EXCEEDED", f"DSL nesting exceeds max depth {MAX_DEPTH}.")])
    if isinstance(obj, Mapping):
        for v in obj.values():
            _check_depth(v, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            _check_depth(item, depth + 1)


def parse_storage_dsl(source: str | Mapping[str, Any], *, input_format: Literal["auto", "yaml", "json"] = "auto") -> StorageDesignAst:
    """Parse YAML, JSON, or dict into a canonical ``StorageDesignAst``. Strictly safe; zero code execution."""
    if isinstance(source, str):
        raw_bytes = source.encode("utf-8")
        if len(raw_bytes) > MAX_DSL_BYTES:
            raise StorageDslError([DslIssue("error", "DSL_TOO_LARGE", f"DSL text exceeds {MAX_DSL_BYTES} bytes.")])
        for pat in _FORBIDDEN_TEXT_PATTERNS:
            m = pat.search(source)
            if m:
                line = source.count("\n", 0, m.start()) + 1
                raise StorageDslError([DslIssue("error", "UNSAFE_DSL_CONTENT", f"Forbidden directive {m.group(0)!r} in declarative DSL.", line=line)])
        try:
            if input_format == "json" or (input_format == "auto" and source.lstrip().startswith("{")):
                doc = json.loads(source)
            else:
                doc = yaml.safe_load(source)
        except json.JSONDecodeError as exc:
            raise StorageDslError([DslIssue("error", "SYNTAX_ERROR", exc.msg, line=exc.lineno, column=exc.colno)]) from exc
        except yaml.YAMLError as exc:
            mark = getattr(exc, "problem_mark", None)
            line = (mark.line + 1) if mark is not None else None
            col = (mark.column + 1) if mark is not None else None
            raise StorageDslError([DslIssue("error", "SYNTAX_ERROR", str(exc), line=line, column=col)]) from exc
    elif isinstance(source, Mapping):
        doc = dict(source)
    else:
        raise StorageDslError([DslIssue("error", "INVALID_INPUT", "Expected YAML/JSON string or mapping.")])

    if not isinstance(doc, Mapping):
        raise StorageDslError([DslIssue("error", "INVALID_ROOT", "Top-level Storage DSL document must be a mapping/object.")])
    _check_depth(doc)

    issues: list[DslIssue] = []
    api_version = str(doc.get("apiVersion") or doc.get("api_version") or API_VERSION)
    if api_version != API_VERSION:
        issues.append(DslIssue("error", "UNSUPPORTED_API_VERSION", f"Expected apiVersion {API_VERSION!r}, got {api_version!r}.", path="apiVersion"))
    kind = str(doc.get("kind") or DESIGN_KIND)
    if kind != DESIGN_KIND:
        issues.append(DslIssue("error", "UNSUPPORTED_KIND", f"Expected kind {DESIGN_KIND!r}, got {kind!r}.", path="kind"))

    meta_raw = doc.get("metadata") or {}
    if not isinstance(meta_raw, Mapping):
        issues.append(DslIssue("error", "INVALID_METADATA", "metadata must be an object.", path="metadata"))
        meta_raw = {}
    name = str(meta_raw.get("name") or "").strip()
    if not name:
        issues.append(DslIssue("error", "MISSING_NAME", "metadata.name is required.", path="metadata.name"))
    elif len(name) > 120:
        issues.append(DslIssue("error", "NAME_TOO_LONG", "metadata.name must be <= 120 characters.", path="metadata.name"))
    labels_raw = meta_raw.get("labels") or {}
    labels = {str(k): str(v) for k, v in labels_raw.items()} if isinstance(labels_raw, Mapping) else {}
    metadata = DesignMetadata(
        name=name,
        description=str(meta_raw.get("description") or "").strip(),
        owner=str(meta_raw["owner"]).strip() if meta_raw.get("owner") is not None else None,
        labels=labels,
    )

    spec_raw = doc.get("spec")
    if not isinstance(spec_raw, Mapping):
        raise StorageDslError(issues + [DslIssue("error", "MISSING_SPEC", "spec object is required.", path="spec")])

    # Scope
    scope_raw = spec_raw.get("scope") or {}
    if not isinstance(scope_raw, Mapping):
        issues.append(DslIssue("error", "INVALID_SCOPE", "spec.scope must be an object.", path="spec.scope"))
        scope_raw = {}
    res_ref = scope_raw.get("resource")
    res_ids_raw = scope_raw.get("resourceIds") if "resourceIds" in scope_raw else scope_raw.get("resource_ids", [])
    res_ids = tuple(str(x) for x in res_ids_raw) if isinstance(res_ids_raw, (list, tuple)) else ()
    raw_mode = scope_raw.get("mode")
    if raw_mode is None:
        raw_mode = "subtree" if res_ref else ("resources" if res_ids else ("site" if scope_raw.get("siteId") or scope_raw.get("site_id") else "all_sites"))
    if raw_mode not in {"all_sites", "site", "subtree", "resources"}:
        issues.append(DslIssue("error", "INVALID_SCOPE_MODE", f"Unsupported scope.mode {raw_mode!r}.", path="spec.scope.mode"))
        raw_mode = "all_sites"
    scope = ScopeSpec(
        mode=raw_mode,
        resource=str(res_ref).strip() if res_ref is not None else None,
        site_id=str(scope_raw.get("siteId") or scope_raw.get("site_id")).strip() if (scope_raw.get("siteId") or scope_raw.get("site_id")) else None,
        resource_ids=res_ids,
    )

    # Destination (RabbitMQ explicitly forbidden as destination!)
    dest_raw = spec_raw.get("destination") or {}
    if not isinstance(dest_raw, Mapping):
        issues.append(DslIssue("error", "INVALID_DESTINATION", "spec.destination must be an object.", path="spec.destination"))
        dest_raw = {}
    engine = str(dest_raw.get("engine") or "tdengine").strip().lower()
    if engine != "tdengine":
        msg = (
            "RabbitMQ is an acquisition transport broker, NOT a valid Historian storage destination; choose 'tdengine'."
            if "rabbit" in engine or "amqp" in engine or "broker" in engine
            else f"Unsupported storage destination {engine!r}; only 'tdengine' is supported."
        )
        issues.append(DslIssue("error", "INVALID_DESTINATION", msg, path="spec.destination.engine"))
    destination = DestinationSpec(
        engine=engine,
        db_strategy=str(dest_raw.get("dbStrategy") or dest_raw.get("db_strategy") or "tenant_isolated"),
    )

    # Datasets
    ds_list = spec_raw.get("datasets")
    if not isinstance(ds_list, list) or not ds_list:
        issues.append(DslIssue("error", "MISSING_DATASETS", "spec.datasets must contain at least one dataset.", path="spec.datasets"))
        ds_list = []
    elif len(ds_list) > MAX_DATASETS:
        issues.append(DslIssue("error", "TOO_MANY_DATASETS", f"Maximum {MAX_DATASETS} datasets per design.", path="spec.datasets"))

    datasets: list[DatasetAst] = []
    seen_ds_keys: set[str] = set()
    for ds_idx, ds_raw in enumerate(ds_list):
        ds_path = f"spec.datasets[{ds_idx}]"
        if not isinstance(ds_raw, Mapping):
            issues.append(DslIssue("error", "INVALID_DATASET", "Dataset must be an object.", path=ds_path))
            continue
        ds_key = str(ds_raw.get("key") or "").strip()
        if not _DATASET_KEY_RE.match(ds_key):
            issues.append(DslIssue("error", "INVALID_DATASET_KEY", f"Invalid dataset key {ds_key!r}. Use letters, digits, underscores starting with a letter/underscore.", path=f"{ds_path}.key"))
        if ds_key.lower() in seen_ds_keys:
            issues.append(DslIssue("error", "DUPLICATE_DATASET_KEY", f"Duplicate dataset key {ds_key!r}.", path=f"{ds_path}.key"))
        seen_ds_keys.add(ds_key.lower())

        semantics = str(ds_raw.get("semantics") or "state_series").strip()
        if semantics not in ALLOWED_SEMANTICS:
            issues.append(DslIssue("error", "INVALID_SEMANTICS", f"Unsupported semantics {semantics!r}.", path=f"{ds_path}.semantics"))
            semantics = "state_series"
        source_kind = str(ds_raw.get("sourceKind") or ds_raw.get("source_kind") or "signals").strip()
        if source_kind not in ALLOWED_SOURCE_KINDS:
            issues.append(DslIssue("error", "INVALID_SOURCE_KIND", f"Unsupported sourceKind {source_kind!r}.", path=f"{ds_path}.sourceKind"))
            source_kind = "signals"
        time_axis = str(ds_raw.get("timeAxis") or ds_raw.get("time_axis") or "acquired_at").strip()
        if time_axis not in ALLOWED_TIME_AXIS:
            issues.append(DslIssue("error", "INVALID_TIME_AXIS", f"Unsupported timeAxis {time_axis!r}.", path=f"{ds_path}.timeAxis"))
            time_axis = "acquired_at"

        # Tags
        tags_raw = ds_raw.get("tags") or []
        if not isinstance(tags_raw, list):
            issues.append(DslIssue("error", "INVALID_TAGS", "tags must be a list.", path=f"{ds_path}.tags"))
            tags_raw = []
        elif len(tags_raw) > MAX_TAGS_PER_DATASET:
            issues.append(DslIssue("error", "TOO_MANY_TAGS", f"Maximum {MAX_TAGS_PER_DATASET} metadata tags per dataset.", path=f"{ds_path}.tags"))
        tags: list[TagSpec] = []
        seen_tags: set[str] = set()
        for t_idx, t_raw in enumerate(tags_raw):
            if not isinstance(t_raw, Mapping):
                issues.append(DslIssue("error", "INVALID_TAG", "Tag entry must be an object.", path=f"{ds_path}.tags[{t_idx}]"))
                continue
            tk = str(t_raw.get("key") or "").strip()
            if not _TAG_KEY_RE.match(tk):
                issues.append(DslIssue("error", "INVALID_TAG_KEY", f"Invalid tag key {tk!r}.", path=f"{ds_path}.tags[{t_idx}].key"))
            if tk.lower() in seen_tags:
                issues.append(DslIssue("error", "DUPLICATE_TAG_KEY", f"Duplicate tag key {tk!r}.", path=f"{ds_path}.tags[{t_idx}].key"))
            seen_tags.add(tk.lower())
            tv = str(t_raw.get("value") or "")
            if len(tv) > 128:
                issues.append(DslIssue("error", "TAG_VALUE_TOO_LONG", "Tag value exceeds 128 characters.", path=f"{ds_path}.tags[{t_idx}].value"))
            tags.append(TagSpec(key=tk, value=tv))

        # Fields
        fields_raw = ds_raw.get("fields") or []
        if not isinstance(fields_raw, list) or not fields_raw:
            issues.append(DslIssue("error", "EMPTY_FIELDS", f"Dataset {ds_key or ds_idx!r} must declare at least one field.", path=f"{ds_path}.fields"))
            fields_raw = []
        elif len(fields_raw) > MAX_FIELDS_PER_DATASET:
            issues.append(DslIssue("error", "TOO_MANY_FIELDS", f"Dataset exceeds {MAX_FIELDS_PER_DATASET} fields.", path=f"{ds_path}.fields"))
        fields: list[FieldAst] = []
        seen_fields: set[str] = set()
        for f_idx, f_raw in enumerate(fields_raw):
            fp = f"{ds_path}.fields[{f_idx}]"
            if not isinstance(f_raw, Mapping):
                issues.append(DslIssue("error", "INVALID_FIELD", "Field entry must be an object.", path=fp))
                continue
            fk = str(f_raw.get("key") or "").strip()
            if not _IDENT_RE.match(fk):
                issues.append(DslIssue("error", "INVALID_FIELD_KEY", f"Invalid field key {fk!r}.", path=f"{fp}.key"))
            elif fk.lower() in RESERVED_FIELD_KEYS:
                issues.append(DslIssue("error", "RESERVED_FIELD_KEY", f"Field key {fk!r} is reserved for system columns.", path=f"{fp}.key"))
            if fk.lower() in seen_fields:
                issues.append(DslIssue("error", "DUPLICATE_FIELD_KEY", f"Duplicate field key {fk!r}.", path=f"{fp}.key"))
            seen_fields.add(fk.lower())

            ftype = str(f_raw.get("type") or f_raw.get("valueType") or f_raw.get("value_type") or "float64").strip()
            if ftype not in ALLOWED_TYPES:
                issues.append(DslIssue("error", "INVALID_FIELD_TYPE", f"Unsupported field type {ftype!r}.", path=f"{fp}.type"))
            from_ref = str(f_raw.get("from") or f_raw.get("fromRef") or f_raw.get("from_ref") or "").strip()
            f_source_kind = str(f_raw.get("sourceKind") or f_raw.get("source_kind") or ("model_field" if from_ref.startswith(("$model[", "{{model:")) else "signal")).strip()
            if f_source_kind not in ("signal", "model_field", "constant", "expression"):
                issues.append(DslIssue("error", "INVALID_SOURCE_KIND", f"Invalid field sourceKind {f_source_kind!r}.", path=f"{fp}.sourceKind"))
                f_source_kind = "signal"
            if not from_ref and f_source_kind in ("signal", "model_field"):
                issues.append(DslIssue("error", "MISSING_SOURCE_REF", f"Field {fk!r} must bind a source reference via 'from'.", path=f"{fp}.from"))

            max_len = f_raw.get("maxLength") if "maxLength" in f_raw else f_raw.get("max_length")
            max_allowed_len = 60000 if ftype == "json" else 15000
            if max_len is not None:
                if isinstance(max_len, bool) or not isinstance(max_len, int) or max_len < 1 or max_len > max_allowed_len:
                    issues.append(DslIssue("error", "INVALID_MAX_LENGTH", f"maxLength must be an integer between 1 and {max_allowed_len}.", path=f"{fp}.maxLength"))
                    max_len = None
            transform = f_raw.get("transform")
            if transform is not None:
                _, t_issues = validate_safe_transform(str(transform))
                for ti in t_issues:
                    issues.append(DslIssue(ti.severity, ti.code, ti.message, path=f"{fp}.transform", line=ti.line, column=ti.column))

            fields.append(
                FieldAst(
                    key=fk,
                    from_ref=from_ref,
                    type=ftype,
                    display_name=str(f_raw.get("displayName") or f_raw.get("display_name") or "").strip(),
                    description=str(f_raw.get("description") or "").strip(),
                    nullable=bool(f_raw.get("nullable", True)),
                    required=bool(f_raw.get("required", False)),
                    unit=str(f_raw["unit"]) if f_raw.get("unit") is not None else None,
                    max_length=max_len,
                    transform=str(transform).strip() if transform is not None else None,
                    source_kind=f_source_kind,  # type: ignore[arg-type]
                    signal_id=str(f_raw["signalId"]).lower() if f_raw.get("signalId") else None,
                    model_id=str(f_raw["modelId"]).lower() if f_raw.get("modelId") else None,
                    model_field_path=str(f_raw["modelFieldPath"]) if f_raw.get("modelFieldPath") else None,
                    resource_id=str(f_raw["resourceId"]).lower() if f_raw.get("resourceId") else None,
                    source_revision=int(f_raw.get("sourceRevision") or 1),
                )
            )

        # Relationships
        rels_raw = ds_raw.get("relationships") or []
        relationships: list[RelationshipAst] = []
        if isinstance(rels_raw, list):
            for r_idx, r_raw in enumerate(rels_raw):
                if not isinstance(r_raw, Mapping):
                    issues.append(DslIssue("error", "INVALID_RELATIONSHIP", "Relationship must be an object.", path=f"{ds_path}.relationships[{r_idx}]"))
                    continue
                rk = str(r_raw.get("kind") or "mapped_from").strip()
                if rk not in {"derived_from", "belongs_to", "references", "mapped_from"}:
                    issues.append(DslIssue("error", "INVALID_RELATIONSHIP_KIND", f"Invalid relationship kind {rk!r}.", path=f"{ds_path}.relationships[{r_idx}].kind"))
                    rk = "mapped_from"
                relationships.append(
                    RelationshipAst(
                        id=str(r_raw.get("id") or f"rel-{r_idx}"),
                        from_node=str(r_raw.get("from") or ""),
                        to_node=str(r_raw.get("to") or ""),
                        kind=rk,  # type: ignore[arg-type]
                        description=str(r_raw.get("description") or ""),
                    )
                )

        # Recording policy
        rec_raw = ds_raw.get("recording") or {}
        if not isinstance(rec_raw, Mapping):
            issues.append(DslIssue("error", "INVALID_RECORDING", "recording must be an object.", path=f"{ds_path}.recording"))
            rec_raw = {}
        mode = str(rec_raw.get("mode") or "ON_CHANGE").strip().upper()
        if mode not in ALLOWED_RECORDING_MODES:
            issues.append(DslIssue("error", "INVALID_RECORDING_MODE", f"Unsupported recording mode {mode!r}.", path=f"{ds_path}.recording.mode"))
            mode = "ON_CHANGE"
        q_trans = rec_raw.get("qualityTransitions", rec_raw.get("quality_transitions", True))
        if q_trans is not True:
            issues.append(DslIssue("error", "QUALITY_TRANSITIONS_MANDATORY", "qualityTransitions cannot be disabled; quality changes must always be recorded.", path=f"{ds_path}.recording.qualityTransitions"))

        deadband_spec: DeadbandSpec | None = None
        db_raw = rec_raw.get("deadband")
        if db_raw is not None:
            if isinstance(db_raw, (int, float)) and not isinstance(db_raw, bool):
                val = float(db_raw)
                if val < 0 or not math.isfinite(val):
                    issues.append(DslIssue("error", "INVALID_DEADBAND", "Deadband must be finite and >= 0.", path=f"{ds_path}.recording.deadband"))
                deadband_spec = DeadbandSpec(kind="absolute", value=max(0.0, val))
            elif isinstance(db_raw, Mapping):
                dk = str(db_raw.get("kind") or "absolute").strip().lower()
                if dk not in {"absolute", "percent"}:
                    issues.append(DslIssue("error", "INVALID_DEADBAND_KIND", f"Deadband kind must be 'absolute' or 'percent', got {dk!r}.", path=f"{ds_path}.recording.deadband.kind"))
                    dk = "absolute"
                dv = db_raw.get("value", 0.0)
                if isinstance(dv, bool) or not isinstance(dv, (int, float)) or not math.isfinite(float(dv)) or float(dv) < 0:
                    issues.append(DslIssue("error", "INVALID_DEADBAND", "Deadband value must be finite and >= 0.", path=f"{ds_path}.recording.deadband.value"))
                    dv = 0.0
                elif dk == "percent" and float(dv) > 100.0:
                    issues.append(DslIssue("error", "INVALID_DEADBAND", "Percent deadband cannot exceed 100%.", path=f"{ds_path}.recording.deadband.value"))
                deadband_spec = DeadbandSpec(kind=dk, value=float(dv))  # type: ignore[arg-type]
            else:
                issues.append(DslIssue("error", "INVALID_DEADBAND", "deadband must be a non-negative number or {kind, value}.", path=f"{ds_path}.recording.deadband"))

        if deadband_spec is not None and deadband_spec.value > 0:
            has_numeric = any(f.type in {"int64", "float64"} for f in fields)
            if fields and not has_numeric:
                issues.append(DslIssue("error", "INVALID_DEADBAND_TYPE", "Numeric deadband cannot be configured on a dataset with no numeric fields.", path=f"{ds_path}.recording.deadband"))

        missing_pol = str(rec_raw.get("missingPolicy") or rec_raw.get("missing_policy") or "GAP_MARKER").strip().upper()
        if missing_pol not in ALLOWED_MISSING_POLICIES:
            issues.append(DslIssue("error", "INVALID_MISSING_POLICY", f"Unsupported missingPolicy {missing_pol!r}.", path=f"{ds_path}.recording.missingPolicy"))
            missing_pol = "GAP_MARKER"

        raw_cp = rec_raw.get("maxCheckpointInterval", rec_raw.get("max_checkpoint_interval", "60s"))
        cp_fmt: str | None = None
        if raw_cp is not None and raw_cp != "":
            try:
                cp_ms = parse_duration_ms(raw_cp, field_path=f"{ds_path}.recording.maxCheckpointInterval")
                cp_fmt = format_duration(cp_ms)
            except StorageDslError as exc:
                issues.extend(exc.issues)

        raw_intv = rec_raw.get("interval")
        intv_fmt: str | None = None
        if raw_intv is not None and raw_intv != "":
            try:
                intv_ms = parse_duration_ms(raw_intv, field_path=f"{ds_path}.recording.interval")
                if intv_ms is not None and (intv_ms < 100 or intv_ms > 86_400_000):
                    issues.append(DslIssue("error", "INVALID_INTERVAL", "INTERVAL duration must be between 100ms and 24h.", path=f"{ds_path}.recording.interval"))
                intv_fmt = format_duration(intv_ms)
            except StorageDslError as exc:
                issues.extend(exc.issues)
        elif mode == "INTERVAL":
            issues.append(DslIssue("error", "MISSING_INTERVAL", "INTERVAL recording mode requires 'recording.interval'.", path=f"{ds_path}.recording.interval"))

        raw_late = rec_raw.get("lateTolerance", rec_raw.get("late_tolerance", "300s"))
        late_fmt: str | None = None
        if raw_late is not None and raw_late != "":
            try:
                late_ms = parse_duration_ms(raw_late, field_path=f"{ds_path}.recording.lateTolerance")
                late_fmt = format_duration(late_ms)
            except StorageDslError as exc:
                issues.extend(exc.issues)

        # Retention
        ret_raw = ds_raw.get("retention") or {}
        if not isinstance(ret_raw, Mapping):
            issues.append(DslIssue("error", "INVALID_RETENTION", "retention must be an object.", path=f"{ds_path}.retention"))
            ret_raw = {}
        ret_days = ret_raw.get("days", 90)
        if isinstance(ret_days, bool) or not isinstance(ret_days, int) or not (MIN_RETENTION_DAYS <= ret_days <= MAX_RETENTION_DAYS):
            issues.append(DslIssue("error", "INVALID_RETENTION_DAYS", f"retention.days must be an integer between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS}.", path=f"{ds_path}.retention.days"))
            ret_days = 90
        legal_hold = bool(ret_raw.get("legalHold", ret_raw.get("legal_hold", False)))

        datasets.append(
            DatasetAst(
                id=str(ds_raw["id"]).lower() if ds_raw.get("id") else None,
                key=ds_key,
                semantics=semantics,  # type: ignore[arg-type]
                source_kind=source_kind,  # type: ignore[arg-type]
                time_axis=time_axis,  # type: ignore[arg-type]
                display_name=str(ds_raw.get("displayName") or ds_raw.get("display_name") or "").strip(),
                description=str(ds_raw.get("description") or "").strip(),
                tags=tuple(tags),
                fields=tuple(fields),
                relationships=tuple(relationships),
                recording=RecordingSpec(
                    mode=mode,  # type: ignore[arg-type]
                    quality_transitions=bool(q_trans),
                    deadband=deadband_spec,
                    max_checkpoint_interval=cp_fmt,
                    interval=intv_fmt,
                    late_tolerance=late_fmt,
                    missing_policy=missing_pol,  # type: ignore[arg-type]
                ),
                retention=RetentionSpec(days=ret_days, legal_hold=legal_hold),
            )
        )

    if issues:
        raise StorageDslError(issues)

    ui_meta_raw = spec_raw.get("uiMeta") if "uiMeta" in spec_raw else spec_raw.get("ui_meta", {})
    ui_meta = _canonicalize_obj(ui_meta_raw) if isinstance(ui_meta_raw, Mapping) else {}
    return StorageDesignAst(
        api_version=API_VERSION,
        kind=DESIGN_KIND,
        metadata=metadata,
        spec=DesignSpec(scope=scope, destination=destination, datasets=tuple(datasets), ui_meta=ui_meta),
    )


def serialize_storage_dsl(
    design: StorageDesignAst,
    *,
    output_format: Literal["yaml", "json"] = "yaml",
    include_ui_meta: bool = True,
) -> str:
    """Lossless canonical YAML or JSON serialization matching ``parse_storage_dsl`` identically."""
    payload = design.to_dict(include_ui_meta=include_ui_meta)
    if output_format == "json":
        return json.dumps(payload, indent=2, sort_keys=False, ensure_ascii=False)
    return yaml.safe_dump(payload, sort_keys=False, allow_unicode=True, default_flow_style=False)


# ==============================================================================
# Catalog Reference Resolution
# ==============================================================================


@dataclass(frozen=True, slots=True)
class CatalogSignal:
    id: str
    resource_id: str
    resource_name: str
    type_key: str
    key: str
    data_type: str
    unit: str | None = None
    active: bool = True
    binding_enabled: bool = True
    expected_interval_ms: int | None = None
    revision: int = 1


@dataclass(frozen=True, slots=True)
class CatalogResource:
    id: str
    type_key: str
    name: str
    code: str
    site_id: str | None = None
    active: bool = True


@dataclass(frozen=True, slots=True)
class CatalogModel:
    id: str
    display_name: str
    field_paths: dict[str, str] = field(default_factory=dict)  # path -> value_type
    active: bool = True


@dataclass(frozen=True, slots=True)
class StorageCatalogSnapshot:
    resources: Sequence[CatalogResource] = ()
    signals: Sequence[CatalogSignal] = ()
    models: Sequence[CatalogModel] = ()


def _unescape_bracket(raw: str) -> str:
    return raw.replace(r"\]", "]").replace(r"\[", "[").replace(r"\\", "\\")


def _strip_backticks(raw: str) -> str:
    text = raw.strip()
    if len(text) >= 2 and text.startswith("`") and text.endswith("`"):
        return text[1:-1].replace(r"\`", "`").replace(r"\\", "\\")
    return text


def _types_compatible(source_type: str, target_type: str, has_transform: bool) -> tuple[bool, str | None]:
    if source_type == target_type:
        return True, None
    if has_transform and target_type in {"float64", "int64", "bool"} and source_type in {"float64", "int64", "bool"}:
        return True, None
    if source_type == "int64" and target_type == "float64":
        return True, None
    if source_type == "bool" and target_type in {"int64", "float64"}:
        return True, None
    if source_type in {"string", "enum"} and target_type in {"string", "enum"}:
        return True, None
    if target_type == "json":
        return True, None
    return False, f"Source data_type {source_type!r} cannot map losslessly into field type {target_type!r}."


def resolve_and_validate_design(
    design: StorageDesignAst,
    catalog: StorageCatalogSnapshot,
) -> tuple[StorageDesignAst, list[DslIssue]]:
    """Resolve symbolic references to immutable UUIDs and validate semantic integrity."""
    issues: list[DslIssue] = []

    res_by_id = {r.id.lower(): r for r in catalog.resources}
    sig_by_id = {s.id.lower(): s for s in catalog.signals}
    mod_by_id = {m.id.lower(): m for m in catalog.models}

    # Lookup indices for display refs
    res_by_type_name: dict[tuple[str, str], list[CatalogResource]] = {}
    for r in catalog.resources:
        res_by_type_name.setdefault((r.type_key.lower(), r.name.lower()), []).append(r)

    sig_by_res_key: dict[tuple[str, str], list[CatalogSignal]] = {}
    for s in catalog.signals:
        sig_by_res_key.setdefault((s.resource_id.lower(), s.key), []).append(s)

    mod_by_name: dict[str, list[CatalogModel]] = {}
    for m in catalog.models:
        mod_by_name.setdefault(m.display_name.lower(), []).append(m)

    # Validate scope resource if present
    resolved_scope_ids = list(design.spec.scope.resource_ids)
    if design.spec.scope.resource:
        raw_res = design.spec.scope.resource.strip()
        m_tok = _RES_TOKEN_RE.match(raw_res)
        m_disp = _RES_DISPLAY_RE.match(raw_res)
        if m_tok:
            rid = m_tok.group(1).lower()
            if rid not in res_by_id:
                issues.append(DslIssue("error", "SCOPE_RESOURCE_NOT_FOUND", f"Scope resource ID {rid} does not exist.", path="spec.scope.resource"))
            elif not res_by_id[rid].active:
                issues.append(DslIssue("warning", "SCOPE_RESOURCE_ARCHIVED", f"Scope resource {res_by_id[rid].name!r} is archived.", path="spec.scope.resource"))
            elif rid not in resolved_scope_ids:
                resolved_scope_ids.append(rid)
        elif m_disp:
            tkey, rname = m_disp.group(1).lower(), _unescape_bracket(m_disp.group(2)).lower()
            matches = res_by_type_name.get((tkey, rname), [])
            if not matches:
                issues.append(DslIssue("error", "SCOPE_RESOURCE_NOT_FOUND", f"Scope resource {raw_res!r} not found in catalog.", path="spec.scope.resource"))
            elif len(matches) > 1:
                issues.append(DslIssue("error", "AMBIGUOUS_RESOURCE", f"Multiple resources match {raw_res!r}; use canonical resource UUID.", path="spec.scope.resource"))
            else:
                if not matches[0].active:
                    issues.append(DslIssue("warning", "SCOPE_RESOURCE_ARCHIVED", f"Scope resource {matches[0].name!r} is archived.", path="spec.scope.resource"))
                if matches[0].id.lower() not in resolved_scope_ids:
                    resolved_scope_ids.append(matches[0].id.lower())
        else:
            issues.append(DslIssue("error", "INVALID_SCOPE_REF", f"Invalid scope resource selector {raw_res!r}.", path="spec.scope.resource"))

    updated_datasets: list[DatasetAst] = []
    for ds_idx, ds in enumerate(design.spec.datasets):
        ds_path = f"spec.datasets[{ds_idx}]"
        if ds.recording.mode in {"ON_CHANGE", "INTERVAL"}:
            issues.append(
                DslIssue(
                    "warning" if ds.recording.mode == "ON_CHANGE" else "info",
                    "EXACT_AGGREGATION_USES_OPERATIONAL_TIER",
                    f"Dataset {ds.key!r} uses {ds.recording.mode}; exact sample-weighted avg/count queries fall back to Operational History within its retention window.",
                    path=f"{ds_path}.recording.mode",
                )
            )
        if ds.semantics == "event_stream" and ds.recording.mode == "ON_CHANGE":
            issues.append(
                DslIssue(
                    "warning",
                    "EVENT_STREAM_ON_CHANGE_RISK",
                    f"Dataset {ds.key!r} has semantics='event_stream' with mode='ON_CHANGE'; repeated identical alarms/events would collapse unless mode='EVERY_ACQUISITION'.",
                    path=f"{ds_path}.recording.mode",
                )
            )

        updated_fields: list[FieldAst] = []
        for f_idx, fld in enumerate(ds.fields):
            fp = f"{ds_path}.fields[{f_idx}]"
            sig_id = fld.signal_id
            mod_id = fld.model_id
            mod_path = fld.model_field_path
            res_id = fld.resource_id
            rev = fld.source_revision
            unit = fld.unit

            if fld.source_kind == "signal":
                sig: CatalogSignal | None = sig_by_id.get(sig_id.lower()) if sig_id else None
                m_tok = _SIG_TOKEN_RE.match(fld.from_ref)
                m_disp = _SIG_DISPLAY_RE.match(fld.from_ref)
                if m_tok:
                    sig = sig_by_id.get(m_tok.group(1).lower())
                    if sig is None:
                        issues.append(DslIssue("error", "SIGNAL_NOT_FOUND", f"Signal token {fld.from_ref} not found.", path=f"{fp}.from"))
                elif m_disp and sig is None:
                    tkey, rname, skey = m_disp.group(1).lower(), _unescape_bracket(m_disp.group(2)).lower(), _strip_backticks(m_disp.group(3))
                    r_matches = res_by_type_name.get((tkey, rname), [])
                    if not r_matches:
                        issues.append(DslIssue("error", "RESOURCE_NOT_FOUND", f"Resource for {fld.from_ref!r} not found.", path=f"{fp}.from"))
                    elif len(r_matches) > 1:
                        issues.append(DslIssue("error", "AMBIGUOUS_RESOURCE", f"Resource name {rname!r} is ambiguous; bind by signal UUID.", path=f"{fp}.from"))
                    else:
                        s_matches = sig_by_res_key.get((r_matches[0].id.lower(), skey), [])
                        if not s_matches:
                            issues.append(DslIssue("error", "SIGNAL_NOT_FOUND", f"Signal {skey!r} not found under resource {r_matches[0].name!r}.", path=f"{fp}.from"))
                        else:
                            sig = s_matches[0]
                elif sig is None:
                    issues.append(DslIssue("error", "INVALID_SIGNAL_REF", f"Unrecognized signal reference {fld.from_ref!r}.", path=f"{fp}.from"))

                if sig is not None:
                    sig_id = sig.id.lower()
                    res_id = sig.resource_id.lower()
                    rev = sig.revision
                    if unit is None:
                        unit = sig.unit
                    if not sig.active:
                        issues.append(DslIssue("error", "SIGNAL_ARCHIVED", f"Signal {sig.key!r} is ARCHIVED and cannot be mapped as active.", path=f"{fp}.from"))
                    elif not sig.binding_enabled:
                        issues.append(DslIssue("warning", "SIGNAL_BINDING_DISABLED", f"Signal {sig.key!r} has a disabled collection binding.", path=f"{fp}.from"))
                    compat, msg = _types_compatible(sig.data_type, fld.type, has_transform=fld.transform is not None)
                    if not compat:
                        issues.append(DslIssue("error", "TYPE_MISMATCH", msg or "Incompatible type.", path=f"{fp}.type"))

            elif fld.source_kind == "model_field":
                mod: CatalogModel | None = mod_by_id.get(mod_id.lower()) if mod_id else None
                m_tok = _MODEL_TOKEN_RE.match(fld.from_ref)
                m_disp = _MODEL_DISPLAY_RE.match(fld.from_ref)
                if m_tok:
                    mod = mod_by_id.get(m_tok.group(1).lower())
                    mod_path = m_tok.group(2)
                elif m_disp and mod is None:
                    mname, mpath = m_disp.group(1).strip().lower(), m_disp.group(2).strip()
                    m_matches = mod_by_name.get(mname, [])
                    if not m_matches:
                        issues.append(DslIssue("error", "MODEL_NOT_FOUND", f"Data Model {m_disp.group(1)!r} not found.", path=f"{fp}.from"))
                    elif len(m_matches) > 1:
                        issues.append(DslIssue("error", "AMBIGUOUS_MODEL", f"Multiple models named {m_disp.group(1)!r}.", path=f"{fp}.from"))
                    else:
                        mod = m_matches[0]
                        mod_path = mpath
                elif mod is None:
                    issues.append(DslIssue("error", "INVALID_MODEL_REF", f"Unrecognized model field reference {fld.from_ref!r}.", path=f"{fp}.from"))

                if mod is not None:
                    mod_id = mod.id.lower()
                    if not mod.active:
                        issues.append(DslIssue("error", "MODEL_ARCHIVED", f"Model {mod.display_name!r} is archived.", path=f"{fp}.from"))
                    if mod_path and mod.field_paths and mod_path not in mod.field_paths:
                        issues.append(DslIssue("error", "MODEL_FIELD_NOT_FOUND", f"Field path {mod_path!r} not present in model {mod.display_name!r}.", path=f"{fp}.from"))
                    elif mod_path and mod_path in mod.field_paths:
                        mtype = mod.field_paths[mod_path]
                        if mtype != "auto":
                            compat, msg = _types_compatible(mtype, fld.type, has_transform=fld.transform is not None)
                            if not compat:
                                issues.append(DslIssue("error", "TYPE_MISMATCH", msg or "Incompatible model field type.", path=f"{fp}.type"))

            updated_fields.append(
                FieldAst(
                    key=fld.key,
                    from_ref=fld.from_ref,
                    type=fld.type,
                    display_name=fld.display_name,
                    description=fld.description,
                    nullable=fld.nullable,
                    required=fld.required,
                    unit=unit,
                    max_length=fld.max_length,
                    transform=fld.transform,
                    source_kind=fld.source_kind,
                    signal_id=sig_id,
                    model_id=mod_id,
                    model_field_path=mod_path,
                    resource_id=res_id,
                    source_revision=rev,
                )
            )

        updated_datasets.append(
            DatasetAst(
                id=ds.id,
                key=ds.key,
                semantics=ds.semantics,
                source_kind=ds.source_kind,
                time_axis=ds.time_axis,
                display_name=ds.display_name,
                description=ds.description,
                tags=ds.tags,
                fields=tuple(updated_fields),
                relationships=ds.relationships,
                recording=ds.recording,
                retention=ds.retention,
            )
        )

    resolved_design = StorageDesignAst(
        api_version=design.api_version,
        kind=design.kind,
        metadata=design.metadata,
        spec=DesignSpec(
            scope=ScopeSpec(
                mode=design.spec.scope.mode,
                resource=design.spec.scope.resource,
                site_id=design.spec.scope.site_id,
                resource_ids=tuple(resolved_scope_ids),
            ),
            destination=design.spec.destination,
            datasets=tuple(updated_datasets),
            ui_meta=design.spec.ui_meta,
        ),
    )
    return resolved_design, issues


# ==============================================================================
# TDengine Physical Schema Compiler
# ==============================================================================


def _td_column_type(field_type: str, max_length: int | None) -> tuple[str, int]:
    if field_type == "bool":
        return "BOOL", 2
    if field_type == "int64":
        return "BIGINT", 9
    if field_type == "float64":
        return "DOUBLE", 9
    if field_type == "timestamp":
        return "TIMESTAMP", 9
    if field_type in {"string", "enum"}:
        n = min(max(max_length if max_length is not None else 1024, 1), 15000)
        return f"NCHAR({n})", 4 * n + 4
    if field_type == "json":
        n = min(max(max_length if max_length is not None else 16384, 1), 60000)
        return f"VARCHAR({n})", n + 4
    raise StorageDslError([DslIssue("error", "UNSUPPORTED_TD_TYPE", f"Unsupported TDengine field type {field_type!r}.")])


def tenant_td_database(tenant_id: UUID | str, prefix: str = "fx_t_") -> str:
    uid_hex = UUID(str(tenant_id)).hex
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,15}", prefix):
        raise ValueError(f"Invalid TDengine db prefix {prefix!r}")
    return f"{prefix}{uid_hex}"


def stable_name_for_dataset(design_id: UUID | str, dataset_key: str, schema_version: int = 1) -> str:
    dhex = UUID(str(design_id)).hex[:8]
    safe_key = re.sub(r"[^A-Za-z0-9_]", "_", dataset_key.lower())[:36]
    name = f"ds_{dhex}_{safe_key}_v{int(schema_version)}"
    if not _IDENT_RE.match(name):
        raise StorageDslError([DslIssue("error", "INVALID_STABLE_NAME", f"Compiled stable name {name!r} is invalid.")])
    return name


def subtable_name_for_series(dataset_id: UUID | str, series_key: str, *, schema_epoch: int = 1) -> str:
    dhex = UUID(str(dataset_id)).hex[:8]
    salt_key = series_key if schema_epoch <= 1 else f"v{int(schema_epoch)}:{series_key}"
    shash = uuid5(_SERIES_NS, salt_key).hex[:16]
    return f"md_{dhex}_{shash}"


@dataclass(frozen=True, slots=True)
class CompiledSeries:
    dataset_key: str
    series_key: str
    field_key: str
    value_type: str
    td_database: str
    td_stable: str
    td_subtable: str
    signal_id: str | None
    model_id: str | None
    model_field_path: str | None
    physical_schema_hash: str
    tags: dict[str, str]


@dataclass(frozen=True, slots=True)
class SchemaDiff:
    is_breaking: bool
    breaking_changes: tuple[str, ...] = ()
    non_breaking_changes: tuple[str, ...] = ()
    ddl_statements: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_breaking": self.is_breaking,
            "breaking_changes": list(self.breaking_changes),
            "non_breaking_changes": list(self.non_breaking_changes),
            "ddl_statements": list(self.ddl_statements),
        }


@dataclass(frozen=True, slots=True)
class CompiledStoragePlan:
    compiler_version: str
    td_database: str
    semantic_hash: str
    ast_hash: str
    plan_hash: str
    ddl_statements: tuple[str, ...]
    datasets: tuple[dict[str, Any], ...]
    series: tuple[CompiledSeries, ...]
    diff: SchemaDiff
    impact: dict[str, Any]
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "compiler_version": self.compiler_version,
            "td_database": self.td_database,
            "semantic_hash": self.semantic_hash,
            "ast_hash": self.ast_hash,
            "plan_hash": self.plan_hash,
            "ddl_statements": list(self.ddl_statements),
            "datasets": list(self.datasets),
            "series": [
                {
                    "dataset_key": s.dataset_key,
                    "series_key": s.series_key,
                    "field_key": s.field_key,
                    "value_type": s.value_type,
                    "td_database": s.td_database,
                    "td_stable": s.td_stable,
                    "td_subtable": s.td_subtable,
                    "signal_id": s.signal_id,
                    "model_id": s.model_id,
                    "model_field_path": s.model_field_path,
                    "physical_schema_hash": s.physical_schema_hash,
                    "tags": dict(s.tags),
                }
                for s in self.series
            ],
            "diff": self.diff.to_dict(),
            "impact": dict(self.impact),
            "warnings": list(self.warnings),
        }


def _sql_lit(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def compile_storage_plan(
    design: StorageDesignAst,
    *,
    tenant_id: UUID | str,
    design_id: UUID | str,
    target_version: int = 1,
    previous_plan: Mapping[str, Any] | None = None,
    expected_intervals_ms: Mapping[str, int] | None = None,
) -> CompiledStoragePlan:
    """Compile a validated canonical ``StorageDesignAst`` into deterministic TDengine DDL & diff."""
    db_name = tenant_td_database(tenant_id)
    sem_hash = design.semantic_hash()
    full_hash = design.full_hash()
    max_keep = max((ds.retention.days for ds in design.spec.datasets), default=90)
    ddl: list[str] = [
        f"CREATE DATABASE IF NOT EXISTS `{db_name}` PRECISION 'us' KEEP {max_keep}d CACHEMODEL 'last_row' CACHESIZE 16"
    ]

    ds_plans: list[dict[str, Any]] = []
    series_list: list[CompiledSeries] = []
    warnings: list[str] = []
    breaking: list[str] = []
    non_breaking: list[str] = []
    diff_ddl: list[str] = []

    prev_ds_map = {d["dataset_key"]: d for d in previous_plan.get("datasets", [])} if previous_plan else {}

    for ds in design.spec.datasets:
        ds_id = ds.id or str(uuid5(UUID(str(design_id)), ds.key))
        col_defs: list[dict[str, Any]] = []
        field_cols_sql: list[str] = []
        row_bytes = 900  # Base metadata columns (~850 bytes worst case)
        for f in ds.fields:
            if not _IDENT_RE.match(f.key) or f.key.lower() in RESERVED_FIELD_KEYS:
                raise StorageDslError([DslIssue("error", "INVALID_COLUMN_KEY", f"Unsafe column key {f.key!r}.")])
            td_type, td_bytes = _td_column_type(f.type, f.max_length)
            row_bytes += td_bytes
            field_cols_sql.append(f"`{f.key}` {td_type}")
            col_defs.append({"key": f.key, "value_type": f.type, "td_type": td_type, "nullable": f.nullable})
        if row_bytes > 64500:
            raise StorageDslError(
                [DslIssue("error", "ROW_WIDTH_EXCEEDED", f"Dataset {ds.key!r} row width ({row_bytes} bytes) exceeds TDengine max row width (65531 bytes); split fields across datasets or reduce maxLength.")]
            )

        prev_ds = prev_ds_map.get(ds.key)
        ds_breaking: list[str] = []
        ds_non_breaking: list[str] = []
        ds_diff_ddl: list[str] = []

        if prev_ds is not None:
            if prev_ds["semantics"] != ds.semantics:
                ds_breaking.append(f"Dataset {ds.key!r} semantics changed ({prev_ds['semantics']} -> {ds.semantics}).")
            if int(ds.retention.days) < int(prev_ds["retention_days"]):
                ds_breaking.append(
                    f"Dataset {ds.key!r} retention reduced ({prev_ds['retention_days']}d -> {ds.retention.days}d); risk of data expiration."
                )
            elif int(ds.retention.days) > int(prev_ds["retention_days"]):
                ds_non_breaking.append(
                    f"Dataset {ds.key!r} retention extended ({prev_ds['retention_days']}d -> {ds.retention.days}d)."
                )
            prev_cols = {c["key"]: c for c in prev_ds.get("columns", [])}
            curr_cols = {c["key"]: c for c in col_defs}
            for ck, pc in prev_cols.items():
                if ck not in curr_cols:
                    ds_breaking.append(f"Removed column {ds.key}.{ck}.")
                elif pc["td_type"] != curr_cols[ck]["td_type"]:
                    ds_breaking.append(
                        f"Column {ds.key}.{ck} physical type changed ({pc['td_type']} -> {curr_cols[ck]['td_type']})."
                    )
            for ck, cc in curr_cols.items():
                if ck not in prev_cols:
                    ds_non_breaking.append(f"Added column {ds.key}.{ck} ({cc['td_type']}).")
                    ds_diff_ddl.append(
                        f"ALTER STABLE `{db_name}`.`{prev_ds['td_stable']}` ADD COLUMN `{ck}` {cc['td_type']}"
                    )

        if prev_ds is not None and not ds_breaking:
            schema_epoch = int(prev_ds.get("schema_epoch") or 1)
            stable = str(prev_ds["td_stable"])
            diff_ddl.extend(ds_diff_ddl)
        else:
            schema_epoch = int(target_version)
            stable = stable_name_for_dataset(design_id, ds.key, schema_version=schema_epoch)
            if prev_ds is None and previous_plan is not None:
                ds_non_breaking.append(f"Added new dataset {ds.key!r}.")

        breaking.extend(ds_breaking)
        non_breaking.extend(ds_non_breaking)

        cols = [
            "`ts` TIMESTAMP",
            "`acquired_at` TIMESTAMP",
            "`source_time` TIMESTAMP",
            "`raw_quality` NCHAR(16)",
            "`reason_code` NCHAR(64)",
            "`event_uid` NCHAR(64)",
            "`data_epoch` BIGINT",
            "`record_kind` NCHAR(24)",
            *field_cols_sql,
        ]

        tags_ddl = [
            "`dataset_id` NCHAR(36)",
            "`series_key` NCHAR(96)",
            "`resource_id` NCHAR(36)",
        ]
        for t in ds.tags:
            if not _TAG_KEY_RE.match(t.key) or t.key in {"dataset_id", "series_key", "resource_id"}:
                raise StorageDslError([DslIssue("error", "INVALID_TAG_KEY", f"Tag key {t.key!r} invalid or reserved.")])
            tags_ddl.append(f"`{t.key}` NCHAR(128)")

        create_stable = (
            f"CREATE STABLE IF NOT EXISTS `{db_name}`.`{stable}` "
            f"({', '.join(cols)}) TAGS ({', '.join(tags_ddl)})"
        )
        ddl.append(create_stable)

        ds_schema_hash = hashlib.sha256(
            json.dumps({"stable": stable, "cols": col_defs, "semantics": ds.semantics, "schema_epoch": schema_epoch}, sort_keys=True).encode("utf-8")
        ).hexdigest()

        base_tags = {t.key: t.value for t in ds.tags}
        for f in ds.fields:
            s_key = (
                f"sig:{f.signal_id}"
                if f.signal_id
                else (f"mod:{f.model_id}:{f.model_field_path or f.key}" if f.model_id else f"fld:{ds.key}:{f.key}")
            )
            sub_name = subtable_name_for_series(ds_id, s_key, schema_epoch=schema_epoch)
            tag_vals = [
                _sql_lit(ds_id),
                _sql_lit(s_key),
                _sql_lit(f.resource_id or ""),
                *[_sql_lit(base_tags.get(t.key, "")) for t in ds.tags],
            ]
            ddl.append(
                f"CREATE TABLE IF NOT EXISTS `{db_name}`.`{sub_name}` "
                f"USING `{db_name}`.`{stable}` TAGS ({', '.join(tag_vals)})"
            )
            series_list.append(
                CompiledSeries(
                    dataset_key=ds.key,
                    series_key=s_key,
                    field_key=f.key,
                    value_type=f.type,
                    td_database=db_name,
                    td_stable=stable,
                    td_subtable=sub_name,
                    signal_id=f.signal_id,
                    model_id=f.model_id,
                    model_field_path=f.model_field_path,
                    physical_schema_hash=ds_schema_hash,
                    tags={"dataset_id": ds_id, "series_key": s_key, "resource_id": f.resource_id or "", **base_tags},
                )
            )

        if ds.recording.mode in {"ON_CHANGE", "INTERVAL"}:
            warnings.append(
                f"Dataset '{ds.key}' records under {ds.recording.mode}; exact raw sample avg/count relies on Operational History."
            )

        ds_plans.append(
            {
                "dataset_id": ds_id,
                "dataset_key": ds.key,
                "td_stable": stable,
                "schema_epoch": schema_epoch,
                "semantics": ds.semantics,
                "recording_mode": ds.recording.mode,
                "retention_days": ds.retention.days,
                "legal_hold": ds.retention.legal_hold,
                "columns": col_defs,
                "physical_schema_hash": ds_schema_hash,
            }
        )

    if previous_plan is None:
        non_breaking.append("Initial schema compilation: creates database, supertable(s), and subtables cleanly.")
    else:
        curr_ds_keys = {d["dataset_key"] for d in ds_plans}
        for dk in prev_ds_map:
            if dk not in curr_ds_keys:
                breaking.append(f"Removed dataset {dk!r} from published design.")
        if not breaking and not non_breaking:
            if previous_plan.get("semantic_hash") == sem_hash:
                non_breaking.append("Layout/metadata update only; physical TDengine schema unchanged.")
            else:
                non_breaking.append("Recording policy/metadata updated without destructive physical schema changes.")

    # Impact & cardinality estimation with explicit stated assumptions
    measured_rate = 0.0
    assumed_signals = 0
    for s in series_list:
        if s.signal_id and expected_intervals_ms and s.signal_id in expected_intervals_ms:
            ms = max(100, int(expected_intervals_ms[s.signal_id]))
            measured_rate += 1000.0 / ms
        else:
            measured_rate += 1.0  # documented fallback assumption: 1 Hz
            assumed_signals += 1

    # Assume 128 bytes average compressed/raw logical row budget range
    rows_per_day_full = int(round(measured_rate * 86_400))
    # ON_CHANGE compression range typically 5%..40% of acquisition rate depending on signal volatility
    any_on_change = any(ds.recording.mode == "ON_CHANGE" for ds in design.spec.datasets)
    est_rows_min = int(round(rows_per_day_full * (0.05 if any_on_change else 1.0)))
    est_rows_max = rows_per_day_full
    est_bytes_min = est_rows_min * 64
    est_bytes_max = est_rows_max * 192

    impact = {
        "dataset_count": len(ds_plans),
        "series_count": len(series_list),
        "field_count": sum(len(ds["columns"]) for ds in ds_plans),
        "estimated_daily_rows_min": est_rows_min,
        "estimated_daily_rows_max": est_rows_max,
        "estimated_daily_bytes_min": est_bytes_min,
        "estimated_daily_bytes_max": est_bytes_max,
        "assumptions": (
            f"Projected from {len(series_list)} series "
            f"({assumed_signals} using 1 Hz default cadence; ON_CHANGE modeled at 5%–100% transition rate)."
        ),
    }

    plan_hash = hashlib.sha256(
        json.dumps({"ddl": ddl, "sem": sem_hash}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    return CompiledStoragePlan(
        compiler_version=COMPILER_VERSION,
        td_database=db_name,
        semantic_hash=sem_hash,
        ast_hash=full_hash,
        plan_hash=plan_hash,
        ddl_statements=tuple(ddl),
        datasets=tuple(ds_plans),
        series=tuple(series_list),
        diff=SchemaDiff(
            is_breaking=len(breaking) > 0,
            breaking_changes=tuple(breaking),
            non_breaking_changes=tuple(non_breaking),
            ddl_statements=tuple(diff_ddl),
        ),
        impact=impact,
        warnings=tuple(dict.fromkeys(warnings)),
    )
