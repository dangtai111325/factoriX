# Physical Object Operations

**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** 400dba192eb13be30806dbacb1568ffff23ae26b  
**Last updated:** 2026-11-12

---

## Overview

This document describes the lifecycle and operations for physical TDengine storage objects in FactoriX: **Database**, **Supertable (STable)**, and **Subtable**. All operations are managed through the Storage Management UI (`/historian/storage`) and backend APIs. No physical DDL is executed until a user explicitly publishes a validated operation plan.

## Object Hierarchy

```
TDengine Instance
└── Database (fx_t_<tenant>_<name>)
    └── Supertable (STable) — defines columns + tags template
        └── Subtable — USING STable TAGS(...) — holds time-series rows
```

## Operation States

All mutating operations follow this state machine:

```
DRAFT → VALIDATING → PLANNED → APPLYING → VERIFYING → APPLIED
                                        ↘ FAILED / OUT_OF_SYNC / NEEDS_RECONCILIATION
```

| State | Meaning |
|-------|---------|
| `DRAFT` | User is editing fields in wizard; no backend mutation |
| `VALIDATING` | Server-side schema/security/version validation |
| `PLANNED` | DDL plan generated and stored; no TDengine changes yet |
| `APPLYING` | DDL executing against TDengine |
| `VERIFYING` | Read-back from `INFORMATION_SCHEMA` / `SHOW` to confirm DDL succeeded |
| `APPLIED` | Registry updated; bindings activated; writer notified |
| `FAILED` | DDL rejected; operation journal has error details; retry safe |
| `OUT_OF_SYNC` | Physical state differs from desired; reconcile required |
| `NEEDS_RECONCILIATION` | Partial apply detected; manual or automatic reconcile needed |

**Rule:** `publish_state = APPLIED` is **never** set before TDengine read-back confirms the DDL outcome.

## Database Operations

### Create Database (Wizard A1–A3)

**A1 — Basics:** Name (ASCII, tenant-prefixed, unique), Description, Owner/Scope.  
**A2 — Storage Settings:** Precision (`ms`/`us`/`ns`), Retention (KEEP), VGroups (advanced), Cache/Buffer settings. Only values supported by pinned image `tdengine/tsdb:3.4.3.9`.  
**A3 — Review & Create:** Read-only DDL preview → `Create Database` → operation journal entry → TDengine execute → read-back verify → `APPLIED`.

**Idempotency:** Create uses an idempotency key; double-clicking results in one operation.

**API:** `POST /api/v1/storage/td/objects/drafts` → `POST .../publish`

### Edit Database

Only non-structural properties editable in-place (description, some retention values). Immutable properties (precision, name) require creating a new database with migration plan.

### Delete Database

Requires: all STables retired/purged, no active bindings, backup verified, typed confirmation, `PURGE_STORAGE` permission.  
DDL: `DROP DATABASE <name>` — only after approval and writer quiesce.

---

## Supertable Operations

### Create Supertable (Wizard B1–B6)

**B1:** Select existing Database, STable name, write semantics.  
**B2:** Column editor — `ts TIMESTAMP` pre-filled (immutable); add value columns with TDengine types.  
**B3:** Tag editor — static subtable identity fields; not per-sample values.  
**B4:** Source Mapping — three-perspective picker (Hierarchy / Collector / Models); bindings stored in `storage_bindings`.  
**B5:** Recording Policy — `ON_CHANGE`, `EVERY_ACQUISITION`, `INTERVAL`; row assembly for mixed-cadence sources.  
**B6:** Review & Publish — DDL preview, impact, quota, `Validate & Dry-run` → `Publish` → saga.

**DDL generated:** `CREATE STABLE <db>.<name> (ts TIMESTAMP, ...) TAGS (...)`

### Edit Supertable

Additive changes (new column/tag): draft diff → impact preview for all subtables → publish.  
Breaking changes (type change, column drop): blocked in-place; requires new STable version + migration plan.

### Delete Supertable

Blocked if any subtables exist. All subtables must be `RETIRED` or `PURGED` first. Impact manifest shows affected bindings, Historian views, and exports.

---

## Subtable Operations

### Create Subtable (Wizard C1–C5)

**C1:** Select Database + STable; name unique; optionally batch-create from hierarchy resources.  
**C2:** Set tag values (typed, static, from resource hierarchy or manual).  
**C3:** Bind source fields to inherited value columns via three-perspective picker.  
**C4:** Row assembly policy, recording mode, preview with real or labeled synthetic samples.  
**C5:** Review DDL (`CREATE TABLE ... USING ... TAGS(...)`), validate, create, optionally start recording.

### Edit Subtable

Tag values: `ALTER TABLE <name> SET TAG <tag>=<value>` — impact preview, audit.  
Bindings: revision update with `effective_at` / `valid_until`; old rows kept.  
Inherited columns: cannot be edited on subtable; requires STable edit.

### Pause / Resume Recording

`POST /api/v1/storage/td/objects/{id}/pause` — stops recording (status `PAUSED`); physical schema and existing data are kept.  
`POST /api/v1/storage/td/objects/{id}/resume` — starts / resumes recording (status `ACTIVE`).

### Archive / Retire

`POST /api/v1/storage/td/objects/{id}/retire` (status `RETIRED`) — stops recording; locks new writes; retains historical data and DDL under retention/legal-hold policy.

### Purge

`DELETE /api/v1/storage/td/objects/{id}?confirm_name=<exact object name>` — permanent DROP of a user-created object; without the exact typed name it answers 400 `CONFIRMATION_REQUIRED`; system objects are refused (403); a supertable that still has subtables not `PURGED`/`RETIRED` answers 409 `DEPENDENCY_EXISTS` unless `force=true`. There is no separate purge-preview endpoint (`apps/center/src/factorix/transport/http/routers/storage/td_objects.py`).  
DDL: `DROP TABLE <name>` — after all guards pass.

**Warning:** Purge of a Subtable with an active writer will quiesce the writer first. If the writer is restarted without the subtable, it will NOT auto-recreate the table.

---

## Security and Authorization

Every storage route requires a signed-in administrator session (`admin_dep`); there are no finer-grained storage permissions in the code.

All mutations: tenant check and audit actor/timestamp; metadata edits (`PATCH /api/v1/storage/td/objects/{id}`) take the revision in the `If-Match` header.

---

## Identifier Safety

- Database/STable/Subtable names validated against TDengine identifier rules (ASCII, length ≤ 64 chars)
- Server-side `quote_ident` after strict allowlist; no raw SQL interpolation from user input
- Reserved system prefixes (`_factorix_`, `information_schema`) rejected
- Cross-tenant resource references rejected at binding validation
