# ADR-007: Safe Selective Telemetry Reset (`CLEAR_TELEMETRY_ONLY`) & Epoch Fencing

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** Resolve P0 safety hazard where `Revert To Zero` previously executed `TRUNCATE ... CASCADE` over every public table, destroying user accounts, 5 Connections, 336 Signals, and 36 Models.

## Context

Previously `identity.revert_to_zero()` truncated every table in `public`, wiped local files, deleted admins, and redirected the frontend to `/register`. Under the new Storage & Historian architecture, operators use `Revert To Zero` to wipe accumulated telemetry & archive data for a clean run without losing hours of Factory Model, Connection, Signal, Model, or Storage Design configuration.

## Decision

Replace full-wipe truncation unconditionally with **`TelemetryResetService`** (`R0`–`R5` durable saga tracked in `storage_operations` and gated by `telemetry_generations.active_epoch`):
- **Pre-Execution Guard:** Admin password re-auth + CSRF + exact typed confirmation `CLEAR TELEMETRY` + signed preview manifest hash + recent backup/restore confirmation + legal hold check. Legacy `{confirm: "REVERT"}` is explicitly rejected (`422` / `400`).
- **Protected Immutable Config Scope:** Never touches `tenants`, `sites`, `admin_accounts`, `sessions`, `resources`/`resource_relations`, `connections`, `secret_store`, `acquisition_jobs`, `source_fields`, `signal_definitions`, `signal_bindings`, `output_groups`, `model_refs`, `storage_designs`/`versions`/`datasets`/`policies`, `historian_saved_views`, `alembic_version`, or external offline backups.
- **Scoped Data Purge:** Increments `active_epoch` first, pauses Acquisition scope, drains/fences RabbitMQ & emergency spools, clears registered TDengine subtables in `fx_t_<tenant_hex>`, deletes only PG telemetry runtime tables (`latest_signal_state`, `observations`, `ingest_dedup`, `observation_quarantine`, `model_state`, `model_snapshots`), clears export artifacts/caches, verifies preflight vs postflight UUID+SHA256 checksums, and resumes Acquisition if previously active.
- **UI State:** Operator stays logged in (`No Data` / `UNKNOWN` initially); fresh acquisitions auto-populate seconds after resume.

## Consequences

- **Positive:** Mathematically prevents configuration loss or post-reset old-epoch data resurrection; idempotently resumable across crash at any stage `R0`–`R5` (`RESET-01..17`).
