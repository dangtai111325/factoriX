"""UTC time helpers shared by Center and Acquisition (R2-E B7).

One implementation each of the helpers that were copied across modules:

* :func:`utcnow` - ``modules.common.utcnow`` and the private ``_utcnow`` copies (ingestion, live state, history).
* :func:`iso` - ``modules.common.iso``.
* :func:`iso_ms` - ``modules.common.iso_ms`` and ``factorix_acquisition.timeutil.iso_ms`` (same output for
  ``datetime``/``None``; Center's version additionally accepts ISO strings).
* :func:`as_utc` - ``domain.rules.as_utc`` (lenient: unparseable text and other types give ``None``).

Variants with different semantics (for example the raising ``_utc`` helpers that also accept epoch-microsecond
integers, or ``_opt_time`` which does not accept a lowercase ``z``) are deliberately NOT folded in here; see the
R2-E Phase B fix log.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_ms(value: datetime | str | None) -> str | None:
    """Contract timestamp text: ``YYYY-MM-DDTHH:mm:ss.SSSZ`` (UTC, exactly 3 fraction digits)."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    moment = value.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def as_utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00").replace("z", "+00:00"))
        except ValueError:
            return None
        return as_utc(parsed)
    return None
