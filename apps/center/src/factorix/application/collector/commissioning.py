"""Commissioning requests (capture, connection tests) handed to Acquisition via PG + NOTIFY. Moved verbatim from ``factorix.modules.collect`` (R2-E B6, move-only)."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import as_uuid, audit, execute, jsonb, utcnow
from factorix.modules.protocols import accept_connection, parse_config, public_protocol, unmask_config
from factorix.platform.errors import AppError

from factorix.application.collector.schemas import CaptureIn, SUBSCRIBE_PROTOCOLS
from factorix.application.legacy_edge.fleet import _assert_edge_can_run, _assert_local_acquisition_can_run, _owned_edge
from factorix.application.collector.connections import _connection_row, get_connection


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
