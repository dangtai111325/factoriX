"""ObservationPublisher: RabbitMQ direct fast path + bounded SQLite outage spool.

Builds schema_version=1 CanonicalObservation payloads with monotonic per-field
source_sequence, deterministic event_uid, redacted CanonicalProvenance, and
tenant active_epoch fencing. Publishes directly to RabbitMQ with confirms when
healthy; spills only confirm-failed observations into AcquisitionSpool on broker
outage or reject-publish backpressure, and replays newest-per-signal before history.
"""

from __future__ import annotations

import logging
import time
from collections import deque
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
from factorix.platform.broker import BrokerBackpressureError, BrokerError, BrokerUnavailableError
from factorix_acquisition.jobs import JobSpec
from factorix_acquisition.mapping import Sample, coerce, field_address
from factorix_acquisition.spool import AcquisitionSpool, SpoolRow
from factorix_acquisition.timeutil import iso_ms, now_iso

logger = logging.getLogger(__name__)

BATCH_ROWS = 500
HISTORY_SLICE_S = 0.25
FLUSH_BUDGET_S = 1.0
MAX_MEMORY_QUEUE = 50_000


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
        on_wake: Any = None,
        on_broker_restored: Any = None,
    ) -> None:
        self.broker = broker
        self.spool = spool
        self.max_attempts = max(1, int(max_attempts))
        self.max_pending = max(100, int(max_pending))
        self.max_spool_bytes = max(0, int(max_spool_bytes))
        self.max_memory_queue = max(100, int(max_memory_queue))
        self._on_wake = on_wake
        self._on_broker_restored = on_broker_restored

        self._fast_queue: deque[CanonicalObservation] = deque()
        self._inflight_flushes = 0
        self._seq: dict[tuple[str, str], int] = {}
        self._tenant_epochs: dict[str, int] = {}
        self._broker_gen = 0
        self._broker_down = broker is None
        self.storage_error: str | None = None
        self.broker_ok: bool = broker is not None
        self.published_fast = 0
        self.published_replay = 0
        self.spilled = 0

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

    def set_tenant_epochs(self, epochs: dict[str, int]) -> int:
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
        purged = self.spool.purge_old_epochs(self._tenant_epochs)
        return purged

    def active_epoch(self, tenant_id: str) -> int:
        return max(1, int(self._tenant_epochs.get(str(tenant_id), 1)))

    @property
    def fast_buffered(self) -> int:
        return len(self._fast_queue)

    def _next_sequence(self, connection_id: str, field_id: str) -> int:
        key = (connection_id, field_id)
        seq = self._seq.get(key, 0) + 1
        self._seq[key] = seq
        return seq

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
            tenant_str = str(spec.tenant_id or binding.get("tenant_id") or "")
            tenant_uuid = _required_uuid(tenant_str)
            epoch = self.active_epoch(str(tenant_uuid))
            signal_uuid = _required_uuid(binding["signal_id"])
            resource_uuid = _required_uuid(binding["resource_id"])
            field_uuid = _optional_uuid(sample.field_id)
            seq = self._next_sequence(spec.connection_id, sample.field_id)

            raw_type = normalize_value_type(str(binding.get("data_type") or "float64"))
            value, quality_str, coerce_reason = coerce(
                raw_type, sample.value, sample.quality, spec.coerce_address.get(sample.field_id)
            )
            reason = sample.reason or coerce_reason
            received_iso = sample.received_time or created_iso
            acquired_dt = _parse_iso_dt(received_iso)
            source_dt = _parse_iso_dt(sample.source_time) if sample.source_time else None

            event_uid = derive_event_uid(
                tenant_id=tenant_uuid,
                connection_id=conn_uuid,
                source_field_id=field_uuid,
                signal_id=signal_uuid,
                acquired_at=acquired_dt,
                sequence_or_key=seq,
                data_epoch=epoch,
            )
            extra_prov: dict[str, Any] = {}
            if reason:
                extra_prov["reason"] = reason
            if binding.get("key"):
                extra_prov["signal_key"] = str(binding["key"])

            address_meta = field_address({"address_json": spec.coerce_address.get(sample.field_id) or {}})
            provenance = CanonicalProvenance(
                protocol=spec.protocol,
                connection_id=conn_uuid,
                job_id=job_uuid,
                source_field_id=field_uuid,
                config_revision=eff_rev,
                address_kind=str(address_meta.get("register_area") or spec.protocol),
                address_summary=_address_summary(spec, sample.field_id),
                extra=extra_prov,
            )
            unit = binding.get("unit")
            try:
                obs = CanonicalObservation(
                    event_uid=event_uid,
                    tenant_id=tenant_uuid,
                    signal_id=signal_uuid,
                    resource_id=resource_uuid,
                    site_id=site_uuid,
                    connection_id=conn_uuid,
                    acquisition_job_id=job_uuid,
                    source_field_id=field_uuid,
                    acquired_at=acquired_dt,
                    source_time=source_dt,
                    value_type=raw_type,
                    value=value,
                    unit=str(unit)[:32] if unit is not None else None,
                    quality=Quality(quality_str),
                    quality_reason=reason,
                    origin=Origin.LIVE,
                    data_epoch=epoch,
                    config_revision=eff_rev,
                    provenance=provenance,
                    source_sequence=seq,
                )
            except ObservationError as exc:
                obs = CanonicalObservation(
                    event_uid=event_uid,
                    tenant_id=tenant_uuid,
                    signal_id=signal_uuid,
                    resource_id=resource_uuid,
                    site_id=site_uuid,
                    connection_id=conn_uuid,
                    acquisition_job_id=job_uuid,
                    source_field_id=field_uuid,
                    acquired_at=acquired_dt,
                    source_time=source_dt,
                    value_type=raw_type,
                    value=None,
                    unit=str(unit)[:32] if unit is not None else None,
                    quality=Quality.BAD,
                    quality_reason=exc.code,
                    origin=Origin.LIVE,
                    data_epoch=epoch,
                    config_revision=eff_rev,
                    provenance=provenance,
                    source_sequence=seq,
                )
            observations.append(obs)
        return observations

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

    def _spill(self, observations: list[CanonicalObservation]) -> int:
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
        try:
            written = self.spool.add_many(rows)
            self.storage_error = None
            self.spilled += written
            return written
        except Exception as exc:  # noqa: BLE001
            if self.storage_error is None:
                logger.error("Cannot spill observations to SQLite spool: %r", exc)
            self.storage_error = f"Spool write failed: {exc}"[:240]
            return 0

    def emit(self, spec: JobSpec, samples: list[Sample], *, revision: int = 1) -> int:
        observations = self.build_observations(spec, samples, revision=revision)
        if not observations:
            return 0
        if self._broker_down or len(self._fast_queue) >= self.max_memory_queue:
            count = self._spill(observations)
        else:
            self._fast_queue.extend(observations)
            count = len(observations)
        if self._on_wake is not None:
            self._on_wake()
        return count

    async def flush_once(self, budget_s: float = FLUSH_BUDGET_S) -> tuple[int, bool]:
        """Publish buffered fast-path observations and replay bounded spool slices.

        Returns ``(published_count, failed_or_broker_unavailable)``.
        """
        self._inflight_flushes += 1
        try:
            published = 0
            # 1. If recovering from broker outage, move any residual RAM fast-queue items into the
            # spool first so latest-per-signal ordering stays monotonic across disk + RAM.
            if self._broker_down and self._fast_queue:
                self._spill(list(self._fast_queue))
                self._fast_queue.clear()

            # 2. When healthy, drain fast-queue items directly to RabbitMQ without hitting SQLite.
            while self._fast_queue and not self._broker_down:
                batch: list[CanonicalObservation] = []
                while self._fast_queue and len(batch) < BATCH_ROWS:
                    obs = self._fast_queue.popleft()
                    if obs.data_epoch >= self.active_epoch(str(obs.tenant_id)):
                        batch.append(obs)
                if not batch:
                    continue
                ok_count, failed = await self._publish_or_spill(batch)
                published += ok_count
                if failed:
                    if self._fast_queue:
                        self._spill(list(self._fast_queue))
                        self._fast_queue.clear()
                    return published, True

            # 3. Replay outage spool if pending rows exist: latest-per-signal lane first, then history.
            if self.spool.pending_count() > 0:
                self.spool.purge_old_epochs(self._tenant_epochs)
                latest_rows = self.spool.latest_pending(BATCH_ROWS)
                if latest_rows:
                    count, ok = await self._replay_rows(latest_rows)
                    published += count
                    if not ok:
                        return published, True

                deadline = time.monotonic() + max(0.0, budget_s)
                while True:
                    rows = self.spool.pending(BATCH_ROWS)
                    if not rows:
                        break
                    count, ok = await self._replay_rows(rows)
                    published += count
                    if not ok:
                        return published, True
                    if len(rows) < BATCH_ROWS or time.monotonic() >= deadline:
                        break
            return published, False
        finally:
            self._inflight_flushes = max(0, self._inflight_flushes - 1)

    async def _publish_or_spill(self, batch: list[CanonicalObservation]) -> tuple[int, bool]:
        broker = self.broker
        gen = self._broker_gen
        if broker is None:
            self._spill(batch)
            self._broker_down = True
            self.broker_ok = False
            return 0, True
        confirmed, failed = await broker.publish_observations_partial(batch)
        self.published_fast += len(confirmed)
        same_gen = gen == self._broker_gen
        if not failed:
            if same_gen:
                self._broker_down = False
                self.broker_ok = True
            return len(confirmed), (not same_gen and self.broker is None)
        if same_gen:
            self._broker_down = True
            self.broker_ok = False
        self._spill([obs for obs, _err in failed])
        return len(confirmed), True

    async def _replay_rows(self, rows: list[Any]) -> tuple[int, bool]:
        broker = self.broker
        gen = self._broker_gen
        if broker is None:
            self._broker_down = True
            self.broker_ok = False
            return 0, False
        valid_obs: list[CanonicalObservation] = []
        corrupt_uids: list[str] = []
        stale_epochs: set[str] = set()
        for row in rows:
            uid = str(row["event_uid"])
            tid = str(row["tenant_id"])
            if int(row["data_epoch"]) < self.active_epoch(tid):
                stale_epochs.add(tid)
                continue
            try:
                obs = CanonicalObservation.from_json_bytes(row["payload"])
            except ObservationError:
                corrupt_uids.append(uid)
                continue
            if obs.data_epoch < self.active_epoch(str(obs.tenant_id)):
                stale_epochs.add(str(obs.tenant_id))
                continue
            valid_obs.append(obs)
        if corrupt_uids:
            self.spool.mark_state(corrupt_uids, "QUARANTINED")
        if stale_epochs:
            self.spool.purge_old_epochs(self._tenant_epochs)
        if not valid_obs:
            return 0, True

        confirmed, failed = await broker.publish_observations_partial(valid_obs)
        if confirmed:
            self.spool.mark_sent(confirmed)
            self.published_replay += len(confirmed)
        same_gen = gen == self._broker_gen
        if not failed:
            if same_gen:
                self._broker_down = False
                self.broker_ok = True
            return len(confirmed), (same_gen or self.broker is not None)

        if same_gen:
            self._broker_down = True
            self.broker_ok = False
        backpressure_uids = [obs.event_uid for obs, err in failed if isinstance(err, BrokerBackpressureError)]
        if backpressure_uids:
            self.spool.note_attempt(backpressure_uids, self.max_attempts)
        # BrokerUnavailableError items remain PENDING without counting against max_attempts
        return len(confirmed), False

    def has_pending(self) -> bool:
        return bool(self._fast_queue) or self._inflight_flushes > 0 or self.spool.pending_count() > 0

    async def drain_and_close(self, *, timeout_s: float = 5.0) -> None:
        """Flush buffered observations on shutdown; spill any unconfirmed items cleanly."""
        deadline = time.monotonic() + timeout_s
        while self._fast_queue and time.monotonic() < deadline and not self._broker_down:
            batch: list[CanonicalObservation] = []
            while self._fast_queue and len(batch) < BATCH_ROWS:
                obs = self._fast_queue.popleft()
                if obs.data_epoch >= self.active_epoch(str(obs.tenant_id)):
                    batch.append(obs)
            if not batch:
                break
            await self._publish_or_spill(batch)
        if self._fast_queue:
            self._spill(list(self._fast_queue))
            self._fast_queue.clear()
        self.spool.close()
