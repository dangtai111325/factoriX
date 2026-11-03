"""Source samples distinguish event time from receive time."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, NamedTuple

from factorix.domain.jsonpath import MappingError, evaluate


class ReadSample(NamedTuple):
    field_id: str
    value: Any
    quality: str
    source_time: str | None = None
    received_time: str | None = None
    topic: str | None = None
    reason: str | None = None
    error_stage: str | None = None


def source_timestamp(document: Any, expression: str | None = None) -> tuple[str | None, bool]:
    """Canonical UTC and an invalid-clock flag; absent timestamps are allowed."""
    if expression:
        try:
            matches = evaluate(expression, document)
        except MappingError:
            return None, True
        value = matches[0] if matches else None
    else:
        value = next((document[key] for key in ("source_timestamp", "timestamp", "source_time", "event_time") if document.get(key) is not None), None) if isinstance(document, dict) else None
    if value is None:
        return None, False
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None, True
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), False
    except (ValueError, TypeError, OverflowError):
        return None, True
