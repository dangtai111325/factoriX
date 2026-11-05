# FactoriX Review 4 — Baseline & Execution Manifest

## 1. Commit and Branch
- **Base Commit**: `748a3265a838fde59705fbf7d8f0ea5ab7fc0b00`
- **Execution Branch**: `fix/review4-release-blockers`
- **Specification**: `review4.md` (End-to-end execution)

## 2. Test Verification Summary
- **Python Unit & Safety Tests**:
  - `apps/center/tests/unit`: **85 passed**
  - `apps/edge/tests`: **17 passed**
  - `tests/safety`: **3 passed**
  - **Total**: **105 passed, 0 failed, 0 skipped**
- **Frontend Verification**:
  - `pnpm run check`: **0 TypeScript errors**
  - `pnpm run build`: **Vite production build succeeded** (`dist/` created in 32.7s)

## 3. Product Feature Deletions (R4-35, R4-36, R4-37)
- **Layout Designer**:
  - Deleted `apps/web/src/pages/03_FactoryLayout/` (5 files)
  - Removed `/api/v1/layouts*` routes from Center backend
  - Removed layout domain functions (`create_layout`, `patch_layout`, `get_layout`)
  - Redirected `/factory/layout` to `/factory/structure`
- **Edge Collectors Management UI**:
  - Deleted `apps/web/src/pages/16_Edges/EdgesPage.tsx`
  - Removed auto-creation of fake `ENROLLED/HEALTHY` edge nodes upon site creation
  - Preserved internal edge runtime, M2M sync (`/api/v1/edge-sync/*`), protocol drivers, SQLite outbox
  - Redirected `/collector/edges` to `/collector/connections`
- **Diagnostics Product Feature**:
  - Deleted `apps/web/src/pages/11_Diagnostics/DiagnosticsPage.tsx`
  - Replaced standalone diagnostics with inline Connection Health & Test and Signal Inspector
  - Redirected `/collector/diagnostics` to `/collector/connections`

## 4. Root-Cause Technical Fixes
- **R4-01 / R4-02 / R4-03 (Add Data Wizard & Commissioning)**:
  - Eliminated timer-based `setInterval` simulated capture in Wizard.
  - Connected `Capture sample` directly to `POST /api/v1/connections/{id}/capture` (202 Accepted) and polled `/api/v1/commissioning/{job_id}`.
  - Eliminated fake `setTimeout(1200)` and hardcoded stage durations in `handleRunTest`.
  - Added protocol-aware job creation: `SUBSCRIBE` for MQTT (preserving QoS 0), `POLL` for Modbus/OPC UA/HTTP; correct address kinds (`mqtt_jsonpath`, `modbus_register`, `opcua_node`, `http_jsonpath`).
- **R4-04 / R4-06 (Center Capture & Edge Execution)**:
  - Center capture refactored into asynchronous Edge command.
  - Edge reports terminal status `PASSED` so `finish_command` accepts it.
  - Implemented `browse_children` on `OpcUaConnector`.
  - Implemented `request_json` on `HttpPullConnector`.
- **R4-07 / R4-08 (Signal State & Freshness Engine & Transaction Boundary)**:
  - Created pure domain evaluation in `factorix.domain.signal_state.py`.
  - Removed client-side 5000ms clock-skew checks from `AppContext.tsx`.
  - Fixed after-commit transaction flush in `app.py::db_session`.
- **R4-10 (MQTT Delivery Policy)**:
  - Added support for `ALL_EVENTS` delivery policy (preserving every message in arrival order) alongside `LATEST_ONLY`.
- **R4-11 (Null Value Quality Coercion)**:
  - `_coerce(value=None)` returns `(None, "BAD", "NULL_VALUE")` instead of `GOOD`.
- **R4-12 (Edge Scheduler Cadence)**:
  - Per-job scheduling tracks monotonic deadlines independently per `job_id`, preventing short intervals (200ms) from forcing high polling rates on slow jobs (60s).
- **R4-18 / R4-19 (Factory Model Invariants)**:
  - Cross-site resource move with active bindings is strictly blocked with `409 CROSS_SITE_BINDINGS` before any DB relation updates.
  - Archive stores prior active & enabled bindings in `properties_json['_prior_archive_state']` so restore only enables previously enabled bindings.
