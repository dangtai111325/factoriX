"""Factory resources, relations and contextual graph."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.catalog import HIERARCHY_PRESETS
from factorix.domain.resources import ResourceInvariantError, assert_no_cycle, validate_code
from factorix.modules.common import as_uuid, audit, execute, execute_rowcount, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
from factorix.modules import usage
from factorix.platform.errors import AppError

MAX_PAGE = 200

FORBIDDEN_NAME = re.compile(r"[/#+$\x00-\x1f]")


class ResourceIn(BaseModel):
    type_key: str
    code: str
    name: str = Field(min_length=1, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)
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


# Fields of a resource edit recorded in the change history: audit key -> resources column.
AUDITED_FIELDS = (("name", "name"), ("code", "code"), ("description", "description"), ("properties", "properties_json"), ("tags", "tags_json"))


def resource_changes(current: dict[str, Any], updated: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Before/after of every audited field that changed (R2-HS-05). ``updated`` uses audit keys.

    Only changed fields appear, each in both payloads, so the history can say exactly what changed.
    """
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for key, column in AUDITED_FIELDS:
        if key not in updated:
            continue
        old = current.get(column)
        new = updated[key]
        if json.dumps(old, sort_keys=True, default=str) != json.dumps(new, sort_keys=True, default=str):
            before[key] = old
            after[key] = new
    return before, after


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


class HierarchyIn(BaseModel):
    name: str
    relation_filter: str = "CONTAINS"
    level_rules: list[dict[str, Any]] = Field(default_factory=list)
    root_selector: dict[str, Any] = Field(default_factory=dict)


class ImportIn(BaseModel):
    site_id: str | None = None
    dry_run: bool = True
    rows: list[dict[str, str]]


class TopicImportIn(BaseModel):
    topics: list[str]
    prefix_levels: int = 1
    level_types: list[str] = Field(default_factory=lambda: ["enterprise", "site", "area", "zone", "line", "machine"])
    skip_suffix_levels: int = 1
    dry_run: bool = True
    site_id: str | None = None


def _aware(value: datetime | None) -> datetime:
    if value is None:
        return utcnow()
    if value.tzinfo is None:
        raise AppError(422, "TIMEZONE", "Timestamps must include a timezone.")
    return value.astimezone(timezone.utc)


async def create_site(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SiteIn, correlation_id: str) -> dict[str, Any]:
    code = validate_code(body.code)
    if not body.timezone or len(body.timezone) > 64:
        raise AppError(422, "TIMEZONE", "Invalid timezone.")
    row_id = uuid4()
    now = utcnow()
    # Check first: only a real duplicate is a 409; any other database error stays a server error.
    existing = await fetch_one(
        session,
        "SELECT id FROM sites WHERE tenant_id = :tenant_id AND code = :code",
        {"tenant_id": tenant_id, "code": code},
    )
    if existing is not None:
        raise AppError(409, "DUPLICATE", "A site with this code already exists.", field_errors=[{"path": "code", "code": "DUPLICATE"}])
    await execute(
        session,
        """
        INSERT INTO sites (id, tenant_id, code, name, timezone, created_at)
        VALUES (:id, :tenant_id, :code, :name, :timezone, :now)
        """,
        {"id": row_id, "tenant_id": tenant_id, "code": code, "name": body.name.strip(), "timezone": body.timezone, "now": now},
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


def sibling_name_key(name: str) -> str:
    """Comparison key of a resource name among its siblings: trimmed, case-insensitive (R3-HS-02)."""
    return str(name or "").strip().lower()


async def assert_unique_sibling_name(
    session: AsyncSession, tenant_id: UUID, parent_id: Any, name: str, *, exclude_id: Any = None, parent_name: str | None = None
) -> None:
    """409 DUPLICATE_NAME when an active sibling (same parent, or both roots) has the same name.
    Two lines named alike under one zone cannot be told apart in the tree, graph or models."""
    duplicate = await fetch_one(
        session,
        """
        SELECT id, code FROM resources
        WHERE tenant_id = :tenant_id AND archived_at IS NULL
          AND parent_id IS NOT DISTINCT FROM CAST(:parent_id AS uuid)
          AND lower(btrim(name)) = :name_key
          AND (CAST(:exclude_id AS uuid) IS NULL OR id <> CAST(:exclude_id AS uuid))
        LIMIT 1
        """,
        {
            "tenant_id": tenant_id,
            "parent_id": as_uuid(parent_id) if parent_id else None,
            "name_key": sibling_name_key(name),
            "exclude_id": as_uuid(exclude_id) if exclude_id else None,
        },
    )
    if duplicate:
        where = f"under {parent_name}" if parent_name else "at the top level"
        raise AppError(
            409,
            "DUPLICATE_NAME",
            f'Another resource {where} is already named "{name.strip()}" (code {duplicate["code"]}). Use a different name.',
            field_errors=[{"path": "name", "code": "DUPLICATE_NAME"}],
        )


async def create_resource(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: ResourceIn,
    correlation_id: str,
) -> dict[str, Any]:
    if len(body.name) > 200:
        raise AppError(422, "NAME_LENGTH", "Name must be at most 200 characters.", field_errors=[{"path": "name", "code": "NAME_LENGTH"}])
    if FORBIDDEN_NAME.search(body.name):
        raise AppError(422, "NAME_CHARS", "Names cannot contain / # + $ or control characters.", field_errors=[{"path": "name", "code": "NAME_CHARS"}])
    try:
        code = validate_code(body.code)
    except ResourceInvariantError as exc:
        raise AppError(422, exc.code, str(exc), field_errors=[{"path": "code", "code": exc.code}]) from exc
    type_row = await _type_by_key(session, tenant_id, body.type_key)
    if type_row["key"] == "enterprise" and body.parent_id:
        raise AppError(422, "ROOT_ONLY", "Enterprise cannot have a parent.", field_errors=[{"path": "parent_id", "code": "ROOT_ONLY"}])

    parent = None
    placement = "recommended"
    if body.parent_id:
        parent = await _resource(session, tenant_id, parse_uuid(body.parent_id))
        if parent.get("status") == "ARCHIVED" or parent.get("archived_at"):
            raise AppError(409, "ARCHIVED_PARENT", "Cannot add children under an archived resource.")
        
        tenant_row = await fetch_one(session, "SELECT hierarchy_mode FROM tenants WHERE id = :id", {"id": tenant_id})
        hierarchy_mode = (tenant_row.get("hierarchy_mode") if tenant_row else "guided") or "guided"
        parent_type_key = parent["type_key"] if "type_key" in parent else await _type_key(session, parent)
        is_std = await _is_standard_containment(session, tenant_id, parent_type_key, type_row["key"], body.relation_code)
        if is_std:
            placement = "recommended"
        else:
            if str(hierarchy_mode).lower() == "strict":
                raise AppError(422, "ADJACENCY", "This resource type cannot be placed under the selected parent in strict mode.")
            placement = "non_standard"

    site_id = parse_uuid(body.site_id) if body.site_id else None
    if site_id is not None:
        await get_site(session, tenant_id, site_id)
    elif parent is not None:
        if parent.get("site_id"):
            site_id = as_uuid(parent["site_id"])
        elif parent.get("type_key") == "site":
            site_row = await fetch_one(session, "SELECT id FROM sites WHERE tenant_id = :tenant_id AND (code = :code OR id = :id)", {"tenant_id": tenant_id, "code": parent["code"], "id": as_uuid(parent["id"])})
            if site_row:
                site_id = as_uuid(site_row["id"])

    if type_row["key"] != "enterprise" and site_id is None:
        raise AppError(422, "SITE_REQUIRED", "This resource requires a site.")

    parent_id_val = as_uuid(parent["id"]) if parent else None
    if parent_id_val is None:
        duplicate = await fetch_one(
            session,
            "SELECT id FROM resources WHERE tenant_id = :tenant_id AND parent_id IS NULL AND lower(code) = lower(:code) AND archived_at IS NULL",
            {"tenant_id": tenant_id, "code": code},
        )
    else:
        duplicate = await fetch_one(
            session,
            "SELECT id FROM resources WHERE tenant_id = :tenant_id AND parent_id = :parent_id AND lower(code) = lower(:code) AND archived_at IS NULL",
            {"tenant_id": tenant_id, "parent_id": parent_id_val, "code": code},
        )
    if duplicate:
        parent_name = parent["name"] if parent else "root"
        raise AppError(409, "DUPLICATE", f'Another resource under {parent_name} already uses the code "{code}".', field_errors=[{"path": "code", "code": "DUPLICATE"}])
    await assert_unique_sibling_name(session, tenant_id, parent_id_val, body.name, parent_name=parent["name"] if parent else None)

    if parent is not None:
        parent_path = parent.get("path_code") or parent["code"]
        path_code = f"{parent_path}/{code}"
    else:
        path_code = code

    now = utcnow()
    resource_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO resources (
            id, tenant_id, site_id, parent_id, path_code, type_id, code, name, description, properties_json, tags_json,
            status, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :site_id, :parent_id, :path_code, :type_id, :code, :name, :description,
            CAST(:properties AS jsonb), CAST(:tags AS jsonb), 'ACTIVE', 1, :now, :now
        )
        """,
        {
            "id": resource_id,
            "tenant_id": tenant_id,
            "site_id": site_id,
            "parent_id": parent_id_val,
            "path_code": path_code,
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
                raise AppError(422, "DOMAIN", "Only physical assets can be installed at a functional position.")
            await _link(session, tenant_id, resource_id, as_uuid(parent["id"]), "INSTALLED_AT", moment)
        else:
            await _link(session, tenant_id, as_uuid(parent["id"]), resource_id, body.relation_code, moment)
    if type_row["key"] == "site":
        existing_site = await fetch_one(session, "SELECT id FROM sites WHERE id = :id OR (tenant_id = :tenant_id AND lower(code) = lower(:code))", {"id": resource_id, "tenant_id": tenant_id, "code": code})
        target_site_id = resource_id
        if not existing_site:
            await execute(
                session,
                "INSERT INTO sites (id, tenant_id, code, name, timezone, created_at) VALUES (:id, :tenant_id, :code, :name, 'Asia/Ho_Chi_Minh', :now)",
                {"id": resource_id, "tenant_id": tenant_id, "code": code, "name": body.name.strip(), "now": now},
            )

    created = await get_resource(session, tenant_id, resource_id)
    created["placement"] = placement
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_CREATE", actor_id=actor, entity_type="resource", entity_id=resource_id, before=None, after={"id": str(resource_id), "code": code, "path_code": path_code}, correlation_id=correlation_id)
    return created


async def _type_key(session: AsyncSession, resource: dict[str, Any]) -> str:
    if resource.get("type_key"):
        return str(resource["type_key"])
    row = await fetch_one(session, "SELECT key FROM resource_types WHERE id = :id", {"id": as_uuid(resource["type_id"])})
    assert row is not None
    return str(row["key"])


async def _is_standard_containment(
    session: AsyncSession,
    tenant_id: UUID,
    parent_key: str,
    child_key: str,
    relation_code: str,
) -> bool:
    if relation_code == "INSTALLED_AT":
        return parent_key == "functional_position" and child_key == "physical_asset"
    if relation_code != "CONTAINS":
        return True
    row = await fetch_one(
        session,
        """
        SELECT 1 AS ok FROM type_adjacency
        WHERE tenant_id = :tenant_id AND relation_code = 'CONTAINS'
          AND parent_type_key = :parent AND child_type_key = :child
        """,
        {"tenant_id": tenant_id, "parent": parent_key, "child": child_key},
    )
    return row is not None


async def _assert_contains(
    session: AsyncSession,
    tenant_id: UUID,
    parent_key: str,
    child_key: str,
    parent: dict[str, Any],
    relation_code: str,
) -> None:
    if parent.get("status") == "ARCHIVED" or parent.get("archived_at"):
        raise AppError(409, "ARCHIVED_PARENT", "Cannot add children under an archived resource.")
    if relation_code == "INSTALLED_AT":
        if parent_key != "functional_position":
            raise AppError(422, "DOMAIN", "INSTALLED_AT links a physical asset to a functional position.")
        return
    if relation_code != "CONTAINS":
        return
    is_std = await _is_standard_containment(session, tenant_id, parent_key, child_key, relation_code)
    if not is_std:
        raise AppError(422, "ADJACENCY", "This resource type cannot be placed under the selected parent in strict mode.")


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
               r.description, r.properties_json, r.tags_json, r.path_code,
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
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    if current["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Archived resources are read-only.")
    name = current["name"]
    if body.name is not None:
        name = body.name.strip()
        if len(name) > 200:
            raise AppError(422, "NAME_LENGTH", "Name must be at most 200 characters.", field_errors=[{"path": "name", "code": "NAME_LENGTH"}])
        if FORBIDDEN_NAME.search(name):
            raise AppError(422, "NAME_CHARS", "Names cannot contain / # + $ or control characters.", field_errors=[{"path": "name", "code": "NAME_CHARS"}])
        if sibling_name_key(name) != sibling_name_key(current["name"]):
            parent_row = await fetch_one(session, "SELECT name FROM resources WHERE id = :id", {"id": current["parent_id"]}) if current.get("parent_id") else None
            await assert_unique_sibling_name(
                session, tenant_id, current.get("parent_id"), name, exclude_id=resource_id, parent_name=parent_row["name"] if parent_row else None
            )
    description = body.description if body.description is not None else current["description"]
    code = current["code"]
    old_path_code = current.get("path_code") or current["code"]
    new_path_code = old_path_code

    if body.code is not None and body.code != current["code"]:
        try:
            code = validate_code(body.code)
        except ResourceInvariantError as exc:
            raise AppError(422, exc.code, str(exc), field_errors=[{"path": "code", "code": exc.code}]) from exc
        # Sibling duplicate check
        if current.get("parent_id") is None:
            dup = await fetch_one(session, "SELECT id FROM resources WHERE tenant_id = :tenant_id AND parent_id IS NULL AND lower(code) = lower(:code) AND archived_at IS NULL AND id <> :id", {"tenant_id": tenant_id, "code": code, "id": resource_id})
        else:
            dup = await fetch_one(session, "SELECT id FROM resources WHERE tenant_id = :tenant_id AND parent_id = :parent_id AND lower(code) = lower(:code) AND archived_at IS NULL AND id <> :id", {"tenant_id": tenant_id, "parent_id": current["parent_id"], "code": code, "id": resource_id})
        if dup:
            parent_row = await fetch_one(session, "SELECT name FROM resources WHERE id = :id", {"id": current["parent_id"]}) if current.get("parent_id") else None
            pname = parent_row["name"] if parent_row else "root"
            raise AppError(409, "DUPLICATE", f'Another resource under {pname} already uses the code "{code}".', field_errors=[{"path": "code", "code": "DUPLICATE"}])

        if current.get("parent_id"):
            parent_row = await fetch_one(session, "SELECT path_code, code FROM resources WHERE id = :id", {"id": current["parent_id"]})
            ppath = (parent_row.get("path_code") or parent_row["code"]) if parent_row else ""
            new_path_code = f"{ppath}/{code}" if ppath else code
        else:
            new_path_code = code

    properties = body.properties if body.properties is not None else current["properties_json"]
    tags = body.tags if body.tags is not None else current["tags_json"]
    updated_rows = await execute_rowcount(
        session,
        """
        UPDATE resources
        SET name = :name, description = :description, code = :code, path_code = :path_code,
            properties_json = CAST(:properties AS jsonb), tags_json = CAST(:tags AS jsonb),
            version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id AND version = :version
        """,
        {
            "name": name,
            "description": description,
            "code": code,
            "path_code": new_path_code,
            "properties": jsonb(properties),
            "tags": jsonb(tags),
            "now": utcnow(),
            "id": resource_id,
            "tenant_id": tenant_id,
            "version": body.version,
        },
    )
    if updated_rows != 1:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere. Reload it and try again.")
    if new_path_code != old_path_code:
        # Only after the version-guarded update succeeded. Prefix match with left() instead of
        # LIKE so "_" or "%" in a code cannot act as a wildcard and rewrite a sibling subtree.
        await execute(
            session,
            """
            UPDATE resources
            SET path_code = CAST(:new_prefix AS text) || SUBSTRING(path_code FROM CAST(:pos AS integer))
            WHERE tenant_id = :tenant_id AND left(path_code, CAST(:prefix_len AS integer)) = CAST(:old_prefix AS text)
            """,
            {
                "new_prefix": new_path_code,
                "pos": len(old_path_code) + 1,
                "tenant_id": tenant_id,
                "prefix_len": len(old_path_code) + 1,
                "old_prefix": f"{old_path_code}/",
            },
        )
    updated = await get_resource(session, tenant_id, resource_id)
    before, after = resource_changes(current, {"name": name, "code": code, "description": description, "properties": properties, "tags": tags})
    before["version"] = int(current["version"])
    after["version"] = int(current["version"]) + 1
    if new_path_code != old_path_code:
        before["path_code"] = old_path_code
        after["path_code"] = new_path_code
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_UPDATE", actor_id=actor, entity_type="resource", entity_id=resource_id, before=before, after=after, correlation_id=correlation_id)
    return updated


async def move_resource(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, body: MoveIn, correlation_id: str) -> dict[str, Any]:
    current = await _resource(session, tenant_id, resource_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This resource was modified elsewhere.")
    if str(body.parent_id) == str(resource_id):
        raise AppError(422, "CYCLE", "Cannot move a resource into itself.")
    parent = await _resource(session, tenant_id, parse_uuid(body.parent_id))
    
    curr_path = current.get("path_code") or current["code"]
    parent_path = parent.get("path_code") or parent["code"]
    if parent_path == curr_path or parent_path.startswith(f"{curr_path}/"):
        raise AppError(422, "CYCLE", "Cannot move a resource into itself or one of its descendants.")
    
    tenant_row = await fetch_one(session, "SELECT hierarchy_mode FROM tenants WHERE id = :id", {"id": tenant_id})
    hierarchy_mode = (tenant_row.get("hierarchy_mode") if tenant_row else None) or "guided"
    if str(hierarchy_mode).lower() == "strict":
        await _assert_contains(session, tenant_id, parent["type_key"], current["type_key"], parent, "CONTAINS")

    dup = await fetch_one(
        session,
        "SELECT id FROM resources WHERE tenant_id = :tenant_id AND parent_id = :parent_id AND lower(code) = lower(:code) AND archived_at IS NULL AND id <> :id",
        {"tenant_id": tenant_id, "parent_id": as_uuid(parent["id"]), "code": current["code"], "id": resource_id},
    )
    if dup:
        raise AppError(409, "DUPLICATE", f'Another resource under {parent["name"]} already uses the code "{current["code"]}".', field_errors=[{"path": "code", "code": "DUPLICATE"}])
    await assert_unique_sibling_name(session, tenant_id, parent["id"], current["name"], exclude_id=resource_id, parent_name=parent["name"])

    old_path_code = current.get("path_code") or current["code"]
    new_path_code = f"{parent_path}/{current['code']}"
    old_len_plus_one = len(old_path_code) + 1
    curr_site_id = current.get("site_id")
    target_site_id = as_uuid(parent.get("site_id")) if parent.get("site_id") else curr_site_id

    if curr_site_id and target_site_id and curr_site_id != target_site_id:
        active_bindings = await fetch_all(
            session,
            """
            SELECT sb.id, sd.id AS signal_id, sd.key, c.id AS connection_id, c.name AS connection_name
            FROM signal_bindings sb
            JOIN signal_definitions sd ON sd.id = sb.signal_id
            JOIN resources r ON r.id = sd.resource_id
            JOIN source_fields sf ON sf.id = sb.source_field_id
            JOIN acquisition_jobs aj ON aj.id = sf.acquisition_job_id
            JOIN connections c ON c.id = aj.connection_id
            WHERE r.tenant_id = :tenant_id
              AND (r.id = :resource_id OR left(r.path_code, CAST(:prefix_len AS integer)) = CAST(:old_prefix AS text))
              AND sb.enabled = TRUE AND sb.valid_to IS NULL
            """,
            {"tenant_id": tenant_id, "resource_id": resource_id, "prefix_len": len(old_path_code) + 1, "old_prefix": f"{old_path_code}/"},
        )
        if active_bindings:
            raise AppError(
                409,
                "CROSS_SITE_BINDINGS",
                f"Cannot move resource across sites because {len(active_bindings)} active signal binding(s) exist. Disconnect or remap signals first.",
            )
    new_site_id = target_site_id

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
        """
        UPDATE resources
        SET parent_id = :parent_id, path_code = :new_path, site_id = :site_id, version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {
            "parent_id": as_uuid(parent["id"]),
            "new_path": new_path_code,
            "site_id": new_site_id,
            "now": utcnow(),
            "id": resource_id,
            "tenant_id": tenant_id,
        },
    )
    await execute(
        session,
        """
        UPDATE resources
        SET path_code = CAST(:new_prefix AS text) || SUBSTRING(path_code FROM CAST(:pos AS integer)), site_id = :site_id
        WHERE tenant_id = :tenant_id AND left(path_code, CAST(:prefix_len AS integer)) = CAST(:old_prefix AS text)
        """,
        {
            "new_prefix": new_path_code,
            "pos": old_len_plus_one,
            "site_id": new_site_id,
            "tenant_id": tenant_id,
            # Exact prefix match: "_" or "%" in a code must not act as a LIKE wildcard.
            "prefix_len": len(old_path_code) + 1,
            "old_prefix": f"{old_path_code}/",
        },
    )
    from factorix.modules import collect
    await collect.bump_edge_release(session, tenant_id, actor, correlation_id)

    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_MOVE", actor_id=actor, entity_type="resource", entity_id=resource_id, before={"parent_id": current.get("parent_id")}, after={"parent_id": str(parent["id"]), "path_code": new_path_code, "at": moment.isoformat()}, correlation_id=correlation_id)
    return await get_resource(session, tenant_id, resource_id)


class ArchiveIn(BaseModel):
    # Archive the data models that read this resource's signals together with it (R3-HS-01).
    # Without it, a resource whose signals feed active models is not archived (409 RESOURCE_HAS_MODELS).
    archive_models: bool = False


async def _active_children(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> int:
    row = await fetch_one(
        session,
        "SELECT count(*) AS count FROM resources WHERE tenant_id = :tenant_id AND parent_id = :id AND archived_at IS NULL",
        {"tenant_id": tenant_id, "id": resource_id},
    )
    return int(row["count"]) if row else 0


async def archive_impact(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> dict[str, Any]:
    """What archiving the resource affects, shown by the archive dialog before it is confirmed.

    ``signals`` are the active signals of the resource (they stop collecting); ``models`` are the
    active data models that read any of them (``usage.models_using_signals``).
    """
    current = await _resource(session, tenant_id, resource_id)
    children = await _active_children(session, tenant_id, resource_id)
    signals = await fetch_all(
        session,
        """
        SELECT sd.id, sd.key, sd.display_name,
               EXISTS (SELECT 1 FROM signal_bindings b WHERE b.signal_id = sd.id AND b.valid_to IS NULL AND b.enabled) AS collecting
        FROM signal_definitions sd
        WHERE sd.tenant_id = :tenant_id AND sd.resource_id = :id AND sd.status = 'ACTIVE'
        ORDER BY sd.key
        """,
        {"tenant_id": tenant_id, "id": resource_id},
    )
    # Signals of the resource and resource attributes (e.g. ``.@zone.@name``) both count (Data Model v2).
    models = await usage.models_using_resource(session, tenant_id, resource_id)
    return {
        "resource_id": str(resource_id),
        "resource_name": current.get("name"),
        "child_count": children,
        "can_archive": children == 0,
        "signal_count": len(signals),
        "collecting_signal_count": sum(1 for row in signals if row.get("collecting")),
        "signals": [{"id": str(row["id"]), "key": row["key"], "display_name": row["display_name"]} for row in signals[:200]],
        "models": models,
    }


async def archive_resource(
    session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, correlation_id: str, *, archive_models: bool = False
) -> dict[str, Any]:
    current = await _resource(session, tenant_id, resource_id)
    if await _active_children(session, tenant_id, resource_id) > 0:
        raise AppError(409, "HAS_CHILDREN", "Archive child resources first.")

    now = utcnow()
    sig_rows = await fetch_all(
        session,
        """
        SELECT sd.id, sb.enabled
        FROM signal_definitions sd
        LEFT JOIN signal_bindings sb ON sb.signal_id = sd.id AND sb.valid_to IS NULL
        WHERE sd.tenant_id = :tenant_id AND sd.resource_id = :id AND sd.status = 'ACTIVE'
        """,
        {"tenant_id": tenant_id, "id": resource_id},
    )
    affected_count = len(sig_rows)
    active_sig_ids = [as_uuid(r["id"]) for r in sig_rows if r["id"]]
    enabled_binding_sig_ids = [as_uuid(r["id"]) for r in sig_rows if r.get("enabled")]

    # R3-HS-01: archiving must not leave models publishing frozen values from archived signals.
    models = await usage.models_using_resource(session, tenant_id, resource_id)
    if models and not archive_models:
        names = ", ".join(str(m.get("display_name") or m["id"]) for m in models[:5])
        raise AppError(
            409,
            "RESOURCE_HAS_MODELS",
            f"{len(models)} data model(s) use signals of this resource ({names}). Archive them too or change them first.",
            extra={"models": models},
        )
    archived_models = await usage.archive_models(session, tenant_id, actor, models, correlation_id) if models else []

    if active_sig_ids:
        await execute(
            session,
            "UPDATE signal_definitions SET status = 'ARCHIVED', updated_at = :now WHERE id = ANY(:ids)",
            {"now": now, "ids": active_sig_ids},
        )
        if enabled_binding_sig_ids:
            await execute(
                session,
                "UPDATE signal_bindings SET enabled = FALSE WHERE signal_id = ANY(:ids)",
                {"ids": enabled_binding_sig_ids},
            )
        from factorix.modules import collect
        await collect.bump_edge_release(session, tenant_id, actor, correlation_id)

    props = dict(current.get("properties_json") or {})
    props["_prior_archive_state"] = {
        "active_signals": [str(sid) for sid in active_sig_ids],
        "enabled_bindings": [str(sid) for sid in enabled_binding_sig_ids],
    }

    await execute(
        session,
        """
        UPDATE resources SET status = 'ARCHIVED', archived_at = :now, version = version + 1, updated_at = :now, properties_json = CAST(:props AS jsonb)
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"now": now, "props": jsonb(props), "id": resource_id, "tenant_id": tenant_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="RESOURCE_ARCHIVE", actor_id=actor, entity_type="resource", entity_id=resource_id, before={"status": current["status"], "affected_signals": 0}, after={"status": "ARCHIVED", "affected_signals": affected_count, "archived_models": [str(m["id"]) for m in archived_models]}, correlation_id=correlation_id)
    res = await get_resource(session, tenant_id, resource_id)
    res["affected_signals"] = affected_count
    res["archived_models"] = archived_models
    return res


async def restore_resource(session: AsyncSession, tenant_id: UUID, actor: UUID, resource_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _resource(session, tenant_id, resource_id)
    if current["archived_at"] is None and current["status"] == "ACTIVE":
        return current
    
    if current.get("parent_id"):
        parent = await fetch_one(
            session,
            "SELECT id, name, status, archived_at FROM resources WHERE id = :id AND tenant_id = :tenant_id",
            {"id": current["parent_id"], "tenant_id": tenant_id},
        )
        if parent and (parent.get("status") == "ARCHIVED" or parent.get("archived_at")):
            raise AppError(409, "ARCHIVED_PARENT", "Cannot restore resource when parent is archived.")
        dup = await fetch_one(
            session,
            "SELECT id FROM resources WHERE tenant_id = :tenant_id AND parent_id = :parent_id AND lower(code) = lower(:code) AND archived_at IS NULL AND id <> :id",
            {"tenant_id": tenant_id, "parent_id": current["parent_id"], "code": current["code"], "id": resource_id},
        )
        if dup:
            pname = parent["name"] if parent else "parent"
            raise AppError(409, "DUPLICATE", f'Another resource under {pname} already uses the code "{current["code"]}".')
        await assert_unique_sibling_name(session, tenant_id, current["parent_id"], current["name"], exclude_id=resource_id, parent_name=parent["name"] if parent else None)
    else:
        dup = await fetch_one(
            session,
            "SELECT id FROM resources WHERE tenant_id = :tenant_id AND parent_id IS NULL AND lower(code) = lower(:code) AND archived_at IS NULL AND id <> :id",
            {"tenant_id": tenant_id, "code": current["code"], "id": resource_id},
        )
        if dup:
            raise AppError(409, "DUPLICATE", f'A root resource already uses the code "{current["code"]}".')
        await assert_unique_sibling_name(session, tenant_id, None, current["name"], exclude_id=resource_id)
            
    now = utcnow()
    props = dict(current.get("properties_json") or {})
    prior_state = props.pop("_prior_archive_state", None)

    signals_to_restore: list[UUID]
    bindings_to_enable: list[UUID]
    if prior_state and isinstance(prior_state, dict):
        signals_to_restore = [as_uuid(sid) for sid in prior_state.get("active_signals", [])]
        bindings_to_enable = [as_uuid(sid) for sid in prior_state.get("enabled_bindings", [])]
    else:
        # Archived before the prior-state snapshot existed: restore exactly the signals the archive
        # action archived (same timestamp as the resource). Which bindings the user had disabled
        # is unknown, so no binding is re-enabled; the operator enables them explicitly.
        sig_rows = await fetch_all(
            session,
            """
            SELECT id FROM signal_definitions
            WHERE tenant_id = :tenant_id AND resource_id = :id AND status = 'ARCHIVED' AND updated_at = :archived_at
            """,
            {"tenant_id": tenant_id, "id": resource_id, "archived_at": current["archived_at"]},
        )
        signals_to_restore = [as_uuid(r["id"]) for r in sig_rows]
        bindings_to_enable = []
    restored, skipped = await _restore_signals(session, tenant_id, resource_id, signals_to_restore, now)
    enabled_now = [sid for sid in bindings_to_enable if sid in set(restored)]
    if enabled_now:
        # Only the current binding of each signal, and only if no other binding became active.
        await execute(
            session,
            """
            UPDATE signal_bindings SET enabled = TRUE
            WHERE id IN (
                SELECT DISTINCT ON (signal_id) id FROM signal_bindings
                WHERE signal_id = ANY(:ids) AND valid_to IS NULL
                ORDER BY signal_id, valid_from DESC, revision DESC
            )
            AND NOT EXISTS (
                SELECT 1 FROM signal_bindings other
                WHERE other.signal_id = signal_bindings.signal_id AND other.enabled = TRUE AND other.valid_to IS NULL
            )
            """,
            {"ids": enabled_now},
        )
    if restored:
        from factorix.modules import collect
        await collect.bump_edge_release(session, tenant_id, actor, correlation_id)

    await execute(
        session,
        """
        UPDATE resources SET status = 'ACTIVE', archived_at = NULL, version = version + 1, updated_at = :now, properties_json = CAST(:props AS jsonb)
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"now": now, "props": jsonb(props), "id": resource_id, "tenant_id": tenant_id},
    )
    await audit(
        session,
        tenant_id=tenant_id,
        event_type="RESOURCE_RESTORE",
        actor_id=actor,
        entity_type="resource",
        entity_id=resource_id,
        before={"status": "ARCHIVED"},
        after={"status": "ACTIVE", "restored_signals": len(restored), "skipped_signals": [str(sid) for sid in skipped]},
        correlation_id=correlation_id,
    )
    result = await get_resource(session, tenant_id, resource_id)
    result["restored_signals"] = len(restored)
    result["skipped_signals"] = [str(sid) for sid in skipped]
    return result


async def _restore_signals(
    session: AsyncSession,
    tenant_id: UUID,
    resource_id: UUID,
    signal_ids: list[UUID],
    now: datetime,
) -> tuple[list[UUID], list[UUID]]:
    """Re-activate archived signals unless an ACTIVE signal now uses the same key on the resource.

    Respects the partial unique index signal_key_active instead of failing with an IntegrityError.
    """
    if not signal_ids:
        return [], []
    rows = await fetch_all(
        session,
        """
        SELECT s.id, EXISTS (
            SELECT 1 FROM signal_definitions other
            WHERE other.resource_id = s.resource_id AND other.key = s.key AND other.status = 'ACTIVE' AND other.id <> s.id
        ) AS key_taken
        FROM signal_definitions s
        WHERE s.tenant_id = :tenant_id AND s.resource_id = :resource_id AND s.id = ANY(:ids) AND s.status = 'ARCHIVED'
        """,
        {"tenant_id": tenant_id, "resource_id": resource_id, "ids": signal_ids},
    )
    restore = [as_uuid(row["id"]) for row in rows if not row["key_taken"]]
    skipped = [as_uuid(row["id"]) for row in rows if row["key_taken"]]
    if restore:
        await execute(
            session,
            "UPDATE signal_definitions SET status = 'ACTIVE', version = version + 1, updated_at = :now WHERE id = ANY(:ids)",
            {"now": now, "ids": restore},
        )
    return restore, skipped


async def create_type(session: AsyncSession, tenant_id: UUID, actor: UUID, body: TypeIn, correlation_id: str) -> dict[str, Any]:
    try:
        key = validate_code(body.key).lower()
    except ResourceInvariantError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    if body.category not in {"ENTERPRISE", "SITE", "AREA", "WORK_CENTER", "ASSET", "POSITION", "CUSTOM"}:
        raise AppError(422, "CATEGORY", "Invalid type category.")
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
    types = await fetch_all(
        session,
        """
        SELECT * FROM resource_types
        WHERE tenant_id = :tenant_id
        ORDER BY
            CASE category
                WHEN 'ENTERPRISE' THEN 1
                WHEN 'SITE' THEN 2
                WHEN 'AREA' THEN 3
                WHEN 'WORK_CENTER' THEN 4
                WHEN 'ASSET' THEN 5
                WHEN 'POSITION' THEN 6
                ELSE 7
            END, key
        """,
        {"tenant_id": tenant_id},
    )
    adjacencies = await fetch_all(
        session,
        "SELECT parent_type_key, child_type_key FROM type_adjacency WHERE tenant_id = :tenant_id AND relation_code = 'CONTAINS'",
        {"tenant_id": tenant_id},
    )
    children_map: dict[str, list[str]] = {}
    for adj in adjacencies:
        children_map.setdefault(adj["parent_type_key"], []).append(adj["child_type_key"])
    for t in types:
        t["recommended_children"] = children_map.get(t["key"], [])
    return types


async def neighbors(
    session: AsyncSession,
    tenant_id: UUID,
    resource_id: UUID,
    *,
    depth: int,
    relation_codes: list[str],
    as_of: datetime | None,
    include_data: bool = False,
) -> dict[str, Any]:
    depth = min(max(depth, 1), 3)
    root_raw = await _resource(session, tenant_id, resource_id)
    root = dict(root_raw)
    root["kind"] = "resource"
    root["label"] = root.get("display_name") or root.get("name") or root.get("code") or ""
    moment = _aware(as_of) if as_of else utcnow()
    codes = relation_codes or ["CONTAINS", "INSTALLED_AT", "FEEDS", "CONNECTED_TO", "MONITORED_BY", "PART_OF"]
    seen = {str(resource_id)}
    frontier = [resource_id]
    nodes = [root]
    edges: list[dict[str, Any]] = []

    # 1. Structural traversal
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
            edge["since"] = edge["valid_from"].isoformat() if edge.get("valid_from") else None
            edge["from"] = str(edge["from_id"])
            edge["to"] = str(edge["to_id"])
            edges.append(edge)
            for endpoint in (edge["from_id"], edge["to_id"]):
                ep_str = str(endpoint)
                if ep_str not in seen and len(nodes) < 200:
                    seen.add(ep_str)
                    next_frontier.append(as_uuid(endpoint))
                    raw_res = await _resource(session, tenant_id, as_uuid(endpoint))
                    r_node = dict(raw_res)
                    r_node["kind"] = "resource"
                    r_node["label"] = r_node.get("display_name") or r_node.get("name") or r_node.get("code") or ""
                    nodes.append(r_node)
        frontier = next_frontier

    # 2. Data traversal (signals -> connections -> edges -> models) if include_data
    if include_data and len(nodes) < 200:
        res_ids = [as_uuid(n["id"]) for n in nodes if n.get("kind") == "resource" or n.get("type_key")]
        if res_ids:
            if not relation_codes or "HAS_SIGNAL" in relation_codes:
                signals = await fetch_all(
                    session,
                    """
                    SELECT s.id, s.key, s.display_name, s.data_type, s.resource_id,
                           l.value_json, l.quality, l.received_time
                    FROM signal_definitions s
                    LEFT JOIN latest_signal_state l ON l.signal_id = s.id
                    WHERE s.tenant_id = :tenant_id AND s.resource_id = ANY(:res_ids) AND s.status = 'ACTIVE'
                    """,
                    {"tenant_id": tenant_id, "res_ids": res_ids},
                )
                sig_ids: list[UUID] = []
                for sig in signals:
                    s_id = str(sig["id"])
                    if s_id not in seen and len(nodes) < 200:
                        seen.add(s_id)
                        sig_ids.append(as_uuid(sig["id"]))
                        nodes.append({
                            "id": s_id,
                            "kind": "signal",
                            "type": "signal",
                            "key": sig["key"],
                            "label": sig["display_name"] or sig["key"],
                            "name": sig["display_name"] or sig["key"],
                            "quality": sig.get("quality") or "UNKNOWN",
                            "value": sig.get("value_json"),
                            "data_type": sig.get("data_type"),
                            "freshness": "REALTIME" if sig.get("received_time") else "UNKNOWN",
                        })
                        edges.append({
                            "id": str(uuid4()),
                            "from_id": str(sig["resource_id"]),
                            "to_id": s_id,
                            "from": str(sig["resource_id"]),
                            "to": s_id,
                            "relation_code": "HAS_SIGNAL",
                            "since": moment.isoformat(),
                        })

                if depth >= 2 and sig_ids and (not relation_codes or "COLLECTED_VIA" in relation_codes):
                    conns = await fetch_all(
                        session,
                        """
                        SELECT b.signal_id, c.id AS connection_id, c.name AS connection_name,
                               c.protocol, c.health, c.site_id
                        FROM signal_bindings b
                        JOIN source_fields sf ON sf.id = b.source_field_id
                        JOIN acquisition_jobs j ON j.id = sf.acquisition_job_id
                        JOIN connections c ON c.id = j.connection_id
                        WHERE b.signal_id = ANY(:sig_ids) AND b.enabled = TRUE
                        """,
                        {"sig_ids": sig_ids},
                    )
                    conn_ids: list[UUID] = []
                    for conn in conns:
                        c_id = str(conn["connection_id"])
                        if c_id not in seen and len(nodes) < 200:
                            seen.add(c_id)
                            conn_ids.append(as_uuid(conn["connection_id"]))
                            nodes.append({
                                "id": c_id,
                                "kind": "connection",
                                "type": "connection",
                                "label": conn["connection_name"],
                                "name": conn["connection_name"],
                                "protocol": conn["protocol"],
                                "health": conn["health"],
                            })
                        edges.append({
                            "id": str(uuid4()),
                            "from_id": str(conn["signal_id"]),
                            "to_id": c_id,
                            "from": str(conn["signal_id"]),
                            "to": c_id,
                            "relation_code": "COLLECTED_VIA",
                            "since": moment.isoformat(),
                        })



                if depth >= 2 and sig_ids and (not relation_codes or "USED_IN" in relation_codes):
                    models = await fetch_all(
                        session,
                        """
                        SELECT m.ref_id AS signal_id, og.id AS model_id, og.display_name AS model_name, og.state AS status
                        FROM model_refs m
                        JOIN output_groups og ON og.id = m.model_id
                        WHERE m.ref_kind = 'signal' AND m.ref_id = ANY(:sig_ids) AND og.status <> 'ARCHIVED'
                        """,
                        {"sig_ids": sig_ids},
                    )
                    for mod in models:
                        m_id = str(mod["model_id"])
                        if m_id not in seen and len(nodes) < 200:
                            seen.add(m_id)
                            nodes.append({
                                "id": m_id,
                                "kind": "model",
                                "type": "model",
                                "label": mod["model_name"],
                                "name": mod["model_name"],
                                "status": mod["status"],
                            })
                        edges.append({
                            "id": str(uuid4()),
                            "from_id": str(mod["signal_id"]),
                            "to_id": m_id,
                            "from": str(mod["signal_id"]),
                            "to": m_id,
                            "relation_code": "USED_IN",
                            "since": moment.isoformat(),
                        })

    if relation_codes:
        edges = [e for e in edges if e.get("relation_code") in relation_codes]

    return {"nodes": nodes[:200], "edges": edges, "truncated": len(nodes) >= 200, "as_of": moment.isoformat().replace("+00:00", "Z")}


async def import_resources(session: AsyncSession, tenant_id: UUID, actor: UUID, body: ImportIn, correlation_id: str) -> dict[str, Any]:
    if len(body.rows) > 2000:
        raise AppError(422, "LIMIT", "Import is limited to 2000 rows at a time.")
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
                raise ResourceInvariantError("NAME", "Name is required.")
            await _type_by_key(session, tenant_id, type_key)
        except (ResourceInvariantError, AppError) as exc:
            errors.append({"row": str(index), "code": getattr(exc, "code", "INVALID"), "message": str(exc)})
            continue
        if code in seen:
            errors.append({"row": str(index), "code": "DUPLICATE", "message": "Duplicate code in the import file."})
            continue
        seen.add(code)
        planned.append({"code": code, "name": name, "type_key": type_key, "parent_code": parent_code})
    if errors:
        raise AppError(422, "IMPORT_INVALID", "The import file has invalid rows.", extra={"row_errors": errors})
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
                raise AppError(422, "MISSING_PARENT", f"Parent not found: {row['parent_code']}.")
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


async def import_from_topics(session: AsyncSession, tenant_id: UUID, actor: UUID, body: TopicImportIn, correlation_id: str) -> dict[str, Any]:
    prefix_skip = max(0, body.prefix_levels)
    suffix_skip = max(0, body.skip_suffix_levels)

    unique_paths: set[tuple[str, ...]] = set()
    for topic in body.topics:
        cleaned = topic.strip().strip("/")
        if not cleaned:
            continue
        parts = cleaned.split("/")
        if len(parts) <= prefix_skip:
            continue
        parts = parts[prefix_skip:]
        if suffix_skip > 0 and len(parts) > suffix_skip:
            parts = parts[:-suffix_skip]
        # Ignore production noise like "production", "order", "output"
        filtered_parts = []
        for p in parts:
            if p.lower() in {"production", "order", "output"}:
                break
            filtered_parts.append(p)
        if not filtered_parts:
            continue
        for i in range(1, len(filtered_parts) + 1):
            unique_paths.add(tuple(filtered_parts[:i]))

    sorted_paths = sorted(unique_paths, key=lambda p: (len(p), p))
    to_create: list[dict[str, Any]] = []
    existing: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []

    level_types = body.level_types or ["enterprise", "site", "area", "zone", "line", "machine"]
    default_site_id = parse_uuid(body.site_id) if body.site_id else None
    created_map: dict[tuple[str, ...], dict[str, Any]] = {}

    for path_tuple in sorted_paths:
        depth = len(path_tuple) - 1
        type_key = level_types[depth] if depth < len(level_types) else level_types[-1]
        code = path_tuple[-1]
        name = code.replace("-", " ").replace("_", " ")
        parent_tuple = path_tuple[:-1] if len(path_tuple) > 1 else None
        expected_path_code = "/".join(path_tuple)

        db_row = await fetch_one(
            session,
            "SELECT id, code, name, type_id, parent_id, path_code, site_id FROM resources WHERE tenant_id = :tenant_id AND (path_code = :path OR (parent_id IS NULL AND :parent_is_null AND lower(code) = lower(:code))) AND archived_at IS NULL",
            {"tenant_id": tenant_id, "path": expected_path_code, "parent_is_null": parent_tuple is None, "code": code},
        )
        if db_row is None and parent_tuple and parent_tuple in created_map:
            parent_id_val = created_map[parent_tuple]["id"]
            db_row = await fetch_one(
                session,
                "SELECT id, code, name, type_id, parent_id, path_code, site_id FROM resources WHERE tenant_id = :tenant_id AND parent_id = :parent_id AND lower(code) = lower(:code) AND archived_at IS NULL",
                {"tenant_id": tenant_id, "parent_id": parent_id_val, "code": code},
            )

        if db_row is not None:
            created_map[path_tuple] = db_row
            existing.append({
                "code": code,
                "name": db_row["name"],
                "type_key": type_key,
                "path_code": db_row["path_code"] or expected_path_code,
                "parent_code": parent_tuple[-1] if parent_tuple else None,
            })
            continue

        item_spec = {
            "code": code,
            "name": name,
            "type_key": type_key,
            "path_code": expected_path_code,
            "parent_code": parent_tuple[-1] if parent_tuple else None,
        }
        to_create.append(item_spec)

        if not body.dry_run:
            parent_id = created_map[parent_tuple]["id"] if parent_tuple and parent_tuple in created_map else None
            site_id_to_use = default_site_id
            if parent_tuple and parent_tuple in created_map:
                site_id_to_use = created_map[parent_tuple].get("site_id") or default_site_id

            if type_key == "site" and site_id_to_use is None:
                site_row = await fetch_one(session, "SELECT id FROM sites WHERE tenant_id = :tenant_id AND lower(code) = lower(:code)", {"tenant_id": tenant_id, "code": code})
                if site_row is None:
                    site_row = await create_site(session, tenant_id, actor, SiteIn(code=code, name=name), correlation_id)
                site_id_to_use = site_row["id"]
                default_site_id = site_id_to_use

            created_res = await create_resource(
                session,
                tenant_id,
                actor,
                ResourceIn(
                    type_key=type_key,
                    code=code,
                    name=name,
                    site_id=str(site_id_to_use) if site_id_to_use else None,
                    parent_id=str(parent_id) if parent_id else None,
                ),
                correlation_id,
            )
            created_map[path_tuple] = created_res

    return {
        "dry_run": body.dry_run,
        "create": to_create,
        "existing": existing,
        "conflicts": conflicts,
    }


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
        return ["At least one level is required."]
    errors: list[str] = []
    keys = [str(level.get("type_key", "")) for level in levels]
    if keys != list(dict.fromkeys(keys)):
        errors.append("Duplicate resource type in the template.")
    rank = {key: index for index, key in enumerate(["enterprise", "site", "plant", "area", "zone", "workshop", "line", "cell", "utility_system", "machine", "sensor", "physical_asset", "functional_position"])}
    previous = -1
    for key in keys:
        current = rank.get(key, previous + 1)
        if current < previous:
            errors.append("Parent-child order is inverted.")
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
