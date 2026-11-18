"""Sites, resource types, resources, relations and hierarchy views. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import resources
from factorix.modules.common import as_uuid, fetch_one, parse_uuid
from factorix.modules.resources import (
    HierarchyIn,
    ImportIn,
    MoveIn,
    RelationIn,
    ResourceIn,
    ResourcePatch,
    SiteIn,
    TopicImportIn,
    TypeIn,
)
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, admin, db_session

router = RouteTable()


class _Sites:
    pass


@router.get("/api/v1/sites")
async def sites(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await resources.list_sites(session, tenant_id)}


@router.post("/api/v1/sites", status_code=201)
async def create_site(body: SiteIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_site(session, tenant_id, actor, body, correlation_id(request))


@router.get("/api/v1/sites/{site_id}")
async def site_detail(site_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.get_site(session, tenant_id, parse_uuid(site_id))


@router.get("/api/v1/resource-types")
async def resource_types(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await resources.list_types(session, tenant_id)}


@router.post("/api/v1/resource-types", status_code=201)
async def create_type(body: TypeIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_type(session, tenant_id, actor, body, correlation_id(request))


@router.get("/api/v1/resources")
async def list_resources(
    parent_id: str | None = None,
    type_key: str | None = None,
    q: str | None = None,
    include_archived: bool = False,
    limit: int = 100,
    cursor: str | None = None,
    view: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.list_resources(session, tenant_id, parent_id=parent_id, type_key=type_key, query=q, include_archived=include_archived, limit=limit, cursor=cursor, view=view)


@router.post("/api/v1/resources", status_code=201)
async def create_resource(body: ResourceIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_resource(session, tenant_id, actor, body, correlation_id(request))


@router.get("/api/v1/resources/{resource_id}")
async def resource_detail(resource_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.get_resource(session, tenant_id, parse_uuid(resource_id))


@router.patch("/api/v1/resources/{resource_id}")
async def patch_resource(resource_id: str, body: ResourcePatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.patch_resource(session, tenant_id, actor, parse_uuid(resource_id), body, correlation_id(request))


@router.get("/api/v1/resources/{resource_id}/archive-impact")
async def resource_archive_impact(resource_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.archive_impact(session, tenant_id, parse_uuid(resource_id))


@router.post("/api/v1/resources/{resource_id}/archive")
async def archive_resource(resource_id: str, request: Request, body: resources.ArchiveIn | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.archive_resource(
        session, tenant_id, actor, parse_uuid(resource_id), correlation_id(request), archive_models=bool(body and body.archive_models)
    )


@router.post("/api/v1/resources/{resource_id}/restore")
async def restore_resource(resource_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.restore_resource(session, tenant_id, actor, parse_uuid(resource_id), correlation_id(request))


@router.post("/api/v1/resources/{resource_id}/move")
async def move_resource(resource_id: str, body: MoveIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.move_resource(session, tenant_id, actor, parse_uuid(resource_id), body, correlation_id(request))


@router.post("/api/v1/resources/import")
async def import_resources(body: ImportIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.import_resources(session, tenant_id, actor, body, correlation_id(request))


@router.post("/api/v1/resources/import/from-topics")
async def import_resources_from_topics(body: TopicImportIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.import_from_topics(session, tenant_id, actor, body, correlation_id(request))


@router.post("/api/v1/resource-relations", status_code=201)
async def create_relation(body: RelationIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    from factorix.modules.resources import _aware, _link, _resource

    source = await _resource(session, tenant_id, parse_uuid(body.from_id))
    target = await _resource(session, tenant_id, parse_uuid(body.to_id))
    if body.relation_code == "CONTAINS":
        await resources._assert_contains(session, tenant_id, source["type_key"], target["type_key"], source, "CONTAINS")
    await _link(session, tenant_id, as_uuid(source["id"]), as_uuid(target["id"]), body.relation_code, _aware(body.valid_from))
    return {"status": "created", "from_id": source["id"], "to_id": target["id"], "relation_code": body.relation_code}


@router.get("/api/v1/hierarchy-presets")
async def presets(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return resources.hierarchy_presets()


@router.post("/api/v1/hierarchy-views", status_code=201)
async def create_hierarchy(body: HierarchyIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_hierarchy(session, tenant_id, actor, body, correlation_id(request))


@router.post("/api/v1/hierarchy-views/{view_id}/validate")
async def validate_hierarchy(view_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    row = await fetch_one(session, "SELECT level_rules_json FROM hierarchy_views WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(view_id), "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Hierarchy template not found.")
    errors = resources.validate_levels(row["level_rules_json"] or [])
    return {"valid": not errors, "errors": errors}
