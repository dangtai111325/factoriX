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

from collections.abc import Mapping, Sequence
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
                end_dt = now

    start_dt: datetime = end_dt - timedelta(minutes=15)
    if start_raw:
        if isinstance(start_raw, datetime):
            start_dt = start_raw.replace(tzinfo=timezone.utc) if start_raw.tzinfo is None else start_raw.astimezone(timezone.utc)
        else:
            try:
                start_dt = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
            except ValueError:
                start_dt = end_dt - timedelta(minutes=15)

    if start_dt >= end_dt:
        start_dt = end_dt - timedelta(minutes=15)

    return start_dt, end_dt


async def _active_epoch(session: AsyncSession, tenant_id: UUID) -> int:
    try:
        row = await fetch_one(
            session,
            """
            SELECT active_epoch
            FROM telemetry_generations
            WHERE tenant_id = :tenant_id
            """,
            {"tenant_id": tenant_id},
        )
        if row and row.get("active_epoch") is not None:
            return int(row["active_epoch"])
    except Exception:
        pass

    try:
        row = await fetch_one(
            session,
            """
            SELECT max(active_epoch) AS active_epoch
            FROM telemetry_reset_operations
            WHERE tenant_id = :tenant_id AND status = 'SUCCEEDED'
            """,
            {"tenant_id": tenant_id},
        )
        if row and row.get("active_epoch") is not None:
            return int(row["active_epoch"])
    except Exception:
        pass

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


def _point(src: HSRC.SeriesSource, ts: datetime, value: Any, quality: str | None, record_kind: str,
           extra: dict[str, Any] | None = None) -> dict[str, Any]:
    t = iso_ms(ts)
    pt = {
        "id": f"{src.key}@{t}",
        "ts": t,
        "event_time": t,
        "acquired_at": t,
        "source_time": None,
        "series_key": src.key,
        "signal_id": str(src.signal_id) if src.signal_id else src.key,
        "signal_key": src.label,
        "value": value,
        "value_type": src.value_type,
        "unit": src.unit,
        "quality": quality,
        "record_kind": record_kind,
        "virtual": False,
    }
    if extra:
        pt.update(extra)
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
) -> dict[str, Any]:
    schema = await reader.schema(db, table)
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
    total = await reader.count(db, table, ts_col, value_col, start_dt, end_dt, epoch_col, epoch)
    numeric = base in HSRC.NUMERIC_TYPES
    meta: dict[str, Any] = {"total": total, "column": value_col, "column_type": base, "downsampled": False,
                            "truncated": False, "bucket_ms": None, "next_cursor": None}
    use_buckets = numeric and (resolution == "bucket" or (resolution == "auto" and total > max_points))
    if use_buckets:
        bms = bucket_ms or HSRC.choose_bucket_ms(start_dt, end_dt, max_points)
        rows = await reader.buckets(db, table, ts_col, value_col, quality_col, start_dt, end_dt, epoch_col, epoch, bms)
        meta.update(downsampled=True, bucket_ms=bms)
        meta["points"] = [
            _point(src, r["ts"], r["avg"], None, "AGGREGATE",
                   {"min": r["min"], "max": r["max"], "count": r["count"], "last": r["last"]})
            for r in rows
        ]
        return meta
    after = None
    if cursor and resolution == "raw":
        after = HSRC._utc(cursor)
    newest = resolution == "auto" and total > max_points
    rows = await reader.raw(db, table, ts_col, value_col, quality_col, start_dt, end_dt, epoch_col, epoch,
                            max_points, after=after, newest_first=newest)
    if newest:
        meta["truncated"] = True
    elif resolution == "raw" and len(rows) >= max_points:
        meta["next_cursor"] = iso_ms(rows[-1]["ts"]) if rows else None
    meta["points"] = [
        _point(src, r["ts"], HSRC.decode_value(r["value"], base),
               (str(r["quality"]).upper() if r.get("quality") else None), record_kind)
        for r in rows
    ]
    return meta


_WRITER_COLUMNS = frozenset({
    "event_key", "source_timestamp", "publish_timestamp", "field_source_timestamp", "quality",
    "quality_reason", "is_null", "model_ref", "model_field_path", "model_revision", "data_epoch",
    "source_event_uid", "time_basis", "acquired_at", "source_time", "raw_quality", "reason_code",
    "origin", "unit", "event_uid", "config_rev", "record_kind",
})


async def query_historian(
    session: AsyncSession,
    tenant_id: UUID,
    payload: Mapping[str, Any],
    *,
    history_provider: TDengineHistoryRepository | None = None,
) -> dict[str, Any]:
    """Multi-series Historian query over signals, Data Model fields and user subtables.

    Points always carry ``value`` (singular). No page is silently dropped: ``total`` is the true row
    count of the window, long ranges are downsampled server-side (``downsampled``/``bucket_ms``), raw
    paging returns ``next_cursor``. Without a TDengine history provider the PostgreSQL observation
    fallback is used and labelled; nothing is synthesized (P0-6).
    """
    payload_dict = dict(payload)
    sources = _collect_sources(payload_dict)
    if len(sources) > MAX_SERIES:
        raise AppError(422, "TOO_MANY_SERIES", f"At most {MAX_SERIES} series per query.")
    mode = str(payload_dict.get("mode") or "operational").lower()
    if mode not in {"operational", "recorded", "reconstructed"}:
        mode = "operational"
    time_axis = str(payload_dict.get("time_axis") or "acquired_at").lower()
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
    resolution = str(payload_dict.get("resolution") or ("bucket" if bucket_ms else "auto")).lower()
    if resolution not in {"auto", "raw", "bucket"}:
        resolution = "auto"
    agg = "avg" if resolution == "bucket" or bucket_ms else None
    quality_filter = payload_dict.get("quality_filter") or payload_dict.get("quality")

    await _enrich_sources(session, tenant_id, sources)
    active_epoch_num = await _active_epoch(session, tenant_id)
    provider = history_provider or get_history_provider()
    reader = HSRC.TableSeriesReader(provider.client) if provider is not None else None
    tenant_db = tenant_td_database(tenant_id)

    series_results: list[dict[str, Any]] = []
    all_points: list[dict[str, Any]] = []
    next_cursor_out: str | None = None
    any_downsampled = False
    for src in sources:
        status = "OK"
        notes = list(src.notes)
        info: dict[str, Any] = {"points": [], "total": 0}
        fidelity = "operational_full"
        try:
            if src.kind == "signal" and src.value_type:
                if provider is None:
                    fidelity = "postgres_fallback"
                    notes.append("TDengine history is not configured; showing PostgreSQL observations.")
                    info = await _pg_signal_points(session, tenant_id, src, start_dt, end_dt, max_points)
                elif mode in ("recorded", "reconstructed"):
                    fidelity = "managed_recorded" if mode == "recorded" else "reconstructed"
                    info = await _legacy_mode_points(provider, session, tenant_id, src, start_dt, end_dt, mode,
                                                     max_points, cursor, active_epoch_num)
                    notes.extend(info.pop("notes", []))
                else:
                    assert reader is not None
                    table = op_subtable_name(src.signal_id, src.value_type)
                    info = await _read_table_series(
                        reader, src, db=tenant_db, table=table, value_col="val", start_dt=start_dt, end_dt=end_dt,
                        epoch=active_epoch_num, resolution=resolution, max_points=max_points, cursor=cursor,
                        bucket_ms=bucket_ms, record_kind="RAW_OPERATIONAL",
                    )
            elif src.kind == "model_field" and src.model_id:
                if reader is None:
                    status = "UNAVAILABLE"
                    notes.append("TDengine history is not configured.")
                elif src.table and src.database:
                    fidelity = "managed_recorded"
                    notes.append(f"Recorded in {src.database}.{src.table} ({src.column}); rows are changes only.")
                    info = await _read_table_series(
                        reader, src, db=src.database, table=src.table, value_col=src.column, start_dt=start_dt,
                        end_dt=end_dt, epoch=active_epoch_num, resolution=resolution, max_points=max_points,
                        cursor=cursor, bucket_ms=bucket_ms, record_kind="MANAGED_RECORDED",
                    )
                else:
                    fidelity = "model_snapshots"
                    snap = get_model_snapshot_provider()
                    records = await snap.list_snapshots(tenant_id, src.model_id, limit=500, active_epoch=active_epoch_num) if snap else []
                    pts = HSRC.snapshot_points(records, src.field_path or "", start_dt, end_dt)
                    notes.append(
                        "This field is not recorded. Only the model's recent samples are kept "
                        f"({len(records)} available); record it in Storage Management for full history."
                    )
                    info = {"points": [_point(src, p["ts"], p["value"], p["quality"], "MODEL_SAMPLE") for p in pts],
                            "total": len(pts), "truncated": False}
            elif src.kind == "subtable" and src.database and src.table:
                if not await _tenant_owns_database(session, tenant_id, src.database):
                    raise AppError(404, "NOT_FOUND", f"Subtable '{src.database}.{src.table}' not found")
                if reader is None:
                    status = "UNAVAILABLE"
                    notes.append("TDengine history is not configured.")
                else:
                    fidelity = "managed_recorded"
                    info = await _read_table_series(
                        reader, src, db=src.database, table=src.table, value_col=src.column, start_dt=start_dt,
                        end_dt=end_dt, epoch=active_epoch_num, resolution=resolution, max_points=max_points,
                        cursor=cursor, bucket_ms=bucket_ms, record_kind="MANAGED_RECORDED",
                    )
            else:
                status = "NOT_FOUND"
        except AppError:
            raise
        except TDEngineError as exc:
            if "not exist" in str(exc).lower() or "0x2603" in str(exc).lower() or "0x2662" in str(exc).lower():
                status = "NO_DATA"
                notes.append("No rows have been stored for this series yet.")
            else:
                status = "ERROR"
                notes.append(f"History query failed: {exc}")
                logger.warning("History query failed for %s: %s", src.key, exc)
        points = info.get("points", [])
        if quality_filter and str(quality_filter).upper() != "ALL":
            points = [pt for pt in points if str(pt.get("quality") or "").upper() == str(quality_filter).upper()]
        if status == "OK" and not points:
            status = "NO_DATA"
        any_downsampled = any_downsampled or bool(info.get("downsampled"))
        if info.get("next_cursor") and next_cursor_out is None:
            next_cursor_out = info["next_cursor"]
        if info.get("downsampled"):
            mins = [p["min"] for p in points if p.get("min") is not None]
            maxs = [p["max"] for p in points if p.get("max") is not None]
            cnt = sum(int(p.get("count") or 0) for p in points)
            wsum = sum(float(p["value"]) * int(p.get("count") or 0) for p in points if p.get("value") is not None)
            min_val, max_val = (min(mins) if mins else None), (max(maxs) if maxs else None)
            avg_val = round(wsum / cnt, 6) if cnt else None
            good_count, good_pct = None, None
            count = cnt
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
        last_pt = points[-1] if points else None
        stats = {
            "signal_id": src.key,
            "series_key": src.key,
            "key": src.label or src.key,
            "display_name": src.label or src.key,
            "unit": src.unit,
            "value_type": src.value_type,
            "min": min_val,
            "max": max_val,
            "avg": avg_val,
            "last": last_pt["value"] if last_pt else None,
            "last_ts": last_pt["ts"] if last_pt else None,
            "count": count,
            "total": info.get("total", count),
            "good_count": good_count,
            "good_pct": good_pct,
            "fidelity": fidelity,
        }
        quality_segments = [] if info.get("downsampled") else _build_quality_segments(
            [p for p in points if p.get("quality")], start_dt, end_dt,
            timedelta(milliseconds=canonical_stale_after_ms(1000)),
        )
        series_results.append({
            "signal_id": src.key,
            "series_key": src.key,
            "source_kind": src.kind,
            "key": src.label or src.key,
            "display_name": src.label or src.key,
            "resource_id": src.resource_id,
            "resource_name": src.resource_name,
            "value_type": src.value_type,
            "unit": src.unit,
            "mode": mode,
            "fidelity": fidelity,
            "status": status,
            "points": points,
            "total": info.get("total", len(points)),
            "downsampled": bool(info.get("downsampled")),
            "bucket_ms": info.get("bucket_ms"),
            "truncated": bool(info.get("truncated")),
            "next_cursor": info.get("next_cursor"),
            "column": info.get("column"),
            "stats": stats,
            "quality_segments": quality_segments,
            "coverage_notes": notes,
        })
        all_points.extend(points)

    all_points.sort(key=lambda pt: str(pt.get("ts") or ""))
    sql_preview = _build_sql_preview(
        tenant_id=tenant_id,
        signal_ids=[sr["series_key"] for sr in series_results],
        dataset_key=None,
        mode=mode,
        time_axis=time_axis,
        start_iso=start_dt.isoformat().replace("+00:00", "Z"),
        end_iso=end_dt.isoformat().replace("+00:00", "Z"),
        quality_filter=str(quality_filter) if quality_filter else None,
        bucket_ms=bucket_ms,
        agg=agg,
        limit=max_points,
    )
    return {
        "mode": mode,
        "start": start_dt.isoformat().replace("+00:00", "Z"),
        "end": end_dt.isoformat().replace("+00:00", "Z"),
        "resolution": resolution,
        "bucket_ms": bucket_ms,
        "agg": agg,
        "max_points": max_points,
        "downsampled": any_downsampled,
        "history_available": provider is not None,
        "series": {sr["series_key"]: sr for sr in series_results},
        "series_list": series_results,
        "points": all_points,
        "rows": all_points,
        "items": all_points,
        "stats": [sr["stats"] for sr in series_results],
        "quality_segments": [seg for sr in series_results for seg in sr["quality_segments"]],
        "sql_preview": sql_preview,
        "next_cursor": next_cursor_out,
        "coverage_notes": [n for sr in series_results for n in sr["coverage_notes"]],
    }


async def _pg_signal_points(session: AsyncSession, tenant_id: UUID, src: HSRC.SeriesSource,
                            start_dt: datetime, end_dt: datetime, max_points: int) -> dict[str, Any]:
    obs_rows = await fetch_all(
        session,
        """
        SELECT id, signal_id, signal_key, acquired_at, event_time, source_time,
               value_json, value_type, unit, raw_quality, reason_code, data_epoch
        FROM observations
        WHERE tenant_id = :tenant_id AND signal_id = :signal_id
          AND acquired_at >= :start_dt AND acquired_at < :end_dt
        ORDER BY acquired_at ASC
        LIMIT :lim
        """,
        {"tenant_id": tenant_id, "signal_id": src.signal_id, "start_dt": start_dt, "end_dt": end_dt,
         "lim": max_points},
    )
    pts = []
    for o in obs_rows:
        ts = o.get("acquired_at") or o.get("event_time")
        if ts is None:
            continue
        v_val = _safe_json_dict(o.get("value_json")).get("v") if o.get("value_json") else o.get("value")
        pts.append(_point(src, ts, v_val, str(o.get("raw_quality") or "").upper() or None, "RAW_OPERATIONAL",
                          {"source_time": iso_ms(o["source_time"]) if o.get("source_time") else None,
                           "reason_code": o.get("reason_code"), "data_epoch": o.get("data_epoch")}))
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
    points: list[dict[str, Any]],
    start_dt: datetime,
    end_dt: datetime,
    hold_delta: timedelta,
) -> list[dict[str, Any]]:
    """Build continuous quality segments with gap truncation across STALE boundaries."""
    if not points:
        return []

    segments: list[dict[str, Any]] = []
    for i, pt in enumerate(points):
        ts = datetime.fromisoformat(str(pt["ts"]).replace("Z", "+00:00"))
        next_ts = (
            datetime.fromisoformat(str(points[i + 1]["ts"]).replace("Z", "+00:00"))
            if i + 1 < len(points)
            else end_dt
        )
        qual = str(pt.get("quality") or "GOOD").upper()
        norm_q = "GOOD" if qual == "GOOD" else ("UNCERTAIN" if qual in {"UNCERTAIN", "WARN"} else ("STALE" if qual in {"STALE", "PAUSED"} else "BAD"))

        seg_end = min(next_ts, ts + hold_delta) if norm_q in {"GOOD", "UNCERTAIN"} else next_ts
        segments.append(
            {
                "signal_id": pt.get("signal_id"),
                "start": ts.isoformat().replace("+00:00", "Z"),
                "end": seg_end.isoformat().replace("+00:00", "Z"),
                "quality": norm_q,
                "reason_code": pt.get("reason_code"),
            }
        )

        # If natural end exceeds valid hold window, insert STALE gap marker segment
        if norm_q in {"GOOD", "UNCERTAIN"} and next_ts > seg_end:
            segments.append(
                {
                    "signal_id": pt.get("signal_id"),
                    "start": seg_end.isoformat().replace("+00:00", "Z"),
                    "end": next_ts.isoformat().replace("+00:00", "Z"),
                    "quality": "STALE",
                    "reason_code": "STALE_GAP_TRUNCATED",
                }
            )

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

    # 3. Quality transitions
    active_epoch_num = await _active_epoch(session, tenant_id)
    qual_clauses = ["l.tenant_id = :tenant_id", "l.updated_at >= :start_dt", "l.updated_at <= :end_dt", "l.data_epoch >= :epoch"]
    qual_params: dict[str, Any] = {"tenant_id": tenant_id, "start_dt": start_dt, "end_dt": end_dt, "epoch": active_epoch_num}
    if effective_sig_ids:
        uids = [_safe_uuid(s) for s in effective_sig_ids if _safe_uuid(s)]
        if uids:
            qual_clauses.append("l.signal_id = ANY(:uids)")
            qual_params["uids"] = uids

    qual_rows = await fetch_all(
        session,
        f"""
        SELECT l.signal_id, s.key AS signal_key, l.quality, l.reason_code, l.updated_at, l.data_epoch
        FROM latest_signal_state l
        JOIN signal_definitions s ON s.id = l.signal_id
        WHERE {' AND '.join(qual_clauses)}
        ORDER BY l.updated_at DESC
        LIMIT 50
        """,
        qual_params,
    )
    for qr in qual_rows:
        q_val = str(qr.get("quality") or "GOOD").upper()
        ts_val = qr.get("updated_at") or qr.get("last_acquired_at") or qr.get("source_time") or utcnow()
        events.append(
            {
                "id": f"qual-{qr.get('signal_id')}-{ts_val}",
                "ts": iso_ms(ts_val),
                "timestamp": iso_ms(ts_val),
                "kind": "QUALITY_TRANSITION",
                "signal_id": str(qr.get("signal_id") or ""),
                "signal_key": str(qr.get("signal_key") or ""),
                "to_state": q_val,
                "quality": q_val,
                "reason_code": qr.get("reason_code"),
                "data_epoch": int(qr.get("data_epoch") or active_epoch_num),
                "summary": f"{qr['signal_key']}: quality is {q_val}",
                "message": f"Signal {qr['signal_key']} transitioned to {q_val}",
            }
        )

    if types:
        wanted = {t.strip().upper() for t in types if t.strip()}
        events = [e for e in events if str(e.get("kind", "")).upper() in wanted]

    events.sort(key=lambda e: str(e.get("ts") or ""), reverse=True)
    return {"items": events[:bounded_limit]}


# ==============================================================================
# S12 Saved Views (backed by saved_queries table)
# ==============================================================================


async def list_saved_views(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    q: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List saved queries / views for tenant."""
    clauses = ["tenant_id = :tenant_id"]
    params: dict[str, Any] = {"tenant_id": tenant_id, "lim": min(max(int(limit), 1), 500)}
    if q and q.strip():
        clauses.append("(name ILIKE :q OR description ILIKE :q)")
        params["q"] = f"%{q.strip()}%"

    where_sql = " AND ".join(clauses)
    rows = await fetch_all(
        session,
        f"""
        SELECT id, name, description, query_spec_json, chart_options_json, is_default, version, created_at, updated_at
        FROM saved_queries
        WHERE {where_sql}
        ORDER BY is_default DESC, updated_at DESC
        LIMIT :lim
        """,
        params,
    )
    return [
        {
            "id": str(r["id"]),
            "name": str(r["name"]),
            "description": str(r.get("description") or ""),
            "query_spec": _safe_json_dict(r.get("query_spec_json")),
            "query_spec_json": _safe_json_dict(r.get("query_spec_json")),
            "chart_options": _safe_json_dict(r.get("chart_options_json")),
            "chart_options_json": _safe_json_dict(r.get("chart_options_json")),
            "is_default": bool(r.get("is_default")),
            "version": int(r.get("version") or 1),
            "created_at": iso_ms(r["created_at"]),
            "updated_at": iso_ms(r["updated_at"]),
        }
        for r in rows
    ]


async def create_saved_view(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    payload: Mapping[str, Any],
    correlation_id: str = "",
) -> dict[str, Any]:
    """Create a new Historian Saved View backed by saved_queries table."""
    payload_dict = dict(payload)
    name = str(payload_dict.get("name") or "Saved View").strip()
    if not name:
        raise AppError(422, "MISSING_NAME", "View name is required.")

    query_spec = payload_dict.get("query_spec") or payload_dict.get("query_spec_json") or {}
    chart_opts = payload_dict.get("chart_options") or payload_dict.get("chart_options_json") or {}
    is_default = bool(payload_dict.get("is_default"))

    now = utcnow()
    view_id = uuid4()

    if is_default:
        await execute(
            session,
            "UPDATE saved_queries SET is_default = FALSE WHERE tenant_id = :tenant_id",
            {"tenant_id": tenant_id},
        )

    await execute(
        session,
        """
        INSERT INTO saved_queries (
            id, tenant_id, name, description, selected_signals_json, aggregation_json,
            visibility, owner_id, query_spec_json, chart_options_json, is_default,
            version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :name, :description, CAST(:sel_sigs AS jsonb), CAST(:agg_json AS jsonb),
            'PRIVATE', :actor_id, CAST(:query_spec AS jsonb), CAST(:chart_opts AS jsonb), :is_default,
            1, :now, :now
        )
        """,
        {
            "id": view_id,
            "tenant_id": tenant_id,
            "name": name,
            "description": str(payload_dict.get("description") or ""),
            "sel_sigs": _dump_json(query_spec.get("signal_ids") or []),
            "agg_json": _dump_json({"bucket_ms": query_spec.get("bucket_ms"), "agg": query_spec.get("agg")}),
            "actor_id": actor_id,
            "query_spec": _dump_json(query_spec),
            "chart_opts": _dump_json(chart_opts),
            "is_default": is_default,
            "now": now,
        },
    )

    return {
        "id": str(view_id),
        "name": name,
        "description": str(payload_dict.get("description") or ""),
        "query_spec": query_spec,
        "chart_options": chart_opts,
        "is_default": is_default,
        "version": 1,
        "created_at": iso_ms(now),
        "updated_at": iso_ms(now),
    }


async def delete_saved_view(
    session: AsyncSession,
    tenant_id: UUID,
    view_id_or_actor: UUID,
    view_id: UUID | None = None,
    *,
    actor_id: UUID | None = None,
    correlation_id: str = "",
) -> None:
    """Delete a saved view."""
    target_view_id = view_id if view_id is not None else view_id_or_actor
    deleted = await execute_rowcount(
        session,
        "DELETE FROM saved_queries WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": target_view_id},
    )
    if not deleted:
        raise AppError(404, "NOT_FOUND", f"Saved view {target_view_id} not found.")


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
    pts = query_res.get("points") or []
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
            "query_json": _dump_json(payload_dict),
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


async def list_export_jobs(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    status: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List export jobs for tenant."""
    params: dict[str, Any] = {"tenant_id": tenant_id, "lim": min(max(int(limit), 1), 200)}
    where_sql = "WHERE tenant_id = :tenant_id"
    if status:
        where_sql += " AND UPPER(status) = :status"
        params["status"] = str(status).strip().upper()

    rows = await fetch_all(
        session,
        f"""
        SELECT id, status, format, file_name, row_count, byte_size, query_json,
               error_code, error_message, data_epoch, created_at, started_at, completed_at, expires_at
        FROM export_jobs
        {where_sql}
        ORDER BY created_at DESC
        LIMIT :lim
        """,
        params,
    )
    now = utcnow()
    items: list[dict[str, Any]] = []

    for r in rows:
        exp_at = r.get("expires_at")
        status_val = str(r.get("status") or "COMPLETED").upper()
        if exp_at and exp_at < now and status_val != "EXPIRED":
            status_val = "EXPIRED"

        items.append(
            {
                "id": str(r["id"]),
                "status": status_val,
                "format": str(r.get("format") or "csv").lower(),
                "file_name": str(r.get("file_name") or f"export-{str(r['id'])[:8]}.csv"),
                "row_count": int(r["row_count"]) if r.get("row_count") is not None else None,
                "byte_size": int(r["byte_size"]) if r.get("byte_size") is not None else None,
                "query_spec": _safe_json_dict(r.get("query_json")),
                "error_code": r.get("error_code"),
                "error_message": r.get("error_message"),
                "data_epoch": int(r.get("data_epoch") or 1),
                "created_at": iso_ms(r.get("created_at") or r.get("now") or now),
                "started_at": iso_ms(r["started_at"]) if r.get("started_at") else None,
                "completed_at": iso_ms(r["completed_at"]) if r.get("completed_at") else None,
                "expires_at": iso_ms(exp_at) if exp_at else None,
                "download_url": f"/api/v1/historian/exports/{r['id']}/download",
            }
        )
    return items


async def get_export_job(
    session: AsyncSession,
    tenant_id: UUID,
    export_id: UUID,
    *,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Get metadata for an export job."""
    r = await fetch_one(
        session,
        """
        SELECT id, status, format, file_name, row_count, byte_size, query_json,
               error_code, error_message, data_epoch, created_at, started_at, completed_at, expires_at
        FROM export_jobs
        WHERE tenant_id = :tenant_id AND id = :id
        """,
        {"tenant_id": tenant_id, "id": export_id},
    )
    if not r:
        raise AppError(404, "NOT_FOUND", f"Export job {export_id} not found.")

    exp_at = r.get("expires_at")
    status_val = str(r.get("status") or "COMPLETED").upper()
    if exp_at and exp_at < utcnow() and status_val != "EXPIRED":
        status_val = "EXPIRED"

    return {
        "id": str(r["id"]),
        "status": status_val,
        "format": str(r.get("format") or "csv").lower(),
        "file_name": str(r.get("file_name") or f"export-{str(r['id'])[:8]}.csv"),
        "row_count": int(r["row_count"]) if r.get("row_count") is not None else None,
        "byte_size": int(r["byte_size"]) if r.get("byte_size") is not None else None,
        "query_spec": _safe_json_dict(r.get("query_json")),
        "error_code": r.get("error_code"),
        "error_message": r.get("error_message"),
        "data_epoch": int(r.get("data_epoch") or 1),
        "created_at": iso_ms(r.get("created_at") or r.get("now") or utcnow()),
        "started_at": iso_ms(r["started_at"]) if r.get("started_at") else None,
        "completed_at": iso_ms(r["completed_at"]) if r.get("completed_at") else None,
        "expires_at": iso_ms(exp_at) if exp_at else None,
        "download_url": f"/api/v1/historian/exports/{r['id']}/download",
    }


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
