# ADR-009: Physical-First TDengine UI

**Status:** Accepted  
**Date:** 2026-11-12  
**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** 400dba192eb13be30806dbacb1568ffff23ae26b

---

## Context

The existing Storage Designer (`StorageDesignerPage.tsx`, 2639 lines) exposes a Dataset abstraction that internally compiles to TDengine objects. Users working with an IIoT platform expect direct control over TDengine physical objects: Database → Supertable → Subtable. The Dataset UI creates a disconnect between what the engineer intends and what gets created.

Key findings from source review at SHA `400dba1`:
- `StorageDesignerPage.tsx:302` sets `step=2` by default, bypassing A1 basics
- `StorageCatalogDetailPage.tsx:383–445` builds a fallback `CompiledDatasetPlan` from client-side heuristics, inventing physical names and hash values
- `apps/web/src/components/shell/Sidebar.tsx:71–79` had 3 navigation children (Designer / Catalog / Historian).
  Note (2026-11-18 correction): plan.md §2 *requires* those 3 children; the earlier wording "instead of the
  required 2" misquoted the plan. The 2-child layout below is a deliberate deviation, see "Deviation from plan §2".
- Backend `storage_dsl.py` (1620 lines) uses `DatasetAst` which does not map 1:1 to physical TDengine objects

## Decision

Replace the Dataset-centric UX with a **Physical-First UI** where users directly design:
1. **TDengine Database** (3-step wizard A1–A3)
2. **Supertable** (6-step wizard B1–B6)
3. **Subtable** (5-step wizard C1–C5)

The sidebar will have exactly **two children** under `Historian & Storage`:
- `Storage Management` → `/historian/storage`
- `Historian` → `/historian/historian`

Legacy routes (`/historian/designer`, `/historian/catalog`) redirect with query preservation.

## Consequences

**Positive:**
- Engineers with TDengine background work with familiar concepts
- UI reflects actual physical state from `INFORMATION_SCHEMA` / `SHOW` queries
- No fabricated fallback topology—`OUT_OF_SYNC` shown when actual metadata unavailable
- Wizard per step enforces correct progression: schema before binding, binding before recording

**Negative / Mitigations:**
- Existing `StorageDesignerPage.tsx` and `StorageCatalogPage.tsx` must be replaced, not extended — mitigated by keeping legacy routes as redirects
- `storage_dsl.py` DatasetAst reader kept as compatibility layer; physical AST v2 added alongside
- Migration from `storage_designs`/`storage_datasets` to the physical object registry (implemented as `storage_objects`, `storage_object_drafts`, `storage_bindings` in migration `0009_storage_drafts_lifecycle`) must be additive (no DROP of old tables until migration parity verified)

## Implementation Notes

- Backend: add `storage_objects.py`, `storage_topology.py`, `storage_revisions.py` modules; keep `storage_designs.py` as legacy adapter
- Frontend: new `StorageManagementPage.tsx` replaces overview; wizards as route-based steps
- TDengine metadata read from actual engine via `INFORMATION_SCHEMA`; never inferred client-side
- Physical topology API: `GET /api/v1/storage/td/topology` returns `actual_state`, `desired_state`, `drift_type`, `last_verified_at`
- Operation saga: `DRAFT → PLANNED → APPLYING → VERIFYING → APPLIED/FAILED/OUT_OF_SYNC`; `publish_state=APPLIED` only after DDL verification

## Deviation from plan §2 (recorded 2026-11-18, v6 WS-H)

plan.md §2 specifies three children under *Historian & Storage*: `Designer`, `Catalog`, `Historian`.
This product keeps **two** children, by decision of this ADR:

| plan §2 child | Where it lives now |
|---|---|
| Designer (`/historian/designer`) | Storage Management → New ▸ Database / Supertable / Subtable wizards, and New ▸ *Subtables from Data Models* (bulk). Each wizard's Review step shows the DDL produced by the backend compiler (`POST /api/v1/storage/td/plan`). |
| Catalog (`/historian/catalog`) | Storage Management → Objects table / Topology, object detail page (`/historian/storage/object/:id`) with bindings, recording state and lifecycle (pause / resume / retire / delete). |
| Historian (`/historian/historian`) | unchanged. |

Why: the owner's target workflow (tdengine_guide.md: 1 DB, 7 supertables, 324 subtables bound to Data Model
fields) is a physical Database → Supertable → Subtable workflow; a separate logical Designer adds a second
vocabulary without adding capability. Nothing was removed: `/historian/designer`, `/historian/designer/:id`,
`/historian/catalog`, `/historian/catalog/:id`, `/historian/explorer`, `/historian/policies`,
`/historian/retention` redirect (query preserved) to the corresponding page, and the logical
`/api/v1/storage/designs/*` API remains available (it can be surfaced as a tab of Storage Management if the
owner wants the logical layer back). This is a contract deviation of plan §2, not a silent change.

## References

- plan.md §3, §4, §4A, §5, §7
- ADR-002: TDengine Physical Schema and Isolation
- ADR-005: Canonical Ordering and Idempotency
- Findings: FX-S01, FX-S02, FX-S03 (plan.md §1.2)
