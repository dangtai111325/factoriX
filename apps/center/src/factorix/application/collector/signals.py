"""Signals: single-signal patch/delete/list, binding enable, re-addressing helpers. Moved verbatim from ``factorix.modules.collect`` (R2-E B6, move-only)."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.application.live.freshness_service import freshness_service
from factorix.domain.source_address import AddressCheck, validate_address_patch
from factorix.modules.common import (
    as_uuid,
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    jsonb,
    parse_uuid,
    utcnow,
)
from factorix.modules.protocols import public_protocol, validate_mqtt_topic
from factorix.platform.errors import AppError

from factorix.application.collector.schemas import SignalPatch
from factorix.application.legacy_edge.fleet import _edges_of_signals, _notify_config_changed, bump_edge_release


async def _set_binding_enabled(session: AsyncSession, signal_ids: list[UUID], enabled: bool) -> None:
    """Enable or disable the current binding (valid_to IS NULL) of each signal; history stays untouched."""
    if not signal_ids:
        return
    if enabled:
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
            {"ids": signal_ids},
        )
    else:
        await execute(
            session,
            "UPDATE signal_bindings SET enabled = FALSE WHERE signal_id = ANY(:ids) AND valid_to IS NULL",
            {"ids": signal_ids},
        )


async def _rebind_signal(session: AsyncSession, tenant_id: UUID, signal_id: UUID, connection_id: UUID) -> set[UUID]:
    """Move a signal to another connection of the same protocol and site.

    The current binding is closed (valid_to = now) and a new source field + binding is created on
    the target connection's acquisition job, so history keeps the old provenance. Returns the edges
    whose configuration changed.
    """
    current = await fetch_one(
        session,
        """
        SELECT b.id AS binding_id, b.revision, b.enabled, b.transform_chain_json, f.*, c.id AS connection_id, c.protocol,
               c.site_id, c.edge_id
        FROM signal_bindings b
        JOIN source_fields f ON f.id = b.source_field_id
        JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        JOIN connections c ON c.id = j.connection_id
        WHERE b.signal_id = :signal_id AND b.valid_to IS NULL AND c.tenant_id = :tenant_id
        ORDER BY b.valid_from DESC, b.revision DESC
        LIMIT 1
        """,
        {"signal_id": signal_id, "tenant_id": tenant_id},
    )
    if current is None:
        raise AppError(409, "NO_BINDING", "This signal has no source binding to move.")
    if as_uuid(current["connection_id"]) == connection_id:
        return set()
    target = await fetch_one(
        session,
        """
        SELECT c.id, c.protocol, c.site_id, c.edge_id, c.status,
               (SELECT j.id FROM acquisition_jobs j WHERE j.connection_id = c.id ORDER BY j.id LIMIT 1) AS job_id
        FROM connections c WHERE c.id = :id AND c.tenant_id = :tenant_id
        """,
        {"id": connection_id, "tenant_id": tenant_id},
    )
    if target is None:
        raise AppError(404, "NOT_FOUND", "Connection not found.", field_errors=[{"path": "connection_id", "code": "NOT_FOUND"}])
    if target["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "The target connection is archived.")
    if target["protocol"] != current["protocol"]:
        raise AppError(422, "PROTOCOL_MISMATCH", "A signal can only move to a connection of the same protocol; its source address would not be valid.", field_errors=[{"path": "connection_id", "code": "PROTOCOL_MISMATCH"}])
    if str(target["site_id"]) != str(current["site_id"]):
        raise AppError(422, "SITE_MISMATCH", "Resource and connection must belong to the same site.", field_errors=[{"path": "connection_id", "code": "SITE_MISMATCH"}])
    if not target.get("job_id"):
        raise AppError(409, "NO_JOB", "The target connection has no acquisition job.")
    now = utcnow()
    await execute(session, "UPDATE signal_bindings SET valid_to = :now WHERE id = :id", {"now": now, "id": as_uuid(current["binding_id"])})
    field_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
        VALUES (:id, :job_id, :kind, CAST(:address AS jsonb), :native, CAST(:decode AS jsonb), :ordinal)
        """,
        {
            "id": field_id,
            "job_id": as_uuid(target["job_id"]),
            "kind": current["address_kind"],
            "address": jsonb(current["address_json"] or {}),
            "native": current["native_datatype"],
            "decode": jsonb(current["decode_json"] or {}),
            "ordinal": int(current.get("ordinal") or 0),
        },
    )
    await execute(
        session,
        """
        INSERT INTO signal_bindings (id, signal_id, source_field_id, transform_chain_json, enabled, revision, valid_from)
        VALUES (:id, :signal_id, :field_id, CAST(:chain AS jsonb), :enabled, :revision, :now)
        """,
        {
            "id": uuid4(),
            "signal_id": signal_id,
            "field_id": field_id,
            "chain": jsonb(current.get("transform_chain_json") or []),
            "enabled": bool(current["enabled"]),
            "revision": int(current["revision"] or 1) + 1,
            "now": now,
        },
    )
    return {as_uuid(x) for x in (current.get("edge_id"), target.get("edge_id")) if x}


_SOURCE_SQL = """
SELECT DISTINCT ON (b.signal_id)
       b.signal_id, b.id AS binding_id, b.revision, b.enabled, b.transform_chain_json,
       f.id AS source_field_id, f.acquisition_job_id, f.address_kind, f.address_json, f.native_datatype, f.decode_json, f.ordinal,
       c.id AS connection_id, c.protocol, c.edge_id, c.status AS connection_status
FROM signal_bindings b
JOIN source_fields f ON f.id = b.source_field_id
JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
JOIN connections c ON c.id = j.connection_id
WHERE b.signal_id = ANY(:ids) AND b.valid_to IS NULL AND c.tenant_id = :tenant_id
ORDER BY b.signal_id, b.valid_from DESC, b.revision DESC
"""


async def _current_sources(session: AsyncSession, tenant_id: UUID, signal_ids: list[UUID]) -> dict[UUID, dict[str, Any]]:
    if not signal_ids:
        return {}
    rows = await fetch_all(session, _SOURCE_SQL, {"ids": signal_ids, "tenant_id": tenant_id})
    return {as_uuid(row["signal_id"]): row for row in rows}


def check_address_change(signal: dict[str, Any], source: dict[str, Any] | None, patch: dict[str, Any]) -> AddressCheck:
    """Validate one address patch against the signal's current source (no I/O)."""
    if source is None:
        check = AddressCheck(address={})
        check.error("address_patch", "NO_BINDING", "This signal has no source binding; its address cannot be edited.")
        return check
    if source.get("connection_status") == "ARCHIVED":
        check = AddressCheck(address=dict(source.get("address_json") or {}))
        check.error("address_patch", "ARCHIVED", "The signal's connection is archived.")
        return check
    return validate_address_patch(
        str(source["protocol"]),
        source.get("address_json") or {},
        patch,
        data_type=str(signal.get("data_type") or ""),
        topic_error=validate_mqtt_topic,
    )


async def _readdress(session: AsyncSession, signal_id: UUID, source: dict[str, Any], check: AddressCheck) -> UUID:
    """Point the signal at the new address: close the current binding and bind a new source field
    on the same acquisition job (revision + 1). Observations keep the provenance of the address that
    produced them; the signal id, and so every data model member, stays the same. Returns the new
    source field id.
    """
    now = utcnow()
    await execute(session, "UPDATE signal_bindings SET valid_to = :now WHERE id = :id", {"now": now, "id": as_uuid(source["binding_id"])})
    field_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
        VALUES (:id, :job_id, :kind, CAST(:address AS jsonb), :native, CAST(:decode AS jsonb), :ordinal)
        """,
        {
            "id": field_id,
            "job_id": as_uuid(source["acquisition_job_id"]),
            "kind": source["address_kind"],
            "address": jsonb(check.address),
            "native": check.native_type or source["native_datatype"],
            "decode": jsonb(source.get("decode_json") or {}),
            "ordinal": int(source.get("ordinal") or 0),
        },
    )
    await execute(
        session,
        """
        INSERT INTO signal_bindings (id, signal_id, source_field_id, transform_chain_json, enabled, revision, valid_from)
        VALUES (:id, :signal_id, :field_id, CAST(:chain AS jsonb), :enabled, :revision, :now)
        """,
        {
            "id": uuid4(),
            "signal_id": signal_id,
            "field_id": field_id,
            "chain": jsonb(source.get("transform_chain_json") or []),
            "enabled": bool(source["enabled"]),
            "revision": int(source.get("revision") or 1) + 1,
            "now": now,
        },
    )
    return field_id


def _source_view(source: dict[str, Any] | None, *, address: dict[str, Any] | None = None, field_id: Any = None) -> dict[str, Any] | None:
    if source is None:
        return None
    return {
        "source_field_id": str(field_id or source["source_field_id"]),
        "connection_id": str(source["connection_id"]),
        "protocol": public_protocol(str(source["protocol"])),
        "address_kind": source["address_kind"],
        "address_json": address if address is not None else (source.get("address_json") or {}),
    }


async def patch_signal(session: AsyncSession, tenant_id: UUID, actor: UUID, signal_id: UUID, body: SignalPatch, correlation_id: str) -> dict[str, Any]:
    current = await _signal(session, tenant_id, signal_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This signal was modified elsewhere. Reload it and try again.")
    if current["status"] != "ACTIVE":
        raise AppError(409, "ARCHIVED", "Archived signals cannot be modified.")
    if body.expected_interval_ms is not None and not (100 <= body.expected_interval_ms <= 86_400_000):
        raise AppError(422, "INTERVAL", "Expected interval must be between 100 ms and one day.", field_errors=[{"path": "expected_interval_ms", "code": "RANGE"}])
    if body.address_patch is not None and body.connection_id:
        raise AppError(422, "ADDRESS_AND_MOVE", "Change the address or move the signal to another connection, not both at once.", field_errors=[{"path": "address_patch", "code": "CONFLICT"}])
    source = (await _current_sources(session, tenant_id, [signal_id])).get(signal_id)
    address_check: AddressCheck | None = None
    if body.address_patch is not None:
        address_check = check_address_change(current, source, body.address_patch)
        if not address_check.ok:
            first = address_check.errors[0]
            raise AppError(
                422,
                first["code"] if len(address_check.errors) == 1 else "ADDRESS_INVALID",
                first["message"] if len(address_check.errors) == 1 else "The source address has errors.",
                field_errors=[{"path": f"address_patch.{e['path']}", "code": e["code"], "message": e["message"]} for e in address_check.errors],
            )
        if address_check.address == (source or {}).get("address_json"):
            address_check = None  # nothing to change
    updated = await execute_rowcount(
        session,
        """
        UPDATE signal_definitions
        SET display_name = :display_name, description = :description, unit = :unit,
            expected_interval_ms = :interval, version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id AND version = :version
        """,
        {
            "display_name": (body.display_name or "").strip() or current["display_name"],
            "description": body.description if body.description is not None else current["description"],
            "unit": body.unit if body.unit is not None else current["unit"],
            "interval": body.expected_interval_ms if body.expected_interval_ms is not None else current["expected_interval_ms"],
            "now": utcnow(),
            "id": signal_id,
            "tenant_id": tenant_id,
            "version": body.version,
        },
    )
    if updated != 1:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This signal was modified elsewhere. Reload it and try again.")
    edges: set[UUID] = set()
    config_changed = False
    new_field_id: UUID | None = None
    if address_check is not None and source is not None:
        new_field_id = await _readdress(session, signal_id, source, address_check)
        config_changed = True
        if source.get("edge_id"):
            edges.add(as_uuid(source["edge_id"]))
    if body.connection_id:
        config_changed = True
        edges |= await _rebind_signal(session, tenant_id, signal_id, parse_uuid(body.connection_id))
    if body.enabled is not None:
        config_changed = True
        edges |= await _edges_of_signals(session, [signal_id])
        await _set_binding_enabled(session, [signal_id], body.enabled)
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    if config_changed and not edges:
        await _notify_config_changed(session, tenant_id)

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="SIGNAL_UPDATE",
        actor_id=actor,
        entity_type="signal",
        entity_id=signal_id,
        before={"display_name": current["display_name"], "version": current["version"]},
        after={
            "display_name": (body.display_name or "").strip() or current["display_name"],
            "version": int(current["version"]) + 1,
            **({"enabled": body.enabled} if body.enabled is not None else {}),
            **({"connection_id": body.connection_id} if body.connection_id else {}),
            **({"address": address_check.address} if address_check is not None else {}),
        },
        correlation_id=correlation_id,
    )
    if address_check is not None and source is not None:
        await audit(session, tenant_id=tenant_id, event_type="SIGNAL_ADDRESS_UPDATE", actor_id=actor, entity_type="signal", entity_id=signal_id, before={"address": source.get("address_json") or {}}, after={"address": address_check.address}, correlation_id=correlation_id)
    result = await _signal(session, tenant_id, signal_id)
    latest_source = (await _current_sources(session, tenant_id, [signal_id])).get(signal_id)
    result["source"] = _source_view(latest_source)
    return result


async def delete_signal(session: AsyncSession, tenant_id: UUID, actor: UUID, signal_id: UUID, correlation_id: str) -> dict[str, Any]:
    sig = await _signal(session, tenant_id, signal_id)
    now = utcnow()
    edges = await _edges_of_signals(session, [signal_id])
    await execute(session, "UPDATE signal_definitions SET status = 'ARCHIVED', version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id", {"now": now, "id": signal_id, "tenant_id": tenant_id})
    await _set_binding_enabled(session, [signal_id], False)
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    if not edges:
        await _notify_config_changed(session, tenant_id)
    await audit(session, tenant_id=tenant_id, event_type="SIGNAL_DELETE", actor_id=actor, entity_type="signal", entity_id=signal_id, before={"status": sig["status"]}, after={"status": "ARCHIVED"}, correlation_id=correlation_id)
    return {"id": str(signal_id), "status": "ARCHIVED"}


async def _signal(session: AsyncSession, tenant_id: UUID, signal_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM signal_definitions WHERE id = :id AND tenant_id = :tenant_id",
        {"id": signal_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Signal not found.")
    return row


async def list_signals(session: AsyncSession, tenant_id: UUID, *, resource_id: str | None, query: str | None, limit: int) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"tenant_id": tenant_id, "limit": min(max(limit, 1), 1000)}
    where = ["s.tenant_id = :tenant_id", "s.status = 'ACTIVE'"]
    if resource_id:
        where.append("s.resource_id = :resource_id")
        params["resource_id"] = parse_uuid(resource_id)
    if query:
        where.append("(s.display_name ILIKE :q OR s.key ILIKE :q)")
        params["q"] = f"%{query.strip()}%"
    rows = await fetch_all(
        session,
        f"""
        SELECT s.id, s.key, s.display_name, s.data_type, s.unit, s.category, s.resource_id, s.version, s.expected_interval_ms,
               r.code AS resource_code, r.name AS resource_name, r.path_code,
               c.id AS connection_id, c.name AS connection_name, c.protocol AS connection_protocol, c.status AS connection_status,
               e.id AS edge_id, e.name AS edge_name,
               f.address_kind, f.address_json, COALESCE(f.ordinal, 0) AS source_ordinal, j.id AS job_id, b.enabled AS binding_enabled,
               j.interval_ms AS job_interval_ms
        FROM signal_definitions s
        JOIN resources r ON r.id = s.resource_id
        LEFT JOIN LATERAL (
            -- The current binding whether enabled or not: a disabled signal still shows its
            -- connection and address, which the user needs to enable it again (R3-SG-01).
            SELECT b.id, b.source_field_id, b.enabled
            FROM signal_bindings b
            WHERE b.signal_id = s.id AND b.valid_to IS NULL
            ORDER BY b.enabled DESC, b.valid_from DESC, b.revision DESC
            LIMIT 1
        ) b ON TRUE
        LEFT JOIN source_fields f ON f.id = b.source_field_id
        LEFT JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        LEFT JOIN connections c ON c.id = j.connection_id
        LEFT JOIN edge_nodes e ON e.id = c.edge_id
        WHERE {' AND '.join(where)}
        ORDER BY r.code, s.created_at, COALESCE(f.ordinal, 0), s.key
        LIMIT :limit
        """,
        params,
    )
    freshness = freshness_service()
    for row in rows:
        if row.get("data_type") == "bool":
            row["data_type"] = "boolean"
        row["signal_id"] = str(row["id"])
        # Server-side stale threshold (R2-E C1): signal interval, falling back to the job interval. The
        # browser uses this instead of deriving its own threshold from expected_interval_ms.
        row["stale_after_ms"] = freshness.stale_after_ms(
            row["id"], expected_interval_ms=row.get("expected_interval_ms"), job_interval_ms=row.pop("job_interval_ms", None)
        )
        conn_id = str(row["connection_id"]) if row.get("connection_id") else None
        row["connection_id"] = conn_id
        row["binding_enabled"] = None if row.get("binding_enabled") is None else bool(row["binding_enabled"])
        row["enabled"] = bool(row["binding_enabled"])
        if conn_id:
            row["source"] = {
                "connection_id": conn_id,
                "connection_name": str(row.get("connection_name") or ""),
                "edge_id": str(row["edge_id"]) if row.get("edge_id") else None,
                "edge_name": str(row.get("edge_name") or ""),
                "protocol": str(row.get("connection_protocol") or ""),
                "address_kind": str(row.get("address_kind") or ""),
                "job_id": str(row["job_id"]) if row.get("job_id") else None,
                "connection_status": str(row.get("connection_status") or ""),
                "binding_enabled": row["binding_enabled"],
            }
        else:
            row["source"] = None
    return rows
