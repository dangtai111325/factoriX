"""S12 Historian routes ``/api/v1/historian/*``: latest/query/events, saved views, sources picker, exports
(R2-E B3, moved verbatim from ``factorix.transport.storage_api``)."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import historian_catalog as HC
from factorix.modules import historian_recorded as HR
from factorix.modules import historian_service as HS
from factorix.modules import historian_views as HV
from factorix.modules.common import parse_uuid
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id

from factorix.transport.http.routers.storage.context import StorageRouterContext


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


def _json_response(payload: Any) -> Response:
    """Large read payloads (Historian series) are serialized once with ``json.dumps``; FastAPI's
    generic response-model encoding walks every point again (D1)."""
    return Response(
        content=json.dumps(payload, separators=(",", ":"), ensure_ascii=False, default=str, allow_nan=False),
        media_type="application/json",
    )


def register(router: APIRouter, ctx: StorageRouterContext) -> None:
    """Register the Historian routes (original order)."""
    admin_dep = ctx.admin_dep
    db_dep = ctx.db_dep
    ids = ctx.ids

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
    ) -> Response:
        tenant_id, _actor = ids(principal)
        return _json_response(await HS.query_historian(session, tenant_id, body))

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
        return _json_response(await HS.query_historian(session, tenant_id, payload))

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
        tenant_id, actor = ids(principal)
        return await HV.list_views(session, tenant_id, actor, q=q, limit=limit)

    @router.get("/api/v1/historian/views/{view_id}", tags=["historian"])
    async def get_view(
        view_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await HV.get_view(session, tenant_id, parse_uuid(view_id), actor)

    @router.patch("/api/v1/historian/views/{view_id}", tags=["historian"])
    async def patch_view(
        view_id: str,
        body: dict[str, Any] = Body(...),
        if_match: str | None = Header(None, alias="If-Match"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Rename / change query, chart options, visibility or default; needs the edited version."""
        tenant_id, actor = ids(principal)
        return await HV.update_view(session, tenant_id, actor, parse_uuid(view_id), body, if_match=if_match)

    @router.post("/api/v1/historian/views/{view_id}/duplicate", status_code=201, tags=["historian"])
    async def duplicate_view(
        view_id: str,
        body: dict[str, Any] = Body(default_factory=dict),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await HV.duplicate_view(session, tenant_id, actor, parse_uuid(view_id), body.get("name"))

    @router.get("/api/v1/historian/sources", tags=["historian"])
    async def historian_sources(
        search: str | None = Query(None, max_length=200),
        kinds: str | None = Query(None, description="comma list of signal,model_field,subtable"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Picker data grouped by machine: signals, Data Model fields and recorded subtables, each with
        its Historian series token, quality and freshness."""
        tenant_id, _actor = ids(principal)
        wanted = {k.strip() for k in kinds.split(",") if k.strip()} if kinds else None
        if wanted and not wanted <= {"signal", "model_field", "subtable"}:
            raise AppError(422, "INVALID_KINDS", "kinds must be a comma list of signal, model_field, subtable.")
        return await HC.sources_by_machine(session, tenant_id, search=search, kinds=wanted)

    @router.get("/api/v1/historian/sources/recorded", tags=["historian"])
    async def historian_recorded_sources(
        q: str | None = Query(None, max_length=200),
        machine_id: str | None = Query(None, max_length=64, description="resource id, or 'none' for no machine"),
        stable: str | None = Query(None, max_length=200),
        database: str | None = Query(None, max_length=200),
        page: int = Query(1, ge=1),
        page_size: int = Query(100, ge=1, le=HR.MAX_PAGE_SIZE),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Recorded tables (every bound value column of a user subtable), searched and paged on the
        server (R2-03: the picker used to see the first 50 of all tables, system ones included).
        ``machines`` = per-machine counts of the filtered result."""
        tenant_id, _actor = ids(principal)
        return await HR.search_recorded(session, tenant_id, q=q, machine_id=machine_id, stable=stable,
                                        database=database, page=page, page_size=page_size)

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
        import re as _re

        safe_name = _re.sub(r"[^A-Za-z0-9._-]+", "_", file_name)[:120] or "historian-export.csv"
        media = "application/json" if safe_name.lower().endswith(".json") else "text/csv"
        return Response(
            content=csv_text.encode("utf-8"),
            media_type=media,
            headers={
                "Content-Disposition": f'attachment; filename="{safe_name}"',
                "Content-Type": f"{media}; charset=utf-8",
                "Cache-Control": "no-store",
            },
        )
