"""Signal quality, origin and freshness. Pure domain — no framework imports."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import StrEnum


class Quality(StrEnum):
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


class Freshness(StrEnum):
    FRESH = "FRESH"
    STALE = "STALE"
    UNKNOWN = "UNKNOWN"


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
) -> Freshness:
    if quality == Quality.BAD:
        return Freshness.UNKNOWN
    reference = event_time or received_time
    if reference is None:
        return Freshness.UNKNOWN
    if reference.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    interval = timedelta(milliseconds=expected_interval_ms or 5000)
    # Two missed intervals marks the serving projection stale without rewriting history.
    if now - reference > interval * 2:
        return Freshness.STALE
    return Freshness.FRESH


def ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return value.astimezone(timezone.utc)
