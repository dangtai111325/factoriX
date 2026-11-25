"""Ingestion pipeline stage 'notify': PG NOTIFY channels and payload chunking (v1 events, v2 latest_ids). Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
import json
from typing import Any
from uuid import UUID

import asyncpg

from factorix.modules.common import iso_ms
from factorix_core.contracts.notify import Channel, LatestIdsV2


# Literal names kept (the channel registry test scans for them); they are the registry values.
NOTIFY_CHANNEL_STREAM = "factorix_stream_events"
NOTIFY_CHANNEL_HEALTH = "factorix_health_changed"
assert NOTIFY_CHANNEL_STREAM == Channel.STREAM_EVENTS and NOTIFY_CHANNEL_HEALTH == Channel.HEALTH_CHANGED
# Same {"events":[...]} wire format; pack as many events as fit one PG NOTIFY (< 8000 bytes).
NOTIFY_CHUNK_MAX_EVENTS = 64
NOTIFY_CHUNK_MAX_BYTES = 7800


def _latest_ids_payloads(
    tenant_id: UUID,
    signal_ids: Sequence[str],
    connection_ids: Sequence[str],
    max_acquired_at: datetime | None,
) -> list[str]:
    """Pack committed signal ids into v2 ``latest_ids`` NOTIFY payloads, each < NOTIFY_CHUNK_MAX_BYTES
    (typed contract ``factorix_core.contracts.notify.LatestIdsV2``, R2-E C6)."""
    if not signal_ids:
        return []
    return LatestIdsV2(
        tenant_id=str(tenant_id),
        signal_ids=tuple(signal_ids),
        connection_ids=tuple(connection_ids or ()),
        max_acquired_at=iso_ms(max_acquired_at) if max_acquired_at is not None else None,
    ).to_payloads(NOTIFY_CHUNK_MAX_BYTES)


async def _emit_chunked_notify(conn: asyncpg.Connection, channel: str, events: Sequence[dict[str, Any]]) -> None:
    if not events:
        return
    prefix, suffix = '{"events":[', ']}'
    wrapper_size = len(prefix) + len(suffix)
    payloads: list[str] = []
    chunk: list[str] = []
    chunk_size = wrapper_size
    for ev in events:
        encoded = json.dumps(ev, separators=(",", ":"), default=str)
        # json.dumps escapes non-ASCII characters, so character and byte counts agree.
        if wrapper_size + len(encoded) > 7900 and isinstance(ev.get("payload"), dict):
            # Large values remain available through the read API.
            compact = {**ev, "payload": {k: v for k, v in ev["payload"].items() if k != "value"}}
            encoded = json.dumps(compact, separators=(",", ":"), default=str)
        if chunk and (
            len(chunk) >= NOTIFY_CHUNK_MAX_EVENTS or chunk_size + 1 + len(encoded) > NOTIFY_CHUNK_MAX_BYTES
        ):
            payloads.append(prefix + ",".join(chunk) + suffix)
            chunk.clear()
            chunk_size = wrapper_size
        chunk_size += bool(chunk) + len(encoded)
        chunk.append(encoded)
    payloads.append(prefix + ",".join(chunk) + suffix)
    await conn.execute(
        "SELECT pg_notify($1, payload) FROM unnest($2::text[]) WITH ORDINALITY AS chunks(payload, position) ORDER BY position",
        channel,
        payloads,
    )
