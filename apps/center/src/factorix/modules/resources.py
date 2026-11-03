"""Factory resources, relations, layouts and contextual graph."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator
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
    hierarchy_mode: Literal["guided", "strict"] = "guided"
    timezone: str = "Asia/Ho_Chi_Minh"
    create_edge: bool = False


class ResourcePatch(BaseModel):
    version: int
    name: str | None = None
    description: str | None = None
    code: str | None = None
    properties: dict[str, Any] | None = None
    tags: list[str] | None = None


class ResourceLifecycleIn(BaseModel):
    version: int = Field(ge=1)


class MoveIn(BaseModel):
    version: int
    parent_id: str | None
    at: datetime | None = None
    hierarchy_mode: Literal["guided", "strict"] = "guided"


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
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=2000)
    default_parent_id: str | None = None
    hierarchy_mode: Literal["guided", "strict"] = "guided"
    plan_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @field_validator("rows")
    @classmethod
    def bounded_json_rows(cls, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        try:
            payload = json.dumps(rows, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            size = len(payload.encode("utf-8"))
        except (TypeError, ValueError, RecursionError) as exc:
            raise ValueError("Import rows must contain valid JSON with finite numbers.") from exc
        if size > 2_000_000:
            raise ValueError("Import rows are limited to 2 MB.")
        return rows


def _aware(value: datetime | None) -> datetime:
    if value is None:
        return utcnow()
    if value.tzinfo is None:
        raise AppError(422, "TIMEZONE", "Timestamps must include a timezone.")
    return value.astimezone(timezone.utc)


async def create_site(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SiteIn, correlation_id: str) -> dict[str, Any]:
    code = _validated_code(body.code)
    name = _validated_name(body.name)
    try:
        ZoneInfo(body.timezone)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise AppError(422, "TIMEZONE", "Select a valid IANA timezone.") from exc
    row_id = uuid4()
    now = utcnow()
    await execute(
        session,
        """
        INSERT INTO sites (id, tenant_id, code, name, timezone, created_at)
        VALUES (:id, :tenant_id, :code, :name, :timezone, :now)
        """,
        {"id": row_id, "tenant_id": tenant_id, "code": code, "name": name, "timezone": body.timezone, "now": now},
    )
    created = await fetch_one(session, "SELECT * FROM sites WHERE id = :id", {"id": row_id})
    await audit(session, tenant_id=tenant_id, event_type="SITE_CREATE", actor_id=actor, entity_type="site", entity_id=row_id, before=None, after=created, correlation_id=correlation_id)
    assert created is not None
    return created


async def list_sites(session: AsyncSession, tenant_id: UUID) -> list[dict[str, Any]]:
    return await fetch_all(session, "SELECT * FROM sites WHERE tenant_id = :tenant_id ORDER BY code", {"tenant_id": tenant_id})


async def get_site(session: AsyncSession, tenant_id: UUID, site_id: UUID) -> dict[str, Any]:
    row = await fetch_one(session, "SELECT * FROM sites WHERE id = :id AND tenant_id = :tenant_id", {"id": site_id, "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Site not found.")
    return row


async def _type_by_key(session: AsyncSession, tenant_id: UUID, key: str) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM resource_types WHERE tenant_id = :tenant_id AND key = :key",
        {"tenant_id": tenant_id, "key": key},
    )
    if row is None:
        raise AppError(422, "UNKNOWN_TYPE", "Resource type does not exist.")
    return row


def _validated_code(value: str) -> str:
    try:
        return validate_code(value)
    except ResourceInvariantError as exc:
        raise AppError(422, exc.code, str(exc)) from exc


def _validated_name(value: str) -> str:
    name = value.strip()
    if not name or len(name) > 200:
        raise AppError(422, "NAME", "Name must contain between 1 and 200 characters.")
    return name


def _root_warnings(type_key: str, *, strict: bool) -> list[dict[str, str]]:
    if type_key == "enterprise":
        return []
    if strict:
        raise AppError(422, "ADJACENCY", "Enterprise is the recommended type at the root level.")
    return [{"code": "NOT_RECOMMENDED", "message": "Enterprise is the recommended type at the root level."}]


async def _model_lock(session: AsyncSession, tenant_id: UUID) -> None:
    # Serializes hierarchy mutations, including empty sibling sets and cycle checks.
    # Collector ingestion does not take this lock.
    await execute(session, "SELECT pg_advisory_xact_lock(hashtextextended(:tenant, 0))", {"tenant": str(tenant_id)})


async def _assert_unique_code(
    session: AsyncSession, tenant_id: UUID, parent_id: UUID | None, code: str, resource_id: UUID,
) -> None:
    duplicate = await fetch_one(session, """
        SELECT id FROM resources WHERE tenant_id = :tenant_id AND code = :code AND id <> :id
          AND parent_id IS NOT DISTINCT FROM CAST(:parent_id AS uuid)
    """, {"tenant_id": tenant_id, "parent_id": parent_id, "code": code, "id": resource_id})
    if duplicate:
        raise AppError(409, "DUPLICATE", "A resource with this code already exists under this parent.",
                       field_errors=[{"path": "code", "code": "DUPLICATE"}])


async def create_resource(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: ResourceIn,
    correlation_id: str,
) -> dict[str, Any]:
    code = _validated_code(body.code)
    name = _validated_name(body.name)
    await _model_lock(session, tenant_id)
    type_row = await _type_by_key(session, tenant_id, body.type_key)
    site_id = parse_uuid(body.site_id) if body.site_id else None
    parent = None
    warnings: list[dict[str, str]] = []
    if body.parent_id:
        parent = await _resource(session, tenant_id, parse_uuid(body.parent_id))
        warnings = await _assert_contains(session, tenant_id, parent["type_key"], type_row["key"], parent,
                                          body.relation_code, strict=body.hierarchy_mode == "strict")
        if type_row["key"] == "site" and parent["site_id"] is not None:
            raise AppError(422, "SITE_SCOPE", "A physical Site cannot be nested inside another Site scope.")
        if type_row["key"] != "site" and parent["site_id"] is not None:
            if site_id is not None and site_id != as_uuid(parent["site_id"]):
                raise AppError(422, "SITE_SCOPE", "The resource must use its parent's Site scope.")
            site_id = as_uuid(parent["site_id"])
    elif body.relation_code == "CONTAINS":
        warnings = _root_warnings(type_row["key"], strict=body.hierarchy_mode == "strict")
    parent_id = as_uuid(parent["id"]) if parent is not None and body.relation_code == "CONTAINS" else None
    now = utcnow()
    moment = _aware(body.valid_from)
    if body.relation_code == "CONTAINS" and moment > utcnow():
        raise AppError(422, "FUTURE_HIERARCHY", "Scheduled hierarchy changes are not supported; apply this placement now.")
    resource_id = uuid4()
    await _assert_unique_code(session, tenant_id, parent_id, code, resource_id)
    if body.create_edge and type_row["key"] != "site":
        raise AppError(422, "SITE_SCOPE", "Automatic Edge creation is available only when creating a Site.")
    if type_row["key"] == "site" and site_id is None:
        scope = await create_site(session, tenant_id, actor, SiteIn(code=code, name=name, timezone=body.timezone), correlation_id)
        site_id = as_uuid(scope["id"])
    elif site_id is not None:
        scope = await get_site(session, tenant_id, site_id)
        if type_row["key"] == "site" and scope["resource_id"] is not None:
            raise AppError(409, "SITE_ANCHORED", "This Site scope already has a resource in the model.")
    if site_id is None and type_row["key"] != "enterprise":
        warnings.append({"code": "SITE_UNASSIGNED", "message": "Assign this resource to a Site before mapping a data source."})
    await execute(
        session,
        """
        INSERT INTO resources (
            id, tenant_id, site_id, parent_id, type_id, code, name, description, properties_json, tags_json,
            status, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :site_id, :parent_id, :type_id, :code, :name, :description,
            CAST(:properties AS jsonb), CAST(:tags AS jsonb), 'ACTIVE', 1, :now, :now
        )
        """,
        {
            "id": resource_id,
            "tenant_id": tenant_id,
            "site_id": site_id,
            "parent_id": parent_id,
            "type_id": as_uuid(type_row["id"]),
            "code": code,
            "name": name,
            "description": body.description,
            "properties": jsonb(body.properties),
            "tags": jsonb(body.tags[:32]),
            "now": now,
        },
    )
    if parent is not None:
        if body.relation_code == "INSTALLED_AT":
            if type_row["key"] != "physical_asset":
                raise AppError(422, "DOMAIN", "Only physical assets can be installed at a functional position.")
            await _link(session, tenant_id, resource_id, as_uuid(parent["id"]), "INSTALLED_AT", moment)
        else:
            await _link(session, tenant_id, as_uuid(parent["id"]), resource_id, body.relation_code, moment)
    edge = None
    if type_row["key"] == "site":
        await execute(session, "UPDATE sites SET resource_id = :id WHERE id = :site_id AND tenant_id = :tenant_id",
                      {"id": resource_id, "site_id": site_id, "tenant_id": tenant_id})
        if body.create_edge:
            from factorix.modules.collect import EdgeIn, create_edge

            edge = await create_edge(session, tenant_id, actor, EdgeIn(name=f"{name} Edge", site_id=str(site_id)), correlation_id)
    created = await get_resource(session, tenant_id, resource_id)
    created["warnings"] = warnings
    if edge is not None:
        created["edge"] = edge
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
    *,
    strict: bool = False,
) -> list[dict[str, str]]:
    if parent.get("status") == "ARCHIVED" or parent.get("archived_at"):
        raise AppError(409, "ARCHIVED_PARENT", "Cannot add children under an archived resource.")
    if relation_code == "INSTALLED_AT":
        if parent_key != "functional_position":
            raise AppError(422, "DOMAIN", "INSTALLED_AT links a physical asset to a functional position.")
        return []
    if relation_code != "CONTAINS":
        return []
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
        if strict:
            raise AppError(422, "ADJACENCY", "This placement is outside the recommended type hierarchy.")
        return [{"code": "NOT_RECOMMENDED", "message": "This placement is outside the recommended type hierarchy."}]
    return []


async def _link(session: AsyncSession, tenant_id: UUID, parent_id: UUID, child_id: UUID, relation_code: str, valid_from: datetime) -> None:
    relation = await fetch_one(
        session,
        "SELECT id, acyclic FROM relation_types WHERE tenant_id = :tenant_id AND code = :code",
        {"tenant_id": tenant_id, "code": relation_code},
    )
    if relation is None:
        raise AppError(422, "RELATION", "Relation type does not exist.")
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
        raise AppError(404, "NOT_FOUND", "Resource not found.")
    return row


async def get_resource(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> dict[str, Any]:
    row = await _resource(session, tenant_id, resource_id)
    children = await fetch_one(
        session,
        """
        SELECT count(*) AS count FROM resources WHERE tenant_id = :tenant_id AND parent_id = :id
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
    return await fetch_all(session, """
        WITH RECURSIVE ancestors AS (
            SELECT id, parent_id, code, name, 0 AS depth, ARRAY[id] AS path FROM resources
            WHERE id = :id AND tenant_id = :tenant_id
            UNION ALL
            SELECT p.id, p.parent_id, p.code, p.name, c.depth + 1, c.path || p.id
            FROM resources p JOIN ancestors c ON p.id = c.parent_id
            WHERE p.tenant_id = :tenant_id AND NOT p.id = ANY(c.path)
        ) SELECT id, code, name FROM ancestors ORDER BY depth DESC
    """, {"id": resource_id, "tenant_id": tenant_id})


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
        where.append("r.parent_id = :parent_id")
        params["parent_id"] = parse_uuid(parent_id)
    elif view != "all" and parent_id is None and not query and not type_key:
        where.append("r.parent_id IS NULL")
    if cursor:
        if cursor.startswith("r1:"):
            parts = cursor.split(":", 2)
            if len(parts) != 3:
                raise AppError(422, "CURSOR", "Invalid resource cursor.")
            params["cursor_id"] = parse_uuid(parts[1])
            params["cursor_code"] = _validated_code(parts[2])
            where.append("(r.code, r.id) > (:cursor_code, :cursor_id)")
        else:
            # Legacy code-only cursors remain accepted; new pages always use the unique pair.
            params["cursor"] = cursor
            where.append("r.code > :cursor")
    sql = f"""
        SELECT r.id, r.code, r.name, r.status, r.version, r.site_id, r.archived_at, r.parent_id,
               r.description, r.properties_json, r.tags_json, r.created_at, r.updated_at,
               t.key AS type_key, t.category AS type_category
        FROM resources r JOIN resource_types t ON t.id = r.type_id
        WHERE {' AND '.join(where)}
        ORDER BY r.code, r.id
        LIMIT :limit
    """
    items = await fetch_all(session, sql, params)
    next_cursor = None
    if len(items) > limit:
        last = items[limit - 1]
        next_cursor = f"r1:{last['id']}:{last['code']}"
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
    await _model_lock(session, tenant_id)
    current = await _resource(session, tenant_id, resource_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    if current["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Archived resources are read-only.")
    name = _validated_name(body.name) if body.name is not None else current["name"]
    description = body.description if body.description is not None else current["description"]
    code = current["code"]
    if body.code is not None:
        code = _validated_code(body.code)
    await _assert_unique_code(session, tenant_id, current["parent_id"], code, resource_id)
    properties = body.properties if body.properties is not None else current["properties_json"]
    tags = body.tags if body.tags is not None else current["tags_json"]
    written = await fetch_one(
        session,
        """
        UPDATE resources
        SET name = :name, description = :description, code = :code,
            properties_json = CAST(:properties AS jsonb), tags_json = CAST(:tags AS jsonb),
            version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id AND version = :version
        RETURNING id
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
    if written is None:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    if current["type_key"] == "site":
        await execute(session, "UPDATE sites SET name = :name, code = :code WHERE resource_id = :id AND tenant_id = :tenant_id",
                      {"name": name, "code": code, "id": resource_id, "tenant_id": tenant_id})
    updated = await get_resource(session, tenant_id, resource_id)
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_UPDATE", actor_id=actor, entity_type="resource", entity_id=resource_id, before={"name": current["name"], "code": current["code"]}, after={"name": name, "code": code}, correlation_id=correlation_id)
    return updated


async def move_resource(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, body: MoveIn, correlation_id: str) -> dict[str, Any]:
    await _model_lock(session, tenant_id)
    current = await _resource(session, tenant_id, resource_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    if current["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Archived resources are read-only.")
    parent = await _resource(session, tenant_id, parse_uuid(body.parent_id)) if body.parent_id is not None else None
    new_parent_id = as_uuid(parent["id"]) if parent else None
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
        SELECT id AS child_id, parent_id FROM resources
        WHERE tenant_id = :tenant_id AND parent_id IS NOT NULL AND id <> :self
        """,
        {"tenant_id": tenant_id, "self": resource_id},
    )
    pairs = [(as_uuid(item["child_id"]), as_uuid(item["parent_id"])) for item in edges]
    try:
        if new_parent_id is not None:
            assert_no_cycle(pairs, resource_id, new_parent_id)
    except ResourceInvariantError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    warnings = await _assert_contains(session, tenant_id, parent["type_key"], current["type_key"], parent,
                                      "CONTAINS", strict=body.hierarchy_mode == "strict") if parent else _root_warnings(current["type_key"], strict=body.hierarchy_mode == "strict")
    await _assert_unique_code(session, tenant_id, new_parent_id, current["code"], resource_id)
    if moment > utcnow():
        raise AppError(422, "FUTURE_HIERARCHY", "Scheduled hierarchy changes are not supported; apply this move now.")
    later = await fetch_one(session, """
        SELECT id FROM resource_relations WHERE tenant_id = :tenant_id AND to_id = :id
          AND relation_type_id = :relation_type AND valid_from >= :moment AND valid_to IS NULL
    """, {"tenant_id": tenant_id, "id": resource_id, "relation_type": as_uuid(relation["id"]), "moment": moment})
    if later:
        raise AppError(422, "TEMPORAL_ORDER", "The move must occur after the current placement began.")
    subtree = await fetch_all(session, """
        WITH RECURSIVE tree AS (
            SELECT r.id, r.site_id, t.key AS type_key FROM resources r
            JOIN resource_types t ON t.id = r.type_id WHERE r.id = :id AND r.tenant_id = :tenant_id
            UNION ALL
            SELECT c.id, c.site_id, ct.key FROM resources c JOIN tree p ON c.parent_id = p.id
            JOIN resource_types ct ON ct.id = c.type_id WHERE c.tenant_id = :tenant_id
        ) SELECT * FROM tree
    """, {"id": resource_id, "tenant_id": tenant_id})
    if parent and parent["site_id"] is not None and any(node["type_key"] == "site" for node in subtree):
        raise AppError(422, "SITE_SCOPE", "A subtree containing a physical Site cannot be nested inside another Site scope.")
    new_site = current["site_id"] if current["type_key"] == "site" else parent["site_id"] if parent else None
    if current["site_id"] != new_site:
        # Site anchors below this node start their own scope and do not inherit the new one.
        affected = await fetch_all(session, """
            WITH RECURSIVE scoped AS (
                SELECT id FROM resources WHERE id = :id AND tenant_id = :tenant_id
                UNION ALL
                SELECT c.id FROM resources c JOIN scoped p ON c.parent_id = p.id
                JOIN resource_types t ON t.id = c.type_id WHERE c.tenant_id = :tenant_id AND t.key <> 'site'
            ) SELECT id FROM scoped
        """, {"id": resource_id, "tenant_id": tenant_id})
        affected_ids = [as_uuid(node["id"]) for node in affected]
        binding = await fetch_one(session, """
            SELECT b.id FROM signal_bindings b JOIN signal_definitions s ON s.id = b.signal_id
            WHERE s.tenant_id = :tenant_id AND s.resource_id = ANY(:ids) AND b.valid_to IS NULL LIMIT 1
        """, {"tenant_id": tenant_id, "ids": affected_ids})
        if binding:
            raise AppError(409, "SOURCE_REASSIGNMENT_REQUIRED",
                           "Reassign or detach source mappings in this subtree before moving it to another Site.")
        await execute(session, """
            UPDATE resources SET site_id = :site_id, updated_at = :now,
                version = version + CASE WHEN id = :root_id THEN 0 ELSE 1 END
            WHERE tenant_id = :tenant_id AND id = ANY(:ids)
        """, {"site_id": new_site, "now": utcnow(), "root_id": resource_id, "tenant_id": tenant_id, "ids": affected_ids})
    await execute(
        session,
        """
        UPDATE resource_relations
        SET valid_to = :moment, revision = revision + 1
        WHERE tenant_id = :tenant_id AND to_id = :self AND relation_type_id = :relation_type_id AND valid_to IS NULL
        """,
        {"moment": moment, "tenant_id": tenant_id, "self": resource_id, "relation_type_id": as_uuid(relation["id"])},
    )
    if new_parent_id is not None:
        await _link(session, tenant_id, new_parent_id, resource_id, "CONTAINS", moment)
    written = await fetch_one(
        session,
        """UPDATE resources SET parent_id = :parent_id, version = version + 1, updated_at = :now
           WHERE id = :id AND tenant_id = :tenant_id AND version = :version RETURNING id""",
        {"now": utcnow(), "id": resource_id, "tenant_id": tenant_id, "version": body.version, "parent_id": new_parent_id},
    )
    if written is None:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_MOVE", actor_id=actor, entity_type="resource", entity_id=resource_id, before={"parent_id": current["parent_id"]}, after={"parent_id": new_parent_id, "at": moment.isoformat()}, correlation_id=correlation_id)
    updated = await get_resource(session, tenant_id, resource_id)
    updated["warnings"] = warnings
    return updated


async def _publish_asset_changes(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, correlation_id: str) -> list[dict[str, Any]]:
    from factorix.modules.collect import ReleaseIn, publish_release

    edges = await fetch_all(session, """
        SELECT DISTINCT c.edge_id FROM signal_bindings b JOIN signal_definitions s ON s.id = b.signal_id
        JOIN source_fields f ON f.id = b.source_field_id JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        JOIN connections c ON c.id = j.connection_id
        WHERE s.tenant_id = :tenant_id AND c.tenant_id = :tenant_id AND s.resource_id = :id
          AND b.valid_to IS NULL AND c.status <> 'ARCHIVED' ORDER BY c.edge_id
    """, {"tenant_id": tenant_id, "id": resource_id})
    deployments = []
    for edge in edges:
        deployments.append(await publish_release(session, tenant_id, actor, ReleaseIn(edge_id=str(edge["edge_id"])), correlation_id))
    return deployments


async def archive_resource(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, correlation_id: str,
                           version: int | None = None) -> dict[str, Any]:
    await _model_lock(session, tenant_id)
    current = await _resource(session, tenant_id, resource_id)
    if version is not None and current["version"] != version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    if current["archived_at"] is not None:
        return await get_resource(session, tenant_id, resource_id)
    children = await fetch_one(
        session,
        """
        SELECT count(*) AS count FROM resources
        WHERE parent_id = :id AND tenant_id = :tenant_id AND archived_at IS NULL
        """,
        {"id": resource_id, "tenant_id": tenant_id},
    )
    if children and int(children["count"]) > 0:
        raise AppError(409, "HAS_CHILDREN", "Archive child resources first.")
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
    deployments = await _publish_asset_changes(session, tenant_id, actor, resource_id, correlation_id)
    updated = await get_resource(session, tenant_id, resource_id)
    updated["deployments"] = deployments
    return updated


async def restore_resource(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID,
                           body: ResourceLifecycleIn, correlation_id: str) -> dict[str, Any]:
    await _model_lock(session, tenant_id)
    current = await _resource(session, tenant_id, resource_id)
    if current["version"] != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    if current["archived_at"] is None:
        return await get_resource(session, tenant_id, resource_id)
    if current["parent_id"]:
        parent = await _resource(session, tenant_id, as_uuid(current["parent_id"]))
        if parent["archived_at"] is not None:
            raise AppError(409, "ARCHIVED_PARENT", "Restore the parent resource first.")
    await execute(session, """UPDATE resources SET status = 'ACTIVE', archived_at = NULL,
        version = version + 1, updated_at = :now WHERE tenant_id = :tenant_id AND id = :id""",
        {"now": utcnow(), "tenant_id": tenant_id, "id": resource_id})
    deployments = await _publish_asset_changes(session, tenant_id, actor, resource_id, correlation_id)
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_RESTORE", actor_id=actor, entity_type="resource",
                entity_id=resource_id, before={"status": "ARCHIVED"}, after={"status": "ACTIVE"}, correlation_id=correlation_id)
    updated = await get_resource(session, tenant_id, resource_id)
    updated["deployments"] = deployments
    return updated


async def create_type(session: AsyncSession, tenant_id: UUID, actor: UUID, body: TypeIn, correlation_id: str) -> dict[str, Any]:
    key = _validated_code(body.key).lower()
    name = _validated_name(body.name)
    await _model_lock(session, tenant_id)
    existing = await fetch_one(session, "SELECT id FROM resource_types WHERE tenant_id = :tenant_id AND key = :key",
                               {"tenant_id": tenant_id, "key": key})
    if existing:
        raise AppError(409, "DUPLICATE", "A resource type with this key already exists.")
    if body.category not in {"ENTERPRISE", "SITE", "AREA", "WORK_CENTER", "ASSET", "POSITION", "CUSTOM"}:
        raise AppError(422, "CATEGORY", "Invalid type category.")
    parents = sorted({_validated_code(value).lower() for value in body.parent_type_keys})
    children = sorted({_validated_code(value).lower() for value in body.child_type_keys})
    for related in set(parents + children) - {key}:
        await _type_by_key(session, tenant_id, related)
    type_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision)
        VALUES (:id, :tenant_id, :key, :name, :category, CAST(:schema AS jsonb), FALSE, 1)
        """,
        {"id": type_id, "tenant_id": tenant_id, "key": key, "name": name, "category": body.category, "schema": jsonb(body.properties_schema)},
    )
    for parent in parents:
        await execute(
            session,
            """
            INSERT INTO type_adjacency (tenant_id, relation_code, parent_type_key, child_type_key)
            VALUES (:tenant_id, 'CONTAINS', :parent, :child)
            ON CONFLICT DO NOTHING
            """,
            {"tenant_id": tenant_id, "parent": parent, "child": key},
        )
    for child in children:
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
    created["parent_type_keys"] = parents
    created["child_type_keys"] = children
    return created


async def list_types(session: AsyncSession, tenant_id: UUID) -> list[dict[str, Any]]:
    catalog = await fetch_all(session, "SELECT * FROM resource_types WHERE tenant_id = :tenant_id ORDER BY key", {"tenant_id": tenant_id})
    pairs = await fetch_all(session, """SELECT parent_type_key, child_type_key FROM type_adjacency
        WHERE tenant_id = :tenant_id AND relation_code = 'CONTAINS' ORDER BY parent_type_key, child_type_key""",
        {"tenant_id": tenant_id})
    by_key = {row["key"]: row for row in catalog}
    for row in catalog:
        row["parent_type_keys"] = []
        row["child_type_keys"] = []
    for pair in pairs:
        if pair["parent_type_key"] in by_key and pair["child_type_key"] in by_key:
            by_key[pair["parent_type_key"]]["child_type_keys"].append(pair["child_type_key"])
            by_key[pair["child_type_key"]]["parent_type_keys"].append(pair["parent_type_key"])
    return catalog


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
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This layout was modified elsewhere.")
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
        raise AppError(422, "LAYOUT_SCOPE", "Layouts cannot write resource relationships.")


async def _layout(session: AsyncSession, tenant_id: UUID, layout_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM layout_definitions WHERE id = :id AND tenant_id = :tenant_id",
        {"id": layout_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Layout not found.")
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
    from factorix.modules.resource_import import ResourceImporter

    return await ResourceImporter(session, tenant_id, actor, correlation_id).run(body)

def hierarchy_presets() -> dict[str, Any]:
    return {"items": [{"name": name, "levels": levels} for name, levels in HIERARCHY_PRESETS.items()]}


async def create_hierarchy(session: AsyncSession, tenant_id: UUID, actor: UUID, body: HierarchyIn, correlation_id: str) -> dict[str, Any]:
    errors = validate_levels(body.level_rules)
    if errors:
        raise AppError(422, "HIERARCHY", "Invalid hierarchy template.", extra={"level_errors": errors})
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
        errors.append("Duplicate resource type in the template.")
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
        raise AppError(422, "UPLOAD", "SVG exceeds 2 MB.")
    lowered = payload.lower()
    banned = ("<script", "foreignobject", "javascript:", "onload=", "onclick=", "onerror=", "<iframe", "xlink:href=\"http", "href=\"http")
    if any(token in lowered for token in banned) or not payload.strip().lower().startswith("<svg"):
        raise AppError(422, "UPLOAD", "SVG failed the safety check.")
    return payload
