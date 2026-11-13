# FactoriX Storage & Historian Release Acceptance Matrix [SUPERSEDED]

> [!WARNING]
> **SUPERSEDED SPECIFICATION MATRIX — 3-NAV STALE BASELINE**  
> This acceptance matrix represents the earlier 3-navigation baseline (`Designer`, `Catalog`, `Historian`) and stale 100% PASS claims that were superseded following the architectural audit in `review.md`.  
> The current production architecture is physical-first with **strictly 2 navigations** (`Storage Management` and `Historian`).  
> Authoritative verification is recorded in `RELEASE_READINESS.md` and machine-generated evidence under `docs/release/evidence/<tested-commit-sha>/`.

---

## 1. Architectural Alignment Delta: Stale Matrix vs Current HEAD

| Dimension | Stale Acceptance Matrix (S00–S17) | Current Production Specification (`review.md` & HEAD) |
|---|---|---|
| **Sub-navigation** | 3 children (`Designer`, `Catalog`, `Historian`) | **Strictly 2 children:** `Storage Management` (`/historian/storage`) and `Historian` (`/historian/historian`). Legacy paths redirect with preserved query params. |
| **Object Model** | Logical "Dataset" / DSL abstractions | **Physical-First TDengine objects:** Direct modeling of Databases (`db:*`), Supertables (`stable:*`), and Subtables (`subtable:*`). |
| **Source Picker** | Flat signal / collector selector | **3-Perspective Source Picker:** Hierarchy, Collector, and Data Models perspectives resolving to unified canonical source UIDs. |
| **Row Assembly** | Unspecified / synthetic simultaneity | **Explicit Row Assembly Policies:** `INDEPENDENT_EVENTS`, `LATEST_AS_OF_TRIGGER`, `TIME_BUCKET`, `EXACT_TIMESTAMP` (ADR-011, ADR-014). |
| **Control Plane Safety** | Implicit DB preserve | **Strict Plane Separation & R0–R5 Epoch Fencing:** Complete preservation of PostgreSQL customer configurations; non-destructive reset (ADR-007, ADR-015). |
| **Verification Basis** | Static assertion text in `reports/test-results.json` | **Machine-Generated Artifacts:** Reproducible test runner logs, hashes, and provenance in `docs/release/evidence/<tested-commit-sha>/`. |

---

## 2. Historical Stage Ledger (Archived for Traceability)

| Stage | Historical Domain | Superseded Status | Audit Notes & Current Status |
|---|---|---|---|
| **S00** | Git Baseline & Branch Isolation | SUPERSEDED | Branch `TDengine-RabbitMQ-Stoorage-Historian` verified. Clean-room audit removes dead legacy code. |
| **S01** | Docker Appliance Stack | SUPERSEDED | Multi-container compose configuration audited for credentials, port mappings, and volume boundaries. |
| **S02** | RabbitMQ Quorum Queues | SUPERSEDED | Transport durability verified with publisher confirms, manual ACK, and offline spool buffer. |
| **S03** | Standalone Acquisition Connector | SUPERSEDED | 5 protocols verified. Dead Edge daemon code migration in progress. |
| **S04** | TDengine Dynamic Compiler & STables | SUPERSEDED | Refactored from Dataset DSL to direct physical DDL operations and registry. |
| **S05** | Center Ingestion Worker | SUPERSEDED | Ingestion worker updated with epoch fencing and multi-source row assembly. |
| **S06** | Operational History & Policies | SUPERSEDED | Change-only deadband and heartbeat recording policies enforced. |
| **S07** | LiveStateProvider & Multi-Tier Health | SUPERSEDED | Strict no-fake-data enforcement; real timestamps and quality indicators. |
| **S08** | E2E Ingestion Integration | SUPERSEDED | Verified through integration test suites. |
| **S09** | Historical Contracts & Value-At Parity | SUPERSEDED | TDengineHistoryRepository queries physical tables directly. |
| **S10** | Storage Designer Backend & UI | SUPERSEDED | Replaced by physical Storage Management canvas and wizards. |
| **S11** | Storage Catalog & Lifecycle | SUPERSEDED | Unified into Storage Management object registry and drawer. |
| **S12** | Historian Explorer & Export Engine | SUPERSEDED | 4-tab workspace with dual modes (Recorded vs Reconstructed) and formula-injection-safe CSV exports. |
| **S13** | Safe Selective Reset Service | SUPERSEDED | R0–R5 state machine with epoch fencing and zero configuration loss. |
| **S14** | Keyset-Paginated Telemetry Migrator | SUPERSEDED | Migration verified with progress checkpointing. |
| **S15** | Scale & Performance Verification | SUPERSEDED | Aggregates and run attribution required in `performance-summary.json`. |
| **S16** | Production Cutover & Environment Switch | HELD GATE | Live production deployment requires explicit owner authorization. |
| **S17** | Documentation & Handover | IN PROGRESS | ADR-001..ADR-015, clean-room reports, and `RELEASE_READINESS.md`. |
