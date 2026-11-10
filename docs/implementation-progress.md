# FactoriX — TDengine + RabbitMQ + Historian & Storage Implementation Progress

**Branch:** `TDengine-RabbitMQ-Stoorage-Historian`  
**Base Commit (`main`):** `1cd21f384cd50ea8613dfcca26be6b93a86b5207`  
**Master Spec:** `C:\Users\Ave-T14-001\Downloads\plan.md`  
**Last Updated:** `2026-11-10T17:45:00+07:00`

> Legend: `PASS` = executed and verified against running/isolated target; `IN_PROGRESS` = active stage; `TODO` = not started; `FAIL` = defective gate under remediation; `BLOCKED` = external/hardware blocker recorded with evidence.

| Stage | Name | Status | Key Deliverables | Verification Command / Evidence |
|---|---|---|---|---|
| **S00** | Environment & Ownership Freeze | `PASS` | `docs/baseline/manifest.md`, `docs/architecture/{current-state,target-state}.md`, `docs/testing/{golden-contracts,test-environment}.md`, `docs/operations/backup-restore.md`; offline backups + restore verified in `C:\Users\Ave-T14-001\Desktop\FactoriX\backup\` | Ephemeral PG 17 restore verified; 29/29 Golden API endpoints HTTP 200; baseline unit+safety `600 passed`; web `tsc --noEmit` 0 errors |
| **S01** | Git Branch & CI Foundation | `PASS` | Branch `TDengine-RabbitMQ-Stoorage-Historian` from `main` (`1cd21f38`), old branches archived in verified bundle (`92.86 MB`) and pruned; isolated `docker-compose.test.yml` (PG 17 + RabbitMQ 4.0 + TDengine 3.3.6.13 all healthy), 5-protocol simulators (`tests/simulators/`) & expanded `.github/workflows/ci.yml` | `pytest tests/simulators apps/center/tests/unit apps/edge/tests tests/safety -q` -> `601 passed`; `tsc --noEmit` -> `0 errors`; Docker test stack healthy (`:15432`, `:15673`, `:16041`); Python 3.12 binary wheels verified |
| **S02** | Canonical Observation & Golden Contract Lock | `PASS` | `apps/center/src/factorix/domain/canonical.py` (`CanonicalObservation` v1, provenance redaction, deterministic UID, SLIs), `apps/center/src/factorix/modules/providers.py` (`LiveStateProvider`, `HistoricalValueProvider`, `ModelSnapshotProvider`, `RecordingPolicyEvaluator`), `test_canonical.py`, `test_golden_contracts.py` | `pytest apps/center/tests/unit apps/edge/tests tests/safety -q` -> `620 passed` |
| **S03** | RabbitMQ Transport (Initially Shadow) | `IN_PROGRESS` | `docs/storage/version-matrix.md` + `docs/architecture/ADR-001..008` verified; building `factorix.platform.broker` + settings + integration suite (`:15673`) | POC `reject-publish` + `taosdump` verified (`@ 3263f62`) |
| **S04** | Local Acquisition Extraction (No Old Edge Daemon) | `TODO` | `apps/acquisition/` package inheriting all 5 protocol connectors, direct PG `ConfigProvider`, RabbitMQ publisher, commissioning worker, tests | Pending |
| **S05** | TDengine POC & Schema Compiler | `TODO` | `tdengine/tdengine:3.3.6.13` (`taos-ws-py`) POC + `version-matrix.md` + `ADR-001..006` + `0008_storage_and_historian.py` + AST/DSL compiler | Pending |
| **S06** | Ingestion Refactor & Dual-Path Validation | `TODO` | `IngestionWorker` (RabbitMQ consumer -> epoch fence -> UID idempotency -> TDengine durable write -> manual ACK -> DLQ), parity harness | Pending |
| **S07** | Recording Policy & Operational History | `TODO` | `ON_CHANGE` (default), `EVERY_ACQUISITION`, `INTERVAL` + Operational History full-fidelity tier for 15m sparklines & model lookbacks | Pending |
| **S08** | Live State Provider & Quality Recovery | `TODO` | `LiveStateProvider` backed by TDengine + bounded index, truthful `last_acquired_at` vs `last_value_changed_at`, reconnect without staleness ghosting | Pending |
| **S09** | Historical Queries & Data Model Migration | `TODO` | `HistoryRepository`, `ModelSnapshotProvider`, full API & 36-model / 336-signal parity | Pending |
| **S10** | Storage Designer Full Stack | `TODO` | Designer 4-step workflow (`Define -> Map -> Record -> Review`), Source Explorer, `@xyflow/react` canvas, DSL Code mode AST round-trip, Simulate, Physical Preview, Publish | Pending |
| **S11** | Catalog Full Stack | `TODO` | Catalog index/filters/bulk, Detail page (6 tabs + Operations drawer), lifecycle transitions (`pause`, `resume`, `duplicate`, `archive`, `restore`) | Pending |
| **S12** | Historian Full Stack | `TODO` | Historian 3-pane Trend workspace, Quality/Events lanes, Query Workspace, Saved Views, async CSV Exports, signal/model deep-links | Pending |
| **S13** | Safe Selective Reset (`CLEAR_TELEMETRY_ONLY`) | `TODO` | `TelemetryResetService` (`R0`-`R5`), monotonic `telemetry_generations.active_epoch`, new `RevertToZeroModal` (`CLEAR TELEMETRY` + re-auth), `RESET-01..17` | Pending |
| **S14** | Data Migration, Audit & Cutover Rehearsal | `TODO` | Restartable chunked PG `observations` -> TDengine migrator + parity verification on cloned backup | Pending |
| **S15** | Reliability, Scale & Computer Use E2E | `TODO` | Playwright visible browser `E2E-J01..J07`, `OLD/COL/DM/DES/CAT/HIS/SEC/RESET` matrix, fault injection `F-01..30`, `docs/benchmark/report.md`, `docs/testing/e2e-ledger.csv` | Pending |
| **S16** | Controlled Cutover & User-Authorized Telemetry Reset | `TODO` | Cutover only with explicit user approval on staging/target; never auto-wipe live `:8080` | Pending |
| **S17** | Legacy Removal, Docs & Final Handover PR | `TODO` | Remove `apps/edge` / `/api/v1/edge-sync/*`, complete wiki `README.md`, `docs/release/acceptance-matrix.md`, clean push | Pending |
