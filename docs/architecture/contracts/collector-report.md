# Contract: acquisition → Center connection report (Q5)

| | |
|---|---|
| Producer | acquisition `AcquisitionRuntime.connection_report(reset=True)` every heartbeat (5 s), leader only |
| Applied by | acquisition `PgControlPlane.flush_connection_reports` → `factorix.domain.health.apply_connection_report` → `UPDATE connections SET health,last_error,last_success_at` (+ audit + `factorix_health_changed`) |
| Transport | in-process call (acquisition imports Center's `domain.health`); there is no typed wire object yet |
| Tests | `apps/center/tests/contracts/test_runtime_status_contract.py` (`test_acquisition_report_states_*`, `test_report_state_to_connection_health`) |

## 1. Report (per connection id)

```
{state, last_ok_at, last_error_code, last_error, read_ms, samples, window_s,
 reads_ok, reads_failed, jobs_total, jobs_failing, failing_since?}
```

* `state ∈ {UP, DOWN, AUTH_FAILED, RATE_LIMITED, SILENT, IDLE}` — the worst job verdict of the connection
  (severity AUTH_FAILED > DOWN > SILENT > RATE_LIMITED > UP). `IDLE` = acquisition runs no job for it.
* Hysteresis is applied in acquisition (DOWN only after no successful read for `max(3 × interval, 10 s)`
  and ≥ 2 consecutive failures). `window_s` = that evidence window.
* `last_ok_at` = newest successful read (or newest MQTT message) — ISO-8601 UTC.
* With several jobs, `last_error` becomes `"<n> of <m> jobs failing: …"`.

## 2. Mapping to `connections` (`apply_connection_report`)

| state | `health` | `last_error` |
|---|---|---|
| UP | HEALTHY | cleared |
| RATE_LIMITED | HEALTHY | rate-limit text (warning) |
| DOWN / AUTH_FAILED | DEGRADED | real error text (`"<code>: <text>"`) |
| DOWN / SILENT **with `last_ok_at` inside `window_s`** | HEALTHY | error kept as a warning |
| SILENT | DEGRADED | "Connected, but the source sends no data." (or the reported text) |
| IDLE | UNKNOWN (effective health becomes IDLE) | cleared |

Invariants: only `ACTIVE` connections change; `last_success_at` only moves forward and never into the
future; a connection marked DEGRADED by the Center "no samples" sweep is not cleared by a mere `UP` unless
`last_success_at` advanced; the call returns no update when nothing changes (no NOTIFY noise).

## 3. Other writers of `connections.health` (for the ownership map, ADR-017)

Center sweep `app.py::_evaluate_connections` (DEGRADED "No samples received for N s." for bound connections
acquisition runs nothing for, predicate re-checked in the UPDATE); `collect.py` pause / resume / archive;
`edge_sync.py` and `telemetry._mark_connections_live` (edge mode); ingestion (edge mode, recovery from the
"No samples" state). Target: one `HealthService` writer (Phase C2).

## 4. Commissioning (same channel family)

`collect` inserts `commissioning_jobs` (`PENDING`) + NOTIFY `factorix_commissioning`; acquisition claims
(`PENDING → RUNNING`, `FOR NO KEY UPDATE SKIP LOCKED`, ≤ 4 at a time, budget 25 s) and finishes
(`PASSED | FAILED | CANCELLED`, `stages_json`, `samples_json`, `error_code`, `diagnostic`); the API reaper
sets rows still `PENDING`/`RUNNING` after 30 s to `FAILED` (`error_code` `EDGE_NOT_STARTED` for PENDING —
legacy name, the text says "Collector did not start" — and `TIMEOUT` for RUNNING; the RUNNING text still says "The Edge collector …", a leftover for U3). Timeouts exist on both sides (25 s / 30 s).
