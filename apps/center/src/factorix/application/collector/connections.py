"""Collector connections: create/get/list/patch/pause/resume/archive. Moved verbatim from ``factorix.modules.collect`` (R2-E B6, move-only)."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.health import effective_connection_health, effective_edge_health
from factorix.modules.common import (
    as_uuid,
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    parse_uuid,
    queue_stream_event,
    utcnow,
)
from factorix.modules.protocols import (
    WEBSOCKET_DEFAULT_INTERVAL_MS,
    accept_connection,
    http_rate_warnings,
    mask_config,
    parse_config,
    public_protocol,
    redacted_endpoint,
    stored_protocol,
    unmask_config,
    validate_interval,
)
from factorix.platform.errors import AppError
from factorix.platform.security import encrypt_secret

from factorix.application.collector.schemas import ConnectionIn, ConnectionPatch, SUBSCRIBE_PROTOCOLS, _SECRET_AUTH
from factorix.application.legacy_edge.fleet import _notify_config_changed, _owned_edge, bump_edge_release


async def _resolve_site_id(session: AsyncSession, tenant_id: UUID, raw_site_id: str) -> UUID:
    """Accept a site id, or the id of a resource inside a site (the console may send either).

    Every lookup is tenant scoped and nothing is created implicitly.
    """
    candidate = parse_uuid(raw_site_id)
    site = await fetch_one(session, "SELECT id FROM sites WHERE id = :id AND tenant_id = :tenant_id", {"id": candidate, "tenant_id": tenant_id})
    if site is not None:
        return as_uuid(site["id"])
    resource = await fetch_one(
        session,
        "SELECT id, code, site_id FROM resources WHERE id = :id AND tenant_id = :tenant_id",
        {"id": candidate, "tenant_id": tenant_id},
    )
    if resource is not None:
        if resource.get("site_id"):
            return as_uuid(resource["site_id"])
        by_code = await fetch_one(
            session,
            "SELECT id FROM sites WHERE tenant_id = :tenant_id AND lower(code) = lower(:code)",
            {"tenant_id": tenant_id, "code": resource["code"]},
        )
        if by_code is not None:
            return as_uuid(by_code["id"])
        raise AppError(422, "SITE", "The selected resource is not inside a site.", field_errors=[{"path": "site_id", "code": "SITE"}])
    raise AppError(404, "NOT_FOUND", "Site not found.", field_errors=[{"path": "site_id", "code": "NOT_FOUND"}])


def _require_secret(protocol: str, config: dict[str, Any], has_secret: bool) -> None:
    if protocol == "http" and config.get("auth") in _SECRET_AUTH and not has_secret:
        raise AppError(
            422,
            "SECRET_REQUIRED",
            "Enter the credential for the selected authentication type.",
            field_errors=[{"path": "secret_input", "code": "REQUIRED"}],
        )


def _job_defaults(protocol: str, interval_override: int | None) -> tuple[str, int | None]:
    mode = "SUBSCRIBE" if protocol in SUBSCRIBE_PROTOCOLS else "POLL"
    interval = validate_interval(protocol, interval_override)
    if interval is None:
        if protocol == "mqtt":
            interval = None
        elif protocol == "websocket":
            interval = WEBSOCKET_DEFAULT_INTERVAL_MS
        else:
            interval = 1000
    return mode, interval


async def create_connection(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: ConnectionIn,
    *,
    data_key: str,
    correlation_id: str,
) -> dict[str, Any]:
    site_id = await _resolve_site_id(session, tenant_id, body.site_id)
    body.site_id = str(site_id)

    dup = await fetch_one(
        session,
        "SELECT id FROM connections WHERE tenant_id = :tenant_id AND site_id = :site_id AND lower(name) = lower(:name)",
        {"tenant_id": tenant_id, "site_id": site_id, "name": body.name.strip()},
    )
    if dup:
        raise AppError(409, "DUPLICATE", f'A connection with name "{body.name.strip()}" already exists in this site.', field_errors=[{"path": "name", "code": "DUPLICATE"}])

    protocol, raw_config, interval_override = accept_connection(body.protocol, body.config)
    config = parse_config(protocol, raw_config)
    _require_secret(protocol, config, bool(body.secret_input))
    mode, interval = _job_defaults(protocol, interval_override)

    from factorix.platform.settings import get_settings

    edge = None
    if body.edge_id:
        edge = await _owned_edge(session, tenant_id, parse_uuid(body.edge_id))
    elif get_settings().collector_mode != "acquisition":
        edge = await fetch_one(
            session,
            "SELECT * FROM edge_nodes WHERE tenant_id = :tenant_id AND site_id = :site_id AND enrollment_status <> 'REVOKED' ORDER BY created_at LIMIT 1",
            {"tenant_id": tenant_id, "site_id": site_id},
        )
        if edge is None:
            site_row = await fetch_one(session, "SELECT name FROM sites WHERE id = :site_id AND tenant_id = :tenant_id", {"site_id": site_id, "tenant_id": tenant_id})
            site_name = site_row["name"] if site_row else "Site"
            edge_id = uuid4()
            # A new collector is UNENROLLED until it presents an enrollment token (in appliance
            # mode Center writes one for the local edge automatically). No fake HEALTHY state.
            await execute(
                session,
                """
                INSERT INTO edge_nodes (
                    id, tenant_id, site_id, name, enrollment_status, desired_revision, active_revision, health, created_at
                ) VALUES (
                    :id, :tenant_id, :site_id, :name, 'UNENROLLED', 0, 0, 'UNKNOWN', :now
                )
                """,
                {"id": edge_id, "tenant_id": tenant_id, "site_id": site_id, "name": f"Edge {site_name}"[:160], "now": utcnow()},
            )
            edge = await _owned_edge(session, tenant_id, edge_id)
    if edge is not None:
        body.edge_id = str(edge["id"])
        if str(edge["site_id"]) != str(site_id):
            raise AppError(422, "SCOPE", "Edge does not belong to the selected site.")
    else:
        body.edge_id = None
    secret_ref = None
    if body.secret_input:
        if len(body.secret_input) > 4096:
            raise AppError(422, "SECRET", "Secret is too long.")
        secret_ref = uuid4()
        await execute(
            session,
            """
            INSERT INTO secret_store (id, tenant_id, ciphertext, created_at)
            VALUES (:id, :tenant_id, :ciphertext, :now)
            """,
            {"id": secret_ref, "tenant_id": tenant_id, "ciphertext": encrypt_secret(data_key, body.secret_input), "now": utcnow()},
        )
    connection_id = uuid4()
    now = utcnow()
    await execute(
        session,
        """
        INSERT INTO connections (
            id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted, secret_ref,
            config_json, status, health, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :site_id, :edge_id, :protocol, :name, :endpoint, :secret_ref,
            CAST(:config AS jsonb), 'ACTIVE', 'UNKNOWN', 1, :now, :now
        )
        """,
        {
            "id": connection_id,
            "tenant_id": tenant_id,
            "site_id": site_id,
            "edge_id": as_uuid(edge["id"]) if edge is not None else None,
            "protocol": protocol,
            "name": body.name.strip(),
            "endpoint": redacted_endpoint(protocol, config),
            "secret_ref": secret_ref,
            "config": jsonb(config),
            "now": now,
        },
    )
    await execute(
        session,
        """
        INSERT INTO acquisition_jobs (
            id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version
        ) VALUES (:id, :connection_id, :mode, :interval_ms, :timeout_ms, TRUE, 1, 1, 1)
        """,
        {
            "id": uuid4(),
            "connection_id": connection_id,
            "mode": mode,
            "interval_ms": interval,
            "timeout_ms": int(config.get("timeout_ms") or 3000),
        },
    )
    if edge is not None:
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(edge["id"]))
    else:
        await _notify_config_changed(session, tenant_id)
    await audit(session, tenant_id=tenant_id, event_type="CONNECTION_CREATE", actor_id=actor, entity_type="connection", entity_id=connection_id, before=None, after={"name": body.name.strip(), "protocol": body.protocol}, correlation_id=correlation_id)
    result = await get_connection(session, tenant_id, connection_id)
    warnings = _connection_warnings(protocol, config, interval, path_count=1)
    if warnings:
        result["warnings"] = warnings
    return result


def _connection_warnings(protocol: str, config: dict[str, Any], interval: int | None, *, path_count: int) -> list[str]:
    if protocol != "http":
        return []
    return http_rate_warnings(interval_ms=interval, path_count=path_count, rate_limit_per_min=config.get("rate_limit_per_min"))


async def _connection_row(session: AsyncSession, tenant_id: UUID, connection_id: UUID, *, lock: bool = False) -> dict[str, Any]:
    """Raw connection row (stored protocol, unmasked config, secret_ref). Internal use only."""
    row = await fetch_one(
        session,
        f"SELECT * FROM connections WHERE id = :id AND tenant_id = :tenant_id{' FOR UPDATE' if lock else ''}",
        {"id": connection_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Connection not found.")
    return row


async def _active_binding_counts(session: AsyncSession, connection_ids: list[UUID]) -> dict[str, int]:
    if not connection_ids:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT j.connection_id, count(DISTINCT b.signal_id) AS active_bindings
        FROM acquisition_jobs j
        JOIN source_fields sf ON sf.acquisition_job_id = j.id
        JOIN signal_bindings b ON b.source_field_id = sf.id
        JOIN signal_definitions s ON s.id = b.signal_id
        WHERE j.connection_id = ANY(:ids) AND b.enabled = TRUE AND b.valid_to IS NULL AND s.status = 'ACTIVE'
        GROUP BY j.connection_id
        """,
        {"ids": connection_ids},
    )
    return {str(row["connection_id"]): int(row["active_bindings"] or 0) for row in rows}


def _decorate_connection(row: dict[str, Any], *, active_bindings: int, edge: dict[str, Any] | None, now: Any) -> dict[str, Any]:
    """Public view: masked config (both keys), public protocol, server-computed effective health."""
    stored = str(row["protocol"])
    edge_health = effective_edge_health(edge, now) if edge is not None else None
    masked = mask_config(row.get("config_json") or {})
    row["protocol"] = public_protocol(stored)
    row["protocol_key"] = stored
    row["config_json"] = masked
    row["config"] = masked
    row["active_binding_count"] = active_bindings
    row["edge_health"] = edge_health
    row["effective_health"] = effective_connection_health(
        status=row.get("status"),
        health=row.get("health"),
        active_bindings=active_bindings,
        edge_health=edge_health,
    )
    row["last_success_at"] = iso_ms(row.get("last_success_at"))
    row.pop("secret_ref", None)
    return row


async def get_connection(session: AsyncSession, tenant_id: UUID, connection_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        """
        SELECT id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted, secret_ref IS NOT NULL AS secret_configured,
               config_json, status, health, last_error, last_success_at, version, created_at, updated_at
        FROM connections WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"id": connection_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Connection not found.")
    row["jobs"] = await fetch_all(
        session,
        "SELECT id, mode, interval_ms, timeout_ms, enabled, version FROM acquisition_jobs WHERE connection_id = :id",
        {"id": connection_id},
    )
    edge = None
    if row.get("edge_id"):
        edge = await fetch_one(
            session,
            "SELECT id, name, enrollment_status, health, last_heartbeat, desired_revision, active_revision FROM edge_nodes WHERE id = :id",
            {"id": as_uuid(row["edge_id"])},
        )
    counts = await _active_binding_counts(session, [connection_id])
    if edge is not None:
        row["edge_name"] = edge["name"]
    else:
        row.setdefault("edge_name", "Local Acquisition" if row.get("edge_id") is None else None)
    return _decorate_connection(row, active_bindings=counts.get(str(connection_id), 0), edge=edge, now=utcnow())


def _mask_config(cfg: Any) -> Any:
    return mask_config(cfg)


async def list_connections(session: AsyncSession, tenant_id: UUID, *, protocol: str | None, site_id: str | None, status: str | None) -> list[dict[str, Any]]:
    where = ["c.tenant_id = :tenant_id", "c.status <> 'ARCHIVED'"]
    params: dict[str, Any] = {"tenant_id": tenant_id}
    if protocol:
        where.append("c.protocol = :protocol")
        params["protocol"] = stored_protocol(protocol)
    if site_id:
        where.append("c.site_id = :site_id")
        params["site_id"] = parse_uuid(site_id)
    if status:
        where.append("c.status = :status")
        params["status"] = status
    rows = await fetch_all(
        session,
        f"""
        SELECT c.id, c.name, c.protocol, c.endpoint_redacted, c.edge_id, c.site_id,
               c.health, c.status, c.last_error, c.last_success_at, c.version, c.config_json,
               c.secret_ref IS NOT NULL AS secret_configured,
               e.name AS edge_name, e.enrollment_status AS edge_enrollment_status, e.health AS edge_raw_health,
               e.last_heartbeat AS edge_last_heartbeat,
               COALESCE(sig.signal_count, 0) AS signal_count,
               0 AS messages_per_min,
               (SELECT j.interval_ms FROM acquisition_jobs j WHERE j.connection_id = c.id ORDER BY j.id LIMIT 1) AS interval_ms
        FROM connections c
        LEFT JOIN edge_nodes e ON e.id = c.edge_id
        LEFT JOIN (
            SELECT j.connection_id, count(DISTINCT b.signal_id) AS signal_count
            FROM acquisition_jobs j
            JOIN source_fields sf ON sf.acquisition_job_id = j.id
            JOIN signal_bindings b ON b.source_field_id = sf.id
            JOIN signal_definitions s ON s.id = b.signal_id
            WHERE b.enabled = TRUE AND b.valid_to IS NULL AND s.status = 'ACTIVE'
            GROUP BY j.connection_id
        ) sig ON sig.connection_id = c.id
        WHERE {' AND '.join(where)}
        ORDER BY c.name
        """,
        params,
    )
    conn_rates: dict[str, int] = {}
    if session is not None and hasattr(session, "begin_nested"):
        from sqlalchemy.exc import SQLAlchemyError

        try:
            async with session.begin_nested():
                rt_rows = await fetch_all(
                    session,
                    """
                    SELECT queues_json
                    FROM collector_runtime_status
                    WHERE role = 'ingestion' AND last_heartbeat >= now() - INTERVAL '45 seconds'
                    """,
                    {},
                )
                for rt in rt_rows:
                    q = rt.get("queues_json") or {}
                    if isinstance(q, dict) and isinstance(q.get("conn_rates"), dict):
                        for cid, cnt in q["conn_rates"].items():
                            conn_rates[str(cid)] = conn_rates.get(str(cid), 0) + int(cnt or 0)
        except SQLAlchemyError:
            pass
    now = utcnow()
    for row in rows:
        edge_enrollment_status = row.pop("edge_enrollment_status", None)
        edge_raw_health = row.pop("edge_raw_health", None)
        edge_last_heartbeat = row.pop("edge_last_heartbeat", None)
        edge = None
        if row.get("edge_id"):
            edge = {
                "enrollment_status": edge_enrollment_status,
                "health": edge_raw_health,
                "last_heartbeat": edge_last_heartbeat,
            }
        elif not row.get("edge_name"):
            row["edge_name"] = "Local Acquisition"
        row["signal_count"] = int(row.get("signal_count") or 0)
        row["messages_per_min"] = max(int(row.get("messages_per_min") or 0), conn_rates.get(str(row["id"]), 0))
        _decorate_connection(row, active_bindings=row["signal_count"], edge=edge, now=now)
    return rows


def _signal_type(value: str) -> str:
    return "bool" if value == "boolean" else value


def _queue_connection_health(session: AsyncSession, tenant_id: UUID, connection: dict[str, Any]) -> None:
    queue_stream_event(
        session,
        "health",
        tenant_id,
        {
            "type": "health",
            "entity": "connection",
            "id": str(connection["id"]),
            "health": connection.get("health"),
            "effective_health": connection.get("effective_health"),
            "last_error": connection.get("last_error"),
            "last_success_at": iso_ms(connection.get("last_success_at")),
        },
    )


async def pause_connection(session: AsyncSession, tenant_id: UUID, actor: UUID, connection_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _connection_row(session, tenant_id, connection_id, lock=True)
    if current["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "Archived connections cannot be paused.")
    await execute(
        session,
        "UPDATE connections SET status = 'PAUSED', health = 'PAUSED', version = version + 1, updated_at = :now WHERE id = :id",
        {"now": utcnow(), "id": connection_id},
    )
    if current.get("edge_id"):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
    else:
        await _notify_config_changed(session, tenant_id)
    await audit(session, tenant_id=tenant_id, event_type="CONNECTION_PAUSE", actor_id=actor, entity_type="connection", entity_id=connection_id, before={"status": current["status"]}, after={"status": "PAUSED"}, correlation_id=correlation_id)
    result = await get_connection(session, tenant_id, connection_id)
    _queue_connection_health(session, tenant_id, result)
    return result


async def resume_connection(session: AsyncSession, tenant_id: UUID, actor: UUID, connection_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _connection_row(session, tenant_id, connection_id, lock=True)
    if current["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "Archived connections cannot be resumed.")
    # No evidence yet: UNKNOWN until the collector reports the connection or a sample arrives.
    await execute(
        session,
        "UPDATE connections SET status = 'ACTIVE', health = 'UNKNOWN', last_error = NULL, version = version + 1, updated_at = :now WHERE id = :id",
        {"now": utcnow(), "id": connection_id},
    )
    if current.get("edge_id"):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
    else:
        await _notify_config_changed(session, tenant_id)
    await audit(session, tenant_id=tenant_id, event_type="CONNECTION_RESUME", actor_id=actor, entity_type="connection", entity_id=connection_id, before={"status": current["status"]}, after={"status": "ACTIVE"}, correlation_id=correlation_id)
    result = await get_connection(session, tenant_id, connection_id)
    _queue_connection_health(session, tenant_id, result)
    return result


async def patch_connection(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    connection_id: UUID,
    body: ConnectionPatch,
    *,
    data_key: str,
    correlation_id: str,
) -> dict[str, Any]:
    current = await _connection_row(session, tenant_id, connection_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This connection was modified elsewhere. Reload it and try again.")
    if current["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "Archived connections cannot be modified.")
    protocol = str(current["protocol"])

    name = body.name.strip() if body.name is not None else current["name"]
    if body.name is not None and body.name.strip() != current["name"]:
        dup = await fetch_one(
            session,
            "SELECT id FROM connections WHERE tenant_id = :tenant_id AND site_id = :site_id AND lower(name) = lower(:name) AND id <> :id",
            {"tenant_id": tenant_id, "site_id": as_uuid(current["site_id"]), "name": name, "id": connection_id},
        )
        if dup:
            raise AppError(409, "DUPLICATE", f'A connection with name "{name}" already exists in this site.', field_errors=[{"path": "name", "code": "DUPLICATE"}])

    stored_config = current["config_json"] or {}
    config = stored_config
    interval_override: int | None = None
    if body.config is not None:
        _, raw_config, interval_override = accept_connection(protocol, unmask_config(body.config, stored_config))
        config = parse_config(protocol, raw_config)
    interval = validate_interval(protocol, interval_override)

    secret_ref = current.get("secret_ref")
    if body.secret_input is not None and body.secret_input != "":
        if len(body.secret_input) > 4096:
            raise AppError(422, "SECRET", "Secret is too long.")
        secret_ref = uuid4()
        await execute(
            session,
            """
            INSERT INTO secret_store (id, tenant_id, ciphertext, created_at)
            VALUES (:id, :tenant_id, :ciphertext, :now)
            """,
            {"id": secret_ref, "tenant_id": tenant_id, "ciphertext": encrypt_secret(data_key, body.secret_input), "now": utcnow()},
        )
    _require_secret(protocol, config, secret_ref is not None)

    endpoint = redacted_endpoint(protocol, config)
    now = utcnow()
    updated = await execute_rowcount(
        session,
        """
        UPDATE connections
        SET name = :name, endpoint_redacted = :endpoint, config_json = CAST(:config AS jsonb),
            secret_ref = :secret_ref,
            version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id AND version = :version
        """,
        {
            "name": name,
            "endpoint": endpoint,
            "config": jsonb(config),
            "secret_ref": secret_ref,
            "now": now,
            "id": connection_id,
            "tenant_id": tenant_id,
            "version": body.version,
        },
    )
    if updated != 1:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This connection was modified elsewhere. Reload it and try again.")
    await execute(
        session,
        f"""
        UPDATE acquisition_jobs
        SET config_revision = config_revision + 1, version = version + 1,
            timeout_ms = :timeout_ms{', interval_ms = :interval_ms' if interval is not None else ''}
        WHERE connection_id = :connection_id
        """,
        {"connection_id": connection_id, "timeout_ms": int(config.get("timeout_ms") or 3000), **({"interval_ms": interval} if interval is not None else {})},
    )
    if current.get("edge_id"):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
    else:
        await _notify_config_changed(session, tenant_id)
    await audit(session, tenant_id=tenant_id, event_type="CONNECTION_UPDATE", actor_id=actor, entity_type="connection", entity_id=connection_id, before={"version": current["version"]}, after={"version": int(current["version"]) + 1, "name": name}, correlation_id=correlation_id)
    result = await get_connection(session, tenant_id, connection_id)
    paths = await fetch_one(
        session,
        """
        SELECT count(DISTINCT COALESCE(f.address_json->>'path', '/')) AS paths
        FROM acquisition_jobs j JOIN source_fields f ON f.acquisition_job_id = j.id
        WHERE j.connection_id = :id
        """,
        {"id": connection_id},
    )
    job_interval = interval if interval is not None else (result["jobs"][0]["interval_ms"] if result.get("jobs") else None)
    warnings = _connection_warnings(protocol, config, job_interval, path_count=int((paths or {}).get("paths") or 1))
    if warnings:
        result["warnings"] = warnings
    return result


async def archive_connection(session: AsyncSession, tenant_id: UUID, actor: UUID, connection_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _connection_row(session, tenant_id, connection_id, lock=True)
    if current["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "Connection is already archived.")
    if current["status"] not in {"DRAFT", "PAUSED"}:
        raise AppError(
            409,
            "CONNECTION_IN_USE",
            "Pause the connection before archiving it.",
        )
    await execute(
        session,
        "UPDATE connections SET status = 'ARCHIVED', health = 'UNKNOWN', version = version + 1, updated_at = :now WHERE id = :id",
        {"now": utcnow(), "id": connection_id},
    )
    # Signals keep their definitions and history; their bindings to the archived source stop.
    await execute(
        session,
        """
        UPDATE signal_bindings SET enabled = FALSE
        WHERE valid_to IS NULL AND enabled = TRUE AND source_field_id IN (
            SELECT f.id FROM source_fields f JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
            WHERE j.connection_id = :connection_id
        )
        """,
        {"connection_id": connection_id},
    )
    if current.get("edge_id"):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
    else:
        await _notify_config_changed(session, tenant_id)
    await audit(
        session,
        tenant_id=tenant_id,
        event_type="CONNECTION_ARCHIVE",
        actor_id=actor,
        entity_type="connection",
        entity_id=connection_id,
        before={"status": current["status"]},
        after={"status": "ARCHIVED"},
        correlation_id=correlation_id,
    )
    return {"id": str(connection_id), "status": "ARCHIVED"}
