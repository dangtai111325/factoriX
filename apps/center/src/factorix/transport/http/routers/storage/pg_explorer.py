"""PostgreSQL read-only explorer routes ``/api/v1/storage/pg/*`` (R2-E B3, moved verbatim from
``factorix.transport.storage_api``)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import iso_ms, utcnow
from factorix.platform.errors import AppError

from factorix.transport.http.routers.storage.context import StorageRouterContext


def register(router: APIRouter, ctx: StorageRouterContext) -> None:
    """Register the PostgreSQL explorer routes (original order)."""
    admin_dep = ctx.admin_dep
    db_dep = ctx.db_dep
    ids = ctx.ids
    pg_explorer = ctx.pg_explorer

    # --- PostgreSQL Read-Only Explorer ---

    @router.get("/api/v1/storage/pg/schemas", tags=["storage"])
    async def list_pg_schemas(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> list[dict[str, Any]]:
        return await pg_explorer.list_schemas(session)

    @router.get("/api/v1/storage/pg/tables", tags=["storage"])
    async def list_pg_tables(
        schema: str = "public",
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> list[dict[str, Any]]:
        return await pg_explorer.list_tables(session, schema=schema)

    @router.get("/api/v1/storage/pg/tables/{schema}/{table}", tags=["storage"])
    async def get_pg_table_detail(
        schema: str,
        table: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        res = await pg_explorer.get_table_details(session, table=table, schema=schema)
        if not res:
            raise AppError(404, "NOT_FOUND", f"Table '{schema}.{table}' not found")
        return res

    @router.get("/api/v1/storage/pg/relationships", tags=["storage"])
    async def get_pg_relationships(
        schema: str = "public",
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tables = await pg_explorer.list_tables(session, schema=schema)
        rels = await pg_explorer.list_relationships(session, schema=schema)
        return {
            "tables": tables,
            "relationships": rels,
            "source": "postgresql",
            "observed_at": iso_ms(utcnow()),
        }

    @router.get("/api/v1/storage/pg/count/{schema}/{table}", tags=["storage"])
    async def count_pg_rows(
        schema: str,
        table: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """"Count exactly" (R1-35): ``count(*)`` in a read-only transaction, 10 s timeout (504 COUNT_TIMEOUT),
        tenant-scoped like the preview; credential / session / audit tables answer 403."""
        tenant_id, _actor = ids(principal)
        return await pg_explorer.count_rows(session, table=table, schema=schema, tenant_id=tenant_id)

    @router.get("/api/v1/storage/pg/preview/{schema}/{table}", tags=["storage"])
    @router.get("/api/v1/storage/pg/preview", tags=["storage"])
    async def get_pg_preview(
        schema: str = "public",
        table: str | None = None,
        limit: int = 50,
        offset: int = 0,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if not table:
            raise AppError(400, "MISSING_TABLE", "Query parameter 'table' is required.")
        return await pg_explorer.preview_data(
            session, table=table, schema=schema, limit=limit, offset=offset, tenant_id=tenant_id
        )
