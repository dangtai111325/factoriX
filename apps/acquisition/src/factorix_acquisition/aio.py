"""Asyncio helpers."""

from __future__ import annotations

import asyncio
from typing import Awaitable, TypeVar

T = TypeVar("T")


async def bounded(awaitable: Awaitable[T], timeout: float | None) -> T:
    """Await with a deadline; raises ``TimeoutError`` (= ``asyncio.TimeoutError``).

    Uses ``asyncio.timeout`` rather than ``asyncio.wait_for``: ``wait_for`` can
    swallow a cancellation that arrives as the inner await completes, leaving a
    stopped acquisition task running.
    """
    async with asyncio.timeout(timeout):
        return await awaitable
