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
        """Create a new draft object."""
        draft_id = uuid4()
        kind = str(data.get("kind") or data.get("object_kind") or "stable").lower()
        name = str(data.get("name") or data.get("physical_name") or f"draft_{draft_id.hex[:8]}")
        spec = data.get("spec") or data
        now = utcnow()

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
            "hash": _compute_spec_hash(spec),
        }
        _IN_MEMORY_DRAFTS[(tenant_id, draft_id)] = draft_record
        return draft_record

    async def get_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
    ) -> dict[str, Any] | None:
        return _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))

    async def patch_draft(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        draft_id: UUID,
        actor_id: UUID | None,
        updates: dict[str, Any],
    ) -> dict[str, Any]:
        draft = _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))
        if not draft:
            raise StorageObjectError("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")

        if "spec" in updates:
            draft["spec"].update(updates["spec"])
        if "name" in updates:
            draft["name"] = updates["name"]
        if "description" in updates:
            draft["spec"]["description"] = updates["description"]

        draft["revision"] = draft.get("revision", 1) + 1
        draft["updated_at"] = iso_ms(utcnow())
        draft["hash"] = _compute_spec_hash(draft["spec"])
        return draft

    # ------------------------------------------------------------------
    # Validation & Planning
    # ------------------------------------------------------------------

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
            draft = _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))
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
            sub_spec = SubtableSpec(
                database=spec_data.get("database", ""),
                stable=spec_data.get("stable") or spec_data.get("parent_stable", ""),
                name=spec_data.get("name") or spec_data.get("physical_name", ""),
                tag_values=spec_data.get("tag_values", {}),
                description=spec_data.get("description", ""),
            )
            v_res = validate_subtable_spec(sub_spec, [])
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
            draft = _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))
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
            sub_spec = SubtableSpec(
                database=spec_data.get("database", ""),
                stable=spec_data.get("stable") or spec_data.get("parent_stable", ""),
                name=spec_data.get("name") or spec_data.get("physical_name", ""),
                tag_values=spec_data.get("tag_values", {}),
            )
            steps = build_create_subtable_plan(sub_spec, [])

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
        draft = _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))
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
        """Execute DDL plan in TDengine within an idempotent saga."""
        draft = _IN_MEMORY_DRAFTS.get((tenant_id, draft_id))
        if not draft:
            raise StorageObjectError("DRAFT_NOT_FOUND", f"Draft {draft_id} not found")

        plan = await self.plan_draft(session, tenant_id, draft_id)
        steps = plan["steps"]

        # Check existing operation with same idempotency_key
        op_id = uuid4()
        now = utcnow()
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
                return {
                    "operation_id": str(row["id"]),
                    "status": row["status"],
                    "idempotent_replay": True,
                }

        # Create new operation record in storage_operations
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, target_id,
                actor_id, idempotency_key, status, requested_at, started_at,
                step_state_json
            ) VALUES (
                :id, :tenant_id, :op_type, :target_type, :target_id,
                :actor_id, :idempotency_key, 'RUNNING', :now, :now,
                :step_state
            )
            """,
            {
                "id": op_id,
                "tenant_id": tenant_id,
                "op_type": f"CREATE_{draft['object_kind'].upper()}",
                "target_type": draft["object_kind"],
                "target_id": draft_id,
                "actor_id": actor_id,
                "idempotency_key": idempotency_key or str(uuid4()),
                "now": now,
                "step_state": jsonb({"phase": "APPLYING", "steps_total": len(steps), "steps_done": 0}),
            },
        )
        await session.commit()

        # Execute DDL against TDengine
        executed_sqls = []
        try:
            if self.td is not None:
                for step in steps:
                    sql = step["sql"]
                    logger.info("Executing TDengine DDL: %s", sql)
                    await self.td.run_write(sql)
                    executed_sqls.append(sql)

            # Mark COMPLETED
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'COMPLETED',
                    completed_at = :completed_at,
                    step_state_json = :step_state
                WHERE id = :id
                """,
                {
                    "id": op_id,
                    "completed_at": utcnow(),
                    "step_state": jsonb({
                        "phase": "APPLIED",
                        "steps_total": len(steps),
                        "steps_done": len(steps),
                        "executed_sqls": executed_sqls,
                    }),
                },
            )
            await session.commit()
            draft["state"] = "APPLIED"
        except Exception as exc:
            logger.error("DDL execution failed for op %s: %s", op_id, exc)
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
            await session.commit()
            draft["state"] = "FAILED"
            raise StorageObjectError("PUBLISH_FAILED", f"Publish failed: {exc}")

        return {
            "operation_id": str(op_id),
            "status": "COMPLETED",
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
        """Fetch operation status by ID."""
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

        return {
            "id": str(row["id"]),
            "operation_type": row["operation_type"],
            "target_type": row["target_type"],
            "target_id": str(row["target_id"]) if row["target_id"] else None,
            "status": row["status"],
            "requested_at": iso_ms(row["requested_at"]) if row["requested_at"] else None,
            "started_at": iso_ms(row["started_at"]) if row["started_at"] else None,
            "completed_at": iso_ms(row["completed_at"]) if row["completed_at"] else None,
            "step_state": step_state,
            "error_code": row["error_code"],
            "error_message": row["error_message"],
        }
