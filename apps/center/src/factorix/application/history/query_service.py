"""HistoryQueryService: the one entry point for history reads (R2-E C3).

Callers: ``GET /api/v1/observations/history`` (Signals sparklines / trend chart, CSV export),
``GET /api/v1/observations/aggregate`` (charts), the Data Model engine ``value_at`` / as-of lookups,
the Historian (``POST /api/v1/historian/query`` keeps its multi-reader orchestration but asks this
service whether the PostgreSQL ``observations`` fallback may be read), and the storage totals.

Readers: TDengine (``TDengineHistoryRepository``) first. The legacy PostgreSQL ``observations`` table is
read only when ``pg_fallback_enabled()``:

* ``FACTORIX_PG_TELEMETRY_FALLBACK=true|false`` decides explicitly;
* unset = on only in the legacy Edge mode, which still writes that table. On the appliance
  (``FACTORIX_COLLECTOR_MODE=acquisition``) nothing writes ``observations`` any more, so a fallback read
  can only return rows from before the TDengine migration (and costs a scan of a large table).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import history_repository as HR
from factorix.modules.common import as_uuid, fetch_all
from factorix.platform.errors import AppError

__all__ = [
    "AGGREGATES",
    "HistoryQuery",
    "HistoryQueryService",
    "history_query_service",
    "pg_fallback_enabled",
]

AGGREGATES = {"min", "max", "avg", "count", "sum"}
HISTORY_MAX_WINDOW = timedelta(days=31)
HISTORY_MAX_LIMIT = 2000
Order = Literal["oldest", "newest"]


def pg_fallback_enabled(settings: Any = None) -> bool:
    """Whether the legacy PostgreSQL ``observations`` table may be read as a history fallback."""
    cfg = settings
    if cfg is None:
        try:
            from factorix.platform.settings import get_settings

            cfg = get_settings()
        except Exception:  # noqa: BLE001 - no settings (tools / tests without env): keep the old behaviour
            return True
    explicit = getattr(cfg, "pg_telemetry_fallback", None)
    if explicit is not None:
        return bool(explicit)
    return str(getattr(cfg, "collector_mode", "edge") or "edge").strip().lower() != "acquisition"


async def active_epoch(session: AsyncSession, tenant_id: UUID) -> int:
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


@dataclass(frozen=True)
class HistoryQuery:
    signal_id: UUID
    start: datetime
    end: datetime
    limit: int = 500
    cursor: str | None = None
    mode: str = "operational"
    dataset_id: UUID | None = None
    order: Order = "oldest"


def _no_rows(mode: str) -> dict[str, Any]:
    return {
        "items": [],
        "next_cursor": None,
        "downsampled": False,
        "fidelity": "managed_recorded" if mode == "recorded" else "reconstructed",
        "coverage_notes": [],
    }


class HistoryQueryService:
    """One read path per history question; ``pg_fallback=None`` follows ``pg_fallback_enabled()``."""

    def __init__(self, *, pg_fallback: bool | None = None) -> None:
        self._pg_fallback = pg_fallback

    @property
    def pg_fallback(self) -> bool:
        return pg_fallback_enabled() if self._pg_fallback is None else self._pg_fallback

    @staticmethod
    def provider(session: Any) -> HR.TDengineHistoryRepository | None:
        return HR.get_history_provider() if isinstance(session, AsyncSession) else None

    # ------------------------------------------------------------------ raw history

    async def history(self, session: AsyncSession, tenant_id: UUID, q: HistoryQuery) -> dict[str, Any]:
        if q.end <= q.start:
            raise AppError(422, "RANGE", "Invalid time range.")
        if q.end - q.start > HISTORY_MAX_WINDOW:
            raise AppError(422, "RANGE", "Query window is limited to 31 days. Narrow the range or use aggregation.")
        limit = min(max(q.limit, 1), HISTORY_MAX_LIMIT)
        clean_mode = str(q.mode or "operational").strip().lower()
        if clean_mode not in {"operational", "recorded", "reconstructed"}:
            raise AppError(422, "INVALID_MODE", f"Unsupported history mode: {q.mode!r}")
        order: Order = "newest" if str(q.order or "oldest").strip().lower() == "newest" else "oldest"
        if order == "newest" and q.cursor:
            raise AppError(422, "INVALID_ORDER", "order=newest returns the most recent rows of the window and cannot be paged.")

        provider = self.provider(session)
        epoch = 1
        if provider is not None:
            epoch = await active_epoch(session, tenant_id)
            page = await provider.query_raw(
                tenant_id,
                signal_id=q.signal_id,
                start=q.start,
                end=q.end,
                limit=limit,
                cursor=q.cursor,
                mode=clean_mode,  # type: ignore[arg-type]
                dataset_id=q.dataset_id,
                session=session,
                active_epoch=epoch,
                **({"order": order} if order == "newest" else {}),
            )
            if page.items or clean_mode != "operational" or epoch > 1 or not self.pg_fallback:
                return {
                    "items": [
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
                    ],
                    "next_cursor": page.next_cursor,
                    "downsampled": page.downsampled,
                    "fidelity": page.fidelity,
                    "coverage_notes": list(page.coverage_notes),
                }

        if clean_mode != "operational":
            return _no_rows(clean_mode)
        if not self.pg_fallback:
            return {
                "items": [],
                "next_cursor": None,
                "downsampled": False,
                "fidelity": "operational",
                "coverage_notes": ["TDengine history is not available; the PostgreSQL observations fallback is disabled."],
            }
        return await self._pg_history(session, tenant_id, q, limit, order)

    async def _pg_history(self, session: AsyncSession, tenant_id: UUID, q: HistoryQuery, limit: int, order: Order) -> dict[str, Any]:
        params: dict[str, Any] = {"tenant_id": tenant_id, "signal_id": q.signal_id, "start": q.start, "end": q.end, "limit": limit + 1}
        cursor_sql = ""
        if q.cursor:
            moment_text, _, id_text = q.cursor.partition("|")
            params["cursor_time"] = datetime.fromisoformat(moment_text.replace("Z", "+00:00"))
            params["cursor_id"] = as_uuid(id_text)
            cursor_sql = "AND (event_time, id) > (:cursor_time, :cursor_id)"
        direction = "DESC" if order == "newest" else ""
        rows = await fetch_all(
            session,
            f"""
            SELECT id, event_uid, event_time, received_time, source_time, value_type, value_json, unit, quality, origin, config_revision
            FROM observations
            WHERE tenant_id = :tenant_id AND signal_id = :signal_id
              AND event_time >= :start AND event_time < :end
              {cursor_sql}
            ORDER BY event_time {direction}, id {direction}
            LIMIT :limit
            """,
            params,
        )
        next_cursor = None
        if order == "newest":
            rows = list(reversed(rows[:limit]))
        elif len(rows) > limit:
            last = rows[limit - 1]
            next_cursor = f"{last['event_time']}|{last['id']}"
            rows = rows[:limit]
        for row in rows:
            row["value"] = None if row["value_json"] is None else row["value_json"].get("v")
        return {"items": rows, "next_cursor": next_cursor, "downsampled": False}

    # ------------------------------------------------------------------ aggregates

    async def aggregate(
        self,
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
        empty = {"fn": fn, "bucket_ms": bucket_ms, "buckets": [], "empty_buckets": "omitted", "quality_policy": "GOOD_ONLY"}
        provider = self.provider(session)
        if provider is not None:
            epoch = await active_epoch(session, tenant_id)
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
            if td_buckets or epoch > 1 or not self.pg_fallback:
                return {
                    **empty,
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
                }
        if not self.pg_fallback:
            return empty
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
        return {**empty, "buckets": rows}

    # ------------------------------------------------------------------ value at an instant (Data Models)

    async def value_at(
        self, session: AsyncSession, tenant_id: UUID, requests: list[tuple[str, datetime, str]]
    ) -> dict[tuple[str, datetime], tuple[Any, Any, Any, Any] | None]:
        """Value of each signal as of an instant: ``requests = [(signal_id, at, mode)]`` with mode ``"s"``
        (by source_time) or ``"e"`` (by event_time). Returns ``(value, quality, source_time, received_time)``.

        TDengine ``value_at_batch`` first; the PostgreSQL ``observations`` fallback only for epoch 1 and
        only when ``pg_fallback`` is on.
        """
        out: dict[tuple[str, datetime], tuple[Any, Any, Any, Any] | None] = {(sid, at): None for sid, at, _m in requests}
        if not requests:
            return out
        remaining = requests
        provider = self.provider(session)
        if provider is not None:
            epoch = await HR._active_epoch_for(session, tenant_id)
            td_res = await provider.value_at_batch(tenant_id, requests=requests, session=session, active_epoch=epoch)
            missing: list[tuple[str, datetime, str]] = []
            for sid, at, mode in requests:
                hit = td_res.get((sid, at))
                if hit is not None:
                    out[(sid, at)] = tuple(hit)  # type: ignore[assignment]
                elif epoch == 1:
                    missing.append((sid, at, mode))
            if epoch > 1 or not missing:
                return out
            remaining = missing
        if not self.pg_fallback:
            return out
        rows = await fetch_all(
            session,
            """
            SELECT q.idx, o.value_json, o.quality, o.source_time, o.received_time
            FROM unnest(CAST(:ids AS uuid[]), CAST(:ats AS timestamptz[]), CAST(:modes AS text[]), CAST(:idx AS integer[]))
                 AS q(signal_id, at, mode, idx)
            LEFT JOIN LATERAL (
                SELECT * FROM (
                    (SELECT o.value_json, o.quality, o.source_time, o.received_time
                     FROM observations o
                     WHERE q.mode = 's' AND o.tenant_id = :tenant_id AND o.signal_id = q.signal_id
                       AND o.source_time <= q.at AND o.quality IN ('GOOD', 'UNCERTAIN')
                     ORDER BY o.source_time DESC, o.received_time DESC
                     LIMIT 1)
                    UNION ALL
                    (SELECT o.value_json, o.quality, o.source_time, o.received_time
                     FROM observations o
                     WHERE q.mode = 'e' AND o.tenant_id = :tenant_id AND o.signal_id = q.signal_id
                       AND o.event_time <= q.at AND o.quality IN ('GOOD', 'UNCERTAIN')
                     ORDER BY o.event_time DESC
                     LIMIT 1)
                ) found
                LIMIT 1
            ) o ON TRUE
            """,
            {
                "tenant_id": tenant_id,
                "ids": [UUID(sid) for sid, _at, _mode in remaining],
                "ats": [at for _sid, at, _mode in remaining],
                "modes": [mode for _sid, _at, mode in remaining],
                "idx": list(range(len(remaining))),
            },
        )
        for row in rows:
            sid, at, _mode = remaining[int(row["idx"])]
            if row.get("quality") is None:
                continue
            value_json = row.get("value_json")
            if isinstance(value_json, str):
                try:
                    value_json = json.loads(value_json)
                except ValueError:
                    value_json = None
            out[(sid, at)] = (
                value_json.get("v") if isinstance(value_json, dict) else None,
                row.get("quality"),
                row.get("source_time"),
                row.get("received_time"),
            )
        return out


_SERVICE = HistoryQueryService()


def history_query_service() -> HistoryQueryService:
    return _SERVICE
