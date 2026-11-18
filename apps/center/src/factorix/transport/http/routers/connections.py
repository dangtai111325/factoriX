"""Connector types, connections, commissioning (tests, capture, jobs). Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect
from factorix.modules.collect import CaptureIn, ConnectionIn, ConnectionPatch, TestIn
from factorix.modules.common import execute, fetch_all, fetch_one, parse_uuid
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _commit_now, _ids, _run_step, _settings, admin, db_session
from factorix.transport.background.appliance_enroll import _ensure_appliance_enrollment

router = RouteTable()


@router.get("/api/v1/connector-types")
async def connector_types(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return {"items": [{"protocol": key, "capabilities": value} for key, value in collect.CAPABILITIES.items()]}


@router.get("/api/v1/connector-types/{protocol}/schema")
async def connector_schema(protocol: str, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    if protocol not in collect.CAPABILITIES:
        raise AppError(404, "NOT_FOUND", "Protocol not found.")
    return {"protocol": protocol, "capabilities": collect.CAPABILITIES[protocol], "can_write": False}


@router.get("/api/v1/connections")
async def connections(protocol: str | None = None, site_id: str | None = None, status: str | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await collect.list_connections(session, tenant_id, protocol=protocol, site_id=site_id, status=status)}


@router.post("/api/v1/connections", status_code=201)
async def create_connection(body: ConnectionIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    cfg = _settings()
    created = await collect.create_connection(session, tenant_id, actor, body, data_key=cfg.data_key, correlation_id=correlation_id(request))
    if cfg.appliance and cfg.collector_mode != "acquisition":
        # A first connection may have created the local edge: hand it an enrollment token now.
        await _commit_now(session)
        await _run_step("appliance_enrollment", _ensure_appliance_enrollment)
    return created


@router.get("/api/v1/connections/{connection_id}")
async def connection_detail(connection_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await collect.get_connection(session, tenant_id, parse_uuid(connection_id))


@router.patch("/api/v1/connections/{connection_id}")
async def patch_connection(connection_id: str, body: ConnectionPatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.patch_connection(session, tenant_id, actor, parse_uuid(connection_id), body, data_key=_settings().data_key, correlation_id=correlation_id(request))


@router.post("/api/v1/connections/{connection_id}/pause")
async def pause_connection(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.pause_connection(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@router.post("/api/v1/connections/{connection_id}/resume")
async def resume_connection(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.resume_connection(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@router.delete("/api/v1/connections/{connection_id}")
async def delete_connection(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.archive_connection(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@router.post("/api/v1/connections/{connection_id}/capture", status_code=202)
async def capture_connection(connection_id: str, body: CaptureIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.capture_connection(session, tenant_id, actor, parse_uuid(connection_id), body, correlation_id(request))


@router.post("/api/v1/connections/{connection_id}/tests", status_code=202)
async def commission(connection_id: str, request: Request, body: TestIn | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    mode = body.mode if body and body.mode else "FULL"
    fields = body.fields if body else None
    config = body.config if body else None
    return await collect.request_commission(
        session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request), mode=mode, fields=fields, config=config, test_path=body.test_path if body else None
    )


@router.get("/api/v1/commissioning/{job_id}")
async def commission_job(job_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    row = await fetch_one(session, "SELECT id, connection_id, stages_json, status, error_code, diagnostic, samples_json, started_at, completed_at FROM commissioning_jobs WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(job_id), "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Commissioning job not found.")

    # 30-second reaper
    if row["status"] in {"PENDING", "RUNNING"}:
        started = row.get("started_at")
        if started:
            from factorix.modules.common import utcnow
            elapsed = (utcnow() - started).total_seconds()
            if elapsed > 30:
                await execute(
                    session,
                    """
                    UPDATE commissioning_jobs
                    SET status = 'FAILED', error_code = 'TIMEOUT', diagnostic = 'Commissioning job timed out after 30 seconds.', completed_at = :now
                    WHERE id = :id
                    """,
                    {"now": utcnow(), "id": row["id"]},
                )
                row["status"] = "FAILED"
                row["error_code"] = "TIMEOUT"
                row["diagnostic"] = "Commissioning job timed out after 30 seconds."

    status = "COMPLETED" if row["status"] == "PASSED" else row["status"]
    stages = list(row.get("stages_json") or [])
    return {
        "id": row["id"],
        "connection_id": row["connection_id"],
        "status": status,
        "error_code": row.get("error_code"),
        "diagnostic": row.get("diagnostic") or "",
        "stages_json": stages,
        "samples_json": row.get("samples_json") or {},
        "started_at": row.get("started_at"),
        "completed_at": row.get("completed_at"),
    }


class JobIn(BaseModel):
    connection_id: str
    mode: str = "POLL"
    interval_ms: int = 1000


@router.post("/api/v1/jobs")
async def create_or_get_job(body: JobIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    conn_id = parse_uuid(body.connection_id)
    conn = await fetch_one(session, "SELECT id FROM connections WHERE id = :id AND tenant_id = :tenant_id", {"id": conn_id, "tenant_id": tenant_id})
    if conn is None:
        raise AppError(404, "NOT_FOUND", "Connection not found.")
    job = await fetch_one(session, "SELECT id FROM acquisition_jobs WHERE connection_id = :id", {"id": conn_id})
    if job:
        await execute(session, "UPDATE acquisition_jobs SET mode = :mode, interval_ms = :interval_ms WHERE id = :id", {"id": job["id"], "mode": body.mode, "interval_ms": body.interval_ms})
        await execute(
            session,
            "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
            {"channel": "factorix_config_changed", "payload": f'{{"tenant_id":"{tenant_id}"}}'},
        )
        return {"id": str(job["id"])}
    job_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO acquisition_jobs (id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version)
        VALUES (:id, :connection_id, :mode, :interval_ms, 3000, TRUE, 1, 1, 1)
        """,
        {"id": job_id, "connection_id": conn_id, "mode": body.mode, "interval_ms": body.interval_ms},
    )
    await execute(
        session,
        "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
        {"channel": "factorix_config_changed", "payload": f'{{"tenant_id":"{tenant_id}"}}'},
    )
    return {"id": str(job_id)}


@router.get("/api/v1/commissioning")
async def commissioning(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(
        session,
        """
        SELECT j.id, j.connection_id, j.status, j.error_code, j.diagnostic, j.started_at, j.completed_at, j.stages_json,
               c.name AS connection_name, c.protocol
        FROM commissioning_jobs j
        JOIN connections c ON c.id = j.connection_id
        WHERE j.tenant_id = :tenant_id
        ORDER BY j.started_at DESC NULLS LAST
        LIMIT 100
        """,
        {"tenant_id": tenant_id},
    )
    return {"items": items}
