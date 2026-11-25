"""Ingestion pipeline: ``IngestionWorker`` (lifecycle, heartbeat) composed of the stage mixins. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import replace
import time
from typing import Any
from uuid import UUID

import asyncpg

from factorix.modules.live_state import TDengineLiveStateProvider
from factorix.modules.providers import LiveSignalRecord, RecordingPolicyEvaluator
from factorix.modules.recording_policy import DefaultRecordingPolicyEvaluator
from factorix.application.live.latest_api import RejectionThrottle
from factorix.platform.broker import BrokerConfig, RabbitMQConsumer
from factorix_core.contracts.runtime_status import QUEUES_SCHEMA_VERSION
from factorix.platform.tdengine import TDEngineClient

from factorix.platform.db import to_asyncpg_dsn
from factorix.application.ingestion.common import (
    DEFAULT_INSTANCE_ID,
    LANE_LEGACY,
    LANE_LIVE,
    MAX_BATCH_ITEMS,
    _WakeAll,
    logger,
)
from factorix.application.ingestion.metrics import LatencyHistogram, RecentUidLru, WorkerMetrics
from factorix.application.ingestion.envelope import _PendingEnvelope
from factorix.application.ingestion.catalog import TenantCatalog, _CatalogStage
from factorix.application.ingestion.pg_store import PgIngestionStore
from factorix.application.ingestion.decode import _DecodeStage
from factorix.application.ingestion.lanes import _LaneStage
from factorix.application.ingestion.validate import _ValidateStage
from factorix.application.ingestion.td_write import _TdWriteStage
from factorix.application.ingestion.policy import _PolicyStage
from factorix.application.ingestion.formulas import _FormulaStage
from factorix.application.ingestion.persist import _PersistStage


class IngestionWorker(
    _CatalogStage,
    _DecodeStage,
    _LaneStage,
    _ValidateStage,
    _TdWriteStage,
    _PolicyStage,
    _FormulaStage,
    _PersistStage,
):
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
        enable_gap_sweep: bool = True,
        update_connection_liveness: bool = True,
        replay_batch_size: int = 500,
    ) -> None:
        self.pg = pg_store
        self.td = tdengine
        self.broker_cfg = broker_cfg
        self.instance_id = instance_id
        self.batch_size = max(1, min(MAX_BATCH_ITEMS, int(batch_size)))
        # Replay batches are kept small: the event loop is shared with the live lane, and a
        # large CPU-bound replay batch (decode + SQL building) would delay live commits.
        self.replay_batch_size = max(1, int(replay_batch_size))
        self._legacy_wake_size = self.batch_size
        self._live_wake_size = self.batch_size
        if broker_cfg is not None:
            # Delivery slots stay occupied until the batch commits and its messages are acknowledged.
            self._legacy_wake_size = min(
                self.batch_size,
                broker_cfg.prefetch_count or self.batch_size,
                broker_cfg.consumer_concurrency,
            )
            self._live_wake_size = min(
                self.batch_size,
                broker_cfg.live_prefetch_count or self.batch_size,
                broker_cfg.live_consumer_concurrency,
            )
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
        self.enable_gap_sweep = bool(enable_gap_sweep)
        self.update_connection_liveness = update_connection_liveness

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
        self._legacy_consumer: RabbitMQConsumer | None = None
        self._live_consumer: RabbitMQConsumer | None = None

        # Two independent lanes (live / legacy=replay): each has its own queue, wake event and
        # batcher task, so a replay batch (or its retries) never blocks live latest-state.
        self._pending_live: deque[_PendingEnvelope] = deque()
        self._pending_legacy: deque[_PendingEnvelope] = deque()
        self._pending_lock = asyncio.Lock()
        self._wake_live = asyncio.Event()
        self._wake_legacy = asyncio.Event()
        self._wake_batcher = _WakeAll(self._wake_live, self._wake_legacy)
        self._live_idle = asyncio.Event()
        self._live_idle.set()
        self._lane_busy: dict[str, bool] = {LANE_LIVE: False, LANE_LEGACY: False}
        self._lane_waiting_msgs: dict[str, int] = {LANE_LIVE: 0, LANE_LEGACY: 0}
        self._lane_batch_started: dict[str, float | None] = {LANE_LIVE: None, LANE_LEGACY: None}
        self._lane_batches: dict[str, int] = {LANE_LIVE: 0, LANE_LEGACY: 0}
        self._lane_items: dict[str, int] = {LANE_LIVE: 0, LANE_LEGACY: 0}
        self._quarantine_failed: set[str] = set()
        self.envelopes_received = 0
        self.delivery_limit = int(broker_cfg.delivery_limit) if broker_cfg is not None else 5
        self._stop_event = asyncio.Event()
        self._stopping = False

        self._batcher_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._notify_task: asyncio.Task[None] | None = None
        self._notify_conn: asyncpg.Connection | None = None

    async def start(self) -> None:
        self._stopping = False
        self._stop_event.clear()
        await self.pg.start()
        self._batcher_task = asyncio.create_task(self._batcher_loop(), name="ingestion-batcher")
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="ingestion-heartbeat")
        if self._notify_dsn:
            self._notify_task = asyncio.create_task(self._notify_loop(), name="ingestion-pg-notify")
        if self.broker_cfg is not None:
            legacy_cfg = self.broker_cfg
            live_cfg = replace(
                self.broker_cfg,
                queue_name=self.broker_cfg.live_queue_name,
                prefetch_count=self.broker_cfg.live_prefetch_count,
                consumer_concurrency=self.broker_cfg.live_consumer_concurrency,
                max_length_bytes=self.broker_cfg.live_max_length_bytes,
                binding_pattern=self.broker_cfg.live_binding_pattern,
            )
            self._legacy_consumer = RabbitMQConsumer(
                legacy_cfg,
                self.handle_legacy_message,
                queue_name=self.broker_cfg.queue_name,
            )
            self._live_consumer = RabbitMQConsumer(
                live_cfg,
                self.handle_live_message,
                queue_name=self.broker_cfg.live_queue_name,
            )
            self._consumer = self._legacy_consumer
            await self._legacy_consumer.start()
            await self._live_consumer.start()

    async def stop(self, *, drain_timeout_s: float = 15.0) -> None:
        self._stopping = True
        self._stop_event.set()
        if self._live_consumer is not None:
            await self._live_consumer.stop(drain_timeout_s=drain_timeout_s)
        if self._legacy_consumer is not None:
            await self._legacy_consumer.stop(drain_timeout_s=drain_timeout_s)
        elif self._consumer is not None:
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

    async def _heartbeat_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                td_ok = False
                try:
                    # Liveness only: a single round trip. The full probe (5 metadata queries incl.
                    # ins_disk_usage) every 5 s was a constant TDengine load (R2-01, WS-P R3).
                    if hasattr(self.td, "ping"):
                        td_ok = bool(await self.td.ping())
                    else:  # test doubles / older clients
                        health = await self.td.health_probe()
                        td_ok = bool(health.reachable)
                except Exception:  # noqa: BLE001
                    td_ok = False
                broker_ok = self._consumers_connected()
                rates = self.hist.tenant_rates_per_min()
                conn_rates = self.hist.connection_rates_per_min()
                slis = self.hist.snapshot()
                self._sync_policy_metrics()
                queues_json = {
                    "schema_version": QUEUES_SCHEMA_VERSION,  # runtime-status.md v1 (additive, CT-19)
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
                    "envelopes_received": self.envelopes_received,
                    "lanes": self.lane_metrics(),
                    "pg_ingested_at": bool(getattr(self.pg, "has_ingested_at", False)),
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
                if td_ok and not self._stop_event.is_set() and self.enable_gap_sweep:
                    await self._sweep_all_interval_gaps()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Ingestion heartbeat update failed: %s", exc)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

    def _consumers_connected(self) -> bool:
        consumers = [c for c in (self._live_consumer, self._legacy_consumer) if c is not None]
        if not consumers:
            return self._consumer is not None
        for consumer in consumers:
            channel = getattr(consumer, "_channel", None)
            if channel is None or bool(getattr(channel, "is_closed", False)):
                return False
        return True

    def lane_metrics(self) -> dict[str, Any]:
        now = time.monotonic()
        out: dict[str, Any] = {}
        for lane in (LANE_LIVE, LANE_LEGACY):
            started = self._lane_batch_started[lane]
            out[lane] = {
                "pending_items": len(self._lane_queue(lane)),
                "waiting_messages": self._lane_waiting_msgs[lane],
                "batches": self._lane_batches[lane],
                "items": self._lane_items[lane],
                "busy": self._lane_busy[lane],
                "stalled_batch_age_s": round(now - started, 3) if started is not None else None,
            }
        return out
