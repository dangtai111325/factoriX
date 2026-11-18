"""R2-E B1/B7: the shared kernel ``factorix_core`` reproduces every helper it replaces, value for value.

Two kinds of reference:

* helpers already rewired to the kernel (``platform.tdengine``, ``modules.common``, ``domain.rules.as_utc``,
  ``factorix_acquisition.timeutil.iso_ms``): a frozen copy of the pre-split implementation lives in this file;
* duplicates that still live in modules another workstream is editing (``storage_objects``, ``storage_dsl``,
  ``storage_topology``, ``storage_model_recorder``, ``historian_sources``): compared live, so the later one-line
  swap to the kernel is proven safe. If such a helper is renamed meanwhile, its comparison is skipped.

Outcomes are compared as ``("ok", value, type, repr)`` or ``("err", exception type, code, message)``.
"""

from __future__ import annotations

import importlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

# The acquisition side of the dedupe (timeutil.iso_ms) is checked too; make it importable when this file runs alone.
_ACQ_SRC = Path(__file__).resolve().parents[3] / "acquisition" / "src"
if str(_ACQ_SRC) not in sys.path:
    sys.path.insert(0, str(_ACQ_SRC))

from factorix.domain.canonical import intern_uuid
from factorix.platform import tdengine as TD
from factorix.platform.tdengine import TDEngineError
from factorix_core import time as KT
from factorix_core.tdengine import naming as KN
from factorix_core.tdengine import sql as KS

UTC = timezone.utc
PLUS7 = timezone(timedelta(hours=7))

# ---------------------------------------------------------------------------- frozen pre-B7 implementations

_OLD_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_OLD_IDENT_RE = KS.IDENT_RE.pattern
_OLD_PREFIX_RE = KN.DB_PREFIX_RE.pattern


def old_td_validate_identifier(name: str, *, kind: str = "identifier") -> str:
    import re

    if not isinstance(name, str) or not re.compile(_OLD_IDENT_RE).fullmatch(name):
        raise TDEngineError("INVALID_IDENTIFIER", f"Unsafe or invalid TDengine {kind}: {name!r}")
    return name


def old_td_quote_ident(name: str, *, kind: str = "identifier") -> str:
    return f"`{old_td_validate_identifier(name, kind=kind)}`"


def old_td_quote_str(value: str) -> str:
    if "\x00" in value:
        raise TDEngineError("INVALID_STRING", "NUL byte is not allowed in TDengine string values.")
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def old_td_tenant_database_name(tenant_id: UUID | str, prefix: str = "fx_t_") -> str:
    import re

    if not re.compile(_OLD_PREFIX_RE).fullmatch(prefix):
        raise TDEngineError("INVALID_PREFIX", f"Invalid database prefix: {prefix!r}")
    uid_hex = intern_uuid(tenant_id).hex
    return f"{prefix}{uid_hex}"


def old_td_to_td_timestamp_us(dt: datetime) -> int:
    if not isinstance(dt, datetime):
        raise TDEngineError("INVALID_TIMESTAMP", f"Expected datetime, got {type(dt).__name__}.")
    utc_dt = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    if utc_dt.year < 1970 or utc_dt.year > 2262:
        raise TDEngineError("TIMESTAMP_OUT_OF_RANGE", f"Timestamp out of supported range: {utc_dt.isoformat()}")
    return (utc_dt - _OLD_EPOCH) // timedelta(microseconds=1)


def old_td_to_utc_datetime(val: Any) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.replace(tzinfo=timezone.utc) if val.tzinfo is None else val.astimezone(timezone.utc)
    if isinstance(val, int):
        return _OLD_EPOCH + timedelta(microseconds=val)
    if isinstance(val, str):
        parsed = datetime.fromisoformat(val.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    raise TDEngineError("INVALID_TIMESTAMP", f"Cannot convert {val!r} to UTC datetime.")


def old_td_sql_literal(value: Any, *, value_type: str | None = None) -> str:
    if value is None:
        return "NULL"
    if value_type == "timestamp" or isinstance(value, datetime):
        if isinstance(value, str):
            dt = old_td_to_utc_datetime(value)
            assert dt is not None
            return str(old_td_to_td_timestamp_us(dt))
        return str(old_td_to_td_timestamp_us(value))
    if isinstance(value, bool) or value_type == "bool":
        if not isinstance(value, bool):
            raise TDEngineError("TYPE_MISMATCH", f"Expected bool value, got {type(value).__name__}.")
        return "true" if value else "false"
    if isinstance(value, int) and value_type != "float64":
        if value < -(2**63) or value > 2**63 - 1:
            raise TDEngineError("INT64_OVERFLOW", f"Integer {value} exceeds signed 64-bit bounds.")
        return str(value)
    if isinstance(value, (int, float)) or value_type == "float64":
        num = float(value)
        if math.isnan(num) or math.isinf(num):
            raise TDEngineError("NON_FINITE_FLOAT", "NaN and Infinity are not valid TDengine DOUBLE literals.")
        if num == 0.0:
            return "-0.0" if math.copysign(1.0, num) < 0 else "0.0"
        return repr(num)
    if isinstance(value, (dict, list)) or value_type == "json":
        payload = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        return old_td_quote_str(payload)
    if isinstance(value, str):
        return old_td_quote_str(value)
    return old_td_quote_str(str(value))


def old_common_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def old_common_iso_ms(value: datetime | str | None) -> str | None:
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


def old_acquisition_iso_ms(moment: datetime | None) -> str | None:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


def old_rules_as_utc(value: Any) -> datetime | None:
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
        return old_rules_as_utc(parsed)
    return None


# ---------------------------------------------------------------------------- helpers


def outcome(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
    try:
        result = fn(*args, **kwargs)
        # repr too: equal aware datetimes may still differ in tzinfo, -0.0 == 0.0, True == 1.
        return ("ok", result, type(result), repr(result))
    except Exception as exc:  # noqa: BLE001 - the exception itself is the compared outcome
        return ("err", type(exc), getattr(exc, "code", None), str(exc))


def live(module: str, name: str) -> Any:
    mod = importlib.import_module(module)
    if not hasattr(mod, name):
        pytest.skip(f"{module}.{name} no longer exists (changed by its owner); re-check before swapping to the kernel")
    return getattr(mod, name)


IDENTS: list[Any] = ["a", "_x", "A1_b", "x" * 64, "x" * 65, "1abc", "", "a-b", "a b", "ä", None, 123, "a\n", "abc`", "select"]
STRINGS = ["", "plain", "it's", "back\\slash", "json \\u00e9", "unicode é ✓", "nul\x00byte", "quote'and\\both", "{a}"]
DATETIMES = [
    datetime(2026, 11, 18, 5, 0, 0, 123456),
    datetime(2026, 11, 18, 5, 0, 0, 123999, tzinfo=UTC),
    datetime(2026, 11, 18, 12, 0, 0, 1, tzinfo=PLUS7),
    datetime(1970, 1, 1, tzinfo=UTC),
    datetime(1969, 12, 31, 23, 59, 59, tzinfo=UTC),
    datetime(2262, 4, 11, tzinfo=UTC),
    datetime(2263, 1, 1, tzinfo=UTC),
    datetime(1, 1, 2, tzinfo=UTC),
    datetime(9999, 12, 30, tzinfo=UTC),
]
TEXT_TIMES: list[Any] = ["2026-11-18T05:00:00Z", "2026-11-18T05:00:00z", "2026-11-18T05:00:00", "2026-11-18T12:00:00+07:00",
                         " 2026-11-18T05:00:00.5Z ", "", "   ", "bad", "2026-13-01T00:00:00Z"]
OBJ = object()
VALUES: list[Any] = [None, True, False, 0, -1, 2**63 - 1, 2**63, -(2**63), -(2**63) - 1, 1.5, -0.0, 0.0, float("nan"), float("inf"),
                     1e300, "text", "it's", "nul\x00", {"a": [1, "é"]}, [1, 2], *DATETIMES[:4], "2026-11-18T05:00:00Z", "bad",
                     b"x", OBJ]
VALUE_TYPES = [None, "float64", "int64", "bool", "string", "enum", "json", "timestamp"]


# ---------------------------------------------------------------------------- platform.tdengine (rewired)


@pytest.mark.parametrize("kind", ["identifier", "database", "table"])
def test_td_identifier_quoting_is_unchanged(kind: str) -> None:
    for name in IDENTS:
        assert outcome(TD.validate_identifier, name, kind=kind) == outcome(old_td_validate_identifier, name, kind=kind), name
        assert outcome(TD.quote_ident, name, kind=kind) == outcome(old_td_quote_ident, name, kind=kind), name


def test_td_quote_str_is_unchanged() -> None:
    for text in STRINGS:
        assert outcome(TD.quote_str, text) == outcome(old_td_quote_str, text), text


def test_td_tenant_database_name_is_unchanged() -> None:
    tenants: list[Any] = [UUID("00000000-0000-0000-0000-0000000000a1"), "00000000-0000-0000-0000-0000000000A1",
                          "000000000000000000000000000000a1", "{00000000-0000-0000-0000-0000000000a1}", "bad", 123, None]
    prefixes = ["fx_t_", "a", "A" * 16, "A" * 17, "1x", "", "x-y", "fx_t_\n"]
    for tenant in tenants:
        for prefix in prefixes:
            assert outcome(TD.tenant_database_name, tenant, prefix) == outcome(old_td_tenant_database_name, tenant, prefix), (tenant, prefix)
    assert TD.tenant_database_name(tenants[0]) == old_td_tenant_database_name(tenants[0]) == "fx_t_" + "0" * 30 + "a1"


def test_td_timestamps_are_unchanged() -> None:
    for dt in [*DATETIMES, "2026-11-18T05:00:00Z", 5, None]:
        assert outcome(TD.to_td_timestamp_us, dt) == outcome(old_td_to_td_timestamp_us, dt), dt
    for val in [None, *DATETIMES, 0, 1_700_000_000_000_000, -5, *TEXT_TIMES, 1.5, b"x"]:
        assert outcome(TD.to_utc_datetime, val) == outcome(old_td_to_utc_datetime, val), val


def test_td_sql_literal_is_unchanged() -> None:
    for value in VALUES:
        for value_type in VALUE_TYPES:
            new = outcome(TD.sql_literal, value, value_type=value_type)
            old = outcome(old_td_sql_literal, value, value_type=value_type)
            assert new == old, (value, value_type, new, old)


def test_td_module_constants_are_unchanged() -> None:
    assert TD._EPOCH_UTC == _OLD_EPOCH
    assert TD._IDENT_RE.pattern == r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"
    assert TD._PREFIX_RE.pattern == r"^[A-Za-z][A-Za-z0-9_]{0,15}$"
    assert (TD._INT64_MIN, TD._INT64_MAX) == (-(2**63), 2**63 - 1)


# ---------------------------------------------------------------------------- time helpers (rewired)


def test_iso_helpers_are_unchanged() -> None:
    from factorix.modules import common
    from factorix_acquisition import timeutil

    for value in [None, *DATETIMES, *TEXT_TIMES]:
        assert outcome(common.iso_ms, value) == outcome(old_common_iso_ms, value), value
    for value in [None, *DATETIMES]:
        assert outcome(timeutil.iso_ms, value) == outcome(old_acquisition_iso_ms, value), value
        assert outcome(common.iso, value) == outcome(old_common_iso, value), value
    assert common.iso_ms is KT.iso_ms and timeutil.iso_ms is KT.iso_ms and common.iso is KT.iso


def test_as_utc_is_unchanged() -> None:
    from factorix.domain import rules

    for value in [None, *DATETIMES, *TEXT_TIMES, 0, 1.5, b"x", OBJ]:
        assert outcome(rules.as_utc, value) == outcome(old_rules_as_utc, value), value


def test_utcnow_copies_are_the_kernel_function() -> None:
    from factorix.application.ingestion import common as ingestion_common
    from factorix.modules import common, history_repository, live_state

    for fn in (common.utcnow, ingestion_common._utcnow, live_state._utcnow, history_repository._utcnow):
        assert fn is KT.utcnow
    before = datetime.now(UTC)
    now = KT.utcnow()
    assert now.tzinfo is UTC and before <= now <= datetime.now(UTC)


# ---------------------------------------------------------------------------- duplicates still in place (live)


def test_quote_ident_matches_historian_sources_q() -> None:
    old_q = live("factorix.modules.historian_sources", "_q")
    for name in IDENTS:
        assert outcome(KS.quote_ident, name) == outcome(old_q, name), name


def test_quote_ident_matches_storage_objects_quote() -> None:
    so = importlib.import_module("factorix.modules.storage_objects")
    old_quote = live("factorix.modules.storage_objects", "_quote")

    def invalid(name: Any, kind: str) -> BaseException:
        so.validate_identifier(name)  # raises the storage error (length check first, then pattern)
        raise AssertionError("unreachable: the kernel only calls this for an invalid name")

    for name in IDENTS:
        assert outcome(KS.quote_ident, name, invalid=invalid) == outcome(old_quote, name), name


def test_quote_str_matches_recorder_str_literal() -> None:
    old = live("factorix.modules.storage_model_recorder", "_str_literal")
    for text in STRINGS:
        assert outcome(KS.quote_str, text, reject_nul=False) == outcome(old, text), text


@pytest.mark.parametrize("precision", ["ms", "us", "ns", "other"])
def test_ts_int_literal_matches_recorder(precision: str) -> None:
    old = live("factorix.modules.storage_model_recorder", "_ts_literal")
    for dt in DATETIMES:
        assert outcome(KS.ts_int_literal, dt, precision) == outcome(old, dt, precision), dt


def test_ts_iso_literal_matches_historian_sources() -> None:
    old = live("factorix.modules.historian_sources", "ts_literal")
    for dt in DATETIMES:
        assert outcome(KS.ts_iso_literal, dt) == outcome(old, dt), dt


def test_parse_aware_ts_matches_recorder() -> None:
    old = live("factorix.modules.storage_model_recorder", "_parse_ts")
    for value in [None, *DATETIMES, *TEXT_TIMES, 0, OBJ]:
        assert outcome(KS.parse_aware_ts, value) == outcome(old, value), value


def test_typed_literal_matches_recorder_value_literal() -> None:
    old = live("factorix.modules.storage_model_recorder", "value_literal")
    rejected = live("factorix.modules.storage_model_recorder", "ValueRejected")
    td_types = ["TIMESTAMP", "BOOL", "DOUBLE", "FLOAT", "BIGINT", "INT", "SMALLINT", "TINYINT", "BIGINT UNSIGNED", "NCHAR(10)",
                "VARCHAR(5)", "BINARY(3)", "JSON", "", None]
    values: list[Any] = [None, True, 1, 1.0, 1.5, -0.0, float("nan"), "x", "abc", "abcd", "éé", {"k": 1}, [1], "2026-11-18T05:00:00Z",
                         "not a ts", "  ", *DATETIMES[:3], 2**70]
    for td_type in td_types:
        for length in (None, 3, 10):
            for precision in ("ms", "us", "ns"):
                for value in values:
                    new = outcome(KS.typed_literal, value, td_type, length, precision, reject=rejected)
                    ref = outcome(old, value, td_type, length, precision)
                    assert new == ref, (value, td_type, length, precision, new, ref)


def test_tenant_database_name_matches_storage_dsl() -> None:
    old = live("factorix.modules.storage_dsl", "tenant_td_database")
    tenants: list[Any] = [UUID("00000000-0000-0000-0000-0000000000a1"), "00000000-0000-0000-0000-0000000000A1", "bad", 123, None]
    for tenant in tenants:
        for prefix in ["fx_t_", "A" * 16, "A" * 17, "1x", "", "fx_t_\n"]:
            assert outcome(KN.tenant_database_name, tenant, prefix, uuid_first=True) == outcome(old, tenant, prefix), (tenant, prefix)


def test_tenant_db_prefix_and_pattern_match_storage_modules() -> None:
    assert live("factorix.modules.storage_objects", "TENANT_DB_PREFIX") == KN.TENANT_DB_PREFIX
    old_re = live("factorix.modules.storage_topology", "_TENANT_DB_RE")
    names: list[Any] = ["fx_t_" + "0" * 30 + "a1", "fx_t_" + "0" * 30 + "A1", "fx_t_" + "0" * 31, "fx_t_" + "0" * 32 + "\n", "factorix", "", "fx_t_"]
    for name in names:
        assert KN.is_tenant_database(name) == bool(old_re.fullmatch(name)), name
    assert old_re.pattern == KN.TENANT_DB_RE.pattern
