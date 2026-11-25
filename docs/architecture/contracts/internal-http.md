# Contract: HTTP used between processes

| | |
|---|---|
| Summary | In acquisition mode (the appliance default) the three FactoriX processes **do not call each other over HTTP**. |
| Tests | `apps/center/tests/contracts/test_route_table.py` (route snapshot `golden/routes.txt`), `apps/center/tests/unit/test_safety_guards.py` |

## 1. Inventory (verified by grep of `apps/*/src` and the live appliance access log, 2026-11-18)

| Caller | Callee | Endpoint | Mode | Purpose |
|---|---|---|---|---|
| API health loop, every 30 s (`application/health/broker_depth.py` → `platform/broker.py::probe_broker_health`, B-11) | RabbitMQ management (`FACTORIX_RABBITMQ_MGMT_URL`, compose default `http://factorix-rabbitmq:15672`) | `GET /api/queues/{vhost}/{queue}` for ingest, live and DLQ queues (after AMQP passive declares); basic auth from the AMQP URL; 3 s timeout per call, 12 s per probe | acquisition | read-only queue depth / unacked / DLQ / oldest age for `/health/ready?verbose=1` and `/api/v1/edges` (`broker`). Queue depth for the acquisition replay pump still comes from AMQP passive declares (`RabbitMQPublisher.queue_depths`) |
| API, ingestion | TDengine taosAdapter (`FACTORIX_TDENGINE_DSN`, `ws://…:6041`) | WebSocket SQL (`taos-ws-py`) | acquisition | telemetry write/read (not HTTP REST) |
| `run-appliance.ps1` / operators / load balancers | API | `GET /health/live` → `{"status":"live"}`; `GET /health/ready` → `{"status":"ready"}` or 503 `ACQUISITION_DOWN` / `INGESTION_DOWN` (acquisition mode) / `EDGE_DOWN` (edge mode); `?verbose=1` adds `processes[]`, `broker` and `notify_bridge` (also inside the 503 error body) | both | liveness / readiness |
| `factorix_edge` daemon (`apps/edge`) | API (`FACTORIX_CENTER_URL`, default `http://127.0.0.1:8080`) | `/api/v1/edge-sync/{enroll,heartbeat,config,ack,secrets/{id},observations,commands,commands/{job_id}}` with `Authorization: Bearer <edge credential>` | **edge only** | legacy Edge protocol |
| acquisition HTTP connector | external OT sources | per connection | acquisition | data acquisition (not internal) |

The live appliance (acquisition mode) logged 2 425 `/api/v1/…` requests in the 6 h before
this check and **0** requests to `/api/v1/edge-sync/*`.

## 2. Legacy Edge API in acquisition mode (A4(b))

Since 2026-11-18 every `/api/v1/edge-sync/*` route answers **410 Gone** with
`{"error":{"code":"EDGE_SYNC_DISABLED",…}}` when `FACTORIX_COLLECTOR_MODE=acquisition`, before any database
session is opened and before body validation (`transport/http/routers/edge_legacy.py::_legacy_edge_sync_enabled`). Reason:
`GET /edge-sync/secrets/{id}` returns a **decrypted** connection secret to any valid Edge bearer token, and
nothing in acquisition mode uses the API. In `edge` mode the routes behave exactly as before. The routes stay
registered (route table unchanged) until plan S17 retires the Edge path (Phase D2).

`FACTORIX_COLLECTOR_MODE` defaults to `acquisition` in the image (`Dockerfile`, A4(a)) and in
`docker-compose.yml` (`${FACTORIX_COLLECTOR_MODE:-acquisition}`, so a deliberate rollback to `edge` is one
variable in the project `.env`). `entrypoint.sh` and `Settings.collector_mode` still default to `edge` when the
variable is absent entirely (CT-14, WS-P / Phase C7).

## 3. Browser-facing REST

Not an inter-process contract, but locked by the route snapshot: 210 (method, path) pairs at HEAD + WIP.
Error body for every `AppError`: `{"error":{"code","message","field_errors","correlation_id","retryable"}}`.
Known shape defect: CT-01 (`GET /api/v1/storage/operations` registered twice).
