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
- `apps/web/src/components/shell/Sidebar.tsx:71–79` has 3 navigation children instead of the required 2
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
- Migration from `storage_designs`/`storage_datasets` to `storage_object_specs` must be additive (no DROP of old tables until migration parity verified)

## Implementation Notes

- Backend: add `storage_objects.py`, `storage_topology.py`, `storage_revisions.py` modules; keep `storage_designs.py` as legacy adapter
- Frontend: new `StorageManagementPage.tsx` replaces overview; wizards as route-based steps
- TDengine metadata read from actual engine via `INFORMATION_SCHEMA`; never inferred client-side
- Physical topology API: `GET /api/v1/storage/td/topology` returns `actual_state`, `desired_state`, `drift_type`, `last_verified_at`
- Operation saga: `DRAFT → PLANNED → APPLYING → VERIFYING → APPLIED/FAILED/OUT_OF_SYNC`; `publish_state=APPLIED` only after DDL verification

## References

- plan.md §3, §4, §4A, §5, §7
- ADR-002: TDengine Physical Schema and Isolation
- ADR-005: Canonical Ordering and Idempotency
- Findings: FX-S01, FX-S02, FX-S03 (plan.md §1.2)
