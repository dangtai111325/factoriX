"""Shared HTTP dependencies: settings, DB session, admin principal, the WebSocket hub, time parsing. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import as_uuid
from factorix.platform.after_commit import flush, listen
from factorix.transport.hub import Hub
from factorix.modules.identity import SESSION_COOKIE, assert_csrf, principal_from_token
from factorix.platform.db import session_factory
from factorix.platform.errors import AppError
from factorix.platform.settings import Settings, get_settings


_INITIAL_SETTINGS = settings = get_settings()
logger = logging.getLogger("factorix.transport.app")


def _settings() -> Settings:
    """Resolve current settings while still honoring test monkeypatches on `app.settings`."""
    return get_settings() if settings is _INITIAL_SETTINGS else settings


async def _flush_events(session: AsyncSession) -> None:
    try:
        await flush(session)
    except Exception:  # noqa: BLE001 - push delivery must never turn a committed request into an error
        logger.exception("After-commit event delivery failed")


async def db_session() -> AsyncIterator[AsyncSession]:
    factory = session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            session.info.pop("fx_events", None)
            raise
        else:
            await _flush_events(session)


async def _commit_now(session: AsyncSession) -> None:
    """Commit before the response is sent (FastAPI runs yield-dependency exit after the response).

    Used where the caller acts on the response: the edge marks outbox rows ACKED, so the rows must
    be durable first. After-commit events are delivered right after the commit.
    """
    await session.commit()
    await _flush_events(session)


async def admin(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    row = await principal_from_token(session, request.cookies.get(SESSION_COOKIE))
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        assert_csrf(request.headers.get("x-csrf-token"), row["csrf_hash"])
    return row


def _ids(row: dict[str, Any]) -> tuple[Any, Any]:
    return as_uuid(row["tenant_id"]), as_uuid(row["admin_id"])


hub = Hub()


async def _publish_committed(events: list[dict[str, Any]]) -> None:
    hub.dispatch(events)


listen(_publish_committed)


async def _run_step(name: str, step: Any) -> None:
    """Run one background step in its own session; failures are logged and never stop the loop."""
    started = time.monotonic()
    try:
        async with session_factory()() as session:
            await step(session)
            await session.commit()
            await _flush_events(session)
        elapsed = time.monotonic() - started
        if elapsed > SLOW_REQUEST_S:
            logger.warning("Background step %s took %.2f s", name, elapsed)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - one failing step must not stop the others
        logger.exception("Background step %s failed", name)


def _opt_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return None


SLOW_REQUEST_S = 1.0


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise AppError(422, "TIMEZONE", "Timestamps must include a timezone.")
    return parsed.astimezone(timezone.utc)
