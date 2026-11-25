"""Non-blocking push hub for the ``/stream`` WebSocket.

Committed events are dispatched to per-socket channels without awaiting any socket. Each channel
has its own sender task, so a slow browser never delays ingest or other browsers. Pending messages
are coalesced: only the newest ``latest`` per signal, the newest ``model_body`` per group and the
newest ``health`` per entity are kept; ``model_event`` messages are queued individually.

Event routing (events are queued with ``factorix.modules.common.queue_stream_event`` or directly
with ``factorix.platform.after_commit.queue``; ``kind`` and ``tenant_id`` are required):

* ``kind == "latest"``  -> sockets of the tenant subscribed to ``signal_id``.
* ``kind == "health"``  -> every socket of the tenant.
* any other kind with a ``group_id`` (``model_body``, ``model_event``, ...) -> sockets of the
  tenant subscribed to that group with ``{"op": "subscribe_models"}``.

The browser receives ``event["payload"]`` when present, otherwise the event without the routing
keys and with ``type = kind``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

Sender = Callable[[dict[str, Any]], Awaitable[None]]

DEFAULT_MAX_PENDING = 5000
SEND_TIMEOUT_S = 10.0
FLUSH_INTERVAL_S = 0.2
# Server heartbeat on every socket. A browser that sees no frame for 3 heartbeats treats push as
# not live and polls REST (liveStream.ts). Each tick also re-evaluates time-based freshness of the
# signals the socket watches and pushes only transitions (FRESH -> DELAYED -> STALE).
HEARTBEAT_INTERVAL_S = 5.0

Refresher = Callable[[dict[str, Any]], dict[str, Any]]
Observer = Callable[[dict[str, Any], dict[str, Any]], None]
Closer = Callable[[], Awaitable[None]]
_ROUTING_KEYS = {"kind", "tenant_id", "payload"}


def browser_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload")
    if isinstance(payload, dict):
        return payload
    message = {key: value for key, value in event.items() if key not in _ROUTING_KEYS}
    message["type"] = str(event.get("kind"))
    return message


def _group_id(event: dict[str, Any]) -> str | None:
    value = event.get("group_id")
    if value is None and isinstance(event.get("payload"), dict):
        value = event["payload"].get("group_id")
    return None if value is None else str(value)


def coalesce_key(message: dict[str, Any]) -> tuple[str, ...] | None:
    """Key under which a newer message replaces an older pending one; None means never coalesce."""
    kind = str(message.get("type") or "")
    if kind == "latest" and message.get("signal_id") is not None:
        return ("latest", str(message["signal_id"]))
    if kind == "model_body" and message.get("group_id") is not None:
        return ("model_body", str(message["group_id"]))
    if kind == "health" and message.get("id") is not None:
        return ("health", str(message.get("entity") or ""), str(message["id"]))
    if kind == "heartbeat":
        return ("heartbeat",)
    return None


class Channel:
    """One browser socket: subscriptions, a bounded coalescing buffer and a sender task."""

    def __init__(self, send: Sender, tenant_id: str, *, max_pending: int = DEFAULT_MAX_PENDING, on_close: Closer | None = None) -> None:
        self._send = send
        self._on_close = on_close
        self.tenant_id = tenant_id
        # Last ``latest`` message offered per signal: the basis of the periodic freshness sweep.
        self.last_latest: dict[str, dict[str, Any]] = {}
        self.heartbeat_seq = 0
        self.sent_frames = 0
        self.signals: set[str] = set()
        self.groups: set[str] = set()
        self.max_pending = max_pending
        self.dropped = 0
        self.closed = False
        self._buffer: OrderedDict[tuple[str, ...], dict[str, Any]] = OrderedDict()
        self._sequence = 0
        self._wake = asyncio.Event()

    @property
    def pending(self) -> int:
        return len(self._buffer)

    def offer(self, message: dict[str, Any]) -> None:
        """Queue a message without waiting. Coalesces by key; drops the oldest when full."""
        if self.closed:
            return
        if message.get("type") == "latest" and message.get("signal_id") is not None:
            self.last_latest[str(message["signal_id"])] = message
        key = coalesce_key(message)
        if key is None:
            self._sequence += 1
            key = ("seq", str(self._sequence))
        if key in self._buffer:
            self._buffer[key] = message
        else:
            if len(self._buffer) >= self.max_pending:
                self._buffer.popitem(last=False)
                self.dropped += 1
            self._buffer[key] = message
        self._wake.set()

    def drain(self) -> list[dict[str, Any]]:
        """Take every pending message in arrival order (used by the sender and by tests)."""
        items = list(self._buffer.values())
        self._buffer.clear()
        self._wake.clear()
        return items

    async def run(self) -> None:
        """Sender loop: waits for messages and sends them; a failed or stuck socket closes the channel."""
        try:
            while not self.closed:
                await self._wake.wait()
                # Let a burst accumulate, then send it as one frame: one WebSocket write per
                # flush instead of one per signal (per-message sends were ~20% of Center CPU).
                await asyncio.sleep(FLUSH_INTERVAL_S)
                messages = self.drain()
                if not messages:
                    continue
                frame = messages[0] if len(messages) == 1 else {"type": "batch", "messages": messages}
                await asyncio.wait_for(self._send(frame), timeout=SEND_TIMEOUT_S)
                self.sent_frames += 1
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - any send failure ends this socket only
            logger.info("Stream socket closed while sending: %s", type(exc).__name__)
            # Close the socket itself: otherwise the browser keeps an open but silent socket (zombie)
            # and believes it receives live data.
            if self._on_close is not None:
                try:
                    await asyncio.wait_for(self._on_close(), timeout=2.0)
                except Exception:  # noqa: BLE001 - already broken
                    pass
        finally:
            self.closed = True

    def close(self) -> None:
        self.closed = True
        self._buffer.clear()
        self._wake.set()


class Hub:
    def __init__(self) -> None:
        self.channels: set[Channel] = set()
        # refresher: re-evaluates time-based freshness of a ``latest`` message (live_state.refresh_live_message).
        # observer: records delivery evidence for every live event (PipelineEvidence.note_delivery).
        self.refresher: Refresher | None = None
        self.observer: Observer | None = None
        self.summary: Callable[[], dict[str, dict[str, Any]]] | None = None
        self.connection_of: Callable[[str], str | None] | None = None

    def register(self, channel: Channel) -> None:
        self.channels.add(channel)

    def unregister(self, channel: Channel) -> None:
        self.channels.discard(channel)
        channel.close()

    def dispatch(self, events: Iterable[dict[str, Any]]) -> None:
        """Route committed events to channels. Never awaits a socket."""
        for event in events:
            kind = event.get("kind")
            tenant = event.get("tenant_id")
            if not kind or tenant is None:
                logger.debug("Dropping stream event without kind/tenant_id")
                continue
            tenant = str(tenant)
            message = browser_payload(event)
            if kind == "latest":
                signal_id = event.get("signal_id") or message.get("signal_id")
                if signal_id is None:
                    continue
                signal_id = str(signal_id)
                if self.observer is not None:
                    try:
                        self.observer(event, message)
                    except Exception:  # noqa: BLE001 - evidence must never block delivery
                        logger.debug("Delivery evidence update failed", exc_info=True)
                if self.refresher is not None:
                    try:
                        message = self.refresher(message)
                    except Exception:  # noqa: BLE001
                        logger.debug("Freshness refresh failed", exc_info=True)
                targets = [ch for ch in self.channels if ch.tenant_id == tenant and signal_id in ch.signals]
            elif kind == "health":
                targets = [ch for ch in self.channels if ch.tenant_id == tenant]
            else:
                group_id = _group_id(event)
                if group_id is None:
                    continue
                targets = [ch for ch in self.channels if ch.tenant_id == tenant and group_id in ch.groups]
            for channel in targets:
                channel.offer(message)

    def sweep(self, channel: Channel) -> int:
        """Re-evaluate freshness of the signals ``channel`` watches; offer only status transitions."""
        if self.refresher is None:
            return 0
        sent = 0
        for signal_id in list(channel.last_latest):
            if signal_id not in channel.signals:
                channel.last_latest.pop(signal_id, None)
                continue
            previous = channel.last_latest[signal_id]
            try:
                current = self.refresher(previous)
            except Exception:  # noqa: BLE001
                continue
            before = (previous.get("effective_status"), previous.get("freshness"), previous.get("reason_code"))
            after = (current.get("effective_status"), current.get("freshness"), current.get("reason_code"))
            if before != after:
                channel.offer(current)
                sent += 1
        return sent

    def heartbeat_frame(self, channel: Channel, server_time: str) -> dict[str, Any]:
        channel.heartbeat_seq += 1
        frame: dict[str, Any] = {"type": "heartbeat", "seq": channel.heartbeat_seq, "server_time": server_time}
        if self.summary is not None and self.connection_of is not None:
            try:
                summary = self.summary()
                wanted = set()
                for sid in channel.signals:
                    cid = self.connection_of(sid)
                    if cid:
                        wanted.add(cid)
                frame["pipeline"] = {cid: summary[cid] for cid in wanted if cid in summary}
            except Exception:  # noqa: BLE001
                logger.debug("Heartbeat pipeline summary failed", exc_info=True)
        return frame

    def tick(self, server_time: str) -> None:
        for channel in list(self.channels):
            if channel.closed:
                continue
            self.sweep(channel)
            channel.offer(self.heartbeat_frame(channel, server_time))

    async def heartbeat_loop(self, clock: Callable[[], str], interval_s: float = HEARTBEAT_INTERVAL_S) -> None:
        while True:
            await asyncio.sleep(interval_s)
            try:
                self.tick(clock())
            except Exception:  # noqa: BLE001 - the heartbeat must keep running
                logger.warning("Stream heartbeat tick failed", exc_info=True)


def origin_allowed(origin: str | None, host: str | None, allowed_origins: Iterable[str]) -> bool:
    """Same-origin check for the cookie-authenticated WebSocket (blocks cross-site hijacking).

    Allowed: a configured web origin, or an Origin whose host:port equals the request Host header.
    Requests without an Origin header (non-browser clients) are allowed; they still need the
    session cookie.
    """
    if not origin:
        return True
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    normalized = f"{parsed.scheme}://{parsed.netloc}".lower()
    for item in allowed_origins:
        if item and normalized == item.rstrip("/").lower():
            return True
    if host and parsed.netloc.lower() == host.strip().lower():
        return True
    return False


def parse_pg_notify_events(channel: str, payload: str) -> list[dict[str, Any]]:
    """Decode asyncpg NOTIFY payloads from IngestionWorker or local Acquisition pg_control."""
    if not payload:
        return []
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []
    events = data.get("events")
    if isinstance(events, list):
        return [ev for ev in events if isinstance(ev, dict) and ev.get("kind") and ev.get("tenant_id")]
    if isinstance(data.get("event"), dict) and data.get("tenant_id"):
        kind = "health" if channel == "factorix_health_changed" or data["event"].get("type") == "health" else str(data["event"].get("type") or "health")
        return [{"kind": kind, "tenant_id": str(data["tenant_id"]), "payload": data["event"]}]
    return []
