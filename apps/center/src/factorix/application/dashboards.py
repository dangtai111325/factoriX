"""Dashboards (widgets, create/patch/publish). Moved verbatim from ``factorix.modules.telemetry`` (R2-E B5, move-only)."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import audit, execute, fetch_one, jsonb, parse_uuid, utcnow
from factorix.platform.errors import AppError


WIDGETS = {
    "kpi",
    "gauge",
    "timeseries",
    "chart",
    "machine_status",
    "energy",
    "latest_table",
    "resource_health",
    "condition",
}


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    site_id: str | None = None


class DashboardPatch(BaseModel):
    version: int
    name: str | None = None
    description: str | None = None
    draft: dict[str, Any] | None = None


async def create_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, body: DashboardIn, correlation_id: str) -> dict[str, Any]:
    dashboard_id = uuid4()
    now = utcnow()
    await execute(
        session,
        """
        INSERT INTO dashboards (
            id, tenant_id, site_id, name, description, owner_admin_id, draft_revision, draft_json, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :site_id, :name, :description, :owner, 1, '{"widgets":[]}'::jsonb, 1, :now, :now
        )
        """,
        {
            "id": dashboard_id,
            "tenant_id": tenant_id,
            "site_id": parse_uuid(body.site_id) if body.site_id else None,
            "name": body.name.strip(),
            "description": body.description,
            "owner": actor,
            "now": now,
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="DASHBOARD_CREATE", actor_id=actor, entity_type="dashboard", entity_id=dashboard_id, before=None, after={"name": body.name.strip()}, correlation_id=correlation_id)
    row = await fetch_one(session, "SELECT * FROM dashboards WHERE id = :id", {"id": dashboard_id})
    assert row is not None
    return row


async def patch_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, body: DashboardPatch, correlation_id: str) -> dict[str, Any]:
    current = await _dashboard(session, tenant_id, dashboard_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This dashboard was modified elsewhere.")
    if current["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Dashboard is archived.")
    if body.draft is not None:
        await _validate_widgets(session, tenant_id, body.draft.get("widgets", []))
    await execute(
        session,
        """
        UPDATE dashboards
        SET name = :name, description = :description, draft_json = CAST(:draft AS jsonb),
            draft_revision = draft_revision + 1, version = version + 1, updated_at = :now
        WHERE id = :id
        """,
        {
            "name": body.name.strip() if body.name else current["name"],
            "description": body.description if body.description is not None else current["description"],
            "draft": jsonb(body.draft if body.draft is not None else current["draft_json"]),
            "now": utcnow(),
            "id": dashboard_id,
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="DASHBOARD_DRAFT", actor_id=actor, entity_type="dashboard", entity_id=dashboard_id, before={"version": current["version"]}, after={"version": int(current["version"]) + 1}, correlation_id=correlation_id)
    return await _dashboard(session, tenant_id, dashboard_id)


async def _validate_widgets(session: AsyncSession, tenant_id: UUID, widgets: list[dict[str, Any]]) -> None:
    if len(widgets) > 40:
        raise AppError(422, "LIMIT", "Maximum 40 widgets per dashboard.")
    for widget in widgets:
        if widget.get("type") not in WIDGETS:
            raise AppError(422, "WIDGET", "Unsupported widget type.")
        for binding in widget.get("bindings", []):
            signal = await fetch_one(
                session,
                "SELECT id FROM signal_definitions WHERE id = :id AND tenant_id = :tenant_id AND status = 'ACTIVE'",
                {"id": parse_uuid(str(binding["signal_id"])), "tenant_id": tenant_id},
            )
            if signal is None:
                raise AppError(422, "BINDING", "Widget references a signal outside its scope.")


async def publish_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _dashboard(session, tenant_id, dashboard_id)
    widgets = (current["draft_json"] or {}).get("widgets", [])
    if not widgets:
        raise AppError(422, "EMPTY", "Dashboard has no widgets yet.")
    await _validate_widgets(session, tenant_id, widgets)
    revision = int(current["published_revision"] or 0) + 1
    await execute(
        session,
        """
        INSERT INTO dashboard_revisions (id, dashboard_id, revision, breakpoints_json, widget_configs_json, created_at, published_at)
        VALUES (:id, :dashboard_id, :revision, CAST(:breakpoints AS jsonb), CAST(:widgets AS jsonb), :now, :now)
        """,
        {"id": uuid4(), "dashboard_id": dashboard_id, "revision": revision, "breakpoints": jsonb({"lg": 12, "md": 6, "sm": 1}), "widgets": jsonb(widgets), "now": utcnow()},
    )
    await execute(
        session,
        "UPDATE dashboards SET published_revision = :revision, version = version + 1, updated_at = :now WHERE id = :id",
        {"revision": revision, "now": utcnow(), "id": dashboard_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="DASHBOARD_PUBLISH", actor_id=actor, entity_type="dashboard", entity_id=dashboard_id, before=None, after={"revision": revision}, correlation_id=correlation_id)
    return await _dashboard(session, tenant_id, dashboard_id)


async def _dashboard(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM dashboards WHERE id = :id AND tenant_id = :tenant_id",
        {"id": dashboard_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Dashboard not found.")
    row["draft"] = row.get("draft_json") or {"widgets": []}
    return row
