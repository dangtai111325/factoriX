"""HTTP routes of Data Model v2 (``/api/v1/data-models``). See ``factorix.modules.data_models``.

Built by :func:`build_router` with the application's auth and session dependencies, so this module
does not import ``factorix.transport.app`` (no import cycle). Static paths are declared before
``/{model_id}`` so they are never captured by it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import data_models as DM
from factorix.modules.common import as_uuid, parse_uuid
from factorix.platform.http import correlation_id


def build_router(admin: Callable[..., Any], db_session: Callable[..., Any]) -> APIRouter:
    router = APIRouter(prefix="/api/v1/data-models", tags=["data-models"])

    def ids(principal: dict[str, Any]) -> tuple[Any, Any]:
        return as_uuid(principal["tenant_id"]), as_uuid(principal["admin_id"])

    @router.get("")
    async def list_models(
        q: str | None = None,
        state: str | None = None,
        machine: str | None = None,
        principal: dict[str, Any] = Depends(admin),
        session: AsyncSession = Depends(db_session),
    ) -> list[dict[str, Any]]:
        tenant_id, _actor = ids(principal)
        return await DM.list_models(session, tenant_id, q=q, state=state, machine=machine)

    @router.post("", status_code=201)
    async def create_model(body: DM.DataModelIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await DM.create_model(session, tenant_id, actor, body, correlation_id(request))

    @router.post("/validate")
    async def validate(body: DM.SpecIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await DM.validate(session, tenant_id, body)

    @router.post("/preview")
    async def preview(body: DM.SpecIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await DM.preview(session, tenant_id, body)

    @router.get("/catalog")
    async def catalog(
        resource_id: str | None = None,
        q: str | None = None,
        principal: dict[str, Any] = Depends(admin),
        session: AsyncSession = Depends(db_session),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await DM.catalog_tree(session, tenant_id, resource_id=resource_id, q=q)

    @router.get("/rules/functions")
    async def rule_functions(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
        del principal
        return DM.functions()

    @router.get("/usage")
    async def usage(resource_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return {"resource_id": resource_id, "models": await DM.models_using_resource(session, tenant_id, parse_uuid(resource_id))}

    @router.get("/{model_id}")
    async def detail(model_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await DM.get_model(session, tenant_id, parse_uuid(model_id))

    @router.patch("/{model_id}")
    async def patch(model_id: str, body: DM.DataModelPatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await DM.patch_model(session, tenant_id, actor, parse_uuid(model_id), body, correlation_id(request))

    @router.delete("/{model_id}")
    async def delete(model_id: str, request: Request, version: int | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await DM.delete_model(session, tenant_id, actor, parse_uuid(model_id), correlation_id(request), version=version)

    @router.post("/{model_id}/pause")
    async def pause(model_id: str, request: Request, body: DM.StateChangeIn | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await DM.set_state(session, tenant_id, actor, parse_uuid(model_id), "PAUSED", body, correlation_id(request))

    @router.post("/{model_id}/resume")
    async def resume(model_id: str, request: Request, body: DM.StateChangeIn | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, actor = ids(principal)
        return await DM.set_state(session, tenant_id, actor, parse_uuid(model_id), "RUNNING", body, correlation_id(request))

    @router.get("/{model_id}/latest")
    async def latest(model_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await DM.latest(session, tenant_id, parse_uuid(model_id))

    @router.get("/{model_id}/snapshots")
    async def snapshots(model_id: str, limit: int = 20, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> list[dict[str, Any]]:
        tenant_id, _actor = ids(principal)
        return await DM.snapshots(session, tenant_id, parse_uuid(model_id), limit=limit)

    @router.post("/{model_id}/duplicate")
    async def duplicate(model_id: str, body: DM.DuplicateIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> Any:
        tenant_id, actor = ids(principal)
        result = await DM.duplicate(session, tenant_id, actor, parse_uuid(model_id), body, correlation_id(request))
        return JSONResponse(result, status_code=200 if body.dry_run else 201)

    return router
