"""Storage Revisions, Drafts, and the physical-object creation saga.

Saga (one operation per object, durable in ``storage_operations``)::

    PREPARING -> APPLYING (DDL) -> VERIFYING (read-back) -> APPLIED
                     \\-> FAILED (DDL error)      \\-> FAILED + compensation (object we created is dropped)

Rules (review P1-1..P1-4, guide G-03 / D5, R1-04 / R1-05):

* Everything is validated **before** any DDL runs: spec, parent supertable, tag values, and for a
  subtable every binding (model field leaf, target column, type, single owner) or the explicit
  "no binding" choice.
* A name clash is detected up front (``information_schema``) and reported as ``NAME_CONFLICT``; DDL
  has no ``IF NOT EXISTS`` that would hide a clash with another schema / other tag values.
* Idempotency: ``(tenant, operation_type, idempotency_key)``; the default key is
  ``<db>.<name>:<spec hash>`` so a double click or a retry after a timeout never creates twice.
* Read-back compares the real schema (columns, types, lengths, composite key, tags) / tag values.
* Registry, bindings and the APPLIED status are written in ONE PostgreSQL transaction; any error
  rolls it back, drops the object this operation just created (it did not exist before) and marks
  the operation FAILED. Nothing is swallowed with ``logger.debug``.
"""

from __future__ import annotations

from datetime import timedelta
import hashlib
import json
import logging
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import storage_bindings as SB
from factorix.modules.common import (
    execute,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    utcnow,
)
from factorix.modules.storage_objects import (
    MAX_DISPLAY_NAME_LEN,
    ColumnSpec,
    DatabaseSpec,
    DdlStep,
    StableSpec,
    StorageObjectError,
    SubtableSpec,
    TagSpec,
    ValidationResult,
    build_create_database_plan,
    build_create_stable_plan,
    build_create_subtable_plan,
    generate_alter_stable_add_column_ddl,
    generate_alter_stable_add_tag_ddl,
    generate_drop_stable_ddl,
    generate_drop_table_ddl,
    is_system_stable,
    validate_database_spec,
    validate_identifier,
    validate_stable_spec,
    validate_subtable_spec,
)
from factorix.platform.tdengine import TDEngineClient, quote_str

logger = logging.getLogger(__name__)

# Drafts that could not be read back from PostgreSQL (unit tests with fake sessions).
_IN_MEMORY_DRAFTS: dict[tuple[UUID, UUID], dict[str, Any]] = {}

#: Columns the managed writer fills from the event contract (guide E1). They are never a binding
#: target; a STABLE may have any subset of them (only the existing ones are written).
WRITER_COLUMNS = frozenset({
    "event_key", "source_timestamp", "publish_timestamp", "field_source_timestamp", "quality",
    "quality_reason", "is_null", "model_ref", "model_field_path", "model_revision", "data_epoch",
    "source_event_uid", "time_basis",
})
RECORDING_MODES = ("ON_CHANGE", "ON_NEW_EVENT", "EVERY_ACQUISITION")
ROW_ASSEMBLY = ("INDEPENDENT_EVENTS", "ATOMIC_EVENT")
IN_PROGRESS = ("PREPARING", "APPLYING", "VERIFYING")
STUCK_AFTER = timedelta(minutes=5)

_HTTP_STATUS = {
    "VALIDATION_FAILED": 422,
    "BINDING_INVALID": 422,
    "NAME_CONFLICT": 409,
    "OPERATION_IN_PROGRESS": 409,
    "SYSTEM_OBJECT": 403,
    "DRAFT_NOT_FOUND": 404,
    "STORAGE_ENGINE_UNAVAILABLE": 503,
    "PUBLISH_FAILED": 502,
    "VERIFICATION_FAILED": 502,
    "REGISTRY_FAILED": 500,
}


def storage_error(code: str, message: str, errors: list[dict[str, Any]] | None = None) -> StorageObjectError:
    exc = StorageObjectError(code, message)
    exc.field_errors = errors or []  # type: ignore[attr-defined]
    exc.http_status = _HTTP_STATUS.get(code, 422)  # type: ignore[attr-defined]
    return exc


def _compute_spec_hash(spec_dict: Any) -> str:
    serialized = json.dumps(spec_dict, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:32]


def _int_or(value: Any, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise storage_error("VALIDATION_FAILED", f"'{value}' is not a whole number.") from None


# ---------------------------------------------------------------------------
# Spec normalisation (accepts the wizard payloads; R1-04 root causes: vgroups=null, role='timestamp')
# ---------------------------------------------------------------------------

def _database_spec(data: dict[str, Any]) -> DatabaseSpec:
    retention_days = data.get("retention_days")
    if retention_days not in (None, ""):
        days = _int_or(retention_days, 3650)
        keep = f"{days}d"
    else:
        keep = data.get("keep") or "3650d"
    return DatabaseSpec(
        name=str(data.get("name") or data.get("physical_name") or ""),
        precision=str(data.get("precision") or "us"),
        keep=keep,
        vgroups=_int_or(data.get("vgroups"), 1),
        replica=_int_or(data.get("replica"), 1),
        cache_model=data.get("cache_model") or None,
        description=str(data.get("description") or ""),
    )


def _length(raw: Any) -> int | None:
    if raw in (None, ""):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _type_and_length(td_type: Any, length: Any) -> tuple[str, int | None]:
    """``VARCHAR(64)`` (wizard style) -> ``("VARCHAR", 64)``; an explicit length wins (R1-17c)."""
    text = str(td_type or "").upper().strip()
    base, _, rest = text.partition("(")
    inline = _length(rest.rstrip(")").strip()) if rest else None
    return base.strip(), _length(length) if _length(length) is not None else inline


def stable_spec_from(data: dict[str, Any]) -> StableSpec:
    cols: list[ColumnSpec] = []
    for i, c in enumerate(data.get("columns") or []):
        if not isinstance(c, dict):
            continue
        td_type, col_length = _type_and_length(c.get("td_type") or c.get("type") or "DOUBLE", c.get("length"))
        role = str(c.get("role") or "").lower()
        if i == 0 and td_type == "TIMESTAMP" and role in ("", "timestamp", "time_key", "ts", "time"):
            role = "time_key"
        cols.append(ColumnSpec(
            name=str(c.get("name") or ""),
            td_type=td_type,
            length=col_length,
            role="time_key" if role == "time_key" else "value",
            nullable=bool(c.get("nullable", True)),
            description=str(c.get("description") or ""),
            primary_key=bool(c.get("primary_key") or c.get("composite_key")),
        ))
    tags = []
    for t in data.get("tags") or []:
        if not isinstance(t, dict):
            continue
        t_type, t_len = _type_and_length(t.get("td_type") or t.get("type") or "VARCHAR", t.get("length"))
        tags.append(TagSpec(
            name=str(t.get("name") or ""), td_type=t_type, length=t_len,
            required=bool(t.get("required", False)), description=str(t.get("description") or ""),
        ))
    return StableSpec(
        database=str(data.get("database") or data.get("database_name") or data.get("database_id") or ""),
        name=str(data.get("name") or data.get("physical_name") or ""),
        columns=cols,
        tags=tags,
        description=str(data.get("description") or ""),
    )


def _split_parent(data: dict[str, Any]) -> tuple[str, str]:
    db = str(data.get("database") or data.get("database_name") or "")
    stable = str(data.get("stable") or data.get("parent_stable") or data.get("stable_id") or "")
    if stable.startswith("stable:"):
        stable = stable[len("stable:"):]
    if "." in stable:
        # "<db>.<stable>" names the database explicitly; it wins over a defaulted "database" key.
        db, stable = stable.split(".", 1)
    return db, stable


def tag_values_from(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    out: dict[str, Any] = {}
    for tv in raw or []:
        if isinstance(tv, dict):
            key = tv.get("tag_name") or tv.get("name")
            if key:
                out[str(key)] = tv.get("value")
    return out


def subtable_spec_from(data: dict[str, Any]) -> SubtableSpec:
    db, stable = _split_parent(data)
    return SubtableSpec(
        database=db,
        stable=stable,
        name=str(data.get("name") or data.get("physical_name") or ""),
        tag_values=tag_values_from(data.get("tag_values")),
        description=str(data.get("description") or ""),
    )


def recording_from(data: dict[str, Any]) -> dict[str, Any]:
    rec = data.get("recording") if isinstance(data.get("recording"), dict) else {}
    mode = str(rec.get("mode") or data.get("recording_mode") or "ON_CHANGE").upper()
    row_assembly = str(
        rec.get("row_assembly") or data.get("row_assembly_policy") or ("ATOMIC_EVENT" if mode == "ON_NEW_EVENT" else "INDEPENDENT_EVENTS")
    ).upper()
    start = rec.get("start_recording", data.get("start_recording", False))
    identity = rec.get("identity_paths") or data.get("identity_paths") or []
    return {
        "mode": mode,
        "row_assembly": row_assembly,
        "start_recording": bool(start),
        "identity_paths": [SB.normalize_field_path(p) for p in identity if str(p or "").strip()],
        "quality_transitions": bool(rec.get("quality_transitions", True)),
    }


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, dict):
        for k in (key, key.capitalize(), key.upper()):
            if k in row:
                return row[k]
        return None
    if isinstance(row, (list, tuple)) and len(row) > index:
        return row[index]
    return None


def _base_type(td_type: str) -> str:
    return str(td_type or "").upper().split("(")[0].strip()


class StorageRevisionService:
    """Drafts, validation, physical plans and the publish saga for TDengine objects."""

    def __init__(self, td_client: TDEngineClient | None = None) -> None:
        self.td = td_client

    # ------------------------------------------------------------------
    # TDengine access helpers
    # ------------------------------------------------------------------

    async def _td_read(self, sql: str) -> list[Any]:
        if self.td is None:
            raise storage_error("STORAGE_ENGINE_UNAVAILABLE", "TDengine is not configured or not reachable.")
        if hasattr(self.td, "query_rows"):
            return list(await self.td.query_rows(sql) or [])
        return list(await self.td.run_read(sql) or [])

    async def _td_exec(self, sql: str) -> None:
        if self.td is None:
            raise storage_error("STORAGE_ENGINE_UNAVAILABLE", "TDengine is not configured or not reachable.")
        if hasattr(self.td, "execute_sql"):
            await self.td.execute_sql(sql)
        else:
            await self.td.run_write(sql)

    async def object_exists(self, kind: str, database: str, name: str) -> bool:
        if kind == "database":
            rows = await self._td_read(
                f"SELECT name FROM information_schema.ins_databases WHERE name = {quote_str(name)}"
            )
            return bool(rows)
        stables = await self._td_read(
            "SELECT stable_name FROM information_schema.ins_stables "
            f"WHERE db_name = {quote_str(database)} AND stable_name = {quote_str(name)}"
        )
        if stables:
            return True
        tables = await self._td_read(
            "SELECT table_name FROM information_schema.ins_tables "
            f"WHERE db_name = {quote_str(database)} AND table_name = {quote_str(name)}"
        )
        return bool(tables)

    async def describe(self, database: str, name: str) -> tuple[list[ColumnSpec], list[TagSpec]]:
        rows = await self._td_read(f"DESCRIBE `{database}`.`{name}`")
        cols: list[ColumnSpec] = []
        tags: list[TagSpec] = []
        for i, r in enumerate(rows):
            field = str(_row_value(r, "field", 0) or "")
            td_type = str(_row_value(r, "type", 1) or "")
            length = _length(_row_value(r, "length", 2))
            note = str(_row_value(r, "note", 3) or "").upper()
            if not field:
                continue
            if "TAG" in note:
                tags.append(TagSpec(name=field, td_type=_base_type(td_type), length=length))
            else:
                cols.append(ColumnSpec(
                    name=field, td_type=_base_type(td_type), length=length,
                    role="time_key" if i == 0 else "value", primary_key="COMPOSITE" in note or "PRIMARY" in note,
                ))
        return cols, tags

    async def stable_schema(
        self, session: AsyncSession, tenant_id: UUID, database: str, stable_name: str
    ) -> tuple[list[ColumnSpec], list[TagSpec]]:
        """Real schema of a parent STABLE: TDengine DESCRIBE first, then the registry."""
        if not database or not stable_name:
            return [], []
        if self.td is not None:
            try:
                cols, tags = await self.describe(database, stable_name)
                if cols:
                    return cols, tags
            except StorageObjectError:
                raise
            except Exception as exc:  # noqa: BLE001 - missing parent is reported by validation
                logger.info("DESCRIBE %s.%s failed: %s", database, stable_name, exc)
        row = await fetch_one(
            session,
            """
            SELECT schema_json, tags_json FROM storage_objects
            WHERE tenant_id = :tenant_id AND object_type = 'stable'
              AND physical_db = :db AND physical_name = :name AND status <> 'PURGED'
            """,
            {"tenant_id": tenant_id, "db": database, "name": stable_name},
        )
        if not row:
            return [], []
        reg = stable_spec_from({
            "database": database, "name": stable_name,
            "columns": _json_list(row.get("schema_json")),
            "tags": _json_list(row.get("tags_json")),
        })
        return reg.columns, reg.tags

    async def parent_schema(
        self, session: AsyncSession, tenant_id: UUID, sub: SubtableSpec, spec_data: dict[str, Any]
    ) -> tuple[list[ColumnSpec], list[TagSpec]]:
        """Schema of the parent STABLE. For planning a whole profile before anything exists, a plan
        request may carry ``parent_stable_spec`` (the STABLE spec it will be created from); it is used
        only when the parent does not exist yet and never by the publish saga."""
        cols, tags = await self.stable_schema(session, tenant_id, sub.database, sub.stable)
        hypo = spec_data.get("parent_stable_spec")
        if not cols and isinstance(hypo, dict) and not spec_data.get("_publishing"):
            parent = stable_spec_from({**hypo, "database": sub.database, "name": sub.stable})
            return parent.columns, parent.tags
        return cols, tags

    async def _resolve_stable_tags(
        self, session: AsyncSession, tenant_id: UUID, database: str, stable_name: str
    ) -> list[TagSpec]:
        return (await self.stable_schema(session, tenant_id, database, stable_name))[1]

    # ------------------------------------------------------------------
    # Draft lifecycle
    # ------------------------------------------------------------------

    async def create_draft(
        self, session: AsyncSession, tenant_id: UUID, actor_id: UUID | None, data: dict[str, Any]
    ) -> dict[str, Any]:
        draft_id = uuid4()
        kind = str(data.get("kind") or data.get("object_kind") or "stable").lower()
        spec = data.get("spec") or data
        name = str(data.get("name") or spec.get("name") or spec.get("physical_name") or f"draft_{draft_id.hex[:8]}")
        now = utcnow()
        spec_hash = _compute_spec_hash(spec)
        record = {
            "id": str(draft_id), "tenant_id": str(tenant_id), "object_kind": kind, "name": name,
            "revision": 1, "spec": spec, "state": "DRAFT", "created_by": str(actor_id) if actor_id else None,
            "created_at": iso_ms(now), "updated_at": iso_ms(now), "hash": spec_hash,
        }
        await execute(
            session,
            """
            INSERT INTO storage_object_drafts (
                id, tenant_id, object_kind, name, revision, spec_json,
                state, created_by, spec_hash, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :kind, :name, 1, :spec,
                'DRAFT', :created_by, :spec_hash, :now, :now
            )
            """,
            {"id": draft_id, "tenant_id": tenant_id, "kind": kind, "name": name, "spec": jsonb(spec),
             "created_by": actor_id, "spec_hash": spec_hash, "now": now},
        )
        await session.commit()
        _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = record
        return record

    async def get_draft(self, session: AsyncSession, tenant_id: UUID, draft_id: UUID) -> dict[str, Any] | None:
        row = await fetch_one(
            session,
            """
            SELECT id, tenant_id, object_kind, name, revision, spec_json,
                   state, created_by, spec_hash, created_at, updated_at
            FROM storage_object_drafts
            WHERE tenant_id = :tenant_id AND id = :draft_id
            """,
            {"tenant_id": tenant_id, "draft_id": draft_id},
        )
        if row:
            spec = row["spec_json"]
            if isinstance(spec, str):
                spec = json.loads(spec)
            return {
                "id": str(row["id"]), "tenant_id": str(row["tenant_id"]),
                "object_kind": str(row["object_kind"]), "name": str(row["name"]),
                "revision": int(row["revision"] or 1), "spec": spec, "state": str(row["state"]),
                "created_by": str(row["created_by"]) if row.get("created_by") else None,
                "created_at": iso_ms(row["created_at"]) if row.get("created_at") else None,
                "updated_at": iso_ms(row["updated_at"]) if row.get("updated_at") else None,
                "hash": str(row.get("spec_hash") or ""),
            }
        return _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))

    async def list_drafts(self, session: AsyncSession, tenant_id: UUID, kind: str | None = None) -> list[dict[str, Any]]:
        rows = await fetch_all(
            session,
            """
            SELECT id, object_kind, name, revision, state, spec_json, updated_at
            FROM storage_object_drafts
            WHERE tenant_id = :tenant_id AND state = 'DRAFT'
              AND (CAST(:kind AS text) IS NULL OR object_kind = :kind)
            ORDER BY updated_at DESC
            LIMIT 100
            """,
            {"tenant_id": tenant_id, "kind": kind},
        )
        return [
            {"id": str(r["id"]), "object_kind": r["object_kind"], "name": r["name"],
             "revision": int(r["revision"] or 1), "state": r["state"],
             "spec": json.loads(r["spec_json"]) if isinstance(r["spec_json"], str) else r["spec_json"],
             "updated_at": iso_ms(r["updated_at"]) if r.get("updated_at") else None}
            for r in rows
        ]

    async def patch_draft(
        self, session: AsyncSession, tenant_id: UUID, draft_id: UUID, actor_id: UUID | None, updates: dict[str, Any]
    ) -> dict[str, Any]:
        draft = await self.get_draft(session, tenant_id, draft_id)
        if not draft:
            raise storage_error("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")
        expected = updates.get("revision")
        if expected is not None and int(expected) != int(draft.get("revision", 1)):
            raise storage_error("OPERATION_IN_PROGRESS", "The draft was changed elsewhere; reload it.")
        if "spec" in updates and isinstance(updates["spec"], dict):
            draft["spec"] = {**draft["spec"], **updates["spec"]}
        if "name" in updates:
            draft["name"] = updates["name"]
        draft["revision"] = int(draft.get("revision", 1)) + 1
        now = utcnow()
        draft["updated_at"] = iso_ms(now)
        draft["hash"] = _compute_spec_hash(draft["spec"])
        await execute(
            session,
            """
            UPDATE storage_object_drafts
            SET name = :name, revision = :revision, spec_json = :spec, spec_hash = :hash, updated_at = :now
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            {"id": draft_id, "tenant_id": tenant_id, "name": draft["name"], "revision": draft["revision"],
             "spec": jsonb(draft["spec"]), "hash": draft["hash"], "now": now},
        )
        await session.commit()
        _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = draft
        return draft

    # ------------------------------------------------------------------
    # Validation & planning
    # ------------------------------------------------------------------

    async def _spec_of(self, session: AsyncSession, tenant_id: UUID, draft_id: UUID | None,
                       custom_spec: dict[str, Any] | None) -> tuple[str, dict[str, Any]]:
        if custom_spec:
            kind = str(custom_spec.get("kind") or "stable").lower()
            return kind, dict(custom_spec.get("spec") or custom_spec)
        if draft_id is None:
            raise storage_error("DRAFT_NOT_FOUND", "No draft or specification given.")
        draft = await self.get_draft(session, tenant_id, draft_id)
        if not draft:
            raise storage_error("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")
        return draft["object_kind"], dict(draft["spec"])

    async def validate_draft(
        self, session: AsyncSession, tenant_id: UUID, draft_id: UUID | None, custom_spec: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        kind, spec_data = await self._spec_of(session, tenant_id, draft_id, custom_spec)
        try:
            v_res, extra = await self._validate(session, tenant_id, kind, spec_data)
        except StorageObjectError as exc:
            errors = getattr(exc, "field_errors", None) or [{"field": exc.field or "", "code": exc.code, "message": str(exc)}]
            return {"valid": False, "errors": errors, "warnings": [], "estimated_row_bytes": 0}
        return {
            "valid": v_res.valid,
            "errors": v_res.errors,
            "warnings": v_res.warnings,
            "estimated_row_bytes": getattr(v_res, "estimated_row_bytes", 0),
            **({"bindings": extra.get("bindings")} if extra.get("bindings") is not None else {}),
        }

    async def _validate(
        self, session: AsyncSession, tenant_id: UUID, kind: str, spec_data: dict[str, Any]
    ) -> tuple[ValidationResult, dict[str, Any]]:
        extra: dict[str, Any] = {}
        display = str(spec_data.get("display_name") or "")
        if kind == "database":
            res = validate_database_spec(_database_spec(spec_data))
        elif kind == "stable":
            st = stable_spec_from(spec_data)
            res = validate_stable_spec(st)
            if spec_data.get("retention_days") not in (None, ""):
                try:
                    if int(spec_data["retention_days"]) < 1:
                        raise ValueError
                except (TypeError, ValueError):
                    res.errors.append({"field": "retention_days", "code": "INVALID_RETENTION",
                                       "message": "Retention must be a positive number of days (supertables inherit the database retention)."})
                    res.valid = False
        elif kind == "subtable":
            sub = subtable_spec_from(spec_data)
            cols, tags = await self.parent_schema(session, tenant_id, sub, spec_data)
            res = validate_subtable_spec(sub, tags)
            extra["stable_columns"] = cols
            extra["stable_tags"] = tags
            try:
                extra["bindings"] = await self.resolve_bindings(session, tenant_id, sub, cols, spec_data)
            except StorageObjectError as exc:
                res.errors.extend(getattr(exc, "field_errors", None) or [{"field": "bindings", "code": exc.code, "message": str(exc)}])
                res.valid = False
            else:
                mismatch = await self.machine_tag_errors(session, tenant_id, sub, extra["bindings"])
                if mismatch:
                    res.errors.extend(mismatch)
                    res.valid = False
        else:
            res = ValidationResult(valid=False, errors=[{"field": "kind", "code": "UNKNOWN_KIND", "message": f"Unknown object kind '{kind}'."}])
        if len(display) > MAX_DISPLAY_NAME_LEN:
            res.errors.append({"field": "display_name", "code": "DISPLAY_NAME_TOO_LONG",
                               "message": f"Display name is limited to {MAX_DISPLAY_NAME_LEN} characters."})
            res.valid = False
        return res, extra

    async def resolve_bindings(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        sub: SubtableSpec,
        columns: list[ColumnSpec],
        spec_data: dict[str, Any],
        *,
        models: dict[str, dict[str, Any]] | None = None,
        owners: dict[tuple[str, str], dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """Validate and normalise the bindings of a subtable (G-02: model_id + field path persisted).

        ``models`` / ``owners`` are caches a caller validating many subtables passes in (bulk, R2-05):
        models found there are not queried again, and ``owners`` replaces the per-call owner lookup."""
        raw = [b for b in (spec_data.get("bindings") or []) if isinstance(b, dict)]
        recording = recording_from(spec_data)
        errors: list[dict[str, Any]] = []

        def err(index: int | None, code: str, message: str) -> None:
            errors.append({"field": "bindings" if index is None else f"bindings[{index}]", "code": code, "message": message})

        if recording["mode"] not in RECORDING_MODES:
            err(None, "INVALID_MODE", f"Recording mode must be one of {', '.join(RECORDING_MODES)}.")
        if recording["row_assembly"] not in ROW_ASSEMBLY:
            err(None, "INVALID_ROW_ASSEMBLY", f"Row assembly must be one of {', '.join(ROW_ASSEMBLY)}.")
        if (recording["mode"] == "ON_NEW_EVENT") != (recording["row_assembly"] == "ATOMIC_EVENT"):
            err(None, "EVENT_MODE_MISMATCH", "On new event recording writes one atomic row per event (row assembly ATOMIC_EVENT) and vice versa.")
        if not raw:
            if not spec_data.get("no_binding"):
                err(None, "BINDING_REQUIRED", "Bind at least one source field, or choose 'Create without a binding' explicitly.")
            if errors:
                raise storage_error("BINDING_INVALID", errors[0]["message"], errors)
            return []

        col_by_name = {c.name: c for c in columns}
        ts_col = columns[0].name if columns else "ts"
        key_cols = {c.name for c in columns if c.primary_key}
        models = models if models is not None else {}
        model_ids = []
        for b in raw:
            if not b.get("model_id") and str(b.get("source_kind") or "") == "model_field":
                try:
                    model_ids.append(str(UUID(str(b.get("source_id") or ""))))
                    continue
                except ValueError:
                    pass
            mid = b.get("model_id") or (str(b.get("source_id") or b.get("canonical_id") or "").split(":")[1]
                                        if str(b.get("source_id") or b.get("canonical_id") or "").startswith("mod:") else None)
            if mid:
                model_ids.append(str(mid))
        if model_ids:
            missing = [m for m in model_ids if m not in models]
            models.update(await load_models(session, tenant_id, missing))
        if owners is None:
            owners = await SB.bound_model_fields(session, tenant_id)
        out: list[dict[str, Any]] = []
        used_cols: set[str] = set()
        for i, b in enumerate(raw):
            col = str(b.get("target_column") or b.get("column_name") or b.get("destination_column") or "")
            kind = str(b.get("source_kind") or b.get("kind") or "").lower()
            can = str(b.get("canonical_id") or b.get("source_id") or "")
            if not kind:
                kind = "model_field" if can.startswith("mod:") or b.get("model_id") else ("signal" if can.startswith("sig:") or b.get("signal_id") else "")
            if kind == "model_field" and not b.get("model_id") and not can.startswith("mod:"):
                try:
                    b = {**b, "model_id": str(UUID(can))}  # a bare model id: the model, not a field
                except ValueError:
                    pass
            if col not in col_by_name:
                err(i, "UNKNOWN_COLUMN", f"Column '{col}' does not exist in supertable '{sub.stable}'.")
                continue
            if col == ts_col or col in key_cols or col in WRITER_COLUMNS:
                err(i, "RESERVED_COLUMN", f"Column '{col}' is filled by the recorder (timestamp / key / audit); bind a value column.")
                continue
            if col in used_cols:
                err(i, "DUPLICATE_COLUMN", f"Column '{col}' is bound twice.")
                continue
            used_cols.add(col)
            column = col_by_name[col]
            if kind == "model_field":
                mid = str(b.get("model_id") or (can.split(":")[1] if can.startswith("mod:") else ""))
                path = SB.normalize_field_path(
                    b.get("model_field_path") or b.get("field_path") or b.get("source_path")
                    or (can.split(":", 2)[2] if can.startswith("mod:") and can.count(":") >= 2 else "")
                )
                model = models.get(mid)
                if model is None:
                    err(i, "MODEL_NOT_FOUND", "The selected Data Model does not exist (or is archived) in this tenant.")
                    continue
                leaf = model["leaves"].get(path)
                if leaf is None:
                    err(i, "FIELD_NOT_FOUND", f"'{path or '(empty)'}' is not a field of '{model['name']}'. Pick a field, not the model.")
                    continue
                owner = owners.get((mid, path))
                if owner and (owner["database"], owner["subtable"]) != (sub.database, sub.name):
                    err(i, "FIELD_ALREADY_RECORDED",
                        f"'{model['name']} · {path}' is already recorded in {owner['database']}.{owner['subtable']} (one owner per field).")
                    continue
                if not SB.model_type_compatible(leaf["value_type"], column.td_type):
                    err(i, "TYPE_MISMATCH",
                        f"Field '{path}' ({leaf['value_type']}) cannot be stored in column '{col}' ({column.td_type}).")
                    continue
                out.append({
                    "source_kind": "model_field", "canonical_id": f"mod:{mid}:{path}", "model_id": mid,
                    "model_field_path": path, "signal_id": None, "target_column": col,
                    "source_data_type": leaf["value_type"], "model_name": model["name"],
                    "model_revision": model["version"], "column_type": column.td_type,
                })
            elif kind == "signal":
                sid = str(b.get("signal_id") or can.replace("sig:", ""))
                try:
                    sid_uuid = UUID(sid)
                except ValueError:
                    err(i, "SIGNAL_NOT_FOUND", "The selected signal id is not valid.")
                    continue
                sig = await fetch_one(
                    session,
                    "SELECT id, key, data_type FROM signal_definitions WHERE tenant_id = :tenant_id AND id = :id AND status = 'ACTIVE'",
                    {"tenant_id": tenant_id, "id": sid_uuid},
                )
                if not sig:
                    err(i, "SIGNAL_NOT_FOUND", "The selected signal does not exist or is not active.")
                    continue
                ok, msg = SB.StorageBindingService().validate_binding("signal", str(sig["data_type"]), column.td_type)
                if not ok:
                    err(i, "TYPE_MISMATCH", msg or "Type mismatch.")
                    continue
                out.append({
                    "source_kind": "signal", "canonical_id": f"sig:{sid_uuid}", "model_id": None,
                    "model_field_path": None, "signal_id": str(sid_uuid), "target_column": col,
                    "source_data_type": str(sig["data_type"]), "column_type": column.td_type,
                })
            else:
                err(i, "SOURCE_KIND_REQUIRED", "Choose a Data Model field (or a signal) as the source.")
        if not errors and recording["row_assembly"] == "ATOMIC_EVENT":
            mids = {b["model_id"] for b in out}
            if len(mids) != 1 or any(b["source_kind"] != "model_field" for b in out):
                err(None, "ATOMIC_EVENT_SOURCE", "An atomic event row takes all its fields from one Data Model.")
        if not errors and recording["mode"] == "ON_NEW_EVENT":
            leaves = models[out[0]["model_id"]]["leaves"] if out else {}
            for p in recording["identity_paths"]:
                if p not in leaves:
                    err(None, "IDENTITY_FIELD_NOT_FOUND", f"Event identity field '{p}' is not a field of the model.")
        if errors:
            raise storage_error("BINDING_INVALID", errors[0]["message"], errors)
        return out

    async def machine_tag_errors(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        sub: SubtableSpec,
        bindings: list[dict[str, Any]],
        *,
        ctx: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """R2-09 / guide K1 (no cross-machine rows): a tag whose value is a *machine* of the Factory
        Model must be the machine the bound source belongs to (the model's machine, or the signal's
        resource). Tags that are not machine ids (lines, zones, free text) are not checked, and a
        source whose machine cannot be determined is not guessed. ``ctx`` caches the resource index /
        signal map / model rows across calls (bulk)."""
        if not bindings or not sub.tag_values:
            return []
        tag_ids: dict[str, str] = {}
        for name, value in sub.tag_values.items():
            try:
                tag_ids[name] = str(UUID(str(value)))
            except (TypeError, ValueError, AttributeError):
                continue
        if not tag_ids:
            return []
        ctx = ctx if ctx is not None else {}
        if "resources" not in ctx:
            ctx["resources"] = await SB.load_resource_index(session, tenant_id)
        resources: dict[str, dict[str, Any]] = ctx["resources"]

        def is_machine(rid: str | None) -> bool:
            return bool(rid) and rid in resources and "machine" in resources[rid]["type_key"].lower()

        machine_tags = {k: v for k, v in tag_ids.items() if is_machine(v)}
        if not machine_tags:
            return []
        if "signals" not in ctx:
            ctx["signals"] = await SB.signal_resource_map(session, tenant_id)
        signal_res: dict[str, str] = ctx["signals"]
        model_rows: dict[str, dict[str, Any]] = ctx.setdefault("models", {})
        want = [str(b["model_id"]) for b in bindings if b.get("model_id") and str(b["model_id"]) not in model_rows]
        if want:
            model_rows.update(await load_models(session, tenant_id, want))
        errors: list[dict[str, Any]] = []
        for b in bindings:
            owner: str | None = None
            label = str(b.get("model_field_path") or b.get("canonical_id") or "source")
            if b.get("model_id"):
                m = model_rows.get(str(b["model_id"])) or {}
                rid = str(m["resource_id"]) if m.get("resource_id") else None
                owner = rid if is_machine(rid) else SB.model_resource_id(m.get("spec_json"), resources, signal_res)
                label = f"{m.get('name') or b.get('model_name') or 'model'} · {b.get('model_field_path')}"
            elif b.get("signal_id"):
                owner = signal_res.get(str(b["signal_id"]).lower())
            if not is_machine(owner):
                continue
            for tag, rid in machine_tags.items():
                if rid != owner:
                    errors.append({
                        "field": f"tag_values.{tag}", "code": "TAG_MACHINE_MISMATCH",
                        "message": (f"Tag '{tag}' is machine '{resources[rid]['name']}', but '{label}' belongs to "
                                    f"machine '{resources[owner]['name']}'. A subtable records one machine; "
                                    "use that machine's id."),
                        "expected": owner,
                    })
        return errors

    async def plan_draft(
        self, session: AsyncSession, tenant_id: UUID, draft_id: UUID | None, custom_spec: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """The exact DDL the saga will execute (Review step shows THIS, not a client-side guess)."""
        kind, spec_data = await self._spec_of(session, tenant_id, draft_id, custom_spec)
        steps: list[DdlStep] = []
        bindings: list[dict[str, Any]] | None = None
        warnings: list[dict[str, Any]] = []
        if kind == "database":
            steps = build_create_database_plan(_database_spec(spec_data))
        elif kind == "stable":
            steps = build_create_stable_plan(stable_spec_from(spec_data))
        elif kind == "subtable":
            sub = subtable_spec_from(spec_data)
            cols, tags = await self.parent_schema(session, tenant_id, sub, spec_data)
            steps = build_create_subtable_plan(sub, tags)
            try:
                bindings = await self.resolve_bindings(session, tenant_id, sub, cols, spec_data)
            except StorageObjectError as exc:
                warnings.extend(getattr(exc, "field_errors", []) or [])
        else:
            raise storage_error("VALIDATION_FAILED", f"Unknown object kind '{kind}'.")
        return {
            "draft_id": str(draft_id) if draft_id else None,
            "kind": kind,
            "steps": [{"action": s.action, "sql": s.sql, "idempotent": s.idempotent, "description": s.description} for s in steps],
            "ddl": [s.sql for s in steps],
            "bindings": bindings,
            "recording": recording_from(spec_data) if kind == "subtable" else None,
            "warnings": warnings,
            "requires_downtime": False,
            "estimated_impact": f"{len(steps)} DDL statement(s)",
        }

    async def simulate_draft(self, session: AsyncSession, tenant_id: UUID, draft_id: UUID) -> dict[str, Any]:
        """No synthetic rows (G-09 / R1-18): report what a real write would contain, without data."""
        draft = await self.get_draft(session, tenant_id, draft_id)
        return {
            "draft_id": str(draft_id),
            "simulated": True,
            "sample_rows": [],
            "note": "No sample rows are generated. Real rows appear after the object is created and recording is started.",
            "spec_hash": draft.get("hash") if draft else None,
        }

    # ------------------------------------------------------------------
    # Publish saga
    # ------------------------------------------------------------------

    async def publish_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
        actor_id: UUID | None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        draft = await self.get_draft(session, tenant_id, draft_id)
        if not draft:
            raise storage_error("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")
        kind = str(draft["object_kind"])
        spec_data = dict(draft["spec"])
        spec_hash = draft.get("hash") or _compute_spec_hash(spec_data)
        op_type = f"CREATE_{kind.upper()}"

        if self.td is None:
            raise storage_error("STORAGE_ENGINE_UNAVAILABLE", "TDengine is not configured or not reachable.")

        # 1. Validate everything before touching TDengine (against the REAL parent only).
        spec_data.pop("parent_stable_spec", None)
        v_res, extra = await self._validate(session, tenant_id, kind, spec_data)
        if not v_res.valid:
            first = v_res.errors[0]["message"] if v_res.errors else "Validation failed"
            raise storage_error("VALIDATION_FAILED", first, v_res.errors)
        if kind == "database":
            db_spec = _database_spec(spec_data)
            db_name, obj_name = db_spec.name, db_spec.name
        elif kind == "stable":
            st_spec = stable_spec_from(spec_data)
            db_name, obj_name = st_spec.database, st_spec.name
        else:
            sub_spec = subtable_spec_from(spec_data)
            db_name, obj_name = sub_spec.database, sub_spec.name
        object_key = obj_name if kind == "database" else f"{db_name}.{obj_name}"
        key = idempotency_key or f"{object_key}:{spec_hash}"

        # 2. Idempotent replay / in-flight detection.
        op_id: UUID | None = None
        prior = await fetch_one(
            session,
            """
            SELECT id, status, started_at, requested_at FROM storage_operations
            WHERE tenant_id = :tenant_id AND operation_type = :op_type AND idempotency_key = :key
            """,
            {"tenant_id": tenant_id, "op_type": op_type, "key": key},
        )
        exists = await self.object_exists(kind, db_name, obj_name)
        if prior:
            st = str(prior["status"])
            started = prior.get("started_at") or prior.get("requested_at")
            if st in ("APPLIED", "COMPLETED") and exists:
                return {"operation_id": str(prior["id"]), "status": "APPLIED", "idempotent_replay": True,
                        "object_key": object_key}
            if st in IN_PROGRESS and started is not None and utcnow() - started < STUCK_AFTER:
                raise storage_error("OPERATION_IN_PROGRESS",
                                    f"Creating {object_key} is already in progress (operation {prior['id']}).")
            op_id = UUID(str(prior["id"]))
        # 3. Name clash.
        if exists:
            raise storage_error(
                "NAME_CONFLICT",
                f"A {'database' if kind == 'database' else 'table or supertable'} named '{object_key}' already exists in TDengine. "
                "Open it instead, or choose another name.",
                [{"field": "name", "code": "NAME_CONFLICT", "message": f"'{obj_name}' already exists."}],
            )
        steps = (await self.plan_draft(session, tenant_id, draft_id))["steps"]
        now = utcnow()
        state = {"phase": "PREPARING", "steps_total": len(steps), "steps_done": 0, "object_key": object_key}
        if op_id is None:
            op_id = uuid4()
            await execute(
                session,
                """
                INSERT INTO storage_operations (
                    id, tenant_id, operation_type, target_type, target_id, actor_id, idempotency_key,
                    status, requested_at, started_at, step_state_json, spec_hash, object_key
                ) VALUES (
                    :id, :tenant_id, :op_type, :target_type, :target_id, :actor_id, :key,
                    'PREPARING', :now, :now, :state, :spec_hash, :object_key
                )
                """,
                {"id": op_id, "tenant_id": tenant_id, "op_type": op_type, "target_type": kind, "target_id": draft_id,
                 "actor_id": actor_id, "key": key, "now": now, "state": jsonb(state), "spec_hash": spec_hash,
                 "object_key": object_key},
            )
        else:
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'PREPARING', started_at = :now, completed_at = NULL, error_code = NULL,
                    error_message = NULL, step_state_json = :state, target_id = :target_id, object_key = :object_key
                WHERE id = :id
                """,
                {"id": op_id, "now": now, "state": jsonb(state), "target_id": draft_id, "object_key": object_key},
            )
        await session.commit()

        async def mark_failed(code: str, message: str, phase_state: dict[str, Any]) -> None:
            await session.rollback()
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'FAILED', completed_at = :now, error_code = :code, error_message = :msg,
                    step_state_json = :state
                WHERE id = :id
                """,
                {"id": op_id, "now": utcnow(), "code": code, "msg": message[:2000], "state": jsonb(phase_state)},
            )
            await execute(
                session,
                "UPDATE storage_object_drafts SET state = 'FAILED', updated_at = :now WHERE tenant_id = :tenant_id AND id = :id",
                {"id": draft_id, "tenant_id": tenant_id, "now": utcnow()},
            )
            await session.commit()

        # 4. DDL.
        executed: list[str] = []
        await execute(session, "UPDATE storage_operations SET status = 'APPLYING', step_state_json = :state WHERE id = :id",
                      {"id": op_id, "state": jsonb({**state, "phase": "APPLYING"})})
        await session.commit()
        try:
            for step in steps:
                logger.info("Executing TDengine DDL: %s", step["sql"])
                await self._td_exec(step["sql"])
                executed.append(step["sql"])
        except Exception as exc:  # noqa: BLE001 - surfaced as FAILED + PUBLISH_FAILED
            await mark_failed("DDL_EXECUTION_ERROR", str(exc), {**state, "phase": "FAILED", "executed_sqls": executed})
            raise storage_error("PUBLISH_FAILED", f"TDengine rejected the DDL: {exc}") from exc

        # 5. Read-back verification against the spec.
        await execute(session, "UPDATE storage_operations SET status = 'VERIFYING', step_state_json = :state WHERE id = :id",
                      {"id": op_id, "state": jsonb({**state, "phase": "VERIFYING", "executed_sqls": executed})})
        await session.commit()
        try:
            verification = await self._verify(kind, spec_data, extra)
        except Exception as exc:  # noqa: BLE001
            verification = {"read_back_ok": False, "problems": [str(exc)]}
        if not verification.get("read_back_ok"):
            compensated = await self._compensate(kind, db_name, obj_name)
            msg = "; ".join(verification.get("problems") or ["read-back mismatch"])
            await mark_failed("VERIFICATION_FAILED", msg, {**state, "phase": "FAILED", "executed_sqls": executed,
                                                           "verification": verification, "compensated": compensated})
            raise storage_error("VERIFICATION_FAILED", f"The created object does not match the request ({msg}). "
                                + ("It was removed again." if compensated else "It could not be removed automatically."))

        # 6. Registry + bindings + APPLIED in one transaction.
        try:
            obj_id = await self._register(session, tenant_id, kind, spec_data, extra, db_name, obj_name, spec_hash)
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'APPLIED', completed_at = :now, verification_json = :v, step_state_json = :state
                WHERE id = :id
                """,
                {"id": op_id, "now": utcnow(), "v": jsonb({**verification, "verified_at": iso_ms(utcnow())}),
                 "state": jsonb({**state, "phase": "APPLIED", "steps_done": len(steps), "executed_sqls": executed,
                                 "object_id": str(obj_id)})},
            )
            await execute(
                session,
                "UPDATE storage_object_drafts SET state = 'APPLIED', updated_at = :now WHERE tenant_id = :tenant_id AND id = :id",
                {"id": draft_id, "tenant_id": tenant_id, "now": utcnow()},
            )
            await session.commit()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Registry write failed for %s", object_key)
            compensated = await self._compensate(kind, db_name, obj_name)
            await mark_failed("REGISTRY_FAILED", str(exc), {**state, "phase": "FAILED", "executed_sqls": executed,
                                                             "compensated": compensated})
            raise storage_error("REGISTRY_FAILED", f"The object could not be registered: {exc}") from exc
        draft["state"] = "APPLIED"
        _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = draft
        if kind == "subtable":
            try:
                from factorix.modules import storage_model_recorder

                storage_model_recorder.invalidate_bindings(tenant_id)
            except Exception:  # noqa: BLE001 - cache invalidation is best effort; TTL reloads anyway
                pass
        return {
            "operation_id": str(op_id),
            "status": "APPLIED",
            "executed_steps": len(executed),
            "object_key": object_key,
            "object_id": str(obj_id),
            "ddl": executed,
            "verification": verification,
        }

    async def _compensate(self, kind: str, database: str, name: str) -> bool:
        """Drop an object THIS operation created (it did not exist before the saga started)."""
        try:
            if kind == "database":
                sql = f"DROP DATABASE IF EXISTS `{database}`"
            elif kind == "stable":
                sql = generate_drop_stable_ddl(database, name)
            else:
                sql = generate_drop_table_ddl(database, name)
            await self._td_exec(sql)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.error("Compensation failed for %s %s.%s: %s", kind, database, name, exc)
            return False

    async def _verify(self, kind: str, spec_data: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
        problems: list[str] = []
        if kind == "database":
            spec = _database_spec(spec_data)
            rows = await self._td_read(
                f"SELECT name, `precision` FROM information_schema.ins_databases WHERE name = {quote_str(spec.name)}"
            )
            if not rows:
                problems.append(f"database '{spec.name}' not found")
            else:
                prec = str(_row_value(rows[0], "precision", 1) or "").lower()
                if prec and prec != spec.precision.lower():
                    problems.append(f"precision is {prec}, expected {spec.precision}")
        elif kind == "stable":
            spec = stable_spec_from(spec_data)
            cols, tags = await self.describe(spec.database, spec.name)
            if [c.name for c in cols] != [c.name for c in spec.columns]:
                problems.append("columns differ: " + ", ".join(c.name for c in cols))
            for want, got in zip(spec.columns, cols, strict=False):
                if _base_type(want.td_type) != _base_type(got.td_type):
                    problems.append(f"{want.name}: type {got.td_type}, expected {want.td_type}")
                if want.length and got.length and int(want.length) != int(got.length):
                    problems.append(f"{want.name}: length {got.length}, expected {want.length}")
                if want.primary_key != got.primary_key:
                    problems.append(f"{want.name}: composite key {'missing' if want.primary_key else 'unexpected'}")
            if [t.name for t in tags] != [t.name for t in spec.tags]:
                problems.append("tags differ: " + ", ".join(t.name for t in tags))
        else:
            spec = subtable_spec_from(spec_data)
            rows = await self._td_read(
                "SELECT table_name, stable_name FROM information_schema.ins_tables "
                f"WHERE db_name = {quote_str(spec.database)} AND table_name = {quote_str(spec.name)}"
            )
            if not rows:
                problems.append(f"subtable '{spec.name}' not found")
            elif str(_row_value(rows[0], "stable_name", 1) or "") != spec.stable:
                problems.append(f"parent is {_row_value(rows[0], 'stable_name', 1)}, expected {spec.stable}")
            tag_rows = await self._td_read(
                "SELECT tag_name, tag_value FROM information_schema.ins_tags "
                f"WHERE db_name = {quote_str(spec.database)} AND table_name = {quote_str(spec.name)}"
            )
            got_tags = {str(_row_value(r, "tag_name", 0)): _row_value(r, "tag_value", 1) for r in tag_rows}
            for tag in extra.get("stable_tags") or []:
                want = spec.tag_values.get(tag.name)
                got = got_tags.get(tag.name)
                if want is None:
                    continue
                if str(got) != str(want):
                    problems.append(f"tag {tag.name}={got!r}, expected {want!r}")
        return {"read_back_ok": not problems, "problems": problems, "object_kind": kind}

    async def _register(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        kind: str,
        spec_data: dict[str, Any],
        extra: dict[str, Any],
        db_name: str,
        obj_name: str,
        spec_hash: str,
    ) -> UUID:
        now = utcnow()
        parent_name: str | None = None
        parent_id: Any = None
        recording: dict[str, Any] = {}
        status = "ACTIVE"
        if kind == "stable":
            st = stable_spec_from(spec_data)
            schema = [{"name": c.name, "td_type": c.td_type, "length": c.length, "role": c.role,
                       "primary_key": c.primary_key} for c in st.columns]
            tags: Any = [{"name": t.name, "td_type": t.td_type, "length": t.length} for t in st.tags]
            recording = {"default_mode": recording_from(spec_data)["mode"]}
        elif kind == "subtable":
            sub = subtable_spec_from(spec_data)
            parent_name = sub.stable
            schema = []
            tags = sub.tag_values
            recording = recording_from(spec_data)
            status = "ACTIVE" if recording["start_recording"] else "PAUSED"
            prow = await fetch_one(
                session,
                """
                SELECT id FROM storage_objects WHERE tenant_id = :tenant_id AND object_type = 'stable'
                  AND physical_db = :db AND physical_name = :name AND status <> 'PURGED'
                """,
                {"tenant_id": tenant_id, "db": db_name, "name": sub.stable},
            )
            parent_id = prow["id"] if prow else None
        else:
            db = _database_spec(spec_data)
            schema = []
            tags = {"precision": db.precision, "keep": db.keep}
        obj_id = uuid4()
        row = await fetch_one(
            session,
            """
            INSERT INTO storage_objects (
                id, tenant_id, object_type, physical_db, physical_name, parent_id, parent_name,
                display_name, description, status, schema_json, tags_json, recording_json,
                binding_revision, revision, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :kind, :db, :name, :parent_id, :parent_name,
                :display_name, :description, :status, :schema, :tags, :recording, 1, 1, :now, :now
            )
            ON CONFLICT (tenant_id, object_type, physical_db, physical_name) DO UPDATE SET
                parent_id = EXCLUDED.parent_id, parent_name = EXCLUDED.parent_name,
                display_name = EXCLUDED.display_name, description = EXCLUDED.description,
                status = EXCLUDED.status, schema_json = EXCLUDED.schema_json, tags_json = EXCLUDED.tags_json,
                recording_json = EXCLUDED.recording_json, revision = storage_objects.revision + 1,
                updated_at = EXCLUDED.updated_at
            WHERE storage_objects.status = 'PURGED'
            RETURNING id
            """,
            {"id": obj_id, "tenant_id": tenant_id, "kind": kind, "db": db_name, "name": obj_name,
             "parent_id": parent_id, "parent_name": parent_name,
             "display_name": str(spec_data.get("display_name") or obj_name),
             "description": str(spec_data.get("description") or ""), "status": status,
             "schema": jsonb(schema), "tags": jsonb(tags), "recording": jsonb(recording), "now": now},
        )
        if not row:
            raise storage_error("NAME_CONFLICT", f"'{db_name}.{obj_name}' is already registered.")
        obj_id = UUID(str(row["id"]))
        if kind == "subtable":
            bindings = extra.get("bindings") or []
            first_type = bindings[0]["source_data_type"] if bindings else "none"
            await execute(
                session,
                """
                INSERT INTO storage_physical_registry (
                    id, tenant_id, tier, series_key, value_type, td_database, td_stable, td_subtable,
                    physical_schema_hash, generation, status, created_at, updated_at
                ) VALUES (
                    :id, :tenant_id, 'MANAGED', :series_key, :value_type, :db, :stable, :sub,
                    :hash, 1, :status, :now, :now
                )
                ON CONFLICT (td_database, td_subtable) DO UPDATE SET
                    td_stable = EXCLUDED.td_stable, value_type = EXCLUDED.value_type, status = EXCLUDED.status,
                    physical_schema_hash = EXCLUDED.physical_schema_hash,
                    generation = storage_physical_registry.generation + 1, updated_at = EXCLUDED.updated_at
                """,
                {"id": uuid4(), "tenant_id": tenant_id, "series_key": f"{db_name}.{obj_name}",
                 "value_type": str(first_type)[:32], "db": db_name, "stable": parent_name, "sub": obj_name,
                 "hash": spec_hash, "status": "ACTIVE" if status == "ACTIVE" else "PAUSED", "now": now},
            )
            # The physical table did not exist before this saga: older binding/state rows of a purged
            # table with the same name are stale and must not leak into the new object.
            params = {"tenant_id": tenant_id, "db": db_name, "sub": obj_name}
            await execute(session, "DELETE FROM storage_bindings WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_subtable = :sub", params)
            await execute(session, "DELETE FROM storage_field_state WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_subtable = :sub", params)
            for b in bindings:
                await execute(
                    session,
                    """
                    INSERT INTO storage_bindings (
                        id, tenant_id, subtable_id, physical_db, physical_subtable, canonical_source_id,
                        source_kind, target_column, signal_id, model_id, model_field_path,
                        row_assembly_policy, policy_config_json, binding_revision, status,
                        source_data_type, created_at, updated_at
                    ) VALUES (
                        :id, :tenant_id, :subtable_id, :db, :sub, :can, :kind, :col, :sig, :mid, :path,
                        :row_pol, :cfg, 1, 'ACTIVE', :dtype, :now, :now
                    )
                    """,
                    {"id": uuid4(), "tenant_id": tenant_id, "subtable_id": obj_id, "db": db_name, "sub": obj_name,
                     "can": b["canonical_id"], "kind": b["source_kind"], "col": b["target_column"],
                     "sig": UUID(b["signal_id"]) if b.get("signal_id") else None,
                     "mid": UUID(b["model_id"]) if b.get("model_id") else None, "path": b.get("model_field_path"),
                     "row_pol": recording["row_assembly"],
                     "cfg": jsonb({"mode": recording["mode"], "identity_paths": recording["identity_paths"],
                                   "quality_transitions": recording["quality_transitions"]}),
                     "dtype": b.get("source_data_type"), "now": now},
                )
        return obj_id

    # ------------------------------------------------------------------
    # Additive schema change of a user supertable (ALTER STABLE ADD COLUMN / ADD TAG)
    # ------------------------------------------------------------------

    def plan_alter_stable(
        self, database: str, name: str, existing: tuple[list[ColumnSpec], list[TagSpec]], change: dict[str, Any]
    ) -> tuple[list[str], list[dict[str, Any]], list[ColumnSpec], list[TagSpec]]:
        """Validate an additive change; returns ``(ddl, errors, new_columns, new_tags)``.

        Only additions are supported: dropping/retyping a column of a table with history is not an
        in-place operation (the UI offers Duplicate instead). New columns are appended (TDengine
        cannot reorder), never become the composite key and need a length when variable-length.
        """
        cols_now, tags_now = existing
        taken = {c.name for c in cols_now} | {t.name for t in tags_now}
        spec = stable_spec_from({"database": database, "name": name,
                                 "columns": [{"name": "ts", "td_type": "TIMESTAMP"}, *(change.get("add_columns") or [])],
                                 "tags": change.get("add_tags") or []})
        new_cols, new_tags = spec.columns[1:], spec.tags
        errors: list[dict[str, Any]] = []
        if is_system_stable(name):
            errors.append({"field": "name", "code": "SYSTEM_OBJECT", "message": f"'{name}' is a FactoriX system supertable."})
        if not new_cols and not new_tags:
            errors.append({"field": "add_columns", "code": "NO_CHANGE", "message": "Nothing to add."})
        for kind, items in (("add_columns", new_cols), ("add_tags", new_tags)):
            for i, item in enumerate(items):
                try:
                    validate_identifier(item.name, f"{kind}[{i}].name")
                except StorageObjectError as exc:
                    errors.append({"field": f"{kind}[{i}].name", "code": exc.code, "message": str(exc)})
                    continue
                if item.name in taken:
                    errors.append({"field": f"{kind}[{i}].name", "code": "DUPLICATE_NAME", "message": f"'{item.name}' already exists."})
                taken.add(item.name)
                base = _base_type(item.td_type)
                if base in ("VARCHAR", "NCHAR", "BINARY", "VARBINARY", "GEOMETRY") and not item.length:
                    errors.append({"field": f"{kind}[{i}].length", "code": "LENGTH_REQUIRED", "message": f"'{item.name}' needs a length."})
                if kind == "add_columns" and base == "JSON":
                    errors.append({"field": f"{kind}[{i}].td_type", "code": "TAG_ONLY_TYPE", "message": "JSON is a tag-only type."})
                if kind == "add_columns" and getattr(item, "primary_key", False):
                    errors.append({"field": f"{kind}[{i}].primary_key", "code": "COMPOSITE_KEY_POSITION",
                                   "message": "The composite key can only be defined when the supertable is created."})
        ddl = [generate_alter_stable_add_column_ddl(database, name, c) for c in new_cols] + [
            generate_alter_stable_add_tag_ddl(database, name, t) for t in new_tags]
        return ddl, errors, new_cols, new_tags

    async def alter_stable(
        self, session: AsyncSession, tenant_id: UUID, actor_id: UUID | None, database: str, name: str,
        change: dict[str, Any], *, dry_run: bool = False,
    ) -> dict[str, Any]:
        existing = await self.describe(database, name)
        if not existing[0]:
            raise storage_error("VALIDATION_FAILED", f"Supertable '{database}.{name}' was not found.")
        ddl, errors, new_cols, new_tags = self.plan_alter_stable(database, name, existing, change)
        if errors:
            raise storage_error("VALIDATION_FAILED", errors[0]["message"], errors)
        if dry_run:
            return {"valid": True, "ddl": ddl}
        op_id = uuid4()
        now = utcnow()
        key = f"{database}.{name}:alter:{_compute_spec_hash(change)}"
        await execute(
            session,
            """
            INSERT INTO storage_operations (id, tenant_id, operation_type, target_type, actor_id, idempotency_key,
                status, requested_at, started_at, step_state_json, object_key)
            VALUES (:id, :tenant_id, 'ALTER_STABLE', 'stable', :actor, :key, 'APPLYING', :now, :now, :state, :obj)
            ON CONFLICT (tenant_id, operation_type, idempotency_key) WHERE idempotency_key IS NOT NULL
            DO UPDATE SET status = 'APPLYING', started_at = EXCLUDED.started_at, error_code = NULL, error_message = NULL
            """,
            {"id": op_id, "tenant_id": tenant_id, "actor": actor_id, "key": key, "now": now,
             "state": jsonb({"phase": "APPLYING", "ddl": ddl}), "obj": f"{database}.{name}"},
        )
        await session.commit()
        executed: list[str] = []
        failure: str | None = None
        for sql in ddl:
            try:
                await self._td_exec(sql)
                executed.append(sql)
            except Exception as exc:  # noqa: BLE001 - reported, earlier additions stay (additive, harmless)
                failure = str(exc)
                break
        cols_after, tags_after = await self.describe(database, name)
        missing = [c.name for c in new_cols if c.name not in {x.name for x in cols_after}] + [
            t.name for t in new_tags if t.name not in {x.name for x in tags_after}]
        status = "APPLIED" if not failure and not missing else "FAILED"
        await execute(
            session,
            """
            UPDATE storage_operations SET status = :st, completed_at = :now, error_code = :code, error_message = :msg,
                   step_state_json = :state
            WHERE tenant_id = :tenant_id AND operation_type = 'ALTER_STABLE' AND idempotency_key = :key
            """,
            {"st": status, "now": utcnow(), "code": None if status == "APPLIED" else "ALTER_FAILED",
             "msg": failure or (f"missing after ALTER: {missing}" if missing else None), "tenant_id": tenant_id, "key": key,
             "state": jsonb({"phase": status, "executed_sqls": executed, "missing": missing})},
        )
        await execute(
            session,
            """
            UPDATE storage_objects SET schema_json = :schema, tags_json = :tags, revision = revision + 1, updated_at = :now
            WHERE tenant_id = :tenant_id AND object_type = 'stable' AND physical_db = :db AND physical_name = :name
              AND status <> 'PURGED'
            """,
            {"tenant_id": tenant_id, "db": database, "name": name, "now": utcnow(),
             "schema": jsonb([{"name": c.name, "td_type": c.td_type, "length": c.length, "role": c.role,
                               "primary_key": c.primary_key} for c in cols_after]),
             "tags": jsonb([{"name": t.name, "td_type": t.td_type, "length": t.length} for t in tags_after])},
        )
        await session.commit()
        if status != "APPLIED":
            raise storage_error("PUBLISH_FAILED", f"ALTER failed after {len(executed)} of {len(ddl)} statement(s): "
                                f"{failure or missing}. Statements already applied are kept (additive).")
        return {"status": "APPLIED", "ddl": executed, "columns": [c.name for c in cols_after], "tags": [t.name for t in tags_after]}

    # ------------------------------------------------------------------
    # Operation status
    # ------------------------------------------------------------------

    async def get_operation(self, session: AsyncSession, tenant_id: UUID, operation_id: UUID) -> dict[str, Any] | None:
        row = await fetch_one(
            session,
            """
            SELECT id, tenant_id, operation_type, target_type, target_id, actor_id, idempotency_key, status,
                   requested_at, started_at, completed_at, step_state_json, error_code, error_message, trace_id,
                   object_key
            FROM storage_operations
            WHERE id = :id AND tenant_id = :tenant_id
            """,
            {"id": operation_id, "tenant_id": tenant_id},
        )
        if not row:
            return None
        step_state = row["step_state_json"]
        if isinstance(step_state, str):
            try:
                step_state = json.loads(step_state)
            except ValueError:
                step_state = {}
        raw_status = str(row["status"])
        return {
            "id": str(row["id"]),
            "operation_type": row["operation_type"],
            "target_type": row["target_type"],
            "target_id": str(row["target_id"]) if row["target_id"] else None,
            "object_key": row.get("object_key"),
            "status": "APPLIED" if raw_status in ("APPLIED", "COMPLETED") else raw_status,
            "requested_at": iso_ms(row["requested_at"]) if row["requested_at"] else None,
            "started_at": iso_ms(row["started_at"]) if row["started_at"] else None,
            "completed_at": iso_ms(row["completed_at"]) if row["completed_at"] else None,
            "step_state": step_state,
            "error_code": row["error_code"],
            "error_message": row["error_message"],
        }


async def load_models(session: AsyncSession, tenant_id: UUID, model_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Active Data Models by id: name, kind, version, field leaves (path -> leaf), spec and resource."""
    valid_ids = []
    for mid in model_ids:
        try:
            valid_ids.append(UUID(str(mid)))
        except ValueError:
            pass
    if not valid_ids:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT id, display_name, kind, version, spec_json, resource_id
        FROM output_groups
        WHERE tenant_id = :tenant_id AND status = 'ACTIVE' AND id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": valid_ids},
    )
    return {
        str(r["id"]): {
            "name": r["display_name"], "kind": r.get("kind"), "version": int(r.get("version") or 1),
            "leaves": {leaf["path"]: leaf for leaf in SB.model_leaf_fields(r.get("spec_json"))},
            "spec_json": r.get("spec_json"), "resource_id": r.get("resource_id"),
        }
        for r in rows
    }


def _json_list(raw: Any) -> list[Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    return raw if isinstance(raw, list) else []


def is_user_stable(name: str) -> bool:
    return not is_system_stable(name)


async def discard_draft(session: AsyncSession, tenant_id: UUID, draft_id: UUID) -> int:
    """Discard a wizard draft (state CANCELLED; the row stays for audit)."""
    from factorix.modules.common import execute_rowcount

    n = await execute_rowcount(
        session,
        "UPDATE storage_object_drafts SET state = 'CANCELLED', updated_at = :now "
        "WHERE tenant_id = :tenant_id AND id = :id AND state = 'DRAFT'",
        {"tenant_id": tenant_id, "id": draft_id, "now": utcnow()},
    )
    _IN_MEMORY_DRAFTS.pop((tenant_id, draft_id), None)
    return n
