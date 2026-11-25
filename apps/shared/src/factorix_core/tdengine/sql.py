"""TDengine SQL text: identifier quoting and literal rendering (R2-E B1/B7).

One implementation of each helper that existed in several modules:

* identifier quoting - ``platform.tdengine.quote_ident`` / ``validate_identifier``,
  ``modules.storage_objects._quote``, ``modules.historian_sources._q``: :func:`quote_ident`;
* string literal - ``platform.tdengine.quote_str`` (rejects NUL) and ``modules.storage_model_recorder._str_literal``
  (does not): :func:`quote_str` with ``reject_nul``;
* timestamp literal - integer epoch at a database precision (``storage_model_recorder._ts_literal``):
  :func:`ts_int_literal`; ISO text for WHERE clauses (``historian_sources.ts_literal``): :func:`ts_iso_literal`;
* dynamically typed value literal (``platform.tdengine.sql_literal``): :func:`sql_literal`;
* column-typed value literal (``storage_model_recorder.value_literal``): :func:`typed_literal`.

Every function raises through a caller-supplied factory so callers keep their exception types:
``error(code, message)`` for the ``platform.tdengine`` family (``TDEngineError`` takes ``(code, message)``),
``invalid(name, kind)`` for identifiers and ``reject(message)`` for typed literals.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
INT64_MIN = -(2**63)
INT64_MAX = 2**63 - 1
EPOCH_UTC = datetime(1970, 1, 1, tzinfo=timezone.utc)


class TDengineSqlError(ValueError):
    """Default error of this module: ``code`` + ``message`` (the shape of ``TDEngineError``)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


ErrorFactory = Callable[[str, str], BaseException]


def _invalid_identifier(name: Any, kind: str) -> BaseException:
    return ValueError(f"Unsafe identifier {name!r}")


# ---------------------------------------------------------------------------- identifiers


def is_identifier(name: Any) -> bool:
    return isinstance(name, str) and IDENT_RE.fullmatch(name) is not None


def validate_identifier(
    name: Any, *, kind: str = "identifier", invalid: Callable[[Any, str], BaseException] = _invalid_identifier
) -> str:
    """Return ``name`` when it is a safe TDengine identifier, else raise ``invalid(name, kind)``.

    ``invalid`` may also raise by itself (for callers with a richer validator, e.g. a length check first).
    """
    if not is_identifier(name):
        raise invalid(name, kind)
    return name


def quote_ident(
    name: Any, *, kind: str = "identifier", invalid: Callable[[Any, str], BaseException] = _invalid_identifier
) -> str:
    return f"`{validate_identifier(name, kind=kind, invalid=invalid)}`"


# ---------------------------------------------------------------------------- strings and timestamps


def quote_str(value: str, *, reject_nul: bool = True, error: ErrorFactory = TDengineSqlError) -> str:
    """Single-quoted string literal; ``\\`` is escaped before ``'`` so JSON ``\\uXXXX`` survives."""
    if reject_nul and "\x00" in value:
        raise error("INVALID_STRING", "NUL byte is not allowed in TDengine string values.")
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def to_td_timestamp_us(dt: datetime, *, error: ErrorFactory = TDengineSqlError) -> int:
    if not isinstance(dt, datetime):
        raise error("INVALID_TIMESTAMP", f"Expected datetime, got {type(dt).__name__}.")
    utc_dt = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    if utc_dt.year < 1970 or utc_dt.year > 2262:
        raise error("TIMESTAMP_OUT_OF_RANGE", f"Timestamp out of supported range: {utc_dt.isoformat()}")
    return (utc_dt - EPOCH_UTC) // timedelta(microseconds=1)


def to_utc_datetime(val: Any, *, error: ErrorFactory = TDengineSqlError) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.replace(tzinfo=timezone.utc) if val.tzinfo is None else val.astimezone(timezone.utc)
    if isinstance(val, int):
        return EPOCH_UTC + timedelta(microseconds=val)
    if isinstance(val, str):
        parsed = datetime.fromisoformat(val.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    raise error("INVALID_TIMESTAMP", f"Cannot convert {val!r} to UTC datetime.")


def ts_int_literal(value: datetime, precision: str) -> str:
    """Epoch integer at the database precision (``ms`` / ``us`` / ``ns``); naive datetimes are UTC; no range check."""
    utc = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    micros = (utc - EPOCH_UTC) // timedelta(microseconds=1)
    if precision == "ms":
        return str(micros // 1000)
    if precision == "ns":
        return str(micros * 1000)
    return str(micros)


def ts_iso_literal(dt: datetime) -> str:
    """``'YYYY-MM-DDTHH:MM:SS.ffffff+00:00'`` (quoted ISO text; any precision; for WHERE clauses)."""
    utc = dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return "'" + utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond:06d}+00:00'"


def parse_aware_ts(value: Any) -> datetime | None:
    """Datetime (naive = UTC) or non-blank ISO text -> aware datetime (offset kept); anything else -> ``None``."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


# ---------------------------------------------------------------------------- value literals


def sql_literal(value: Any, *, value_type: str | None = None, error: ErrorFactory = TDengineSqlError) -> str:
    """Literal for a dynamically typed value (``value_type`` = canonical type name, optional); timestamps in us."""
    if value is None:
        return "NULL"
    if value_type == "timestamp" or isinstance(value, datetime):
        if isinstance(value, str):
            dt = to_utc_datetime(value, error=error)
            assert dt is not None
            return str(to_td_timestamp_us(dt, error=error))
        return str(to_td_timestamp_us(value, error=error))
    if isinstance(value, bool) or value_type == "bool":
        if not isinstance(value, bool):
            raise error("TYPE_MISMATCH", f"Expected bool value, got {type(value).__name__}.")
        return "true" if value else "false"
    if isinstance(value, int) and value_type != "float64":
        if value < INT64_MIN or value > INT64_MAX:
            raise error("INT64_OVERFLOW", f"Integer {value} exceeds signed 64-bit bounds.")
        return str(value)
    if isinstance(value, (int, float)) or value_type == "float64":
        num = float(value)
        if math.isnan(num) or math.isinf(num):
            raise error("NON_FINITE_FLOAT", "NaN and Infinity are not valid TDengine DOUBLE literals.")
        if num == 0.0:
            # Preserve -0.0 cleanly via repr(-0.0) == '-0.0'
            return "-0.0" if math.copysign(1.0, num) < 0 else "0.0"
        return repr(num)
    if isinstance(value, (dict, list)) or value_type == "json":
        payload = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        return quote_str(payload, error=error)
    if isinstance(value, str):
        return quote_str(value, error=error)
    return quote_str(str(value), error=error)


def typed_literal(
    value: Any, td_type: str, length: int | None, precision: str, *, reject: Callable[[str], BaseException] = ValueError
) -> str:
    """Literal for a column of TDengine type ``td_type``; raises ``reject(message)`` instead of truncating or guessing."""
    if value is None:
        return "NULL"
    base = str(td_type or "").upper().split("(")[0].strip()
    if base == "TIMESTAMP":
        ts = value if isinstance(value, datetime) else parse_aware_ts(value)
        if ts is None:
            raise reject(f"'{value}' is not a timestamp")
        return ts_int_literal(ts, precision)
    if base == "BOOL":
        if isinstance(value, bool):
            return "true" if value else "false"
        raise reject(f"{value!r} is not a boolean")
    if base in ("DOUBLE", "FLOAT"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise reject(f"{value!r} is not a number")
        num = float(value)
        if not math.isfinite(num):
            raise reject("NaN/Infinity cannot be stored")
        return repr(num)
    if base in ("BIGINT", "INT", "SMALLINT", "TINYINT") or base.endswith("UNSIGNED"):
        if isinstance(value, bool):
            raise reject(f"{value!r} is a boolean, not an integer")
        if isinstance(value, float):
            if not value.is_integer():
                raise reject(f"{value!r} is not a whole number")
            value = int(value)
        if not isinstance(value, int):
            raise reject(f"{value!r} is not an integer")
        return str(value)
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if length and len(text.encode("utf-8")) > int(length):
        raise reject(f"text of {len(text.encode('utf-8'))} bytes exceeds the column length {length}")
    return quote_str(text, reject_nul=False)
