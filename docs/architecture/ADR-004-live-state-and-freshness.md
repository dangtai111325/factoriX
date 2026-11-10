# ADR-004: Truthful LiveStateProvider & Freshness Semantics

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** Eliminate stale/bad ghosting during `ON_CHANGE` recording, reconnects, and service restarts without false `GOOD` badges.

## Context

In distributed IIoT systems, storing only value changes creates a classic hazard: a sensor holding constant `25.0 °C` for 2 hours must still show `GOOD` if Acquisition polled it 1s ago, whereas a disconnected sensor holding cached `25.0 °C` must transition to `STALE` after `max(2 * interval_ms, 12000ms)` and automatically recover to `GOOD` upon the first fresh good acquisition — even if the numeric value is still `25.0`.

## Decision

1. **Dual Timestamps in `LiveStateProvider`:** Track `last_acquired_at` (latest authentic protocol read/keepalive timestamp) independently from `last_value_changed_at` and `last_good_at`.
2. **Backend-Derived `LiveStateProvider`:** Backed by bounded in-memory index + PG `latest_signal_state` snapshot / TDengine `LAST_ROW` hydration on cold start. Updates `last_acquired_at` on EVERY authentic active-epoch acquisition (including `ON_CHANGE` unchanged skips), so unchanged healthy sources NEVER fall `STALE`.
3. **Cold-Start / Broker-Only Guard:** Service boot or open RabbitMQ socket NEVER marks a signal `GOOD`; signals remain `UNKNOWN` / `NO_DATA` or re-evaluated from `last_acquired_at` against current UTC clock (`STALE` if older than threshold) until a fresh active-epoch acquisition arrives.
4. **Shared Freshness Rule:** Frontend `AppContext.tsx` evaluates client freshness strictly using the same server-synced rule (`receivedTime` == `last_acquired_at` in canonical latest payload) and clears cached `liveRef` immediately upon `telemetry_reset` WebSocket event.

## Consequences

- **Positive:** Fixes `STALE` false positives on steady sources AND eliminates ghost `GOOD` states after outages or resets.
