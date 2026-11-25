# End-to-End Browser Walkthrough Guide (Computer Use & Automation)

**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** 400dba192eb13be30806dbacb1568ffff23ae26b  
**Last updated:** 2026-11-12

---

## 1. Overview & Setup Requirements

This runbook guides end-to-end browser walkthroughs and automated Playwright execution for testing the revised Storage Management and Historian workflows.

### Prerequisites
- Active test appliance stack running via Docker Compose:
  - `factorix-appliance`: Web UI at `http://localhost:5173` (or port 8000 for backend)
  - `factorix-postgres`: Port 5432
  - `factorix-rabbitmq`: Port 5672 / 15672
  - `factorix-tdengine`: Port 6041 (REST) / 6030
- 5 protocol simulators active: Modbus TCP, OPC UA, MQTT, HTTP, WebSocket.
- Browser test dimensions: Desktop standard (1920×1080, 1440×900, 1280×800) and mobile viewport (375×812).

---

## 2. Core Walkthrough Flows

### Walkthrough 1: First-Time Physical TDengine Schema Creation (W1)

1. **W1.01 — Navigation Verification:**
   - Navigate to `http://localhost:5173`.
   - Log in using admin credentials.
   - Expand `Historian & Storage` in the sidebar.
   - **Verification:** Exactly two items appear: `Storage Management` and `Historian`.

2. **W1.02 — Storage Management Overview:**
   - Click `Storage Management` (`/historian/storage`).
   - Observe header: `+ New` button (with Database, Supertable, Subtable dropdown), `Refresh` button.
   - Engine switcher: `TDengine (Managed)` [selected] and `PostgreSQL (Read Only)`.
   - View switcher: `Topology` (canvas) and `Objects` (table).
   - KPI chips: Databases count, Supertables count, Subtables count.
   - **Verification:** Initial clean state shows empty canvas with `No storage objects configured yet` CTA.

3. **W1.03 — Create Database (Wizard A1–A3):**
   - Click `+ New → Database` (navigates to `/historian/storage/create?kind=database`).
   - **Step A1 (Basics):** Enter Name `factory_timeseries`, Description `Core factory telemetry`. Click `Next`.
   - **Step A2 (Storage Settings):** Select Precision `ms`, Retention `365 days`. Click `Next`.
   - **Step A3 (Review & Create):** Review generated DDL: `CREATE DATABASE factory_timeseries PRECISION 'ms' KEEP 365;`. Click `Create Database`.
   - **Verification:** Operation executes; user redirected to `/historian/storage`. Canvas displays new database node `factory_timeseries`.

4. **W1.04 — Create Supertable (Wizard B1–B6):**
   - Click `+ New → Supertable` (navigates to `/historian/storage/create?kind=stable`).
   - **Step B1 (Target & Basics):** Select Database `factory_timeseries`, Name `machine_telemetry`. Click `Next`.
   - **Step B2 (Columns):** `ts TIMESTAMP` is locked at top. Click `+ Add Column`:
     - Col 1: `raw_temperature` (DOUBLE, Nullable)
     - Col 2: `raw_pressure` (DOUBLE, Nullable)
     - Col 3: `derived_state` (VARCHAR 32, Nullable)
   - **Step B3 (Tags):** Click `+ Add Tag`: `resource_id` (VARCHAR 64). Click `Next`.
   - **Step B4 (Source Mapping Template):** Optional binding template. Select `Define later at subtable level`. Click `Next`.
   - **Step B5 (Recording & Retention):** Select Recording Mode `ON_CHANGE`. Click `Next`.
   - **Step B6 (Review & Publish):** Check DDL preview: `CREATE STABLE factory_timeseries.machine_telemetry (ts TIMESTAMP, raw_temperature DOUBLE, raw_pressure DOUBLE, derived_state VARCHAR(32)) TAGS (resource_id VARCHAR(64));`. Click `Publish Supertable`.
   - **Verification:** Node `machine_telemetry` appears inside `factory_timeseries` with schema inheritance line.

5. **W1.05 — Create Subtable with Multi-Source Row Assembly (Wizard C1–C5):**
   - Click `+ New → Subtable` (navigates to `/historian/storage/create?kind=subtable`).
   - **Step C1 (Parent & Identity):** Select STable `machine_telemetry`, Name `line1_m01`. Click `Next`.
   - **Step C2 (Tag Values):** Enter `resource_id = RES-LINE1-PUMP01`. Click `Next`.
   - **Step C3 (Bind Data Sources):**
     - Left pane: 3 tabs (`Hierarchy`, `Data Collector`, `Data Models`).
     - Select `Data Collector` tab → Modbus connection → drag `Temperature_Raw` to `raw_temperature`.
     - Select `Data Models` tab → Pump Health Model → drag `Operating_State` to `derived_state`.
   - **Step C4 (Row Assembly Policy):**
     - Select `LATEST_AS_OF_TRIGGER` with Trigger `raw_temperature` and `max_age_ms = 6000`.
     - Select Recording Mode `ON_CHANGE`.
   - **Step C5 (Review & Create):** Review DDL: `CREATE TABLE line1_m01 USING machine_telemetry TAGS ('RES-LINE1-PUMP01');`. Click `Create & Start Recording`.
   - **Verification:** Subtable appears under STable; active recording indicator turns green.

6. **W1.06 — Historian Verification:**
   - Navigate to `/historian/historian`.
   - In left panel, search and select `line1_m01`.
   - Trend chart renders multi-series line for `raw_temperature` and step-hold for `derived_state`.
   - Verify 4 tabs: `Trend`, `Records` (tabular rows), `Events` (quality transitions), `Saved Views & Exports`.

---

### Walkthrough 2: Safe Telemetry Reset (`Revert To Zero`) (W2)

1. Navigate to Settings / Admin → `Clear Telemetry & Operational History`.
2. Inspect side-by-side preview:
   - **Will Be Cleared:** Subtable telemetry rows, cached latest values, export jobs.
   - **Strictly Preserved:** 5 Connections, 336 Signals, 36 Data Models, Storage Schemas.
3. Enter confirmation text `CLEAR TELEMETRY` and current admin password.
4. Click `Execute Reset`.
5. **Verification:**
   - Modal closes; page refreshes in place without logout or redirect to `/register`.
   - Signals Catalog shows signals present with `UNKNOWN`/`NO_DATA` status until next poll.
   - TDengine subtable row counts drop to 0; schema and column bindings remain intact.
   - Within 5–10 seconds, live simulators produce fresh observations; signals return to `GOOD` under the new epoch.

---

### Walkthrough 3: PostgreSQL Read-Only Explorer (W3)

1. Open `Storage Management` (`/historian/storage`).
2. Switch engine tab to `PostgreSQL (Read Only)`.
3. Verify persistent `READ-ONLY VIEW` badge.
4. Select `public.signal_definitions`:
   - Inspect columns: `id`, `resource_id`, `signal_key`, `data_type`.
   - View ERD canvas: verify solid FK relationship to `resources.id`.
   - View Data Preview: rows render with pagination (25 rows/page).
5. Attempt access to protected tables:
   - In search bar, search `admin_accounts` or `secret_store`.
   - Verify table is omitted from listing or access is blocked with a 403 error banner.
