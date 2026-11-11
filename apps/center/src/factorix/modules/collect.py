"""Connections, signals, formulas, releases and edge enrollment (data models: factorix.modules.data_models)."""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.formula import FormulaError, bind, detect_cycles, evaluate, output_quality, parse_expression
from factorix.domain.jsonpath import MappingError, apply_cardinality, compile_path, evaluate as eval_path, suggest_type
from factorix.domain.units import add_units
from factorix.domain.source_address import AddressCheck, validate_address_patch
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
    validate_mqtt_topic,
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
    # Source address change of a bound signal (R2-SG-03): merged into the current address_json;
    # a key set to null is removed. Validated per protocol; the signal id stays the same.
    address_patch: dict[str, Any] | None = None


class SignalAddressItem(BaseModel):
    signal_id: str
    version: int
    address_patch: dict[str, Any]


class SignalBulkAddressIn(BaseModel):
    items: list[SignalAddressItem]


class SignalPropertyItem(BaseModel):
    signal_id: str
    version: int


class SignalBulkPropertiesIn(BaseModel):
    """Properties set on every listed signal in one change (R4-SG-02). A property that is not sent
    is left unchanged; ``round_digits: null`` removes rounding, ``unit: ""`` clears the unit."""

    items: list[SignalPropertyItem]
    unit: str | None = None
    expected_interval_ms: int | None = None
    round_digits: int | None = None


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


class EdgeIn(BaseModel):
    name: str
    site_id: str


class EdgePatch(BaseModel):
    name: str


class ReleaseIn(BaseModel):
    edge_id: str


async def _assert_edge_can_run(session: AsyncSession, edge: dict[str, Any]) -> None:
    """A test or capture may be queued for an enrolled edge, or for one whose enrollment is pending.

    Pending means the appliance's built-in collector (Center writes its enrollment token right after
    the first connection creates the edge row, R2-CN-02) or an edge with an unused, unexpired
    enrollment token. The command then waits as PENDING; the edge pulls it once it has enrolled, and
    the reaper fails it with "Collector did not start" if it is never picked up.
    """
    status = str(edge.get("enrollment_status") or "")
    if status == "ENROLLED":
        return
    if status != "REVOKED":
        from factorix.platform.settings import get_settings

        if get_settings().appliance:
            return
        token = await fetch_one(
            session,
            "SELECT 1 AS ok FROM edge_enrollment_tokens WHERE edge_id = :edge_id AND used_at IS NULL AND expires_at > :now LIMIT 1",
            {"edge_id": as_uuid(edge["id"]), "now": utcnow()},
        )
        if token is not None:
            return
    raise AppError(409, "EDGE_NOT_ENROLLED", "No enrolled collector for this site. Enroll the Edge first.")


async def _assert_local_acquisition_can_run(session: AsyncSession) -> None:
    """Allow commissioning/capture for local-acquisition connections when appliance/acquisition mode is active or heartbeat is fresh."""
    from factorix.domain.health import heartbeat_fresh
    from factorix.platform.settings import get_settings

    settings = get_settings()
    if settings.appliance or settings.collector_mode == "acquisition":
        return
    row = await fetch_one(
        session,
        "SELECT last_heartbeat, health FROM collector_runtime_status WHERE role = 'acquisition' ORDER BY last_heartbeat DESC LIMIT 1",
        {},
    )
    if row is not None and heartbeat_fresh(row.get("last_heartbeat"), utcnow()):
        return
    raise AppError(409, "EDGE_NOT_ENROLLED", "Local acquisition worker is not running. Start factorix-acquisition first.")


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


async def _notify_config_changed(session: AsyncSession, tenant_id: UUID) -> None:
    await execute(
        session,
        "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
        {"channel": "factorix_config_changed", "payload": json.dumps({"tenant_id": str(tenant_id)})},
    )


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
    await _notify_config_changed(session, tenant_id)


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


async def capture_connection(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    connection_id: UUID,
    body: CaptureIn,
    correlation_id: str,
) -> dict[str, Any]:
    conn = await get_connection(session, tenant_id, connection_id)
    if conn.get("edge_id"):
        edge = await _owned_edge(session, tenant_id, as_uuid(conn["edge_id"]))
        await _assert_edge_can_run(session, edge)
    else:
        await _assert_local_acquisition_can_run(session)

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
    await execute(
        session,
        "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
        {"channel": "factorix_commissioning", "payload": json.dumps({"job_id": str(job_id), "connection_id": str(connection_id)})},
    )
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
    # R2-SG-02: the source field ordinal keeps the order of the request (= source order chosen in the
    # wizard); every signal of one request shares created_at, so it is the only stable ordering.
    for position, item in enumerate(prepared):
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
                VALUES (:id, :job_id, :kind, CAST(:address AS jsonb), :native, CAST(:decode AS jsonb), :ordinal)
                """,
                {
                    "id": field_id,
                    "job_id": job_id,
                    "ordinal": position,
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


async def bulk_address_signals(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SignalBulkAddressIn, correlation_id: str) -> dict[str, Any]:
    """Apply an address patch to many signals at once, all or nothing (R2-SG-03).

    Every item is validated first; if any item is invalid nothing is written and the 422 lists the
    errors per item. Otherwise each changed signal is re-addressed, its version is bumped and one
    configuration release per affected edge is published so the edge applies the new addresses.
    """
    if not body.items or len(body.items) > 1000:
        raise AppError(422, "LIMIT", "Send between 1 and 1000 items.")
    item_errors: list[dict[str, Any]] = []
    ids: list[UUID | None] = []
    seen: set[UUID] = set()
    for index, item in enumerate(body.items):
        try:
            signal_id = parse_uuid(item.signal_id)
        except AppError:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "INVALID_ID", "message": "Invalid signal id."})
            ids.append(None)
            continue
        if signal_id in seen:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "DUPLICATE", "message": "The signal appears more than once."})
        seen.add(signal_id)
        ids.append(signal_id)
    known = [sid for sid in ids if sid is not None]
    signals = {
        as_uuid(row["id"]): row
        for row in await fetch_all(
            session,
            "SELECT id, version, status, data_type, display_name FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
            {"tenant_id": tenant_id, "ids": known},
        )
    } if known else {}
    sources = await _current_sources(session, tenant_id, known)
    planned: list[tuple[UUID, dict[str, Any], dict[str, Any], AddressCheck]] = []
    for index, (item, signal_id) in enumerate(zip(body.items, ids)):
        if signal_id is None:
            continue
        signal = signals.get(signal_id)
        if signal is None:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "NOT_FOUND", "message": "Signal not found."})
            continue
        if signal["status"] != "ACTIVE":
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "ARCHIVED", "message": "Archived signals cannot be modified."})
            continue
        if int(signal["version"]) != item.version:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "version", "code": "RESOURCE_VERSION_CONFLICT", "message": "This signal was modified elsewhere. Reload it and try again."})
            continue
        check = check_address_change(signal, sources.get(signal_id), item.address_patch)
        for error in check.errors:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": f"address_patch.{error['path']}", "code": error["code"], "message": error["message"]})
        if check.ok:
            planned.append((signal_id, signal, sources[signal_id], check))
    if item_errors:
        raise AppError(
            422,
            "BULK_ADDRESS_REJECTED",
            f"No signal was changed because {len({e['index'] for e in item_errors})} item(s) have errors.",
            field_errors=[{"path": f"items[{e['index']}].{e['path']}", "code": e["code"]} for e in item_errors],
            extra={"item_errors": item_errors},
        )
    updated: list[dict[str, Any]] = []
    unchanged: list[str] = []
    edges: set[UUID] = set()
    local_changed = False
    now = utcnow()
    for signal_id, signal, source, check in planned:
        before = source.get("address_json") or {}
        if check.address == before:
            unchanged.append(str(signal_id))
            continue
        bumped = await fetch_one(
            session,
            "UPDATE signal_definitions SET version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id AND version = :version RETURNING version",
            {"now": now, "id": signal_id, "tenant_id": tenant_id, "version": int(signal["version"])},
        )
        if bumped is None:
            raise AppError(409, "RESOURCE_VERSION_CONFLICT", "A signal was modified elsewhere during the update. Nothing was changed; reload and try again.", extra={"signal_id": str(signal_id)})
        field_id = await _readdress(session, signal_id, source, check)
        if source.get("edge_id"):
            edges.add(as_uuid(source["edge_id"]))
        else:
            local_changed = True
        await audit(session, tenant_id=tenant_id, event_type="SIGNAL_ADDRESS_UPDATE", actor_id=actor, entity_type="signal", entity_id=signal_id, before={"address": before, "version": int(signal["version"])}, after={"address": check.address, "version": int(bumped["version"]), "bulk": True}, correlation_id=correlation_id)
        updated.append({"signal_id": str(signal_id), "version": int(bumped["version"]), "source": _source_view(source, address=check.address, field_id=field_id)})
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    if local_changed and not edges:
        await _notify_config_changed(session, tenant_id)
    return {"updated": updated, "unchanged": unchanged, "count": len(updated)}


BULK_PROPERTY_KEYS = ("unit", "expected_interval_ms", "round_digits")
NUMERIC_SIGNAL_TYPES = frozenset({"int64", "float64"})


async def bulk_properties_signals(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SignalBulkPropertiesIn, correlation_id: str) -> dict[str, Any]:
    """Set unit, expected interval (Stale timeout) and/or round digits on many signals at once,
    all or nothing (R4-SG-02). Runs in the request transaction: every item is validated first and a
    422 lists the errors per item; otherwise each changed signal gets one version bump and one audit
    entry, a changed rounding re-addresses the source (as the single edit does) and one configuration
    release per affected edge is published."""
    sent = [key for key in BULK_PROPERTY_KEYS if key in body.model_fields_set]
    if not sent:
        raise AppError(422, "REQUIRED", "Choose at least one property to change.")
    if not body.items or len(body.items) > 1000:
        raise AppError(422, "LIMIT", "Send between 1 and 1000 signals.")
    if "unit" in sent and body.unit is not None and len(body.unit.strip()) > 32:
        raise AppError(422, "UNIT", "Unit must be at most 32 characters.", field_errors=[{"path": "unit", "code": "LENGTH"}])
    if "expected_interval_ms" in sent and (body.expected_interval_ms is None or not 100 <= body.expected_interval_ms <= 86_400_000):
        raise AppError(422, "INTERVAL", "Expected interval must be between 100 ms and one day.", field_errors=[{"path": "expected_interval_ms", "code": "RANGE"}])
    if "round_digits" in sent and body.round_digits is not None and not 0 <= body.round_digits <= 10:
        raise AppError(422, "RANGE", "Round digits must be a whole number from 0 to 10.", field_errors=[{"path": "round_digits", "code": "RANGE"}])
    unit = (body.unit or "").strip() if "unit" in sent else None

    item_errors: list[dict[str, Any]] = []
    ids: list[UUID | None] = []
    seen: set[UUID] = set()
    for index, item in enumerate(body.items):
        try:
            signal_id = parse_uuid(item.signal_id)
        except AppError:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "INVALID_ID", "message": "Invalid signal id."})
            ids.append(None)
            continue
        if signal_id in seen:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "DUPLICATE", "message": "The signal appears more than once."})
        seen.add(signal_id)
        ids.append(signal_id)
    known = [sid for sid in ids if sid is not None]
    signals = {
        as_uuid(row["id"]): row
        for row in await fetch_all(
            session,
            "SELECT id, version, status, data_type, display_name, unit, expected_interval_ms FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
            {"tenant_id": tenant_id, "ids": known},
        )
    } if known else {}
    sources = await _current_sources(session, tenant_id, known) if "round_digits" in sent else {}
    planned: list[tuple[UUID, dict[str, Any], AddressCheck | None]] = []
    for index, (item, signal_id) in enumerate(zip(body.items, ids)):
        if signal_id is None:
            continue
        signal = signals.get(signal_id)
        label = (signal or {}).get("display_name") or item.signal_id

        def fail(path: str, code: str, message: str) -> None:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": path, "code": code, "message": f"{label}: {message}"})

        if signal is None:
            fail("signal_id", "NOT_FOUND", "Signal not found.")
            continue
        if signal["status"] != "ACTIVE":
            fail("signal_id", "ARCHIVED", "Archived signals cannot be modified.")
            continue
        if int(signal["version"]) != item.version:
            fail("version", "RESOURCE_VERSION_CONFLICT", "This signal was modified elsewhere. Reload it and try again.")
            continue
        check: AddressCheck | None = None
        if "round_digits" in sent:
            if str(signal.get("data_type")) not in NUMERIC_SIGNAL_TYPES:
                fail("round_digits", "TYPE", "Rounding applies to numeric signals only.")
                continue
            check = check_address_change(signal, sources.get(signal_id), {"round_digits": body.round_digits})
            for error in check.errors:
                fail(error["path"], error["code"], error["message"])
            if not check.ok:
                continue
            if check.address == (sources[signal_id].get("address_json") or {}):
                check = None
        planned.append((signal_id, signal, check))
    if item_errors:
        raise AppError(
            422,
            "BULK_PROPERTIES_REJECTED",
            f"No signal was changed because {len({e['index'] for e in item_errors})} signal(s) have errors.",
            field_errors=[{"path": f"items[{e['index']}].{e['path']}", "code": e["code"]} for e in item_errors],
            extra={"item_errors": item_errors},
        )

    updated: list[dict[str, Any]] = []
    unchanged: list[str] = []
    edges: set[UUID] = set()
    local_changed = False
    now = utcnow()
    for signal_id, signal, check in planned:
        before: dict[str, Any] = {}
        after: dict[str, Any] = {}
        if unit is not None and (signal.get("unit") or "") != unit:
            before["unit"], after["unit"] = signal.get("unit"), unit
        if "expected_interval_ms" in sent and signal.get("expected_interval_ms") != body.expected_interval_ms:
            before["expected_interval_ms"], after["expected_interval_ms"] = signal.get("expected_interval_ms"), body.expected_interval_ms
        if check is not None:
            before["round_digits"] = (sources[signal_id].get("address_json") or {}).get("round_digits")
            after["round_digits"] = body.round_digits
        if not after:
            unchanged.append(str(signal_id))
            continue
        bumped = await fetch_one(
            session,
            """
            UPDATE signal_definitions
            SET unit = :unit, expected_interval_ms = :interval, version = version + 1, updated_at = :now
            WHERE id = :id AND tenant_id = :tenant_id AND version = :version RETURNING version
            """,
            {
                "unit": after.get("unit", signal.get("unit")),
                "interval": after.get("expected_interval_ms", signal.get("expected_interval_ms")),
                "now": now,
                "id": signal_id,
                "tenant_id": tenant_id,
                "version": int(signal["version"]),
            },
        )
        if bumped is None:
            raise AppError(409, "RESOURCE_VERSION_CONFLICT", "A signal was modified elsewhere during the update. Nothing was changed; reload and try again.", extra={"signal_id": str(signal_id)})
        if check is not None:
            await _readdress(session, signal_id, sources[signal_id], check)
            if sources[signal_id].get("edge_id"):
                edges.add(as_uuid(sources[signal_id]["edge_id"]))
            else:
                local_changed = True
        before["version"], after["version"] = int(signal["version"]), int(bumped["version"])
        await audit(session, tenant_id=tenant_id, event_type="SIGNAL_UPDATE", actor_id=actor, entity_type="signal", entity_id=signal_id, before=before, after={**after, "bulk": True}, correlation_id=correlation_id)
        updated.append({"signal_id": str(signal_id), "version": int(bumped["version"]), "changed": sorted(k for k in after if k != "version")})
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    if local_changed and not edges:
        await _notify_config_changed(session, tenant_id)
    return {"updated": updated, "unchanged": unchanged, "count": len(updated)}


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
    if not edges:
        await _notify_config_changed(session, tenant_id)
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
               c.id AS connection_id, c.name AS connection_name, c.protocol AS connection_protocol, c.status AS connection_status,
               e.id AS edge_id, e.name AS edge_name,
               f.address_kind, f.address_json, COALESCE(f.ordinal, 0) AS source_ordinal, j.id AS job_id, b.enabled AS binding_enabled
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
    for row in rows:
        if row.get("data_type") == "bool":
            row["data_type"] = "boolean"
        row["signal_id"] = str(row["id"])
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
    await _notify_config_changed(session, tenant_id)
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
    # HTTP: a relative data path used to prove authentication when the test has no fields and the
    # connection has no ``path`` (R2-CN-01). Without any path AUTH is reported SKIPPED.
    test_path: str | None = Field(default=None, max_length=512)
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
    test_path: str | None = None,
) -> dict[str, Any]:
    """Dispatch a real commissioning test to the edge; results come back via GET /commissioning/{id}."""
    connection = await _connection_row(session, tenant_id, connection_id)
    if connection["status"] == "ARCHIVED":
        raise AppError(409, "ARCHIVED", "Archived connections cannot be tested.")
    if connection.get("edge_id"):
        edge = await _owned_edge(session, tenant_id, as_uuid(connection["edge_id"]))
        await _assert_edge_can_run(session, edge)
    else:
        await _assert_local_acquisition_can_run(session)
    probe_path = (test_path or "").strip() or None
    if probe_path is not None and ("://" in probe_path or probe_path.startswith("//")):
        raise AppError(422, "TEST_PATH", "The test path must be relative to the base URL, for example /api/v1/status.", field_errors=[{"path": "test_path", "code": "INVALID"}])
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
    if probe_path is not None:
        meta["test_path"] = probe_path
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
    await execute(
        session,
        "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
        {"channel": "factorix_commissioning", "payload": json.dumps({"job_id": str(job_id), "connection_id": str(connection_id)})},
    )
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
