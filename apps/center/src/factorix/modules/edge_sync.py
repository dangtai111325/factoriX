"""Edge credential sync: config, heartbeat, ingest and commissioning pull."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.health import (
    ConnectionUpdate,
    apply_connection_report,
    edge_config_state,
    effective_connection_health,
    effective_edge_health,
)
from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, iso_ms, jsonb, queue_stream_event, utcnow
from factorix.modules.telemetry import ingest_observations
from factorix.platform.errors import AppError
from factorix.platform.security import decrypt_secret, hash_token, new_token


async def enroll(session: AsyncSession, enrollment_token: str) -> dict[str, str]:
    row = await fetch_one(
        session,
        """
        SELECT t.id AS token_id, t.edge_id, t.expires_at, t.used_at, e.tenant_id, e.enrollment_status
        FROM edge_enrollment_tokens t
        JOIN edge_nodes e ON e.id = t.edge_id
        WHERE t.token_hash = :token_hash
        """,
        {"token_hash": hash_token(enrollment_token)},
    )
    if row is None or row["used_at"] is not None or row["expires_at"] <= utcnow():
        raise AppError(401, "ENROLLMENT", "Edge enrollment token is invalid or already used.")
    credential = new_token()
    await execute(
        session,
        """
        UPDATE edge_nodes
        SET credential_hash = :credential_hash, enrollment_status = 'ENROLLED', health = 'OFFLINE'
        WHERE id = :id
        """,
        {"credential_hash": hash_token(credential), "id": as_uuid(row["edge_id"])},
    )
    await execute(
        session,
        "UPDATE edge_enrollment_tokens SET used_at = :now WHERE id = :id",
        {"now": utcnow(), "id": as_uuid(row["token_id"])},
    )
    return {"edge_id": str(row["edge_id"]), "credential": credential, "tenant_id": str(row["tenant_id"])}


async def edge_principal(session: AsyncSession, credential: str | None) -> dict[str, Any]:
    if not credential:
        raise AppError(401, "UNAUTHENTICATED", "Missing Edge credential.")
    row = await fetch_one(
        session,
        """
        SELECT id, tenant_id, site_id, desired_revision, active_revision, enrollment_status
        FROM edge_nodes WHERE credential_hash = :credential_hash
        """,
        {"credential_hash": hash_token(credential)},
    )
    if row is None or row["enrollment_status"] != "ENROLLED":
        raise AppError(401, "UNAUTHENTICATED", "Invalid Edge credential.")
    return row


_EDGE_REPORTED_HEALTH = {"HEALTHY", "DEGRADED", "ACTIVE", "CONFIG_PENDING"}


def edge_health_payload(row: dict[str, Any], now: datetime) -> dict[str, Any]:
    effective = effective_edge_health(row, now)
    return {
        "type": "health",
        "entity": "edge",
        "id": str(row["id"]),
        "health": effective,
        "effective_health": effective,
        "config_state": edge_config_state(row),
        "last_error": None,
        "last_success_at": iso_ms(row.get("last_heartbeat")),
    }


async def heartbeat(session: AsyncSession, edge: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    """Record edge liveness and apply the per-connection states the edge reports."""
    now = utcnow()
    edge_id = as_uuid(edge["id"])
    tenant_id = as_uuid(edge["tenant_id"])
    previous = await fetch_one(
        session,
        "SELECT id, enrollment_status, health, last_heartbeat, desired_revision, active_revision FROM edge_nodes WHERE id = :id FOR UPDATE",
        {"id": edge_id},
    )
    assert previous is not None
    health = str(body.get("health") or "HEALTHY").upper()
    if health not in _EDGE_REPORTED_HEALTH:
        health = "DEGRADED"
    queues = body.get("queues")
    try:
        pending = max(int(body.get("outbox_pending") or 0), 0)
    except (TypeError, ValueError):
        pending = 0
    await execute(
        session,
        """
        UPDATE edge_nodes
        SET last_heartbeat = :now, health = :health, software_version = :version, outbox_pending = :pending,
            queues_json = CAST(:queues AS jsonb)
        WHERE id = :id
        """,
        {
            "now": now,
            "health": health,
            "version": str(body.get("software_version") or "")[:40],
            "pending": pending,
            "queues": jsonb(queues if isinstance(queues, dict) else {}),
            "id": edge_id,
        },
    )
    fresh = await fetch_one(
        session,
        "SELECT id, enrollment_status, health, last_heartbeat, desired_revision, active_revision, queues_json FROM edge_nodes WHERE id = :id",
        {"id": edge_id},
    )
    assert fresh is not None
    before = effective_edge_health(previous, now)
    after = effective_edge_health(fresh, now)
    if before != after:
        if before == "OFFLINE":
            await audit(
                session,
                tenant_id=tenant_id,
                event_type="EDGE_ONLINE",
                actor_id=None,
                entity_type="edge",
                entity_id=edge_id,
                before={"health": before},
                after={"health": after},
                correlation_id="heartbeat",
            )
        queue_stream_event(session, "health", tenant_id, edge_health_payload(fresh, now))
    reports = body.get("connections")
    if isinstance(reports, dict) and reports:
        await _apply_connection_reports(session, tenant_id, edge_id, reports, now)
    return {
        "desired_revision": fresh["desired_revision"],
        "active_revision": fresh["active_revision"],
        "health": fresh["health"],
        "effective_health": after,
        "queues_json": fresh.get("queues_json"),
    }


async def _apply_connection_reports(
    session: AsyncSession,
    tenant_id: UUID,
    edge_id: UUID,
    reports: dict[str, Any],
    now: datetime,
) -> None:
    by_id: dict[UUID, dict[str, Any]] = {}
    for key, report in list(reports.items())[:500]:
        if not isinstance(report, dict):
            continue
        try:
            by_id[UUID(str(key))] = report
        except ValueError:
            continue
    if not by_id:
        return
    rows = await fetch_all(
        session,
        """
        SELECT id, status, health, last_error, last_success_at
        FROM connections
        WHERE tenant_id = :tenant_id AND edge_id = :edge_id AND id = ANY(:ids)
        FOR UPDATE
        """,
        {"tenant_id": tenant_id, "edge_id": edge_id, "ids": list(by_id)},
    )
    if not rows:
        return
    counts = await fetch_all(
        session,
        """
        SELECT j.connection_id, count(DISTINCT b.signal_id) AS active_bindings
        FROM acquisition_jobs j
        JOIN source_fields f ON f.acquisition_job_id = j.id
        JOIN signal_bindings b ON b.source_field_id = f.id
        JOIN signal_definitions s ON s.id = b.signal_id
        WHERE j.connection_id = ANY(:ids) AND b.enabled = TRUE AND b.valid_to IS NULL AND s.status = 'ACTIVE'
        GROUP BY j.connection_id
        """,
        {"ids": [as_uuid(row["id"]) for row in rows]},
    )
    bindings = {str(row["connection_id"]): int(row["active_bindings"] or 0) for row in counts}
    for row in rows:
        conn_id = as_uuid(row["id"])
        update = apply_connection_report(row, by_id[conn_id], now)
        if update is None:
            continue
        await execute(
            session,
            "UPDATE connections SET health = :health, last_error = :last_error, last_success_at = :last_success_at WHERE id = :id",
            {"health": update.health, "last_error": update.last_error, "last_success_at": update.last_success_at, "id": conn_id},
        )
        payload = _connection_payload(conn_id, update, bindings.get(str(conn_id), 0))
        if update.health == row["health"]:
            if update.last_error != row.get("last_error"):
                queue_stream_event(session, "health", tenant_id, payload)
            continue
        if update.health == "DEGRADED":
            await audit(
                session,
                tenant_id=tenant_id,
                event_type="CONNECTION_DEGRADED",
                actor_id=None,
                entity_type="connection",
                entity_id=conn_id,
                before={"health": row["health"]},
                after={"health": "DEGRADED", "last_error": update.last_error, "source": "edge"},
                correlation_id="heartbeat",
            )
        elif row["health"] == "DEGRADED":
            await audit(
                session,
                tenant_id=tenant_id,
                event_type="CONNECTION_RECOVERED",
                actor_id=None,
                entity_type="connection",
                entity_id=conn_id,
                before={"health": "DEGRADED"},
                after={"health": update.health},
                correlation_id="heartbeat",
            )
        queue_stream_event(session, "health", tenant_id, payload)


def _connection_payload(conn_id: UUID, update: ConnectionUpdate, active_bindings: int) -> dict[str, Any]:
    return {
        "type": "health",
        "entity": "connection",
        "id": str(conn_id),
        "health": update.health,
        "effective_health": effective_connection_health(status="ACTIVE", health=update.health, active_bindings=active_bindings, edge_health="ONLINE"),
        "last_error": update.last_error,
        "last_success_at": iso_ms(update.last_success_at),
    }


async def desired_config(session: AsyncSession, edge: dict[str, Any]) -> dict[str, Any]:
    release = await fetch_one(
        session,
        """
        SELECT revision, content_hash, snapshot_json, published_at, status
        FROM configuration_releases
        WHERE edge_id = :edge_id AND revision = :revision
        """,
        {"edge_id": as_uuid(edge["id"]), "revision": int(edge["desired_revision"])},
    )
    if release is None:
        return {"revision": int(edge["desired_revision"]), "active_revision": int(edge["active_revision"]), "snapshot": None}
    return {
        "revision": release["revision"],
        "active_revision": int(edge["active_revision"]),
        "checksum_sha256": release["content_hash"],
        "snapshot": release["snapshot_json"],
    }


async def acknowledge(session: AsyncSession, edge: dict[str, Any], revision: int, state: str, diagnostic: str) -> dict[str, Any]:
    if state not in {"ACTIVE", "FAILED"}:
        raise AppError(422, "STATE", "Invalid activation state.")
    if revision != int(edge["desired_revision"]) and state == "ACTIVE":
        raise AppError(409, "REVISION", "Revision does not match expected configuration.")
    if state == "ACTIVE":
        await execute(
            session,
            "UPDATE edge_nodes SET active_revision = :revision, health = 'CONFIG_VALIDATED' WHERE id = :id",
            {"revision": revision, "id": as_uuid(edge["id"])},
        )
        await execute(
            session,
            """
            UPDATE connections
            SET status = 'ACTIVE', health = 'UNKNOWN', updated_at = :now
            WHERE edge_id = :id AND tenant_id = :tenant_id AND status = 'DRAFT'
            """,
            {"now": utcnow(), "id": as_uuid(edge["id"]), "tenant_id": as_uuid(edge["tenant_id"])},
        )
    else:
        await execute(
            session,
            "UPDATE edge_nodes SET health = 'DEGRADED' WHERE id = :id",
            {"id": as_uuid(edge["id"])},
        )
    await execute(
        session,
        """
        INSERT INTO deployment_events (id, edge_id, revision, state, diagnostic_redacted, at)
        VALUES (:id, :edge_id, :revision, :state, :diagnostic, :now)
        """,
        {
            "id": uuid4(),
            "edge_id": as_uuid(edge["id"]),
            "revision": revision,
            "state": state,
            "diagnostic": diagnostic[:500],
            "now": utcnow(),
        },
    )
    fresh = await fetch_one(
        session,
        "SELECT desired_revision, active_revision, health FROM edge_nodes WHERE id = :id",
        {"id": as_uuid(edge["id"])},
    )
    assert fresh is not None
    return fresh


async def accept_observations(session: AsyncSession, edge: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any]:
    return await ingest_observations(session, tenant_id=as_uuid(edge["tenant_id"]), edge_id=as_uuid(edge["id"]), items=items)


async def pull_commands(session: AsyncSession, edge: dict[str, Any]) -> dict[str, Any]:
    jobs = await fetch_one(
        session,
        """
        SELECT j.id, j.connection_id, j.stages_json, j.samples_json, c.protocol, c.config_json, c.endpoint_redacted, c.secret_ref
        FROM commissioning_jobs j
        JOIN connections c ON c.id = j.connection_id
        WHERE j.status = 'PENDING' AND c.edge_id = :edge_id
        ORDER BY j.id
        LIMIT 1
        """,
        {"edge_id": as_uuid(edge["id"])},
    )
    if jobs is None:
        return {"job": None}
    await execute(session, "UPDATE commissioning_jobs SET status = 'RUNNING', started_at = :now WHERE id = :id", {"now": utcnow(), "id": as_uuid(jobs["id"])})
    meta = (jobs.get("samples_json") or {}).get("meta", {})
    override = meta.get("config_override")
    job_payload = {
        "id": str(jobs["id"]),
        "connection_id": str(jobs["connection_id"]),
        "stages_json": jobs["stages_json"],
        "protocol": jobs["protocol"],
        # A test of unsaved edits carries the validated draft config; otherwise the stored one.
        "config_json": override if isinstance(override, dict) and override else jobs["config_json"],
        "endpoint_redacted": jobs["endpoint_redacted"],
        "secret_ref": str(jobs["secret_ref"]) if jobs.get("secret_ref") else None,
        "command_type": meta.get("command_type") or "COMMISSION",
        "mode": meta.get("mode") or "FULL",
        "fields": meta.get("fields") or [],
        "test_path": meta.get("test_path"),
        "topic_filter": meta.get("topic_filter"),
        "topics": meta.get("topics") or [],
        # HTTP capture fetches one path; the wizard sends it as the capture filter.
        "path": meta.get("path") or (meta.get("topic_filter") if jobs["protocol"] == "http" else None),
        "seconds": meta.get("seconds"),
        "max_messages": meta.get("max_messages"),
        "browse_node": meta.get("browse_node"),
    }
    return {"job": job_payload}


def _command_result(body: dict[str, Any]) -> dict[str, Any]:
    samples = body.get("samples")
    result: dict[str, Any] = dict(samples) if isinstance(samples, dict) else {"samples": samples or []}
    if body.get("browse") is not None:
        result["browse"] = body.get("browse")
    return result


async def finish_command(session: AsyncSession, edge: dict[str, Any], job_id: UUID, body: dict[str, Any]) -> dict[str, Any]:
    job = await fetch_one(
        session,
        """
        SELECT j.id FROM commissioning_jobs j
        JOIN connections c ON c.id = j.connection_id
        WHERE j.id = :id AND c.edge_id = :edge_id
        """,
        {"id": job_id, "edge_id": as_uuid(edge["id"])},
    )
    if job is None:
        raise AppError(404, "NOT_FOUND", "Commissioning command not found.")
    status = body.get("status")
    if status not in {"PASSED", "FAILED", "CANCELLED"}:
        raise AppError(422, "STATE", "Invalid commissioning test status.")
    await execute(
        session,
        """
        UPDATE commissioning_jobs
        SET status = :status, stages_json = CAST(:stages AS jsonb), completed_at = :now,
            error_code = :error_code, diagnostic = :diagnostic,
            samples_json = CAST(:samples AS jsonb)
        WHERE id = :id
        """,
        {
            "status": status,
            "stages": jsonb(body.get("stages") or []),
            # Keep every result part the edge reports (samples, browse tree, raw payload text).
            "samples": jsonb(_command_result(body)),
            "now": utcnow(),
            "error_code": body.get("error_code"),
            "diagnostic": str(body.get("diagnostic") or "")[:1000],
            "id": job_id,
        },
    )
    return {"job_id": str(job_id), "status": status}


async def read_secret(session: AsyncSession, edge: dict[str, Any], secret_id: UUID, data_key: str) -> dict[str, str]:
    row = await fetch_one(
        session,
        """
        SELECT s.ciphertext FROM secret_store s
        JOIN connections c ON c.secret_ref = s.id
        WHERE s.id = :id AND c.edge_id = :edge_id AND c.tenant_id = :tenant_id
        """,
        {"id": secret_id, "edge_id": as_uuid(edge["id"]), "tenant_id": as_uuid(edge["tenant_id"])},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Secret for this Edge was not found.")
    return {"secret": decrypt_secret(data_key, row["ciphertext"])}
