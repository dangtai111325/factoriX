"""ObservationPublisher: RabbitMQ fast path with real backpressure + bounded SQLite outage spool.

Builds schema_version=1 CanonicalObservation payloads with monotonic per-field
source_sequence, deterministic event_uid, redacted CanonicalProvenance, and
tenant active_epoch fencing. The broker adapter packs them into v2 batch envelopes
and confirms them through a sliding window (``factorix.platform.broker``).

Flow-control contract (v6):

* ``emit`` admits observations into a bounded RAM queue. When the queue is full it
  **awaits** (bounded by ``admission_wait_s``) for the flusher to make room — real
  backpressure towards the jobs, not a spill to SQLite. If the queue is still full after
  the bounded wait, the samples are rejected and counted as an explicit acquisition gap
  (``gap_rejected``) and surfaced through ``storage_error`` (plan §4.1(6)).
* The SQLite spool is used only when the broker is genuinely unavailable (connect/confirm
  failure). Queue-full nacks (``reject-publish``) are backpressure: observations stay in
  RAM, publishing is paced, nothing is marked DEAD.
* Live data has priority: each flush drains RAM first; spool replay only uses the
  remaining budget, is rate-limited (``replay_max_obs_s``) and shrinks to a small slice
  while live data waits.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol
from uuid import UUID, uuid5, NAMESPACE_URL

from factorix.domain.canonical import (
    CanonicalObservation,
    CanonicalProvenance,
    _redact_url_userinfo,
    derive_event_uid,
    normalize_value_type,
)
from factorix.domain.observation import ObservationError
from factorix.domain.quality import Origin, Quality
from factorix.platform.broker import (
    BrokerBackpressureError,
    BrokerError,
    BrokerTimeoutError,
    tenant_live_routing_key,
    tenant_routing_key,
)
from factorix_acquisition.jobs import JobSpec
from factorix_acquisition.mapping import Sample, coerce, field_address
from factorix_acquisition.replay import ReplayController, ReplayLimits, ReplayPump
from factorix_acquisition.spool import AcquisitionSpool, SpoolRow
from factorix_acquisition.timeutil import iso_ms, now_iso

logger = logging.getLogger(__name__)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


DEFAULT_FRESHNESS_WINDOW_S = 12.0
# Observations handed to the broker per call. One call may become several envelopes
# (per tenant/lane, bounded by the broker's batch_max_obs/bytes) confirmed concurrently.
BATCH_ROWS = 500
# While RAM is backlogged a flush hands up to this many BATCH_ROWS to one broker call so
# several envelopes are in flight at once (sliding window) instead of one confirm RTT each.
PIPELINE_BATCHES = 4
CONTENDED_REPLAY_ROWS = BATCH_ROWS // 4
HISTORY_SLICE_S = 0.25
FLUSH_BUDGET_S = 1.0
MAX_MEMORY_QUEUE = 50_000
ADMISSION_WAIT_S = _env_float("FACTORIX_PUBLISH_ADMISSION_WAIT_S", 2.0)
REPLAY_MAX_OBS_S = _env_float("FACTORIX_REPLAY_MAX_OBS_S", 2000.0)
# A broker that is connected but has not confirmed anything for this long is treated as
# unavailable (spool); shorter confirm timeouts are "slow" and retried from RAM.
SLOW_TO_DOWN_S = _env_float("FACTORIX_PUBLISH_SLOW_TO_DOWN_S", 30.0)


def _background_replay_default() -> bool:
    if os.environ.get("FACTORIX_ENVIRONMENT") == "test":
        return False
    return os.environ.get("FACTORIX_REPLAY_BACKGROUND", "on").strip().lower() not in {"off", "0", "false", "no"}
EXPIRE_INTERVAL_S = 60.0
BACKPRESSURE_PAUSE_MIN_S = 0.05
BACKPRESSURE_PAUSE_MAX_S = 2.0
GAP_ALARM_HOLD_S = 60.0


class BrokerPublisherProtocol(Protocol):
    async def publish_observations_partial(
        self,
        observations: list[CanonicalObservation],
    ) -> tuple[list[str], list[tuple[CanonicalObservation, BrokerError]]]: ...


def _optional_uuid(raw: Any) -> UUID | None:
    if not raw:
        return None
    try:
        return UUID(str(raw))
    except (TypeError, ValueError):
        return None


def _required_uuid(raw: Any) -> UUID:
    try:
        return UUID(str(raw))
    except (TypeError, ValueError):
        return uuid5(NAMESPACE_URL, str(raw or "unknown"))


def _parse_iso_dt(raw: str | None) -> datetime:
    if not raw:
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(raw.replace("Z", "+00:00").replace("z", "+00:00")).astimezone(timezone.utc)


def _address_summary(spec: JobSpec, field_id: str) -> str:
    conn = spec.connection
    endpoint = str(conn.get("endpoint_redacted") or "")
    if not endpoint:
        cfg = spec.config
        if spec.protocol == "modbus_tcp":
            endpoint = f"modbus://{cfg.get('host', '')}:{cfg.get('port', 502)}"
        elif spec.protocol == "mqtt":
            endpoint = f"mqtt://{cfg.get('host', '')}:{cfg.get('port', 1883)}"
        elif spec.protocol == "opcua":
            endpoint = str(cfg.get("endpoint") or "")
        elif spec.protocol == "http":
            endpoint = str(cfg.get("base_url") or cfg.get("url") or "")
        elif spec.protocol == "websocket":
            endpoint = str(cfg.get("url") or "")
    addr = spec.coerce_address.get(field_id) or {}
    detail = ""
    if spec.protocol == "modbus_tcp":
        detail = f"u{addr.get('unit_id', spec.config.get('unit_id', 1))}:{addr.get('register_area', 'holding')}@{addr.get('offset', 0)}"
    elif spec.protocol == "opcua":
        detail = str(addr.get("node_id") or "")
    elif spec.protocol == "mqtt":
        detail = f"{addr.get('topic', '')} {addr.get('jsonpath', '')}".strip()
    elif spec.protocol in {"http", "websocket"}:
        detail = f"{addr.get('path', '')} {addr.get('jsonpath', '')}".strip()
    joined = f"{endpoint} [{detail}]".strip() if detail else endpoint
    return _redact_url_userinfo(joined)[:256]


@dataclass(slots=True)
class _FieldStatic:
    """Per (job, config fingerprint, field) constants computed once instead of per sample."""

    spec: JobSpec
    tenant_uuid: UUID
    signal_uuid: UUID
    resource_uuid: UUID
    field_uuid: UUID | None
    raw_type: str
    unit: str | None
    address_kind: str
    address_summary: str
    signal_key: str | None
    provenance: CanonicalProvenance


class ObservationPublisher:
    def __init__(
        self,
        broker: BrokerPublisherProtocol | None,
        spool: AcquisitionSpool,
        *,
        max_attempts: int = 10,
        max_pending: int = 1_000_000,
        max_spool_bytes: int = 512 * 1024 * 1024,
        max_memory_queue: int = MAX_MEMORY_QUEUE,
        freshness_window_s: float = DEFAULT_FRESHNESS_WINDOW_S,
        admission_wait_s: float = ADMISSION_WAIT_S,
        replay_max_obs_s: float = REPLAY_MAX_OBS_S,
        background_replay: bool | None = None,
        on_wake: Any = None,
        on_broker_restored: Any = None,
    ) -> None:
        self.broker = broker
        self.spool = spool
        # Kept for API compatibility: replay attempts are counted, but backpressure never DEADs a row.
        self.max_attempts = max(1, int(max_attempts))
        self.max_pending = max(100, int(max_pending))
        self.max_spool_bytes = max(0, int(max_spool_bytes))
        self.max_memory_queue = max(100, int(max_memory_queue))
        self.freshness_window_s = float(freshness_window_s)
        self.admission_wait_s = max(0.0, float(admission_wait_s))
        self.replay_max_obs_s = max(1.0, float(replay_max_obs_s))
        self._on_wake = on_wake
        self._on_broker_restored = on_broker_restored

        self._fast_queue: deque[CanonicalObservation] = deque()
        self._space_event = asyncio.Event()
        self._ram_event = asyncio.Event()
        self._inflight_flushes = 0
        self._seq: dict[tuple[str, str], int] = {}
        self._tenant_epochs: dict[str, int] = {}
        self._field_cache: dict[tuple[str, str, str], _FieldStatic] = {}
        self._broker_gen = 0
        self._broker_down = broker is None
        self._spool_error: str | None = None
        self.broker_ok: bool = broker is not None
        self.ingest_backpressure = False
        self._backpressure_pause_s = 0.0
        self._backpressure_until = 0.0
        self.broker_slow = False
        self._slow_since: float | None = None
        self.slow_events = 0
        self._next_expire_at = 0.0
        self.background_replay = _background_replay_default() if background_replay is None else bool(background_replay)
        self.replay = ReplayPump(
            self,
            ReplayController(
                ReplayLimits(
                    max_rate=self.replay_max_obs_s,
                    initial_rate=min(self.replay_max_obs_s, _env_float("FACTORIX_REPLAY_INITIAL_OBS_S", 500.0)),
                )
            ),
        )
        self.published_fast = 0
        self.published_replay = 0
        self.spilled = 0
        self.publish_failed = 0
        self.publish_failed_by_lane: Counter[str] = Counter()
        self.backpressure_events = 0
        self.admission_waits = 0
        self.admission_wait_seconds = 0.0
        self.gap_rejected = 0
        self.last_gap_at: float | None = None
        self._gap_by_protocol: Counter[str] = Counter()
        self._last_gap_log = 0.0
        self.last_publish_failure: str | None = None
        self._emitted_by_protocol: Counter[str] = Counter()
        self._stage_calls: Counter[str] = Counter()
        self._stage_seconds: Counter[str] = Counter()
        if broker is not None and hasattr(broker, "add_reconnect_listener"):
            broker.add_reconnect_listener(self._broker_reconnected)  # type: ignore[attr-defined]

    # ------------------------------------------------------------------ health surface

    @property
    def storage_error(self) -> str | None:
        """Spool failure, or an active acquisition-gap alarm (kept for ``GAP_ALARM_HOLD_S``)."""
        if self._spool_error is not None:
            return self._spool_error
        if self.last_gap_at is not None and time.monotonic() - self.last_gap_at <= GAP_ALARM_HOLD_S:
            return (
                f"Publisher backlog full: {self.gap_rejected} observation(s) rejected "
                "(acquisition gap); RabbitMQ/Center cannot keep up."
            )[:240]
        return None

    @storage_error.setter
    def storage_error(self, value: str | None) -> None:
        self._spool_error = value

    def _broker_reconnected(self) -> None:
        self._broker_gen += 1
        self._broker_down = False
        self.broker_ok = True
        if self._on_broker_restored is not None:
            self._on_broker_restored()
        elif self._on_wake is not None:
            self._on_wake()

    def set_broker(self, broker: BrokerPublisherProtocol | None) -> None:
        was_down = self._broker_down or not self.broker_ok
        self._broker_gen += 1
        self.broker = broker
        self.broker_ok = broker is not None
        self._broker_down = broker is None
        if broker is not None:
            if self._on_broker_restored is not None:
                self._on_broker_restored()
            elif self._on_wake is not None and (was_down or self.has_pending()):
                self._on_wake()

    async def set_tenant_epochs(self, epochs: dict[str, int]) -> int:
        changed = False
        cleaned: dict[str, int] = {}
        for k, v in epochs.items():
            val = max(1, int(v or 1))
            cleaned[str(k)] = val
            if val > self._tenant_epochs.get(str(k), 1):
                changed = True
        self._tenant_epochs = cleaned
        if not changed and not cleaned:
            return 0
        # Fence in-memory buffered observations belonging to old epochs
        if self._fast_queue:
            kept: deque[CanonicalObservation] = deque()
            for obs in self._fast_queue:
                if obs.data_epoch >= self.active_epoch(str(obs.tenant_id)):
                    kept.append(obs)
            self._fast_queue = kept
            self._space_event.set()
        return await asyncio.to_thread(self.spool.purge_old_epochs, cleaned)

    def active_epoch(self, tenant_id: str) -> int:
        return max(1, int(self._tenant_epochs.get(str(tenant_id), 1)))

    @property
    def fast_buffered(self) -> int:
        return len(self._fast_queue)

    def fast_head_age_s(self) -> float | None:
        """Age of the oldest live observation still waiting in RAM (None when empty)."""
        if not self._fast_queue:
            return None
        return max(0.0, (datetime.now(timezone.utc) - self._fast_queue[0].acquired_at).total_seconds())

    def publish_metrics(self) -> dict[str, Any]:
        head_age = self.fast_head_age_s()
        queue_age = round(head_age, 3) if head_age is not None else None
        metrics: dict[str, Any] = {
            "published_fast": self.published_fast,
            "published_replay": self.published_replay,
            "spilled": self.spilled,
            "overflow_dropped": self.spool.overflow_dropped_count,
            "spool_expired": getattr(self.spool, "expired_count", 0),
            "spool_full": self._spool_is_full(),
            "spool_occupied_bytes": self.spool.occupied_bytes() if hasattr(self.spool, "occupied_bytes") else None,
            "publish_failed": self.publish_failed,
            "publish_failed_by_lane": dict(self.publish_failed_by_lane),
            "last_publish_failure": self.last_publish_failure,
            "ingest_backpressure": self.ingest_backpressure,
            "broker_slow": self.broker_slow,
            "slow_events": self.slow_events,
            "replay": {**self.replay.controller.snapshot(), "background": self.background_replay},
            "backpressure_events": self.backpressure_events,
            "admission_waits": self.admission_waits,
            "admission_wait_s": round(self.admission_wait_seconds, 3),
            "gap_rejected": self.gap_rejected,
            "gap_rejected_by_protocol": dict(self._gap_by_protocol),
            "replay_max_obs_s": self.replay_max_obs_s,
            "fast_head_age_s": queue_age,
            "emitted_by_protocol": dict(self._emitted_by_protocol),
            "stage_calls": dict(self._stage_calls),
            "stage_seconds": {stage: round(seconds, 4) for stage, seconds in self._stage_seconds.items()},
        }
        broker = self.broker
        if broker is not None and hasattr(broker, "envelopes_published"):
            metrics["envelopes_published"] = int(getattr(broker, "envelopes_published", 0))
            metrics["envelope_observations"] = int(getattr(broker, "observations_published", 0))
        return metrics

    def _record_stage(self, stage: str, started: float) -> None:
        self._stage_calls[stage] += 1
        self._stage_seconds[stage] += time.monotonic() - started

    def _note_publish_failures(self, failed: list[tuple[CanonicalObservation, BrokerError]], *, lane: str = "live") -> None:
        if failed:
            self.publish_failed += len(failed)
            self.publish_failed_by_lane[lane] += len(failed)
            error = failed[-1][1]
            self.last_publish_failure = type(error.__cause__ or error).__name__

    def _next_sequence(self, connection_id: str, field_id: str) -> int:
        key = (connection_id, field_id)
        seq = self._seq.get(key, 0) + 1
        self._seq[key] = seq
        return seq

    # ------------------------------------------------------------------ canonicalisation

    def _field_static(self, spec: JobSpec, field_id: str, binding: dict[str, Any], eff_rev: int) -> _FieldStatic:
        key = (spec.job_id, spec.fingerprint, field_id)
        cached = self._field_cache.get(key)
        if cached is not None and cached.spec is spec and cached.provenance.config_revision == eff_rev:
            return cached
        if len(self._field_cache) > 100_000:
            self._field_cache.clear()
        tenant_str = str(spec.tenant_id or binding.get("tenant_id") or "")
        address_meta = field_address({"address_json": spec.coerce_address.get(field_id) or {}})
        field_uuid = _optional_uuid(field_id)
        address_kind = str(address_meta.get("register_area") or spec.protocol)
        address_summary = _address_summary(spec, field_id)
        signal_key = str(binding["key"]) if binding.get("key") else None
        unit = binding.get("unit")
        static = _FieldStatic(
            spec=spec,
            tenant_uuid=_required_uuid(tenant_str),
            signal_uuid=_required_uuid(binding["signal_id"]),
            resource_uuid=_required_uuid(binding["resource_id"]),
            field_uuid=field_uuid,
            raw_type=normalize_value_type(str(binding.get("data_type") or "float64")),
            unit=str(unit)[:32] if unit is not None else None,
            address_kind=address_kind,
            address_summary=address_summary,
            signal_key=signal_key,
            provenance=CanonicalProvenance(
                protocol=spec.protocol,
                connection_id=_optional_uuid(spec.connection_id),
                job_id=_optional_uuid(spec.job_id),
                source_field_id=field_uuid,
                config_revision=eff_rev,
                address_kind=address_kind,
                address_summary=address_summary,
                extra={"signal_key": signal_key} if signal_key else {},
            ),
        )
        self._field_cache[key] = static
        return static

    def build_observations(self, spec: JobSpec, samples: list[Sample], *, revision: int = 1) -> list[CanonicalObservation]:
        created_iso = now_iso()
        observations: list[CanonicalObservation] = []
        eff_rev = max(1, int(spec.config_revision or revision or 1))
        conn_uuid = _optional_uuid(spec.connection_id)
        job_uuid = _optional_uuid(spec.job_id)
        site_uuid = _optional_uuid(spec.site_id)

        for sample in samples:
            binding = spec.bindings.get(sample.field_id)
            if not binding:
                continue
            static = self._field_static(spec, sample.field_id, binding, eff_rev)
            epoch = self.active_epoch(str(static.tenant_uuid))
            seq = self._next_sequence(spec.connection_id, sample.field_id)

            value, quality_str, coerce_reason = coerce(
                static.raw_type, sample.value, sample.quality, spec.coerce_address.get(sample.field_id)
            )
            reason = sample.reason or coerce_reason
            received_iso = sample.received_time or created_iso
            acquired_dt = _parse_iso_dt(received_iso)
            source_dt = _parse_iso_dt(sample.source_time) if sample.source_time else None

            event_uid = derive_event_uid(
                tenant_id=static.tenant_uuid,
                connection_id=conn_uuid,
                source_field_id=static.field_uuid,
                signal_id=static.signal_uuid,
                acquired_at=acquired_dt,
                sequence_or_key=seq,
                data_epoch=epoch,
            )
            provenance = static.provenance
            if reason:
                extra_prov: dict[str, Any] = {"reason": reason}
                if static.signal_key:
                    extra_prov["signal_key"] = static.signal_key
                provenance = CanonicalProvenance(
                    protocol=spec.protocol,
                    connection_id=conn_uuid,
                    job_id=job_uuid,
                    source_field_id=static.field_uuid,
                    config_revision=eff_rev,
                    address_kind=static.address_kind,
                    address_summary=static.address_summary,
                    extra=extra_prov,
                )
            common = {
                "event_uid": event_uid,
                "tenant_id": static.tenant_uuid,
                "signal_id": static.signal_uuid,
                "resource_id": static.resource_uuid,
                "site_id": site_uuid,
                "connection_id": conn_uuid,
                "acquisition_job_id": job_uuid,
                "source_field_id": static.field_uuid,
                "acquired_at": acquired_dt,
                "source_time": source_dt,
                "value_type": static.raw_type,
                "unit": static.unit,
                "origin": Origin.LIVE,
                "data_epoch": epoch,
                "config_revision": eff_rev,
                "provenance": provenance,
                "source_sequence": seq,
            }
            try:
                obs = CanonicalObservation(value=value, quality=Quality(quality_str), quality_reason=reason, **common)
            except ObservationError as exc:
                obs = CanonicalObservation(value=None, quality=Quality.BAD, quality_reason=exc.code, **common)
            observations.append(obs)
        return observations

    # ------------------------------------------------------------------ spool

    def _to_spool_row(self, obs: CanonicalObservation, created_iso: str) -> SpoolRow:
        return (
            obs.event_uid,
            str(obs.tenant_id),
            int(obs.data_epoch),
            iso_ms(obs.acquired_at),
            obs.to_json_bytes(),
            int(obs.config_revision),
            created_iso,
            str(obs.signal_id),
        )

    def _spool_is_full(self) -> bool:
        is_full = getattr(self.spool, "is_full", None)
        return bool(is_full(self.max_pending, self.max_spool_bytes)) if is_full is not None else False

    async def _spill(self, observations: list[CanonicalObservation]) -> int | None:
        """Write unconfirmed observations to the outage spool. ``None`` = not stored (full or I/O error)."""
        if not observations:
            return 0
        created = now_iso()
        rows = [
            self._to_spool_row(obs, created)
            for obs in observations
            if obs.data_epoch >= self.active_epoch(str(obs.tenant_id))
        ]
        if not rows:
            return 0
        if self._spool_is_full():
            self._spool_error = (
                f"Outage spool full ({self.spool.pending_count()} pending, budget {self.max_pending} rows / "
                f"{self.max_spool_bytes // (1024 * 1024)} MiB); new observations are not spooled."
            )[:240]
            return None

        async def write_rows() -> int | None:
            try:
                written = await asyncio.to_thread(self.spool.add_many, rows)
            except Exception as exc:  # noqa: BLE001
                if self._spool_error is None:
                    logger.error("Cannot spill observations to SQLite spool: %r", exc)
                self._spool_error = f"Spool write failed: {exc}"[:240]
                return None
            self._spool_error = None
            self.spilled += written
            if written:
                self.replay.wake()
            return written

        # Keep the write alive if a job stops while waiting for SQLite.
        write = asyncio.create_task(write_rows())
        try:
            return await asyncio.shield(write)
        except asyncio.CancelledError:
            await write
            raise

    def _reject_gap(self, observations: list[CanonicalObservation], protocol: str, why: str) -> None:
        """Explicitly reject samples that cannot be buffered anywhere (counted acquisition gap)."""
        if not observations:
            return
        self.gap_rejected += len(observations)
        self._gap_by_protocol[protocol] += len(observations)
        self.last_gap_at = time.monotonic()
        if self.last_gap_at - self._last_gap_log >= 10.0:
            self._last_gap_log = self.last_gap_at
            logger.error(
                "ACQUISITION GAP: rejected %d %s observation(s) (%s); total rejected %d",
                len(observations),
                protocol,
                why,
                self.gap_rejected,
            )

    def _admit_to_ram(self, observations: list[CanonicalObservation], protocol: str, why: str) -> int:
        room = self.max_memory_queue - len(self._fast_queue)
        if room >= len(observations):
            self._fast_queue.extend(observations)
            return len(observations)
        accepted = observations[: max(0, room)]
        self._fast_queue.extend(accepted)
        self._reject_gap(observations[len(accepted):], protocol, why)
        return len(accepted)

    async def _wait_for_ram_space(self) -> None:
        """Backpressure: block the emitting job (bounded) until the flusher drains the RAM queue."""
        if self.admission_wait_s <= 0:
            return
        started = time.monotonic()
        deadline = started + self.admission_wait_s
        self.admission_waits += 1
        try:
            while len(self._fast_queue) >= self.max_memory_queue and not self._broker_down:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self._space_event.clear()
                if self._on_wake is not None:
                    self._on_wake()
                try:
                    await asyncio.wait_for(self._space_event.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    return
        finally:
            self.admission_wait_seconds += time.monotonic() - started

    async def emit(self, spec: JobSpec, samples: list[Sample], *, revision: int = 1) -> int:
        started = time.monotonic()
        observations = self.build_observations(spec, samples, revision=revision)
        self._record_stage("canonicalize", started)
        self._emitted_by_protocol[spec.protocol] += len(observations)
        if not observations:
            return 0
        if not self._broker_down and len(self._fast_queue) >= self.max_memory_queue:
            await self._wait_for_ram_space()
        if self._broker_down:
            written = await self._spill(observations)
            count = written if written is not None else self._admit_to_ram(observations, spec.protocol, "broker down and spool unavailable")
        else:
            count = self._admit_to_ram(observations, spec.protocol, "publisher RAM queue full after bounded wait")
        self._ram_event.set()
        if self._on_wake is not None:
            self._on_wake()
        return count

    async def _spill_buffered(self) -> None:
        if not self._fast_queue:
            return
        buffered = list(self._fast_queue)
        self._fast_queue.clear()
        self._space_event.set()
        await self._spill_or_restore(buffered)

    async def _spill_or_restore(self, observations: list[CanonicalObservation]) -> None:
        if await self._spill(observations) is None:
            self._fast_queue.extendleft(reversed(observations))

    def _pop_fast_batch(self, max_items: int) -> list[CanonicalObservation]:
        batch: list[CanonicalObservation] = []
        now = datetime.now(timezone.utc).timestamp()
        cutoff = now - self.freshness_window_s
        if (
            max_items > 1
            and len(self._fast_queue) > max_items
            and self._fast_queue[0].acquired_at.timestamp() < cutoff
        ):
            # During a RAM backlog, observations near the tail have the best
            # chance of reaching the live lane. Keep a share of each batch
            # for the head so older observations still leave in FIFO order.
            live_quota = max(1, max_items * 3 // 4)
            deferred: list[CanonicalObservation] = []
            for _ in range(max_items):
                obs = self._fast_queue.pop()
                if obs.data_epoch < self.active_epoch(str(obs.tenant_id)):
                    continue
                if not cutoff <= obs.acquired_at.timestamp() <= now:
                    deferred.append(obs)
                    continue
                batch.append(obs)
                if len(batch) == live_quota:
                    break
            self._fast_queue.extend(reversed(deferred))
            batch.reverse()
        while self._fast_queue and len(batch) < max_items:
            obs = self._fast_queue.popleft()
            if obs.data_epoch >= self.active_epoch(str(obs.tenant_id)):
                batch.append(obs)
        if batch:
            self._space_event.set()
        return batch

    def route_for_observation(self, obs: CanonicalObservation) -> str:
        """Route to live lane if within freshness window, else legacy lane."""
        now = datetime.now(timezone.utc)
        acq_at = obs.acquired_at if obs.acquired_at.tzinfo else obs.acquired_at.replace(tzinfo=timezone.utc)
        age_s = (now - acq_at).total_seconds()
        if 0.0 <= age_s <= self.freshness_window_s:
            return tenant_live_routing_key(obs.tenant_id)
        return tenant_routing_key(obs.tenant_id)

    async def publish_observation(self, obs: CanonicalObservation) -> tuple[bool, str]:
        """Route and publish a single observation, returning (success, routing_key)."""
        rkey = self.route_for_observation(obs)
        if self.broker is None or self._broker_down:
            await self._spill([obs])
            return False, rkey
        try:
            if hasattr(self.broker, "publish_observation"):
                await self.broker.publish_observation(obs, routing_key=rkey)
                self.published_fast += 1
                return True, rkey
            confirmed, failed = await self.broker.publish_observations_partial([obs])
            if confirmed:
                self.published_fast += 1
                return True, rkey
            await self._spill([obs])
            return False, rkey
        except Exception:
            await self._spill([obs])
            return False, rkey

    # ------------------------------------------------------------------ flushing

    def _fast_batch_rows(self) -> int:
        if len(self._fast_queue) > BATCH_ROWS:
            return BATCH_ROWS * PIPELINE_BATCHES
        return BATCH_ROWS

    def _note_backpressure(self) -> None:
        self.ingest_backpressure = True
        self.backpressure_events += 1
        self._backpressure_pause_s = min(
            BACKPRESSURE_PAUSE_MAX_S, max(BACKPRESSURE_PAUSE_MIN_S, self._backpressure_pause_s * 2)
        )
        self._backpressure_until = time.monotonic() + self._backpressure_pause_s

    def _clear_backpressure(self) -> None:
        self.ingest_backpressure = False
        self._backpressure_pause_s = 0.0

    async def _maybe_expire(self) -> None:
        now = time.monotonic()
        if now < self._next_expire_at:
            return
        self._next_expire_at = now + EXPIRE_INTERVAL_S
        await asyncio.to_thread(self.spool.expire_stale)

    async def flush_once(self, budget_s: float = FLUSH_BUDGET_S) -> tuple[int, bool]:
        """Publish buffered live observations (the live lane).

        Spool replay is a separate lane (:mod:`factorix_acquisition.replay`): in background mode
        it runs in its own task and never delays this method; in inline mode (unit tests, or
        ``FACTORIX_REPLAY_BACKGROUND=off``) one controller-limited replay step follows the live
        lane. Returns ``(published_count, failed_or_broker_unavailable)``.
        """
        flush_started = time.monotonic()
        self._inflight_flushes += 1
        try:
            published = 0
            # Paced retry while the broker reports queue-full backpressure or slow confirms.
            pause = self._backpressure_until - time.monotonic()
            if pause > 0:
                await asyncio.sleep(min(pause, max(budget_s, BACKPRESSURE_PAUSE_MIN_S)))
            # If recovering from broker outage, move any residual RAM fast-queue items into the
            # spool first so latest-per-signal ordering stays monotonic across disk + RAM.
            if self._broker_down:
                await self._spill_buffered()
            if self.spool.pending_count() > 0:
                if self.background_replay:
                    self.replay.start()
                    self.replay.wake()
                else:
                    await self._maybe_expire()

            if not self._fast_queue and self.spool.pending_count() <= 0:
                return 0, False

            deadline = time.monotonic() + max(0.0, budget_s)
            while True:
                progressed = False
                # 1. Live lane: everything buffered in RAM goes first. While the broker is
                # marked down (RAM could not be spooled) one batch per flush probes recovery.
                ram_allowed = True
                while self._fast_queue and ram_allowed:
                    if self._broker_down:
                        ram_allowed = False
                    batch = self._pop_fast_batch(self._fast_batch_rows())
                    if not batch:
                        break
                    ok_count, failed = await self._publish_or_spill(batch)
                    published += ok_count
                    progressed = True
                    if failed:
                        if self._broker_down:
                            await self._spill_buffered()
                        return published, True
                    if time.monotonic() >= deadline:
                        break

                # 2. Inline replay step (only when replay has no task of its own).
                if not self.background_replay and self.spool.pending_count() > 0:
                    wanted = CONTENDED_REPLAY_ROWS if self._fast_queue else BATCH_ROWS
                    count, ok, attempted = await self.replay.replay_once(wanted)
                    published += count
                    progressed = progressed or attempted
                    if not ok:
                        return published, True

                if not progressed:
                    if self.spool.pending_count() > 0 and not self._fast_queue and not self._broker_down:
                        # Nothing live to send and replay is paced/elsewhere: wait for live data
                        # (bounded) so the runtime's flush loop does not spin on has_pending().
                        wait_s = max(budget_s, 0.01)
                        if not self.background_replay:
                            wait_s = min(wait_s, self.replay.controller.seconds_until(CONTENDED_REPLAY_ROWS))
                        await self._wait_for_live(wait_s)
                    break
                if time.monotonic() >= deadline:
                    break
                if not self._fast_queue and (self.background_replay or self.spool.pending_count() <= 0):
                    break
            return published, False
        finally:
            self._inflight_flushes = max(0, self._inflight_flushes - 1)
            self._record_stage("flush", flush_started)

    async def _wait_for_live(self, max_wait_s: float) -> None:
        if max_wait_s <= 0:
            return
        self._ram_event.clear()
        try:
            await asyncio.wait_for(self._ram_event.wait(), timeout=max_wait_s)
        except asyncio.TimeoutError:
            pass

    async def _publish_or_spill(self, batch: list[CanonicalObservation]) -> tuple[int, bool]:
        """Publish one live batch; classify failures as backpressure / slow / unavailable.

        * backpressure (queue full) and slow (confirm timeout on an open connection): the
          observations go back to the front of the RAM queue and publishing is paced; this is
          not an outage and never feeds the spool (no spill → replay feedback loop);
        * slow for longer than ``SLOW_TO_DOWN_S``, or a connection/channel failure: the broker
          is unavailable → unconfirmed observations go to the outage spool.
        """
        broker = self.broker
        gen = self._broker_gen
        if broker is None:
            await self._spill_or_restore(batch)
            self._broker_down = True
            self.broker_ok = False
            return 0, True
        publish_started = time.monotonic()
        try:
            confirmed, failed = await broker.publish_observations_partial(batch)
        except asyncio.CancelledError:
            await self._spill_or_restore(batch)
            raise
        self._record_stage("fast_publish", publish_started)
        self.replay.controller.note_live_publish(time.monotonic() - publish_started)
        self._note_publish_failures(failed, lane="live")
        self.published_fast += len(confirmed)
        same_gen = gen == self._broker_gen
        if not failed:
            if same_gen:
                self._broker_down = False
                self.broker_ok = True
                self._clear_backpressure()
                self._clear_slow()
            return len(confirmed), (not same_gen and self.broker is None)

        self.replay.controller.note_live_failure(type(failed[-1][1]).__name__)
        backpressured = [obs for obs, err in failed if isinstance(err, BrokerBackpressureError)]
        slow = [obs for obs, err in failed if isinstance(err, BrokerTimeoutError)]
        unavailable = [obs for obs, err in failed if not isinstance(err, (BrokerBackpressureError, BrokerTimeoutError))]
        if slow and self._note_slow():
            # Silent for too long while "connected": treat as unavailable from now on.
            unavailable.extend(slow)
            slow = []
        retry_in_ram = backpressured + slow
        if backpressured:
            # Queue full = Center is behind, not an outage: keep the data in RAM and pace.
            self._note_backpressure()
        if retry_in_ram:
            order = {id(obs): i for i, obs in enumerate(batch)}
            retry_in_ram.sort(key=lambda o: order.get(id(o), 0))
            self._fast_queue.extendleft(reversed(retry_in_ram))
        if unavailable:
            if same_gen:
                # Confirmed deliveries show the broker accepted work. Keep the
                # unattempted RAM queue available for the next live flush.
                self.broker_ok = bool(confirmed)
                self._broker_down = not self.broker_ok
            await self._spill_or_restore(unavailable)
        return len(confirmed), True

    def _note_slow(self) -> bool:
        """Record a confirm timeout; True once the broker has been slow for ``SLOW_TO_DOWN_S``."""
        now = time.monotonic()
        if self._slow_since is None:
            self._slow_since = now
        self.broker_slow = True
        self.slow_events += 1
        self._backpressure_pause_s = min(
            BACKPRESSURE_PAUSE_MAX_S, max(BACKPRESSURE_PAUSE_MIN_S, self._backpressure_pause_s * 2)
        )
        self._backpressure_until = now + self._backpressure_pause_s
        return now - self._slow_since >= SLOW_TO_DOWN_S

    def _clear_slow(self) -> None:
        self.broker_slow = False
        self._slow_since = None

    async def _replay_rows(self, rows: list[Any]) -> tuple[int, bool]:
        """Compatibility shim: replay one list of spool rows (see :class:`ReplayPump`)."""
        return await self.replay.replay_rows(rows)

    def has_pending(self) -> bool:
        return bool(self._fast_queue) or self._inflight_flushes > 0 or self.spool.pending_count() > 0

    async def drain_and_close(self, *, timeout_s: float = 5.0) -> None:
        """Flush buffered observations on shutdown; spill any unconfirmed items cleanly."""
        await self.replay.stop()
        deadline = time.monotonic() + timeout_s
        while self._fast_queue and time.monotonic() < deadline and not self._broker_down:
            batch = self._pop_fast_batch(self._fast_batch_rows())
            if not batch:
                break
            await self._publish_or_spill(batch)
        await self._spill_buffered()
        await asyncio.to_thread(self.spool.close)
