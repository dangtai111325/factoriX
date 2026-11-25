"""Signal quality, origin and freshness. Pure domain — no framework imports."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum


class Quality(StrEnum):
    """The one quality vocabulary: source quality (GOOD / UNCERTAIN / BAD) plus the STALE serving
    projection. ``domain.signal_state.SourceQuality`` is this enum (R2-E C1)."""

    GOOD = "GOOD"
    UNCERTAIN = "UNCERTAIN"
    BAD = "BAD"
    STALE = "STALE"


class Origin(StrEnum):
    LIVE = "LIVE"
    REPLAYED = "REPLAYED"
    MANUAL = "MANUAL"
    TEST = "TEST"
    DERIVED = "DERIVED"
    CALCULATED = "CALCULATED"


class Freshness(StrEnum):
    """The one freshness vocabulary (R2-E C1 / CT-11). ``domain.signal_state.Freshness`` is this enum."""

    FRESH = "FRESH"
    DELAYED = "DELAYED"
    STALE = "STALE"
    UNKNOWN = "UNKNOWN"
    NO_DATA = "NO_DATA"


def combine_quality(qualities: list[Quality]) -> Quality:
    """Worst input quality wins. STALE is a serving projection, not stored as GOOD."""
    if not qualities:
        return Quality.BAD
    rank = {Quality.GOOD: 0, Quality.UNCERTAIN: 1, Quality.STALE: 2, Quality.BAD: 3}
    return max(qualities, key=lambda item: rank[item])


def freshness_status(
    *,
    event_time: datetime | None,
    received_time: datetime | None,
    expected_interval_ms: int | None,
    now: datetime,
    quality: Quality,
    source_ok_at: datetime | None = None,
    source_reported_at: datetime | None = None,
    delivered_at: datetime | None = None,
) -> Freshness:
    """Freshness of a value with the canonical rule of ``domain.signal_state`` (threshold
    ``max(2 x interval, 12 s)``, DELAYED when the pipeline evidence says the source is still read).
    CT-11: this used a private 5 s fallback without the 12 s floor and had no DELAYED. Kept for
    compatibility; live surfaces use ``FreshnessService`` (which also resolves the interval)."""
    if quality == Quality.BAD:
        return Freshness.UNKNOWN
    reference = event_time or received_time
    if reference is None:
        return Freshness.UNKNOWN
    if reference.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    from factorix.domain.signal_state import canonical_stale_after_ms, classify_freshness

    verdict = classify_freshness(
        last_acquired_at=reference,
        now=now,
        stale_after_ms=canonical_stale_after_ms(expected_interval_ms),
        source_ok_at=source_ok_at,
        source_reported_at=source_reported_at,
        delivered_at=delivered_at,
    )
    return Freshness(verdict.freshness)


def ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return value.astimezone(timezone.utc)
