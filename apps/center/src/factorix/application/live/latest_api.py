"""Latest-value read API and stream payloads (``latest_states``, ``latest_stream_payload``, ``select_binding``, ``RejectionThrottle``). Moved verbatim from ``factorix.modules.telemetry`` (R2-E B5, move-only)."""

from __future__ import annotations

from collections.abc import Mapping
import logging
import math
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.application.live.freshness_service import FreshnessService, freshness_service
from factorix.domain.signal_state import evaluate_signal_state  # noqa: F401 - re-exported by modules.telemetry
from factorix.modules.live_state import (
    compute_health_dimensions,
    extract_runtime_health,
    get_live_state_provider,
    record_from_pg_row,
)
from factorix.modules.common import as_uuid, fetch_all, iso_ms, utcnow
from factorix.platform.errors import AppError


logger = logging.getLogger("factorix.modules.telemetry")


class RejectionThrottle:
    """Remembers when a rejection was last audited so a misrouted signal cannot flood audit_events.

    Only the first rejection per key (tenant, edge, signal) per window is audited; every rejected
    sample is still recorded in observation_quarantine.
    """

    def __init__(self, window: timedelta = timedelta(hours=1), max_keys: int = 10_000) -> None:
        self.window = window
        self.max_keys = max_keys
        self._seen: dict[tuple[str, ...], datetime] = {}

    def should_audit(self, key: tuple[str, ...], now: datetime) -> bool:
        last = self._seen.get(key)
        if last is not None and now - last < self.window:
            return False
        if key not in self._seen and len(self._seen) >= self.max_keys:
            self._prune(now)
        self._seen[key] = now
        return True

    def _prune(self, now: datetime) -> None:
        self._seen = {key: moment for key, moment in self._seen.items() if now - moment < self.window}
        if len(self._seen) >= self.max_keys:
            newest = sorted(self._seen.items(), key=lambda pair: pair[1])[len(self._seen) // 2 :]
            self._seen = dict(newest)


def select_binding(rows: list[dict[str, Any]], moment: datetime) -> dict[str, Any] | None:
    """Pick the binding whose validity window contains the acquisition time (received_time)."""
    for row in sorted(rows, key=lambda item: item["valid_from"], reverse=True):
        valid_from = row["valid_from"]
        valid_to = row.get("valid_to")
        if valid_from <= moment and (valid_to is None or valid_to > moment):
            return row
    return None


_NO_EVIDENCE = FreshnessService(use_evidence=False)


def latest_stream_payload(
    *,
    signal_id: Any,
    value: Any,
    quality: str,
    reason: str | None,
    received_time: datetime,
    source_time: datetime | None,
    expected_interval_ms: int | None,
    null_allowed: bool = False,
    now: datetime | None = None,
    include_meta: bool = False,
    data_epoch: int | None = None,
    last_acquired_at: datetime | None = None,
    last_value_changed_at: datetime | None = None,
    health_dimensions: Mapping[str, str] | None = None,
    job_interval_ms: int | None = None,
    freshness: FreshnessService | None = None,
) -> dict[str, Any]:
    """Push message for ``/stream`` subscribers, evaluated by ``FreshnessService``.

    Without ``freshness`` the payload is evaluated with intervals only (signal interval, falling back
    to the job interval): ingestion has no pipeline evidence, so it cannot tell DELAYED from STALE.
    The API re-evaluates every pushed message at dispatch (``FreshnessService.refresh_message``).
    """
    acq = last_acquired_at or received_time
    service = freshness or _NO_EVIDENCE
    state = service.evaluate(
        signal_id=signal_id,
        has_observation=True,
        raw_quality=quality,
        raw_value=value,
        event_time=received_time,
        last_acquired_at=acq,
        expected_interval_ms=expected_interval_ms,
        job_interval_ms=job_interval_ms,
        raw_reason_code=reason,
        null_allowed=null_allowed,
        now=now,
    )
    payload: dict[str, Any] = {
        "type": "latest",
        "signal_id": str(signal_id),
        "value": value,
        "quality": quality,
        "effective_status": state.effective_status,
        "reason_code": state.reason_code,
        "received_time": iso_ms(received_time),
        "source_time": iso_ms(source_time),
    }
    if include_meta:
        payload["evaluated_at"] = state.evaluated_at
        payload["stale_after_ms"] = state.stale_after_ms
        if data_epoch is not None:
            payload["data_epoch"] = int(data_epoch)
        if last_acquired_at is not None:
            payload["last_acquired_at"] = iso_ms(last_acquired_at)
        if last_value_changed_at is not None:
            payload["last_value_changed_at"] = iso_ms(last_value_changed_at)
        if health_dimensions:
            for dim_key in ("source_health", "connection_health", "broker_health", "storage_health"):
                if health_dimensions.get(dim_key) is not None:
                    payload[dim_key] = health_dimensions[dim_key]
    return payload


def connection_health_payload(*, connection_id: Any, health: str, effective_health: str, last_error: str | None, last_success_at: Any) -> dict[str, Any]:
    return {
        "type": "health",
        "entity": "connection",
        "id": str(connection_id),
        "health": health,
        "effective_health": effective_health,
        "last_error": last_error,
        "last_success_at": iso_ms(last_success_at),
    }


_LATEST_TIME_FIELDS = ("event_time", "received_time", "source_time", "last_good_event_time", "updated_at")


async def latest_states(session: AsyncSession, tenant_id: UUID, signal_ids: list[UUID]) -> list[dict[str, Any]]:
    if not signal_ids:
        return []
    if len(signal_ids) > 200:
        raise AppError(422, "LIMIT", "At most 200 signals per latest read.")
    rows = await fetch_all(
        session,
        """
        SELECT l.*, s.key, s.display_name, s.expected_interval_ms,
               l.reason_code AS raw_reason,
               COALESCE(nb.nullable, FALSE) AS nullable,
               COALESCE(nb.connection_status = 'PAUSED', FALSE) AS connection_paused,
               nb.connection_id AS nb_connection_id,
               nb.connection_health AS nb_connection_health,
               nb.connection_status AS nb_connection_status,
               nb.job_interval_ms AS nb_job_interval_ms,
               COALESCE(nb.binding_enabled, TRUE) AS nb_binding_enabled,
               s.status AS nb_signal_status
        FROM latest_signal_state l
        JOIN signal_definitions s ON s.id = l.signal_id
        LEFT JOIN LATERAL (
            SELECT COALESCE((f.address_json->>'nullable') = 'true', FALSE) AS nullable,
                   b.enabled AS binding_enabled,
                   c.id AS connection_id,
                   c.health AS connection_health,
                   c.status AS connection_status,
                   j.interval_ms AS job_interval_ms
            FROM signal_bindings b
            JOIN source_fields f ON f.id = b.source_field_id
            LEFT JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
            LEFT JOIN connections c ON c.id = j.connection_id
            WHERE b.signal_id = l.signal_id AND b.enabled = TRUE AND b.valid_to IS NULL
            LIMIT 1
        ) nb ON TRUE
        WHERE l.tenant_id = :tenant_id AND l.signal_id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": signal_ids},
    )
    now = utcnow()
    live_provider = get_live_state_provider() if isinstance(session, AsyncSession) else None
    active_epoch = 1
    collector_online: bool | None = None
    broker_ok: bool | None = None
    storage_ok: bool | None = None
    sig_meta_by_id: dict[UUID, dict[str, Any]] = {}

    if isinstance(session, AsyncSession):
        try:
            async with session.begin_nested():
                gen_res = await session.execute(
                    text("SELECT active_epoch FROM telemetry_generations WHERE tenant_id = :tenant_id"),
                    {"tenant_id": tenant_id},
                )
                gen_row = gen_res.mappings().first()
                if gen_row is not None and gen_row.get("active_epoch") is not None:
                    active_epoch = max(1, int(gen_row["active_epoch"]))
        except SQLAlchemyError:
            active_epoch = 1

        try:
            async with session.begin_nested():
                rt_res = await session.execute(
                    text(
                        """
                        SELECT role, health, broker_ok, queues_json, last_heartbeat
                        FROM collector_runtime_status
                        """
                    ),
                    {},
                )
                rt_rows = [dict(r) for r in rt_res.mappings().all()]
                collector_online, broker_ok, storage_ok = extract_runtime_health(
                    rt_rows,
                    now=now,
                    tdengine_configured=(live_provider is not None),
                )
        except SQLAlchemyError:
            collector_online, broker_ok, storage_ok = None, None, None

        if live_provider is not None:
            live_provider.set_active_epoch(tenant_id, active_epoch)
            try:
                async with session.begin_nested():
                    meta_res = await session.execute(
                        text(
                            """
                            SELECT s.id, s.resource_id, s.key, s.display_name, s.data_type, s.unit,
                                   s.expected_interval_ms, s.status AS signal_status,
                                   COALESCE(nb.nullable, FALSE) AS nullable,
                                   COALESCE(nb.binding_enabled, FALSE) AS binding_enabled,
                                   nb.connection_id, nb.connection_health, nb.connection_status,
                                   nb.job_interval_ms
                            FROM signal_definitions s
                            LEFT JOIN LATERAL (
                                SELECT COALESCE((f.address_json->>'nullable') = 'true', FALSE) AS nullable,
                                       b.enabled AS binding_enabled,
                                       c.id AS connection_id,
                                       c.health AS connection_health,
                                       c.status AS connection_status,
                                       j.interval_ms AS job_interval_ms
                                FROM signal_bindings b
                                JOIN source_fields f ON f.id = b.source_field_id
                                LEFT JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
                                LEFT JOIN connections c ON c.id = j.connection_id
                                WHERE b.signal_id = s.id AND b.valid_to IS NULL
                                ORDER BY b.enabled DESC, b.valid_from DESC
                                LIMIT 1
                            ) nb ON TRUE
                            WHERE s.tenant_id = :tenant_id AND s.id = ANY(:ids)
                            """
                        ),
                        {"tenant_id": tenant_id, "ids": signal_ids},
                    )
                    for mr in meta_res.mappings().all():
                        sid_u = as_uuid(mr["id"])
                        sig_meta_by_id[sid_u] = dict(mr)
            except SQLAlchemyError:
                sig_meta_by_id = {}

            if sig_meta_by_id:
                # Only signals with neither a cached entry nor a PostgreSQL latest row need TDengine
                # cold recovery (the PG rows are seeded just below).
                pg_ids = {as_uuid(r["signal_id"]) for r in rows}
                missing_specs = {
                    sid_u: meta
                    for sid_u, meta in sig_meta_by_id.items()
                    if sid_u not in pg_ids and live_provider.get_entry(tenant_id, sid_u) is None
                }
                if missing_specs:
                    await live_provider.warm_from_tdengine(
                        tenant_id, missing_specs, active_epoch=active_epoch, mark_unverified=True
                    )

    out_rows: list[dict[str, Any]] = []
    seen_sids: set[UUID] = set()

    for row in rows:
        nb_conn_health = row.pop("nb_connection_health", None)
        nb_conn_status = row.pop("nb_connection_status", None)
        nb_conn_id = row.pop("nb_connection_id", None)
        nb_job_interval = row.pop("nb_job_interval_ms", None)
        nb_binding_enabled = bool(row.pop("nb_binding_enabled", True))
        nb_signal_status = str(row.pop("nb_signal_status", "ACTIVE") or "ACTIVE")
        raw_reason = row.pop("raw_reason", None)
        conn_paused = bool(row.pop("connection_paused", False))
        binding_enabled = nb_binding_enabled and nb_signal_status == "ACTIVE"

        row_epoch = int(row.get("data_epoch") or 1)
        if isinstance(session, AsyncSession) and row_epoch < active_epoch:
            # Older epoch PG row must never resurface into the active generation.
            continue

        sid = as_uuid(row["signal_id"])
        seen_sids.add(sid)

        if live_provider is not None:
            pg_rec, pg_seq, pg_upd = record_from_pg_row(row, tenant_id=tenant_id)
            post_boot = live_provider.is_verified_in_session(tenant_id, sid) or (
                pg_upd is not None
                and pg_upd > live_provider.started_at
                and pg_rec.last_acquired_at > live_provider.started_at
            )
            live_provider.seed_from_record(
                pg_rec,
                source_sequence=pg_seq,
                restored_unverified=not post_boot,
                expected_interval_ms=row.get("expected_interval_ms"),
                null_allowed=bool(row.get("nullable")),
            )
            evaluated = live_provider.evaluate_signal(
                tenant_id,
                sid,
                binding_enabled=binding_enabled,
                expected_interval_ms=row.get("expected_interval_ms"),
                null_allowed=bool(row.get("nullable")),
                connection_paused=conn_paused,
                connection_health=nb_conn_health,
                connection_status=nb_conn_status,
                active_bindings=1 if binding_enabled else 0,
                collector_online=collector_online,
                broker_ok=broker_ok,
                storage_ok=storage_ok,
                now=now,
                connection_id=nb_conn_id,
                job_interval_ms=nb_job_interval,
            )
            rec = evaluated.record
            eval_result = evaluated.evaluation
            dims = evaluated.health_dimensions
            if rec is not None:
                row["value"] = rec.value
                row["value_json"] = {"v": rec.value}
                row["raw_quality"] = rec.raw_quality
                row["event_time"] = rec.event_time
                row["received_time"] = rec.last_acquired_at
                row["source_time"] = rec.source_time
                row["last_acquired_at"] = rec.last_acquired_at
                row["last_value_changed_at"] = rec.last_value_changed_at
                row["data_epoch"] = rec.data_epoch
                row["last_good_value_json"] = {"v": rec.last_good_value} if rec.last_good_value is not None else None
                row["last_good_event_time"] = rec.last_good_at
                row["updated_at"] = rec.updated_at or rec.last_acquired_at
            else:
                row["value"] = None
                row["raw_quality"] = row.get("quality")
        else:
            value_json = row.get("value_json")
            val = None if value_json is None else value_json.get("v")
            row["value"] = val
            last_good_val = None
            if row.get("last_good_value_json") is not None and isinstance(row["last_good_value_json"], dict):
                last_good_val = row["last_good_value_json"].get("v")
            reason_code_in = row.get("reason_code") or raw_reason
            last_acq = row.get("last_acquired_at") or row.get("received_time")
            eval_result = freshness_service().evaluate(
                signal_id=sid,
                has_observation=True,
                raw_quality=row.get("quality"),
                raw_value=val,
                event_time=row.get("event_time"),
                last_acquired_at=last_acq,
                expected_interval_ms=row.get("expected_interval_ms"),
                job_interval_ms=nb_job_interval,
                connection_id=nb_conn_id,
                connection_health=nb_conn_health,
                last_good_value=last_good_val,
                last_good_time=row.get("last_good_event_time"),
                raw_reason_code=reason_code_in,
                binding_enabled=binding_enabled,
                null_allowed=bool(row.get("nullable")),
                connection_paused=conn_paused,
                now=now,
            )
            dims = compute_health_dimensions(
                signal_effective_status=eval_result.effective_status,
                reason_code=eval_result.reason_code,
                connection_health=nb_conn_health,
                connection_status=nb_conn_status,
                active_bindings=1 if binding_enabled else 0,
                collector_online=collector_online,
                broker_ok=broker_ok,
                storage_ok=storage_ok,
            )
            row["raw_quality"] = row.get("quality")

        row["source_quality"] = eval_result.source_quality
        row["freshness"] = eval_result.freshness
        row["delivery_lag_ms"] = eval_result.delivery_lag_ms
        if nb_conn_id is not None:
            row["connection_id"] = str(nb_conn_id)
        row["effective_status"] = eval_result.effective_status
        row["reason_code"] = eval_result.reason_code
        row["evaluated_at"] = iso_ms(now)
        row["stale_after_ms"] = eval_result.stale_after_ms
        row["last_good"] = eval_result.last_good
        row["quality"] = eval_result.effective_status
        row["source_health"] = dims["source_health"]
        row["connection_health"] = dims["connection_health"]
        row["broker_health"] = dims["broker_health"]
        row["storage_health"] = dims["storage_health"]
        for field in _LATEST_TIME_FIELDS:
            row[field] = iso_ms(row.get(field))
        for opt_field in ("last_acquired_at", "last_value_changed_at"):
            if opt_field in row:
                row[opt_field] = iso_ms(row.get(opt_field))
        out_rows.append(row)

    # Cold-recovered TDengine rows whose PG latest_signal_state row is absent (or was older-epoch filtered)
    if live_provider is not None and isinstance(session, AsyncSession):
        for sid_u in signal_ids:
            if sid_u in seen_sids:
                continue
            entry = live_provider.get_entry(tenant_id, sid_u)
            if entry is None:
                continue
            meta = sig_meta_by_id.get(sid_u)
            if meta is None:
                continue
            conn_status = meta.get("connection_status")
            conn_health = meta.get("connection_health")
            conn_paused = str(conn_status or "") == "PAUSED"
            binding_enabled = bool(meta.get("binding_enabled")) and str(meta.get("signal_status") or "ACTIVE") == "ACTIVE"
            evaluated = live_provider.evaluate_signal(
                tenant_id,
                sid_u,
                binding_enabled=binding_enabled,
                expected_interval_ms=meta.get("expected_interval_ms"),
                null_allowed=bool(meta.get("nullable")),
                connection_paused=conn_paused,
                connection_health=conn_health,
                connection_status=conn_status,
                active_bindings=1 if binding_enabled else 0,
                collector_online=collector_online,
                broker_ok=broker_ok,
                storage_ok=storage_ok,
                now=now,
                connection_id=meta.get("connection_id"),
                job_interval_ms=meta.get("job_interval_ms"),
            )
            rec = evaluated.record
            if rec is None:
                continue
            eval_result = evaluated.evaluation
            dims = evaluated.health_dimensions
            out_rows.append(
                {
                    "tenant_id": tenant_id,
                    "signal_id": sid_u,
                    "resource_id": rec.resource_id,
                    "observation_id": rec.observation_id,
                    "value_type": rec.value_type,
                    "value_json": {"v": rec.value},
                    "unit": rec.unit if rec.unit is not None else meta.get("unit"),
                    "quality": eval_result.effective_status,
                    "raw_quality": rec.raw_quality,
                    "event_time": iso_ms(rec.event_time),
                    "received_time": iso_ms(rec.last_acquired_at),
                    "source_time": iso_ms(rec.source_time),
                    "last_acquired_at": iso_ms(rec.last_acquired_at),
                    "last_value_changed_at": iso_ms(rec.last_value_changed_at),
                    "data_epoch": rec.data_epoch,
                    "config_revision": rec.config_revision,
                    "origin": rec.origin,
                    "last_good_value_json": {"v": rec.last_good_value} if rec.last_good_value is not None else None,
                    "last_good_event_time": iso_ms(rec.last_good_at),
                    "updated_at": iso_ms(rec.updated_at or rec.last_acquired_at),
                    "key": meta.get("key"),
                    "display_name": meta.get("display_name"),
                    "expected_interval_ms": meta.get("expected_interval_ms"),
                    "nullable": bool(meta.get("nullable")),
                    "value": rec.value,
                    "source_quality": eval_result.source_quality,
                    "freshness": eval_result.freshness,
                    "delivery_lag_ms": eval_result.delivery_lag_ms,
                    "connection_id": str(meta["connection_id"]) if meta.get("connection_id") else None,
                    "effective_status": eval_result.effective_status,
                    "reason_code": eval_result.reason_code,
                    "evaluated_at": iso_ms(now),
                    "stale_after_ms": eval_result.stale_after_ms,
                    "last_good": eval_result.last_good,
                    "source_health": dims["source_health"],
                    "connection_health": dims["connection_health"],
                    "broker_health": dims["broker_health"],
                    "storage_health": dims["storage_health"],
                }
            )
    return out_rows


def finite_or_none(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value
