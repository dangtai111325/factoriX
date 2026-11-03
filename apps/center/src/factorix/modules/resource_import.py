"""Tenant-scoped preview and atomic application of resource import plans."""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.resource_import import ImportAction, ImportPlan, ModelNode, plan_resources
from factorix.modules.common import audit, fetch_all
from factorix.platform.errors import AppError

if TYPE_CHECKING:
    from factorix.modules.resources import ImportIn


class ResourceImporter:
    def __init__(self, session: AsyncSession, tenant_id: UUID, actor: UUID, correlation_id: str):
        self.session = session
        self.tenant_id = tenant_id
        self.actor = actor
        self.correlation_id = correlation_id

    async def run(self, body: ImportIn) -> dict[str, Any]:
        from factorix.modules import resources

        if not body.dry_run and body.plan_hash is None:
            raise AppError(409, "PREVIEW_REQUIRED", "Preview this import before applying it.")
        await resources._model_lock(self.session, self.tenant_id)
        plan = await self._plan(body)
        if plan.errors:
            raise AppError(422, "IMPORT_INVALID", "The import contains invalid rows.", extra={
                "row_errors": [asdict(issue) for issue in plan.errors],
                "warnings": [asdict(issue) for issue in plan.warnings],
                "items": [asdict(item) for item in plan.items],
            })
        if body.dry_run:
            return self._result(plan, dry_run=True)
        creates = [item for item in plan.items if item.action == ImportAction.CREATE]
        if body.plan_hash != plan.plan_hash and creates:
            raise AppError(409, "IMPORT_STALE", "The import preview has changed. Preview it again before applying it.")
        applied: dict[int, dict[str, Any]] = {}
        for item in plan.items:
            if item.action == ImportAction.REUSE:
                applied[item.index] = {"id": item.existing_id, "site_id": item.site_id}
                continue
            parent_id = applied[item.parent_index]["id"] if item.parent_index is not None else item.parent_id
            site_id = item.site_id
            if item.site_index is not None and item.site_index != item.index:
                site_id = applied[item.site_index]["site_id"]
            applied[item.index] = await resources.create_resource(
                self.session, self.tenant_id, self.actor,
                resources.ResourceIn(
                    type_key=item.type_key, code=item.code, name=item.name,
                    parent_id=str(parent_id) if parent_id is not None else None,
                    site_id=str(site_id) if site_id is not None else None, timezone=item.timezone,
                    description=item.description, properties=item.properties, tags=item.tags,
                    hierarchy_mode=body.hierarchy_mode,
                ),
                self.correlation_id,
            )
        if creates:
            await audit(self.session, tenant_id=self.tenant_id, actor_id=self.actor,
                        event_type="RESOURCE_IMPORT", entity_type="resource_import", entity_id=None,
                        before=None, after={"created": len(creates), "reused": len(plan.items) - len(creates),
                                            "plan_hash": plan.plan_hash}, correlation_id=self.correlation_id)
        return self._result(plan, dry_run=False, applied=applied)

    async def _plan(self, body: ImportIn) -> ImportPlan:
        params = {"tenant_id": self.tenant_id}
        rows = await fetch_all(self.session, """
            SELECT r.id, r.code, r.name, r.parent_id, r.site_id, r.status, r.version,
                   r.description, r.properties_json, r.tags_json, t.key AS type_key
            FROM resources r JOIN resource_types t ON t.id = r.type_id AND t.tenant_id = r.tenant_id
            WHERE r.tenant_id = :tenant_id ORDER BY r.id
        """, params)
        model = [ModelNode(
            id=str(row["id"]), code=row["code"], name=row["name"], type_key=row["type_key"],
            parent_id=str(row["parent_id"]) if row["parent_id"] is not None else None,
            site_id=str(row["site_id"]) if row["site_id"] is not None else None,
            archived=row["status"] == "ARCHIVED", version=row["version"],
            description=row["description"], properties=row["properties_json"], tags=row["tags_json"],
        ) for row in rows]
        catalog = await fetch_all(self.session, "SELECT key FROM resource_types WHERE tenant_id = :tenant_id", params)
        types: dict[str, set[str]] = {row["key"]: set() for row in catalog}
        pairs = await fetch_all(self.session, """
            SELECT parent_type_key, child_type_key FROM type_adjacency
            WHERE tenant_id = :tenant_id AND relation_code = 'CONTAINS'
        """, params)
        for pair in pairs:
            if pair["child_type_key"] in types:
                types[pair["child_type_key"]].add(pair["parent_type_key"])
        scopes = await fetch_all(self.session, "SELECT id, resource_id FROM sites WHERE tenant_id = :tenant_id", params)
        sites = {str(row["id"]): str(row["resource_id"]) if row["resource_id"] is not None else None for row in scopes}
        return await asyncio.to_thread(plan_resources, body.rows, model, types, sites=sites,
                                       site_id=body.site_id, default_parent_id=body.default_parent_id,
                                       hierarchy_mode=body.hierarchy_mode)

    @staticmethod
    def _result(plan: ImportPlan, *, dry_run: bool, applied: dict[int, dict[str, Any]] | None = None) -> dict[str, Any]:
        applied = applied or {}
        items = [{**asdict(item), "id": applied.get(item.index, {}).get("id", item.existing_id)} for item in plan.items]
        return {
            "dry_run": dry_run, "accepted": len(items),
            "created": 0 if dry_run else sum(item.action == ImportAction.CREATE for item in plan.items),
            "reused": sum(item.action == ImportAction.REUSE for item in plan.items),
            "plan_hash": plan.plan_hash, "items": items,
            "warnings": [asdict(issue) for issue in plan.warnings],
        }
