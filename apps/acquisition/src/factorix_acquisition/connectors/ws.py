"""WebSocket subscriber (protocol key ``websocket``). This client never sends data frames.

A background task keeps one connection open and reconnects with exponential backoff
(1 s -> 30 s). Every text frame that is valid JSON becomes the latest frame, stamped
with its arrival time. Consumers wait for a frame newer than the one they used.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidHandshake, InvalidStatus, InvalidURI, WebSocketException

from factorix.domain.network import AllowedEndpoint, assert_url
from factorix_acquisition.aio import bounded
from factorix_acquisition.connectors.errors import ConnectorError
from factorix_acquisition.timeutil import from_epoch

logger = logging.getLogger(__name__)

MAX_FRAME_BYTES = 4 * 1024 * 1024


class Frame:
    __slots__ = ("seq", "document", "received_time", "size", "raw")

    def __init__(self, seq: int, document: Any, received_time: str, size: int, raw: str = "") -> None:
        self.raw = raw
        self.seq = seq
        self.document = document
        self.received_time = received_time
        self.size = size


def translate(exc: BaseException, url: str) -> ConnectorError:
    if isinstance(exc, ConnectorError):
        return exc
    if isinstance(exc, InvalidStatus):
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in {401, 403}:
            return ConnectorError("AUTH", f"WebSocket server rejected the handshake (HTTP {status}).")
        if status == 429:
            return ConnectorError("RATE_LIMITED", "WebSocket server rate limited the handshake (HTTP 429).")
        return ConnectorError("PROTOCOL", f"WebSocket handshake failed (HTTP {status}).")
    if isinstance(exc, InvalidURI):
        return ConnectorError("CONFIG", "WebSocket URL is not valid.")
    if isinstance(exc, InvalidHandshake):
        return ConnectorError("PROTOCOL", "WebSocket handshake failed.")
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return ConnectorError("TIMEOUT", f"WebSocket {url} did not open in time.")
    if isinstance(exc, OSError):
        return ConnectorError("NETWORK", f"Cannot connect to WebSocket {url}.")
    if isinstance(exc, WebSocketException):
        return ConnectorError("NETWORK", f"WebSocket connection to {url} closed.")
    return ConnectorError("PROTOCOL", f"WebSocket failed ({type(exc).__name__}).")


class WebSocketConnector:
    can_write = False

    def __init__(
        self,
        url: str,
        allowlist: list[AllowedEndpoint],
        *,
        headers: dict[str, str] | None = None,
        timeout_s: float = 10.0,
        max_backoff_s: float = 30.0,
    ) -> None:
        if not url.lower().startswith(("ws://", "wss://")):
            raise ConnectorError("CONFIG", "WebSocket URL must start with ws:// or wss://.")
        assert_url(url, allowlist)
        self.url = url
        self.headers = dict(headers or {})
        self.timeout_s = timeout_s
        self.max_backoff_s = max_backoff_s
        self.state = "DOWN"
        self.last_error_code: str | None = None
        self.last_error: str | None = None
        self.last_message_at: str | None = None
        self.frames = 0
        self.decode_errors = 0
        self.latest: Frame | None = None
        self._new_frame = asyncio.Condition()
        self._task: asyncio.Task[None] | None = None
        self._first_attempt = asyncio.Event()

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name=f"ws:{self.url}")

    async def wait_connected(self, timeout_s: float) -> None:
        deadline = time.monotonic() + timeout_s
        while self.state != "UP":
            remaining = deadline - time.monotonic()
            if self._first_attempt.is_set() and self.state != "UP" and self.last_error_code:
                raise ConnectorError(self.last_error_code, self.last_error or "WebSocket connection failed.")
            if remaining <= 0:
                raise ConnectorError("TIMEOUT", f"WebSocket {self.url} did not open in time.")
            await asyncio.sleep(min(0.1, remaining))

    async def next_frame(self, after_seq: int, timeout_s: float | None) -> Frame | None:
        async with self._new_frame:
            if self.latest is not None and self.latest.seq > after_seq:
                return self.latest
            try:
                await bounded(
                    self._new_frame.wait_for(lambda: self.latest is not None and self.latest.seq > after_seq),
                    timeout=timeout_s,
                )
            except asyncio.TimeoutError:
                return None
            return self.latest

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with connect(
                    self.url,
                    additional_headers=self.headers or None,
                    open_timeout=self.timeout_s,
                    max_size=MAX_FRAME_BYTES,
                    ping_interval=20,
                    ping_timeout=20,
                    proxy=None,
                ) as socket:
                    self.state = "UP"
                    self.last_error_code = None
                    self.last_error = None
                    self._first_attempt.set()
                    backoff = 1.0
                    async for message in socket:
                        await self._on_message(message)
                raise ConnectorError("NETWORK", f"WebSocket {self.url} was closed by the server.")
            except asyncio.CancelledError:
                self.state = "DOWN"
                raise
            except Exception as exc:  # noqa: BLE001 - every failure is translated and retried
                error = translate(exc, self.url)
                self.state = "AUTH_FAILED" if error.code == "AUTH" else "DOWN"
                self.last_error_code = error.code
                self.last_error = str(error)
                self._first_attempt.set()
                logger.warning("WebSocket %s: %s; reconnecting in %.0f s", self.url, error, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self.max_backoff_s)

    async def _on_message(self, message: str | bytes) -> None:
        arrival = from_epoch(time.time())
        try:
            text = message.decode("utf-8") if isinstance(message, bytes) else message
            document = json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.decode_errors += 1
            if self.decode_errors == 1 or self.decode_errors % 1000 == 0:
                logger.warning("WebSocket %s frame is not UTF-8 JSON (%d so far)", self.url, self.decode_errors)
            return
        self.frames += 1
        self.last_message_at = arrival
        async with self._new_frame:
            self.latest = Frame(self.frames, document, arrival, len(message), text)
            self._new_frame.notify_all()

    async def close(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.state = "DOWN"


async def capture(connector: WebSocketConnector, seconds: float, max_messages: int) -> list[Frame]:
    """Collect up to ``max_messages`` distinct frames within ``seconds``."""
    await connector.start()
    await connector.wait_connected(connector.timeout_s)
    frames: list[Frame] = []
    last = connector.latest.seq if connector.latest else 0
    deadline = time.monotonic() + seconds
    while len(frames) < max_messages:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        frame = await connector.next_frame(last, remaining)
        if frame is None:
            break
        frames.append(frame)
        last = frame.seq
    return frames
