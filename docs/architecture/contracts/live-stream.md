# Contract: browser push (`WS /stream`)

| | |
|---|---|
| Producer | API process: `transport/hub.py::Hub` fed by the NOTIFY bridge and by in-process after-commit events (`modules/common.queue_stream_event`) |
| Consumer | web `lib/liveStream.ts`, `store/AppContext.tsx` |
| Auth | session cookie; same-origin check (`hub.origin_allowed`) |
| Tests | `apps/center/tests/contracts/test_response_shapes.py`, `apps/center/tests/unit/test_live_freshness.py` |

## Client → server

`{"op":"subscribe","signal_ids":[…≤5000],"mode":"add"?}` · `{"op":"subscribe_models","group_ids":[…≤500]}` ·
`{"op":"subscribe_health"}` · `{"op":"ping"}`.

## Server → client frames (`type`)

| type | Shape | Notes |
|---|---|---|
| `latest` | `type, signal_id, value, quality, effective_status, reason_code, received_time, source_time` + optional `evaluated_at, stale_after_ms, freshness, delivery_lag_ms, connection_id, data_epoch, last_acquired_at, last_value_changed_at, source_health, connection_health, broker_health, storage_health` (`transport/ws/stream.py::_latest_message`) | re-evaluated at dispatch and on the 5 s sweep (`refresh_live_message` adds `age_ms`); only transitions are pushed by the sweep |
| `batch` | `{"type":"batch","messages":[…]}` | several pending frames flushed together |
| `health` | `{type:"health",entity:"connection",id,health,effective_health,last_error,last_success_at}` | coalesced per (entity, id) |
| `heartbeat` | `{type:"heartbeat",seq,server_time,pipeline?:{connection_id:{source_ok_at,delivered_at,delivery_lag_ms}}}` every 5 s | client treats > 15 s without any frame as "push not live" and polls REST |
| `resync` | `{type:"resync",reason}` | after the NOTIFY bridge reconnects: refetch |
| `model_body`, `model_event` | payload of the Data Model engine, routed by `group_id` | `model_body` coalesced per group |
| `telemetry_reset` | sent by the reset saga | client clears its live cache |
| `subscribed`, `subscribed_models`, `subscribed_health`, `pong`, `error` | control replies (`subscribed` carries `count, rejected, heartbeat_s`) | |

Coalescing (`hub.coalesce_key`): newest `latest` per signal, newest `model_body` per group, newest `health`
per entity, one `heartbeat`; `model_event` is never coalesced; when a socket buffer exceeds 5000 pending
frames the oldest is dropped (counted).

Rules: new fields are additive; the browser must ignore unknown `type`s and keys; `freshness` is
authoritative when present (`freshness.md`).
