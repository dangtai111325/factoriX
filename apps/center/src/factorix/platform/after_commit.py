"""Events that may leave the process only after the database transaction commits."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

Listener = Callable[[list[dict[str, Any]]], Awaitable[None]]
Effect = Callable[[], Awaitable[None]]
_listeners: list[Listener] = []
logger = logging.getLogger(__name__)


def listen(listener: Listener) -> None:
    if listener not in _listeners:
        _listeners.append(listener)


def queue(session: AsyncSession, event: dict[str, Any]) -> None:
    session.info.setdefault("fx_events", []).append(event)


def defer(session: AsyncSession, effect: Effect) -> None:
    # Private effects never enter the event/broadcast payload.
    session.info.setdefault("fx_effects", []).append(effect)


def discard(session: AsyncSession) -> None:
    session.info.pop("fx_events", None)
    session.info.pop("fx_effects", None)


async def flush(session: AsyncSession) -> None:
    events = list(session.info.pop("fx_events", []))
    effects = list(session.info.pop("fx_effects", []))
    for listener in _listeners if events else ():
        try:
            await listener(events)
        except Exception as exc:
            # The write is already committed. A disconnected viewer cannot roll it back
            # or turn it into a misleading HTTP failure; reconnect reads a fresh snapshot.
            logger.error("After-commit event delivery failed (%s).", type(exc).__name__)
    for effect in effects:
        try:
            await effect()
        except Exception as exc:
            # The owning use case must retain a durable retry record. Do not
            # report the committed request as rolled back or log secret payloads.
            logger.error("After-commit effect delivery failed (%s).", type(exc).__name__)
