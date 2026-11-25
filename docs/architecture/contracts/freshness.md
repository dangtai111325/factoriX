# Contract: quality, freshness, effective status and health

| | |
|---|---|
| Rule owner | `factorix/domain/signal_state.py` (`evaluate_signal_state`, `classify_freshness`, `canonical_stale_after_ms`) and `factorix/domain/health.py` |
| Single evaluator | the API process (v6_contracts Q2). Ingestion's commit-time status and the browser's fallback are not authoritative |
| Tests | `apps/center/tests/contracts/test_freshness_matrix.py` (one record through every evaluator), `apps/center/tests/unit/test_signal_state.py`, `test_live_freshness.py`, `test_connection_health_windowed.py` |

## 1. Vocabulary

| Concept | Values | Where it comes from |
|---|---|---|
| **Source quality** (`quality` on the wire, `raw_quality` in the API) | `GOOD`, `UNCERTAIN`, `BAD` (+ `STALE` exists in `domain.quality.Quality` for the wire enum, never produced by acquisition) | the protocol read / decoder in acquisition |
| **Freshness** (`signal_state.Freshness`) | `FRESH`, `DELAYED`, `STALE`, `UNKNOWN`, `NO_DATA` | time since `last_acquired_at` + pipeline evidence |
| **Effective status** (`EffectiveStatus`) | `GOOD`, `UNCERTAIN`, `BAD`, `STALE`, `NO_DATA`, `DISABLED`, `PAUSED` | combination below; what the UI badges show |
| **Reason code** (`ReasonCode`) | `OK`, `DISABLED`, `NO_OBSERVATIONS`, `RAW_SOURCE_BAD`, `RAW_SOURCE_UNCERTAIN`, `NO_FRESH_ACQUISITION`, `UNVERIFIED_AFTER_RESTART`, `CONNECTION_OFFLINE` (never produced, CT-12), `CONNECTION_PAUSED`, `NULL_VALUE`, `FIELD_MISSING`, `SOURCE_CLOCK_SKEW`, `DELIVERY_DELAYED`, `DELIVERY_STALLED` | |

`domain/quality.py` also defines a second `Freshness` (`FRESH/STALE/UNKNOWN`) and `freshness_status()`; both
have no caller and are **not** the rule (CT-11).

## 2. Threshold

```
stale_after_ms = max(2 × interval_ms, 12 000)
interval_ms    = signal_definitions.expected_interval_ms  →  else acquisition_jobs.interval_ms (Q2)  →  else 1000
```

`canonical_stale_after_ms(None)` uses 1000 ms, so every evaluator that is not given the job interval
computes 12 s for a slow poll (CT-10).

## 3. Freshness verdict (`classify_freshness`)

Inputs: `last_acquired_at` (newest acquisition time Center holds for the signal), `source_ok_at`
(`connections.last_success_at`, written by acquisition), `source_reported_at` (acquisition heartbeat time),
`delivered_at` (newest acquisition time Center received for the same connection).

1. `age = now - last_acquired_at`; `age ≤ stale_after` → **FRESH**.
2. Newer data of the same connection was delivered (`delivered_at - last_acquired_at > stale_after`) → **STALE** (`NO_FRESH_ACQUISITION`: this signal's source is silent).
3. No source evidence, evidence older than `stale_after + 15 s`, or acquisition itself has no successful read within `stale_after` → **STALE**.
4. `age > max(10 × stale_after, 300 s)` → **STALE** (`DELIVERY_STALLED`).
5. Otherwise → **DELAYED** (`DELIVERY_DELAYED`, `delivery_lag_ms = age`): the value is current at the source and in transit.

## 4. Effective status (`evaluate_signal_state`, first match wins)

| # | Condition | effective_status | freshness | reason |
|---|---|---|---|---|
| 1 | binding disabled or resource archived | DISABLED | UNKNOWN | DISABLED |
| 1b | connection paused | PAUSED (last value kept) | UNKNOWN | CONNECTION_PAUSED |
| 2 | no observation | NO_DATA | NO_DATA | NO_OBSERVATIONS |
| 3 | value null, quality GOOD, field not nullable | BAD | age verdict | NULL_VALUE |
| 3b | source BAD | BAD | age verdict | raw reason or RAW_SOURCE_BAD |
| 4 | source UNCERTAIN | UNCERTAIN | age verdict | raw reason or RAW_SOURCE_UNCERTAIN |
| 5 | verdict STALE | STALE | STALE | verdict reason |
| 5b | restored from a checkpoint, not yet verified in this session | UNCERTAIN | UNKNOWN | UNVERIFIED_AFTER_RESTART |
| 5c | verdict DELAYED | **GOOD** | DELAYED | DELIVERY_DELAYED |
| 6 | otherwise | GOOD | FRESH | raw reason or OK |

A STALE / PAUSED / DELAYED signal keeps its last value (Q3, H1); only BAD / NO_DATA / DISABLED render "—".

## 5. Who evaluates (today)

| Surface | Evaluator | Evidence | Interval fallback | Matrix row |
|---|---|---|---|---|
| REST latest / Data Models / models engine (provider path) | `TDengineLiveStateProvider.evaluate_signal` | `PipelineEvidence` | signal → job | `live_provider` ✔ |
| Push dispatch + 5 s hub sweep | `live_state.refresh_live_message` | `PipelineEvidence` | job (mapping) → payload | `push_refresh` ✔ |
| Ingestion NOTIFY v1 payload | `telemetry.latest_stream_payload` | none | signal → 1000 | `ingestion_commit` ✘ (re-evaluated at dispatch, so the browser is right; the PG/NOTIFY value is not) |
| Models engine PG fallback, `data_models.signal_states` without provider, `telemetry.latest_states` without provider | `evaluate_signal_state` | none | signal → 1000 | `models_engine_pg_fallback` ✘ |
| Historian source catalog badge | `historian_catalog._freshness` (WS-H) | none, no DELAYED | signal → 1000 | `historian_catalog` ✘ |
| Historian quality segments | `historian_service` gap threshold `canonical_stale_after_ms(1000)` (12 s constant) | none | constant | not in matrix (WS-H) |
| Browser safety net | `apps/web/src/lib/format.ts::serverStaleAfterMs` (used by `store/AppContext.tsx` and `pages/08_SignalsCatalog/SignalInspector.tsx`): the server's `stale_after_ms`, else the server minimum `SERVER_MIN_STALE_AFTER_MS = 12000`; the browser never derives it from the interval | — | 1000 | not in matrix (TS) |

✘ = disagrees with the reference for at least one scenario (`xfail(strict)` cells, CT-10). Target: one
`FreshnessService.evaluate(record, evidence, now)` for every surface (Phase C1).

### 5b. Since R2-E C1 (ARCH-C): one evaluator

`application/live/freshness_service.py::FreshnessService` is the only caller of `evaluate_signal_state` /
`classify_freshness` for live surfaces. It resolves the interval (signal `expected_interval_ms` → acquisition
job `interval_ms` → API mapping → 1000 ms only when nothing is known), passes the API `PipelineEvidence`
(source_ok / reported / delivered) and the connection health (CT-12 `CONNECTION_OFFLINE`).

| Surface | Call | Matrix row |
|---|---|---|
| REST latest (cache) / Data Models / models engine (cache) | `TDengineLiveStateProvider.evaluate_signal(..., connection_id, job_interval_ms)` → `FreshnessService.evaluate` | `live_provider` ✔ |
| REST latest without cache, Data Models PG fallback | `FreshnessService.evaluate` / `evaluate_latest_row` (SQL adds `connection_id`, `job_interval_ms`) | `latest_row_pg_fallback` ✔ |
| Models engine PG fallback | `models_engine.sample_from_latest(row, freshness=...)` | `models_engine_pg_fallback` ✔ |
| Push dispatch + 5 s sweep | `Hub.refresher = FreshnessService(evidence).refresh_message` | `push_refresh` ✔ |
| Ingestion v1 payload | `latest_stream_payload(..., job_interval_ms)` (no evidence in that process: provisional, re-evaluated at dispatch) | `ingestion_commit` ✔ (as delivered) + `test_ingestion_raw_payload_agrees_without_evidence` |
| Historian catalog badge | `historian_catalog._freshness` → `FreshnessService.classify` (`NO_DATA/FRESH/DELAYED/STALE`) | `historian_catalog` ✔ |
| Historian quality segments / gap threshold | `FreshnessService.stale_after_ms(signal, expected)` (job interval via the evidence mapping) | — |
| Historian latest (`/historian/latest`) | additive `effective_status`, `freshness`, `stale_after_ms` | — |
| Signals list | additive `stale_after_ms` per signal (job-interval fallback) | — |
| Collector status `/api/v1/edges` | `FreshnessService.delayed_connections()`: a delivery stall → `effective_health=DEGRADED`, diagnostic "Data delayed N s …", `delayed_connections` (R2-02) | `test_collector_status_degrades_during_a_delivery_stall` |
| Browser | renders the server verdict; `serverStaleAfterMs()` (no interval math); `displayFreshness()` shows an expired FRESH verdict as DELAYED until the next server verdict; Overview "Data delayed", "N delayed" in signal summaries; counts wait for the first latest read (R2-18) | TS |


## 6. Health definitions

* **Process liveness**: heartbeat age ≤ 15 s (`heartbeat_fresh`) — see `runtime-status.md`.
* **Collector status** (`/api/v1/edges`, acquisition mode): `OFFLINE` (stale heartbeat) | `DEGRADED` (the row
  says DEGRADED) | `ONLINE`; `delivery_lag_ms` = worst connection lag from `PipelineEvidence`.
* **Connection health** (stored): `HEALTHY | DEGRADED | UNKNOWN` (+ status `PAUSED`/`ARCHIVED`); transitions
  in `collector-report.md`. **Effective connection health** (`effective_connection_health`): `ARCHIVED`,
  `PAUSED`, `IDLE` (no active bindings — never DEGRADED), `UNKNOWN` (collector not online or no evidence),
  else the stored value.
* **"No data" rule** (Center sweep): bound connection, collector online, no job running for it, no
  `last_success_at` advance for `max(3 × interval, 30 s)` → DEGRADED "No samples received for N s."
* **Overview pills**: `collector_status` (NONE / ONLINE / DEGRADED / NOT_ENROLLED / OFFLINE) and
  `data_collection_status` (NOT_CONFIGURED / PAUSED / IDLE / DEGRADED / PENDING / HEALTHY) in `domain/health.py`.
* **Health dimensions on a latest row** (`compute_health_dimensions`): `source_health`, `connection_health`,
  `broker_health`, `storage_health` — broker from `collector_runtime_status.broker_ok`, storage from the
  ingestion row's `queues_json.tdengine_ok`.
