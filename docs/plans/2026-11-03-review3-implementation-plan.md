# FactoriX System Rebuild & Refinement Implementation Plan (review3.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and `writing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution proceeds in a strict verification loop: *Code fix -> Unit/Integration test -> Playwright/Browser inspection (`/browser`) -> Comparison against `review3.md` -> Pass 100% -> Advance*.

**Goal:** Transform the FactoriX IIoT Appliance codebase into an enterprise-grade industrial software platform adhering 100% to the specifications, test cases, and quality mandates of `review3.md`.
**Architecture:** Multi-tier edge-to-cloud industrial platform comprising a React 18 / Vite / Tailwind SPA (`apps/web`), FastAPI / SQLAlchemy / Alembic Center appliance (`apps/center`), and a high-performance Python Edge collector runtime (`apps/edge`) with PostgreSQL 17 for transactional & telemetry storage, communicating via MQTT 3.1.1/5.0, Modbus TCP, OPC UA, and HTTP.
**Tech Stack:** React 18, TypeScript, Tailwind CSS, `@xyflow/react`, `elkjs`, `react-zoom-pan-pinch`, Python 3.11+, FastAPI, SQLAlchemy 2.0, Alembic, Paho MQTT, AsyncUA, PyModbus, PostgreSQL 17, Docker, Playwright.
**Spec Document:** `C:\Users\Ave-T14-001\Downloads\review3.md` (Commit baseline `ed9a255` / `a9bedf1`).

---

## Global Constraints

1. **Strict Scope Discipline:** Focus exclusively on **Factory Model** (Hierarchy Structure, Layout Designer, Knowledge Graph) and **Data Collector** (Connections, Add Data Wizard, Signals, Edge Collectors, Diagnostics), plus shell, brand, overview, and navigation cleanup. DO NOT invent or expand auth, RBAC, multi-factor authentication, or mail verification beyond existing basic sessions.
2. **Coming Soon Modules:** Retain unimplemented modules (`/dashboards`, `/historian`, `/alarms`, `/analytics`, `/reports`, `/administration`) as polished product-grade **Coming soon** pages with concise value propositions, projected feature lists, and working "In the meantime" deep links. Eliminate all developer roadmap jargon ("Workstream", "development candidate", "IoTDB", "Keycloak").
3. **No Mock or Simulated Data in Production Screens:** Never hardcode random numbers, synthetic sparklines, dummy CPU metrics, or static lists (e.g. `18/20`, `LineA_PLC`, `Tank_03`, `Stamping Press`, `CPU: 32%`). If data has not arrived, display clean empty states or honest "No data" indicators.
4. **No Dead Controls or Unhandled Interactions:** Every button, tab, drawer, and menu item must perform its designated action or navigate to its corresponding functional page. No placeholder alert boxes or inert handlers.
5. **Honest Handshakes & Verification:** Connection tests, health checks, and commissioning runs must evaluate real physical network packets and responses. Never simulate success stages (`REACH`, `AUTH`, `SUBSCRIBE`, `SAMPLE`, `MAP`). Stage timeouts must trigger after 30 seconds via a background reaper.
6. **Consistent Industrial English & Avenue Brand Identity:** All user-facing copy, labels, tooltips, validation messages, and errors must be standard industrial English (ISA-95, ISA-101). No mixed Vietnamese or technical developer comments in the UI. Avenue primary Navy (`#0B2545`), secondary Blue (`#134074`), accent Cyan/Blue, and official Avenue icon (`favicon.ico`) must be used.
7. **In-App Revert To Zero Dialog:** Revert To Zero is preserved for appliance maintenance, but MUST be implemented as a custom in-app `ConfirmDialog` requiring the user to type the word `"REVERT"` to activate the destructive action. Native browser `window.confirm` dialogs are strictly prohibited.
8. **Iterative Verification Loop:** No module is declared complete until it achieves 100% pass on all applicable UI test cases (`TC-UI-*`) and backend test cases (`TC-BE-*`), verified via automated test runs and live Playwright browser inspection (`/browser`).

---

## Review Focus & Critical Input Classes

1. **MQTT Wildcard Routing & Partial Payload Handling:** Ingesting ~36 msg/s across 6 lines on `uns/TIPA/DongNai/Factory-1/ASSY/#` where different topics (`state`, `process`, `energy`, `condition`) arrive at different rates with disparate JSON structures. Fields mapped to non-matching topics must NOT report `BAD` quality when another topic arrives (`CR-Q01`, `P3.1`). Missing fields on matched topics follow explicit `missing: SKIP` (omit) or `missing: BAD` (`FIELD_MISSING`).
2. **Data Type Preservation & Whole-Float Integers:** Text fields containing numerical strings (e.g. employee IDs `"22023376"`, lot numbers, or error codes `"AS3"`) must remain strings, not coerced to numbers or marked `BAD` (`CR-Q02`, `P3.2`). Numeric fields receiving integer values as float with zero decimal (e.g. `105.0`) must be coerced cleanly to `int64`.
3. **Edge Ingestion Queue Bounding & Latency Drifts:** The edge collector `_inbox` must use `deque(maxlen=10000)` and drain completely on every cycle (`CR-Q03`, `P3.1`). Dropped counts and queue lengths must be reported in heartbeats. Latency (`received_time - source_time`) must remain steady under 2 seconds without accumulating drift (`TC-E2E-02`).
4. **Source Timestamp vs. Ingest Timestamp:** Observations must prioritize `source_timestamp` from the payload (ISO-8601 with Z or timezone offset). Center ingest must record `source_time` and set `event_time = source_time` when time skew <= 24 hours, tagging `UNCERTAIN` (`SOURCE_TIME_SKEW`) only on extreme clock drifts (`CR-Q04`, `P3.5`).
5. **Resource Hierarchy Code Scoping & Path Codes:** Resource `code` must be unique per direct parent (`(parent_id, code)` scoped uniqueness), allowing identical codes across different parents (e.g. machine `AA10-02` under different lines). `path_code` must be unique across the tenant and auto-update down the entire descendant subtree whenever an ancestor is renamed or moved (`P2.2`).

---

## Test Preconditions & Reference Fixtures

- **D0:** Pristine first-run appliance, no admin account initialized (`/register`).
- **D1:** Initial setup completed, admin authenticated, model empty.
- **D2:** D1 + Standard TIPA Hierarchy:
  `TIPA` (Enterprise) › `DongNai` (Site) › `Factory-1` (Area) › `ASSY` (Zone) › 6 Lines (`Assembly-AA10-01-A1` through `-06-A6`) › each Line containing 1 Machine (`AA10-01` through `AA10-06`). "Edge DongNai" is ENROLLED and ONLINE.
- **D3:** D2 + Active MQTT connection `mqtt-lab` (`192.168.2.108:18883`, 3.1.1, auth None). Machine `AA10-02` configured with 6 signals:
  `status` (Integer, `$.status`, topic `…/AA10-02/state`), `speed_1` (Number, `…/process`), `power` (Number, `…/energy`), `machine_temp_1` (Number, `…/condition`), `employee` (Text, `…/state`), `stop_error` (Text, `…/state`). Line `Assembly-AA10-02-AB` has 4 production signals (`order_qty`, `wo`, `item`, `cycle_time`) from `…/production/order`.
- **D4:** D3 + Parallel read-only subscriber (`paho` or `mosquitto_sub`) to verify observation parity within ±1 cycle.

---

## Phase P0: Preparation, Brand Identity & Shell Cleanup

### Task P0.1: Avenue Favicon & Document Title Integration
- **Files:**
  - Create: `apps/web/public/favicon.ico` (copied from `tests/artifacts/favicon-served.ico` or `apps/web/dist/avenue-net_icon.ico`)
  - Modify: `apps/web/index.html:5-10`
  - Modify: `apps/web/src/App.tsx`
  - Modify: `apps/web/src/store/AppContext.tsx`
- **Actions:**
  - [ ] Copy verified Avenue icon into `apps/web/public/favicon.ico`.
  - [ ] Update `apps/web/index.html` link tag to `<link rel="icon" type="image/x-icon" href="/favicon.ico" />`.
  - [ ] Implement a title sync utility hook `usePageTitle(title: string)` setting `document.title = `${title} · FactoriX``.
  - [ ] Mount page title handlers in every page component.
- **Verification:**
  - Run `curl -I http://127.0.0.1:8080/favicon.ico` -> verify HTTP 200 and image/x-icon.
  - Test case: `TC-UI-NAV-01`, `TC-UI-NAV-02`.

### Task P0.2: URL Route Normalization & Legacy Alias Redirection
- **Files:**
  - Modify: `apps/web/src/App.tsx:20-80`
  - Modify: `apps/web/src/components/shell/Sidebar.tsx`
- **Actions:**
  - [ ] Establish standard canonical paths:
    - `/overview`
    - `/factory/structure`, `/factory/layout`, `/factory/graph`
    - `/collector/connections`, `/collector/signals`, `/collector/edges`, `/collector/diagnostics`, `/collector/add-data`
    - `/models`
    - `/dashboards`, `/historian`, `/alarms`, `/analytics`, `/reports`, `/administration`
  - [ ] Configure `Navigate` components in React Router to permanently redirect all legacy paths while preserving query strings:
    - `/topology` -> `/factory/structure`
    - `/factory-layout` -> `/factory/layout`
    - `/knowledge-graph` -> `/factory/graph`
    - `/acquisition/connections` -> `/collector/connections`
    - `/acquisition/edges` -> `/collector/edges`
    - `/acquisition/add-data` -> `/collector/add-data`
    - `/signals` -> `/collector/signals`
    - `/live/monitor` -> `/collector/signals?view=live`
    - `/live/diagnostics` -> `/collector/diagnostics?tab=health`
    - `/live/activity` -> `/collector/diagnostics?tab=activity`
    - `/signals/output-groups` -> `/models`
    - `/signals/calculated` -> `/models?tab=calculations`
    - `/storage` -> `/historian`
    - `/acquisition/studio/mqtt` -> `/collector/connections`
    - `/acquisition/studio/opc` -> `/collector/connections`
    - `/acquisition/studio/http` -> `/collector/connections`
- **Verification:**
  - Test case: `TC-UI-NAV-06`. Open `/acquisition/add-data?resourceId=X` -> redirected to `/collector/add-data?resourceId=X`.

### Task P0.3: Avenue Brand Theme, Color System & Typography
- **Files:**
  - Modify: `apps/web/src/index.css`
  - Modify: `apps/web/tailwind.config.js`
- **Actions:**
  - [ ] Configure Tailwind palette with Avenue Industrial Design tokens:
    - Primary Navy: `#0B2545` (`avenue-navy-900`)
    - Slate Blue: `#134074` (`avenue-blue-800`)
    - Surface Card: `#FFFFFF` (light), `#1E293B` (dark)
    - Borders: `#E2E8F0` (light), `#334155` (dark)
    - Status Badges: Good `#10B981`, Uncertain `#F59E0B`, Bad `#EF4444`, Stale `#6B7280`.
  - [ ] Enforce clean system typography font stack with tabular figures (`tabular-nums`) for all industrial metrics, timestamps, and measurements.
- **Verification:**
  - Playwright visual check on Topbar, Sidebar, and Cards.

### Task P0.4: In-App Revert To Zero Dialog
- **Files:**
  - Create: `apps/web/src/components/modals/RevertToZeroModal.tsx`
  - Modify: `apps/web/src/components/shell/Sidebar.tsx`
  - Modify: `apps/web/src/store/AppContext.tsx`
- **Actions:**
  - [ ] Replace any native `window.confirm` / `alert` calls with custom in-app `ConfirmDialog`.
  - [ ] Add explicit warning copy: *"This action resets all resources, connections, signals, and observations to clean state. This cannot be undone."*.
  - [ ] Include verification text input: button `Revert to zero` remains disabled until user types exact string `"REVERT"`.
  - [ ] Cancel button closes dialog without invoking backend reset.
- **Verification:**
  - Test case: `TC-UI-NAV-11`. Attempt typing lowercase `revert` -> button remains disabled. Type `REVERT` -> button enables.

### Task P0.5: Mock Data & Technical Commentary Purge
- **Files:**
  - Modify: `apps/web/src/pages/` (all pages)
  - Modify: `apps/web/src/components/`
- **Actions:**
  - [ ] Search and purge all fake strings: `18/20`, `CPU: 32%`, `Reactor 1`, `LineA_PLC`, `Tank_03`, `CNC Milling Unit`, `Stamping Press`, `ZONE A - MACHINING`, `DEMO`, `node-center`.
  - [ ] Eliminate synthetic sparkline generators that fabricate wavy lines when telemetry history is empty.
  - [ ] Delete internal developer comments and Vietnamese text fragments from UI components.
- **Verification:**
  - Run text scan across `apps/web/src`: `grep -rnE "(LineA_PLC|Tank_03|Reactor 1|Stamping Press|18/20)" apps/web/src` -> 0 occurrences.
  - Test case: `TC-UI-NAV-12`.

---

## Phase P1: Navigation, Breadcrumb & Coming Soon Modules

### Task P1.1: Sidebar Navigation Overhaul
- **Files:**
  - Modify: `apps/web/src/components/shell/Sidebar.tsx`
- **Actions:**
  - [ ] Reorganize navigation tree:
    - Overview (`/overview`)
    - Factory Model (collapsible group):
      - Hierarchy Structure (`/factory/structure`)
      - Layout Designer (`/factory/layout`)
      - Knowledge Graph (`/factory/graph`)
    - Data Collector (collapsible group):
      - Connections (`/collector/connections`)
      - Signals (`/collector/signals`)
      - Edge Collectors (`/collector/edges`)
      - Diagnostics (`/collector/diagnostics`)
    - Data Models (`/models`)
    - Coming soon (collapsible group, default closed):
      - Dashboards (`/dashboards`)
      - Historian & Storage (`/historian`)
      - Alarms & Events (`/alarms`)
      - Analytics (`/analytics`)
      - Reports (`/reports`)
      - Administration (`/administration`)
    - Footer: Revert To Zero, Sign out, version tag matching `apps/web/package.json`.
  - [ ] Add "Soon" badge pill beside each coming soon item.
  - [ ] Persist open/closed states in `localStorage['fx.sidebar.groups']`.
- **Verification:**
  - Test cases: `TC-UI-NAV-03`, `TC-UI-NAV-04`, `TC-UI-AUTH-09`, `TC-UI-AUTH-10`.

### Task P1.2: Topbar Cleanup & Status Indicators
- **Files:**
  - Modify: `apps/web/src/components/shell/Topbar.tsx`
- **Actions:**
  - [ ] Remove legacy "LIVE REFRESH" toggle, mock Pause button, and raw "Collector: ..." developer status strings.
  - [ ] Implement hierarchical breadcrumb reflecting current domain path (e.g., `Factory Model › Hierarchy Structure`).
  - [ ] Integrate Data Collection status chip: "X/Y edges online" with green/red dot. Clicking routes to `/collector/edges`. If an edge is offline > 30s, display banner: *"Data collection for [Site] is offline since HH:MM"*.
  - [ ] User menu dropdown: User avatar, Username, "Change password", "About FactoriX", "Sign out".
- **Verification:**
  - Test cases: `TC-UI-NAV-07`, `TC-UI-NAV-08`, `TC-UI-AUTH-12`.

### Task P1.3: Plant Scope Selector & localStorage Persistence
- **Files:**
  - Modify: `apps/web/src/components/shell/Topbar.tsx`
  - Modify: `apps/web/src/store/AppContext.tsx`
- **Actions:**
  - [ ] Implement Plant Selector dropdown showing current site, total resources, and "All sites" option.
  - [ ] Label formatting: *"Plant"* label, *"X sites · Y resources"* using proper English pluralization.
  - [ ] Persist selection in `localStorage['fx.scope']`.
  - [ ] Synchronize scope filter with Overview KPI metrics and page filters.
- **Verification:**
  - Test cases: `TC-UI-NAV-09`, `TC-UI-OV-08`.

### Task P1.4: Global Command Palette / Search (Ctrl+K)
- **Files:**
  - Create: `apps/web/src/components/shell/CommandPaletteModal.tsx`
  - Modify: `apps/web/src/components/shell/Topbar.tsx`
  - Modify: `apps/web/src/App.tsx`
- **Actions:**
  - [ ] Bind global keydown listener for `Ctrl+K` / `Cmd+K`.
  - [ ] Implement categorized search results: Resources, Signals, Connections.
  - [ ] Arrow key navigation (Up/Down) with highlighting; Enter key executes navigation to target entity.
  - [ ] Empty state: *"No results for "<query>""*.
- **Verification:**
  - Test case: `TC-UI-NAV-10`. Press `Ctrl+K` -> search "AA10-02" -> Arrow Down -> Enter -> navigates to `/factory/structure?resourceId=<AA10-02>`.

### Task P1.5: Coming Soon Module Polish
- **Files:**
  - Create: `apps/web/src/pages/coming-soon/ComingSoonPage.tsx`
- **Actions:**
  - [ ] Build a reusable template for Coming Soon modules.
  - [ ] Header badge: "Coming soon".
  - [ ] Single concise value sentence explaining the business capability.
  - [ ] Projected feature bullet points.
  - [ ] "In the meantime" section with actionable deep links (e.g. for Dashboards: *"In the meantime, view real-time values in Signals Live Monitor"* -> link to `/collector/signals?view=live`).
  - [ ] Strip all dev jargon ("Workstream", "development candidate", "IoTDB", "Keycloak").
- **Verification:**
  - Test case: `TC-UI-NAV-05`. Click every coming soon item and verify text, links, and layout.

### Task P1.6: User Profile & Password Change Dialog
- **Files:**
  - Create: `apps/web/src/components/modals/ChangePasswordModal.tsx`
  - Modify: `apps/web/src/components/shell/Topbar.tsx`
  - Modify: `apps/center/src/factorix/platform/security.py`
  - Modify: `apps/center/src/factorix/modules/identity.py`
- **Actions:**
  - [ ] Modal fields: Current password, New password (12-128 chars), Confirm new password.
  - [ ] Client validation with immediate inline errors.
  - [ ] Backend route `POST /api/v1/auth/password`: verifies current password, hashes new password with Argon2id, revokes all other active sessions while retaining current session.
  - [ ] Success toast: *"Password changed"*.
- **Verification:**
  - Test cases: `TC-UI-AUTH-12`, `TC-BE-AUTH-03`, `TC-BE-AUTH-04`.

---

## Phase P2: Factory Model Implementation

### Task P2.1: Database Schema & Migration `0005_flexible_hierarchy_area.py`
- **Files:**
  - Create: `apps/center/migrations/versions/0005_flexible_hierarchy_area.py`
  - Modify: `apps/center/src/factorix/domain/resources.py`
  - Modify: `apps/center/src/factorix/modules/resources.py`
- **Actions:**
  - [ ] Add `area` to valid resource type enum/domain values.
  - [ ] Update adjacency rules:
    - Recommended parent for `area`: `site`.
    - Recommended children for `area`: `zone`, `line`, `cell`.
    - `site` recommended children include `plant`, `area`.
  - [ ] Add `hierarchy_mode` column (`VARCHAR(20) DEFAULT 'guided'`) to `tenants` table.
  - [ ] In `guided` mode: allow non-standard parent-child placements with soft warning `placement: "non_standard"`. In `strict` mode: reject invalid placements with `422 ADJACENCY`.
  - [ ] Ensure migration is fully idempotent.
- **Verification:**
  - Run `alembic upgrade head`.
  - Test cases: `TC-BE-RES-01`, `TC-BE-RES-03`, `TC-BE-RES-04`, `TC-BE-RES-05`, `TC-BE-RES-08`.

### Task P2.2: Scoped Resource Codes & Path Code Maintenance
- **Files:**
  - Create: `apps/center/migrations/versions/0006_scoped_resource_codes.py`
  - Modify: `apps/center/src/factorix/domain/resources.py`
  - Modify: `apps/center/src/factorix/modules/resources.py`
  - Create: `apps/web/src/utils/slugify.ts`
- **Actions:**
  - [ ] Update unique constraints:
    - Change global `(tenant_id, code)` to scoped `(tenant_id, parent_id, code)` where `status = 'ACTIVE'`.
    - For root resources (`parent_id IS NULL`), unique `(tenant_id, code)`.
    - Maintain `path_code` unique across `(tenant_id, path_code)`.
  - [ ] Server-side validation:
    - Resource name: 1-200 chars, reject `/ # + $` or control characters (`422 NAME_CHARS`).
    - Resource code: 1-64 chars, regex `^[A-Za-z0-9][A-Za-z0-9_.-]*$` (`422 INVALID_CODE`).
  - [ ] Subtree `path_code` propagation: when a resource is renamed or moved, update `path_code` for the resource and recursively for all descendants.
  - [ ] Implement Vietnamese diacritics stripping and slugification in frontend (`Máy ép số 1` -> `May-ep-so-1`, `Xưởng Đúc` -> `Xuong-Duc`).
- **Verification:**
  - Test cases: `TC-BE-RES-09`, `TC-BE-RES-10`, `TC-BE-RES-11`, `TC-BE-RES-12`, `TC-BE-RES-13`, `TC-BE-RES-14`, `TC-BE-RES-15`, `TC-BE-RES-16`, `TC-BE-RES-17`, `TC-UI-HS-10`, `TC-UI-HS-11`, `TC-UI-HS-15`, `TC-UI-HS-16`.

### Task P2.3: Hierarchy Structure WAI-ARIA Treeview & Keyboard Navigation
- **Files:**
  - Create: `apps/web/src/pages/factory/structure/ResourceTree.tsx`
  - Create: `apps/web/src/pages/factory/structure/TypeChip.tsx`
  - Modify: `apps/web/src/pages/02_FactoryStructure/FactoryStructurePage.tsx` -> move to `apps/web/src/pages/factory/structure/FactoryStructurePage.tsx`
- **Actions:**
  - [ ] Implement WAI-ARIA Treeview pattern (`role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-selected`).
  - [ ] Keyboard navigation support:
    - Down / Up Arrow: move focus to next / previous visible node.
    - Right Arrow: expand closed node; if open, move focus to first child.
    - Left Arrow: collapse open node; if closed, move focus to parent.
    - Home / End: navigate to first / last visible node.
    - Type-ahead: pressing letters jumps focus to matching node label.
  - [ ] Render `TypeChip` badge (ENT, SITE, AREA, ZONE, LINE, MACH) in neutral slate palette.
  - [ ] Display live signal counter and health status indicator on leaves (e.g. green dot + "6" on `AA10-02`).
  - [ ] Make tree pane horizontally resizable with drag handle (persisted in `localStorage['fx.tree.width']`).
- **Verification:**
  - Test cases: `TC-UI-HS-28`, `TC-UI-HS-29`, `TC-UI-HS-30`, `TC-UI-HS-31`, `TC-UI-HS-32`, `TC-UI-HS-34`, `TC-UI-HS-35`.

### Task P2.4: Resource CRUD: Inspector, Edit, Move & Archive with Undo
- **Files:**
  - Create: `apps/web/src/pages/factory/structure/ResourceInspector.tsx`
  - Create: `apps/web/src/pages/factory/structure/ResourceEditModal.tsx`
  - Create: `apps/web/src/pages/factory/structure/ResourceMoveModal.tsx`
  - Create: `apps/web/src/pages/factory/structure/ResourceArchiveModal.tsx`
  - Modify: `apps/center/src/factorix/modules/resources.py`
- **Actions:**
  - [ ] Resource Inspector tabs: Overview, Signals, History (audit log filtered to `entity_id`).
  - [ ] Edit Resource: name, display name, code, description; optimistic lock check (`version`).
  - [ ] Move Resource: destination picker excluding self and current descendants (cycle prevention, `422 CYCLE`). Updates `parent_id`, `path_code`, and `resource_relations`.
  - [ ] Archive Resource:
    - Prevent archive if active children exist (`409 HAS_CHILDREN`).
    - If resource has active signals, disable signal bindings, trigger Edge config release, and log audit event.
    - Display 10-second toast with "Undo" action to restore.
    - Support "Show archived" toggle with "Restore" button.
- **Verification:**
  - Test cases: `TC-BE-RES-18`, `TC-BE-RES-19`, `TC-BE-RES-20`, `TC-BE-RES-21`, `TC-BE-RES-22`, `TC-BE-RES-23`, `TC-BE-RES-24`, `TC-BE-RES-25`, `TC-UI-HS-21`, `TC-UI-HS-22`, `TC-UI-HS-24`, `TC-UI-HS-25`, `TC-UI-HS-26`, `TC-UI-HS-36`, `TC-UI-HS-37`, `TC-UI-HS-38`, `TC-UI-HS-39`.

### Task P2.5: "Import from MQTT topics" Wizard
- **Files:**
  - Create: `apps/web/src/pages/factory/structure/ImportFromTopicsModal.tsx`
  - Modify: `apps/center/src/factorix/modules/resources.py`
  - Modify: `apps/center/src/factorix/domain/uns.py`
- **Actions:**
  - [ ] Multi-step import modal: Topic Input (paste raw topics), Level Mapping (map level 1..N to types or Ignore), Hierarchy Preview, Confirmation.
  - [ ] Default mapping for TIPA format (`uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-xx/AA10-xx/...`):
    - Level 1: `uns` -> Ignore
    - Level 2: `TIPA` -> Enterprise
    - Level 3: `DongNai` -> Site
    - Level 4: `Factory-1` -> Area
    - Level 5: `ASSY` -> Zone
    - Level 6: `Assembly-...` -> Line
    - Level 7: `AA10-...` -> Machine
    - Level 8: suffix (`state`, `process`, `order`, etc.) -> Ignore
  - [ ] Backend route `POST /api/v1/resources/import/from-topics` supporting `dry_run: true/false`.
  - [ ] Preview correctly shows 16 resources created from 36 TIPA topics; subsequent import runs are idempotent (`0 new · 16 already exist`).
- **Verification:**
  - Test cases: `TC-UI-HS-40`, `TC-UI-HS-41`, `TC-UI-HS-42`, `TC-BE-RES-26`, `TC-BE-RES-27`.

### Task P2.6: Layout Designer - Level-Based Nested Card Layout
- **Files:**
  - Create: `apps/web/src/pages/factory/layout/LayoutDesignerPage.tsx`
  - Create: `apps/web/src/pages/factory/layout/AutoGrid.ts`
  - Create: `apps/web/src/pages/factory/layout/ResourceCard.tsx`
  - Create: `apps/web/src/pages/factory/layout/LayoutInspector.tsx`
  - Modify: `apps/center/src/factorix/modules/resources.py` (layout draft endpoint)
- **Actions:**
  - [ ] Hierarchical card navigation: Breadcrumb navigation at top (`All › TIPA › DongNai › Factory-1 › ASSY`). Clicking a card drills down into its children; Backspace or breadcrumb click navigates up.
  - [ ] Auto-grid calculation:
    - 1 child: 1x1 full container
    - 2 children: 1x2 grid
    - 3 children: 1x3 grid
    - 6 children (e.g. ASSY): 3x2 grid matching 16:9 container aspect ratio with 12px gutters
    - 12 children: 4x3 grid
  - [ ] Live data representation on cards: leaf cards display up to 3 live values with unit, quality badge, and relative update time; container cards display roll-up statistics (e.g. "1 machine · 1 good").
  - [ ] Edit Layout Mode:
    - Toggle button "Edit layout".
    - Resizable and draggable cards with drag handles.
    - Relative coordinate system `(x, y, w, h)` bounded between `0.0` and `1.0`.
    - Unplaced items tray ("Not placed yet").
    - "Reset to auto layout" button restores calculated auto-grid.
    - Debounced saving: at most 1 PATCH request per 800ms with optimistic concurrency (`version`).
  - [ ] Canvas zoom & pan: integrate `react-zoom-pan-pinch` (25% to 400%, Space + drag to pan, "Fit" button).
- **Verification:**
  - Test cases: `TC-UI-LD-01` through `TC-UI-LD-25`, `TC-BE-LAY-01` through `TC-BE-LAY-08`.

### Task P2.7: Knowledge Graph (`@xyflow/react` + `elkjs`)
- **Files:**
  - Create: `apps/web/src/pages/factory/graph/KnowledgeGraphPage.tsx`
  - Create: `apps/web/src/pages/factory/graph/graphLayout.ts`
  - Create: `apps/web/src/pages/factory/graph/CustomNodes.tsx`
  - Create: `apps/web/src/pages/factory/graph/CustomEdges.tsx`
  - Modify: `apps/center/src/factorix/modules/resources.py` (neighbors endpoint)
- **Actions:**
  - [ ] Backend route `GET /api/v1/resources/neighbors`:
    - Parameters: `resource_id`, `depth` (1..3), `relation_types`, `include_data` (boolean).
    - Returns real graph topology:
      - `CONTAINS` edges (Parent resource -> Child resource)
      - `HAS_SIGNAL` edges (Machine -> Signal)
      - `COLLECTED_VIA` edges (Signal -> Connection)
      - `RUNS_ON` edges (Connection -> Edge node)
    - Hard limit of 200 nodes (`truncated: true`).
  - [ ] Layout engine: use `elkjs` layered left-to-right (`elk.direction: RIGHT`, hierarchy-aware spacing, no edge-node collisions).
  - [ ] Interactive UI controls: Depth selector (1, 2, 3), Relation type filter checkboxes, "Center on..." search selector, Minimap, Zoom to fit, and "Export PNG" button.
  - [ ] Details panel: clicking any node displays clean metadata, real-time value/status, and connection attributes without technical IDs.
- **Verification:**
  - Test cases: `TC-UI-KG-01` through `TC-UI-KG-15`, `TC-BE-GR-01` through `TC-BE-GR-08`.

---

## Phase P3: Edge Collector & Data Pipeline Core Fixes

### Task P3.1: Edge MQTT Ingestion Queue Drain & Topic Routing (CR-Q01, CR-Q03)
- **Files:**
  - Modify: `apps/edge/src/factorix_edge/connectors/mqtt.py`
  - Modify: `apps/edge/src/factorix_edge/runtime.py:302-328, 487-502`
- **Actions:**
  - [ ] In `MqttConnector`:
    - Replace unbounded queue with `_inbox: deque[tuple[str, dict]] = deque(maxlen=10000)`.
    - Maintain `dropped` counter for dropped packets.
    - In `on_message`, store `(message.topic, payload)` tuple.
    - Implement `drain(timeout_s: float = 0.5) -> list[tuple[str, dict]]` returning **all** queued messages up to queue exhaustion.
    - Support MQTT QoS 0, 1, 2 subscriptions.
    - Pass through `client_id`, `keepalive`, `clean_session`, `tls`, `ca_pem`, `tls_insecure`, and protocol version (`MQTTv311` / `MQTTv5`).
  - [ ] In `_read_mqtt`:
    - For each configured field, extract its specific target topic (`address_json.topic`, fallback to `config.topics[0]`).
    - Filter messages using `paho.mqtt.client.topic_matches_sub(field_topic, msg_topic)`.
    - Pick the **most recent** matching message in the cycle.
    - If no message matches the field topic during the cycle -> **do not emit an observation** (prevents spurious BAD quality).
    - If a matching message is found but the field JSONPath is missing: check `address_json.missing`. If `"SKIP"` (default), omit observation. If `"BAD"`, emit `BAD` with `reason="FIELD_MISSING"`.
  - [ ] Report queue length and `dropped` count in heartbeat (`queues: {<connection_id>: {"pending": n, "dropped": m}}`).
- **Verification:**
  - Edge unit tests: `test_mqtt_routing.py`.
  - Test cases: `TC-BE-RT-01` through `TC-BE-RT-08`, `TC-E2E-02`.

### Task P3.2: Type Coercion & Validation (CR-Q02)
- **Files:**
  - Modify: `apps/web/src/store/AppContext.tsx:678-690`
  - Modify: `apps/edge/src/factorix_edge/runtime.py:505-522`
  - Modify: `apps/center/src/factorix/modules/collect.py:337-340`
- **Actions:**
  - [ ] Replace ad-hoc type conversions in Web with canonical `TYPE_MAP`:
    - Text -> `string`
    - Integer -> `int64`
    - Number -> `float64`
    - Boolean -> `bool`
  - [ ] In Edge `_coerce`:
    - For `string`: preserve string values, including numerical strings (e.g. `"22023376"`, `"AS3"`).
    - For `int64`: accept whole floats with zero fractional part (`105.0` -> `105`); reject floats with fractional parts (`105.5` -> `BAD`, `reason="TYPE_MISMATCH"`).
    - For `bool`: accept `0` / `1` when native source is coil.
    - For `null` payloads: emit value `null` with quality `GOOD` (valid source null) or `NO_DATA`.
  - [ ] In Center `bulk_signals`: validate compatibility, return `422 TYPE` if `data_type='string'` is paired with numeric Modbus register types without string decoding.
- **Verification:**
  - Test cases: `TC-BE-RT-09`, `TC-BE-RT-10`, `TC-BE-RT-11`, `TC-BE-SIG-04`, `TC-BE-SIG-05`, `TC-BE-SIG-06`.

### Task P3.3: Sample Capture API & Edge Task (CR-Q05)
- **Files:**
  - Create: `apps/center/src/factorix/modules/commissioning.py` (or add to `collect.py`)
  - Modify: `apps/edge/src/factorix_edge/runtime.py`
- **Actions:**
  - [ ] Center endpoint: `POST /api/v1/connections/{id}/capture`
    - Body: `{ "topic_filter": "...", "seconds": 10, "max_messages": 200 }` (for MQTT), `{ "path": "...", "method": "GET" }` (HTTP), `{ "browse_node": "i=85" }` (OPC UA).
    - Generates command `CAPTURE`, returns `{ "job_id": "..." }`.
  - [ ] Center query: `GET /api/v1/commissioning/{job_id}` returns `samples: [{ "topic": "...", "payload": {...}, "received_at": "..." }]` and `browse: [...]`.
  - [ ] Edge collector handling:
    - MQTT: subscribes to `topic_filter` for `seconds` duration, captures up to `max_messages`, retaining latest message per topic.
    - HTTP: performs single test pull.
    - OPC UA: browses 1 level of child nodes for `browse_node`.
    - Safety guard: truncate payloads exceeding 64 KB and flag `truncated: true`.
    - Sample capture MUST NOT write observations to telemetry tables.
- **Verification:**
  - Test cases: `TC-BE-COM-05`, `TC-BE-COM-06`, `TC-BE-COM-07`, `TC-BE-COM-08`.

### Task P3.4: Honest Commissioning Handshakes & Timeout Reaper (CR-Q06)
- **Files:**
  - Modify: `apps/edge/src/factorix_edge/runtime.py:368-476`
  - Modify: `apps/center/src/factorix/transport/app.py:508-522`
  - Modify: `apps/web/src/store/AppContext.tsx:606-675`
- **Actions:**
  - [ ] Edge `_commission`:
    - Standard stage nomenclature across all protocols: `REACH`, `AUTH`, `SUBSCRIBE` (or `READ`), `SAMPLE`, `MAP`.
    - Stages pass ONLY upon physical proof: MQTT receives >= 1 matching message; Modbus reads first register; OPC UA reads target node; HTTP receives 2xx JSON response.
    - `MAP` stage executes JSONPath / decode on captured sample, returning `samples: { field_key: value | null, error? }`.
    - Support two operational modes: `CONNECTIVITY` (REACH + AUTH) for test connection button; `FULL` (all stages) for wizard review.
  - [ ] Center app:
    - Remove artificial aliases (`transport/read_sample/decode_quality`).
    - Implement commissioning reaper: any job stuck in `PENDING` or `RUNNING` for > 30 seconds is marked `FAILED` with `error_code="TIMEOUT"` and diagnostic *"The edge did not answer within 30 seconds."*.
  - [ ] Frontend:
    - Commissioning polling max 35 seconds.
    - Mark passed only when status is `COMPLETED` and all stages are `PASSED` or `NOT_APPLICABLE`.
- **Verification:**
  - Test cases: `TC-BE-COM-01`, `TC-BE-COM-02`, `TC-BE-COM-03`, `TC-BE-COM-04`, `TC-BE-COM-09`, `TC-BE-COM-10`, `TC-BE-COM-11`, `TC-BE-COM-12`, `TC-UI-AD-30` through `TC-UI-AD-36`.

### Task P3.5: Source Timestamp Extraction (CR-Q04)
- **Files:**
  - Modify: `apps/center/src/factorix/domain/observation.py`
  - Modify: `apps/center/src/factorix/modules/telemetry.py`
  - Modify: `apps/edge/src/factorix_edge/runtime.py`
- **Actions:**
  - [ ] Extend field decode schema: `decode_json.timestamp_path` (default `$.source_timestamp` if detected).
  - [ ] Edge collector: extract timestamp from matching message, parse ISO-8601 (handling UTC `Z` and timezone offsets), transmit `source_time`. If parse fails, set `source_time=null` and record `reason="SOURCE_TIME_INVALID"`.
  - [ ] Center telemetry ingestion:
    - Set `event_time = source_time` when present and `|source_time - received_time| <= 24 hours`.
    - If clock skew exceeds 24 hours, set `event_time = received_time`, mark quality `UNCERTAIN` and `reason="SOURCE_TIME_SKEW"`.
- **Verification:**
  - Test cases: `TC-BE-ING-03`, `TC-BE-ING-04`, `TC-BE-ING-05`.

### Task P3.6: Protocol Configuration & Parameter Completion
- **Files:**
  - Modify: `apps/center/src/factorix/modules/protocols.py`
  - Modify: `apps/web/src/store/AppContext.tsx:535-569`
  - Modify: `apps/edge/src/factorix_edge/runtime.py:321`
- **Actions:**
  - [ ] Center `protocols.py`:
    - `MqttConfig`: add `keepalive: int = Field(60, ge=5, le=3600)`, `clean_session: bool = True`, `tls_verify: bool = True`, `ca_secret_ref: str | None = None`. Map protocol version `"5.0"` -> `"5"`.
    - MQTT topic validator: `+` must take full level; `#` must be terminal level; no leading `/`; no empty levels.
    - `HttpConfig`: add `method: Literal["GET", "POST"] = "GET"`, `headers: dict[str, str] = {}`, `body: str | None = None`. DO NOT pop `method` in `accept_connection`.
    - `ModbusConfig`: add `word_order` default.
    - Translate all validation errors to standard industrial English.
  - [ ] Web forms:
    - OPC UA: real `security_mode`, `security_policy`, credentials.
    - MQTT: real `username`, `secret_input`, `client_id` (format `factorix-${siteCode}-${4chars}`), `keepalive`, `clean_session`, `tls`, `qos`.
    - HTTP: `method`, `path`, `headers`, `auth`.
  - [ ] Edge: apply `client_id`, `keepalive`, TLS verification, Modbus register area, word order, byte order, scale, and offset.
- **Verification:**
  - Test cases: `TC-BE-CON-01` through `TC-BE-CON-14`, `TC-BE-RT-12` through `TC-BE-RT-15`.

### Task P3.7: Edge & Connection Health Background Loop (CR-E02, CR-C03, RG-03)
- **Files:**
  - Modify: `apps/center/src/factorix/transport/app.py` (FastAPI lifespan)
  - Modify: `apps/center/src/factorix/modules/collect.py`
  - Modify: `apps/web/src/store/AppContext.tsx`
- **Actions:**
  - [ ] Center lifespan background task executing every 10 seconds:
    1. Mark enrolled edge nodes `OFFLINE` if `last_heartbeat < now() - 30s`; emit audit event `EDGE_OFFLINE` with severity `WARN`.
    2. Mark active connections `DEGRADED` with `last_error='No data received for 30 s'` if no `GOOD` observation has been recorded in `max(3 * interval, 30s)`.
    3. Run commissioning timeout reaper (Task P3.4).
  - [ ] Standardize edge node health API responses:
    - Map `ACTIVE`, `HEALTHY`, `CONFIG_VALIDATED` -> `ONLINE`.
    - Retain `DEGRADED`, `OFFLINE`. Un-enrolled nodes return `NOT_ENROLLED`. Provide `health_raw` for diagnostics.
  - [ ] Extend `list_connections` response: include `config_json` (secrets masked), `last_success_at`, `signal_count`, `messages_per_min` (calculated from last 60 seconds of observations), and lifecycle `status`.
  - [ ] Web cleanup: remove `collectorLabel` and arbitrary string-includes checks.
- **Verification:**
  - Test cases: `TC-BE-EDGE-05` through `TC-BE-EDGE-10`, `TC-UI-ED-03` through `TC-UI-ED-05`.

### Task P3.8: Bulk Signals Site Validation & JSONPath Verification (CR-Q09)
- **Files:**
  - Modify: `apps/center/src/factorix/modules/collect.py:384-395`
- **Actions:**
  - [ ] In `bulk_signals`: verify that target resource and connection belong to the same site (`connection.site_id == resource.site_id`). Reject mismatches with `422 SITE_MISMATCH` *"This connection belongs to another site."*.
  - [ ] Validate JSONPath syntax on each field item using `validate_mapping`, reporting specific field errors as `items[i].source_field.address`.
  - [ ] Ensure all rejection messages are clear English.
- **Verification:**
  - Test cases: `TC-BE-SIG-07` through `TC-BE-SIG-10`.

---

## Phase P4: Connections & Add Data Wizard

### Task P4.1: Backend Connection Lifecycle Operations
- **Files:**
  - Modify: `apps/center/src/factorix/modules/collect.py:40-44`
- **Actions:**
  - [ ] Implement `PATCH /api/v1/connections/{id}`:
    - Accepts `name`, `config` (merge), `secret_input` (update password or preserve existing if empty), `edge_id`.
    - Optimistic concurrency check on `version` (`409`).
    - Re-runs config parser, increments `config_revision`, triggers Edge configuration push, emits `CONNECTION_UPDATE` audit event.
  - [ ] Implement `POST /api/v1/connections/{id}/resume` (symmetric to existing `/pause`).
  - [ ] In `DELETE /api/v1/connections/{id}`: enforce restriction that connection must be `DRAFT` or `PAUSED`. If `ACTIVE`, return `409 CONNECTION_IN_USE` with message *"Pause the connection before archiving it."*.
  - [ ] Extend `POST /api/v1/connections/{id}/tests` to accept `{ "mode": "CONNECTIVITY" | "FULL", "fields": [...] }`.
  - [ ] Allow creating MQTT connection with empty topics array (`topics: []`), creating an initial `SUBSCRIBE` job.
- **Verification:**
  - Test cases: `TC-BE-CON-15` through `TC-BE-CON-20`.

### Task P4.2: Frontend Connections Page & Connection Detail Drawer
- **Files:**
  - Create: `apps/web/src/pages/collector/connections/ConnectionsPage.tsx`
  - Create: `apps/web/src/pages/collector/connections/ConnectionDetailDrawer.tsx`
  - Create: `apps/web/src/pages/collector/connections/ConnectionForm.tsx`
  - Modify: `apps/web/src/store/AppContext.tsx`
- **Actions:**
  - [ ] Interactive KPI filter pills: Total, Online, Degraded / Offline, Paused.
  - [ ] Connections table columns: Name, Protocol, Host / Endpoint, Edge, Signals count, Last data, Status, Actions menu (`...`).
  - [ ] Actions menu items:
    - Test connection (runs CONNECTIVITY mode test).
    - Add data from this connection (opens wizard with connection pre-selected).
    - Edit (opens ConnectionForm drawer).
    - Pause / Resume.
    - Archive: invokes `ConfirmDialog`. If connection is active, dialog offers *"Pause and archive"*.
  - [ ] Connection Detail Drawer with tabs: Overview, Signals (grouped by resource), Topics/Addresses, History.
  - [ ] Support `?connectionId=` query parameter to auto-open drawer.
- **Verification:**
  - Test cases: `TC-UI-CN-01` through `TC-UI-CN-25`.

### Task P4.3: Frontend 5-Step Add Data Wizard
- **Files:**
  - Create: `apps/web/src/pages/collector/add-data/AddDataPage.tsx`
  - Create: `apps/web/src/pages/collector/add-data/StepTarget.tsx`
  - Create: `apps/web/src/pages/collector/add-data/StepSource.tsx`
  - Create: `apps/web/src/pages/collector/add-data/StepAddress.tsx`
  - Create: `apps/web/src/pages/collector/add-data/StepFields.tsx`
  - Create: `apps/web/src/pages/collector/add-data/StepReview.tsx`
  - Create: `apps/web/src/pages/collector/add-data/JsonTree.tsx`
  - Create: `apps/web/src/pages/collector/add-data/OpcBrowser.tsx`
  - Create: `apps/web/src/pages/collector/add-data/useAddDataDraft.ts`
- **Actions:**
  - [ ] Wizard State Machine & validation rules per step:
    - Step 1 `StepTarget`: ResourcePicker filtering active resources; prefill via `?resourceId=`.
    - Step 2 `StepSource`: Lists site connections; "+ New connection" creates connection inline only upon "Save connection". Ephemeral draft connections for tests.
    - Step 3 `StepAddress`: Suggests MQTT topic filter `uns/${path_code}/#`; custom input validation; QoS 0/1/2 selection.
    - Step 4 `StepFields`:
      - MQTT/HTTP: "Capture sample (10 s)" -> displays captured topics list and recursive `JsonTree` with type annotations. Clicking node adds field with specific topic, JSONPath address, slugified name, and guessed type. Button "Select all numeric".
      - Modbus: register row editor with "Add rows..." range generator.
      - OPC UA: tree node browser.
      - Timestamp auto-detection: detects `source_timestamp` and sets timestamp path.
      - Inline validation: unique signal names, valid JSONPath, type match check.
      - "Apply to similar resources": detects sibling resources matching topic pattern (e.g. `AA10-01`..`06`) and creates batch signals.
    - Step 5 `StepReview`: Summary card, "Run test" (FULL mode) displaying stage statuses and live sample previews. "Start collecting" commits signals via `signals/bulk`, publishes config release, and navigates to Signals page.
- **Verification:**
  - Test cases: `TC-UI-AD-01` through `TC-UI-AD-45`, `TC-E2E-01`.

### Task P4.4: Shared MQTT Topic Validation Utility
- **Files:**
  - Create: `apps/web/src/utils/mqttTopic.ts`
  - Modify: `apps/center/src/factorix/modules/protocols.py`
- **Actions:**
  - [ ] Implement `validateTopicFilter(topic: string): string | null` with identical rules:
    - Not empty
    - Does not start with `/`
    - Does not start with `$` (reserved broker prefix)
    - No empty levels (`//`)
    - `#` wildcard must be the terminal character on its own level
    - `+` wildcard must occupy its entire level
    - Maximum topic byte length <= 65535
- **Verification:**
  - Test cases: `TC-UI-AD-10` through `TC-UI-AD-14`, `TC-BE-CON-05` through `TC-BE-CON-08`.

### Task P4.5: Wizard Draft State Persistence & Navigation Guard
- **Files:**
  - Modify: `apps/web/src/pages/collector/add-data/useAddDataDraft.ts`
  - Modify: `apps/web/src/components/shell/Sidebar.tsx`
  - Modify: `apps/center/src/factorix/modules/collect.py`
- **Actions:**
  - [ ] Persist wizard draft state in `sessionStorage['fx.addData.draft']` across page reloads.
  - [ ] Implement navigation guard: warn user with `ConfirmDialog` if leaving wizard with unsaved changes.
  - [ ] On Cancel: prompt whether to delete newly created connection if one was created in Step 2.
  - [ ] Background cleaner in Center: purge ephemeral DRAFT connections older than 1 hour.
- **Verification:**
  - Test cases: `TC-UI-AD-40`, `TC-UI-AD-41`, `TC-UI-AD-42`, `TC-UI-AD-43`.

---

## Phase P5: Overview Page & Scope Navigation

### Task P5.1: Overview Page Redesign
- **Files:**
  - Create: `apps/web/src/pages/overview/OverviewPage.tsx`
  - Create: `apps/web/src/pages/overview/GetStartedChecklist.tsx`
  - Create: `apps/web/src/pages/overview/DataQualityDonut.tsx`
  - Create: `apps/web/src/pages/overview/LatestValuesTable.tsx`
  - Create: `apps/web/src/pages/overview/RecentActivityFeed.tsx`
- **Actions:**
  - [ ] Strip out dummy chart arrays and live refresh mocks.
  - [ ] Implement "Get started" 4-step checklist: ① Build factory model, ② Enroll edge, ③ Add connection, ④ Map signals.
  - [ ] Clickable KPI cards: Resources, Signals ("X of Y good"), Connections ("X online"), Edges ("X online").
  - [ ] Data Collection summary card: "X/Y edges online · A/B connections online · Last data X s ago · ~M msg/min".
  - [ ] Data quality donut: real distribution of Good, Uncertain, Bad, Stale, No data without decorative dots.
  - [ ] Latest values table: 6 recent signal values with relative timestamps and absolute tooltip time.
  - [ ] Recent activity feed: formatted audit messages with relative time and link to Diagnostics Activity tab.
- **Verification:**
  - Test cases: `TC-UI-OV-01` through `TC-UI-OV-10`.

### Task P5.2: Scope Synchronization
- **Files:**
  - Modify: `apps/web/src/store/AppContext.tsx`
  - Modify: `apps/web/src/pages/overview/OverviewPage.tsx`
- **Actions:**
  - [ ] Ensure `countResources(scope)` matches between Topbar plant selector and Overview KPI.
  - [ ] When "All sites" is chosen, update Overview subtitle to *"Showing all sites"* and aggregate metrics globally.
- **Verification:**
  - Test cases: `TC-UI-NAV-09`, `TC-UI-OV-08`.

---

## Phase P6: Signals, Edge Collectors & Diagnostics

### Task P6.1: Backend Signal Lifecycle Endpoints
- **Files:**
  - Modify: `apps/center/src/factorix/transport/app.py:537`
  - Modify: `apps/center/src/factorix/modules/collect.py`
- **Actions:**
  - [ ] Enhance `PATCH /api/v1/signals/{id}`: accept `display_name`, `unit`, `description`, `expected_interval_ms`, `enabled`.
  - [ ] Implement `DELETE /api/v1/signals/{id}`: set `status='ARCHIVED'`, set `signal_bindings.enabled=false`, trigger Edge config release, log audit event.
  - [ ] Implement `POST /api/v1/signals/bulk-action`: body `{ "ids": [...], "action": "disable" | "enable" | "delete" }`.
- **Verification:**
  - Test cases: `TC-BE-SIG-11`, `TC-BE-SIG-12`, `TC-BE-SIG-13`, `TC-BE-SIG-14`.

### Task P6.2: Frontend Signals Catalog & Inspector Drawer
- **Files:**
  - Create: `apps/web/src/pages/collector/signals/SignalsPage.tsx`
  - Create: `apps/web/src/pages/collector/signals/SignalsTable.tsx`
  - Create: `apps/web/src/pages/collector/signals/SignalInspector.tsx`
  - Create: `apps/web/src/pages/collector/signals/SignalEditModal.tsx`
  - Create: `apps/web/src/pages/collector/signals/Sparkline15m.tsx`
- **Actions:**
  - [ ] Filter bar: by resource (`?resourceId=`), connection (`?connectionId=`), quality status, data type tab (Number, Integer, Boolean, Text), and search query.
  - [ ] Table columns: Signal name & key, Resource location, Value & Unit, 15-minute Trend sparkline, Quality badge, Updated (`source_time` relative time).
  - [ ] Real sparkline: fetch from `GET /api/v1/observations/history?signal_id=...&from=now-15m&limit=120` (lazy cached). Render empty if no history.
  - [ ] Signal Inspector drawer: live value, quality reason, binding metadata (Connection, Topic / Address, Field, Edge), interval settings.
  - [ ] Action buttons: Edit metadata, Disable / Enable, Delete (with confirmation), and Bulk actions (Disable, Delete, Export CSV).
- **Verification:**
  - Test cases: `TC-UI-SG-01` through `TC-UI-SG-14`.

### Task P6.3: Signals Live Operations View
- **Files:**
  - Create: `apps/web/src/pages/collector/signals/SignalsLiveView.tsx`
  - Create: `apps/web/src/pages/collector/signals/TrendChart.tsx`
  - Delete: `apps/web/src/pages/10_LiveOperations/LiveOperationsPage.tsx`
- **Actions:**
  - [ ] Live view mode toggle on Signals page (`view=live` query parameter).
  - [ ] Grid of large telemetry cards updating via poll (every 5s) or WebSocket stream.
  - [ ] Select up to 4 signals to plot simultaneously on `TrendChart`.
  - [ ] Time range selector: 15 minutes, 1 hour, 6 hours.
  - [ ] "Export CSV" for active chart series.
- **Verification:**
  - Test cases: `TC-UI-SG-15` through `TC-UI-SG-20`.

### Task P6.4: Edge Collectors Management Page
- **Files:**
  - Create: `apps/web/src/pages/collector/edges/EdgesPage.tsx`
  - Create: `apps/web/src/pages/collector/edges/EnrollmentTokenModal.tsx`
  - Create: `apps/web/src/pages/collector/edges/EdgeRenameModal.tsx`
  - Modify: `apps/center/src/factorix/modules/edge_sync.py`
- **Actions:**
  - [ ] Resolve site name cleanly via `siteName(siteId)` without displaying raw UUIDs.
  - [ ] Status mapping: normalized `ONLINE`, `DEGRADED`, `OFFLINE`, `NOT_ENROLLED`.
  - [ ] Configuration sync status: `active_revision === desired_revision ? 'Up to date' : 'Update pending'`.
  - [ ] Actions menu:
    - Rename Edge node (`PATCH /api/v1/edges/{id}`).
    - Show enrollment token: displays token in modal with countdown *"Expires in 30 min"* and Copy button (token hidden from table).
    - Re-enroll dialog with warning.
    - Delete Edge: blocked if any active connection is bound to the edge node.
- **Verification:**
  - Test cases: `TC-UI-ED-01` through `TC-UI-ED-10`, `TC-BE-EDGE-11`, `TC-BE-EDGE-12`.

### Task P6.5: Diagnostics Center (Health & Activity Tabs)
- **Files:**
  - Create: `apps/web/src/pages/collector/diagnostics/DiagnosticsPage.tsx`
  - Create: `apps/web/src/pages/collector/diagnostics/HealthTab.tsx`
  - Create: `apps/web/src/pages/collector/diagnostics/ActivityTab.tsx`
  - Create: `apps/center/migrations/versions/0007_audit_severity.py`
  - Modify: `apps/center/src/factorix/modules/identity.py` (audit events)
- **Actions:**
  - [ ] Health Tab:
    - 4 issue KPI counters: Edges offline, Connections degraded, Signals bad, Signals stale.
    - Actionable issue list with remediation recommendations (e.g. *"power on AA10-02 has no update for 10 s · Check that the source publishes …/energy"*).
    - Clicking connection error opens connection drawer.
  - [ ] Activity Tab:
    - Add `severity` column (`INFO`, `WARN`, `ERROR`) to `audit_events`.
    - Human-readable event formatter `formatAuditEvent(e)`.
    - Severity filter (All, Warning, Error), cursor pagination ("Load more"), and CSV export.
- **Verification:**
  - Test cases: `TC-UI-DG-01` through `TC-UI-DG-10`, `TC-BE-AUD-01` through `TC-BE-AUD-04`.

---

## Phase P7: Data Models (UNS Output Groups)

### Task P7.1: Backend Output Groups Management
- **Files:**
  - Modify: `apps/center/src/factorix/modules/resources.py` (or `output_groups.py`)
- **Actions:**
  - [ ] Implement `GET /api/v1/output-groups/{id}` including members ordered by `ordinal`.
  - [ ] Implement `PATCH /api/v1/output-groups/{id}`: `display_name`, `topic_template`, `resource_id`, `members[{signal_id, output_alias, ordinal}]`, `version`.
  - [ ] Implement `DELETE /api/v1/output-groups/{id}`: soft delete with `status='ARCHIVED'`.
  - [ ] Validation rules:
    - `output_alias` matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and is unique within the group.
    - `topic_template` does not start with `/`.
    - Topic tokens must be valid hierarchy levels (`enterprise`, `site`, `area`, `plant`, `zone`, `line`, `cell`, `machine`, `resource`).
    - Signals must be `ACTIVE`.
  - [ ] In `GET /output-groups/{id}/preview`: return live JSON payload; if signal has no data, output `null` with `quality: "NO_DATA"`.
- **Verification:**
  - Test cases: `TC-BE-MOD-01` through `TC-BE-MOD-08`.

### Task P7.2: Frontend Data Models Workspace
- **Files:**
  - Create: `apps/web/src/pages/models/ModelCatalogPage.tsx`
  - Create: `apps/web/src/pages/models/ModelWorkspace.tsx`
  - Modify: `apps/web/src/store/AppContext.tsx:806-818`
- **Actions:**
  - [ ] Model Catalog: lists defined models with scope, topic template, signal count, and status.
  - [ ] Model Workspace:
    - Design Tab: model name, target scope picker (`ResourcePicker`), interactive topic template editor with clickable token chips (`{enterprise}`, `{site}`, etc.), resolved topic preview, and field alias mapper.
    - Live Preview Tab: real-time JSON display with values, timestamps, and quality flags.
    - Calculations Tab: clean Coming soon placeholder.
  - [ ] Strip mock simulator references ("Test Dispatch (Simulated)", "FactoriX-UNS-Publisher-v1").
- **Verification:**
  - Test cases: `TC-UI-DM-01` through `TC-UI-DM-10`.

---

## Phase P8: Accessibility, Responsive Layout & Design System

### Task P8.1: Accessibility Audit & WAI-ARIA Standards
- **Files:**
  - Modify: `apps/web/src/components/` (all interactive components)
- **Actions:**
  - [ ] Treeview: verify full WAI-ARIA keyboard navigation and focus styling.
  - [ ] Modals: enforce focus trapping on open and restore focus to trigger element on Escape.
  - [ ] Interactive controls: verify `aria-label` on all icon-only buttons.
  - [ ] Status badges: ensure textual labels accompany all color indicators for colorblind accessibility.
  - [ ] Automated accessibility audit using `@axe-core/playwright`: 0 serious or critical violations across all 10 core views.
- **Verification:**
  - Test cases: `TC-UI-NAV-13`, `TC-UI-HS-28` through `TC-UI-HS-31`.

### Task P8.2: Responsive Viewport Optimization
- **Files:**
  - Modify: `apps/web/src/components/shell/Sidebar.tsx`
  - Modify: `apps/web/src/components/shell/Topbar.tsx`
  - Modify: `apps/web/src/components/common/DataTable.tsx`
- **Actions:**
  - [ ] Viewport 1366x768: verify single-line Topbar with no broken line wraps.
  - [ ] Viewport 1024x768: sidebar collapses to icon-only rail with hover tooltips; drawers adjust to mobile overlays below 768px.
  - [ ] DataTables: ensure horizontal scroll within table boundary without viewport spill.
- **Verification:**
  - Test cases: `TC-UI-NAV-13`.

---

## Phase P9: Test Automation & Module Lock Verification

### Task P9.1: Test Environment Configuration
- **Files:**
  - Create: `docker-compose.test.yml`
  - Create: `tests/simulators/mqtt_tipa_publisher.py`
  - Create: `tests/simulators/modbus_sim.py`
  - Create: `tests/simulators/opcua_sim.py`
- **Actions:**
  - [ ] Docker Compose test stack: PostgreSQL 17, Eclipse Mosquitto (port 18883 with user/pass and TLS listener), Center appliance, Edge collector.
  - [ ] TIPA Publisher simulator: publishes 36 realistic topics matching the DongNai factory pattern with genuine JSON payloads and `source_timestamp`.
  - [ ] Modbus simulator: PyModbus holding registers and coils.
  - [ ] OPC UA simulator: AsyncUA server exposing test nodes.
- **Verification:**
  - Stack boots cleanly with `docker compose -f docker-compose.test.yml up -d` and passes `/health/ready`.

### Task P9.2: Test Suite Execution Matrix
- **Files:**
  - Backend Unit: `apps/center/tests/unit/` (`test_hierarchy_flexible.py`, `test_resource_codes.py`, `test_topic_validation.py`, `test_protocol_configs.py`, `test_layout_schema.py`, `test_graph_neighbors.py`, `test_output_groups.py`, `test_auth_sessions.py`)
  - Backend Integration: `apps/center/tests/integration/` (`test_collect_flow.py`, `test_edge_health.py`, `test_commissioning.py`, `test_ingest_quality.py`)
  - Edge Unit: `apps/edge/tests/` (`test_mqtt_routing.py`, `test_coerce.py`, `test_source_time.py`, `test_commission_truth.py`)
  - Web E2E: `apps/web/tests/e2e/` (`nav.spec.ts`, `hierarchy.spec.ts`, `layout.spec.ts`, `graph.spec.ts`, `connections.spec.ts`, `add-data.mqtt.spec.ts`, `signals.spec.ts`, `edges.spec.ts`, `diagnostics.spec.ts`, `models.spec.ts`, `golden-path.spec.ts`)
- **Actions:**
  - [ ] Implement and run each test suite, verifying all test IDs from §9 and §10.
  - [ ] Execute End-to-End Golden Path (`TC-E2E-01` through `TC-E2E-05`).
- **Verification:**
  - 100% test pass rate across all suites.

### Task P9.3: Verification of §11 Module Lock Criteria & Tagging
- **Conditions for Locking:**
  - Navigation & Shell: `TC-UI-NAV-01..13` PASS -> Tag `lock/shell-v1`
  - Hierarchy Structure: `TC-UI-HS-01..45`, `TC-BE-RES-01..30` PASS -> Tag `lock/hierarchy-v1`
  - Layout Designer: `TC-UI-LD-01..25`, `TC-BE-LAY-01..08` PASS -> Tag `lock/layout-v1`
  - Knowledge Graph: `TC-UI-KG-01..15`, `TC-BE-GR-01..08` PASS -> Tag `lock/graph-v1`
  - Connections: `TC-UI-CN-01..25`, `TC-BE-CON-01..20` PASS -> Tag `lock/connections-v1`
  - Add Data: `TC-UI-AD-01..45`, `TC-BE-COM-01..12`, `TC-BE-SIG-01..10`, `TC-BE-RT-01..15`, `E2E-01..02` PASS -> Tag `lock/add-data-v1`
  - Signals: `TC-UI-SG-01..20`, `TC-BE-SIG-11..15`, `TC-BE-ING-01..10` PASS -> Tag `lock/signals-v1`
  - Edge Collectors: `TC-UI-ED-01..10`, `TC-BE-EDGE-01..12`, `E2E-03` PASS -> Tag `lock/edges-v1`
  - Diagnostics: `TC-UI-DG-01..10`, `TC-BE-AUD-01..03` PASS -> Tag `lock/diagnostics-v1`
  - Overview: `TC-UI-OV-01..10` PASS -> Tag `lock/overview-v1`
  - Data Models: `TC-UI-DM-01..10`, `TC-BE-MOD-01..08` PASS -> Tag `lock/models-v0`
  - Auth: `TC-UI-AUTH-01..12`, `TC-BE-AUTH-01..06` PASS -> Tag `lock/auth-basic-v1`
- **Actions:**
  - [ ] Execute `git tag -a <tag-name> -m "<description>"` upon meeting lock criteria for each module.
