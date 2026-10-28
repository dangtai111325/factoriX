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


def ordering_key(event_time: datetime, received_time: datetime, event_uid: str) -> tuple[datetime, datetime, str]:
    return (ensure_utc(event_time), ensure_utc(received_time), event_uid)


def should_replace_latest(
    *,
    current_event_time: datetime | None,
    current_received_time: datetime | None,
    current_uid: str | None,
    incoming_event_time: datetime,
    incoming_received_time: datetime,
    incoming_uid: str,
) -> bool:
    """Newer source/event time wins. Replayed older samples must not regress latest."""
    if current_event_time is None or current_received_time is None or current_uid is None:
        return True
    incoming = ordering_key(incoming_event_time, incoming_received_time, incoming_uid)
    current = ordering_key(current_event_time, current_received_time, current_uid)
    return incoming > current


def classify_clock(
    event_time: datetime,
    received_time: datetime,
    *,
    now: datetime | None = None,
) -> Quality | None:
    """Return UNCERTAIN when the source timestamp is too far in the future; None means accept as-is."""
    now = now or datetime.now(timezone.utc)
    if ensure_utc(event_time) > ensure_utc(now) + FUTURE_SKEW:
        return Quality.UNCERTAIN
    return None
