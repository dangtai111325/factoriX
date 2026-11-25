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
The following tables are strictly forbidden from inspection, schema listing, or data preview:
- `admin_accounts` (password hashes, salts, MFA tokens)
- `user_sessions` / `sessions` (active session tokens, auth cookies)
- `secret_store` (API keys, connection credentials, TLS private keys)
- `password_reset_codes` (temporary auth tokens)
- `alembic_version` (migration lock state — hidden from general browsing)

Any API query requesting metadata or previews for denylisted tables will immediately fail with `403 Forbidden` (`FORBIDDEN_PROTECTED_TABLE`).

### Layer 2: Column Masking & Redaction
For tables that are visible (e.g., `connections`, `signal_definitions`), columns matching sensitive naming patterns are automatically masked:
- `*password*`, `*secret*`, `*token*`, `*credential*`, `*private_key*`
- Masked values appear in data preview as `••••••••` or are omitted from the payload.

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
   - Paginated preview table (default 25 rows, up to 100).
   - Column sorting and cursor-based pagination.
   - Query execution timeout capped at 3000ms with strict row limits (`LIMIT 100`).
   - Read-only watermark badge: `READ-ONLY VIEW • MUTATIONS DISABLED`.

---

## 4. API Endpoints

All endpoints require active authentication and `VIEW_PG_METADATA` / `VIEW_STORAGE` permission:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/storage/pg/schemas` | List all visible schemas in the control plane database |
| `GET` | `/api/v1/storage/pg/tables?schema=public` | List visible tables with approximate row counts |
| `GET` | `/api/v1/storage/pg/tables/{table_name}/schema` | Column definitions, types, nullability, PK/FK flags |
| `GET` | `/api/v1/storage/pg/tables/{table_name}/preview?limit=25&cursor=...` | Sanitized paginated data preview |
| `GET` | `/api/v1/storage/pg/relationships` | Graph edges representing genuine PostgreSQL foreign keys |

---

## 5. Defensive Verification Matrix

| ID | Test Scenario | Expected Outcome |
|---|---|---|
| `PG-001` | User switches to PostgreSQL engine | Engine tab shows `PostgreSQL (Read Only)`; mutation buttons are hidden. |
| `PG-004` | Inspect `signal_definitions` schema | Columns, types, and FK to `resources` displayed accurately. |
| `PG-006` | Forged POST/PUT/DELETE request to PG explorer API | Returns `405 Method Not Allowed` or `403 Forbidden`. |
| `PG-007` | SQL injection attempt in preview filters | Parameterized query protects DB; error returned cleanly without leaking stack trace. |
| `PG-008` | Direct API request for `admin_accounts` | Returns `403 Forbidden` (`FORBIDDEN_PROTECTED_TABLE`). |
| `PG-010` | Long-running query / large table preview | Statement timeout fires at 3s; returns `408 Request Timeout` without locking DB. |
| `PG-014` | TDengine container down, PG container up | PostgreSQL Explorer operates normally; TDengine tab shows degraded status banner. |
