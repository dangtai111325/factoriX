# ADR-011: Row Assembly and Epoch Idempotency

**Status:** Accepted  
**Date:** 2026-11-12  
**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** 400dba192eb13be30806dbacb1568ffff23ae26b

---

## Context

A TDengine subtable may bind columns from multiple sources with different update cadences:
- Raw signal (Modbus TCP): updates every 1 second
- Data Model derived field: updates every 5 seconds
- Another signal (OPC UA event): updates on-change only

The timestamp primary key in TDengine is unique per subtable row. Placing values from these mismatched cadences into one wide row requires an explicit **Row Assembly Policy** to prevent silent data fabrication (inventing a simultaneous timestamp that did not exist in reality).

Additionally, after a telemetry reset (`Revert To Zero`), new samples must not be confused with pre-reset samples. The epoch mechanism fences data planes cleanly.

## Decision

### Row Assembly Policies (user-selectable at Subtable Step C4 / Supertable Step B5)

| Mode | Behavior | Use when |
|------|----------|----------|
| `INDEPENDENT_EVENTS` | Write one row per source event; unrelated columns are NULL with explicit `NOT_SAMPLED` semantics | Sources are truly asynchronous; no synthetic simultaneity needed |
| `LATEST_AS_OF_TRIGGER` | Trigger source fires; carry-forward latest known value of other columns if `age ≤ max_age_ms`; label as `carried_forward` | Sources update at known different rates; model field lags raw by ≤ 6s |
| `TIME_BUCKET` | Aggregate all sources into fixed-width window (1s/5s/1m); emit one row per bucket with explicit aggregation function per column | Sensor fusion with explicit windowing semantics |
| `EXACT_TIMESTAMP` | Write row only when all bound columns have matching timestamps (within precision tolerance); reject/quarantine otherwise | Synchronized multi-channel acquisition where simultaneity is guaranteed |

### Epoch Idempotency Contract

Every ingested observation carries `data_epoch` matching the system's current epoch counter. The epoch is incremented atomically during `Revert To Zero` before any telemetry deletion. The ingestion worker:
1. Rejects observations with `data_epoch < current_epoch` (old epoch fenced)
2. Rejects observations with `data_epoch > current_epoch + 1` (future epoch guard)
3. Dedup store key includes `(tenant_id, source_id, event_uid, data_epoch)` — no cross-epoch dedup collision

After reset, old RabbitMQ messages/spool items with stale epoch are drained and rejected (not silently discarded without audit).

### Idempotency Key for TDengine Writes

```
idempotency_key = SHA256(tenant_id + subtable_name + timestamp_ms + data_epoch + source_event_uid)
```

Stored in `storage_row_assembly.checkpoint_period` table for bounded window. Partial TDengine write success (cross-vgroup) is detected via read-back and per-item retry with same idempotency key.

## Consequences

**Positive:**
- No synthetic timestamps invented to match mismatched sources
- Reset is safe: old epoch cannot contaminate new TDengine rows
- Partial TDengine INSERT failures (vnode rejection) are handled per-item without duplicate rows

**Negative / Mitigations:**
- `INDEPENDENT_EVENTS` produces sparse wide rows — query must handle NULL semantics; Historian reconstructs step-hold curves correctly by ignoring NULL columns
- `LATEST_AS_OF_TRIGGER` requires bounded carry-forward buffer in ingestion worker memory — bounded by `max_age_ms` and GC policy
- Dedup store grows with throughput — TTL cleanup based on `data_epoch` and watermark; not unbounded

## Implementation Notes

- `storage_row_assembly` PostgreSQL table stores policy per subtable revision
- `storage_assembly.py` module owns carry-forward buffer state; stateful per (tenant, subtable)
- TDengine INSERT retry: detect `TS_DATA_ALREADY_INSERTED` for idempotent replays; treat as success when payload matches expected schema hash
- Epoch fence: `telemetry_generations.data_epoch` incremented in PostgreSQL before `Clearing` phase of reset FSM
- `ingestion_worker.py` dedup LRU keyed by `(event_uid, data_epoch)` — not just `event_uid` to prevent cross-epoch collision

## References

- plan.md §2.4, §7.5 items 10–11, §13A
- ADR-007: Telemetry Reset Epoch Fencing
- ADR-010: Model Output Materialization
- Findings: FX-S04, FX-S05 (plan.md §1.2)
