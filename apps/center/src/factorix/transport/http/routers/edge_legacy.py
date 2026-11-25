"""Legacy Edge machine-to-machine API ``/api/v1/edge-sync/*`` (410 in acquisition mode, A4(b)). Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import edge_sync
from factorix.modules.common import parse_uuid
from factorix.platform.errors import AppError

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _commit_now, _settings, db_session

router = RouteTable()


class EdgeEnrollIn(BaseModel):
    enrollment_token: str


class EdgeAckIn(BaseModel):
    revision: int
    state: str
    diagnostic: str = ""


class EdgeBatchIn(BaseModel):
    observations: list[dict[str, Any]]


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def _legacy_edge_sync_enabled() -> None:
    """A4(b) safety guard: the legacy Edge M2M API (it serves decrypted secrets) is gone in acquisition mode.

    Only the ``factorix_edge`` daemon calls these routes; acquisition reads PostgreSQL directly.
    """
    if _settings().collector_mode == "acquisition":
        raise AppError(410, "EDGE_SYNC_DISABLED", "The legacy Edge sync API is disabled: this installation uses the built-in acquisition collector.")


@router.post("/api/v1/edge-sync/enroll", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_enroll(body: EdgeEnrollIn, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    result = await edge_sync.enroll(session, body.enrollment_token)
    await _commit_now(session)
    return result


@router.post("/api/v1/edge-sync/heartbeat", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_heartbeat(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    body = await request.json()
    if not isinstance(body, dict):
        raise AppError(422, "BODY", "Heartbeat body must be a JSON object.")
    result = await edge_sync.heartbeat(session, edge, body)
    await _commit_now(session)
    return result


@router.get("/api/v1/edge-sync/config", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_config(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.desired_config(session, edge)


@router.post("/api/v1/edge-sync/ack", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_ack(body: EdgeAckIn, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    result = await edge_sync.acknowledge(session, edge, body.revision, body.state, body.diagnostic)
    await _commit_now(session)
    return result


@router.get("/api/v1/edge-sync/secrets/{secret_id}", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_secret(secret_id: str, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.read_secret(session, edge, parse_uuid(secret_id), _settings().data_key)


@router.post("/api/v1/edge-sync/observations", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_observations(body: EdgeBatchIn, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    result = await edge_sync.accept_observations(session, edge, body.observations)
    # The edge marks rows ACKED as soon as it reads this response: commit first (at-least-once).
    await _commit_now(session)
    return result


@router.get("/api/v1/edge-sync/commands", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_commands(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    result = await edge_sync.pull_commands(session, edge)
    await _commit_now(session)
    return result


@router.post("/api/v1/edge-sync/commands/{job_id}", dependencies=[Depends(_legacy_edge_sync_enabled)])
async def edge_command_result(job_id: str, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    body = await request.json()
    if not isinstance(body, dict):
        raise AppError(422, "BODY", "Command result must be a JSON object.")
    result = await edge_sync.finish_command(session, edge, parse_uuid(job_id), body)
    await _commit_now(session)
    return result
