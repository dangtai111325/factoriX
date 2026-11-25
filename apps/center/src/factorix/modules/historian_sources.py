"""Historian series sources: signals, Data Model fields and user subtables (review P0-3, P1-7..P1-9).

One reader for every TDengine table the Historian shows:

* ``signal``      -> operational subtable ``op_<type>_<signal hex>`` (column ``val``)
* ``model_field`` -> the user subtable the field is recorded in (``storage_bindings``); without a
                     binding, the model snapshot ring (``ms_<group hex>``, only the last samples)
* ``subtable``    -> any tenant subtable, one value column (the bound one, or the first value column)

Range handling is explicit, never a silent first page:

* the number of rows in the window is counted first;
* ``resolution=auto``: up to ``max_points`` rows are returned raw (ascending, complete); above that
  numeric series are aggregated server-side with ``INTERVAL`` (avg/min/max/count per bucket) and the
  response says ``downsampled`` with the bucket size; non-numeric series return the most recent
  ``max_points`` rows with ``truncated=true`` and the true ``total``;
* ``resolution=raw``: cursor pagination (``next_cursor``), with ``total``.

Time bounds are sent as RFC 3339 strings so the same SQL works on ``ms``/``us``/``ns`` databases.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import json
import math
import re
import time
from typing import Any
from uuid import UUID

from factorix_core.tdengine.sql import IDENT_RE
from factorix_core.tdengine.sql import quote_ident, ts_iso_literal

from factorix.modules import storage_bindings as SB

_IDENT = IDENT_RE  # B-18: the shared kernel pattern (same object)
NUMERIC_TYPES = {"DOUBLE", "FLOAT", "BIGINT", "INT", "SMALLINT", "TINYINT", "BIGINT UNSIGNED", "INT UNSIGNED",
                 "SMALLINT UNSIGNED", "TINYINT UNSIGNED"}
NICE_BUCKETS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
                   1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000]
_SCHEMA_TTL_S = 60.0


# R2-E B7: one implementation in the shared kernel (same output and exception: ValueError "Unsafe identifier ...").
_q = quote_ident
ts_literal = ts_iso_literal


def _utc(val: Any) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    if isinstance(val, (int, float)):
        return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=int(val))
    try:
        parsed = datetime.fromisoformat(str(val).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def choose_bucket_ms(start: datetime, end: datetime, max_points: int) -> int:
    span_ms = max(1, int((end - start).total_seconds() * 1000))
    target = span_ms / max(1, max_points)
    for b in NICE_BUCKETS_MS:
        if b >= target:
            return b
    return NICE_BUCKETS_MS[-1]


@dataclass
class SeriesSource:
    kind: str  # signal | model_field | subtable
    key: str  # stable id for the response: sig:<uuid> | mod:<uuid>:<path> | subtable:<db>.<sub>[:<col>]
    label: str = ""
    signal_id: UUID | None = None
    model_id: UUID | None = None
    field_path: str | None = None
    database: str | None = None
    table: str | None = None
    column: str | None = None
    value_type: str | None = None
    unit: str | None = None
    resource_id: str | None = None
    resource_name: str | None = None
    notes: list[str] = field(default_factory=list)
    snapshot_group: UUID | None = None
    expected_interval_ms: int | None = None


def parse_source_token(token: Any, kind_hint: str | None = None) -> SeriesSource | None:
    """``<uuid>`` | ``sig:<uuid>`` | ``mod:<model uuid>:<field path>`` | ``subtable:<db>.<table>[:<col>]``
    | ``<db>.<table>`` | ``{"kind": ..., "id": ...}``."""
    if isinstance(token, dict):
        kind_hint = str(token.get("kind") or token.get("source_kind") or kind_hint or "") or None
        if token.get("model_id") and (token.get("field_path") or token.get("model_field_path")):
            token = f"mod:{token['model_id']}:{token.get('field_path') or token.get('model_field_path')}"
        else:
            token = token.get("id") or token.get("source_id") or ""
    text = str(token or "").strip()
    if not text:
        return None
    kind = (kind_hint or "").lower()
    if text.startswith("sig:"):
        text, kind = text[4:], "signal"
    if text.startswith("mod:") or kind == "model_field":
        rest = text[4:] if text.startswith("mod:") else text
        mid, _, path = rest.partition(":")
        try:
            model_id = UUID(mid)
        except ValueError:
            return None
        path = SB.normalize_field_path(path)
        if not path:
            return None
        return SeriesSource("model_field", f"mod:{model_id}:{path}", model_id=model_id, field_path=path)
    if text.startswith("subtable:") or kind in ("subtable", "table") or ("." in text and not _is_uuid(text)):
        rest = text.split(":", 1)[1] if text.startswith("subtable:") else text
        ref, _, col = rest.partition(":")
        if "." not in ref:
            return None
        db, table = ref.split(".", 1)
        if not (_IDENT.fullmatch(db) and _IDENT.fullmatch(table)) or (col and not _IDENT.fullmatch(col)):
            return None
        return SeriesSource("subtable", f"subtable:{db}.{table}" + (f":{col}" if col else ""), database=db,
                            table=table, column=col or None)
    try:
        sid = UUID(text)
    except ValueError:
        return None
    return SeriesSource("signal", str(sid), signal_id=sid)


def _is_uuid(text: str) -> bool:
    try:
        UUID(text)
        return True
    except ValueError:
        return False


_SCHEMA_CACHE: dict[str, tuple[float, list[tuple[str, str, str]]]] = {}

#: Operational subtables (``op_<type>_<signal hex>``) have a fixed schema: no DESCRIBE needed.
OP_VALUE_TYPES = {"float64": "DOUBLE", "int64": "BIGINT", "bool": "BOOL", "string": "VARCHAR", "enum": "VARCHAR", "json": "VARCHAR"}


def operational_schema(value_type: str) -> list[tuple[str, str, str]]:
    return [("ts", "TIMESTAMP", ""), ("val", OP_VALUE_TYPES.get(str(value_type).lower(), "VARCHAR"), ""),
            ("source_time", "TIMESTAMP", ""), ("raw_quality", "VARCHAR", ""), ("data_epoch", "BIGINT", "")]


#: Column holding the source's own time, by table family (R2-24): operational tables store the
#: device/source time as ``source_time``; recorded tables the model body time as ``source_timestamp``.
SOURCE_TIME_COLUMNS = ("source_time", "source_timestamp")


class TableSeriesReader:
    """Reads one value column of one TDengine table in a window: count, raw page, buckets."""

    def __init__(self, client: Any) -> None:
        self.client = client
        # Shared by every request (the reader itself is per request): one DESCRIBE per table per minute.
        self._schemas = _SCHEMA_CACHE

    async def schema(self, db: str, table: str) -> list[tuple[str, str, str]]:
        """``[(name, base type, note)]`` of data columns (tags excluded)."""
        key = f"{db}.{table}"
        hit = self._schemas.get(key)
        if hit and time.monotonic() - hit[0] < _SCHEMA_TTL_S:
            return hit[1]
        rows = await self.client.query_rows(f"DESCRIBE {_q(db)}.{_q(table)}")
        cols: list[tuple[str, str, str]] = []
        for r in rows or []:
            note = str(r.get("note") or r.get("Note") or "").upper()
            if "TAG" in note:
                continue
            cols.append((str(r.get("field") or r.get("Field")), str(r.get("type") or r.get("Type") or "").upper().split("(")[0], note))
        self._schemas[key] = (time.monotonic(), cols)
        return cols

    @staticmethod
    def _where(ts_col: str, start: datetime, end: datetime, epoch_col: bool, epoch: int, extra: str = "") -> str:
        where = f"{_q(ts_col)} >= {ts_literal(start)} AND {_q(ts_col)} < {ts_literal(end)}"
        if epoch_col:
            where += f" AND `data_epoch` >= {int(epoch)}"
        return where + extra

    async def count(self, db: str, table: str, ts_col: str, value_col: str, start: datetime, end: datetime,
                    epoch_col: bool, epoch: int) -> int:
        rows = await self.client.query_rows(
            f"SELECT COUNT(*) AS n FROM {_q(db)}.{_q(table)} WHERE {self._where(ts_col, start, end, epoch_col, epoch)}"
        )
        if not rows:
            return 0
        r = rows[0]
        return int(r.get("n") if isinstance(r, dict) and r.get("n") is not None else (list(r.values())[0] if isinstance(r, dict) else r[0]) or 0)

    async def raw(self, db: str, table: str, ts_col: str, value_col: str, quality_col: str | None,
                  start: datetime, end: datetime, epoch_col: bool, epoch: int, limit: int,
                  *, after: datetime | None = None, newest_first: bool = False,
                  source_time_col: str | None = None) -> list[dict[str, Any]]:
        cols = [f"{_q(ts_col)} AS `ts`", f"{_q(value_col)} AS `value`"]
        if quality_col:
            cols.append(f"{_q(quality_col)} AS `quality`")
        if source_time_col:
            cols.append(f"{_q(source_time_col)} AS `source_time`")
        extra = f" AND {_q(ts_col)} > {ts_literal(after)}" if after is not None else ""
        order = "DESC" if newest_first else "ASC"
        rows = await self.client.query_rows(
            f"SELECT {', '.join(cols)} FROM {_q(db)}.{_q(table)} "
            f"WHERE {self._where(ts_col, start, end, epoch_col, epoch, extra)} ORDER BY `ts` {order} LIMIT {int(limit)}"
        )
        out = [{"ts": _utc(r.get("ts")), "value": r.get("value"), "quality": r.get("quality"),
                "source_time": _utc(r.get("source_time")) if source_time_col else None} for r in rows or []]
        out = [r for r in out if r["ts"] is not None]
        out.sort(key=lambda r: r["ts"])
        return out

    async def buckets(self, db: str, table: str, ts_col: str, value_col: str, quality_col: str | None,
                      start: datetime, end: datetime, epoch_col: bool, epoch: int, bucket_ms: int) -> list[dict[str, Any]]:
        v = _q(value_col)
        good = f" AND {_q(quality_col)} IN ('GOOD', 'UNCERTAIN')" if quality_col else ""
        rows = await self.client.query_rows(
            f"SELECT _WSTART AS `bucket`, AVG({v}) AS `avg`, MIN({v}) AS `min`, MAX({v}) AS `max`, "
            f"COUNT({v}) AS `count`, LAST({v}) AS `last` FROM {_q(db)}.{_q(table)} "
            f"WHERE {self._where(ts_col, start, end, epoch_col, epoch, good)} AND {v} IS NOT NULL "
            f"INTERVAL({int(bucket_ms)}a) FILL(NONE) ORDER BY `bucket` ASC"
        )
        out = []
        for r in rows or []:
            b = _utc(r.get("bucket"))
            if b is None:
                continue

            def num(x: Any) -> float | None:
                if x is None:
                    return None
                try:
                    f = float(x)
                except (TypeError, ValueError):
                    return None
                return f if math.isfinite(f) else None

            out.append({"ts": b, "avg": num(r.get("avg")), "min": num(r.get("min")), "max": num(r.get("max")),
                        "count": int(r.get("count") or 0), "last": num(r.get("last"))})
        return out


def decode_value(raw: Any, base_type: str) -> Any:
    if raw is None:
        return None
    if base_type == "BOOL":
        return bool(raw) if not isinstance(raw, str) else raw.lower() in ("true", "1")
    if base_type in NUMERIC_TYPES:
        try:
            f = float(raw)
        except (TypeError, ValueError):
            return raw
        if not math.isfinite(f):
            return None  # NaN / Inf are not JSON values; shown as a gap, never as a fake number
        return int(f) if base_type not in ("DOUBLE", "FLOAT") and f.is_integer() else f
    if isinstance(raw, (bytes, bytearray)):
        return raw.decode("utf-8", "replace")
    return raw


def snapshot_points(records: list[Any], path: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
    """Field values extracted from model snapshot bodies (ascending, inside the window)."""
    out: list[dict[str, Any]] = []
    for rec in records:
        ts = _utc(getattr(rec, "sampled_at", None))
        if ts is None or ts < start or ts >= end:
            continue
        try:
            body = json.loads(rec.body) if rec.body else None
        except ValueError:
            continue
        found, value = SB.extract_field(body, path)
        if not found:
            continue
        errors = getattr(rec, "errors", []) or []
        bad = any(SB.normalize_field_path(e.get("path")) == path for e in errors if isinstance(e, dict))
        out.append({"ts": ts, "value": value, "quality": "BAD" if bad else None})
    out.sort(key=lambda r: r["ts"])
    return out


_OFFSET = re.compile(r"^\s*(\d+)\s*(s|m|h|d|w)\s*$", re.IGNORECASE)
_UNIT_MS = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}


def parse_offset_ms(raw: Any) -> int | None:
    """``"1d"``, ``"7d"``, ``"1h"``, ``"30m"`` or milliseconds -> milliseconds (compare periods)."""
    if raw in (None, "", 0):
        return None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return int(raw) if raw > 0 else None
    m = _OFFSET.match(str(raw))
    if not m:
        raise ValueError(f"'{raw}' is not an offset like 1h, 1d or 7d")
    return int(m.group(1)) * _UNIT_MS[m.group(2).lower()]


def gap_stats(times: list[datetime], start: datetime, end: datetime, threshold_ms: int | None) -> dict[str, Any]:
    """Gaps = intervals between consecutive points (and the window edges) longer than ``threshold_ms``.

    ``coverage_pct`` is the share of the window not inside a gap. Returns ``None`` values when no
    threshold applies (sparse change-only series have no notion of "missing samples").
    """
    if not threshold_ms:
        return {"gap_count": None, "longest_gap_ms": None, "coverage_pct": None}
    window_ms = max(1.0, (end - start).total_seconds() * 1000.0)
    edges = [start, *sorted(times), end]
    gaps = []
    for a, b in zip(edges, edges[1:], strict=False):
        d = (b - a).total_seconds() * 1000.0
        if d > threshold_ms:
            gaps.append(d)
    if not times:
        return {"gap_count": 1, "longest_gap_ms": int(window_ms), "coverage_pct": 0.0}
    return {
        "gap_count": len(gaps),
        "longest_gap_ms": int(max(gaps)) if gaps else 0,
        "coverage_pct": round(max(0.0, 100.0 * (1.0 - sum(gaps) / window_ms)), 1),
    }
