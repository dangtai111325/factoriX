# Contract: process heartbeats (`collector_runtime_status`, `queues_json`)

| | |
|---|---|
| Table | `collector_runtime_status` (PK `instance_id`), one row per process instance, upserted every 5 s |
| Producers | acquisition `PgControlPlane.record_heartbeat` (role `acquisition`, leader only); ingestion `PgIngestionStore.write_heartbeat` (role `ingestion`) |
| Readers | API: health sweep (`app.py::_evaluate_connections` via `_acquisition_runtime_info`), `/health/ready`, `/api/v1/edges` (acquisition mode), `/api/v1/overview`, `live_state.extract_runtime_health`, `collect.list_connections` (rates), `telemetry.storage_overview` / ingestion health |
| Version | `schema_version: 1` (both roles, B-11); rows written before carry no version (= 0). Readers must tolerate missing keys and a JSON string instead of an object; `factorix_core.contracts.runtime_status` parses both shapes |
| Tests | `apps/center/tests/contracts/test_runtime_status_contract.py` |

## 1. Row columns

| Column | acquisition | ingestion |
|---|---|---|
| `role` | `acquisition` | `ingestion` |
| `health` | `HEALTHY` \| `DEGRADED` (DEGRADED when config invalid, activation error, storage/gap error, broker not OK, or a configured job not running) | `HEALTHY` when TDengine answers its probe, else `DEGRADED` |
| `software_version` | `FACTORIX_ACQUISITION_VERSION` (default `acq-v1`) | constant `s06-worker` (CT-19) |
| `config_revision` | snapshot revision in force (`config-revision.md`) | constant `1` (CT-19) |
| `spool_pending` / `fast_buffered` | SQLite spool PENDING rows / RAM queue length | `0` |
| `broker_ok` | publisher connected and confirming | both consumers have an open channel |
| `diagnostic` | first of: activation error, publisher storage/gap error, "RabbitMQ broker unavailable.", "N of M acquisition jobs are not running." (≤ 500 chars) | last worker error |
| `last_heartbeat` | write time (UTC) | write time (UTC) |

**Liveness rule (one for every surface):** `domain.health.heartbeat_fresh` — a heartbeat older than
`EDGE_OFFLINE_AFTER_S = 15 s` means the process is offline (`/edges` → `OFFLINE`, `/health/ready` → 503
`ACQUISITION_DOWN` / `INGESTION_DOWN`, sweep skipped).

The acquisition also still updates every non-revoked `edge_nodes` row (compatibility until plan S17;
`health` = `DEGRADED` or `CONFIG_VALIDATED`, `active_revision` follows `desired_revision` when config is in sync).

## 2. `queues_json` — acquisition

```
{ "schema_version": 1,
  "connectors": {"<mqtt connection uuid>": {"pending","dropped","connects","disconnects","session_present"}},  # one per MQTT connector
  "publisher": publish_metrics(),
  "runtime":   {"started_at","leader_since","jobs_expected","jobs_running","connections_running":[uuid…],"last_report_at"} }
```

Before v1 (unversioned rows) the MQTT counters were top-level keys named by the connection UUID (CT-18);
`connector_counters()` reads both.

* `publisher` keys (owned by WS-P, additive): `published_fast, published_replay, spilled, overflow_dropped,
  spool_expired, spool_full, spool_occupied_bytes, publish_failed, publish_failed_by_lane, last_publish_failure,
  ingest_backpressure, broker_slow, slow_events, replay{…,background}, backpressure_events, admission_waits,
  admission_wait_s, gap_rejected, gap_rejected_by_protocol, replay_max_obs_s, fast_head_age_s,
  emitted_by_protocol, stage_calls, stage_seconds`, plus `envelopes_published, envelope_observations` when the
  broker exposes them.
* `runtime` is read by the Center health sweep: connections listed in `connections_running` are judged only by
  acquisition's own windowed evidence; `leader_since` / `started_at` reset the "no data" reference time.
* Readers of unversioned rows must skip top-level keys that are UUIDs (MQTT counters, CT-18 — fixed in v1).

## 3. `queues_json` — ingestion

```
{ "schema_version": 1, "tenant_rates": {tenant: obs/min}, "conn_rates": {connection: obs/min},
  "acked_total","dlq_total","retried_total","epoch_fenced_dropped","tdengine_writes",
  "managed_writes","managed_checkpoints","managed_gap_markers","managed_write_errors","managed_skips_by_reason",
  "tdengine_ok": bool, "envelopes_received",
  "lanes": {"live"|"legacy": {"pending_items","waiting_messages","batches","items","busy","stalled_batch_age_s"}},
  "pg_ingested_at": bool,
  …latency SLIs from LatencyHistogram.snapshot() (merged at top level) }
```

Readers: `collect.list_connections` (`conn_rates`, rows of the last 45 s), `telemetry.storage_overview`
(`tenant_rates`), `live_state.extract_runtime_health` (`tdengine_ok`).

## 4. Rules

* Keys are additive only. Renaming or changing the meaning of a key that a reader uses needs a
  `schema_version` key in `queues_json` and a reader that accepts both shapes for one release (ADR-018).
* Done in v1 (B-11): `schema_version`, MQTT counters under `"connectors"`, shared parser
  `factorix_core.contracts.runtime_status` (`parse_queues`, `queues_schema_version`, `connector_counters`).
  Still open (Phase D4): one typed `RuntimeStatus` model for all five readers.

## 5. Broker depth (CT-20)

The API process probes RabbitMQ read-only every 30 s from its health loop (`application/health/broker_depth.py`
→ `platform.broker.probe_broker_health`: passive declares + management HTTP GETs, 12 s bound, own task) and
keeps the last answer. Shape (`null` = not measured): `{schema_version, broker_ok, live_q_depth, ingest_q_depth,
live_q_unacked, ingest_q_unacked, dlq_depth, oldest_age_s, checked_at, error, warnings, age_s}`.
Exposed (additive) by `GET /health/ready?verbose=1` (`processes[]` + `broker` + `notify_bridge`, also inside the 503 error body)
and by every `GET /api/v1/edges` item in acquisition mode (`broker`).
