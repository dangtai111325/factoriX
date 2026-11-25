"""Pure domain evaluation for canonical signal quality, freshness, and effective status.

No framework, database, or network imports.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from factorix.domain.quality import Freshness, Quality


# One quality and one freshness vocabulary (R2-E C1 / CT-11): both enums live in ``domain.quality``.
SourceQuality = Quality


class EffectiveStatus(StrEnum):
    GOOD = "GOOD"
    UNCERTAIN = "UNCERTAIN"
    BAD = "BAD"
    STALE = "STALE"
    NO_DATA = "NO_DATA"
    DISABLED = "DISABLED"
    PAUSED = "PAUSED"


class ReasonCode(StrEnum):
    OK = "OK"
    DISABLED = "DISABLED"
    NO_OBSERVATIONS = "NO_OBSERVATIONS"
    RAW_SOURCE_BAD = "RAW_SOURCE_BAD"
    RAW_SOURCE_UNCERTAIN = "RAW_SOURCE_UNCERTAIN"
    NO_FRESH_ACQUISITION = "NO_FRESH_ACQUISITION"
    UNVERIFIED_AFTER_RESTART = "UNVERIFIED_AFTER_RESTART"
    CONNECTION_OFFLINE = "CONNECTION_OFFLINE"
    CONNECTION_PAUSED = "CONNECTION_PAUSED"
    NULL_VALUE = "NULL_VALUE"
    FIELD_MISSING = "FIELD_MISSING"
    SOURCE_CLOCK_SKEW = "SOURCE_CLOCK_SKEW"
    DELIVERY_DELAYED = "DELIVERY_DELAYED"
    DELIVERY_STALLED = "DELIVERY_STALLED"


@dataclass(frozen=True)
class SignalEvaluationResult:
    source_quality: str
    freshness: str
    effective_status: str
    reason_code: str
    evaluated_at: str
    stale_after_ms: int
    last_good: dict[str, Any] | None
    delivery_lag_ms: int | None = None


# Acquisition reports source evidence through its PG heartbeat every 5 s; Center reads it every 5 s.
SOURCE_EVIDENCE_SLACK_MS = 15_000
DELAY_CAP_FACTOR = 10
DELAY_CAP_MIN_MS = 300_000


@dataclass(frozen=True)
class FreshnessVerdict:
    freshness: str  # FRESH | DELAYED | STALE
    age_ms: int
    delivery_lag_ms: int | None
    reason_code: str | None  # None when FRESH


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def classify_freshness(
    *,
    last_acquired_at: datetime | None,
    now: datetime,
    stale_after_ms: int,
    source_ok_at: datetime | None = None,
    source_reported_at: datetime | None = None,
    delivered_at: datetime | None = None,
) -> FreshnessVerdict:
    """Separate a silent source (STALE) from a value that is merely late in the pipeline (DELAYED).

    ``last_acquired_at``   acquisition time of the newest value Center holds for the signal.
    ``source_ok_at``       acquisition's own evidence (PG heartbeat, not the broker) of its last
                           successful read of the signal's connection.
    ``source_reported_at`` when that evidence was reported (acquisition heartbeat time).
    ``delivered_at``       newest acquisition time Center has received from the same connection.

    FRESH   age <= stale_after.
    STALE   the pipeline already delivered newer data of the same connection beyond the threshold
            but none for this signal (this source/topic is silent), or acquisition has no recent
            successful read of the connection, or there is no source evidence at all.
    DELAYED acquisition keeps reading the connection while Center's newest value is older than the
            threshold: the value exists at the source and is in transit. Capped at
            max(10 x stale_after, 300 s), after which it is STALE (DELIVERY_STALLED).
    """
    eval_now = _as_utc(now) or datetime.now(timezone.utc)
    acquired = _as_utc(last_acquired_at)
    if acquired is None:
        return FreshnessVerdict(str(Freshness.STALE), 0, None, str(ReasonCode.NO_FRESH_ACQUISITION))
    age_ms = int((eval_now - acquired).total_seconds() * 1000)
    if age_ms <= stale_after_ms:
        return FreshnessVerdict(str(Freshness.FRESH), max(0, age_ms), None, None)
    stale = FreshnessVerdict(str(Freshness.STALE), age_ms, None, str(ReasonCode.NO_FRESH_ACQUISITION))
    delivered = _as_utc(delivered_at)
    if delivered is not None and (delivered - acquired).total_seconds() * 1000 > stale_after_ms:
        return stale  # newer data of the same connection arrives, this signal's does not
    source_ok = _as_utc(source_ok_at)
    if source_ok is None:
        return stale
    reported = _as_utc(source_reported_at) or source_ok
    if (eval_now - reported).total_seconds() * 1000 > stale_after_ms + SOURCE_EVIDENCE_SLACK_MS:
        return stale  # no current evidence from acquisition
    if (reported - source_ok).total_seconds() * 1000 > stale_after_ms:
        return stale  # acquisition itself has no recent successful read: source silent / down
    if age_ms > max(DELAY_CAP_FACTOR * stale_after_ms, DELAY_CAP_MIN_MS):
        return FreshnessVerdict(str(Freshness.STALE), age_ms, age_ms, str(ReasonCode.DELIVERY_STALLED))
    return FreshnessVerdict(str(Freshness.DELAYED), age_ms, age_ms, str(ReasonCode.DELIVERY_DELAYED))


OFFLINE_CONNECTION_HEALTH = frozenset({"DEGRADED", "OFFLINE", "DOWN", "DISCONNECTED"})


def stale_reason_code(verdict_reason: str | None, connection_health: str | None = None) -> str:
    """Reason of a STALE verdict: a silent source of a connection reported DEGRADED/OFFLINE is
    ``CONNECTION_OFFLINE`` (CT-12); otherwise the time verdict's own reason."""
    reason = str(verdict_reason or ReasonCode.NO_FRESH_ACQUISITION)
    if reason == ReasonCode.NO_FRESH_ACQUISITION and str(connection_health or "").upper() in OFFLINE_CONNECTION_HEALTH:
        return str(ReasonCode.CONNECTION_OFFLINE)
    return reason


def canonical_stale_after_ms(
    expected_interval_ms: int | None = None,
    *,
    stale_multiplier: float = 2.0,
    min_stale_ms: int = 12000,
) -> int:
    """Canonical staleness threshold calculation shared across live state and history reconstruction."""
    interval_ms = int(expected_interval_ms or 1000)
    return max(int(interval_ms * stale_multiplier), min_stale_ms)


def evaluate_signal_state(
    *,
    has_observation: bool,
    raw_quality: str | None,
    raw_value: Any,
    event_time: datetime | None,
    last_acquired_at: datetime | None = None,
    expected_interval_ms: int | None = None,
    stale_multiplier: float = 2.0,
    min_stale_ms: int = 12000,
    now: datetime | None = None,
    binding_enabled: bool = True,
    resource_archived: bool = False,
    connection_health: str | None = None,
    last_good_value: Any = None,
    last_good_time: datetime | None = None,
    raw_reason_code: str | None = None,
    acquisition_mode: str = "POLL",
    null_allowed: bool = False,
    connection_paused: bool = False,
    restored_unverified: bool = False,
    source_ok_at: datetime | None = None,
    source_reported_at: datetime | None = None,
    delivered_at: datetime | None = None,
) -> SignalEvaluationResult:
    """Canonical single-source-of-truth evaluator for effective signal status across FactoriX."""
    eval_now = now or datetime.now(timezone.utc)
    if eval_now.tzinfo is None:
        eval_now = eval_now.replace(tzinfo=timezone.utc)

    stale_after_ms = canonical_stale_after_ms(
        expected_interval_ms,
        stale_multiplier=stale_multiplier,
        min_stale_ms=min_stale_ms,
    )

    last_good_payload = None
    if last_good_value is not None:
        good_iso = (
            last_good_time.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            if isinstance(last_good_time, datetime)
            else (str(last_good_time) if last_good_time else None)
        )
        last_good_payload = {"value": last_good_value, "source_time": good_iso}

    eval_now_iso = eval_now.isoformat().replace("+00:00", "Z")

    # 1. Disabled or archived
    if not binding_enabled or resource_archived:
        return SignalEvaluationResult(
            source_quality=str(raw_quality or SourceQuality.BAD),
            freshness=str(Freshness.UNKNOWN),
            effective_status=str(EffectiveStatus.DISABLED),
            reason_code=str(ReasonCode.DISABLED),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
        )

    # 1b. The source connection is paused by the operator: no acquisition is expected, so the
    # signal is PAUSED, not STALE (R3-CN-02). The last value is kept and still reported.
    if connection_paused:
        return SignalEvaluationResult(
            source_quality=str(raw_quality or SourceQuality.BAD),
            freshness=str(Freshness.UNKNOWN),
            effective_status=str(EffectiveStatus.PAUSED),
            reason_code=str(ReasonCode.CONNECTION_PAUSED),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
        )

    # 2. No observation yet
    if not has_observation:
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.BAD),
            freshness=str(Freshness.NO_DATA),
            effective_status=str(EffectiveStatus.NO_DATA),
            reason_code=str(ReasonCode.NO_OBSERVATIONS),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=None,
        )

    norm_quality = str(raw_quality or SourceQuality.BAD).upper()

    # Determine freshness time reference. Age beyond the threshold is STALE only when the source is
    # silent; when acquisition still reads the source it is DELAYED (in transit), see classify_freshness.
    ref_time = last_acquired_at or event_time
    is_stale = False
    verdict: FreshnessVerdict | None = None
    if ref_time is not None:
        verdict = classify_freshness(
            last_acquired_at=ref_time,
            now=eval_now,
            stale_after_ms=stale_after_ms,
            source_ok_at=source_ok_at,
            source_reported_at=source_reported_at,
            delivered_at=delivered_at,
        )
        is_stale = verdict.freshness == Freshness.STALE
    is_delayed = verdict is not None and verdict.freshness == Freshness.DELAYED
    lag_ms = verdict.delivery_lag_ms if verdict is not None else None
    age_freshness = str(Freshness.STALE if is_stale else (Freshness.DELAYED if is_delayed else Freshness.FRESH))

    # 3. Explicit BAD from source or null value on scalar measurement.
    # A field declared nullable (address.nullable) reports a successful read of null as GOOD.
    if raw_value is None and norm_quality == "GOOD" and not null_allowed:
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.BAD),
            freshness=age_freshness,
            effective_status=str(EffectiveStatus.BAD),
            reason_code=str(ReasonCode.NULL_VALUE),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
            delivery_lag_ms=lag_ms,
        )

    if norm_quality == "BAD":
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.BAD),
            freshness=age_freshness,
            effective_status=str(EffectiveStatus.BAD),
            reason_code=str(raw_reason_code or ReasonCode.RAW_SOURCE_BAD),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
            delivery_lag_ms=lag_ms,
        )

    # 4. Explicit UNCERTAIN from source
    if norm_quality == "UNCERTAIN":
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.UNCERTAIN),
            freshness=age_freshness,
            effective_status=str(EffectiveStatus.UNCERTAIN),
            reason_code=str(raw_reason_code or ReasonCode.RAW_SOURCE_UNCERTAIN),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
            delivery_lag_ms=lag_ms,
        )

    # 5. Stale acquisition (no fresh sample or keepalive within policy). A stale value of a connection
    # whose health is DEGRADED/OFFLINE is explained as CONNECTION_OFFLINE (CT-12); status stays STALE.
    if is_stale:
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.GOOD),
            freshness=str(Freshness.STALE),
            effective_status=str(EffectiveStatus.STALE),
            reason_code=stale_reason_code(verdict.reason_code if verdict else None, connection_health),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
            delivery_lag_ms=lag_ms,
        )

    # 5b. Conservatively recovered crash/restart checkpoint awaiting first verified acquisition
    if restored_unverified:
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.UNCERTAIN),
            freshness=str(Freshness.UNKNOWN),
            effective_status=str(EffectiveStatus.UNCERTAIN),
            reason_code=str(ReasonCode.UNVERIFIED_AFTER_RESTART),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
        )

    # 5c. Value current at the source but late in the pipeline: GOOD, value kept, flagged DELAYED.
    if is_delayed:
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.GOOD),
            freshness=str(Freshness.DELAYED),
            effective_status=str(EffectiveStatus.GOOD),
            reason_code=str(ReasonCode.DELIVERY_DELAYED),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
            delivery_lag_ms=lag_ms,
        )

    # 6. Valid and Fresh
    return SignalEvaluationResult(
        source_quality=str(SourceQuality.GOOD),
        freshness=str(Freshness.FRESH),
        effective_status=str(EffectiveStatus.GOOD),
        reason_code=str(raw_reason_code or ReasonCode.OK),
        evaluated_at=eval_now_iso,
        stale_after_ms=stale_after_ms,
        last_good=last_good_payload,
    )
