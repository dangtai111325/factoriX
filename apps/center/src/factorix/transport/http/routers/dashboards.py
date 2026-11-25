"""Dashboards. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import telemetry
from factorix.modules.common import fetch_all, parse_uuid
from factorix.modules.telemetry import DashboardIn, DashboardPatch
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


@router.get("/api/v1/dashboards")
async def dashboards(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await fetch_all(session, "SELECT id, name, description, draft_revision, published_revision, archived_at, version, updated_at FROM dashboards WHERE tenant_id = :tenant_id AND archived_at IS NULL ORDER BY name", {"tenant_id": tenant_id})}


@router.post("/api/v1/dashboards", status_code=201)
async def create_dashboard(body: DashboardIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.create_dashboard(session, tenant_id, actor, body, correlation_id(request))


@router.get("/api/v1/dashboards/{dashboard_id}")
async def dashboard_detail(dashboard_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await telemetry._dashboard(session, tenant_id, parse_uuid(dashboard_id))


@router.patch("/api/v1/dashboards/{dashboard_id}")
async def patch_dashboard(dashboard_id: str, body: DashboardPatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.patch_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request))


@router.post("/api/v1/dashboards/{dashboard_id}/publish")
async def publish_dashboard(dashboard_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.publish_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), correlation_id(request))
