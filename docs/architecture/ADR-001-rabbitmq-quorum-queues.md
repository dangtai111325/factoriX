# ADR-001: RabbitMQ 4.0 Quorum Queues as Durable Telemetry Transport

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** Elimination of loopback HTTP polling delays, durable buffering across TDengine restarts/spikes, strict zero silent `drop-head`, clear separation of transport vs storage.

## Context

Previously, Edge wrote batches into a local `outbox.sqlite` file and forwarded them over loopback HTTP (`POST /api/v1/edge-sync/observations`) to Center, which synchronously inserted into PostgreSQL `observations`. Under multi-protocol load (~300+ obs/s) and DB bloat (24+ GB PG), synchronous request timeouts caused retries, queue buildup in SQLite, and intermittent stale/bad UI flaps.

## Decision

Adopt **RabbitMQ 4.0 Quorum Queues** (`factorix.telemetry.ingress` direct exchange -> `factorix.telemetry.ingest.q` quorum queue) with:
1. **Publisher Confirms (`mandatory=True`)** from `factorix-acquisition` (`aio-pika`).
2. **Manual ACK strictly AFTER durable TDengine commit** in `IngestionWorker`.
3. **At-least-once Dead Lettering** (`x-dead-letter-strategy: at-least-once`, `x-overflow: reject-publish`) routing poison/repeatedly failing events to `factorix.telemetry.dlq` after bounded retries (`x-delivery-limit`).
4. **No `drop-head`:** Overflow raises backpressure to Acquisition (`DeliveryError`), never silently dropping historical events at the tail/head.
5. **Transport only:** RabbitMQ NEVER appears in the UI as a Storage Destination.

## Consequences

- **Positive:** Decouples OT acquisition latency from TDengine storage commit latency; survives TDengine restarts cleanly without halting polling; exposes real queue depth/oldest-age health.
- **Negative / Mitigation:** Quorum Queues keep Raft logs in memory/disk and are unsuitable for unbounded multi-million message backlogs (>5M msgs). Bounded `x-max-length` + emergency local spool + explicit health alerting mitigate runaway growth; RabbitMQ Streams remain a documented future upgrade path only if `x100`+ workloads prove necessary.
