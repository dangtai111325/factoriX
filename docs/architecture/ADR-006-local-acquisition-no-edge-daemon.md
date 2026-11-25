# ADR-006: Self-Contained Local Acquisition (`apps/acquisition`) Without Edge Daemon

- **Status:** Accepted
- **Date:** 2026-11-10 (corrected 2026-11-18, see "Correction")
- **Decision Drivers:** Eliminate brittle Edge enrollment/credential/outbox/HTTP-loopback bottlenecks while preserving all 5 OT protocol connectors and UI Connection semantics.

## Context

FactoriX is deployed as a single site-level Docker Compose/appliance installation. Previously, `apps/edge` ran inside the same container as Center but pretended to be a remote agent: requiring `edge_nodes` enrollment tokens, local credential files, active-config polling over HTTP loopback, SQLite outbox batching, and `POST /api/v1/edge-sync/observations` back into FastAPI. That added serialization overhead, enrollment fragility, and HTTP bottlenecking across 5 protocols.

## Decision

Replace `apps/edge` with **`apps/acquisition/` (`factorix-acquisition`)**:
1. **Preserve Proven OT Logic:** Reuse/adapt all 5 connectors (`modbus_tcp`, `opcua`, `mqtt`, `http`, `websocket`), `jobs.py`, `mapping.py`, `commissioning.py`, and `timeutil.py`.
2. **Direct PostgreSQL `ConfigProvider`:** Reads active `connections`, `acquisition_jobs`, `source_fields`, `signal_definitions`, `signal_bindings`, `secret_store` (decrypted in-process using `FACTORIX_DATA_KEY` from env), and `telemetry_generations.active_epoch`, listening to PG `LISTEN/NOTIFY` (`factorix_config_changed`, `factorix_epoch_changed`, `factorix_commissioning`) plus periodic fallback poll and read-only LKG cache.
3. **Single-Poller Fencing (`F-26`):** Acquire a PostgreSQL advisory lock per `tenant_id` (`pg_try_advisory_lock`) in `factorix-acquisition` so starting two acquisition processes NEVER double-polls OT PLCs or emits duplicate streams.
4. **Direct RabbitMQ Publisher:** Publishes canonical batch/events directly to RabbitMQ `factorix.telemetry.ingress` with publisher confirms; writes live connection health/commissioning statuses back to PG `collector_runtime_status` / `connections` + `/stream` notification.

## Correction (2026-11-18)

- There is **no** `factorix_reset_fence` channel: the reset saga fences through `telemetry_generations.active_epoch` and
  NOTIFY `factorix_epoch_changed` (+ `factorix_config_changed`). Channel list: `contracts/notify.md` (CT-17).
- Single-poller fencing uses **one** session advisory lock per installation (`FACTORIX_ACQUISITION_LOCK_KEY`, default
  `DEFAULT_LOCK_KEY`), not one per tenant.
- `apps/edge` is **not retired yet** (S17 pending): it is still built into the image, tested by `pytest.ini`, and
  selectable with `FACTORIX_COLLECTOR_MODE=edge`. Since 2026-11-18 the image and compose default to `acquisition`
  (A4(a)) and `/api/v1/edge-sync/*` answers 410 Gone in acquisition mode (A4(b)); acquisition still updates
  `edge_nodes` for `/api/v1/edges` / `/overview` compatibility. Retirement plan: R2-E Phase D2.
- Health and commissioning are written straight to PostgreSQL (`collector_runtime_status`, `connections`,
  `commissioning_jobs`) and announced with `factorix_health_changed`; there is no HTTP between the processes
  (`contracts/internal-http.md`).

## Consequences

- **Positive:** Removes enrollment failures, SQLite loopback queue stalls, and Center HTTP ingest bottleneck; sub-second hot config reload on connection edit/pause/resume.
- **Migration Safety:** Transitional compatibility keeps `/api/v1/connections` and `/overview` response fields intact; old `/api/v1/edge-sync/*` and `apps/edge` assets are cleanly retired in S17 after full E2E validation.
