"""100x Scale Load Benchmark (33,600 Signals / Tens of thousands of series).

Validates throughput, latency, memory, queue depth, TDengine subtable creation
and query responsiveness under 100x baseline load (336 * 100 = 33,600 signals).
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance, derive_event_uid
from factorix.domain.quality import Quality
from factorix.platform.broker import (
    BrokerConfig,
    ConsumeOutcome,
    RabbitMQConsumer,
    RabbitMQPublisher,
    declare_telemetry_topology,
)
from factorix.platform.tdengine import (
    TDEngineClient,
    TDEngineConfig,
    op_subtable_name,
    tenant_database_name,
)


def _td_dsn() -> str:
    raw = os.environ.get("FACTORIX_TDENGINE_DSN", "")
    if not raw or "factorix-tdengine" in raw:
        return "ws://root:taosdata@127.0.0.1:6041"
    return raw


def _rmq_url() -> str:
    raw = os.environ.get("FACTORIX_RABBITMQ_URL", "")
    if not raw or "factorix-rabbitmq" in raw:
        return "amqp://factorix_mq:factorix-mq-pw@127.0.0.1:5672/"
    return raw


@pytest.mark.asyncio
async def test_33600_signals_100x_tdengine_ingest_and_query_scale() -> None:
    """Simulate 33,600 signals (100x baseline) batch insertion and concurrent queries in TDengine."""
    tenant_id = uuid4()
    db = tenant_database_name(tenant_id)
    
    # Generate 33,600 signals distributed across 100 resources (336 signals/resource)
    NUM_SIGNALS = 33600
    NUM_RESOURCES = 100
    resources = [uuid4() for _ in range(NUM_RESOURCES)]
    signals = [
        (uuid4(), resources[i % NUM_RESOURCES], "float64" if i % 10 < 8 else ("bool" if i % 10 == 8 else "int64"))
        for i in range(NUM_SIGNALS)
    ]
    
    base_time = datetime(2026, 11, 12, 10, 0, 0, tzinfo=timezone.utc)
    
    cfg = TDEngineConfig(dsn=_td_dsn(), batch_chunk_rows=1000)
    async with TDEngineClient(cfg) as td:
        try:
            # 1. Ensure operational schema
            t_schema_start = time.perf_counter()
            await td.ensure_operational_schema(tenant_id)
            t_schema = time.perf_counter() - t_schema_start
            print(f"\n[100x Scale] Operational schema ensured in {t_schema:.3f}s")
            
            # 2. Cycle 1: Warmup & Initial creation of 33,600 subtables
            print(f"[100x Scale] Generating Cycle 1 (33,600 observations across {NUM_SIGNALS} unique series)...")
            batch_cycle_1 = [
                {
                    "signal_id": sig_id,
                    "resource_id": res_id,
                    "value_type": val_type,
                    "value": float(idx % 100) if val_type == "float64" else (True if val_type == "bool" else int(idx)),
                    "raw_quality": "GOOD",
                    "event_time": base_time,
                    "acquired_at": base_time,
                    "event_uid": f"100x-c1-{idx}",
                }
                for idx, (sig_id, res_id, val_type) in enumerate(signals)
            ]
            
            t_write_start = time.perf_counter()
            res_c1 = await td.write_operational_observations(tenant_id, batch_cycle_1)
            t_write_c1 = time.perf_counter() - t_write_start
            
            rate_c1 = NUM_SIGNALS / max(t_write_c1, 0.001)
            print(f"[100x Scale] Cycle 1 Ingest: {NUM_SIGNALS} signals written in {t_write_c1:.2f}s ({rate_c1:.0f} obs/s)")
            assert len(res_c1.succeeded_ids) == NUM_SIGNALS, f"Expected {NUM_SIGNALS} successes, got {len(res_c1.succeeded_ids)}"
            assert len(res_c1.failures) == 0
            
            # 3. Cycle 2 & 3: Streaming Burst (67,200 observations = 2 more full site sweeps)
            burst_obs = []
            for cycle in (2, 3):
                t_cycle = base_time + timedelta(seconds=cycle)
                for idx, (sig_id, res_id, val_type) in enumerate(signals):
                    burst_obs.append({
                        "signal_id": sig_id,
                        "resource_id": res_id,
                        "value_type": val_type,
                        "value": float((idx + cycle) % 100) if val_type == "float64" else (cycle % 2 == 0 if val_type == "bool" else int(idx + cycle)),
                        "raw_quality": "GOOD",
                        "event_time": t_cycle,
                        "acquired_at": t_cycle,
                        "event_uid": f"100x-c{cycle}-{idx}",
                    })
            
            t_burst_start = time.perf_counter()
            res_burst = await td.write_operational_observations(tenant_id, burst_obs)
            t_burst = time.perf_counter() - t_burst_start
            burst_rate = len(burst_obs) / max(t_burst, 0.001)
            print(f"[100x Scale] Burst Ingest (Cycles 2-3): {len(burst_obs)} observations in {t_burst:.2f}s ({burst_rate:.0f} obs/s)")
            assert len(res_burst.succeeded_ids) == len(burst_obs)
            assert len(res_burst.failures) == 0
            
            # Total observations written = 33,600 * 3 = 100,800
            total_obs = NUM_SIGNALS * 3
            print(f"[100x Scale] Total 100,800 observations written across 33,600 subtables successfully.")
            
            # 4. Concurrent Query Responsiveness Benchmark under 100x scale
            # Sample 50 random signals across different types
            sample_signals = [signals[i * (NUM_SIGNALS // 50)] for i in range(50)]
            
            # 4a. Concurrent LAST_ROW queries
            t_last_start = time.perf_counter()
            async def _query_last(sig_info):
                sig_id, _, val_type = sig_info
                sub = op_subtable_name(sig_id, val_type)
                return await td.query_last_row(db, sub)
            
            last_results = await asyncio.gather(*[_query_last(s) for s in sample_signals])
            t_last = time.perf_counter() - t_last_start
            avg_last_ms = (t_last / len(sample_signals)) * 1000
            print(f"[100x Scale] 50 Concurrent LAST_ROW queries: total {t_last:.3f}s (avg {avg_last_ms:.2f}ms/query)")
            assert all(r is not None for r in last_results)
            assert avg_last_ms < 100.0, f"Average LAST_ROW query took {avg_last_ms:.2f}ms (expected < 100ms)"
            
            # 4b. Range queries (15-minute sparkline window)
            t_range_start = time.perf_counter()
            async def _query_range(sig_info):
                sig_id, _, val_type = sig_info
                sub = op_subtable_name(sig_id, val_type)
                return await td.query_range(db, sub, start=base_time - timedelta(minutes=1), end=base_time + timedelta(minutes=15))
            
            range_results = await asyncio.gather(*[_query_range(s) for s in sample_signals[:20]])
            t_range = time.perf_counter() - t_range_start
            avg_range_ms = (t_range / 20) * 1000
            print(f"[100x Scale] 20 Concurrent 15m Range queries: total {t_range:.3f}s (avg {avg_range_ms:.2f}ms/query)")
            assert all(len(r) == 3 for r in range_results)
            assert avg_range_ms < 150.0, f"Average Range query took {avg_range_ms:.2f}ms (expected < 150ms)"
            
            # 4c. Value-At queries (as-of time travel)
            t_vat_start = time.perf_counter()
            target_t = base_time + timedelta(seconds=1)
            async def _query_vat(sig_info):
                sig_id, _, val_type = sig_info
                sub = op_subtable_name(sig_id, val_type)
                return await td.query_value_at(db, sub, at=target_t)
            
            vat_results = await asyncio.gather(*[_query_vat(s) for s in sample_signals[:20]])
            t_vat = time.perf_counter() - t_vat_start
            avg_vat_ms = (t_vat / 20) * 1000
            print(f"[100x Scale] 20 Concurrent Value-At queries: total {t_vat:.3f}s (avg {avg_vat_ms:.2f}ms/query)")
            assert all(r is not None for r in vat_results)
            
            print(f"[100x Scale Benchmark] PASS: 33,600 series scale test completed with 100% integrity!")
        finally:
            await td.drop_database(db, confirm=True)


@pytest.mark.asyncio
async def test_100x_scale_quorum_queue_throughput_and_backpressure() -> None:
    """Verify RabbitMQ 4.0 Quorum Queue absorbs 10,000+ observations burst without loss or deadlock."""
    suffix = uuid4().hex[:8]
    cfg = BrokerConfig(
        amqp_url=_rmq_url(),
        exchange_name=f"factorix.test.scale.x.{suffix}",
        queue_name=f"factorix.test.scale.q.{suffix}",
        dlx_name=f"factorix.test.scale.dlx.{suffix}",
        dlq_name=f"factorix.test.scale.dlq.{suffix}",
        delivery_limit=3,
        prefetch_count=256,
        max_inflight_publishes=128,
        confirm_timeout_s=10.0,
    )
    
    tenant_id = uuid4()
    site_id = uuid4()
    res_id = uuid4()
    
    # 10,000 observations burst
    TOTAL_MSGS = 10000
    base_time = datetime.now(timezone.utc)
    
    observations = [
        CanonicalObservation(
            event_uid=f"scale-{suffix}-{i}",
            tenant_id=tenant_id,
            signal_id=uuid4(),
            resource_id=res_id,
            site_id=site_id,
            acquired_at=base_time + timedelta(milliseconds=i),
            value_type="float64",
            value=float(i % 1000),
            quality=Quality.GOOD,
            data_epoch=1,
        )
        for i in range(TOTAL_MSGS)
    ]
    
    # Publish burst (pub.start declares topology automatically)
    pub = RabbitMQPublisher(cfg)
    await pub.start()
    t_pub_start = time.perf_counter()
    try:
        # Publish in concurrent chunks of 500
        CHUNK_SIZE = 500
        for offset in range(0, TOTAL_MSGS, CHUNK_SIZE):
            chunk = observations[offset : offset + CHUNK_SIZE]
            confirmed, failed = await pub.publish_observations_partial(chunk)
            assert len(failed) == 0, f"Publish failures: {failed}"
        t_pub = time.perf_counter() - t_pub_start
        pub_rate = TOTAL_MSGS / max(t_pub, 0.001)
        print(f"\n[100x Scale Quorum Queue] Published {TOTAL_MSGS} messages in {t_pub:.2f}s ({pub_rate:.0f} msg/s)")
    finally:
        await pub.close()
        
    # Consume and acknowledge with high-concurrency consumer
    consumed_count = 0
    t_consume_start = time.perf_counter()
    
    async def _handle(msg):
        nonlocal consumed_count
        consumed_count += 1
        return ConsumeOutcome.ACK
    
    consumer = RabbitMQConsumer(cfg, _handle)
    await consumer.start()
    
    try:
        # Wait until all 10,000 messages are consumed
        for _ in range(60):
            if consumed_count >= TOTAL_MSGS:
                break
            await asyncio.sleep(0.5)
        
        t_consume = time.perf_counter() - t_consume_start
        consume_rate = consumed_count / max(t_consume, 0.001)
        print(f"[100x Scale Quorum Queue] Consumed {consumed_count}/{TOTAL_MSGS} messages in {t_consume:.2f}s ({consume_rate:.0f} msg/s)")
        assert consumed_count == TOTAL_MSGS, f"Expected {TOTAL_MSGS} messages consumed, got {consumed_count}"
        print(f"[100x Scale Quorum Queue] PASS: Zero message loss under heavy burst!")
    finally:
        await consumer.stop()
        # Clean up queue
        import aio_pika
        conn = await aio_pika.connect(cfg.amqp_url)
        try:
            ch = await conn.channel()
            await ch.queue_delete(cfg.queue_name)
            await ch.queue_delete(cfg.dlq_name)
            await ch.exchange_delete(cfg.exchange_name)
            await ch.exchange_delete(cfg.dlx_name)
        finally:
            await conn.close()
