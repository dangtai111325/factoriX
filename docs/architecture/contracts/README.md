# FactoriX inter-process contracts

Status: **descriptive (as-is, verified against code on 2026-11-18, HEAD `4fb46dc` + working tree)**.
These documents describe what the code does today, not what it should do. Where the code disagrees with
an earlier agreement (`v6_contracts.md` Q1–Q7, H1–H7, P1–P4) or with an ADR, the gap is listed under
"Known discrepancies" with an id `CT-nn`. Characterization tests reference the same ids in their
`xfail` reasons, so fixing a discrepancy flips a strict `xfail` and forces the fixer to update both the
test and the doc in the same change.

Process topology (one appliance container, three Python processes):

```
acquisition  ──AMQP obs-batch v2──►  RabbitMQ  ──►  ingestion  ──PG tx: latest_signal_state + NOTIFY──►  API (uvicorn)
     │  ▲                                                │                                                  │
     │  └── PG snapshot + NOTIFY wake-ups ◄── API writes config (connections/jobs/fields/bindings) ◄────────┘
     └──► PG: connections.health*, collector_runtime_status, commissioning_jobs, audit_events, edge_nodes (compat)
```

There is **no HTTP between the three processes** in acquisition mode (see `internal-http.md`). Every
cross-process interaction goes through RabbitMQ or PostgreSQL (tables + LISTEN/NOTIFY).

| Contract | Document | Producer → consumer | Version marker | Characterization tests |
|---|---|---|---|---|
| Telemetry wire format | [obs-batch.md](obs-batch.md) | acquisition → ingestion | `schema_version=1` per observation, `envelope_version=2` per message | `apps/center/tests/contracts/test_obs_batch_golden.py` |
| PG NOTIFY channels | [notify.md](notify.md) | API / ingestion / acquisition / reset ↔ all | none on v1 payloads; `"v":2` on `latest_ids` | `test_notify_payloads.py` |
| Heartbeat / `queues_json` | [runtime-status.md](runtime-status.md) | acquisition, ingestion → API | none (free JSON) | `test_runtime_status_contract.py` |
| Connection report | [collector-report.md](collector-report.md) | acquisition → PG `connections` | none | `test_runtime_status_contract.py` |
| Config snapshot / revision | [config-revision.md](config-revision.md) | API (PG) → acquisition, ingestion | `schema_version="fx.acquisition.config.v1"` | `test_runtime_status_contract.py::test_config_revision_*` |
| Internal HTTP | [internal-http.md](internal-http.md) | none between FactoriX processes in acquisition mode; edge daemon → API (edge mode only) | URL path `/api/v1` | `test_route_table.py`, `apps/center/tests/unit/test_safety_guards.py` |
| Freshness / health / quality | [freshness.md](freshness.md) | domain rules → every surface | none | `test_freshness_matrix.py` |
| Browser push `/stream` | [live-stream.md](live-stream.md) | API → browser | frame `type` | `test_response_shapes.py` |

Versioning rules for all of the above: [ADR-018](../ADR-018-contract-versioning.md).
Who owns which table/queue/channel: [ADR-017](../ADR-017-bounded-contexts-and-ownership.md).

## Known discrepancies (index)

| Id | Contract | Summary | Owner | Test |
|---|---|---|---|---|
| CT-01 | REST | **Fixed (WS-H round 3):** the logical designs journal moved to `GET /api/v1/storage/designs/operations`; `GET /api/v1/storage/operations` is only the physical `{items,total,page,page_size}` list | WS-H | `test_route_table.py::test_no_duplicate_method_path`, `test_response_shapes.py::test_storage_operations_list_matches_the_physical_ui` (pass) |
| CT-02 | NOTIFY v1 → live cache | `_seed_live_cache` treats a missing `quality` as `GOOD` and then also records it as last-good | WS-Q / lead (`app.py`) | `test_notify_payloads.py::test_seed_live_cache_missing_quality_is_not_good` (xfail) |
| CT-03 | NOTIFY v2 | `latest_ids` path only calls `hub.dispatch`; it never refreshes the API live-state provider used by the model engine, so v2 cannot become the default | WS-Q (`app.py`) | `test_notify_payloads.py::test_v2_latest_ids_seeds_live_cache` (xfail) |
| CT-04 | NOTIFY v2 | bridge detects v2 by substring `'"signal_ids"'` instead of `v`/`kind` | Phase C6 | documented only |
| CT-05 | NOTIFY health | ingestion (edge mode only) sends each connection-health event on **both** `factorix_stream_events` and `factorix_health_changed`; the bridge listens to both → double dispatch | WS-P | documented only |
| CT-06 | NOTIFY epoch | ingestion ignores the payload epoch and fences its live provider at `cached_epoch + 1` | WS-P | documented only |
| CT-07 | Config revision | revision is derived (max entity counters / +1 on digest change) and process-local: after an acquisition restart it can go **down**; `POST /api/v1/jobs` changes mode/interval without bumping `config_revision` | lead (Phase C, `config_revision_seq`) | `test_runtime_status_contract.py::test_config_revision_monotonic_across_restart` (xfail) |
| CT-08 | AMQP topology | acquisition builds `BrokerConfig` from a private env subset but declares the full topology; queue arguments tuned through `Settings` (`FACTORIX_RABBITMQ_MAX_LENGTH_BYTES`, `..._DELIVERY_LIMIT`) are not seen by acquisition → `PRECONDITION_FAILED` risk | WS-P | `test_obs_batch_golden.py::test_acquisition_and_ingestion_declare_identical_queue_arguments` (xfail) |
| CT-09 | Settings | `BrokerConfig.from_settings` reads 5 undeclared settings with `getattr` (`rabbitmq_live_queue`, `rabbitmq_binding_pattern`, `rabbitmq_live_binding_pattern`, `rabbitmq_live_max_length_bytes`, `rabbitmq_freshness_window_s`) → their env vars are silently ignored | WS-P | `test_obs_batch_golden.py::test_broker_settings_are_declared` (xfail) |
| CT-10 | Freshness | evaluators without pipeline evidence / job-interval fallback (ingestion commit payload, `models_engine.sample_from_latest`, `data_models.signal_states` fallback, `historian_catalog._freshness`, Historian quality segments, browser fallback) disagree with the canonical verdict for slow polls and for DELAYED | Phase C1 (WS-H for Historian, WS-Q/WS-D for browser) | `test_freshness_matrix.py` (xfail cells) |
| CT-11 | Freshness | `domain/quality.freshness_status` (no caller) uses a 5 s fallback and no 12 s floor; `quality.Freshness` lacks DELAYED / NO_DATA | archival (D3) | `test_freshness_matrix.py` (xfail cells) |
| CT-12 | Freshness | `evaluate_signal_state(connection_health=...)` is accepted but ignored; `ReasonCode.CONNECTION_OFFLINE` is never produced | Phase C1 | documented only |
| CT-13 | HTTP | `/api/v1/edge-sync/*` (incl. `GET /edge-sync/secrets/{id}` which returns a decrypted secret) was mounted in acquisition mode | **fixed in A4(b)**: 410 Gone in acquisition mode | `test_safety_guards.py` |
| CT-14 | Runtime mode | image default `FACTORIX_COLLECTOR_MODE=edge` | **fixed in A4(a)** (Dockerfile); `entrypoint.sh:90` and `Settings.collector_mode` still default to `edge` (WS-P / Phase C7) | `test_safety_guards.py` |
| CT-15 | Test stack | `docker-compose.test.yml` runs `rabbitmq:4.0` and `tdengine/tdengine:3.3.6.13`; production runs `rabbitmq:4.4` and `tdengine/tsdb:3.4.3.9` | WS-P (compose) | documented only |
| CT-16 | Settings | personal mailbox as SMTP default | **fixed in A5** (`settings.py`) | — |
| CT-17 | NOTIFY / ADR | ADR-006 lists a `factorix_reset_fence` channel that no code emits or listens to | **fixed in A3** (ADR-006) | `test_notify_payloads.py::test_channel_registry_matches_code` |
| CT-18 | `queues_json` | acquisition puts MQTT per-connection counters under connection-UUID keys at the top level, next to `publisher` / `runtime`; no `schema_version` | Phase C / D4 | `test_runtime_status_contract.py` (documents shape) |
| CT-19 | `queues_json` | ingestion heartbeat row always writes `config_revision=1` and `software_version='s06-worker'` | WS-P | documented only |
| CT-20 | HTTP | `platform/broker.py::probe_broker_health` (RabbitMQ management HTTP probe, DLQ depth) has no caller; `/health/ready` and the UI therefore never see queue depth / DLQ count (plan §4.1(8)) | Phase D4 | documented only |
| CT-21 | REST text | commissioning reaper messages still say "no Edge collector picked up this test" / "The Edge collector started the test…" (`app.py::commissioning_timeout`), user-facing (U3 leftover) | lead (`app.py`) | documented only |
