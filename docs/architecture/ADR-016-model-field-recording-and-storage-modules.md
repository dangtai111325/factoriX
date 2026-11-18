# ADR-016: Model-field recording path and the Historian & Storage backend modules

**Status:** Accepted (v6, 2026-11-18) — supersedes the RabbitMQ `ModelFieldUpdate` envelope of ADR-010 for
Data Model fields recorded into user subtables.

## Context

tdengine_guide.md needs Data Model **fields** written into user-created TDengine subtables with ON_CHANGE
and ON_NEW_EVENT semantics (guide C1/C4/D3), durably and idempotently. The model engine already runs in the
Center process and commits `model_state` in PostgreSQL every sample; there was no path from a model field to a
user subtable (review P0-2, gate G-05).

## Decision

Record model fields through a **PostgreSQL transactional outbox**, not through RabbitMQ:

```
ModelEngine.process ── one PG transaction ──────────────────────────────┐
  model_state upsert                                                     │
  storage_model_recorder.capture_model_results                           │
    load ACTIVE model_field bindings (cache 10 s)                        │
    compare with storage_field_state (durable last value/quality/null)   │
    on change -> storage_record_outbox row + storage_field_state update  │
commit ◄─────────────────────────────────────────────────────────────────┘
RecordingDispatcher (background, started in app lifespan)
  PENDING outbox rows (FOR UPDATE SKIP LOCKED) -> epoch fence -> INSERT INTO db.sub (existing columns only)
  -> CONFIRMED after TDengine accepted; retry with backoff; FAILED (visible) after budget / non-retryable error
```

Why: the change decision and its durable record commit atomically with the model state (no lost or invented
change on crash); the outbox is replayable; `(ts, event_key)` is deterministic (`sha256(tenant|binding|epoch|seq)`)
so a replay is an upsert on the TDengine composite key; no new broker topology, no ordering problem between
model state and the change stream. Signal-bound subtables stay on the ingestion path (WS-P), using the same
schema-aware row builder (`recording_policy.ManagedSubtableWrite`).

Limits (stated in the UI and the fix log): the source is the sampled model body, so several changes between two
samples collapse into one, and two completion events between two samples cannot be told apart (guide D4/G-07).

## Module map (backend, `apps/center/src/factorix`)

| Module | Responsibility | Depends on |
|---|---|---|
| `modules/storage_objects.py` | Pure: object specs, validation rules, DDL generation, system-object rules | — |
| `modules/storage_revisions.py` | Drafts, plan (exact DDL), binding resolution, create saga (validate → DDL → read-back → registry, compensation), additive ALTER | storage_objects, storage_bindings, TDengine client |
| `modules/storage_bindings.py` | Source discovery views; model field leaves; body field extraction; model → machine resolution; type compatibility | domain.body |
| `modules/storage_model_recorder.py` | Model-field change detection (pure `plan_records`), capture (outbox), dispatcher (writer), writer health | storage_bindings |
| `modules/recording_policy.py` | Signal-bound recording policy evaluation (ingestion side) | — |
| `modules/storage_topology.py` | Read models of the physical TDengine catalog (databases, stables, subtables, tags, topology, summary) | TDengine client |
| `modules/historian_sources.py` | Pure-ish: series tokens, TDengine series reader (count / raw / INTERVAL buckets), gap stats, offsets | storage_bindings |
| `modules/historian_service.py` | Historian query (multi-series, downsampling, compare), events, exports | historian_sources, historian_views |
| `modules/historian_views.py` | Saved views (visibility, optimistic concurrency) | historian_sources |
| `modules/historian_catalog.py` | Picker read model grouped by machine | storage_bindings |
| `modules/telemetry_reset.py` | Revert To Zero saga (rows only; schema/registry kept) | TDengine client |
| `modules/postgres_explorer.py` | Read-only PG explorer | — |
| `transport/storage_api.py` | HTTP routes only: auth/tenant checks, error mapping; no business rules beyond request shaping | modules above |

Rules kept across modules: identifiers are validated before reaching SQL; every tenant-facing database name is
checked against the tenant (canonical `fx_t_<hex>` or registered); storage errors are `StorageObjectError` with a
code and HTTP status (mapped once in `transport/app.py`); nothing is swallowed — background failures are counted
and exposed by `GET /api/v1/storage/recording/status`.

## Consequences

* Migration `0010_storage_model_recording` adds `storage_field_state`, `storage_record_outbox`,
  `storage_objects.recording_json`, `storage_operations.object_key`, `ATOMIC_EVENT` row assembly.
* Pausing a subtable (`storage_objects.status = PAUSED`) stops capture at the next binding reload (≤ 10 s).
* Revert To Zero clears `storage_field_state` and `storage_record_outbox` together with the TDengine rows.
