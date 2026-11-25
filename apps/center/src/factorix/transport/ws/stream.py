"""WebSocket ``/stream``: subscribe signals/models/health, initial snapshot, ``latest`` frames. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import UUID

from fastapi import WebSocket, WebSocketDisconnect

from factorix.modules import telemetry
from factorix.modules.common import as_uuid, fetch_all, iso_ms, utcnow
from factorix.transport.hub import HEARTBEAT_INTERVAL_S, Channel, origin_allowed
from factorix.modules.identity import SESSION_COOKIE, principal_from_token
from factorix.platform.db import session_factory
from factorix.platform.errors import AppError

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _settings, hub

router = RouteTable()


STREAM_MAX_SIGNALS = 5000
STREAM_MAX_GROUPS = 500


def _stream_ids(values: Any, limit: int) -> list[UUID]:
    if not isinstance(values, list):
        return []
    ids: list[UUID] = []
    for item in values[:limit]:
        try:
            ids.append(UUID(str(item)))
        except ValueError:
            continue
    return ids


def _latest_message(row: dict[str, Any]) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "type": "latest",
        "signal_id": str(row["signal_id"]),
        "value": row.get("value"),
        "quality": row.get("raw_quality"),
        "effective_status": row.get("effective_status"),
        "reason_code": row.get("reason_code"),
        "received_time": row.get("received_time"),
        "source_time": row.get("source_time"),
    }
    for key in (
        "evaluated_at",
        "stale_after_ms",
        "freshness",
        "delivery_lag_ms",
        "connection_id",
        "data_epoch",
        "last_acquired_at",
        "last_value_changed_at",
        "source_health",
        "connection_health",
        "broker_health",
        "storage_health",
    ):
        if row.get(key) is not None:
            msg[key] = row[key]
    return msg


async def _stream_subscribe_signals(channel: Channel, tenant_id: UUID, message: dict[str, Any]) -> tuple[int, list[str]]:
    requested = _stream_ids(message.get("signal_ids"), STREAM_MAX_SIGNALS)
    valid: list[UUID] = []
    async with session_factory()() as session:
        if requested:
            rows = await fetch_all(
                session,
                "SELECT id FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
                {"tenant_id": tenant_id, "ids": requested},
            )
            valid = [as_uuid(row["id"]) for row in rows]
        if message.get("mode") != "add":
            channel.signals.clear()
        channel.signals.update(str(item) for item in valid)
        # Initial snapshot so the page shows current values immediately, then pushes follow.
        for start in range(0, len(valid), 200):
            for row in await telemetry.latest_states(session, tenant_id, valid[start : start + 200]):
                channel.offer(_latest_message(row))
    accepted = {str(item) for item in valid}
    rejected = [str(item) for item in message.get("signal_ids") or [] if str(item) not in accepted][:200]
    return len(channel.signals), rejected


async def _stream_subscribe_models(channel: Channel, tenant_id: UUID, message: dict[str, Any]) -> int:
    requested = _stream_ids(message.get("group_ids"), STREAM_MAX_GROUPS)
    valid: list[str] = []
    if requested:
        async with session_factory()() as session:
            rows = await fetch_all(
                session,
                "SELECT id FROM output_groups WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
                {"tenant_id": tenant_id, "ids": requested},
            )
            valid = [str(row["id"]) for row in rows]
    if message.get("mode") != "add":
        channel.groups.clear()
    channel.groups.update(valid)
    return len(channel.groups)


@router.websocket("/stream")
async def stream(socket: WebSocket) -> None:
    cfg = _settings()
    allowed = [cfg.web_origin] if cfg.web_origin else []
    if not origin_allowed(socket.headers.get("origin"), socket.headers.get("host"), allowed):
        await socket.close(code=4403)
        return
    await socket.accept()
    async with session_factory()() as session:
        try:
            principal = await principal_from_token(session, socket.cookies.get(SESSION_COOKIE))
        except AppError:
            await socket.close(code=4401)
            return
    tenant_id = as_uuid(principal["tenant_id"])
    async def _close_socket() -> None:
        await socket.close(code=1011)

    channel = Channel(socket.send_json, str(tenant_id), on_close=_close_socket)
    hub.register(channel)
    sender = asyncio.create_task(channel.run(), name="stream-sender")
    try:
        while not channel.closed:
            try:
                message = await socket.receive_json()
            except (ValueError, KeyError):
                channel.offer({"type": "error", "code": "BAD_MESSAGE", "message": "Messages must be JSON objects."})
                continue
            if not isinstance(message, dict):
                continue
            op = message.get("op")
            if op == "subscribe":
                count, rejected = await _stream_subscribe_signals(channel, tenant_id, message)
                channel.offer({"type": "subscribed", "count": count, "rejected": rejected, "heartbeat_s": HEARTBEAT_INTERVAL_S})
            elif op == "subscribe_models":
                count = await _stream_subscribe_models(channel, tenant_id, message)
                channel.offer({"type": "subscribed_models", "count": count})
            elif op == "subscribe_health":
                # Health events are delivered to every socket of the tenant; acknowledged for clients.
                channel.offer({"type": "subscribed_health"})
            elif op == "ping":
                channel.offer({"type": "pong", "server_time": iso_ms(utcnow())})
    except (WebSocketDisconnect, RuntimeError):
        # RuntimeError: the sender closed a broken socket while receive() was waiting.
        pass
    finally:
        hub.unregister(channel)
        sender.cancel()
        try:
            await sender
        except asyncio.CancelledError:
            pass
