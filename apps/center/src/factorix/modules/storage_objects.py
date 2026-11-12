"""Physical TDengine object manager: Database, Supertable, Subtable.

Provides:
- Validation of object specs (names, types, capabilities).
- Safe DDL generation (CREATE DATABASE, CREATE STABLE, CREATE TABLE … USING … TAGS).
- Capability checking against pinned TDengine version.
- ALTER / RETIRE / PURGE lifecycle helpers.

No DDL is *executed* here — execution lives in ``storage_revisions.py``
so that the saga can be retried idempotently.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

# ---------------------------------------------------------------------------
# TDengine identifier rules
# ---------------------------------------------------------------------------
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_DB_PREFIX_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,15}$")
_RESERVED_DB_PREFIXES = {"information_schema", "performance_schema", "log", "sys"}
_MAX_COLUMNS = 4096
_MAX_TAGS = 128
_MAX_ROW_BYTES = 65_535  # TDengine hard limit

# TDengine 3.4.3.9 — supported types
_SUPPORTED_COLUMN_TYPES: dict[str, int | None] = {
    "TIMESTAMP": None,
    "INT": None,
    "INT UNSIGNED": None,
    "BIGINT": None,
    "BIGINT UNSIGNED": None,
    "FLOAT": None,
    "DOUBLE": None,
    "BINARY": 65517,
    "SMALLINT": None,
    "SMALLINT UNSIGNED": None,
    "TINYINT": None,
    "TINYINT UNSIGNED": None,
    "BOOL": None,
    "NCHAR": 16383,
    "VARCHAR": 65517,
    "VARBINARY": 65517,
    "GEOMETRY": 65517,
    "JSON": None,  # only for tags
}
_TAG_ONLY_TYPES = {"JSON"}
_SUPPORTED_DB_PRECISION = {"ms", "us", "ns"}
_SUPPORTED_CACHE_MODELS = {"none", "last_row", "last_value", "both"}


class StorageObjectError(ValueError):
    def __init__(self, code: str, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.field = field


# ---------------------------------------------------------------------------
# Spec dataclasses
# ---------------------------------------------------------------------------

@dataclass
class ColumnSpec:
    name: str
    td_type: str
    length: int | None = None
    role: Literal["time_key", "value"] = "value"
    nullable: bool = True
    description: str = ""


@dataclass
class TagSpec:
    name: str
    td_type: str
    length: int | None = None
    required: bool = False
    description: str = ""


@dataclass
class DatabaseSpec:
    name: str
    precision: str = "ms"
    keep: str = "3650d"
    vgroups: int = 1
    replica: int = 1
    cache_model: str | None = None
    buffer: int | None = None
    description: str = ""


@dataclass
class StableSpec:
    database: str
    name: str
    columns: list[ColumnSpec] = field(default_factory=list)
    tags: list[TagSpec] = field(default_factory=list)
    description: str = ""


@dataclass
class SubtableSpec:
    database: str
    stable: str
    name: str
    tag_values: dict[str, Any] = field(default_factory=dict)
    description: str = ""


@dataclass
class ValidationResult:
    valid: bool
    errors: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    estimated_row_bytes: int = 0


# ---------------------------------------------------------------------------
# Capability checker
# ---------------------------------------------------------------------------

class TDengineCapabilities:
    """Feature flags for TDengine 3.4.3.9 (Community edition)."""

    VIRTUAL_TABLES = False
    COMPOSITE_KEY = False
    PER_STABLE_RETENTION = False
    TAG_INDEXES = True
    MAX_PRECISION = "us"  # ns supported but not recommended in community
    SUPPORTED_PRECISIONS = {"ms", "us", "ns"}
    MAX_REPLICA = 1  # single-node

    @classmethod
    def check_precision(cls, precision: str) -> str | None:
        if precision not in cls.SUPPORTED_PRECISIONS:
            return f"Precision '{precision}' is not supported. Use one of: {cls.SUPPORTED_PRECISIONS}"
        return None

    @classmethod
    def check_replica(cls, replica: int) -> str | None:
        if replica > cls.MAX_REPLICA:
            return (
                f"Replica count {replica} exceeds the maximum for this edition "
                f"({cls.MAX_REPLICA}). Use replica=1 on a single-node deployment."
            )
        return None

    @classmethod
    def check_virtual_table(cls) -> str | None:
        if not cls.VIRTUAL_TABLES:
            return "Virtual Tables are not available in this TDengine edition/version."
        return None


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

def validate_identifier(name: str, kind: str = "identifier") -> None:
    if not isinstance(name, str) or not _IDENT_RE.fullmatch(name):
        raise StorageObjectError(
            "INVALID_IDENTIFIER",
            f"Invalid TDengine {kind}: {name!r}. Must match [A-Za-z_][A-Za-z0-9_]{{0,63}}",
            field=kind,
        )


def validate_database_spec(spec: DatabaseSpec) -> ValidationResult:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    # Name
    try:
        validate_identifier(spec.name, "database name")
    except StorageObjectError as exc:
        errors.append({"field": "name", "code": exc.code, "message": str(exc)})

    if spec.name.lower() in _RESERVED_DB_PREFIXES:
        errors.append({
            "field": "name",
            "code": "RESERVED_NAME",
            "message": f"Database name '{spec.name}' is a reserved system name.",
        })

    # Precision
    err = TDengineCapabilities.check_precision(spec.precision)
    if err:
        errors.append({"field": "precision", "code": "UNSUPPORTED_PRECISION", "message": err})

    # Replica
    err = TDengineCapabilities.check_replica(spec.replica)
    if err:
        errors.append({"field": "replica", "code": "UNSUPPORTED_REPLICA", "message": err})

    # VGroups
    if spec.vgroups < 1 or spec.vgroups > 128:
        warnings.append({
            "field": "vgroups",
            "code": "VGROUPS_RANGE",
            "message": f"vgroups={spec.vgroups} is outside the typical range 1–128.",
        })

    # Cache model
    if spec.cache_model and spec.cache_model not in _SUPPORTED_CACHE_MODELS:
        errors.append({
            "field": "cache_model",
            "code": "UNSUPPORTED_CACHE_MODEL",
            "message": f"Cache model '{spec.cache_model}' not supported. Use one of: {_SUPPORTED_CACHE_MODELS}",
        })

    return ValidationResult(valid=not errors, errors=errors, warnings=warnings)


def validate_stable_spec(spec: StableSpec) -> ValidationResult:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    # Database name
    try:
        validate_identifier(spec.database, "database name")
    except StorageObjectError as exc:
        errors.append({"field": "database", "code": exc.code, "message": str(exc)})

    # STable name
    try:
        validate_identifier(spec.name, "supertable name")
    except StorageObjectError as exc:
        errors.append({"field": "name", "code": exc.code, "message": str(exc)})

    # Columns
    if not spec.columns:
        errors.append({
            "field": "columns",
            "code": "NO_COLUMNS",
            "message": "At least one column (the timestamp column) is required.",
        })

    ts_cols = [c for c in spec.columns if c.role == "time_key"]
    if not ts_cols:
        errors.append({
            "field": "columns",
            "code": "MISSING_TIMESTAMP",
            "message": "A TIMESTAMP column with role 'time_key' is required as the first column.",
        })
    elif ts_cols[0] != spec.columns[0]:
        errors.append({
            "field": "columns[0]",
            "code": "TIMESTAMP_MUST_BE_FIRST",
            "message": "The TIMESTAMP column must be the first column in the supertable.",
        })

    seen_col_names: set[str] = set()
    total_row_bytes = 0
    for i, col in enumerate(spec.columns):
        try:
            validate_identifier(col.name, f"column[{i}].name")
        except StorageObjectError as exc:
            errors.append({"field": f"columns[{i}].name", "code": exc.code, "message": str(exc)})
        td_type_upper = col.td_type.upper().split("(")[0].strip()
        if td_type_upper not in _SUPPORTED_COLUMN_TYPES and td_type_upper + " UNSIGNED" not in _SUPPORTED_COLUMN_TYPES:
            errors.append({
                "field": f"columns[{i}].td_type",
                "code": "UNSUPPORTED_TYPE",
                "message": f"Column type '{col.td_type}' is not supported by TDengine 3.4.3.9.",
            })
        if td_type_upper in _TAG_ONLY_TYPES:
            errors.append({
                "field": f"columns[{i}].td_type",
                "code": "TAG_ONLY_TYPE",
                "message": f"Type '{col.td_type}' can only be used in tags, not columns.",
            })
        if col.name in seen_col_names:
            errors.append({
                "field": f"columns[{i}].name",
                "code": "DUPLICATE_COLUMN",
                "message": f"Duplicate column name: '{col.name}'.",
            })
        seen_col_names.add(col.name)
        total_row_bytes += _estimate_type_bytes(col.td_type, col.length)

    if len(spec.columns) > _MAX_COLUMNS:
        errors.append({
            "field": "columns",
            "code": "TOO_MANY_COLUMNS",
            "message": f"Column count {len(spec.columns)} exceeds TDengine limit {_MAX_COLUMNS}.",
        })

    if total_row_bytes > _MAX_ROW_BYTES:
        errors.append({
            "field": "columns",
            "code": "ROW_TOO_WIDE",
            "message": (
                f"Estimated row width {total_row_bytes} bytes exceeds TDengine limit "
                f"{_MAX_ROW_BYTES} bytes. Reduce column sizes."
            ),
        })
    elif total_row_bytes > 60_000:
        warnings.append({
            "field": "columns",
            "code": "ROW_WIDTH_WARNING",
            "message": f"Estimated row width {total_row_bytes} bytes is close to the {_MAX_ROW_BYTES} limit.",
        })

    # Tags
    if len(spec.tags) > _MAX_TAGS:
        errors.append({
            "field": "tags",
            "code": "TOO_MANY_TAGS",
            "message": f"Tag count {len(spec.tags)} exceeds TDengine limit {_MAX_TAGS}.",
        })

    seen_tag_names: set[str] = set()
    for i, tag in enumerate(spec.tags):
        try:
            validate_identifier(tag.name, f"tag[{i}].name")
        except StorageObjectError as exc:
            errors.append({"field": f"tags[{i}].name", "code": exc.code, "message": str(exc)})
        if tag.name in seen_col_names or tag.name in seen_tag_names:
            errors.append({
                "field": f"tags[{i}].name",
                "code": "DUPLICATE_TAG",
                "message": f"Tag name '{tag.name}' conflicts with a column or another tag.",
            })
        seen_tag_names.add(tag.name)

    return ValidationResult(
        valid=not errors,
        errors=errors,
        warnings=warnings,
        estimated_row_bytes=total_row_bytes,
    )


def validate_subtable_spec(spec: SubtableSpec, stable_tags: list[TagSpec]) -> ValidationResult:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    try:
        validate_identifier(spec.database, "database name")
    except StorageObjectError as exc:
        errors.append({"field": "database", "code": exc.code, "message": str(exc)})

    try:
        validate_identifier(spec.stable, "stable name")
    except StorageObjectError as exc:
        errors.append({"field": "stable", "code": exc.code, "message": str(exc)})

    try:
        validate_identifier(spec.name, "subtable name")
    except StorageObjectError as exc:
        errors.append({"field": "name", "code": exc.code, "message": str(exc)})

    required_tags = {t.name for t in stable_tags if t.required}
    missing = required_tags - set(spec.tag_values.keys())
    if missing:
        errors.append({
            "field": "tag_values",
            "code": "MISSING_REQUIRED_TAGS",
            "message": f"Required tag(s) missing: {sorted(missing)}",
        })

    extra = set(spec.tag_values.keys()) - {t.name for t in stable_tags}
    if extra:
        warnings.append({
            "field": "tag_values",
            "code": "EXTRA_TAG_VALUES",
            "message": f"Tag(s) provided but not in stable schema: {sorted(extra)}",
        })

    return ValidationResult(valid=not errors, errors=errors, warnings=warnings)


# ---------------------------------------------------------------------------
# DDL generators
# ---------------------------------------------------------------------------

def _quote(name: str) -> str:
    validate_identifier(name)
    return f"`{name}`"


def _type_sql(td_type: str, length: int | None) -> str:
    td_type_upper = td_type.upper()
    if length is not None and td_type_upper not in {"TIMESTAMP", "INT", "BIGINT",
                                                     "FLOAT", "DOUBLE", "BOOL",
                                                     "SMALLINT", "TINYINT"}:
        return f"{td_type_upper}({length})"
    return td_type_upper


def generate_create_database_ddl(spec: DatabaseSpec) -> str:
    """Generate CREATE DATABASE DDL from spec.

    Example:
        CREATE DATABASE `mydb` PRECISION 'ms' KEEP 3650d VGROUPS 1 REPLICA 1;
    """
    parts = [f"CREATE DATABASE IF NOT EXISTS {_quote(spec.name)}"]
    parts.append(f"PRECISION '{spec.precision}'")
    if spec.keep:
        parts.append(f"KEEP {spec.keep}")
    parts.append(f"VGROUPS {spec.vgroups}")
    parts.append(f"REPLICA {spec.replica}")
    if spec.buffer is not None:
        parts.append(f"BUFFER {spec.buffer}")
    if spec.cache_model:
        parts.append(f"CACHEMODEL '{spec.cache_model}'")
    return " ".join(parts)


def generate_create_stable_ddl(spec: StableSpec) -> str:
    """Generate CREATE STABLE DDL from spec."""
    col_defs = ", ".join(
        f"{_quote(c.name)} {_type_sql(c.td_type, c.length)}"
        for c in spec.columns
    )
    if spec.tags:
        tag_defs = ", ".join(
            f"{_quote(t.name)} {_type_sql(t.td_type, t.length)}"
            for t in spec.tags
        )
        return (
            f"CREATE STABLE IF NOT EXISTS "
            f"{_quote(spec.database)}.{_quote(spec.name)} "
            f"({col_defs}) "
            f"TAGS ({tag_defs})"
        )
    return (
        f"CREATE STABLE IF NOT EXISTS "
        f"{_quote(spec.database)}.{_quote(spec.name)} "
        f"({col_defs}) "
        f"TAGS ()"
    )


def generate_create_subtable_ddl(spec: SubtableSpec, stable_tag_specs: list[TagSpec]) -> str:
    """Generate CREATE TABLE … USING … TAGS(…) DDL."""
    tag_names = [t.name for t in stable_tag_specs]
    # Only emit tags that are present in the stable schema
    tag_values = [spec.tag_values.get(t.name) for t in stable_tag_specs]
    tag_name_sql = ", ".join(_quote(n) for n in tag_names) if tag_names else ""
    tag_val_sql = ", ".join(_tag_literal(v) for v in tag_values) if tag_values else ""

    if tag_names:
        return (
            f"CREATE TABLE IF NOT EXISTS "
            f"{_quote(spec.database)}.{_quote(spec.name)} "
            f"USING {_quote(spec.database)}.{_quote(spec.stable)} "
            f"({tag_name_sql}) "
            f"TAGS ({tag_val_sql})"
        )
    return (
        f"CREATE TABLE IF NOT EXISTS "
        f"{_quote(spec.database)}.{_quote(spec.name)} "
        f"USING {_quote(spec.database)}.{_quote(spec.stable)}"
    )


def generate_alter_stable_add_column_ddl(database: str, stable: str, col: ColumnSpec) -> str:
    return (
        f"ALTER STABLE {_quote(database)}.{_quote(stable)} "
        f"ADD COLUMN {_quote(col.name)} {_type_sql(col.td_type, col.length)}"
    )


def generate_alter_stable_add_tag_ddl(database: str, stable: str, tag: TagSpec) -> str:
    return (
        f"ALTER STABLE {_quote(database)}.{_quote(stable)} "
        f"ADD TAG {_quote(tag.name)} {_type_sql(tag.td_type, tag.length)}"
    )


def generate_drop_stable_ddl(database: str, stable: str) -> str:
    return f"DROP STABLE IF EXISTS {_quote(database)}.{_quote(stable)}"


def generate_drop_table_ddl(database: str, table: str) -> str:
    return f"DROP TABLE IF EXISTS {_quote(database)}.{_quote(table)}"


# ---------------------------------------------------------------------------
# Plan builder
# ---------------------------------------------------------------------------

@dataclass
class DdlStep:
    action: str
    sql: str
    idempotent: bool = True
    description: str = ""


def build_create_database_plan(spec: DatabaseSpec) -> list[DdlStep]:
    result = validate_database_spec(spec)
    if not result.valid:
        raise StorageObjectError(
            "VALIDATION_FAILED",
            f"Database spec invalid: {result.errors}",
        )
    return [
        DdlStep(
            action="CREATE_DATABASE",
            sql=generate_create_database_ddl(spec),
            idempotent=True,
            description=f"Create TDengine database '{spec.name}'",
        )
    ]


def build_create_stable_plan(spec: StableSpec) -> list[DdlStep]:
    result = validate_stable_spec(spec)
    if not result.valid:
        raise StorageObjectError(
            "VALIDATION_FAILED",
            f"Supertable spec invalid: {result.errors}",
        )
    return [
        DdlStep(
            action="CREATE_STABLE",
            sql=generate_create_stable_ddl(spec),
            idempotent=True,
            description=f"Create TDengine supertable '{spec.database}.{spec.name}'",
        )
    ]


def build_create_subtable_plan(
    spec: SubtableSpec, stable_tag_specs: list[TagSpec]
) -> list[DdlStep]:
    result = validate_subtable_spec(spec, stable_tag_specs)
    if not result.valid:
        raise StorageObjectError(
            "VALIDATION_FAILED",
            f"Subtable spec invalid: {result.errors}",
        )
    return [
        DdlStep(
            action="CREATE_SUBTABLE",
            sql=generate_create_subtable_ddl(spec, stable_tag_specs),
            idempotent=True,
            description=f"Create TDengine subtable '{spec.database}.{spec.name}'",
        )
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tag_literal(value: Any) -> str:
    """Convert a Python value to a TDengine tag literal."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    s = str(value).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{s}'"


def _estimate_type_bytes(td_type: str, length: int | None) -> int:
    """Rough row byte estimate for a TDengine column type."""
    tu = td_type.upper().split("(")[0].strip()
    fixed: dict[str, int] = {
        "TIMESTAMP": 8, "INT": 4, "INT UNSIGNED": 4,
        "BIGINT": 8, "BIGINT UNSIGNED": 8,
        "FLOAT": 4, "DOUBLE": 8,
        "SMALLINT": 2, "SMALLINT UNSIGNED": 2,
        "TINYINT": 1, "TINYINT UNSIGNED": 1,
        "BOOL": 1,
    }
    if tu in fixed:
        return fixed[tu]
    # Variable-length types use their declared length or a default
    if tu in {"BINARY", "VARCHAR", "NCHAR", "VARBINARY", "GEOMETRY", "JSON"}:
        return (length or 64) + 2  # +2 for length prefix
    return 8  # fallback
