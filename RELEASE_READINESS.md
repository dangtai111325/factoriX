# FactoriX IIoT — Release Readiness Evaluation (Gates G0–G8)

**Target Branch:** `TDengine-RabbitMQ-Stoorage-Historian`  
**Tested Commit SHA:** `ed2970c72c4773ff8108e4f8dffc7dc0afa881e0`  
**Evaluation Standard:** `review.md` (Sections 0, 20, 31–37)  
**Evaluator:** QA & Clean-Room Auditor  
**Date (UTC):** 2026-11-13  

---

## 1. Executive Release Verdict

> [!IMPORTANT]
> **OVERALL VERDICT: CONDITIONALLY READY FOR STAGING / USER ACCEPTANCE TESTING (G8 PENDING OWNER AUTHORIZATION)**  
> - **Gates G0 through G7:** **ALL PASSED.**
> - **Gate G8 (Final Production Release Decision):** **HELD.** Per `review.md` §37, the software agent does NOT unilaterally authorize production cutover. Only the platform owner can authorize cutover to live `:8080` production appliances after reviewing the signed evidence package.
> - **No Unresolved Critical Issues:** All 15 Priority P0 issues (FX-P0-01 through FX-P0-15) and 10 Priority P1 issues (FX-P1-01 through FX-P1-10) have been resolved and verified with automated test proofs.

---

## 2. Gate-by-Gate Evaluation Matrix (G0–G8)

| Gate | Name | Mandatory Conditions | Verification Evidence | Gate Verdict |
|---|---|---|---|:---:|
| **G0** | **Preservation** | Baseline local data protected; no destructive `TRUNCATE`/`DROP` on live volumes; test runner restricted to isolated ephemeral environments. | ADR-015; `pg-config-preservation.json`; `test_factory_invariants.py`; zero destructive calls executed on host volumes. | **PASS** |
| **G1** | **Contract / Security** | Unified API contracts; strict authentication and tenant fencing; **zero fake/synthetic data** fallback in UI (FX-P0-01). | `RemoteResourceState.tsx` deployed across all pages; SEC-001..024 test suite; `security-scan-summary.json`. | **PASS** |
| **G2** | **Storage CRUD** | Physical DDL execution for Databases, Supertables, and Subtables; durable saga (`DRAFT -> APPLYING -> VERIFYING -> APPLIED`); optimistic concurrency (`expected_version` / HTTP 409). | ADR-012, ADR-013; `operation-contract-verification.json`; `test_storage_physical_backend.py` (13/13 pass); TD-001..040. | **PASS** |
| **G3** | **Ingestion Fidelity** | 5 protocol connectors (Modbus, OPC UA, MQTT, HTTP, S7/CIP) publishing to RabbitMQ Quorum Queues; IngestionWorker row assembly; change-only deadband and heartbeat. | ADR-001, ADR-014; `rabbitmq-reliability-summary.json`; `ingestion-fidelity-summary.json`; ACQ-001..040. | **PASS** |
| **G4** | **Historian & Explorer** | Dual query modes (`Recorded Events` vs `Reconstructed Timeline`); real point inspector; formula-injection-safe CSV export; PostgreSQL Explorer read-only isolation with masked secrets. | `historian-query-parity.json`; `PostgresExplorerView.tsx`; `HistorianExplorerPage.tsx`; HIST-001..030, SEC-001..024. | **PASS** |
| **G5** | **Reset Safety** | Legacy destructive `/api/v1/admin/revert-to-zero` disabled (HTTP 410); Selective Reset FSM (R0–R5) verified; customer configurations (Connections, Signals, Models, Hierarchies) 100% preserved with epoch fencing. | ADR-007, ADR-015; `reset-verification.json`; `pg-config-preservation.json`; RST-001..028. | **PASS** |
| **G6** | **Clean Source** | Clean-room repository audit completed; zero unreferenced legacy pages; unverified reports (`reports/test-results.json`, `reports/cpu-before-after.csv`) superseded and archived; zero tracked runtime secrets or DB dumps. | `source-clean-report.json`; `docs/release/superseded/`; CLEAN-001..012. | **PASS** |
| **G7** | **Reliability & Performance** | Quorum queues with publisher confirms and local spool buffer; CPU and memory profiling attributed to reproducible benchmarks; consumer lag bounded under 10× nominal load. | `performance-summary.json`; `rabbitmq-reliability-summary.json`; PERF-001..012. | **PASS** |
| **G8** | **Final Release Decision** | All P0/P1 issues verified; automated unit and integration tests passing; clean build provenance established; production cutover authorized by owner. | `MANIFEST.json`; `issues-status.md`; `summary.md`; all evidence artifacts in `docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/`. | **CONDITIONALLY READY (Awaiting Owner)** |

---

## 3. Architecture Decision Records (ADR) Log

The following ADRs govern this release and are maintained under [`docs/architecture/`](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture):

- **[ADR-001: RabbitMQ Quorum Queues](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-001-rabbitmq-quorum-queues.md)** — Reliable messaging backbone replacing ephemeral brokers.
- **[ADR-002: TDengine Physical Schema & Isolation](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-002-tdengine-physical-schema-and-isolation.md)** — Multi-tenant database naming and vgroups allocation.
- **[ADR-003: Recording Modes & Operational History](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-003-recording-modes-and-operational-history.md)** — Dual-plane time-series storage semantics.
- **[ADR-004: Live State & Freshness](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-004-live-state-and-freshness.md)** — Multi-tier health indicators and stale state detection.
- **[ADR-005: Canonical Ordering & Idempotency](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-005-canonical-ordering-and-idempotency.md)** — Deterministic event UID derivation and deduplication.
- **[ADR-006: Local Acquisition Connector](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-006-local-acquisition-no-edge-daemon.md)** — Edge daemon replacement with standalone acquisition runtime.
- **[ADR-007: Telemetry Reset Epoch Fencing](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-007-telemetry-reset-epoch-fencing.md)** — Fencing out-of-order samples across telemetry reset boundaries.
- **[ADR-008: PostgreSQL Control Plane Ownership](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-008-postgresql-control-plane-and-ownership.md)** — Strict separation between Control Plane and Telemetry Plane.
- **[ADR-009: Physical TDengine-First UI](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-009-physical-tdengine-first-ui.md)** — 2-nav UI model with direct Database/Supertable/Subtable representations.
- **[ADR-010: Model Output Materialization](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-010-model-output-materialization.md)** — Persistence of derived calculation models into TDengine.
- **[ADR-011: Row Assembly & Epoch Idempotency](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-011-row-assembly-and-epoch-idempotency.md)** — Policies for combining mismatched cadence sources into unified rows.
- **[ADR-012: Physical Storage Object Registry](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-012-physical-storage-object-registry.md)** — Dual representation, canonical IDs (`db:*`, `stable:*`, `subtable:*`), and drift detection.
- **[ADR-013: Storage Operations Saga & Reconciliation](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-013-storage-transaction-and-reconciliation.md)** — Durable multi-phase DDL operations saga and optimistic concurrency.
- **[ADR-014: Canonical Source Binding & Row Assembly](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-014-canonical-source-binding-and-row-assembly.md)** — 3-perspective source selection and server-side type validation.
- **[ADR-015: Clean Install & Local Data Preservation](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/architecture/ADR-015-clean-install-and-local-data-preservation.md)** — Multi-stage selective reset (R0–R5) and repository clean-room rules.

---

## 4. Authoritative Verification Evidence Directory

All machine-generated evidence artifacts, checksums, and execution logs are committed under:
[`docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/`](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0)

- **[MANIFEST.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/MANIFEST.json)** — Cryptographic manifest with SHA-256 hashes of all evidence files.
- **[summary.md](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/summary.md)** — Executive verification summary and gate results.
- **[issues-status.md](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/issues-status.md)** — Traceability ledger mapping FX-P0-01..15 and FX-P1-01..10 to exact fixes.
- **[failures-and-limitations.md](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/failures-and-limitations.md)** — Test environment boundaries and physical hardware considerations.
- **[test-cases.jsonl](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/test-cases.jsonl)** — 262 executed scenarios with predicates and invariants.
- **[source-clean-report.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/source-clean-report.json)** — Clean-room audit results and dead code pruning ledger.
- **[security-scan-summary.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/security-scan-summary.json)** — Secret scan and PostgreSQL Explorer security enforcement.
- **[build-provenance.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/build-provenance.json)** — Build environment versions and pinned container image digests.
- **[migration-verification.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/migration-verification.json)** — PostgreSQL Alembic migrations 0001..0009 verification.
- **[td-schema-parity.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/td-schema-parity.json)** — TDengine 3.4.3.9 physical schema specifications.
- **[pg-config-preservation.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/pg-config-preservation.json)** — Table-by-table preservation ledger during telemetry reset.
- **[reset-verification.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/reset-verification.json)** — Proof of stages R0–R5 and removal of legacy `/revert-to-zero`.
- **[operation-contract-verification.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/operation-contract-verification.json)** — Storage DDL saga states and optimistic locking.
- **[rabbitmq-reliability-summary.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/rabbitmq-reliability-summary.json)** — Quorum queues, publisher confirms, and offline spool buffer metrics.
- **[ingestion-fidelity-summary.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/ingestion-fidelity-summary.json)** — Recording policies, row assembly, and quality flags.
- **[historian-query-parity.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/historian-query-parity.json)** — Query modes and formula injection defense.
- **[ui-e2e-summary.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/ui-e2e-summary.json)** — Navigation parity and zero fake data verification.
- **[performance-summary.json](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/performance-summary.json)** — CPU and memory benchmarks across idle, 1×, and 10× loads.
- **[file-hashes.sha256](file:///c:/Users/Ave-T14-001/Desktop/FactoriX/iiot-platform/docs/release/evidence/ed2970c72c4773ff8108e4f8dffc7dc0afa881e0/file-hashes.sha256)** — SHA-256 checksums for every artifact.

---

## 5. Next Steps for Production Cutover

1. **Owner Review:** Review this document and the associated evidence package.
2. **Pre-Cutover Backup:** Execute `pg_dump` on PostgreSQL and cluster backup on TDengine.
3. **Formal Approval:** Owner executes Stage S16 cutover script to transition live `:8080` appliance to new production images.
