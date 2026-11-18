"""Mappings and formulas. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect
from factorix.modules.collect import FormulaIn, MappingPreviewIn, PreviewIn
from factorix.modules.common import fetch_all, parse_uuid
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


@router.post("/api/v1/mappings/validate")
async def mapping_validate(body: MappingPreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    result = collect.validate_mapping(body)
    return {"valid": True, **result}


@router.post("/api/v1/mappings/preview")
async def mapping_preview(body: MappingPreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return collect.validate_mapping(body)


@router.post("/api/v1/formulas", status_code=201)
async def create_formula(body: FormulaIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.save_formula(session, tenant_id, actor, body, correlation_id(request))


@router.post("/api/v1/formulas/validate")
async def validate_formula(body: PreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return collect.preview_formula(body)


@router.post("/api/v1/formulas/evaluate-preview")
async def evaluate_formula(body: PreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return collect.preview_formula(body)


@router.post("/api/v1/formulas/{formula_id}/publish")
async def publish_formula(formula_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.publish_formula(session, tenant_id, actor, parse_uuid(formula_id), correlation_id(request))


@router.get("/api/v1/formulas")
async def formulas(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(
        session,
        """
        SELECT f.id, f.signal_id, f.expression_source, f.unit, f.revision, f.status, s.key, s.display_name, s.resource_id
        FROM formula_definitions f
        JOIN signal_definitions s ON s.id = f.signal_id
        WHERE s.tenant_id = :tenant_id AND f.status <> 'ARCHIVED'
        ORDER BY s.key
        """,
        {"tenant_id": tenant_id},
    )
    return {"items": items}
