# ADR-015: Clean Install, Baseline Preservation, and Selective Telemetry Reset

**Status:** Accepted  
**Date:** 2026-11-13  
**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** ed2970c72c4773ff8108e4f8dffc7dc0afa881e0  

---

## Context

Industrial edge deployments of FactoriX represent substantial plant engineering investments:
- Configured plant hierarchies (Enterprises, Sites, Areas, Lines, WorkCells, Machines).
- Verified protocol driver connections (Modbus TCP/RTU, OPC UA, MQTT Sparkplug B, HTTP REST).
- Commissioned signal point lists and calibration formulas.
- Data models, calculation expressions, user accounts, and security access controls.

A critical defect identified in legacy versions (FX-P0-10/11) was that telemetry clearing mechanisms (`Revert To Zero`) contained destructive paths that executed blanket `TRUNCATE` operations on PostgreSQL tables, destroying configuration alongside time-series telemetry. Furthermore, automated test harnesses and docker-compose files risked data destruction on persistent customer volumes during updates.

A strict boundary must be enforced between the persistent Control Plane and the transient Telemetry Plane, accompanied by a verified, non-destructive selective reset finite state machine.

## Decision

### 1. Architectural Plane Separation & Volume Isolation

FactoriX strictly decouples the persistent Control Plane from the Telemetry Data Plane:

| Domain Plane | Storage Engine | Contents | Preservation Rule |
|---|---|---|---|
| **Control Plane** | PostgreSQL 17 | Users, tenants, hierarchies, connections, signals, models, storage object registry, audit logs | **PERMANENTLY PRESERVED.** Never truncated, dropped, or reset during telemetry clearing. |
| **Telemetry Plane** | TDengine 3.4.3.9 | Time-series observations, subtable data points, historical aggregations | **SELECTIVELY CLEARED.** Eligible for purge during telemetry reset without altering table schemas. |
| **Buffer Plane** | RabbitMQ 4.4 Quorum Queues | In-flight messages, spool disk files | **DRAINED.** Flushed or purged during reset; connection topology preserved. |
| **Cache Plane** | Memory / State Cache | Live signal values, freshness timestamps | **CLEARED.** Reset to unobserved state upon epoch advance. |

### 2. Selective Telemetry Reset Finite State Machine (Stages R0–R5)

To reset operational telemetry without touching customer configurations, the system executes an automated, audited 6-stage finite state machine:

- **Stage R0 (Authentication & Epoch Fence):**
  - Requires explicit administrative role and confirmation token.
  - Atomically increments `data_epoch` counter in `telemetry_generations`.
  - Ingestion workers instantly fence and drop any incoming packets carrying `epoch < current_epoch`.
- **Stage R1 (Broker In-Flight Drain):**
  - RabbitMQ queues are drained of pending messages carrying obsolete epoch identifiers.
  - Spool files on disk created during outages are wiped or archived with reset marker.
- **Stage R2 (Ingestion Worker Quiescence):**
  - Ingestion workers flush pending in-memory batch buffers and enter quiet phase.
- **Stage R3 (TDengine Telemetry Purge):**
  - DDL schemas (Databases, Supertables, Subtables) are **strictly preserved**.
  - Historical data rows are purged via table truncation or partition dropping; table definitions and tags remain intact.
- **Stage R4 (Live State Cache Reset):**
  - `latest_signal_state` table in PostgreSQL is reset or cleared; signal definitions in `signals` table remain 100% untouched.
- **Stage R5 (Resume & Audit Verification):**
  - Ingestion resumes under the incremented epoch.
  - Cryptographic verification report is generated and logged in `audit_events` with before/after row counts, schema parity hashes, and epoch metadata.

### 3. Destruction Guards in CI, Test, and Packaging

- All automated test runners, CI scripts, and verification suites must run against ephemeral, uniquely namespaced Docker containers (`factorix-ci-<runid>`) with disposable volumes.
- Any command containing `TRUNCATE`, `DROP DATABASE`, or `docker volume rm` on non-test environments is blocked by strict environment variable checks (`FACTORIX_ENV=test` and `ALLOW_DESTRUCTIVE_RESET=true`).
- Release packages and Git branches are subject to clean-room audits (removing mock datasets, dead legacy files, and obsolete PASS claims).

## Consequences

**Positive:**
- Complete safety for plant configuration assets during maintenance, testing, and telemetry purges.
- Eliminates configuration wiping accidents (resolves FX-P0-10, FX-P0-11).
- Epoch fencing prevents race conditions and out-of-order stale data resurrection after reset.
- Verifiable audit trail provides compliance evidence for regulated manufacturing environments.

**Negative / Mitigations:**
- Multi-stage reset takes longer than an uncoordinated drop (typically 2–5 seconds).
- Acceptable given the absolute priority of configuration preservation in mission-critical manufacturing.

## References

- review.md §0.1, §10 (FX-P0-10/11), §19, §20, §29 (Test cases RST-001..RST-028)
- ADR-007: Telemetry Reset Epoch Fencing
- ADR-008: PostgreSQL Control Plane and Ownership
- ADR-011: Row Assembly and Epoch Idempotency
- ADR-012: Physical Storage Object Registry
