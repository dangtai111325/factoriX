"""Signals: list, bulk create/properties/address/action, usage, latest. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect, telemetry
from factorix.modules import usage
from factorix.modules.collect import SignalBulkActionIn, SignalBulkIn, SignalPatch
from factorix.modules.common import fetch_one, parse_uuid
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


@router.get("/api/v1/signals")
async def signals(resource_id: str | None = None, q: str | None = None, limit: int = 200, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await collect.list_signals(session, tenant_id, resource_id=resource_id, query=q, limit=limit)}


@router.post("/api/v1/signals/bulk", status_code=201)
async def signal_bulk(body: SignalBulkIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.bulk_signals(session, tenant_id, actor, body, correlation_id(request))


@router.patch("/api/v1/signals/{signal_id}")
async def patch_signal(signal_id: str, body: SignalPatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.patch_signal(session, tenant_id, actor, parse_uuid(signal_id), body, correlation_id(request))


@router.delete("/api/v1/signals/{signal_id}")
async def delete_signal(signal_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.delete_signal(session, tenant_id, actor, parse_uuid(signal_id), correlation_id(request))


@router.get("/api/v1/signals/{signal_id}/usage")
async def signal_usage(signal_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    """Data models that read the signal; asked before disable, delete or pause (R3-DM-02)."""
    tenant_id, _actor = _ids(principal)
    signal = parse_uuid(signal_id)
    if await fetch_one(session, "SELECT id FROM signal_definitions WHERE id = :id AND tenant_id = :tenant_id", {"id": signal, "tenant_id": tenant_id}) is None:
        raise AppError(404, "NOT_FOUND", "Signal not found.")
    return {"signal_id": str(signal), "models": await usage.models_using_signal(session, tenant_id, signal)}


class SignalUsageIn(BaseModel):
    signal_ids: list[str]


@router.post("/api/v1/signals/usage")
async def signals_usage(body: SignalUsageIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    """Data models that read any of the signals, in one query (R4-SG-01: the bulk Disable / Delete
    dialog asked once per selected signal and waited behind the page's other requests)."""
    tenant_id, _actor = _ids(principal)
    if len(body.signal_ids) > 5000:
        raise AppError(422, "LIMIT", "At most 5000 signals per usage lookup.")
    ids = list(dict.fromkeys(parse_uuid(item) for item in body.signal_ids))
    return {"signal_ids": [str(item) for item in ids], "models": await usage.models_using_signals(session, tenant_id, ids) if ids else []}


@router.post("/api/v1/signals/bulk-properties")
async def signal_bulk_properties(body: collect.SignalBulkPropertiesIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    """Set unit, expected interval and/or round digits on many signals, all or nothing (R4-SG-02)."""
    tenant_id, actor = _ids(principal)
    return await collect.bulk_properties_signals(session, tenant_id, actor, body, correlation_id(request))


@router.post("/api/v1/signals/bulk-address")
async def signal_bulk_address(body: collect.SignalBulkAddressIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.bulk_address_signals(session, tenant_id, actor, body, correlation_id(request))


@router.post("/api/v1/signals/bulk-action")
async def signal_bulk_action(body: SignalBulkActionIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.bulk_action_signals(session, tenant_id, actor, body, correlation_id(request))


@router.get("/api/v1/signals/{signal_id}/latest")
async def signal_latest(signal_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    rows = await telemetry.latest_states(session, tenant_id, [parse_uuid(signal_id)])
    if not rows:
        return {"signal_id": signal_id, "value": None, "quality": None, "freshness": "UNKNOWN"}
    return rows[0]
