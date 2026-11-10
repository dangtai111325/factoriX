# ADR-006: Self-Contained Local Acquisition (`apps/acquisition`) Without Edge Daemon

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** Eliminate brittle Edge enrollment/credential/outbox/HTTP-loopback bottlenecks while preserving all 5 OT protocol connectors and UI Connection semantics.

## Context

FactoriX is deployed as a single site-level Docker Compose/appliance installation. Previously, `apps/edge` ran inside the same container as Center but pretended to be a remote agent: requiring `edge_nodes` enrollment tokens, local credential files, active-config polling over HTTP loopback, SQLite outbox batching, and `POST /api/v1/edge-sync/observations` back into FastAPI. That added serialization overhead, enrollment fragility, and HTTP bottlenecking across 5 protocols.

## Decision

Replace `apps/edge` with **`apps/acquisition/` (`factorix-acquisition`)**:
1. **Preserve Proven OT Logic:** Reuse/adapt all 5 connectors (`modbus_tcp`, `opcua`, `mqtt`, `http`, `websocket`), `jobs.py`, `mapping.py`, `commissioning.py`, and `timeutil.py`.
2. **Direct PostgreSQL `ConfigProvider`:** Reads active `connections`, `acquisition_jobs`, `source_fields`, `signal_definitions`, `signal_bindings`, `secret_store` (decrypted in-process using `FACTORIX_DATA_KEY` from env), and `telemetry_generations.active_epoch`, listening to PG `LISTEN/NOTIFY` (`factorix_config_changed`, `factorix_reset_fence`) plus periodic fallback poll and read-only LKG cache.
3. **Single-Poller Fencing (`F-26`):** Acquire a PostgreSQL advisory lock per `tenant_id` (`pg_try_advisory_lock`) in `factorix-acquisition` so starting two acquisition processes NEVER double-polls OT PLCs or emits duplicate streams.
4. **Direct RabbitMQ Publisher:** Publishes canonical batch/events directly to RabbitMQ `factorix.telemetry.ingress` with publisher confirms; writes live connection health/commissioning statuses back to PG `collector_runtime_status` / `connections` + `/stream` notification.

## Consequences

- **Positive:** Removes enrollment failures, SQLite loopback queue stalls, and Center HTTP ingest bottleneck; sub-second hot config reload on connection edit/pause/resume.
- **Migration Safety:** Transitional compatibility keeps `/api/v1/connections` and `/overview` response fields intact; old `/api/v1/edge-sync/*` and `apps/edge` assets are cleanly retired in S17 after full E2E validation.
