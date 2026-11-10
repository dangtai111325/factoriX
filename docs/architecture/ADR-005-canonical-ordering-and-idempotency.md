# ADR-005: Canonical Observation Ordering, Epoch Fencing & Idempotency

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** Deterministic replay safety across RabbitMQ redeliveries, out-of-order OT clocks, and multi-worker ingestion.

## Context

OT devices can have skewed or backward clocks (PLC battery loss, daylight saving, retained MQTT messages), and RabbitMQ quorum delivery is at-least-once (messages can redeliver after worker crashes before ACK).

## Decision

1. **Canonical Observation v1 Schema (`factorix.domain.canonical`):** Every event carries `schema_version=1`, `data_epoch`, `config_revision`, `event_uid` (UUIDv7/deterministic ID per acquisition sample), `tenant_id`, `site_id`, `connection_id`, `acquisition_job_id`, `source_field_id`, `signal_id`, `resource_id`, `source_time`, `acquired_at`, `ingested_at`, `value_type`, `value`, `quality`, `quality_reason`, `origin`, and redacted `provenance` (never containing secrets).
2. **Authoritative Time Ordering:** Live state & historical event ordering uses `(acquired_at, event_uid)` monotonically per signal (`resolve_times` clamps implausible future acquisition skew >5 min with `UNCERTAIN`/`EDGE_CLOCK_FUTURE` while retaining raw `source_time` as queryable metadata). Out-of-order historical inserts are stored at their valid timestamp without rewinding live state to an older sample.
3. **Epoch Fencing + Bounded Idempotency:** Every worker checks `message.data_epoch == current tenant active_epoch` before TDengine/Live persistence. Messages from older epochs are quarantined/discarded cleanly without entering TDengine. Within active epoch, bounded UID deduplication + TDengine timestamp semantics prevent duplicate history rows on redelivery.

## Consequences

- **Positive:** Eliminates race conditions where an old unACKed message or retained MQTT packet resurrects erased telemetry after a reset or reconnect (`F-19`, `F-20`, `F-29`).
