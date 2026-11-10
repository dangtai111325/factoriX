# FactoriX Data Dictionary — PostgreSQL Control Plane (`0008`) & TDengine Data Plane

**Migration Revision:** `0008_storage_and_historian` (extends `0007_data_model_v2`)  
**TSDB Engine:** TDengine `3.3.6.13` Community Edition (`PRECISION 'us'`)

---

## 1. PostgreSQL Control Plane Tables (`public` schema)

| Table | Purpose | Key Columns & Constraints | Preserved on Telemetry Reset? |
|---|---|---|---|
| `collector_runtime_status` | Local `factorix_acquisition` process status, backlog, RabbitMQ readiness | `instance_id` PK, `role`, `health`, `software_version`, `config_revision`, `spool_pending`, `fast_buffered`, `broker_ok`, `queues_json`, `diagnostic`, `last_heartbeat`, `updated_at` | Config metadata preserved; runtime counters update cleanly |
| `telemetry_generations` | Per-tenant monotonic epoch & reset lifecycle fence (`ADR-007`) | `tenant_id` PK FK(`tenants`), `active_epoch` (`>= 1`), `lifecycle_state` (`ACTIVE`, `RESETTING`, `FAILED_FENCED`), `updated_at`, `updated_by`, `reset_operation_id` | Preserved and incremented atomically (`active_epoch += 1`) |
| `storage_designs` | Mutable user Storage Design definitions & draft AST | `id` PK, `tenant_id`, `name` (tenant active unique), `scope_json`, `draft_ast_json`, `draft_ui_meta_json`, `draft_revision`, `status`, `current_version`, `published_version_id`, `owner_id`, `last_validation_json`, `archived_at` | **YES — 100% Preserved** |
| `storage_design_versions` | Immutable published AST snapshots, hashes & compiled TDengine DDL plans | `id` PK, `design_id` FK, `version`, `ast_json`, `ast_hash`, `semantic_hash`, `ui_meta_json`, `compiler_version`, `ddl_plan_json`, `plan_hash`, `publish_state`, `effective_from_epoch`, `applied_at` | **YES — 100% Preserved** |
| `storage_datasets` | Logical time-series datasets belonging to a Storage Design | `id` PK, `design_id` FK, `dataset_key`, `resource_scope_json`, `semantics` (`state_series`, `event_stream`, `structured_record`), `source_kind`, `time_axis`, `tags_json`, `status`, `current_schema_version` | **YES — 100% Preserved** |
| `storage_field_bindings` | Field mappings inside each dataset bound to stable Signal/Model IDs | `id` PK, `dataset_id` FK, `field_key`, `value_type`, `max_length`, `source_kind`, `signal_id`, `model_id`, `model_field_path`, `resource_id`, `source_ref`, `source_revision`, `transform_json`, `nullable`, `required`, `unit` | **YES — 100% Preserved** |
| `storage_recording_policies` | Per-dataset recording strategy, deadband, keepalive & retention metadata | `id` PK, `dataset_id` UNIQUE FK, `mode` (`ON_CHANGE`, `EVERY_ACQUISITION`, `INTERVAL`), `policy_json`, `retention_json`, `version`, `enabled`, `legal_hold` | **YES — 100% Preserved** |
| `storage_physical_registry` | Explicit PG ownership map of every TDengine database, supertable & subtable | `id` PK, `tenant_id`, `tier` (`OPERATIONAL`, `MANAGED`, `MODEL_SNAPSHOT`), `design_id`, `design_version_id`, `dataset_id`, `signal_id`, `series_key`, `value_type`, `td_database`, `td_stable`, `td_subtable`, `physical_schema_hash`, `generation`, `status` | **YES (Schema Ownership Preserved; only row data cleared on reset)** |
| `storage_dependencies` | Impact graph tracking refs across designs, signals, models, views | `id` PK, `tenant_id`, `owner_type`, `owner_id`, `target_type`, `target_id`, `target_subpath`, `kind` | **YES — 100% Preserved** |
| `storage_operations` | Durable saga journal for Publish, Retention Purge, Telemetry Reset & PG Migration | `id` PK, `tenant_id`, `operation_type`, `target_type`, `target_id`, `actor_id`, `idempotency_key`, `status`, `step_state_json`, `error_code`, `trace_id` | Security/reset audit preserved |
| `saved_queries` *(extended)* | Historian Saved Views & Queries | Original columns + `owner_id`, `description`, `query_spec_json`, `chart_options_json`, `is_default`, `version`, `created_at`, `updated_at` | **YES — 100% Preserved** |
| `export_jobs` *(extended)* | Historian & Storage async export queue and artifacts | Original columns + `format`, `output_ref`, `file_name`, `byte_size`, `expires_at`, `started_at`, `completed_at`, `error_code`, `error_message`, `data_epoch` | Export files/telemetry results cleared on reset |
| `latest_signal_state` *(extended)* | Fast latest state cache / UI hydration | Original columns + `last_acquired_at`, `last_value_changed_at`, `data_epoch`, `source_sequence`, `reason_code`, `event_uid` | **Cleared** (`NO_DATA` / `UNKNOWN` after reset) |
| `connections.edge_id` | Made nullable (`DROP NOT NULL`) | Local FactoriX Acquisition does not require an enrolled Edge node | **Connections 100% Preserved** |

---

## 2. TDengine Data Plane Physical Layout

Each FactoriX tenant maps deterministically to its own isolated database:
- **Database:** `fx_t_<tenant_uuid_hex>` (`PRECISION 'us'`, `CACHEMODEL 'last_row'`, `CACHESIZE 16`)
- **System Operational History STables (Full-Fidelity Operational Tier):**
  - `op_float64` (`val DOUBLE`), `op_int64` (`val BIGINT`), `op_bool` (`val BOOL`), `op_string` (`val NCHAR(4096)`), `op_json` (`val VARCHAR(32768)`)
  - Columns: `(ts TIMESTAMP, val <TYPE>, acquired_at TIMESTAMP, source_time TIMESTAMP, raw_quality NCHAR(16), reason_code NCHAR(64), origin NCHAR(16), unit NCHAR(32), event_uid NCHAR(64), config_rev BIGINT, data_epoch BIGINT, source_seq BIGINT, record_kind NCHAR(24))`
  - Tags: `(signal_id NCHAR(36), resource_id NCHAR(36), connection_id NCHAR(36))`
  - Subtable Name: `op_<type>_<signal_uuid_hex>`
- **Model Snapshots STable:**
  - `model_snapshots`: `(ts TIMESTAMP, body_text VARCHAR(48000), errors_json VARCHAR(8192), error_count INT, data_epoch BIGINT) TAGS (group_id NCHAR(36))` *(sized cleanly within TDengine's `65,531`-byte max row limit)*
  - Subtable Name: `ms_<group_uuid_hex>`
- **User-Managed Dataset STables:**
  - `ds_<design_hex8>_<dataset_key>_v<ver>` compiled cleanly from `SchemaCompiler` with validated fields, mandatory metadata columns (`ts`, `acquired_at`, `source_time`, `raw_quality`, `reason_code`, `event_uid`, `data_epoch`, `record_kind`), and up to `16` metadata tags.
  - Subtable Name: `md_<dataset_hex8>_<uuid5_hex16>` (mapped explicitly in PG `storage_physical_registry`).
