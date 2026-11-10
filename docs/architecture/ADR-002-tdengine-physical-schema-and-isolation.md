# ADR-002: TDengine 3.3.6.13 Data Plane, Per-Tenant DBs & Registry Ownership

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** High-compression TSDB storage replacing 24 GB PG `observations` bloat, strict multi-tenant isolation, safe `CLEAR_TELEMETRY_ONLY` resets, AGPL-3.0 compliance.

## Context

Storing all telemetry in monthly PostgreSQL `observations` partitions grew PostgreSQL to `24.13 GB` (`~32M` rows) in short order, slowing vacuuming, queries, and backups. Meanwhile, TDengine restricts `DELETE` queries to timestamp predicates (`ts <= ...`) on tables/subtables.

## Decision

1. **Physical Tenant Isolation:** Each FactoriX tenant owns an isolated TDengine database named deterministically `fx_t_<tenant_hex>` (Precision `'us'`, `CACHEMODEL 'last_row'`, `CACHESIZE 16`). Cross-tenant data NEVER shares a TDengine database or supertable.
2. **Typed Operational + User-Managed Supertables:**
   - System Operational History STables (`op_float64`, `op_int64`, `op_bool`, `op_string`, `op_json`) auto-populated for live sparklines and model lookbacks.
   - User-managed Storage Design STables/subtables compiled from `factorix.io/storage/v1` AST.
3. **PG `storage_physical_registry` Ownership:** Every TDengine database/STable/subtable created by FactoriX is registered in PostgreSQL (`tenant_id`, `design_version_id`, `dataset_id`, `signal_id`, `td_database`, `td_stable`, `td_subtable`, `status`). Telemetry resets enumerate exact registered subtables rather than wildcards.
4. **Network Service Boundary:** Interact exclusively via `taos-ws-py` WebSocket (`:6041`) to a standalone `tdengine:3.3.6.13` Community container.

## Consequences

- **Positive:** 100% deterministic tenant isolation; per-subtable `DELETE WHERE ts <= ...` or scoped epoch purge cannot leak across tenants; clean separation from PostgreSQL control plane.
- **Negative / Mitigation:** No native cross-store distributed SQL transactions between PG and TDengine. Solved via PostgreSQL `storage_operations` saga journal + immutable design versions + `active_epoch` fencing.
