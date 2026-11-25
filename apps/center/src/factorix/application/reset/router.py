"""HTTP routes ``/api/v1/admin/telemetry-reset/*`` (R2-E B8, moved verbatim from
``factorix.modules.telemetry_reset``). No module-level router here: the old module still exports ``router``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import (
    as_uuid,
    parse_uuid,
)
from factorix.modules.identity import SESSION_COOKIE, assert_csrf, principal_from_token
from factorix.modules.live_state import get_live_state_provider
from factorix.platform.db import session_factory
from factorix.platform.settings import get_settings
from factorix.platform.tdengine import (
    TDEngineClient,
)

from factorix.application.reset.service import TelemetryResetService


class TelemetryResetExecuteIn(BaseModel):
    confirm_phrase: str = Field(default="")
    password: str = Field(default="")


async def _default_db_session() -> Any:
    factory = session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


async def _default_admin_principal(
    request: Request,
    session: AsyncSession = Depends(_default_db_session),
) -> dict[str, Any]:
    row = await principal_from_token(session, request.cookies.get(SESSION_COOKIE))
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        assert_csrf(request.headers.get("x-csrf-token"), row["csrf_hash"])
    return row


def _resolve_td_client(request: Request) -> TDEngineClient | None:
    app = getattr(request, "app", None)
    state = getattr(app, "state", None)
    return getattr(state, "td_client", None)


def _resolve_broker_config() -> Any:
    try:
        from factorix.platform.broker import BrokerConfig

        cfg = get_settings()
        if getattr(cfg, "rabbitmq_url", ""):
            return BrokerConfig.from_settings(cfg)
    except Exception:  # noqa: BLE001
        return None
    return None


def build_router(
    admin_dep: Callable[..., Any] = _default_admin_principal,
    session_dep: Callable[..., Any] = _default_db_session,
) -> APIRouter:
    """Build FastAPI ``APIRouter`` for ``/api/v1/admin/telemetry-reset`` endpoints."""
    r = APIRouter(prefix="/api/v1/admin/telemetry-reset", tags=["telemetry-reset"])
    service = TelemetryResetService()

    @r.get("/preview")
    @r.post("/preview")
    async def preview_reset(
        request: Request,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        td_client = _resolve_td_client(request)
        return await service.preview(session, tenant_id, tdengine=td_client)

    @r.post("/execute")
    async def execute_reset(
        body: TelemetryResetExecuteIn,
        request: Request,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        actor_id = as_uuid(principal["admin_id"])
        td_client = _resolve_td_client(request)
        broker_cfg = getattr(getattr(request.app, "state", None), "broker", None) or _resolve_broker_config()
        live_prov = getattr(getattr(request.app, "state", None), "live_state_provider", None) or get_live_state_provider()
        return await service.execute(
            session,
            tenant_id,
            actor_id,
            confirm_phrase=body.confirm_phrase,
            password=body.password,
            tdengine=td_client,
            broker=broker_cfg,
            live_provider=live_prov,
        )

    @r.get("/status")
    async def reset_status(
        operation_id: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        op_uuid = parse_uuid(operation_id) if operation_id else None
        return await service.status(session, tenant_id, operation_id=op_uuid)

    @r.get("/{operation_id}")
    async def reset_status_by_id(
        operation_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        return await service.status(session, tenant_id, operation_id=parse_uuid(operation_id))

    return r
