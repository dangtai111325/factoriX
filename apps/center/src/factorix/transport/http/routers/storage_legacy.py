"""Storage overview, ingestion health and CSV export (pre-Storage-Designer routes). Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import telemetry
from factorix.modules.common import parse_uuid

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, _time, admin, db_session

router = RouteTable()


@router.get("/api/v1/storage/overview")
async def storage_overview(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await telemetry.storage_overview(session, tenant_id)


@router.get("/api/v1/storage/ingestion-health")
async def ingestion_health(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    overview = await telemetry.storage_overview(session, tenant_id)
    return {"ingest_per_minute": overview["ingest_per_minute"], "quarantine": overview["quarantine"], "dedup_keys": overview["dedup_keys"], "newest": overview["newest"]}


@router.post("/api/v1/storage/exports", status_code=202)
async def export_csv(signal_id: str, start: str, end: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.export_csv(session, tenant_id, actor, parse_uuid(signal_id), _time(start), _time(end))
