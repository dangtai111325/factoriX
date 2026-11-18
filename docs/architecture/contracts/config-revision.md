# Contract: configuration flow PostgreSQL → acquisition / ingestion

| | |
|---|---|
| Writer | API only (`collect`, `resources`, `data_models`, `storage_*`, `transport/app.py`) |
| Wake-up | NOTIFY `factorix_config_changed` / `factorix_epoch_changed` / `factorix_commissioning` (`notify.md`) — payload is a hint only |
| Readers | acquisition `config_provider.load_pg_snapshot` (+ LKG file); ingestion `PgIngestionStore.load_tenant_catalog` |
| Version | snapshot `schema_version = "fx.acquisition.config.v1"`; `revision` is **derived**, not stored |
| Tests | `apps/center/tests/contracts/test_runtime_status_contract.py::test_config_revision_*` |

## 1. Acquisition snapshot

`load_pg_snapshot(conn, prev_revision, prev_digest)` runs one `REPEATABLE READ READ ONLY` transaction:

| Section | Source (filter) |
|---|---|
| `connections` | `connections` (status ≠ ARCHIVED) ⋈ `secret_store` (`secret_hash` = sha256 of ciphertext; sensitive config keys stripped) |
| `jobs` | `acquisition_jobs` of those connections |
| `source_fields` | `source_fields` of those jobs (ordered by job, ordinal) |
| `signal_bindings` | enabled, `valid_to IS NULL`, signal ACTIVE, connection not archived (+ signal key/resource/data_type/unit) |
| `formulas` | `formula_definitions` PUBLISHED of ACTIVE signals |
| `tenant_epochs` | `telemetry_generations.active_epoch` (default 1) |

Then `structure_sha256 = sha256(connections, jobs, source_fields, signal_bindings, formulas, tenant_epochs)`,
`checksum_sha256` over the whole snapshot without `issued_at`, and:

```
max_entity_rev = max(MAX(configuration_releases.revision), connections.version, jobs.config_revision, bindings.revision)
revision = prev_revision                  if digest unchanged
         = prev_revision + 1              if digest changed but no entity counter went above prev_revision
         = max(1, max_entity_rev)         otherwise (also on every cold start: prev_revision = 0)
```

`ConfigProvider.fetch_if_changed` saves every changed snapshot to the LKG file
(`FACTORIX_LKG_CONFIG_PATH`, secrets stripped) and the runtime applies it (`mark_applied`). The applied
`revision` is stamped on every observation (`config_revision`, `provenance.config_revision`) and on the
acquisition heartbeat row.

Re-read triggers: NOTIFY wake-up (< 100 ms), a 10 s poll (`config_s`), and every LISTEN reconnect. A PG
outage at cold start falls back to the LKG snapshot.

## 2. Ingestion catalog

Per tenant, cached: full reload when older than 30 s or invalidated by NOTIFY; epoch re-read every 2 s; a
catalog miss forces a refresh at most every 2 s. Reads signal definitions, bindings, formulas, both storage
binding tables (`storage_bindings` physical — `source_kind='signal'` — and the logical design bindings),
recording policies and the active epoch.

## 3. Rules

* The API is the only writer of configuration tables; acquisition and ingestion never write them
  (acquisition writes only health/heartbeat/commissioning/audit/`edge_nodes`, see ADR-017).
* NOTIFY payloads are hints: a reader must re-read PostgreSQL and must not trust payload contents for
  configuration (acquisition ignores them entirely).
* Every configuration transaction must either bump an entity counter it changes or rely on the digest;
  the revision a collector reports must never go down (target: a PG sequence `config_revision_seq`, Phase C).

## Known discrepancies

* **CT-07** — `revision` is process-local. After an acquisition restart (`prev_revision = 0`) it is recomputed
  as `max_entity_rev`, which is lower than the revision reached through `+1` digest bumps before the restart:
  observations and the heartbeat then report a **smaller** `config_revision` for the same configuration.
  Mutations that change no entity counter (e.g. `POST /api/v1/jobs` updates `mode`/`interval_ms` without
  `config_revision`; source field / formula edits) are only visible through the digest.
  **Fixed (ARCH-C):** `ConfigProvider` starts from the LKG revision + structure hash after a restart and
  `load_pg_snapshot(revision_floor=…)` never returns less than the revision of the last acquisition heartbeat;
  `POST /api/v1/jobs` bumps `acquisition_jobs.config_revision`.
