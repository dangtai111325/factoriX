# FactoriX Storage & Historian — Verified Version & License Matrix

**Branch:** `TDengine-RabbitMQ-Stoorage-Historian`  
**Verified Date (UTC):** `2026-11-10`  
**POC Runner Evidence:** Empirical runs against `factorix-storage-e2e` (`docker-compose.test.yml`)

---

## 1. Container & Engine Matrix (Pinned Versions)

| Layer | Component | Exact Version / Tag | Protocol / Interface | License | Operational Notes |
|---|---|---|---|---|---|
| Control Plane DB | PostgreSQL | `postgres:17-alpine` / `postgresql-17` (`17.11`) | TCP `5432` (`asyncpg 0.32.0`) | PostgreSQL License (Permissive) | Stores auth, Factory Model, Connections/Secrets, Signals, Data Models, Storage Designs, Physical Registry, Epochs, Audit. |
| Transport Broker | RabbitMQ | `rabbitmq:4.0-management-alpine` (`4.0.9`, Erlang `27.3.4.19`) | AMQP 0-9-1 (`aio-pika 10.2.3`) + Mgmt HTTP `:15672` | MPL-2.0 | Quorum queues (`x-queue-type: quorum`), durable publisher confirms, manual ACK, `at-least-once` DLX, `reject-publish` overflow. |
| Time-Series Historian | TDengine | `tdengine/tdengine:3.3.6.13` (Community Edition) | WebSocket `taosws` `:6041` (`taos-ws-py 0.7.1`) | Server: AGPL-3.0 (standalone container boundary); Python client: MIT/Apache | Deployed as an isolated separate container accessed exclusively over network protocol (WebSocket). Enterprise-only features are NOT required or invoked. |
| Backend Runtime | Python | `python:3.12-slim-bookworm` (container) / `3.14` (host venv) | FastAPI `0.162.0`, Uvicorn `0.54.0` | PSF | Uses pre-built `taos-ws-py==0.7.1` & `aio-pika==10.2.3` binary wheels (no Rust toolchain needed in runtime image). |
| Frontend Runtime | Node.js / React | `node:22-bookworm-slim` (`v24.16.0` host), React `18.3.1`, Vite `5.4.11`, TS `5.6.3`, `@xyflow/react` `12.12.1` | REST `/api/v1/*` + WebSocket `/stream` | MIT | E2E verification via Chromium Playwright (`1.65.0`). |

---

## 2. Empirical POC Findings (TDengine 3.3.6.13 & RabbitMQ 4.0.9)

All items below were empirically executed and observed against the live isolated containers before schema/worker coding:

1. **RabbitMQ Quorum Queue + `at-least-once` DLX + `reject-publish` (`aio-pika 10.2.3`)**:
   - Quorum queue declares cleanly with `"x-queue-type": "quorum"`, `"x-dead-letter-strategy": "at-least-once"`, `"x-overflow": "reject-publish"`, `"x-delivery-limit": N`.
   - Poison messages rejected via `nack(requeue=True)` exceeding `x-delivery-limit` route reliably into the durable Quorum DLQ without message loss.
   - Exceeding `x-max-length` with `"x-overflow": "reject-publish"` raises `aiormq.exceptions.DeliveryError: Message delivery failed: Basic.Nack(...)` to publisher confirms, enabling explicit acquisition backpressure instead of silent `drop-head` loss.
2. **TDengine `3.3.6.13` Community Edition + `taos-ws-py 0.7.1`**:
   - `CREATE DATABASE ... PRECISION 'us' KEEP 30d` and `ALTER DATABASE ... CACHEMODEL 'last_row' CACHESIZE 16` succeed on Community `3.3.6.13`; `LAST_ROW(ts, ...)` returns exact latest values.
   - Typed round-trip (`DOUBLE`, signed 64-bit integer `2**63 - 1`, `-0.0`, `BOOL`, Unicode `NCHAR` including Vietnamese diacritics, `NULL`) succeeds with exact fidelity.
   - **SQL String Escaping Critical Finding:** Unescaped `\uXXXX` or backslashes inside SQL single quotes are interpreted by the TDengine SQL lexer (`"°C"` -> JSON `\u00b0C` failed exact comparison until escaping `\` -> `\\` and `'` -> `\'`, OR binding via `stmt2_statement`). Production writes will escape backslashes + quotes consistently and validate JSON serialization before persisting.
   - **Non-finite floats (`NaN`, `Infinity`)**: TDengine rejects `'NaN'`, `NaN`, `Infinity` with `QueryError [0x0216]`. Canonical ingestion normalizes/rejects non-finite floats before persistence (`BAD` / `NON_FINITE_VALUE` or quarantine).
   - **Cross-tenant Deletion Defense-in-Depth:** Although `DELETE FROM <stable> WHERE tag = ...` is supported in 3.3.6.13, `DELETE FROM` cannot be trusted alone across shared super tables during tenant-scoped resets. FactoriX mandates **per-tenant TDengine databases** (`fx_t_<tenant_hex>`) AND explicit subtable enumeration via PostgreSQL `storage_physical_registry` (`DELETE FROM <db>.<subtable> WHERE ts <= ...`).
   - **Row-Width Hard Limit (`65,531` bytes, `[0x263E]`):** TDengine `3.3.6.13` counts `NCHAR(n)` as `4*n` bytes and `VARCHAR(n)` as `n` bytes toward a strict `65,531`-byte maximum row width. `model_snapshots` is sized cleanly at `body_text VARCHAR(48000)` + `errors_json VARCHAR(8192)`, and `SchemaCompiler` rejects any compiled supertable exceeding `64,500` bytes (`ROW_WIDTH_EXCEEDED`, `string/enum <= 15000`, `json <= 60000`).
   - **Non-Breaking vs Breaking Schema Evolution:** Non-breaking Managed dataset versions reuse the existing supertable (`ALTER STABLE ... ADD COLUMN ...` executed before new subtables), while breaking updates allocate `_v<version>` supertables + version-salted subtable names (`v{epoch}:...`) so historical data remains queryable during cutover.
   - **Batched Write POC (`test_tdengine_x1_and_x10_batched_benchmark`):** `x1` (`300` rows across `300` cold auto-created subtables): `0.334s` (`899 obs/s`) standalone / `1.245s` (`241 obs/s`) during full container regression; `x10` (`3,000` rows across `300` subtables): `0.604s` (`4,969 obs/s`) standalone / `2.931s` (`1,024 obs/s`) during full container regression over host WebSocket to Docker Desktop.
   - **Backup / Restore POC (`taosdump 3.3.6.13`):** Requires destination directory pre-created (`mkdir -p`); `taosdump -D <db> -o <dir>` and `taosdump -i <dir>` exit `0` and restore Avro tag metadata + table schemas + typed rows identically (`1/1` verified).

---

## 3. Pinned Python Dependencies Added Over Baseline

- `aio-pika==10.2.3` (`aiormq==7.2.5`, `pamqp==5.0.0`)
- `taos-ws-py==0.7.1`
- `PyYAML==6.0.3` (safe YAML loader `yaml.safe_load` / dumper for FactoriX Storage DSL)
- Existing pinned dependencies in `infrastructure/docker/requirements.txt` remain locked (`fastapi==0.162.0`, `sqlalchemy==2.1.6`, `alembic==1.20.1`, `asyncpg==0.32.0`, `pymodbus==3.16.1`, `asyncua==2.1.0`, `paho-mqtt==2.1.0`, `websockets==15.0.1` -> upgradeable to `16.1.1` only if verified in container).

---

## 4. Licensing & Compliance Summary

- **AGPL-3.0 Separation:** TDengine Community Server (`tdengine/tdengine:3.3.6.13`) runs unmodified in its own container/process communicating strictly over WebSocket (`:6041`) with `taos-ws-py`. FactoriX Center/Acquisition Python services do not embed or link `libtaos` server internals. Operators opting for commercial SLA or enterprise features may swap `FACTORIX_TDENGINE_DSN` to an externally licensed TDengine Enterprise/TSDB instance without code changes; no Enterprise-only SQL extensions are depended upon in `v1`.
- **PostgreSQL / RabbitMQ:** Both ship under permissive/weak-copyleft licenses (`PostgreSQL License` / `MPL-2.0`).
