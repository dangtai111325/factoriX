# Isolated Test & Staging Environment Specification

> **Golden Safety Rule:** The production appliance container `factorix-appliance` (`:8080`, Docker volume `factorix-data`) and hardware OT host `pc03` (`192.168.2.108`) are **strictly off-limits** for automated/destructive tests. All development, fault injection, scale benchmarks, telemetry reset tests, and Playwright E2E tests run exclusively on isolated Docker project **`factorix-storage-e2e`**.

---

## 1. Environment Separation Matrix

| Resource | Production / Live Target (DO NOT TOUCH) | Isolated Dev & E2E Stack (`factorix-storage-e2e`) |
|---|---|---|
| Compose File | `docker-compose.yml` | `docker-compose.test.yml` |
| HTTP Web / API Port | `127.0.0.1:8080` | `127.0.0.1:8081` |
| Database Name | `factorix` | `factorix_test` |
| Destructive Test Flag | Unset / disallowed | `FACTORIX_ENABLE_DESTRUCTIVE_TESTS=YES_I_USE_EPHEMERAL_DB` |
| PostgreSQL Volume | `factorix-data` | Disposable volume `factorix_e2e_pg_data` (project-scoped) |
| RabbitMQ Service | — *(until S16 cutover)* | `rabbitmq:4.0-management-alpine` (internal net, ports exposed to test runner only) |
| TDengine Service | — *(until S16 cutover)* | `tdengine/tdengine:3.3.6.13` (internal net + WebSocket `:6041`) |
| OT Sources | Live `pc03` (`192.168.2.108`) | Isolated mock simulators in `tests/simulators/` (Modbus TCP, OPC UA, MQTT, HTTP REST, WebSocket) |

---

## 2. Destructive Test Safety Guard (`tests/safety/test_destructive_guard.py`)

Any test or script that resets data, truncates tables, or purges broker/TSDB state MUST call `check_destructive_test_db_guard(database_url, env_flag)` first, requiring:
1. `FACTORIX_ENVIRONMENT=test`
2. `FACTORIX_ENABLE_DESTRUCTIVE_TESTS=YES_I_USE_EPHEMERAL_DB`
3. Database name matches `_test`, `-test`, `_ephemeral`, `-ephemeral`, `factorix_test`, `factorix_ci`, `test_db`, or `ephemeral`.

---

## 3. Pinned Infrastructure Images Available Locally

| Service | Pinned Image Tag | Verified Digest / ID | Purpose |
|---|---|---|---|
| PostgreSQL | `postgres:17-alpine` | `b0f9560a2de0` | Control plane & staging clone verification |
| RabbitMQ | `rabbitmq:4.0-management-alpine` | `6202aafa4a1b` | Quorum Queue ingress broker + management HTTP API (`:15672`) |
| TDengine | `tdengine/tdengine:3.3.6.13` | `79d32ce8a42f` | TSDB engine + `taosadapter` REST/WebSocket (`:6041`) |

---

## 4. Verification & Host Capacity Baseline

- **Host Free Disk (`C:`):** `306 GiB` free / `652 GiB` total (ample for dual staging compose + TDengine/RabbitMQ POCs).
- **Local Python Test Runner:** `pytest` inside repo `.venv` + Docker Python 3.12 parity tests inside Compose CI containers.
- **Browser Automation Runner:** Chromium / Playwright in visible desktop mode (`1440x900` & `390x844` mobile responsive spot checks), capturing screenshots and tracing API/DB side effects against `:8081`.
