# ADR-010: Model Output Materialization to TDengine

**Status:** Accepted  
**Date:** 2026-11-12  
**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** 400dba192eb13be30806dbacb1568ffff23ae26b

---

## Context

Data Models in FactoriX compute rule-derived fields from raw signal data. Currently these outputs exist as `model_state`/`model_snapshots` in PostgreSQL and periodic snapshots via `models_engine.py`. When a user wants to store derived field values in TDengine alongside raw telemetry, there is no stable event envelope carrying model outputs through RabbitMQ to the ingestion worker.

Findings from source review:
- `models_engine.py:798–991`: periodic scheduler + background catalog poll every 15s + preview POST per sampleMs
- `ingestion_worker.py:~1920–2220`: formula expressions parsed per trigger/dependency in hot loop — `parse_expression` + `bind` called repeatedly for the same `(formula_id, revision)` pair
- No `ModelFieldUpdate` canonical event type found in RabbitMQ schema; model outputs reach TDengine only as a side-effect of ingestion worker formula evaluation

## Decision

Define a canonical **`ModelFieldUpdate` event envelope** published to RabbitMQ after model output has been committed and verified as durable:

```json
{
  "event_type": "model_field_update",
  "tenant_id": "<uuid>",
  "model_id": "<uuid>",
  "model_revision": "<int>",
  "field_path": "state",
  "resource_id": "<uuid>",
  "value": "<typed>",
  "value_type": "DOUBLE|VARCHAR|BOOL|...",
  "quality": "GOOD|BAD|UNCERTAIN",
  "acquired_at": "<ISO8601>",
  "source_time": "<ISO8601>",
  "produced_at": "<ISO8601>",
  "event_uid": "<uuid>",
  "data_epoch": "<int>"
}
```

The recording router (`storage_recording.py`) maps `ModelFieldUpdate` events to target TDengine subtable columns via `storage_source_bindings_v2` where `source_kind = 'model_field'`.

## Consequences

**Positive:**
- Model-derived fields can be stored in the same TDengine subtable as raw signal values without code duplication
- Event UID enables idempotent replay — retries do not produce duplicate rows
- Model revision tracked per binding — schema incompatibilities discovered at binding time, not at write time
- Decouples model evaluation cadence from raw acquisition cadence

**Negative / Mitigations:**
- Must NOT create a feedback loop: `ModelFieldUpdate` must not trigger re-ingestion into acquisition path — enforced via source kind filter in ingestion worker
- Formula caching by `(formula_id, revision)` required to avoid repeated `parse_expression` calls — reduces CPU (finding FX-S08)
- Double-write protection: idempotency key = `(tenant_id, model_id, model_revision, field_path, resource_id, data_epoch, source_time_ms)` checked in dedup store before TDengine write

## Implementation Notes

- Add `ModelFieldUpdateAdapter` in `models_engine.py` that publishes after verified model snapshot
- Ingestion worker: filter `event_type == 'model_field_update'` and route to `storage_recording.py`
- Compile formula expressions once per `(formula_id, revision)`, cache with LRU
- Recording router reads `source_kind = 'model_field'` bindings from `storage_source_bindings_v2`
- Row assembly policy governs how model fields (5s cadence) are combined with raw fields (1s cadence): see ADR-011

## References

- plan.md §6.3, §7.5
- ADR-011: Row Assembly and Epoch Idempotency
- Findings: FX-S08, FX-S09, FX-S11 (plan.md §1.2)
