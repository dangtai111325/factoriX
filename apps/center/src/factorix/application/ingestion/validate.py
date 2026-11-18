"""Ingestion pipeline stage 'validate/bind': decode observations, validate, origin filter, bind to the tenant catalog. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from datetime import datetime
from uuid import UUID

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.observation import ObservationError, resolve_times
from factorix.domain.quality import Origin
from factorix.platform.broker import ConsumeOutcome

from factorix.application.ingestion.common import YIELD_EVERY_ITEMS, _WorkerStoppingRetry, _utcnow
from factorix.application.ingestion.envelope import _PendingEnvelope, _PreparedObs
from factorix.application.ingestion.catalog import TenantCatalog, _default_owned_check


class _ValidateStage:
    """IngestionWorker part: per-batch decode/validate/bind."""

    async def _process_batch(self, batch: list[_PendingEnvelope]) -> None:
        now = _utcnow()
        parsed_per_tenant: dict[UUID, list[tuple[_PendingEnvelope, _PreparedObs]]] = {}

        # 1. Envelope decode, validation, origin filter
        decoded_candidates: list[tuple[_PendingEnvelope, CanonicalObservation, datetime, datetime, datetime | None, str, str | None]] = []
        for index, env in enumerate(batch):
            if index and index % YIELD_EVERY_ITEMS == 0:
                # Cooperative yield: let the other lane / consumer callbacks run between chunks.
                await asyncio.sleep(0)
            try:
                if env.payload is not None:
                    obs = CanonicalObservation.from_dict(env.payload)
                    if env.batch_tenant is not None and obs.tenant_id != env.batch_tenant:
                        raise ObservationError("TENANT_MISMATCH", "Batch item tenant differs from its envelope tenant.")
                else:
                    obs = CanonicalObservation.from_json_bytes(env.raw_body)
            except (ObservationError, ValueError, TypeError, KeyError, AttributeError) as exc:
                tid = env.batch_tenant or self._header_tenant_uuid(env.headers)
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
        lifecycle_cache: dict[tuple[UUID, int], TenantCatalog] = {}
        for env, obs, ev_time, rx_time, src_time, norm_quality, reason_code in decoded_candidates:
            try:
                life_key = (obs.tenant_id, int(obs.data_epoch))
                cat = lifecycle_cache.get(life_key)  # type: ignore[assignment]
                if cat is None:
                    cat = await self._wait_for_active_lifecycle(obs.tenant_id, obs.data_epoch)
                    lifecycle_cache[life_key] = cat
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

            if obs.signal_id not in cat.bindings:
                try:
                    cat = await self._get_catalog(obs.tenant_id, need_signal=obs.signal_id)
                    lifecycle_cache[(obs.tenant_id, int(obs.data_epoch))] = cat
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
            prep = _PreparedObs(
                obs=obs,
                event_time=ev_time,
                received_time=rx_time,
                source_time=src_time,
                norm_quality=norm_quality,
                reason_code=reason_code,
                owned=owned,
                ingested_at=env.ingested_at,
                lane=env.lane,
            )
            parsed_per_tenant.setdefault(obs.tenant_id, []).append((env, prep))

        # 3. Per-tenant durable persistence: TDengine first, then formulas + PG latest_signal_state + ACK
        for tenant_id, tenant_items in parsed_per_tenant.items():
            await self._persist_tenant_batch(tenant_id, tenant_items)
