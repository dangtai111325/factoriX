"""Ingestion pipeline stage 'lanes/batcher': live and replay lanes, micro-batching, poison isolation, PG retry. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
import time
from typing import Any
from uuid import UUID

from factorix.platform.broker import ConsumeOutcome

from factorix.application.ingestion.common import (
    LANE_LEGACY,
    LANE_LIVE,
    REPLAY_YIELD_MAX_S,
    _WorkerStoppingRetry,
    logger,
)
from factorix.application.ingestion.envelope import _PendingEnvelope
from factorix.application.ingestion.catalog import TenantCatalog


class _LaneStage:
    """IngestionWorker part: lanes, batcher and retry helpers."""

    def _lane_queue(self, lane: str) -> deque[_PendingEnvelope]:
        return self._pending_live if lane == LANE_LIVE else self._pending_legacy

    def _take_lane_batch(self, lane: str) -> list[_PendingEnvelope]:
        queue = self._lane_queue(lane)
        limit = self.batch_size if lane == LANE_LIVE else min(self.batch_size, self.replay_batch_size)
        count = min(len(queue), limit)
        return [queue.popleft() for _ in range(count)]

    async def _batcher_loop(self) -> None:
        """Run both lane batchers until stopped (live and legacy/replay are independent tasks)."""
        await asyncio.gather(self._lane_loop(LANE_LIVE), self._lane_loop(LANE_LEGACY))

    async def _yield_to_live(self) -> None:
        deadline = time.monotonic() + REPLAY_YIELD_MAX_S
        while (self._pending_live or self._lane_busy[LANE_LIVE]) and not self._stop_event.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            self._live_idle.clear()
            try:
                await asyncio.wait_for(self._live_idle.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                return

    async def _lane_loop(self, lane: str) -> None:
        queue = self._lane_queue(lane)
        wake = self._wake_live if lane == LANE_LIVE else self._wake_legacy
        while not self._stop_event.is_set() or queue:
            try:
                await asyncio.wait_for(wake.wait(), timeout=self.flush_interval_s)
            except asyncio.TimeoutError:
                pass
            wake.clear()
            if lane == LANE_LEGACY and queue:
                await self._yield_to_live()

            async with self._pending_lock:
                batch = self._take_lane_batch(lane)
                if queue:
                    wake.set()
            if not batch:
                if lane == LANE_LIVE:
                    self._live_idle.set()
                continue
            batch_started_at = time.monotonic()
            self._lane_busy[lane] = True
            self._lane_batch_started[lane] = batch_started_at
            try:
                await self._process_batch_isolated(batch)
            finally:
                self._lane_busy[lane] = False
                self._lane_batch_started[lane] = None
                self._lane_batches[lane] += 1
                self._lane_items[lane] += len(batch)
                self.hist.record_batch_stage("batch_processing", batch_started_at)
                self.hist.record_batch_stage(f"batch_processing_{lane}", batch_started_at)
                if lane == LANE_LIVE and not queue:
                    self._live_idle.set()

    async def _process_batch_isolated(self, batch: list[_PendingEnvelope]) -> None:
        """Process a batch; an unexpected exception is isolated to the item(s) that cause it.

        A bug or poison item must not send every innocent neighbour around the delivery limit
        into the DLQ: on failure the unresolved items are re-processed one by one. An item that
        keeps failing is retried until its last allowed delivery, then quarantined with durable
        evidence (DEAD_LETTER for a v1 message, quarantine row inside a batch envelope).
        """
        try:
            await self._process_batch(batch)
            return
        except Exception as exc:  # noqa: BLE001 - every future must resolve
            logger.exception("Unexpected error in ingestion batch of %d; isolating", len(batch))
            self.metrics.last_error = f"Batch exception: {type(exc).__name__}"[:300]
            first_error: BaseException = exc
        unresolved = [env for env in batch if not env.future.done()]
        if len(unresolved) == 1 or len(batch) == 1:
            for env in unresolved:
                await self._resolve_poison(env, first_error)
            return
        for env in unresolved:
            if env.future.done():
                continue
            try:
                await self._process_batch([env])
            except Exception as item_exc:  # noqa: BLE001
                await self._resolve_poison(env, item_exc)

    async def _resolve_poison(self, env: _PendingEnvelope, exc: BaseException) -> None:
        if env.future.done():
            return
        if env.delivery_count + 1 < max(1, self.delivery_limit):
            env.future.set_result(ConsumeOutcome.RETRY)
            self.metrics.retried_total += 1
            return
        await self._safe_quarantine(
            tenant_id=env.batch_tenant or self._header_tenant_uuid(env.headers),
            edge_id=None,
            event_uid=str(env.message_id or "poison")[:256],
            reason=f"INGEST_EXCEPTION ({type(exc).__name__}) after {env.delivery_count + 1} deliveries",
            payload={"message_id": env.message_id, "bytes": len(env.raw_body)},
        )
        self.metrics.dlq_total += 1
        env.future.set_result(ConsumeOutcome.DEAD_LETTER)

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
