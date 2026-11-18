"""PG retention policies. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import telemetry
from factorix.modules.common import parse_uuid
from factorix.modules.telemetry import RetentionIn
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


@router.post("/api/v1/retention-policies", status_code=201)
async def create_retention(body: RetentionIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.create_retention(session, tenant_id, actor, body, correlation_id(request))


@router.post("/api/v1/retention-policies/{policy_id}/preview")
async def retention_preview(policy_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await telemetry.preview_retention(session, tenant_id, parse_uuid(policy_id))


@router.post("/api/v1/retention-policies/{policy_id}/enable")
async def retention_enable(policy_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.enable_retention(session, tenant_id, actor, parse_uuid(policy_id), correlation_id(request))


@router.post("/api/v1/retention-policies/{policy_id}/execute")
async def retention_execute(policy_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.execute_retention(session, tenant_id, actor, parse_uuid(policy_id), correlation_id(request))
