"""Connections, signals, formulas, output groups, releases and edge enrollment."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import replace
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.body import ALIAS_RE as BODY_ALIAS_RE
from factorix.domain.body import (
    BUILTIN_TEMPLATES,
    DEFAULT_EMIT_POLICY,
    DEFAULT_TEMPLATE_TOPIC,
    BodyError,
    Member,
    as_utc,
    fmt_ms,
    normalize_emit_policy,
    normalize_members,
    normalize_projection,
)
from factorix.domain.formula import FormulaError, bind, detect_cycles, evaluate, output_quality, parse_expression
from factorix.domain.jsonpath import MappingError, apply_cardinality, compile_path, evaluate as eval_path, suggest_type
from factorix.domain.units import add_units
from factorix.domain.signal_state import evaluate_signal_state
from factorix.domain.uns import TopicError, render_topic
from factorix.modules import models_engine
from factorix.domain.health import effective_connection_health, effective_edge_health
from factorix.modules.common import as_uuid, audit, execute, execute_rowcount, fetch_all, fetch_one, iso_ms, jsonb, parse_uuid, queue_stream_event, utcnow
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
from factorix.platform.security import encrypt_secret, new_token, hash_token

CAPABILITIES = {
    "modbus_tcp": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "opcua": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": True, "can_write": False},
    "mqtt": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
    "http": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "websocket": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
}
SUBSCRIBE_PROTOCOLS = {"mqtt", "websocket"}
_SECRET_AUTH = {"api_key", "basic", "bearer"}


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    site_id: str
    edge_id: str | None = None
    protocol: str
    config: dict[str, Any]
    secret_input: str | None = None


class ConnectionPatch(BaseModel):
    version: int
    name: str | None = None
    config: dict[str, Any] | None = None
    secret_input: str | None = None


class JobIn(BaseModel):
    connection_id: str
    mode: str
    interval_ms: int | None = 1000
    timeout_ms: int = 3000
    enabled: bool = True


class SignalBulkItem(BaseModel):
    key: str
    name: str
    data_type: str
    unit: str | None = None
    expected_interval_ms: int | None = None
    source_field: dict[str, Any] | None = None


class SignalBulkIn(BaseModel):
    resource_id: str
    items: list[SignalBulkItem]
    atomic: bool = True


class SignalPatch(BaseModel):
    version: int
    display_name: str | None = None
    description: str | None = None
    unit: str | None = None
    expected_interval_ms: int | None = None
    enabled: bool | None = None
    connection_id: str | None = None


class SignalBulkActionIn(BaseModel):
    signal_ids: list[str]
    action: str  # "enable" | "disable" | "delete"


class CaptureIn(BaseModel):
    topics: list[str] = Field(default_factory=list)
    topic_filter: str | None = None
    duration_seconds: int = 10
    max_messages: int = 100
    browse_node: str | None = None


class FormulaIn(BaseModel):
    signal_id: str | None = None
    resource_id: str | None = None
    key: str | None = None
    display_name: str | None = None
    expression: str
    aliases: dict[str, str]
    unit: str | None = None
    temporal_policy: dict[str, Any] = Field(default_factory=lambda: {"mode": "LATEST_WITH_MAX_AGE", "max_age_ms": 10000})

    @field_validator("temporal_policy", mode="before")
    @classmethod
    def _temporal_policy(cls, value: Any) -> Any:
        if value == "LATEST":
            return {"mode": "LATEST_WITH_MAX_AGE", "max_age_ms": 10000}
        if isinstance(value, str) and value:
            return {"mode": value}
        return value


class PreviewIn(BaseModel):
    expression: str
    values: dict[str, Any] = Field(default_factory=dict)
    qualities: dict[str, str] = Field(default_factory=dict)
    aliases: dict[str, str] = Field(default_factory=dict)


class MappingPreviewIn(BaseModel):
    expression: str
    document: Any
    cardinality: str = "REJECT_MULTI"
    missing: str = "NULL"
    samples: list[Any] = Field(default_factory=list)


class OutputGroupIn(BaseModel):
    resource_id: str
    key: str
    display_name: str
    kind: str = "STATE"
    topic_template: str = "fx/v1/{enterprise}/{site}/{plant}/{zone}/{line}/{resource}/{group}"
    members: list[dict[str, Any]] = Field(default_factory=list)
    projection_policy: dict[str, Any] = Field(default_factory=lambda: {"mode": "compact", "missing": "null"})
    emit_policy: dict[str, Any] | None = None
    template_id: str | None = None


class OutputGroupPatch(BaseModel):
    version: int
    resource_id: str | None = None
    display_name: str | None = None
    kind: str | None = None
    topic_template: str | None = None
    members: list[dict[str, Any]] | None = None
    projection_policy: dict[str, Any] | None = None
    emit_policy: dict[str, Any] | None = None


class OutputGroupPublishIn(BaseModel):
    version: int | None = None


class OutputGroupDuplicateIn(BaseModel):
    resource_id: str
    display_name: str | None = None
    key: str | None = None


class ModelTemplateIn(BaseModel):
    key: str
    display_name: str
    description: str = ""
    kind: str = "STATE"
    topic_template: str = DEFAULT_TEMPLATE_TOPIC
    fields: list[dict[str, Any]]
    emit_policy: dict[str, Any] | None = None


class ModelTemplatePatch(BaseModel):
    version: int
    display_name: str | None = None
    description: str | None = None
    kind: str | None = None
    topic_template: str | None = None
    fields: list[dict[str, Any]] | None = None
    emit_policy: dict[str, Any] | None = None


class TemplateApplyIn(BaseModel):
    resource_ids: list[str]
    publish: bool = False
    dry_run: bool = False


class EdgeIn(BaseModel):
    name: str
    site_id: str


class EdgePatch(BaseModel):
    name: str


class ReleaseIn(BaseModel):
    edge_id: str


async def _owned_edge(session: AsyncSession, tenant_id: UUID, edge_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM edge_nodes WHERE id = :id AND tenant_id = :tenant_id",
        {"id": edge_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Edge not found.")
    row.pop("credential_hash", None)
    return row


async def create_edge(session: AsyncSession, tenant_id: UUID, actor: UUID, body: EdgeIn, correlation_id: str) -> dict[str, Any]:
    edge_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO edge_nodes (
            id, tenant_id, site_id, name, enrollment_status, desired_revision, active_revision, health, created_at
        ) VALUES (
            :id, :tenant_id, :site_id, :name, 'UNENROLLED', 0, 0, 'UNKNOWN', :now
        )
        """,
        {"id": edge_id, "tenant_id": tenant_id, "site_id": parse_uuid(body.site_id), "name": body.name.strip(), "now": utcnow()},
    )
    await audit(session, tenant_id=tenant_id, event_type="EDGE_CREATE", actor_id=actor, entity_type="edge", entity_id=edge_id, before=None, after={"name": body.name.strip()}, correlation_id=correlation_id)
    row = await _owned_edge(session, tenant_id, edge_id)
    row.pop("credential_hash", None)
    return row


async def issue_enrollment(session: AsyncSession, tenant_id: UUID, edge_id: UUID, actor: UUID, correlation_id: str) -> dict[str, Any]:
    await _owned_edge(session, tenant_id, edge_id)
    token = new_token()
    expires = utcnow() + timedelta(minutes=30)
    await execute(
        session,
        """
        INSERT INTO edge_enrollment_tokens (id, edge_id, token_hash, expires_at)
        VALUES (:id, :edge_id, :token_hash, :expires_at)
        """,
        {"id": uuid4(), "edge_id": edge_id, "token_hash": hash_token(token), "expires_at": expires},
    )
    await audit(session, tenant_id=tenant_id, event_type="EDGE_ENROLL_TOKEN", actor_id=actor, entity_type="edge", entity_id=edge_id, before=None, after={"ttl_minutes": 30}, correlation_id=correlation_id)
    return {
        "enrollment_token": token,
        "expires_in_seconds": 1800,
        "expires_at": expires.isoformat().replace("+00:00", "Z"),
        "edge_id": str(edge_id),
    }


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

    edge = None
    if body.edge_id:
        edge = await _owned_edge(session, tenant_id, parse_uuid(body.edge_id))
    else:
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
    body.edge_id = str(edge["id"])
    if str(edge["site_id"]) != str(site_id):
        raise AppError(422, "SCOPE", "Edge does not belong to the selected site.")
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
            "edge_id": as_uuid(edge["id"]),
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
    await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(edge["id"]))
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
    edge = await fetch_one(
        session,
        "SELECT id, name, enrollment_status, health, last_heartbeat, desired_revision, active_revision FROM edge_nodes WHERE id = :id",
        {"id": as_uuid(row["edge_id"])},
    )
    counts = await _active_binding_counts(session, [connection_id])
    if edge is not None:
        row["edge_name"] = edge["name"]
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
               COALESCE(obs.messages_per_min, 0) AS messages_per_min,
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
        LEFT JOIN (
            SELECT o.connection_id, count(*) AS messages_per_min
            FROM observations o
            WHERE o.tenant_id = :tenant_id AND o.event_time >= now() - INTERVAL '60 seconds'
            GROUP BY o.connection_id
        ) obs ON obs.connection_id = c.id
        WHERE {' AND '.join(where)}
        ORDER BY c.name
        """,
        params,
    )
    now = utcnow()
    for row in rows:
        edge = None
        if row.get("edge_id"):
            edge = {
                "enrollment_status": row.pop("edge_enrollment_status", None),
                "health": row.pop("edge_raw_health", None),
                "last_heartbeat": row.pop("edge_last_heartbeat", None),
            }
        row["signal_count"] = int(row.get("signal_count") or 0)
        row["messages_per_min"] = int(row.get("messages_per_min") or 0)
        _decorate_connection(row, active_bindings=row["signal_count"], edge=edge, now=now)
    return rows


def _signal_type(value: str) -> str:
    return "bool" if value == "boolean" else value


async def bump_edge_release(session: AsyncSession, tenant_id: UUID, actor: UUID, correlation_id: str, edge_id: UUID | None = None) -> None:
    """Publish a new configuration release for one edge, or for every non-revoked edge of the tenant.

    Errors propagate: a failed release must fail the mutation that needed it (no silent drift
    between the stored configuration and what the edge runs). Unenrolled edges are included so
    the snapshot they receive on enrollment is current.
    """
    if actor is None:
        admin_row = await fetch_one(session, "SELECT id FROM admin_accounts WHERE tenant_id = :tenant_id ORDER BY created_at ASC LIMIT 1", {"tenant_id": tenant_id})
        if admin_row:
            actor = as_uuid(admin_row["id"])
    if edge_id is not None:
        edges = [{"id": edge_id}]
    else:
        edges = await fetch_all(
            session,
            "SELECT id FROM edge_nodes WHERE tenant_id = :tenant_id AND enrollment_status <> 'REVOKED' ORDER BY id",
            {"tenant_id": tenant_id},
        )
    for e in edges:
        await publish_release(session, tenant_id, actor, ReleaseIn(edge_id=str(e["id"])), correlation_id)


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
    await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
    await audit(session, tenant_id=tenant_id, event_type="CONNECTION_PAUSE", actor_id=actor, entity_type="connection", entity_id=connection_id, before={"status": current["status"]}, after={"status": "PAUSED"}, correlation_id=correlation_id)
    result = await get_connection(session, tenant_id, connection_id)
    _queue_connection_health(session, tenant_id, result)
    return result


async def resume_connection(session: AsyncSession, tenant_id: UUID, actor: UUID, connection_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _connection_row(session, tenant_id, connection_id, lock=True)
    if current["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "Archived connections cannot be resumed.")
    # No evidence yet: UNKNOWN until the edge reports the connection or a sample arrives.
    await execute(
        session,
        "UPDATE connections SET status = 'ACTIVE', health = 'UNKNOWN', last_error = NULL, version = version + 1, updated_at = :now WHERE id = :id",
        {"now": utcnow(), "id": connection_id},
    )
    await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
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
    await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
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


async def capture_connection(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    connection_id: UUID,
    body: CaptureIn,
    correlation_id: str,
) -> dict[str, Any]:
    conn = await get_connection(session, tenant_id, connection_id)
    edge = await _owned_edge(session, tenant_id, as_uuid(conn["edge_id"]))
    if edge.get("enrollment_status") != "ENROLLED":
        raise AppError(409, "EDGE_NOT_ENROLLED", "No enrolled collector for this site. Enroll the Edge first.")

    topic_filter = body.topic_filter or (body.topics[0] if body.topics else "#")
    meta = {
        "command_type": "CAPTURE",
        "topic_filter": topic_filter,
        "topics": body.topics or [topic_filter],
        "seconds": min(max(1, body.duration_seconds), 60),
        "max_messages": min(max(1, body.max_messages), 200),
        "browse_node": body.browse_node,
    }
    stages = [{"stage": "CAPTURE", "status": "PENDING", "duration_ms": None, "detail": ""}]
    job_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO commissioning_jobs (
            id, tenant_id, connection_id, requested_by, stages_json, status, diagnostic, samples_json, started_at
        ) VALUES (
            :id, :tenant_id, :connection_id, :actor, CAST(:stages AS jsonb), 'PENDING', '', CAST(:samples AS jsonb), :now
        )
        """,
        {
            "id": job_id,
            "tenant_id": tenant_id,
            "connection_id": connection_id,
            "actor": actor,
            "stages": jsonb(stages),
            "samples": jsonb({"meta": meta}),
            "now": utcnow(),
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="CAPTURE_REQUEST", actor_id=actor, entity_type="connection", entity_id=connection_id, before=None, after={"job_id": str(job_id), "protocol": conn["protocol"]}, correlation_id=correlation_id)
    return {"job_id": str(job_id), "status": "PENDING", "poll_url": f"/api/v1/commissioning/{job_id}"}


async def bulk_signals(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: SignalBulkIn,
    correlation_id: str,
) -> dict[str, Any]:
    if not body.items or len(body.items) > 500:
        raise AppError(422, "LIMIT", "Create between 1 and 500 signals at a time.")
    resource_id = parse_uuid(body.resource_id)
    resource = await fetch_one(session, "SELECT id, archived_at, site_id FROM resources WHERE id = :id AND tenant_id = :tenant_id", {"id": resource_id, "tenant_id": tenant_id})
    if resource is None:
        raise AppError(404, "NOT_FOUND", "Resource not found.")
    if resource["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Cannot add signals to an archived resource.")
    errors: list[dict[str, str]] = []
    prepared: list[dict[str, Any]] = []
    seen: set[str] = set()
    has_site_mismatch = False

    for index, item in enumerate(body.items):
        key = item.key.strip()
        if not key or len(key) > 64:
            errors.append({"path": f"items[{index}].key", "code": "INVALID"})
            continue
        if key in seen:
            errors.append({"path": f"items[{index}].key", "code": "DUPLICATE"})
            continue
        raw_type = item.data_type.lower()
        if raw_type == "float32":
            data_type = "float64"
        else:
            data_type = _signal_type(raw_type)
        if data_type not in {"bool", "int64", "float64", "string", "enum", "json"}:
            errors.append({"path": f"items[{index}].data_type", "code": "INVALID"})
            continue

        source = item.source_field
        if source:
            address = source.get("address") or {}
            native_type = str(address.get("native_type", "")).lower()
            if data_type == "string" and native_type in {"uint16", "int16", "uint32", "int32", "float32", "float64"}:
                errors.append({"path": f"items[{index}].data_type", "code": "TYPE"})
                continue
            if source.get("address_kind") == "mqtt_jsonpath":
                jp = str(address.get("jsonpath", "")).strip()
                if not jp.startswith("$"):
                    errors.append({"path": f"items[{index}].source_field.address", "code": "INVALID_JSONPATH"})
                    continue
            if source.get("acquisition_job_id"):
                job_id = parse_uuid(str(source["acquisition_job_id"]))
                job_site = await fetch_one(
                    session,
                    """
                    SELECT c.site_id FROM acquisition_jobs j
                    JOIN connections c ON c.id = j.connection_id
                    WHERE j.id = :id AND c.tenant_id = :tenant_id
                    """,
                    {"id": job_id, "tenant_id": tenant_id},
                )
                if job_site is None:
                    errors.append({"path": f"items[{index}].source_field.acquisition_job_id", "code": "JOB"})
                    continue
                if resource.get("site_id") and job_site.get("site_id") and str(resource["site_id"]) != str(job_site["site_id"]):
                    has_site_mismatch = True
                    errors.append({"path": f"items[{index}].source_field.acquisition_job_id", "code": "SITE_MISMATCH"})
                    continue

        seen.add(key)
        exists = await fetch_one(
            session,
            "SELECT id FROM signal_definitions WHERE resource_id = :resource_id AND key = :key AND status = 'ACTIVE'",
            {"resource_id": resource_id, "key": key},
        )
        if exists:
            errors.append({"path": f"items[{index}].key", "code": "DUPLICATE"})
            continue
        dumped = item.model_dump()
        dumped["data_type"] = data_type
        prepared.append(dumped)

    if errors and body.atomic:
        if has_site_mismatch:
            raise AppError(422, "SITE_MISMATCH", "Resource and connection must belong to the same site.", field_errors=errors)
        raise AppError(422, "BULK_REJECTED", "No signals were created because some rows have errors.", field_errors=errors)
    created: list[str] = []
    now = utcnow()
    for item in prepared:
        signal_id = uuid4()
        await execute(
            session,
            """
            INSERT INTO signal_definitions (
                id, tenant_id, resource_id, key, display_name, data_type, unit, category,
                expected_interval_ms, status, version, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :resource_id, :key, :display_name, :data_type, :unit, 'COLLECTED',
                :interval, 'ACTIVE', 1, :now, :now
            )
            """,
            {
                "id": signal_id,
                "tenant_id": tenant_id,
                "resource_id": resource_id,
                "key": item["key"].strip(),
                "display_name": item["name"].strip(),
                "data_type": item["data_type"],
                "unit": item["unit"],
                "interval": item["expected_interval_ms"],
                "now": now,
            },
        )
        source = item.get("source_field")
        if source:
            job_id = parse_uuid(str(source["acquisition_job_id"]))
            job = await fetch_one(
                session,
                """
                SELECT j.id FROM acquisition_jobs j
                JOIN connections c ON c.id = j.connection_id
                WHERE j.id = :id AND c.tenant_id = :tenant_id
                """,
                {"id": job_id, "tenant_id": tenant_id},
            )
            if job is None:
                raise AppError(422, "JOB", "Acquisition job does not belong to the tenant.")
            field_id = uuid4()
            await execute(
                session,
                """
                INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
                VALUES (:id, :job_id, :kind, CAST(:address AS jsonb), :native, CAST(:decode AS jsonb), 0)
                """,
                {
                    "id": field_id,
                    "job_id": job_id,
                    "kind": source.get("address_kind", "modbus_register"),
                    "address": jsonb(source.get("address", {})),
                    "native": source.get("address", {}).get("native_type", item["data_type"]),
                    "decode": jsonb({"scale": source.get("scale", 1), "offset": source.get("offset", 0)}),
                },
            )
            await execute(
                session,
                """
                INSERT INTO signal_bindings (id, signal_id, source_field_id, transform_chain_json, enabled, revision, valid_from)
                VALUES (:id, :signal_id, :field_id, '[]'::jsonb, TRUE, 1, :now)
                """,
                {"id": uuid4(), "signal_id": signal_id, "field_id": field_id, "now": now},
            )
        created.append(str(signal_id))
    if created:
        await bump_edge_release(session, tenant_id, actor, correlation_id)
    await audit(session, tenant_id=tenant_id, event_type="SIGNAL_BULK", actor_id=actor, entity_type="resource", entity_id=resource_id, before=None, after={"created": len(created)}, correlation_id=correlation_id)
    return {"created": created, "count": len(created)}


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


async def _edges_of_signals(session: AsyncSession, signal_ids: list[UUID]) -> set[UUID]:
    if not signal_ids:
        return set()
    rows = await fetch_all(
        session,
        """
        SELECT DISTINCT c.edge_id
        FROM signal_bindings b
        JOIN source_fields f ON f.id = b.source_field_id
        JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        JOIN connections c ON c.id = j.connection_id
        WHERE b.signal_id = ANY(:ids) AND b.valid_to IS NULL
        """,
        {"ids": signal_ids},
    )
    return {as_uuid(row["edge_id"]) for row in rows if row.get("edge_id")}


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
    return {as_uuid(current["edge_id"]), as_uuid(target["edge_id"])}


async def patch_signal(session: AsyncSession, tenant_id: UUID, actor: UUID, signal_id: UUID, body: SignalPatch, correlation_id: str) -> dict[str, Any]:
    current = await _signal(session, tenant_id, signal_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This signal was modified elsewhere. Reload it and try again.")
    if current["status"] != "ACTIVE":
        raise AppError(409, "ARCHIVED", "Archived signals cannot be modified.")
    if body.expected_interval_ms is not None and not (100 <= body.expected_interval_ms <= 86_400_000):
        raise AppError(422, "INTERVAL", "Expected interval must be between 100 ms and one day.", field_errors=[{"path": "expected_interval_ms", "code": "RANGE"}])
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
    if body.connection_id:
        edges |= await _rebind_signal(session, tenant_id, signal_id, parse_uuid(body.connection_id))
    if body.enabled is not None:
        edges |= await _edges_of_signals(session, [signal_id])
        await _set_binding_enabled(session, [signal_id], body.enabled)
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)

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
        },
        correlation_id=correlation_id,
    )
    return await _signal(session, tenant_id, signal_id)


async def delete_signal(session: AsyncSession, tenant_id: UUID, actor: UUID, signal_id: UUID, correlation_id: str) -> dict[str, Any]:
    sig = await _signal(session, tenant_id, signal_id)
    now = utcnow()
    edges = await _edges_of_signals(session, [signal_id])
    await execute(session, "UPDATE signal_definitions SET status = 'ARCHIVED', version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id", {"now": now, "id": signal_id, "tenant_id": tenant_id})
    await _set_binding_enabled(session, [signal_id], False)
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    await audit(session, tenant_id=tenant_id, event_type="SIGNAL_DELETE", actor_id=actor, entity_type="signal", entity_id=signal_id, before={"status": sig["status"]}, after={"status": "ARCHIVED"}, correlation_id=correlation_id)
    return {"id": str(signal_id), "status": "ARCHIVED"}


async def bulk_action_signals(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SignalBulkActionIn, correlation_id: str) -> dict[str, Any]:
    if not body.signal_ids:
        return {"affected": 0, "action": body.action.lower()}
    if len(body.signal_ids) > 1000:
        raise AppError(422, "LIMIT", "At most 1000 signals per bulk action.")
    action = body.action.lower()
    if action not in {"enable", "disable", "delete"}:
        raise AppError(422, "INVALID_ACTION", f"Unknown bulk action '{body.action}'.")
    requested = [parse_uuid(s) for s in body.signal_ids]
    owned = await fetch_all(
        session,
        "SELECT id FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids) AND status = 'ACTIVE'",
        {"tenant_id": tenant_id, "ids": requested},
    )
    ids = [as_uuid(row["id"]) for row in owned]
    if not ids:
        return {"affected": 0, "action": action}
    now = utcnow()
    edges = await _edges_of_signals(session, ids)
    if action == "enable":
        await _set_binding_enabled(session, ids, True)
        await execute(session, "UPDATE signal_definitions SET version = version + 1, updated_at = :now WHERE id = ANY(:ids) AND tenant_id = :tenant_id", {"now": now, "ids": ids, "tenant_id": tenant_id})
    elif action == "disable":
        await _set_binding_enabled(session, ids, False)
        await execute(session, "UPDATE signal_definitions SET version = version + 1, updated_at = :now WHERE id = ANY(:ids) AND tenant_id = :tenant_id", {"now": now, "ids": ids, "tenant_id": tenant_id})
    else:
        await execute(session, "UPDATE signal_definitions SET status = 'ARCHIVED', version = version + 1, updated_at = :now WHERE id = ANY(:ids) AND tenant_id = :tenant_id", {"now": now, "ids": ids, "tenant_id": tenant_id})
        await _set_binding_enabled(session, ids, False)
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    await audit(session, tenant_id=tenant_id, event_type=f"SIGNAL_BULK_{action.upper()}", actor_id=actor, entity_type="signal", entity_id=ids[0], before=None, after={"action": action, "count": len(ids), "ids": [str(item) for item in ids]}, correlation_id=correlation_id)
    return {"affected": len(ids), "action": action}


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
               c.id AS connection_id, c.name AS connection_name, c.protocol AS connection_protocol,
               e.id AS edge_id, e.name AS edge_name,
               f.address_kind, f.address_json, j.id AS job_id, b.enabled AS binding_enabled
        FROM signal_definitions s
        JOIN resources r ON r.id = s.resource_id
        LEFT JOIN LATERAL (
            SELECT b.id, b.source_field_id, b.enabled
            FROM signal_bindings b
            WHERE b.signal_id = s.id AND b.enabled = TRUE AND b.valid_to IS NULL
            ORDER BY b.valid_from DESC, b.revision DESC
            LIMIT 1
        ) b ON TRUE
        LEFT JOIN source_fields f ON f.id = b.source_field_id
        LEFT JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        LEFT JOIN connections c ON c.id = j.connection_id
        LEFT JOIN edge_nodes e ON e.id = c.edge_id
        WHERE {' AND '.join(where)}
        ORDER BY r.code, s.key
        LIMIT :limit
        """,
        params,
    )
    for row in rows:
        if row.get("data_type") == "bool":
            row["data_type"] = "boolean"
        row["signal_id"] = str(row["id"])
        conn_id = str(row["connection_id"]) if row.get("connection_id") else None
        row["connection_id"] = conn_id
        row["enabled"] = bool(row.get("binding_enabled", True))
        if conn_id:
            row["source"] = {
                "connection_id": conn_id,
                "connection_name": str(row.get("connection_name") or ""),
                "edge_id": str(row["edge_id"]) if row.get("edge_id") else None,
                "edge_name": str(row.get("edge_name") or ""),
                "protocol": str(row.get("connection_protocol") or ""),
                "address_kind": str(row.get("address_kind") or ""),
                "job_id": str(row["job_id"]) if row.get("job_id") else None,
            }
        else:
            row["source"] = None
    return rows


def validate_mapping(body: MappingPreviewIn) -> dict[str, Any]:
    try:
        compile_path(body.expression)
        matches = eval_path(body.expression, body.document)
        result = apply_cardinality(matches, cardinality=body.cardinality, missing=body.missing)  # type: ignore[arg-type]
    except MappingError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    return {
        "present": result.present,
        "value": result.value,
        "match_count": result.match_count,
        "quality_override": result.quality_override,
        "suggested_type": suggest_type(body.samples or matches),
    }


async def save_formula(session: AsyncSession, tenant_id: UUID, actor: UUID, body: FormulaIn, correlation_id: str) -> dict[str, Any]:
    try:
        program = parse_expression(body.expression)
        alias_ids = {name: parse_uuid(signal_id) for name, signal_id in body.aliases.items()}
        bind(program, alias_ids)
    except FormulaError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    for signal_id in alias_ids.values():
        await _signal(session, tenant_id, signal_id)
    if body.unit and len(alias_ids) >= 2 and "/" not in body.expression and "+" in body.expression:
        units = []
        for signal_id in alias_ids.values():
            row = await _signal(session, tenant_id, signal_id)
            units.append(row["unit"])
        if len(units) >= 2:
            check = add_units(units[0], units[1])
            if not check.compatible:
                raise AppError(422, "UNIT", check.reason)
    signal_id: UUID
    if body.signal_id:
        signal_id = parse_uuid(body.signal_id)
        await _signal(session, tenant_id, signal_id)
    else:
        if not body.resource_id or not body.key or not body.display_name:
            raise AppError(422, "SIGNAL", "Calculated signals require a resource, key, and name.")
        signal_id = uuid4()
        now = utcnow()
        await execute(
            session,
            """
            INSERT INTO signal_definitions (
                id, tenant_id, resource_id, key, display_name, data_type, unit, category, status, version, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :resource_id, :key, :name, 'float64', :unit, 'CALCULATED', 'ACTIVE', 1, :now, :now
            )
            """,
            {
                "id": signal_id,
                "tenant_id": tenant_id,
                "resource_id": parse_uuid(body.resource_id),
                "key": body.key.strip(),
                "name": body.display_name.strip(),
                "unit": body.unit,
                "now": now,
            },
        )
    formula_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO formula_definitions (
            id, signal_id, expression_source, ast_json, unit, temporal_policy_json, revision, status
        ) VALUES (
            :id, :signal_id, :expression, CAST(:ast AS jsonb), :unit, CAST(:policy AS jsonb), 1, 'DRAFT'
        )
        ON CONFLICT (signal_id) DO UPDATE SET
            expression_source = EXCLUDED.expression_source,
            ast_json = EXCLUDED.ast_json,
            unit = EXCLUDED.unit,
            temporal_policy_json = EXCLUDED.temporal_policy_json,
            revision = formula_definitions.revision + 1,
            status = 'DRAFT'
        """,
        {
            "id": formula_id,
            "signal_id": signal_id,
            "expression": body.expression,
            "ast": jsonb({"normalized": program.analysis.normalized, "names": list(program.analysis.names)}),
            "unit": body.unit,
            "policy": jsonb(body.temporal_policy),
        },
    )
    stored = await fetch_one(session, "SELECT id FROM formula_definitions WHERE signal_id = :signal_id", {"signal_id": signal_id})
    assert stored is not None
    await execute(session, "DELETE FROM formula_dependencies WHERE formula_id = :id", {"id": as_uuid(stored["id"])})
    for alias, dep in alias_ids.items():
        await execute(
            session,
            """
            INSERT INTO formula_dependencies (formula_id, variable_alias, dependency_signal_id)
            VALUES (:formula_id, :alias, :dep)
            """,
            {"formula_id": as_uuid(stored["id"]), "alias": alias, "dep": dep},
        )
    await audit(session, tenant_id=tenant_id, event_type="FORMULA_DRAFT", actor_id=actor, entity_type="formula", entity_id=as_uuid(stored["id"]), before=None, after={"signal_id": str(signal_id)}, correlation_id=correlation_id)
    return {"id": stored["id"], "signal_id": str(signal_id), "status": "DRAFT", "warnings": list(program.analysis.warnings)}


async def publish_formula(session: AsyncSession, tenant_id: UUID, actor: UUID, formula_id: UUID, correlation_id: str) -> dict[str, Any]:
    formula = await fetch_one(
        session,
        """
        SELECT f.*, s.tenant_id FROM formula_definitions f
        JOIN signal_definitions s ON s.id = f.signal_id
        WHERE f.id = :id AND s.tenant_id = :tenant_id
        """,
        {"id": formula_id, "tenant_id": tenant_id},
    )
    if formula is None:
        raise AppError(404, "NOT_FOUND", "Formula not found.")
    graph = await _formula_graph(session, tenant_id)
    deps = await fetch_all(
        session,
        "SELECT dependency_signal_id FROM formula_dependencies WHERE formula_id = :id",
        {"id": formula_id},
    )
    graph[as_uuid(formula["signal_id"])] = {as_uuid(item["dependency_signal_id"]) for item in deps}
    try:
        detect_cycles(graph)
    except FormulaError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    await execute(session, "UPDATE formula_definitions SET status = 'PUBLISHED', revision = revision + 1 WHERE id = :id", {"id": formula_id})
    await audit(session, tenant_id=tenant_id, event_type="FORMULA_PUBLISH", actor_id=actor, entity_type="formula", entity_id=formula_id, before={"status": formula["status"]}, after={"status": "PUBLISHED"}, correlation_id=correlation_id)
    return {"id": str(formula_id), "status": "PUBLISHED"}


async def _formula_graph(session: AsyncSession, tenant_id: UUID) -> dict[UUID, set[UUID]]:
    rows = await fetch_all(
        session,
        """
        SELECT f.signal_id, d.dependency_signal_id
        FROM formula_definitions f
        JOIN signal_definitions s ON s.id = f.signal_id
        LEFT JOIN formula_dependencies d ON d.formula_id = f.id
        WHERE s.tenant_id = :tenant_id AND f.status = 'PUBLISHED'
        """,
        {"tenant_id": tenant_id},
    )
    graph: dict[UUID, set[UUID]] = {}
    for row in rows:
        node = as_uuid(row["signal_id"])
        graph.setdefault(node, set())
        if row["dependency_signal_id"]:
            graph[node].add(as_uuid(row["dependency_signal_id"]))
    return graph


def preview_formula(body: PreviewIn) -> dict[str, Any]:
    try:
        program = parse_expression(body.expression)
        if body.aliases:
            bind(program, {name: parse_uuid(value) for name, value in body.aliases.items()})
        value = evaluate(program, body.values)
    except FormulaError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    qualities = [body.qualities.get(name, "GOOD") for name in program.analysis.names]
    return {
        "value": value,
        "quality": output_quality(qualities, value),
        "warnings": list(program.analysis.warnings),
        "dependencies": list(program.analysis.names),
    }


# ============================================================================================
# Data models (output groups) and model templates
# ============================================================================================

ALIAS_RE = BODY_ALIAS_RE
TOPIC_ROLES = ("enterprise", "site", "plant", "area", "zone", "workshop", "line", "cell", "machine")
ALLOWED_TEMPLATE_VARS = set(TOPIC_ROLES) | {"resource", "group"}
GROUP_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_MEMBER_KIND_DB = {"signal": "SIGNAL", "snapshot": "SNAPSHOT", "context": "CONTEXT", "constant": "CONSTANT", "system": "SYSTEM"}


def _body_error(exc: BodyError) -> AppError:
    field_errors = [{"path": f"members.{exc.alias}", "code": exc.code}] if exc.alias else None
    return AppError(422, exc.code, str(exc), field_errors=field_errors)


def _validate_topic_template(topic_template: str) -> None:
    if not topic_template or not topic_template.strip():
        raise AppError(422, "TEMPLATE", "Topic template is required.")
    if topic_template.startswith("/"):
        raise AppError(422, "TEMPLATE", "Topic template cannot start with /.")
    if "#" in topic_template or "+" in topic_template:
        raise AppError(422, "TEMPLATE", "Topic template must not contain MQTT wildcards.")
    for name in re.findall(r"\{([a-zA-Z0-9_]+)\}", topic_template):
        if name not in ALLOWED_TEMPLATE_VARS:
            raise AppError(422, "TEMPLATE", f"Topic template contains unknown variable '{name}'.")


def _validate_group_spec(
    topic_template: str, members: list[dict[str, Any]], kind: str = "STATE", *, require_signal_ids: bool = False
) -> list[Member]:
    """Topic template plus the pure member rules of :func:`factorix.domain.body.normalize_members`."""
    _validate_topic_template(topic_template)
    try:
        return normalize_members(kind, members, require_signal_ids=require_signal_ids)
    except BodyError as exc:
        raise _body_error(exc) from exc


def _validate_group_key(key: str) -> str:
    cleaned = (key or "").strip()
    if not GROUP_KEY_RE.match(cleaned):
        raise AppError(422, "KEY_INVALID", "Key must be 1-64 letters, digits, '_', '-' or '.', starting with a letter or digit.", field_errors=[{"path": "key", "code": "KEY_INVALID"}])
    return cleaned


def _policies(kind: str | None, emit: dict[str, Any] | None, projection: dict[str, Any] | None, *, base_emit: dict[str, Any] | None = None) -> tuple[str, dict[str, Any], dict[str, Any]]:
    model_kind = str(kind or "STATE").upper()
    if model_kind not in ("STATE", "EVENT"):
        raise AppError(422, "MODEL_KIND", "Model kind must be STATE or EVENT.")
    try:
        return model_kind, normalize_emit_policy(emit, base_emit), normalize_projection(projection)
    except BodyError as exc:
        raise _body_error(exc) from exc


def _ms(value: Any) -> str | None:
    return fmt_ms(value)


async def _active_resource(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> dict[str, Any]:
    resource = await fetch_one(
        session,
        "SELECT id, code, name, status, archived_at FROM resources WHERE id = :id AND tenant_id = :tenant_id",
        {"id": resource_id, "tenant_id": tenant_id},
    )
    if resource is None:
        raise AppError(404, "NOT_FOUND", "Resource not found.")
    if resource.get("status") == "ARCHIVED" or resource.get("archived_at"):
        raise AppError(422, "RESOURCE_ARCHIVED", "The resource is archived.")
    return resource


async def _resolve_members(
    session: AsyncSession, tenant_id: UUID, resource_id: UUID, members: list[Member], *, rekey: bool
) -> tuple[list[Member], list[str]]:
    """Bind signal/snapshot members to ACTIVE signals of ``resource_id``.

    strict (``rekey=False``): a given ``signal_id`` must exist in the tenant, be ACTIVE and belong to
    the model's resource; a member with only ``signal_key`` is looked up on the resource.
    rekey (duplicate, template apply, resource change): a ``signal_id`` already on the resource is
    kept, otherwise the member is re-resolved by its signal key on the resource.
    Returns the bound members and the signal keys that could not be resolved.
    """
    wanted_ids = {UUID(m.signal_id) for m in members if m.kind in ("signal", "snapshot") and m.signal_id and _is_uuid(m.signal_id)}
    for m in members:
        if m.kind in ("signal", "snapshot") and m.signal_id and not _is_uuid(m.signal_id):
            raise AppError(422, "MEMBER_SIGNAL_INVALID", f"Member '{m.alias}' has an invalid signal id.", field_errors=[{"path": f"members.{m.alias}", "code": "MEMBER_SIGNAL_INVALID"}])
    by_id: dict[str, dict[str, Any]] = {}
    if wanted_ids:
        for row in await fetch_all(
            session,
            "SELECT id, key, resource_id, status FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
            {"tenant_id": tenant_id, "ids": list(wanted_ids)},
        ):
            by_id[str(row["id"])] = row
    on_resource: dict[str, dict[str, Any]] = {}
    for row in await fetch_all(
        session,
        "SELECT id, key FROM signal_definitions WHERE tenant_id = :tenant_id AND resource_id = :resource_id AND status = 'ACTIVE'",
        {"tenant_id": tenant_id, "resource_id": resource_id},
    ):
        on_resource[str(row["key"])] = row
    lowered = {key.lower(): row for key, row in on_resource.items()}

    resolved: list[Member] = []
    missing: list[str] = []
    for member in members:
        if member.kind not in ("signal", "snapshot"):
            resolved.append(member)
            continue
        signal = by_id.get(member.signal_id or "")
        if member.signal_id and not rekey:
            path = [{"path": f"members.{member.alias}", "code": "MEMBER_SIGNAL"}]
            if signal is None:
                raise AppError(422, "MEMBER_SIGNAL_NOT_FOUND", f"Signal of member '{member.alias}' was not found.", field_errors=path)
            if signal["status"] != "ACTIVE":
                raise AppError(422, "MEMBER_SIGNAL_ARCHIVED", f"Signal of member '{member.alias}' is not active.", field_errors=path)
            if str(signal["resource_id"]) != str(resource_id):
                raise AppError(422, "MEMBER_SIGNAL_OTHER_RESOURCE", f"Signal of member '{member.alias}' belongs to another resource.", field_errors=path)
            resolved.append(replace(member, signal_key=str(signal["key"])))
            continue
        if signal is not None and signal["status"] == "ACTIVE" and str(signal["resource_id"]) == str(resource_id):
            resolved.append(replace(member, signal_key=str(signal["key"])))
            continue
        key = member.signal_key or (str(signal["key"]) if signal is not None else None)
        target = None
        if key:
            target = on_resource.get(key) or lowered.get(key.lower())
        if target is None:
            missing.append(key or member.alias)
            continue
        resolved.append(replace(member, signal_id=str(target["id"]), signal_key=str(target["key"])))
    return resolved, missing


def _is_uuid(value: str) -> bool:
    try:
        UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


async def _insert_members(session: AsyncSession, group_id: UUID, members: list[Member]) -> None:
    for ordinal, member in enumerate(members):
        await execute(
            session,
            """
            INSERT INTO output_group_members (
                output_group_id, signal_id, output_alias, ordinal, member_kind, signal_key, context_ref,
                constant_json, system_field, contributes_ts, is_trigger
            ) VALUES (
                :group_id, :signal_id, :alias, :ordinal, :kind, :signal_key, :context_ref,
                CAST(:constant AS jsonb), :system_field, :contributes_ts, :is_trigger
            )
            """,
            {
                "group_id": group_id,
                "signal_id": UUID(member.signal_id) if member.kind in ("signal", "snapshot") and member.signal_id else None,
                "alias": member.alias,
                "ordinal": ordinal,
                "kind": _MEMBER_KIND_DB[member.kind],
                "signal_key": member.signal_key if member.kind in ("signal", "snapshot") else None,
                "context_ref": member.context_ref if member.kind == "context" else None,
                "constant": jsonb({"v": member.value}) if member.kind == "constant" else None,
                "system_field": member.field if member.kind == "system" else None,
                "contributes_ts": bool(member.contributes_ts),
                "is_trigger": bool(member.is_trigger),
            },
        )


async def _key_taken(session: AsyncSession, resource_id: UUID, key: str, *, exclude: UUID | None = None) -> dict[str, Any] | None:
    return await fetch_one(
        session,
        """
        SELECT id, status FROM output_groups
        WHERE resource_id = :resource_id AND key = :key AND status <> 'ARCHIVED'
          AND (CAST(:exclude AS uuid) IS NULL OR id <> CAST(:exclude AS uuid))
        """,
        {"resource_id": resource_id, "key": key, "exclude": exclude},
    )


def _conflict(exc: IntegrityError) -> AppError:
    return AppError(409, "OUTPUT_GROUP_CONFLICT", "The data model conflicts with an existing one (duplicate key or alias).", extra={"detail": str(exc.orig)[:200]})


async def _create_group(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    resource_id: UUID,
    key: str,
    display_name: str,
    kind: str,
    topic_template: str,
    members: list[Member],
    projection: dict[str, Any],
    emit_policy: dict[str, Any],
    template_id: UUID | None,
) -> UUID:
    if await _key_taken(session, resource_id, key):
        raise AppError(409, "OUTPUT_GROUP_EXISTS", f"A data model with key '{key}' already exists on this resource.", field_errors=[{"path": "key", "code": "DUPLICATE"}])
    group_id = uuid4()
    now = utcnow()
    try:
        await execute(
            session,
            """
            INSERT INTO output_groups (
                id, tenant_id, resource_id, key, display_name, topic_template, projection_policy_json, version, status,
                kind, emit_policy_json, template_id, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :resource_id, :key, :name, :topic, CAST(:policy AS jsonb), 1, 'DRAFT',
                :kind, CAST(:emit AS jsonb), :template_id, :now, :now
            )
            """,
            {
                "id": group_id,
                "tenant_id": tenant_id,
                "resource_id": resource_id,
                "key": key,
                "name": display_name,
                "topic": topic_template,
                "policy": jsonb(projection),
                "kind": kind,
                "emit": jsonb(emit_policy),
                "template_id": template_id,
                "now": now,
            },
        )
        await _insert_members(session, group_id, members)
    except IntegrityError as exc:
        raise _conflict(exc) from exc
    return group_id


async def create_output_group(session: AsyncSession, tenant_id: UUID, actor: UUID, body: OutputGroupIn, correlation_id: str) -> dict[str, Any]:
    resource = await _active_resource(session, tenant_id, parse_uuid(body.resource_id))
    key = _validate_group_key(body.key)
    display_name = body.display_name.strip()
    if not display_name:
        raise AppError(422, "NAME_REQUIRED", "Name is required.", field_errors=[{"path": "display_name", "code": "REQUIRED"}])
    kind, emit, projection = _policies(body.kind, body.emit_policy, body.projection_policy)
    members = _validate_group_spec(body.topic_template, body.members, kind)
    resolved, missing = await _resolve_members(session, tenant_id, as_uuid(resource["id"]), members, rekey=False)
    if missing:
        raise AppError(422, "MEMBERS_UNRESOLVED", "Some signal keys do not exist on this resource.", extra={"missing_keys": missing})
    template_id = None
    if body.template_id:
        template = await fetch_one(session, "SELECT id FROM model_templates WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(body.template_id), "tenant_id": tenant_id})
        if template is None:
            raise AppError(404, "NOT_FOUND", "Model template not found.")
        template_id = as_uuid(template["id"])
    group_id = await _create_group(
        session,
        tenant_id,
        resource_id=as_uuid(resource["id"]),
        key=key,
        display_name=display_name,
        kind=kind,
        topic_template=body.topic_template,
        members=resolved,
        projection=projection,
        emit_policy=emit,
        template_id=template_id,
    )
    await audit(session, tenant_id=tenant_id, event_type="OUTPUT_GROUP_DRAFT", actor_id=actor, entity_type="output_group", entity_id=group_id, before=None, after={"key": key, "kind": kind, "members": len(resolved)}, correlation_id=correlation_id)
    return await get_output_group(session, tenant_id, group_id)


async def _group_row(session: AsyncSession, tenant_id: UUID, group_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        """
        SELECT g.*, r.code AS resource_code, r.name AS resource_name
        FROM output_groups g JOIN resources r ON r.id = g.resource_id
        WHERE g.id = :id AND g.tenant_id = :tenant_id
        """,
        {"id": group_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Output group not found.")
    return row


def _group_out(row: dict[str, Any]) -> dict[str, Any]:
    emit = row.get("emit_policy_json")
    projection = row.get("projection_policy_json")
    return {
        "id": str(row["id"]),
        "tenant_id": str(row["tenant_id"]),
        "resource_id": str(row["resource_id"]),
        "resource_code": row.get("resource_code"),
        "resource_name": row.get("resource_name"),
        "key": row["key"],
        "display_name": row["display_name"],
        "kind": row.get("kind") or "STATE",
        "status": row["status"],
        "version": int(row["version"]),
        "topic_template": row["topic_template"],
        "projection_policy": json.loads(projection) if isinstance(projection, str) else projection,
        "emit_policy": json.loads(emit) if isinstance(emit, str) else emit,
        "template_id": str(row["template_id"]) if row.get("template_id") else None,
        "created_at": _ms(row.get("created_at")),
        "updated_at": _ms(row.get("updated_at")),
    }


async def _member_rows(session: AsyncSession, group_id: UUID) -> list[dict[str, Any]]:
    rows = await fetch_all(
        session,
        """
        SELECT m.*, s.key AS current_key, s.display_name AS signal_name, s.unit, s.data_type, s.status AS signal_status
        FROM output_group_members m
        LEFT JOIN signal_definitions s ON s.id = m.signal_id
        WHERE m.output_group_id = :id
        ORDER BY m.ordinal ASC
        """,
        {"id": group_id},
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        member = models_engine.member_from_row(row)
        out.append(
            {
                **member.as_dict(),
                "signal_key": member.signal_key or row.get("current_key"),
                "output_alias": member.alias,
                "ordinal": int(row["ordinal"]),
                "signal_name": row.get("signal_name"),
                "signal_status": row.get("signal_status"),
                "unit": row.get("unit"),
                "data_type": row.get("data_type"),
            }
        )
    return out


async def get_output_group(session: AsyncSession, tenant_id: UUID, group_id: UUID) -> dict[str, Any]:
    row = await _group_row(session, tenant_id, group_id)
    members = await _member_rows(session, group_id)
    return {**_group_out(row), "member_count": len(members), "members": members}


async def list_output_groups(session: AsyncSession, tenant_id: UUID, *, resource_id: str | None = None, include_archived: bool = False) -> dict[str, Any]:
    rows = await fetch_all(
        session,
        """
        SELECT g.*, r.code AS resource_code, r.name AS resource_name,
               (SELECT count(*) FROM output_group_members m WHERE m.output_group_id = g.id) AS member_count
        FROM output_groups g
        JOIN resources r ON r.id = g.resource_id
        WHERE g.tenant_id = :tenant_id
          AND (CAST(:resource_id AS uuid) IS NULL OR g.resource_id = CAST(:resource_id AS uuid))
          AND (:include_archived OR g.status <> 'ARCHIVED')
        ORDER BY r.code, g.key
        """,
        {"tenant_id": tenant_id, "resource_id": parse_uuid(resource_id) if resource_id else None, "include_archived": include_archived},
    )
    return {"items": [{**_group_out(row), "member_count": int(row["member_count"] or 0)} for row in rows]}


async def patch_output_group(session: AsyncSession, tenant_id: UUID, actor: UUID, group_id: UUID, body: OutputGroupPatch, correlation_id: str) -> dict[str, Any]:
    current = await _group_row(session, tenant_id, group_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This output group was modified elsewhere.")
    if current["status"] == "ARCHIVED":
        raise AppError(409, "OUTPUT_GROUP_ARCHIVED", "Archived data models cannot be edited.")

    resource_id = as_uuid(current["resource_id"])
    resource_changed = False
    if body.resource_id and parse_uuid(body.resource_id) != resource_id:
        resource_id = as_uuid((await _active_resource(session, tenant_id, parse_uuid(body.resource_id)))["id"])
        resource_changed = True
        if await _key_taken(session, resource_id, current["key"], exclude=group_id):
            raise AppError(409, "OUTPUT_GROUP_EXISTS", f"A data model with key '{current['key']}' already exists on that resource.")

    topic_template = body.topic_template if body.topic_template is not None else current["topic_template"]
    display_name = (body.display_name.strip() if body.display_name is not None else current["display_name"]) or current["display_name"]
    kind, emit, projection = _policies(
        body.kind or current.get("kind"),
        body.emit_policy,
        body.projection_policy if body.projection_policy is not None else current.get("projection_policy_json"),
        base_emit=current.get("emit_policy_json") if isinstance(current.get("emit_policy_json"), dict) else None,
    )
    raw_members = body.members if body.members is not None else [m.as_dict() for m in (await models_engine.load_members(session, [group_id])).get(str(group_id), [])]
    members = _validate_group_spec(topic_template, raw_members, kind)
    resolved, missing = await _resolve_members(session, tenant_id, resource_id, members, rekey=resource_changed)
    if missing:
        raise AppError(422, "MEMBERS_UNRESOLVED", "Some signal keys do not exist on this resource.", extra={"missing_keys": missing})

    try:
        updated = await fetch_one(
            session,
            """
            UPDATE output_groups
            SET resource_id = :resource_id, display_name = :name, topic_template = :topic, kind = :kind,
                projection_policy_json = CAST(:policy AS jsonb), emit_policy_json = CAST(:emit AS jsonb),
                version = version + 1, updated_at = :now
            WHERE id = :id AND tenant_id = :tenant_id AND version = :version
            RETURNING id
            """,
            {
                "resource_id": resource_id,
                "name": display_name,
                "topic": topic_template,
                "kind": kind,
                "policy": jsonb(projection),
                "emit": jsonb(emit),
                "now": utcnow(),
                "id": group_id,
                "tenant_id": tenant_id,
                "version": body.version,
            },
        )
        if updated is None:
            raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This output group was modified elsewhere.")
        await execute(session, "DELETE FROM output_group_members WHERE output_group_id = :id", {"id": group_id})
        await _insert_members(session, group_id, resolved)
    except IntegrityError as exc:
        raise _conflict(exc) from exc

    if current["status"] == "PUBLISHED":
        await execute(session, "DELETE FROM model_state WHERE group_id = :id", {"id": group_id})
        await models_engine.refresh_groups(session, tenant_id, [group_id])
    await audit(session, tenant_id=tenant_id, event_type="OUTPUT_GROUP_UPDATE", actor_id=actor, entity_type="output_group", entity_id=group_id, before={"version": current["version"], "resource_id": str(current["resource_id"]), "kind": current.get("kind")}, after={"version": int(current["version"]) + 1, "resource_id": str(resource_id), "kind": kind, "members": len(resolved)}, correlation_id=correlation_id)
    return await get_output_group(session, tenant_id, group_id)


async def delete_output_group(session: AsyncSession, tenant_id: UUID, actor: UUID, group_id: UUID, correlation_id: str) -> dict[str, Any]:
    group = await _group_row(session, tenant_id, group_id)
    await execute(
        session,
        "UPDATE output_groups SET status = 'ARCHIVED', version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id",
        {"id": group_id, "tenant_id": tenant_id, "now": utcnow()},
    )
    await execute(session, "DELETE FROM model_state WHERE group_id = :id", {"id": group_id})
    await audit(session, tenant_id=tenant_id, event_type="OUTPUT_GROUP_DELETE", actor_id=actor, entity_type="output_group", entity_id=group_id, before={"status": group["status"]}, after={"status": "ARCHIVED"}, correlation_id=correlation_id)
    return {"id": str(group_id), "status": "ARCHIVED"}


async def _publish_group(session: AsyncSession, tenant_id: UUID, actor: UUID | None, group_id: UUID, version: int | None, correlation_id: str) -> dict[str, Any]:
    current = await _group_row(session, tenant_id, group_id)
    if current["status"] == "ARCHIVED":
        raise AppError(409, "OUTPUT_GROUP_ARCHIVED", "Archived data models cannot be published.")
    if version is not None and int(current["version"]) != version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This output group was modified elsewhere.")
    if current["status"] == "PUBLISHED":
        return await get_output_group(session, tenant_id, group_id)
    members = (await models_engine.load_members(session, [group_id])).get(str(group_id), [])
    normalized = _validate_group_spec(current["topic_template"], [m.as_dict() for m in members], current.get("kind") or "STATE", require_signal_ids=True)
    _resolved, missing = await _resolve_members(session, tenant_id, as_uuid(current["resource_id"]), normalized, rekey=False)
    if missing:
        raise AppError(422, "MEMBERS_UNRESOLVED", "Some signal keys do not exist on this resource.", extra={"missing_keys": missing})
    await execute(
        session,
        "UPDATE output_groups SET status = 'PUBLISHED', version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id",
        {"id": group_id, "tenant_id": tenant_id, "now": utcnow()},
    )
    await models_engine.refresh_groups(session, tenant_id, [group_id])
    await audit(session, tenant_id=tenant_id, event_type="OUTPUT_GROUP_PUBLISH", actor_id=actor, entity_type="output_group", entity_id=group_id, before={"status": current["status"], "version": current["version"]}, after={"status": "PUBLISHED", "version": int(current["version"]) + 1}, correlation_id=correlation_id)
    return await get_output_group(session, tenant_id, group_id)


async def publish_output_group(session: AsyncSession, tenant_id: UUID, actor: UUID, group_id: UUID, body: OutputGroupPublishIn | None, correlation_id: str) -> dict[str, Any]:
    return await _publish_group(session, tenant_id, actor, group_id, body.version if body else None, correlation_id)


async def unpublish_output_group(session: AsyncSession, tenant_id: UUID, actor: UUID, group_id: UUID, body: OutputGroupPublishIn | None, correlation_id: str) -> dict[str, Any]:
    current = await _group_row(session, tenant_id, group_id)
    if current["status"] == "ARCHIVED":
        raise AppError(409, "OUTPUT_GROUP_ARCHIVED", "Archived data models cannot be unpublished.")
    if body and body.version is not None and int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This output group was modified elsewhere.")
    if current["status"] != "PUBLISHED":
        return await get_output_group(session, tenant_id, group_id)
    await execute(
        session,
        "UPDATE output_groups SET status = 'DRAFT', version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id",
        {"id": group_id, "tenant_id": tenant_id, "now": utcnow()},
    )
    await audit(session, tenant_id=tenant_id, event_type="OUTPUT_GROUP_UNPUBLISH", actor_id=actor, entity_type="output_group", entity_id=group_id, before={"status": "PUBLISHED", "version": current["version"]}, after={"status": "DRAFT", "version": int(current["version"]) + 1}, correlation_id=correlation_id)
    return await get_output_group(session, tenant_id, group_id)


def _topic_context(chain: list[dict[str, Any]], group_key: str) -> dict[str, str | None]:
    """Topic segments use resource codes from the CONTAINS breadcrumb (nearest resource per type key)."""
    context: dict[str, str | None] = {role: None for role in TOPIC_ROLES}
    for item in chain:
        role = str(item.get("type_key") or "")
        if role in context and context[role] is None:
            context[role] = item.get("code")
    context["resource"] = chain[0].get("code") if chain else None
    context["group"] = group_key
    return context


async def _render_group_topic(session: AsyncSession, tenant_id: UUID, group: dict[str, Any]) -> tuple[str | None, str | None]:
    chain = await models_engine.resource_chain(session, tenant_id, as_uuid(group["resource_id"]))
    try:
        return render_topic(group["topic_template"], _topic_context(chain, group["key"])), None
    except TopicError as exc:
        return None, str(exc)


async def preview_output_group(session: AsyncSession, tenant_id: UUID, group_id: UUID) -> dict[str, Any]:
    """The body exactly as the engine would emit it now, computed by the same pure compose function."""
    group = await _group_row(session, tenant_id, group_id)
    members = (await models_engine.load_members(session, [group_id])).get(str(group_id), [])
    signal_ids = sorted({UUID(m.signal_id) for m in members if m.signal_id}, key=str)
    latest = await models_engine.load_latest(session, tenant_id, signal_ids)
    meta = {
        str(row["id"]): row
        for row in (
            await fetch_all(
                session,
                """
                SELECT s.id, s.expected_interval_ms,
                       EXISTS (SELECT 1 FROM signal_bindings b WHERE b.signal_id = s.id) AS has_binding,
                       EXISTS (SELECT 1 FROM signal_bindings b WHERE b.signal_id = s.id AND b.enabled AND b.valid_to IS NULL) AS has_enabled
                FROM signal_definitions s
                WHERE s.tenant_id = :tenant_id AND s.id = ANY(:ids)
                """,
                {"tenant_id": tenant_id, "ids": signal_ids},
            )
            if signal_ids
            else []
        )
    }
    context = await models_engine.resource_context(session, tenant_id, as_uuid(group["resource_id"]), use_cache=False)
    now = utcnow()
    snapshot: dict[str, Any] | None = None
    if (group.get("kind") or "STATE") == "EVENT":
        instants = [as_utc(latest[m.signal_id].get("source_time") or latest[m.signal_id].get("received_time")) for m in members if m.is_trigger and m.signal_id in latest]
        instant = max((ts for ts in instants if ts is not None), default=None)
        if instant is not None:
            _rows, snapshot = await models_engine.snapshot_at(session, tenant_id, members, instant)
    result = models_engine.compose(group, members, latest, context, now, snapshot)

    fields: list[dict[str, Any]] = []
    for member in members:
        row = latest.get(member.signal_id or "") if member.signal_id else None
        quality = None
        reason = None
        if member.kind in ("signal", "snapshot"):
            info = meta.get(member.signal_id or "", {})
            enabled = bool(info.get("has_enabled")) or not bool(info.get("has_binding"))
            state = evaluate_signal_state(
                has_observation=row is not None,
                raw_quality=None if row is None else row.get("quality"),
                raw_value=None if row is None else row.get("value"),
                event_time=None if row is None else row.get("event_time"),
                last_acquired_at=None if row is None else row.get("received_time"),
                expected_interval_ms=info.get("expected_interval_ms"),
                now=now,
                binding_enabled=enabled,
            )
            quality, reason = state.effective_status, state.reason_code
        fields.append(
            {
                "alias": member.alias,
                "kind": member.kind,
                "value": result.body.get(member.alias),
                "quality": quality,
                "reason_code": reason,
                "source_time": None if row is None else _ms(row.get("source_time")),
                "received_time": None if row is None else _ms(row.get("received_time")),
                "contributes_ts": member.contributes_ts,
                "is_trigger": member.is_trigger,
                "signal_id": member.signal_id,
                "signal_key": member.signal_key,
                "context_ref": member.context_ref,
                "field": member.field,
                "wins_source_timestamp": member.alias == result.ts_from_alias,
            }
        )
    topic, topic_error = await _render_group_topic(session, tenant_id, group)
    return {
        "group_id": str(group_id),
        "kind": group.get("kind") or "STATE",
        "status": group["status"],
        "topic": topic,
        "topic_error": topic_error,
        "body": result.body_text,
        "values": result.body,
        "fields": fields,
        "source_timestamp": _ms(result.source_ts),
        "source_timestamp_from": result.ts_from_alias,
        "generated_at": _ms(now),
    }


async def latest_output_group(session: AsyncSession, tenant_id: UUID, group_id: UUID) -> dict[str, Any]:
    group = await _group_row(session, tenant_id, group_id)
    state = await fetch_one(session, "SELECT body_text, source_ts, last_publish_ts FROM model_state WHERE group_id = :id AND tenant_id = :tenant_id", {"id": group_id, "tenant_id": tenant_id})
    if state is None and (group.get("kind") or "STATE") == "EVENT":
        state = await fetch_one(
            session,
            "SELECT body_text, source_ts, created_at AS last_publish_ts FROM model_events WHERE group_id = :id AND tenant_id = :tenant_id AND status = 'FINAL' ORDER BY source_ts DESC, created_at DESC LIMIT 1",
            {"id": group_id, "tenant_id": tenant_id},
        )
    return {
        "group_id": str(group_id),
        "status": group["status"],
        "body": None if state is None else state["body_text"],
        "source_ts": None if state is None else _ms(state["source_ts"]),
        "published_at": None if state is None else _ms(state["last_publish_ts"]),
    }


async def output_group_events(session: AsyncSession, tenant_id: UUID, group_id: UUID, *, limit: int = 50) -> list[dict[str, Any]]:
    await _group_row(session, tenant_id, group_id)
    rows = await fetch_all(
        session,
        """
        SELECT id, source_ts, body_text, status, created_at FROM model_events
        WHERE group_id = :id AND tenant_id = :tenant_id
        ORDER BY source_ts DESC, created_at DESC
        LIMIT :limit
        """,
        {"id": group_id, "tenant_id": tenant_id, "limit": min(max(int(limit), 1), 1000)},
    )
    return [
        {"id": str(row["id"]), "source_ts": _ms(row["source_ts"]), "body": row["body_text"], "status": row["status"], "created_at": _ms(row["created_at"])}
        for row in rows
    ]


def _retarget_name(name: str, source: dict[str, Any], target: dict[str, Any]) -> str:
    for attr in ("name", "code"):
        old, new = str(source.get(attr) or ""), str(target.get(attr) or "")
        if old and old in name:
            return name.replace(old, new)
    return f"{name} ({target.get('name') or target.get('code')})"


async def duplicate_output_group(session: AsyncSession, tenant_id: UUID, actor: UUID, group_id: UUID, body: OutputGroupDuplicateIn, correlation_id: str) -> dict[str, Any]:
    source = await _group_row(session, tenant_id, group_id)
    target = await _active_resource(session, tenant_id, parse_uuid(body.resource_id))
    same_resource = str(target["id"]) == str(source["resource_id"])
    key = _validate_group_key(body.key or (f"{source['key']}_copy" if same_resource else source["key"]))
    if body.display_name and body.display_name.strip():
        display_name = body.display_name.strip()
    elif same_resource:
        display_name = f"{source['display_name']} copy"
    else:
        display_name = _retarget_name(source["display_name"], {"name": source["resource_name"], "code": source["resource_code"]}, target)
    members = (await models_engine.load_members(session, [group_id])).get(str(group_id), [])
    resolved, missing = await _resolve_members(session, tenant_id, as_uuid(target["id"]), members, rekey=True)
    if missing:
        return {"created": None, "missing_keys": missing}
    kind, emit, projection = _policies(source.get("kind"), None, source.get("projection_policy_json"), base_emit=source.get("emit_policy_json") if isinstance(source.get("emit_policy_json"), dict) else None)
    new_id = await _create_group(
        session,
        tenant_id,
        resource_id=as_uuid(target["id"]),
        key=key,
        display_name=display_name,
        kind=kind,
        topic_template=source["topic_template"],
        members=resolved,
        projection=projection,
        emit_policy=emit,
        template_id=as_uuid(source["template_id"]) if source.get("template_id") else None,
    )
    await audit(session, tenant_id=tenant_id, event_type="OUTPUT_GROUP_DUPLICATE", actor_id=actor, entity_type="output_group", entity_id=new_id, before={"source_id": str(group_id)}, after={"resource_id": str(target["id"]), "key": key}, correlation_id=correlation_id)
    return {"created": await get_output_group(session, tenant_id, new_id), "missing_keys": []}


# ---- Model templates ------------------------------------------------------------------------


def _template_fields(kind: str, fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Templates are resource independent: signal members carry a signal key, never a signal id."""
    for raw in fields:
        if raw.get("signal_id"):
            raise AppError(422, "TEMPLATE_SIGNAL_ID", f"Template member '{raw.get('alias')}' must use signal_key, not signal_id.")
    try:
        members = normalize_members(kind, fields, require_signal_ids=False)
    except BodyError as exc:
        raise _body_error(exc) from exc
    out: list[dict[str, Any]] = []
    for member in members:
        spec: dict[str, Any] = {"kind": member.kind, "alias": member.alias}
        if member.kind in ("signal", "snapshot"):
            spec["signal_key"] = member.signal_key
        if member.kind == "context":
            spec["context_ref"] = member.context_ref
        if member.kind == "constant":
            spec["value"] = member.value
        if member.kind == "system":
            spec["field"] = member.field
        spec["contributes_ts"] = member.contributes_ts
        spec["is_trigger"] = member.is_trigger
        out.append(spec)
    return out


async def _seed_builtin_templates(session: AsyncSession, tenant_id: UUID) -> None:
    count = await fetch_one(session, "SELECT count(*) AS n FROM model_templates WHERE tenant_id = :tenant_id AND is_builtin", {"tenant_id": tenant_id})
    if count and int(count["n"] or 0) >= len(BUILTIN_TEMPLATES):
        return
    now = utcnow()
    for spec in BUILTIN_TEMPLATES:
        await execute(
            session,
            """
            INSERT INTO model_templates (
                id, tenant_id, key, display_name, description, kind, topic_template, fields_json,
                emit_policy_json, is_builtin, version, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :key, :name, :description, :kind, :topic, CAST(:fields AS jsonb),
                CAST(:emit AS jsonb), TRUE, 1, :now, :now
            )
            ON CONFLICT (tenant_id, key) DO NOTHING
            """,
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "key": spec["key"],
                "name": spec["display_name"],
                "description": spec["description"],
                "kind": spec["kind"],
                "topic": DEFAULT_TEMPLATE_TOPIC,
                "fields": jsonb(_template_fields(spec["kind"], spec["fields"])),
                "emit": jsonb(dict(DEFAULT_EMIT_POLICY)),
                "now": now,
            },
        )


def _template_out(row: dict[str, Any]) -> dict[str, Any]:
    fields = row.get("fields_json")
    emit = row.get("emit_policy_json")
    return {
        "id": str(row["id"]),
        "key": row["key"],
        "display_name": row["display_name"],
        "description": row.get("description") or "",
        "kind": row["kind"],
        "topic_template": row["topic_template"],
        "fields": json.loads(fields) if isinstance(fields, str) else (fields or []),
        "emit_policy": json.loads(emit) if isinstance(emit, str) else emit,
        "is_builtin": bool(row.get("is_builtin")),
        "version": int(row["version"]),
        "created_at": _ms(row.get("created_at")),
        "updated_at": _ms(row.get("updated_at")),
    }


async def _template_row(session: AsyncSession, tenant_id: UUID, template_id: UUID) -> dict[str, Any]:
    row = await fetch_one(session, "SELECT * FROM model_templates WHERE id = :id AND tenant_id = :tenant_id", {"id": template_id, "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Model template not found.")
    return row


async def list_model_templates(session: AsyncSession, tenant_id: UUID) -> dict[str, Any]:
    await _seed_builtin_templates(session, tenant_id)
    rows = await fetch_all(
        session,
        "SELECT * FROM model_templates WHERE tenant_id = :tenant_id ORDER BY is_builtin DESC, created_at ASC, key ASC",
        {"tenant_id": tenant_id},
    )
    return {"items": [_template_out(row) for row in rows]}


async def create_model_template(session: AsyncSession, tenant_id: UUID, actor: UUID, body: ModelTemplateIn, correlation_id: str) -> dict[str, Any]:
    key = _validate_group_key(body.key)
    name = body.display_name.strip()
    if not name:
        raise AppError(422, "NAME_REQUIRED", "Name is required.")
    kind, emit, _projection = _policies(body.kind, body.emit_policy, None)
    _validate_topic_template(body.topic_template)
    fields = _template_fields(kind, body.fields)
    if await fetch_one(session, "SELECT id FROM model_templates WHERE tenant_id = :tenant_id AND key = :key", {"tenant_id": tenant_id, "key": key}):
        raise AppError(409, "TEMPLATE_EXISTS", f"A model template with key '{key}' already exists.")
    template_id = uuid4()
    now = utcnow()
    try:
        await execute(
            session,
            """
            INSERT INTO model_templates (
                id, tenant_id, key, display_name, description, kind, topic_template, fields_json,
                emit_policy_json, is_builtin, version, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :key, :name, :description, :kind, :topic, CAST(:fields AS jsonb),
                CAST(:emit AS jsonb), FALSE, 1, :now, :now
            )
            """,
            {"id": template_id, "tenant_id": tenant_id, "key": key, "name": name, "description": body.description.strip(), "kind": kind, "topic": body.topic_template, "fields": jsonb(fields), "emit": jsonb(emit), "now": now},
        )
    except IntegrityError as exc:
        raise AppError(409, "TEMPLATE_EXISTS", f"A model template with key '{key}' already exists.") from exc
    await audit(session, tenant_id=tenant_id, event_type="MODEL_TEMPLATE_CREATE", actor_id=actor, entity_type="model_template", entity_id=template_id, before=None, after={"key": key, "kind": kind}, correlation_id=correlation_id)
    return _template_out(await _template_row(session, tenant_id, template_id))


async def patch_model_template(session: AsyncSession, tenant_id: UUID, actor: UUID, template_id: UUID, body: ModelTemplatePatch, correlation_id: str) -> dict[str, Any]:
    current = await _template_row(session, tenant_id, template_id)
    if current.get("is_builtin"):
        raise AppError(409, "TEMPLATE_BUILTIN", "Built-in templates are read-only. Create a copy instead.")
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This template was modified elsewhere.")
    base_emit = current.get("emit_policy_json") if isinstance(current.get("emit_policy_json"), dict) else None
    kind, emit, _projection = _policies(body.kind or current["kind"], body.emit_policy, None, base_emit=base_emit)
    topic = body.topic_template if body.topic_template is not None else current["topic_template"]
    _validate_topic_template(topic)
    raw_fields = body.fields if body.fields is not None else _template_out(current)["fields"]
    fields = _template_fields(kind, raw_fields)
    name = (body.display_name.strip() if body.display_name is not None else current["display_name"]) or current["display_name"]
    description = body.description.strip() if body.description is not None else current.get("description") or ""
    updated = await fetch_one(
        session,
        """
        UPDATE model_templates
        SET display_name = :name, description = :description, kind = :kind, topic_template = :topic,
            fields_json = CAST(:fields AS jsonb), emit_policy_json = CAST(:emit AS jsonb),
            version = version + 1, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id AND version = :version
        RETURNING id
        """,
        {"name": name, "description": description, "kind": kind, "topic": topic, "fields": jsonb(fields), "emit": jsonb(emit), "now": utcnow(), "id": template_id, "tenant_id": tenant_id, "version": body.version},
    )
    if updated is None:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "This template was modified elsewhere.")
    await audit(session, tenant_id=tenant_id, event_type="MODEL_TEMPLATE_UPDATE", actor_id=actor, entity_type="model_template", entity_id=template_id, before={"version": current["version"]}, after={"version": int(current["version"]) + 1}, correlation_id=correlation_id)
    return _template_out(await _template_row(session, tenant_id, template_id))


async def delete_model_template(session: AsyncSession, tenant_id: UUID, actor: UUID, template_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _template_row(session, tenant_id, template_id)
    if current.get("is_builtin"):
        raise AppError(409, "TEMPLATE_BUILTIN", "Built-in templates cannot be deleted.")
    await execute(session, "DELETE FROM model_templates WHERE id = :id AND tenant_id = :tenant_id", {"id": template_id, "tenant_id": tenant_id})
    await audit(session, tenant_id=tenant_id, event_type="MODEL_TEMPLATE_DELETE", actor_id=actor, entity_type="model_template", entity_id=template_id, before={"key": current["key"]}, after=None, correlation_id=correlation_id)
    return {"id": str(template_id), "deleted": True}


async def apply_model_template(session: AsyncSession, tenant_id: UUID, actor: UUID, template_id: UUID, body: TemplateApplyIn, correlation_id: str) -> dict[str, Any]:
    template = _template_out(await _template_row(session, tenant_id, template_id))
    if not body.resource_ids:
        raise AppError(422, "RESOURCES_REQUIRED", "Select at least one resource.")
    if len(body.resource_ids) > 200:
        raise AppError(422, "LIMIT", "At most 200 resources per apply.")
    ids = list(dict.fromkeys(parse_uuid(item) for item in body.resource_ids))
    resources = {
        str(row["id"]): row
        for row in await fetch_all(
            session,
            "SELECT id, code, name, status, archived_at FROM resources WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
            {"tenant_id": tenant_id, "ids": ids},
        )
    }
    unknown = [str(item) for item in ids if str(item) not in resources]
    if unknown:
        raise AppError(404, "NOT_FOUND", "Some resources were not found.", extra={"resource_ids": unknown})
    kind, emit, projection = _policies(template["kind"], None, None, base_emit=template.get("emit_policy"))
    members = _validate_group_spec(template["topic_template"], template["fields"], kind)
    key = _validate_group_key(template["key"])

    results: list[dict[str, Any]] = []
    for resource_id in ids:
        resource = resources[str(resource_id)]
        entry: dict[str, Any] = {
            "resource_id": str(resource_id),
            "resource_code": resource["code"],
            "resource_name": resource["name"],
            "group_id": None,
            "missing_keys": [],
            "status": "dry_run",
            "published": False,
        }
        if resource.get("status") == "ARCHIVED" or resource.get("archived_at"):
            entry["status"] = "missing"
            entry["error"] = "RESOURCE_ARCHIVED"
            results.append(entry)
            continue
        resolved, missing = await _resolve_members(session, tenant_id, resource_id, members, rekey=True)
        entry["missing_keys"] = missing
        existing = await _key_taken(session, resource_id, key)
        if existing is not None:
            entry["status"] = "exists"
            entry["group_id"] = str(existing["id"])
            entry["published"] = existing["status"] == "PUBLISHED"
        elif missing:
            entry["status"] = "missing"
        elif not body.dry_run:
            group_id = await _create_group(
                session,
                tenant_id,
                resource_id=resource_id,
                key=key,
                display_name=f"{resource['name']} {template['display_name']}",
                kind=kind,
                topic_template=template["topic_template"],
                members=resolved,
                projection=projection,
                emit_policy=emit,
                template_id=template_id,
            )
            entry["status"] = "created"
            entry["group_id"] = str(group_id)
            if body.publish:
                await _publish_group(session, tenant_id, actor, group_id, None, correlation_id)
                entry["published"] = True
        results.append(entry)
    if not body.dry_run:
        created = [r["group_id"] for r in results if r["status"] == "created"]
        await audit(session, tenant_id=tenant_id, event_type="MODEL_TEMPLATE_APPLY", actor_id=actor, entity_type="model_template", entity_id=template_id, before=None, after={"created": created, "publish": body.publish, "resources": len(ids)}, correlation_id=correlation_id)
    return {"template_id": str(template_id), "dry_run": body.dry_run, "results": results}


async def publish_release(session: AsyncSession, tenant_id: UUID, actor: UUID, body: ReleaseIn, correlation_id: str) -> dict[str, Any]:
    # Serialise releases per edge: the row lock makes concurrent mutations queue instead of racing
    # on UNIQUE (edge_id, revision) with the same desired_revision + 1.
    edge = await fetch_one(
        session,
        "SELECT * FROM edge_nodes WHERE id = :id AND tenant_id = :tenant_id FOR UPDATE",
        {"id": parse_uuid(body.edge_id), "tenant_id": tenant_id},
    )
    if edge is None:
        raise AppError(404, "NOT_FOUND", "Edge not found.")
    edge.pop("credential_hash", None)
    connections = await fetch_all(
        session,
        """
        SELECT id, protocol, name, endpoint_redacted, config_json, status, secret_ref
        FROM connections
        WHERE edge_id = :edge_id AND tenant_id = :tenant_id AND status <> 'ARCHIVED'
        """,
        {"edge_id": as_uuid(edge["id"]), "tenant_id": tenant_id},
    )
    jobs = []
    fields = []
    if connections:
        jobs = await fetch_all(
            session,
            "SELECT * FROM acquisition_jobs WHERE connection_id = ANY(:ids)",
            {"ids": [as_uuid(item["id"]) for item in connections]},
        )
    if jobs:
        fields = await fetch_all(
            session,
            "SELECT * FROM source_fields WHERE acquisition_job_id = ANY(:ids)",
            {"ids": [as_uuid(item["id"]) for item in jobs]},
        )
    bindings = await fetch_all(
        session,
        """
        SELECT b.signal_id, b.source_field_id, b.transform_chain_json, s.key, s.resource_id, s.data_type, s.unit
        FROM signal_bindings b
        JOIN signal_definitions s ON s.id = b.signal_id
        WHERE s.tenant_id = :tenant_id AND b.enabled = TRUE AND b.valid_to IS NULL
        """,
        {"tenant_id": tenant_id},
    )
    formulas = await fetch_all(
        session,
        """
        SELECT f.signal_id, f.expression_source, f.revision, f.temporal_policy_json
        FROM formula_definitions f JOIN signal_definitions s ON s.id = f.signal_id
        WHERE s.tenant_id = :tenant_id AND f.status = 'PUBLISHED'
        """,
        {"tenant_id": tenant_id},
    )
    last_release = await fetch_one(
        session,
        "SELECT COALESCE(max(revision), 0) AS revision FROM configuration_releases WHERE edge_id = :edge_id",
        {"edge_id": as_uuid(edge["id"])},
    )
    revision = max(int(edge["desired_revision"]), int((last_release or {}).get("revision") or 0)) + 1
    payload = {
        "schema_version": "fx.edge.config.v1",
        "edge_id": edge["id"],
        "revision": revision,
        "issued_at": utcnow().isoformat().replace("+00:00", "Z"),
        "connections": [{**item, "secret_ref": item["secret_ref"]} for item in connections],
        "jobs": jobs,
        "source_fields": fields,
        "signal_bindings": bindings,
        "formulas": formulas,
        "security_policy_revision": 1,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    digest = hashlib.sha256(canonical).hexdigest()
    payload["checksum_sha256"] = digest
    if actor is None:
        admin_row = await fetch_one(session, "SELECT id FROM admin_accounts WHERE tenant_id = :tenant_id ORDER BY created_at ASC LIMIT 1", {"tenant_id": tenant_id})
        if admin_row:
            actor = as_uuid(admin_row["id"])
    await execute(
        session,
        """
        INSERT INTO configuration_releases (
            id, tenant_id, edge_id, revision, content_hash, snapshot_json, published_at, published_by, status
        ) VALUES (
            :id, :tenant_id, :edge_id, :revision, :content_hash, CAST(:snapshot AS jsonb), :now, :actor, 'PUBLISHED'
        )
        """,
        {
            "id": uuid4(),
            "tenant_id": tenant_id,
            "edge_id": as_uuid(edge["id"]),
            "revision": revision,
            "content_hash": digest,
            "snapshot": jsonb(payload),
            "now": utcnow(),
            "actor": actor,
        },
    )
    await execute(
        session,
        "UPDATE edge_nodes SET desired_revision = :revision, health = 'CONFIG_PENDING' WHERE id = :id",
        {"revision": revision, "id": as_uuid(edge["id"])},
    )
    await execute(
        session,
        """
        INSERT INTO deployment_events (id, edge_id, revision, state, diagnostic_redacted, at)
        VALUES (:id, :edge_id, :revision, 'PUBLISHED', '', :now)
        """,
        {"id": uuid4(), "edge_id": as_uuid(edge["id"]), "revision": revision, "now": utcnow()},
    )
    await audit(session, tenant_id=tenant_id, event_type="CONFIG_PUBLISH", actor_id=actor, entity_type="edge", entity_id=as_uuid(edge["id"]), before={"desired": edge["desired_revision"]}, after={"desired": revision, "active": edge["active_revision"]}, correlation_id=correlation_id)
    return {"edge_id": edge["id"], "revision": revision, "status": "PUBLISHED", "active_revision": edge["active_revision"], "checksum_sha256": digest}


async def patch_edge(session: AsyncSession, tenant_id: UUID, actor: UUID, edge_id: UUID, body: EdgePatch, correlation_id: str) -> dict[str, Any]:
    edge = await _owned_edge(session, tenant_id, edge_id)
    new_name = body.name.strip()
    await execute(session, "UPDATE edge_nodes SET name = :name WHERE id = :id AND tenant_id = :tenant_id", {"name": new_name, "id": edge_id, "tenant_id": tenant_id})
    await audit(session, tenant_id=tenant_id, event_type="EDGE_RENAME", actor_id=actor, entity_type="edge", entity_id=edge_id, before={"name": edge["name"]}, after={"name": new_name}, correlation_id=correlation_id)
    return await _owned_edge(session, tenant_id, edge_id)


async def delete_edge(session: AsyncSession, tenant_id: UUID, actor: UUID, edge_id: UUID, correlation_id: str) -> dict[str, Any]:
    await _owned_edge(session, tenant_id, edge_id)
    active_conns = await fetch_one(session, "SELECT count(*) AS count FROM connections WHERE edge_id = :id AND tenant_id = :tenant_id AND status <> 'ARCHIVED'", {"id": edge_id, "tenant_id": tenant_id})
    if active_conns and int(active_conns["count"]) > 0:
        raise AppError(409, "EDGE_IN_USE", "Cannot delete edge node with existing connections.")
    await execute(session, "DELETE FROM edge_nodes WHERE id = :id AND tenant_id = :tenant_id", {"id": edge_id, "tenant_id": tenant_id})
    await audit(session, tenant_id=tenant_id, event_type="EDGE_DELETE", actor_id=actor, entity_type="edge", entity_id=edge_id, before=None, after={"id": str(edge_id)}, correlation_id=correlation_id)
    return {"id": str(edge_id), "status": "DELETED"}


class TestIn(BaseModel):
    mode: str = "FULL"
    fields: list[dict[str, Any]] = []
    # Optional unsaved edits of the connection form: validated like a PATCH and sent to the edge
    # for this test only (the stored configuration is not changed).
    config: dict[str, Any] | None = None


async def request_commission(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    connection_id: UUID,
    correlation_id: str,
    *,
    mode: str = "FULL",
    fields: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Dispatch a real commissioning test to the edge; results come back via GET /commissioning/{id}."""
    connection = await _connection_row(session, tenant_id, connection_id)
    if connection["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "Archived connections cannot be tested.")
    edge = await _owned_edge(session, tenant_id, as_uuid(connection["edge_id"]))
    if edge.get("enrollment_status") != "ENROLLED":
        raise AppError(
            409,
            "EDGE_NOT_ENROLLED",
            "No enrolled collector for this site. Enroll the Edge first.",
        )
    protocol = str(connection["protocol"])
    mode_upper = mode.upper()
    if mode_upper not in {"CONNECTIVITY", "FULL"}:
        raise AppError(422, "MODE", "Test mode must be CONNECTIVITY or FULL.")
    if mode_upper == "CONNECTIVITY":
        stage_names = ["REACH", "AUTH"]
    else:
        read_stage = "SUBSCRIBE" if protocol in SUBSCRIBE_PROTOCOLS else "READ"
        stage_names = ["REACH", "AUTH", read_stage, "SAMPLE", "MAP"]
    stages = [
        {"stage": name, "status": "PENDING", "duration_ms": None, "detail": ""}
        for name in stage_names
    ]
    job_id = uuid4()
    meta: dict[str, Any] = {"mode": mode_upper, "fields": fields or []}
    if config:
        _, raw_config, _interval = accept_connection(protocol, unmask_config(config, connection["config_json"] or {}))
        meta["config_override"] = parse_config(protocol, raw_config)
    await execute(
        session,
        """
        INSERT INTO commissioning_jobs (
            id, tenant_id, connection_id, requested_by, stages_json, status, diagnostic, samples_json, started_at
        ) VALUES (
            :id, :tenant_id, :connection_id, :actor, CAST(:stages AS jsonb), 'PENDING', '', CAST(:samples AS jsonb), :now
        )
        """,
        {
            "id": job_id,
            "tenant_id": tenant_id,
            "connection_id": connection_id,
            "actor": actor,
            "stages": jsonb(stages),
            "samples": jsonb({"meta": meta}),
            "now": utcnow(),
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="COMMISSION_REQUEST", actor_id=actor, entity_type="connection", entity_id=connection_id, before=None, after={"job_id": str(job_id), "protocol": public_protocol(protocol), "mode": mode_upper, "draft_config": bool(config)}, correlation_id=correlation_id)
    return {"job_id": str(job_id), "status": "PENDING", "poll_url": f"/api/v1/commissioning/{job_id}"}


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
    await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=as_uuid(current["edge_id"]))
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
