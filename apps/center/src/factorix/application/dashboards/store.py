"""PostgreSQL access of the Dashboard context (``dashboards``, ``dashboard_revisions``, ``dashboard_templates``).

SQL only; every statement is tenant-scoped (revisions through their dashboard). Revisions are immutable:
this module never updates a ``dashboard_revisions`` row and deletes them only together with their (archived)
dashboard in :func:`delete_archived_dashboard`. Mutations of ``dashboards`` are
optimistic (``WHERE version = :expected``) and report whether a row was changed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import execute, execute_rowcount, fetch_all, fetch_one, jsonb

#: Columns a guarded update may set (plus version/updated_at/updated_by, always set).
_UPDATABLE = ("name", "description", "draft_json", "archived_at", "published_revision", "published_at")
_JSON_COLUMNS = frozenset({"draft_json"})


def _like(q: str) -> str:
    return "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def list_dashboards(session: AsyncSession, tenant_id: UUID, *, include_archived: bool, q: str | None) -> list[dict[str, Any]]:
    where = ["d.tenant_id = :tenant_id"]
    params: dict[str, Any] = {"tenant_id": tenant_id}
    if not include_archived:
        where.append("d.archived_at IS NULL")
    if q and q.strip():
        where.append("(d.name ILIKE :q ESCAPE '\\' OR d.description ILIKE :q ESCAPE '\\')")
        params["q"] = _like(q)
    return await fetch_all(
        session,
        f"""
        SELECT d.id, d.name, d.description, d.draft_revision, d.published_revision, d.published_at, d.archived_at,
               d.version, d.created_at, d.updated_at,
               CASE WHEN jsonb_typeof(d.draft_json -> 'widgets') = 'array'
                    THEN jsonb_array_length(d.draft_json -> 'widgets') ELSE 0 END AS widget_count,
               d.draft_json #>> '{{settings,theme,preset}}' AS theme_preset,
               CASE WHEN d.published_revision IS NULL THEN TRUE
                    ELSE d.draft_json IS DISTINCT FROM r.document_json END AS has_unpublished_changes
        FROM dashboards d
        LEFT JOIN dashboard_revisions r ON r.dashboard_id = d.id AND r.revision = d.published_revision
        WHERE {' AND '.join(where)}
        ORDER BY lower(d.name), d.created_at
        """,
        params,
    )


async def get_dashboard(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any] | None:
    return await fetch_one(
        session,
        """
        SELECT d.*, r.document_json AS published_document_json
        FROM dashboards d
        LEFT JOIN dashboard_revisions r ON r.dashboard_id = d.id AND r.revision = d.published_revision
        WHERE d.id = :id AND d.tenant_id = :tenant_id
        """,
        {"id": dashboard_id, "tenant_id": tenant_id},
    )


async def insert_dashboard(session: AsyncSession, *, dashboard_id: UUID, tenant_id: UUID, site_id: UUID | None, name: str,
                           description: str, owner: UUID, document: dict[str, Any], now: datetime) -> None:
    await execute(
        session,
        """
        INSERT INTO dashboards (
            id, tenant_id, site_id, name, description, owner_admin_id, draft_revision, draft_json, version,
            created_at, updated_at, updated_by
        ) VALUES (
            :id, :tenant_id, :site_id, :name, :description, :owner, 1, CAST(:draft AS jsonb), 1, :now, :now, :owner
        )
        """,
        {"id": dashboard_id, "tenant_id": tenant_id, "site_id": site_id, "name": name, "description": description,
         "owner": owner, "draft": jsonb(document), "now": now},
    )


async def update_dashboard(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID, *, expected_version: int, actor: UUID,
                           now: datetime, bump_draft: bool = False, **fields: Any) -> bool:
    """Guarded update: applies only when the row still has ``expected_version``; returns whether it did."""
    unknown = set(fields) - set(_UPDATABLE)
    if unknown:
        raise ValueError(f"not updatable: {sorted(unknown)}")
    sets = ["version = version + 1", "updated_at = :now", "updated_by = :actor"]
    if bump_draft:
        sets.append("draft_revision = draft_revision + 1")
    params: dict[str, Any] = {"id": dashboard_id, "tenant_id": tenant_id, "expected": expected_version, "now": now, "actor": actor}
    for column in _UPDATABLE:
        if column in fields:
            if column in _JSON_COLUMNS:
                sets.append(f"{column} = CAST(:{column} AS jsonb)")
                params[column] = jsonb(fields[column])
            else:
                sets.append(f"{column} = :{column}")
                params[column] = fields[column]
    changed = await execute_rowcount(
        session,
        f"UPDATE dashboards SET {', '.join(sets)} WHERE id = :id AND tenant_id = :tenant_id AND version = :expected",
        params,
    )
    return changed == 1


async def next_revision(session: AsyncSession, dashboard_id: UUID) -> int:
    row = await fetch_one(session, "SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM dashboard_revisions WHERE dashboard_id = :id",
                          {"id": dashboard_id})
    return int((row or {}).get("next") or 1)


async def insert_revision(session: AsyncSession, *, revision_id: UUID, dashboard_id: UUID, revision: int, document: dict[str, Any],
                          actor: UUID, note: str, now: datetime) -> None:
    await execute(
        session,
        """
        INSERT INTO dashboard_revisions (
            id, dashboard_id, revision, breakpoints_json, widget_configs_json, document_json, published_by, note,
            created_at, published_at
        ) VALUES (
            :id, :dashboard_id, :revision, CAST(:breakpoints AS jsonb), CAST(:widgets AS jsonb), CAST(:document AS jsonb),
            :actor, :note, :now, :now
        )
        """,
        {"id": revision_id, "dashboard_id": dashboard_id, "revision": revision,
         "breakpoints": jsonb({"lg": 12, "md": 6, "sm": 1}), "widgets": jsonb(document.get("widgets", [])),
         "document": jsonb(document), "actor": actor, "note": note, "now": now},
    )


async def list_revisions(session: AsyncSession, dashboard_id: UUID) -> list[dict[str, Any]]:
    return await fetch_all(
        session,
        """
        SELECT r.revision, r.published_at, r.created_at, r.published_by, r.note,
               COALESCE(a.full_name, a.login) AS published_by_name,
               CASE WHEN jsonb_typeof(r.document_json -> 'widgets') = 'array' THEN jsonb_array_length(r.document_json -> 'widgets')
                    WHEN jsonb_typeof(r.widget_configs_json) = 'array' THEN jsonb_array_length(r.widget_configs_json)
                    ELSE 0 END AS widget_count
        FROM dashboard_revisions r
        LEFT JOIN admin_accounts a ON a.id = r.published_by
        WHERE r.dashboard_id = :id
        ORDER BY r.revision DESC
        """,
        {"id": dashboard_id},
    )


async def get_revision(session: AsyncSession, dashboard_id: UUID, revision: int) -> dict[str, Any] | None:
    return await fetch_one(
        session,
        """
        SELECT r.revision, r.published_at, r.created_at, r.published_by, r.note, r.document_json, r.widget_configs_json,
               COALESCE(a.full_name, a.login) AS published_by_name
        FROM dashboard_revisions r
        LEFT JOIN admin_accounts a ON a.id = r.published_by
        WHERE r.dashboard_id = :id AND r.revision = :revision
        """,
        {"id": dashboard_id, "revision": revision},
    )


async def delete_archived_dashboard(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> int | None:
    """Permanently delete an *archived* dashboard and its revisions (same transaction as the caller).

    The row is locked first (``FOR UPDATE``) and must still be archived, so a concurrent unarchive either
    wins (nothing is deleted, ``None``) or waits. Returns the number of deleted revisions, or ``None`` when
    no archived dashboard with that id exists in the tenant.
    """
    row = await fetch_one(
        session,
        "SELECT id FROM dashboards WHERE id = :id AND tenant_id = :tenant_id AND archived_at IS NOT NULL FOR UPDATE",
        {"id": dashboard_id, "tenant_id": tenant_id},
    )
    if row is None:
        return None
    revisions = await execute_rowcount(session, "DELETE FROM dashboard_revisions WHERE dashboard_id = :id", {"id": dashboard_id})
    deleted = await execute_rowcount(
        session,
        "DELETE FROM dashboards WHERE id = :id AND tenant_id = :tenant_id AND archived_at IS NOT NULL",
        {"id": dashboard_id, "tenant_id": tenant_id},
    )
    return revisions if deleted == 1 else None


async def dashboard_states(session: AsyncSession, tenant_id: UUID, ids: list[UUID]) -> dict[str, bool]:
    """``dashboard id -> archived`` for the given ids that exist in the tenant."""
    if not ids:
        return {}
    rows = await fetch_all(
        session,
        "SELECT id, archived_at FROM dashboards WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
        {"tenant_id": tenant_id, "ids": ids},
    )
    return {str(r["id"]).lower(): r.get("archived_at") is not None for r in rows}


# ---------------------------------------------------------------------------------------------------------
# Tenant templates
# ---------------------------------------------------------------------------------------------------------


async def list_templates(session: AsyncSession, tenant_id: UUID) -> list[dict[str, Any]]:
    return await fetch_all(
        session,
        """
        SELECT id, name, description, category, document_json, roles_json, created_by, created_at, updated_at
        FROM dashboard_templates WHERE tenant_id = :tenant_id ORDER BY lower(name), created_at
        """,
        {"tenant_id": tenant_id},
    )


async def get_template(session: AsyncSession, tenant_id: UUID, template_id: UUID) -> dict[str, Any] | None:
    return await fetch_one(
        session,
        """
        SELECT id, name, description, category, document_json, roles_json, created_by, created_at, updated_at
        FROM dashboard_templates WHERE tenant_id = :tenant_id AND id = :id
        """,
        {"tenant_id": tenant_id, "id": template_id},
    )


async def insert_template(session: AsyncSession, *, template_id: UUID, tenant_id: UUID, name: str, description: str, category: str,
                          document: dict[str, Any], roles: list[dict[str, Any]], actor: UUID, now: datetime) -> None:
    await execute(
        session,
        """
        INSERT INTO dashboard_templates (
            id, tenant_id, name, description, category, document_json, roles_json, created_by, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :name, :description, :category, CAST(:document AS jsonb), CAST(:roles AS jsonb), :actor, :now, :now
        )
        """,
        {"id": template_id, "tenant_id": tenant_id, "name": name, "description": description, "category": category,
         "document": jsonb(document), "roles": jsonb(roles), "actor": actor, "now": now},
    )


async def delete_template(session: AsyncSession, tenant_id: UUID, template_id: UUID) -> bool:
    return await execute_rowcount(
        session, "DELETE FROM dashboard_templates WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": template_id},
    ) == 1
