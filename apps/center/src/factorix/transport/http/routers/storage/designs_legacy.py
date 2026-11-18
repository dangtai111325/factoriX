"""S10/S11 logical Storage Designer routes ``/api/v1/storage/designs/*`` (+ ``/storage/health``,
``/storage/retention/preview``) (R2-E B3, moved verbatim from ``factorix.transport.storage_api``)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import storage_designs as SD
from factorix.modules.common import parse_uuid
from factorix.platform.http import correlation_id

from factorix.transport.http.routers.storage.context import StorageRouterContext


def register(router: APIRouter, ctx: StorageRouterContext) -> None:
    """Register the logical-design routes (original order)."""
    admin_dep = ctx.admin_dep
    db_dep = ctx.db_dep
    ids = ctx.ids

    # ==========================================================================
    # S10 & S11: Storage Designer & Catalog APIs (/api/v1/storage/*)
    # ==========================================================================

    @router.get("/api/v1/storage/designs", tags=["storage"])
    async def list_designs(
        status: str | None = None,
        search: str | None = None,
        q: str | None = None,
        scope: str | None = None,
        mode: str | None = None,
        retention: str | None = None,
        updated: str | None = None,
        limit: int = 50,
        offset: int = 0,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        term = search or q
        return await SD.list_designs(
            session,
            tenant_id,
            status=status,
            search=term,
            scope=scope,
            mode=mode,
            retention=retention,
            updated=updated,
            limit=limit,
            offset=offset,
        )

    @router.post("/api/v1/storage/designs", status_code=201, tags=["storage"])
    async def create_design(
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.create_design(
            session,
            tenant_id,
            actor,
            body,
            correlation_id=correlation_id(request),
        )

    # Static routes before /{design_id}
    @router.post("/api/v1/storage/designs/validate", tags=["storage"])
    async def validate_design_standalone(
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.validate_design(session, tenant_id, body=body)

    @router.post("/api/v1/storage/designs/physical-plan", tags=["storage"])
    async def compile_physical_plan_standalone(
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.compile_design_physical_plan(session, tenant_id, body=body)

    @router.post("/api/v1/storage/designs/simulate", tags=["storage"])
    async def simulate_design_standalone(
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.simulate_design(session, tenant_id, body=body)

    @router.post("/api/v1/storage/designs/bulk", tags=["storage"])
    async def bulk_designs(
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.bulk_designs(
            session,
            tenant_id,
            actor,
            body,
            correlation_id=correlation_id(request),
        )

    @router.post("/api/v1/storage/designs/import", status_code=201, tags=["storage"])
    async def import_design(
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.import_design_bundle(
            session,
            tenant_id,
            actor,
            body,
            correlation_id=correlation_id(request),
        )

    @router.get("/api/v1/storage/health", tags=["storage"])
    async def storage_health(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.get_storage_health(session, tenant_id)

    @router.get("/api/v1/storage/designs/operations", tags=["storage"])
    async def list_operations(
        design_id: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> list[dict[str, Any]]:
        tenant_id, _actor = ids(principal)
        return await SD.list_storage_operations(
            session,
            tenant_id,
            design_id=parse_uuid(design_id) if design_id else None,
            kind=kind,
            status=status,
            limit=limit,
            offset=offset,
        )

    @router.post("/api/v1/storage/retention/preview", tags=["storage"])
    async def preview_retention(
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.preview_storage_retention(session, tenant_id, body=body)

    # Dynamic routes on /{design_id}
    @router.get("/api/v1/storage/designs/{design_id}", tags=["storage"])
    async def get_design(
        design_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.get_design(session, tenant_id, parse_uuid(design_id))

    @router.put("/api/v1/storage/designs/{design_id}", tags=["storage"])
    async def put_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        if_match: str | None = Header(None, alias="If-Match"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.update_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            body,
            correlation_id=correlation_id(request),
            if_match=if_match,
        )

    @router.patch("/api/v1/storage/designs/{design_id}", tags=["storage"])
    async def patch_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        if_match: str | None = Header(None, alias="If-Match"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.update_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            body,
            correlation_id=correlation_id(request),
            if_match=if_match,
        )

    @router.post("/api/v1/storage/designs/{design_id}/validate", tags=["storage"])
    async def validate_design_by_id(
        design_id: str,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.validate_design(
            session,
            tenant_id,
            design_id=parse_uuid(design_id),
            body=body,
        )

    @router.post("/api/v1/storage/designs/{design_id}/physical-plan", tags=["storage"])
    async def compile_physical_plan_by_id(
        design_id: str,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.compile_design_physical_plan(
            session,
            tenant_id,
            design_id=parse_uuid(design_id),
            body=body,
        )

    @router.post("/api/v1/storage/designs/{design_id}/simulate", tags=["storage"])
    async def simulate_design_by_id(
        design_id: str,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.simulate_design(
            session,
            tenant_id,
            design_id=parse_uuid(design_id),
            body=body,
        )

    @router.post("/api/v1/storage/designs/{design_id}/publish", tags=["storage"])
    async def publish_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        if_match: str | None = Header(None, alias="If-Match"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        payload = dict(body)
        if if_match is not None and "expected_version" not in payload:
            clean_ver = str(if_match).strip().strip('"').strip("'")
            try:
                payload["expected_version"] = int(clean_ver)
            except (ValueError, TypeError):
                pass
        return await SD.publish_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            payload=payload,
            correlation_id=correlation_id(request),
        )

    @router.post("/api/v1/storage/designs/{design_id}/pause", tags=["storage"])
    async def pause_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.pause_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            payload=body,
            correlation_id=correlation_id(request),
        )

    @router.post("/api/v1/storage/designs/{design_id}/resume", tags=["storage"])
    async def resume_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.resume_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            payload=body,
            correlation_id=correlation_id(request),
        )

    @router.post("/api/v1/storage/designs/{design_id}/duplicate", status_code=201, tags=["storage"])
    async def duplicate_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.duplicate_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            payload=body,
            correlation_id=correlation_id(request),
        )

    @router.post("/api/v1/storage/designs/{design_id}/archive", tags=["storage"])
    async def archive_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.archive_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            payload=body,
            correlation_id=correlation_id(request),
        )

    @router.post("/api/v1/storage/designs/{design_id}/restore", tags=["storage"])
    async def restore_design(
        design_id: str,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await SD.restore_design(
            session,
            tenant_id,
            actor,
            parse_uuid(design_id),
            payload=body,
            correlation_id=correlation_id(request),
        )

    @router.get("/api/v1/storage/designs/{design_id}/dependencies", tags=["storage"])
    async def get_design_dependencies(
        design_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await SD.get_design_dependencies(session, tenant_id, parse_uuid(design_id))

    @router.get("/api/v1/storage/designs/{design_id}/export", tags=["storage"])
    async def export_design(
        design_id: str,
        format: str = "yaml",
        fmt: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        effective_fmt = fmt or format or "yaml"
        return await SD.export_design_bundle(
            session,
            tenant_id,
            parse_uuid(design_id),
            fmt=effective_fmt,
        )
