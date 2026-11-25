# ADR-012: Physical Storage Object Registry and Dual Representation

**Status:** Accepted  
**Date:** 2026-11-13  
**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** ed2970c72c4773ff8108e4f8dffc7dc0afa881e0  

---

## Context

In earlier iterations of FactoriX, storage modeling relied on an abstract "Dataset" layer that hid the underlying physical primitives of TDengine (Databases, Supertables, Subtables). This created impedance mismatches:
- Users could not directly control TDengine-specific properties (vgroups, precision, buffer, duration, keep retention).
- Supertable tags (fixed metadata per device/subtable) were conflated with dynamic timestamped metric columns.
- State in PostgreSQL metadata frequently drifted from the real schemas present in the TDengine cluster, causing silent query failures or invalid DDL execution.

FactoriX requires a physical-first architecture where the UI, API, and storage engine operate on explicit TDengine objects while PostgreSQL maintains an authoritative registry and control plane.

## Decision

### 1. Dual Representation Architecture

We adopt a strict dual representation pattern:
- **TDengine (Authoritative Physical Plane):** TDengine is the single source of truth for physical time-series storage, table structures, column definitions, tags, and data retention policies.
- **PostgreSQL (Control Plane Registry):** PostgreSQL tables (`storage_physical_registry`, `storage_revisions`, `storage_operations`) store operational metadata, semantic descriptions, business tags, lineage links to factory hierarchy and data models, and audit records.

### 2. Canonical Object Identifiers

Every physical storage object has a globally unique, deterministic canonical ID:

| Level | Object Type | Canonical ID Syntax | Example |
|---|---|---|---|
| 1 | Database | `db:<database_name>` | `db:fx_t_default` |
| 2 | Supertable | `stable:<database_name>.<stable_name>` | `stable:fx_t_default.st_cnc_telemetry` |
| 3 | Subtable | `subtable:<database_name>.<subtable_name>` | `subtable:fx_t_default.sub_cnc_01` |

These canonical IDs are used consistently across REST APIs, WebSocket events, frontend route parameters, and topology graph nodes.

### 3. Physical Metadata Truth & Schema Synchronization

The application never invents synthetic physical objects or relies on unverified in-memory state:
- When querying object details, the backend queries TDengine `information_schema` (`ins_tables`, `ins_tags`, `ins_columns`) or executes `DESCRIBE / SHOW CREATE TABLE`.
- The PostgreSQL registry mirrors physical schema hashes (`schema_hash = SHA256(canonical_ddl)`).
- Schema drift detection runs during startup, background reconciliation, and before any mutation:
  - `IN_SYNC`: Metadata matches physical TDengine schema hash.
  - `DRIFT_DETECTED`: Physical schema modified outside FactoriX control plane.
  - `ORPHANED_PHYSICAL`: Physical table exists in TDengine without PostgreSQL registry record.
  - `MISSING_PHYSICAL`: Registered in PostgreSQL but missing in TDengine cluster.

### 4. Direct Wizard-Driven Physical Object Lifecycle

Creation and configuration wizards in the UI map 1:1 to physical TDengine DDL:
- **Database Wizard:** Engine configuration, precision (`ms`/`us`), buffer memory, keep retention days, vgroups allocation.
- **Supertable Wizard:** Timestamp column specification, typed metric columns (`DOUBLE`, `BIGINT`, `BINARY`, etc.), and immutable tag schema.
- **Subtable Wizard:** Target supertable selection, tag value assignment, and source binding with explicit row assembly policies.

## Consequences

**Positive:**
- Eliminates the confusing "Dataset" layer and restores complete visibility into TDengine physical storage.
- Prevents split-brain state through rigorous drift detection and hash verification.
- Enables granular performance tuning (vgroups, buffer, duration) directly per tenant and workload.
- Frontend topology graph renders true physical containment (`Database CONTAINS Supertable`, `Supertable CONTAINS Subtable`).

**Negative / Mitigations:**
- Dual representation requires reconciliation logic when network partitions occur during DDL execution.
- Addressed in ADR-013 via durable multi-phase operation sagas and idempotent reconciliation workers.

## References

- review.md §1.3, §1.4, §4 (FX-P0-02), §5 (FX-P0-03/04), §13 (FX-P1-01/02)
- ADR-002: TDengine Physical Schema and Isolation
- ADR-009: Physical TDengine-First UI
- ADR-013: Storage Operations Saga and Reconciliation
