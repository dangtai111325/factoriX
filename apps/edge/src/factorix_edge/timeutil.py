"""The single timestamp format the edge emits: ``YYYY-MM-DDTHH:mm:ss.SSSZ`` (UTC, 3 fraction digits)."""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any


def iso_ms(moment: datetime) -> str:
    """Format an aware (or naive-UTC) datetime as UTC with exactly three fraction digits."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


def from_epoch(seconds: float) -> str:
    return iso_ms(datetime.fromtimestamp(seconds, tz=timezone.utc))


def from_epoch_ms(milliseconds: int) -> str:
    whole, rest = divmod(int(milliseconds), 1000)
    moment = datetime.fromtimestamp(whole, tz=timezone.utc).replace(microsecond=rest * 1000)
    return iso_ms(moment)


def now_iso() -> str:
    return from_epoch(time.time())


def normalize_time(value: Any) -> str | None:
    """Turn a source-reported timestamp into the edge format.

    Accepts ISO-8601 strings (``Z`` or an offset; naive strings are read as UTC),
    datetimes, and epoch numbers (seconds or milliseconds, decided by magnitude).
    Returns ``None`` for ``None``/empty input. Raises ``ValueError`` when the value is
    present but cannot be read as a time.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return iso_ms(value)
    if isinstance(value, bool):
        raise ValueError("Boolean is not a timestamp.")
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)) or value < 0:
            raise ValueError("Timestamp number is not valid.")
        # Epoch milliseconds beyond year 2286 in seconds would be > 1e10.
        if value >= 1e11:
            return from_epoch_ms(int(value))
        return from_epoch(float(value))
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return normalize_time(int(text))
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00").replace("z", "+00:00"))
    return iso_ms(parsed)
