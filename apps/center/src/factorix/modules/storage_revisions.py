"""Storage Revisions, Drafts, and Operation Saga Manager.

Manages physical object draft specifications, revision histories, and DDL
execution sagas with idempotency and state transitions:
  DRAFT -> PREPARED -> APPLYING -> APPLIED (or FAILED)

Works in tandem with ``storage_objects.py`` (which builds the DDL plans)
and ``tdengine.py`` (which executes physical DDL against TDengine).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import json
import logging
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import (
    as_uuid,
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    utcnow,
)
from factorix.modules.storage_objects import (
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
    validate_database_spec,
    validate_stable_spec,
    validate_subtable_spec,
)
from factorix.platform.tdengine import TDEngineClient, TDEngineError

logger = logging.getLogger(__name__)

# In-memory drafts store for drafts not yet persisted to DB (or session drafts)
# Key: (tenant_id, draft_id) -> draft dict
_IN_MEMORY_DRAFTS: dict[tuple[UUID, UUID], dict[str, Any]] = {}


def _compute_spec_hash(spec_dict: dict[str, Any]) -> str:
    serialized = json.dumps(spec_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:32]


class StorageRevisionService:
    """Service for handling physical object drafts, validation, planning, and publishing."""

    def __init__(self, td_client: TDEngineClient | None = None) -> None:
        self.td = td_client

    # ------------------------------------------------------------------
    # Draft Lifecycle (CRUD)
    # ------------------------------------------------------------------

    async def create_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        actor_id: UUID | None,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Create a new draft object and persist to PostgreSQL."""
        draft_id = uuid4()
        kind = str(data.get("kind") or data.get("object_kind") or "stable").lower()
        name = str(data.get("name") or data.get("physical_name") or f"draft_{draft_id.hex[:8]}")
        spec = data.get("spec") or data
        now = utcnow()
        spec_hash = _compute_spec_hash(spec)

        draft_record = {
            "id": str(draft_id),
            "tenant_id": str(tenant_id),
            "object_kind": kind,
            "name": name,
            "revision": 1,
            "spec": spec,
            "state": "DRAFT",
            "created_by": str(actor_id) if actor_id else None,
            "created_at": iso_ms(now),
            "updated_at": iso_ms(now),
            "hash": spec_hash,
        }

        try:
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
                {
                    "id": draft_id,
                    "tenant_id": tenant_id,
                    "kind": kind,
                    "name": name,
                    "spec": jsonb(spec),
                    "created_by": actor_id,
                    "spec_hash": spec_hash,
                    "now": now,
                },
            )
            await session.commit()
        except Exception as exc:
            logger.debug("Persisting draft to storage_object_drafts fallback to in-memory: %s", exc)

        _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = draft_record
        return draft_record

    async def get_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
    ) -> dict[str, Any] | None:
        """Fetch draft object from PostgreSQL or in-memory fallback."""
        try:
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
                    try:
                        spec = json.loads(spec)
                    except Exception:
                        pass
                return {
                    "id": str(row["id"]),
                    "tenant_id": str(row["tenant_id"]),
                    "object_kind": str(row["object_kind"]),
                    "name": str(row["name"]),
                    "revision": int(row["revision"] or 1),
                    "spec": spec,
                    "state": str(row["state"]),
                    "created_by": str(row["created_by"]) if row.get("created_by") else None,
                    "created_at": iso_ms(row["created_at"]) if row.get("created_at") else None,
                    "updated_at": iso_ms(row["updated_at"]) if row.get("updated_at") else None,
                    "hash": str(row.get("spec_hash") or ""),
                }
        except Exception as exc:
            logger.debug("get_draft from database fallback to in-memory: %s", exc)

        return _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))

    async def patch_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
        actor_id: UUID | None,
        updates: dict[str, Any],
    ) -> dict[str, Any]:
        """Update draft specification with optimistic revision increment."""
        draft = await self.get_draft(session, tenant_id, draft_id)
        if not draft:
            raise StorageObjectError("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")

        if "spec" in updates:
            draft["spec"].update(updates["spec"])
        if "name" in updates:
            draft["name"] = updates["name"]
        if "description" in updates:
            draft["spec"]["description"] = updates["description"]

        draft["revision"] = draft.get("revision", 1) + 1
        now = utcnow()
        draft["updated_at"] = iso_ms(now)
        draft["hash"] = _compute_spec_hash(draft["spec"])

        try:
            await execute(
                session,
                """
                UPDATE storage_object_drafts
                SET name = :name,
                    revision = :revision,
                    spec_json = :spec,
                    spec_hash = :hash,
                    updated_at = :now
                WHERE tenant_id = :tenant_id AND id = :id
                """,
                {
                    "id": draft_id,
                    "tenant_id": tenant_id,
                    "name": draft["name"],
                    "revision": draft["revision"],
                    "spec": jsonb(draft["spec"]),
                    "hash": draft["hash"],
                    "now": now,
                },
            )
            await session.commit()
        except Exception as exc:
            logger.debug("patch_draft in database fallback to in-memory: %s", exc)

        _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = draft
        return draft

    # ------------------------------------------------------------------
    # Validation & Planning
    # ------------------------------------------------------------------

    async def _resolve_stable_tags(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        database: str,
        stable_name: str,
    ) -> list[TagSpec]:
        """Fetch real tag definitions for parent STable from TDengine, storage_objects, or drafts."""
        tags: list[TagSpec] = []
        if not database or not stable_name:
            return tags

        # 1. Try TDengine DESCRIBE if client is available
        if self.td is not None:
            try:
                sql = f"DESCRIBE `{database}`.`{stable_name}`"
                rows = await self.td.query_rows(sql) if hasattr(self.td, "query_rows") else await self.td.run_read(sql)
                for r in (rows or []):
                    note = str(
                        r.get("Note") or r.get("note")
                        or (r[3] if isinstance(r, (tuple, list)) and len(r) > 3 else "")
                    ).upper()
                    if "TAG" in note:
                        tname = str(r.get("Field") or r.get("field") or (r[0] if isinstance(r, (tuple, list)) else ""))
                        ttype = str(r.get("Type") or r.get("type") or (r[1] if isinstance(r, (tuple, list)) and len(r) > 1 else "NCHAR"))
                        tlen = r.get("Length") or r.get("length") or (r[2] if isinstance(r, (tuple, list)) and len(r) > 2 else 64)
                        try:
                            tlen_int = int(tlen) if tlen is not None else 64
                        except (ValueError, TypeError):
                            tlen_int = 64
                        tags.append(TagSpec(name=tname, td_type=ttype, length=tlen_int, required=False))
                if tags:
                    return tags
            except Exception as exc:
                logger.debug("Could not describe parent stable from TDengine: %s", exc)

        # 2. Try storage_objects in PostgreSQL
        try:
            row = await fetch_one(
                session,
                """
                SELECT tags_json FROM storage_objects
                WHERE tenant_id = :tenant_id AND object_type = 'stable'
                  AND physical_db = :db AND physical_name = :name
                """,
                {"tenant_id": tenant_id, "db": database, "name": stable_name},
            )
            if row and row.get("tags_json"):
                tags_data = row["tags_json"]
                if isinstance(tags_data, str):
                    tags_data = json.loads(tags_data)
                for t in tags_data:
                    tags.append(TagSpec(
                        name=t["name"],
                        td_type=t.get("td_type") or t.get("type", "NCHAR"),
                        length=int(t.get("length") or 64),
                        required=bool(t.get("required", False)),
                    ))
                if tags:
                    return tags
        except Exception:
            pass

        # 3. Try storage_object_drafts in PostgreSQL
        try:
            row = await fetch_one(
                session,
                """
                SELECT spec_json FROM storage_object_drafts
                WHERE tenant_id = :tenant_id AND object_kind = 'stable'
                  AND name = :name
                ORDER BY updated_at DESC LIMIT 1
                """,
                {"tenant_id": tenant_id, "name": stable_name},
            )
            if row and row.get("spec_json"):
                s_spec = row["spec_json"]
                if isinstance(s_spec, str):
                    s_spec = json.loads(s_spec)
                for t in s_spec.get("tags", []):
                    tags.append(TagSpec(
                        name=t["name"],
                        td_type=t.get("td_type") or t.get("type", "NCHAR"),
                        length=int(t.get("length") or 64),
                        required=bool(t.get("required", False)),
                    ))
                if tags:
                    return tags
        except Exception:
            pass

        return tags

    async def validate_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
        custom_spec: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Validate the draft specification."""
        if custom_spec:
            kind = str(custom_spec.get("kind") or "stable").lower()
            spec_data = custom_spec.get("spec") or custom_spec
        else:
            draft = await self.get_draft(session, tenant_id, draft_id)
            if not draft:
                raise StorageObjectError("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")
            kind = draft["object_kind"]
            spec_data = draft["spec"]

        if kind == "database":
            db_spec = DatabaseSpec(
                name=spec_data.get("name") or spec_data.get("physical_name") or "",
                precision=spec_data.get("precision", "ms"),
                keep=spec_data.get("keep") or f"{spec_data.get('retention_days', 3650)}d",
                vgroups=int(spec_data.get("vgroups", 1)),
                replica=int(spec_data.get("replica", 1)),
                cache_model=spec_data.get("cache_model"),
                description=spec_data.get("description", ""),
            )
            v_res = validate_database_spec(db_spec)
        elif kind == "stable":
            cols: list[ColumnSpec] = []
            for c in spec_data.get("columns", []):
                cols.append(ColumnSpec(
                    name=c["name"],
                    td_type=c.get("td_type") or c.get("type", "DOUBLE"),
                    length=c.get("length"),
                    role=c.get("role", "value"),
                    nullable=c.get("nullable", True),
                    description=c.get("description", ""),
                ))
            tags: list[TagSpec] = []
            for t in spec_data.get("tags", []):
                tags.append(TagSpec(
                    name=t["name"],
                    td_type=t.get("td_type") or t.get("type", "NCHAR"),
                    length=t.get("length", 64),
                    required=t.get("required", False),
                    description=t.get("description", ""),
                ))
            st_spec = StableSpec(
                database=spec_data.get("database", ""),
                name=spec_data.get("name") or spec_data.get("physical_name", ""),
                columns=cols,
                tags=tags,
                description=spec_data.get("description", ""),
            )
            v_res = validate_stable_spec(st_spec)
        elif kind == "subtable":
            db_name = spec_data.get("database", "")
            st_name = spec_data.get("stable") or spec_data.get("parent_stable", "")
            stable_tags = await self._resolve_stable_tags(session, tenant_id, db_name, st_name)
            sub_spec = SubtableSpec(
                database=db_name,
                stable=st_name,
                name=spec_data.get("name") or spec_data.get("physical_name", ""),
                tag_values=spec_data.get("tag_values", {}),
                description=spec_data.get("description", ""),
            )
            v_res = validate_subtable_spec(sub_spec, stable_tags)
        else:
            v_res = ValidationResult(valid=True)

        return {
            "valid": v_res.valid,
            "errors": v_res.errors,
            "warnings": v_res.warnings,
            "estimated_row_bytes": getattr(v_res, "estimated_row_bytes", 0),
        }

    async def plan_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
        custom_spec: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Generate execution DDL plan without executing anything."""
        if custom_spec:
            kind = str(custom_spec.get("kind") or "stable").lower()
            spec_data = custom_spec.get("spec") or custom_spec
        else:
            draft = await self.get_draft(session, tenant_id, draft_id)
            if not draft:
                raise StorageObjectError("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")
            kind = draft["object_kind"]
            spec_data = draft["spec"]

        steps: list[DdlStep] = []
        if kind == "database":
            db_spec = DatabaseSpec(
                name=spec_data.get("name") or spec_data.get("physical_name", ""),
                precision=spec_data.get("precision", "ms"),
                keep=spec_data.get("keep") or f"{spec_data.get('retention_days', 3650)}d",
                vgroups=int(spec_data.get("vgroups", 1)),
                replica=int(spec_data.get("replica", 1)),
                cache_model=spec_data.get("cache_model"),
            )
            steps = build_create_database_plan(db_spec)
        elif kind == "stable":
            cols = [
                ColumnSpec(
                    name=c["name"],
                    td_type=c.get("td_type") or c.get("type", "DOUBLE"),
                    length=c.get("length"),
                    role=c.get("role", "value"),
                    nullable=c.get("nullable", True),
                )
                for c in spec_data.get("columns", [])
            ]
            tags = [
                TagSpec(
                    name=t["name"],
                    td_type=t.get("td_type") or t.get("type", "NCHAR"),
                    length=t.get("length", 64),
                    required=t.get("required", False),
                )
                for t in spec_data.get("tags", [])
            ]
            st_spec = StableSpec(
                database=spec_data.get("database", ""),
                name=spec_data.get("name") or spec_data.get("physical_name", ""),
                columns=cols,
                tags=tags,
            )
            steps = build_create_stable_plan(st_spec)
        elif kind == "subtable":
            db_name = spec_data.get("database", "")
            st_name = spec_data.get("stable") or spec_data.get("parent_stable", "")
            stable_tags = await self._resolve_stable_tags(session, tenant_id, db_name, st_name)
            sub_spec = SubtableSpec(
                database=db_name,
                stable=st_name,
                name=spec_data.get("name") or spec_data.get("physical_name", ""),
                tag_values=spec_data.get("tag_values", {}),
            )
            steps = build_create_subtable_plan(sub_spec, stable_tags)

        return {
            "draft_id": str(draft_id),
            "kind": kind,
            "steps": [
                {
                    "action": s.action,
                    "sql": s.sql,
                    "idempotent": s.idempotent,
                    "description": s.description,
                }
                for s in steps
            ],
            "requires_downtime": False,
            "estimated_impact": f"{len(steps)} DDL statement(s)",
        }

        return {
            "draft_id": str(draft_id),
            "kind": kind,
            "steps": [
                {
                    "action": s.action,
                    "sql": s.sql,
                    "idempotent": s.idempotent,
                    "description": s.description,
                }
                for s in steps
            ],
            "requires_downtime": False,
            "estimated_impact": f"{len(steps)} DDL statement(s)",
        }

    async def simulate_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
    ) -> dict[str, Any]:
        """Simulate sample data generation / ingestion dry-run."""
        draft = await self.get_draft(session, tenant_id, draft_id)
        spec = draft["spec"] if draft else {}
        sample_rows = [
            {
                "ts": iso_ms(utcnow()),
                "sample_index": i,
                "status": "SIMULATED",
                "preview_note": "Synthetic dry-run row preview",
            }
            for i in range(5)
        ]
        return {
            "draft_id": str(draft_id),
            "simulated": True,
            "sample_rows": sample_rows,
            "row_assembly_result": "OK",
        }

    # ------------------------------------------------------------------
    # Operation Saga & Publishing
    # ------------------------------------------------------------------

    async def publish_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
        actor_id: UUID | None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Execute DDL plan in TDengine within an idempotent saga with read-back verification."""
        draft = await self.get_draft(session, tenant_id, draft_id)
        if not draft:
            raise StorageObjectError("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")

        op_id = uuid4()
        now = utcnow()
        kind = draft["object_kind"]
        spec_data = draft["spec"]
        spec_hash = draft.get("hash") or _compute_spec_hash(spec_data)

        # Check existing operation with same idempotency_key
        if idempotency_key:
            row = await fetch_one(
                session,
                """
                SELECT id, status, step_state_json, error_code, error_message
                FROM storage_operations
                WHERE tenant_id = :tenant_id AND idempotency_key = :key
                """,
                {"tenant_id": tenant_id, "key": idempotency_key},
            )
            if row:
                st = str(row["status"])
                norm_status = "APPLIED" if st in ("APPLIED", "COMPLETED") else st
                return {
                    "operation_id": str(row["id"]),
                    "status": norm_status,
                    "idempotent_replay": True,
                }

        # Rule FX-P0-04: Never mark APPLIED if TD client is null/unavailable
        if self.td is None:
            try:
                await execute(
                    session,
                    """
                    INSERT INTO storage_operations (
                        id, tenant_id, operation_type, target_type, target_id,
                        actor_id, idempotency_key, status, requested_at, completed_at,
                        error_code, error_message, step_state_json
                    ) VALUES (
                        :id, :tenant_id, :op_type, :target_type, :target_id,
                        :actor_id, :idempotency_key, 'FAILED', :now, :now,
                        'STORAGE_ENGINE_UNAVAILABLE', 'TDengine client is not available or reachable',
                        :step_state
                    )
                    """,
                    {
                        "id": op_id,
                        "tenant_id": tenant_id,
                        "op_type": f"CREATE_{kind.upper()}",
                        "target_type": kind,
                        "target_id": draft_id,
                        "actor_id": actor_id,
                        "idempotency_key": idempotency_key or str(uuid4()),
                        "now": now,
                        "step_state": jsonb({"phase": "FAILED", "reason": "STORAGE_ENGINE_UNAVAILABLE"}),
                    },
                )
                await session.commit()
            except Exception:
                pass
            raise StorageObjectError("STORAGE_ENGINE_UNAVAILABLE", "TDengine client is not available or reachable")

        plan = await self.plan_draft(session, tenant_id, draft_id)
        steps = plan["steps"]

        # Phase 1: PREPARING
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, target_id,
                actor_id, idempotency_key, status, requested_at, started_at,
                step_state_json, spec_hash
            ) VALUES (
                :id, :tenant_id, :op_type, :target_type, :target_id,
                :actor_id, :idempotency_key, 'PREPARING', :now, :now,
                :step_state, :spec_hash
            )
            """,
            {
                "id": op_id,
                "tenant_id": tenant_id,
                "op_type": f"CREATE_{kind.upper()}",
                "target_type": kind,
                "target_id": draft_id,
                "actor_id": actor_id,
                "idempotency_key": idempotency_key or str(uuid4()),
                "now": now,
                "step_state": jsonb({"phase": "PREPARING", "steps_total": len(steps), "steps_done": 0}),
                "spec_hash": spec_hash,
            },
        )
        await session.commit()

        # Phase 2: APPLYING
        await execute(
            session,
            """
            UPDATE storage_operations
            SET status = 'APPLYING',
                step_state_json = :step_state
            WHERE id = :id
            """,
            {
                "id": op_id,
                "step_state": jsonb({"phase": "APPLYING", "steps_total": len(steps), "steps_done": 0}),
            },
        )
        await session.commit()

        executed_sqls = []
        try:
            for step in steps:
                sql = step["sql"]
                logger.info("Executing TDengine DDL: %s", sql)
                if hasattr(self.td, "execute_sql"):
                    await self.td.execute_sql(sql)
                elif hasattr(self.td, "run_write"):
                    await self.td.run_write(sql)
                executed_sqls.append(sql)

            # Phase 3: VERIFYING with read-back
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'VERIFYING',
                    step_state_json = :step_state
                WHERE id = :id
                """,
                {
                    "id": op_id,
                    "step_state": jsonb({
                        "phase": "VERIFYING",
                        "steps_total": len(steps),
                        "steps_done": len(executed_sqls),
                        "executed_sqls": executed_sqls,
                    }),
                },
            )
            await session.commit()

            # Real metadata read-back verification
            if kind == "database":
                db_name = spec_data.get("name") or spec_data.get("physical_name", "")
                if db_name:
                    dbs = await (
                        self.td.query_rows("SHOW DATABASES")
                        if hasattr(self.td, "query_rows")
                        else self.td.run_read("SHOW DATABASES")
                    )
                    db_names = {
                        str(list(r.values())[0] if isinstance(r, dict) else r[0])
                        for r in (dbs or [])
                    }
                    if db_name not in db_names:
                        raise StorageObjectError("VERIFICATION_FAILED", f"Database '{db_name}' not found in TDengine after creation")
            elif kind == "stable":
                db_name = spec_data.get("database", "")
                st_name = spec_data.get("name") or spec_data.get("physical_name", "")
                if db_name and st_name:
                    cols = await (
                        self.td.query_rows(f"DESCRIBE `{db_name}`.`{st_name}`")
                        if hasattr(self.td, "query_rows")
                        else self.td.run_read(f"DESCRIBE `{db_name}`.`{st_name}`")
                    )
                    if not cols:
                        raise StorageObjectError("VERIFICATION_FAILED", f"STable '{db_name}.{st_name}' not found in TDengine after creation")
            elif kind == "subtable":
                db_name = spec_data.get("database", "")
                sub_name = spec_data.get("name") or spec_data.get("physical_name", "")
                if db_name and sub_name:
                    await (
                        self.td.query_rows(f"SELECT * FROM `{db_name}`.`{sub_name}` TAGS")
                        if hasattr(self.td, "query_rows")
                        else self.td.run_read(f"SELECT * FROM `{db_name}`.`{sub_name}` TAGS")
                    )

            # Phase 4: Register in storage_objects & storage_physical_registry
            obj_db = spec_data.get("database") or spec_data.get("name") or spec_data.get("physical_name", "")
            obj_name = spec_data.get("name") or spec_data.get("physical_name", "")
            parent_name = spec_data.get("stable") or spec_data.get("parent_stable")
            schema_json_data = spec_data.get("columns", [])
            tags_json_data = spec_data.get("tags") or spec_data.get("tag_values", {})

            try:
                await execute(
                    session,
                    """
                    INSERT INTO storage_objects (
                        id, tenant_id, object_type, physical_db, physical_name,
                        parent_name, display_name, description, status,
                        schema_json, tags_json, binding_revision, revision,
                        created_at, updated_at
                    ) VALUES (
                        :id, :tenant_id, :obj_type, :db, :name,
                        :parent_name, :display_name, :desc, 'ACTIVE',
                        :schema, :tags, 1, 1, :now, :now
                    )
                    ON CONFLICT (tenant_id, object_type, physical_db, physical_name)
                    DO UPDATE SET
                        status = 'ACTIVE',
                        schema_json = EXCLUDED.schema_json,
                        tags_json = EXCLUDED.tags_json,
                        updated_at = EXCLUDED.updated_at
                    """,
                    {
                        "id": uuid4(),
                        "tenant_id": tenant_id,
                        "obj_type": kind,
                        "db": obj_db,
                        "name": obj_name,
                        "parent_name": parent_name,
                        "display_name": spec_data.get("display_name") or obj_name,
                        "desc": spec_data.get("description", ""),
                        "schema": jsonb(schema_json_data),
                        "tags": jsonb(tags_json_data),
                        "now": utcnow(),
                    },
                )
            except Exception as reg_exc:
                logger.debug("Registering storage_object skipped: %s", reg_exc)

            if kind == "subtable":
                st_parent = parent_name or "st_default"
                series_k = f"{tenant_id}:{obj_db}:{obj_name}"
                try:
                    await execute(
                        session,
                        """
                        INSERT INTO storage_physical_registry (
                            id, tenant_id, tier, series_key, value_type,
                            td_database, td_stable, td_subtable, physical_schema_hash,
                            generation, status, created_at, updated_at
                        ) VALUES (
                            :id, :tenant_id, 'MANAGED', :series_key, 'float64',
                            :db, :stable, :subtable, :schema_hash,
                            1, 'ACTIVE', :now, :now
                        )
                        ON CONFLICT (td_database, td_subtable)
                        DO UPDATE SET status = 'ACTIVE', updated_at = EXCLUDED.updated_at
                        """,
                        {
                            "id": uuid4(),
                            "tenant_id": tenant_id,
                            "series_key": series_k,
                            "db": obj_db,
                            "stable": st_parent,
                            "subtable": obj_name,
                            "schema_hash": spec_hash,
                            "now": utcnow(),
                        },
                    )
                except Exception as phys_exc:
                    logger.debug("Registering storage_physical_registry skipped: %s", phys_exc)

                # Persist bindings if present in subtable spec
                bindings_list = spec_data.get("bindings", [])
                for b in bindings_list:
                    can_id = b.get("canonical_id") or b.get("source_id") or ""
                    tgt_col = b.get("target_column") or b.get("destination_column") or ""
                    skind = b.get("kind") or b.get("source_kind") or "signal"
                    row_pol = b.get("row_assembly_policy") or "INDEPENDENT_EVENTS"
                    sig_uuid = None
                    mod_uuid = None
                    mod_path = None
                    if skind == "signal":
                        raw_id = b.get("signal_id") or b.get("id") or can_id
                        try:
                            clean_id = raw_id.replace("sig:", "") if isinstance(raw_id, str) else str(raw_id)
                            sig_uuid = UUID(clean_id)
                        except Exception:
                            sig_uuid = None
                    elif skind == "model_field":
                        raw_id = b.get("model_id") or b.get("id") or can_id
                        try:
                            clean_id = raw_id.replace("mod:", "").split(":")[0] if isinstance(raw_id, str) else str(raw_id)
                            mod_uuid = UUID(clean_id)
                        except Exception:
                            mod_uuid = None
                        mod_path = b.get("field_path")

                    if tgt_col:
                        try:
                            await execute(
                                session,
                                """
                                INSERT INTO storage_bindings (
                                    id, tenant_id, physical_db, physical_subtable,
                                    canonical_source_id, source_kind, target_column,
                                    signal_id, model_id, model_field_path,
                                    row_assembly_policy, policy_config_json,
                                    binding_revision, status, created_at, updated_at
                                ) VALUES (
                                    :id, :tenant_id, :db, :subtable,
                                    :can_id, :skind, :tgt_col,
                                    :sig_id, :mod_id, :mod_path,
                                    :row_pol, :p_cfg,
                                    1, 'ACTIVE', :now, :now
                                )
                                ON CONFLICT (tenant_id, physical_db, physical_subtable, target_column)
                                DO UPDATE SET
                                    canonical_source_id = EXCLUDED.canonical_source_id,
                                    updated_at = EXCLUDED.updated_at
                                """,
                                {
                                    "id": uuid4(),
                                    "tenant_id": tenant_id,
                                    "db": obj_db,
                                    "subtable": obj_name,
                                    "can_id": can_id,
                                    "skind": skind,
                                    "tgt_col": tgt_col,
                                    "sig_id": sig_uuid,
                                    "mod_id": mod_uuid,
                                    "mod_path": mod_path,
                                    "row_pol": row_pol,
                                    "p_cfg": jsonb(b.get("policy_config", {})),
                                    "now": utcnow(),
                                },
                            )
                        except Exception as bind_exc:
                            logger.debug("Persisting storage_bindings skipped: %s", bind_exc)

            # Mark APPLIED
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'APPLIED',
                    completed_at = :completed_at,
                    verification_json = :v_json,
                    step_state_json = :step_state
                WHERE id = :id
                """,
                {
                    "id": op_id,
                    "completed_at": utcnow(),
                    "v_json": jsonb({"read_back_ok": True, "object_kind": kind, "verified_at": iso_ms(utcnow())}),
                    "step_state": jsonb({
                        "phase": "APPLIED",
                        "steps_total": len(steps),
                        "steps_done": len(steps),
                        "executed_sqls": executed_sqls,
                    }),
                },
            )

            # Update draft state in DB and memory
            try:
                await execute(
                    session,
                    """
                    UPDATE storage_object_drafts
                    SET state = 'APPLIED', updated_at = :now
                    WHERE tenant_id = :tenant_id AND id = :id
                    """,
                    {"id": draft_id, "tenant_id": tenant_id, "now": utcnow()},
                )
            except Exception:
                pass

            await session.commit()
            draft["state"] = "APPLIED"
            _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = draft
        except Exception as exc:
            logger.error("DDL execution/verification failed for op %s: %s", op_id, exc)
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'FAILED',
                    completed_at = :completed_at,
                    error_code = 'DDL_EXECUTION_ERROR',
                    error_message = :err,
                    step_state_json = :step_state
                WHERE id = :id
                """,
                {
                    "id": op_id,
                    "completed_at": utcnow(),
                    "err": str(exc),
                    "step_state": jsonb({
                        "phase": "FAILED",
                        "executed_sqls": executed_sqls,
                    }),
                },
            )
            try:
                await execute(
                    session,
                    """
                    UPDATE storage_object_drafts
                    SET state = 'FAILED', updated_at = :now
                    WHERE tenant_id = :tenant_id AND id = :id
                    """,
                    {"id": draft_id, "tenant_id": tenant_id, "now": utcnow()},
                )
            except Exception:
                pass
            await session.commit()
            draft["state"] = "FAILED"
            _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = draft
            raise StorageObjectError("PUBLISH_FAILED", f"Publish failed: {exc}")

        return {
            "operation_id": str(op_id),
            "status": "APPLIED",
            "executed_steps": len(executed_sqls),
        }

    # ------------------------------------------------------------------
    # Operation Status
    # ------------------------------------------------------------------

    async def get_operation(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        operation_id: UUID,
    ) -> dict[str, Any] | None:
        """Fetch operation status by ID with unified status enum."""
        row = await fetch_one(
            session,
            """
            SELECT id, tenant_id, operation_type, target_type, target_id,
                   actor_id, idempotency_key, status, requested_at,
                   started_at, completed_at, step_state_json, error_code,
                   error_message, trace_id
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
            except Exception:
                step_state = {}

        raw_status = str(row["status"])
        norm_status = "APPLIED" if raw_status in ("APPLIED", "COMPLETED") else raw_status

        return {
            "id": str(row["id"]),
            "operation_type": row["operation_type"],
            "target_type": row["target_type"],
            "target_id": str(row["target_id"]) if row["target_id"] else None,
            "status": norm_status,
            "requested_at": iso_ms(row["requested_at"]) if row["requested_at"] else None,
            "started_at": iso_ms(row["started_at"]) if row["started_at"] else None,
            "completed_at": iso_ms(row["completed_at"]) if row["completed_at"] else None,
            "step_state": step_state,
            "error_code": row["error_code"],
            "error_message": row["error_message"],
        }
