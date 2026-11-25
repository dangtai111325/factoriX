# PostgreSQL Read-Only Explorer

**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** 400dba192eb13be30806dbacb1568ffff23ae26b  
**Last updated:** 2026-11-12

---

## 1. Overview & Business Intent

FactoriX uses PostgreSQL 17 as its core control plane, storing user accounts, factory hierarchy, connection configurations, signal definitions, data model formulas, and the physical storage schema registry.

While TDengine is the high-throughput time-series engine, system engineers often need visibility into the relational control plane to understand system metadata, verify foreign key relationships, inspect signal-to-connection mappings, and debug configuration issues.

The **PostgreSQL Read-Only Explorer** provides this visibility directly within `Storage Management` (`/historian/storage`) via the Engine Switcher tab:
- **Engine Switcher:** `[ TDengine (Managed) ]` | `[ PostgreSQL (Read Only) ]`
- **Explicit Read-Only Guarantee:** Strictly read-only at the UI, API, and database permission layers.
- **Security Perimeter:** Automatic masking and denylist protection for secrets, passwords, tokens, and sensitive system state.

---

## 2. Security Perimeter & Allowlist / Denylist Rules

To ensure that internal secrets and sensitive user credentials are never exposed, the PostgreSQL Explorer enforces three layers of defense:

### Layer 1: Table & Schema Denylist (Server-Side)
The following tables (`SENSITIVE_TABLES` in `apps/center/src/factorix/modules/postgres_explorer.py`) are hidden from the table list and refused for preview and count:
- `admin_accounts`, `sessions`, `password_reset_codes`, `login_throttle` (credentials and sign-in state)
- `secret_store`, `edge_enrollment_tokens` (connection credentials and enrollment tokens)
- `audit_events`
- `alembic_version`

A preview or count request for one of these tables fails with `403` (`ACCESS_DENIED`).

### Layer 2: Column Masking & Redaction
For tables that are visible (e.g., `connections`, `signal_definitions`), columns matching sensitive naming patterns are automatically masked:
- `*password*`, `*secret*`, `*token*`, `*credential*`, `*private_key*`
- Masked values appear in data preview as `********`.

### Layer 3: Database Role Privileges (Least Privilege)
The backend connection pool for PostgreSQL Explorer queries uses a dedicated read-only role or explicitly enforces read-only transactions:
```sql
SET TRANSACTION READ ONLY;
```
Direct DDL (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`) or DML (`INSERT`, `UPDATE`, `DELETE`) executed through explorer endpoints is impossible and will raise an immediate database error.

---

## 3. UI Capabilities & Views

When the user selects `PostgreSQL (Read Only)` in Storage Management, the UI provides:

### 3.1 Database & Schema Tree (Left Sidebar / Accordion)
- Hierarchical tree: Database (`factorix`) → Schemas (`public`, etc.) → Tables & Views
- Search filter by table name
- Row count estimate chip next to each table name

### 3.2 Main Content Panes (Tabs)
1. **Columns & Schema:**
   - Table columns: `Column Name`, `Data Type`, `Nullable`, `Default Value`, `Primary Key (PK)`, `Foreign Key (FK)` target.
2. **Relationships (ERD Canvas):**
   - Interactive canvas showing verified foreign keys as solid directed lines.
   - Distinct legend: Solid line = `FOREIGN_KEY (pg_constraint)`. No fabricated TDengine-style relationships are drawn here.
   - Pan, zoom, fit, and node focus.
3. **Indexes & Constraints:**
   - Unique constraints, primary keys, and B-tree/GIN indexes with indexed columns.
4. **Data Preview:**
   - Paginated preview table (default 50 rows, at most 200, `limit` / `offset` pagination).
   - Preview statement timeout 5000 ms; exact count (`Count exactly`) 10 s.
   - Read-only watermark badge: `READ-ONLY VIEW • MUTATIONS DISABLED`.

---

## 4. API Endpoints

All endpoints require a signed-in administrator session (`apps/center/src/factorix/transport/http/routers/storage/pg_explorer.py`):

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/storage/pg/schemas` | List all visible schemas in the control plane database |
| `GET` | `/api/v1/storage/pg/tables?schema=public` | List visible tables with approximate row counts |
| `GET` | `/api/v1/storage/pg/tables/{schema}/{table}` | Column definitions, types, nullability, PK/FK flags |
| `GET` | `/api/v1/storage/pg/preview/{schema}/{table}?limit=50&offset=0` (also `/api/v1/storage/pg/preview?schema=&table=`) | Sanitized paginated data preview |
| `GET` | `/api/v1/storage/pg/count/{schema}/{table}` | Exact `count(*)` in a read-only transaction (504 `COUNT_TIMEOUT` after 10 s) |
| `GET` | `/api/v1/storage/pg/relationships?schema=public` | Tables plus graph edges of genuine PostgreSQL foreign keys |

---

## 5. Defensive Verification Matrix

| ID | Test Scenario | Expected Outcome |
|---|---|---|
| `PG-001` | User switches to PostgreSQL engine | Engine tab shows `PostgreSQL (Read Only)`; mutation buttons are hidden. |
| `PG-004` | Inspect `signal_definitions` schema | Columns, types, and FK to `resources` displayed accurately. |
| `PG-006` | Forged POST/PUT/DELETE request to PG explorer API | Returns `405 Method Not Allowed` or `403 Forbidden`. |
| `PG-007` | SQL injection attempt in preview filters | Parameterized query protects DB; error returned cleanly without leaking stack trace. |
| `PG-008` | Direct API request for `admin_accounts` | Returns `403` (`ACCESS_DENIED`). |
| `PG-010` | Long-running query / large table preview | Statement timeout fires (5 s preview, 10 s exact count → 504 `COUNT_TIMEOUT`) without locking DB. |
| `PG-014` | TDengine container down, PG container up | PostgreSQL Explorer operates normally; TDengine tab shows degraded status banner. |
