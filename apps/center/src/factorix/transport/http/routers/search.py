"""Global search. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import fetch_all
from factorix.modules.protocols import public_protocol

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


@router.get("/api/v1/search")
async def search(q: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    pattern = f"%{q.strip()}%"
    return {
        "resources": await fetch_all(session, "SELECT id, code, name FROM resources WHERE tenant_id = :tenant_id AND (name ILIKE :q OR code ILIKE :q) ORDER BY code LIMIT 8", {"tenant_id": tenant_id, "q": pattern}),
        "connections": [
            {**row, "protocol": public_protocol(str(row["protocol"]))}
            for row in await fetch_all(session, "SELECT id, name, protocol FROM connections WHERE tenant_id = :tenant_id AND name ILIKE :q ORDER BY name LIMIT 8", {"tenant_id": tenant_id, "q": pattern})
        ],
        "signals": await fetch_all(session, "SELECT id, key, display_name FROM signal_definitions WHERE tenant_id = :tenant_id AND (key ILIKE :q OR display_name ILIKE :q) ORDER BY key LIMIT 8", {"tenant_id": tenant_id, "q": pattern}),
    }
