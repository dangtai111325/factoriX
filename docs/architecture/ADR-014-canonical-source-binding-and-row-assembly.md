# ADR-014: Canonical Source Binding and Multi-Source Row Assembly

**Status:** Accepted  
**Date:** 2026-11-13  
**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** ed2970c72c4773ff8108e4f8dffc7dc0afa881e0  

---

## Context

Industrial time-series subtable schemas in TDengine frequently combine columns sourced from disparate sources:
1. **High-frequency raw sensor signals** (e.g. spindle RPM via Modbus TCP at 100ms or 1s intervals).
2. **Derived analytical model metrics** (e.g. running OEE, thermal drift calculations at 5s or 1m intervals).
3. **Asynchronous event-triggered signals** (e.g. part count pulse or alarm transition on-change).

Because TDengine uses a strict timestamp as the primary key per subtable, combining these disparate streams into a single row structure risks data fabrication if simultaneous timestamps are artificially invented, or silent data loss if non-matching samples are discarded.

Furthermore, users configure source bindings from different domain contexts (by physical asset hierarchy, by field connection, or by analytical data model). The system must provide a unified source binding model that resolves to unambiguous physical sources.

## Decision

### 1. Three-Perspective Unified Source Binding

The source configuration interface provides three perspectives that map to identical canonical source descriptors:
- **Hierarchy Perspective:** `Plant / Area / Line / WorkCell / Asset / Signal`
- **Collector Perspective:** `Connection / Protocol Driver / Channel / Point`
- **Data Models Perspective:** `Model Class / Instance / Output Metric`

All three perspectives resolve to a deterministic canonical identifier:
- Raw telemetry: `sig:<connection_slug>:<device_id>:<tag_name>`
- Calculated metric: `model:<model_id>:<instance_id>:<field_name>`

### 2. Server-Side Validation Contract

When validating a subtable design or executing an operation, the backend strictly verifies:
- Every referenced source ID exists and is actively licensed/configured.
- Source data type is coercible to the target TDengine column type (e.g., `FLOAT/DOUBLE`, `INT/BIGINT`, `BOOL`, `BINARY/NCHAR`). Incompatible bindings fail with HTTP 422 `TYPE_MISMATCH`.
- No two columns in the same subtable bind to the exact same canonical source unless distinct transformation or aggregation rules are applied.
- Supertable tag values are immutable per subtable and resolved at creation time.

### 3. Multi-Source Row Assembly Policies

Each subtable declares an explicit `RowAssemblyPolicy` governing how multi-rate sources populate TDengine rows:

| Policy | Behavior | Constraints & Quality Flags |
|---|---|---|
| `INDEPENDENT_EVENTS` | Arriving source event writes a row immediately at its actual timestamp. Non-firing columns are populated as `NULL`. | Quality indicator marks unset columns as `NOT_SAMPLED`. Zero interpolation error. |
| `LATEST_AS_OF_TRIGGER` | A designated master trigger source triggers row generation. Secondary columns carry forward their latest observed value if `age <= max_age_ms`. | Secondary values carry `CARRIED_FORWARD` quality annotation. If expired, written as `NULL` with `STALE` quality. |
| `TIME_BUCKET` | Fixed time window (e.g. 1s, 5s, 1m). Samples within window are aggregated (last, mean, min, max) into a single row placed at bucket boundary. | Bucket boundary timestamp with explicit window metadata. |
| `EXACT_TIMESTAMP` | Row written only when all bound sources deliver observations with matching timestamps within a tolerance window `delta_ms`. | Incomplete tuples are quarantined in a bounded reorder buffer; discarded if timeout expires. |

### 4. Change-Only and Heartbeat Recording Policies

To optimize storage without sacrificing fidelity:
- Subtables or individual columns may configure `ChangeOnlyRecordingPolicy` with deadband thresholds (`absolute_epsilon`, `relative_percent`).
- Heartbeat interval ensures a point is recorded at least once every `max_interval_seconds` regardless of change.
- Ingestion worker evaluates recording policies in-stream before dispatching SQL batch inserts to TDengine.

## Consequences

**Positive:**
- Completely prevents synthetic timestamp fabrication (FX-P0-01, FX-P0-06).
- Supports seamless coexistence of raw field signals and complex data model calculations in the same historian subtable.
- Explicit quality indicators (`GOOD`, `CARRIED_FORWARD`, `STALE`, `NOT_SAMPLED`) enable accurate reconstruction in the Historian timeline without misleading line charts.

**Negative / Mitigations:**
- `INDEPENDENT_EVENTS` increases subtable row count and produces sparse rows.
- TDengine column-oriented storage and compression algorithms handle sparse NULLs efficiently; Historian queries apply forward-fill (`FILL(PREV)`) only when requested by the user.

## References

- review.md §7 (FX-P0-06/07), §8 (Row assembly), §14 (FX-P1-05/06), §26 (Test cases SRC-001..SRC-032)
- ADR-010: Model Output Materialization
- ADR-011: Row Assembly and Epoch Idempotency
- ADR-012: Physical Storage Object Registry
