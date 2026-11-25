"""Dashboard Studio HTTP API (contract ``docs/architecture/contracts/dashboard.md`` §5).

Same auth as every navigation (``Depends(admin)``; CSRF on mutations); the tenant and actor always come from
the principal. Static paths (``/widget-types``, ``/themes``, ``/templates``, ``/sources``, ``/resolve``,
``/import``) are registered before ``/{dashboard_id}``.
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.application.dashboards import registry as dashboard_registry
from factorix.application.dashboards import service as dashboard_service
from factorix.application.dashboards.requests import (
    DashboardIn,
    DashboardPatch,
    DuplicateIn,
    ImportIn,
    PublishIn,
    ResolveIn,
    RestoreIn,
    TemplateIn,
    ValidateIn,
    VersionIn,
)
from factorix.modules.common import parse_uuid
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()

_BASE = "/api/v1/dashboards"


# ---- collection + static paths (before /{dashboard_id})


@router.get(_BASE)
async def dashboards(include_archived: bool = False, q: str | None = Query(None, max_length=160),
                     principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.list_dashboards(session, tenant_id, include_archived=include_archived, q=q)


@router.post(_BASE, status_code=201)
async def create_dashboard(body: DashboardIn, request: Request, principal: dict[str, Any] = Depends(admin),
                           session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.create_dashboard(session, tenant_id, actor, body, correlation_id(request))


@router.get(f"{_BASE}/widget-types")
async def dashboard_widget_types(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return dashboard_registry.widget_types_payload()


@router.get(f"{_BASE}/themes")
async def dashboard_themes(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return dashboard_registry.themes_payload()


@router.get(f"{_BASE}/templates")
async def dashboard_templates(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.list_templates(session, tenant_id)


@router.post(f"{_BASE}/templates", status_code=201)
async def create_dashboard_template(body: TemplateIn, request: Request, principal: dict[str, Any] = Depends(admin),
                                    session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.create_template(session, tenant_id, actor, body, correlation_id(request))


@router.delete(f"{_BASE}/templates/{{template_id}}", status_code=204)
async def delete_dashboard_template(template_id: str, request: Request, principal: dict[str, Any] = Depends(admin),
                                    session: AsyncSession = Depends(db_session)) -> Response:
    tenant_id, actor = _ids(principal)
    await dashboard_service.delete_template(session, tenant_id, actor, template_id, correlation_id(request))
    return Response(status_code=204)


@router.get(f"{_BASE}/sources")
async def dashboard_sources(q: str | None = Query(None, max_length=160), principal: dict[str, Any] = Depends(admin),
                            session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.list_sources(session, tenant_id, q=q)


@router.post(f"{_BASE}/resolve")
async def dashboard_resolve(body: ResolveIn, principal: dict[str, Any] = Depends(admin),
                            session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.resolve(session, tenant_id, body)


@router.post(f"{_BASE}/import", status_code=201)
async def import_dashboard(body: ImportIn, request: Request, principal: dict[str, Any] = Depends(admin),
                           session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.import_dashboard(session, tenant_id, actor, body, correlation_id(request))


# ---- one dashboard


@router.get(f"{_BASE}/{{dashboard_id}}")
async def dashboard_detail(dashboard_id: str, principal: dict[str, Any] = Depends(admin),
                           session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.get_dashboard(session, tenant_id, parse_uuid(dashboard_id))


@router.patch(f"{_BASE}/{{dashboard_id}}")
async def patch_dashboard(dashboard_id: str, body: DashboardPatch, request: Request, principal: dict[str, Any] = Depends(admin),
                          session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.patch_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request))


@router.post(f"{_BASE}/{{dashboard_id}}/validate")
async def validate_dashboard(dashboard_id: str, body: ValidateIn | None = None, principal: dict[str, Any] = Depends(admin),
                             session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.validate(session, tenant_id, parse_uuid(dashboard_id), body or ValidateIn())


@router.post(f"{_BASE}/{{dashboard_id}}/publish")
async def publish_dashboard(dashboard_id: str, body: PublishIn, request: Request, principal: dict[str, Any] = Depends(admin),
                            session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.publish_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request))


@router.get(f"{_BASE}/{{dashboard_id}}/published")
async def published_dashboard(dashboard_id: str, principal: dict[str, Any] = Depends(admin),
                              session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.get_published(session, tenant_id, parse_uuid(dashboard_id))


@router.get(f"{_BASE}/{{dashboard_id}}/revisions")
async def dashboard_revisions(dashboard_id: str, principal: dict[str, Any] = Depends(admin),
                              session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.list_revisions(session, tenant_id, parse_uuid(dashboard_id))


@router.get(f"{_BASE}/{{dashboard_id}}/revisions/{{revision}}")
async def dashboard_revision(dashboard_id: str, revision: int, principal: dict[str, Any] = Depends(admin),
                             session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.get_revision(session, tenant_id, parse_uuid(dashboard_id), revision)


@router.post(f"{_BASE}/{{dashboard_id}}/restore")
async def restore_dashboard(dashboard_id: str, body: RestoreIn, request: Request, principal: dict[str, Any] = Depends(admin),
                            session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.restore_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request))


@router.post(f"{_BASE}/{{dashboard_id}}/duplicate", status_code=201)
async def duplicate_dashboard(dashboard_id: str, body: DuplicateIn, request: Request, principal: dict[str, Any] = Depends(admin),
                              session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.duplicate_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request))


@router.post(f"{_BASE}/{{dashboard_id}}/archive")
async def archive_dashboard(dashboard_id: str, body: VersionIn, request: Request, principal: dict[str, Any] = Depends(admin),
                            session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.set_archived(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request),
                                                archived=True)


@router.post(f"{_BASE}/{{dashboard_id}}/unarchive")
async def unarchive_dashboard(dashboard_id: str, body: VersionIn, request: Request, principal: dict[str, Any] = Depends(admin),
                              session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await dashboard_service.set_archived(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request),
                                                archived=False)


@router.get(f"{_BASE}/{{dashboard_id}}/export")
async def export_dashboard(dashboard_id: str, principal: dict[str, Any] = Depends(admin),
                           session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await dashboard_service.export_dashboard(session, tenant_id, parse_uuid(dashboard_id))
