"""HTTP routes for Storage Designer (S10), Storage Catalog & Lifecycle (S11), and Historian Explorer (S12).

Exposes routes under:
  - ``/api/v1/storage/*``
  - ``/api/v1/historian/*``

Built by :func:`build_router` with application auth and session dependencies. Also exports
a module-level :data:`router` configured with default dependencies.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import historian_service as HS
from factorix.modules import storage_designs as SD
from factorix.modules.common import as_uuid, parse_uuid
from factorix.platform.http import correlation_id


async def _default_admin() -> dict[str, Any]:
    return {
        "tenant_id": "00000000-0000-0000-0000-000000000001",
        "admin_id": "00000000-0000-0000-0000-000000000001",
        "role": "admin",
    }


async def _default_db_session() -> AsyncSession:  # pragma: no cover
    raise RuntimeError("Database session dependency not configured.")


def _parse_signals_param(
    signal_ids: Sequence[str] | None,
    signals: Sequence[str] | None,
    single_signal: str | None = None,
) -> list[str]:
    combined: list[str] = []
    if single_signal:
        combined.append(single_signal)
    if signal_ids:
        combined.extend(signal_ids)
    if signals:
        combined.extend(signals)
    parsed: list[str] = []
    for item in combined:
        for part in str(item).split(","):
            part_str = part.strip()
            if part_str and part_str not in parsed:
                parsed.append(part_str)
    return parsed


def build_router(
    admin: Callable[..., Any] | None = None,
    db_session: Callable[..., Any] | None = None,
) -> APIRouter:
    admin_dep = admin or _default_admin
    db_dep = db_session or _default_db_session

    def ids(principal: dict[str, Any]) -> tuple[UUID, UUID | None]:
        tenant_id = as_uuid(principal["tenant_id"])
        actor_raw = (
            principal.get("admin_id")
            or principal.get("actor_id")
            or principal.get("user_id")
        )
        actor_id = as_uuid(actor_raw) if actor_raw else None
        return tenant_id, actor_id

    router = APIRouter()

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

    @router.get("/api/v1/storage/operations", tags=["storage"])
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

    # ==========================================================================
    # S12: Historian APIs (/api/v1/historian/*)
    # ==========================================================================

    @router.get("/api/v1/historian/latest", tags=["historian"])
    async def historian_latest(
        signal_ids: list[str] = Query(default=[]),
        signals: list[str] = Query(default=[]),
        signal_id: str | None = None,
        design_id: str | None = None,
        dataset_id: str | None = None,
        dataset_name: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        sig_list = _parse_signals_param(signal_ids, signals, signal_id)
        return await HS.get_historian_latest(
            session,
            tenant_id,
            signals=sig_list,
            design_id=parse_uuid(design_id) if design_id else None,
            dataset_name=dataset_name or dataset_id,
        )

    @router.post("/api/v1/historian/query", tags=["historian"])
    async def historian_query_post(
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await HS.query_historian(session, tenant_id, body)

    @router.get("/api/v1/historian/query", tags=["historian"])
    async def historian_query_get(
        signal_ids: list[str] = Query(default=[]),
        signals: list[str] = Query(default=[]),
        signal_id: str | None = None,
        mode: str = "operational",
        start: str | None = None,
        end: str | None = None,
        range: str | None = None,
        bucket_ms: int | None = None,
        agg: str | None = None,
        cursor: str | None = None,
        limit: int = 1000,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        sig_list = _parse_signals_param(signal_ids, signals, signal_id)
        payload: dict[str, Any] = {
            "signals": sig_list,
            "mode": mode,
            "start": start,
            "end": end,
            "range": range,
            "bucket_ms": bucket_ms,
            "agg": agg,
            "cursor": cursor,
            "limit": limit,
        }
        return await HS.query_historian(session, tenant_id, payload)

    @router.get("/api/v1/historian/events", tags=["historian"])
    async def historian_events(
        signal_ids: list[str] = Query(default=[]),
        signals: list[str] = Query(default=[]),
        signal_id: str | None = None,
        design_id: str | None = None,
        start: str | None = None,
        end: str | None = None,
        range: str | None = None,
        types: list[str] = Query(default=[]),
        limit: int = 200,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        sig_list = _parse_signals_param(signal_ids, signals, signal_id)
        type_list: list[str] = []
        for t in types:
            type_list.extend([p.strip() for p in t.split(",") if p.strip()])
        return await HS.list_historian_events(
            session,
            tenant_id,
            signals=sig_list,
            design_id=parse_uuid(design_id) if design_id else None,
            start=start or range,
            end=end,
            types=type_list,
            limit=limit,
        )

    @router.get("/api/v1/historian/views", tags=["historian"])
    async def list_views(
        q: str | None = None,
        limit: int = 50,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> list[dict[str, Any]]:
        tenant_id, _actor = ids(principal)
        return await HS.list_saved_views(session, tenant_id, q=q, limit=limit)

    @router.post("/api/v1/historian/views", status_code=201, tags=["historian"])
    async def create_view(
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await HS.create_saved_view(
            session,
            tenant_id,
            actor,
            body,
            correlation_id=correlation_id(request),
        )

    @router.delete("/api/v1/historian/views/{view_id}", tags=["historian"])
    async def delete_view(
        view_id: str,
        request: Request,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        await HS.delete_saved_view(
            session,
            tenant_id,
            actor,
            parse_uuid(view_id),
            correlation_id=correlation_id(request),
        )
        return {"ok": True, "deleted": view_id}

    @router.post("/api/v1/historian/exports", status_code=202, tags=["historian"])
    async def create_export(
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await HS.create_export_job(
            session,
            tenant_id,
            actor,
            body,
            correlation_id=correlation_id(request),
        )

    @router.get("/api/v1/historian/exports", tags=["historian"])
    async def list_exports(
        status: str | None = None,
        limit: int = 50,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> list[dict[str, Any]]:
        tenant_id, _actor = ids(principal)
        return await HS.list_export_jobs(session, tenant_id, status=status, limit=limit)

    @router.get("/api/v1/historian/exports/{export_id}", tags=["historian"])
    async def get_export(
        export_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await HS.get_export_job(session, tenant_id, parse_uuid(export_id))

    @router.post("/api/v1/historian/exports/{export_id}/cancel", tags=["historian"])
    async def cancel_export(
        export_id: str,
        request: Request,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await HS.cancel_export_job(
            session,
            tenant_id,
            actor,
            parse_uuid(export_id),
            correlation_id=correlation_id(request),
        )

    @router.post("/api/v1/historian/exports/{export_id}/retry", tags=["historian"])
    async def retry_export(
        export_id: str,
        request: Request,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await HS.retry_export_job(
            session,
            tenant_id,
            actor,
            parse_uuid(export_id),
            correlation_id=correlation_id(request),
        )

    @router.get("/api/v1/historian/exports/{export_id}/download", tags=["historian"])
    async def download_export(
        export_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> Response:
        tenant_id, _actor = ids(principal)
        csv_text, file_name = await HS.download_export_csv(
            session,
            tenant_id,
            parse_uuid(export_id),
        )
        return Response(
            content=csv_text.encode("utf-8"),
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
                "Content-Type": "text/csv; charset=utf-8",
                "Cache-Control": "no-store",
            },
        )

    return router


# Default router instance
router = build_router()
