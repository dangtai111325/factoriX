"""Observations: latest, history, aggregate. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import telemetry
from factorix.modules.common import parse_uuid, utcnow

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, _time, admin, db_session

router = RouteTable()


@router.get("/api/v1/observations/latest")
async def latest(signal_ids: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    ids = [parse_uuid(item) for item in signal_ids.split(",") if item]
    return {"items": await telemetry.latest_states(session, tenant_id, ids)}


@router.get("/api/v1/observations/history")
async def history(
    signal_id: str,
    start: str | None = None,
    end: str | None = None,
    from_time: str | None = Query(None, alias="from"),
    limit: int = 500,
    cursor: str | None = None,
    mode: str = "operational",
    dataset_id: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    now = utcnow()
    raw_start = start or from_time
    if raw_start:
        if raw_start.startswith("now-"):
            offset_str = raw_start[4:]
            if offset_str.endswith("m"):
                start_dt = now - timedelta(minutes=int(offset_str[:-1]))
            elif offset_str.endswith("h"):
                start_dt = now - timedelta(hours=int(offset_str[:-1]))
            elif offset_str.endswith("d"):
                start_dt = now - timedelta(days=int(offset_str[:-1]))
            else:
                start_dt = now - timedelta(minutes=15)
        else:
            start_dt = _time(raw_start)
    else:
        start_dt = now - timedelta(minutes=15)

    if end:
        end_dt = _time(end)
    else:
        end_dt = now

    return await telemetry.history(
        session,
        tenant_id,
        signal_id=parse_uuid(signal_id),
        start=start_dt,
        end=end_dt,
        limit=limit,
        cursor=cursor,
        mode=mode,
        dataset_id=parse_uuid(dataset_id) if dataset_id else None,
    )


@router.get("/api/v1/observations/aggregate")
async def aggregate(signal_ids: str, start: str, end: str, bucket_ms: int = 60000, fn: str = "avg", principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    ids = [parse_uuid(item) for item in signal_ids.split(",") if item]
    return await telemetry.aggregate(session, tenant_id, signal_ids=ids, start=_time(start), end=_time(end), bucket_ms=bucket_ms, fn=fn)
