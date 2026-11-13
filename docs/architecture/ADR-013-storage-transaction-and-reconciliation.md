# ADR-013: Storage Operations Saga, Transaction Lifecycle, and Reconciliation

**Status:** Accepted  
**Date:** 2026-11-13  
**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** ed2970c72c4773ff8108e4f8dffc7dc0afa881e0  

---

## Context

Physical DDL operations in TDengine (creating databases, declaring supertables, instantiating subtables, and altering columns/tags) are asynchronous cluster operations. Unlike relational systems with distributed 2PC transactions, TDengine operations cannot participate in an atomic PostgreSQL transaction.

Earlier implementations suffered from severe operational defects:
- Operations were marked `APPLIED` immediately after issuing an HTTP/REST request to TDengine before physical execution completed, resulting in race conditions where subsequent writes failed.
- In-flight drafts were maintained in transient server memory or uncommitted request states, causing lost work on container restart.
- Absence of optimistic concurrency led to silent overwrites when multiple operators configured storage concurrently.
- No automated reconciliation mechanism existed to clean up orphaned partial state after network or service failures.

## Decision

### 1. Multi-Phase Operation Saga State Machine

All storage mutations (Create, Alter, Pause, Resume, Retire, Purge) must execute through a durable multi-phase saga:

```
[ DRAFT ] 
    │
    ▼
[ VALIDATING ] ── (syntax / catalog validation fails) ──► [ REJECTED ]
    │
    ▼
[ APPLYING ]   ── (DDL transport failure)              ──► [ FAILED / RETRYING ]
    │
    ▼
[ VERIFYING ]  ── (read-back mismatch or timeout)       ──► [ TIMED_OUT / COMPENSATING ]
    │
    ▼
[ APPLIED ] (Strict invariant: physical read-back confirmed)
```

**Non-Negotiable Rule:** The system NEVER reports `status = APPLIED` or `HTTP 200 OK` (with applied status) until a physical read-back probe (`DESCRIBE <table>` or querying `information_schema.ins_tables`) confirms the target schema exists in TDengine with matching hash.

### 2. Optimistic Concurrency and Revision Tracking

- Every physical object in `storage_physical_registry` and every draft in `storage_drafts` holds a strictly monotonic `revision_id` (integer) and `revision_sha` (SHA-256).
- Mutating endpoints (`PUT /api/v1/storage/td/objects/{id}`, `PATCH`, `POST .../publish`) mandate an `expected_version` payload parameter or an HTTP `If-Match: "<revision_id>"` header.
- If `expected_version != current_revision_id`, the API immediately rejects the request with HTTP 409 `VERSION_CONFLICT`, returning the conflicting version and user diff.

### 3. Idempotent Operation Journal

- Every operation is registered in PostgreSQL `storage_operations` before DDL dispatch:
  - `op_id` (UUIDv7, time-ordered)
  - `tenant_id`
  - `target_object_id` (`db:*`, `stable:*`, `subtable:*`)
  - `operation_type` (`CREATE`, `ALTER`, `PAUSE`, `RESUME`, `RETIRE`, `PURGE`)
  - `ddl_statements` (JSON array of executed SQL)
  - `status` (`DRAFT`, `VALIDATING`, `APPLYING`, `VERIFYING`, `APPLIED`, `FAILED`, `ROLLED_BACK`)
  - `error_code`, `error_details`, `retry_count`, `created_at`, `updated_at`
- If a client retries with the same `op_id` or client idempotency key, the server returns the existing operation status without re-executing DDL.

### 4. Background Reconciliation & Recovery

A background reconciliation worker runs periodically (every 10 seconds):
- Scans `storage_operations` where `status IN ('APPLYING', 'VERIFYING')` with `updated_at < NOW() - INTERVAL '30 seconds'`.
- Issues physical verification probes to TDengine.
- If physical object matches requested specification, transitions operation to `APPLIED`.
- If physical object is absent or corrupted after retry limit, transitions operation to `FAILED` and emits audit events.
- Safely cleans up dangling transient tables created during aborted operations.

## Consequences

**Positive:**
- Eliminates phantom `APPLIED` states; operators and automated pipelines receive truth-aligned operation status.
- Prevents concurrent overwrite hazards in multi-user industrial environments.
- Provides complete historical auditability of every DDL statement executed against the cluster.
- Self-healing capabilities through background reconciliation.

**Negative / Mitigations:**
- Asynchronous operation requires UI polling or WebSocket subscription to track operation completion.
- Mitigated by returning structured `operation_id` with `GET /api/v1/storage/td/operations/{op_id}` and WebSocket notifications.

## References

- review.md §5 (FX-P0-03/04), §6 (FX-P0-05), §13 (FX-P1-01/02), §25 (Test cases TD-011..TD-040)
- ADR-005: Canonical Ordering and Idempotency
- ADR-012: Physical Storage Object Registry
