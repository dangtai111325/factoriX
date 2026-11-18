"""History/aggregate read API with the PG ``observations`` fallback, storage totals and CSV export. Moved verbatim from ``factorix.modules.telemetry`` (R2-E B5, move-only)."""

from __future__ import annotations

import asyncio
import collections
import time
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.csv_safe import csv_row
from factorix.modules.history_repository import get_history_provider
from factorix.modules.common import as_uuid, execute, fetch_all, fetch_one, jsonb, utcnow
from factorix.platform.errors import AppError

from factorix.application.live.latest_api import logger


AGGREGATES = {"min", "max", "avg", "count", "sum"}


async def _active_epoch(session: AsyncSession, tenant_id: UUID) -> int:
    if not isinstance(session, AsyncSession):
        return 1
    try:
        async with session.begin_nested():
            gen_res = await session.execute(
                text("SELECT active_epoch FROM telemetry_generations WHERE tenant_id = :tenant_id"),
                {"tenant_id": tenant_id},
            )
            gen_row = gen_res.mappings().first()
            if gen_row is not None and gen_row.get("active_epoch") is not None:
                return max(1, int(gen_row["active_epoch"]))
    except SQLAlchemyError:
        return 1
    return 1


async def history(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    signal_id: UUID,
    start: datetime,
    end: datetime,
    limit: int,
    cursor: str | None,
    mode: str = "operational",
    dataset_id: UUID | None = None,
) -> dict[str, Any]:
    if end <= start:
        raise AppError(422, "RANGE", "Invalid time range.")
    if end - start > timedelta(days=31):
        raise AppError(422, "RANGE", "Query window is limited to 31 days. Narrow the range or use aggregation.")
    limit = min(max(limit, 1), 2000)

    clean_mode = str(mode or "operational").strip().lower()
    if clean_mode not in {"operational", "recorded", "reconstructed"}:
        raise AppError(422, "INVALID_MODE", f"Unsupported history mode: {mode!r}")

    provider = get_history_provider() if isinstance(session, AsyncSession) else None
    if provider is not None:
        epoch = await _active_epoch(session, tenant_id)
        page = await provider.query_raw(
            tenant_id,
            signal_id=signal_id,
            start=start,
            end=end,
            limit=limit,
            cursor=cursor,
            mode=clean_mode,  # type: ignore[arg-type]
            dataset_id=dataset_id,
            session=session,
            active_epoch=epoch,
        )
        if page.items or clean_mode != "operational" or epoch > 1:
            items = [
                {
                    "id": pt.id,
                    "event_uid": pt.event_uid,
                    "event_time": pt.event_time,
                    "received_time": pt.received_time,
                    "source_time": pt.source_time,
                    "value_type": pt.value_type,
                    "value_json": {"v": pt.value},
                    "value": pt.value,
                    "unit": pt.unit,
                    "quality": pt.quality,
                    "reason_code": pt.reason_code,
                    "origin": pt.origin,
                    "config_revision": pt.config_revision,
                    "data_epoch": pt.data_epoch,
                    "record_kind": pt.record_kind,
                    "virtual": pt.virtual,
                    "dataset_id": str(pt.dataset_id) if pt.dataset_id else None,
                }
                for pt in page.items
            ]
            return {
                "items": items,
                "next_cursor": page.next_cursor,
                "downsampled": page.downsampled,
                "fidelity": page.fidelity,
                "coverage_notes": list(page.coverage_notes),
            }

    if clean_mode != "operational":
        return {
            "items": [],
            "next_cursor": None,
            "downsampled": False,
            "fidelity": "managed_recorded" if clean_mode == "recorded" else "reconstructed",
            "coverage_notes": [],
        }

    params: dict[str, Any] = {
        "tenant_id": tenant_id,
        "signal_id": signal_id,
        "start": start,
        "end": end,
        "limit": limit + 1,
    }
    cursor_sql = ""
    if cursor:
        moment_text, _, id_text = cursor.partition("|")
        params["cursor_time"] = datetime.fromisoformat(moment_text.replace("Z", "+00:00"))
        params["cursor_id"] = as_uuid(id_text)
        cursor_sql = "AND (event_time, id) > (:cursor_time, :cursor_id)"
    rows = await fetch_all(
        session,
        f"""
        SELECT id, event_uid, event_time, received_time, source_time, value_type, value_json, unit, quality, origin, config_revision
        FROM observations
        WHERE tenant_id = :tenant_id AND signal_id = :signal_id
          AND event_time >= :start AND event_time < :end
          {cursor_sql}
        ORDER BY event_time, id
        LIMIT :limit
        """,
        params,
    )
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = f"{last['event_time']}|{last['id']}"
        rows = rows[:limit]
    for row in rows:
        row["value"] = None if row["value_json"] is None else row["value_json"].get("v")
    return {"items": rows, "next_cursor": next_cursor, "downsampled": False}


async def aggregate(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    signal_ids: list[UUID],
    start: datetime,
    end: datetime,
    bucket_ms: int,
    fn: str,
) -> dict[str, Any]:
    if fn not in AGGREGATES:
        raise AppError(422, "AGGREGATE", "Unsupported aggregate function.")
    if bucket_ms < 1000 or bucket_ms > 86_400_000:
        raise AppError(422, "BUCKET", "Bucket must be between 1 second and 1 day.")
    if len(signal_ids) > 20:
        raise AppError(422, "LIMIT", "At most 20 signals per aggregation query.")
    if end <= start:
        raise AppError(422, "RANGE", "Invalid time range.")

    provider = get_history_provider() if isinstance(session, AsyncSession) else None
    if provider is not None:
        epoch = await _active_epoch(session, tenant_id)
        td_buckets = await provider.aggregate(
            tenant_id,
            signal_ids=signal_ids,
            start=start,
            end=end,
            bucket_ms=bucket_ms,
            fn=fn,  # type: ignore[arg-type]
            session=session,
            active_epoch=epoch,
        )
        if td_buckets or epoch > 1:
            return {
                "fn": fn,
                "bucket_ms": bucket_ms,
                "buckets": [
                    {
                        "signal_id": b.signal_id,
                        "bucket": b.bucket,
                        "value": b.value,
                        "good_count": b.good_count,
                        "sample_count": b.sample_count,
                    }
                    for b in td_buckets
                ],
                "empty_buckets": "omitted",
                "quality_policy": "GOOD_ONLY",
            }

    sql_fn = {"min": "min", "max": "max", "avg": "avg", "sum": "sum", "count": "count"}[fn]
    value_expr = "count(*)" if fn == "count" else f"{sql_fn}((value_json->>'v')::double precision)"
    rows = await fetch_all(
        session,
        f"""
        SELECT signal_id,
               to_timestamp(floor(extract(epoch FROM event_time) * 1000 / :bucket) * :bucket / 1000.0) AS bucket,
               {value_expr} AS value,
               count(*) FILTER (WHERE quality = 'GOOD') AS good_count,
               count(*) AS sample_count
        FROM observations
        WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids)
          AND event_time >= :start AND event_time < :end
          AND value_type IN ('float64', 'int64')
          AND quality = 'GOOD'
          AND jsonb_typeof(value_json->'v') = 'number'
        GROUP BY signal_id, bucket
        ORDER BY signal_id, bucket
        """,
        {"tenant_id": tenant_id, "ids": signal_ids, "start": start, "end": end, "bucket": bucket_ms},
    )
    return {"fn": fn, "bucket_ms": bucket_ms, "buckets": rows, "empty_buckets": "omitted", "quality_policy": "GOOD_ONLY"}


class _IngestRate:
    """Rolling one-minute count of committed samples per tenant, kept in memory.

    The Overview polls this every few seconds; counting rows of the (multi-million row)
    observations table for it saturated the database (R4 performance finding)."""

    def __init__(self, window_s: float = 60.0) -> None:
        self._window = window_s
        self._events: dict[str, collections.deque[tuple[float, int]]] = {}

    def add(self, tenant: str, count: int) -> None:
        now = time.monotonic()
        events = self._events.setdefault(tenant, collections.deque())
        events.append((now, count))
        self._trim(events, now)

    def per_minute(self, tenant: str) -> int:
        events = self._events.get(tenant)
        if not events:
            return 0
        self._trim(events, time.monotonic())
        return sum(count for _, count in events)

    def _trim(self, events: "collections.deque[tuple[float, int]]", now: float) -> None:
        while events and now - events[0][0] > self._window:
            events.popleft()


_INGEST_RATE = _IngestRate()
_TOTALS_TTL_S = 300.0
_totals_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_totals_refreshing: set[str] = set()
_totals_tasks: set["asyncio.Task[None]"] = set()


async def _compute_observation_totals(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    active_epoch: int = 1,
) -> dict[str, Any]:
    provider = get_history_provider() if isinstance(session, AsyncSession) else None
    totals: dict[str, Any] = {
        "observations": 0,
        "oldest": None,
        "newest": None,
        "disk_bytes": None,
        "approximate": False,
    }
    if provider is not None:
        td_metrics = await provider.storage_overview_metrics(
            tenant_id, active_epoch=active_epoch, include_disk=True
        )
        totals.update(td_metrics)

    # Pre-S17 PG fallback ONLY when TDengine has no active-epoch observations and epoch == 1
    if int(totals.get("observations") or 0) == 0 and active_epoch == 1:
        row = await fetch_one(
            session,
            """
            SELECT count(*) AS observations, min(event_time) AS oldest, max(event_time) AS newest
            FROM observations WHERE tenant_id = :tenant_id
            """,
            {"tenant_id": tenant_id},
        )
        if row and int(row.get("observations") or 0) > 0:
            totals["observations"] = int(row["observations"])
            totals["oldest"] = row.get("oldest")
            totals["newest"] = row.get("newest")

    # ingest_dedup holds a key per sample for 7 days: check control-plane counts cleanly.
    quarantine = await fetch_one(
        session,
        "SELECT count(*) AS count FROM observation_quarantine WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    dedup = await fetch_one(
        session,
        "SELECT count(*) AS count FROM ingest_dedup WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    totals["quarantine"] = int(quarantine["count"]) if quarantine else 0
    totals["dedup_keys"] = int(dedup["count"]) if dedup else 0
    totals["approximate"] = False
    return totals


async def _estimated_totals(session: AsyncSession) -> dict[str, Any]:
    """Planner row estimates (instant, approximate) for the first Overview after a start, while the
    exact counts are computed in the background."""
    totals: dict[str, Any] = {
        "observations": 0,
        "oldest": None,
        "newest": None,
        "quarantine": 0,
        "dedup_keys": 0,
        "disk_bytes": None,
        "approximate": True,
    }
    try:
        async with session.begin_nested():
            row = await fetch_one(
                session,
                """
                SELECT
                  COALESCE((SELECT sum(GREATEST(c.reltuples, 0)) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                            WHERE i.inhparent = 'observations'::regclass), 0) AS observations,
                  COALESCE((SELECT GREATEST(reltuples, 0) FROM pg_class WHERE oid = 'ingest_dedup'::regclass), 0) AS dedup_keys
                """,
                {},
            )
        if row:
            totals["observations"] = int(row["observations"] or 0)
            totals["dedup_keys"] = int(row["dedup_keys"] or 0)
    except SQLAlchemyError:
        pass
    return totals


async def _refresh_totals(tenant_id: UUID, active_epoch: int) -> None:
    from factorix.platform.db import session_factory

    key = f"{tenant_id}:{active_epoch}"
    try:
        async with session_factory()() as session:
            totals = await _compute_observation_totals(session, tenant_id, active_epoch=active_epoch)
            await session.rollback()
        _totals_cache[key] = (time.monotonic(), totals)
    except Exception:  # noqa: BLE001 - a failed refresh keeps the last figures
        logger.warning("storage totals refresh failed", exc_info=True)
    finally:
        _totals_refreshing.discard(key)


def _schedule_totals_refresh(tenant_id: UUID, active_epoch: int) -> None:
    key = f"{tenant_id}:{active_epoch}"
    if key in _totals_refreshing:
        return
    _totals_refreshing.add(key)
    task = asyncio.get_running_loop().create_task(_refresh_totals(tenant_id, active_epoch))
    _totals_tasks.add(task)
    task.add_done_callback(_totals_tasks.discard)


async def _observation_totals(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    active_epoch: int = 1,
) -> dict[str, Any]:
    """Size figures of stored history (count, oldest, newest, quarantine, dedup keys).

    Epoch-keyed cache guarantees reset/epoch bumps invalidate immediately. When TDengine is
    configured, cold misses resolve TDengine STable metadata synchronously (fast columnar header
    scan) and refresh in the background every 5 minutes.
    """
    key = f"{tenant_id}:{active_epoch}"
    cached = _totals_cache.get(key)
    if cached and time.monotonic() - cached[0] < _TOTALS_TTL_S:
        return cached[1]
    if get_history_provider() is not None and isinstance(session, AsyncSession):
        if cached is not None:
            _schedule_totals_refresh(tenant_id, active_epoch)
            return cached[1]
        totals = await _compute_observation_totals(session, tenant_id, active_epoch=active_epoch)
        _totals_cache[key] = (time.monotonic(), totals)
        return totals
    _schedule_totals_refresh(tenant_id, active_epoch)
    if cached:
        return cached[1]
    return await _estimated_totals(session)


async def storage_overview(session: AsyncSession, tenant_id: UUID) -> dict[str, Any]:
    epoch = await _active_epoch(session, tenant_id)
    totals = await _observation_totals(session, tenant_id, active_epoch=epoch)
    ingest_per_minute = int(_INGEST_RATE.per_minute(str(tenant_id)))
    quality = await fetch_all(
        session,
        """
        SELECT l.quality, count(*) AS count FROM latest_signal_state l
        JOIN signal_definitions s ON s.id = l.signal_id
        WHERE l.tenant_id = :tenant_id AND s.status = 'ACTIVE' AND l.data_epoch >= :active_epoch
        GROUP BY l.quality
        """,
        {"tenant_id": tenant_id, "active_epoch": epoch},
    )
    quarantine = {"count": totals.get("quarantine", 0)}
    dedup = {"count": totals.get("dedup_keys", 0)}
    backlog_row = await fetch_one(
        session,
        "SELECT COALESCE(sum(outbox_pending), 0) AS pending FROM edge_nodes WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    backlog = int(backlog_row["pending"]) if backlog_row else 0
    if hasattr(session, "begin_nested"):
        try:
            async with session.begin_nested():
                cutoff = utcnow() - timedelta(seconds=30)
                runtime_rows = await fetch_all(
                    session,
                    """
                    SELECT role, spool_pending, fast_buffered, queues_json, last_heartbeat
                    FROM collector_runtime_status
                    WHERE last_heartbeat >= :cutoff
                    """,
                    {"cutoff": cutoff},
                )
                worker_rate = 0
                acq_backlog = 0
                tenant_key = str(tenant_id)
                for rt in runtime_rows:
                    role = str(rt.get("role") or "")
                    if role == "acquisition":
                        acq_backlog += int(rt.get("spool_pending") or 0) + int(rt.get("fast_buffered") or 0)
                    elif role == "ingestion":
                        qj = rt.get("queues_json") or {}
                        if isinstance(qj, dict):
                            tr = qj.get("tenant_rates") or {}
                            if isinstance(tr, dict):
                                worker_rate += int(tr.get(tenant_key) or 0)
                ingest_per_minute = max(ingest_per_minute, worker_rate)
                backlog += acq_backlog
        except Exception:  # noqa: BLE001 - optional when running against mocked or pre-0008 test DBs
            pass
    disk_bytes = totals.get("disk_bytes")
    if disk_bytes is None:
        disk_bytes = 0
    return {
        "observations": int(totals["observations"]) if totals else 0,
        "oldest": totals["oldest"] if totals else None,
        "newest": totals["newest"] if totals else None,
        "ingest_per_minute": ingest_per_minute,
        "quality": quality,
        "quarantine": int(quarantine["count"]) if quarantine else 0,
        "dedup_keys": int(dedup["count"]) if dedup else 0,
        "backlog": backlog,
        "disk_bytes": disk_bytes,
        "approximate": bool(totals.get("approximate")),
        "note": (
            "TDengine storage metrics active."
            if disk_bytes is not None
            else "Disk usage is shown only when the server can measure it."
        ),
    }


async def export_csv(session: AsyncSession, tenant_id: UUID, actor: UUID, signal_id: UUID, start: datetime, end: datetime) -> dict[str, Any]:
    page = await history(session, tenant_id, signal_id=signal_id, start=start, end=end, limit=5000, cursor=None)
    lines = [csv_row(["event_time", "value", "unit", "quality", "origin", "event_uid"])]
    for item in page["items"]:
        lines.append(csv_row([item["event_time"], item["value"], item["unit"], item["quality"], item["origin"], item["event_uid"]]))
    text = "\n".join(lines) + "\n"
    job_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO export_jobs (id, tenant_id, requested_by, query_json, status, row_count, csv_text, created_at)
        VALUES (:id, :tenant_id, :actor, CAST(:query AS jsonb), 'READY', :rows, :csv, :now)
        """,
        {
            "id": job_id,
            "tenant_id": tenant_id,
            "actor": actor,
            "query": jsonb({"signal_id": str(signal_id)}),
            "rows": len(page["items"]),
            "csv": text,
            "now": utcnow(),
        },
    )
    return {"job_id": str(job_id), "row_count": len(page["items"]), "csv": text, "truncated": page["next_cursor"] is not None}
