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

from factorix.modules import storage_bindings as SB

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
NUMERIC_TYPES = {"DOUBLE", "FLOAT", "BIGINT", "INT", "SMALLINT", "TINYINT", "BIGINT UNSIGNED", "INT UNSIGNED",
                 "SMALLINT UNSIGNED", "TINYINT UNSIGNED"}
NICE_BUCKETS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
                   1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000]
_SCHEMA_TTL_S = 60.0


def _q(name: str) -> str:
    if not isinstance(name, str) or not _IDENT.fullmatch(name):
        raise ValueError(f"Unsafe identifier {name!r}")
    return f"`{name}`"


def ts_literal(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return "'" + utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond:06d}+00:00'"


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


class TableSeriesReader:
    """Reads one value column of one TDengine table in a window: count, raw page, buckets."""

    def __init__(self, client: Any) -> None:
        self.client = client
        self._schemas: dict[str, tuple[float, list[tuple[str, str, str]]]] = {}

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
                  *, after: datetime | None = None, newest_first: bool = False) -> list[dict[str, Any]]:
        cols = [f"{_q(ts_col)} AS `ts`", f"{_q(value_col)} AS `value`"]
        if quality_col:
            cols.append(f"{_q(quality_col)} AS `quality`")
        extra = f" AND {_q(ts_col)} > {ts_literal(after)}" if after is not None else ""
        order = "DESC" if newest_first else "ASC"
        rows = await self.client.query_rows(
            f"SELECT {', '.join(cols)} FROM {_q(db)}.{_q(table)} "
            f"WHERE {self._where(ts_col, start, end, epoch_col, epoch, extra)} ORDER BY `ts` {order} LIMIT {int(limit)}"
        )
        out = [{"ts": _utc(r.get("ts")), "value": r.get("value"), "quality": r.get("quality")} for r in rows or []]
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
