"""Ingestion pipeline stage 'decode': AMQP delivery intake (v1 single / v2 batch envelopes), settle and quarantine. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from aio_pika.abc import AbstractIncomingMessage

from factorix.domain.canonical import (
    OBS_BATCH_CONTENT_TYPE,
    OBS_BATCH_HEADER,
    OBS_BATCH_HEADER_VALUE,
    OBS_BATCH_SCHEMA,
    decode_observation_batch,
)
from factorix.domain.observation import ObservationError
from factorix.platform.broker import ConsumeOutcome

from factorix.application.ingestion.common import (
    LANE_LEGACY,
    LANE_LIVE,
    MAX_BATCH_MESSAGE_BYTES,
    MAX_MESSAGE_BYTES,
    _utcnow,
    logger,
)
from factorix.application.ingestion.envelope import _PendingEnvelope


class _DecodeStage:
    """IngestionWorker part: AMQP delivery intake and settle."""

    async def handle_live_message(self, message: AbstractIncomingMessage) -> ConsumeOutcome:
        return await self._enqueue_incoming_message(message, lane="live")

    async def handle_legacy_message(self, message: AbstractIncomingMessage) -> ConsumeOutcome:
        return await self._enqueue_incoming_message(message, lane="legacy")

    async def handle_message(self, message: AbstractIncomingMessage) -> ConsumeOutcome:
        """RabbitMQConsumer message handler. Resolves only after durable storage or permanent quarantine."""
        rkey = str(getattr(message, "routing_key", "") or "")
        lane = "live" if rkey.startswith("telemetry.live.v1.") else "legacy"
        return await self._enqueue_incoming_message(message, lane=lane)

    @staticmethod
    def _is_batch_message(message: AbstractIncomingMessage, headers: Mapping[str, Any], raw_body: bytes) -> bool:
        if headers.get(OBS_BATCH_HEADER) == OBS_BATCH_HEADER_VALUE:
            return True
        if getattr(message, "content_type", None) == OBS_BATCH_CONTENT_TYPE:
            return True
        # Header-less fallback (e.g. re-published from the DLQ by an operator).
        return f'"schema":"{OBS_BATCH_SCHEMA}"'.encode() in raw_body[:64]

    async def _enqueue_incoming_message(self, message: AbstractIncomingMessage, lane: str = "live") -> ConsumeOutcome:
        """Consume one AMQP message: a legacy v1 observation or a v2 batch envelope.

        The message settles only after every contained observation is durably stored (or
        quarantined with durable evidence). Outcome per message: any item RETRY -> RETRY
        (redelivery is idempotent by event_uid); per-item rejects inside a batch are kept as
        quarantine rows and the message is ACKed; if such evidence could not be written the
        message is retried (and after the delivery limit dead-lettered whole to the DLQ).
        """
        lane = LANE_LIVE if lane == LANE_LIVE else LANE_LEGACY
        self.metrics.received_total += 1
        raw_body = bytes(message.body)
        headers = dict(message.headers or {})
        is_batch = self._is_batch_message(message, headers, raw_body)
        limit = MAX_BATCH_MESSAGE_BYTES if is_batch else MAX_MESSAGE_BYTES
        message_id = str(message.message_id) if message.message_id else None
        if len(raw_body) > limit:
            tid = self._header_tenant_uuid(headers)
            uid = str(message_id or "oversize")[:256]
            await self._safe_quarantine(
                tenant_id=tid,
                edge_id=None,
                event_uid=uid,
                reason=f"OVERSIZE_PAYLOAD: {len(raw_body)} bytes > {limit}",
                payload={"bytes": len(raw_body)},
            )
            self.metrics.dlq_total += 1
            return ConsumeOutcome.DEAD_LETTER

        loop = asyncio.get_running_loop()
        ingested_at = _utcnow()
        redelivered = bool(getattr(message, "redelivered", False))
        try:
            delivery_count = int(headers.get("x-delivery-count") or 0)
        except (TypeError, ValueError):
            delivery_count = 0
        envelopes: list[_PendingEnvelope] = []
        if is_batch:
            try:
                batch = decode_observation_batch(raw_body)
            except ObservationError as exc:
                tid = self._header_tenant_uuid(headers)
                await self._safe_quarantine(
                    tenant_id=tid,
                    edge_id=None,
                    event_uid=str(message_id or "invalid-batch")[:256],
                    reason=f"INVALID_BATCH ({exc.code}): {exc}",
                    payload={"message_id": message_id, "bytes": len(raw_body)},
                )
                self.metrics.dlq_total += 1
                # The whole envelope goes to the DLQ: the durable copy is the evidence.
                return ConsumeOutcome.DEAD_LETTER
            self.envelopes_received += 1
            for index, item in enumerate(batch.items):
                uid = item.get("event_uid") if isinstance(item, Mapping) else None
                envelopes.append(
                    _PendingEnvelope(
                        raw_body=b"",
                        message_id=str(uid or f"{batch.batch_id}#{index}")[:256],
                        headers=headers,
                        redelivered=redelivered,
                        ingested_at=ingested_at,
                        future=loop.create_future(),
                        payload=item,
                        batch_tenant=batch.tenant_id,
                        delivery_count=delivery_count,
                        lane=lane,
                    )
                )
            # Each additional item is an observation received inside this message.
            self.metrics.received_total += len(envelopes) - 1
        else:
            envelopes.append(
                _PendingEnvelope(
                    raw_body=raw_body,
                    message_id=message_id,
                    headers=headers,
                    redelivered=redelivered,
                    ingested_at=ingested_at,
                    future=loop.create_future(),
                    delivery_count=delivery_count,
                    lane=lane,
                )
            )

        queue = self._pending_live if lane == LANE_LIVE else self._pending_legacy
        wake_size = self._live_wake_size if lane == LANE_LIVE else self._legacy_wake_size
        async with self._pending_lock:
            queue.extend(envelopes)
            self._lane_waiting_msgs[lane] += 1
            should_wake = len(queue) >= self.batch_size or self._lane_waiting_msgs[lane] >= max(1, wake_size)
        if should_wake:
            (self._wake_live if lane == LANE_LIVE else self._wake_legacy).set()
        try:
            outcomes = [await env.future for env in envelopes]
        finally:
            self._lane_waiting_msgs[lane] = max(0, self._lane_waiting_msgs[lane] - 1)
        return self._aggregate_outcome(envelopes, outcomes)

    def _aggregate_outcome(self, envelopes: Sequence[_PendingEnvelope], outcomes: Sequence[ConsumeOutcome]) -> ConsumeOutcome:
        if len(outcomes) == 1:
            if envelopes[0].payload is not None and outcomes[0] == ConsumeOutcome.DEAD_LETTER:
                return self._settle_batch_rejects(envelopes, outcomes)
            return outcomes[0]
        if any(outcome == ConsumeOutcome.RETRY for outcome in outcomes):
            self._discard_quarantine_marks(envelopes)
            return ConsumeOutcome.RETRY
        return self._settle_batch_rejects(envelopes, outcomes)

    def _settle_batch_rejects(self, envelopes: Sequence[_PendingEnvelope], outcomes: Sequence[ConsumeOutcome]) -> ConsumeOutcome:
        """Per-item rejects in a batch: ACK when their quarantine evidence is durable, else retry."""
        missing_evidence = any(
            outcome == ConsumeOutcome.DEAD_LETTER and (env.message_id or "") in self._quarantine_failed
            for env, outcome in zip(envelopes, outcomes)
        )
        self._discard_quarantine_marks(envelopes)
        return ConsumeOutcome.RETRY if missing_evidence else ConsumeOutcome.ACK

    def _discard_quarantine_marks(self, envelopes: Sequence[_PendingEnvelope]) -> None:
        if self._quarantine_failed:
            for env in envelopes:
                self._quarantine_failed.discard(env.message_id or "")

    async def ingest_direct_bytes(
        self,
        items: Sequence[tuple[bytes, dict[str, Any] | None, str | None, bool]],
    ) -> list[ConsumeOutcome]:
        """Synchronously process a list of ``(raw_bytes, headers, message_id, redelivered)`` for tests/replays."""
        loop = asyncio.get_running_loop()
        envelopes: list[_PendingEnvelope] = []
        pre_outcomes: dict[int, ConsumeOutcome] = {}
        now = _utcnow()
        for idx, (raw_body, headers, msg_id, redelivered) in enumerate(items):
            if len(raw_body) > MAX_MESSAGE_BYTES:
                tid = self._header_tenant_uuid(headers or {})
                await self._safe_quarantine(
                    tenant_id=tid,
                    edge_id=None,
                    event_uid=str(msg_id or "oversize")[:256],
                    reason=f"OVERSIZE_PAYLOAD: {len(raw_body)} bytes > {MAX_MESSAGE_BYTES}",
                    payload={"bytes": len(raw_body)},
                )
                self.metrics.dlq_total += 1
                pre_outcomes[idx] = ConsumeOutcome.DEAD_LETTER
                continue
            env = _PendingEnvelope(
                raw_body=raw_body,
                message_id=msg_id,
                headers=headers or {},
                redelivered=redelivered,
                ingested_at=now,
                future=loop.create_future(),
            )
            envelopes.append(env)
        if envelopes:
            await self._process_batch(envelopes)
        outcomes: list[ConsumeOutcome] = []
        env_iter = iter(envelopes)
        for idx in range(len(items)):
            if idx in pre_outcomes:
                outcomes.append(pre_outcomes[idx])
            else:
                outcomes.append(next(env_iter).future.result())
        return outcomes

    @staticmethod
    def _header_tenant_uuid(headers: Mapping[str, Any] | None) -> UUID:
        if headers and headers.get("x-tenant-id"):
            try:
                return UUID(str(headers["x-tenant-id"]))
            except ValueError:
                pass
        return UUID(int=0)

    async def _safe_quarantine(
        self,
        *,
        tenant_id: UUID,
        edge_id: UUID | None,
        event_uid: str,
        reason: str,
        payload: dict[str, Any],
    ) -> None:
        try:
            await self.pg.write_quarantine(
                tenant_id=tenant_id,
                edge_id=edge_id,
                event_uid=event_uid,
                reason=reason,
                payload=payload,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to record quarantine entry (%s): %s", event_uid, type(exc).__name__)
            if len(self._quarantine_failed) < 100_000:
                self._quarantine_failed.add(str(event_uid))
