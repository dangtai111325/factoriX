"""Typed Live State Provider backed by TDengine LAST_ROW recovery & bounded LRU cache (S08).

Implements ``LiveStateProvider`` and §5.4 guarantees:
- Deterministic active-epoch monotonic ordering ``(data_epoch, acquired_at, source_sequence, event_uid)``
  so replayed older observations or skewed source timestamps cannot overwrite current state or clear ``STALE``.
- Explicit separation of ``last_acquired_at`` (acquisition freshness, keeping steady healthy signals ``GOOD``)
  from ``last_value_changed_at`` (when value, quality, reason, or epoch genuinely changed).
- Conservative cold-start recovery from TDengine ``LAST_ROW(*)`` checkpoints: restored rows stay
  ``restored_unverified=True`` (evaluating as ``UNCERTAIN`` / ``UNVERIFIED_AFTER_RESTART`` or ``STALE``)
  until the running system receives a fresh verified active-epoch acquisition.
- Four independent health dimensions (``source_health``, ``connection_health``, ``broker_health``,
  ``storage_health``) so transport socket liveness alone never fakes ``GOOD`` source health.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
import math
from typing import Any
from uuid import UUID

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.health import effective_connection_health, heartbeat_fresh
from factorix.domain.quality import Origin
from factorix.domain.signal_state import SignalEvaluationResult, evaluate_signal_state
from factorix.modules.providers import LiveSignalRecord, LiveStateProvider
from factorix.platform.tdengine import (
    TDEngineClient,
    TDEngineError,
    op_subtable_name,
    quote_fq_table,
    tenant_database_name,
    to_utc_datetime,
)

logger = logging.getLogger(__name__)

DEFAULT_MAX_SIGNALS_PER_TENANT = 50_000


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utc(dt: Any) -> datetime | None:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    if isinstance(dt, str):
        text = dt.strip()
        if not text:
            return None
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return to_utc_datetime(dt)


def _canonical_equal(a: Any, b: Any) -> bool:
    """Strict canonical value equality (no bool==int aliasing, handles -0.0 == 0.0)."""
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        fa = float(a)
        fb = float(b)
        if not (math.isfinite(fa) and math.isfinite(fb)):
            return False
        if fa == 0.0 and fb == 0.0:
            return True
        return fa == fb
    if type(a) is not type(b) and not (isinstance(a, str) and isinstance(b, str)):
        return False
    return a == b


def _decode_td_value(raw_val: Any, value_type: str) -> Any:
    if raw_val is None:
        return None
    vtype = str(value_type or "").lower()
    if vtype == "json":
        if isinstance(raw_val, (dict, list)):
            return raw_val
        if isinstance(raw_val, str):
            stripped = raw_val.strip()
            if not stripped:
                return None
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                return raw_val
    if vtype == "bool":
        return bool(raw_val)
    if vtype == "float64":
        return float(raw_val)
    if vtype == "int64":
        return int(raw_val)
    if vtype == "timestamp":
        if isinstance(raw_val, (int, datetime, str)):
            return to_utc_datetime(raw_val)
    return raw_val


def _order_key(
    data_epoch: int,
    acquired_at: datetime,
    source_sequence: int | None,
    event_uid: str | None,
) -> tuple[int, datetime, int, str]:
    acq = _utc(acquired_at) or datetime.min.replace(tzinfo=timezone.utc)
    seq = int(source_sequence) if source_sequence is not None else -1
    return (int(data_epoch), acq, seq, str(event_uid or ""))


def compute_health_dimensions(
    *,
    signal_effective_status: str,
    reason_code: str | None = None,
    connection_health: str | None = None,
    connection_status: str | None = None,
    active_bindings: int = 1,
    collector_online: bool | None = None,
    broker_ok: bool | None = None,
    storage_ok: bool | None = None,
) -> dict[str, str]:
    """Compute independent ``source_health``, ``connection_health``, ``broker_health``, ``storage_health``."""
    eff = str(signal_effective_status or "NO_DATA").upper()
    rc = str(reason_code or "").upper()
    if eff == "GOOD":
        src_health = "GOOD"
    elif eff == "UNCERTAIN" and rc == "UNVERIFIED_AFTER_RESTART":
        src_health = "UNKNOWN"
    elif eff in {"UNCERTAIN", "BAD", "STALE", "PAUSED", "DISABLED", "NO_DATA"}:
        src_health = eff
    else:
        src_health = "UNKNOWN"

    if connection_status:
        edge_h: str | None = None
        if collector_online is True:
            edge_h = "ONLINE"
        elif collector_online is False:
            edge_h = "OFFLINE"
        conn_h = effective_connection_health(
            status=connection_status,
            health=connection_health,
            active_bindings=active_bindings,
            edge_health=edge_h,
        )
    else:
        raw_c = str(connection_health or "UNKNOWN").upper()
        conn_h = raw_c if raw_c in {"HEALTHY", "DEGRADED", "IDLE", "PAUSED", "ARCHIVED"} else "UNKNOWN"

    if broker_ok is True:
        brk_health = "HEALTHY"
    elif broker_ok is False:
        brk_health = "DEGRADED"
    else:
        brk_health = "UNKNOWN"

    if storage_ok is True:
        strg_health = "HEALTHY"
    elif storage_ok is False:
        strg_health = "DEGRADED"
    else:
        strg_health = "UNKNOWN"

    return {
        "source_health": src_health,
        "connection_health": conn_h,
        "broker_health": brk_health,
        "storage_health": strg_health,
    }


def extract_runtime_health(
    runtime_rows: Sequence[Mapping[str, Any]],
    *,
    now: datetime | None = None,
    tdengine_configured: bool = False,
) -> tuple[bool | None, bool | None, bool | None]:
    """Derive ``(collector_online, broker_ok, storage_ok)`` from ``collector_runtime_status`` rows."""
    cur_now = now or _utcnow()
    acq_rows = [r for r in runtime_rows if str(r.get("role") or "") == "acquisition"]
    ing_rows = [r for r in runtime_rows if str(r.get("role") or "") == "ingestion"]

    acq_fresh = [r for r in acq_rows if heartbeat_fresh(r.get("last_heartbeat"), cur_now)]
    ing_fresh = [r for r in ing_rows if heartbeat_fresh(r.get("last_heartbeat"), cur_now)]

    collector_online: bool | None = None
    if acq_rows:
        collector_online = any(
            str(r.get("health") or "").upper() not in {"OFFLINE", "DOWN"} for r in acq_fresh
        )

    broker_ok: bool | None = None
    active_fresh = ing_fresh or acq_fresh
    if active_fresh:
        broker_ok = all(bool(r.get("broker_ok", False)) for r in active_fresh)
    elif acq_rows or ing_rows:
        broker_ok = False

    storage_ok: bool | None = None
    if ing_fresh:
        healthy_ing = False
        for r in ing_fresh:
            qj = r.get("queues_json") or {}
            if isinstance(qj, str):
                try:
                    qj = json.loads(qj)
                except json.JSONDecodeError:
                    qj = {}
            td_ok = qj.get("tdengine_ok") if isinstance(qj, Mapping) else None
            r_health = str(r.get("health") or "").upper()
            if r_health not in {"OFFLINE", "DOWN", "DEGRADED"} and td_ok is not False:
                healthy_ing = True
        storage_ok = healthy_ing
    elif ing_rows or tdengine_configured:
        storage_ok = False if tdengine_configured or ing_rows else None

    return collector_online, broker_ok, storage_ok


@dataclass(slots=True)
class _LiveEntry:
    record: LiveSignalRecord
    source_sequence: int | None
    restored_unverified: bool = False
    last_good_source_time: datetime | None = None
    expected_interval_ms: int | None = None
    null_allowed: bool = False


@dataclass(frozen=True, slots=True)
class EvaluatedLiveSignal:
    record: LiveSignalRecord | None
    evaluation: SignalEvaluationResult
    health_dimensions: dict[str, str]
    last_good_source_time: datetime | None
    restored_unverified: bool


class TDengineLiveStateProvider:
    """Bounded per-tenant LRU live-state cache with TDengine LAST_ROW cold recovery and epoch fencing."""

    def __init__(
        self,
        tdengine: TDEngineClient | None = None,
        *,
        max_signals_per_tenant: int = DEFAULT_MAX_SIGNALS_PER_TENANT,
    ) -> None:
        self._td = tdengine
        self._max_per_tenant = max(64, int(max_signals_per_tenant))
        self._cache: dict[UUID, OrderedDict[UUID, _LiveEntry]] = {}
        self._active_epochs: dict[UUID, int] = {}
        self._verified: dict[UUID, set[UUID]] = {}
        self._lock = asyncio.Lock()
        self.started_at: datetime = _utcnow()

    def set_active_epoch(self, tenant_id: UUID, epoch: int) -> None:
        eff = max(1, int(epoch))
        prev = self._active_epochs.get(tenant_id, 1)
        if eff > prev:
            self.invalidate_epoch_sync(tenant_id, eff)
        else:
            self._active_epochs[tenant_id] = max(prev, eff)

    def invalidate_epoch_sync(self, tenant_id: UUID | None, new_epoch: int) -> None:
        eff = max(1, int(new_epoch))
        if tenant_id is None:
            for tid in list(self._active_epochs):
                self._active_epochs[tid] = max(self._active_epochs.get(tid, 1), eff)
            self._cache.clear()
            self._verified.clear()
            return
        self._active_epochs[tenant_id] = max(self._active_epochs.get(tenant_id, 1), eff)
        self._cache.pop(tenant_id, None)
        self._verified.pop(tenant_id, None)

    async def invalidate_epoch(self, tenant_id: UUID, new_epoch: int) -> None:
        async with self._lock:
            self.invalidate_epoch_sync(tenant_id, new_epoch)

    def is_verified_in_session(self, tenant_id: UUID, signal_id: UUID) -> bool:
        return signal_id in self._verified.get(tenant_id, ())

    def _put_entry(self, tenant_id: UUID, signal_id: UUID, entry: _LiveEntry) -> None:
        bucket = self._cache.setdefault(tenant_id, OrderedDict())
        bucket[signal_id] = entry
        bucket.move_to_end(signal_id)
        while len(bucket) > self._max_per_tenant:
            bucket.popitem(last=False)

    def get_entry(self, tenant_id: UUID, signal_id: UUID) -> _LiveEntry | None:
        bucket = self._cache.get(tenant_id)
        if not bucket:
            return None
        entry = bucket.get(signal_id)
        if entry is None:
            return None
        active_epoch = self._active_epochs.get(tenant_id, 1)
        if entry.record.data_epoch < active_epoch:
            bucket.pop(signal_id, None)
            return None
        bucket.move_to_end(signal_id)
        return entry

    def seed_from_record(
        self,
        record: LiveSignalRecord,
        *,
        source_sequence: int | None = None,
        restored_unverified: bool = False,
        last_good_source_time: datetime | None = None,
        expected_interval_ms: int | None = None,
        null_allowed: bool = False,
    ) -> bool:
        """Seed or advance cache from an existing persisted record without bypassing epoch/order guards."""
        active_epoch = self._active_epochs.get(record.tenant_id, 1)
        if record.data_epoch < active_epoch:
            return False
        prev = self.get_entry(record.tenant_id, record.signal_id)
        cand_key = _order_key(record.data_epoch, record.last_acquired_at, source_sequence, record.event_uid)
        if prev is not None:
            prev_key = _order_key(
                prev.record.data_epoch,
                prev.record.last_acquired_at,
                prev.source_sequence,
                prev.record.event_uid,
            )
            if cand_key < prev_key:
                return False
            same_key_promotion = prev.restored_unverified and not restored_unverified
            same_key_metadata_enrich = (
                cand_key == prev_key
                and prev.restored_unverified == restored_unverified
                and (
                    (
                        record.last_value_changed_at is not None
                        and prev.record.last_value_changed_at is not None
                        and record.last_value_changed_at < prev.record.last_value_changed_at
                    )
                    or (prev.record.last_good_value is None and record.last_good_value is not None)
                )
            )
            if cand_key == prev_key and not (same_key_promotion or same_key_metadata_enrich):
                return False

        good_val = record.last_good_value
        good_at = record.last_good_at
        good_src = last_good_source_time
        same_epoch = prev is not None and prev.record.data_epoch == record.data_epoch
        if good_val is None and same_epoch and prev is not None and prev.record.last_good_value is not None:
            good_val = prev.record.last_good_value
            good_at = prev.record.last_good_at
            good_src = good_src or prev.last_good_source_time
        if good_src is None and same_epoch and prev is not None and good_val is not None:
            good_src = prev.last_good_source_time

        eff_record = (
            record
            if (good_val == record.last_good_value and good_at == record.last_good_at)
            else LiveSignalRecord(
                tenant_id=record.tenant_id,
                signal_id=record.signal_id,
                resource_id=record.resource_id,
                observation_id=record.observation_id,
                event_uid=record.event_uid,
                data_epoch=record.data_epoch,
                value_type=record.value_type,
                value=record.value,
                unit=record.unit,
                raw_quality=record.raw_quality,
                reason_code=record.reason_code,
                event_time=record.event_time,
                last_acquired_at=record.last_acquired_at,
                last_value_changed_at=record.last_value_changed_at,
                source_time=record.source_time,
                config_revision=record.config_revision,
                origin=record.origin,
                last_good_value=good_val,
                last_good_at=good_at,
                updated_at=record.updated_at,
            )
        )
        eff_interval = expected_interval_ms if expected_interval_ms is not None else (prev.expected_interval_ms if prev else None)
        eff_null = null_allowed or (prev.null_allowed if prev else False)
        eff_seq = source_sequence if source_sequence is not None else (prev.source_sequence if prev and cand_key == prev_key else None)

        self._active_epochs[record.tenant_id] = max(active_epoch, record.data_epoch)
        self._put_entry(
            record.tenant_id,
            record.signal_id,
            _LiveEntry(
                record=eff_record,
                source_sequence=eff_seq,
                restored_unverified=restored_unverified,
                last_good_source_time=good_src,
                expected_interval_ms=eff_interval,
                null_allowed=eff_null,
            ),
        )
        if not restored_unverified:
            self._verified.setdefault(record.tenant_id, set()).add(record.signal_id)
        return True

    async def apply_observation(
        self,
        obs: CanonicalObservation,
        *,
        observation_id: UUID | None = None,
        expected_interval_ms: int | None = None,
        null_allowed: bool = False,
    ) -> tuple[bool, bool]:
        """Apply incoming active-epoch observation; returns (accepted_as_newest, value_or_quality_changed)."""
        if obs.origin == Origin.TEST:
            return False, False

        tid = obs.tenant_id
        sid = obs.signal_id
        async with self._lock:
            active_epoch = self._active_epochs.get(tid, 1)
            if obs.data_epoch < active_epoch:
                return False, False

            acquired_at = _utc(obs.acquired_at) or _utcnow()
            source_time = _utc(obs.source_time)
            prev = self.get_entry(tid, sid)
            cand_key = _order_key(obs.data_epoch, acquired_at, obs.source_sequence, obs.event_uid)

            if prev is not None:
                prev_key = _order_key(
                    prev.record.data_epoch,
                    prev.record.last_acquired_at,
                    prev.source_sequence,
                    prev.record.event_uid,
                )
                if cand_key <= prev_key:
                    return False, False

            self._active_epochs[tid] = max(active_epoch, obs.data_epoch)
            norm_quality = str(obs.quality.value if hasattr(obs.quality, "value") else obs.quality).upper()
            reason_code = obs.quality_reason
            eff_null_allowed = null_allowed if prev is None else (null_allowed or prev.null_allowed)
            if obs.value is None and norm_quality == "GOOD" and not eff_null_allowed:
                norm_quality = "BAD"
                reason_code = reason_code or "NULL_VALUE"

            same_epoch = prev is not None and prev.record.data_epoch == obs.data_epoch
            val_changed = (
                prev is None
                or not same_epoch
                or not _canonical_equal(prev.record.value, obs.value)
                or prev.record.raw_quality != norm_quality
                or (prev.record.reason_code or "") != (reason_code or "")
            )

            last_changed_at = (
                acquired_at
                if val_changed
                else (prev.record.last_value_changed_at or prev.record.event_time)  # type: ignore[union-attr]
            )

            is_good = norm_quality == "GOOD" and (obs.value is not None or eff_null_allowed)
            if is_good:
                good_val = obs.value
                good_at = acquired_at
                good_src_ts = source_time
            elif same_epoch and prev is not None:
                good_val = prev.record.last_good_value
                good_at = prev.record.last_good_at
                good_src_ts = prev.last_good_source_time
            else:
                good_val = None
                good_at = None
                good_src_ts = None

            rec = LiveSignalRecord(
                tenant_id=tid,
                signal_id=sid,
                resource_id=obs.resource_id,
                observation_id=observation_id,
                event_uid=obs.event_uid,
                data_epoch=int(obs.data_epoch),
                value_type=obs.value_type,
                value=obs.value,
                unit=obs.unit,
                raw_quality=norm_quality,
                reason_code=reason_code,
                event_time=acquired_at,
                last_acquired_at=acquired_at,
                last_value_changed_at=last_changed_at,
                source_time=source_time,
                config_revision=int(obs.config_revision),
                origin=obs.origin.value if hasattr(obs.origin, "value") else str(obs.origin),
                last_good_value=good_val,
                last_good_at=good_at,
                updated_at=_utcnow(),
            )
            eff_interval = (
                expected_interval_ms
                if expected_interval_ms is not None
                else (prev.expected_interval_ms if prev is not None else None)
            )
            self._put_entry(
                tid,
                sid,
                _LiveEntry(
                    record=rec,
                    source_sequence=obs.source_sequence,
                    restored_unverified=False,
                    last_good_source_time=good_src_ts,
                    expected_interval_ms=eff_interval,
                    null_allowed=eff_null_allowed,
                ),
            )
            self._verified.setdefault(tid, set()).add(sid)
            return True, val_changed

    async def warm_from_tdengine(
        self,
        tenant_id: UUID,
        signal_specs: Mapping[UUID, Mapping[str, Any]],
        *,
        active_epoch: int | None = None,
        mark_unverified: bool = True,
    ) -> dict[UUID, LiveSignalRecord]:
        """Recover active-epoch LAST_ROW checkpoints from TDengine for signals missing from cache."""
        if active_epoch is not None:
            self.set_active_epoch(tenant_id, active_epoch)
        eff_epoch = self._active_epochs.get(tenant_id, 1)
        if self._td is None or not signal_specs:
            return {
                sid: entry.record
                for sid in signal_specs
                if (entry := self.get_entry(tenant_id, sid)) is not None
            }

        db = tenant_database_name(tenant_id, prefix=self._td.config.db_prefix)
        out: dict[UUID, LiveSignalRecord] = {}
        missing: list[tuple[UUID, Mapping[str, Any]]] = []
        for sid, spec in signal_specs.items():
            cached = self.get_entry(tenant_id, sid)
            if cached is not None and cached.record.data_epoch >= eff_epoch:
                out[sid] = cached.record
            else:
                missing.append((sid, spec))

        for sid, spec in missing:
            vtype = str(spec.get("data_type") or spec.get("value_type") or "float64")
            try:
                subtable = op_subtable_name(sid, vtype)
                row = await self._td.query_last_row(db, subtable)
            except TDEngineError as exc:
                low = exc.message.lower()
                if any(tok in low for tok in ("not exist", "doesn't exist", "does not exist")):
                    continue
                logger.warning("TDengine LAST_ROW recovery skipped for %s.%s: %s", db, sid, exc.message)
                continue

            if not row:
                continue
            row_epoch = int(row.get("data_epoch") or 1)
            if row_epoch < eff_epoch:
                continue

            val = _decode_td_value(row.get("val"), vtype)
            raw_quality = str(row.get("raw_quality") or "GOOD").upper()
            reason_code = str(row["reason_code"]) if row.get("reason_code") else None
            ev_time = _utc(row.get("ts")) or _utcnow()
            acq_time = _utc(row.get("acquired_at")) or ev_time
            src_time = _utc(row.get("source_time"))
            null_allowed = bool(spec.get("nullable"))
            res_id_raw = spec.get("resource_id") or row.get("resource_id") or sid
            res_id = res_id_raw if isinstance(res_id_raw, UUID) else UUID(str(res_id_raw))

            good_val: Any = None
            good_at: datetime | None = None
            good_src_time: datetime | None = None
            if raw_quality == "GOOD" and (val is not None or null_allowed):
                good_val = val
                good_at = acq_time
                good_src_time = src_time
            else:
                try:
                    fq = quote_fq_table(db, subtable)
                    good_rows = await self._td.query_rows(
                        f"SELECT `ts`, `val`, `acquired_at`, `source_time` FROM {fq} "
                        f"WHERE `raw_quality` = 'GOOD' AND `data_epoch` >= {eff_epoch} "
                        "ORDER BY `ts` DESC LIMIT 1"
                    )
                    if good_rows:
                        gr = good_rows[0]
                        good_val = _decode_td_value(gr.get("val"), vtype)
                        good_at = _utc(gr.get("acquired_at")) or _utc(gr.get("ts"))
                        good_src_time = _utc(gr.get("source_time"))
                except TDEngineError:
                    pass

            rec = LiveSignalRecord(
                tenant_id=tenant_id,
                signal_id=sid,
                resource_id=res_id,
                observation_id=None,
                event_uid=str(row.get("event_uid") or "") or None,
                data_epoch=row_epoch,
                value_type=vtype,
                value=val,
                unit=spec.get("unit") if spec.get("unit") is not None else row.get("unit"),
                raw_quality=raw_quality,
                reason_code=reason_code,
                event_time=ev_time,
                last_acquired_at=acq_time,
                last_value_changed_at=acq_time,
                source_time=src_time,
                config_revision=int(row.get("config_rev") or 1),
                origin=str(row.get("origin") or "LIVE"),
                last_good_value=good_val,
                last_good_at=good_at,
                updated_at=_utcnow(),
            )
            async with self._lock:
                # Never overwrite a newer in-session sample that arrived concurrently while querying TDengine
                current = self.get_entry(tenant_id, sid)
                if current is not None and current.record.data_epoch >= eff_epoch:
                    out[sid] = current.record
                    continue
                self.seed_from_record(
                    rec,
                    source_sequence=int(row["source_seq"]) if row.get("source_seq") is not None else None,
                    restored_unverified=mark_unverified,
                    last_good_source_time=good_src_time,
                    expected_interval_ms=spec.get("expected_interval_ms"),
                    null_allowed=null_allowed,
                )
                out[sid] = rec
        return out

    async def get_latest(
        self,
        tenant_id: UUID,
        signal_ids: list[UUID],
        *,
        signal_specs: Mapping[UUID, Mapping[str, Any]] | None = None,
        active_epoch: int | None = None,
    ) -> dict[UUID, LiveSignalRecord]:
        if active_epoch is not None:
            self.set_active_epoch(tenant_id, active_epoch)
        eff_epoch = self._active_epochs.get(tenant_id, 1)

        out: dict[UUID, LiveSignalRecord] = {}
        missing_specs: dict[UUID, Mapping[str, Any]] = {}
        for sid in signal_ids:
            entry = self.get_entry(tenant_id, sid)
            if entry is not None and entry.record.data_epoch >= eff_epoch:
                out[sid] = entry.record
            elif signal_specs and sid in signal_specs:
                missing_specs[sid] = signal_specs[sid]

        if missing_specs and self._td is not None:
            recovered = await self.warm_from_tdengine(
                tenant_id, missing_specs, active_epoch=eff_epoch, mark_unverified=True
            )
            out.update(recovered)
        return out

    def evaluate_signal(
        self,
        tenant_id: UUID,
        signal_id: UUID,
        *,
        binding_enabled: bool = True,
        resource_archived: bool = False,
        expected_interval_ms: int | None = None,
        null_allowed: bool = False,
        connection_paused: bool = False,
        connection_health: str | None = None,
        connection_status: str | None = None,
        active_bindings: int = 1,
        collector_online: bool | None = None,
        broker_ok: bool | None = None,
        storage_ok: bool | None = None,
        now: datetime | None = None,
        require_session_verification: bool = True,
    ) -> EvaluatedLiveSignal:
        entry = self.get_entry(tenant_id, signal_id)
        rec = entry.record if entry is not None else None
        eval_now = now or _utcnow()

        if rec is None:
            ev = evaluate_signal_state(
                has_observation=False,
                raw_quality=None,
                raw_value=None,
                event_time=None,
                last_acquired_at=None,
                expected_interval_ms=expected_interval_ms,
                binding_enabled=binding_enabled,
                resource_archived=resource_archived,
                connection_health=connection_health,
                null_allowed=null_allowed,
                connection_paused=connection_paused,
                now=eval_now,
            )
            dims = compute_health_dimensions(
                signal_effective_status=ev.effective_status,
                reason_code=ev.reason_code,
                connection_health=connection_health,
                connection_status=connection_status,
                active_bindings=active_bindings,
                collector_online=collector_online,
                broker_ok=broker_ok,
                storage_ok=storage_ok,
            )
            return EvaluatedLiveSignal(
                record=None,
                evaluation=ev,
                health_dimensions=dims,
                last_good_source_time=None,
                restored_unverified=False,
            )

        assert entry is not None
        unverified = bool(entry.restored_unverified and require_session_verification)
        ev = evaluate_signal_state(
            has_observation=True,
            raw_quality=rec.raw_quality,
            raw_value=rec.value,
            event_time=rec.event_time,
            last_acquired_at=rec.last_acquired_at,
            expected_interval_ms=expected_interval_ms if expected_interval_ms is not None else entry.expected_interval_ms,
            last_good_value=rec.last_good_value,
            last_good_time=rec.last_good_at,
            raw_reason_code=rec.reason_code,
            binding_enabled=binding_enabled,
            resource_archived=resource_archived,
            connection_health=connection_health,
            null_allowed=null_allowed or entry.null_allowed,
            connection_paused=connection_paused,
            restored_unverified=unverified,
            now=eval_now,
        )
        dims = compute_health_dimensions(
            signal_effective_status=ev.effective_status,
            reason_code=ev.reason_code,
            connection_health=connection_health,
            connection_status=connection_status,
            active_bindings=active_bindings,
            collector_online=collector_online,
            broker_ok=broker_ok,
            storage_ok=storage_ok,
        )
        return EvaluatedLiveSignal(
            record=rec,
            evaluation=ev,
            health_dimensions=dims,
            last_good_source_time=entry.last_good_source_time,
            restored_unverified=unverified,
        )


def record_from_pg_row(
    row: Mapping[str, Any], *, tenant_id: UUID | None = None
) -> tuple[LiveSignalRecord, int | None, datetime | None]:
    """Build a ``LiveSignalRecord`` plus optional ``source_sequence`` and ``updated_at`` from a PG latest row."""
    raw_vj = row.get("value_json")
    if isinstance(raw_vj, str):
        try:
            raw_vj = json.loads(raw_vj)
        except json.JSONDecodeError:
            raw_vj = None
    val = raw_vj.get("v") if isinstance(raw_vj, dict) else row.get("value")

    raw_gv = row.get("last_good_value_json")
    if isinstance(raw_gv, str):
        try:
            raw_gv = json.loads(raw_gv)
        except json.JSONDecodeError:
            raw_gv = None
    good_val = raw_gv.get("v") if isinstance(raw_gv, dict) else None

    tid_val = row.get("tenant_id") or tenant_id
    tid = tid_val if isinstance(tid_val, UUID) else UUID(str(tid_val))
    sid = row["signal_id"] if isinstance(row["signal_id"], UUID) else UUID(str(row["signal_id"]))
    res_raw = row.get("resource_id") or sid
    res_id = res_raw if isinstance(res_raw, UUID) else UUID(str(res_raw))
    obs_raw = row.get("observation_id")
    obs_id = obs_raw if isinstance(obs_raw, UUID) else (UUID(str(obs_raw)) if obs_raw else None)

    ev_time = _utc(row.get("event_time")) or _utc(row.get("received_time")) or _utcnow()
    rx_time = _utc(row.get("received_time")) or ev_time
    acq_time = _utc(row.get("last_acquired_at")) or rx_time
    chg_time = _utc(row.get("last_value_changed_at")) or ev_time
    src_time = _utc(row.get("source_time"))
    good_at = _utc(row.get("last_good_event_time"))
    upd_at = _utc(row.get("updated_at")) or rx_time
    seq_raw = row.get("source_sequence")
    seq = int(seq_raw) if seq_raw is not None else None
    ev_uid = str(row.get("event_uid") or (str(obs_id) if obs_id else "") or "") or None
    reason = row.get("reason_code") or row.get("raw_reason")

    rec = LiveSignalRecord(
        tenant_id=tid,
        signal_id=sid,
        resource_id=res_id,
        observation_id=obs_id,
        event_uid=ev_uid,
        data_epoch=max(1, int(row.get("data_epoch") or 1)),
        value_type=str(row.get("value_type") or "float64"),
        value=val,
        unit=row.get("unit"),
        raw_quality=str(row.get("raw_quality") or row.get("quality") or "GOOD").upper(),
        reason_code=str(reason) if reason else None,
        event_time=ev_time,
        last_acquired_at=acq_time,
        last_value_changed_at=chg_time,
        source_time=src_time,
        config_revision=max(1, int(row.get("config_revision") or 1)),
        origin=str(row.get("origin") or "LIVE"),
        last_good_value=good_val,
        last_good_at=good_at,
        updated_at=upd_at,
    )
    return rec, seq, upd_at


_GLOBAL_LIVE_STATE_PROVIDER: TDengineLiveStateProvider | None = None


def configure_live_state_provider(provider: TDengineLiveStateProvider | None) -> None:
    global _GLOBAL_LIVE_STATE_PROVIDER
    _GLOBAL_LIVE_STATE_PROVIDER = provider


def get_live_state_provider() -> TDengineLiveStateProvider | None:
    return _GLOBAL_LIVE_STATE_PROVIDER


# Type-check protocol conformance statically
_: type[LiveStateProvider] = TDengineLiveStateProvider  # type: ignore[assignment]
