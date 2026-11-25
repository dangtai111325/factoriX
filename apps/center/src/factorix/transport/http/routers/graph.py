"""Resource graph neighbours. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import resources
from factorix.modules.common import parse_uuid

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


@router.get("/api/v1/graph/neighbors")
@router.get("/api/v1/resources/neighbors")
async def graph(
    resource_id: str,
    depth: int = 1,
    relation_types: str = "",
    include_data: bool = False,
    as_of: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    moment = datetime.fromisoformat(as_of.replace("Z", "+00:00")) if as_of else None
    codes = [item for item in relation_types.split(",") if item]
    return await resources.neighbors(
        session,
        tenant_id,
        parse_uuid(resource_id),
        depth=depth,
        relation_codes=codes,
        as_of=moment,
        include_data=include_data,
    )
