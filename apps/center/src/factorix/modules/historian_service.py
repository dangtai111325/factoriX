"""Historian Service (S12) for multi-series queries, events, saved views, and CSV exports.

Architectural invariants (§5.2, §5.3, §6.2, §8.3, ADR-002, ADR-008):
- Multi-series query with mode in (operational | recorded | reconstructed).
- Reconstructed step-hold timeline with canonical_stale_after_ms gap truncation.
- Formula-injection safe CSV exports backed by `export_jobs` table.
- Saved Views backed by `saved_queries` table without schema duplication.
- Truthful quality transitions, storage operations, and epoch reset event feed.
- Expired download enforcement returning HTTP 410 EXPORT_EXPIRED.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import logging
import math
import re
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

try:
    from factorix.platform.csv_safe import csv_cell, csv_row, sanitize_csv_cell
except ImportError:
    from factorix.domain.csv_safe import csv_cell, csv_row
    sanitize_csv_cell = csv_cell

from factorix.domain.signal_state import canonical_stale_after_ms
from factorix.modules.common import (
    as_uuid,
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    iso_ms,
    parse_uuid,
    utcnow,
)
from factorix.modules.history_repository import (
    HistoricalBucket,
    HistoricalPage,
    HistoricalPoint,
    TDengineHistoryRepository,
    get_history_provider,
    get_model_snapshot_provider,
)
from factorix.modules.live_state import (
    compute_health_dimensions,
    extract_runtime_health,
    get_live_state_provider,
)
from factorix.modules import historian_sources as HSRC
from factorix.modules import historian_views as HV
from factorix.modules import storage_bindings as SB
from factorix.modules.storage_dsl import tenant_td_database
from factorix.platform.errors import AppError
from factorix.platform.tdengine import (
    TDEngineError,
    op_subtable_name,
    quote_fq_table,
    to_td_timestamp_us,
    to_utc_datetime,
)

logger = logging.getLogger(__name__)


def _safe_uuid(val: Any) -> UUID | None:
    if val is None or val == "":
        return None
    try:
        return as_uuid(val)
    except Exception:
        return None

_RANGE_MAP: dict[str, int] = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
}


def _safe_json_dict(val: Any) -> dict[str, Any]:
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip():
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _dump_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _parse_time_bounds(
    start_raw: str | datetime | None,
    end_raw: str | datetime | None,
    range_preset: str | None = None,
) -> tuple[datetime, datetime]:
    now = utcnow()
    if range_preset and range_preset.lower() in _RANGE_MAP:
        span_ms = _RANGE_MAP[range_preset.lower()]
        return now - timedelta(milliseconds=span_ms), now

    end_dt: datetime = now
    if end_raw:
        if isinstance(end_raw, datetime):
            end_dt = end_raw.replace(tzinfo=timezone.utc) if end_raw.tzinfo is None else end_raw.astimezone(timezone.utc)
        else:
            try:
                end_dt = datetime.fromisoformat(str(end_raw).replace("Z", "+00:00"))
            except ValueError:
                raise AppError(422, "INVALID_TIME", f"'{end_raw}' is not an ISO-8601 timestamp.") from None
            if end_dt.tzinfo is None:
                end_dt = end_dt.replace(tzinfo=timezone.utc)

    start_dt: datetime = end_dt - timedelta(minutes=15)
    if start_raw:
        if isinstance(start_raw, datetime):
            start_dt = start_raw.replace(tzinfo=timezone.utc) if start_raw.tzinfo is None else start_raw.astimezone(timezone.utc)
        else:
            try:
                start_dt = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
            except ValueError:
                raise AppError(422, "INVALID_TIME", f"'{start_raw}' is not an ISO-8601 timestamp.") from None
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)

    if start_dt >= end_dt:
        start_dt = end_dt - timedelta(minutes=15)

    return start_dt, end_dt


async def _active_epoch(session: AsyncSession, tenant_id: UUID) -> int:
    """Active telemetry epoch of the tenant (single source: ``telemetry_generations``)."""
    row = await fetch_one(
        session,
        "SELECT active_epoch FROM telemetry_generations WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    if row and row.get("active_epoch") is not None:
        return max(1, int(row["active_epoch"]))
    return 1


# ==============================================================================
# S12 Historian Latest Values & Health
# ==============================================================================


async def get_historian_latest(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    signal_ids: Sequence[UUID | str] | None = None,
    signals: Sequence[UUID | str] | None = None,
    design_id: UUID | str | None = None,
    dataset_id: UUID | str | None = None,
    dataset_name: str | None = None,
) -> dict[str, Any]:
    """Retrieve latest values and the 4 health dimensions for selected signals or design bindings."""
    target_signal_ids: list[UUID] = []
    effective_signals = signal_ids if signal_ids is not None else signals
    if effective_signals:
        for s in effective_signals:
            u = _safe_uuid(s)
            if u and u not in target_signal_ids:
                target_signal_ids.append(u)

    if (not target_signal_ids) and (design_id or dataset_id or dataset_name):
        params: dict[str, Any] = {"tenant_id": tenant_id}
        clauses = ["fb.tenant_id = :tenant_id", "fb.signal_id IS NOT NULL"]
        d_id = _safe_uuid(design_id)
        if d_id:
            clauses.append("ds.design_id = :design_id")
            params["design_id"] = d_id
        ds_id = _safe_uuid(dataset_id)
        if ds_id:
            clauses.append("fb.dataset_id = :dataset_id")
            params["dataset_id"] = ds_id
        if dataset_name:
            clauses.append("(ds.dataset_key = :ds_name OR ds.display_name = :ds_name)")
            params["ds_name"] = dataset_name
        where_sql = " AND ".join(clauses)
        bound_rows = await fetch_all(
            session,
            f"""
            SELECT DISTINCT fb.signal_id
            FROM storage_field_bindings fb
            JOIN storage_datasets ds ON ds.id = fb.dataset_id
            WHERE {where_sql}
            """,
            params,
        )
        target_signal_ids = [as_uuid(r["signal_id"]) for r in bound_rows]

    # Active epoch
    epoch_row = await fetch_one(
        session,
        "SELECT active_epoch FROM telemetry_generations WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    active_epoch = int(epoch_row["active_epoch"]) if epoch_row and epoch_row.get("active_epoch") is not None else 1

    id_filter = ""
    query_params: dict[str, Any] = {"tenant_id": tenant_id, "epoch": active_epoch}
    if target_signal_ids:
        id_filter = "AND s.id = ANY(:sig_ids)"
        query_params["sig_ids"] = target_signal_ids

    rows = await fetch_all(
        session,
        f"""
        SELECT s.id AS signal_id, s.key, s.unit, s.data_type, s.status AS signal_status,
               s.expected_interval_ms,
               r.id AS resource_id, r.name AS resource_name,
               l.value_json, l.quality, l.reason_code, l.source_time,
               l.received_time, l.last_acquired_at, l.last_value_changed_at,
               l.data_epoch, l.source_sequence, l.event_uid,
               c.health AS connection_health, c.status AS connection_status
        FROM signal_definitions s
        LEFT JOIN resources r ON r.id = s.resource_id
        LEFT JOIN latest_signal_state l ON l.signal_id = s.id AND l.tenant_id = s.tenant_id
        LEFT JOIN LATERAL (
            SELECT c.health, c.status
            FROM signal_bindings b
            JOIN source_fields f ON f.id = b.source_field_id
            LEFT JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
            LEFT JOIN connections c ON c.id = j.connection_id
            WHERE b.signal_id = s.id AND b.valid_to IS NULL
            ORDER BY b.enabled DESC, b.valid_from DESC
            LIMIT 1
        ) c ON TRUE
        WHERE s.tenant_id = :tenant_id AND s.status = 'ACTIVE'
          {id_filter}
        ORDER BY s.key ASC
        LIMIT 500
        """,
        query_params,
    )

    items: list[dict[str, Any]] = []
    now = utcnow()

    for r in rows:
        row_epoch = int(r.get("data_epoch") or 1)
        is_fresh_epoch = row_epoch >= active_epoch

        val_obj = _safe_json_dict(r.get("value_json")) if r.get("value_json") else None
        raw_val = val_obj.get("v") if val_obj else None
        raw_qual = str(r.get("quality") or "NO_DATA").upper() if is_fresh_epoch else "NO_DATA"
        reason = str(r["reason_code"]) if (r.get("reason_code") and is_fresh_epoch) else None

        last_acq = r.get("last_acquired_at") or r.get("received_time")
        if not is_fresh_epoch:
            last_acq = None
            raw_val = None

        # Compute 4 dimensions of health
        src_health = str(r.get("source_health") or ("ONLINE" if raw_qual == "GOOD" else ("DEGRADED" if raw_qual in {"UNCERTAIN", "STALE"} else "UNKNOWN"))).upper()
        conn_health = str(r.get("connection_health") or "CONNECTED").upper()
        broker_health = str(r.get("broker_health") or "HEALTHY").upper()
        storage_health = str(r.get("storage_health") or "HEALTHY").upper()

        sig_key = str(r.get("key") or r.get("signal_key") or "")
        items.append(
            {
                "signal_id": str(r.get("signal_id") or r.get("id")),
                "key": sig_key,
                "display_name": str(r.get("display_name") or sig_key),
                "resource_id": str(r["resource_id"]) if r.get("resource_id") else None,
                "resource_name": str(r.get("resource_name") or ""),
                "value": raw_val,
                "value_type": str(r.get("data_type") or "float64"),
                "unit": r.get("unit"),
                "quality": raw_qual,
                "reason_code": reason,
                "source_time": iso_ms(r["source_time"]) if (r.get("source_time") and is_fresh_epoch) else None,
                "last_acquired_at": iso_ms(last_acq) if last_acq else None,
                "last_value_changed_at": iso_ms(r["last_value_changed_at"]) if (r.get("last_value_changed_at") and is_fresh_epoch) else None,
                "data_epoch": row_epoch,
                "source_health": src_health,
                "connection_health": conn_health,
                "broker_health": broker_health,
                "storage_health": storage_health,
            }
        )

    return {"items": items, "active_epoch": active_epoch}


# ==============================================================================
# S12 Historian Multi-Series Query & Aggregation
# ==============================================================================


def _build_sql_preview(
    tenant_id: UUID,
    signal_ids: Sequence[str],
    dataset_key: str | None,
    mode: str,
    time_axis: str,
    start_iso: str,
    end_iso: str,
    quality_filter: str | None,
    bucket_ms: int | None,
    agg: str | None,
    limit: int,
) -> str:
    db = tenant_td_database(tenant_id)
    time_col = "`source_time`" if time_axis == "source_time" else "`ts`"
    table_target = (
        f"`{db}`.`md_{re.sub(r'[^A-Za-z0-9_]', '_', dataset_key)}`"
        if mode == "recorded" and dataset_key
        else f"`{db}`.`op_float64`"
    )

    sig_clause = ""
    if signal_ids:
        sample_ids = [f"'{s[:8]}...'" for s in signal_ids[:4]]
        sig_clause = f" AND `signal_id` IN ({', '.join(sample_ids)})"

    qual_clause = f" AND `raw_quality` = '{quality_filter}'" if quality_filter and quality_filter != "ALL" else ""

    if bucket_ms and bucket_ms > 0 and agg:
        fn_sql = agg.upper()
        return (
            f"-- Read-only TDengine Parameterized Query Preview ({mode.upper()})\n"
            f"SELECT _WSTART AS `bucket_ts`, `signal_id`, {fn_sql}(`val`) AS `{agg}_val`, COUNT(`val`) AS `samples`\n"
            f"FROM {table_target}\n"
            f"WHERE {time_col} >= '{start_iso}' AND {time_col} < '{end_iso}'\n"
            f"  AND `data_epoch` >= :active_epoch{sig_clause}{qual_clause}\n"
            f"PARTITION BY `signal_id` INTERVAL({bucket_ms}a) FILL(NONE)\n"
            f"ORDER BY `bucket_ts` ASC LIMIT {limit};"
        )

    return (
        f"-- Read-only TDengine Parameterized Query Preview ({mode.upper()})\n"
        f"SELECT `ts`, `val`, `acquired_at`, `source_time`, `raw_quality`, `reason_code`, `event_uid`, `record_kind`, `data_epoch`\n"
        f"FROM {table_target}\n"
        f"WHERE {time_col} >= '{start_iso}' AND {time_col} < '{end_iso}'\n"
        f"  AND `data_epoch` >= :active_epoch{sig_clause}{qual_clause}\n"
        f"ORDER BY {time_col} ASC LIMIT {limit};"
    )


MAX_SERIES = 20
DEFAULT_MAX_POINTS = 1500
EXPORT_MAX_ROWS_PER_SERIES = 100_000


def _collect_sources(payload: Mapping[str, Any]) -> list[HSRC.SeriesSource]:
    """Every requested series: ``sources`` (objects or tokens), ``signal_ids``/``signals``/``signal_id``,
    ``source_id`` (+ ``kind``). Duplicates are removed, order is kept."""
    tokens: list[Any] = []
    raw_sources = payload.get("sources")
    if isinstance(raw_sources, str):
        raw_sources = [t for t in raw_sources.split(",") if t.strip()]
    tokens.extend(raw_sources or [])
    for key in ("signal_ids", "signals"):
        val = payload.get(key)
        if isinstance(val, str):
            val = [t for t in val.split(",") if t.strip()]
        tokens.extend(val or [])
    for key in ("signal_id", "source_id"):
        if payload.get(key):
            tokens.append({"kind": payload.get("kind") or payload.get("source_kind"), "id": payload[key]}
                          if key == "source_id" else payload[key])
    out: list[HSRC.SeriesSource] = []
    seen: set[str] = set()
    for tok in tokens:
        src = HSRC.parse_source_token(tok)
        if src is not None and src.key not in seen:
            seen.add(src.key)
            out.append(src)
    return out


async def _enrich_sources(session: AsyncSession, tenant_id: UUID, sources: list[HSRC.SeriesSource]) -> None:
    sig_ids = [s.signal_id for s in sources if s.signal_id]
    if sig_ids:
        rows = await fetch_all(
            session,
            """
            SELECT s.id, s.key, s.display_name, s.unit, s.data_type, s.expected_interval_ms,
                   r.id AS resource_id, r.name AS resource_name
            FROM signal_definitions s LEFT JOIN resources r ON r.id = s.resource_id
            WHERE s.tenant_id = :tenant_id AND s.id = ANY(:ids)
            """,
            {"tenant_id": tenant_id, "ids": sig_ids},
        )
        meta = {as_uuid(r["id"]): r for r in rows}
        for src in sources:
            m = meta.get(src.signal_id) if src.signal_id else None
            if src.kind == "signal":
                if m is None:
                    src.notes.append("Signal not found in this tenant.")
                    continue
                src.value_type = str(m.get("data_type") or "float64")
                src.unit = m.get("unit")
                src.expected_interval_ms = int(m.get("expected_interval_ms") or 0) or None
                src.resource_id = str(m["resource_id"]) if m.get("resource_id") else None
                src.resource_name = m.get("resource_name")
                src.label = f"{m.get('resource_name')} \u00b7 {m['key']}" if m.get("resource_name") else str(m["key"])
    model_ids = [s.model_id for s in sources if s.model_id]
    if model_ids:
        rows = await fetch_all(
            session,
            """
            SELECT m.id, m.display_name, m.spec_json, r.id AS resource_id, r.name AS resource_name
            FROM output_groups m LEFT JOIN resources r ON r.id = m.resource_id
            WHERE m.tenant_id = :tenant_id AND m.id = ANY(:ids)
            """,
            {"tenant_id": tenant_id, "ids": model_ids},
        )
        models = {as_uuid(r["id"]): r for r in rows}
        bindings = await SB.bound_model_fields(session, tenant_id)
        for src in sources:
            if src.kind != "model_field":
                continue
            m = models.get(src.model_id)
            if m is None:
                src.notes.append("Data Model not found in this tenant.")
                continue
            leaves = {leaf["path"]: leaf for leaf in SB.model_leaf_fields(m.get("spec_json"))}
            leaf = leaves.get(src.field_path or "")
            src.value_type = leaf["data_type"] if leaf else None
            src.resource_id = str(m["resource_id"]) if m.get("resource_id") else None
            src.resource_name = m.get("resource_name")
            src.label = f"{m['display_name']} \u00b7 {src.field_path}"
            owner = bindings.get((str(src.model_id), src.field_path or ""))
            if owner:
                src.database, src.table, src.column = owner["database"], owner["subtable"], owner["column"]
            else:
                src.snapshot_group = src.model_id
    for src in sources:
        if src.kind == "subtable" and src.database and src.table:
            reg = await fetch_one(
                session,
                "SELECT display_name FROM storage_objects WHERE tenant_id = :tenant_id AND physical_db = :db "
                "AND physical_name = :name AND status <> 'PURGED' LIMIT 1",
                {"tenant_id": tenant_id, "db": src.database, "name": src.table},
            )
            src.label = (reg or {}).get("display_name") or src.table


async def _tenant_owns_database(session: AsyncSession, tenant_id: UUID, db: str) -> bool:
    if db == tenant_td_database(tenant_id):
        return True
    row = await fetch_one(
        session,
        "SELECT 1 FROM storage_objects WHERE tenant_id = :tenant_id AND physical_db = :db AND status <> 'PURGED' LIMIT 1",
        {"tenant_id": tenant_id, "db": db},
    )
    return bool(row)


def _iso(ts: datetime) -> str:
    """``YYYY-MM-DDTHH:MM:SS.mmmZ`` (same text as ``iso_ms``, ~4x faster: it runs once per point)."""
    if ts.tzinfo is not timezone.utc:
        ts = ts.astimezone(timezone.utc) if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    return ts.replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"


def _point(src: HSRC.SeriesSource, ts: datetime, value: Any, quality: str | None, record_kind: str,
           extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compact point: series-level facts (key, label, unit, type) live on the series, not on every
    point (D1: the old shape was ~400 bytes/point and was repeated 4x in the response)."""
    pt: dict[str, Any] = {"ts": _iso(ts), "value": value, "quality": quality, "record_kind": record_kind}
    if extra:
        for k, v in extra.items():
            if v is not None and v is not False:
                pt[k] = v
    return pt


async def _read_table_series(
    reader: HSRC.TableSeriesReader,
    src: HSRC.SeriesSource,
    *,
    db: str,
    table: str,
    value_col: str | None,
    start_dt: datetime,
    end_dt: datetime,
    epoch: int,
    resolution: str,
    max_points: int,
    cursor: str | None,
    bucket_ms: int | None,
    record_kind: str,
    schema: list[tuple[str, str, str]] | None = None,
) -> dict[str, Any]:
    """One series. Usually ONE TDengine round trip:

    * ``bucket`` or a window that clearly holds more than ``max_points`` samples (expected interval
      known) -> INTERVAL buckets directly (avg/min/max/count/last), ``total`` = sum of counts;
    * otherwise the newest ``max_points + 1`` rows; ``<= max_points`` -> complete raw series;
      more -> numeric: buckets (2nd query); text: the most recent ``max_points`` rows + COUNT.
    """
    schema = schema or await reader.schema(db, table)
    if not schema:
        return {"points": [], "total": 0, "status": "NO_TABLE"}
    names = [c[0] for c in schema]
    types = {c[0]: c[1] for c in schema}
    ts_col = names[0]
    if value_col is None or value_col not in types:
        value_col = next(
            (n for n, t, note in schema[1:] if "COMPOSITE" not in note and n not in _WRITER_COLUMNS and n != "val"),
            "val" if "val" in types else None,
        )
    if value_col is None:
        return {"points": [], "total": 0, "status": "NO_VALUE_COLUMN"}
    quality_col = "quality" if "quality" in types else ("raw_quality" if "raw_quality" in types else None)
    epoch_col = "data_epoch" in types
    base = types[value_col]
    numeric = base in HSRC.NUMERIC_TYPES
    meta: dict[str, Any] = {"column": value_col, "column_type": base, "downsampled": False,
                            "truncated": False, "bucket_ms": None, "next_cursor": None}

    async def as_buckets() -> dict[str, Any]:
        bms = bucket_ms or HSRC.choose_bucket_ms(start_dt, end_dt, max_points)
        rows = await reader.buckets(db, table, ts_col, value_col, quality_col, start_dt, end_dt, epoch_col, epoch, bms)
        meta.update(downsampled=True, bucket_ms=bms, total=sum(r["count"] for r in rows), times=[r["ts"] for r in rows])
        meta["points"] = [
            _point(src, r["ts"], r["avg"], None, "AGGREGATE", {"min": r["min"], "max": r["max"], "count": r["count"], "last": r["last"]})
            for r in rows
        ]
        return meta

    def as_raw(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        meta["times"] = [r["ts"] for r in rows]  # kept as datetimes for gap stats / quality segments
        return [_point(src, r["ts"], HSRC.decode_value(r["value"], base),
                       (str(r["quality"]).upper() if r.get("quality") else None), record_kind) for r in rows]

    if numeric and resolution == "bucket":
        return await as_buckets()
    if resolution == "raw":
        after = HSRC._utc(cursor) if cursor else None
        rows = await reader.raw(db, table, ts_col, value_col, quality_col, start_dt, end_dt, epoch_col, epoch,
                                max_points, after=after)
        meta["points"] = as_raw(rows)
        if len(rows) >= max_points:
            meta["next_cursor"] = iso_ms(rows[-1]["ts"])
            meta["total"] = await reader.count(db, table, ts_col, value_col, start_dt, end_dt, epoch_col, epoch)
        else:
            meta["total"] = len(rows) if not cursor else None
        return meta
    span_ms = (end_dt - start_dt).total_seconds() * 1000.0
    if numeric and src.expected_interval_ms and span_ms / max(1, src.expected_interval_ms) > 2 * max_points:
        return await as_buckets()
    rows = await reader.raw(db, table, ts_col, value_col, quality_col, start_dt, end_dt, epoch_col, epoch,
                            max_points + 1, newest_first=True)
    if len(rows) <= max_points:
        meta.update(points=as_raw(rows), total=len(rows))
        return meta
    if numeric:
        return await as_buckets()
    meta.update(points=as_raw(rows[-max_points:]), truncated=True,
                total=await reader.count(db, table, ts_col, value_col, start_dt, end_dt, epoch_col, epoch))
    return meta


_WRITER_COLUMNS = frozenset({
    "event_key", "source_timestamp", "publish_timestamp", "field_source_timestamp", "quality",
    "quality_reason", "is_null", "model_ref", "model_field_path", "model_revision", "data_epoch",
    "source_event_uid", "time_basis", "acquired_at", "source_time", "raw_quality", "reason_code",
    "origin", "unit", "event_uid", "config_rev", "record_kind",
})
#: Concurrent TDengine reads per request (the client pool has 4 workers shared with the API process).
TD_PARALLEL = 4


async def query_historian(
    session: AsyncSession,
    tenant_id: UUID,
    payload: Mapping[str, Any],
    *,
    history_provider: TDengineHistoryRepository | None = None,
) -> dict[str, Any]:
    """Multi-series Historian query over signals, Data Model fields and user subtables.

    Flow (D1): all PostgreSQL work first (source resolution, epoch, tenant checks), then the TDengine
    reads of every series — and of the compare window — run concurrently (bounded by ``TD_PARALLEL``),
    one round trip per series in the common case, long ranges aggregated by TDengine (INTERVAL).
    Points are compact (``ts, value, quality, record_kind`` + bucket/lineage extras when present) and the
    response carries them once, in ``series_list``. Without a TDengine provider the labelled
    PostgreSQL fallback is used; nothing is synthesized (P0-6).
    """
    payload_dict = dict(payload)
    sources = _collect_sources(payload_dict)
    if len(sources) > MAX_SERIES:
        raise AppError(422, "TOO_MANY_SERIES", f"At most {MAX_SERIES} series per query.")
    mode = str(payload_dict.get("mode") or "operational").lower()
    if mode not in {"operational", "recorded", "reconstructed"}:
        mode = "operational"
    start_val = payload_dict.get("start") or payload_dict.get("from_ts") or payload_dict.get("from")
    end_val = payload_dict.get("end") or payload_dict.get("to_ts") or payload_dict.get("to")
    start_dt, end_dt = _parse_time_bounds(start_val, end_val, payload_dict.get("range"))
    if end_dt - start_dt > timedelta(days=366):
        raise AppError(422, "RANGE", "The Historian window is limited to 366 days.")
    max_points = min(max(int(payload_dict.get("max_points") or payload_dict.get("limit") or DEFAULT_MAX_POINTS), 1),
                     int(payload_dict.get("_max_points_cap") or 5000))
    cursor = str(payload_dict.get("cursor")) if payload_dict.get("cursor") else None
    bucket_ms = int(payload_dict["bucket_ms"]) if payload_dict.get("bucket_ms") else None
    if bucket_ms is not None and not 1000 <= bucket_ms <= 86_400_000:
        raise AppError(422, "BUCKET", "Bucket must be between 1 second and 1 day.")
    try:
        compare_ms = HSRC.parse_offset_ms(payload_dict.get("compare_offset"))
    except ValueError as exc:
        raise AppError(422, "INVALID_COMPARE_OFFSET", str(exc)) from exc
    resolution = str(payload_dict.get("resolution") or ("bucket" if bucket_ms else "auto")).lower()
    if resolution not in {"auto", "raw", "bucket"}:
        resolution = "auto"
    quality_filter = payload_dict.get("quality_filter") or payload_dict.get("quality")

    # ---- PostgreSQL phase (one session, sequential)
    await _enrich_sources(session, tenant_id, sources)
    for src in sources:
        if src.kind == "subtable" and src.database and src.table and not await _tenant_owns_database(session, tenant_id, src.database):
            raise AppError(404, "NOT_FOUND", f"Subtable '{src.database}.{src.table}' not found")
    active_epoch_num = await _active_epoch(session, tenant_id)
    provider = history_provider or get_history_provider()
    ctx = _SeriesContext(
        reader=HSRC.TableSeriesReader(provider.client) if provider is not None else None,
        tenant_id=tenant_id, tenant_db=tenant_td_database(tenant_id), epoch=active_epoch_num, mode=mode,
        resolution=resolution, max_points=max_points, cursor=cursor, bucket_ms=bucket_ms,
    )
    # Session-bound series (PG fallback, designer recorded/reconstructed) cannot run concurrently.
    session_bound: dict[str, dict[str, Any]] = {}
    for window in [(start_dt, end_dt)] + ([(start_dt - timedelta(milliseconds=compare_ms),
                                            end_dt - timedelta(milliseconds=compare_ms))] if compare_ms else []):
        for src in sources:
            if src.kind == "signal" and src.value_type and (provider is None or mode in ("recorded", "reconstructed")):
                key = f"{src.key}|{window[0].isoformat()}"
                if provider is None:
                    info = await _pg_signal_points(session, tenant_id, src, window[0], window[1], max_points)
                    info["fidelity"] = "postgres_fallback"
                    info["notes"] = ["TDengine history is not configured; showing PostgreSQL observations."]
                else:
                    info = await _legacy_mode_points(provider, session, tenant_id, src, window[0], window[1], mode,
                                                     max_points, cursor, active_epoch_num)
                    info["fidelity"] = "managed_recorded" if mode == "recorded" else "reconstructed"
                session_bound[key] = info

    # ---- TDengine phase (concurrent, no session)
    sem = asyncio.Semaphore(TD_PARALLEL)

    async def one(src: HSRC.SeriesSource, w_start: datetime, w_end: datetime) -> dict[str, Any]:
        pre = session_bound.get(f"{src.key}|{w_start.isoformat()}")
        if pre is not None:
            return pre
        async with sem:
            return await _series_info(ctx, src, w_start, w_end)

    windows = [(start_dt, end_dt)]
    if compare_ms:
        shift = timedelta(milliseconds=compare_ms)
        windows.append((start_dt - shift, end_dt - shift))
    infos = await asyncio.gather(*[one(src, w0, w1) for (w0, w1) in windows for src in sources])
    main = [_series_result(src, infos[i], start_dt, end_dt, mode, quality_filter) for i, src in enumerate(sources)]
    compare: dict[str, Any] | None = None
    if compare_ms:
        w0, w1 = windows[1]
        prev = [_series_result(src, infos[len(sources) + i], w0, w1, mode, quality_filter) for i, src in enumerate(sources)]
        shift = timedelta(milliseconds=compare_ms)
        for sr in prev:
            for pt in sr["points"]:
                moved = HSRC._utc(pt["ts"])
                if moved is not None:
                    pt["original_ts"] = pt["ts"]
                    pt["ts"] = iso_ms(moved + shift)
        compare = {"offset_ms": compare_ms, "start": _z(w0), "end": _z(w1),
                   "series_list": prev, "stats": [sr["stats"] for sr in prev]}

    return {
        "mode": mode,
        "start": _z(start_dt),
        "end": _z(end_dt),
        "compare": compare,
        "resolution": resolution,
        "bucket_ms": bucket_ms,
        "agg": "avg" if any(sr["downsampled"] for sr in main) else None,
        "max_points": max_points,
        "downsampled": any(sr["downsampled"] for sr in main),
        "history_available": provider is not None,
        # Per-series summary by key (no points; the points are only in series_list).
        "series": {sr["series_key"]: {k: v for k, v in sr.items() if k not in ("points", "quality_segments")} for sr in main},
        "series_list": main,
        "stats": [sr["stats"] for sr in main],
        "next_cursor": next((sr["next_cursor"] for sr in main if sr.get("next_cursor")), None),
        "coverage_notes": [n for sr in main for n in sr["coverage_notes"]],
    }


def _z(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


@dataclass
class _SeriesContext:
    reader: HSRC.TableSeriesReader | None
    tenant_id: UUID
    tenant_db: str
    epoch: int
    mode: str
    resolution: str
    max_points: int
    cursor: str | None
    bucket_ms: int | None


async def _series_info(ctx: _SeriesContext, src: HSRC.SeriesSource, start_dt: datetime, end_dt: datetime) -> dict[str, Any]:
    """TDengine read of one series in one window; never raises for data problems (status + note)."""
    info: dict[str, Any] = {"points": [], "total": 0, "notes": list(src.notes), "fidelity": "operational_full"}
    kw = dict(start_dt=start_dt, end_dt=end_dt, epoch=ctx.epoch, resolution=ctx.resolution,
              max_points=ctx.max_points, cursor=ctx.cursor, bucket_ms=ctx.bucket_ms)
    try:
        if src.kind == "signal" and src.value_type and src.signal_id is not None:
            if ctx.reader is None:
                return {**info, "status": "UNAVAILABLE"}
            info.update(await _read_table_series(
                ctx.reader, src, db=ctx.tenant_db, table=op_subtable_name(src.signal_id, src.value_type), value_col="val",
                record_kind="RAW_OPERATIONAL", schema=HSRC.operational_schema(src.value_type), **kw))
        elif src.kind == "model_field" and src.model_id:
            if ctx.reader is None:
                info["notes"].append("TDengine history is not configured.")
                return {**info, "status": "UNAVAILABLE"}
            if src.table and src.database:
                info["fidelity"] = "managed_recorded"
                info["notes"].append(f"Recorded in {src.database}.{src.table} ({src.column}); rows are changes only.")
                info.update(await _read_table_series(ctx.reader, src, db=src.database, table=src.table,
                                                     value_col=src.column, record_kind="MANAGED_RECORDED", **kw))
            else:
                info["fidelity"] = "model_snapshots"
                snap = get_model_snapshot_provider()
                records = await snap.list_snapshots(ctx.tenant_id, src.model_id, limit=500, active_epoch=ctx.epoch) if snap else []
                pts = HSRC.snapshot_points(records, src.field_path or "", start_dt, end_dt)
                info["notes"].append("This field is not recorded. Only the model's recent samples are kept "
                                     f"({len(records)} available); record it in Storage Management for full history.")
                info.update(points=[_point(src, p["ts"], p["value"], p["quality"], "MODEL_SAMPLE") for p in pts], total=len(pts))
        elif src.kind == "subtable" and src.database and src.table:
            if ctx.reader is None:
                info["notes"].append("TDengine history is not configured.")
                return {**info, "status": "UNAVAILABLE"}
            info["fidelity"] = "managed_recorded"
            info.update(await _read_table_series(ctx.reader, src, db=src.database, table=src.table,
                                                 value_col=src.column, record_kind="MANAGED_RECORDED", **kw))
        else:
            info["status"] = "NOT_FOUND"
    except TDEngineError as exc:
        low = str(exc).lower()
        if "not exist" in low or "0x2603" in low or "0x2662" in low:
            info.update(status="NO_DATA", points=[], total=0)
            info["notes"].append("No rows have been stored for this series yet.")
        else:
            info.update(status="ERROR", points=[], total=0)
            info["notes"].append(f"History query failed: {exc}")
            logger.warning("History query failed for %s: %s", src.key, exc)
    return info


def _series_result(src: HSRC.SeriesSource, info: dict[str, Any], start_dt: datetime, end_dt: datetime,
                   mode: str, quality_filter: Any) -> dict[str, Any]:
    status = info.get("status") or "OK"
    points = info.get("points", [])
    times = info.get("times")
    if times is None or len(times) != len(points):
        times = [HSRC._utc(p["ts"]) for p in points]
    if quality_filter and str(quality_filter).upper() != "ALL":
        keep = [i for i, pt in enumerate(points) if str(pt.get("quality") or "").upper() == str(quality_filter).upper()]
        points, times = [points[i] for i in keep], [times[i] for i in keep]
    if status == "OK" and not points:
        status = "NO_DATA"
    downsampled = bool(info.get("downsampled"))
    if downsampled:
        mins = [p["min"] for p in points if p.get("min") is not None]
        maxs = [p["max"] for p in points if p.get("max") is not None]
        cnt = sum(int(p.get("count") or 0) for p in points)
        wsum = sum(float(p["value"]) * int(p.get("count") or 0) for p in points if p.get("value") is not None)
        min_val, max_val = (min(mins) if mins else None), (max(maxs) if maxs else None)
        avg_val = round(wsum / cnt, 6) if cnt else None
        good_count, good_pct, count = None, None, cnt
    else:
        nums = [float(pt["value"]) for pt in points if isinstance(pt.get("value"), (int, float))
                and not isinstance(pt.get("value"), bool) and math.isfinite(float(pt["value"]))]
        min_val = min(nums) if nums else None
        max_val = max(nums) if nums else None
        avg_val = round(sum(nums) / len(nums), 6) if nums else None
        known = [pt for pt in points if pt.get("quality")]
        good_count = sum(1 for pt in known if str(pt["quality"]).upper() == "GOOD")
        good_pct = round(good_count / len(known) * 100.0, 1) if known else None
        count = len(points)
    if downsampled:
        gap_threshold = int(info.get("bucket_ms") or 0) or None
    elif src.kind == "signal" and mode == "operational":
        gap_threshold = canonical_stale_after_ms(src.expected_interval_ms or 1000)
    else:
        gap_threshold = None
    gaps = HSRC.gap_stats([t for t in times if t is not None], start_dt, end_dt, gap_threshold) if status != "ERROR" else {}
    total = info.get("total")
    stats = {
        "signal_id": src.key, "series_key": src.key, "key": src.label or src.key, "display_name": src.label or src.key,
        "unit": src.unit, "value_type": src.value_type, "min": min_val, "max": max_val, "avg": avg_val,
        "last": points[-1]["value"] if points else None, "last_ts": points[-1]["ts"] if points else None,
        "count": count, "total": total if total is not None else count, "good_count": good_count, "good_pct": good_pct,
        "fidelity": info.get("fidelity"), "first": points[0]["value"] if points else None,
        "first_ts": points[0]["ts"] if points else None, "gap_count": gaps.get("gap_count"),
        "longest_gap_ms": gaps.get("longest_gap_ms"), "coverage_pct": gaps.get("coverage_pct"),
        "gap_threshold_ms": gap_threshold,
    }
    notes = list(info.get("notes") or [])
    info.pop("times", None)
    return {
        "signal_id": src.key, "series_key": src.key, "source_kind": src.kind, "key": src.label or src.key,
        "display_name": src.label or src.key, "resource_id": src.resource_id, "resource_name": src.resource_name,
        "value_type": src.value_type, "unit": src.unit, "mode": mode, "fidelity": info.get("fidelity"),
        "status": status, "points": points, "total": total if total is not None else len(points),
        "downsampled": downsampled, "bucket_ms": info.get("bucket_ms"), "truncated": bool(info.get("truncated")),
        "next_cursor": info.get("next_cursor"), "column": info.get("column"), "stats": stats,
        "quality_segments": [] if downsampled else _build_quality_segments(
            [(t, str(p.get("quality") or "").upper()) for t, p in zip(times, points, strict=False) if t is not None and p.get("quality")],
            start_dt, end_dt, timedelta(milliseconds=canonical_stale_after_ms(src.expected_interval_ms or 1000))),
        "coverage_notes": notes,
    }


async def _pg_signal_points(session: AsyncSession, tenant_id: UUID, src: HSRC.SeriesSource,
                            start_dt: datetime, end_dt: datetime, max_points: int) -> dict[str, Any]:
    obs_rows = await fetch_all(
        session,
        """
        SELECT id, signal_id, received_time, event_time, source_time, value_json, value_type, unit, quality
        FROM observations
        WHERE tenant_id = :tenant_id AND signal_id = :signal_id
          AND event_time >= :start_dt AND event_time < :end_dt
        ORDER BY event_time ASC
        LIMIT :lim
        """,
        {"tenant_id": tenant_id, "signal_id": src.signal_id, "start_dt": start_dt, "end_dt": end_dt,
         "lim": max_points},
    )
    pts = []
    for o in obs_rows:
        ts = o.get("event_time") or o.get("received_time")
        if ts is None:
            continue
        v_val = _safe_json_dict(o.get("value_json")).get("v") if o.get("value_json") else None
        pts.append(_point(src, ts, v_val, str(o.get("quality") or "").upper() or None, "RAW_OPERATIONAL",
                          {"source_time": iso_ms(o["source_time"]) if o.get("source_time") else None}))
    pts.sort(key=lambda p: p["ts"])
    return {"points": pts, "total": len(pts), "truncated": len(pts) >= max_points}


async def _legacy_mode_points(provider: TDengineHistoryRepository, session: AsyncSession, tenant_id: UUID,
                              src: HSRC.SeriesSource, start_dt: datetime, end_dt: datetime, mode: str,
                              max_points: int, cursor: str | None, epoch: int) -> dict[str, Any]:
    """Recorded / reconstructed signal history (designer datasets), paged to ``max_points``."""
    pts: list[dict[str, Any]] = []
    notes: list[str] = []
    cur = cursor
    win_end = min(end_dt, start_dt + timedelta(days=31))
    if win_end < end_dt:
        notes.append("Recorded/reconstructed views are limited to 31 days; showing the first 31 days.")
    next_cursor = None
    while len(pts) < max_points:
        page = await provider.query_raw(
            tenant_id, signal_id=src.signal_id, start=start_dt, end=win_end, limit=min(2000, max_points - len(pts)),
            cursor=cur, mode=mode, session=session, value_type=src.value_type, active_epoch=epoch,  # type: ignore[arg-type]
        )
        notes = list(dict.fromkeys([*notes, *page.coverage_notes]))
        for p in page.items:
            pts.append(_point(src, p.event_time, p.value, p.quality, p.record_kind,
                              {"source_time": iso_ms(p.source_time) if p.source_time else None,
                               "reason_code": p.reason_code, "event_uid": p.event_uid, "virtual": p.virtual,
                               "data_epoch": p.data_epoch}))
        if not page.next_cursor:
            break
        cur = page.next_cursor
        next_cursor = page.next_cursor
    else:
        next_cursor = cur
    return {"points": pts, "total": len(pts), "next_cursor": next_cursor if len(pts) >= max_points else None,
            "notes": notes}


def _build_quality_segments(
    points: list[dict[str, Any]] | list[tuple[datetime, str]],
    start_dt: datetime,
    end_dt: datetime,
    hold_delta: timedelta,
) -> list[dict[str, Any]]:
    """Quality timeline: consecutive points of the same quality form ONE segment; a silence longer
    than ``hold_delta`` after a GOOD/UNCERTAIN point becomes a STALE segment (was one segment per point)."""
    segments: list[dict[str, Any]] = []

    raw: list[list[Any]] = []  # [start, end, quality, reason] as datetimes; rendered once at the end

    def push(a: datetime, b: datetime, q: str, reason: str | None = None) -> None:
        if b <= a:
            return
        last = raw[-1] if raw else None
        if last and last[2] == q and last[1] == a and last[3] == reason:
            last[1] = b
        else:
            raw.append([a, b, q, reason])

    parsed = [p if isinstance(p, tuple) else (HSRC._utc(p["ts"]), str(p.get("quality") or "").upper()) for p in points]
    parsed = [(t, q) for t, q in parsed if t is not None]
    for i, (ts, qual) in enumerate(parsed):
        nxt = parsed[i + 1][0] if i + 1 < len(parsed) else end_dt
        norm = "GOOD" if qual == "GOOD" else ("UNCERTAIN" if qual in {"UNCERTAIN", "WARN", "DELAYED"} else
                                              ("STALE" if qual in {"STALE", "PAUSED"} else "BAD"))
        held = min(nxt, ts + hold_delta) if norm in {"GOOD", "UNCERTAIN"} else nxt
        push(ts, held, norm)
        if held < nxt:
            push(held, nxt, "STALE", "STALE_GAP")
    segments.extend({"start": _iso(a), "end": _iso(b), "quality": q, "reason_code": r} for a, b, q, r in raw)
    return segments


# ==============================================================================
# S12 Historian Events Feed
# ==============================================================================


async def list_historian_events(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    signal_ids: Sequence[UUID | str] | None = None,
    signals: Sequence[UUID | str] | None = None,
    design_id: UUID | str | None = None,
    start: str | datetime | None = None,
    end: str | datetime | None = None,
    range_preset: str | None = None,
    types: Sequence[str] | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    """Return chronological quality transitions, storage operations, and epoch reset markers."""
    start_dt, end_dt = _parse_time_bounds(start, end, range_preset)
    bounded_limit = min(max(int(limit), 1), 500)
    events: list[dict[str, Any]] = []
    effective_sig_ids = signal_ids if signal_ids is not None else signals

    # 1. Storage Operations
    op_clauses = ["tenant_id = :tenant_id", "requested_at >= :start_dt", "requested_at <= :end_dt"]
    op_params: dict[str, Any] = {"tenant_id": tenant_id, "start_dt": start_dt, "end_dt": end_dt}
    if design_id:
        d_id = _safe_uuid(design_id)
        if d_id:
            op_clauses.append("(target_id = :design_id OR step_state_json->>'design_id' = :did_str)")
            op_params["design_id"] = d_id
            op_params["did_str"] = str(d_id)

    op_rows = await fetch_all(
        session,
        f"""
        SELECT id, operation_type, target_type, target_id, status, requested_at, completed_at
        FROM storage_operations
        WHERE {' AND '.join(op_clauses)}
        ORDER BY requested_at DESC
        LIMIT :lim
        """,
        {**op_params, "lim": bounded_limit},
    )
    for r in op_rows:
        events.append(
            {
                "id": str(r["id"]),
                "ts": iso_ms(r["requested_at"]),
                "timestamp": iso_ms(r["requested_at"]),
                "kind": "STORAGE_OPERATION",
                "design_id": str(r["target_id"]) if r.get("target_id") else None,
                "summary": f"{r['operation_type']} ({r['status']})",
                "message": f"{r['operation_type']} on {r['target_type']} ({r['status']})",
            }
        )

    # 2. Telemetry epoch resets
    epoch_rows = await fetch_all(
        session,
        """
        SELECT active_epoch, updated_at, reset_operation_id
        FROM telemetry_generations
        WHERE tenant_id = :tenant_id AND updated_at >= :start_dt AND updated_at <= :end_dt
        """,
        {"tenant_id": tenant_id, "start_dt": start_dt, "end_dt": end_dt},
    )
    for er in epoch_rows:
        events.append(
            {
                "id": f"epoch-{er['active_epoch']}",
                "ts": iso_ms(er["updated_at"]),
                "timestamp": iso_ms(er["updated_at"]),
                "kind": "EPOCH_RESET",
                "data_epoch": int(er["active_epoch"]),
                "summary": f"Telemetry Epoch Reset: Active Epoch {er['active_epoch']}",
                "message": f"Telemetry Epoch boundary advanced to {er['active_epoch']}",
            }
        )

    # 3. Quality transitions — real history (D3): TDengine STATE_WINDOW over the stored raw quality of
    #    each requested signal in the window (not the current latest state). Only computed when the
    #    caller names signals and asks for them (or does not filter by type).
    wanted = {t.strip().upper() for t in types or [] if t.strip()}
    sig_uuids = [u for u in (_safe_uuid(s) for s in (effective_sig_ids or [])) if u is not None][:MAX_SERIES]
    provider = get_history_provider()
    if sig_uuids and provider is not None and (not wanted or "QUALITY_TRANSITION" in wanted):
        active_epoch_num = await _active_epoch(session, tenant_id)
        meta_rows = await fetch_all(
            session,
            "SELECT id, key, data_type FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
            {"tenant_id": tenant_id, "ids": sig_uuids},
        )
        db = tenant_td_database(tenant_id)
        sem = asyncio.Semaphore(TD_PARALLEL)

        async def transitions(row: Mapping[str, Any]) -> list[dict[str, Any]]:
            table = op_subtable_name(as_uuid(row["id"]), str(row.get("data_type") or "float64"))
            sql = (
                f"SELECT _wstart AS ws, _wend AS we, raw_quality AS q, COUNT(*) AS n FROM {quote_fq_table(db, table)} "
                f"WHERE ts >= {HSRC.ts_literal(start_dt)} AND ts < {HSRC.ts_literal(end_dt)} "
                f"AND data_epoch >= {int(active_epoch_num)} STATE_WINDOW(raw_quality) LIMIT {bounded_limit + 1}"
            )
            async with sem:
                try:
                    windows = await provider.client.query_rows(sql)
                except TDEngineError as exc:
                    if "not exist" not in str(exc).lower():
                        logger.warning("Quality transition query failed for %s: %s", row["id"], exc)
                    return []
            out: list[dict[str, Any]] = []
            prev: str | None = None
            for w in windows or []:
                q = str(w.get("q") or "UNKNOWN").upper()
                ts_val = HSRC._utc(w.get("ws"))
                if prev is not None and q != prev and ts_val is not None:
                    out.append({
                        "id": f"qual-{row['id']}-{iso_ms(ts_val)}",
                        "ts": iso_ms(ts_val), "timestamp": iso_ms(ts_val), "kind": "QUALITY_TRANSITION",
                        "signal_id": str(row["id"]), "signal_key": str(row["key"]),
                        "from_state": prev, "to_state": q, "quality": q, "samples": int(w.get("n") or 0),
                        "until": iso_ms(HSRC._utc(w.get("we"))) if w.get("we") else None,
                        "summary": f"{row['key']}: {prev} \u2192 {q}",
                        "message": f"Signal {row['key']} quality changed from {prev} to {q}",
                    })
                prev = q
            return out

        for chunk in await asyncio.gather(*[transitions(r) for r in meta_rows]):
            events.extend(chunk)

    if types:
        wanted = {t.strip().upper() for t in types if t.strip()}
        events = [e for e in events if str(e.get("kind", "")).upper() in wanted]

    events.sort(key=lambda e: str(e.get("ts") or ""), reverse=True)
    return {"items": events[:bounded_limit]}


# ==============================================================================
# S12 Saved Views (backed by saved_queries table)
# ==============================================================================


async def list_saved_views(
    session: AsyncSession, tenant_id: UUID, *, q: str | None = None, limit: int = 100, actor_id: UUID | None = None,
) -> list[dict[str, Any]]:
    """Saved views (see :mod:`factorix.modules.historian_views`)."""
    return await HV.list_views(session, tenant_id, actor_id, q=q, limit=limit)


async def create_saved_view(
    session: AsyncSession, tenant_id: UUID, actor_id: UUID | None, payload: Mapping[str, Any], correlation_id: str = "",
) -> dict[str, Any]:
    return await HV.create_view(session, tenant_id, actor_id, payload)


async def delete_saved_view(
    session: AsyncSession,
    tenant_id: UUID,
    view_id_or_actor: UUID,
    view_id: UUID | None = None,
    *,
    actor_id: UUID | None = None,
    correlation_id: str = "",
) -> None:
    actor = view_id_or_actor if view_id is not None else actor_id
    await HV.delete_view(session, tenant_id, actor, view_id if view_id is not None else view_id_or_actor)


# ==============================================================================
# S12 Historian CSV Exports (backed by export_jobs table)
# ==============================================================================


async def create_export_job(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    payload: Mapping[str, Any],
    *,
    history_provider: TDengineHistoryRepository | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Create and immediately generate a formula-injection-safe CSV export job."""
    payload_dict = dict(payload)
    if not actor_id:
        # Fallback to first admin of tenant if not supplied
        admin_row = await fetch_one(session, "SELECT id FROM admin_accounts WHERE tenant_id = :tenant_id LIMIT 1", {"tenant_id": tenant_id})
        actor_id = as_uuid(admin_row["id"]) if admin_row else uuid4()

    job_id = uuid4()
    now = utcnow()
    expires_at = now + timedelta(days=7)
    fmt = str(payload_dict.get("format") or "csv").lower()
    if fmt not in {"csv", "json"}:
        raise AppError(422, "EXPORT_FORMAT", "Supported export formats: csv, json.")
    file_name = str(payload_dict.get("file_name") or f"historian-export-{str(job_id)[:8]}.{fmt}").strip()
    file_name = re.sub(r"[^A-Za-z0-9._-]+", "_", file_name)[:120] or f"historian-export.{fmt}"
    if not file_name.lower().endswith(f".{fmt}"):
        file_name = f"{file_name.rsplit('.', 1)[0]}.{fmt}"
    active_epoch_num = await _active_epoch(session, tenant_id)

    # Exports contain every raw row of the window (no 250-row first page, R1-08), per series up to a
    # hard cap that is reported in the job instead of being applied silently.
    export_payload = {**payload_dict, "resolution": "raw", "max_points": EXPORT_MAX_ROWS_PER_SERIES,
                      "_max_points_cap": EXPORT_MAX_ROWS_PER_SERIES}
    export_payload.pop("cursor", None)
    query_res = await query_historian(session, tenant_id, export_payload, history_provider=history_provider)
    labels = payload_dict.get("labels") if isinstance(payload_dict.get("labels"), dict) else {}
    pts = []
    for sr in query_res.get("series_list", []):
        name = sr["display_name"] if sr.get("resource_name") or sr["display_name"] != sr["series_key"] else labels.get(sr["series_key"], sr["display_name"])
        for pt in sr["points"]:
            pts.append({**pt, "signal_id": sr["series_key"], "signal_key": name, "unit": sr.get("unit")})
    pts.sort(key=lambda pt: str(pt.get("ts") or ""))
    truncated_series = [sr["display_name"] for sr in query_res.get("series_list", []) if len(sr["points"]) >= EXPORT_MAX_ROWS_PER_SERIES]

    # Build formula-injection-safe CSV using csv_row and csv_cell
    header = [
        "timestamp",
        "signal_id",
        "signal_key",
        "value",
        "quality",
        "unit",
        "source_time",
        "reason_code",
        "record_kind",
        "virtual",
        "event_uid",
        "data_epoch",
    ]
    rows_text: list[str] = [csv_row(header)]

    for pt in pts:
        row_vals = [
            pt.get("acquired_at") or pt.get("ts") or pt.get("event_time"),
            pt.get("signal_id"),
            pt.get("signal_key") or "",
            pt.get("value"),
            pt.get("quality"),
            pt.get("unit") or "",
            pt.get("source_time") or "",
            pt.get("reason_code") or "",
            pt.get("record_kind") or "RAW_OPERATIONAL",
            "true" if pt.get("virtual") else "false",
            pt.get("event_uid") or "",
            pt.get("data_epoch") or active_epoch_num,
        ]
        rows_text.append(csv_row(row_vals))

    csv_text = "\r\n".join(rows_text) + "\r\n"
    if fmt == "json":
        csv_text = json.dumps(
            {"mode": query_res.get("mode"), "start": query_res.get("start"), "end": query_res.get("end"),
             "truncated_series": truncated_series,
             "rows": [{k: pt.get(k) for k in ("ts", "series_key", "signal_key", "value", "quality", "unit",
                                               "record_kind", "source_time", "reason_code")} for pt in pts]},
            ensure_ascii=False, default=str,
        )
    byte_size = len(csv_text.encode("utf-8"))
    row_count = len(pts)

    await execute(
        session,
        """
        INSERT INTO export_jobs (
            id, tenant_id, requested_by, query_json, status, row_count, csv_text,
            format, output_ref, file_name, byte_size, expires_at, started_at,
            completed_at, data_epoch, created_at
        ) VALUES (
            :id, :tenant_id, :actor_id, CAST(:query_json AS jsonb), :status, :row_count, :csv_text,
            :format, :output_ref, :file_name, :byte_size, :expires_at, :now,
            :now, :epoch, :created_at
        )
        """,
        {
            "id": job_id,
            "tenant_id": tenant_id,
            "actor_id": actor_id,
            "query_json": _dump_json({**payload_dict, "_result": {
                "series": [sr["display_name"] for sr in query_res.get("series_list", [])],
                "truncated_series": truncated_series, "start": query_res.get("start"), "end": query_res.get("end"),
            }}),
            "status": "COMPLETED",
            "format": fmt,
            "row_count": row_count,
            "csv_text": csv_text,
            "output_ref": f"db://export_jobs/{job_id}",
            "file_name": file_name,
            "byte_size": byte_size,
            "expires_at": expires_at,
            "now": now,
            "epoch": active_epoch_num,
            "created_at": now,
        },
    )

    return {
        "id": str(job_id),
        "status": "COMPLETED",
        "format": fmt,
        "truncated_series": truncated_series,
        "progress_pct": 100,
        "title": str(payload_dict.get("title") or "").strip()[:300] or None,
        "labels": payload_dict.get("labels") if isinstance(payload_dict.get("labels"), dict) else {},
        "series": [sr["display_name"] for sr in query_res.get("series_list", [])],
        "start": query_res.get("start"),
        "end": query_res.get("end"),
        "file_name": file_name,
        "row_count": row_count,
        "byte_size": byte_size,
        "query_spec": payload_dict,
        "data_epoch": active_epoch_num,
        "created_at": iso_ms(now),
        "completed_at": iso_ms(now),
        "expires_at": iso_ms(expires_at),
        "download_url": f"/api/v1/historian/exports/{job_id}/download",
    }


_EXPORT_COLUMNS = """
        SELECT id, status, format, file_name, row_count, byte_size, query_json,
               error_code, error_message, data_epoch, created_at, started_at, completed_at, expires_at
        FROM export_jobs
"""


def _export_item(r: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    exp_at = r.get("expires_at")
    status_val = str(r.get("status") or "COMPLETED").upper()
    if exp_at and exp_at < now and status_val != "EXPIRED":
        status_val = "EXPIRED"
    spec = _safe_json_dict(r.get("query_json"))
    result = spec.pop("_result", {}) if isinstance(spec.get("_result"), dict) else {}
    series = result.get("series") or []
    title = str(spec.get("title") or "").strip()[:300] or (
        f"{len(series)} series · {result.get('start') or spec.get('start') or spec.get('range') or ''}"
        f" → {result.get('end') or spec.get('end') or ''} · {spec.get('mode') or 'operational'}"
    )
    return {
        "id": str(r["id"]),
        "status": status_val,
        "progress_pct": 100 if status_val in ("COMPLETED", "READY", "FAILED", "EXPIRED", "CANCELLED") else 0,
        "title": title,
        "series": series,
        "start": result.get("start"),
        "end": result.get("end"),
        "mode": spec.get("mode") or "operational",
        "truncated_series": result.get("truncated_series") or [],
        "format": str(r.get("format") or "csv").lower(),
        "file_name": str(r.get("file_name") or f"export-{str(r['id'])[:8]}.csv"),
        "row_count": int(r["row_count"]) if r.get("row_count") is not None else None,
        "byte_size": int(r["byte_size"]) if r.get("byte_size") is not None else None,
        "query_spec": spec,
        "error_code": r.get("error_code"),
        "error_message": r.get("error_message"),
        "data_epoch": int(r.get("data_epoch") or 1),
        "created_at": iso_ms(r.get("created_at") or now),
        "started_at": iso_ms(r["started_at"]) if r.get("started_at") else None,
        "completed_at": iso_ms(r["completed_at"]) if r.get("completed_at") else None,
        "expires_at": iso_ms(exp_at) if exp_at else None,
        "download_url": f"/api/v1/historian/exports/{r['id']}/download" if status_val in ("COMPLETED", "READY") else None,
    }


async def list_export_jobs(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    status: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Export jobs of the tenant, newest first, with progress and a readable title."""
    rows = await fetch_all(
        session,
        _EXPORT_COLUMNS + """
        WHERE tenant_id = :tenant_id AND (CAST(:status AS text) IS NULL OR UPPER(status) = :status)
        ORDER BY created_at DESC
        LIMIT :lim
        """,
        {"tenant_id": tenant_id, "lim": min(max(int(limit), 1), 200),
         "status": str(status).strip().upper() if status else None},
    )
    now = utcnow()
    return [_export_item(r, now) for r in rows]


async def get_export_job(
    session: AsyncSession,
    tenant_id: UUID,
    export_id: UUID,
    *,
    correlation_id: str = "",
) -> dict[str, Any]:
    r = await fetch_one(session, _EXPORT_COLUMNS + " WHERE tenant_id = :tenant_id AND id = :id",
                        {"tenant_id": tenant_id, "id": export_id})
    if not r:
        raise AppError(404, "NOT_FOUND", f"Export job {export_id} not found.")
    return _export_item(r, utcnow())


async def cancel_export_job(
    session: AsyncSession,
    tenant_id: UUID,
    actor_or_export_id: UUID,
    export_id: UUID | None = None,
    *,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Cancel a pending export job."""
    target_id = export_id if export_id is not None else actor_or_export_id
    r = await fetch_one(
        session,
        "SELECT id, status FROM export_jobs WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": target_id},
    )
    if not r:
        raise AppError(404, "NOT_FOUND", f"Export job {target_id} not found.")

    await execute(
        session,
        "UPDATE export_jobs SET status = 'CANCELLED' WHERE id = :id AND tenant_id = :tenant_id",
        {"id": target_id, "tenant_id": tenant_id},
    )
    return await get_export_job(session, tenant_id, target_id, correlation_id=correlation_id)


async def retry_export_job(
    session: AsyncSession,
    tenant_id: UUID,
    actor_or_export_id: UUID,
    export_id: UUID | None = None,
    *,
    history_provider: TDengineHistoryRepository | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Retry an export job."""
    target_id = export_id if export_id is not None else actor_or_export_id
    actor_id = actor_or_export_id if export_id is not None else None
    job = await get_export_job(session, tenant_id, target_id, correlation_id=correlation_id)
    return await create_export_job(
        session,
        tenant_id,
        actor_id,
        job.get("query_spec") or {},
        history_provider=history_provider,
        correlation_id=correlation_id,
    )


async def download_export_csv(
    session: AsyncSession,
    tenant_id: UUID,
    export_id: UUID,
    *,
    correlation_id: str = "",
) -> tuple[str, str]:
    """Retrieve the CSV text and file name for an export job, enforcing tenant isolation and expiry (HTTP 410)."""
    r = await fetch_one(
        session,
        """
        SELECT id, file_name, csv_text, status, expires_at
        FROM export_jobs
        WHERE tenant_id = :tenant_id AND id = :id
        """,
        {"tenant_id": tenant_id, "id": export_id},
    )
    if not r:
        raise AppError(404, "NOT_FOUND", f"Export job {export_id} not found.")

    exp_at = r.get("expires_at")
    status_val = str(r.get("status") or "COMPLETED").upper()
    if (exp_at and exp_at < utcnow()) or status_val == "EXPIRED":
        raise AppError(410, "EXPORT_EXPIRED", "This export file has expired.")

    if status_val not in {"COMPLETED", "READY"}:
        raise AppError(409, "EXPORT_NOT_READY", f"Export job is in status {status_val}.")

    csv_text = str(r.get("csv_text") or r.get("csv_content") or "")
    file_name = str(r.get("file_name") or f"export-{str(export_id)[:8]}.csv")
    return csv_text, file_name
