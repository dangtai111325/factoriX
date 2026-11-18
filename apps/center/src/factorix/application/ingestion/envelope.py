"""Ingestion pipeline: in-flight delivery and prepared-observation records. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from factorix.domain.canonical import CanonicalObservation
from factorix.platform.broker import ConsumeOutcome


@dataclass(slots=True)
class _PreparedObs:
    obs: CanonicalObservation
    event_time: datetime
    received_time: datetime
    source_time: datetime | None
    norm_quality: str
    reason_code: str | None
    owned: dict[str, Any]
    ingested_at: datetime
    lane: str = "live"


@dataclass(slots=True)
class _PendingEnvelope:
    """One observation awaiting durable persistence (a v1 message, or one item of a v2 batch)."""

    raw_body: bytes
    message_id: str | None
    headers: Mapping[str, Any]
    redelivered: bool
    ingested_at: datetime
    future: asyncio.Future[ConsumeOutcome]
    payload: Mapping[str, Any] | None = None
    batch_tenant: UUID | None = None
    delivery_count: int = 0
    lane: str = "live"
