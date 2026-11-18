"""Ingestion pipeline stage 'dedup/epoch': per-tenant persist (epoch fence, dedup, then TD write, policy, latest-state, ACK). Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from datetime import datetime
import time
from typing import Any
from uuid import UUID, uuid4

from factorix.domain.canonical import CanonicalObservation, intern_uuid, measure_latency_slis
from factorix.modules.providers import LiveSignalRecord, RecordingDecision
from factorix.modules.recording_policy import (
    DefaultRecordingPolicyEvaluator,
    ManagedBindingTarget,
    ManagedSubtableWrite,
)
from factorix.application.live.latest_api import latest_stream_payload
from factorix.platform.broker import ConsumeOutcome

from factorix.application.ingestion.common import _WorkerStoppingRetry, _utcnow
from factorix.application.ingestion.envelope import _PendingEnvelope, _PreparedObs


class _PersistStage:
    """IngestionWorker part: per-tenant persist."""

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

        raw_write_started_at = time.monotonic()
        succeeded_uids, perm_failures, stopping_aborted = await self._write_td_with_retry(
            tenant_id, td_records, record_kind="RAW_OPERATIONAL"
        )
        if td_records:
            self.hist.record_batch_stage("tdengine_operational_write", raw_write_started_at)
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

        committed_items.sort(
            key=lambda pair: (
                pair[1].obs.data_epoch,
                pair[1].received_time,
                pair[1].obs.source_sequence if pair[1].obs.source_sequence is not None else -1,
                pair[1].obs.event_uid,
            )
        )

        # Build newest candidate per signal for PG latest_signal_state + stream notification
        newest_map: dict[UUID, dict[str, Any]] = {}
        connection_sample_times: dict[UUID, datetime] = {}
        shadow_rows: list[dict[str, Any]] = []
        formula_triggers: list[_PreparedObs] = []

        # committed_items is sorted ascending by the ordering key (event_uids are unique after
        # dedup), so the last item per signal is its newest candidate. Build each latest row once
        # per signal instead of once per observation.
        newest_prep: dict[UUID, _PreparedObs] = {}
        shadow_obs_ids: dict[str, UUID] = {}
        for _env, prep in committed_items:
            obs = prep.obs
            newest_prep[obs.signal_id] = prep
            if self.update_connection_liveness and prep.norm_quality in {"GOOD", "UNCERTAIN"}:
                connection_id = intern_uuid(prep.owned["connection_id"])
                previous_sample = connection_sample_times.get(connection_id)
                if previous_sample is None or prep.received_time > previous_sample:
                    connection_sample_times[connection_id] = prep.received_time
            if self.shadow_pg:
                obs_id = shadow_obs_ids[obs.event_uid] = uuid4()
                provenance = obs.provenance.to_dict() if obs.provenance else {}
                if prep.reason_code:
                    provenance["reason"] = prep.reason_code
                shadow_rows.append(
                    {
                        "observation_id": obs_id,
                        "site_id": intern_uuid(prep.owned["site_id"]) if prep.owned.get("site_id") else obs.site_id,
                        "resource_id": intern_uuid(prep.owned["resource_id"]),
                        "signal_id": obs.signal_id,
                        "connection_id": intern_uuid(prep.owned["connection_id"]),
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
                        "provenance": provenance,
                    }
                )
            if obs.signal_id in cat.formula_inputs:
                formula_triggers.append(prep)

        for sig_id, prep in newest_prep.items():
            obs = prep.obs
            newest_map[sig_id] = {
                "_sort_key": (
                    obs.data_epoch,
                    prep.received_time,
                    obs.source_sequence if obs.source_sequence is not None else -1,
                    obs.event_uid,
                ),
                "signal_id": sig_id,
                "resource_id": intern_uuid(prep.owned["resource_id"]),
                "observation_id": shadow_obs_ids.get(obs.event_uid) or uuid4(),
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
                "ingested_at": prep.ingested_at,
            }

        # Evaluate synchronous published formulas (depth <= 4) & write calculated outputs to TDengine before PG commit
        calc_td: list[dict[str, Any]] = []
        if formula_triggers:
            formula_started_at = time.monotonic()
            calc_td, calc_latest, calc_shadow, calc_stopped = await self._evaluate_formulas(
                tenant_id, cat, formula_triggers, newest_map
            )
            self.hist.record_batch_stage("formula_evaluation_and_write", formula_started_at)
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
                managed_started_at = time.monotonic()
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
                self.hist.record_batch_stage("managed_evaluation_and_write", managed_started_at)

        now_commit = _utcnow()
        latest_list = []
        t_cache_preview = self._live_cache.get(tenant_id, {})
        stream_events = []
        compact_notify = getattr(self.pg, "notify_format", "v1") == "v2"
        for r in newest_map.values():
            prev_rec_preview = t_cache_preview.get(r["signal_id"])
            # The raw and managed history writes have already run. A strictly
            # older candidate cannot pass PostgreSQL's latest-state guard.
            if (
                prev_rec_preview is not None
                and prev_rec_preview.received_time is not None
                and (r["data_epoch"], r["received_time"]) < (prev_rec_preview.data_epoch, prev_rec_preview.received_time)
            ):
                continue
            latest_list.append(r)
            if compact_notify:
                # v2 NOTIFY carries ids only; skip building the full stream payload.
                stream_events.append({"kind": "latest", "signal_id": str(r["signal_id"])})
                continue
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

        metadata_started_at = time.monotonic()
        try:
            replaced_signals, _health_events = await self._retry_pg_op(
                lambda: self.pg.commit_batch_metadata(
                    tenant_id=tenant_id,
                    latest_rows=latest_list,
                    connection_sample_times=connection_sample_times,
                    stream_events=stream_events,
                    shadow_pg_rows=shadow_rows,
                    now=now_commit,
                    connection_ids_for_notify={p.owned.get("connection_id") for _e, p in committed_items},
                )
            )
        except _WorkerStoppingRetry:
            for env, _prep in committed_items:
                if not env.future.done():
                    env.future.set_result(ConsumeOutcome.RETRY)
                    self.metrics.retried_total += 1
            return
        self.hist.record_batch_stage("postgres_metadata_commit", metadata_started_at)

        t_cache = self._live_cache.setdefault(tenant_id, {})
        for sig_id, row in newest_map.items():
            if sig_id not in replaced_signals and sig_id in t_cache:
                continue
            prev_rec = t_cache.get(sig_id)
            # The live and replay lanes commit concurrently: never let a slower, older commit
            # overwrite a newer cached state (PG's upsert guard enforces the same order).
            if (
                prev_rec is not None
                and prev_rec.received_time is not None
                and (int(row["data_epoch"]), row["received_time"]) < (prev_rec.data_epoch, prev_rec.received_time)
            ):
                continue
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
                received_time=row["received_time"],
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
        # The provider keeps only the newest state per signal, so feeding the newest committed
        # observation of each signal gives the same final state at a fraction of the cost.
        newest_for_live: dict[UUID, _PreparedObs] = {}
        for _env, prep in ordered_for_live:
            newest_for_live[prep.obs.signal_id] = prep
        for prep in newest_for_live.values():
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
            conn_uuid = conn_raw if isinstance(conn_raw, UUID) else (intern_uuid(conn_raw) if conn_raw else None)
            self.hist.record(tenant_id, sli, connection_id=conn_uuid, lane=prep.lane)
            self.metrics.acked_total += 1
            if not env.future.done():
                env.future.set_result(ConsumeOutcome.ACK)
        self.metrics.batches_committed += 1
        self.metrics.last_commit_at = committed_at
