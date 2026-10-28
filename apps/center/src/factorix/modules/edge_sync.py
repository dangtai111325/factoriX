"""Edge credential sync: config, heartbeat, ingest and commissioning pull."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import as_uuid, execute, fetch_one, jsonb, utcnow
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
        raise AppError(401, "ENROLLMENT", "Mã tham gia Edge không hợp lệ hoặc đã dùng.")
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
        raise AppError(401, "UNAUTHENTICATED", "Thiếu credential Edge.")
    row = await fetch_one(
        session,
        """
        SELECT id, tenant_id, site_id, desired_revision, active_revision, enrollment_status
        FROM edge_nodes WHERE credential_hash = :credential_hash
        """,
        {"credential_hash": hash_token(credential)},
    )
    if row is None or row["enrollment_status"] != "ENROLLED":
        raise AppError(401, "UNAUTHENTICATED", "Credential Edge không hợp lệ.")
    return row


async def heartbeat(session: AsyncSession, edge: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    health = str(body.get("health") or "HEALTHY")
    if health not in {"HEALTHY", "DEGRADED", "OFFLINE", "ACTIVE", "CONFIG_PENDING"}:
        health = "DEGRADED"
    await execute(
        session,
        """
        UPDATE edge_nodes
        SET last_heartbeat = :now, health = :health, software_version = :version, outbox_pending = :pending
        WHERE id = :id
        """,
        {
            "now": utcnow(),
            "health": health,
            "version": str(body.get("software_version") or "")[:40],
            "pending": int(body.get("outbox_pending") or 0),
            "id": as_uuid(edge["id"]),
        },
    )
    fresh = await fetch_one(session, "SELECT desired_revision, active_revision, health FROM edge_nodes WHERE id = :id", {"id": as_uuid(edge["id"])})
    assert fresh is not None
    return fresh


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
        raise AppError(422, "STATE", "Trạng thái kích hoạt không hợp lệ.")
    if revision != int(edge["desired_revision"]) and state == "ACTIVE":
        raise AppError(409, "REVISION", "Revision không khớp cấu hình mong muốn.")
    if state == "ACTIVE":
        await execute(
            session,
            "UPDATE edge_nodes SET active_revision = :revision, health = 'ACTIVE' WHERE id = :id",
            {"revision": revision, "id": as_uuid(edge["id"])},
        )
        await execute(
            session,
            """
            UPDATE connections
            SET status = 'ACTIVE', health = 'HEALTHY', last_success_at = :now, updated_at = :now
            WHERE edge_id = :id AND tenant_id = :tenant_id AND status IN ('DRAFT', 'PUBLISHED', 'DEPLOYING')
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
        SELECT j.id, j.connection_id, j.stages_json, c.protocol, c.config_json, c.endpoint_redacted, c.secret_ref
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
    return {"job": jobs}


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
        raise AppError(404, "NOT_FOUND", "Không tìm thấy lệnh kiểm thử.")
    status = body.get("status")
    if status not in {"PASSED", "FAILED", "CANCELLED"}:
        raise AppError(422, "STATE", "Kết quả kiểm thử không hợp lệ.")
    await execute(
        session,
        """
        UPDATE commissioning_jobs
        SET status = :status, stages_json = CAST(:stages AS jsonb), completed_at = :now,
            error_code = :error_code, diagnostic = :diagnostic
        WHERE id = :id
        """,
        {
            "status": status,
            "stages": jsonb(body.get("stages") or []),
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
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bí mật của Edge này.")
    return {"secret": decrypt_secret(data_key, row["ciphertext"])}
