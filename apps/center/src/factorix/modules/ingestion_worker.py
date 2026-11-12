"""RabbitMQ -> Validation -> Epoch Fence -> TDengine -> Live State Ingestion Worker (S06).

Consumes canonical observations from RabbitMQ Quorum Queue ``factorix.telemetry.ingest.q``,
validates envelopes, fences stale epochs via ``telemetry_generations``, verifies signal
bindings in PostgreSQL (without requiring legacy ``edge_nodes``), evaluates recording
policies, writes durably to TDengine operational history, evaluates published formulas
synchronously (depth <= 4), updates ``latest_signal_state`` and ``connections`` liveness,
pushes chunked WebSocket events via PostgreSQL ``NOTIFY``, and ACKs RabbitMQ ONLY after all
durable storage effects succeed.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import math
import time
from typing import Any
from uuid import UUID, uuid4

import asyncpg
from aio_pika.abc import AbstractIncomingMessage

from factorix.domain.canonical import CanonicalObservation, LatencySLIs, measure_latency_slis, redact_provenance
from factorix.domain.formula import FormulaError, bind, evaluate, output_quality, parse_expression
from factorix.domain.health import NO_DATA_PREFIX, effective_connection_health
from factorix.domain.observation import ObservationError, resolve_times
from factorix.domain.quality import Origin, Quality
from factorix.modules.common import iso_ms
from factorix.modules.live_state import TDengineLiveStateProvider
from factorix.modules.providers import LiveSignalRecord, RecordingDecision, RecordingPolicyEvaluator
from factorix.modules.recording_policy import (
    DefaultRecordingPolicyEvaluator,
    ManagedBindingTarget,
    ManagedSubtableWrite,
    build_managed_target_from_row,
)
from factorix.modules.telemetry import RejectionThrottle, connection_health_payload, latest_stream_payload, select_binding
from factorix.platform.broker import BrokerConfig, ConsumeOutcome, RabbitMQConsumer
from factorix.platform.tdengine import (
    BatchWriteFailure,
    BatchWriteResult,
    SubtableWriteItem,
    TDEngineClient,
    TDEngineError,
    op_stable_for_type,
    op_subtable_name,
    tenant_database_name,
    to_td_timestamp_us,
    to_utc_datetime,
)

logger = logging.getLogger(__name__)

MAX_MESSAGE_BYTES = 262_144
DEFAULT_INSTANCE_ID = "local-ingestion-1"
NOTIFY_CHANNEL_STREAM = "factorix_stream_events"
NOTIFY_CHANNEL_HEALTH = "factorix_health_changed"
NOTIFY_CHUNK_MAX_EVENTS = 20
NOTIFY_CHUNK_MAX_BYTES = 7000
MAX_FORMULA_DEPTH = 4


def to_asyncpg_dsn(dsn: str) -> str:
    text = str(dsn or "").strip()
    if text.startswith("postgresql+asyncpg://"):
        return "postgresql://" + text[len("postgresql+asyncpg://") :]
    if text.startswith("postgres+asyncpg://"):
        return "postgresql://" + text[len("postgres+asyncpg://") :]
    return text


def _json_val(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return value
    return value


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _deterministic_calc_uid(formula_id: Any, revision: int, output_signal_id: Any, trigger_uid: str) -> str:
    digest = hashlib.sha256(f"{formula_id}|{int(revision)}|{output_signal_id}|{trigger_uid}".encode("utf-8")).hexdigest()[:48]
    return f"calc:{digest}"


class RecentUidLru:
    """Bounded FIFO/LRU cache preventing duplicate processing of identical event_uids within a window."""

    def __init__(self, max_size: int = 100_000) -> None:
        self.max_size = max(16, int(max_size))
        self._items: OrderedDict[tuple[UUID, str], float] = OrderedDict()

    def __contains__(self, key: tuple[UUID, str]) -> bool:
        hit = key in self._items
        if hit:
            self._items.move_to_end(key)
        return hit

    def mark(self, key: tuple[UUID, str]) -> None:
        self._items[key] = time.monotonic()
        self._items.move_to_end(key)
        while len(self._items) > self.max_size:
            self._items.popitem(last=False)

    def clear_tenant(self, tenant_id: UUID) -> None:
        drop_keys = [k for k in self._items if k[0] == tenant_id]
        for k in drop_keys:
            self._items.pop(k, None)

    def __len__(self) -> int:
        return len(self._items)


class LatencyHistogram:
    """Bounded sliding sample tracker for p50/p95/max ingest & commit SLI reporting."""

    def __init__(self, max_samples: int = 2048) -> None:
        self.max_samples = max(64, int(max_samples))
        self._acq_to_commit_ms: list[float] = []
        self._ingest_to_commit_ms: list[float] = []
        self._events: dict[UUID, list[float]] = {}
        self._conn_events: dict[UUID, list[float]] = {}

    def record(self, tenant_id: UUID, sli: LatencySLIs, *, connection_id: UUID | None = None) -> None:
        now = time.monotonic()
        bucket = self._events.setdefault(tenant_id, [])
        bucket.append(now)
        if connection_id is not None:
            self._conn_events.setdefault(connection_id, []).append(now)
        if sli.acquisition_to_commit_ms is not None:
            self._acq_to_commit_ms.append(sli.acquisition_to_commit_ms)
            if len(self._acq_to_commit_ms) > self.max_samples:
                del self._acq_to_commit_ms[: len(self._acq_to_commit_ms) - self.max_samples]
        if sli.ingest_to_commit_ms is not None:
            self._ingest_to_commit_ms.append(sli.ingest_to_commit_ms)
            if len(self._ingest_to_commit_ms) > self.max_samples:
                del self._ingest_to_commit_ms[: len(self._ingest_to_commit_ms) - self.max_samples]

    def tenant_rates_per_min(self) -> dict[str, int]:
        cutoff = time.monotonic() - 60.0
        out: dict[str, int] = {}
        for tid in list(self._events):
            recent = [t for t in self._events[tid] if t >= cutoff]
            if recent:
                self._events[tid] = recent
                out[str(tid)] = len(recent)
            else:
                self._events.pop(tid, None)
        return out

    def connection_rates_per_min(self) -> dict[str, int]:
        cutoff = time.monotonic() - 60.0
        out: dict[str, int] = {}
        for cid in list(self._conn_events):
            recent = [t for t in self._conn_events[cid] if t >= cutoff]
            if recent:
                self._conn_events[cid] = recent
                out[str(cid)] = len(recent)
            else:
                self._conn_events.pop(cid, None)
        return out

    @staticmethod
    def _pct(values: list[float], pct: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        idx = min(len(ordered) - 1, max(0, int(math.ceil(pct * len(ordered))) - 1))
        return round(ordered[idx], 3)

    def snapshot(self) -> dict[str, Any]:
        return {
            "sli_acq_to_commit_p50_ms": self._pct(self._acq_to_commit_ms, 0.50),
            "sli_acq_to_commit_p95_ms": self._pct(self._acq_to_commit_ms, 0.95),
            "sli_acq_to_commit_max_ms": round(max(self._acq_to_commit_ms), 3) if self._acq_to_commit_ms else None,
            "sli_ingest_to_commit_p50_ms": self._pct(self._ingest_to_commit_ms, 0.50),
            "sli_ingest_to_commit_p95_ms": self._pct(self._ingest_to_commit_ms, 0.95),
        }


@dataclass(slots=True)
class WorkerMetrics:
    received_total: int = 0
    acked_total: int = 0
    dlq_total: int = 0
    retried_total: int = 0
    dedup_hits: int = 0
    test_dropped: int = 0
    epoch_fenced_dropped: int = 0
    tdengine_writes: int = 0
    tdengine_retryable_errors: int = 0
    tdengine_permanent_errors: int = 0
    pg_retryable_errors: int = 0
    formula_writes: int = 0
    managed_writes: int = 0
    managed_checkpoints: int = 0
    managed_gap_markers: int = 0
    managed_write_errors: int = 0
    managed_skips_by_reason: dict[str, int] = field(default_factory=dict)
    batches_committed: int = 0
    last_commit_at: datetime | None = None
    last_error: str | None = None


@dataclass(slots=True)
class TenantCatalog:
    tenant_id: UUID
    active_epoch: int = 1
    lifecycle_state: str = "ACTIVE"
    bindings: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    formula_inputs: set[UUID] = field(default_factory=set)
    formulas_by_dep: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    formula_aliases: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    managed_targets_by_signal: dict[UUID, list[ManagedBindingTarget]] = field(default_factory=dict)
    managed_targets_by_model: dict[tuple[UUID, str], list[ManagedBindingTarget]] = field(default_factory=dict)
    all_managed_targets: tuple[ManagedBindingTarget, ...] = ()
    loaded_at: float = 0.0
    epoch_loaded_at: float = 0.0
    last_miss_refresh_at: float = 0.0


@dataclass(slots=True)
class _PreparedObs:
    obs: CanonicalObservation
    event_time: datetime
    received_time: datetime
    source_time: datetime | None
    norm_quality: str
    reason_code: str | None
    owned: dict[str, Any]
    ingested_at: datetime
    provenance_dict: dict[str, Any]


@dataclass(slots=True)
class _PendingEnvelope:
    raw_body: bytes
    message_id: str | None
    headers: Mapping[str, Any]
    redelivered: bool
    ingested_at: datetime
    future: asyncio.Future[ConsumeOutcome]


def _default_owned_check(catalog: TenantCatalog, obs: CanonicalObservation, received_time: datetime) -> dict[str, Any] | None:
    row = select_binding(catalog.bindings.get(obs.signal_id, []), received_time)
    if row is None:
        return None
    if obs.resource_id != UUID(str(row["resource_id"])):
        return None
    if obs.connection_id is not None and obs.connection_id != UUID(str(row["connection_id"])):
        return None
    if obs.source_field_id is not None and obs.source_field_id != UUID(str(row["source_field_id"])):
        return None
    if obs.provenance and obs.provenance.source_field_id is not None:
        if obs.provenance.source_field_id != UUID(str(row["source_field_id"])):
            return None
    row_site = row.get("site_id")
    if obs.site_id is not None and row_site is not None and obs.site_id != UUID(str(row_site)):
        return None
    return row


class PgIngestionStore:
    """Direct asyncpg adapter for catalog lookup, fencing, latest state, formulas, liveness & quarantine."""

    def __init__(self, dsn: str, *, min_pool: int = 2, max_pool: int = 16) -> None:
        self._dsn = to_asyncpg_dsn(dsn)
        self._min_pool = max(1, int(min_pool))
        self._max_pool = max(self._min_pool, int(max_pool))
        self._pool: asyncpg.Pool | None = None

    @property
    def pool(self) -> asyncpg.Pool | None:
        return self._pool

    async def start(self) -> None:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(
                self._dsn,
                min_size=self._min_pool,
                max_size=self._max_pool,
                command_timeout=15.0,
            )

    async def close(self) -> None:
        pool = self._pool
        self._pool = None
        if pool is not None:
            await pool.close()

    @staticmethod
    def is_retryable_pg_error(exc: BaseException) -> bool:
        return isinstance(
            exc,
            (
                asyncpg.PostgresConnectionError,
                asyncpg.CannotConnectNowError,
                asyncpg.ConnectionDoesNotExistError,
                asyncpg.InterfaceError,
                asyncpg.TooManyConnectionsError,
                asyncpg.DeadlockDetectedError,
                asyncpg.SerializationError,
                OSError,
                TimeoutError,
            ),
        )

    async def fetch_tenant_epoch(self, tenant_id: UUID) -> tuple[int, str]:
        assert self._pool is not None
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT active_epoch, lifecycle_state FROM telemetry_generations WHERE tenant_id = $1",
                tenant_id,
            )
        if row is None:
            return 1, "ACTIVE"
        return max(1, int(row["active_epoch"] or 1)), str(row["lifecycle_state"] or "ACTIVE")

    async def load_tenant_catalog(self, tenant_id: UUID) -> TenantCatalog:
        assert self._pool is not None
        now_mono = time.monotonic()
        async with self._pool.acquire() as conn:
            async with conn.transaction(isolation="repeatable_read", readonly=True):
                gen_row = await conn.fetchrow(
                    "SELECT active_epoch, lifecycle_state FROM telemetry_generations WHERE tenant_id = $1",
                    tenant_id,
                )
                active_epoch = max(1, int(gen_row["active_epoch"] or 1)) if gen_row else 1
                lifecycle_state = str(gen_row["lifecycle_state"] or "ACTIVE") if gen_row else "ACTIVE"

                binding_rows = await conn.fetch(
                    """
                    SELECT b.signal_id, b.valid_from, b.valid_to, s.resource_id, s.expected_interval_ms, r.site_id,
                           c.id AS connection_id, f.id AS source_field_id,
                           COALESCE((f.address_json->>'nullable') = 'true', FALSE) AS nullable
                    FROM signal_bindings b
                    JOIN signal_definitions s ON s.id = b.signal_id
                    JOIN resources r ON r.id = s.resource_id
                    JOIN source_fields f ON f.id = b.source_field_id
                    JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
                    JOIN connections c ON c.id = j.connection_id
                    WHERE s.tenant_id = $1 AND c.tenant_id = $1 AND b.enabled = TRUE AND s.status = 'ACTIVE'
                    """,
                    tenant_id,
                )
                bindings: dict[UUID, list[dict[str, Any]]] = {}
                for r in binding_rows:
                    d = dict(r)
                    sig = UUID(str(d["signal_id"]))
                    bindings.setdefault(sig, []).append(d)

                formula_rows = await conn.fetch(
                    """
                    SELECT d.dependency_signal_id, f.id AS formula_id, f.signal_id AS output_id,
                           f.expression_source, f.revision, s.resource_id, s.data_type, s.unit,
                           s.expected_interval_ms, r.site_id
                    FROM formula_dependencies d
                    JOIN formula_definitions f ON f.id = d.formula_id
                    JOIN signal_definitions s ON s.id = f.signal_id
                    JOIN resources r ON r.id = s.resource_id
                    WHERE f.status = 'PUBLISHED' AND s.tenant_id = $1
                    """,
                    tenant_id,
                )
                formula_inputs: set[UUID] = set()
                formulas_by_dep: dict[UUID, list[dict[str, Any]]] = {}
                formula_ids: set[UUID] = set()
                for r in formula_rows:
                    d = dict(r)
                    dep_sig = UUID(str(d["dependency_signal_id"]))
                    fid = UUID(str(d["formula_id"]))
                    formula_inputs.add(dep_sig)
                    formula_ids.add(fid)
                    existing = formulas_by_dep.setdefault(dep_sig, [])
                    if not any(UUID(str(x["formula_id"])) == fid for x in existing):
                        existing.append(d)

                formula_aliases: dict[UUID, list[dict[str, Any]]] = {}
                if formula_ids:
                    alias_rows = await conn.fetch(
                        """
                        SELECT formula_id, variable_alias, dependency_signal_id
                        FROM formula_dependencies
                        WHERE formula_id = ANY($1::uuid[])
                        """,
                        list(formula_ids),
                    )
                    for r in alias_rows:
                        fid = UUID(str(r["formula_id"]))
                        formula_aliases.setdefault(fid, []).append(dict(r))

                managed_rows = await conn.fetch(
                    """
                    SELECT d.id AS design_id,
                           d.status AS design_status,
                           ds.id AS dataset_id,
                           ds.dataset_key,
                           ds.semantics,
                           ds.time_axis,
                           ds.tags_json,
                           ds.status AS dataset_status,
                           fb.field_key,
                           fb.value_type,
                           fb.max_length,
                           fb.source_kind AS field_source_kind,
                           fb.signal_id,
                           fb.model_id,
                           fb.model_field_path,
                           fb.resource_id,
                           fb.source_revision,
                           fb.transform_json,
                           fb.nullable,
                           fb.required,
                           COALESCE(rp.mode, 'ON_CHANGE') AS recording_mode,
                           COALESCE(rp.policy_json, '{}'::jsonb) AS policy_json,
                           COALESCE(rp.version, 1) AS policy_version,
                           COALESCE(rp.enabled, TRUE) AS policy_enabled,
                           pr.design_version_id,
                           pr.td_database,
                           pr.td_stable,
                           pr.td_subtable,
                           pr.series_key AS registry_series_key,
                           pr.status AS registry_status
                    FROM storage_datasets ds
                    JOIN storage_designs d ON d.id = ds.design_id
                    JOIN storage_field_bindings fb ON fb.dataset_id = ds.id
                    LEFT JOIN storage_recording_policies rp ON rp.dataset_id = ds.id
                    JOIN storage_physical_registry pr
                      ON pr.tenant_id = ds.tenant_id
                     AND pr.tier = 'MANAGED'
                     AND pr.dataset_id = ds.id
                     AND (
                          (fb.signal_id IS NOT NULL AND pr.series_key IN (
                              concat(CAST(ds.id AS text), ':sig:', lower(CAST(fb.signal_id AS text))),
                              concat(CAST(d.id AS text), ':sig:', lower(CAST(fb.signal_id AS text)))
                          ))
                          OR (fb.model_id IS NOT NULL AND pr.series_key IN (
                              concat(CAST(ds.id AS text), ':mod:', lower(CAST(fb.model_id AS text)), ':', COALESCE(NULLIF(fb.model_field_path, ''), fb.field_key)),
                              concat(CAST(d.id AS text), ':mod:', lower(CAST(fb.model_id AS text)), ':', COALESCE(NULLIF(fb.model_field_path, ''), fb.field_key))
                          ))
                          OR (fb.signal_id IS NULL AND fb.model_id IS NULL AND pr.series_key IN (
                              concat(CAST(ds.id AS text), ':fld:', ds.dataset_key, ':', fb.field_key),
                              concat(CAST(d.id AS text), ':fld:', ds.dataset_key, ':', fb.field_key)
                          ))
                     )
                    WHERE ds.tenant_id = $1
                      AND d.status IN ('RUNNING', 'PAUSED')
                      AND ds.status IN ('RUNNING', 'PAUSED')
                      AND pr.status IN ('ACTIVE', 'PAUSED')
                    ORDER BY ds.id, fb.ordinal, fb.field_key
                    """,
                    tenant_id,
                )
                managed_by_signal: dict[UUID, list[ManagedBindingTarget]] = {}
                managed_by_model: dict[tuple[UUID, str], list[ManagedBindingTarget]] = {}
                all_managed: list[ManagedBindingTarget] = []
                for r in managed_rows:
                    target = build_managed_target_from_row(dict(r))
                    all_managed.append(target)
                    if target.signal_id is not None:
                        managed_by_signal.setdefault(target.signal_id, []).append(target)
                    if target.model_id is not None and target.model_field_path:
                        managed_by_model.setdefault((target.model_id, target.model_field_path), []).append(target)

        return TenantCatalog(
            tenant_id=tenant_id,
            active_epoch=active_epoch,
            lifecycle_state=lifecycle_state,
            bindings=bindings,
            formula_inputs=formula_inputs,
            formulas_by_dep=formulas_by_dep,
            formula_aliases=formula_aliases,
            managed_targets_by_signal=managed_by_signal,
            managed_targets_by_model=managed_by_model,
            all_managed_targets=tuple(all_managed),
            loaded_at=now_mono,
            epoch_loaded_at=now_mono,
            last_miss_refresh_at=0.0,
        )

    async def write_quarantine(
        self,
        *,
        tenant_id: UUID,
        edge_id: UUID | None,
        event_uid: str,
        reason: str,
        payload: dict[str, Any],
    ) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO observation_quarantine (id, tenant_id, edge_id, event_uid, reason, received_time, payload_redacted)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                """,
                uuid4(),
                tenant_id,
                edge_id,
                (event_uid or "invalid")[:256],
                reason[:300],
                _utcnow(),
                json.dumps(redact_provenance(payload), default=str),
            )

    async def write_audit(
        self,
        *,
        tenant_id: UUID,
        event_type: str,
        entity_type: str,
        entity_id: UUID,
        after: dict[str, Any],
        before: dict[str, Any] | None = None,
        severity: str = "WARN",
        correlation_id: str = "ingestion",
    ) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO audit_events (
                    id, tenant_id, event_type, actor_id, entity_type, entity_id,
                    before_json, after_json, correlation_id, occurred_at, severity
                ) VALUES ($1, $2, $3, NULL, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
                """,
                uuid4(),
                tenant_id,
                event_type,
                entity_type,
                entity_id,
                json.dumps(before, default=str) if before is not None else None,
                json.dumps(after, default=str),
                correlation_id[:128],
                _utcnow(),
                severity,
            )

    async def fetch_latest_values(self, tenant_id: UUID, signal_ids: Sequence[UUID]) -> dict[UUID, dict[str, Any]]:
        if self._pool is None or not signal_ids:
            return {}
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT signal_id, value_json, quality, received_time
                FROM latest_signal_state
                WHERE tenant_id = $1 AND signal_id = ANY($2::uuid[])
                """,
                tenant_id,
                list(signal_ids),
            )
        out: dict[UUID, dict[str, Any]] = {}
        for r in rows:
            sid = UUID(str(r["signal_id"]))
            vj = _json_val(r["value_json"])
            out[sid] = {
                "value": vj.get("v") if isinstance(vj, dict) else None,
                "quality": str(r["quality"]),
                "received_time": r["received_time"],
            }
        return out

    async def fetch_latest_states_for_eval(
        self, tenant_id: UUID, signal_ids: Sequence[UUID]
    ) -> dict[UUID, LiveSignalRecord]:
        if self._pool is None or not signal_ids:
            return {}
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT tenant_id, signal_id, resource_id, observation_id, event_uid, data_epoch,
                       value_type, value_json, unit, quality, reason_code,
                       event_time, last_acquired_at, last_value_changed_at, source_time,
                       config_revision, origin, last_good_value_json, last_good_event_time,
                       updated_at, received_time
                FROM latest_signal_state
                WHERE tenant_id = $1 AND signal_id = ANY($2::uuid[])
                """,
                tenant_id,
                list(signal_ids),
            )
        out: dict[UUID, LiveSignalRecord] = {}
        for r in rows:
            sid = UUID(str(r["signal_id"]))
            vj = _json_val(r["value_json"])
            gv = _json_val(r["last_good_value_json"])
            out[sid] = LiveSignalRecord(
                tenant_id=UUID(str(r["tenant_id"])),
                signal_id=sid,
                resource_id=UUID(str(r["resource_id"])),
                observation_id=UUID(str(r["observation_id"])) if r.get("observation_id") else None,
                event_uid=str(r["event_uid"]) if r.get("event_uid") else None,
                data_epoch=int(r.get("data_epoch") or 1),
                value_type=str(r["value_type"]),
                value=vj.get("v") if isinstance(vj, dict) else None,
                unit=r.get("unit"),
                raw_quality=str(r["quality"]),
                reason_code=r.get("reason_code"),
                event_time=r["event_time"],
                last_acquired_at=r.get("last_acquired_at") or r["received_time"],
                last_value_changed_at=r.get("last_value_changed_at") or r["event_time"],
                source_time=r.get("source_time"),
                config_revision=int(r.get("config_revision") or 1),
                origin=str(r.get("origin") or "LIVE"),
                last_good_value=gv.get("v") if isinstance(gv, dict) else None,
                last_good_at=r.get("last_good_event_time"),
                updated_at=r.get("updated_at"),
            )
        return out

    async def commit_batch_metadata(
        self,
        *,
        tenant_id: UUID,
        latest_rows: Sequence[dict[str, Any]],
        live_connection_ids: set[UUID],
        stream_events: list[dict[str, Any]],
        shadow_pg_rows: Sequence[dict[str, Any]],
        now: datetime,
    ) -> tuple[set[UUID], list[dict[str, Any]]]:
        """Atomically persist latest_signal_state + connection liveness + optional shadow PG + PG NOTIFY."""
        assert self._pool is not None
        replaced_signals: set[UUID] = set()
        health_events: list[dict[str, Any]] = []

        async with self._pool.acquire() as conn:
            async with conn.transaction():
                if shadow_pg_rows:
                    await self._insert_shadow_pg(conn, tenant_id, shadow_pg_rows, now)

                if latest_rows:
                    # Sorted by signal_id so concurrent ingestion transactions acquire row locks in deterministic order.
                    ordered = sorted(latest_rows, key=lambda r: str(r["signal_id"]))
                    sig_ids = [r["signal_id"] for r in ordered]
                    res_ids = [r["resource_id"] for r in ordered]
                    obs_ids = [r["observation_id"] for r in ordered]
                    val_types = [r["value_type"] for r in ordered]
                    val_jsons = [json.dumps({"v": r["value"]}, allow_nan=False) for r in ordered]
                    units = [r["unit"] for r in ordered]
                    qualities = [r["quality"] for r in ordered]
                    ev_times = [r["event_time"] for r in ordered]
                    rx_times = [r["received_time"] for r in ordered]
                    acq_times = [r["last_acquired_at"] for r in ordered]
                    src_times = [r["source_time"] for r in ordered]
                    revs = [int(r["config_revision"]) for r in ordered]
                    origins = [r["origin"] for r in ordered]
                    epochs = [int(r["data_epoch"]) for r in ordered]
                    seqs = [r["source_sequence"] for r in ordered]
                    reasons = [r["reason_code"] for r in ordered]
                    uids = [r["event_uid"][:256] for r in ordered]
                    goods = [
                        json.dumps({"v": r["value"]}, allow_nan=False) if (r["quality"] == "GOOD" and r["value"] is not None) else None
                        for r in ordered
                    ]
                    good_times = [
                        r["event_time"] if (r["quality"] == "GOOD" and r["value"] is not None) else None
                        for r in ordered
                    ]

                    ret_rows = await conn.fetch(
                        """
                        INSERT INTO latest_signal_state (
                            tenant_id, signal_id, resource_id, observation_id, value_type, value_json, unit, quality,
                            event_time, received_time, source_time, config_revision, origin, last_good_value_json,
                            last_good_event_time, updated_at, last_acquired_at, last_value_changed_at,
                            data_epoch, source_sequence, reason_code, event_uid
                        )
                        SELECT $1::uuid, t.signal_id, t.resource_id, t.observation_id, t.value_type, t.value_json::jsonb,
                               t.unit, t.quality, t.event_time, t.received_time, t.source_time, t.config_rev, t.origin,
                               t.good_json::jsonb, t.good_time, $2::timestamptz, t.last_acquired_at, t.event_time,
                               t.data_epoch, t.source_seq, t.reason_code, t.event_uid
                        FROM unnest(
                            $3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::text[],
                            $9::text[], $10::timestamptz[], $11::timestamptz[], $12::timestamptz[],
                            $13::timestamptz[], $14::bigint[], $15::text[], $16::bigint[], $17::bigint[],
                            $18::text[], $19::text[], $20::text[], $21::timestamptz[]
                        ) AS t(
                            signal_id, resource_id, observation_id, value_type, value_json, unit,
                            quality, event_time, received_time, last_acquired_at,
                            source_time, config_rev, origin, data_epoch, source_seq,
                            reason_code, event_uid, good_json, good_time
                        )
                        ON CONFLICT (tenant_id, signal_id) DO UPDATE SET
                            resource_id = EXCLUDED.resource_id,
                            observation_id = EXCLUDED.observation_id,
                            value_type = EXCLUDED.value_type,
                            value_json = EXCLUDED.value_json,
                            unit = EXCLUDED.unit,
                            quality = EXCLUDED.quality,
                            event_time = EXCLUDED.event_time,
                            received_time = EXCLUDED.received_time,
                            source_time = EXCLUDED.source_time,
                            config_revision = EXCLUDED.config_revision,
                            origin = EXCLUDED.origin,
                            last_acquired_at = EXCLUDED.last_acquired_at,
                            last_value_changed_at = CASE
                                WHEN latest_signal_state.value_json IS DISTINCT FROM EXCLUDED.value_json
                                  OR latest_signal_state.quality IS DISTINCT FROM EXCLUDED.quality
                                  OR COALESCE(latest_signal_state.reason_code, '') IS DISTINCT FROM COALESCE(EXCLUDED.reason_code, '')
                                  OR EXCLUDED.data_epoch > latest_signal_state.data_epoch
                                THEN EXCLUDED.event_time
                                ELSE COALESCE(latest_signal_state.last_value_changed_at, latest_signal_state.event_time)
                            END,
                            data_epoch = EXCLUDED.data_epoch,
                            source_sequence = EXCLUDED.source_sequence,
                            reason_code = EXCLUDED.reason_code,
                            event_uid = EXCLUDED.event_uid,
                            last_good_value_json = CASE
                                WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.value_json
                                ELSE latest_signal_state.last_good_value_json
                            END,
                            last_good_event_time = CASE
                                WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.event_time
                                ELSE latest_signal_state.last_good_event_time
                            END,
                            updated_at = EXCLUDED.updated_at
                        WHERE EXCLUDED.data_epoch > latest_signal_state.data_epoch
                           OR (
                               EXCLUDED.data_epoch = latest_signal_state.data_epoch
                               AND (
                                   EXCLUDED.received_time,
                                   COALESCE(EXCLUDED.source_sequence, -1),
                                   EXCLUDED.event_uid
                               ) > (
                                   latest_signal_state.received_time,
                                   COALESCE(latest_signal_state.source_sequence, -1),
                                   COALESCE(NULLIF(latest_signal_state.event_uid, ''), latest_signal_state.observation_id::text)
                               )
                           )
                        RETURNING signal_id, last_acquired_at, last_value_changed_at, data_epoch
                        """,
                        tenant_id,
                        now,
                        sig_ids,
                        res_ids,
                        obs_ids,
                        val_types,
                        val_jsons,
                        units,
                        qualities,
                        ev_times,
                        rx_times,
                        acq_times,
                        src_times,
                        revs,
                        origins,
                        epochs,
                        seqs,
                        reasons,
                        uids,
                        goods,
                        good_times,
                    )
                    returned_rows = {UUID(str(r["signal_id"])): dict(r) for r in ret_rows}
                    replaced_signals = set(returned_rows.keys())
                else:
                    returned_rows = {}

                if live_connection_ids:
                    conn_rows = await conn.fetch(
                        """
                        WITH prev AS (
                            SELECT id, health AS old_health
                            FROM connections
                            WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid AND status = 'ACTIVE'
                            ORDER BY id
                            FOR UPDATE
                        )
                        UPDATE connections c
                        SET last_success_at = GREATEST(COALESCE(c.last_success_at, $3::timestamptz), $3::timestamptz),
                            health = CASE
                                WHEN c.health = 'UNKNOWN' THEN 'HEALTHY'
                                WHEN c.health = 'DEGRADED' AND c.last_error LIKE $4 THEN 'HEALTHY'
                                ELSE c.health
                            END,
                            last_error = CASE WHEN c.last_error LIKE $4 THEN NULL ELSE c.last_error END
                        FROM prev
                        WHERE c.id = prev.id
                        RETURNING c.id, c.health, c.last_error, c.last_success_at, prev.old_health
                        """,
                        sorted(live_connection_ids, key=str),
                        tenant_id,
                        now,
                        f"{NO_DATA_PREFIX}%",
                    )
                    for cr in conn_rows:
                        if cr["health"] == cr["old_health"]:
                            continue
                        if cr["old_health"] == "DEGRADED":
                            await conn.execute(
                                """
                                INSERT INTO audit_events (
                                    id, tenant_id, event_type, actor_id, entity_type, entity_id,
                                    before_json, after_json, correlation_id, occurred_at, severity
                                ) VALUES ($1, $2, 'CONNECTION_RECOVERED', NULL, 'connection', $3, $4::jsonb, $5::jsonb, 'ingestion', $6, 'INFO')
                                """,
                                uuid4(),
                                tenant_id,
                                cr["id"],
                                json.dumps({"health": cr["old_health"]}),
                                json.dumps({"health": cr["health"]}),
                                now,
                            )
                        payload = connection_health_payload(
                            connection_id=cr["id"],
                            health=cr["health"],
                            effective_health=effective_connection_health(
                                status="ACTIVE",
                                health=cr["health"],
                                active_bindings=1,
                                edge_health="ONLINE",
                            ),
                            last_error=cr.get("last_error"),
                            last_success_at=cr.get("last_success_at"),
                        )
                        health_events.append(
                            {"kind": "health", "tenant_id": str(tenant_id), "payload": payload}
                        )

                # Filter stream latest events to signals that actually advanced in latest_signal_state
                to_notify: list[dict[str, Any]] = []
                for ev in stream_events:
                    if ev.get("kind") != "latest":
                        to_notify.append(ev)
                        continue
                    sid = UUID(str(ev["signal_id"]))
                    if sid not in replaced_signals:
                        continue
                    meta_row = returned_rows.get(sid) or {}
                    payload = dict(ev.get("payload") or {})
                    if meta_row.get("last_value_changed_at") is not None:
                        payload["last_value_changed_at"] = iso_ms(meta_row["last_value_changed_at"])
                    if meta_row.get("last_acquired_at") is not None:
                        payload["last_acquired_at"] = iso_ms(meta_row["last_acquired_at"])
                    if meta_row.get("data_epoch") is not None:
                        payload["data_epoch"] = int(meta_row["data_epoch"])
                    to_notify.append({**ev, "payload": payload})
                to_notify.extend(health_events)
                await _emit_chunked_notify(conn, NOTIFY_CHANNEL_STREAM, to_notify)
                if health_events:
                    await _emit_chunked_notify(conn, NOTIFY_CHANNEL_HEALTH, health_events)

        return replaced_signals, health_events

    async def _insert_shadow_pg(
        self,
        conn: asyncpg.Connection,
        tenant_id: UUID,
        rows: Sequence[dict[str, Any]],
        now: datetime,
    ) -> None:
        """Optional dual-path shadow insert into PostgreSQL ``observations`` for S06 parity tests."""
        # Ensure partitions exist for each month referenced by shadow batch
        months = {(r["event_time"].year, r["event_time"].month) for r in rows}
        for year, month in sorted(months):
            part_start = datetime(year, month, 1, tzinfo=timezone.utc)
            part_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc) if month == 12 else datetime(year, month + 1, 1, tzinfo=timezone.utc)
            part_name = f"observations_{year}_{month:02d}"
            await conn.execute(
                f"CREATE TABLE IF NOT EXISTS {part_name} PARTITION OF observations "
                f"FOR VALUES FROM ('{part_start.isoformat()}') TO ('{part_end.isoformat()}')"
            )

        dedup_pairs = [(r["event_uid"], r.get("connection_id") or tenant_id) for r in rows]
        inserted_uids = await conn.fetch(
            """
            INSERT INTO ingest_dedup (tenant_id, edge_id, event_uid, first_seen_at)
            SELECT $1::uuid, t.edge_id, t.event_uid, $2::timestamptz
            FROM unnest($3::text[], $4::uuid[]) AS t(event_uid, edge_id)
            ON CONFLICT DO NOTHING
            RETURNING event_uid
            """,
            tenant_id,
            now,
            [u for u, _ in dedup_pairs],
            [e for _, e in dedup_pairs],
        )
        fresh_uids = {str(r["event_uid"]) for r in inserted_uids}
        new_rows = [r for r in rows if r["event_uid"] in fresh_uids]
        if not new_rows:
            return
        await conn.execute(
            """
            INSERT INTO observations (
                id, tenant_id, site_id, resource_id, signal_id, edge_id, connection_id, event_uid,
                event_time, received_time, source_time, value_type, value_json, unit, quality, origin,
                config_revision, provenance_json
            )
            SELECT t.id, $1::uuid, t.site_id, t.resource_id, t.signal_id, NULL, t.connection_id, t.event_uid,
                   t.event_time, t.received_time, t.source_time, t.value_type, t.value_json::jsonb, t.unit,
                   t.quality, t.origin, t.config_revision, t.provenance::jsonb
            FROM unnest(
                $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[],
                $8::timestamptz[], $9::timestamptz[], $10::timestamptz[], $11::text[],
                $12::text[], $13::text[], $14::text[], $15::text[], $16::bigint[], $17::text[]
            ) AS t(
                id, site_id, resource_id, signal_id, connection_id, event_uid,
                event_time, received_time, source_time, value_type,
                value_json, unit, quality, origin, config_revision, provenance
            )
            """,
            tenant_id,
            [r["observation_id"] for r in new_rows],
            [r.get("site_id") for r in new_rows],
            [r["resource_id"] for r in new_rows],
            [r["signal_id"] for r in new_rows],
            [r.get("connection_id") for r in new_rows],
            [r["event_uid"] for r in new_rows],
            [r["event_time"] for r in new_rows],
            [r["received_time"] for r in new_rows],
            [r.get("source_time") for r in new_rows],
            [r["value_type"] for r in new_rows],
            [json.dumps({"v": r["value"]}, allow_nan=False) for r in new_rows],
            [r.get("unit") for r in new_rows],
            [r["quality"] for r in new_rows],
            [r["origin"] for r in new_rows],
            [int(r["config_revision"]) for r in new_rows],
            [json.dumps(r.get("provenance") or {}, default=str) for r in new_rows],
        )

    async def write_heartbeat(
        self,
        *,
        instance_id: str,
        health: str,
        queues_json: dict[str, Any],
        broker_ok: bool,
        diagnostic: str | None = None,
    ) -> None:
        if self._pool is None:
            return
        now = _utcnow()
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO collector_runtime_status (
                    instance_id, role, health, software_version, config_revision,
                    spool_pending, fast_buffered, broker_ok, queues_json, diagnostic,
                    last_heartbeat, updated_at
                ) VALUES ($1, 'ingestion', $2, 's06-worker', 1, 0, 0, $3, $4::jsonb, $5, $6, $6)
                ON CONFLICT (instance_id) DO UPDATE SET
                    health = EXCLUDED.health,
                    broker_ok = EXCLUDED.broker_ok,
                    queues_json = EXCLUDED.queues_json,
                    diagnostic = EXCLUDED.diagnostic,
                    last_heartbeat = EXCLUDED.last_heartbeat,
                    updated_at = EXCLUDED.updated_at
                """,
                instance_id,
                health,
                bool(broker_ok),
                json.dumps(queues_json, default=str),
                (diagnostic or "")[:500] or None,
                now,
            )


async def _emit_chunked_notify(conn: asyncpg.Connection, channel: str, events: Sequence[dict[str, Any]]) -> None:
    if not events:
        return
    chunk: list[dict[str, Any]] = []
    for ev in events:
        candidate = chunk + [ev]
        encoded = json.dumps({"events": candidate}, separators=(",", ":"), default=str)
        if chunk and (len(candidate) > NOTIFY_CHUNK_MAX_EVENTS or len(encoded.encode("utf-8")) > NOTIFY_CHUNK_MAX_BYTES):
            await conn.execute(
                "SELECT pg_notify($1, $2)",
                channel,
                json.dumps({"events": chunk}, separators=(",", ":"), default=str),
            )
            chunk = [ev]
        else:
            chunk = candidate
    if chunk:
        payload = json.dumps({"events": chunk}, separators=(",", ":"), default=str)
        if len(payload.encode("utf-8")) > 7900:
            # Extremely wide JSON payload: strip large payload values from stream push; UI fetches via REST
            shrunk = [
                {
                    **ev,
                    "payload": {k: v for k, v in (ev.get("payload") or {}).items() if k != "value"}
                    if isinstance(ev.get("payload"), dict)
                    else ev.get("payload"),
                }
                for ev in chunk
            ]
            payload = json.dumps({"events": shrunk}, separators=(",", ":"), default=str)
        await conn.execute("SELECT pg_notify($1, $2)", channel, payload)


class IngestionWorker:
    """Async micro-batching RabbitMQ -> TDengine + PG Live State worker."""

    def __init__(
        self,
        *,
        pg_store: PgIngestionStore,
        tdengine: TDEngineClient,
        broker_cfg: BrokerConfig | None = None,
        instance_id: str = DEFAULT_INSTANCE_ID,
        batch_size: int = 200,
        flush_ms: int = 20,
        shadow_pg: bool = False,
        recording_evaluator: RecordingPolicyEvaluator | None = None,
        live_provider: TDengineLiveStateProvider | None = None,
        db_dsn_for_notify: str | None = None,
    ) -> None:
        self.pg = pg_store
        self.td = tdengine
        self.broker_cfg = broker_cfg
        self.instance_id = instance_id
        self.batch_size = max(1, min(1000, int(batch_size)))
        self.flush_interval_s = max(0.002, int(flush_ms) / 1000.0)
        self.shadow_pg = bool(shadow_pg)
        self._formula_ast_cache: dict[tuple[UUID, int], Any] = {}
        self.recording_evaluator: RecordingPolicyEvaluator = (
            recording_evaluator if recording_evaluator is not None else DefaultRecordingPolicyEvaluator()
        )
        self.live_provider: TDengineLiveStateProvider = (
            live_provider if live_provider is not None else TDengineLiveStateProvider(tdengine)
        )
        self._notify_dsn = to_asyncpg_dsn(db_dsn_for_notify) if db_dsn_for_notify else None

        self.metrics = WorkerMetrics()
        self.hist = LatencyHistogram()
        self.recent_uids = RecentUidLru()
        self._rejections = RejectionThrottle()

        self._catalogs: dict[UUID, TenantCatalog] = {}
        self._catalog_locks: dict[UUID, asyncio.Lock] = {}
        self._eval_locks: dict[UUID, asyncio.Lock] = {}
        self._live_cache: dict[UUID, dict[UUID, LiveSignalRecord]] = {}
        self._ensured_tenants: set[UUID] = set()
        self._consumer: RabbitMQConsumer | None = None

        self._pending: list[_PendingEnvelope] = []
        self._pending_lock = asyncio.Lock()
        self._wake_batcher = asyncio.Event()
        self._stop_event = asyncio.Event()
        self._stopping = False

        self._batcher_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._notify_task: asyncio.Task[None] | None = None
        self._notify_conn: asyncpg.Connection | None = None

    def invalidate_tenant_cache(self, tenant_id: UUID | None = None, *, epoch_changed: bool = False) -> None:
        if tenant_id is None:
            self._catalogs.clear()
            self._live_cache.clear()
            if epoch_changed:
                if hasattr(self.recording_evaluator, "invalidate_tenant"):
                    self.recording_evaluator.invalidate_tenant(None)
                self.live_provider.invalidate_epoch_sync(None, 1)
            return
        cat = self._catalogs.get(tenant_id)
        if cat is not None:
            cat.loaded_at = 0.0
            cat.epoch_loaded_at = 0.0
        self._live_cache.pop(tenant_id, None)
        if epoch_changed:
            if hasattr(self.recording_evaluator, "invalidate_tenant"):
                self.recording_evaluator.invalidate_tenant(tenant_id)
            next_ep = (cat.active_epoch + 1) if cat is not None else 1
            self.live_provider.invalidate_epoch_sync(tenant_id, next_ep)

    async def start(self) -> None:
        self._stopping = False
        self._stop_event.clear()
        await self.pg.start()
        self._batcher_task = asyncio.create_task(self._batcher_loop(), name="ingestion-batcher")
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="ingestion-heartbeat")
        if self._notify_dsn:
            self._notify_task = asyncio.create_task(self._notify_loop(), name="ingestion-pg-notify")
        if self.broker_cfg is not None:
            self._consumer = RabbitMQConsumer(self.broker_cfg, self.handle_message)
            await self._consumer.start()

    async def stop(self, *, drain_timeout_s: float = 15.0) -> None:
        self._stopping = True
        self._stop_event.set()
        if self._consumer is not None:
            await self._consumer.stop(drain_timeout_s=drain_timeout_s)
        self._wake_batcher.set()
        if self._batcher_task is not None:
            try:
                await asyncio.wait_for(self._batcher_task, timeout=drain_timeout_s)
            except asyncio.TimeoutError:
                self._batcher_task.cancel()
                await asyncio.gather(self._batcher_task, return_exceptions=True)
            self._batcher_task = None
        for task in (self._heartbeat_task, self._notify_task):
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self._heartbeat_task = None
        self._notify_task = None
        if self._notify_conn is not None and not self._notify_conn.is_closed():
            try:
                await self._notify_conn.close()
            except Exception:  # noqa: BLE001
                pass
            self._notify_conn = None
        await self.pg.close()

    async def handle_message(self, message: AbstractIncomingMessage) -> ConsumeOutcome:
        """RabbitMQConsumer message handler. Resolves only after durable storage or permanent quarantine."""
        self.metrics.received_total += 1
        raw_body = bytes(message.body)
        if len(raw_body) > MAX_MESSAGE_BYTES:
            tid = self._header_tenant_uuid(message.headers)
            uid = str(message.message_id or "oversize")[:256]
            await self._safe_quarantine(
                tenant_id=tid,
                edge_id=None,
                event_uid=uid,
                reason=f"OVERSIZE_PAYLOAD: {len(raw_body)} bytes > {MAX_MESSAGE_BYTES}",
                payload={"bytes": len(raw_body)},
            )
            self.metrics.dlq_total += 1
            return ConsumeOutcome.DEAD_LETTER

        fut: asyncio.Future[ConsumeOutcome] = asyncio.get_running_loop().create_future()
        env = _PendingEnvelope(
            raw_body=raw_body,
            message_id=str(message.message_id) if message.message_id else None,
            headers=dict(message.headers or {}),
            redelivered=bool(getattr(message, "redelivered", False)),
            ingested_at=_utcnow(),
            future=fut,
        )
        async with self._pending_lock:
            self._pending.append(env)
            should_wake = len(self._pending) >= self.batch_size
        if should_wake:
            self._wake_batcher.set()
        return await fut

    async def ingest_direct_bytes(
        self,
        items: Sequence[tuple[bytes, dict[str, Any] | None, str | None, bool]],
    ) -> list[ConsumeOutcome]:
        """Synchronously process a list of ``(raw_bytes, headers, message_id, redelivered)`` for tests/replays."""
        loop = asyncio.get_running_loop()
        envelopes: list[_PendingEnvelope] = []
        pre_outcomes: dict[int, ConsumeOutcome] = {}
        now = _utcnow()
        for idx, (raw_body, headers, msg_id, redelivered) in enumerate(items):
            if len(raw_body) > MAX_MESSAGE_BYTES:
                tid = self._header_tenant_uuid(headers or {})
                await self._safe_quarantine(
                    tenant_id=tid,
                    edge_id=None,
                    event_uid=str(msg_id or "oversize")[:256],
                    reason=f"OVERSIZE_PAYLOAD: {len(raw_body)} bytes > {MAX_MESSAGE_BYTES}",
                    payload={"bytes": len(raw_body)},
                )
                self.metrics.dlq_total += 1
                pre_outcomes[idx] = ConsumeOutcome.DEAD_LETTER
                continue
            env = _PendingEnvelope(
                raw_body=raw_body,
                message_id=msg_id,
                headers=headers or {},
                redelivered=redelivered,
                ingested_at=now,
                future=loop.create_future(),
            )
            envelopes.append(env)
        if envelopes:
            await self._process_batch(envelopes)
        outcomes: list[ConsumeOutcome] = []
        env_iter = iter(envelopes)
        for idx in range(len(items)):
            if idx in pre_outcomes:
                outcomes.append(pre_outcomes[idx])
            else:
                outcomes.append(next(env_iter).future.result())
        return outcomes

    @staticmethod
    def _header_tenant_uuid(headers: Mapping[str, Any] | None) -> UUID:
        if headers and headers.get("x-tenant-id"):
            try:
                return UUID(str(headers["x-tenant-id"]))
            except ValueError:
                pass
        return UUID(int=0)

    async def _safe_quarantine(
        self,
        *,
        tenant_id: UUID,
        edge_id: UUID | None,
        event_uid: str,
        reason: str,
        payload: dict[str, Any],
    ) -> None:
        try:
            await self.pg.write_quarantine(
                tenant_id=tenant_id,
                edge_id=edge_id,
                event_uid=event_uid,
                reason=reason,
                payload=payload,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to record quarantine entry (%s): %s", event_uid, exc)

    async def _batcher_loop(self) -> None:
        while not self._stop_event.is_set() or self._pending:
            try:
                await asyncio.wait_for(self._wake_batcher.wait(), timeout=self.flush_interval_s)
            except asyncio.TimeoutError:
                pass
            self._wake_batcher.clear()

            batch: list[_PendingEnvelope] = []
            async with self._pending_lock:
                if self._pending:
                    batch = self._pending[: self.batch_size]
                    del self._pending[: self.batch_size]
                    if self._pending:
                        self._wake_batcher.set()
            if batch:
                try:
                    await self._process_batch(batch)
                except Exception as exc:  # noqa: BLE001 - ensure all futures resolve on unexpected error
                    logger.exception("Unexpected error in ingestion batcher; marking retry")
                    self.metrics.last_error = str(exc)[:300]
                    for env in batch:
                        if not env.future.done():
                            env.future.set_result(ConsumeOutcome.RETRY)
                            self.metrics.retried_total += 1

    async def _get_catalog(self, tenant_id: UUID, *, need_signal: UUID | None = None) -> TenantCatalog:
        lock = self._catalog_locks.setdefault(tenant_id, asyncio.Lock())
        async with lock:
            now_mono = time.monotonic()
            prev_cat = self._catalogs.get(tenant_id)
            prev_epoch = prev_cat.active_epoch if prev_cat is not None else None
            if prev_cat is None or prev_cat.loaded_at <= 0.0 or (now_mono - prev_cat.loaded_at) > 30.0:
                cat = await self._retry_pg_op(lambda: self.pg.load_tenant_catalog(tenant_id))
                if prev_epoch is not None and cat.active_epoch > prev_epoch:
                    self.recent_uids.clear_tenant(tenant_id)
                    self._live_cache.pop(tenant_id, None)
                    if hasattr(self.recording_evaluator, "invalidate_tenant"):
                        self.recording_evaluator.invalidate_tenant(tenant_id)
                    await self.live_provider.invalidate_epoch(tenant_id, cat.active_epoch)
                else:
                    self.live_provider.set_active_epoch(tenant_id, cat.active_epoch)
                self._catalogs[tenant_id] = cat
                return cat
            cat = prev_cat
            if cat.epoch_loaded_at <= 0.0 or (now_mono - cat.epoch_loaded_at) > 2.0:
                epoch, state = await self._retry_pg_op(lambda: self.pg.fetch_tenant_epoch(tenant_id))
                if epoch > cat.active_epoch:
                    self.recent_uids.clear_tenant(tenant_id)
                    self._live_cache.pop(tenant_id, None)
                    if hasattr(self.recording_evaluator, "invalidate_tenant"):
                        self.recording_evaluator.invalidate_tenant(tenant_id)
                    await self.live_provider.invalidate_epoch(tenant_id, epoch)
                cat.active_epoch = epoch
                cat.lifecycle_state = state
                cat.epoch_loaded_at = now_mono
            if need_signal is not None and need_signal not in cat.bindings:
                if (now_mono - cat.last_miss_refresh_at) >= 2.0:
                    cat = await self._retry_pg_op(lambda: self.pg.load_tenant_catalog(tenant_id))
                    if prev_epoch is not None and cat.active_epoch > prev_epoch:
                        self.recent_uids.clear_tenant(tenant_id)
                        self._live_cache.pop(tenant_id, None)
                        if hasattr(self.recording_evaluator, "invalidate_tenant"):
                            self.recording_evaluator.invalidate_tenant(tenant_id)
                        await self.live_provider.invalidate_epoch(tenant_id, cat.active_epoch)
                    cat.last_miss_refresh_at = now_mono
                    self._catalogs[tenant_id] = cat
            return cat

    async def _retry_pg_op(self, op: Callable[[], Awaitable[Any]]) -> Any:
        """Hold/retry transient PG errors until recovery or worker shutdown (avoids DLQ exhaustion)."""
        delay = 0.25
        while True:
            try:
                return await op()
            except Exception as exc:
                if not self.pg.is_retryable_pg_error(exc):
                    raise
                self.metrics.pg_retryable_errors += 1
                self.metrics.last_error = f"PG retryable: {exc}"[:300]
                if self._stopping:
                    raise _WorkerStoppingRetry(str(exc)) from exc
                logger.warning("PG transient error (%s); retrying in %.2fs", exc, delay)
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                    raise _WorkerStoppingRetry("Worker stopping during PG recovery.")
                except asyncio.TimeoutError:
                    pass
                delay = min(5.0, delay * 2.0)

    async def _wait_for_active_lifecycle(self, tenant_id: UUID, obs_epoch: int) -> TenantCatalog:
        """Block unACKed messages cleanly while tenant reset is in progress; allow old-epoch drops immediately."""
        delay = 0.25
        while True:
            cat = await self._get_catalog(tenant_id)
            if obs_epoch != cat.active_epoch or cat.lifecycle_state == "ACTIVE":
                return cat
            if self._stopping:
                raise _WorkerStoppingRetry("Worker stopping while tenant is in non-ACTIVE reset state.")
            logger.info(
                "Tenant %s is in lifecycle_state=%s; holding epoch=%d delivery unACKed",
                tenant_id,
                cat.lifecycle_state,
                obs_epoch,
            )
            cat.epoch_loaded_at = 0.0
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                raise _WorkerStoppingRetry("Worker stopping during tenant reset pause.")
            except asyncio.TimeoutError:
                pass
            delay = min(2.0, delay * 1.5)

    async def _process_batch(self, batch: list[_PendingEnvelope]) -> None:
        now = _utcnow()
        parsed_per_tenant: dict[UUID, list[tuple[_PendingEnvelope, _PreparedObs]]] = {}

        # 1. Envelope decode, validation, origin filter
        decoded_candidates: list[tuple[_PendingEnvelope, CanonicalObservation, datetime, datetime, datetime | None, str, str | None]] = []
        for env in batch:
            try:
                obs = CanonicalObservation.from_json_bytes(env.raw_body)
                obs.validate()
            except (ObservationError, ValueError, TypeError, KeyError) as exc:
                tid = self._header_tenant_uuid(env.headers)
                uid = str(env.message_id or "invalid")[:256]
                await self._safe_quarantine(
                    tenant_id=tid,
                    edge_id=None,
                    event_uid=uid,
                    reason=str(exc) or type(exc).__name__,
                    payload={"message_id": uid, "bytes": len(env.raw_body)},
                )
                self.metrics.dlq_total += 1
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.DEAD_LETTER)
                continue

            if obs.origin == Origin.TEST:
                self.metrics.test_dropped += 1
                self.metrics.acked_total += 1
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.ACK)
                continue

            if obs.origin == Origin.CALCULATED:
                await self._safe_quarantine(
                    tenant_id=obs.tenant_id,
                    edge_id=None,
                    event_uid=obs.event_uid,
                    reason="CALCULATED observations are produced by Center.",
                    payload={"signal_id": str(obs.signal_id), "data_epoch": obs.data_epoch},
                )
                self.metrics.dlq_total += 1
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.DEAD_LETTER)
                continue

            dec = resolve_times(
                received_time=obs.acquired_at,
                source_time=obs.source_time,
                quality=obs.quality.value,
                now=env.ingested_at,
            )
            if dec.reason and dec.quality != obs.quality.value:
                reason_code = dec.reason
            elif obs.quality_reason:
                reason_code = obs.quality_reason
            elif dec.reason:
                reason_code = dec.reason
            else:
                reason_code = None

            decoded_candidates.append((env, obs, dec.event_time, dec.received_time, dec.source_time, dec.quality, reason_code))

        # 2. Epoch fencing, lifecycle pause gate, catalog ownership, in-memory dedup
        batch_seen_uids: set[tuple[UUID, str]] = set()
        for env, obs, ev_time, rx_time, src_time, norm_quality, reason_code in decoded_candidates:
            try:
                cat = await self._wait_for_active_lifecycle(obs.tenant_id, obs.data_epoch)
            except _WorkerStoppingRetry:
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.RETRY)
                    self.metrics.retried_total += 1
                continue

            if obs.data_epoch < cat.active_epoch:
                self.metrics.epoch_fenced_dropped += 1
                self.metrics.acked_total += 1
                if self._rejections.should_audit((str(obs.tenant_id), "epoch", str(obs.data_epoch)), now):
                    try:
                        await self.pg.write_audit(
                            tenant_id=obs.tenant_id,
                            event_type="EPOCH_FENCED_DROP",
                            entity_type="signal",
                            entity_id=obs.signal_id,
                            after={
                                "data_epoch": obs.data_epoch,
                                "active_epoch": cat.active_epoch,
                                "event_uid": obs.event_uid,
                            },
                            severity="INFO",
                        )
                    except Exception:  # noqa: BLE001
                        pass
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.ACK)
                continue

            if obs.data_epoch > cat.active_epoch:
                await self._safe_quarantine(
                    tenant_id=obs.tenant_id,
                    edge_id=None,
                    event_uid=obs.event_uid,
                    reason=f"EPOCH_AHEAD: observation epoch {obs.data_epoch} > active_epoch {cat.active_epoch}",
                    payload={"signal_id": str(obs.signal_id), "data_epoch": obs.data_epoch},
                )
                self.metrics.dlq_total += 1
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.DEAD_LETTER)
                continue

            uid_key = (obs.tenant_id, obs.event_uid)
            if uid_key in batch_seen_uids or (uid_key in self.recent_uids and not env.redelivered):
                self.metrics.dedup_hits += 1
                self.metrics.acked_total += 1
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.ACK)
                continue

            try:
                cat = await self._get_catalog(obs.tenant_id, need_signal=obs.signal_id)
            except _WorkerStoppingRetry:
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.RETRY)
                    self.metrics.retried_total += 1
                continue

            owned = _default_owned_check(cat, obs, rx_time)
            if owned is None:
                await self._safe_quarantine(
                    tenant_id=obs.tenant_id,
                    edge_id=None,
                    event_uid=obs.event_uid,
                    reason="Signal is not bound or scope/connection mismatch.",
                    payload={"signal_id": str(obs.signal_id), "connection_id": str(obs.connection_id or "")},
                )
                if self._rejections.should_audit((str(obs.tenant_id), str(obs.signal_id), "unbound"), now):
                    try:
                        await self.pg.write_audit(
                            tenant_id=obs.tenant_id,
                            event_type="INGEST_REJECTED",
                            entity_type="connection" if obs.connection_id else "signal",
                            entity_id=obs.connection_id or obs.signal_id,
                            after={
                                "event_uid": obs.event_uid,
                                "signal_id": str(obs.signal_id),
                                "config_revision": obs.config_revision,
                            },
                            severity="WARN",
                        )
                    except Exception:  # noqa: BLE001
                        pass
                self.metrics.dlq_total += 1
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.DEAD_LETTER)
                continue

            batch_seen_uids.add(uid_key)
            prov_dict = obs.provenance.to_dict() if obs.provenance else {}
            if reason_code:
                prov_dict["reason"] = reason_code
            prep = _PreparedObs(
                obs=obs,
                event_time=ev_time,
                received_time=rx_time,
                source_time=src_time,
                norm_quality=norm_quality,
                reason_code=reason_code,
                owned=owned,
                ingested_at=env.ingested_at,
                provenance_dict=prov_dict,
            )
            parsed_per_tenant.setdefault(obs.tenant_id, []).append((env, prep))

        # 3. Per-tenant durable persistence: TDengine first, then formulas + PG latest_signal_state + ACK
        for tenant_id, tenant_items in parsed_per_tenant.items():
            await self._persist_tenant_batch(tenant_id, tenant_items)

    async def _write_td_with_retry(
        self,
        tenant_id: UUID,
        td_records: list[dict[str, Any]],
        *,
        record_kind: str = "RAW_OPERATIONAL",
    ) -> tuple[set[str], dict[str, BatchWriteFailure], bool]:
        """Write to TDengine with backoff on retryable/schema errors; never exhaust x-delivery-limit=5."""
        if not td_records:
            return set(), {}, False
        pending = list(td_records)
        succeeded_all: set[str] = set()
        perm_failures: dict[str, BatchWriteFailure] = {}
        delay = 0.25
        schema_retries = 0

        while pending:
            try:
                if tenant_id not in self._ensured_tenants:
                    await self.td.ensure_operational_schema(tenant_id)
                    self._ensured_tenants.add(tenant_id)
                res: BatchWriteResult = await self.td.write_operational_observations(
                    tenant_id, pending, record_kind=record_kind
                )
            except TDEngineError as exc:
                schema_missing = self._handle_possible_schema_error(tenant_id, exc.message)
                if schema_missing and schema_retries < 2:
                    schema_retries += 1
                    logger.warning(
                        "TDengine schema missing for tenant %s; re-ensuring schema (attempt %d)",
                        tenant_id,
                        schema_retries,
                    )
                    continue
                if not exc.retryable:
                    self.metrics.tdengine_permanent_errors += len(pending)
                    self.metrics.last_error = f"TDengine permanent error: {exc.message}"[:300]
                    for r in pending:
                        perm_failures[str(r["event_uid"])] = BatchWriteFailure(
                            str(r["event_uid"]),
                            op_subtable_name(r["signal_id"], r["value_type"]),
                            exc.code,
                            exc.message,
                            retryable=False,
                        )
                    return succeeded_all, perm_failures, False

                self.metrics.tdengine_retryable_errors += 1
                self.metrics.last_error = f"TDengine unavailable: {exc.message}"[:300]
                if self._stopping:
                    return succeeded_all, perm_failures, True
                logger.warning("TDengine write failed cleanly (%s); retrying %d records in %.2fs", exc.code, len(pending), delay)
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                    return succeeded_all, perm_failures, True
                except asyncio.TimeoutError:
                    pass
                delay = min(5.0, delay * 2.0)
                continue

            succeeded_all.update(res.succeeded_ids)
            retry_ids: set[str] = set()
            saw_schema_missing = False
            for fail in res.failures:
                schema_missing = self._handle_possible_schema_error(tenant_id, fail.message)
                if fail.retryable or (schema_missing and schema_retries < 2):
                    retry_ids.add(fail.item_id)
                    if schema_missing:
                        saw_schema_missing = True
                else:
                    self.metrics.tdengine_permanent_errors += 1
                    perm_failures[fail.item_id] = fail
            if saw_schema_missing:
                schema_retries += 1

            if not retry_ids:
                break
            pending = [r for r in pending if str(r["event_uid"]) in retry_ids]
            self.metrics.tdengine_retryable_errors += len(pending)
            self.metrics.last_error = f"TDengine partial retryable error on {len(pending)} item(s)"
            if self._stopping:
                return succeeded_all, perm_failures, True
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                return succeeded_all, perm_failures, True
            except asyncio.TimeoutError:
                pass
            delay = min(5.0, delay * 2.0)

        return succeeded_all, perm_failures, False

    def _handle_possible_schema_error(self, tenant_id: UUID, message: str) -> bool:
        low = message.lower()
        if any(tok in low for tok in ("not exist", "doesn't exist", "does not exist")):
            self._ensured_tenants.discard(tenant_id)
            return True
        return False

    async def _hydrate_previous_live(
        self, tenant_id: UUID, signal_ids: Sequence[UUID]
    ) -> dict[UUID, LiveSignalRecord]:
        t_cache = self._live_cache.setdefault(tenant_id, {})
        missing = [sid for sid in dict.fromkeys(signal_ids) if sid not in t_cache]
        if missing and hasattr(self.pg, "fetch_latest_states_for_eval"):
            try:
                loaded = await self._retry_pg_op(
                    lambda: self.pg.fetch_latest_states_for_eval(tenant_id, missing)
                )
                t_cache.update(loaded)
            except _WorkerStoppingRetry:
                raise
        return {sid: t_cache[sid] for sid in signal_ids if sid in t_cache}

    async def _hydrate_managed_states(
        self,
        tenant_id: UUID,
        cat: TenantCatalog,
        targets: Sequence[ManagedBindingTarget],
    ) -> bool:
        """Hydrate missing per-series Managed states from TDengine ``LAST_ROW`` on cold start.

        Returns ``True`` if aborted cleanly due to worker shutdown.
        """
        if not isinstance(self.recording_evaluator, DefaultRecordingPolicyEvaluator):
            return False
        if not hasattr(self.td, "query_last_row"):
            return False

        deduped: dict[tuple[UUID, str], ManagedBindingTarget] = {}
        for t in targets:
            deduped.setdefault((t.dataset_id, t.series_key), t)

        need = [
            t
            for t in deduped.values()
            if not self.recording_evaluator.has_series_state(tenant_id, t.dataset_id, t.series_key)
        ]
        for target in need:
            delay = 0.25
            while True:
                try:
                    row = await self.td.query_last_row(target.td_database, target.td_subtable)
                except TDEngineError as exc:
                    low = exc.message.lower()
                    if any(tok in low for tok in ("not exist", "doesn't exist", "does not exist")):
                        row = None
                    elif exc.retryable:
                        self.metrics.tdengine_retryable_errors += 1
                        self.metrics.last_error = f"TDengine Managed hydration unavailable: {exc.message}"[:300]
                        if self._stopping:
                            return True
                        try:
                            await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                            return True
                        except asyncio.TimeoutError:
                            pass
                        delay = min(5.0, delay * 2.0)
                        continue
                    else:
                        logger.warning(
                            "Non-retryable Managed LAST_ROW error for %s.%s: %s",
                            target.td_database,
                            target.td_subtable,
                            exc.message,
                        )
                        row = None
                self.recording_evaluator.seed_series_state_from_row(
                    tenant_id,
                    target,
                    row,
                    active_epoch=cat.active_epoch,
                )
                break
        return False

    async def _write_managed_td_with_retry(
        self,
        tenant_id: UUID,
        writes: Sequence[ManagedSubtableWrite],
    ) -> tuple[set[str], dict[str, BatchWriteFailure], bool]:
        """Write Managed dataset rows cleanly via ``TDEngineClient.write_batch`` with retry isolation."""
        if not writes or not hasattr(self.td, "write_batch"):
            return set(), {}, False

        seen_ts: dict[tuple[str, str], dict[int, str]] = {}
        by_db: dict[str, list[SubtableWriteItem]] = {}
        for w in writes:
            sub_key = (w.target.td_database, w.target.td_subtable)
            sub_seen = seen_ts.setdefault(sub_key, {})
            ts_us = to_td_timestamp_us(w.ts)
            while ts_us in sub_seen and sub_seen[ts_us] != w.event_uid:
                ts_us += 1
            sub_seen[ts_us] = w.event_uid
            item = w.to_subtable_item(ts_override=to_utc_datetime(ts_us))
            by_db.setdefault(w.target.td_database, []).append(item)

        succeeded_all: set[str] = set()
        perm_failures: dict[str, BatchWriteFailure] = {}
        for db_name, db_items in by_db.items():
            pending = list(db_items)
            delay = 0.25
            while pending:
                try:
                    res: BatchWriteResult = await self.td.write_batch(db_name, pending)
                except TDEngineError as exc:
                    if not exc.retryable:
                        self.metrics.managed_write_errors += len(pending)
                        self.metrics.last_error = f"Managed TDengine write error: {exc.message}"[:300]
                        for it in pending:
                            perm_failures[it.item_id] = BatchWriteFailure(
                                it.item_id,
                                it.subtable,
                                exc.code,
                                exc.message,
                                retryable=False,
                            )
                        break
                    self.metrics.tdengine_retryable_errors += 1
                    self.metrics.last_error = f"Managed TDengine unavailable: {exc.message}"[:300]
                    if self._stopping:
                        return succeeded_all, perm_failures, True
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                        return succeeded_all, perm_failures, True
                    except asyncio.TimeoutError:
                        pass
                    delay = min(5.0, delay * 2.0)
                    continue

                succeeded_all.update(res.succeeded_ids)
                retry_ids: set[str] = set()
                for fail in res.failures:
                    if fail.retryable:
                        retry_ids.add(fail.item_id)
                    else:
                        self.metrics.managed_write_errors += 1
                        self.metrics.last_error = f"Managed write rejected ({fail.code}): {fail.message}"[:300]
                        perm_failures[fail.item_id] = fail

                if not retry_ids:
                    break
                pending = [it for it in pending if it.item_id in retry_ids]
                self.metrics.tdengine_retryable_errors += len(pending)
                if self._stopping:
                    return succeeded_all, perm_failures, True
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                    return succeeded_all, perm_failures, True
                except asyncio.TimeoutError:
                    pass
                delay = min(5.0, delay * 2.0)

        return succeeded_all, perm_failures, False

    @staticmethod
    def _build_calc_obs(tenant_id: UUID, rec: Mapping[str, Any]) -> CanonicalObservation:
        vtype = str(rec.get("value_type") or "float64")
        val = rec.get("value")
        qual_str = str(rec.get("raw_quality") or "GOOD").upper()
        reason = str(rec["reason_code"]) if rec.get("reason_code") else None
        if vtype == "float64" and isinstance(val, (int, float)) and not isinstance(val, bool):
            fval = float(val)
            if not math.isfinite(fval):
                val = None
                qual_str = "BAD"
                reason = reason or "NON_FINITE"
        return CanonicalObservation(
            event_uid=str(rec["event_uid"]),
            tenant_id=tenant_id,
            site_id=None,
            connection_id=None,
            acquisition_job_id=None,
            source_field_id=None,
            signal_id=UUID(str(rec["signal_id"])),
            resource_id=UUID(str(rec["resource_id"])),
            source_time=rec.get("source_time"),
            acquired_at=rec["acquired_at"],
            value_type=vtype,
            value=val,
            unit=rec.get("unit"),
            quality=Quality(qual_str),
            quality_reason=reason,
            origin=Origin.CALCULATED,
            data_epoch=int(rec.get("data_epoch") or 1),
            config_revision=max(1, int(rec.get("config_revision") or 1)),
            source_sequence=None,
        )

    def _sync_policy_metrics(self) -> None:
        if isinstance(self.recording_evaluator, DefaultRecordingPolicyEvaluator):
            pm = self.recording_evaluator.metrics
            self.metrics.managed_checkpoints = pm.managed_checkpoints
            self.metrics.managed_gap_markers = pm.managed_gap_markers
            self.metrics.managed_skips_by_reason = dict(pm.managed_skipped_by_reason)

    async def _persist_tenant_batch(
        self,
        tenant_id: UUID,
        tenant_items: list[tuple[_PendingEnvelope, _PreparedObs]],
    ) -> None:
        try:
            cat = await self._get_catalog(tenant_id)
        except _WorkerStoppingRetry:
            for env, _ in tenant_items:
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.RETRY)
                    self.metrics.retried_total += 1
            return

        # Re-check epoch right before TDengine write to close any race with concurrent reset fence
        still_items: list[tuple[_PendingEnvelope, _PreparedObs]] = []
        for env, prep in tenant_items:
            if prep.obs.data_epoch < cat.active_epoch:
                self.metrics.epoch_fenced_dropped += 1
                self.metrics.acked_total += 1
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.ACK)
                continue
            still_items.append((env, prep))
        if not still_items:
            return

        is_default_eval = isinstance(self.recording_evaluator, DefaultRecordingPolicyEvaluator)
        custom_prev_live: dict[UUID, LiveSignalRecord] = {}
        if not is_default_eval:
            try:
                custom_prev_live = await self._hydrate_previous_live(
                    tenant_id, [p.obs.signal_id for _, p in still_items]
                )
            except _WorkerStoppingRetry:
                for env, _ in still_items:
                    if not env.future.done():
                        env.future.set_result(ConsumeOutcome.RETRY)
                        self.metrics.retried_total += 1
                return

        td_records: list[dict[str, Any]] = []
        env_by_uid: dict[str, tuple[_PendingEnvelope, _PreparedObs]] = {}
        for env, prep in still_items:
            obs = prep.obs
            env_by_uid[obs.event_uid] = (env, prep)
            if not is_default_eval:
                decision: RecordingDecision = self.recording_evaluator.evaluate(
                    obs, previous_live=custom_prev_live.get(obs.signal_id)
                )
                op_write = bool(decision.write_operational)
            else:
                op_write = getattr(self.recording_evaluator, "write_operational", True)
            if op_write:
                td_records.append(
                    {
                        "event_uid": obs.event_uid,
                        "signal_id": obs.signal_id,
                        "resource_id": prep.owned["resource_id"],
                        "connection_id": prep.owned["connection_id"],
                        "value_type": obs.value_type,
                        "value": obs.value,
                        "unit": obs.unit,
                        "raw_quality": prep.norm_quality,
                        "reason_code": prep.reason_code,
                        "origin": obs.origin.value,
                        "event_time": prep.event_time,
                        "acquired_at": prep.received_time,
                        "source_time": prep.source_time,
                        "config_revision": obs.config_revision,
                        "data_epoch": obs.data_epoch,
                        "source_seq": obs.source_sequence,
                    }
                )

        succeeded_uids, perm_failures, stopping_aborted = await self._write_td_with_retry(
            tenant_id, td_records, record_kind="RAW_OPERATIONAL"
        )
        # Include any item where write_operational was False as succeeded for live state update
        op_written_uids = {str(r["event_uid"]) for r in td_records}
        for uid in list(env_by_uid):
            if uid not in op_written_uids and uid not in perm_failures:
                succeeded_uids.add(uid)

        for uid, fail in perm_failures.items():
            env, prep = env_by_uid[uid]
            await self._safe_quarantine(
                tenant_id=tenant_id,
                edge_id=None,
                event_uid=uid,
                reason=f"TDENGINE_REJECTED ({fail.code}): {fail.message}",
                payload={"signal_id": str(prep.obs.signal_id), "subtable": fail.subtable},
            )
            self.metrics.dlq_total += 1
            if not env.future.done():
                env.future.set_result(ConsumeOutcome.DEAD_LETTER)

        if stopping_aborted:
            for uid, (env, _prep) in env_by_uid.items():
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.RETRY)
                    self.metrics.retried_total += 1
            return

        committed_items = [env_by_uid[uid] for uid in env_by_uid if uid in succeeded_uids]
        if not committed_items:
            return
        self.metrics.tdengine_writes += sum(1 for _env, p in committed_items if p.obs.event_uid in op_written_uids)

        # Build newest candidate per signal for PG latest_signal_state + stream notification
        newest_map: dict[UUID, dict[str, Any]] = {}
        live_conns: set[UUID] = set()
        shadow_rows: list[dict[str, Any]] = []
        formula_triggers: list[_PreparedObs] = []

        for _env, prep in committed_items:
            obs = prep.obs
            obs_id = uuid4()
            cand_key = (obs.data_epoch, prep.received_time, obs.source_sequence if obs.source_sequence is not None else -1, obs.event_uid)
            prev_cand = newest_map.get(obs.signal_id)
            if prev_cand is None or cand_key > prev_cand["_sort_key"]:
                newest_map[obs.signal_id] = {
                    "_sort_key": cand_key,
                    "signal_id": obs.signal_id,
                    "resource_id": UUID(str(prep.owned["resource_id"])),
                    "observation_id": obs_id,
                    "value_type": obs.value_type,
                    "value": obs.value,
                    "unit": obs.unit,
                    "quality": prep.norm_quality,
                    "event_time": prep.event_time,
                    "received_time": prep.received_time,
                    "last_acquired_at": prep.received_time,
                    "source_time": prep.source_time,
                    "config_revision": obs.config_revision,
                    "origin": obs.origin.value,
                    "data_epoch": obs.data_epoch,
                    "source_sequence": obs.source_sequence,
                    "reason_code": prep.reason_code,
                    "event_uid": obs.event_uid,
                    "expected_interval_ms": prep.owned.get("expected_interval_ms"),
                    "nullable": bool(prep.owned.get("nullable")),
                }
            if prep.norm_quality in {"GOOD", "UNCERTAIN"}:
                live_conns.add(UUID(str(prep.owned["connection_id"])))
            if self.shadow_pg:
                shadow_rows.append(
                    {
                        "observation_id": obs_id,
                        "site_id": UUID(str(prep.owned["site_id"])) if prep.owned.get("site_id") else obs.site_id,
                        "resource_id": UUID(str(prep.owned["resource_id"])),
                        "signal_id": obs.signal_id,
                        "connection_id": UUID(str(prep.owned["connection_id"])),
                        "event_uid": obs.event_uid,
                        "event_time": prep.event_time,
                        "received_time": prep.received_time,
                        "source_time": prep.source_time,
                        "value_type": obs.value_type,
                        "value": obs.value,
                        "unit": obs.unit,
                        "quality": prep.norm_quality,
                        "origin": obs.origin.value,
                        "config_revision": obs.config_revision,
                        "provenance": prep.provenance_dict,
                    }
                )
            if obs.signal_id in cat.formula_inputs:
                formula_triggers.append(prep)

        # Evaluate synchronous published formulas (depth <= 4) & write calculated outputs to TDengine before PG commit
        calc_td: list[dict[str, Any]] = []
        if formula_triggers:
            calc_td, calc_latest, calc_shadow, calc_stopped = await self._evaluate_formulas(
                tenant_id, cat, formula_triggers, newest_map
            )
            if calc_stopped:
                for env, _prep in committed_items:
                    if not env.future.done():
                        env.future.set_result(ConsumeOutcome.RETRY)
                        self.metrics.retried_total += 1
                return
            for sig_id, row in calc_latest.items():
                prev_cand = newest_map.get(sig_id)
                if prev_cand is None or row["_sort_key"] > prev_cand["_sort_key"]:
                    newest_map[sig_id] = row
            shadow_rows.extend(calc_shadow)
            self.metrics.formula_writes += len(calc_td)

        # Evaluate Managed Recording Policies & persist Managed datasets to TDengine BEFORE PG commit / RMQ ACK
        if is_default_eval and cat.managed_targets_by_signal:
            assert isinstance(self.recording_evaluator, DefaultRecordingPolicyEvaluator)
            managed_inputs: list[
                tuple[CanonicalObservation, str | None, str | None, list[ManagedBindingTarget]]
            ] = []
            ordered_committed = sorted(
                committed_items,
                key=lambda item: (
                    item[1].obs.data_epoch,
                    item[1].received_time,
                    item[1].obs.source_sequence if item[1].obs.source_sequence is not None else -1,
                    item[1].obs.event_uid,
                ),
            )
            for _env, prep in ordered_committed:
                targets = cat.managed_targets_by_signal.get(prep.obs.signal_id)
                if targets:
                    managed_inputs.append((prep.obs, prep.norm_quality, prep.reason_code, targets))
            for crec in calc_td:
                calc_sig = UUID(str(crec["signal_id"]))
                targets = cat.managed_targets_by_signal.get(calc_sig)
                if targets:
                    calc_obs = self._build_calc_obs(tenant_id, crec)
                    managed_inputs.append((calc_obs, calc_obs.quality.value, calc_obs.quality_reason, targets))

            if managed_inputs:
                targets_needed = [t for _obs, _q, _r, tlist in managed_inputs for t in tlist]
                sigs_needed = [obs.signal_id for obs, _q, _r, _tlist in managed_inputs]
                try:
                    prev_live_map = await self._hydrate_previous_live(tenant_id, sigs_needed)
                except _WorkerStoppingRetry:
                    for env, _prep in committed_items:
                        if not env.future.done():
                            env.future.set_result(ConsumeOutcome.RETRY)
                            self.metrics.retried_total += 1
                    return

                eval_lock = self._eval_locks.setdefault(tenant_id, asyncio.Lock())
                async with eval_lock:
                    hyd_stopped = await self._hydrate_managed_states(tenant_id, cat, targets_needed)
                    if hyd_stopped:
                        for env, _prep in committed_items:
                            if not env.future.done():
                                env.future.set_result(ConsumeOutcome.RETRY)
                                self.metrics.retried_total += 1
                        return

                    all_managed_writes: list[ManagedSubtableWrite] = []
                    for m_obs, m_qual, m_reason, m_targets in managed_inputs:
                        det = self.recording_evaluator.evaluate_for_targets(
                            m_obs,
                            targets=m_targets,
                            previous_live=prev_live_map.get(m_obs.signal_id),
                            active_epoch=cat.active_epoch,
                            norm_quality=m_qual,
                            reason_code=m_reason,
                        )
                        if det.writes:
                            all_managed_writes.extend(det.writes)

                    m_succ, m_perm, m_stopped = await self._write_managed_td_with_retry(
                        tenant_id, all_managed_writes
                    )
                    if m_stopped:
                        self.recording_evaluator.invalidate_tenant(tenant_id)
                        for env, _prep in committed_items:
                            if not env.future.done():
                                env.future.set_result(ConsumeOutcome.RETRY)
                                self.metrics.retried_total += 1
                        return

                    self.metrics.managed_writes += len(m_succ)
                    self._sync_policy_metrics()
                    for item_id, fail in m_perm.items():
                        await self._safe_quarantine(
                            tenant_id=tenant_id,
                            edge_id=None,
                            event_uid=item_id[:256],
                            reason=f"MANAGED_TDENGINE_REJECTED ({fail.code}): {fail.message}",
                            payload={"subtable": fail.subtable, "item_id": item_id},
                        )

        now_commit = _utcnow()
        latest_list = list(newest_map.values())
        t_cache_preview = self._live_cache.get(tenant_id, {})
        stream_events = []
        for r in latest_list:
            prev_rec_preview = t_cache_preview.get(r["signal_id"])
            preview_changed = (
                prev_rec_preview is None
                or prev_rec_preview.data_epoch != int(r["data_epoch"])
                or prev_rec_preview.value != r["value"]
                or prev_rec_preview.raw_quality != r["quality"]
                or (prev_rec_preview.reason_code or "") != (r["reason_code"] or "")
            )
            preview_changed_at = (
                r["event_time"]
                if preview_changed
                else (prev_rec_preview.last_value_changed_at or prev_rec_preview.event_time)  # type: ignore[union-attr]
            )
            stream_events.append(
                {
                    "kind": "latest",
                    "tenant_id": str(tenant_id),
                    "signal_id": str(r["signal_id"]),
                    "resource_id": str(r["resource_id"]),
                    "value_type": str(r["value_type"]),
                    "unit": r.get("unit"),
                    "event_uid": r.get("event_uid"),
                    "source_sequence": r.get("source_sequence"),
                    "config_revision": int(r.get("config_revision") or 1),
                    "origin": str(r.get("origin") or "LIVE"),
                    "payload": latest_stream_payload(
                        signal_id=r["signal_id"],
                        value=r["value"],
                        quality=r["quality"],
                        reason=r["reason_code"],
                        received_time=r["received_time"],
                        source_time=r["source_time"],
                        expected_interval_ms=r.get("expected_interval_ms"),
                        null_allowed=bool(r.get("nullable")),
                        now=now_commit,
                        include_meta=True,
                        data_epoch=int(r["data_epoch"]),
                        last_acquired_at=r["last_acquired_at"],
                        last_value_changed_at=preview_changed_at,
                    ),
                }
            )

        try:
            replaced_signals, _health_events = await self._retry_pg_op(
                lambda: self.pg.commit_batch_metadata(
                    tenant_id=tenant_id,
                    latest_rows=latest_list,
                    live_connection_ids=live_conns,
                    stream_events=stream_events,
                    shadow_pg_rows=shadow_rows,
                    now=now_commit,
                )
            )
        except _WorkerStoppingRetry:
            for env, _prep in committed_items:
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.RETRY)
                    self.metrics.retried_total += 1
            return

        t_cache = self._live_cache.setdefault(tenant_id, {})
        for sig_id, row in newest_map.items():
            if sig_id not in replaced_signals and sig_id in t_cache:
                continue
            prev_rec = t_cache.get(sig_id)
            val_changed = (
                prev_rec is None
                or prev_rec.data_epoch != int(row["data_epoch"])
                or prev_rec.value != row["value"]
                or prev_rec.raw_quality != row["quality"]
                or (prev_rec.reason_code or "") != (row["reason_code"] or "")
            )
            good_val = row["value"] if (row["quality"] == "GOOD" and row["value"] is not None) else (
                prev_rec.last_good_value if prev_rec else None
            )
            good_at = row["event_time"] if (row["quality"] == "GOOD" and row["value"] is not None) else (
                prev_rec.last_good_at if prev_rec else None
            )
            t_cache[sig_id] = LiveSignalRecord(
                tenant_id=tenant_id,
                signal_id=sig_id,
                resource_id=row["resource_id"],
                observation_id=row["observation_id"],
                event_uid=row["event_uid"],
                data_epoch=int(row["data_epoch"]),
                value_type=row["value_type"],
                value=row["value"],
                unit=row["unit"],
                raw_quality=row["quality"],
                reason_code=row["reason_code"],
                event_time=row["event_time"],
                last_acquired_at=row["last_acquired_at"],
                last_value_changed_at=(
                    row["event_time"]
                    if val_changed
                    else (prev_rec.last_value_changed_at or prev_rec.event_time)
                ),
                source_time=row["source_time"],
                config_revision=int(row["config_revision"]),
                origin=row["origin"],
                last_good_value=good_val,
                last_good_at=good_at,
                updated_at=now_commit,
            )

        # Feed committed observations & calculated outputs into LiveStateProvider in causal order
        ordered_for_live = sorted(
            committed_items,
            key=lambda item: (
                item[1].obs.data_epoch,
                item[1].received_time,
                item[1].obs.source_sequence if item[1].obs.source_sequence is not None else -1,
                item[1].obs.event_uid,
            ),
        )
        for _env, prep in ordered_for_live:
            await self.live_provider.apply_observation(
                prep.obs,
                expected_interval_ms=prep.owned.get("expected_interval_ms"),
                null_allowed=bool(prep.owned.get("nullable")),
            )
        for crec in calc_td:
            calc_obs = self._build_calc_obs(tenant_id, crec)
            await self.live_provider.apply_observation(calc_obs)

        committed_at = _utcnow()
        for env, prep in committed_items:
            self.recent_uids.mark((tenant_id, prep.obs.event_uid))
            sli = measure_latency_slis(
                acquired_at=prep.obs.acquired_at,
                ingested_at=prep.ingested_at,
                committed_at=committed_at,
            )
            conn_raw = prep.owned.get("connection_id")
            conn_uuid = conn_raw if isinstance(conn_raw, UUID) else (UUID(str(conn_raw)) if conn_raw else None)
            self.hist.record(tenant_id, sli, connection_id=conn_uuid)
            self.metrics.acked_total += 1
            if not env.future.done():
                env.future.set_result(ConsumeOutcome.ACK)
        self.metrics.batches_committed += 1
        self.metrics.last_commit_at = committed_at

    async def _evaluate_formulas(
        self,
        tenant_id: UUID,
        cat: TenantCatalog,
        triggers: list[_PreparedObs],
        overlay_latest: Mapping[UUID, dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], dict[UUID, dict[str, Any]], list[dict[str, Any]], bool]:
        """Compute published formulas up to depth 4 in causal chronological order and persist to TDengine."""
        # Seed pre-batch cache ONLY from already-committed live state (never future values in this batch!)
        trigger_sigs = {p.obs.signal_id for p in triggers}
        state_cache: dict[UUID, tuple[Any, str, datetime]] = {}
        live_t = self._live_cache.get(tenant_id, {})
        for sid, rec in live_t.items():
            if rec.data_epoch == cat.active_epoch:
                state_cache[sid] = (rec.value, str(rec.raw_quality), rec.last_acquired_at)

        # Pre-collect all alias signal IDs needed by potentially reachable formulas up to depth 4
        frontier_sigs = set(trigger_sigs)
        needed_aliases: set[UUID] = set()
        seen_fids: set[UUID] = set()
        scan_sigs = set(frontier_sigs)
        for _depth in range(MAX_FORMULA_DEPTH + 1):
            next_sigs: set[UUID] = set()
            for sig in scan_sigs:
                for f in cat.formulas_by_dep.get(sig, []):
                    fid = UUID(str(f["formula_id"]))
                    if fid in seen_fids:
                        continue
                    seen_fids.add(fid)
                    out_sig = UUID(str(f["output_id"]))
                    next_sigs.add(out_sig)
                    for al in cat.formula_aliases.get(fid, []):
                        needed_aliases.add(UUID(str(al["dependency_signal_id"])))
            if not next_sigs:
                break
            scan_sigs = next_sigs

        missing_from_cache = [sid for sid in needed_aliases if sid not in state_cache]
        if missing_from_cache:
            try:
                pg_latest = await self._retry_pg_op(
                    lambda: self.pg.fetch_latest_values(tenant_id, missing_from_cache)
                )
            except _WorkerStoppingRetry:
                return [], {}, [], True
            for sid, data in pg_latest.items():
                state_cache[sid] = (data["value"], data["quality"], data["received_time"])

        for sid, row in overlay_latest.items():
            if sid not in trigger_sigs and sid not in state_cache:
                state_cache[sid] = (row["value"], str(row["quality"]), row["received_time"])

        calc_td_records: list[dict[str, Any]] = []
        calc_latest_rows: dict[UUID, dict[str, Any]] = {}
        calc_shadow_rows: list[dict[str, Any]] = []

        ordered_triggers = sorted(
            triggers,
            key=lambda p: (
                p.obs.data_epoch,
                p.received_time,
                p.obs.source_sequence if p.obs.source_sequence is not None else -1,
                p.obs.event_uid,
            ),
        )
        visited_evals: set[tuple[UUID, str]] = set()
        for trig_prep in ordered_triggers:
            state_cache[trig_prep.obs.signal_id] = (
                trig_prep.obs.value,
                trig_prep.norm_quality,
                trig_prep.received_time,
            )
            queue: list[tuple[UUID, datetime, datetime, int, str, int]] = [
                (
                    trig_prep.obs.signal_id,
                    trig_prep.event_time,
                    trig_prep.received_time,
                    trig_prep.obs.data_epoch,
                    trig_prep.obs.event_uid,
                    0,
                )
            ]
            while queue:
                trig_sig, ev_time, rx_time, data_epoch, trig_uid, depth = queue.pop(0)
                if depth >= MAX_FORMULA_DEPTH:
                    continue
                for formula in cat.formulas_by_dep.get(trig_sig, []):
                    fid = UUID(str(formula["formula_id"]))
                    if (fid, trig_uid) in visited_evals:
                        continue
                    visited_evals.add((fid, trig_uid))
                    aliases = cat.formula_aliases.get(fid, [])
                    if not aliases:
                        continue
                    values: dict[str, Any] = {}
                    qualities: list[str] = []
                    alias_ids: dict[str, UUID] = {}
                    ready = True
                    for al in aliases:
                        dep_id = UUID(str(al["dependency_signal_id"]))
                        dep_state = state_cache.get(dep_id)
                        if dep_state is None:
                            ready = False
                            break
                        values[str(al["variable_alias"])] = dep_state[0]
                        qualities.append(dep_state[1])
                        alias_ids[str(al["variable_alias"])] = dep_id
                    if not ready:
                        continue
                    try:
                        rev = int(formula.get("revision") or 1)
                        cache_key = (fid, rev)
                        program = self._formula_ast_cache.get(cache_key)
                        if program is None:
                            ast = parse_expression(str(formula["expression_source"]))
                            program = bind(ast, alias_ids)
                            if len(self._formula_ast_cache) >= 5000:
                                self._formula_ast_cache.pop(next(iter(self._formula_ast_cache)))
                            self._formula_ast_cache[cache_key] = program
                        val = evaluate(program, values)
                    except (FormulaError, ZeroDivisionError, OverflowError, ValueError):
                        continue
                    qual = output_quality(qualities, val)
                    output_id = UUID(str(formula["output_id"]))
                    resource_id = UUID(str(formula["resource_id"]))
                    site_id = UUID(str(formula["site_id"])) if formula.get("site_id") else None
                    rev = int(formula["revision"] or 1)
                    vtype = str(formula["data_type"])
                    calc_uid = _deterministic_calc_uid(fid, rev, output_id, trig_uid)
                    obs_id = uuid4()

                    calc_td_records.append(
                        {
                            "event_uid": calc_uid,
                            "signal_id": output_id,
                            "resource_id": resource_id,
                            "connection_id": None,
                            "value_type": vtype,
                            "value": val,
                            "unit": formula.get("unit"),
                            "raw_quality": qual,
                            "reason_code": None,
                            "origin": Origin.CALCULATED.value,
                            "event_time": ev_time,
                            "acquired_at": rx_time,
                            "source_time": None,
                            "config_revision": rev,
                            "data_epoch": data_epoch,
                            "source_seq": None,
                        }
                    )
                    state_cache[output_id] = (val, qual, rx_time)
                    cand_sort_key = (data_epoch, rx_time, -1, calc_uid)
                    prev_latest = calc_latest_rows.get(output_id)
                    if prev_latest is None or cand_sort_key > prev_latest["_sort_key"]:
                        calc_latest_rows[output_id] = {
                            "_sort_key": cand_sort_key,
                            "signal_id": output_id,
                            "resource_id": resource_id,
                            "observation_id": obs_id,
                            "value_type": vtype,
                            "value": val,
                            "unit": formula.get("unit"),
                            "quality": qual,
                            "event_time": ev_time,
                            "received_time": rx_time,
                            "last_acquired_at": rx_time,
                            "source_time": None,
                            "config_revision": rev,
                            "origin": Origin.CALCULATED.value,
                            "data_epoch": data_epoch,
                            "source_sequence": None,
                            "reason_code": None,
                            "event_uid": calc_uid,
                            "expected_interval_ms": formula.get("expected_interval_ms"),
                            "nullable": False,
                        }
                    if self.shadow_pg:
                        calc_shadow_rows.append(
                            {
                                "observation_id": obs_id,
                                "site_id": site_id,
                                "resource_id": resource_id,
                                "signal_id": output_id,
                                "connection_id": None,
                                "event_uid": calc_uid,
                                "event_time": ev_time,
                                "received_time": rx_time,
                                "source_time": None,
                                "value_type": vtype,
                                "value": val,
                                "unit": formula.get("unit"),
                                "quality": qual,
                                "origin": Origin.CALCULATED.value,
                                "config_revision": rev,
                                "provenance": {"formula_id": str(fid), "formula_revision": rev},
                            }
                        )
                    if output_id in cat.formula_inputs and depth + 1 < MAX_FORMULA_DEPTH:
                        queue.append((output_id, ev_time, rx_time, data_epoch, calc_uid, depth + 1))

        if calc_td_records:
            _succ, _perm, aborted = await self._write_td_with_retry(
                tenant_id, calc_td_records, record_kind="RAW_OPERATIONAL"
            )
            if aborted:
                return [], {}, [], True

        return calc_td_records, calc_latest_rows, calc_shadow_rows, False

    async def _sweep_all_interval_gaps(self) -> None:
        if not isinstance(self.recording_evaluator, DefaultRecordingPolicyEvaluator):
            return
        if not hasattr(self.td, "write_batch"):
            return
        for tid, cat in list(self._catalogs.items()):
            if cat.lifecycle_state != "ACTIVE" or not cat.all_managed_targets:
                continue
            eval_lock = self._eval_locks.setdefault(tid, asyncio.Lock())
            if eval_lock.locked():
                continue
            async with eval_lock:
                interval_targets = [t for t in cat.all_managed_targets if t.mode.value == "INTERVAL" and not t.is_paused]
                if not interval_targets:
                    continue
                stopped = await self._hydrate_managed_states(tid, cat, interval_targets)
                if stopped:
                    return
                gaps = self.recording_evaluator.sweep_interval_gaps(
                    tid, targets=interval_targets, active_epoch=cat.active_epoch
                )
                if not gaps:
                    continue
                succ, perm, aborted = await self._write_managed_td_with_retry(tid, gaps)
                if aborted:
                    self.recording_evaluator.invalidate_tenant(tid)
                    return
                self.metrics.managed_writes += len(succ)
                self._sync_policy_metrics()
                for item_id, fail in perm.items():
                    await self._safe_quarantine(
                        tenant_id=tid,
                        edge_id=None,
                        event_uid=item_id[:256],
                        reason=f"INTERVAL_GAP_WRITE_REJECTED ({fail.code}): {fail.message}",
                        payload={"subtable": fail.subtable, "item_id": item_id},
                    )

    async def _heartbeat_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                td_ok = False
                try:
                    health = await self.td.health_probe()
                    td_ok = bool(health.reachable)
                except Exception:  # noqa: BLE001
                    td_ok = False
                broker_ok = bool(self._consumer is not None)
                rates = self.hist.tenant_rates_per_min()
                conn_rates = self.hist.connection_rates_per_min()
                slis = self.hist.snapshot()
                self._sync_policy_metrics()
                queues_json = {
                    "tenant_rates": rates,
                    "conn_rates": conn_rates,
                    "acked_total": self.metrics.acked_total,
                    "dlq_total": self.metrics.dlq_total,
                    "retried_total": self.metrics.retried_total,
                    "epoch_fenced_dropped": self.metrics.epoch_fenced_dropped,
                    "tdengine_writes": self.metrics.tdengine_writes,
                    "managed_writes": self.metrics.managed_writes,
                    "managed_checkpoints": self.metrics.managed_checkpoints,
                    "managed_gap_markers": self.metrics.managed_gap_markers,
                    "managed_write_errors": self.metrics.managed_write_errors,
                    "managed_skips_by_reason": dict(self.metrics.managed_skips_by_reason),
                    "tdengine_ok": td_ok,
                    **slis,
                }
                status = "HEALTHY" if td_ok else "DEGRADED"
                await self.pg.write_heartbeat(
                    instance_id=self.instance_id,
                    health=status,
                    queues_json=queues_json,
                    broker_ok=broker_ok,
                    diagnostic=self.metrics.last_error,
                )
                if td_ok and not self._stop_event.is_set():
                    await self._sweep_all_interval_gaps()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Ingestion heartbeat update failed: %s", exc)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

    def _on_pg_notify(self, _conn: Any, _pid: int, channel: str, payload: str) -> None:
        tid: UUID | None = None
        if payload:
            try:
                obj = json.loads(payload)
                if isinstance(obj, dict) and obj.get("tenant_id"):
                    tid = UUID(str(obj["tenant_id"]))
            except (ValueError, json.JSONDecodeError):
                tid = None
        is_epoch = channel == "factorix_epoch_changed"
        self.invalidate_tenant_cache(tid, epoch_changed=is_epoch)
        if is_epoch and tid is not None:
            self.recent_uids.clear_tenant(tid)

    async def _notify_loop(self) -> None:
        assert self._notify_dsn is not None
        backoff = 0.5
        while not self._stop_event.is_set():
            try:
                conn = await asyncpg.connect(self._notify_dsn, timeout=5.0)
                self._notify_conn = conn
                await conn.add_listener("factorix_config_changed", self._on_pg_notify)
                await conn.add_listener("factorix_epoch_changed", self._on_pg_notify)
                self.invalidate_tenant_cache(None)
                backoff = 0.5
                while not self._stop_event.is_set() and not conn.is_closed():
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        await conn.execute("SELECT 1")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Ingestion PG LISTEN/NOTIFY connection lost (%r); reconnecting", exc)
                if self._notify_conn is not None and not self._notify_conn.is_closed():
                    try:
                        await self._notify_conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                self._notify_conn = None
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(10.0, backoff * 2.0)


class _WorkerStoppingRetry(Exception):
    """Internal signal to abort retry loop cleanly on worker shutdown and NACK requeue."""


@dataclass(frozen=True, slots=True)
class ParityDiffReport:
    pg_count: int
    td_count: int
    missing_in_td: tuple[str, ...]
    extra_in_td: tuple[str, ...]
    mismatches: tuple[dict[str, Any], ...]

    @property
    def ok(self) -> bool:
        return not self.missing_in_td and not self.extra_in_td and not self.mismatches


async def compare_pg_vs_tdengine_observations(
    pg_pool: asyncpg.Pool,
    tdengine: TDEngineClient,
    tenant_id: UUID,
    signal_ids: Sequence[UUID],
    *,
    start: datetime,
    end: datetime,
    data_epoch: int | None = None,
) -> ParityDiffReport:
    """Compare PostgreSQL ``observations`` against TDengine Operational History over a window (S06 parity gate)."""
    if not signal_ids:
        return ParityDiffReport(0, 0, (), (), ())

    async with pg_pool.acquire() as conn:
        pg_rows = await conn.fetch(
            """
            SELECT signal_id, event_uid, event_time, received_time, source_time,
                   value_type, value_json, quality, origin, config_revision
            FROM observations
            WHERE tenant_id = $1 AND signal_id = ANY($2::uuid[])
              AND event_time >= $3 AND event_time <= $4
            ORDER BY signal_id, event_time, event_uid
            """,
            tenant_id,
            list(signal_ids),
            start,
            end,
        )
        sig_types = await conn.fetch(
            "SELECT id, data_type FROM signal_definitions WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            tenant_id,
            list(signal_ids),
        )

    type_by_signal = {UUID(str(r["id"])): str(r["data_type"]) for r in sig_types}
    db_name = tenant_database_name(tenant_id, prefix=tdengine.config.db_prefix)

    pg_by_uid: dict[str, dict[str, Any]] = {}
    for r in pg_rows:
        vj = _json_val(r["value_json"])
        val = vj.get("v") if isinstance(vj, dict) else None
        pg_by_uid[str(r["event_uid"])] = {
            "signal_id": UUID(str(r["signal_id"])),
            "event_uid": str(r["event_uid"]),
            "event_time": r["event_time"].astimezone(timezone.utc),
            "received_time": r["received_time"].astimezone(timezone.utc),
            "value_type": str(r["value_type"]),
            "value": val,
            "quality": str(r["quality"]),
            "origin": str(r["origin"]),
            "config_revision": int(r["config_revision"]),
        }

    td_by_uid: dict[str, dict[str, Any]] = {}
    for sig_id in signal_ids:
        vtype = type_by_signal.get(sig_id, "float64")
        stable = op_stable_for_type(vtype)
        subtable = op_subtable_name(sig_id, vtype)
        # Verify stable matches expectation
        _ = stable
        try:
            td_rows = await tdengine.query_range(db_name, subtable, start=start, end=end, limit=10_000)
        except TDEngineError:
            td_rows = []
        for tr in td_rows:
            if data_epoch is not None and int(tr.get("data_epoch") or 1) != data_epoch:
                continue
            uid = str(tr["event_uid"])
            td_val = tr["val"]
            if vtype == "json" and isinstance(td_val, str):
                td_val = _json_val(td_val)
            td_by_uid[uid] = {
                "signal_id": sig_id,
                "event_uid": uid,
                "ts": tr["ts"].astimezone(timezone.utc) if isinstance(tr["ts"], datetime) else tr["ts"],
                "acquired_at": tr["acquired_at"].astimezone(timezone.utc) if isinstance(tr["acquired_at"], datetime) else tr["acquired_at"],
                "value": td_val,
                "raw_quality": str(tr["raw_quality"]),
                "origin": str(tr["origin"]),
                "config_rev": int(tr["config_rev"]),
            }

    missing = tuple(sorted(uid for uid in pg_by_uid if uid not in td_by_uid))
    extra = tuple(sorted(uid for uid in td_by_uid if uid not in pg_by_uid))
    mismatches: list[dict[str, Any]] = []

    for uid in sorted(set(pg_by_uid) & set(td_by_uid)):
        pg_row = pg_by_uid[uid]
        td_row = td_by_uid[uid]
        # Tolerate up to 20us collision disambiguation shift on TDengine ts while checking acquired_at exactness
        ts_delta_us = abs((td_row["ts"] - pg_row["event_time"]).total_seconds() * 1_000_000.0)
        val_equal = _values_equal(pg_row["value"], td_row["value"], pg_row["value_type"])
        if (
            not val_equal
            or td_row["raw_quality"] != pg_row["quality"]
            or td_row["origin"] != pg_row["origin"]
            or td_row["config_rev"] != pg_row["config_revision"]
            or ts_delta_us > 50.0
        ):
            mismatches.append({"event_uid": uid, "pg": pg_row, "td": td_row, "ts_delta_us": ts_delta_us})

    return ParityDiffReport(
        pg_count=len(pg_by_uid),
        td_count=len(td_by_uid),
        missing_in_td=missing,
        extra_in_td=extra,
        mismatches=tuple(mismatches),
    )


def _values_equal(a: Any, b: Any, vtype: str) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if vtype == "float64":
        return math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-12)
    return a == b
