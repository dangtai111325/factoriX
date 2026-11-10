# Baseline System Manifest (Pre-Migration Freeze)

**Captured At (UTC):** `2026-11-10T10:15:31Z` (API golden capture finalized `2026-11-10T10:25Z`)  
**Source Control Base:** `main` @ `1cd21f384cd50ea8613dfcca26be6b93a86b5207`  
**Implementation Branch:** `TDengine-RabbitMQ-Stoorage-Historian` (branched from pinned `main` SHA)  
**Target Appliance:** `factorix-appliance` (`factorix:latest`, PG 17 volume `factorix-data`, HTTP `:8080`)  
**Protected Backup Location (Outside Git):** `C:\Users\Ave-T14-001\Desktop\FactoriX\backup\`

> **Security Notice:** Plaintext passwords, session cookies, encryption keys (`FACTORIX_DATA_KEY`), and raw OT credentials are excluded from this manifest and repository.

---

## 1. Runtime & Software Versions Observed Live

| Component | Baseline Observation | Source / Evidence |
|---|---|---|
| PostgreSQL Engine | **PostgreSQL 17.11** (Debian `17.11-1.pgdg12+2`) *(Note: legacy `README.md` erroneously cited PG 16)* | `psql` / `Dockerfile` |
| Alembic Head | `0007_data_model_v2` | `alembic_version` table |
| Legacy Transport / Collector | Single container running `uvicorn factorix.transport.app:app` + supervised `python -m factorix_edge` | `infrastructure/docker/entrypoint.sh` |
| Python Runtime (Docker / Host) | Docker `python:3.12-slim-bookworm`; Host `.venv` Python 3.14 | `Dockerfile` / `.venv` |
| Frontend Stack | Vite 5.4.11 + React 18.3.1 + TypeScript 5.6.3 + `@xyflow/react` 12.12.1 | `apps/web/package.json` |
| Baseline Disk Headroom (Host C:) | `306 GiB` free / `652 GiB` total | Host filesystem check |

---

## 2. Protected Configuration Inventory & Exact Parity Checksums

All active AND archived entities recorded below **MUST survive schema migration, Historian rollout, and `CLEAR_TELEMETRY_ONLY` resets with identical UUIDs and configuration definitions**.

| Entity Scope | Active / Running | Archived / Other | Total | Protected UUIDs SHA256 (sorted JSON array) |
|---|---:|---:|---:|---|
| `tenants` | 1 | 0 | **1** | `d153d5c584f0d43cdea167a311acc936b0b1b49e13c88f209e4ff6d8a5c1a191` |
| `sites` | 1 | 0 | **1** | `c137f3c3cee106997e5faf87e2a89bf3caa3b7986a701031fa6ab9d654bd3a1e` |
| `admin_accounts` (`dangtai`) | 1 | 0 | **1** | `8c6014b5f070944910bb7994a12afad6db4ff34debeab62b8ca3e9fb9202c731` |
| `resources` (Factory Model) | 16 | 12 (`ARCHIVED`) | **28** | `76809c39f838bebea67c3f64dbddc8b0f19b56240885a38deb456ae3abe55e46` |
| `connections` (PC03 OT Sources) | 5 (`ACTIVE`) | 2 (`ARCHIVED`) | **7** | `61da8fd3301b4bb76fa30753378262639a5cad624e1d3cb2d17a7b4e2f8439f8` |
| `signal_definitions` | **336** (`enabled=true`) | 8 (`ARCHIVED`) | **344** | `2d0d12fa37df26abc30d4066b1789b9a14619e3289d7eb7e1ca94a53fb6cac` |
| `output_groups` (Data Models) | **36** (`ACTIVE` & `RUNNING`) | 55 (`ARCHIVED`) | **91** | `cf94e9b844bd7a23a455f334703fd492fdefe7f1489fe8b50a841320bfb584de` |
| `secret_store` refs | 4 | 0 | **4** | `a69632fbd0133e43d89dae7579acecd9bef4875b2c5be4639d25ca28fb2810aa` |
| `acquisition_jobs` | 5 active / 2 archived | — | **7** | Linked 1:1 to `connections` |
| `formula_definitions` | 0 | 0 | **0** | Calculated logic currently stored inside Data Model v2 `spec_json` |
| `edge_nodes` *(retired in S04/S17)* | 1 (`Edge DongNai`) | 0 | **1** | Config preserved via `connections` before retiring Edge daemon |

### Active Connections Breakdown (5 OT Protocols against PC03)

| Connection Name | Protocol | Interval (ms) | Bound Active Signals | Baseline Status |
|---|---|---:|---:|---|
| `PC03 Modbus TCP 502` | `modbus_tcp` | 1000 | 48 | `ACTIVE` / `HEALTHY` |
| `PC03 OPC UA 4840` | `opcua` | 1000 | 78 | `ACTIVE` / `HEALTHY` |
| `PC03 MQTT 1883` | `mqtt` | Event-driven | 144 | `ACTIVE` / `HEALTHY` |
| `PC03 HTTP 443` | `http` | 5000 | 18 | `ACTIVE` (observed intermittent timeout `DEGRADED` on `/operator-program` under baseline) |
| `PC03 WebSocket live` | `websocket` | 1000 | 48 | `ACTIVE` / `HEALTHY` |

### Active Signals Breakdown (336 Signals)

- **By `data_type`:** `float64`: `240` | `int64`: `54` | `string`: `42` (Total: `336`).
- **By `expected_interval_ms`:** `1000 ms`: `318` | `5000 ms`: `18`.
- **Archived Signals:** `8` definitions retained cleanly (`total = 344`), excluded from active `/api/v1/signals?limit=1000` count `336`.

### Active Data Models Breakdown (36 Running Models)

- **Total Active `output_groups`:** `36` (all `state = RUNNING`, `sample_ms = 1000`).
- **Total Fields / Signal References:** `540` fields across `408` `model_refs`.
- **Calculated Rules Present:** All `36` models include calculated fields; rule AST functions used in production models are `latest_ts`, `now`, `ts`, `value_at` (`6` models use `value_at(sigA, ts(sigB))` cross-signal temporal alignment). **Operational History MUST support `ts()` / `value_at()` lookbacks and 15m sparklines (`SignalSparkline.tsx`) without gaps caused by `ON_CHANGE` deduplication.**

---

## 3. Baseline Data Plane Footprint (Reason for Migration)

| Metric | Live Measurement |
|---|---|
| PostgreSQL Total DB Size (`pg_database_size`) | `24,125,781,683` bytes (~`24.13 GB` / `22.47 GiB`) |
| `observations_2026_11` partition size | `21,914,886,144` bytes (~`21.9 GB`) |
| `ingest_dedup` table size | `2,477,858,816` bytes (~`2.48 GB`) |
| `observations` estimate (`pg_class` / `/storage/overview`) | `~30.2M` – `32.35M` rows (`3` monthly partitions: `2026_10`, `2026_11`, `2026_12`) |
| Ingest Throughput Observed | `~48,414` obs/min (`~807` obs/s burst / `~300` nominal) |
| Edge SQLite Outbox (`outbox.sqlite` `.backup()`) | `81,317,888` bytes (`~81.3 MB`; `46,946` pending at snapshot moment) |
| `latest_signal_state` | `344` rows (`~14.9 MB` incl. indexes/bloat) |
| `model_snapshots` / `model_state` | `5.98 MB` / `39` states (`1.07 MB`) |
| `observation_quarantine` | `855` rows (`352 KB`) |
| `retention_policies` | `0` rows |

---

## 4. Verified Pre-Migration Artifacts & Restore Proof

1. **PostgreSQL Custom Dump (`pre-tdengine-config-20261110_171156.dump`):** `3,068,040` bytes (`--schema` + control-plane tables; excludes heavy `observations_*` partitions). **Verified restored cleanly into an ephemeral `postgres:17-alpine` container (`table_count=53`, `signals=344`, `output_groups=91`).**
2. **SQLite Outbox Online Backup (`pre-tdengine-outbox-20261110_171156.sqlite`):** `81,317,888` bytes captured safely via `sqlite3.Connection.backup()`.
3. **Observation Window Sample (`pre-tdengine-obs-sample-20261110_171156.csv`):** `5,569,962` bytes (schema/data sample).
4. **Golden API Response Baseline (`golden-api-baseline-20261110_171156.json`):** `1,183,417` bytes, all `29/29` key endpoints HTTP `200`.
5. **Pre-Cleanup Full Git Recovery Bundle (`factorix-precleanup-20261110_171156.bundle`):** `92,862,239` bytes (`SHA256: 2642A9F689F22CC49D9C6DBA6F5BD163153314F9B5FF54104058CFB4665C7BBB`), `git bundle verify` passed, archiving deleted branches `codex-review2` (`88393698`), `iiot-replace-frontend-review2` (`a3ee1cb5`), `new-frontend` (`c8619a5d`).
6. **Baseline Test Suites:** Python `pytest apps/center/tests/unit apps/edge/tests tests/safety -q` -> `600 passed`; Web `npm run check` -> `0 errors`.
