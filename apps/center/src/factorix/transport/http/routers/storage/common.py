"""Tenant/database guards and error mapping shared by the TDengine storage routes (R2-E B3).

Moved verbatim (dedented) from the ``build_router`` closure of ``factorix.transport.storage_api``; none of
them read a closure variable."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.storage_dsl import tenant_td_database
from factorix.modules.storage_objects import StorageObjectError
from factorix.modules.common import fetch_all, fetch_one
from factorix.platform.errors import AppError


def tenant_db(tenant_id: UUID) -> str:
    """The tenant's own TDengine database, with the configured ``tdengine_db_prefix`` (B-13)."""
    return tenant_td_database(tenant_id)


async def _assert_tenant_database_access(
    sess: AsyncSession | None, tenant_id: UUID, db_name: str | None
) -> bool:
    if not db_name:
        return False
    canonical_tenant_db = tenant_db(tenant_id)
    if db_name.lower() == canonical_tenant_db.lower():
        return True
    if sess is not None:
        row = await fetch_one(
            sess,
            "SELECT 1 FROM storage_objects WHERE tenant_id = :tenant_id AND physical_db = :db "
            "AND status <> 'PURGED' LIMIT 1",
            {"tenant_id": tenant_id, "db": db_name},
        )
        if row:
            return True
    return False


async def _require_db(sess: AsyncSession, tenant_id: UUID, db_name: str | None, what: str) -> str:
    """Tenant check for every ``?database=`` / object id (P1-13)."""
    db = db_name or tenant_db(tenant_id)
    if not await _assert_tenant_database_access(sess, tenant_id, db):
        raise AppError(404, "NOT_FOUND", f"{what} not found")
    return db


def _storage_error(exc: StorageObjectError) -> AppError:
    return AppError(
        int(getattr(exc, "http_status", 422)),
        exc.code or "STORAGE_OPERATION_FAILED",
        str(exc),
        field_errors=getattr(exc, "field_errors", None) or [],
        retryable=exc.code in ("STORAGE_ENGINE_UNAVAILABLE", "PUBLISH_FAILED"),
    )


async def _bindings_of(sess: AsyncSession, tenant_id: UUID, db: str, sub: str) -> list[dict[str, Any]]:
    rows = await fetch_all(
        sess,
        """
        SELECT b.id, b.source_kind, b.canonical_source_id, b.target_column, b.signal_id, b.model_id,
               b.model_field_path, b.row_assembly_policy, b.policy_config_json, b.status, b.source_data_type,
               m.display_name AS model_name, s.key AS signal_key
        FROM storage_bindings b
        LEFT JOIN output_groups m ON m.id = b.model_id
        LEFT JOIN signal_definitions s ON s.id = b.signal_id
        WHERE b.tenant_id = :tenant_id AND b.physical_db = :db AND b.physical_subtable = :sub
        ORDER BY b.target_column
        """,
        {"tenant_id": tenant_id, "db": db, "sub": sub},
    )
    out = []
    for r in rows:
        cfg = r.get("policy_config_json")
        if isinstance(cfg, str):
            try:
                cfg = json.loads(cfg)
            except ValueError:
                cfg = {}
        out.append({
            "id": str(r["id"]),
            "source_kind": r["source_kind"],
            "source_id": r["canonical_source_id"],
            "column_name": r["target_column"],
            "target_column": r["target_column"],
            "signal_id": str(r["signal_id"]) if r.get("signal_id") else None,
            "signal_key": r.get("signal_key"),
            "model_id": str(r["model_id"]) if r.get("model_id") else None,
            "model_name": r.get("model_name"),
            "model_field_path": r.get("model_field_path"),
            "source_path": r.get("model_field_path") or r.get("signal_key"),
            "row_assembly_policy": r["row_assembly_policy"],
            "recording_mode": (cfg or {}).get("mode", "ON_CHANGE"),
            "source_data_type": r.get("source_data_type"),
            "status": r["status"],
        })
    return out
