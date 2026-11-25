# FactoriX inter-process contracts

Status: **descriptive (as-is, verified against code on 2026-11-18, HEAD `4fb46dc` + working tree)**; owners updated by
ARCH-C (R2-E Phase C, HEAD `87974ce` + working tree): see "Single owners" below.
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
| CT-02 | NOTIFY v1 → live cache | **Fixed (ARCH-C, C6):** a v1 event without `quality` is seeded `UNCERTAIN`, never GOOD, and never recorded as last good | ARCH-C | `test_notify_payloads.py::test_seed_live_cache_missing_quality_is_not_good` (pass) |
| CT-03 | NOTIFY v2 | **Fixed (ARCH-C, C6):** the `latest_ids` path seeds the API live cache from the rows it reads (`notify_bridge._seed_live_cache_from_rows`); v2 is now the **default** (`FACTORIX_NOTIFY_FORMAT=v1` = kill switch) | ARCH-C | `test_v2_latest_ids_seeds_live_cache`, `test_v2_bridge_feeds_every_v1_consumer`, `test_v2_is_the_default_notify_format` (pass) |
| CT-04 | NOTIFY v2 | **Fixed (ARCH-C, C6):** payloads are decoded by `v`/`kind` with `factorix_core.contracts.notify.parse_stream_events`; no substring sniffing | ARCH-C | `test_v2_payload_is_routed_by_the_bridge_and_not_by_the_v1_parser` (pass) |
| CT-05 | NOTIFY health | **Fixed (ARCH-C):** ingestion (edge mode) emits health events on `factorix_health_changed` only | ARCH-C | documented |
| CT-06 | NOTIFY epoch | **Fixed (ARCH-C):** ingestion fences its live provider at the payload's `active_epoch` (`new_epoch` read too); `cached + 1` only when the payload has none | ARCH-C | `test_ingestion_accepts_every_config_and_epoch_payload` (pass) |
| CT-07 | Config revision | **Fixed (ARCH-C):** the first load after an acquisition restart continues from the LKG revision + structure hash and never goes below the revision of the last acquisition heartbeat (`revision_floor`); `POST /api/v1/jobs` bumps `acquisition_jobs.config_revision`. A PG sequence `config_revision_seq` stays a Phase-D option | ARCH-C | `test_config_revision_monotonic_across_restart`, `test_post_jobs_bumps_the_job_config_revision` (pass) |
| CT-08 | AMQP topology | **Fixed (ARCH-C, C9):** one owner — the ingestion consumer declares the topology; acquisition builds `BrokerConfig.from_settings(BrokerSettings(), declare_topology=False)` (same `FACTORIX_RABBITMQ_*` names/defaults) and only checks the ingress exchange passively | ARCH-C | `test_acquisition_and_ingestion_declare_identical_queue_arguments`, `test_passive_publisher_never_declares_queues` (pass) |
| CT-09 | Settings | **Fixed (ARCH-C, C9):** the five broker settings are declared in `BrokerSettings` (inherited by `Settings`); `from_settings` no longer uses `getattr` defaults | ARCH-C | `test_broker_settings_are_declared` (pass) |
| CT-10 | Freshness | **Fixed (ARCH-C, C1):** every evaluator goes through `application.live.freshness_service.FreshnessService` (job-interval fallback, API pipeline evidence, DELAYED); the browser uses the server `stale_after_ms` | ARCH-C | `test_freshness_matrix.py` (all cells pass, `KNOWN_MISMATCHES` empty) |
| CT-11 | Freshness | **Fixed (ARCH-C, C1):** one `Freshness` enum and one quality enum (`domain.quality`; `signal_state.SourceQuality is Quality`); `quality.freshness_status` is a wrapper of the canonical rule | ARCH-C | `test_one_freshness_and_one_quality_enum` (pass) |
| CT-12 | Freshness | **Fixed (ARCH-C, C1):** a STALE value of a connection whose health is DEGRADED/OFFLINE has `reason_code=CONNECTION_OFFLINE` (status stays STALE; data that arrives is never degraded) | ARCH-C | `test_stale_value_of_a_degraded_connection_is_connection_offline` (pass) |
| CT-13 | HTTP | `/api/v1/edge-sync/*` (incl. `GET /edge-sync/secrets/{id}` which returns a decrypted secret) was mounted in acquisition mode | **fixed in A4(b)**: 410 Gone in acquisition mode | `test_safety_guards.py` |
| CT-14 | Runtime mode | image default `FACTORIX_COLLECTOR_MODE=edge` | **fixed in A4(a)** (Dockerfile); `entrypoint.sh:90` and `Settings.collector_mode` still default to `edge` (WS-P / Phase C7) | `test_safety_guards.py` |
| CT-15 | Test stack | `docker-compose.test.yml` runs `rabbitmq:4.0` and `tdengine/tdengine:3.3.6.13`; production runs `rabbitmq:4.4` and `tdengine/tsdb:3.4.3.9` | WS-P (compose) | documented only |
| CT-16 | Settings | personal mailbox as SMTP default | **fixed in A5** (`settings.py`) | — |
| CT-17 | NOTIFY / ADR | ADR-006 lists a `factorix_reset_fence` channel that no code emits or listens to | **fixed in A3** (ADR-006) | `test_notify_payloads.py::test_channel_registry_matches_code` |
| CT-18 | `queues_json` | acquisition puts MQTT per-connection counters under connection-UUID keys at the top level, next to `publisher` / `runtime`; no `schema_version` | Phase C / D4 | `test_runtime_status_contract.py` (documents shape) |
| CT-19 | `queues_json` | **Partly fixed (ARCH-C):** ingestion heartbeat reports `software_version` (`FACTORIX_INGESTION_VERSION`, default `ingestion-v1`); `config_revision=1` stays (ingestion has no revision of its own — readers must not use it) | ARCH-C | documented |
| CT-20 | HTTP | `platform/broker.py::probe_broker_health` (RabbitMQ management HTTP probe, DLQ depth) has no caller; `/health/ready` and the UI therefore never see queue depth / DLQ count (plan §4.1(8)) | Phase D4 | documented only |
| CT-21 | REST text | **Fixed (ARCH-C):** commissioning reaper messages say "collector" (also `web/src/lib/commissioning.ts` user texts) | ARCH-C | documented |

## Single owners (R2-E Phase C, ARCH-C)

| Concept | Owner (one place) | Everyone else |
|---|---|---|
| Freshness / effective status / stale threshold | `application/live/freshness_service.py::FreshnessService` (+ `PipelineEvidence`) over the rule in `domain/signal_state.py` | REST latest, push dispatch + sweep, Data Models, models engine (cache + PG fallback), Historian catalog / latest / gap & quality segments, ingestion payload, `/api/v1/signals` `stale_after_ms` call it; the browser renders the server verdict (`lib/format.ts::serverStaleAfterMs`, `displayFreshness`) |
| Quality / freshness vocabulary | `domain/quality.py` (`Quality`, `Freshness`) | `signal_state.SourceQuality` / `Freshness` are the same objects |
| `connections.health / last_error / last_success_at` | `application/health/health_service.py` | acquisition report, Edge report, sample evidence, Center sweep, pause/resume/archive submit evidence (`test_health_single_writer.py`) |
| History reads | `application/history/query_service.py::HistoryQueryService` | `/observations/history` (+ `order=newest`), `/observations/aggregate`, CSV export, models `value_at`; Historian and storage totals ask it whether the PG `observations` fallback (`FACTORIX_PG_TELEMETRY_FALLBACK`, unset = Edge mode only) may be read |
| NOTIFY channels + payloads | `apps/shared/src/factorix_core/contracts/notify.py` (`Channel`, `ConfigChanged`, `EpochChanged`, `HealthChanged`, `StreamEventsV1`, `LatestIdsV2`, `parse_*`) | bridge and ingestion decode with it; literals that remain must be registry values (`test_every_channel_literal_is_in_the_registry`) |
| RabbitMQ topology | ingestion consumer (`declare_telemetry_topology`) | acquisition publisher passive (`BrokerConfig.declare_topology=False`); settings in `platform/settings.py::BrokerSettings` |
