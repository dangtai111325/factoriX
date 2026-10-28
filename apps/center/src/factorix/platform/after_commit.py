"""Events that may leave the process only after the database transaction commits."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

Listener = Callable[[list[dict[str, Any]]], Awaitable[None]]
_listeners: list[Listener] = []


def listen(listener: Listener) -> None:
    if listener not in _listeners:
        _listeners.append(listener)


def queue(session: AsyncSession, event: dict[str, Any]) -> None:
    session.info.setdefault("fx_events", []).append(event)


async def flush(session: AsyncSession) -> None:
    events = list(session.info.pop("fx_events", []))
    if not events:
        return
    for listener in _listeners:
        await listener(events)
