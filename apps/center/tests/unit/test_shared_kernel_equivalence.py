"""R2-E B1/B7: the shared kernel ``factorix_core`` reproduces every helper it replaces, value for value.

Two kinds of reference:

* helpers already rewired to the kernel (``platform.tdengine``, ``modules.common``, ``domain.rules.as_utc``,
  ``factorix_acquisition.timeutil.iso_ms``): a frozen copy of the pre-split implementation lives in this file;
* the former duplicates in ``storage_objects``, ``storage_dsl``, ``storage_topology``, ``storage_model_recorder`` and
  ``historian_sources`` (swapped in B7 after a live value-for-value comparison): the old names must be the kernel
  functions themselves (or a ``functools.partial`` of one carrying the caller's error type / option).

Outcomes are compared as ``("ok", value, type, repr)`` or ``("err", exception type, code, message)``.
"""

from __future__ import annotations

import functools
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


# ---------------------------------------------------------------------------- former duplicates: now the kernel (B7 done)
# Until the swap these tests compared each copy in storage_objects / storage_dsl / storage_topology /
# storage_model_recorder / historian_sources with the kernel, value for value, on the sets above (all equal; the
# same comparison was re-run old-code-vs-new-names after the swap, see fix_log ARCH-B "B3/B7/B8"). The old names
# are now the kernel functions (or a ``partial`` of one with the caller's error/option), which is asserted here.


def _is_partial_of(obj: Any, fn: Any, **keywords: Any) -> bool:
    return isinstance(obj, functools.partial) and obj.func is fn and not obj.args and obj.keywords == keywords


def test_historian_sources_q_is_the_kernel_quote_ident() -> None:
    from factorix.modules import historian_sources

    assert historian_sources._q is KS.quote_ident


def test_storage_objects_quote_is_the_kernel_quote_ident_with_the_storage_error() -> None:
    from factorix.modules import storage_objects as so

    assert isinstance(so._quote, functools.partial) and so._quote.func is KS.quote_ident and set(so._quote.keywords) == {"invalid"}
    assert so._quote("a_1") == "`a_1`"
    for name, code in (("x" * 65, "IDENTIFIER_TOO_LONG"), ("1abc", "INVALID_IDENTIFIER"), (None, "INVALID_IDENTIFIER")):
        with pytest.raises(so.StorageObjectError) as err:
            so._quote(name)
        assert err.value.code == code


def test_recorder_str_literal_is_the_kernel_quote_str_keeping_nul() -> None:
    from factorix.modules import storage_model_recorder as smr

    assert _is_partial_of(smr._str_literal, KS.quote_str, reject_nul=False)


@pytest.mark.parametrize(
    ("precision", "expected"),
    [("ms", "1794952800123"), ("us", "1794952800123456"), ("ns", "1794952800123456000"), ("other", "1794952800123456")],
)
def test_recorder_ts_literal_is_the_kernel_ts_int_literal(precision: str, expected: str) -> None:
    from factorix.modules import storage_model_recorder as smr

    assert smr._ts_literal is KS.ts_int_literal
    assert smr._ts_literal(datetime(2026, 11, 18, 5, 0, 0, 123456, tzinfo=PLUS7), precision) == expected


def test_historian_sources_ts_literal_is_the_kernel_ts_iso_literal() -> None:
    from factorix.modules import historian_sources

    assert historian_sources.ts_literal is KS.ts_iso_literal


def test_recorder_parse_ts_is_the_kernel_parse_aware_ts() -> None:
    from factorix.modules import storage_model_recorder as smr

    assert smr._parse_ts is KS.parse_aware_ts


def test_recorder_value_literal_is_the_kernel_typed_literal() -> None:
    from factorix.modules import storage_model_recorder as smr

    assert _is_partial_of(smr.value_literal, KS.typed_literal, reject=smr.ValueRejected)


def test_storage_dsl_tenant_td_database_is_the_kernel_tenant_database_name() -> None:
    """WS-H R4 (B-13): same kernel function and validation order, but the default prefix is the
    configured ``tdengine_db_prefix`` instead of a fixed ``fx_t_``."""
    from uuid import UUID

    from factorix.modules import storage_dsl
    from factorix.platform.settings import get_settings

    tid = UUID("9ed2d4e8-1f0c-46f9-a9e0-d25a18492265")
    assert storage_dsl.tenant_td_database(tid) == KN.tenant_database_name(
        tid, get_settings().tdengine_db_prefix, uuid_first=True)
    assert storage_dsl.tenant_td_database(tid, "abc_") == KN.tenant_database_name(tid, "abc_", uuid_first=True)
    with pytest.raises(ValueError):  # tenant id is still parsed before the prefix is checked
        storage_dsl.tenant_td_database("not-a-uuid", "1bad")


def test_tenant_db_prefix_and_pattern_are_the_kernel_constants() -> None:
    from factorix.modules import storage_objects, storage_topology

    assert storage_objects.TENANT_DB_PREFIX is KN.TENANT_DB_PREFIX
    assert storage_topology._TENANT_DB_RE is KN.TENANT_DB_RE
