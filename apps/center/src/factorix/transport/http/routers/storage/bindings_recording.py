"""Recording status, subtable bindings and the unified binding-source picker
(``/storage/recording/status``, ``/storage/td/bindings``, ``/storage/sources``)
(R2-E B3, moved verbatim from ``factorix.transport.storage_api``)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import storage_model_recorder as SMR
from factorix.modules.common import fetch_all, iso_ms

from factorix.transport.http.routers.storage.common import _bindings_of, _require_db, tenant_db
from factorix.transport.http.routers.storage.context import StorageRouterContext


def register(router: APIRouter, ctx: StorageRouterContext) -> None:
    """Register the recording/binding routes (original relative order)."""
    admin_dep = ctx.admin_dep
    db_dep = ctx.db_dep
    ids = ctx.ids
    binding_service = ctx.binding_service

    @router.get("/api/v1/storage/recording/status", tags=["storage"])
    async def recording_status(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Managed writer health: outbox pending/failed, last write, errors (guide H12.3)."""
        tenant_id, _actor = ids(principal)
        return await SMR.recording_status(session, tenant_id)

    @router.get("/api/v1/storage/recording/failures", tags=["storage"])
    async def recording_failures(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Which subtables have rows the writer could not store, and why (R2-07: the KPI
        "N with write errors" links here). Purged objects are not listed (their rows cannot be
        written any more and are discarded on purge)."""
        tenant_id, _actor = ids(principal)
        rows = await fetch_all(
            session,
            """
            SELECT x.physical_db, x.physical_subtable, o.display_name, o.status AS object_status,
                   COUNT(*) AS failed, MIN(x.created_at) AS first_failed_at, MAX(x.created_at) AS last_failed_at,
                   (ARRAY_AGG(x.last_error ORDER BY x.created_at DESC))[1] AS last_error,
                   MAX(x.attempts) AS attempts
            FROM storage_record_outbox x
            JOIN storage_objects o ON o.tenant_id = x.tenant_id AND o.object_type = 'subtable'
             AND o.physical_db = x.physical_db AND o.physical_name = x.physical_subtable AND o.status <> 'PURGED'
            WHERE x.tenant_id = :tenant_id AND x.status = 'FAILED'
            GROUP BY x.physical_db, x.physical_subtable, o.display_name, o.status
            ORDER BY MAX(x.created_at) DESC
            LIMIT 200
            """,
            {"tenant_id": tenant_id},
        )
        items = [{
            "object_id": f"subtable:{r['physical_db']}.{r['physical_subtable']}",
            "database": r["physical_db"],
            "subtable": r["physical_subtable"],
            "display_name": r.get("display_name") or r["physical_subtable"],
            "object_status": r.get("object_status"),
            "failed": int(r.get("failed") or 0),
            "attempts": int(r.get("attempts") or 0),
            "last_error": r.get("last_error"),
            "first_failed_at": iso_ms(r["first_failed_at"]) if r.get("first_failed_at") else None,
            "last_failed_at": iso_ms(r["last_failed_at"]) if r.get("last_failed_at") else None,
        } for r in rows]
        return {"items": items, "total": len(items)}

    @router.get("/api/v1/storage/td/bindings", tags=["storage"])
    async def list_td_bindings(
        target: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Bindings of one subtable (``target=db.subtable``) or of the whole tenant."""
        tenant_id, _actor = ids(principal)
        if target:
            ref = target.split(":", 1)[1] if target.startswith("subtable:") else target
            db, sub = ref.split(".", 1) if "." in ref else (tenant_db(tenant_id), ref)
            await _require_db(session, tenant_id, db, "Subtable")
            items = await _bindings_of(session, tenant_id, db, sub)
            return {"items": items, "total": len(items)}
        rows = await fetch_all(
            session,
            "SELECT physical_db, physical_subtable FROM storage_bindings WHERE tenant_id = :tenant_id "
            "AND status = 'ACTIVE' GROUP BY physical_db, physical_subtable ORDER BY 1, 2 LIMIT 1000",
            {"tenant_id": tenant_id},
        )
        items: list[dict[str, Any]] = []
        for r in rows:
            for b in await _bindings_of(session, tenant_id, r["physical_db"], r["physical_subtable"]):
                items.append({**b, "database": r["physical_db"], "subtable": r["physical_subtable"]})
        return {"items": items, "total": len(items)}

    # --- Unified Sources Discovery ---

    @router.get("/api/v1/storage/sources", tags=["storage"])
    async def get_storage_sources(
        view: str = Query("hierarchy", pattern="^(hierarchy|collector|models)$"),
        search: str | None = None,
        limit: int = 100,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        return await binding_service.list_sources(
            session, tenant_id, view=view, search=search, limit=limit
        )
