"""R2-E C1: FreshnessService (interval resolution, evidence, delivery stall verdict for R2-02)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from factorix.application.live.freshness_service import FreshnessService, PipelineEvidence, resolve_interval_ms

NOW = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
CONN = "00000000-0000-0000-0000-0000000000c1"


def _evidence(*, delivered_age_s: float, source_ok_age_s: float, interval_ms: int = 1000) -> PipelineEvidence:
    ev = PipelineEvidence()
    ev.set_mapping([{"signal_id": uuid4(), "connection_id": CONN, "interval_ms": interval_ms}], now=NOW)
    ev.set_source([{"id": CONN, "last_success_at": NOW - timedelta(seconds=source_ok_age_s), "health": "HEALTHY"}],
                  reported_at=NOW - timedelta(seconds=1))
    ev.note_delivery(None, NOW - timedelta(seconds=delivered_age_s), connection_id=CONN)
    return ev


def test_interval_resolution_order() -> None:
    assert resolve_interval_ms(5000, 30_000) == 5000
    assert resolve_interval_ms(None, 30_000) == 30_000
    assert resolve_interval_ms(0, None) is None
    sid = uuid4()
    ev = PipelineEvidence()
    ev.note_signal(sid, CONN, 20_000)
    assert FreshnessService(ev).stale_after_ms(sid) == 40_000  # API mapping fallback
    assert FreshnessService(ev, use_evidence=False).stale_after_ms(sid) == 12_000  # no evidence in this process


def test_delivery_stall_is_reported_per_connection() -> None:
    """R2-02: acquisition reads the source (2 s) but Center's newest value is 30 s old -> delayed."""
    assert FreshnessService(_evidence(delivered_age_s=30, source_ok_age_s=2)).delayed_connections(NOW) == {CONN: 30_000}


def test_silent_source_or_fresh_data_is_not_a_stall() -> None:
    assert FreshnessService(_evidence(delivered_age_s=3, source_ok_age_s=2)).delayed_connections(NOW) == {}
    # acquisition itself has no recent read: the source is silent, not the pipeline late
    assert FreshnessService(_evidence(delivered_age_s=30, source_ok_age_s=30)).delayed_connections(NOW) == {}
    # a 30 s poll is not late at 30 s (threshold 60 s from the job interval)
    assert FreshnessService(_evidence(delivered_age_s=30, source_ok_age_s=2, interval_ms=30_000)).delayed_connections(NOW) == {}
