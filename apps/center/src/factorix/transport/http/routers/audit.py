"""Audit events. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import fetch_all, parse_uuid
from factorix.platform.errors import AppError

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


@router.get("/api/v1/audit-events")
async def audit_events(
    limit: int = 50,
    severity: str | None = None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    cursor: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    limit = min(max(limit, 1), 500)
    clauses = ["tenant_id = :tenant_id"]
    params: dict[str, Any] = {"tenant_id": tenant_id, "limit": limit + 1}
    if severity:
        clauses.append("severity = :severity")
        params["severity"] = severity.upper()
    if entity_type:
        clauses.append("entity_type = :entity_type")
        params["entity_type"] = entity_type
    if entity_id:
        clauses.append("entity_id = :entity_id")
        params["entity_id"] = parse_uuid(entity_id)
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AppError(422, "CURSOR", "Invalid cursor.") from exc
        clauses.append("occurred_at < :cursor_dt")
        params["cursor_dt"] = cursor_dt

    where_sql = " AND ".join(clauses)
    rows = await fetch_all(
        session,
        f"""
        SELECT id, event_type, actor_id, entity_type, entity_id,
               before_json, after_json, correlation_id, occurred_at, severity
        FROM audit_events
        WHERE {where_sql}
        ORDER BY occurred_at DESC
        LIMIT :limit
        """,
        params,
    )
    has_more = len(rows) > limit
    items = rows[:limit]
    next_cursor = None
    if has_more and items:
        last = items[-1]
        next_cursor = last["occurred_at"].isoformat() if hasattr(last["occurred_at"], "isoformat") else str(last["occurred_at"])
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}
