"""TDengine Historical Value & Model Snapshot Repositories (S09).

Implements ``HistoricalValueProvider`` and ``ModelSnapshotProvider`` over TDengine
per-tenant Operational History STables (``op_float64``, ``op_int64``, ``op_bool``,
``op_string``, ``op_json``), Managed Dataset STables, and ``model_snapshots``.

Design guarantees:
- All queries enforce ``data_epoch >= active_epoch`` so reset epochs never leak prior data.
- Missing tenant databases or subtables (before first write or immediately post-reset)
  degrade cleanly to empty result sets without erroring.
- Numeric aggregates enforce ``value_type IN ('float64', 'int64')``, ``raw_quality = 'GOOD'``,
  and non-null values matching existing PostgreSQL contract semantics.
- Managed history supports both sparse ``mode='recorded'`` events and canonical
  ``mode='reconstructed'`` timelines with pre-window carry-in seeds, gap truncation
  at ``max(interval_ms * 2.0, 12000)``, and explicit ``BAD``/``STALE`` fidelity.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
import json
import logging
import math
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import text as sa_text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.signal_state import canonical_stale_after_ms
from factorix.modules.live_state import _decode_td_value
from factorix.modules.providers import (
    HistoricalBucket,
    HistoricalPage,
    HistoricalPoint,
    ModelSnapshotRecord,
)
from factorix.platform.errors import AppError
from factorix.platform.tdengine import (
    MODEL_SNAPSHOTS_STABLE,
    OP_STABLE_COL_TYPES,
    SubtableWriteItem,
    TDEngineClient,
    TDEngineError,
    model_snapshot_subtable_name,
    op_stable_for_type,
    op_subtable_name,
    quote_fq_table,
    quote_ident,
    tenant_database_name,
    to_td_timestamp_us,
    to_utc_datetime,
)

logger = logging.getLogger(__name__)

_MAX_BODY_BYTES = 47_000
_MAX_ERRORS_BYTES = 7_800
_NUMERIC_TYPES = frozenset({"float64", "int64"})

_HISTORY_PROVIDER: TDengineHistoryRepository | None = None
_MODEL_SNAPSHOT_PROVIDER: TDengineModelSnapshotProvider | None = None


def configure_history_provider(provider: TDengineHistoryRepository | None) -> None:
    global _HISTORY_PROVIDER
    _HISTORY_PROVIDER = provider


def get_history_provider() -> TDengineHistoryRepository | None:
    return _HISTORY_PROVIDER


def configure_model_snapshot_provider(provider: TDengineModelSnapshotProvider | None) -> None:
    global _MODEL_SNAPSHOT_PROVIDER
    _MODEL_SNAPSHOT_PROVIDER = provider


def get_model_snapshot_provider() -> TDengineModelSnapshotProvider | None:
    return _MODEL_SNAPSHOT_PROVIDER


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utc(dt: datetime | str | int | None) -> datetime | None:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    return to_utc_datetime(dt)


def _is_missing_td_object(exc: TDEngineError) -> bool:
    msg = (exc.message or "").lower()
    return (
        "not exist" in msg
        or "doesn't exist" in msg
        or "does not exist" in msg
        or "0x0362" in msg
        or "0x2103" in msg
        or "0x2603" in msg
    )


def _truncate_utf8(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    return raw[:max_bytes].decode("utf-8", errors="ignore")


def _safe_errors_json(raw: Any, max_bytes: int = _MAX_ERRORS_BYTES) -> tuple[str, int]:
    parsed: list[Any]
    if isinstance(raw, str):
        try:
            loaded = json.loads(raw) if raw.strip() else []
            parsed = loaded if isinstance(loaded, list) else [loaded]
        except json.JSONDecodeError:
            parsed = []
    elif isinstance(raw, Sequence) and not isinstance(raw, (bytes, bytearray, str)):
        parsed = list(raw)
    else:
        parsed = []

    count = len(parsed)
    encoded = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) <= max_bytes:
        return encoded, count

    trimmed = list(parsed)
    while trimmed:
        trimmed.pop()
        cand = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
        if len(cand.encode("utf-8")) <= max_bytes - 128:
            trimmed.append({"code": "TRUNCATED", "message": f"{count - len(trimmed)} error(s) truncated"})
            return json.dumps(trimmed, ensure_ascii=False, separators=(",", ":")), count
    return '[{"code":"TRUNCATED","message":"Errors truncated to fit buffer"}]', count


def _synthetic_point_id(signal_id: UUID, ts_us: int, event_uid: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"{signal_id}:{ts_us}:{event_uid}"))


def _format_cursor(ts: datetime, point_id: str) -> str:
    moment = _utc(ts) or _utcnow()
    return f"{moment.isoformat().replace('+00:00', 'Z')}|{point_id}"


def _parse_cursor(cursor: str | None) -> tuple[int, str] | None:
    if not cursor:
        return None
    moment_text, sep, id_text = cursor.partition("|")
    if not sep or not moment_text or not id_text:
        raise AppError(422, "INVALID_CURSOR", "Invalid pagination cursor.")
    try:
        parsed_dt = datetime.fromisoformat(moment_text.strip().replace("Z", "+00:00"))
        if parsed_dt.tzinfo is None:
            parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)
        uid_norm = str(UUID(id_text.strip()))
    except (ValueError, TypeError) as exc:
        raise AppError(422, "INVALID_CURSOR", "Invalid pagination cursor.") from exc
    return to_td_timestamp_us(parsed_dt), uid_norm


async def _active_epoch_for(session: AsyncSession | None, tenant_id: UUID) -> int:
    if not isinstance(session, AsyncSession):
        return 1
    try:
        async with session.begin_nested():
            row = (
                await session.execute(
                    sa_text("SELECT active_epoch FROM telemetry_generations WHERE tenant_id = :tenant_id"),
                    {"tenant_id": tenant_id},
                )
            ).mappings().first()
            if row and row.get("active_epoch") is not None:
                return max(1, int(row["active_epoch"]))
    except SQLAlchemyError:
        return 1
    return 1


class TDengineModelSnapshotProvider:
    """``ModelSnapshotProvider`` implementation backed by TDengine ``model_snapshots`` STable."""

    def __init__(self, client: TDEngineClient) -> None:
        self._client = client

    @property
    def client(self) -> TDEngineClient:
        return self._client

    async def append_snapshot(self, tenant_id: UUID, record: ModelSnapshotRecord) -> None:
        await self.append_snapshots_batch(tenant_id, [record])

    async def append_snapshots_batch(self, tenant_id: UUID, records: Sequence[ModelSnapshotRecord]) -> None:
        if not records:
            return
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        items: list[SubtableWriteItem] = []
        seen_by_sub: dict[str, set[int]] = {}
        for rec in records:
            subtable = model_snapshot_subtable_name(rec.group_id)
            ts_dt = _utc(rec.sampled_at) or _utcnow()
            ts_us = to_td_timestamp_us(ts_dt)
            used = seen_by_sub.setdefault(subtable, set())
            while ts_us in used:
                ts_us += 1
            used.add(ts_us)
            safe_ts = to_utc_datetime(ts_us)
            body_safe = _truncate_utf8(str(rec.body or ""), _MAX_BODY_BYTES)
            err_json_safe, err_count = _safe_errors_json(rec.errors)
            eff_count = max(int(rec.error_count or 0), err_count)
            items.append(
                SubtableWriteItem(
                    item_id=f"{rec.group_id}:{ts_us}",
                    stable=MODEL_SNAPSHOTS_STABLE,
                    subtable=subtable,
                    tags=(str(rec.group_id),),
                    columns=("ts", "body_text", "errors_json", "error_count", "data_epoch"),
                    values=(safe_ts, body_safe, err_json_safe, eff_count, max(1, int(rec.data_epoch))),
                    value_types=("timestamp", "string", "string", "int64", "int64"),
                )
            )

        res = await self._client.write_batch(db, items)
        if res.failures:
            missing_failures = any(
                "not exist" in f.message.lower()
                or "doesn't exist" in f.message.lower()
                or "does not exist" in f.message.lower()
                or "0x0362" in f.message.lower()
                or "0x2103" in f.message.lower()
                for f in res.failures
            )
            if missing_failures:
                await self._client.ensure_operational_schema(tenant_id)
                failed_ids = {f.item_id for f in res.failures}
                retry_items = [it for it in items if it.item_id in failed_ids]
                retry_res = await self._client.write_batch(db, retry_items)
                if retry_res.failures:
                    first = retry_res.failures[0]
                    raise TDEngineError(first.error_code, first.message, retryable=first.retryable)
            else:
                first = res.failures[0]
                raise TDEngineError(first.error_code, first.message, retryable=first.retryable)

    async def list_snapshots(
        self,
        tenant_id: UUID,
        group_id: UUID,
        *,
        limit: int = 20,
        active_epoch: int | None = 1,
    ) -> list[ModelSnapshotRecord]:
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        fq = quote_fq_table(db, model_snapshot_subtable_name(group_id))
        bounded = min(max(int(limit), 1), 500)
        epoch_filter = f" WHERE `data_epoch` >= {int(active_epoch)}" if active_epoch is not None else ""
        try:
            rows = await self._client.query_rows(
                f"SELECT `ts`, `body_text`, `errors_json`, `error_count`, `data_epoch` "
                f"FROM {fq}{epoch_filter} ORDER BY `ts` DESC LIMIT {bounded}"
            )
        except TDEngineError as exc:
            if _is_missing_td_object(exc):
                return []
            raise

        out: list[ModelSnapshotRecord] = []
        for row in rows:
            sampled_at = _utc(row.get("ts"))
            if sampled_at is None:
                continue
            raw_errs = row.get("errors_json")
            parsed_errs: list[dict[str, Any]]
            if isinstance(raw_errs, str):
                try:
                    loaded = json.loads(raw_errs) if raw_errs.strip() else []
                    parsed_errs = loaded if isinstance(loaded, list) else []
                except json.JSONDecodeError:
                    parsed_errs = []
            elif isinstance(raw_errs, list):
                parsed_errs = list(raw_errs)
            else:
                parsed_errs = []
            out.append(
                ModelSnapshotRecord(
                    group_id=group_id,
                    sampled_at=sampled_at,
                    body=str(row.get("body_text") or ""),
                    errors=parsed_errs,
                    error_count=int(row.get("error_count") or len(parsed_errs)),
                    data_epoch=int(row.get("data_epoch") or 1),
                )
            )
        return out

    async def prune_snapshots(
        self,
        tenant_id: UUID,
        group_ids: Sequence[UUID],
        *,
        keep: int = 100,
    ) -> int:
        if not group_ids:
            return 0
        bounded_keep = max(1, int(keep))
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        total_deleted = 0
        for gid in group_ids:
            fq = quote_fq_table(db, model_snapshot_subtable_name(gid))
            try:
                rows = await self._client.query_rows(
                    f"SELECT `ts` FROM {fq} ORDER BY `ts` DESC LIMIT {bounded_keep + 1}"
                )
            except TDEngineError as exc:
                if _is_missing_td_object(exc):
                    continue
                raise
            if len(rows) <= bounded_keep:
                continue
            cutoff_ts = _utc(rows[bounded_keep].get("ts"))
            if cutoff_ts is None:
                continue
            cutoff_us = to_td_timestamp_us(cutoff_ts)
            try:
                total_deleted += await self._client.execute_sql(f"DELETE FROM {fq} WHERE `ts` <= {cutoff_us}")
            except TDEngineError as exc:
                if not _is_missing_td_object(exc):
                    raise
        return total_deleted

    async def delete_model_snapshots(self, tenant_id: UUID, group_id: UUID) -> None:
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        fq = quote_fq_table(db, model_snapshot_subtable_name(group_id))
        try:
            await self._client.execute_sql(f"DROP TABLE IF EXISTS {fq}")
        except TDEngineError as exc:
            if not _is_missing_td_object(exc):
                raise

    async def clear_epoch(self, tenant_id: UUID, max_epoch: int) -> int:
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        try:
            subtables = await self._client.list_subtables(db, stable=MODEL_SNAPSHOTS_STABLE)
        except TDEngineError as exc:
            if _is_missing_td_object(exc):
                return 0
            raise
        deleted = 0
        for sub in subtables:
            fq = quote_fq_table(db, sub)
            try:
                deleted += await self._client.execute_sql(f"DELETE FROM {fq} WHERE `data_epoch` <= {int(max_epoch)}")
            except TDEngineError as exc:
                if not _is_missing_td_object(exc):
                    raise
        return deleted


class TDengineHistoryRepository:
    """``HistoricalValueProvider`` backed by TDengine Operational & Managed History."""

    def __init__(self, client: TDEngineClient) -> None:
        self._client = client

    @property
    def client(self) -> TDEngineClient:
        return self._client

    async def _signal_meta_map(
        self,
        session: AsyncSession | None,
        tenant_id: UUID,
        signal_ids: Sequence[UUID],
    ) -> dict[UUID, dict[str, Any]]:
        out: dict[UUID, dict[str, Any]] = {}
        if not signal_ids:
            return out
        if isinstance(session, AsyncSession):
            try:
                async with session.begin_nested():
                    res = await session.execute(
                        sa_text(
                            """
                            SELECT id, data_type, expected_interval_ms, unit
                            FROM signal_definitions
                            WHERE tenant_id = :tenant_id AND id = ANY(:ids)
                            """
                        ),
                        {"tenant_id": tenant_id, "ids": list(signal_ids)},
                    )
                    for r in res.mappings().all():
                        out[UUID(str(r["id"]))] = dict(r)
            except SQLAlchemyError:
                out = {}

        missing = [sid for sid in signal_ids if sid not in out]
        if missing:
            db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
            try:
                existing = set(await self._client.list_subtables(db))
            except TDEngineError as exc:
                if _is_missing_td_object(exc):
                    existing = set()
                else:
                    raise
            if existing:
                for sid in missing:
                    for vtype in ("float64", "int64", "bool", "string", "json"):
                        candidate = op_subtable_name(sid, vtype)
                        if candidate in existing:
                            out[sid] = {
                                "id": sid,
                                "data_type": vtype,
                                "expected_interval_ms": None,
                                "unit": None,
                            }
                            break
        return out

    async def _managed_binding(
        self,
        session: AsyncSession | None,
        tenant_id: UUID,
        signal_id: UUID,
        *,
        dataset_id: UUID | None = None,
    ) -> dict[str, Any] | None:
        if not isinstance(session, AsyncSession):
            return None
        params: dict[str, Any] = {"tenant_id": tenant_id, "signal_id": signal_id}
        ds_filter = ""
        if dataset_id is not None:
            ds_filter = " AND r.dataset_id = :dataset_id"
            params["dataset_id"] = dataset_id
        try:
            async with session.begin_nested():
                row = (
                    await session.execute(
                        sa_text(
                            f"""
                            SELECT r.td_database, r.td_stable, r.td_subtable, r.dataset_id, r.value_type,
                                   r.status AS registry_status,
                                   ds.dataset_key, ds.status AS dataset_status,
                                   d.status AS design_status,
                                   fb.field_key,
                                   COALESCE(rp.policy_json, '{{}}'::jsonb) AS policy_json,
                                   COALESCE(rp.mode, 'ON_CHANGE') AS recording_mode,
                                   COALESCE(rp.enabled, TRUE) AS policy_enabled,
                                   s.expected_interval_ms
                            FROM storage_physical_registry r
                            JOIN storage_datasets ds ON ds.id = r.dataset_id
                            JOIN storage_designs d ON d.id = r.design_id
                            JOIN signal_definitions s ON s.id = r.signal_id
                            JOIN storage_field_bindings fb
                              ON fb.dataset_id = r.dataset_id AND fb.signal_id = r.signal_id
                            LEFT JOIN storage_recording_policies rp
                              ON rp.dataset_id = r.dataset_id
                            WHERE r.tenant_id = :tenant_id
                              AND r.tier = 'MANAGED'
                              AND r.signal_id = :signal_id
                              AND r.status IN ('ACTIVE', 'PAUSED')
                              {ds_filter}
                            ORDER BY CASE WHEN r.status = 'ACTIVE' THEN 0 ELSE 1 END,
                                     d.updated_at DESC NULLS LAST,
                                     r.updated_at DESC
                            LIMIT 1
                            """
                        ),
                        params,
                    )
                ).mappings().first()
                return dict(row) if row else None
        except SQLAlchemyError:
            return None

    async def _query_operational_rows(
        self,
        tenant_id: UUID,
        *,
        signal_id: UUID,
        value_type: str,
        start: datetime,
        end: datetime,
        limit: int,
        active_epoch: int,
        cursor_tuple: tuple[int, str] | None = None,
    ) -> list[HistoricalPoint]:
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        subtable = op_subtable_name(signal_id, value_type)
        fq = quote_fq_table(db, subtable)
        start_us = to_td_timestamp_us(start)
        end_us = to_td_timestamp_us(end)
        where = f"`ts` >= {start_us} AND `ts` < {end_us} AND `data_epoch` >= {int(active_epoch)}"
        if cursor_tuple is not None:
            where += f" AND `ts` >= {cursor_tuple[0]}"
        fetch_cap = min(limit + 8, 10_000)
        try:
            rows = await self._client.query_rows(
                f"SELECT `ts`, `val`, `acquired_at`, `source_time`, `raw_quality`, `reason_code`, "
                f"`origin`, `unit`, `event_uid`, `config_rev`, `data_epoch`, `record_kind` "
                f"FROM {fq} WHERE {where} ORDER BY `ts` ASC LIMIT {fetch_cap}"
            )
        except TDEngineError as exc:
            if _is_missing_td_object(exc):
                return []
            raise

        points: list[HistoricalPoint] = []
        for r in rows:
            ts_dt = _utc(r.get("ts"))
            if ts_dt is None:
                continue
            ts_us = to_td_timestamp_us(ts_dt)
            ev_uid = str(r.get("event_uid") or "")
            pt_id = _synthetic_point_id(signal_id, ts_us, ev_uid)
            if cursor_tuple is not None and (ts_us, pt_id) <= cursor_tuple:
                continue
            acq_dt = _utc(r.get("acquired_at")) or ts_dt
            src_dt = _utc(r.get("source_time"))
            decoded_val = _decode_td_value(r.get("val"), value_type)
            points.append(
                HistoricalPoint(
                    id=pt_id,
                    event_uid=ev_uid,
                    signal_id=signal_id,
                    event_time=ts_dt,
                    received_time=acq_dt,
                    source_time=src_dt,
                    value_type=value_type,
                    value=decoded_val,
                    unit=r.get("unit"),
                    quality=str(r.get("raw_quality") or "GOOD"),
                    reason_code=r.get("reason_code"),
                    origin=str(r.get("origin") or "LIVE"),
                    config_revision=int(r.get("config_rev") or 1),
                    data_epoch=int(r.get("data_epoch") or 1),
                    record_kind=str(r.get("record_kind") or "RAW_OPERATIONAL"),  # type: ignore[arg-type]
                    virtual=False,
                    dataset_id=None,
                )
            )
        points.sort(key=lambda p: (to_td_timestamp_us(p.event_time), p.id))
        return points[:limit]

    async def _query_managed_rows(
        self,
        binding: Mapping[str, Any],
        *,
        signal_id: UUID,
        start: datetime,
        end: datetime,
        limit: int,
        active_epoch: int,
        unit: str | None = None,
        cursor_tuple: tuple[int, str] | None = None,
    ) -> list[HistoricalPoint]:
        db = str(binding["td_database"])
        subtable = str(binding["td_subtable"])
        field_key = str(binding["field_key"])
        vtype = str(binding.get("value_type") or "float64")
        dataset_uuid = UUID(str(binding["dataset_id"]))
        fq = quote_fq_table(db, subtable)
        col = quote_ident(field_key, kind="column")
        start_us = to_td_timestamp_us(start)
        end_us = to_td_timestamp_us(end)
        where = f"`ts` >= {start_us} AND `ts` < {end_us} AND `data_epoch` >= {int(active_epoch)}"
        if cursor_tuple is not None:
            where += f" AND `ts` >= {cursor_tuple[0]}"
        fetch_cap = min(limit + 8, 10_000)
        try:
            rows = await self._client.query_rows(
                f"SELECT `ts`, {col} AS `val`, `acquired_at`, `source_time`, `raw_quality`, `reason_code`, "
                f"`event_uid`, `data_epoch`, `record_kind` "
                f"FROM {fq} WHERE {where} ORDER BY `ts` ASC LIMIT {fetch_cap}"
            )
        except TDEngineError as exc:
            if _is_missing_td_object(exc):
                return []
            raise

        points: list[HistoricalPoint] = []
        for r in rows:
            ts_dt = _utc(r.get("ts"))
            if ts_dt is None:
                continue
            ts_us = to_td_timestamp_us(ts_dt)
            ev_uid = str(r.get("event_uid") or "")
            pt_id = _synthetic_point_id(signal_id, ts_us, ev_uid)
            if cursor_tuple is not None and (ts_us, pt_id) <= cursor_tuple:
                continue
            acq_dt = _utc(r.get("acquired_at")) or ts_dt
            src_dt = _utc(r.get("source_time"))
            decoded_val = _decode_td_value(r.get("val"), vtype)
            points.append(
                HistoricalPoint(
                    id=pt_id,
                    event_uid=ev_uid,
                    signal_id=signal_id,
                    event_time=ts_dt,
                    received_time=acq_dt,
                    source_time=src_dt,
                    value_type=vtype,
                    value=decoded_val,
                    unit=unit,
                    quality=str(r.get("raw_quality") or "GOOD"),
                    reason_code=r.get("reason_code"),
                    origin="MANAGED",
                    config_revision=1,
                    data_epoch=int(r.get("data_epoch") or 1),
                    record_kind=str(r.get("record_kind") or "MANAGED_RECORDED"),  # type: ignore[arg-type]
                    virtual=False,
                    dataset_id=dataset_uuid,
                )
            )
        points.sort(key=lambda p: (to_td_timestamp_us(p.event_time), p.id))
        return points[:limit]

    async def _pre_window_seed(
        self,
        *,
        db: str,
        subtable: str,
        val_col_sql: str,
        value_type: str,
        signal_id: UUID,
        start: datetime,
        active_epoch: int,
        origin: str,
        unit: str | None,
        dataset_id: UUID | None,
    ) -> HistoricalPoint | None:
        fq = quote_fq_table(db, subtable)
        start_us = to_td_timestamp_us(start)
        try:
            rows = await self._client.query_rows(
                f"SELECT `ts`, {val_col_sql} AS `val`, `acquired_at`, `source_time`, `raw_quality`, `reason_code`, "
                f"`event_uid`, `data_epoch`, `record_kind` "
                f"FROM {fq} WHERE `ts` < {start_us} AND `data_epoch` >= {int(active_epoch)} "
                "ORDER BY `ts` DESC LIMIT 1"
            )
        except TDEngineError as exc:
            if _is_missing_td_object(exc):
                return None
            raise
        if not rows:
            return None
        r = rows[0]
        ts_dt = _utc(r.get("ts"))
        if ts_dt is None:
            return None
        ts_us = to_td_timestamp_us(ts_dt)
        ev_uid = str(r.get("event_uid") or "")
        return HistoricalPoint(
            id=_synthetic_point_id(signal_id, ts_us, f"seed:{ev_uid}"),
            event_uid=ev_uid,
            signal_id=signal_id,
            event_time=ts_dt,
            received_time=_utc(r.get("acquired_at")) or ts_dt,
            source_time=_utc(r.get("source_time")),
            value_type=value_type,
            value=_decode_td_value(r.get("val"), value_type),
            unit=unit,
            quality=str(r.get("raw_quality") or "GOOD"),
            reason_code=r.get("reason_code"),
            origin=origin,
            config_revision=1,
            data_epoch=int(r.get("data_epoch") or 1),
            record_kind=str(r.get("record_kind") or "RAW_OPERATIONAL"),  # type: ignore[arg-type]
            virtual=True,
            dataset_id=dataset_id,
        )

    async def query_raw(
        self,
        tenant_id: UUID,
        *,
        signal_id: UUID,
        start: datetime,
        end: datetime,
        limit: int,
        cursor: str | None = None,
        mode: Literal["operational", "recorded", "reconstructed"] = "operational",
        dataset_id: UUID | None = None,
        session: AsyncSession | None = None,
        value_type: str | None = None,
        active_epoch: int | None = None,
    ) -> HistoricalPage:
        start_utc = _utc(start)
        end_utc = _utc(end)
        if start_utc is None or end_utc is None or end_utc <= start_utc:
            raise AppError(422, "RANGE", "Invalid time range.")
        if end_utc - start_utc > timedelta(days=31):
            raise AppError(422, "RANGE", "Query window is limited to 31 days. Narrow the range or use aggregation.")

        bounded_limit = min(max(int(limit), 1), 2000)
        cursor_tuple = _parse_cursor(cursor)
        eff_epoch = active_epoch if active_epoch is not None else await _active_epoch_for(session, tenant_id)

        meta_map = await self._signal_meta_map(session, tenant_id, [signal_id])
        sig_meta = meta_map.get(signal_id, {})
        eff_vtype = value_type or sig_meta.get("data_type")
        unit = sig_meta.get("unit")
        expected_interval_ms = sig_meta.get("expected_interval_ms")

        if mode == "operational":
            if not eff_vtype:
                return HistoricalPage(items=[], next_cursor=None, downsampled=False, fidelity="operational_full")
            pts = await self._query_operational_rows(
                tenant_id,
                signal_id=signal_id,
                value_type=str(eff_vtype),
                start=start_utc,
                end=end_utc,
                limit=bounded_limit + 1,
                active_epoch=eff_epoch,
                cursor_tuple=cursor_tuple,
            )
            next_cur = None
            if len(pts) > bounded_limit:
                last_pt = pts[bounded_limit - 1]
                next_cur = _format_cursor(last_pt.event_time, last_pt.id)
                pts = pts[:bounded_limit]
            return HistoricalPage(items=pts, next_cursor=next_cur, downsampled=False, fidelity="operational_full")

        binding = await self._managed_binding(session, tenant_id, signal_id, dataset_id=dataset_id)
        if mode == "recorded":
            if binding is None:
                if dataset_id is not None:
                    raise AppError(404, "DATASET_NOT_FOUND", "Managed dataset binding not found for signal.")
                return HistoricalPage(
                    items=[],
                    next_cursor=None,
                    downsampled=False,
                    fidelity="managed_recorded",
                    coverage_notes=["Signal has no active or paused Managed dataset binding; showing 0 recorded events."],
                )
            pts = await self._query_managed_rows(
                binding,
                signal_id=signal_id,
                start=start_utc,
                end=end_utc,
                limit=bounded_limit + 1,
                active_epoch=eff_epoch,
                unit=unit,
                cursor_tuple=cursor_tuple,
            )
            next_cur = None
            if len(pts) > bounded_limit:
                last_pt = pts[bounded_limit - 1]
                next_cur = _format_cursor(last_pt.event_time, last_pt.id)
                pts = pts[:bounded_limit]
            notes: list[str] = []
            if str(binding.get("recording_mode") or "").upper() in {"ON_CHANGE", "INTERVAL"}:
                notes.append(
                    f"Sparse Managed recording ({binding['recording_mode']}): unchanged intervals are compressed."
                )
            return HistoricalPage(
                items=pts,
                next_cursor=next_cur,
                downsampled=False,
                fidelity="managed_recorded",
                coverage_notes=notes,
            )

        # mode == "reconstructed"
        coverage_notes: list[str] = []
        policy_paused = False
        policy_interval_ms: int | None = None
        if binding is not None:
            ds_uuid = UUID(str(binding["dataset_id"]))
            db = str(binding["td_database"])
            subtable = str(binding["td_subtable"])
            field_key = str(binding["field_key"])
            val_col_sql = quote_ident(field_key, kind="column")
            src_vtype = str(binding.get("value_type") or eff_vtype or "float64")
            src_origin = "MANAGED"
            policy_paused = (
                str(binding.get("registry_status") or "").upper() == "PAUSED"
                or str(binding.get("dataset_status") or "").upper() == "PAUSED"
                or str(binding.get("design_status") or "").upper() == "PAUSED"
            )
            raw_pj = binding.get("policy_json")
            if isinstance(raw_pj, str):
                try:
                    raw_pj = json.loads(raw_pj)
                except json.JSONDecodeError:
                    raw_pj = {}
            if isinstance(raw_pj, Mapping) and raw_pj.get("interval_ms"):
                try:
                    policy_interval_ms = int(raw_pj["interval_ms"])
                except (TypeError, ValueError):
                    policy_interval_ms = None
            events = await self._query_managed_rows(
                binding,
                signal_id=signal_id,
                start=start_utc,
                end=end_utc,
                limit=5000,
                active_epoch=eff_epoch,
                unit=unit,
                cursor_tuple=None,
            )
        else:
            if dataset_id is not None:
                raise AppError(404, "DATASET_NOT_FOUND", "Managed dataset binding not found for signal.")
            if not eff_vtype:
                return HistoricalPage(items=[], next_cursor=None, downsampled=False, fidelity="reconstructed")
            ds_uuid = None
            db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
            subtable = op_subtable_name(signal_id, str(eff_vtype))
            val_col_sql = "`val`"
            src_vtype = str(eff_vtype)
            src_origin = "LIVE"
            coverage_notes.append("No Managed dataset binding found; reconstructed from full Operational History.")
            events = await self._query_operational_rows(
                tenant_id,
                signal_id=signal_id,
                value_type=src_vtype,
                start=start_utc,
                end=end_utc,
                limit=5000,
                active_epoch=eff_epoch,
                cursor_tuple=None,
            )

        pre_seed = await self._pre_window_seed(
            db=db,
            subtable=subtable,
            val_col_sql=val_col_sql,
            value_type=src_vtype,
            signal_id=signal_id,
            start=start_utc,
            active_epoch=eff_epoch,
            origin=src_origin,
            unit=unit,
            dataset_id=ds_uuid,
        )

        eff_interval_ms = expected_interval_ms
        if policy_interval_ms is not None:
            eff_interval_ms = max(int(eff_interval_ms or 0), policy_interval_ms)
        stale_after_ms = canonical_stale_after_ms(eff_interval_ms)
        hold_delta = timedelta(milliseconds=stale_after_ms)

        timeline: list[HistoricalPoint] = []
        held_anchor: HistoricalPoint | None = None

        if pre_seed is not None:
            pre_valid = (
                pre_seed.quality in {"GOOD", "UNCERTAIN"}
                and pre_seed.value is not None
                and pre_seed.record_kind not in {"gap_marker", "interval_null"}
            )
            if not policy_paused and pre_valid and start_utc <= pre_seed.event_time + hold_delta:
                seed_pt = HistoricalPoint(
                    id=_synthetic_point_id(signal_id, to_td_timestamp_us(start_utc), f"seed:{pre_seed.event_uid}"),
                    event_uid=f"seed:{pre_seed.event_uid}",
                    signal_id=signal_id,
                    event_time=start_utc,
                    received_time=start_utc,
                    source_time=pre_seed.source_time,
                    value_type=src_vtype,
                    value=pre_seed.value,
                    unit=unit,
                    quality=pre_seed.quality,
                    reason_code="RECONSTRUCTED_PRE_WINDOW_SEED",
                    origin="RECONSTRUCTED",
                    config_revision=pre_seed.config_revision,
                    data_epoch=pre_seed.data_epoch,
                    record_kind="RECONSTRUCTED_STEP",
                    virtual=True,
                    dataset_id=ds_uuid,
                )
                timeline.append(seed_pt)
                held_anchor = pre_seed

        def _maybe_insert_gap(until_ts: datetime) -> None:
            nonlocal held_anchor
            if held_anchor is None:
                return
            gap_ts = held_anchor.event_time + hold_delta
            if gap_ts < until_ts and start_utc <= gap_ts < end_utc:
                gap_us = to_td_timestamp_us(gap_ts)
                timeline.append(
                    HistoricalPoint(
                        id=_synthetic_point_id(signal_id, gap_us, f"gap:{gap_us}"),
                        event_uid=f"gap:{gap_us}",
                        signal_id=signal_id,
                        event_time=gap_ts,
                        received_time=gap_ts,
                        source_time=None,
                        value_type=src_vtype,
                        value=None,
                        unit=unit,
                        quality="STALE",
                        reason_code="STALE_NO_DATA",
                        origin="RECONSTRUCTED",
                        config_revision=1,
                        data_epoch=held_anchor.data_epoch,
                        record_kind="RECONSTRUCTED_STEP",
                        virtual=True,
                        dataset_id=ds_uuid,
                    )
                )
                held_anchor = None

        for ev in events:
            _maybe_insert_gap(ev.event_time)
            timeline.append(ev)
            ev_valid = (
                ev.quality in {"GOOD", "UNCERTAIN"}
                and ev.record_kind not in {"gap_marker", "interval_null"}
                and not policy_paused
            )
            if ev_valid and ev.value is not None:
                held_anchor = ev
            else:
                held_anchor = None

        reconstruct_horizon = min(end_utc, _utcnow())
        _maybe_insert_gap(reconstruct_horizon)

        if cursor_tuple is not None:
            timeline = [p for p in timeline if (to_td_timestamp_us(p.event_time), p.id) > cursor_tuple]

        next_cur = None
        if len(timeline) > bounded_limit:
            last_pt = timeline[bounded_limit - 1]
            next_cur = _format_cursor(last_pt.event_time, last_pt.id)
            timeline = timeline[:bounded_limit]

        return HistoricalPage(
            items=timeline,
            next_cursor=next_cur,
            downsampled=False,
            fidelity="reconstructed",
            coverage_notes=coverage_notes,
        )

    async def aggregate(
        self,
        tenant_id: UUID,
        *,
        signal_ids: list[UUID],
        start: datetime,
        end: datetime,
        bucket_ms: int,
        fn: Literal["min", "max", "avg", "count", "sum"],
        session: AsyncSession | None = None,
        active_epoch: int | None = None,
    ) -> list[HistoricalBucket]:
        if fn not in {"min", "max", "avg", "count", "sum"}:
            raise AppError(422, "AGGREGATE", "Unsupported aggregate function.")
        if bucket_ms < 1000 or bucket_ms > 86_400_000:
            raise AppError(422, "BUCKET", "Bucket must be between 1 second and 1 day.")
        if len(signal_ids) > 20:
            raise AppError(422, "LIMIT", "At most 20 signals per aggregation query.")
        start_utc = _utc(start)
        end_utc = _utc(end)
        if start_utc is None or end_utc is None or end_utc <= start_utc:
            raise AppError(422, "RANGE", "Invalid time range.")
        if not signal_ids:
            return []

        eff_epoch = active_epoch if active_epoch is not None else await _active_epoch_for(session, tenant_id)
        meta_map = await self._signal_meta_map(session, tenant_id, signal_ids)
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        start_us = to_td_timestamp_us(start_utc)
        end_us = to_td_timestamp_us(end_utc)
        fn_sql = f"{fn.upper()}(`val`)"

        buckets: list[HistoricalBucket] = []
        for sid in sorted(dict.fromkeys(signal_ids), key=str):
            vtype = str((meta_map.get(sid) or {}).get("data_type") or "").lower()
            if vtype not in _NUMERIC_TYPES:
                continue
            fq = quote_fq_table(db, op_subtable_name(sid, vtype))
            try:
                rows = await self._client.query_rows(
                    f"SELECT _WSTART AS `bucket`, {fn_sql} AS `value`, COUNT(`val`) AS `sample_count` "
                    f"FROM {fq} "
                    f"WHERE `ts` >= {start_us} AND `ts` < {end_us} "
                    f"AND `data_epoch` >= {int(eff_epoch)} "
                    f"AND `raw_quality` = 'GOOD' AND `val` IS NOT NULL "
                    f"INTERVAL({int(bucket_ms)}a) FILL(NONE) ORDER BY `bucket` ASC"
                )
            except TDEngineError as exc:
                if _is_missing_td_object(exc):
                    continue
                raise

            for r in rows:
                b_dt = _utc(r.get("bucket"))
                if b_dt is None:
                    continue
                cnt = int(r.get("sample_count") or 0)
                raw_v = r.get("value")
                val_f: float | None = None
                if raw_v is not None:
                    f = float(raw_v)
                    val_f = f if math.isfinite(f) else None
                buckets.append(
                    HistoricalBucket(
                        signal_id=sid,
                        bucket=b_dt,
                        value=val_f,
                        good_count=cnt,
                        sample_count=cnt,
                    )
                )

        buckets.sort(key=lambda b: (str(b.signal_id), b.bucket))
        return buckets

    async def value_at(
        self,
        tenant_id: UUID,
        *,
        signal_id: UUID,
        at: datetime,
        axis: Literal["source", "event"] = "event",
        lookback_ms: int | None = None,
        session: AsyncSession | None = None,
        active_epoch: int | None = None,
    ) -> tuple[Any, str | None, datetime | None] | None:
        batch = await self.value_at_batch(
            tenant_id,
            requests=[(signal_id, at, axis)],
            lookback_ms=lookback_ms,
            session=session,
            active_epoch=active_epoch,
        )
        hit = batch.get((str(signal_id), at))
        if hit is None:
            return None
        val, qual, src_ts, _rcv_ts = hit
        return (val, qual, src_ts)

    async def value_at_batch(
        self,
        tenant_id: UUID,
        *,
        requests: Sequence[tuple[UUID | str, datetime, str]],
        lookback_ms: int | None = None,
        session: AsyncSession | None = None,
        active_epoch: int | None = None,
    ) -> dict[tuple[str, datetime], tuple[Any, str, datetime | None, datetime | None] | None]:
        if not requests:
            return {}
        eff_epoch = active_epoch if active_epoch is not None else await _active_epoch_for(session, tenant_id)
        unique_sids = list({UUID(str(sid)) for sid, _at, _mode in requests})
        meta_map = await self._signal_meta_map(session, tenant_id, unique_sids)
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)

        out: dict[tuple[str, datetime], tuple[Any, str, datetime | None, datetime | None] | None] = {}
        seen_req: dict[tuple[str, datetime, str], Any] = {}

        for sid_raw, at, mode in requests:
            sid_uuid = UUID(str(sid_raw))
            sid_str = str(sid_raw)
            norm_mode = "s" if mode in {"s", "source"} else "e"
            dedup_key = (str(sid_uuid), at, norm_mode)
            if dedup_key in seen_req:
                out[(sid_str, at)] = seen_req[dedup_key]
                continue

            vtype = str((meta_map.get(sid_uuid) or {}).get("data_type") or "")
            if not vtype:
                seen_req[dedup_key] = None
                out[(sid_str, at)] = None
                continue

            at_utc = _utc(at)
            if at_utc is None:
                seen_req[dedup_key] = None
                out[(sid_str, at)] = None
                continue

            fq = quote_fq_table(db, op_subtable_name(sid_uuid, vtype))
            at_us = to_td_timestamp_us(at_utc)
            min_clause = ""
            if lookback_ms is not None and int(lookback_ms) > 0:
                min_us = max(0, at_us - int(lookback_ms) * 1000)
                min_clause = f" AND `{'source_time' if norm_mode == 's' else 'ts'}` >= {min_us}"

            if norm_mode == "s":
                sql = (
                    f"SELECT `ts`, `val`, `raw_quality`, `source_time`, `acquired_at` FROM {fq} "
                    f"WHERE `source_time` IS NOT NULL AND `source_time` <= {at_us}{min_clause} "
                    f"AND `data_epoch` >= {int(eff_epoch)} AND `raw_quality` IN ('GOOD', 'UNCERTAIN') "
                    "ORDER BY `source_time` DESC, `ts` DESC LIMIT 1"
                )
            else:
                sql = (
                    f"SELECT `ts`, `val`, `raw_quality`, `source_time`, `acquired_at` FROM {fq} "
                    f"WHERE `ts` <= {at_us}{min_clause} "
                    f"AND `data_epoch` >= {int(eff_epoch)} AND `raw_quality` IN ('GOOD', 'UNCERTAIN') "
                    "ORDER BY `ts` DESC LIMIT 1"
                )

            try:
                rows = await self._client.query_rows(sql)
            except TDEngineError as exc:
                if _is_missing_td_object(exc):
                    rows = []
                else:
                    raise

            if not rows:
                seen_req[dedup_key] = None
                out[(sid_str, at)] = None
                continue

            r = rows[0]
            val = _decode_td_value(r.get("val"), vtype)
            qual = str(r.get("raw_quality") or "GOOD")
            src_ts = _utc(r.get("source_time"))
            rcv_ts = _utc(r.get("acquired_at")) or _utc(r.get("ts"))
            res_tuple = (val, qual, src_ts, rcv_ts)
            seen_req[dedup_key] = res_tuple
            out[(sid_str, at)] = res_tuple

        return out

    async def fallback_source_times(
        self,
        tenant_id: UUID,
        pairs: Sequence[tuple[UUID | str, datetime]],
        *,
        session: AsyncSession | None = None,
        active_epoch: int | None = None,
    ) -> dict[tuple[str, datetime], datetime | None]:
        if not pairs:
            return {}
        eff_epoch = active_epoch if active_epoch is not None else await _active_epoch_for(session, tenant_id)
        sids = list({UUID(str(sid)) for sid, _ in pairs})
        meta_map = await self._signal_meta_map(session, tenant_id, sids)
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)

        out: dict[tuple[str, datetime], datetime | None] = {}
        for sid_raw, at in pairs:
            sid_uuid = UUID(str(sid_raw))
            vtype = str((meta_map.get(sid_uuid) or {}).get("data_type") or "")
            at_utc = _utc(at)
            if not vtype or at_utc is None:
                out[(str(sid_raw).lower(), at)] = None
                continue
            fq = quote_fq_table(db, op_subtable_name(sid_uuid, vtype))
            at_us = to_td_timestamp_us(at_utc)
            try:
                rows = await self._client.query_rows(
                    f"SELECT `source_time` FROM {fq} "
                    f"WHERE `ts` = {at_us} AND `data_epoch` >= {int(eff_epoch)} "
                    "ORDER BY `acquired_at` DESC LIMIT 1"
                )
            except TDEngineError as exc:
                if _is_missing_td_object(exc):
                    rows = []
                else:
                    raise
            src_dt = _utc(rows[0].get("source_time")) if rows else None
            out[(str(sid_raw).lower(), at)] = src_dt
        return out

    async def storage_overview_metrics(
        self,
        tenant_id: UUID,
        *,
        active_epoch: int = 1,
        include_disk: bool = True,
    ) -> dict[str, Any]:
        db = tenant_database_name(tenant_id, prefix=self._client.config.db_prefix)
        total_obs = 0
        oldest: datetime | None = None
        newest: datetime | None = None

        for stable in OP_STABLE_COL_TYPES:
            fq_st = quote_fq_table(db, stable)
            try:
                rows = await self._client.query_rows(
                    f"SELECT COUNT(*) AS `cnt`, FIRST(`ts`) AS `oldest`, LAST(`ts`) AS `newest` "
                    f"FROM {fq_st} WHERE `data_epoch` >= {int(active_epoch)}"
                )
            except TDEngineError as exc:
                if _is_missing_td_object(exc):
                    continue
                raise
            if not rows:
                continue
            r = rows[0]
            total_obs += int(r.get("cnt") or 0)
            o_dt = _utc(r.get("oldest"))
            n_dt = _utc(r.get("newest"))
            if o_dt is not None and (oldest is None or o_dt < oldest):
                oldest = o_dt
            if n_dt is not None and (newest is None or n_dt > newest):
                newest = n_dt

        disk_bytes: int | None = None
        if include_disk:
            try:
                health = await self._client.health_probe()
                disk_bytes = health.disk_used_bytes
            except Exception:  # noqa: BLE001
                disk_bytes = None

        return {
            "observations": total_obs,
            "oldest": oldest,
            "newest": newest,
            "disk_bytes": disk_bytes,
            "approximate": False,
        }
