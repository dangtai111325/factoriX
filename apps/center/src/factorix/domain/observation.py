"""Canonical observation value object and latest-state ordering."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from factorix.domain.quality import Origin, Quality, ensure_utc

MAX_STRING = 8192
MAX_JSON_DEPTH = 16
MAX_EVENT_UID = 256
FUTURE_SKEW = timedelta(minutes=5)


class ObservationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class Observation:
    event_uid: str
    tenant_id: UUID
    resource_id: UUID
    signal_id: UUID
    event_time: datetime
    received_time: datetime
    value: Any
    data_type: str
    unit: str | None
    quality: Quality
    origin: Origin
    config_revision: int
    site_id: UUID | None = None
    edge_id: UUID | None = None
    connection_id: UUID | None = None
    source_time: datetime | None = None
    provenance: dict[str, Any] | None = None

    def validate(self) -> None:
        if not self.event_uid or len(self.event_uid) > MAX_EVENT_UID:
            raise ObservationError("INVALID_EVENT_UID", "invalid event_uid")
        if any(ch in self.event_uid for ch in ("\n", "\r", "\x00")):
            raise ObservationError("INVALID_EVENT_UID", "invalid event_uid")
        try:
            ensure_utc(self.event_time)
            ensure_utc(self.received_time)
            if self.source_time is not None:
                ensure_utc(self.source_time)
        except ValueError as exc:
            raise ObservationError("TIMEZONE", str(exc)) from exc
        if self.config_revision < 1:
            raise ObservationError("INVALID_REVISION", "invalid config revision")
        if self.data_type not in {
            "bool",
            "int64",
            "float64",
            "string",
            "enum",
            "json",
        }:
            raise ObservationError("INVALID_TYPE", "unsupported data type")
        _validate_value(self.data_type, self.value)
        if self.unit is not None and (len(self.unit) > 32 or "/" in self.unit and self.unit.count("/") > 3):
            raise ObservationError("INVALID_UNIT", "invalid unit")
        if self.provenance is not None:
            _assert_depth(self.provenance, 0)


def _validate_value(data_type: str, value: Any) -> None:
    if value is None:
        return
    if data_type == "bool":
        if not isinstance(value, bool):
            raise ObservationError("INVALID_VALUE", "boolean value required")
        return
    if data_type == "int64":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ObservationError("INVALID_VALUE", "integer value required")
        if abs(value) > 2**63 - 1:
            raise ObservationError("INVALID_VALUE", "integer out of range")
        return
    if data_type == "float64":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ObservationError("INVALID_VALUE", "numeric value required")
        if not math.isfinite(float(value)):
            raise ObservationError("NON_FINITE", "non-finite float")
        return
    if data_type in {"string", "enum"}:
        if not isinstance(value, str):
            raise ObservationError("INVALID_VALUE", "string value required")
        if len(value) > MAX_STRING:
            raise ObservationError("VALUE_TOO_LARGE", "string too large")
        return
    if data_type == "json":
        _assert_depth(value, 0)


def _assert_depth(value: Any, depth: int) -> None:
    if depth > MAX_JSON_DEPTH:
        raise ObservationError("JSON_TOO_DEEP", "json exceeds depth")
    if isinstance(value, dict):
        if len(value) > 256:
            raise ObservationError("JSON_TOO_WIDE", "json object too wide")
        for item in value.values():
            _assert_depth(item, depth + 1)
    elif isinstance(value, list):
        if len(value) > 512:
            raise ObservationError("JSON_TOO_WIDE", "json array too long")
        for item in value:
            _assert_depth(item, depth + 1)


SOURCE_TIME_FUTURE = "SOURCE_TIME_FUTURE"
EDGE_CLOCK_FUTURE = "EDGE_CLOCK_FUTURE"


@dataclass(frozen=True, slots=True)
class TimeDecision:
    """Result of the time model for one incoming sample.

    event_time is always the acquisition time (received_time). source_time is metadata only.
    """

    event_time: datetime
    received_time: datetime
    source_time: datetime | None
    quality: str
    reason: str | None


def resolve_times(
    *,
    received_time: datetime | None,
    source_time: datetime | None,
    quality: str,
    now: datetime | None = None,
) -> TimeDecision:
    """Apply the FactoriX time model.

    - event_time = received_time (acquisition time on the edge), always.
    - source_time (the source's last-change time) is kept as metadata. An old source_time never
      downgrades quality. A source_time more than FUTURE_SKEW ahead of received_time marks a GOOD
      sample UNCERTAIN with reason SOURCE_TIME_FUTURE; the sample is still accepted.
    - A received_time more than FUTURE_SKEW ahead of the Center clock is impossible for a real
      acquisition. It is clamped to the Center clock (UNCERTAIN, EDGE_CLOCK_FUTURE) so that one
      bad edge clock cannot freeze the latest value ordering.
    """
    current = ensure_utc(now or datetime.now(timezone.utc))
    received = ensure_utc(received_time) if received_time is not None else current
    source = ensure_utc(source_time) if source_time is not None else None
    upper = str(quality or "GOOD").upper()
    reason: str | None = None
    if received > current + FUTURE_SKEW:
        received = current
        reason = EDGE_CLOCK_FUTURE
        if upper == "GOOD":
            upper = "UNCERTAIN"
    if source is not None and source > received + FUTURE_SKEW:
        if upper == "GOOD":
            upper = "UNCERTAIN"
        reason = reason or SOURCE_TIME_FUTURE
    return TimeDecision(event_time=received, received_time=received, source_time=source, quality=upper, reason=reason)


def ordering_key(received_time: datetime, observation_id: str) -> tuple[datetime, str]:
    """Latest-state ordering: acquisition time first, observation id as the tie breaker."""
    return (ensure_utc(received_time), str(observation_id))


def should_replace_latest(
    *,
    current_received_time: datetime | None,
    current_uid: str | None,
    incoming_received_time: datetime,
    incoming_uid: str,
    current_event_time: datetime | None = None,
    incoming_event_time: datetime | None = None,
) -> bool:
    """Newer acquisition (received_time, observation id) wins; replayed older samples never regress latest.

    event_time arguments are accepted for compatibility and ignored: event_time equals received_time
    by contract, and the source clock never takes part in the ordering. Mirrors the SQL guard in
    ``telemetry._upsert_latest``.
    """
    del current_event_time, incoming_event_time
    if current_received_time is None or current_uid is None:
        return True
    return ordering_key(incoming_received_time, incoming_uid) > ordering_key(current_received_time, current_uid)


def classify_clock(
    event_time: datetime,
    received_time: datetime,
    *,
    now: datetime | None = None,
) -> Quality | None:
    """Return UNCERTAIN when a timestamp is too far ahead of the Center clock; None means accept as-is.

    Ingest uses ``resolve_times``; this helper remains for callers that only need the check.
    """
    now = now or datetime.now(timezone.utc)
    if ensure_utc(event_time) > ensure_utc(now) + FUTURE_SKEW:
        return Quality.UNCERTAIN
    return None
