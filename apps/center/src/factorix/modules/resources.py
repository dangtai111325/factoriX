"""Factory resources, relations, layouts and contextual graph."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.catalog import HIERARCHY_PRESETS
from factorix.domain.resources import ResourceInvariantError, assert_no_cycle, validate_code
from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
from factorix.platform.errors import AppError

MAX_PAGE = 200


class ResourceIn(BaseModel):
    type_key: str
    code: str
    name: str = Field(min_length=1, max_length=200)
    site_id: str | None = None
    parent_id: str | None = None
    relation_code: str = "CONTAINS"
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    properties: dict[str, Any] = Field(default_factory=dict)
    valid_from: datetime | None = None


class ResourcePatch(BaseModel):
    version: int
    name: str | None = None
    description: str | None = None
    code: str | None = None
    properties: dict[str, Any] | None = None
    tags: list[str] | None = None


class MoveIn(BaseModel):
    version: int
    parent_id: str
    at: datetime | None = None


class TypeIn(BaseModel):
    key: str
    name: str
    category: str = "CUSTOM"
    properties_schema: dict[str, Any] = Field(default_factory=dict)
    parent_type_keys: list[str] = Field(default_factory=list)
    child_type_keys: list[str] = Field(default_factory=list)


class SiteIn(BaseModel):
    code: str
    name: str
    timezone: str = "Asia/Ho_Chi_Minh"


class RelationIn(BaseModel):
    from_id: str
    to_id: str
    relation_code: str
    valid_from: datetime | None = None
    valid_to: datetime | None = None


class LayoutIn(BaseModel):
    name: str
    scope_resource_id: str | None = None


class LayoutDraft(BaseModel):
    version: int
    draft: dict[str, Any]


class HierarchyIn(BaseModel):
    name: str
    relation_filter: str = "CONTAINS"
    level_rules: list[dict[str, Any]] = Field(default_factory=list)
    root_selector: dict[str, Any] = Field(default_factory=dict)


class ImportIn(BaseModel):
    site_id: str | None = None
    dry_run: bool = True
    rows: list[dict[str, str]]


def _aware(value: datetime | None) -> datetime:
    if value is None:
        return utcnow()
    if value.tzinfo is None:
        raise AppError(422, "TIMEZONE", "Thời điểm phải có múi giờ.")
    return value.astimezone(timezone.utc)


async def create_site(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SiteIn, correlation_id: str) -> dict[str, Any]:
    code = validate_code(body.code)
    if not body.timezone or len(body.timezone) > 64:
        raise AppError(422, "TIMEZONE", "Múi giờ không hợp lệ.")
    row_id = uuid4()
    now = utcnow()
    try:
        await execute(
            session,
            """
            INSERT INTO sites (id, tenant_id, code, name, timezone, created_at)
            VALUES (:id, :tenant_id, :code, :name, :timezone, :now)
            """,
            {"id": row_id, "tenant_id": tenant_id, "code": code, "name": body.name.strip(), "timezone": body.timezone, "now": now},
        )
    except Exception as exc:
        raise AppError(409, "DUPLICATE", "Mã site đã tồn tại.") from exc
    created = await fetch_one(session, "SELECT * FROM sites WHERE id = :id", {"id": row_id})
    await audit(session, tenant_id=tenant_id, event_type="SITE_CREATE", actor_id=actor, entity_type="site", entity_id=row_id, before=None, after=created, correlation_id=correlation_id)
    assert created is not None
    return created


async def list_sites(session: AsyncSession, tenant_id: UUID) -> list[dict[str, Any]]:
    return await fetch_all(session, "SELECT * FROM sites WHERE tenant_id = :tenant_id ORDER BY code", {"tenant_id": tenant_id})


async def get_site(session: AsyncSession, tenant_id: UUID, site_id: UUID) -> dict[str, Any]:
    row = await fetch_one(session, "SELECT * FROM sites WHERE id = :id AND tenant_id = :tenant_id", {"id": site_id, "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy site.")
    return row


async def _type_by_key(session: AsyncSession, tenant_id: UUID, key: str) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM resource_types WHERE tenant_id = :tenant_id AND key = :key",
        {"tenant_id": tenant_id, "key": key},
    )
    if row is None:
        raise AppError(422, "UNKNOWN_TYPE", "Loại tài nguyên không tồn tại.")
    return row


async def create_resource(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: ResourceIn,
    correlation_id: str,
) -> dict[str, Any]:
    try:
        code = validate_code(body.code)
    except ResourceInvariantError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    type_row = await _type_by_key(session, tenant_id, body.type_key)
    site_id = parse_uuid(body.site_id) if body.site_id else None
    if site_id is not None:
        await get_site(session, tenant_id, site_id)
    if type_row["key"] != "enterprise" and site_id is None:
        raise AppError(422, "SITE_REQUIRED", "Tài nguyên này cần site.")
    parent = None
    if body.parent_id:
        parent = await _resource(session, tenant_id, parse_uuid(body.parent_id))
        await _assert_contains(session, tenant_id, parent["type_key"] if "type_key" in parent else await _type_key(session, parent), type_row["key"], parent, body.relation_code)
    now = utcnow()
    resource_id = uuid4()
    duplicate = await fetch_one(
        session,
        "SELECT id FROM resources WHERE tenant_id = :tenant_id AND code = :code",
        {"tenant_id": tenant_id, "code": code},
    )
    if duplicate:
        raise AppError(409, "DUPLICATE", "Mã tài nguyên đã tồn tại.", field_errors=[{"path": "code", "code": "DUPLICATE"}])
    await execute(
        session,
        """
        INSERT INTO resources (
            id, tenant_id, site_id, type_id, code, name, description, properties_json, tags_json,
            status, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :site_id, :type_id, :code, :name, :description,
            CAST(:properties AS jsonb), CAST(:tags AS jsonb), 'ACTIVE', 1, :now, :now
        )
        """,
        {
            "id": resource_id,
            "tenant_id": tenant_id,
            "site_id": site_id,
            "type_id": as_uuid(type_row["id"]),
            "code": code,
            "name": body.name.strip(),
            "description": body.description,
            "properties": jsonb(body.properties),
            "tags": jsonb(body.tags[:32]),
            "now": now,
        },
    )
    if parent is not None:
        moment = _aware(body.valid_from)
        if body.relation_code == "INSTALLED_AT":
            if type_row["key"] != "physical_asset":
                raise AppError(422, "DOMAIN", "Chỉ tài sản vật lý mới lắp vào vị trí chức năng.")
            await _link(session, tenant_id, resource_id, as_uuid(parent["id"]), "INSTALLED_AT", moment)
        else:
            await _link(session, tenant_id, as_uuid(parent["id"]), resource_id, body.relation_code, moment)
    created = await get_resource(session, tenant_id, resource_id)
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_CREATE", actor_id=actor, entity_type="resource", entity_id=resource_id, before=None, after={"id": str(resource_id), "code": code}, correlation_id=correlation_id)
    return created


async def _type_key(session: AsyncSession, resource: dict[str, Any]) -> str:
    if resource.get("type_key"):
        return str(resource["type_key"])
    row = await fetch_one(session, "SELECT key FROM resource_types WHERE id = :id", {"id": as_uuid(resource["type_id"])})
    assert row is not None
    return str(row["key"])


async def _assert_contains(
    session: AsyncSession,
    tenant_id: UUID,
    parent_key: str,
    child_key: str,
    parent: dict[str, Any],
    relation_code: str,
) -> None:
    if relation_code == "INSTALLED_AT":
        if parent_key != "functional_position":
            raise AppError(422, "DOMAIN", "INSTALLED_AT gắn tài sản vào vị trí chức năng.")
        return
    if relation_code != "CONTAINS":
        return
    allowed = await fetch_one(
        session,
        """
        SELECT 1 AS ok FROM type_adjacency
        WHERE tenant_id = :tenant_id AND relation_code = 'CONTAINS'
          AND parent_type_key = :parent AND child_type_key = :child
        """,
        {"tenant_id": tenant_id, "parent": parent_key, "child": child_key},
    )
    if allowed is None:
        raise AppError(422, "ADJACENCY", "Không thể đặt loại này bên dưới cha đã chọn.")
    if parent.get("status") == "ARCHIVED" or parent.get("archived_at"):
        raise AppError(409, "ARCHIVED_PARENT", "Không thêm con vào tài nguyên đã lưu trữ.")


async def _link(session: AsyncSession, tenant_id: UUID, parent_id: UUID, child_id: UUID, relation_code: str, valid_from: datetime) -> None:
    relation = await fetch_one(
        session,
        "SELECT id, acyclic FROM relation_types WHERE tenant_id = :tenant_id AND code = :code",
        {"tenant_id": tenant_id, "code": relation_code},
    )
    if relation is None:
        raise AppError(422, "RELATION", "Loại quan hệ không tồn tại.")
    if relation["acyclic"]:
        edges = await fetch_all(
            session,
            """
            SELECT to_id AS child_id, from_id AS parent_id
            FROM resource_relations
            WHERE tenant_id = :tenant_id AND relation_type_id = :relation_type_id AND valid_to IS NULL
            """,
            {"tenant_id": tenant_id, "relation_type_id": as_uuid(relation["id"])},
        )
        pairs = [(as_uuid(item["child_id"]), as_uuid(item["parent_id"])) for item in edges]
        try:
            assert_no_cycle(pairs, child_id, parent_id)
        except ResourceInvariantError as exc:
            raise AppError(422, exc.code, str(exc)) from exc
    await execute(
        session,
        """
        INSERT INTO resource_relations (
            id, tenant_id, from_id, to_id, relation_type_id, valid_from, revision, created_at
        ) VALUES (
            :id, :tenant_id, :from_id, :to_id, :relation_type_id, :valid_from, 1, :now
        )
        """,
        {
            "id": uuid4(),
            "tenant_id": tenant_id,
            "from_id": parent_id,
            "to_id": child_id,
            "relation_type_id": as_uuid(relation["id"]),
            "valid_from": valid_from,
            "now": utcnow(),
        },
    )


async def _resource(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        """
        SELECT r.*, t.key AS type_key, t.name AS type_name, t.category AS type_category
        FROM resources r JOIN resource_types t ON t.id = r.type_id
        WHERE r.id = :id AND r.tenant_id = :tenant_id
        """,
        {"id": resource_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    return row


async def get_resource(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> dict[str, Any]:
    row = await _resource(session, tenant_id, resource_id)
    children = await fetch_one(
        session,
        """
        SELECT count(*) AS count FROM resource_relations rr
        JOIN relation_types rt ON rt.id = rr.relation_type_id
        WHERE rr.tenant_id = :tenant_id AND rr.from_id = :id AND rt.code = 'CONTAINS' AND rr.valid_to IS NULL
        """,
        {"tenant_id": tenant_id, "id": resource_id},
    )
    signals = await fetch_one(
        session,
        "SELECT count(*) AS count FROM signal_definitions WHERE resource_id = :id AND status = 'ACTIVE'",
        {"id": resource_id},
    )
    row["child_count"] = int(children["count"]) if children else 0
    row["signal_count"] = int(signals["count"]) if signals else 0
    row["breadcrumb"] = await breadcrumb(session, tenant_id, resource_id)
    return row


async def breadcrumb(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> list[dict[str, str]]:
    chain: list[dict[str, str]] = []
    current: UUID | None = resource_id
    guard = 0
    while current is not None and guard < 32:
        guard += 1
        row = await fetch_one(
            session,
            "SELECT id, code, name FROM resources WHERE id = :id AND tenant_id = :tenant_id",
            {"id": current, "tenant_id": tenant_id},
        )
        if row is None:
            break
        chain.append({"id": row["id"], "code": row["code"], "name": row["name"]})
        parent = await fetch_one(
            session,
            """
            SELECT rr.from_id FROM resource_relations rr
            JOIN relation_types rt ON rt.id = rr.relation_type_id
            WHERE rr.tenant_id = :tenant_id AND rr.to_id = :id AND rt.code = 'CONTAINS' AND rr.valid_to IS NULL
            """,
            {"tenant_id": tenant_id, "id": current},
        )
        current = as_uuid(parent["from_id"]) if parent else None
    chain.reverse()
    return chain


async def list_resources(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    parent_id: str | None,
    type_key: str | None,
    query: str | None,
    include_archived: bool,
    limit: int,
    cursor: str | None,
    view: str | None = None,
) -> dict[str, Any]:
    limit = min(max(limit, 1), MAX_PAGE)
    params: dict[str, Any] = {"tenant_id": tenant_id, "limit": limit + 1}
    where = ["r.tenant_id = :tenant_id"]
    if not include_archived:
        where.append("r.archived_at IS NULL")
    if type_key:
        where.append("t.key = :type_key")
        params["type_key"] = type_key
    if query:
        where.append("(r.name ILIKE :q OR r.code ILIKE :q)")
        params["q"] = f"%{query.strip()}%"
    if parent_id:
        where.append(
            """
            EXISTS (
                SELECT 1 FROM resource_relations rr
                JOIN relation_types rt ON rt.id = rr.relation_type_id
                WHERE rr.to_id = r.id AND rr.from_id = :parent_id AND rt.code = 'CONTAINS' AND rr.valid_to IS NULL
            )
            """
        )
        params["parent_id"] = parse_uuid(parent_id)
    elif view != "all" and parent_id is None and not query and not type_key:
        where.append(
            """
            NOT EXISTS (
                SELECT 1 FROM resource_relations rr
                JOIN relation_types rt ON rt.id = rr.relation_type_id
                WHERE rr.to_id = r.id AND rt.code = 'CONTAINS' AND rr.valid_to IS NULL
            )
            """
        )
    if cursor:
        params["cursor"] = cursor
        where.append("r.code > :cursor")
    sql = f"""
        SELECT r.id, r.code, r.name, r.status, r.version, r.site_id, r.archived_at, t.key AS type_key, t.category AS type_category,
               (
                 SELECT rr.from_id FROM resource_relations rr
                 JOIN relation_types rt ON rt.id = rr.relation_type_id
                 WHERE rr.to_id = r.id AND rt.code = 'CONTAINS' AND rr.valid_to IS NULL
                 ORDER BY rr.valid_from DESC
                 LIMIT 1
               ) AS parent_id
        FROM resources r JOIN resource_types t ON t.id = r.type_id
        WHERE {' AND '.join(where)}
        ORDER BY r.code
        LIMIT :limit
    """
    items = await fetch_all(session, sql, params)
    next_cursor = None
    if len(items) > limit:
        next_cursor = items[limit - 1]["code"]
        items = items[:limit]
    return {"items": items, "next_cursor": next_cursor}


async def patch_resource(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    resource_id: UUID,
    body: ResourcePatch,
    correlation_id: str,
) -> dict[str, Any]:
    current = await _resource(session, tenant_id, resource_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "Tài nguyên đã được chỉnh sửa ở nơi khác.")
    if current["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Tài nguyên đã lưu trữ chỉ đọc.")
    name = body.name.strip() if body.name is not None else current["name"]
    description = body.description if body.description is not None else current["description"]
    code = current["code"]
    if body.code is not None:
        try:
            code = validate_code(body.code)
        except ResourceInvariantError as exc:
            raise AppError(422, exc.code, str(exc)) from exc
    properties = body.properties if body.properties is not None else current["properties_json"]
    tags = body.tags if body.tags is not None else current["tags_json"]
    await execute(
        session,
        """
        UPDATE resources
        SET name = :name, description = :description, code = :code,
            properties_json = CAST(:properties AS jsonb), tags_json = CAST(:tags AS jsonb),
            version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id AND version = :version
        """,
        {
            "name": name,
            "description": description,
            "code": code,
            "properties": jsonb(properties),
            "tags": jsonb(tags),
            "now": utcnow(),
            "id": resource_id,
            "tenant_id": tenant_id,
            "version": body.version,
        },
    )
    updated = await get_resource(session, tenant_id, resource_id)
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_UPDATE", actor_id=actor, entity_type="resource", entity_id=resource_id, before={"name": current["name"], "code": current["code"]}, after={"name": name, "code": code}, correlation_id=correlation_id)
    return updated


async def move_resource(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, body: MoveIn, correlation_id: str) -> dict[str, Any]:
    current = await _resource(session, tenant_id, resource_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "Tài nguyên đã được chỉnh sửa ở nơi khác.")
    parent = await _resource(session, tenant_id, parse_uuid(body.parent_id))
    await _assert_contains(session, tenant_id, parent["type_key"], current["type_key"], parent, "CONTAINS")
    moment = _aware(body.at)
    relation = await fetch_one(
        session,
        "SELECT id FROM relation_types WHERE tenant_id = :tenant_id AND code = 'CONTAINS'",
        {"tenant_id": tenant_id},
    )
    assert relation is not None
    edges = await fetch_all(
        session,
        """
        SELECT to_id AS child_id, from_id AS parent_id
        FROM resource_relations
        WHERE tenant_id = :tenant_id AND relation_type_id = :relation_type_id AND valid_to IS NULL AND to_id <> :self
        """,
        {"tenant_id": tenant_id, "relation_type_id": as_uuid(relation["id"]), "self": resource_id},
    )
    pairs = [(as_uuid(item["child_id"]), as_uuid(item["parent_id"])) for item in edges]
    try:
        assert_no_cycle(pairs, resource_id, as_uuid(parent["id"]))
    except ResourceInvariantError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    await execute(
        session,
        """
        UPDATE resource_relations
        SET valid_to = :moment, revision = revision + 1
        WHERE tenant_id = :tenant_id AND to_id = :self AND relation_type_id = :relation_type_id AND valid_to IS NULL
        """,
        {"moment": moment, "tenant_id": tenant_id, "self": resource_id, "relation_type_id": as_uuid(relation["id"])},
    )
    await _link(session, tenant_id, as_uuid(parent["id"]), resource_id, "CONTAINS", moment)
    await execute(
        session,
        "UPDATE resources SET version = version + 1, updated_at = :now WHERE id = :id",
        {"now": utcnow(), "id": resource_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_MOVE", actor_id=actor, entity_type="resource", entity_id=resource_id, before={"parent": None}, after={"parent_id": parent["id"], "at": moment.isoformat()}, correlation_id=correlation_id)
    return await get_resource(session, tenant_id, resource_id)


async def archive_resource(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _resource(session, tenant_id, resource_id)
    children = await fetch_one(
        session,
        """
        SELECT count(*) AS count FROM resource_relations rr
        JOIN resources child ON child.id = rr.to_id
        JOIN relation_types rt ON rt.id = rr.relation_type_id
        WHERE rr.from_id = :id AND rt.code = 'CONTAINS' AND rr.valid_to IS NULL AND child.archived_at IS NULL
        """,
        {"id": resource_id},
    )
    if children and int(children["count"]) > 0:
        raise AppError(409, "HAS_CHILDREN", "Hãy lưu trữ các tài nguyên con trước.")
    now = utcnow()
    await execute(
        session,
        """
        UPDATE resources SET status = 'ARCHIVED', archived_at = :now, version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"now": now, "id": resource_id, "tenant_id": tenant_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_ARCHIVE", actor_id=actor, entity_type="resource", entity_id=resource_id, before={"status": current["status"]}, after={"status": "ARCHIVED"}, correlation_id=correlation_id)
    return await get_resource(session, tenant_id, resource_id)


async def create_type(session: AsyncSession, tenant_id: UUID, actor: UUID, body: TypeIn, correlation_id: str) -> dict[str, Any]:
    try:
        key = validate_code(body.key).lower()
    except ResourceInvariantError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    if body.category not in {"ENTERPRISE", "SITE", "AREA", "WORK_CENTER", "ASSET", "POSITION", "CUSTOM"}:
        raise AppError(422, "CATEGORY", "Nhóm loại không hợp lệ.")
    type_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision)
        VALUES (:id, :tenant_id, :key, :name, :category, CAST(:schema AS jsonb), FALSE, 1)
        """,
        {"id": type_id, "tenant_id": tenant_id, "key": key, "name": body.name.strip(), "category": body.category, "schema": jsonb(body.properties_schema)},
    )
    for parent in body.parent_type_keys:
        await execute(
            session,
            """
            INSERT INTO type_adjacency (tenant_id, relation_code, parent_type_key, child_type_key)
            VALUES (:tenant_id, 'CONTAINS', :parent, :child)
            ON CONFLICT DO NOTHING
            """,
            {"tenant_id": tenant_id, "parent": parent, "child": key},
        )
    for child in body.child_type_keys:
        await execute(
            session,
            """
            INSERT INTO type_adjacency (tenant_id, relation_code, parent_type_key, child_type_key)
            VALUES (:tenant_id, 'CONTAINS', :parent, :child)
            ON CONFLICT DO NOTHING
            """,
            {"tenant_id": tenant_id, "parent": key, "child": child},
        )
    created = await fetch_one(session, "SELECT * FROM resource_types WHERE id = :id", {"id": type_id})
    await audit(session, tenant_id=tenant_id, event_type="TYPE_CREATE", actor_id=actor, entity_type="resource_type", entity_id=type_id, before=None, after={"key": key}, correlation_id=correlation_id)
    assert created is not None
    return created


async def list_types(session: AsyncSession, tenant_id: UUID) -> list[dict[str, Any]]:
    return await fetch_all(session, "SELECT * FROM resource_types WHERE tenant_id = :tenant_id ORDER BY key", {"tenant_id": tenant_id})


async def neighbors(
    session: AsyncSession,
    tenant_id: UUID,
    resource_id: UUID,
    *,
    depth: int,
    relation_codes: list[str],
    as_of: datetime | None,
) -> dict[str, Any]:
    depth = min(max(depth, 1), 3)
    await _resource(session, tenant_id, resource_id)
    moment = _aware(as_of) if as_of else utcnow()
    codes = relation_codes or ["CONTAINS", "INSTALLED_AT", "FEEDS", "CONNECTED_TO", "MONITORED_BY", "PART_OF"]
    seen = {str(resource_id)}
    frontier = [resource_id]
    nodes = [await _resource(session, tenant_id, resource_id)]
    edges: list[dict[str, Any]] = []
    for _ in range(depth):
        if not frontier or len(nodes) >= 200:
            break
        found = await fetch_all(
            session,
            """
            SELECT rr.id, rr.from_id, rr.to_id, rr.valid_from, rr.valid_to, rt.code AS relation_code
            FROM resource_relations rr
            JOIN relation_types rt ON rt.id = rr.relation_type_id
            WHERE rr.tenant_id = :tenant_id
              AND rt.code = ANY(:codes)
              AND rr.valid_from <= :moment
              AND (rr.valid_to IS NULL OR rr.valid_to > :moment)
              AND (rr.from_id = ANY(:frontier) OR rr.to_id = ANY(:frontier))
            """,
            {"tenant_id": tenant_id, "codes": codes, "moment": moment, "frontier": frontier},
        )
        next_frontier: list[UUID] = []
        for edge in found:
            edges.append(edge)
            for endpoint in (edge["from_id"], edge["to_id"]):
                if endpoint not in seen and len(nodes) < 200:
                    seen.add(endpoint)
                    next_frontier.append(as_uuid(endpoint))
                    nodes.append(await _resource(session, tenant_id, as_uuid(endpoint)))
        frontier = next_frontier
    return {"nodes": nodes, "edges": edges, "truncated": len(nodes) >= 200, "as_of": moment.isoformat().replace("+00:00", "Z")}


async def save_layout_draft(session: AsyncSession, tenant_id: UUID, actor: UUID, layout_id: UUID, body: LayoutDraft, correlation_id: str) -> dict[str, Any]:
    current = await _layout(session, tenant_id, layout_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "Layout đã được chỉnh sửa ở nơi khác.")
    _reject_topology_keys(body.draft)
    await execute(
        session,
        """
        UPDATE layout_definitions
        SET draft_json = CAST(:draft AS jsonb), version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"draft": jsonb(body.draft), "now": utcnow(), "id": layout_id, "tenant_id": tenant_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="LAYOUT_DRAFT", actor_id=actor, entity_type="layout", entity_id=layout_id, before={"version": current["version"]}, after={"version": int(current["version"]) + 1}, correlation_id=correlation_id)
    return await _layout(session, tenant_id, layout_id)


def _reject_topology_keys(draft: dict[str, Any]) -> None:
    banned = {"resource_relations", "parent_id", "contains"}
    if banned & set(draft):
        raise AppError(422, "LAYOUT_SCOPE", "Layout không được ghi quan hệ tài nguyên.")


async def _layout(session: AsyncSession, tenant_id: UUID, layout_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM layout_definitions WHERE id = :id AND tenant_id = :tenant_id",
        {"id": layout_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy layout.")
    return row


async def create_layout(session: AsyncSession, tenant_id: UUID, actor: UUID, body: LayoutIn, correlation_id: str) -> dict[str, Any]:
    layout_id = uuid4()
    scope = parse_uuid(body.scope_resource_id) if body.scope_resource_id else None
    if scope:
        await _resource(session, tenant_id, scope)
    await execute(
        session,
        """
        INSERT INTO layout_definitions (id, tenant_id, scope_resource_id, name, draft_json, version, updated_at)
        VALUES (:id, :tenant_id, :scope, :name, '{}'::jsonb, 1, :now)
        """,
        {"id": layout_id, "tenant_id": tenant_id, "scope": scope, "name": body.name.strip(), "now": utcnow()},
    )
    await audit(session, tenant_id=tenant_id, event_type="LAYOUT_CREATE", actor_id=actor, entity_type="layout", entity_id=layout_id, before=None, after={"name": body.name.strip()}, correlation_id=correlation_id)
    return await _layout(session, tenant_id, layout_id)


async def publish_layout(session: AsyncSession, tenant_id: UUID, actor: UUID, layout_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _layout(session, tenant_id, layout_id)
    revision = int(current["published_revision"] or 0) + 1
    await execute(
        session,
        """
        INSERT INTO layout_revisions (id, layout_id, revision, elements_json, created_by, created_at)
        VALUES (:id, :layout_id, :revision, CAST(:elements AS jsonb), :actor, :now)
        """,
        {
            "id": uuid4(),
            "layout_id": layout_id,
            "revision": revision,
            "elements": jsonb(current["draft_json"]),
            "actor": actor,
            "now": utcnow(),
        },
    )
    await execute(
        session,
        """
        UPDATE layout_definitions
        SET published_revision = :revision, version = version + 1, updated_at = :now
        WHERE id = :id
        """,
        {"revision": revision, "now": utcnow(), "id": layout_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="LAYOUT_PUBLISH", actor_id=actor, entity_type="layout", entity_id=layout_id, before=None, after={"revision": revision}, correlation_id=correlation_id)
    return await _layout(session, tenant_id, layout_id)


async def import_resources(session: AsyncSession, tenant_id: UUID, actor: UUID, body: ImportIn, correlation_id: str) -> dict[str, Any]:
    if len(body.rows) > 2000:
        raise AppError(422, "LIMIT", "Mỗi lần nhập tối đa 2000 dòng.")
    errors: list[dict[str, str]] = []
    planned: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, row in enumerate(body.rows, start=1):
        code = str(row.get("code", "")).strip()
        name = str(row.get("name", "")).strip()
        type_key = str(row.get("type_key", "")).strip()
        parent_code = str(row.get("parent_code", "")).strip()
        try:
            validate_code(code)
            if not name:
                raise ResourceInvariantError("NAME", "Thiếu tên.")
            await _type_by_key(session, tenant_id, type_key)
        except (ResourceInvariantError, AppError) as exc:
            errors.append({"row": str(index), "code": getattr(exc, "code", "INVALID"), "message": str(exc)})
            continue
        if code in seen:
            errors.append({"row": str(index), "code": "DUPLICATE", "message": "Mã lặp trong tệp."})
            continue
        seen.add(code)
        planned.append({"code": code, "name": name, "type_key": type_key, "parent_code": parent_code})
    if errors:
        raise AppError(422, "IMPORT_INVALID", "Tệp nhập có dòng không hợp lệ.", extra={"row_errors": errors})
    if body.dry_run:
        return {"dry_run": True, "accepted": len(planned), "created": 0}
    created = 0
    for row in planned:
        parent_id = None
        if row["parent_code"]:
            parent = await fetch_one(
                session,
                "SELECT id FROM resources WHERE tenant_id = :tenant_id AND code = :code",
                {"tenant_id": tenant_id, "code": row["parent_code"]},
            )
            if parent is None:
                raise AppError(422, "MISSING_PARENT", f"Không thấy cha {row['parent_code']}.")
            parent_id = parent["id"]
        await create_resource(
            session,
            tenant_id,
            actor,
            ResourceIn(
                type_key=row["type_key"],
                code=row["code"],
                name=row["name"],
                site_id=body.site_id,
                parent_id=parent_id,
            ),
            correlation_id,
        )
        created += 1
    return {"dry_run": False, "accepted": created, "created": created}


def hierarchy_presets() -> dict[str, Any]:
    return {"items": [{"name": name, "levels": levels} for name, levels in HIERARCHY_PRESETS.items()]}


async def create_hierarchy(session: AsyncSession, tenant_id: UUID, actor: UUID, body: HierarchyIn, correlation_id: str) -> dict[str, Any]:
    errors = validate_levels(body.level_rules)
    if errors:
        raise AppError(422, "HIERARCHY", "Mẫu phân cấp không hợp lệ.", extra={"level_errors": errors})
    row_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO hierarchy_views (
            id, tenant_id, name, relation_filter, root_selector, level_rules_json, revision, status
        ) VALUES (
            :id, :tenant_id, :name, :relation_filter, CAST(:root AS jsonb), CAST(:levels AS jsonb), 1, 'DRAFT'
        )
        """,
        {
            "id": row_id,
            "tenant_id": tenant_id,
            "name": body.name.strip(),
            "relation_filter": body.relation_filter,
            "root": jsonb(body.root_selector),
            "levels": jsonb(body.level_rules),
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="HIERARCHY_DRAFT", actor_id=actor, entity_type="hierarchy_view", entity_id=row_id, before=None, after={"name": body.name.strip()}, correlation_id=correlation_id)
    row = await fetch_one(session, "SELECT * FROM hierarchy_views WHERE id = :id", {"id": row_id})
    assert row is not None
    return row


def validate_levels(levels: list[dict[str, Any]]) -> list[str]:
    if not levels:
        return ["Cần ít nhất một cấp."]
    errors: list[str] = []
    keys = [str(level.get("type_key", "")) for level in levels]
    if keys != list(dict.fromkeys(keys)):
        errors.append("Loại tài nguyên bị lặp trong mẫu.")
    rank = {key: index for index, key in enumerate(["enterprise", "site", "plant", "zone", "workshop", "line", "cell", "utility_system", "machine", "sensor", "physical_asset", "functional_position"])}
    previous = -1
    for key in keys:
        current = rank.get(key, previous + 1)
        if current < previous:
            errors.append("Thứ tự cha-con bị đảo.")
        previous = current
    return errors


def sanitize_svg(payload: str) -> str:
    if len(payload.encode("utf-8")) > 2_000_000:
        raise AppError(422, "UPLOAD", "SVG vượt quá 2 MB.")
    lowered = payload.lower()
    banned = ("<script", "foreignobject", "javascript:", "onload=", "onclick=", "onerror=", "<iframe", "xlink:href=\"http", "href=\"http")
    if any(token in lowered for token in banned) or not payload.strip().lower().startswith("<svg"):
        raise AppError(422, "UPLOAD", "SVG không đạt kiểm tra an toàn.")
    return payload
