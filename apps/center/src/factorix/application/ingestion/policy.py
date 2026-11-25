"""Ingestion pipeline stage 'policy': recording-policy state hydration, metrics and interval-gap sweep. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from uuid import UUID

from factorix.modules.providers import LiveSignalRecord
from factorix.modules.recording_policy import DefaultRecordingPolicyEvaluator, ManagedBindingTarget
from factorix.platform.tdengine import TDEngineError

from factorix.application.ingestion.common import _WorkerStoppingRetry, logger
from factorix.application.ingestion.catalog import TenantCatalog


class _PolicyStage:
    """IngestionWorker part: recording-policy state and gap sweep."""

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
                    if exc.schema_missing:
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

    def _sync_policy_metrics(self) -> None:
        if isinstance(self.recording_evaluator, DefaultRecordingPolicyEvaluator):
            pm = self.recording_evaluator.metrics
            self.metrics.managed_checkpoints = pm.managed_checkpoints
            self.metrics.managed_gap_markers = pm.managed_gap_markers
            self.metrics.managed_skips_by_reason = dict(pm.managed_skipped_by_reason)

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
