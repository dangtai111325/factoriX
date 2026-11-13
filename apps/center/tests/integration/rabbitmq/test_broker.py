"""Live RabbitMQ 4.0 Quorum Queue integration tests (S03)."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

import aio_pika
import httpx
import pytest
from aio_pika.abc import AbstractIncomingMessage

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance, derive_event_uid
from factorix.domain.quality import Quality
from factorix.platform.broker import (
    BrokerBackpressureError,
    BrokerConfig,
    ConsumeOutcome,
    RabbitMQConsumer,
    RabbitMQPublisher,
    declare_telemetry_topology,
    probe_broker_health,
    tenant_routing_key,
)


def _isolated_cfg(**overrides: object) -> BrokerConfig:
    suffix = uuid4().hex[:10]
    amqp_url = os.environ["FACTORIX_RABBITMQ_URL"]
    mgmt_url = os.environ.get("FACTORIX_RABBITMQ_MGMT_URL", "http://127.0.0.1:15672")
    kwargs: dict[str, object] = {
        "amqp_url": amqp_url,
        "mgmt_url": mgmt_url,
        "exchange_name": f"factorix.test.ingress.{suffix}",
        "queue_name": f"factorix.test.ingest.q.{suffix}",
        "dlx_name": f"factorix.test.dlx.{suffix}",
        "dlq_name": f"factorix.test.dlq.{suffix}",
        "delivery_limit": 3,
        "prefetch_count": 16,
        "max_inflight_publishes": 16,
        "confirm_timeout_s": 5.0,
    }
    kwargs.update(overrides)
    return BrokerConfig(**kwargs)  # type: ignore[arg-type]


async def _cleanup_topology(cfg: BrokerConfig) -> None:
    conn = await aio_pika.connect(cfg.amqp_url, timeout=5.0)
    try:
        ch = await conn.channel()
        for qname in (cfg.queue_name, cfg.dlq_name):
            try:
                await ch.queue_delete(qname, if_unused=False, if_empty=False)
            except Exception:
                pass
        for xname in (cfg.exchange_name, cfg.dlx_name):
            try:
                await ch.exchange_delete(xname, if_unused=False)
            except Exception:
                pass
    finally:
        await conn.close()
        # Drain any pending aiormq I/O tasks to avoid "Future exception was never retrieved" on Python 3.14
        await asyncio.sleep(0)


def _make_obs(tenant_id, *, value: float | str = 42.5, value_type: str = "float64", epoch: int = 1, seq: int = 1) -> CanonicalObservation:
    sig_id = uuid4()
    res_id = uuid4()
    conn_id = uuid4()
    field_id = uuid4()
    now = datetime.now(timezone.utc)
    return CanonicalObservation(
        event_uid=derive_event_uid(
            tenant_id=tenant_id,
            connection_id=conn_id,
            source_field_id=field_id,
            signal_id=sig_id,
            acquired_at=now,
            sequence_or_key=f"s-{seq}",
            data_epoch=epoch,
        ),
        tenant_id=tenant_id,
        site_id=uuid4(),
        connection_id=conn_id,
        acquisition_job_id=uuid4(),
        source_field_id=field_id,
        signal_id=sig_id,
        resource_id=res_id,
        source_time=now,
        acquired_at=now,
        value_type=value_type,
        value=value,
        unit="°C" if value_type == "float64" else None,
        quality=Quality.GOOD,
        data_epoch=epoch,
        config_revision=2,
        provenance=CanonicalProvenance(protocol="modbus_tcp", connection_id=conn_id, address_summary="127.0.0.1:15020/hr1"),
        correlation_id=f"test-{seq}",
    )


@pytest.mark.asyncio
async def test_quorum_topology_arguments_and_health_probe() -> None:
    cfg = _isolated_cfg()
    try:
        async with RabbitMQPublisher(cfg):
            health = await probe_broker_health(cfg)
            assert health.broker_ok is True
            assert health.ready_count == 0
            assert health.dlq_count == 0

            # Verify exact RabbitMQ 4.0 Quorum Queue attributes via Management API
            from urllib.parse import urlparse

            parsed = urlparse(cfg.amqp_url)
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    f"{cfg.mgmt_url}/api/queues/%2F/{cfg.queue_name}",
                    auth=(parsed.username or "", parsed.password or ""),
                )
                assert resp.status_code == 200
                info = resp.json()
                assert info["type"] == "quorum"
                args = info["arguments"]
                assert args["x-dead-letter-strategy"] == "at-least-once"
                assert args["x-overflow"] == "reject-publish"
                assert args["x-delivery-limit"] == 3
    finally:
        await _cleanup_topology(cfg)


@pytest.mark.asyncio
async def test_publisher_confirm_manual_ack_and_epoch_headers() -> None:
    cfg = _isolated_cfg()
    tenant_id = uuid4()
    received: list[tuple[CanonicalObservation, dict[str, object]]] = []
    done = asyncio.Event()

    async def handle(msg: AbstractIncomingMessage) -> ConsumeOutcome:
        obs = CanonicalObservation.from_json_bytes(msg.body)
        received.append((obs, dict(msg.headers or {})))
        if len(received) >= 3:
            done.set()
        return ConsumeOutcome.ACK

    consumer = RabbitMQConsumer(cfg, handle)
    try:
        async with RabbitMQPublisher(cfg) as pub:
            for i in range(3):
                await pub.publish_observation(_make_obs(tenant_id, value=20.0 + i, epoch=7, seq=i))
            assert pub.metrics.published_ok == 3
            assert pub.metrics.last_confirm_latency_ms is not None

            await consumer.start()
            await asyncio.wait_for(done.wait(), timeout=5.0)
            await consumer.stop(drain_timeout_s=5.0)

        assert len(received) == 3
        assert consumer.metrics.consumed_ack == 3
        assert {item[0].data_epoch for item in received} == {7}
        assert all(item[1].get("x-data-epoch") == 7 for item in received)
        health = await probe_broker_health(cfg)
        assert health.ready_count == 0
    finally:
        await _cleanup_topology(cfg)


@pytest.mark.asyncio
async def test_retry_delivery_limit_routes_poison_to_quorum_dlq() -> None:
    cfg = _isolated_cfg(delivery_limit=2)
    tenant_id = uuid4()
    attempts = 0

    async def failing_handler(_msg: AbstractIncomingMessage) -> ConsumeOutcome:
        nonlocal attempts
        attempts += 1
        return ConsumeOutcome.RETRY

    consumer = RabbitMQConsumer(cfg, failing_handler)
    try:
        async with RabbitMQPublisher(cfg) as pub:
            await pub.publish_observation(_make_obs(tenant_id, seq=99))
            await consumer.start()
            # With at-least-once DLX strategy, RabbitMQ 4.0 may crash the quorum queue
            # process (noproc) when dead-lettering – this IS the dead-letter event.
            # Wait up to 30s for >= delivery_limit attempts, then verify DLQ directly.
            deadline = asyncio.get_running_loop().time() + 30.0
            while asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.5)
                if attempts >= cfg.delivery_limit:
                    # Give RabbitMQ time to complete the at-least-once DLX publish
                    await asyncio.sleep(3.0)
                    break
            await consumer.stop(drain_timeout_s=5.0)

        assert attempts >= cfg.delivery_limit, (
            f"Expected >= {cfg.delivery_limit} delivery attempts, got {attempts}"
        )

        # Verify the message arrived in the DLQ via Management HTTP
        # (AMQP passive declare message_count may lag for at-least-once dead-lettered messages)
        parsed = urlparse(cfg.amqp_url)
        dlq_check_auth = (parsed.username or "", parsed.password or "")
        dlq_msg_found = False
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Retry DLQ check a few times to allow Management stats to settle
            for _ in range(6):
                resp = await client.get(
                    f"{cfg.mgmt_url}/api/queues/%2F/{cfg.dlq_name}",
                    auth=dlq_check_auth,
                )
                if resp.status_code == 200 and int(resp.json().get("messages", 0)) >= 1:
                    dlq_msg_found = True
                    break
                await asyncio.sleep(1.0)

        assert dlq_msg_found, (
            f"Expected poison message in DLQ after {cfg.delivery_limit} deliveries "
            f"(attempts={attempts})"
        )

        # Read and verify the message inside DLQ has intact payload & headers
        # Use plain connect (not robust) to avoid aiormq reconnect task teardown noise on Python 3.14
        conn = await aio_pika.connect(cfg.amqp_url, timeout=5.0)
        try:
            ch = await conn.channel()
            dlq = await ch.declare_queue(cfg.dlq_name, passive=True)
            dlq_msg = await dlq.get(timeout=5.0)
            assert dlq_msg is not None
            restored = CanonicalObservation.from_json_bytes(dlq_msg.body)
            assert restored.correlation_id == "test-99"
            await dlq_msg.ack()
            # Allow any pending aiormq I/O tasks to settle before closing
            await asyncio.sleep(0.1)
        finally:
            await conn.close()
            await asyncio.sleep(0)
    finally:
        await _cleanup_topology(cfg)


@pytest.mark.asyncio
async def test_overflow_reject_publish_raises_backpressure_without_drop_head() -> None:
    cfg = _isolated_cfg(max_length=2)
    tenant_id = uuid4()
    try:
        rejected_at: int | None = None
        async with RabbitMQPublisher(cfg) as pub:
            for seq in range(1, 8):
                try:
                    await pub.publish_observation(_make_obs(tenant_id, seq=seq))
                except BrokerBackpressureError:
                    rejected_at = seq
                    break
            assert rejected_at is not None and rejected_at <= 5
            assert pub.metrics.publish_backpressure >= 1

        # Verify the earliest messages were NEVER overwritten by drop-head
        # Use plain connect (not robust) to avoid aiormq reconnect task teardown noise on Python 3.14
        conn = await aio_pika.connect(cfg.amqp_url, timeout=5.0)
        try:
            ch = await conn.channel()
            q = await ch.declare_queue(cfg.queue_name, passive=True)
            m1 = await q.get(timeout=5.0)
            m2 = await q.get(timeout=5.0)
            assert m1 is not None and m2 is not None
            assert CanonicalObservation.from_json_bytes(m1.body).correlation_id == "test-1"
            assert CanonicalObservation.from_json_bytes(m2.body).correlation_id == "test-2"
            await m1.ack()
            await m2.ack()
            # Allow any pending aiormq I/O tasks to settle before closing
            await asyncio.sleep(0.1)
        finally:
            await conn.close()
            await asyncio.sleep(0)
    finally:
        await _cleanup_topology(cfg)


@pytest.mark.asyncio
async def test_unacked_consumer_crash_redelivers_message() -> None:
    cfg = _isolated_cfg()
    tenant_id = uuid4()
    seen_deliveries = 0
    recovered = asyncio.Event()

    # First consumer closes connection abruptly without ACKing
    # Use plain connect (not robust) to avoid aiormq reconnect task teardown noise on Python 3.14
    conn1 = await aio_pika.connect(cfg.amqp_url, timeout=5.0)
    try:
        ch1 = await conn1.channel()
        _, q1, _ = await declare_telemetry_topology(ch1, cfg)
        async with RabbitMQPublisher(cfg) as pub:
            await pub.publish_observation(_make_obs(tenant_id, seq=777))
        msg1 = await q1.get(timeout=5.0, no_ack=False)
        assert msg1 is not None
        assert msg1.redelivered is False
    finally:
        await conn1.close()
        await asyncio.sleep(0)

    async def second_handler(msg: AbstractIncomingMessage) -> ConsumeOutcome:
        nonlocal seen_deliveries
        seen_deliveries += 1
        assert msg.redelivered is True
        assert CanonicalObservation.from_json_bytes(msg.body).correlation_id == "test-777"
        recovered.set()
        return ConsumeOutcome.ACK

    consumer2 = RabbitMQConsumer(cfg, second_handler)
    try:
        await consumer2.start()
        await asyncio.wait_for(recovered.wait(), timeout=5.0)
        await consumer2.stop(drain_timeout_s=5.0)
        assert seen_deliveries == 1
    finally:
        await _cleanup_topology(cfg)
