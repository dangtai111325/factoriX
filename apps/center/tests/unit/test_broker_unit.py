"""Unit tests for BrokerConfig, URL redaction, routing keys, and Settings validators (S03)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import NAMESPACE_URL, UUID, uuid5

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
from factorix.domain.canonical import (
    OBS_BATCH_CONTENT_TYPE,
    OBS_BATCH_HEADER,
    OBS_BATCH_HEADER_VALUE,
    CanonicalObservation,
    CanonicalProvenance,
    decode_observation_batch,
)
from factorix.domain.quality import Quality


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


def _obs(i: int, *, tenant: UUID | None = None, age_s: float = 0.0) -> CanonicalObservation:
    return CanonicalObservation(
        event_uid=f"uid-{i}",
        tenant_id=tenant or UUID("11111111-2222-3333-4444-555555555555"),
        signal_id=uuid5(NAMESPACE_URL, f"sig-{i % 7}"),
        resource_id=uuid5(NAMESPACE_URL, "res"),
        acquired_at=datetime.now(timezone.utc) - timedelta(seconds=age_s),
        value_type="float64",
        value=float(i),
        quality=Quality.GOOD,
        source_sequence=i,
        provenance=CanonicalProvenance(protocol="modbus_tcp", address_summary="10.0.0.1:502"),
    )


def test_build_envelopes_batches_by_lane_and_round_trips_every_observation() -> None:
    publisher = RabbitMQPublisher(BrokerConfig(amqp_url="amqp://localhost/", batch_max_obs=4, envelope_mode="batch"))
    fresh = [_obs(i) for i in range(6)]
    stale = [_obs(100 + i, age_s=60) for i in range(2)]
    envelopes = publisher.build_envelopes([fresh[0], stale[0], *fresh[1:], stale[1]])
    lanes = [(env.routing_key.startswith("telemetry.live.v1."), len(env.observations)) for env in envelopes]
    assert sorted(lanes) == [(False, 2), (True, 2), (True, 4)]
    decoded: list[CanonicalObservation] = []
    for env in envelopes:
        assert env.content_type == OBS_BATCH_CONTENT_TYPE
        assert env.headers[OBS_BATCH_HEADER] == OBS_BATCH_HEADER_VALUE
        batch = decode_observation_batch(env.body)
        assert batch.batch_id == env.message_id and len(batch.items) == len(env.observations)
        decoded.extend(CanonicalObservation.from_dict(item) for item in batch.items)
    assert sorted(decoded, key=lambda o: o.event_uid) == sorted([*fresh, *stale], key=lambda o: o.event_uid)

    small = RabbitMQPublisher(BrokerConfig(amqp_url="amqp://localhost/", batch_max_obs=500, batch_max_bytes=4096))
    sized = small.build_envelopes([_obs(i) for i in range(40)])
    assert len(sized) > 1 and all(len(env.body) <= 4096 + 512 for env in sized)

    legacy = RabbitMQPublisher(BrokerConfig(amqp_url="amqp://localhost/", envelope_mode="single"))
    singles = legacy.build_envelopes(fresh[:3])
    assert [env.message_id for env in singles] == ["uid-0", "uid-1", "uid-2"]
    assert CanonicalObservation.from_json_bytes(singles[0].body) == fresh[0]


@pytest.mark.asyncio
async def test_publish_window_fails_fast_after_unavailable_and_keeps_confirms(monkeypatch: pytest.MonkeyPatch) -> None:
    publisher = RabbitMQPublisher(
        BrokerConfig(amqp_url="amqp://localhost/", confirm_timeout_s=0.05, max_inflight_publishes=1, batch_max_obs=1)
    )
    items = [_obs(i) for i in range(4)]
    attempted: list[str] = []

    async def publish(**kwargs):
        attempted.append(kwargs["message_id"])
        if len(attempted) == 2:
            error = BrokerUnavailableError("confirm timeout")
            error.__cause__ = TimeoutError()
            raise error

    monkeypatch.setattr(publisher, "_publish_unbounded", publish)
    confirmed, failed = await asyncio.wait_for(publisher.publish_observations_partial(items), timeout=1)
    assert confirmed == ["uid-0"]
    assert [obs.event_uid for obs, _ in failed] == ["uid-1", "uid-2", "uid-3"]
    # The stalled broker costs ONE confirm timeout: later envelopes are not even attempted.
    assert len(attempted) == 2
    assert all(isinstance(error, BrokerUnavailableError) and isinstance(error.__cause__, TimeoutError) for _, error in failed)


@pytest.mark.asyncio
async def test_publish_window_keeps_going_on_backpressure_and_overlaps_confirms(monkeypatch: pytest.MonkeyPatch) -> None:
    publisher = RabbitMQPublisher(BrokerConfig(amqp_url="amqp://localhost/", max_inflight_publishes=8, batch_max_obs=1))
    items = [_obs(i) for i in range(8)]
    active = 0
    peak = 0

    async def publish(**kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        if b"uid-3" in kwargs["payload"]:
            raise BrokerBackpressureError("queue full")

    monkeypatch.setattr(publisher, "_publish_unbounded", publish)
    confirmed, failed = await publisher.publish_observations_partial(items)
    assert peak > 1  # several envelopes awaiting confirms at once (sliding window)
    assert [obs.event_uid for obs, _ in failed] == ["uid-3"]
    assert isinstance(failed[0][1], BrokerBackpressureError)
    assert len(confirmed) == 7 and publisher.envelopes_published == 7


def test_scrub_secrets_removes_url_credentials() -> None:
    assert broker.scrub_secrets("connect amqp://mq:s3cr3t@host:5672/ failed") == "connect amqp://***:***@host:5672/ failed"
    assert "pw" not in broker.scrub_secrets("postgresql+asyncpg://user:pw@db:5432/x")


def test_two_lane_broker_config_and_routing_keys() -> None:
    cfg = BrokerConfig(amqp_url="amqp://localhost/")
    assert cfg.queue_name == "factorix.telemetry.ingest.q"
    assert cfg.live_queue_name == "factorix.telemetry.live.q"
    assert cfg.binding_pattern == "telemetry.v1.*"
    assert cfg.live_binding_pattern == "telemetry.live.v1.*"
    assert cfg.live_max_length_bytes == 256 * 1024 * 1024
    assert cfg.live_prefetch_count == 256
    assert cfg.live_consumer_concurrency == 256

    # The live lane follows the configured topology (isolated / prefixed topologies never share a live queue
    # whose DLX arguments belong to another topology); an explicit name is kept as given.
    prefixed = BrokerConfig(amqp_url="amqp://localhost/", queue_name="factorix.s06.ingest.q.abc", dlx_name="factorix.s06.dlx.abc")
    assert prefixed.live_queue_name == "factorix.s06.live.q.abc"
    assert BrokerConfig(amqp_url="amqp://localhost/", queue_name="custom").live_queue_name == "custom.live"
    assert BrokerConfig(amqp_url="amqp://localhost/", live_queue_name="x.live.q").live_queue_name == "x.live.q"
    from factorix.platform.settings import BrokerSettings

    from_env = BrokerConfig.from_settings(BrokerSettings(rabbitmq_url="amqp://localhost/"))
    assert (from_env.queue_name, from_env.live_queue_name, from_env.dlq_name) == (
        "factorix.telemetry.ingest.q", "factorix.telemetry.live.q", "factorix.telemetry.dlq",
    )

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
