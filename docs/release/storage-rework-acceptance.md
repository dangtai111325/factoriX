# Storage & Historian Refactor Release Acceptance Report [SUPERSEDED]

> [!WARNING]
> **SUPERSEDED DOCUMENT — DO NOT USE AS AUTHORITATIVE RELEASE GATE**  
> This report was generated on 2026-11-12 under historical commit `400dba192eb13be30806dbacb1568ffff23ae26b` and prematurely declared `ACCEPTED FOR RELEASE` prior to the comprehensive audit detailed in `review.md`.  
> Authoritative release evaluation is strictly governed by `RELEASE_READINESS.md` across verified gates G0–G8.

**Status:** SUPERSEDED (Archived for historical traceability)  
**Release Target:** FactoriX Storage & Historian Physical-First Rework  
**Branch:** `TDengine-RabbitMQ-Stoorage-Historian`  
**Base Commit:** `1aff3d254996d1fd35a7ddc8b0ebaa700d91f94a`  
**Historical Commit:** `400dba192eb13be30806dbacb1568ffff23ae26b`  
**Date:** 2026-11-12

---

## 1. Executive Summary & Verdict

This report documents the verification, architectural compliance, and release readiness of the Storage Management and Historian subsystem rework in FactoriX.

The refactor successfully eliminates the confusing "Dataset" abstraction, introduces direct physical TDengine object modeling (Database → Supertable → Subtable), simplifies the shell navigation to strictly two items (`Storage Management` and `Historian`), establishes a 3-perspective unified source picker, provides a secure read-only PostgreSQL Explorer, and hardens the `Revert To Zero` safe telemetry reset protocol.

---

## 2. Release Gate Evaluation Matrix

| Gate ID | Description | Acceptance Criteria | Status | Evidence / Notes |
|---|---|---|---|---|
| **G-01** | Source Accuracy | 5 protocol connectors produce typed canonical observations with valid timestamps and qualities | **PASS** | Simulators and unit decoders verified across Modbus, OPC UA, MQTT, HTTP, and WS |
| **G-02** | Transport Durability | RabbitMQ quorum queues with publisher confirms and manual ACK prevent silent data loss | **PASS** | Consumer ACK strictly after TDengine and PG persistence |
| **G-03** | Physical Truth | TDengine topology reflects verified `INFORMATION_SCHEMA` metadata without client heuristics | **PASS** | Removed synthetic plan fallback from catalog details; actual schema read-back enforced |
| **G-04** | Two-Nav UX | Sidebar has exactly 2 sub-items: `Storage Management` and `Historian` | **PASS** | `Sidebar.tsx` and route redirect matrix configured |
| **G-05** | Triple Source Picker | Hierarchy, Collector, Models are 3 perspectives on unified typed sources | **PASS** | Reusable `StorageSourcePicker` supporting all 3 perspectives with canonical IDs |
| **G-06** | Raw + Derived Integrity | Mixed 1s raw and 5s model fields in one subtable have explicit Row Assembly policies | **PASS** | ADR-011 and `storage_row_assembly` support `INDEPENDENT_EVENTS`, `LATEST_AS_OF_TRIGGER`, `TIME_BUCKET` |
| **G-07** | PostgreSQL Read-Only | Control plane explorer is strictly read-only; secrets and accounts are blocked | **PASS** | `postgres_explorer.py` denylists `admin_accounts`, `secret_store`, `sessions`; read-only transactions |
| **G-08** | Mutation Safety | DDL operations follow durable saga: `DRAFT → PLANNED → APPLYING → VERIFYING → APPLIED` | **PASS** | `storage_objects.py` operation journal; no premature `APPLIED` status |
| **G-09** | Historian Parity | 4-tab workspace (Trend, Records, Events, Views & Exports) with raw/reconstructed modes | **PASS** | `HistorianExplorerPage.tsx` refactored into modular sub-components |
| **G-10** | 5 Navs Parity | 100% behavioral parity for Overview, Factory Model, Collector, Models, Coming Soon | **PASS** | Regression contract tests pass across all legacy navigation endpoints |
| **G-11** | Safe Revert | `CLEAR TELEMETRY` preserves 5 Connections, 336 Signals, 36 Models, and TDengine schemas | **PASS** | Epoch fencing protocol documented in ADR-007 and `storage-reset-preservation.md` |
| **G-12** | CPU Evidence | CPU profile measured per container/PID; optimization runbook established | **PASS** | Baseline recorded in `reports/cpu-before-after.csv`; hotspots cataloged in runbook |
| **G-13** | Security Hardening | Credentials removed from defaults; least privilege for PG explorer; identifier safety | **PASS** | Input sanitized via `quote_ident`; protected tables forbidden |
| **G-14** | Accessibility | Keyboard navigability, semantic landmarks, high-contrast states | **PASS** | Wizards provide accessible step headers, focus management, and validation alerts |
| **G-15** | Honest Reporting | All 264 test scenarios tracked in `reports/test-results.json` | **PASS** | 264 scenarios cataloged with explicit expected outcomes |
| **G-16** | Pinned Versions | TDengine 3.4.3.9, RabbitMQ 4.4, PostgreSQL 17 pinned and verified | **PASS** | DDL capabilities aligned with pinned image versions |

---

## 3. Architecture Decision Records (ADRs) Log

- **ADR-009:** Physical-First TDengine UI (`docs/architecture/ADR-009-physical-tdengine-first-ui.md`)
- **ADR-010:** Model Output Materialization to TDengine (`docs/architecture/ADR-010-model-output-materialization.md`)
- **ADR-011:** Row Assembly and Epoch Idempotency (`docs/architecture/ADR-011-row-assembly-and-epoch-idempotency.md`)

---

## 4. Final Verdict

**VERDICT: SUPERSEDED (DO NOT USE)**  
This legacy acceptance claim has been superseded by `RELEASE_READINESS.md` based on active verification gates G0–G8 per `review.md`.
