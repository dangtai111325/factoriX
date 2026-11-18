"""Create-wizard plan, server drafts (``/storage/td/drafts``, ``/storage/td/objects/drafts/*``) and the
physical operations journal ``/storage/operations`` (R2-E B3, moved verbatim from
``factorix.transport.storage_api``).

``PATCH /storage/td/objects/drafts/{id}`` is registered by :func:`register_before_objects` BEFORE
:mod:`.td_objects`, because ``PATCH /storage/td/objects/{object_id:path}`` also matches that URL (B-09: the
draft route used to be unreachable). The other routes here cannot collide with :mod:`.td_objects`."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, Query
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import storage_objects as SO
from factorix.modules import storage_revisions as SR
from factorix.modules.storage_objects import StorageObjectError
from factorix.modules.common import fetch_all, iso_ms, parse_uuid
from factorix.platform.errors import AppError

from factorix.transport.http.routers.storage.common import _storage_error, tenant_db
from factorix.transport.http.routers.storage.context import StorageRouterContext


def register_before_objects(router: APIRouter, ctx: StorageRouterContext) -> None:
    """Routes that must win over the generic ``/storage/td/objects/{object_id:path}`` routes."""
    admin_dep = ctx.admin_dep
    db_dep = ctx.db_dep
    ids = ctx.ids
    revision_service = ctx.revision_service

    @router.patch("/api/v1/storage/td/objects/drafts/{draft_id}", tags=["storage"])
    async def patch_storage_draft(
        draft_id: str,
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Save a server draft: body = ``{spec, revision}`` (409 when ``revision`` is stale)."""
        tenant_id, actor_id = ids(principal)
        try:
            return await revision_service.patch_draft(session, tenant_id, parse_uuid(draft_id), actor_id, body)
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc


def register(router: APIRouter, ctx: StorageRouterContext) -> None:
    """Register the plan/draft/operation routes (original relative order)."""
    admin_dep = ctx.admin_dep
    db_dep = ctx.db_dep
    ids = ctx.ids
    revision_service = ctx.revision_service

    @router.post("/api/v1/storage/td/plan", tags=["storage"])
    async def plan_td_object(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Validation + the exact DDL the backend will run (Review step; P1-4)."""
        tenant_id, _actor = ids(principal)
        kind = str(body.get("kind") or "").lower()
        spec = dict(body.get("spec") or {})
        if kind in ("stable", "subtable") and not spec.get("database"):
            spec["database"] = tenant_db(tenant_id)
        validation = await revision_service.validate_draft(session, tenant_id, None, custom_spec={"kind": kind, "spec": spec})
        plan: dict[str, Any] = {"steps": [], "ddl": []}
        if validation["valid"]:
            try:
                plan = await revision_service.plan_draft(session, tenant_id, None, custom_spec={"kind": kind, "spec": spec})
            except StorageObjectError as exc:
                raise _storage_error(exc) from exc
        name = str(spec.get("name") or spec.get("physical_name") or "")
        db = name if kind == "database" else str(spec.get("database") or "")
        exists = False
        if name and validation["valid"]:
            try:
                exists = await revision_service.object_exists(kind, db, name)
            except StorageObjectError:
                exists = False
        return {**plan, "valid": validation["valid"] and not exists, "errors": validation["errors"]
                + ([{"field": "name", "code": "NAME_CONFLICT", "message": f"'{name}' already exists."}] if exists else []),
                "warnings": validation["warnings"] + plan.get("warnings", []), "exists": exists}

    @router.post("/api/v1/storage/td/validate-name", tags=["storage"])
    async def validate_td_name(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Check only the name of a database / supertable / subtable (wizard step 1 "Next", R1-17a /
        R1-29): the same validators as create — length first (``IDENTIFIER_TOO_LONG``), character set,
        reserved names (``log``, ``information_schema`` …, ``fx_t_`` prefix, ``op_``/``ms_``) — plus
        ``NAME_CONFLICT`` when it already exists. Body: ``{kind, name, database?, description?}``."""
        tenant_id, _actor = ids(principal)
        kind = str(body.get("kind") or "").lower()
        name = str(body.get("name") or "")
        if kind not in ("database", "stable", "subtable"):
            return {"valid": False, "errors": [{"field": "kind", "code": "UNKNOWN_KIND",
                                                "message": "kind must be database, stable or subtable."}], "exists": False}
        database = name if kind == "database" else str(body.get("database") or tenant_db(tenant_id))
        spec: dict[str, Any] = {"name": name, "description": body.get("description") or "",
                                "database": database, "stable": body.get("stable") or "_"}
        if kind == "database":
            result = SO.validate_database_spec(SR._database_spec(spec))
        elif kind == "stable":
            result = SO.validate_stable_spec(SR.stable_spec_from(spec))
        else:
            result = SO.validate_subtable_spec(SR.subtable_spec_from(spec), [])
        errors = [e for e in result.errors if str(e.get("field") or "") in ("name", "description", "display_name")]
        exists = False
        if not errors:
            try:
                exists = await revision_service.object_exists(kind, database, name)
            except StorageObjectError:
                exists = False
            if exists:
                errors.append({"field": "name", "code": "NAME_CONFLICT", "message": f"'{name}' already exists."})
        return {"valid": not errors, "errors": errors, "exists": exists}

    @router.delete("/api/v1/storage/td/drafts/{draft_id}", tags=["storage"])
    async def discard_td_draft(
        draft_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        n = await SR.discard_draft(session, tenant_id, parse_uuid(draft_id))
        if not n:
            raise AppError(404, "NOT_FOUND", f"Draft '{draft_id}' not found")
        return {"id": draft_id, "state": "CANCELLED"}

    @router.get("/api/v1/storage/td/drafts/{draft_id}", tags=["storage"])
    async def get_td_draft(
        draft_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Reopen a server draft (D5): ``spec`` is exactly the body the create endpoint of
        ``object_kind`` accepts; continue with PATCH /td/objects/drafts/{id} (``revision`` = optimistic
        lock), validate/plan, then POST /td/objects/drafts/{id}/publish or the normal create."""
        tenant_id, _actor = ids(principal)
        draft = await revision_service.get_draft(session, tenant_id, parse_uuid(draft_id))
        if not draft or draft.get("state") not in ("DRAFT", "FAILED"):
            raise AppError(404, "NOT_FOUND", f"Draft '{draft_id}' not found")
        return {k: draft.get(k) for k in ("id", "object_kind", "name", "revision", "state", "spec", "created_at", "updated_at")}

    @router.get("/api/v1/storage/td/drafts", tags=["storage"])
    async def list_td_drafts(
        kind: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        items = await revision_service.list_drafts(session, tenant_id, kind)
        return {"items": items, "total": len(items)}

    # --- Drafts Lifecycle ---

    @router.post("/api/v1/storage/td/objects/drafts", status_code=201, tags=["storage"])
    async def create_storage_draft(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        return await revision_service.create_draft(session, tenant_id, actor_id, body)

    @router.post("/api/v1/storage/td/objects/drafts/{draft_id}/validate", tags=["storage"])
    async def validate_storage_draft(
        draft_id: str,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await revision_service.validate_draft(
            session, tenant_id, parse_uuid(draft_id), custom_spec=body if body else None
        )

    @router.post("/api/v1/storage/td/objects/drafts/{draft_id}/plan", tags=["storage"])
    async def plan_storage_draft(
        draft_id: str,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        try:
            return await revision_service.plan_draft(
                session, tenant_id, parse_uuid(draft_id), custom_spec=body if body else None
            )
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc

    @router.post("/api/v1/storage/td/objects/drafts/{draft_id}/simulate", tags=["storage"])
    async def simulate_storage_draft(
        draft_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await revision_service.simulate_draft(
            session, tenant_id, parse_uuid(draft_id)
        )

    @router.post("/api/v1/storage/td/objects/drafts/{draft_id}/publish", status_code=202, tags=["storage"])
    async def publish_storage_draft(
        draft_id: str,
        body: dict[str, Any] = Body(default_factory=dict),
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        try:
            return await revision_service.publish_draft(
                session,
                tenant_id,
                parse_uuid(draft_id),
                actor_id,
                idempotency_key=idempotency_key or body.get("idempotency_key"),
            )
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc

    # --- Operations ---

    @router.get("/api/v1/storage/operations/{op_id}", tags=["storage"])
    async def get_storage_operation(
        op_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        op = await revision_service.get_operation(session, tenant_id, parse_uuid(op_id))
        if not op:
            raise AppError(404, "NOT_FOUND", f"Operation '{op_id}' not found")
        return op

    @router.get("/api/v1/storage/operations", tags=["storage"])
    async def list_storage_operations(
        object_type: str | None = None,
        status: str | None = None,
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=200),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        clauses = ["tenant_id = :tenant_id"]
        params: dict[str, Any] = {"tenant_id": tenant_id}
        if object_type:
            clauses.append("target_type = :target_type")
            params["target_type"] = object_type
        if status:
            clauses.append("status = :status")
            params["status"] = status

        sql = f"""
            SELECT id, tenant_id, operation_type, target_type, target_id,
                   actor_id, idempotency_key, status, requested_at,
                   started_at, completed_at, step_state_json, error_code,
                   error_message, trace_id
            FROM storage_operations
            WHERE {' AND '.join(clauses)}
            ORDER BY requested_at DESC
            LIMIT {int(limit)}
        """
        rows = await fetch_all(session, sql, params)
        items = []
        for r in rows:
            step_state = r.get("step_state_json") or {}
            if isinstance(step_state, str):
                try:
                    step_state = json.loads(step_state)
                except ValueError:
                    step_state = {}
            items.append({
                "id": str(r["id"]),
                "operation_type": r["operation_type"],
                "target_type": r["target_type"],
                "target_id": str(r["target_id"]) if r.get("target_id") else None,
                "status": r["status"],
                "requested_at": iso_ms(r["requested_at"]) if r.get("requested_at") else None,
                "started_at": iso_ms(r["started_at"]) if r.get("started_at") else None,
                "completed_at": iso_ms(r["completed_at"]) if r.get("completed_at") else None,
                "step_state": step_state,
                "error_code": r.get("error_code"),
                "error_message": r.get("error_message"),
            })
        return {"items": items, "total": len(items), "page": 1, "page_size": limit}
