# ADR-003: Recording Modes & Full-Fidelity Operational History Tier

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** Zero loss of 15-minute Signal sparklines and Data Model `value_at()`/`ts()` accuracy when user Storage Designs select `ON_CHANGE`.

## Context

In baseline production (`36` running Data Models, `408` `model_refs`, `336` active Signals), `6` models use `value_at(sigA, ts(sigB))` and the Signals screen renders 15-minute sparklines. If an unchanging analog or boolean signal were stored *only* via `ON_CHANGE` in a single table, a 15-minute unchanged signal would have zero intermediate points for exact `count/avg` or sparkline fidelity, and resetting/pausing a user Storage Design could break Data Collector diagnostics.

## Decision

Separate storage concerns into **two explicit tiers in TDengine**:
1. **Operational History Tier (Built-in, bounded retention e.g. 7–30 days configurable):** Automatically records acquired observations per bound signal at full configured acquisition fidelity (including quality transitions & activity evidence), powering:
   - Signal `15m` sparklines (`/api/v1/observations/history`)
   - Data Model `ts()`, `value_at()`, and `/api/v1/observations/aggregate` exact `count/avg/min/max`
   - Historian `Full-fidelity observations` mode when within operational retention
   Pausing or archiving a user Storage Design NEVER breaks Operational History.
2. **User-Managed Storage Datasets (Storage Designer -> Catalog -> Historian):** Follow explicit immutable published **Recording Policies**:
   - `ON_CHANGE` *(Default)*: records when typed value changes (exceeding optional numeric deadband), when quality changes, or when `maxCheckpointInterval` (heartbeat keepalive) elapses.
   - `EVERY_ACQUISITION`: records every valid acquisition cycle.
   - `INTERVAL`: fixed interval / window sampling with explicit downsampling labeling.

## Consequences

- **Positive:** Achieves dramatic long-term compression via `ON_CHANGE` in long-retention datasets while preserving 100% backward parity for `15m` sparklines, `count/avg`, and all `36` baseline Data Models.
- **Negative / Mitigation:** Both tiers are cleanly metered separately (`ops_writes` vs `managed_change_writes`) so operators are never misled by fake compression ratios, and both tiers live within per-tenant `fx_t_<hex>` TDengine DB so `CLEAR_TELEMETRY_ONLY` clears both cleanly.
