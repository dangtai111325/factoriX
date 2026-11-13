"""HTTP routes for Storage Designer (S10), Storage Catalog & Lifecycle (S11), and Historian Explorer (S12).

Exposes routes under:
  - ``/api/v1/storage/*``
  - ``/api/v1/historian/*``

Built by :func:`build_router` with application auth and session dependencies. Also exports
a module-level :data:`router` configured with default dependencies.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import historian_service as HS
from factorix.modules import postgres_explorer as PE
from factorix.modules import storage_bindings as SB
from factorix.modules import storage_designs as SD
from factorix.modules import storage_objects as SO
from factorix.modules import storage_revisions as SR
from factorix.modules import storage_topology as ST
from factorix.modules.common import as_uuid, execute, fetch_all, fetch_one, iso_ms, parse_uuid, utcnow
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id
from factorix.platform.settings import Settings
from factorix.platform.tdengine import TDEngineClient, TDEngineConfig

logger = logging.getLogger(__name__)

_td_singleton: TDEngineClient | None = None


def _get_td_client() -> TDEngineClient | None:
    global _td_singleton
    if _td_singleton is None:
        try:
            cfg = Settings()
            if cfg.tdengine_dsn:
                _td_singleton = TDEngineClient(
                    TDEngineConfig(dsn=cfg.tdengine_dsn, db_prefix=cfg.tdengine_db_prefix)
                )
        except Exception:
            pass
    return _td_singleton


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
    td_client: Any | None = None,
) -> APIRouter:
    admin_dep = admin or _default_admin
    db_dep = db_session or _default_db_session

    td = td_client or _get_td_client()
    topology_inspector = ST.StorageTopologyInspector(td)
    revision_service = SR.StorageRevisionService(td)
    binding_service = SB.StorageBindingService()
    pg_explorer = PE.PostgresExplorerService()

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

    # ==========================================================================
    # Physical-First TDengine & PostgreSQL Storage APIs
    # ==========================================================================

    async def _assert_tenant_database_access(
        sess: AsyncSession | None, tenant_id: UUID, db_name: str
    ) -> bool:
        canonical_tenant_db = f"fx_t_{tenant_id.hex}"
        if db_name.lower() == canonical_tenant_db.lower():
            return True
        if sess is not None:
            row = await fetch_one(
                sess,
                "SELECT 1 FROM storage_objects WHERE tenant_id = :tenant_id AND physical_db = :db LIMIT 1",
                {"tenant_id": tenant_id, "db": db_name},
            )
            if row:
                return True
        return False

    @router.get("/api/v1/storage/engines", tags=["storage"])
    async def get_storage_engines(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        info = await topology_inspector.get_engines_info(session)
        now_iso = iso_ms(utcnow())
        td_healthy = info["tdengine"]["healthy"]
        td_version = info["tdengine"]["version"]
        pg_healthy = info.get("postgresql", {}).get("healthy", True)
        pg_raw_ver = info.get("postgresql", {}).get("version", "PostgreSQL (unknown)")
        pg_version = (
            f"PostgreSQL {pg_raw_ver}"
            if pg_raw_ver and not str(pg_raw_ver).lower().startswith("postgresql")
            else str(pg_raw_ver or "PostgreSQL")
        )
        return {
            "tdengine": {
                "reachable": td_healthy,
                "version": td_version,
                "last_checked_at": now_iso,
                "features": info["tdengine"]["features"],
            },
            "postgresql": {
                "reachable": pg_healthy,
                "version": pg_version,
                "last_checked_at": now_iso,
            },
        }

    @router.get("/api/v1/storage/td/topology", tags=["storage"])
    async def get_td_topology(
        database: str | None = None,
        depth: int = 2,
        cursor: str | None = None,
        show_bindings: bool = False,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        snap = await topology_inspector.get_topology(
            tenant_id, database=database, depth=depth, cursor=cursor
        )
        return ST.topology_snapshot_to_dict(snap)

    @router.get("/api/v1/storage/td/stats", tags=["storage"])
    async def get_td_stats(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id)
        db_count = len(dbs)
        total_stables = sum(d.stable_count for d in dbs)
        total_subtables = sum(d.ntables for d in dbs)

        rows = await fetch_all(
            session,
            """
            SELECT status, COUNT(*) AS cnt
            FROM storage_objects
            WHERE tenant_id = :tenant_id AND object_type = 'subtable'
            GROUP BY status
            """,
            {"tenant_id": tenant_id},
        )
        status_map = {r["status"]: int(r["cnt"]) for r in rows}
        active_cnt = status_map.get("ACTIVE", 0)
        paused_cnt = status_map.get("PAUSED", 0)
        error_cnt = status_map.get("ERROR", 0)

        if not status_map:
            active_cnt = total_subtables
            paused_cnt = 0
            error_cnt = 0
        else:
            total_subtables = max(total_subtables, sum(status_map.values()))

        return {
            "database_count": db_count,
            "stable_count": total_stables,
            "subtable_count": total_subtables,
            "recording_active": active_cnt,
            "recording_paused": paused_cnt,
            "recording_error": error_cnt,
            "observed_at": iso_ms(utcnow()),
        }

    @router.get("/api/v1/storage/td/databases", tags=["storage"])
    async def list_td_databases(
        principal: dict[str, Any] = Depends(admin_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id)
        now_iso = iso_ms(utcnow())
        items = [
            {
                "id": d.name,
                "physical_name": d.name,
                "display_name": d.name,
                "description": "",
                "precision": d.precision,
                "retention_days": 3650,
                "vgroups": d.vgroups,
                "cache_mb": 16,
                "status": "ACTIVE",
                "stable_count": d.stable_count,
                "subtable_count": d.ntables,
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
                "last_verified_at": now_iso,
                "drift_status": "OK",
            }
            for d in dbs
        ]
        return {"items": items, "total": len(items), "page": 1, "page_size": 50}

    @router.get("/api/v1/storage/td/databases/{name}", tags=["storage"])
    async def get_td_database(
        name: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if not await _assert_tenant_database_access(session, tenant_id, name):
            raise AppError(404, "NOT_FOUND", f"Database '{name}' not found")
        d = await topology_inspector.get_database(name)
        if not d:
            raise AppError(404, "NOT_FOUND", f"Database '{name}' not found")
        now_iso = iso_ms(utcnow())
        return {
            "id": d.name,
            "physical_name": d.name,
            "display_name": d.name,
            "description": "",
            "precision": d.precision,
            "retention_days": 3650,
            "vgroups": d.vgroups,
            "cache_mb": 16,
            "status": "ACTIVE",
            "stable_count": d.stable_count,
            "subtable_count": d.ntables,
            "tenant_id": str(tenant_id),
            "observed_at": now_iso,
            "last_verified_at": now_iso,
            "drift_status": "OK",
        }

    @router.post("/api/v1/storage/td/databases", status_code=202, tags=["storage"])
    async def create_td_database(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        draft = await revision_service.create_draft(
            session, tenant_id, actor_id, {"kind": "database", "spec": body}
        )
        res = await revision_service.publish_draft(
            session, tenant_id, UUID(draft["id"]), actor_id
        )
        return {
            "id": res["operation_id"],
            "operation_id": res["operation_id"],
            "status": res["status"],
            "object_type": "database",
            "object_name": body.get("physical_name") or body.get("name"),
            "created_at": iso_ms(utcnow()),
        }

    @router.get("/api/v1/storage/td/stables", tags=["storage"])
    async def list_td_stables(
        database: str | None = None,
        cursor: str | None = None,
        search: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id)
        target_db = database or (dbs[0].name if dbs else f"fx_t_{tenant_id.hex}")
        stables = await topology_inspector.list_stables(target_db)
        if search:
            stables = [s for s in stables if search.lower() in s.name.lower()]
        now_iso = iso_ms(utcnow())
        items = [
            {
                "id": f"{s.database}.{s.name}",
                "database_id": s.database,
                "database_name": s.database,
                "physical_name": s.name,
                "display_name": s.name,
                "columns": [
                    {
                        "name": c.name,
                        "td_type": c.td_type,
                        "nullable": c.nullable,
                        "role": "timestamp" if c.role == "time_key" else c.role,
                        "length": c.length,
                    }
                    for c in s.columns
                ],
                "tags": [
                    {"name": t.name, "td_type": t.td_type}
                    for t in s.tags
                ],
                "subtable_count": s.subtable_count,
                "status": "ACTIVE",
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
                "last_verified_at": now_iso,
                "drift_status": "OK",
            }
            for s in stables
        ]
        return {"items": items, "total": len(items), "page": 1, "page_size": 50}

    @router.get("/api/v1/storage/td/stables/{stable_id:path}", tags=["storage"])
    async def get_td_stable(
        stable_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if "." in stable_id:
            db_name, sname = stable_id.split(".", 1)
        else:
            db_name = f"fx_t_{tenant_id.hex}"
            sname = stable_id
        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Supertable '{stable_id}' not found")
        st = await topology_inspector.get_stable(db_name, sname)
        if not st:
            raise AppError(404, "NOT_FOUND", f"Supertable '{stable_id}' not found")
        now_iso = iso_ms(utcnow())
        return {
            "id": f"{st.database}.{st.name}",
            "database_id": st.database,
            "database_name": st.database,
            "physical_name": st.name,
            "display_name": st.name,
            "columns": [
                {
                    "name": c.name,
                    "td_type": c.td_type,
                    "nullable": c.nullable,
                    "role": "timestamp" if c.role == "time_key" else c.role,
                    "length": c.length,
                }
                for c in st.columns
            ],
            "tags": [
                {"name": t.name, "td_type": t.td_type}
                for t in st.tags
            ],
            "subtable_count": st.subtable_count,
            "status": "ACTIVE",
            "tenant_id": str(tenant_id),
            "observed_at": now_iso,
            "last_verified_at": now_iso,
            "drift_status": "OK",
        }

    @router.post("/api/v1/storage/td/stables", status_code=202, tags=["storage"])
    async def create_td_stable(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        if not body.get("database"):
            body["database"] = body.get("database_name") or f"fx_t_{tenant_id.hex}"
        draft = await revision_service.create_draft(
            session, tenant_id, actor_id, {"kind": "stable", "spec": body}
        )
        res = await revision_service.publish_draft(
            session, tenant_id, UUID(draft["id"]), actor_id
        )
        return {
            "id": res["operation_id"],
            "operation_id": res["operation_id"],
            "status": res["status"],
            "object_type": "stable",
            "object_name": body.get("physical_name") or body.get("name"),
            "created_at": iso_ms(utcnow()),
        }

    @router.post("/api/v1/storage/td/stables/validate", tags=["storage"])
    async def validate_td_stable(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        if not body.get("database"):
            body["database"] = body.get("database_name") or f"fx_t_{tenant_id.hex}"
        v_res = await revision_service.validate_draft(
            session, tenant_id, uuid4(), custom_spec={"kind": "stable", "spec": body}
        )
        return {
            "valid": v_res["valid"],
            "errors": [
                {"field": e.get("field", "columns"), "message": e.get("message", "Validation error")}
                for e in v_res.get("errors", [])
            ],
            "warnings": v_res.get("warnings", []),
        }

    @router.get("/api/v1/storage/td/subtables", tags=["storage"])
    async def list_td_subtables(
        stable: str | None = None,
        database: str | None = None,
        cursor: str | None = None,
        search: str | None = None,
        status: str | None = None,
        limit: int = 50,
        principal: dict[str, Any] = Depends(admin_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id)
        target_db = database or (dbs[0].name if dbs else f"fx_t_{tenant_id.hex}")
        subs, next_cur = await topology_inspector.list_subtables(
            target_db, stable_name=stable, cursor=cursor, limit=limit
        )
        if search:
            subs = [s for s in subs if search.lower() in s.name.lower()]
        now_iso = iso_ms(utcnow())
        items = [
            {
                "id": f"{s.database}.{s.name}",
                "stable_id": f"{s.database}.{s.stable_name}",
                "stable_name": s.stable_name,
                "database_id": s.database,
                "database_name": s.database,
                "physical_name": s.name,
                "display_name": s.name,
                "tag_values": [{"name": k, "td_type": "NCHAR", "value": str(v)} for k, v in s.tags.items()],
                "bindings": [],
                "status": "ACTIVE",
                "write_active": True,
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
                "last_verified_at": now_iso,
                "drift_status": "OK",
            }
            for s in subs
        ]
        return {"items": items, "total": len(items), "cursor": next_cur, "page": 1, "page_size": limit}

    @router.get("/api/v1/storage/td/subtables/{subtable_id:path}", tags=["storage"])
    async def get_td_subtable(
        subtable_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if "." in subtable_id:
            db_name, tname = subtable_id.split(".", 1)
        else:
            db_name = f"fx_t_{tenant_id.hex}"
            tname = subtable_id
        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Subtable '{subtable_id}' not found")
        sub = await topology_inspector.get_subtable(db_name, tname)
        if not sub:
            raise AppError(404, "NOT_FOUND", f"Subtable '{subtable_id}' not found")
        now_iso = iso_ms(utcnow())
        return {
            "id": f"{sub.database}.{sub.name}",
            "stable_id": f"{sub.database}.{sub.stable_name}",
            "stable_name": sub.stable_name,
            "database_id": sub.database,
            "database_name": sub.database,
            "physical_name": sub.name,
            "display_name": sub.name,
            "tag_values": [{"name": k, "td_type": "NCHAR", "value": str(v)} for k, v in sub.tags.items()],
            "bindings": [],
            "status": "ACTIVE",
            "write_active": True,
            "tenant_id": str(tenant_id),
            "observed_at": now_iso,
            "last_verified_at": now_iso,
            "drift_status": "OK",
        }

    @router.post("/api/v1/storage/td/subtables", status_code=202, tags=["storage"])
    async def create_td_subtable(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        if not body.get("database"):
            body["database"] = f"fx_t_{tenant_id.hex}"
        if not body.get("stable"):
            body["stable"] = body.get("stable_id") or ""
            if "." in body["stable"]:
                body["database"], body["stable"] = body["stable"].split(".", 1)
        tag_vals = {}
        for tv in body.get("tag_values", []):
            if isinstance(tv, dict):
                tag_vals[tv.get("tag_name") or tv.get("name")] = tv.get("value")
        body["tag_values"] = tag_vals

        draft = await revision_service.create_draft(
            session, tenant_id, actor_id, {"kind": "subtable", "spec": body}
        )
        res = await revision_service.publish_draft(
            session, tenant_id, UUID(draft["id"]), actor_id
        )
        return {
            "id": res["operation_id"],
            "operation_id": res["operation_id"],
            "status": res["status"],
            "object_type": "subtable",
            "object_name": body.get("physical_name") or body.get("name"),
            "created_at": iso_ms(utcnow()),
        }

    @router.get("/api/v1/storage/td/objects/{object_id:path}", tags=["storage"])
    async def get_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        now_iso = iso_ms(utcnow())

        obj_kind, parsed_db, parsed_name = ST.parse_canonical_object_id(object_id)
        target_db = parsed_db or (parsed_name if obj_kind == "database" else f"fx_t_{tenant_id.hex}")
        if not await _assert_tenant_database_access(session, tenant_id, target_db):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        # 1. Database
        if obj_kind == "database" or "." not in object_id:
            d = await topology_inspector.get_database(parsed_name)
            if d:
                return {
                    "id": d.name,
                    "object_type": "database",
                    "physical_name": d.name,
                    "display_name": d.name,
                    "precision": d.precision,
                    "status": "ACTIVE",
                    "stable_count": d.stable_count,
                    "subtable_count": d.ntables,
                    "tenant_id": str(tenant_id),
                    "observed_at": now_iso,
                }

        # 2. Supertable or Subtable
        st = await topology_inspector.get_stable(target_db, parsed_name)
        if st:
            return {
                "id": f"{st.database}.{st.name}",
                "object_type": "stable",
                "database_name": st.database,
                "physical_name": st.name,
                "display_name": st.name,
                "columns": [{"name": c.name, "td_type": c.td_type} for c in st.columns],
                "tags": [{"name": t.name, "td_type": t.td_type} for t in st.tags],
                "subtable_count": st.subtable_count,
                "status": "ACTIVE",
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
            }

        sub = await topology_inspector.get_subtable(target_db, parsed_name)
        if sub:
            return {
                "id": f"{sub.database}.{sub.name}",
                "object_type": "subtable",
                "stable_name": sub.stable_name,
                "database_name": sub.database,
                "physical_name": sub.name,
                "display_name": sub.name,
                "tag_values": [{"name": k, "value": str(v)} for k, v in sub.tags.items()],
                "status": "ACTIVE",
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
            }

        raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

    @router.patch("/api/v1/storage/td/objects/{object_id:path}", tags=["storage"])
    async def patch_td_object(
        object_id: str,
        body: dict[str, Any] = Body(...),
        if_match: str | None = Header(None, alias="If-Match"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Update storage object metadata, tags, columns, or retention with revision concurrency check."""
        tenant_id, actor_id = ids(principal)
        now_iso = iso_ms(utcnow())

        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if not db_name:
            db_name = name if obj_kind == "database" else f"fx_t_{tenant_id.hex}"

        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        existing_obj = await fetch_one(
            session,
            """
            SELECT id, object_type, physical_db, physical_name, display_name, description,
                   status, schema_json, tags_json, revision, updated_at
            FROM storage_objects
            WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_name = :name
            LIMIT 1
            """,
            {"tenant_id": tenant_id, "db": db_name, "name": name},
        )

        current_rev = int(existing_obj["revision"]) if existing_obj else 1

        client_rev = body.get("revision") or body.get("expected_revision")
        if if_match:
            try:
                client_rev = int(if_match.strip('"'))
            except (ValueError, TypeError):
                pass

        if client_rev is not None and int(client_rev) != current_rev:
            raise AppError(
                409,
                "VERSION_CONFLICT",
                f"Object revision conflict: server has revision {current_rev}, request specified {client_rev}",
                extra={"server_revision": current_rev, "client_revision": client_rev},
            )

        schema_changing_keys = {
            "columns", "tags", "tag_values", "precision", "retention_days",
            "source_mapping_template", "bindings"
        }
        is_metadata_only = not any(k in body and body[k] is not None for k in schema_changing_keys)

        if is_metadata_only and existing_obj:
            new_disp = body.get("display_name", existing_obj.get("display_name") or "")
            new_desc = body.get("description", existing_obj.get("description") or "")
            new_rev = current_rev + 1
            await execute(
                session,
                """
                UPDATE storage_objects
                SET display_name = :disp, description = :desc, revision = :rev, updated_at = :now
                WHERE id = :id AND tenant_id = :tenant_id
                """,
                {
                    "disp": new_disp,
                    "desc": new_desc,
                    "rev": new_rev,
                    "now": utcnow(),
                    "id": existing_obj["id"],
                    "tenant_id": tenant_id,
                },
            )
            return {
                "id": object_id,
                "object_type": existing_obj["object_type"],
                "physical_name": existing_obj["physical_name"],
                "display_name": new_disp,
                "description": new_desc,
                "revision": new_rev,
                "status": existing_obj["status"],
                "observed_at": now_iso,
            }

        draft_body = {
            "kind": obj_kind,
            "name": name,
            "spec": {
                **body,
                "database": db_name,
                "physical_name": name,
            },
        }
        draft = await revision_service.create_draft(session, tenant_id, actor_id, draft_body)
        res = await revision_service.publish_draft(session, tenant_id, UUID(draft["id"]), actor_id)

        return {
            "id": res["operation_id"],
            "operation_id": res["operation_id"],
            "operation_kind": "ALTER",
            "status": res["status"],
            "object_type": obj_kind,
            "object_name": name,
            "created_at": now_iso,
        }

    @router.post("/api/v1/storage/td/objects/{object_id:path}/pause", tags=["storage"])
    async def pause_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Pause data recording on a storage object."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if not db_name:
            db_name = name if obj_kind == "database" else f"fx_t_{tenant_id.hex}"

        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        op_id = uuid4()
        now = utcnow()
        await execute(
            session,
            """
            UPDATE storage_objects
            SET status = 'PAUSED', updated_at = :now
            WHERE tenant_id = :tenant_id AND physical_db = :db
              AND (physical_name = :name OR :obj_kind = 'database' OR parent_name = :name)
            """,
            {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name, "obj_kind": obj_kind},
        )
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, target_name, actor_id,
                status, requested_at, completed_at, step_state_json
            ) VALUES (
                :id, :tenant_id, 'PAUSE', :target_type, :target_name, :actor_id,
                'APPLIED', :now, :now, :state
            )
            """,
            {
                "id": op_id,
                "tenant_id": tenant_id,
                "target_type": obj_kind,
                "target_name": name,
                "actor_id": actor_id,
                "now": now,
                "state": json.dumps({"action": "pause", "object_id": object_id}),
            },
        )
        return {
            "id": object_id,
            "operation_id": str(op_id),
            "status": "PAUSED",
            "write_active": False,
            "updated_at": iso_ms(now),
        }

    @router.post("/api/v1/storage/td/objects/{object_id:path}/resume", tags=["storage"])
    async def resume_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Resume data recording on a storage object."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if not db_name:
            db_name = name if obj_kind == "database" else f"fx_t_{tenant_id.hex}"

        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        op_id = uuid4()
        now = utcnow()
        await execute(
            session,
            """
            UPDATE storage_objects
            SET status = 'ACTIVE', updated_at = :now
            WHERE tenant_id = :tenant_id AND physical_db = :db
              AND (physical_name = :name OR :obj_kind = 'database' OR parent_name = :name)
            """,
            {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name, "obj_kind": obj_kind},
        )
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, target_name, actor_id,
                status, requested_at, completed_at, step_state_json
            ) VALUES (
                :id, :tenant_id, 'RESUME', :target_type, :target_name, :actor_id,
                'APPLIED', :now, :now, :state
            )
            """,
            {
                "id": op_id,
                "tenant_id": tenant_id,
                "target_type": obj_kind,
                "target_name": name,
                "actor_id": actor_id,
                "now": now,
                "state": json.dumps({"action": "resume", "object_id": object_id}),
            },
        )
        return {
            "id": object_id,
            "operation_id": str(op_id),
            "status": "ACTIVE",
            "write_active": True,
            "updated_at": iso_ms(now),
        }

    @router.post("/api/v1/storage/td/objects/{object_id:path}/retire", tags=["storage"])
    async def retire_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Soft-retire a storage object, halting new writes while preserving historical data."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if not db_name:
            db_name = name if obj_kind == "database" else f"fx_t_{tenant_id.hex}"

        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        op_id = uuid4()
        now = utcnow()
        await execute(
            session,
            """
            UPDATE storage_objects
            SET status = 'RETIRED', updated_at = :now
            WHERE tenant_id = :tenant_id AND physical_db = :db
              AND (physical_name = :name OR :obj_kind = 'database' OR parent_name = :name)
            """,
            {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name, "obj_kind": obj_kind},
        )
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, target_name, actor_id,
                status, requested_at, completed_at, step_state_json
            ) VALUES (
                :id, :tenant_id, 'RETIRE', :target_type, :target_name, :actor_id,
                'APPLIED', :now, :now, :state
            )
            """,
            {
                "id": op_id,
                "tenant_id": tenant_id,
                "target_type": obj_kind,
                "target_name": name,
                "actor_id": actor_id,
                "now": now,
                "state": json.dumps({"action": "retire", "object_id": object_id}),
            },
        )
        return {
            "id": object_id,
            "operation_id": str(op_id),
            "status": "RETIRED",
            "write_active": False,
            "updated_at": iso_ms(now),
        }

    @router.delete("/api/v1/storage/td/objects/{object_id:path}", tags=["storage"])
    async def delete_td_object(
        object_id: str,
        confirm_name: str | None = Query(None),
        force: bool = Query(False),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Destructively drop a storage object with safety confirmation and dependency validation."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if not db_name:
            db_name = name if obj_kind == "database" else f"fx_t_{tenant_id.hex}"

        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        if confirm_name != name and not force:
            raise AppError(
                400,
                "CONFIRMATION_REQUIRED",
                f"Destructive purge requires explicit confirmation. Pass confirm_name='{name}' to confirm.",
            )

        if not force:
            dep_views = await fetch_all(
                session,
                "SELECT id, name FROM saved_views WHERE tenant_id = :tenant_id AND query_params_json::text LIKE :pat LIMIT 5",
                {"tenant_id": tenant_id, "pat": f"%{name}%"},
            )
            if dep_views:
                raise AppError(
                    409,
                    "DEPENDENCY_EXISTS",
                    f"Cannot purge object '{name}': dependent views exist ({[v['name'] for v in dep_views]}).",
                )

        if td is not None:
            try:
                exec_fn = getattr(td, "execute_sql", None) or getattr(td, "run_write", None)
                if exec_fn is not None:
                    if obj_kind in ("subtable", "table"):
                        await exec_fn(f"DROP TABLE IF EXISTS `{db_name}`.`{name}`")
                    elif obj_kind == "stable":
                        await exec_fn(f"DROP STABLE IF EXISTS `{db_name}`.`{name}`")
                    elif obj_kind == "database":
                        await exec_fn(f"DROP DATABASE IF EXISTS `{name}`")
            except Exception as exc:
                logger.warning("TDengine DROP failed during purge of %s: %s", object_id, exc)

        now = utcnow()
        await execute(
            session,
            """
            UPDATE storage_objects
            SET status = 'PURGED', updated_at = :now
            WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_name = :name
            """,
            {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name},
        )
        return {
            "id": object_id,
            "status": "PURGED",
            "dropped": True,
            "purged_at": iso_ms(now),
        }

    @router.get("/api/v1/storage/td/bindings", tags=["storage"])
    async def list_td_bindings(
        target: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        rows = await fetch_all(
            session,
            """
            SELECT fb.id, fb.field_key, fb.value_type, fb.source_kind, fb.signal_id,
                   fb.model_id, fb.model_field_path, fb.resource_id, fb.source_ref,
                   fb.source_revision, fb.transform_json, fb.nullable, fb.required,
                   fb.unit, ds.dataset_key, d.name AS design_name
            FROM storage_field_bindings fb
            JOIN storage_datasets ds ON ds.id = fb.dataset_id
            JOIN storage_designs d ON d.id = ds.design_id
            WHERE fb.tenant_id = :tenant_id
            LIMIT 200
            """,
            {"tenant_id": tenant_id},
        )
        return {
            "items": [
                {
                    "id": str(r["id"]),
                    "field_key": r["field_key"],
                    "value_type": r["value_type"],
                    "source_kind": r["source_kind"],
                    "signal_id": str(r["signal_id"]) if r.get("signal_id") else None,
                    "model_id": str(r["model_id"]) if r.get("model_id") else None,
                    "model_field_path": r.get("model_field_path"),
                    "source_ref": r["source_ref"],
                    "unit": r.get("unit"),
                }
                for r in rows
            ],
            "total": len(rows),
        }

    # --- Drafts Lifecycle ---

    @router.post("/api/v1/storage/td/objects/drafts", status_code=201, tags=["storage"])
    async def create_storage_draft(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        return await revision_service.create_draft(session, tenant_id, actor_id, body)

    @router.patch("/api/v1/storage/td/objects/drafts/{draft_id}", tags=["storage"])
    async def patch_storage_draft(
        draft_id: str,
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        return await revision_service.patch_draft(
            session, tenant_id, parse_uuid(draft_id), actor_id, body
        )

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
        return await revision_service.plan_draft(
            session, tenant_id, parse_uuid(draft_id), custom_spec=body if body else None
        )

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
        return await revision_service.publish_draft(
            session,
            tenant_id,
            parse_uuid(draft_id),
            actor_id,
            idempotency_key=idempotency_key or body.get("idempotency_key"),
        )

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
        limit: int = 50,
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
            LIMIT {min(max(1, limit), 200)}
        """
        rows = await fetch_all(session, sql, params)
        items = []
        for r in rows:
            step_state = r["step_state_json"]
            if isinstance(step_state, str):
                try:
                    import json
                    step_state = json.loads(step_state)
                except Exception:
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

    # --- Unified Sources Discovery ---

    @router.get("/api/v1/storage/sources", tags=["storage"])
    async def get_storage_sources(
        view: str = Query("hierarchy", pattern="^(hierarchy|collector|models)$"),
        search: str | None = None,
        limit: int = 100,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await binding_service.list_sources(
            session, tenant_id, view=view, search=search, limit=limit
        )

    # --- PostgreSQL Read-Only Explorer ---

    @router.get("/api/v1/storage/pg/schemas", tags=["storage"])
    async def list_pg_schemas(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> list[dict[str, Any]]:
        return await pg_explorer.list_schemas(session)

    @router.get("/api/v1/storage/pg/tables", tags=["storage"])
    async def list_pg_tables(
        schema: str = "public",
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> list[dict[str, Any]]:
        return await pg_explorer.list_tables(session, schema=schema)

    @router.get("/api/v1/storage/pg/tables/{schema}/{table}", tags=["storage"])
    async def get_pg_table_detail(
        schema: str,
        table: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        res = await pg_explorer.get_table_details(session, table=table, schema=schema)
        if not res:
            raise AppError(404, "NOT_FOUND", f"Table '{schema}.{table}' not found")
        return res

    @router.get("/api/v1/storage/pg/relationships", tags=["storage"])
    async def get_pg_relationships(
        schema: str = "public",
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tables = await pg_explorer.list_tables(session, schema=schema)
        rels = await pg_explorer.list_relationships(session, schema=schema)
        return {
            "tables": tables,
            "relationships": rels,
            "source": "postgresql",
            "observed_at": iso_ms(utcnow()),
        }

    @router.get("/api/v1/storage/pg/preview/{schema}/{table}", tags=["storage"])
    @router.get("/api/v1/storage/pg/preview", tags=["storage"])
    async def get_pg_preview(
        schema: str = "public",
        table: str | None = None,
        limit: int = 50,
        offset: int = 0,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if not table:
            raise AppError(400, "MISSING_TABLE", "Query parameter 'table' is required.")
        return await pg_explorer.preview_data(
            session, table=table, schema=schema, limit=limit, offset=offset, tenant_id=tenant_id
        )

    return router


# Default router instance
router = build_router()
