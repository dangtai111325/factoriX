"""Legacy Edge fleet: create/enroll/patch/delete edge, configuration releases and the config-changed NOTIFY. Moved verbatim from ``factorix.modules.collect`` (R2-E B6, move-only)."""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
from factorix.platform.errors import AppError
from factorix.platform.security import new_token, hash_token


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
