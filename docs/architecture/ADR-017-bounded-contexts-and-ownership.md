# ADR-017: Bounded contexts and ownership map

- **Status:** Accepted (v6, 2026-11-18) — map of record for Phase B/C of R2-E. Describes ownership **as it is**
  (writers verified by grep of `INSERT|UPDATE|DELETE` and `pg_notify`) and the single owner each concept moves to.
- **Numbering note:** R2-E called this "ADR-016"; ADR-016 was taken the same day by WS-H (model-field recording), so
  ownership is ADR-017 and contract versioning is ADR-018.
- **Related:** ADR-008 (PG control plane), ADR-016 (model-field recording), ADR-018 (contract versioning),
  `contracts/README.md` (discrepancy ids `CT-nn`).

## Context

Center and Acquisition talk through shared PostgreSQL tables, free-form NOTIFY payloads and an unversioned
heartbeat blob; several concepts have many writers (six writers of `connections.health`, six "active epoch"
readers, two recording engines, two storage registries, two binding tables read by one ingestion catalog). Refactors
in Phase B/C need one agreed owner per concept, otherwise every move re-opens the same debate.

## Decision

1. Every table, queue, NOTIFY channel and in-memory state below has exactly **one owning context**. Other contexts
   read it, or change it **only through the owner's interface** (function / service / contract), never by their own SQL.
2. Until Phase C lands, the "current extra writers" column is tolerated but frozen: no new writer may be added.
3. Runtime resource names (tables, columns, queues, exchanges, channels) do not change when ownership moves (ADR-018).

### Contexts

| Context | Process | Owns | Public interface (today → target) |
|---|---|---|---|
| Identity | API | `tenants, sites, admin_accounts, sessions, password_reset_codes, login_throttle` | `modules/identity.py`, dependency `admin()` |
| Factory Model | API | `resource_types, resources, relation_types, resource_relations, type_adjacency, hierarchy_*` | `modules/resources.py` |
| Collector Config | API | `connections` (configuration columns), `acquisition_jobs, source_fields, signal_definitions, signal_bindings, mapping_definitions, formula_*, secret_store` | `modules/collect.py` → `CollectorConfigService`; read contract `contracts/config-revision.md` |
| Acquisition | acquisition | SQLite spool, LKG snapshot file, `JobHealth`, leader advisory lock | emits `obs-batch.v2`, connection report, heartbeat, commissioning results |
| Telemetry Pipeline (Ingestion) | ingestion | `latest_signal_state`, `observation_quarantine`, TDengine `op_*`, dedup LRU, signal recording state | consumes `obs-batch` v1/v2, emits NOTIFY `factorix_stream_events` |
| Health | API (evaluator) + acquisition (evidence) | `connections.health / last_error / last_success_at`, `collector_runtime_status` | `domain/health.py` → `HealthService` (Phase C2) |
| Live State | API | API live cache, `PipelineEvidence`, `Hub` | `TDengineLiveStateProvider`, `refresh_live_message`, WS `/stream` → `FreshnessService` (Phase C1) |
| History | API (read only) | — (reads TDengine op / managed / snapshots) | `history_repository`, `historian_service` → `HistoryQueryService` (Phase C3) |
| Storage | API | `storage_objects, storage_object_drafts, storage_bindings, storage_operations`; logical `storage_designs*` | `storage_revisions` saga, `storage_bindings`, `storage_topology` |
| Recording | ingestion (signal), API model worker (model field) | signal policy state (RAM), `storage_field_state`, `storage_record_outbox` | `recording_policy`, `storage_model_recorder` (ADR-016) → shared pure `decide()` (Phase C4) |
| Data Models | API | `output_groups*, model_templates, model_refs, model_state, model_snapshots` | `data_models`, `models_engine` |
| Telemetry Lifecycle (Reset) | API | `telemetry_generations` | `telemetry_reset` saga; other stores purged through ports (Phase C10) |
| Legacy Edge (frozen) | API, only in edge mode | `edge_nodes, edge_enrollment_tokens, configuration_drafts/releases, deployment_events` | `/api/v1/edge-sync/*` (410 in acquisition mode), `/api/v1/edges` (still the collector status API) |

### Ownership map of shared resources

| Resource | Owner | Current extra writers (frozen, to be routed through the owner) |
|---|---|---|
| `connections` config columns | Collector Config | `transport/app.py` (`POST /api/v1/jobs` touches `acquisition_jobs`) |
| `connections.health*` | Health | acquisition `pg_control` (via `apply_connection_report`), Center sweep `app.py::_evaluate_connections`, `collect` pause/resume/archive, ingestion (edge mode), `edge_sync`, `telemetry._mark_connections_live` |
| `collector_runtime_status` | Health (one row per process; each role writes only its own row) | — |
| `latest_signal_state` | Ingestion | `telemetry` (edge path), `telemetry_reset` (purge) |
| `commissioning_jobs` | Collector Config (commissioning) | acquisition (claim/finish), `edge_sync`, `app.py` reaper, `telemetry_reset` |
| `audit_events` | `modules/common.audit` | ingestion, acquisition, `app.py` (own INSERTs with the same columns) |
| `edge_nodes` | Legacy Edge | `collect`, `edge_sync`, `app.py`, `telemetry_reset`, **acquisition** (compat heartbeat) |
| `storage_objects`, `storage_bindings` | Storage | `transport/storage_api.py` (direct SQL) |
| `storage_operations` | Storage (operations log) | `storage_designs`, `storage_revisions`, `telemetry_migrator`, `telemetry_reset`, `storage_api` |
| `storage_physical_registry` | Storage (to be merged into `storage_objects`, Phase C5) | `storage_compiler`, `storage_designs`, `storage_revisions` |
| `model_state`, `model_snapshots` | Data Models | `telemetry_reset` |
| `storage_field_state`, `storage_record_outbox` | Recording (model field) | `telemetry_reset` |
| `telemetry_generations` | Reset | — (6 readers: to be one `epoch_repo`) |
| RabbitMQ exchange / queues / DLQ | Telemetry Pipeline (provisioning) | acquisition publisher also declares the topology (CT-08) |
| NOTIFY channels | the producer listed in `contracts/notify.md` | — |
| TDengine `fx_t_<tenant>` DB, `op_*` STABLEs | Ingestion (writes) / Storage (DDL) | Reset (`DELETE FROM` every STABLE) |
| User STABLEs / subtables | Storage (DDL) | rows: Ingestion (signal bindings), Recording dispatcher (model fields) |

### Concept owners (single source of truth)

| Concept | Owner | Everybody else |
|---|---|---|
| Freshness / effective status | `domain/signal_state.py` rule, evaluated in the API with evidence | call the API evaluator; never re-implement thresholds (CT-10) |
| Quality vocabulary | `domain/signal_state.SourceQuality/Freshness/EffectiveStatus/ReasonCode` | `domain/quality.Freshness` and `freshness_status` are archival (CT-11) |
| Connection health transitions | `domain/health.apply_connection_report` + sweep predicates | no other module computes health |
| Telemetry wire format | `domain/canonical.py` | publisher/consumer import it; no second encoder of the item format |
| Config revision | acquisition `config_provider` today → PG sequence (Phase C) | readers never derive their own |
| Heartbeat schema | each role for its own row | readers parse through one function (Phase C/D4) |

## Consequences

- Phase B moves code without changing these owners; Phase C removes the "extra writers" column row by row, each with a
  test that greps for the forbidden SQL (e.g. `UPDATE connections SET health` only in the Health module).
- A change that adds a writer to a resource owned by another context needs an ADR amendment.
- The characterization tests under `apps/center/tests/contracts/` are the safety net for every move.
