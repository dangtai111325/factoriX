# Golden API & Behavior Contracts (5 Core Navigations)

Captured live against baseline appliance (`1cd21f38`) at `2026-11-10T10:15Z` into protected artifact `C:\Users\Ave-T14-001\Desktop\FactoriX\backup\golden-api-baseline-20261110_171156.json`. Zero breaking schema/type changes are permitted across the 5 existing navigation domains (`Overview`, `Factory Model`, `Data Collector`, `Data Models`, `Coming Soon`).

---

## 1. Captured Endpoint Response Contracts (`29/29 HTTP 200`)

| Endpoint | Top-Level JSON Keys / Type | Item / Inner Field Contract Highlights |
|---|---|---|
| `GET /api/v1/auth/status` | `admin_exists`, `bootstrap_enabled`, `setup_code_required`, `appliance` | Boolean flags; never exposes tokens |
| `GET /api/v1/auth/me` | `admin_id`, `tenant_id`, `login`, `email`, `full_name`, `locale`, `timezone`, `role` | Preserved user identity; reset never invalidates or forces `/register` |
| `GET /api/v1/sites` | `items` | `id`, `tenant_id`, `code`, `name`, `timezone`, `created_at` |
| `GET /api/v1/resource-types` | `items` | Preserved hierarchy resource types |
| `GET /api/v1/hierarchy-presets` | preset object | Unchanged preset hierarchy structure |
| `GET /api/v1/resources?view=all&limit=1000` | `items` (`16` active / `28` all incl. archived) | Exact UUID preservation across Factory Model & Graph |
| `GET /api/v1/resources?view=tree&limit=1000` | tree structure | Preserved parent-child topology |
| `GET /api/v1/graph/neighbors?resource_id=...` | `nodes`, `edges`, `truncated`, `as_of` | Preserves Knowledge Graph pan/zoom/neighbors |
| `GET /api/v1/connector-types` | `items` | All 5 OT protocols (`modbus_tcp`, `opcua`, `mqtt`, `http`, `websocket`) |
| `GET /api/v1/connections` | `items` (`5` active) | `id`, `name`, `protocol`, `endpoint_redacted`, `edge_id`, `site_id`, `health`, `status`, `last_error`, `last_success_at`, `version`, `config_json`, `secret_configured`, `edge_name`, `signal_count`, `messages_per_min`, `interval_ms`, `protocol_key`, `config`, `active_binding_count`, `edge_health`, `effective_health` *(secrets always masked; `edge_*` adapter preserved gracefully until S17 UI migration)* |
| `GET /api/v1/signals?limit=1000` | `items` (`336` active; `enabled=true`) | `id`, `key`, `display_name`, `data_type`, `unit`, `category`, `resource_id`, `version`, `expected_interval_ms`, `resource_code`, `resource_name`, `path_code`, `connection_id`, `connection_name`, `connection_protocol`, `connection_status`, `edge_id`, `edge_name`, `address_kind`, `address_json`, `source_ordinal`, `job_id`, `binding_enabled`, `signal_id`, `enabled`, `source` |
| `GET /api/v1/observations/latest?signal_ids=...` | `items` | `tenant_id`, `signal_id`, `resource_id`, `observation_id`, `value_type`, `value_json`, `unit`, `quality`, `event_time`, `received_time`, `source_time`, `config_revision`, `origin`, `last_good_value_json`, `last_good_event_time`, `updated_at`, `key`, `display_name`, `expected_interval_ms`, `nullable`, `value`, `source_quality`, `freshness`, `effective_status`, `reason_code`, `evaluated_at`, `stale_after_ms`, `last_good`, `raw_quality` |
| `GET /api/v1/signals/{id}/latest` | single object | Same exact `29`-field contract as `observations/latest.items[0]` |
| `GET /api/v1/signals/{id}/usage` | `signal_id`, `models` | Referenced Data Models using `{model_id, ...}` |
| `GET /api/v1/observations/history?signal_id=...&from=now-15m` | `items`, `next_cursor`, `downsampled` | `id`, `event_uid`, `event_time`, `received_time`, `source_time`, `value_type`, `value_json`, `unit`, `quality`, `origin`, `config_revision`, `value` |
| `GET /api/v1/observations/aggregate?...` | `fn`, `bucket_ms`, `buckets`, `empty_buckets`, `quality_policy` | Bucket items: `signal_id`, `bucket`, `value`, `good_count`, `sample_count` *(exact full-fidelity counts & sample-weighted average served from TDengine Operational History)* |
| `GET /api/v1/data-models` | JSON array (`36` active models) | `id`, `name`, `description`, `sample_ms`, `state`, `version`, `field_count`, `ref_count`, `machines`, `machine_ids`, `created_at`, `updated_at`, `last_sampled_at`, `error_count`, `body` |
| `GET /api/v1/data-models/{id}` | object (`spec`, `issues`, `latest`) | Full v2 `spec` tree + validation issues + live body |
| `GET /api/v1/data-models/{id}/latest` | `body`, `sampled_at`, `errors`, `fields`, `quality` | Current computed JSON object with key order preserved |
| `GET /api/v1/data-models/{id}/snapshots` | JSON array (up to `5` / `SNAPSHOT_KEEP`) | `sampled_at`, `body`, `errors`, `error_count` |
| `GET /api/v1/data-models/catalog` | `types`, `resources` | Hierarchy picker catalog for Data Model rules |
| `GET /api/v1/data-models/rules/functions` | function spec map | Includes `value_at`, `ts`, `latest_ts`, `now`, arithmetic, filters |
| `GET /api/v1/overview` | summary KPI object | `resources`, `machines`, `active_connections`, `connections_online`, `connections_idle`, `connections_degraded`, `connections_paused`, `connections_working`, `connections_total`, `collector_status`, `data_collection_status`, `last_data_at`, `ingest_per_minute`, `messages_per_min`, `generated_at`, `connection_health`, `recent_errors` |
| `GET /api/v1/storage/overview` | TSDB health summary | `observations`, `oldest`, `newest`, `ingest_per_minute`, `quality`, `quarantine`, `dedup_keys`, `backlog`, `disk_bytes`, `approximate`, `note` |
| `GET /api/v1/storage/ingestion-health` | lightweight metrics | `ingest_per_minute`, `quarantine`, `dedup_keys`, `newest` |
| `GET /api/v1/commissioning` | `items` | `id`, `connection_id`, `status`, `error_code`, `diagnostic`, `started_at`, `completed_at`, `stages_json`, `connection_name`, `protocol` |
| `GET /api/v1/audit-events?limit=20` | `items`, `next_cursor`, `has_more` | `id`, `event_type`, `actor_id`, `entity_type`, `entity_id`, `before_json`, `after_json`, `correlation_id`, `occurred_at`, `severity` |

---

## 2. Semantic Invariants Enforced by Tests

1. **15-Minute Sparklines (`SignalSparkline.tsx`):** Even when user-created designs use `ON_CHANGE` recording (skipping unchanged values), `GET /api/v1/observations/history` and `GET /api/v1/observations/aggregate` return full-fidelity operational samples / sample counts without showing artificial gaps or wrong denominators.
2. **Staleness / Reconnect Separation:** `last_acquired_at` (updated on every valid acquisition, even identical values) determines `FRESH` vs `STALE`, never `last_value_changed_at`.
3. **Time Ordering:** `event_time = received_time` (acquisition timestamp); `source_time` is preserved metadata (`value_at` / provenance) and delayed `source_time` does NOT false-downgrade fresh acquisitions to `BAD`/`STALE`.
4. **Data Model `value_at()` Lookup:** `6/36` active models align signal values at `ts(other_signal)`. The Operational History tier + TDengine lookup MUST match PostgreSQL baseline semantics when identical samples are present.
5. **Safe Revert Compatibility:** Old `{ "confirm": "REVERT" }` requests are explicitly rejected (`400`/`422`); resets require the two-phase `preview` -> `execute` workflow with `CLEAR TELEMETRY`, admin password re-auth, signed preview hash, and keep all protected IDs/schemas intact.
