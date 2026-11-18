# Contract: PostgreSQL LISTEN/NOTIFY channels

| | |
|---|---|
| Transport | `SELECT pg_notify(channel, payload)` inside the producing transaction (delivered on COMMIT only); payload JSON text < 8000 bytes (PostgreSQL limit) |
| Delivery | at-most-once, no replay. Every listener therefore also **polls** (acquisition config every 10 s, ingestion catalog every 30 s / epoch every 2 s, API live state from PG) and wakes all loops on (re)connect; the API bridge sends a `resync` frame to every browser after a reconnect |
| Tests | `apps/center/tests/contracts/test_notify_payloads.py` (`test_channel_registry_matches_code` scans the source for producers/listeners) |

There are exactly **five** channels. (ADR-006 used to list `factorix_reset_fence`; no code emits or
listens to it — CT-17, ADR corrected.)

| Channel | Producers (module) | Listeners | Payload | Listener semantics |
|---|---|---|---|---|
| `factorix_config_changed` | `collect._notify_config_changed`; `storage_designs` (×4); `telemetry_reset` (R1, R5); `transport/app.py` `POST /api/v1/jobs` (×2) | acquisition `PgNotifyListener` (wake-up only, payload ignored); ingestion `_on_pg_notify` | `{"tenant_id": "<uuid>"}`; storage designs add `kind, design_id, version`; reset sends the epoch payload below | acquisition: re-read the whole snapshot (`config-revision.md`); ingestion: invalidate that tenant's catalog (payload without a valid `tenant_id` → invalidate all tenants) |
| `factorix_epoch_changed` | `telemetry_reset` (R1 `RESETTING`, R5 `ACTIVE`) | acquisition (wake-up epoch + config loops); ingestion (invalidate catalog + recording state + dedup LRU of the tenant); API bridge (fence the live cache) | `{"tenant_id","previous_epoch","active_epoch","new_epoch","lifecycle_state","operation_id","kind"}` — `active_epoch == new_epoch` (two names, both kept for compatibility) | API reads `active_epoch` (falls back to `new_epoch`). Ingestion ignores the number and fences its own live provider at `cached_epoch + 1` (CT-06); its catalog reload (≤ 2 s) restores the real epoch |
| `factorix_stream_events` | ingestion `commit_batch_metadata` | API `_pg_notify_bridge_loop` | **v1** (default): `{"events":[event,…]}`; **v2** (`FACTORIX_NOTIFY_FORMAT=v2`): `{"v":2,"kind":"latest_ids",…}` | see §1 / §2 |
| `factorix_health_changed` | acquisition `pg_control.flush_connection_reports` (only when `health` or `last_error` changed); ingestion (edge mode only, connection recovered) | API bridge | `{"tenant_id","event":{type:"health",entity:"connection",id,health,effective_health,last_error,last_success_at}}` | parsed to `{kind:"health",tenant_id,payload:event}`; `last_success_at` also feeds `PipelineEvidence.note_source` |
| `factorix_commissioning` | `collect` (capture request, commission/test request) | acquisition (wake the commands loop, payload ignored; it claims `PENDING` rows with `FOR NO KEY UPDATE SKIP LOCKED`) | `{"job_id","connection_id"}` | — |

## 1. `factorix_stream_events` v1 (default)

```
{"events":[{"kind":"latest","tenant_id","signal_id","resource_id","value_type","unit","event_uid",
            "source_sequence","config_revision","origin",
            "payload":{"type":"latest","signal_id","value","quality","effective_status","reason_code",
                       "received_time","source_time","evaluated_at","stale_after_ms","data_epoch",
                       "last_acquired_at","last_value_changed_at"}}, …]}
```

* Packed by `ingestion_worker._emit_chunked_notify`: ≤ 64 events and ≤ 7800 bytes per NOTIFY, order kept.
  An event whose encoding alone exceeds 7900 bytes is sent without `payload.value` (the value stays
  readable through REST).
* Only signals whose `latest_signal_state` row actually advanced in the committed transaction are sent.
* `payload.effective_status` is computed at commit time **without** pipeline evidence and is not trusted for
  freshness: the API re-evaluates at dispatch (`live_state.refresh_live_message`, see `freshness.md`).
* Consumer: `hub.parse_pg_notify_events` keeps items that have `kind` and `tenant_id`; the bridge seeds the
  API live cache from `latest` items (`_seed_live_cache`, CT-02), notes health evidence and dispatches.

## 2. `factorix_stream_events` v2 (`latest_ids`)

```
{"v":2,"kind":"latest_ids","tenant_id":"<uuid>","max_acquired_at":"<iso ms>","connection_ids":[≤32],"signal_ids":[…]}
```

* Built by `ingestion_worker._latest_ids_payloads`, each payload < 7800 bytes (~190 ids), as many NOTIFYs
  as needed; `connection_ids` is capped at 32 per payload; `max_acquired_at` / `connection_ids` are optional.
* The bridge recognises v2 by the substring `'"signal_ids"'` (CT-04), notes delivery evidence for the listed
  connections, coalesces bursts per tenant and reads the rows itself (`telemetry.latest_states`, 200 ids per
  query), then dispatches. **It does not seed the API live cache** (CT-03), which is why v1 stays the default.
* A v2 payload is never mistaken for v1 (`parse_pg_notify_events` returns `[]` for it).

## 3. Rules

* Channel names are frozen (they are runtime resources, like queue names).
* Every new payload carries `"v": N` and `"kind"`; listeners must ignore unknown kinds and unknown keys,
  and must survive malformed JSON (all current listeners do).
* A payload must be built with `json.dumps`, never by string formatting (`app.py` `POST /api/v1/jobs` still
  uses an f-string; harmless for a UUID, but it is the pattern to remove in Phase C6).

## Known discrepancies

CT-02, CT-03, CT-04, CT-05 (ingestion edge mode emits each health event on two channels; the bridge
listens to both, so the browser may receive it twice), CT-06, CT-17 — see README.
