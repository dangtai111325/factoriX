"""Ingestion pipeline: shared limits, lane names and small helpers. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from factorix_core.time import utcnow as _core_utcnow


logger = logging.getLogger("factorix.modules.ingestion_worker")

MAX_MESSAGE_BYTES = 262_144
# v2 batch envelopes carry up to MAX_OBS_PER_BATCH observations; the publisher caps them far lower.
MAX_BATCH_MESSAGE_BYTES = 4 * 1024 * 1024
MAX_BATCH_ITEMS = 5000
DEFAULT_INSTANCE_ID = "local-ingestion-1"
MAX_FORMULA_DEPTH = 4
# Replay (history) lane yields to pending/busy live work for at most this long per batch,
# so live latest-state is never stuck behind a replay batch, yet replay is never starved.
REPLAY_YIELD_MAX_S = 0.5
# CPU-bound loops over a batch yield to the event loop every N items.
YIELD_EVERY_ITEMS = 250
LANE_LIVE = "live"
LANE_LEGACY = "legacy"


def _json_val(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return value
    return value


_utcnow = _core_utcnow  # shared kernel ``factorix_core.time.utcnow`` (R2-E B7)


def _deterministic_calc_uid(formula_id: Any, revision: int, output_signal_id: Any, trigger_uid: str) -> str:
    digest = hashlib.sha256(f"{formula_id}|{int(revision)}|{output_signal_id}|{trigger_uid}".encode("utf-8")).hexdigest()[:48]
    return f"calc:{digest}"


class _WakeAll:
    """Fan-out wake handle for the per-lane batchers (kept as ``_wake_batcher`` for callers/tests)."""

    def __init__(self, *events: asyncio.Event) -> None:
        self._events = events

    def set(self) -> None:
        for event in self._events:
            event.set()

    def clear(self) -> None:
        for event in self._events:
            event.clear()

    def is_set(self) -> bool:
        return any(event.is_set() for event in self._events)


class _WorkerStoppingRetry(Exception):
    """Internal signal to abort retry loop cleanly on worker shutdown and NACK requeue."""
