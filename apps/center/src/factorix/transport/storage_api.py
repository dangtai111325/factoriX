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
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import historian_catalog as HC
from factorix.modules import historian_service as HS
from factorix.modules import historian_views as HV
from factorix.modules import postgres_explorer as PE
from factorix.modules import storage_bindings as SB
from factorix.modules import storage_designs as SD
from factorix.modules import storage_model_recorder as SMR
from factorix.modules import storage_objects as SO
from factorix.modules import storage_revisions as SR
from factorix.modules import storage_topology as ST
from factorix.modules.storage_objects import StorageObjectError, is_system_stable, is_system_subtable
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


def _is_missing_td_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "not exist",
            "doesn't exist",
            "does not exist",
            "unknown database",
            "database not specified",
            "0x0362",
            "table does not exist",
            "stable does not exist",
        )
    )


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


def _json_response(payload: Any) -> Response:
    """Large read payloads (Historian series) are serialized once with ``json.dumps``; FastAPI's
    generic response-model encoding walks every point again (D1)."""
    return Response(
        content=json.dumps(payload, separators=(",", ":"), ensure_ascii=False, default=str, allow_nan=False),
        media_type="application/json",
    )


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

    # ==========================================================================
    # Physical-First TDengine & PostgreSQL Storage APIs
    # ==========================================================================

    async def _assert_tenant_database_access(
        sess: AsyncSession | None, tenant_id: UUID, db_name: str | None
    ) -> bool:
        if not db_name:
            return False
        canonical_tenant_db = f"fx_t_{tenant_id.hex}"
        if db_name.lower() == canonical_tenant_db.lower():
            return True
        if sess is not None:
            row = await fetch_one(
                sess,
                "SELECT 1 FROM storage_objects WHERE tenant_id = :tenant_id AND physical_db = :db "
                "AND status <> 'PURGED' LIMIT 1",
                {"tenant_id": tenant_id, "db": db_name},
            )
            if row:
                return True
        return False

    async def _require_db(sess: AsyncSession, tenant_id: UUID, db_name: str | None, what: str) -> str:
        """Tenant check for every ``?database=`` / object id (P1-13)."""
        db = db_name or f"fx_t_{tenant_id.hex}"
        if not await _assert_tenant_database_access(sess, tenant_id, db):
            raise AppError(404, "NOT_FOUND", f"{what} not found")
        return db

    def _storage_error(exc: StorageObjectError) -> AppError:
        return AppError(
            int(getattr(exc, "http_status", 422)),
            exc.code or "STORAGE_OPERATION_FAILED",
            str(exc),
            field_errors=getattr(exc, "field_errors", None) or [],
            retryable=exc.code in ("STORAGE_ENGINE_UNAVAILABLE", "PUBLISH_FAILED"),
        )

    async def _registry(sess: AsyncSession, tenant_id: UUID, kind: str | None, db: str, name: str) -> dict[str, Any] | None:
        return await fetch_one(
            sess,
            """
            SELECT id, object_type, physical_db, physical_name, parent_name, display_name, description,
                   status, schema_json, tags_json, recording_json, revision, created_at, updated_at
            FROM storage_objects
            WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_name = :name
              AND (CAST(:kind AS text) IS NULL OR object_type = :kind) AND status <> 'PURGED'
            ORDER BY updated_at DESC LIMIT 1
            """,
            {"tenant_id": tenant_id, "db": db, "name": name, "kind": kind},
        )

    async def _bindings_of(sess: AsyncSession, tenant_id: UUID, db: str, sub: str) -> list[dict[str, Any]]:
        rows = await fetch_all(
            sess,
            """
            SELECT b.id, b.source_kind, b.canonical_source_id, b.target_column, b.signal_id, b.model_id,
                   b.model_field_path, b.row_assembly_policy, b.policy_config_json, b.status, b.source_data_type,
                   m.display_name AS model_name, s.key AS signal_key
            FROM storage_bindings b
            LEFT JOIN output_groups m ON m.id = b.model_id
            LEFT JOIN signal_definitions s ON s.id = b.signal_id
            WHERE b.tenant_id = :tenant_id AND b.physical_db = :db AND b.physical_subtable = :sub
            ORDER BY b.target_column
            """,
            {"tenant_id": tenant_id, "db": db, "sub": sub},
        )
        out = []
        for r in rows:
            cfg = r.get("policy_config_json")
            if isinstance(cfg, str):
                try:
                    cfg = json.loads(cfg)
                except ValueError:
                    cfg = {}
            out.append({
                "id": str(r["id"]),
                "source_kind": r["source_kind"],
                "source_id": r["canonical_source_id"],
                "column_name": r["target_column"],
                "target_column": r["target_column"],
                "signal_id": str(r["signal_id"]) if r.get("signal_id") else None,
                "signal_key": r.get("signal_key"),
                "model_id": str(r["model_id"]) if r.get("model_id") else None,
                "model_name": r.get("model_name"),
                "model_field_path": r.get("model_field_path"),
                "source_path": r.get("model_field_path") or r.get("signal_key"),
                "row_assembly_policy": r["row_assembly_policy"],
                "recording_mode": (cfg or {}).get("mode", "ON_CHANGE"),
                "source_data_type": r.get("source_data_type"),
                "status": r["status"],
            })
        return out

    def _json_field(raw: Any, default: Any) -> Any:
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except ValueError:
                return default
        return raw if raw is not None else default

    async def _create_object(
        sess: AsyncSession, tenant_id: UUID, actor_id: UUID | None, kind: str, body: dict[str, Any],
        idem: str | None,
    ) -> dict[str, Any]:
        try:
            draft = await revision_service.create_draft(sess, tenant_id, actor_id, {"kind": kind, "spec": body})
            res = await revision_service.publish_draft(
                sess, tenant_id, UUID(draft["id"]), actor_id, idempotency_key=idem or body.get("idempotency_key"),
            )
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc
        SMR.invalidate_bindings(tenant_id)
        return {
            "id": res["operation_id"],
            "operation_id": res["operation_id"],
            "status": res["status"],
            "object_type": kind,
            "object_key": res.get("object_key"),
            "object_name": body.get("physical_name") or body.get("name"),
            "idempotent_replay": bool(res.get("idempotent_replay")),
            "ddl": res.get("ddl", []),
            "verification": res.get("verification"),
            "created_at": iso_ms(utcnow()),
        }

    async def _resolve_kind(db: str, name: str, hint: str) -> str:
        """``stable`` or ``subtable`` from TDengine for ``db.name`` ids (the parser only knows 'table')."""
        if hint in ("stable", "subtable"):
            return hint
        try:
            rows = await revision_service._td_read(
                "SELECT stable_name FROM information_schema.ins_stables "
                f"WHERE db_name = '{db}' AND stable_name = '{name}'"
            )
        except Exception:  # noqa: BLE001
            rows = []
        return "stable" if rows else "subtable"

    def _assert_user_object(kind: str, db: str, name: str | None, tenant_id: UUID, action: str) -> None:
        """FactoriX system objects are read-only in the Storage UI (R1-16)."""
        if kind == "database" and (name or db) == f"fx_t_{tenant_id.hex}":
            if action in ("drop", "retire", "alter"):
                raise AppError(403, "SYSTEM_OBJECT", "The tenant database is managed by FactoriX and cannot be changed here.")
        if kind == "stable" and is_system_stable(name):
            raise AppError(403, "SYSTEM_OBJECT", f"'{name}' is a FactoriX system supertable (operational history); it is read-only.")
        if kind in ("subtable", "table") and is_system_subtable(name):
            raise AppError(403, "SYSTEM_OBJECT", f"'{name}' is a FactoriX system table; it is read-only.")

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
        include_subtable_tags: bool = True,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        snap = await topology_inspector.get_topology(
            tenant_id,
            database=database,
            depth=depth,
            cursor=cursor,
            session=session,
            include_subtable_tags=include_subtable_tags,
        )
        return ST.topology_snapshot_to_dict(snap)

    @router.get("/api/v1/storage/td/catalog", tags=["storage"])
    async def get_td_catalog(
        object_type: Literal["database", "stable", "subtable"] | None = None,
        status: Literal["ACTIVE", "DRAFT", "OUT_OF_SYNC", "ERROR"] | None = None,
        search: str = Query("", max_length=200),
        page: int = Query(1, ge=1),
        page_size: int = Query(15, ge=1, le=100),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        rows, total = await topology_inspector.list_catalog(
            tenant_id, session, object_type=object_type, status=status, search=search, page=page, page_size=page_size,
        )
        observed_at = iso_ms(utcnow())
        return {
            "items": [{**row, "last_verified_at": observed_at} for row in rows],
            "total": total,
        }

    @router.get("/api/v1/storage/td/stats", tags=["storage"])
    async def get_td_stats(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id, await ST.registered_databases(session, tenant_id))
        db_count = len(dbs)
        total_stables = sum(d.stable_count for d in dbs)
        total_subtables = sum(d.subtable_count for d in dbs)

        # "Recording" = registered subtables that are ACTIVE and have at least one ACTIVE binding;
        # errors = subtables with FAILED outbox rows (writer could not store them).
        rows = await fetch_all(
            session,
            """
            SELECT o.status,
                   COUNT(*) FILTER (WHERE EXISTS (
                       SELECT 1 FROM storage_bindings b WHERE b.tenant_id = o.tenant_id
                         AND b.physical_db = o.physical_db AND b.physical_subtable = o.physical_name
                         AND b.status = 'ACTIVE')) AS bound
            FROM storage_objects o
            WHERE o.tenant_id = :tenant_id AND o.object_type = 'subtable' AND o.status <> 'PURGED'
            GROUP BY o.status
            """,
            {"tenant_id": tenant_id},
        )
        status_map = {r["status"]: int(r["bound"] or 0) for r in rows}
        active_cnt = status_map.get("ACTIVE", 0)
        paused_cnt = status_map.get("PAUSED", 0)
        err_row = await fetch_one(
            session,
            "SELECT COUNT(DISTINCT physical_db || '.' || physical_subtable) AS n FROM storage_record_outbox "
            "WHERE tenant_id = :tenant_id AND status = 'FAILED'",
            {"tenant_id": tenant_id},
        )
        error_cnt = int((err_row or {}).get("n") or 0)

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
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id, await ST.registered_databases(session, tenant_id))
        labels = {
            str(r["physical_name"]): r for r in await fetch_all(
                session,
                "SELECT physical_name, display_name, description FROM storage_objects "
                "WHERE tenant_id = :tenant_id AND object_type = 'database' AND status <> 'PURGED'",
                {"tenant_id": tenant_id},
            )
        }
        now_iso = iso_ms(utcnow())
        items = []
        for d in dbs:
            reg = labels.get(d.name) or {}
            keep = str(d.keep or "")
            try:
                retention_days = int(keep.split(",")[-1].strip().rstrip("d")) if keep.split(",")[-1].strip().endswith("d") else None
            except ValueError:
                retention_days = None
            items.append({
                "id": d.name,
                "physical_name": d.name,
                "display_name": reg.get("display_name") or d.name,
                "description": reg.get("description") or "",
                "precision": d.precision,
                "keep": d.keep,
                "retention_days": retention_days,
                "vgroups": d.vgroups,
                "status": "ACTIVE",
                "stable_count": d.stable_count,
                "subtable_count": d.subtable_count,
                "is_tenant_default": d.is_tenant,
                "is_system": d.is_tenant,
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
            })
        return {"items": items, "total": len(items), "page": 1, "page_size": len(items)}

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
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        return await _create_object(session, tenant_id, actor_id, "database", body, idempotency_key)

    @router.get("/api/v1/storage/td/stables", tags=["storage"])
    async def list_td_stables(
        database: str | None = None,
        cursor: str | None = None,
        search: str | None = None,
        include_system: bool = True,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if database:
            target_dbs = [await _require_db(session, tenant_id, database, f"Database '{database}'")]
        else:
            target_dbs = [d.name for d in await topology_inspector.list_databases(
                tenant_id, await ST.registered_databases(session, tenant_id))]
        reg_rows = await fetch_all(
            session,
            "SELECT physical_db, physical_name, display_name, description, recording_json FROM storage_objects "
            "WHERE tenant_id = :tenant_id AND object_type = 'stable' AND status <> 'PURGED'",
            {"tenant_id": tenant_id},
        )
        reg = {(str(r["physical_db"]), str(r["physical_name"])): r for r in reg_rows}
        now_iso = iso_ms(utcnow())
        items = []
        for db_name in target_dbs:
            for st in await topology_inspector.list_stables(db_name):
                system = is_system_stable(st.name)
                if search and search.lower() not in st.name.lower():
                    continue
                if system and not include_system:
                    continue
                r = reg.get((st.database, st.name)) or {}
                items.append({
                    "id": f"{st.database}.{st.name}",
                    "database_id": st.database,
                    "database_name": st.database,
                    "physical_name": st.name,
                    "display_name": r.get("display_name") or st.name,
                    "description": r.get("description") or "",
                    "columns": [
                        {
                            "name": c.name,
                            "td_type": c.td_type,
                            "nullable": c.nullable,
                            "role": "timestamp" if c.role == "time_key" else c.role,
                            "length": c.length,
                            "primary_key": c.primary_key,
                        }
                        for c in st.columns
                    ],
                    "tags": [{"name": t.name, "td_type": t.td_type, "length": t.length} for t in st.tags],
                    "subtable_count": st.subtable_count,
                    "status": "ACTIVE",
                    "is_system": system,
                    "managed": bool(r),
                    "recording": _json_field(r.get("recording_json"), {}),
                    "tenant_id": str(tenant_id),
                    "observed_at": now_iso,
                })
        return {"items": items, "total": len(items), "page": 1, "page_size": len(items)}

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
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        body = dict(body)
        body["database"] = await _require_db(
            session, tenant_id, body.get("database") or body.get("database_name"), "Database"
        )
        return await _create_object(session, tenant_id, actor_id, "stable", body, idempotency_key)

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
            spec["database"] = f"fx_t_{tenant_id.hex}"
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

    @router.get("/api/v1/storage/td/templates", tags=["storage"])
    async def stable_templates(principal: dict[str, Any] = Depends(admin_dep)) -> dict[str, Any]:
        """Generic supertable column templates (no customer data): per-field change history."""
        audit = [
            {"name": "ts", "td_type": "TIMESTAMP", "role": "timestamp"},
            {"name": "event_key", "td_type": "VARCHAR", "length": 64, "primary_key": True},
            {"name": "source_timestamp", "td_type": "TIMESTAMP"},
            {"name": "publish_timestamp", "td_type": "TIMESTAMP"},
            {"name": "field_source_timestamp", "td_type": "TIMESTAMP"},
            {"name": "quality", "td_type": "VARCHAR", "length": 16},
            {"name": "quality_reason", "td_type": "VARCHAR", "length": 128},
            {"name": "is_null", "td_type": "BOOL"},
            {"name": "model_ref", "td_type": "VARCHAR", "length": 36},
            {"name": "model_field_path", "td_type": "VARCHAR", "length": 128},
            {"name": "model_revision", "td_type": "INT"},
            {"name": "data_epoch", "td_type": "BIGINT"},
            {"name": "source_event_uid", "td_type": "VARCHAR", "length": 256},
            {"name": "time_basis", "td_type": "VARCHAR", "length": 24},
        ]
        event_audit = [c for c in audit if c["name"] not in ("field_source_timestamp", "is_null", "model_field_path")]
        return {"items": [
            {
                "id": "field_change_history",
                "name": "Per-field change history",
                "description": "One subtable per Data Model field; audit columns + typed value columns. Recording: on change.",
                "columns": audit,
                "value_columns": [
                    {"name": "value_f64", "td_type": "DOUBLE"},
                    {"name": "value_i64", "td_type": "BIGINT"},
                    {"name": "value_text", "td_type": "VARCHAR", "length": 256},
                ],
                "tags": [
                    {"name": "machine_ref", "td_type": "VARCHAR", "length": 36},
                    {"name": "line_ref", "td_type": "VARCHAR", "length": 36},
                    {"name": "field_key", "td_type": "VARCHAR", "length": 64},
                ],
                "recording_mode": "ON_CHANGE",
            },
            {
                "id": "atomic_event",
                "name": "Atomic event stream",
                "description": "One row per completed event with several business fields. Recording: on new event.",
                "columns": event_audit,
                "value_columns": [],
                "tags": [
                    {"name": "zone_ref", "td_type": "VARCHAR", "length": 36},
                    {"name": "line_ref", "td_type": "VARCHAR", "length": 36},
                ],
                "recording_mode": "ON_NEW_EVENT",
            },
        ]}

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
        limit: int = Query(50, ge=1, le=500),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if stable and "." in stable and not database:
            database, stable = stable.split(".", 1)
        target_db = await _require_db(session, tenant_id, database, f"Database '{database}'")
        try:
            subs, next_cur = await topology_inspector.list_subtables(
                target_db, stable_name=stable, cursor=cursor, limit=limit, search=search,
            )
            total = await topology_inspector.count_subtables(target_db, stable, search)
        except ValueError as exc:
            raise AppError(422, "INVALID_PARAMETER", str(exc)) from exc
        reg_rows = await fetch_all(
            session,
            """
            SELECT o.physical_name, o.display_name, o.status, o.recording_json,
                   (SELECT COUNT(*) FROM storage_bindings b WHERE b.tenant_id = o.tenant_id
                      AND b.physical_db = o.physical_db AND b.physical_subtable = o.physical_name
                      AND b.status = 'ACTIVE') AS binding_count
            FROM storage_objects o
            WHERE o.tenant_id = :tenant_id AND o.object_type = 'subtable' AND o.physical_db = :db
              AND o.status <> 'PURGED' AND o.physical_name = ANY(:names)
            """,
            {"tenant_id": tenant_id, "db": target_db, "names": [s.name for s in subs]},
        ) if subs else []
        reg = {str(r["physical_name"]): r for r in reg_rows}
        now_iso = iso_ms(utcnow())
        items = []
        for s in subs:
            r = reg.get(s.name) or {}
            st_value = str(r.get("status") or "ACTIVE")
            if status and st_value != status:
                continue
            items.append({
                "id": f"{s.database}.{s.name}",
                "stable_id": f"{s.database}.{s.stable_name}",
                "stable_name": s.stable_name,
                "database_id": s.database,
                "database_name": s.database,
                "physical_name": s.name,
                "display_name": r.get("display_name") or s.name,
                "tag_values": [{"name": k, "value": None if v is None else str(v)} for k, v in s.tags.items()],
                "binding_count": int(r.get("binding_count") or 0),
                "status": st_value,
                "managed": bool(r),
                "is_system": is_system_subtable(s.name),
                "write_active": bool(r) and st_value == "ACTIVE" and int(r.get("binding_count") or 0) > 0,
                "recording": _json_field(r.get("recording_json"), {}),
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
            })
        return {"items": items, "total": total, "cursor": next_cur, "next_cursor": next_cur, "page_size": limit}

    @router.get("/api/v1/storage/td/subtables/{subtable_id:path}", tags=["storage"])
    async def get_td_subtable(
        subtable_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if subtable_id.startswith("subtable:"):
            subtable_id = subtable_id[len("subtable:"):]
        db_name, tname = subtable_id.split(".", 1) if "." in subtable_id else (f"fx_t_{tenant_id.hex}", subtable_id)
        await _require_db(session, tenant_id, db_name, f"Subtable '{subtable_id}'")
        try:
            sub = await topology_inspector.get_subtable(db_name, tname)
        except ValueError as exc:
            raise AppError(404, "NOT_FOUND", f"Subtable '{subtable_id}' not found") from exc
        if not sub:
            raise AppError(404, "NOT_FOUND", f"Subtable '{subtable_id}' not found")
        r = await _registry(session, tenant_id, "subtable", db_name, tname) or {}
        bindings = await _bindings_of(session, tenant_id, db_name, tname)
        st_value = str(r.get("status") or "ACTIVE")
        return {
            "id": f"{sub.database}.{sub.name}",
            "stable_id": f"{sub.database}.{sub.stable_name}",
            "stable_name": sub.stable_name,
            "database_id": sub.database,
            "database_name": sub.database,
            "physical_name": sub.name,
            "display_name": r.get("display_name") or sub.name,
            "description": r.get("description") or "",
            "tag_values": [{"name": k, "value": None if v is None else str(v)} for k, v in sub.tags.items()],
            "bindings": bindings,
            "status": st_value,
            "managed": bool(r),
            "is_system": is_system_subtable(sub.name),
            "write_active": bool(r) and st_value == "ACTIVE" and bool(bindings),
            "recording": _json_field(r.get("recording_json"), {}),
            "tenant_id": str(tenant_id),
            "observed_at": iso_ms(utcnow()),
        }

    @router.post("/api/v1/storage/td/subtables", status_code=202, tags=["storage"])
    async def create_td_subtable(
        body: dict[str, Any] = Body(...),
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        body = dict(body)
        stable_ref = str(body.get("stable") or body.get("stable_id") or "")
        if "." in stable_ref:
            body["database"], body["stable"] = stable_ref.split(".", 1)
        body["database"] = await _require_db(session, tenant_id, body.get("database"), "Database")
        return await _create_object(session, tenant_id, actor_id, "subtable", body, idempotency_key)

    @router.post("/api/v1/storage/td/subtables/bulk", tags=["storage"])
    async def bulk_create_td_subtables(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Create many subtables through the SAME saga as the wizard, one operation per row.

        ``rows``: subtable specs (max 50 per call; the UI sends chunks). ``dry_run``: validate and plan
        only. Each row gets its own idempotency key (``bulk:<db>.<name>:<spec hash>``) so a retried
        chunk never duplicates. Rows are independent: one failing row does not stop the others.
        Result per row: CREATED | EXISTS | VALID | INVALID | FAILED, with operation id and errors.
        """
        tenant_id, actor_id = ids(principal)
        rows = [r for r in (body.get("rows") or []) if isinstance(r, dict)]
        if not rows:
            raise AppError(422, "VALIDATION_FAILED", "No rows to create.")
        if len(rows) > 50:
            raise AppError(422, "TOO_MANY_ROWS", "At most 50 rows per request; send the rest in further chunks.")
        dry_run = bool(body.get("dry_run"))
        results: list[dict[str, Any]] = []
        for raw in rows:
            spec = dict(raw)
            stable_ref = str(spec.get("stable") or "")
            if "." in stable_ref:
                spec["database"], spec["stable"] = stable_ref.split(".", 1)
            name = str(spec.get("name") or spec.get("physical_name") or "")
            entry: dict[str, Any] = {"name": name, "database": spec.get("database"), "stable": spec.get("stable")}
            try:
                spec["database"] = await _require_db(session, tenant_id, spec.get("database"), "Database")
                if await revision_service.object_exists("subtable", spec["database"], name):
                    entry.update(status="EXISTS", message=f"'{name}' already exists; open it to verify, nothing was created.")
                    results.append(entry)
                    continue
                if dry_run:
                    v = await revision_service.validate_draft(session, tenant_id, None, custom_spec={"kind": "subtable", "spec": spec})
                    entry.update(status="VALID" if v["valid"] else "INVALID", errors=v["errors"])
                    if v["valid"]:
                        plan = await revision_service.plan_draft(session, tenant_id, None, custom_spec={"kind": "subtable", "spec": spec})
                        entry["ddl"] = plan["ddl"]
                    results.append(entry)
                    continue
                spec_hash = SR._compute_spec_hash(spec)
                res = await _create_object(
                    session, tenant_id, actor_id, "subtable", spec, f"bulk:{spec['database']}.{name}:{spec_hash}"
                )
                entry.update(status="CREATED", operation_id=res["operation_id"], replay=res["idempotent_replay"])
            except AppError as exc:
                entry.update(status="INVALID" if exc.status == 422 else "FAILED", code=exc.code, message=exc.message,
                             errors=exc.field_errors)
            except StorageObjectError as exc:
                entry.update(status="FAILED", code=exc.code, message=str(exc))
            results.append(entry)
        summary: dict[str, int] = {}
        for r in results:
            summary[r["status"]] = summary.get(r["status"], 0) + 1
        return {"items": results, "summary": summary, "dry_run": dry_run}

    @router.get("/api/v1/storage/td/summary", tags=["storage"])
    async def storage_summary(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Per database / supertable counts: physical subtables, registered by recording status,
        bound subtables and writer health — for overview screens (no subtable listing)."""
        tenant_id, _actor = ids(principal)
        return {**(await topology_inspector.summarize(tenant_id, session)),
                "recording": await SMR.recording_status(session, tenant_id), "observed_at": iso_ms(utcnow())}

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

    @router.post("/api/v1/storage/td/objects/{object_id:path}/alter", tags=["storage"])
    async def alter_td_stable(
        object_id: str,
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Additive schema change of a USER supertable: ``add_columns`` / ``add_tags``; ``dry_run``
        returns the ALTER statements without executing them."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if not db_name or not name:
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")
        await _require_db(session, tenant_id, db_name, f"Storage object '{object_id}'")
        kind = await _resolve_kind(db_name, name, obj_kind)
        if kind != "stable":
            raise AppError(422, "NOT_A_SUPERTABLE", "Columns and tags are added to a supertable; its subtables inherit them.")
        _assert_user_object("stable", db_name, name, tenant_id, "alter")
        try:
            return await revision_service.alter_stable(
                session, tenant_id, actor_id, db_name, name, body, dry_run=bool(body.get("dry_run")))
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc

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

    @router.get("/api/v1/storage/recording/status", tags=["storage"])
    async def recording_status(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Managed writer health: outbox pending/failed, last write, errors (guide H12.3)."""
        tenant_id, _actor = ids(principal)
        return await SMR.recording_status(session, tenant_id)

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
        if not parsed_name:
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")
        kind = await _resolve_kind(target_db, parsed_name, obj_kind)
        if kind == "stable":
            st = await topology_inspector.get_stable(target_db, parsed_name)
            if st and st.columns:
                r = await _registry(session, tenant_id, "stable", target_db, parsed_name) or {}
                return {
                    "id": f"{st.database}.{st.name}",
                    "object_type": "stable",
                    "database_name": st.database,
                    "physical_name": st.name,
                    "display_name": r.get("display_name") or st.name,
                    "description": r.get("description") or "",
                    "columns": [{"name": c.name, "td_type": c.td_type, "length": c.length,
                                 "role": "timestamp" if c.role == "time_key" else c.role,
                                 "primary_key": c.primary_key} for c in st.columns],
                    "tags": [{"name": t.name, "td_type": t.td_type, "length": t.length} for t in st.tags],
                    "subtable_count": st.subtable_count,
                    "status": str(r.get("status") or "ACTIVE"),
                    "managed": bool(r),
                    "is_system": is_system_stable(st.name),
                    "recording": _json_field(r.get("recording_json"), {}),
                    "revision": int(r.get("revision") or 1),
                    "tenant_id": str(tenant_id),
                    "observed_at": now_iso,
                }

        sub = await topology_inspector.get_subtable(target_db, parsed_name)
        if sub:
            r = await _registry(session, tenant_id, "subtable", target_db, parsed_name) or {}
            bindings = await _bindings_of(session, tenant_id, target_db, parsed_name)
            st_value = str(r.get("status") or "ACTIVE")
            return {
                "id": f"{sub.database}.{sub.name}",
                "object_type": "subtable",
                "stable_name": sub.stable_name,
                "parent_name": sub.stable_name,
                "database_name": sub.database,
                "physical_name": sub.name,
                "display_name": r.get("display_name") or sub.name,
                "description": r.get("description") or "",
                "tag_values": [{"name": k, "value": None if v is None else str(v)} for k, v in sub.tags.items()],
                "bindings": bindings,
                "status": st_value,
                "managed": bool(r),
                "is_system": is_system_subtable(sub.name),
                "write_active": bool(r) and st_value == "ACTIVE" and bool(bindings),
                "recording": _json_field(r.get("recording_json"), {}),
                "revision": int(r.get("revision") or 1),
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
        """Update storage object metadata (display name / description) with a revision check.

        Physical schema changes of an existing object are not executed through this route: a
        replayed ``CREATE`` cannot alter an object (R1-16). System objects are read-only.
        """
        tenant_id, actor_id = ids(principal)
        now_iso = iso_ms(utcnow())
        if object_id.startswith("drafts/"):
            try:
                return await revision_service.patch_draft(
                    session, tenant_id, parse_uuid(object_id.split("/", 1)[1]), actor_id, body
                )
            except StorageObjectError as exc:
                raise _storage_error(exc) from exc

        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if obj_kind == "database":
            db_name, name = db_name, db_name
        if not db_name:
            db_name = f"fx_t_{tenant_id.hex}"
        if obj_kind == "table" and name:
            obj_kind = await _resolve_kind(db_name, name, obj_kind)
        _assert_user_object(obj_kind, db_name, name, tenant_id, "alter")

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

        raise AppError(
            422,
            "SCHEMA_CHANGE_NOT_SUPPORTED",
            "This route changes display name and description only. Add columns or tags with "
            "POST /api/v1/storage/td/objects/<id>/alter; other schema or binding changes need a corrected "
            "copy (Duplicate) and retiring the old object.",
        )

    async def _lifecycle(
        session: AsyncSession, principal: dict[str, Any], object_id: str, action: str, new_status: str,
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if obj_kind == "database":
            name = db_name
        if not db_name:
            db_name = f"fx_t_{tenant_id.hex}"
        await _require_db(session, tenant_id, db_name, f"Storage object '{object_id}'")
        if obj_kind == "table" and name:
            obj_kind = await _resolve_kind(db_name, name, obj_kind)
        _assert_user_object(obj_kind, db_name, name, tenant_id, action)
        now = utcnow()
        if obj_kind == "database":
            where = "physical_db = :db"
        elif obj_kind == "stable":
            where = "physical_db = :db AND (physical_name = :name OR (object_type = 'subtable' AND parent_name = :name))"
        else:
            where = "physical_db = :db AND physical_name = :name AND object_type = 'subtable'"
        guard = "" if action == "retire" else " AND status <> 'RETIRED'"
        await execute(
            session,
            f"UPDATE storage_objects SET status = :st, updated_at = :now, revision = revision + 1 "
            f"WHERE tenant_id = :tenant_id AND status <> 'PURGED'{guard} AND {where}",
            {"st": new_status, "now": now, "tenant_id": tenant_id, "db": db_name, "name": name},
        )
        if action == "retire":
            await execute(
                session,
                "UPDATE storage_bindings SET status = 'RETIRED', updated_at = :now WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND (CAST(:name AS text) IS NULL OR physical_subtable = :name "
                "OR physical_subtable IN (SELECT physical_name FROM storage_objects WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND parent_name = :name))",
                {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name if obj_kind != "database" else None},
            )
        op_id = uuid4()
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, actor_id, status, requested_at, started_at,
                completed_at, step_state_json, object_key
            ) VALUES (
                :id, :tenant_id, :op_type, :target_type, :actor_id, 'APPLIED', :now, :now, :now, :state, :object_key
            )
            """,
            {"id": op_id, "tenant_id": tenant_id, "op_type": action.upper(), "target_type": obj_kind,
             "actor_id": actor_id, "now": now, "state": json.dumps({"action": action, "object_id": object_id}),
             "object_key": f"{db_name}.{name}" if name and obj_kind != "database" else db_name},
        )
        SMR.invalidate_bindings(tenant_id)
        return {
            "id": object_id,
            "operation_id": str(op_id),
            "status": new_status,
            "write_active": new_status == "ACTIVE",
            "updated_at": iso_ms(now),
        }

    @router.post("/api/v1/storage/td/objects/{object_id:path}/pause", tags=["storage"])
    async def pause_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Stop recording into a user object (data and configuration are kept)."""
        return await _lifecycle(session, principal, object_id, "pause", "PAUSED")

    @router.post("/api/v1/storage/td/objects/{object_id:path}/resume", tags=["storage"])
    async def resume_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Start / resume recording into a user object."""
        return await _lifecycle(session, principal, object_id, "resume", "ACTIVE")

    @router.post("/api/v1/storage/td/objects/{object_id:path}/retire", tags=["storage"])
    async def retire_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Retire: no new writes, bindings retired, historical rows preserved."""
        return await _lifecycle(session, principal, object_id, "retire", "RETIRED")

    @router.delete("/api/v1/storage/td/objects/{object_id:path}", tags=["storage"])
    async def delete_td_object(
        object_id: str,
        confirm_name: str | None = Query(None),
        force: bool = Query(False),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Purge (DROP) a user-created object after typed confirmation. System objects: 403."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if obj_kind == "database":
            name = db_name
        if not db_name:
            db_name = f"fx_t_{tenant_id.hex}"
        await _require_db(session, tenant_id, db_name, f"Storage object '{object_id}'")
        if obj_kind == "table" and name:
            obj_kind = await _resolve_kind(db_name, name, obj_kind)
        _assert_user_object(obj_kind, db_name, name, tenant_id, "drop")
        if confirm_name != name:
            raise AppError(
                400,
                "CONFIRMATION_REQUIRED",
                f"Type the exact name '{name}' to confirm the permanent deletion.",
            )
        if obj_kind == "stable":
            children = await fetch_all(
                session,
                "SELECT physical_name FROM storage_objects WHERE tenant_id = :tenant_id AND physical_db = :db "
                "AND parent_name = :name AND object_type = 'subtable' AND status NOT IN ('PURGED', 'RETIRED') LIMIT 5",
                {"tenant_id": tenant_id, "db": db_name, "name": name},
            )
            if children and not force:
                raise AppError(409, "DEPENDENCY_EXISTS",
                               f"Supertable '{name}' still has active subtables ({', '.join(c['physical_name'] for c in children)}). Retire them first.")
        dep_views = await fetch_all(
            session,
            "SELECT id, name FROM saved_queries WHERE tenant_id = :tenant_id AND query_spec_json::text LIKE :pat LIMIT 5",
            {"tenant_id": tenant_id, "pat": f"%{name}%"},
        )
        if dep_views and not force:
            raise AppError(409, "DEPENDENCY_EXISTS",
                           f"Saved Historian views use '{name}': {', '.join(v['name'] for v in dep_views)}.")
        try:
            if obj_kind == "database":
                await revision_service._td_exec(f"DROP DATABASE IF EXISTS `{name}`")
            elif obj_kind == "stable":
                await revision_service._td_exec(f"DROP STABLE IF EXISTS `{db_name}`.`{name}`")
            else:
                await revision_service._td_exec(f"DROP TABLE IF EXISTS `{db_name}`.`{name}`")
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc
        except Exception as exc:  # noqa: BLE001
            if not _is_missing_td_error(exc):
                raise AppError(503, "TDENGINE_DROP_FAILED", f"TDengine could not drop the object: {exc}", retryable=True) from exc
        now = utcnow()
        params = {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name}
        if obj_kind == "database":
            await execute(session, "UPDATE storage_objects SET status = 'PURGED', updated_at = :now WHERE tenant_id = :tenant_id AND physical_db = :db", params)
            await execute(session, "UPDATE storage_bindings SET status = 'RETIRED', updated_at = :now WHERE tenant_id = :tenant_id AND physical_db = :db", params)
        else:
            await execute(
                session,
                "UPDATE storage_objects SET status = 'PURGED', updated_at = :now WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND (physical_name = :name OR parent_name = :name)",
                params,
            )
            await execute(
                session,
                "UPDATE storage_bindings SET status = 'RETIRED', updated_at = :now WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND physical_subtable = :name",
                params,
            )
        await execute(
            session,
            """
            INSERT INTO storage_operations (id, tenant_id, operation_type, target_type, actor_id, status,
                requested_at, started_at, completed_at, step_state_json, object_key)
            VALUES (:id, :tenant_id, 'PURGE', :kind, :actor_id, 'APPLIED', :now, :now, :now, :state, :key)
            """,
            {"id": uuid4(), "tenant_id": tenant_id, "kind": obj_kind, "actor_id": actor_id, "now": now,
             "state": json.dumps({"action": "purge", "object_id": object_id}),
             "key": name if obj_kind == "database" else f"{db_name}.{name}"},
        )
        SMR.invalidate_bindings(tenant_id)
        return {"id": object_id, "status": "PURGED", "dropped": True, "purged_at": iso_ms(now)}

    @router.get("/api/v1/storage/td/bindings", tags=["storage"])
    async def list_td_bindings(
        target: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Bindings of one subtable (``target=db.subtable``) or of the whole tenant."""
        tenant_id, _actor = ids(principal)
        if target:
            ref = target.split(":", 1)[1] if target.startswith("subtable:") else target
            db, sub = ref.split(".", 1) if "." in ref else (f"fx_t_{tenant_id.hex}", ref)
            await _require_db(session, tenant_id, db, "Subtable")
            items = await _bindings_of(session, tenant_id, db, sub)
            return {"items": items, "total": len(items)}
        rows = await fetch_all(
            session,
            "SELECT physical_db, physical_subtable FROM storage_bindings WHERE tenant_id = :tenant_id "
            "AND status = 'ACTIVE' GROUP BY physical_db, physical_subtable ORDER BY 1, 2 LIMIT 1000",
            {"tenant_id": tenant_id},
        )
        items: list[dict[str, Any]] = []
        for r in rows:
            for b in await _bindings_of(session, tenant_id, r["physical_db"], r["physical_subtable"]):
                items.append({**b, "database": r["physical_db"], "subtable": r["physical_subtable"]})
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
            step_state = r.get("step_state_json") or {}
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
