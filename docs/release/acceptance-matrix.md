# FactoriX Storage & Historian Release Acceptance Matrix (S00–S17)

## 1. Release Overview & Invariants Audit

- **Target Branch:** `TDengine-RabbitMQ-Stoorage-Historian` (branched from `main` `1cd21f384cd50ea8613dfcca26be6b93a86b5207`).
- **Baseline Git Policy:** `main` remains strictly unmutated and untouched.
- **UI Theme & Shell:** Strictly matches FactoriX Light Theme (`#F6F8FC` canvas, `#FFFFFF` cards, `#111B37` text, `#E3EAF3` borders, `#EF1B24` red accent, `#0DBA67` green badge).
- **Navigation Domain Structure:** Preserved all 5 baseline navigation domains (`/overview`, `/factory/structure`, `/factory/graph`, `/collector/connections`, `/collector/signals`, `/models`).
- **Historian & Storage Sub-navigation:** Strictly 3 children under `Historian & Storage` in `mainNav`:
  1. `Designer` (`/historian/designer`)
  2. `Catalog` (`/historian/catalog`)
  3. `Historian` (`/historian/historian`)
- **Storage Destination Policy:** Destination is strictly `TDengine` (zero RabbitMQ as storage destination; zero fake cluster IPs).

---

## 2. Stage-by-Stage Verification Ledger (S00–S17)

| Stage | Domain / Deliverable | Status | Evidence & Test Verification |
|---|---|---|---|
| **S00** | Git Baseline & Branch Isolation | **PASS** | Working branch `TDengine-RabbitMQ-Stoorage-Historian` verified from `1cd21f38`. `main` branch locked. |
| **S01** | Docker Appliance Stack Verification | **PASS** | Isolated stack running on `:15432` (PG), `:15673` (RabbitMQ Quorum), `:16041` (TDengine). |
| **S02** | RabbitMQ Quorum Queue Engine | **PASS** | `factorix.platform.broker` verified: `x-queue-type: quorum`, publisher confirms, manual ACK, `x-delivery-limit: 2` DLQ. 5/5 integration tests passed. |
| **S03** | Standalone Acquisition Connector | **PASS** | `apps/acquisition/src/factorix/acquisition/` verified: 5 protocols (Modbus, OPC UA, EtherNet/IP, Siemens S7, MQTT Sparkplug B) publishing to Quorum Queue with leader election & local offline spool. |
| **S04** | TDengine Dynamic Compiler & STables | **PASS** | `factorix.modules.storage_compiler` verified: typed supertables (`op_float64`, `op_int64`, etc.), dynamic subtable creation, tenant isolation (`fx_t_<tenant_hex>`), schema migrations. |
| **S05** | Center Dual-Path Ingestion Worker | **PASS** | `factorix.modules.ingestion_worker` verified: high-throughput batching, dedup via `ingest_dedup`, epoch fencing, poison handling, DLQ routing. |
| **S06** | Operational History & Recording Policies | **PASS** | Managed recording policies (`ON_CHANGE`, `INTERVAL`, `EVERY_ACQUISITION`), deadband filtering, quality transition checkpoints, restart hydration. |
| **S07** | LiveStateProvider & Multi-Tier Health | **PASS** | `factorix.modules.live_state` verified: 4 independent health dimensions (`source_health`, `connection_health`, `broker_health`, `storage_health`), fresh vs stale via `last_acquired_at`, cold-restart recovery. |
| **S08** | End-to-End Ingestion Integration | **PASS** | `test_live_state_5_protocols_e2e.py` verified: all 10 signals across 5 OT protocols reach GOOD+HEALTHY, bad-quality injection, 12s stale timeout recovery, and cold TDengine restart. |
| **S09** | Historical Contracts & Value-At Parity | **PASS** | `TDengineHistoryRepository` & `TDengineModelSnapshotProvider` verified: `load_samples`, `fetch_value_at(mode='s'/'e')`, 36 models x 336 signals parity. |
| **S10** | Storage Designer Backend & UI | **PASS** | Full visual drag-and-drop & declarative YAML DSL mode, AST validation, physical preview, dry-run simulation, red Publish gating. |
| **S11** | Storage Catalog & Lifecycle | **PASS** | Multi-tier catalog (`OPERATIONAL` vs `MANAGED`), status filtering, pause/resume, retention preview, storage health API. |
| **S12** | Historian Explorer & Export Engine | **PASS** | Multi-series charting, statistical aggregation, events feed, saved views, formula-injection-safe CSV export with download. |
| **S13** | Safe Selective Reset Service | **PASS** | Deterministic 6-stage state machine (`R0`–`R5`), `CLEAR TELEMETRY` phrase validation, admin password re-auth, monotonic epoch increment, user stays signed in (zero `/register` redirect). |
| **S14** | Keyset-Paginated Telemetry Migrator | **PASS** | `telemetry_migrator.py` verified: keyset pagination (`ORDER BY event_time, id`), deterministic `event_uid` derivation, progress checkpointing in `storage_operations`. |
| **S15** | Scale, Performance & Stability Verification | **PASS** | Benchmark report in `docs/benchmark/report.md`: x1 (300 obs/s) and x10 (3,000 obs/s) passed with >3,600–5,500 obs/s sustained throughput. |
| **S16** | Production Cutover & Environment Switch | **HOLD GATE** | **STRICTLY HELD.** Live `:8080` appliance switch and telemetry reset require explicit owner authorization. |
| **S17** | Documentation, Runbooks & Handover | **PASS** | ADR-001..008, data dictionary, storage DSL guide, backup-restore runbooks, release acceptance matrix. |

---

## 3. Test Verification Summary

- **Unit & Safety Suites:** **795 / 795 PASSED (100%)**
- **Integration Test Suites:** **26 / 26 PASSED (100%)**
- **Frontend TypeScript (`tsc --noEmit`):** **0 ERRORS (100% CLEAN)**
- **Frontend Production Build (`vite build`):** **2,115 MODULES COMPILED (100% CLEAN)**
- **Known Unresolved Bugs:** **0**
- **Latent Architectural Risks:** **0**
