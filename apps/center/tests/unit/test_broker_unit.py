"""Unit tests for BrokerConfig, URL redaction, routing keys, and Settings validators (S03)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from aiormq.exceptions import DeliveryError, PublishError
from pamqp.commands import Basic

from factorix.platform import broker
from factorix.platform.broker import (
    BrokerBackpressureError,
    BrokerConfig,
    BrokerUnavailableError,
    RabbitMQPublisher,
    declare_telemetry_topology,
    probe_broker_health,
    redact_amqp_url,
    tenant_live_routing_key,
    tenant_routing_key,
)
from factorix.platform.settings import Settings


def test_broker_config_and_redaction() -> None:
    url = "amqp://mq_admin:supersecretpw@broker.internal:5672/factorix"
    assert redact_amqp_url(url) == "amqp://***:***@broker.internal:5672/factorix"
    tid = UUID("11111111-2222-3333-4444-555555555555")
    assert tenant_routing_key(tid) == "telemetry.v1.11111111222233334444555555555555"


def test_settings_validates_rabbitmq_and_tdengine_schemes() -> None:
    base_kwargs = {
        "environment": "test",
        "database_url": "postgresql+asyncpg://u:p@localhost:5432/factorix_test",
        "data_key": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "rabbitmq_url": "amqp://user:pw@127.0.0.1:15673/",
        "tdengine_dsn": "ws://root:pw@127.0.0.1:16041",
    }
    s = Settings(**base_kwargs)
    cfg = BrokerConfig.from_settings(s)
    assert cfg.queue_name == "factorix.telemetry.ingest.q"
    assert cfg.exchange_name == "factorix.telemetry.ingress"
    assert cfg.dlx_name == "factorix.telemetry.dlx"

    with pytest.raises(ValueError, match="amqp://"):
        Settings(**{**base_kwargs, "rabbitmq_url": "http://localhost:5672"})
    with pytest.raises(ValueError, match="ws://"):
        Settings(**{**base_kwargs, "tdengine_dsn": "mysql://localhost:6041"})

    s_empty = Settings(**{**base_kwargs, "rabbitmq_url": ""})
    with pytest.raises(BrokerUnavailableError):
        BrokerConfig.from_settings(s_empty)


@pytest.mark.asyncio
async def test_publisher_keeps_unroutable_delivery_distinct_from_broker_nack(monkeypatch: pytest.MonkeyPatch) -> None:
    channel = SimpleNamespace(is_closed=False)
    conn = SimpleNamespace(channel=AsyncMock(return_value=channel))
    exchange = SimpleNamespace(publish=AsyncMock())
    monkeypatch.setattr(broker, "connect_with_backoff", AsyncMock(return_value=conn))
    monkeypatch.setattr(broker, "declare_telemetry_topology", AsyncMock(return_value=(exchange, None, None)))
    publisher = RabbitMQPublisher(BrokerConfig(amqp_url="amqp://localhost/"))
    returned = Basic.Return(reply_code=312, reply_text="NO_ROUTE", routing_key="unbound")
    exchange.publish.side_effect = [
        PublishError(SimpleNamespace(delivery=returned), returned),
        DeliveryError(None, Basic.Nack(delivery_tag=2)),
        Basic.Ack(delivery_tag=3),
    ]

    with pytest.raises(BrokerUnavailableError, match="could not route"):
        await publisher.publish_bytes(payload=b"{}", routing_key="unbound", message_id="unroutable")
    conn.channel.assert_awaited_once_with(publisher_confirms=True, on_return_raises=True)
    with pytest.raises(BrokerBackpressureError, match="rejected"):
        await publisher.publish_bytes(payload=b"{}", routing_key="bound", message_id="rejected")
    await publisher.publish_bytes(payload=b"{}", routing_key="bound", message_id="confirmed")
    assert publisher.metrics.publish_errors == 1
    assert publisher.metrics.publish_backpressure == 1
    assert publisher.metrics.published_ok == 1


def test_two_lane_broker_config_and_routing_keys() -> None:
    cfg = BrokerConfig(amqp_url="amqp://localhost/")
    assert cfg.queue_name == "factorix.telemetry.ingest.q"
    assert cfg.live_queue_name == "factorix.telemetry.live.q"
    assert cfg.binding_pattern == "telemetry.v1.*"
    assert cfg.live_binding_pattern == "telemetry.live.v1.*"
    assert cfg.live_max_length_bytes == 256 * 1024 * 1024
    assert cfg.live_prefetch_count == 128

    tid = UUID("11111111-2222-3333-4444-555555555555")
    legacy_key = tenant_routing_key(tid)
    live_key = tenant_live_routing_key(tid)
    assert legacy_key == "telemetry.v1.11111111222233334444555555555555"
    assert live_key == "telemetry.live.v1.11111111222233334444555555555555"
    # Mutual exclusivity: 3 words vs 4 words
    assert len(legacy_key.split(".")) == 3
    assert len(live_key.split(".")) == 4


@pytest.mark.asyncio
async def test_declare_telemetry_topology_declares_two_lanes_and_unpacks_compatibly() -> None:
    channel = SimpleNamespace(
        declare_exchange=AsyncMock(return_value=SimpleNamespace(name="exchange")),
        declare_queue=AsyncMock(side_effect=lambda name, durable, arguments: SimpleNamespace(
            name=name,
            bind=AsyncMock(),
        )),
    )
    cfg = BrokerConfig(amqp_url="amqp://localhost/")
    res = await declare_telemetry_topology(channel, cfg)

    # Verify 3-unpacking works for backwards compatibility
    ingress, queue, dlq = res
    assert ingress.name == "exchange"
    assert queue.name == cfg.queue_name
    assert dlq.name == cfg.dlq_name

    # Verify live_queue attribute exists and is declared
    assert res.live_queue.name == cfg.live_queue_name


@pytest.mark.asyncio
async def test_probe_broker_health_two_lanes(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = BrokerConfig(amqp_url="amqp://localhost/", mgmt_url="http://127.0.0.1:15672")

    mock_queue_res = SimpleNamespace(declaration_result=SimpleNamespace(message_count=42))
    mock_live_res = SimpleNamespace(declaration_result=SimpleNamespace(message_count=5))
    mock_dlq_res = SimpleNamespace(declaration_result=SimpleNamespace(message_count=0))

    async def mock_declare_queue(qname: str, passive: bool = False):
        if qname == cfg.queue_name:
            return mock_queue_res
        if qname == cfg.live_queue_name:
            return mock_live_res
        return mock_dlq_res

    mock_channel = SimpleNamespace(declare_queue=AsyncMock(side_effect=mock_declare_queue))
    mock_conn = SimpleNamespace(channel=AsyncMock(return_value=mock_channel), close=AsyncMock())
    import aio_pika
    monkeypatch.setattr(aio_pika, "connect", AsyncMock(return_value=mock_conn))

    snapshot = await probe_broker_health(cfg)
    assert snapshot.broker_ok is True
    assert snapshot.legacy_ready_count == 42
    assert snapshot.live_ready_count == 5
    assert snapshot.ready_count == 47  # combined
    assert snapshot.dlq_count == 0
