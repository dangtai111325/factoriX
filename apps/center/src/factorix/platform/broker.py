"""RabbitMQ Quorum Queue transport library for FactoriX telemetry (§4, ADR-001).

Provides durable ingress topology declaration, publisher-confirmed publishing
with explicit ``reject-publish`` backpressure handling, bounded manual-ACK
consumers with graceful drain, and AMQP / Management HTTP health inspection.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from urllib.parse import quote, urlparse
from uuid import UUID

import aio_pika
import aiormq.exceptions
import httpx
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustChannel, AbstractRobustConnection, AbstractRobustExchange, AbstractRobustQueue

from factorix.domain.canonical import CanonicalObservation

logger = logging.getLogger(__name__)


class BrokerError(RuntimeError):
    """Base error raised by the RabbitMQ transport layer."""


class BrokerUnavailableError(BrokerError):
    """Broker connection or channel could not be established or confirmed within timeout."""


class BrokerBackpressureError(BrokerError):
    """Broker rejected a publish via ``reject-publish`` overflow or unroutable mandatory flag."""


class ConsumeOutcome(StrEnum):
    ACK = "ACK"
    RETRY = "RETRY"
    DEAD_LETTER = "DEAD_LETTER"


@dataclass(frozen=True, slots=True)
class BrokerConfig:
    amqp_url: str
    mgmt_url: str = ""
    exchange_name: str = "factorix.telemetry.ingress"
    queue_name: str = "factorix.telemetry.ingest.q"
    dlx_name: str = "factorix.telemetry.dlx"
    dlq_name: str = "factorix.telemetry.dlq"
    binding_pattern: str = "telemetry.v1.*"
    dlq_routing_key: str = "dlq"
    max_length_bytes: int = 512 * 1024 * 1024
    dlq_max_length_bytes: int = 256 * 1024 * 1024
    max_length: int | None = None
    delivery_limit: int = 5
    prefetch_count: int = 128
    max_inflight_publishes: int = 64
    confirm_timeout_s: float = 10.0
    consumer_concurrency: int = 32
    reconnect_interval_s: float = 2.0

    @classmethod
    def from_settings(cls, settings: Any) -> "BrokerConfig":
        if not getattr(settings, "rabbitmq_url", ""):
            raise BrokerUnavailableError("FACTORIX_RABBITMQ_URL is not configured.")
        return cls(
            amqp_url=str(settings.rabbitmq_url),
            mgmt_url=str(getattr(settings, "rabbitmq_mgmt_url", "") or ""),
            exchange_name=str(settings.rabbitmq_exchange),
            queue_name=str(settings.rabbitmq_queue),
            dlx_name=str(settings.rabbitmq_dlx),
            dlq_name=str(settings.rabbitmq_dlq),
            max_length_bytes=int(settings.rabbitmq_max_length_bytes),
            delivery_limit=int(settings.rabbitmq_delivery_limit),
            prefetch_count=int(settings.rabbitmq_prefetch),
            max_inflight_publishes=int(settings.rabbitmq_publisher_max_inflight),
            confirm_timeout_s=float(settings.rabbitmq_confirm_timeout_s),
            consumer_concurrency=int(getattr(settings, "ingestion_consumer_concurrency", 32) or 32),
        )


def tenant_routing_key(tenant_id: UUID) -> str:
    return f"telemetry.v1.{tenant_id.hex}"


def redact_amqp_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path or "/"
    if parsed.username or parsed.password:
        return f"{parsed.scheme}://***:***@{host}{port}{path}"
    return f"{parsed.scheme}://{host}{port}{path}"


@dataclass(slots=True)
class BrokerMetrics:
    published_ok: int = 0
    publish_backpressure: int = 0
    publish_errors: int = 0
    last_confirm_latency_ms: float | None = None
    consumed_ack: int = 0
    consumed_retry: int = 0
    consumed_dlq: int = 0


@dataclass(frozen=True, slots=True)
class BrokerHealthSnapshot:
    broker_ok: bool
    ready_count: int | None
    unacked_count: int | None
    dlq_count: int | None
    oldest_queued_age_s: float | None
    checked_at: datetime
    error: str | None = None
    warnings: list[str] = field(default_factory=list)


async def declare_telemetry_topology(
    channel: AbstractRobustChannel,
    cfg: BrokerConfig,
) -> tuple[AbstractRobustExchange, AbstractRobustQueue, AbstractRobustQueue]:
    """Declare durable topic ingress, Quorum ingest queue, and at-least-once Quorum DLX/DLQ."""
    dlx = await channel.declare_exchange(
        cfg.dlx_name,
        aio_pika.ExchangeType.DIRECT,
        durable=True,
    )

    async def _declare_quorum_queue(qname: str, args: dict[str, Any]) -> AbstractRobustQueue:
        for attempt in range(6):
            try:
                return await channel.declare_queue(qname, durable=True, arguments=args)
            except Exception as exc:
                if "cluster_not_formed" in str(exc) and attempt < 5:
                    logger.info("Raft cluster forming for quorum queue %s (attempt %d/5)...", qname, attempt + 1)
                    await asyncio.sleep(1.0)
                    continue
                raise
        return await channel.declare_queue(qname, durable=True, arguments=args)

    dlq = await _declare_quorum_queue(
        cfg.dlq_name,
        {
            "x-queue-type": "quorum",
            "x-max-length-bytes": int(cfg.dlq_max_length_bytes),
            "x-overflow": "reject-publish",
        },
    )
    await dlq.bind(dlx, routing_key=cfg.dlq_routing_key)

    ingress = await channel.declare_exchange(
        cfg.exchange_name,
        aio_pika.ExchangeType.TOPIC,
        durable=True,
    )
    queue_args: dict[str, Any] = {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": cfg.dlx_name,
        "x-dead-letter-routing-key": cfg.dlq_routing_key,
        "x-dead-letter-strategy": "at-least-once",
        "x-overflow": "reject-publish",
        "x-max-length-bytes": int(cfg.max_length_bytes),
        "x-delivery-limit": int(cfg.delivery_limit),
    }
    if cfg.max_length is not None:
        queue_args["x-max-length"] = int(cfg.max_length)
    queue = await _declare_quorum_queue(cfg.queue_name, queue_args)
    await queue.bind(ingress, routing_key=cfg.binding_pattern)
    return ingress, queue, dlq


async def connect_with_backoff(
    amqp_url: str,
    *,
    reconnect_interval_s: float = 2.0,
    max_attempts: int = 3,
    connect_timeout_s: float = 10.0,
) -> AbstractRobustConnection:
    last_exc: Exception | None = None
    delay = 0.25
    for attempt in range(1, max(1, max_attempts) + 1):
        try:
            conn = await aio_pika.connect_robust(
                amqp_url,
                timeout=connect_timeout_s,
                reconnect_interval=reconnect_interval_s,
            )
            return conn
        except (OSError, TimeoutError, aio_pika.exceptions.AMQPError, aiormq.exceptions.AMQPException) as exc:
            last_exc = exc
            if attempt >= max_attempts:
                break
            jitter = random.uniform(0.0, 0.2 * delay)
            await asyncio.sleep(min(delay + jitter, 5.0))
            delay *= 2.0
    raise BrokerUnavailableError(f"Failed connecting to RabbitMQ ({redact_amqp_url(amqp_url)}): {last_exc}") from last_exc


class RabbitMQPublisher:
    """Thread/async-safe durable publisher with publisher confirms and bounded in-flight semaphore."""

    def __init__(self, cfg: BrokerConfig) -> None:
        self.cfg = cfg
        self.metrics = BrokerMetrics()
        self._conn: AbstractRobustConnection | None = None
        self._channel: AbstractRobustChannel | None = None
        self._exchange: AbstractRobustExchange | None = None
        self._lock = asyncio.Lock()
        self._inflight = asyncio.Semaphore(cfg.max_inflight_publishes)

    async def start(self) -> None:
        async with self._lock:
            if self._exchange is not None and self._channel is not None and not self._channel.is_closed:
                return
            self._conn = await connect_with_backoff(
                self.cfg.amqp_url,
                reconnect_interval_s=self.cfg.reconnect_interval_s,
                max_attempts=3,
                connect_timeout_s=self.cfg.confirm_timeout_s,
            )
            self._channel = await self._conn.channel(publisher_confirms=True)  # type: ignore[assignment]
            self._exchange, _, _ = await declare_telemetry_topology(self._channel, self.cfg)

    async def close(self) -> None:
        async with self._lock:
            if self._channel is not None and not self._channel.is_closed:
                try:
                    await self._channel.close()
                except Exception:  # noqa: BLE001
                    logger.debug("Ignoring channel close failure during publisher shutdown", exc_info=True)
            if self._conn is not None and not self._conn.is_closed:
                try:
                    await self._conn.close()
                except Exception:  # noqa: BLE001
                    logger.debug("Ignoring connection close failure during publisher shutdown", exc_info=True)
            self._exchange = None
            self._channel = None
            self._conn = None

    async def __aenter__(self) -> "RabbitMQPublisher":
        await self.start()
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def _ensure_exchange(self) -> AbstractRobustExchange:
        if self._exchange is None or self._channel is None or self._channel.is_closed:
            await self.start()
        assert self._exchange is not None
        return self._exchange

    async def publish_observation(self, obs: CanonicalObservation) -> None:
        headers: dict[str, Any] = {
            "x-schema-version": int(obs.schema_version),
            "x-data-epoch": int(obs.data_epoch),
            "x-config-revision": int(obs.config_revision),
            "x-tenant-id": str(obs.tenant_id),
            "x-signal-id": str(obs.signal_id),
            "x-value-type": obs.value_type,
        }
        if obs.source_sequence is not None:
            headers["x-source-sequence"] = int(obs.source_sequence)
        await self.publish_bytes(
            payload=obs.to_json_bytes(),
            routing_key=tenant_routing_key(obs.tenant_id),
            message_id=obs.event_uid,
            correlation_id=obs.correlation_id,
            headers=headers,
        )

    async def publish_observations_partial(
        self,
        observations: Sequence[CanonicalObservation],
    ) -> tuple[list[str], list[tuple[CanonicalObservation, BrokerError]]]:
        """Publish observations concurrently (bounded by ``max_inflight_publishes``) with confirms.

        Returns ``(confirmed_event_uids, failed_items_with_errors)`` so outage spooling only
        stores observations that RabbitMQ did not confirm.
        """
        if not observations:
            return [], []
        results = await asyncio.gather(
            *(self.publish_observation(obs) for obs in observations),
            return_exceptions=True,
        )
        confirmed: list[str] = []
        failed: list[tuple[CanonicalObservation, BrokerError]] = []
        for obs, outcome in zip(observations, results):
            if outcome is None:
                confirmed.append(obs.event_uid)
            elif isinstance(outcome, BrokerError):
                failed.append((obs, outcome))
            elif isinstance(outcome, BaseException):
                failed.append((obs, BrokerUnavailableError(f"RabbitMQ publish failed for {obs.event_uid}: {outcome}")))
        return confirmed, failed

    async def publish_bytes(
        self,
        *,
        payload: bytes,
        routing_key: str,
        message_id: str,
        correlation_id: str | None = None,
        headers: dict[str, Any] | None = None,
        content_type: str = "application/json",
    ) -> None:
        async with self._inflight:
            exchange = await self._ensure_exchange()
            msg = aio_pika.Message(
                body=payload,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                content_type=content_type,
                message_id=message_id,
                correlation_id=correlation_id,
                timestamp=datetime.now(timezone.utc),
                headers=headers or {},
            )
            started = time.monotonic()
            try:
                await exchange.publish(
                    msg,
                    routing_key=routing_key,
                    mandatory=True,
                    timeout=self.cfg.confirm_timeout_s,
                )
            except (aiormq.exceptions.DeliveryError, aiormq.exceptions.PublishError) as exc:
                self.metrics.publish_backpressure += 1
                raise BrokerBackpressureError(f"RabbitMQ rejected message {message_id}: {exc}") from exc
            except (TimeoutError, aio_pika.exceptions.AMQPError, aiormq.exceptions.AMQPException, OSError) as exc:
                self.metrics.publish_errors += 1
                raise BrokerUnavailableError(f"RabbitMQ publish failed for {message_id}: {exc}") from exc
            self.metrics.published_ok += 1
            self.metrics.last_confirm_latency_ms = round((time.monotonic() - started) * 1000.0, 3)


MessageHandler = Callable[[AbstractIncomingMessage], Awaitable[ConsumeOutcome]]


class RabbitMQConsumer:
    """Manual-ACK Quorum Queue consumer with bounded QoS/concurrency and graceful drain."""

    def __init__(self, cfg: BrokerConfig, handler: MessageHandler) -> None:
        self.cfg = cfg
        self.handler = handler
        self.metrics = BrokerMetrics()
        self._conn: AbstractRobustConnection | None = None
        self._channel: AbstractRobustChannel | None = None
        self._queue: AbstractRobustQueue | None = None
        self._consumer_tag: str | None = None
        self._semaphore = asyncio.Semaphore(cfg.consumer_concurrency)
        self._inflight_tasks: set[asyncio.Task[Any]] = set()
        self._stopping = False

    async def start(self) -> None:
        self._stopping = False
        self._conn = await connect_with_backoff(
            self.cfg.amqp_url,
            reconnect_interval_s=self.cfg.reconnect_interval_s,
            max_attempts=5,
            connect_timeout_s=self.cfg.confirm_timeout_s,
        )
        self._channel = await self._conn.channel()  # type: ignore[assignment]
        await self._channel.set_qos(prefetch_count=self.cfg.prefetch_count)
        _, self._queue, _ = await declare_telemetry_topology(self._channel, self.cfg)
        self._consumer_tag = await self._queue.consume(self._on_message, no_ack=False)

    async def _on_message(self, message: AbstractIncomingMessage) -> None:
        if self._stopping:
            await message.nack(requeue=True)
            return
        task = asyncio.create_task(self._process_guarded(message))
        self._inflight_tasks.add(task)
        task.add_done_callback(self._inflight_tasks.discard)

    async def _process_guarded(self, message: AbstractIncomingMessage) -> None:
        async with self._semaphore:
            try:
                outcome = await self.handler(message)
            except asyncio.CancelledError:
                try:
                    await message.nack(requeue=True)
                except Exception:  # noqa: BLE001
                    pass
                raise
            except Exception:  # noqa: BLE001 - handler bug/transient error must requeue, never lose message
                logger.exception("Unhandled consumer exception; NACKing with requeue=True")
                outcome = ConsumeOutcome.RETRY

            if outcome == ConsumeOutcome.ACK:
                await message.ack()
                self.metrics.consumed_ack += 1
            elif outcome == ConsumeOutcome.RETRY:
                deliv_count = int(
                    (message.headers or {}).get("x-delivery-count")
                    or (message.headers or {}).get("x-acquired-count")
                    or 0
                )
                if self.cfg.delivery_limit and deliv_count >= self.cfg.delivery_limit:
                    logger.warning(
                        "Message %s exceeded delivery limit (%s >= %s); routing to DLQ",
                        message.message_id,
                        deliv_count,
                        self.cfg.delivery_limit,
                    )
                    await message.reject(requeue=False)
                    self.metrics.consumed_dlq += 1
                else:
                    await message.nack(requeue=True)
                    self.metrics.consumed_retry += 1
            elif outcome == ConsumeOutcome.DEAD_LETTER:
                await message.reject(requeue=False)
                self.metrics.consumed_dlq += 1

    async def stop(self, *, drain_timeout_s: float = 15.0) -> None:
        self._stopping = True
        if self._queue is not None and self._consumer_tag is not None:
            try:
                await self._queue.cancel(self._consumer_tag)
            except Exception:  # noqa: BLE001
                logger.debug("Ignoring consumer cancel error during shutdown", exc_info=True)
            self._consumer_tag = None
        if self._inflight_tasks:
            done, pending = await asyncio.wait(self._inflight_tasks, timeout=drain_timeout_s)
            del done
            for t in pending:
                t.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        if self._channel is not None and not self._channel.is_closed:
            try:
                await self._channel.close()
            except Exception:  # noqa: BLE001
                logger.debug("Ignoring consumer channel close error", exc_info=True)
        if self._conn is not None and not self._conn.is_closed:
            try:
                await self._conn.close()
            except Exception:  # noqa: BLE001
                logger.debug("Ignoring consumer connection close error", exc_info=True)


async def probe_broker_health(cfg: BrokerConfig) -> BrokerHealthSnapshot:
    """Measure AMQP reachability and inspect ready/unacked/DLQ counts + oldest age when available."""
    checked_at = datetime.now(timezone.utc)
    ready_count: int | None = None
    unacked_count: int | None = None
    dlq_count: int | None = None
    oldest_age_s: float | None = None
    warnings: list[str] = []

    try:
        conn = await aio_pika.connect(cfg.amqp_url, timeout=min(cfg.confirm_timeout_s, 5.0))
        try:
            channel = await conn.channel()
            try:
                q_res = await channel.declare_queue(cfg.queue_name, passive=True)
                ready_count = int(q_res.declaration_result.message_count or 0)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Primary queue {cfg.queue_name} unavailable: {exc}")
            try:
                dlq_res = await channel.declare_queue(cfg.dlq_name, passive=True)
                dlq_count = int(dlq_res.declaration_result.message_count or 0)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"DLQ {cfg.dlq_name} unavailable: {exc}")
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001
        return BrokerHealthSnapshot(
            broker_ok=False,
            ready_count=None,
            unacked_count=None,
            dlq_count=None,
            oldest_queued_age_s=None,
            checked_at=checked_at,
            error=str(exc),
            warnings=warnings,
        )

    if cfg.mgmt_url:
        parsed_amqp = urlparse(cfg.amqp_url)
        vhost = quote(parsed_amqp.path.lstrip("/") or "/", safe="")
        auth = (parsed_amqp.username, parsed_amqp.password or "") if parsed_amqp.username else None
        base = cfg.mgmt_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                resp = await client.get(f"{base}/api/queues/{vhost}/{quote(cfg.queue_name, safe='')}", auth=auth)
                if resp.status_code == 200:
                    data = resp.json()
                    # Keep synchronous AMQP queue.declare_ok message_count authoritative when
                    # available; Management HTTP stats lag up to ~5s behind real-time ACKs.
                    if ready_count is None:
                        ready_count = int(data.get("messages_ready", 0))
                    unacked_count = int(data.get("messages_unacknowledged", 0))
                    head_ts = data.get("head_message_timestamp")
                    if isinstance(head_ts, (int, float)) and head_ts > 0 and (ready_count or 0) > 0:
                        oldest_age_s = max(0.0, round(time.time() - float(head_ts), 3))
                    else:
                        oldest_age_s = 0.0 if ready_count == 0 else None
                dlq_resp = await client.get(f"{base}/api/queues/{vhost}/{quote(cfg.dlq_name, safe='')}", auth=auth)
                if dlq_resp.status_code == 200:
                    dlq_data = dlq_resp.json()
                    if dlq_count is None:
                        dlq_count = int(dlq_data.get("messages_ready", 0))
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Management HTTP probe unavailable: {exc}")

    return BrokerHealthSnapshot(
        broker_ok=True,
        ready_count=ready_count,
        unacked_count=unacked_count,
        dlq_count=dlq_count,
        oldest_queued_age_s=oldest_age_s,
        checked_at=checked_at,
        warnings=warnings,
    )
