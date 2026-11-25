"""Physical-first TDengine object routes: engines, topology/catalog/stats, databases, supertables, subtables
(single + bulk), summary, templates, object detail/metadata/alter/lifecycle/purge
(R2-E B3, moved verbatim from ``factorix.transport.storage_api``)."""

from __future__ import annotations

import json
import re
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, Header, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import storage_model_recorder as SMR
from factorix.modules import storage_bulk as SBULK
from factorix.modules import storage_topology as ST
from factorix.modules.storage_objects import (
    MAX_DESCRIPTION_LEN,
    StorageObjectError,
    is_system_stable,
    is_system_subtable,
    validate_identifier,
)
from factorix.modules.common import execute, fetch_all, fetch_one, iso_ms, utcnow
from factorix.platform.errors import AppError
from factorix_core.contracts.notify import Channel, ConfigChanged
from factorix.platform.tdengine import is_missing_object_error, quote_str

from factorix.transport.http.routers.storage.common import _assert_tenant_database_access, _bindings_of, _require_db, _storage_error, tenant_db
from factorix.transport.http.routers.storage.context import StorageRouterContext


_is_missing_td_error = is_missing_object_error  # B-14: one shared list (platform.tdengine)


async def _registry(sess: AsyncSession, tenant_id: UUID, kind: str | None, db: str, name: str) -> dict[str, Any] | None:
    return await fetch_one(
        sess,
        """
        SELECT id, object_type, physical_db, physical_name, parent_name, display_name, description,
               status, schema_json, tags_json, recording_json, revision, created_at, updated_at
        FROM storage_objects
        WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_name = :name
          AND (CAST(:kind AS text) IS NULL OR object_type = :kind) AND status <> 'PURGED'
        ORDER BY updated_at DESC LIMIT 1
        """,
        {"tenant_id": tenant_id, "db": db, "name": name, "kind": kind},
    )


def _json_field(raw: Any, default: Any) -> Any:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return default
    return raw if raw is not None else default


def _retention_days(keep: Any) -> int | None:
    """Days of the last ``KEEP`` tier as TDengine reports it (``'30d,30d,30d'``, ``'5256000m'``, ``'3650d'``)."""
    last = str(keep or "").split(",")[-1].strip().lower()
    m = re.fullmatch(r"(\d+)([dhm]?)", last)
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2) or "d"
    return {"d": n, "h": n // 24, "m": n // 1440}[unit]


def _column_payload(c: Any) -> dict[str, Any]:
    """One column of a supertable as TDengine describes it (R2-13: real ``nullable``)."""
    return {"name": c.name, "td_type": c.td_type, "length": c.length, "nullable": c.nullable,
            "role": "timestamp" if c.role == "time_key" else c.role, "primary_key": c.primary_key}


def _drift(registry: dict[str, Any], physical_columns: list[Any], system: bool) -> str:
    """``SYSTEM`` | ``UNMANAGED`` (not created through FactoriX) | ``OK`` | ``SCHEMA_MISMATCH`` (B-12:
    computed from the registry and the physical schema instead of a fixed ``"OK"``)."""
    if system:
        return "SYSTEM"
    if not registry:
        return "UNMANAGED"
    want = [str(c.get("name")) for c in _json_field(registry.get("schema_json"), []) if isinstance(c, dict)]
    if want and want != [c.name for c in physical_columns][: len(want)]:
        return "SCHEMA_MISMATCH"
    return "OK"


def _checked_name(name: str | None, what: str) -> str:
    """Identifier taken from a URL: validated before it reaches any SQL text (B-10 / B-11)."""
    try:
        validate_identifier(str(name or ""), what)
    except StorageObjectError as exc:
        raise AppError(404, "NOT_FOUND", f"Storage object '{name}' not found") from exc
    return str(name)


async def _database_payload(sess: AsyncSession, tenant_id: UUID, d: Any) -> dict[str, Any]:
    """Database detail from TDengine (precision, KEEP, vgroups, replica, cache model, counts) and the
    registry (display name, description, status) — R2-06 / B-12 (no fixed values)."""
    reg = await _registry(sess, tenant_id, "database", d.name, d.name) or {}
    tenant = d.name == tenant_db(tenant_id)
    now_iso = iso_ms(utcnow())
    created = reg.get("created_at")
    return {
        "id": d.name,
        "object_id": f"db:{d.name}",
        "object_type": "database",
        "physical_name": d.name,
        "display_name": reg.get("display_name") or d.name,
        "description": reg.get("description") or "",
        "precision": d.precision,
        "keep": d.keep,
        "retention_days": _retention_days(d.keep),
        "vgroups": d.vgroups,
        "replica": d.replica,
        "cache_model": d.cache_model,
        "status": str(reg.get("status") or "ACTIVE"),
        "stable_count": d.stable_count,
        "subtable_count": d.subtable_count,
        "table_count": d.ntables,
        "is_tenant_default": tenant,
        "is_system": tenant,
        "managed": bool(reg) or tenant,
        "owner": "FactoriX (tenant database)" if tenant else "user",
        "revision": int(reg.get("revision") or 1),
        "created_at": iso_ms(created) if created else None,
        "tenant_id": str(tenant_id),
        "observed_at": now_iso,
        "last_verified_at": now_iso,
    }


async def _recording_summary(
    sess: AsyncSession, tenant_id: UUID, db: str, name: str, registry: dict[str, Any], bindings: list[dict[str, Any]],
) -> dict[str, Any]:
    """What the subtable page shows in RECORDING (R2-12): mode, state, last write, writer backlog."""
    cfg = _json_field(registry.get("recording_json"), {}) or {}
    status = str(registry.get("status") or ("ACTIVE" if registry else "UNMANAGED"))
    active = [b for b in bindings if b.get("status") == "ACTIVE"]
    if not registry:
        state = "NOT_MANAGED"
    elif status == "ACTIVE" and active:
        state = "RECORDING"
    elif status == "ACTIVE":
        state = "NO_BINDING"
    else:
        state = status  # PAUSED | RETIRED
    row = await fetch_one(
        sess,
        """
        SELECT COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
               COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
               COUNT(*) FILTER (WHERE status = 'CONFIRMED') AS written,
               MAX(confirmed_at) AS last_write_at,
               MAX(created_at) FILTER (WHERE status = 'FAILED') AS last_failed_at
        FROM storage_record_outbox
        WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_subtable = :name
        """,
        {"tenant_id": tenant_id, "db": db, "name": name},
    ) if registry else None
    err = await fetch_one(
        sess,
        "SELECT last_error FROM storage_record_outbox WHERE tenant_id = :tenant_id AND physical_db = :db "
        "AND physical_subtable = :name AND status = 'FAILED' ORDER BY created_at DESC LIMIT 1",
        {"tenant_id": tenant_id, "db": db, "name": name},
    ) if row and int(row.get("failed") or 0) else None
    row = row or {}
    return {
        "mode": cfg.get("mode") or (active[0].get("recording_mode") if active else None),
        "row_assembly": cfg.get("row_assembly"),
        "state": state,
        "bindings_active": len(active),
        "rows_written": int(row.get("written") or 0),
        "pending": int(row.get("pending") or 0),
        "failed": int(row.get("failed") or 0),
        "last_write_at": iso_ms(row["last_write_at"]) if row.get("last_write_at") else None,
        "last_failed_at": iso_ms(row["last_failed_at"]) if row.get("last_failed_at") else None,
        "last_error": (err or {}).get("last_error"),
    }


def _summary_keys(summary: dict[str, Any]) -> dict[str, Any]:
    """The summary fields WS-D reads inside ``recording`` (WS-D-S1): additive to recording_json."""
    return {k: summary[k] for k in ("state", "last_write_at", "pending", "failed", "last_error", "rows_written")}


def _effective_bindings(bindings: list[dict[str, Any]], object_status: str) -> list[dict[str, Any]]:
    """A binding of a paused / retired subtable does not record (R2-12: was shown "Active")."""
    out = []
    for b in bindings:
        eff = b.get("status")
        if eff == "ACTIVE" and object_status in ("PAUSED", "RETIRED"):
            eff = object_status
        out.append({**b, "effective_status": eff})
    return out


def _assert_user_object(kind: str, db: str, name: str | None, tenant_id: UUID, action: str) -> None:
    """FactoriX system objects are read-only in the Storage UI (R1-16)."""
    if kind == "database" and (name or db) == tenant_db(tenant_id):
        if action in ("drop", "retire", "alter"):
            raise AppError(403, "SYSTEM_OBJECT", "The tenant database is managed by FactoriX and cannot be changed here.")
    if kind == "stable" and is_system_stable(name):
        raise AppError(403, "SYSTEM_OBJECT", f"'{name}' is a FactoriX system supertable (operational history); it is read-only.")
    if kind in ("subtable", "table") and is_system_subtable(name):
        raise AppError(403, "SYSTEM_OBJECT", f"'{name}' is a FactoriX system table; it is read-only.")


def register(router: APIRouter, ctx: StorageRouterContext) -> None:
    """Register the TDengine object routes (original relative order)."""
    admin_dep = ctx.admin_dep
    db_dep = ctx.db_dep
    ids = ctx.ids
    topology_inspector = ctx.topology_inspector
    revision_service = ctx.revision_service

    # ==========================================================================
    # Physical-First TDengine & PostgreSQL Storage APIs
    # ==========================================================================

    async def _create_object(
        sess: AsyncSession, tenant_id: UUID, actor_id: UUID | None, kind: str, body: dict[str, Any],
        idem: str | None,
    ) -> dict[str, Any]:
        try:
            draft = await revision_service.create_draft(sess, tenant_id, actor_id, {"kind": kind, "spec": body})
            res = await revision_service.publish_draft(
                sess, tenant_id, UUID(draft["id"]), actor_id, idempotency_key=idem or body.get("idempotency_key"),
            )
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc
        SMR.invalidate_bindings(tenant_id)
        return {
            "id": res["operation_id"],
            "operation_id": res["operation_id"],
            "status": res["status"],
            "object_type": kind,
            "object_key": res.get("object_key"),
            "object_name": body.get("physical_name") or body.get("name"),
            "idempotent_replay": bool(res.get("idempotent_replay")),
            "ddl": res.get("ddl", []),
            "verification": res.get("verification"),
            "created_at": iso_ms(utcnow()),
        }

    async def _resolve_kind(db: str, name: str, hint: str) -> str:
        """``stable`` or ``subtable`` from TDengine for ``db.name`` ids (the parser only knows 'table')."""
        if hint in ("stable", "subtable"):
            return hint
        _checked_name(db, "database name")
        _checked_name(name, "table name")
        try:
            rows = await revision_service._td_read(
                "SELECT stable_name FROM information_schema.ins_stables "
                f"WHERE db_name = {quote_str(db)} AND stable_name = {quote_str(name)}"
            )
        except Exception:  # noqa: BLE001
            rows = []
        return "stable" if rows else "subtable"

    @router.get("/api/v1/storage/engines", tags=["storage"])
    async def get_storage_engines(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        info = await topology_inspector.get_engines_info(session)
        now_iso = iso_ms(utcnow())
        td_healthy = info["tdengine"]["healthy"]
        td_version = info["tdengine"]["version"]
        pg_healthy = info.get("postgresql", {}).get("healthy", True)
        pg_raw_ver = info.get("postgresql", {}).get("version", "PostgreSQL (unknown)")
        pg_version = (
            f"PostgreSQL {pg_raw_ver}"
            if pg_raw_ver and not str(pg_raw_ver).lower().startswith("postgresql")
            else str(pg_raw_ver or "PostgreSQL")
        )
        return {
            "tdengine": {
                "reachable": td_healthy,
                "version": td_version,
                "last_checked_at": now_iso,
                "features": info["tdengine"]["features"],
            },
            "postgresql": {
                "reachable": pg_healthy,
                "version": pg_version,
                "last_checked_at": now_iso,
            },
        }

    @router.get("/api/v1/storage/td/topology", tags=["storage"])
    async def get_td_topology(
        database: str | None = None,
        depth: int = 2,
        cursor: str | None = None,
        show_bindings: bool = False,
        include_subtable_tags: bool = True,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        snap = await topology_inspector.get_topology(
            tenant_id,
            database=database,
            depth=depth,
            cursor=cursor,
            session=session,
            include_subtable_tags=include_subtable_tags,
        )
        return ST.topology_snapshot_to_dict(snap)

    @router.get("/api/v1/storage/td/catalog", tags=["storage"])
    async def get_td_catalog(
        object_type: Literal["database", "stable", "subtable"] | None = None,
        status: Literal["ACTIVE", "PAUSED", "RETIRED", "DRAFT", "OUT_OF_SYNC", "ERROR"] | None = None,
        search: str = Query("", max_length=200),
        page: int = Query(1, ge=1),
        page_size: int = Query(15, ge=1, le=100),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        rows, total = await topology_inspector.list_catalog(
            tenant_id, session, object_type=object_type, status=status, search=search, page=page, page_size=page_size,
        )
        observed_at = iso_ms(utcnow())
        return {
            "items": [{**row, "last_verified_at": observed_at} for row in rows],
            "total": total,
        }

    @router.get("/api/v1/storage/td/stats", tags=["storage"])
    async def get_td_stats(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id, await ST.registered_databases(session, tenant_id))
        db_count = len(dbs)
        total_stables = sum(d.stable_count for d in dbs)
        total_subtables = sum(d.subtable_count for d in dbs)

        # "Recording" = registered subtables that are ACTIVE and have at least one ACTIVE binding;
        # errors = subtables with FAILED outbox rows (writer could not store them).
        rows = await fetch_all(
            session,
            """
            SELECT o.status,
                   COUNT(*) FILTER (WHERE EXISTS (
                       SELECT 1 FROM storage_bindings b WHERE b.tenant_id = o.tenant_id
                         AND b.physical_db = o.physical_db AND b.physical_subtable = o.physical_name
                         AND b.status = 'ACTIVE')) AS bound
            FROM storage_objects o
            WHERE o.tenant_id = :tenant_id AND o.object_type = 'subtable' AND o.status <> 'PURGED'
            GROUP BY o.status
            """,
            {"tenant_id": tenant_id},
        )
        status_map = {r["status"]: int(r["bound"] or 0) for r in rows}
        active_cnt = status_map.get("ACTIVE", 0)
        paused_cnt = status_map.get("PAUSED", 0)
        # R2-07: only objects that still exist count, and the KPI says which ones they are.
        err_rows = await ST.recording_error_subtables(session, tenant_id, limit=200)
        error_cnt = len(err_rows)

        return {
            "database_count": db_count,
            "stable_count": total_stables,
            "subtable_count": total_subtables,
            "recording_active": active_cnt,
            "recording_paused": paused_cnt,
            "recording_error": error_cnt,
            "recording_error_objects": [f"{db}.{sub}" for db, sub in err_rows[:50]],
            "observed_at": iso_ms(utcnow()),
        }

    @router.get("/api/v1/storage/td/databases", tags=["storage"])
    async def list_td_databases(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        dbs = await topology_inspector.list_databases(tenant_id, await ST.registered_databases(session, tenant_id))
        labels = {
            str(r["physical_name"]): r for r in await fetch_all(
                session,
                "SELECT physical_name, display_name, description FROM storage_objects "
                "WHERE tenant_id = :tenant_id AND object_type = 'database' AND status <> 'PURGED'",
                {"tenant_id": tenant_id},
            )
        }
        now_iso = iso_ms(utcnow())
        items = []
        for d in dbs:
            reg = labels.get(d.name) or {}
            retention_days = _retention_days(d.keep)
            items.append({
                "id": d.name,
                "object_id": f"db:{d.name}",
                "physical_name": d.name,
                "display_name": reg.get("display_name") or d.name,
                "description": reg.get("description") or "",
                "precision": d.precision,
                "keep": d.keep,
                "retention_days": retention_days,
                "vgroups": d.vgroups,
                "status": "ACTIVE",
                "stable_count": d.stable_count,
                "subtable_count": d.subtable_count,
                "is_tenant_default": d.is_tenant,
                "is_system": d.is_tenant,
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
            })
        return {"items": items, "total": len(items), "page": 1, "page_size": len(items)}

    @router.get("/api/v1/storage/td/databases/{name}", tags=["storage"])
    async def get_td_database(
        name: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if name.startswith("db:"):
            name = name[3:]
        if not await _assert_tenant_database_access(session, tenant_id, name):
            raise AppError(404, "NOT_FOUND", f"Database '{name}' not found")
        d = await topology_inspector.get_database(name)
        if not d:
            raise AppError(404, "NOT_FOUND", f"Database '{name}' not found")
        return await _database_payload(session, tenant_id, d)

    @router.post("/api/v1/storage/td/databases", status_code=202, tags=["storage"])
    async def create_td_database(
        body: dict[str, Any] = Body(...),
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        return await _create_object(session, tenant_id, actor_id, "database", body, idempotency_key)

    @router.get("/api/v1/storage/td/stables", tags=["storage"])
    async def list_td_stables(
        database: str | None = None,
        cursor: str | None = None,
        search: str | None = None,
        include_system: bool = True,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if database:
            target_dbs = [await _require_db(session, tenant_id, database, f"Database '{database}'")]
        else:
            target_dbs = [d.name for d in await topology_inspector.list_databases(
                tenant_id, await ST.registered_databases(session, tenant_id))]
        reg_rows = await fetch_all(
            session,
            "SELECT physical_db, physical_name, display_name, description, recording_json FROM storage_objects "
            "WHERE tenant_id = :tenant_id AND object_type = 'stable' AND status <> 'PURGED'",
            {"tenant_id": tenant_id},
        )
        reg = {(str(r["physical_db"]), str(r["physical_name"])): r for r in reg_rows}
        now_iso = iso_ms(utcnow())
        items = []
        for db_name in target_dbs:
            for st in await topology_inspector.list_stables(db_name):
                system = is_system_stable(st.name)
                if search and search.lower() not in st.name.lower():
                    continue
                if system and not include_system:
                    continue
                r = reg.get((st.database, st.name)) or {}
                items.append({
                    "id": f"{st.database}.{st.name}",
                    "database_id": st.database,
                    "database_name": st.database,
                    "physical_name": st.name,
                    "display_name": r.get("display_name") or st.name,
                    "description": r.get("description") or "",
                    "columns": [_column_payload(c) for c in st.columns],
                    "tags": [{"name": t.name, "td_type": t.td_type, "length": t.length} for t in st.tags],
                    "subtable_count": st.subtable_count,
                    "suggested_prefix": None if system else SBULK.suggested_subtable_prefix(st.name),
                    "status": "ACTIVE",
                    "is_system": system,
                    "managed": bool(r),
                    "recording": _json_field(r.get("recording_json"), {}),
                    "tenant_id": str(tenant_id),
                    "observed_at": now_iso,
                })
        return {"items": items, "total": len(items), "page": 1, "page_size": len(items)}

    @router.get("/api/v1/storage/td/stables/{stable_id:path}", tags=["storage"])
    async def get_td_stable(
        stable_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if "." in stable_id:
            db_name, sname = stable_id.split(".", 1)
        else:
            db_name = tenant_db(tenant_id)
            sname = stable_id
        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Supertable '{stable_id}' not found")
        st = await topology_inspector.get_stable(db_name, _checked_name(sname, "supertable name"))
        if not st or not st.columns:
            raise AppError(404, "NOT_FOUND", f"Supertable '{stable_id}' not found")
        r = await _registry(session, tenant_id, "stable", db_name, sname) or {}
        now_iso = iso_ms(utcnow())
        system = is_system_stable(st.name)
        return {
            "id": f"{st.database}.{st.name}",
            "database_id": st.database,
            "database_name": st.database,
            "physical_name": st.name,
            "display_name": r.get("display_name") or st.name,
            "description": r.get("description") or "",
            "columns": [_column_payload(c) for c in st.columns],
            "tags": [{"name": t.name, "td_type": t.td_type, "length": t.length} for t in st.tags],
            "subtable_count": st.subtable_count,
            "suggested_prefix": None if system else SBULK.suggested_subtable_prefix(st.name),
            "status": str(r.get("status") or "ACTIVE"),
            "managed": bool(r),
            "is_system": system,
            "recording": _json_field(r.get("recording_json"), {}),
            "tenant_id": str(tenant_id),
            "observed_at": now_iso,
            "last_verified_at": now_iso,
            "drift_status": _drift(r, st.columns, system),
        }

    @router.post("/api/v1/storage/td/stables", status_code=202, tags=["storage"])
    async def create_td_stable(
        body: dict[str, Any] = Body(...),
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        body = dict(body)
        body["database"] = await _require_db(
            session, tenant_id, body.get("database") or body.get("database_name"), "Database"
        )
        return await _create_object(session, tenant_id, actor_id, "stable", body, idempotency_key)

    @router.get("/api/v1/storage/td/templates", tags=["storage"])
    async def stable_templates(principal: dict[str, Any] = Depends(admin_dep)) -> dict[str, Any]:
        """Generic supertable column templates (no customer data): per-field change history."""
        audit = [
            {"name": "ts", "td_type": "TIMESTAMP", "role": "timestamp"},
            {"name": "event_key", "td_type": "VARCHAR", "length": 64, "primary_key": True},
            {"name": "source_timestamp", "td_type": "TIMESTAMP"},
            {"name": "publish_timestamp", "td_type": "TIMESTAMP"},
            {"name": "field_source_timestamp", "td_type": "TIMESTAMP"},
            {"name": "quality", "td_type": "VARCHAR", "length": 16},
            {"name": "quality_reason", "td_type": "VARCHAR", "length": 128},
            {"name": "is_null", "td_type": "BOOL"},
            {"name": "model_ref", "td_type": "VARCHAR", "length": 36},
            {"name": "model_field_path", "td_type": "VARCHAR", "length": 128},
            {"name": "model_revision", "td_type": "INT"},
            {"name": "data_epoch", "td_type": "BIGINT"},
            {"name": "source_event_uid", "td_type": "VARCHAR", "length": 256},
            {"name": "time_basis", "td_type": "VARCHAR", "length": 24},
        ]
        event_audit = [c for c in audit if c["name"] not in ("field_source_timestamp", "is_null", "model_field_path")]
        return {"items": [
            {
                "id": "field_change_history",
                "name": "Per-field change history",
                "description": "One subtable per Data Model field; audit columns + typed value columns. Recording: on change.",
                "columns": audit,
                "value_columns": [
                    {"name": "value_f64", "td_type": "DOUBLE"},
                    {"name": "value_i64", "td_type": "BIGINT"},
                    {"name": "value_text", "td_type": "VARCHAR", "length": 256},
                ],
                "tags": [
                    {"name": "machine_ref", "td_type": "VARCHAR", "length": 36},
                    {"name": "line_ref", "td_type": "VARCHAR", "length": 36},
                    {"name": "field_key", "td_type": "VARCHAR", "length": 64},
                ],
                "recording_mode": "ON_CHANGE",
            },
            {
                "id": "atomic_event",
                "name": "Atomic event stream",
                "description": "One row per completed event with several business fields. Recording: on new event.",
                "columns": event_audit,
                "value_columns": [],
                "tags": [
                    {"name": "zone_ref", "td_type": "VARCHAR", "length": 36},
                    {"name": "line_ref", "td_type": "VARCHAR", "length": 36},
                ],
                "recording_mode": "ON_NEW_EVENT",
            },
        ]}

    @router.post("/api/v1/storage/td/stables/validate", tags=["storage"])
    async def validate_td_stable(
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        if not body.get("database"):
            body["database"] = body.get("database_name") or tenant_db(tenant_id)
        v_res = await revision_service.validate_draft(
            session, tenant_id, uuid4(), custom_spec={"kind": "stable", "spec": body}
        )
        return {
            "valid": v_res["valid"],
            "errors": [
                {"field": e.get("field", "columns"), "message": e.get("message", "Validation error")}
                for e in v_res.get("errors", [])
            ],
            "warnings": v_res.get("warnings", []),
        }

    @router.get("/api/v1/storage/td/subtables", tags=["storage"])
    async def list_td_subtables(
        stable: str | None = None,
        database: str | None = None,
        cursor: str | None = None,
        search: str | None = None,
        status: str | None = None,
        limit: int = Query(50, ge=1, le=500),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if stable and "." in stable and not database:
            database, stable = stable.split(".", 1)
        target_db = await _require_db(session, tenant_id, database, f"Database '{database}'")
        try:
            subs, next_cur = await topology_inspector.list_subtables(
                target_db, stable_name=stable, cursor=cursor, limit=limit, search=search,
            )
            total = await topology_inspector.count_subtables(target_db, stable, search)
        except ValueError as exc:
            raise AppError(422, "INVALID_PARAMETER", str(exc)) from exc
        reg_rows = await fetch_all(
            session,
            """
            SELECT o.physical_name, o.display_name, o.status, o.recording_json,
                   (SELECT COUNT(*) FROM storage_bindings b WHERE b.tenant_id = o.tenant_id
                      AND b.physical_db = o.physical_db AND b.physical_subtable = o.physical_name
                      AND b.status = 'ACTIVE') AS binding_count
            FROM storage_objects o
            WHERE o.tenant_id = :tenant_id AND o.object_type = 'subtable' AND o.physical_db = :db
              AND o.status <> 'PURGED' AND o.physical_name = ANY(:names)
            """,
            {"tenant_id": tenant_id, "db": target_db, "names": [s.name for s in subs]},
        ) if subs else []
        reg = {str(r["physical_name"]): r for r in reg_rows}
        now_iso = iso_ms(utcnow())
        items = []
        for s in subs:
            r = reg.get(s.name) or {}
            st_value = str(r.get("status") or "ACTIVE")
            if status and st_value != status:
                continue
            items.append({
                "id": f"{s.database}.{s.name}",
                "stable_id": f"{s.database}.{s.stable_name}",
                "stable_name": s.stable_name,
                "database_id": s.database,
                "database_name": s.database,
                "physical_name": s.name,
                "display_name": r.get("display_name") or s.name,
                "tag_values": [{"name": k, "value": None if v is None else str(v)} for k, v in s.tags.items()],
                "binding_count": int(r.get("binding_count") or 0),
                "status": st_value,
                "managed": bool(r),
                "is_system": is_system_subtable(s.name),
                "write_active": bool(r) and st_value == "ACTIVE" and int(r.get("binding_count") or 0) > 0,
                "recording": _json_field(r.get("recording_json"), {}),
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
            })
        return {"items": items, "total": total, "cursor": next_cur, "next_cursor": next_cur, "page_size": limit}

    @router.get("/api/v1/storage/td/subtables/{subtable_id:path}", tags=["storage"])
    async def get_td_subtable(
        subtable_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        if subtable_id.startswith("subtable:"):
            subtable_id = subtable_id[len("subtable:"):]
        db_name, tname = subtable_id.split(".", 1) if "." in subtable_id else (tenant_db(tenant_id), subtable_id)
        await _require_db(session, tenant_id, db_name, f"Subtable '{subtable_id}'")
        try:
            sub = await topology_inspector.get_subtable(db_name, tname)
        except ValueError as exc:
            raise AppError(404, "NOT_FOUND", f"Subtable '{subtable_id}' not found") from exc
        if not sub:
            raise AppError(404, "NOT_FOUND", f"Subtable '{subtable_id}' not found")
        r = await _registry(session, tenant_id, "subtable", db_name, tname) or {}
        bindings = await _bindings_of(session, tenant_id, db_name, tname)
        st_value = str(r.get("status") or "ACTIVE")
        summary = await _recording_summary(session, tenant_id, db_name, tname, r, bindings)
        bindings = _effective_bindings(bindings, st_value)
        return {
            "id": f"{sub.database}.{sub.name}",
            "stable_id": f"{sub.database}.{sub.stable_name}",
            "stable_name": sub.stable_name,
            "database_id": sub.database,
            "database_name": sub.database,
            "physical_name": sub.name,
            "display_name": r.get("display_name") or sub.name,
            "description": r.get("description") or "",
            "tag_values": [{"name": k, "value": None if v is None else str(v)} for k, v in sub.tags.items()],
            "bindings": bindings,
            "status": st_value,
            "managed": bool(r),
            "is_system": is_system_subtable(sub.name),
            "write_active": bool(r) and st_value == "ACTIVE" and bool(bindings),
            "recording": {**(_json_field(r.get("recording_json"), {}) or {}), **_summary_keys(summary)},
            "recording_summary": summary,
            "tenant_id": str(tenant_id),
            "observed_at": iso_ms(utcnow()),
        }

    @router.post("/api/v1/storage/td/subtables", status_code=202, tags=["storage"])
    async def create_td_subtable(
        body: dict[str, Any] = Body(...),
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        body = dict(body)
        stable_ref = str(body.get("stable") or body.get("stable_id") or "")
        if "." in stable_ref:
            body["database"], body["stable"] = stable_ref.split(".", 1)
        body["database"] = await _require_db(session, tenant_id, body.get("database"), "Database")
        return await _create_object(session, tenant_id, actor_id, "subtable", body, idempotency_key)

    @router.post("/api/v1/storage/td/subtables/bulk", tags=["storage"])
    async def bulk_create_td_subtables(
        response: Response,
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Create many subtables with the same rules as the wizard saga (R2-04 / R2-05 / WS-P P6).

        ``dry_run: true`` (max 50 rows): validate + plan in the request, result per row VALID | INVALID |
        EXISTS | FAILED. Otherwise (max 1000 rows): **202** with a background job (its own TDengine
        connection, one job at a time, chunks of 50) — poll ``GET /api/v1/storage/td/bulk-jobs/{job_id}``
        for progress and the per-row results CREATED | EXISTS | INVALID | FAILED. Each row has its own
        idempotency key (``bulk:<db>.<name>:<spec hash>``), so a resubmitted job never duplicates.
        """
        tenant_id, actor_id = ids(principal)
        rows = [r for r in (body.get("rows") or []) if isinstance(r, dict)]
        if not rows:
            raise AppError(422, "VALIDATION_FAILED", "No rows to create.")
        if bool(body.get("dry_run")):
            if len(rows) > SBULK.MAX_ROWS:
                raise AppError(422, "TOO_MANY_ROWS", f"Validate at most {SBULK.MAX_ROWS} rows per request.")

            async def resolve_db(name: str | None) -> str:
                return await _require_db(session, tenant_id, name, "Database")

            return await SBULK.BulkSubtableCreator(revision_service).run(
                session, tenant_id, actor_id, rows, dry_run=True, resolve_db=resolve_db,
            )
        if len(rows) > SBULK.MAX_JOB_ROWS:
            raise AppError(422, "TOO_MANY_ROWS", f"At most {SBULK.MAX_JOB_ROWS} rows per job.")

        def resolve_factory(job_session: AsyncSession) -> Any:
            async def resolve_db(name: str | None) -> str:
                return await _require_db(job_session, tenant_id, name, "Database")
            return resolve_db

        job = SBULK.submit_job(tenant_id, actor_id, rows, resolve_factory=resolve_factory)
        response.status_code = 202
        return {**job, "status_url": f"/api/v1/storage/td/bulk-jobs/{job['job_id']}", "poll_after_ms": 1000}

    @router.get("/api/v1/storage/td/bulk-jobs", tags=["storage"])
    async def list_bulk_jobs(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Recent bulk jobs of the tenant, live and stored (no per-row items)."""
        tenant_id, _actor = ids(principal)
        items = await SBULK.load_jobs(session, tenant_id)
        return {"items": items, "total": len(items)}

    @router.get("/api/v1/storage/td/bulk-jobs/{job_id}", tags=["storage"])
    async def get_bulk_job(
        job_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Progress + per-row results of a bulk job: ``status`` QUEUED | RUNNING | DONE | FAILED |
        INTERRUPTED (the API restarted while it ran; ``error`` says how many rows were processed),
        ``total``, ``done``, ``progress_pct``, ``summary``, ``items`` (rows finished so far), ``error``."""
        tenant_id, _actor = ids(principal)
        job = await SBULK.load_job(session, tenant_id, job_id)
        if job is None:
            raise AppError(404, "NOT_FOUND", f"Bulk job '{job_id}' not found.")
        return job

    @router.get("/api/v1/storage/td/summary", tags=["storage"])
    async def storage_summary(
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Per database / supertable counts: physical subtables, registered by recording status,
        bound subtables and writer health — for overview screens (no subtable listing)."""
        tenant_id, _actor = ids(principal)
        return {**(await topology_inspector.summarize(tenant_id, session)),
                "recording": await SMR.recording_status(session, tenant_id), "observed_at": iso_ms(utcnow())}

    @router.post("/api/v1/storage/td/objects/{object_id:path}/alter", tags=["storage"])
    async def alter_td_stable(
        object_id: str,
        body: dict[str, Any] = Body(...),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Additive schema change of a USER supertable: ``add_columns`` / ``add_tags``; ``dry_run``
        returns the ALTER statements without executing them."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if not db_name or not name:
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")
        await _require_db(session, tenant_id, db_name, f"Storage object '{object_id}'")
        kind = await _resolve_kind(db_name, name, obj_kind)
        if kind != "stable":
            raise AppError(422, "NOT_A_SUPERTABLE", "Columns and tags are added to a supertable; its subtables inherit them.")
        _assert_user_object("stable", db_name, name, tenant_id, "alter")
        try:
            return await revision_service.alter_stable(
                session, tenant_id, actor_id, db_name, name, body, dry_run=bool(body.get("dry_run")))
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc

    @router.get("/api/v1/storage/td/objects/{object_id:path}", tags=["storage"])
    async def get_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        tenant_id, _actor = ids(principal)
        now_iso = iso_ms(utcnow())

        obj_kind, parsed_db, parsed_name = ST.parse_canonical_object_id(object_id)
        target_db = parsed_db or (parsed_name if obj_kind == "database" else tenant_db(tenant_id))
        if not await _assert_tenant_database_access(session, tenant_id, target_db):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        # 1. Database: ``db:<name>`` / ``<name>`` parse to ('database', <name>, None) — the name is the
        #    *database* part (R2-06: it used to look up ``None`` and always answered 404).
        if obj_kind == "database":
            d = await topology_inspector.get_database(parsed_db)
            if not d:
                raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")
            return await _database_payload(session, tenant_id, d)

        # 2. Supertable or Subtable
        if not parsed_name:
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")
        _checked_name(parsed_name, "table name")
        kind = await _resolve_kind(target_db, parsed_name, obj_kind)
        if kind == "stable":
            st = await topology_inspector.get_stable(target_db, parsed_name)
            if st and st.columns:
                r = await _registry(session, tenant_id, "stable", target_db, parsed_name) or {}
                return {
                    "id": f"{st.database}.{st.name}",
                    "object_type": "stable",
                    "database_name": st.database,
                    "physical_name": st.name,
                    "display_name": r.get("display_name") or st.name,
                    "description": r.get("description") or "",
                    "columns": [_column_payload(c) for c in st.columns],
                    "tags": [{"name": t.name, "td_type": t.td_type, "length": t.length} for t in st.tags],
                    "subtable_count": st.subtable_count,
                    "status": str(r.get("status") or "ACTIVE"),
                    "managed": bool(r),
                    "is_system": is_system_stable(st.name),
                    "recording": _json_field(r.get("recording_json"), {}),
                    "revision": int(r.get("revision") or 1),
                    "drift_status": _drift(r, st.columns, is_system_stable(st.name)),
                    "tenant_id": str(tenant_id),
                    "observed_at": now_iso,
                }

        sub = await topology_inspector.get_subtable(target_db, parsed_name)
        if sub:
            r = await _registry(session, tenant_id, "subtable", target_db, parsed_name) or {}
            bindings = await _bindings_of(session, tenant_id, target_db, parsed_name)
            st_value = str(r.get("status") or "ACTIVE")
            summary = await _recording_summary(session, tenant_id, target_db, parsed_name, r, bindings)
            bindings = _effective_bindings(bindings, st_value)
            return {
                "id": f"{sub.database}.{sub.name}",
                "object_type": "subtable",
                "stable_name": sub.stable_name,
                "parent_name": sub.stable_name,
                "database_name": sub.database,
                "physical_name": sub.name,
                "display_name": r.get("display_name") or sub.name,
                "description": r.get("description") or "",
                "tag_values": [{"name": k, "value": None if v is None else str(v)} for k, v in sub.tags.items()],
                "bindings": bindings,
                "status": st_value,
                "managed": bool(r),
                "is_system": is_system_subtable(sub.name),
                "write_active": bool(r) and st_value == "ACTIVE" and bool(bindings),
                "recording": {**(_json_field(r.get("recording_json"), {}) or {}), **_summary_keys(summary)},
                "recording_summary": summary,
                "revision": int(r.get("revision") or 1),
                "tenant_id": str(tenant_id),
                "observed_at": now_iso,
            }

        raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

    @router.patch("/api/v1/storage/td/objects/{object_id:path}", tags=["storage"])
    async def patch_td_object(
        object_id: str,
        body: dict[str, Any] = Body(...),
        if_match: str | None = Header(None, alias="If-Match"),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Update storage object metadata (display name / description) with a revision check.

        Physical schema changes of an existing object are not executed through this route: a
        replayed ``CREATE`` cannot alter an object (R1-16). System objects are read-only.
        """
        tenant_id, actor_id = ids(principal)
        now_iso = iso_ms(utcnow())
        # Drafts: PATCH /td/objects/drafts/{id} is registered before this route (B-09).
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if obj_kind == "database":
            db_name, name = db_name, db_name
        if not db_name:
            db_name = tenant_db(tenant_id)
        if obj_kind == "table" and name:
            obj_kind = await _resolve_kind(db_name, name, obj_kind)
        _assert_user_object(obj_kind, db_name, name, tenant_id, "alter")

        if not await _assert_tenant_database_access(session, tenant_id, db_name):
            raise AppError(404, "NOT_FOUND", f"Storage object '{object_id}' not found")

        existing_obj = await fetch_one(
            session,
            """
            SELECT id, object_type, physical_db, physical_name, display_name, description,
                   status, schema_json, tags_json, revision, updated_at
            FROM storage_objects
            WHERE tenant_id = :tenant_id AND physical_db = :db AND physical_name = :name
            LIMIT 1
            """,
            {"tenant_id": tenant_id, "db": db_name, "name": name},
        )

        current_rev = int(existing_obj["revision"]) if existing_obj else 1

        client_rev = body.get("revision") or body.get("expected_revision")
        if if_match:
            try:
                client_rev = int(if_match.strip('"'))
            except (ValueError, TypeError):
                pass

        if client_rev is not None and int(client_rev) != current_rev:
            raise AppError(
                409,
                "VERSION_CONFLICT",
                f"Object revision conflict: server has revision {current_rev}, request specified {client_rev}",
                extra={"server_revision": current_rev, "client_revision": client_rev},
            )

        schema_changing_keys = {
            "columns", "tags", "tag_values", "precision", "retention_days",
            "source_mapping_template", "bindings"
        }
        is_metadata_only = not any(k in body and body[k] is not None for k in schema_changing_keys)

        if is_metadata_only and existing_obj:
            new_disp = body.get("display_name", existing_obj.get("display_name") or "")
            new_desc = body.get("description", existing_obj.get("description") or "")
            # Same limit as create (validate_*_spec): a long description must not be accepted silently.
            if len(str(new_desc or "")) > MAX_DESCRIPTION_LEN:
                raise AppError(
                    422, "DESCRIPTION_TOO_LONG", f"Description is limited to {MAX_DESCRIPTION_LEN} characters.",
                    field_errors=[{"field": "description", "code": "DESCRIPTION_TOO_LONG",
                                   "message": f"Description is limited to {MAX_DESCRIPTION_LEN} characters."}],
                )
            new_rev = current_rev + 1
            await execute(
                session,
                """
                UPDATE storage_objects
                SET display_name = :disp, description = :desc, revision = :rev, updated_at = :now
                WHERE id = :id AND tenant_id = :tenant_id
                """,
                {
                    "disp": new_disp,
                    "desc": new_desc,
                    "rev": new_rev,
                    "now": utcnow(),
                    "id": existing_obj["id"],
                    "tenant_id": tenant_id,
                },
            )
            return {
                "id": object_id,
                "object_type": existing_obj["object_type"],
                "physical_name": existing_obj["physical_name"],
                "display_name": new_disp,
                "description": new_desc,
                "revision": new_rev,
                "status": existing_obj["status"],
                "observed_at": now_iso,
            }

        raise AppError(
            422,
            "SCHEMA_CHANGE_NOT_SUPPORTED",
            "This route changes display name and description only. Add columns or tags with "
            "POST /api/v1/storage/td/objects/<id>/alter; other schema or binding changes need a corrected "
            "copy (Duplicate) and retiring the old object.",
        )

    async def _lifecycle(
        session: AsyncSession, principal: dict[str, Any], object_id: str, action: str, new_status: str,
    ) -> dict[str, Any]:
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if obj_kind == "database":
            name = db_name
        if not db_name:
            db_name = tenant_db(tenant_id)
        await _require_db(session, tenant_id, db_name, f"Storage object '{object_id}'")
        if obj_kind == "table" and name:
            obj_kind = await _resolve_kind(db_name, name, obj_kind)
        _assert_user_object(obj_kind, db_name, name, tenant_id, action)
        now = utcnow()
        if obj_kind == "database":
            where = "physical_db = :db"
        elif obj_kind == "stable":
            where = "physical_db = :db AND (physical_name = :name OR (object_type = 'subtable' AND parent_name = :name))"
        else:
            where = "physical_db = :db AND physical_name = :name AND object_type = 'subtable'"
        guard = "" if action == "retire" else " AND status <> 'RETIRED'"
        await execute(
            session,
            f"UPDATE storage_objects SET status = :st, updated_at = :now, revision = revision + 1 "
            f"WHERE tenant_id = :tenant_id AND status <> 'PURGED'{guard} AND {where}",
            {"st": new_status, "now": now, "tenant_id": tenant_id, "db": db_name, "name": name},
        )
        # Keep the physical registry in step (it used to stay ACTIVE for paused / retired subtables).
        await execute(
            session,
            "UPDATE storage_physical_registry SET status = :st, updated_at = :now WHERE tenant_id = :tenant_id "
            "AND td_database = :db AND (CAST(:name AS text) IS NULL OR td_subtable = :name OR td_stable = :name)",
            {"st": new_status, "now": now, "tenant_id": tenant_id, "db": db_name,
             "name": name if obj_kind != "database" else None},
        )
        if action == "retire":
            await execute(
                session,
                "UPDATE storage_bindings SET status = 'RETIRED', updated_at = :now WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND (CAST(:name AS text) IS NULL OR physical_subtable = :name "
                "OR physical_subtable IN (SELECT physical_name FROM storage_objects WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND parent_name = :name))",
                {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name if obj_kind != "database" else None},
            )
        op_id = uuid4()
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, actor_id, status, requested_at, started_at,
                completed_at, step_state_json, object_key
            ) VALUES (
                :id, :tenant_id, :op_type, :target_type, :actor_id, 'APPLIED', :now, :now, :now, :state, :object_key
            )
            """,
            {"id": op_id, "tenant_id": tenant_id, "op_type": action.upper(), "target_type": obj_kind,
             "actor_id": actor_id, "now": now, "state": json.dumps({"action": action, "object_id": object_id}),
             "object_key": f"{db_name}.{name}" if name and obj_kind != "database" else db_name},
        )
        SMR.invalidate_bindings(tenant_id)
        # H7: the ingestion worker (another process) caches signal-binding targets; tell it to reload now
        # instead of on its 30 s catalog TTL. Delivered on commit, so a rolled-back change is not announced.
        await execute(
            session,
            "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
            {"channel": Channel.CONFIG_CHANGED.value, "payload": ConfigChanged(str(tenant_id)).to_payload()},
        )
        return {
            "id": object_id,
            "operation_id": str(op_id),
            "status": new_status,
            "write_active": new_status == "ACTIVE",
            "updated_at": iso_ms(now),
        }

    @router.post("/api/v1/storage/td/objects/{object_id:path}/pause", tags=["storage"])
    async def pause_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Stop recording into a user object (data and configuration are kept)."""
        return await _lifecycle(session, principal, object_id, "pause", "PAUSED")

    @router.post("/api/v1/storage/td/objects/{object_id:path}/resume", tags=["storage"])
    async def resume_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Start / resume recording into a user object."""
        return await _lifecycle(session, principal, object_id, "resume", "ACTIVE")

    @router.post("/api/v1/storage/td/objects/{object_id:path}/retire", tags=["storage"])
    async def retire_td_object(
        object_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Retire: no new writes, bindings retired, historical rows preserved."""
        return await _lifecycle(session, principal, object_id, "retire", "RETIRED")

    @router.delete("/api/v1/storage/td/objects/{object_id:path}", tags=["storage"])
    async def delete_td_object(
        object_id: str,
        confirm_name: str | None = Query(None),
        force: bool = Query(False),
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(db_dep),
    ) -> dict[str, Any]:
        """Purge (DROP) a user-created object after typed confirmation. System objects: 403."""
        tenant_id, actor_id = ids(principal)
        obj_kind, db_name, name = ST.parse_canonical_object_id(object_id)
        if obj_kind == "database":
            name = db_name
        if not db_name:
            db_name = tenant_db(tenant_id)
        await _require_db(session, tenant_id, db_name, f"Storage object '{object_id}'")
        _checked_name(db_name, "database name")
        _checked_name(name, "object name")
        if obj_kind == "table" and name:
            obj_kind = await _resolve_kind(db_name, name, obj_kind)
        _assert_user_object(obj_kind, db_name, name, tenant_id, "drop")
        if confirm_name != name:
            raise AppError(
                400,
                "CONFIRMATION_REQUIRED",
                f"Type the exact name '{name}' to confirm the permanent deletion.",
            )
        if obj_kind == "stable":
            children = await fetch_all(
                session,
                "SELECT physical_name FROM storage_objects WHERE tenant_id = :tenant_id AND physical_db = :db "
                "AND parent_name = :name AND object_type = 'subtable' AND status NOT IN ('PURGED', 'RETIRED') LIMIT 5",
                {"tenant_id": tenant_id, "db": db_name, "name": name},
            )
            if children and not force:
                raise AppError(409, "DEPENDENCY_EXISTS",
                               f"Supertable '{name}' still has active subtables ({', '.join(c['physical_name'] for c in children)}). Retire them first.")
        dep_views = await fetch_all(
            session,
            "SELECT id, name FROM saved_queries WHERE tenant_id = :tenant_id AND query_spec_json::text LIKE :pat LIMIT 5",
            {"tenant_id": tenant_id, "pat": f"%{name}%"},
        )
        if dep_views and not force:
            raise AppError(409, "DEPENDENCY_EXISTS",
                           f"Saved Historian views use '{name}': {', '.join(v['name'] for v in dep_views)}.")
        try:
            if obj_kind == "database":
                await revision_service._td_exec(f"DROP DATABASE IF EXISTS `{name}`")
            elif obj_kind == "stable":
                await revision_service._td_exec(f"DROP STABLE IF EXISTS `{db_name}`.`{name}`")
            else:
                await revision_service._td_exec(f"DROP TABLE IF EXISTS `{db_name}`.`{name}`")
        except StorageObjectError as exc:
            raise _storage_error(exc) from exc
        except Exception as exc:  # noqa: BLE001
            if not _is_missing_td_error(exc):
                raise AppError(503, "TDENGINE_DROP_FAILED", f"TDengine could not drop the object: {exc}", retryable=True) from exc
        now = utcnow()
        params = {"now": now, "tenant_id": tenant_id, "db": db_name, "name": name}
        if obj_kind == "database":
            await execute(session, "UPDATE storage_objects SET status = 'PURGED', updated_at = :now WHERE tenant_id = :tenant_id AND physical_db = :db", params)
            await execute(session, "UPDATE storage_bindings SET status = 'RETIRED', updated_at = :now WHERE tenant_id = :tenant_id AND physical_db = :db", params)
            # Rows still waiting for a table that no longer exists can never be written (R2-07).
            await execute(session, "DELETE FROM storage_record_outbox WHERE tenant_id = :tenant_id AND physical_db = :db "
                          "AND status <> 'CONFIRMED'", params)
            # The tables are gone: their physical-registry rows must not be counted / reset any more.
            await execute(session, "DELETE FROM storage_physical_registry WHERE tenant_id = :tenant_id AND td_database = :db", params)
        else:
            await execute(
                session,
                "UPDATE storage_objects SET status = 'PURGED', updated_at = :now WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND (physical_name = :name OR parent_name = :name)",
                params,
            )
            await execute(
                session,
                "UPDATE storage_bindings SET status = 'RETIRED', updated_at = :now WHERE tenant_id = :tenant_id "
                "AND physical_db = :db AND physical_subtable = :name",
                params,
            )
            await execute(
                session,
                "DELETE FROM storage_record_outbox WHERE tenant_id = :tenant_id AND physical_db = :db AND status <> 'CONFIRMED' "
                "AND (physical_subtable = :name OR physical_subtable IN (SELECT physical_name FROM storage_objects "
                "WHERE tenant_id = :tenant_id AND physical_db = :db AND parent_name = :name))",
                params,
            )
            await execute(
                session,
                "DELETE FROM storage_physical_registry WHERE tenant_id = :tenant_id AND td_database = :db "
                "AND (td_subtable = :name OR td_stable = :name)",
                params,
            )
        await execute(
            session,
            """
            INSERT INTO storage_operations (id, tenant_id, operation_type, target_type, actor_id, status,
                requested_at, started_at, completed_at, step_state_json, object_key)
            VALUES (:id, :tenant_id, 'PURGE', :kind, :actor_id, 'APPLIED', :now, :now, :now, :state, :key)
            """,
            {"id": uuid4(), "tenant_id": tenant_id, "kind": obj_kind, "actor_id": actor_id, "now": now,
             "state": json.dumps({"action": "purge", "object_id": object_id}),
             "key": name if obj_kind == "database" else f"{db_name}.{name}"},
        )
        SMR.invalidate_bindings(tenant_id)
        return {"id": object_id, "status": "PURGED", "dropped": True, "purged_at": iso_ms(now)}
