"""Asyncio helpers."""

from __future__ import annotations

import asyncio
from typing import Awaitable, TypeVar

T = TypeVar("T")


async def bounded(awaitable: Awaitable[T], timeout: float | None) -> T:
    """Await with a deadline; raises ``TimeoutError`` (= ``asyncio.TimeoutError``).

    Uses ``asyncio.timeout`` rather than ``asyncio.wait_for``: on Python 3.11
    ``wait_for`` can swallow a cancellation that arrives as the inner await
    completes, which would leave a stopped job running forever.
    """
    async with asyncio.timeout(timeout):
        return await awaitable
