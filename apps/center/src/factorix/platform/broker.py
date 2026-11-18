"""RabbitMQ Quorum Queue transport library for FactoriX telemetry (§4, ADR-001).

Provides durable ingress topology declaration, publisher-confirmed publishing
with explicit ``reject-publish`` backpressure handling, bounded manual-ACK
consumers with graceful drain, and AMQP / Management HTTP health inspection.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from urllib.parse import quote, urlparse
from uuid import UUID, uuid4

import aio_pika
import aiormq.exceptions
import httpx
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustChannel, AbstractRobustConnection, AbstractRobustExchange, AbstractRobustQueue

from factorix.domain.canonical import (
    OBS_BATCH_CONTENT_TYPE,
    OBS_BATCH_ENVELOPE_VERSION,
    OBS_BATCH_HEADER,
    OBS_BATCH_HEADER_VALUE,
    OBS_BATCH_SCHEMA,
    CanonicalObservation,
)

logger = logging.getLogger(__name__)

_URL_CREDENTIALS_RE = re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://)([^/@\s:]+)(:[^/@\s]*)?@")


def scrub_secrets(text: Any) -> str:
    """Remove URL userinfo (``scheme://user:pass@``) from arbitrary error text before it is logged or stored."""
    return _URL_CREDENTIALS_RE.sub(r"\1***:***@", str(text))


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


class BrokerError(RuntimeError):
    """Base error raised by the RabbitMQ transport layer."""


class BrokerUnavailableError(BrokerError):
    """Broker connection or channel could not be established or confirmed within timeout."""


class BrokerBackpressureError(BrokerError):
    """Broker rejected a publish, for example because a queue reached its limit."""


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
    live_queue_name: str = "factorix.telemetry.live.q"
    dlx_name: str = "factorix.telemetry.dlx"
    dlq_name: str = "factorix.telemetry.dlq"
    binding_pattern: str = "telemetry.v1.*"
    live_binding_pattern: str = "telemetry.live.v1.*"
    dlq_routing_key: str = "dlq"
    max_length_bytes: int = 512 * 1024 * 1024
    live_max_length_bytes: int = 256 * 1024 * 1024
    dlq_max_length_bytes: int = 256 * 1024 * 1024
    max_length: int | None = None
    delivery_limit: int = 5
    prefetch_count: int = 128
    live_prefetch_count: int = 256
    freshness_window_s: float = 12.0
    max_inflight_publishes: int = 64
    confirm_timeout_s: float = 10.0
    consumer_concurrency: int = 32
    live_consumer_concurrency: int = 256
    reconnect_interval_s: float = 2.0
    # Wire format of the publisher: "batch" = v2 envelopes (default), "single" = legacy one-message-per-observation.
    envelope_mode: str = field(default_factory=lambda: os.environ.get("FACTORIX_PUBLISH_ENVELOPE", "batch").strip().lower() or "batch")
    batch_max_obs: int = field(default_factory=lambda: _env_int("FACTORIX_PUBLISH_BATCH_MAX_OBS", 500))
    batch_max_bytes: int = field(default_factory=lambda: _env_int("FACTORIX_PUBLISH_BATCH_MAX_BYTES", 192 * 1024, minimum=4096))

    @classmethod
    def from_settings(cls, settings: Any) -> "BrokerConfig":
        if not getattr(settings, "rabbitmq_url", ""):
            raise BrokerUnavailableError("FACTORIX_RABBITMQ_URL is not configured.")
        return cls(
            amqp_url=str(settings.rabbitmq_url),
            mgmt_url=str(getattr(settings, "rabbitmq_mgmt_url", "") or ""),
            exchange_name=str(settings.rabbitmq_exchange),
            queue_name=str(settings.rabbitmq_queue),
            live_queue_name=str(getattr(settings, "rabbitmq_live_queue", "factorix.telemetry.live.q") or "factorix.telemetry.live.q"),
            dlx_name=str(settings.rabbitmq_dlx),
            dlq_name=str(settings.rabbitmq_dlq),
            binding_pattern=str(getattr(settings, "rabbitmq_binding_pattern", "telemetry.v1.*") or "telemetry.v1.*"),
            live_binding_pattern=str(getattr(settings, "rabbitmq_live_binding_pattern", "telemetry.live.v1.*") or "telemetry.live.v1.*"),
            max_length_bytes=int(settings.rabbitmq_max_length_bytes),
            live_max_length_bytes=int(getattr(settings, "rabbitmq_live_max_length_bytes", 256 * 1024 * 1024) or 256 * 1024 * 1024),
            delivery_limit=int(settings.rabbitmq_delivery_limit),
            prefetch_count=int(settings.rabbitmq_prefetch),
            live_prefetch_count=int(settings.rabbitmq_live_prefetch),
            freshness_window_s=float(getattr(settings, "rabbitmq_freshness_window_s", 12.0) or 12.0),
            max_inflight_publishes=int(settings.rabbitmq_publisher_max_inflight),
            confirm_timeout_s=float(settings.rabbitmq_confirm_timeout_s),
            consumer_concurrency=int(getattr(settings, "ingestion_consumer_concurrency", 32) or 32),
            live_consumer_concurrency=int(settings.ingestion_live_consumer_concurrency),
        )


def tenant_routing_key(tenant_id: UUID) -> str:
    return f"telemetry.v1.{tenant_id.hex}"


def tenant_live_routing_key(tenant_id: UUID) -> str:
    return f"telemetry.live.v1.{tenant_id.hex}"


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
    live_ready_count: int | None = None
    live_unacked_count: int | None = None
    legacy_ready_count: int | None = None
    legacy_unacked_count: int | None = None


class TelemetryTopology(tuple):
    """3-tuple (ingress, queue, dlq) with live_queue property for two-lane topology."""

    def __new__(
        cls,
        ingress: AbstractRobustExchange,
        queue: AbstractRobustQueue,
        dlq: AbstractRobustQueue,
        live_queue: AbstractRobustQueue | None = None,
    ) -> "TelemetryTopology":
        instance = super().__new__(cls, (ingress, queue, dlq))
        instance._live_queue = live_queue
        return instance

    @property
    def ingress(self) -> AbstractRobustExchange:
        return self[0]

    @property
    def queue(self) -> AbstractRobustQueue:
        return self[1]

    @property
    def dlq(self) -> AbstractRobustQueue:
        return self[2]

    @property
    def live_queue(self) -> AbstractRobustQueue | None:
        return self._live_queue


async def declare_telemetry_topology(
    channel: AbstractRobustChannel,
    cfg: BrokerConfig,
) -> TelemetryTopology:
    """Declare durable topic ingress, legacy + live Quorum queues, and at-least-once Quorum DLX/DLQ."""
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
    queue: Any = None
    if cfg.queue_name != cfg.live_queue_name:
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

    # Two-lane architecture: declare and bind live quorum queue
    live_queue_args: dict[str, Any] = {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": cfg.dlx_name,
        "x-dead-letter-routing-key": cfg.dlq_routing_key,
        "x-dead-letter-strategy": "at-least-once",
        "x-overflow": "reject-publish",
        "x-max-length-bytes": int(cfg.live_max_length_bytes),
        "x-delivery-limit": int(cfg.delivery_limit),
    }
    live_queue = await _declare_quorum_queue(cfg.live_queue_name, live_queue_args)
    await live_queue.bind(ingress, routing_key=cfg.live_binding_pattern)

    if queue is None:
        queue = live_queue

    return TelemetryTopology(ingress, queue, dlq, live_queue)


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
    raise BrokerUnavailableError(
        f"Failed connecting to RabbitMQ ({redact_amqp_url(amqp_url)}): {scrub_secrets(last_exc)}"
    ) from last_exc


@dataclass(slots=True)
class _Envelope:
    """One AMQP message: either a v2 batch of observations or (legacy mode) a single v1 observation."""

    observations: list[CanonicalObservation]
    routing_key: str
    body: bytes
    message_id: str
    headers: dict[str, Any]
    content_type: str
    correlation_id: str | None = None


class RabbitMQPublisher:
    """Durable publisher with publisher confirms and a sliding window of in-flight envelopes.

    ``publish_observations_partial`` packs observations into v2 batch envelopes (one AMQP
    message per tenant/lane chunk, bounded by ``batch_max_obs`` / ``batch_max_bytes``) and
    publishes them concurrently, at most ``max_inflight_publishes`` unconfirmed at a time.
    Each envelope has its own confirm timeout; there is no batch-wide deadline that cancels
    already-sent messages. When an envelope fails because the broker is unreachable, the
    envelopes that were not sent yet fail fast without waiting for their own timeout, so a
    stalled connection costs one timeout per call, not one per wave.
    """

    def __init__(self, cfg: BrokerConfig) -> None:
        self.cfg = cfg
        self.metrics = BrokerMetrics()
        self._conn: AbstractRobustConnection | None = None
        self._channel: AbstractRobustChannel | None = None
        self._exchange: AbstractRobustExchange | None = None
        self._lock = asyncio.Lock()
        self._inflight = asyncio.Semaphore(max(1, int(cfg.max_inflight_publishes)))
        self._reconnect_listeners: list[Callable[[], None]] = []
        self.envelopes_published = 0
        self.observations_published = 0

    def add_reconnect_listener(self, callback: Callable[[], None]) -> None:
        """Register a callback fired when the robust connection re-establishes itself."""
        self._reconnect_listeners.append(callback)

    def _fire_reconnect(self, *_args: Any, **_kwargs: Any) -> None:
        for callback in list(self._reconnect_listeners):
            try:
                callback()
            except Exception:  # noqa: BLE001
                logger.debug("Reconnect listener failed", exc_info=True)

    async def start(self) -> None:
        async with self._lock:
            if self._exchange is not None and self._channel is not None and not self._channel.is_closed:
                return
            conn = self._conn
            if conn is not None and getattr(conn, "is_closed", True):
                # Never leak a dead connection when replacing it (A-P2-10).
                try:
                    await conn.close()
                except Exception:  # noqa: BLE001
                    logger.debug("Ignoring close failure of a dead publisher connection", exc_info=True)
                conn = None
            if conn is None:
                conn = await connect_with_backoff(
                    self.cfg.amqp_url,
                    reconnect_interval_s=self.cfg.reconnect_interval_s,
                    max_attempts=3,
                    connect_timeout_s=self.cfg.confirm_timeout_s,
                )
                callbacks = getattr(conn, "reconnect_callbacks", None)
                if callbacks is not None and hasattr(callbacks, "add"):
                    try:
                        callbacks.add(self._fire_reconnect)
                    except Exception:  # noqa: BLE001
                        logger.debug("Robust reconnect callback registration failed", exc_info=True)
                self._conn = conn
            self._channel = await conn.channel(publisher_confirms=True, on_return_raises=True)  # type: ignore[assignment]
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

    # ------------------------------------------------------------------ routing & encoding

    def _routing_key_for(self, obs: CanonicalObservation, now: datetime) -> str:
        acq_at = obs.acquired_at if obs.acquired_at.tzinfo else obs.acquired_at.replace(tzinfo=timezone.utc)
        age_s = (now - acq_at).total_seconds()
        if 0.0 <= age_s <= float(getattr(self.cfg, "freshness_window_s", 12.0)):
            return tenant_live_routing_key(obs.tenant_id)
        return tenant_routing_key(obs.tenant_id)

    @staticmethod
    def _single_headers(obs: CanonicalObservation) -> dict[str, Any]:
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
        return headers

    def _single_envelope(self, obs: CanonicalObservation, routing_key: str) -> _Envelope:
        return _Envelope(
            observations=[obs],
            routing_key=routing_key,
            body=obs.to_json_bytes(),
            message_id=obs.event_uid,
            headers=self._single_headers(obs),
            content_type="application/json",
            correlation_id=obs.correlation_id,
        )

    def build_envelopes(self, observations: Sequence[CanonicalObservation]) -> list[_Envelope]:
        """Group observations by (tenant, lane) preserving order and cut them into bounded envelopes."""
        now = datetime.now(timezone.utc)
        if self.cfg.envelope_mode == "single":
            return [self._single_envelope(obs, self._routing_key_for(obs, now)) for obs in observations]

        max_obs = max(1, int(self.cfg.batch_max_obs))
        max_bytes = max(4096, int(self.cfg.batch_max_bytes))
        created = now.isoformat().replace("+00:00", "Z")
        # (tenant, routing_key) -> [observations, encoded items, approx bytes]
        groups: dict[tuple[UUID, str], list[Any]] = {}
        out: list[_Envelope] = []

        def close(key: tuple[UUID, str]) -> None:
            obs_list, parts, _size = groups.pop(key)
            if obs_list:
                out.append(self._batch_envelope(key[0], key[1], obs_list, parts, created))

        for obs in observations:
            rkey = self._routing_key_for(obs, now)
            key = (obs.tenant_id, rkey)
            encoded = json.dumps(obs.to_compact_dict(), separators=(",", ":"), ensure_ascii=False, allow_nan=False)
            item_bytes = len(encoded) if encoded.isascii() else len(encoded.encode("utf-8"))
            current = groups.get(key)
            if current is not None and (len(current[0]) >= max_obs or current[2] + item_bytes + 1 > max_bytes):
                close(key)
                current = None
            if current is None:
                current = [[], [], 256]
                groups[key] = current
            current[0].append(obs)
            current[1].append(encoded)
            current[2] += item_bytes + 1
        for key in list(groups):
            close(key)
        return out

    @staticmethod
    def _batch_envelope(
        tenant_id: UUID, routing_key: str, obs_list: list[CanonicalObservation], parts: list[str], created: str
    ) -> _Envelope:
        batch_id = f"fxb-{uuid4().hex}"
        head = json.dumps(
            {
                "schema": OBS_BATCH_SCHEMA,
                "envelope_version": OBS_BATCH_ENVELOPE_VERSION,
                "batch_id": batch_id,
                "tenant_id": str(tenant_id),
                "created_at": created,
                "count": len(obs_list),
            },
            separators=(",", ":"),
        )
        body = (head[:-1] + ',"observations":[' + ",".join(parts) + "]}").encode("utf-8")
        first = obs_list[0]
        return _Envelope(
            observations=obs_list,
            routing_key=routing_key,
            body=body,
            message_id=batch_id,
            headers={
                OBS_BATCH_HEADER: OBS_BATCH_HEADER_VALUE,
                "x-tenant-id": str(tenant_id),
                "x-data-epoch": int(first.data_epoch),
                "x-observation-count": len(obs_list),
            },
            content_type=OBS_BATCH_CONTENT_TYPE,
        )

    # ------------------------------------------------------------------ publishing

    async def publish_observation(self, obs: CanonicalObservation, routing_key: str | None = None) -> None:
        """Publish ONE observation as a legacy v1 message (tools/tests; the hot path sends envelopes)."""
        if routing_key is None:
            routing_key = self._routing_key_for(obs, datetime.now(timezone.utc))
        await self.publish_bytes(
            payload=obs.to_json_bytes(),
            routing_key=routing_key,
            message_id=obs.event_uid,
            correlation_id=obs.correlation_id,
            headers=self._single_headers(obs),
        )

    async def publish_observations_partial(
        self,
        observations: Sequence[CanonicalObservation],
    ) -> tuple[list[str], list[tuple[CanonicalObservation, BrokerError]]]:
        """Publish observations as confirmed envelopes through the sliding window.

        Returns ``(confirmed_event_uids, failed_items_with_errors)`` so the caller spools only
        observations whose envelope RabbitMQ did not confirm. Both lists keep input order.
        """
        if not observations:
            return [], []
        envelopes = self.build_envelopes(observations)
        results = await self.publish_envelopes(envelopes)
        order = {obs.event_uid: idx for idx, obs in enumerate(observations)}
        confirmed: list[str] = []
        failed: list[tuple[CanonicalObservation, BrokerError]] = []
        for env, error in zip(envelopes, results):
            if error is None:
                confirmed.extend(obs.event_uid for obs in env.observations)
            else:
                failed.extend((obs, error) for obs in env.observations)
        confirmed.sort(key=lambda uid: order.get(uid, 0))
        failed.sort(key=lambda item: order.get(item[0].event_uid, 0))
        return confirmed, failed

    async def publish_envelopes(self, envelopes: Sequence[_Envelope]) -> list[BrokerError | None]:
        """Publish envelopes concurrently (window = ``max_inflight_publishes``); one result per envelope."""
        results: list[BrokerError | None] = [None] * len(envelopes)
        abort: list[BrokerError] = []

        async def one(index: int, env: _Envelope) -> None:
            if abort:
                results[index] = self._not_attempted(env, abort[0])
                return
            async with self._inflight:
                if abort:
                    results[index] = self._not_attempted(env, abort[0])
                    return
                try:
                    await self._publish_unbounded(
                        payload=env.body,
                        routing_key=env.routing_key,
                        message_id=env.message_id,
                        correlation_id=env.correlation_id,
                        headers=env.headers,
                        content_type=env.content_type,
                    )
                except BrokerBackpressureError as exc:
                    # Queue full: the other lane may still accept, keep publishing it.
                    results[index] = exc
                except BrokerError as exc:
                    if not abort:
                        abort.append(exc)
                    results[index] = exc
                else:
                    self.envelopes_published += 1
                    self.observations_published += len(env.observations)

        if len(envelopes) == 1:
            await one(0, envelopes[0])
            return results
        tasks = [asyncio.create_task(one(i, env)) for i, env in enumerate(envelopes)]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        return results

    def _not_attempted(self, env: _Envelope, cause: BrokerError) -> BrokerError:
        self.metrics.publish_errors += 1
        error = BrokerUnavailableError(f"RabbitMQ unavailable; envelope {env.message_id} not attempted: {cause}")
        error.__cause__ = cause.__cause__ or cause
        return error

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
            await self._publish_unbounded(
                payload=payload,
                routing_key=routing_key,
                message_id=message_id,
                correlation_id=correlation_id,
                headers=headers,
                content_type=content_type,
            )

    async def _publish_unbounded(
        self,
        *,
        payload: bytes,
        routing_key: str,
        message_id: str,
        correlation_id: str | None = None,
        headers: dict[str, Any] | None = None,
        content_type: str = "application/json",
    ) -> None:
        try:
            exchange = await self._ensure_exchange()
        except BrokerError:
            self.metrics.publish_errors += 1
            raise
        except (TimeoutError, aio_pika.exceptions.AMQPError, aiormq.exceptions.AMQPException, OSError) as exc:
            self.metrics.publish_errors += 1
            raise BrokerUnavailableError(f"RabbitMQ channel unavailable: {scrub_secrets(exc)}") from exc
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
        except aiormq.exceptions.PublishError as exc:
            self.metrics.publish_errors += 1
            raise BrokerUnavailableError(f"RabbitMQ could not route message {message_id}: {scrub_secrets(exc)}") from exc
        except aiormq.exceptions.DeliveryError as exc:
            self.metrics.publish_backpressure += 1
            raise BrokerBackpressureError(f"RabbitMQ rejected message {message_id}: {scrub_secrets(exc)}") from exc
        except (TimeoutError, aio_pika.exceptions.AMQPError, aiormq.exceptions.AMQPException, OSError) as exc:
            self.metrics.publish_errors += 1
            raise BrokerUnavailableError(f"RabbitMQ publish failed for {message_id}: {scrub_secrets(exc)}") from exc
        self.metrics.published_ok += 1
        self.metrics.last_confirm_latency_ms = round((time.monotonic() - started) * 1000.0, 3)


MessageHandler = Callable[[AbstractIncomingMessage], Awaitable[ConsumeOutcome]]


class RabbitMQConsumer:
    """Manual-ACK Quorum Queue consumer with bounded QoS/concurrency and graceful drain."""

    def __init__(
        self,
        cfg: BrokerConfig,
        handler: MessageHandler,
        *,
        queue_name: str | None = None,
    ) -> None:
        self.cfg = cfg
        self.handler = handler
        self.target_queue_name = queue_name or cfg.queue_name
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
        topology = await declare_telemetry_topology(self._channel, self.cfg)
        live_q = getattr(topology, "live_queue", None)
        if live_q is None and len(topology) >= 4:
            live_q = topology[3]
        legacy_q = getattr(topology, "queue", topology[1])

        if (self.target_queue_name == self.cfg.live_queue_name or self.cfg.queue_name == self.cfg.live_queue_name) and live_q is not None:
            self._queue = live_q
        else:
            self._queue = legacy_q
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

            try:
                await self._settle(message, outcome)
            except Exception as exc:  # noqa: BLE001 - channel lost after processing; broker redelivers unacked
                logger.warning(
                    "Could not settle message %s (%s): %s; it will be redelivered",
                    message.message_id,
                    outcome,
                    scrub_secrets(exc),
                )

    async def _settle(self, message: AbstractIncomingMessage, outcome: ConsumeOutcome) -> None:
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
    """Measure AMQP reachability and inspect ready/unacked/DLQ counts + oldest age for both live & legacy queues."""
    checked_at = datetime.now(timezone.utc)
    legacy_ready: int | None = None
    live_ready: int | None = None
    legacy_unacked: int | None = None
    live_unacked: int | None = None
    dlq_count: int | None = None
    oldest_age_s: float | None = None
    warnings: list[str] = []

    try:
        conn = await aio_pika.connect(cfg.amqp_url, timeout=min(cfg.confirm_timeout_s, 5.0))
        try:
            channel = await conn.channel()
            try:
                q_res = await channel.declare_queue(cfg.queue_name, passive=True)
                legacy_ready = int(q_res.declaration_result.message_count or 0)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Legacy queue {cfg.queue_name} unavailable: {scrub_secrets(exc)}")
            try:
                live_res = await channel.declare_queue(cfg.live_queue_name, passive=True)
                live_ready = int(live_res.declaration_result.message_count or 0)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Live queue {cfg.live_queue_name} unavailable: {scrub_secrets(exc)}")
            try:
                dlq_res = await channel.declare_queue(cfg.dlq_name, passive=True)
                dlq_count = int(dlq_res.declaration_result.message_count or 0)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"DLQ {cfg.dlq_name} unavailable: {scrub_secrets(exc)}")
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
            error=scrub_secrets(exc),
            warnings=warnings,
            live_ready_count=None,
            live_unacked_count=None,
            legacy_ready_count=None,
            legacy_unacked_count=None,
        )

    if cfg.mgmt_url:
        parsed_amqp = urlparse(cfg.amqp_url)
        vhost = quote(parsed_amqp.path.lstrip("/") or "/", safe="")
        auth = (parsed_amqp.username, parsed_amqp.password or "") if parsed_amqp.username else None
        base = cfg.mgmt_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                # Query legacy queue
                resp = await client.get(f"{base}/api/queues/{vhost}/{quote(cfg.queue_name, safe='')}", auth=auth)
                if resp.status_code == 200:
                    data = resp.json()
                    if legacy_ready is None:
                        legacy_ready = int(data.get("messages_ready", 0))
                    legacy_unacked = int(data.get("messages_unacknowledged", 0))
                    head_ts = data.get("head_message_timestamp")
                    if isinstance(head_ts, (int, float)) and head_ts > 0 and (legacy_ready or 0) > 0:
                        oldest_age_s = max(0.0, round(time.time() - float(head_ts), 3))
                    elif legacy_ready == 0 and oldest_age_s is None:
                        oldest_age_s = 0.0

                # Query live queue
                live_resp = await client.get(f"{base}/api/queues/{vhost}/{quote(cfg.live_queue_name, safe='')}", auth=auth)
                if live_resp.status_code == 200:
                    live_data = live_resp.json()
                    if live_ready is None:
                        live_ready = int(live_data.get("messages_ready", 0))
                    live_unacked = int(live_data.get("messages_unacknowledged", 0))
                    live_head_ts = live_data.get("head_message_timestamp")
                    if isinstance(live_head_ts, (int, float)) and live_head_ts > 0 and (live_ready or 0) > 0:
                        live_age = max(0.0, round(time.time() - float(live_head_ts), 3))
                        oldest_age_s = max(oldest_age_s or 0.0, live_age)

                # Query DLQ
                dlq_resp = await client.get(f"{base}/api/queues/{vhost}/{quote(cfg.dlq_name, safe='')}", auth=auth)
                if dlq_resp.status_code == 200:
                    dlq_data = dlq_resp.json()
                    if dlq_count is None:
                        dlq_count = int(dlq_data.get("messages_ready", 0))
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Management HTTP probe unavailable: {scrub_secrets(exc)}")

    # Total combined ready and unacked for backwards compatibility
    total_ready = None
    if legacy_ready is not None or live_ready is not None:
        total_ready = (legacy_ready or 0) + (live_ready or 0)

    total_unacked = None
    if legacy_unacked is not None or live_unacked is not None:
        total_unacked = (legacy_unacked or 0) + (live_unacked or 0)

    return BrokerHealthSnapshot(
        broker_ok=True,
        ready_count=total_ready,
        unacked_count=total_unacked,
        dlq_count=dlq_count,
        oldest_queued_age_s=oldest_age_s,
        checked_at=checked_at,
        warnings=warnings,
        live_ready_count=live_ready,
        live_unacked_count=live_unacked,
        legacy_ready_count=legacy_ready,
        legacy_unacked_count=legacy_unacked,
    )
