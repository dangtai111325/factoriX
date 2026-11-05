"""Pure domain evaluation for canonical signal quality, freshness, and effective status.

No framework, database, or network imports.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any


class SourceQuality(StrEnum):
    GOOD = "GOOD"
    UNCERTAIN = "UNCERTAIN"
    BAD = "BAD"


class Freshness(StrEnum):
    FRESH = "FRESH"
    STALE = "STALE"
    UNKNOWN = "UNKNOWN"
    NO_DATA = "NO_DATA"


class EffectiveStatus(StrEnum):
    GOOD = "GOOD"
    UNCERTAIN = "UNCERTAIN"
    BAD = "BAD"
    STALE = "STALE"
    NO_DATA = "NO_DATA"
    DISABLED = "DISABLED"


class ReasonCode(StrEnum):
    OK = "OK"
    DISABLED = "DISABLED"
    NO_OBSERVATIONS = "NO_OBSERVATIONS"
    RAW_SOURCE_BAD = "RAW_SOURCE_BAD"
    RAW_SOURCE_UNCERTAIN = "RAW_SOURCE_UNCERTAIN"
    NO_FRESH_ACQUISITION = "NO_FRESH_ACQUISITION"
    CONNECTION_OFFLINE = "CONNECTION_OFFLINE"
    NULL_VALUE = "NULL_VALUE"
    FIELD_MISSING = "FIELD_MISSING"
    SOURCE_CLOCK_SKEW = "SOURCE_CLOCK_SKEW"


@dataclass(frozen=True)
class SignalEvaluationResult:
    source_quality: str
    freshness: str
    effective_status: str
    reason_code: str
    evaluated_at: str
    stale_after_ms: int
    last_good: dict[str, Any] | None


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
) -> SignalEvaluationResult:
    """Canonical single-source-of-truth evaluator for effective signal status across FactoriX."""
    eval_now = now or datetime.now(timezone.utc)
    if eval_now.tzinfo is None:
        eval_now = eval_now.replace(tzinfo=timezone.utc)

    interval_ms = int(expected_interval_ms or 1000)
    stale_after_ms = max(int(interval_ms * stale_multiplier), min_stale_ms)

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

    # Determine freshness time reference
    ref_time = last_acquired_at or event_time
    is_stale = False
    if ref_time is not None:
        if ref_time.tzinfo is None:
            ref_time = ref_time.replace(tzinfo=timezone.utc)
        elapsed_ms = (eval_now - ref_time).total_seconds() * 1000.0
        if elapsed_ms > stale_after_ms:
            is_stale = True

    # 3. Explicit BAD from source or null value on scalar measurement
    if raw_value is None and norm_quality == "GOOD":
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.BAD),
            freshness=str(Freshness.STALE if is_stale else Freshness.FRESH),
            effective_status=str(EffectiveStatus.BAD),
            reason_code=str(ReasonCode.NULL_VALUE),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
        )

    if norm_quality == "BAD":
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.BAD),
            freshness=str(Freshness.STALE if is_stale else Freshness.FRESH),
            effective_status=str(EffectiveStatus.BAD),
            reason_code=str(raw_reason_code or ReasonCode.RAW_SOURCE_BAD),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
        )

    # 4. Explicit UNCERTAIN from source
    if norm_quality == "UNCERTAIN":
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.UNCERTAIN),
            freshness=str(Freshness.STALE if is_stale else Freshness.FRESH),
            effective_status=str(EffectiveStatus.UNCERTAIN),
            reason_code=str(raw_reason_code or ReasonCode.RAW_SOURCE_UNCERTAIN),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
        )

    # 5. Stale acquisition (no fresh sample or keepalive within policy)
    if is_stale:
        return SignalEvaluationResult(
            source_quality=str(SourceQuality.GOOD),
            freshness=str(Freshness.STALE),
            effective_status=str(EffectiveStatus.STALE),
            reason_code=str(ReasonCode.NO_FRESH_ACQUISITION),
            evaluated_at=eval_now_iso,
            stale_after_ms=stale_after_ms,
            last_good=last_good_payload,
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
