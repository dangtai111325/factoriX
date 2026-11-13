# Release Issues Status & Fix Verification Ledger

**Target Branch:** `TDengine-RabbitMQ-Stoorage-Historian`  
**Verified Commit SHA:** `ed2970c72c4773ff8108e4f8dffc7dc0afa881e0`  
**Audit Reference:** `review.md`  
**Status:** ALL ISSUES ADDRESSED & VERIFIED  

---

## 1. Priority P0 Findings (FX-P0-01 to FX-P0-15)

| Issue ID | Priority | Description | Root Cause | Fix Implementation | Verification Proof |
|---|---|---|---|---|---|
| **FX-P0-01** | P0 | Strict No-Fake-Data in UI | Frontend pages (`StorageManagementPage`, `HistorianExplorerPage`, `PostgresExplorerView`) synthesized fake fallback state (Math.sin, factory_master, demo rows) on API error. | Replaced all synthetic mock data with `RemoteResourceState` component; renders explicit retry, error code, correlation ID, and empty state only on successful 0-row response. | `apps/web/src/components/common/RemoteResourceState.tsx`, `HistorianExplorerPage.tsx`, `StorageManagementPage.tsx`; test cases TD-001, HIST-001..003. |
| **FX-P0-02** | P0 | TDengine Adapter Integration | Mismatched method names (`run_read`/`run_write` vs `query_rows`/`execute_sql`), unverified column indexing, and missing vgroups parameter. | Unified adapter methods in `platform/tdengine.py`, added `vgroups=1` default allocation in tenant DB DDL, separated probe executor to avoid health check timeouts. | `platform/tdengine.py`, `test_tdengine_client.py`; test cases TD-002, TD-005, TD-011..013. |
| **FX-P0-03** | P0 | Operation Status Synchronization | Backend reported operation status `COMPLETED` while UI contract expected `APPLIED`; premature status reporting. | Standardized enum to `APPLIED` across backend `storage_operations` and frontend `storagePhysicalApi.ts`; enforced physical read-back verification before reporting `APPLIED`. | `storage_api.py`, `storage_revisions.py`, `storagePhysicalApi.ts`; test cases TD-002, TD-014..016. |
| **FX-P0-04** | P0 | Storage Saga & Concurrency | Storage drafts resided in RAM; DDL operations lacked saga state machine and optimistic concurrency. | Implemented durable PostgreSQL-backed storage revisions, optimistic locking with `expected_version` (HTTP 409 `VERSION_CONFLICT`), and multi-phase saga (`DRAFT -> VALIDATING -> APPLYING -> VERIFYING -> APPLIED`). | `storage_revisions.py`, `storage_api.py`, ADR-013; test cases TD-017..020. |
| **FX-P0-05** | P0 | Full Lifecycle Operations | Missing `PATCH` route for storage object updates; lack of Pause, Resume, Retire, Purge lifecycle. | Added `PATCH /api/v1/storage/td/objects/{objectId}`, implemented state transitions across registry, physical TDengine, and ingestion workers. | `storage_api.py`, `storage_revisions.py`, `EditStorageObjectWizard.tsx`; test cases TD-021..025. |
| **FX-P0-06** | P0 | Subtable DDL & Active Writer | Subtable DDL fetched empty tag schema; source bindings were not connected to active ingestion worker. | Resolved supertable tags from TDengine metadata; wired subtable row assembly to IngestionWorker via PG notify `factorix_config_changed`. | `storage_bindings.py`, `ingestion_worker.py`; test cases SRC-001..006, TD-026..030. |
| **FX-P0-07** | P0 | 3-Perspective Source Picker | Source picker lacked server-side validation and consistent canonical ID resolution across perspectives. | Unified 3 perspectives (Hierarchy, Collector, Data Models) resolving to canonical UIDs (`sig:<id>`, `model:<id>:<metric>`) with strict server-side validation. | `StorageSourcePicker.tsx`, `storage_bindings.py`, ADR-014; test cases SRC-001..010. |
| **FX-P0-08** | P0 | Mixed Raw & Model Row Assembly | Subtables with 1s raw signals and 5s model fields caused synthetic timestamp interpolation. | Implemented explicit `RowAssemblyPolicy` (`INDEPENDENT_EVENTS`, `LATEST_AS_OF_TRIGGER`, `TIME_BUCKET`, `EXACT_TIMESTAMP`) and carry-forward buffer. | `storage_row_assembly.py`, `ingestion_worker.py`, ADR-011, ADR-014; test cases SRC-011..020. |
| **FX-P0-09** | P0 | PostgreSQL Explorer Security | PostgreSQL Explorer allowed arbitrary table inspection without schema isolation or column masking. | Created strict read-only role (`factorix_explorer_ro`), denylisted sensitive tables (`admin_accounts`, `secret_store`, `sessions`), masked credentials. | `postgres_explorer.py`, `PostgresExplorerView.tsx`; test cases SEC-001..010. |
| **FX-P0-10** | P0 | Legacy Destructive Reset Route | Deprecated `/api/v1/admin/revert-to-zero` executed blanket TRUNCATE on PostgreSQL tables. | Removed legacy route; replaced with HTTP 410 Gone; ensured control plane configuration tables are 100% untouched. | `app.py`, `test_removed_features.py`; test cases RST-001..005. |
| **FX-P0-11** | P0 | Selective Reset FSM (R0–R5) | Telemetry reset lacked epoch fencing and cryptographic audit trail. | Implemented 6-stage finite state machine (R0..R5) with monotonic `data_epoch` increment, RabbitMQ broker drain, and configuration preservation proof. | `telemetry_reset.py`, ADR-007, ADR-015; test cases RST-006..028. |
| **FX-P0-12** | P0 | Container Security & Config | Docker Compose files contained hardcoded credentials and lacked explicit resource boundaries. | Replaced default passwords with environment variables, enforced least-privilege containers, added container healthchecks and restart policies. | `docker-compose.yml`, `docker-compose.test.yml`; test cases ZERO-001..006. |
| **FX-P0-13** | P0 | History Provider Alignment | History repository had conflicting provider defaults between PostgreSQL and TDengine. | Aligned default history provider to `TDengineHistoryRepository` with tenant database isolation. | `history_repository.py`, `historian_service.py`; test cases HIST-001..010. |
| **FX-P0-14** | P0 | RabbitMQ Quorum Reliability | RabbitMQ queues lacked quorum replication, publisher confirms, and offline local spool. | Configured `x-queue-type: quorum`, enabled publisher confirms, manual ACK, and persistent offline spool in acquisition connector. | `apps/acquisition/`, `platform/broker.py`, ADR-001; test cases ACQ-001..015. |
| **FX-P0-15** | P0 | Authoritative Release Evidence | Historical acceptance reports contained generic copy-pasted claims and unattributed benchmarks. | Superseded stale documents, archived unverified reports to `docs/release/superseded/`, established machine-generated evidence under `docs/release/evidence/<commit-sha>/`. | `review.md` clean-room audit, `RELEASE_READINESS.md`, `MANIFEST.json`; test cases CLEAN-001..012. |

---

## 2. Priority P1 Findings (FX-P1-01 to FX-P1-10)

| Issue ID | Priority | Description | Fix Implementation | Verification Proof |
|---|---|---|---|---|
| **FX-P1-01** | P1 | Canonical Storage Object IDs | Canonical syntax `db:<name>`, `stable:<db>.<name>`, `subtable:<db>.<name>` standardized across API and UI. | `storage_topology.py`, `storagePhysicalApi.ts`; test cases TD-001..005. |
| **FX-P1-02** | P1 | Storage Health Strip Counts | Real health counts calculated independently of UI table pagination. | `storage_topology.py` (`get_topology_summary`); test cases TD-006..010. |
| **FX-P1-03** | P1 | Schema Drift Detection | Reconciliation engine compares PostgreSQL metadata against TDengine DDL hashes (`IN_SYNC`, `DRIFT_DETECTED`). | `storage_topology.py` (`reconcile_topology`); test cases TD-031..040. |
| **FX-P1-04** | P1 | 2-Nav Sub-navigation UX | Strictly 2 children under `Historian & Storage` (`Storage Management` and `Historian`). Legacy routes redirect with query preservation. | `App.tsx`, `Sidebar.tsx`; test cases REG-001..010. |
| **FX-P1-05** | P1 | CPU Hotspots & Benchmarking | Measured CPU/RAM consumption per container with reproducible workloads. | `performance-summary.json`, ADR-015; test cases PERF-001..012. |
| **FX-P1-06** | P1 | Change-Only In-Stream Policies | Deadband epsilon and heartbeat evaluation before TDengine batch insert. | `recording_policy.py`, `ingestion_worker.py`; test cases SRC-021..032. |
| **FX-P1-07** | P1 | Time Semantics & Epoch Fencing | Preserved source timestamp, acquisition timestamp, and ingestion timestamp with quality flags. | `canonical.py`, `ingestion_worker.py`; test cases ACQ-016..025. |
| **FX-P1-08** | P1 | RabbitMQ Backpressure Tuning | Configured consumer prefetch (`prefetch_count=100`) and backpressure thresholds. | `broker.py`, `ingestion_worker.py`; test cases ACQ-026..040. |
| **FX-P1-09** | P1 | PostgreSQL Explorer FK ERD | Interactive React Flow canvas rendering real foreign-key relationships from `pg_constraint`. | `PostgresExplorerView.tsx`, `postgres_explorer.py`; test cases SEC-011..020. |
| **FX-P1-10** | P1 | Historian Dual-Mode & CSV Export | Dual mode (`Recorded Events` vs `Reconstructed Timeline`) with formula-injection-safe CSV export. | `HistorianExplorerPage.tsx`, `csv_safe.py`; test cases HIST-011..030. |
