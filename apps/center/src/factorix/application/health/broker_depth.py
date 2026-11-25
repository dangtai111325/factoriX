"""RabbitMQ queue depth / DLQ for the API's health surfaces (CT-20, B-11 / OP-13).

The API process probes the broker read-only (``platform.broker.probe_broker_health``: passive queue
declares + management HTTP GETs) from its background health loop every ``PROBE_EVERY_S`` and keeps the
last answer here; ``/health/ready?verbose=1`` and ``/api/v1/edges`` show it (additive keys). A probe never
declares or changes topology (the ingestion worker owns it, R2-E C9) and never blocks a request.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from factorix.platform.broker import BrokerConfig, BrokerHealthSnapshot, probe_broker_health

logger = logging.getLogger(__name__)

PROBE_EVERY_S = 30.0
PROBE_TIMEOUT_S = 12.0
SCHEMA_VERSION = 1

_latest: dict[str, Any] | None = None
_latest_mono: float = 0.0


def snapshot_to_dict(snap: BrokerHealthSnapshot) -> dict[str, Any]:
    """Stable, secret-free view of one probe (``None`` = not measured, never a guessed 0)."""
    return {
        "schema_version": SCHEMA_VERSION,
        "broker_ok": bool(snap.broker_ok),
        "live_q_depth": snap.live_ready_count,
        "ingest_q_depth": snap.legacy_ready_count,
        "live_q_unacked": snap.live_unacked_count,
        "ingest_q_unacked": snap.legacy_unacked_count,
        "dlq_depth": snap.dlq_count,
        "oldest_age_s": snap.oldest_queued_age_s,
        "checked_at": snap.checked_at.isoformat().replace("+00:00", "Z") if snap.checked_at else None,
        "error": snap.error,
        "warnings": list(snap.warnings or [])[:5],
    }


def latest() -> dict[str, Any] | None:
    """The last probe result with its age, or ``None`` before the first probe / without a broker."""
    if _latest is None:
        return None
    return {**_latest, "age_s": round(max(0.0, time.monotonic() - _latest_mono), 1)}


def due(now_mono: float | None = None) -> bool:
    now_mono = time.monotonic() if now_mono is None else now_mono
    return _latest is None or (now_mono - _latest_mono) >= PROBE_EVERY_S


async def refresh(settings: Any, *, probe: Any = probe_broker_health) -> dict[str, Any] | None:
    """Probe now when a broker is configured (acquisition appliance); keeps the previous value on failure."""
    global _latest, _latest_mono
    if not getattr(settings, "rabbitmq_url", ""):
        return None
    try:
        cfg = BrokerConfig.from_settings(settings)
        snap = await asyncio.wait_for(probe(cfg), timeout=PROBE_TIMEOUT_S)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - observability must never break the health loop
        logger.debug("Broker depth probe failed: %s", type(exc).__name__)
        return latest()
    _latest = snapshot_to_dict(snap)
    _latest_mono = time.monotonic()
    return latest()


def reset_for_tests() -> None:
    global _latest, _latest_mono
    _latest = None
    _latest_mono = 0.0
