# Contract: telemetry wire format on RabbitMQ (`obs-batch`)

| | |
|---|---|
| Producer | acquisition `ObservationPublisher` → `platform/broker.py::RabbitMQPublisher` (also the SQLite spool replay) |
| Consumer | ingestion `modules/ingestion_worker.py::IngestionWorker` (two lanes) |
| Code | `domain/canonical.py` (`CanonicalObservation`, `encode_observation_batch`, `decode_observation_batch`), `platform/broker.py` (`build_envelopes`, `_batch_envelope`, `_single_envelope`, `declare_telemetry_topology`) |
| Versions | observation `schema_version = 1` (`CANONICAL_SCHEMA_VERSION`); envelope `envelope_version = 2` (`OBS_BATCH_ENVELOPE_VERSION`) |
| Tests | `apps/center/tests/contracts/test_obs_batch_golden.py` (golden bytes in `apps/center/tests/contracts/golden/`) |

## 1. Topology (declared by **both** publisher and consumer, same function)

| Object | Name (default) | Type / arguments |
|---|---|---|
| ingress exchange | `factorix.telemetry.ingress` | **topic**, durable |
| live queue | `factorix.telemetry.live.q` (unless `FACTORIX_RABBITMQ_LIVE_QUEUE` is set: derived from the ingest queue name, `*.ingest.q*` → `*.live.q*`, so every topology has its own live queue) | quorum; bound `telemetry.live.v1.*`; `x-overflow=reject-publish`, `x-max-length-bytes=256 MiB`, `x-delivery-limit=5`, DLX at-least-once |
| replay ("legacy") queue | `factorix.telemetry.ingest.q` | quorum; bound `telemetry.v1.*`; same arguments with `x-max-length-bytes=512 MiB` |
| DLX / DLQ | `factorix.telemetry.dlx` (direct) → `factorix.telemetry.dlq` | quorum, routing key `dlq`, `reject-publish`, 256 MiB |

Changing any queue argument of an existing queue makes the declare fail with `PRECONDITION_FAILED`: queue
arguments are **frozen** (ADR-018). See CT-08: acquisition builds its `BrokerConfig` from its own env
subset (`FACTORIX_RABBITMQ_{URL,MGMT_URL,EXCHANGE,QUEUE,DLX,DLQ,CONFIRM_TIMEOUT_S,PUBLISHER_MAX_INFLIGHT}`), so
`FACTORIX_RABBITMQ_MAX_LENGTH_BYTES` / `..._DELIVERY_LIMIT` set for the API/ingestion `Settings` are not
seen by acquisition, which declares the same queues with the dataclass defaults.

**Since R2-E C9 (ARCH-C), one owner:** the ingestion consumer declares the topology. Acquisition builds
`BrokerConfig.from_settings(BrokerSettings(), declare_topology=False)` — the same `FACTORIX_RABBITMQ_*` section
(`platform/settings.py::BrokerSettings`, inherited by `Settings`, CT-09) — and its publisher only runs a
**passive** declare of the ingress exchange (`broker.passive_ingress_exchange`). Until ingestion has declared
the topology the publisher reports "RabbitMQ topology is not provisioned yet" and the samples stay in the spool.

## 2. Routing (lane decision at publish time)

`age = now - acquired_at`; `0 <= age <= 12 s` (`BrokerConfig.freshness_window_s`, publisher
`DEFAULT_FRESHNESS_WINDOW_S`) → routing key `telemetry.live.v1.<tenant hex>` (live lane), otherwise
`telemetry.v1.<tenant hex>` (replay lane, called `legacy` in code and metrics). Ingestion derives the lane
from the queue it consumed (or, for the single-consumer path, from the routing-key prefix).

## 3. Message framing

### v2 batch envelope (default, `FACTORIX_PUBLISH_ENVELOPE=batch`)

* `content_type = application/vnd.factorix.obs-batch+json`, persistent, `mandatory=True`, publisher confirms.
* `message_id = fxb-<32 hex>` (= `batch_id`).
* headers: `x-envelope: obs-batch.v2`, `x-tenant-id`, `x-data-epoch` (epoch of the first item), `x-observation-count`.
* body (compact JSON, UTF-8, key order fixed — the first 30 bytes are `{"schema":"factorix.obs-batch"`, which
  ingestion uses to recognise a header-less envelope re-published from the DLQ):

```json
{"schema":"factorix.obs-batch","envelope_version":2,"batch_id":"fxb-…","tenant_id":"<uuid>",
 "created_at":"<ISO-8601 UTC, Z>","count":N,"observations":[<v1 observation, compact>, …]}
```

* One envelope = one tenant × one lane, ≤ `FACTORIX_PUBLISH_BATCH_MAX_OBS` (500) items and
  ≤ `FACTORIX_PUBLISH_BATCH_MAX_BYTES` (192 KiB). The consumer accepts ≤ 5000 items and ≤ 4 MiB
  (`MAX_BATCH_ITEMS`, `MAX_BATCH_MESSAGE_BYTES`); bigger → quarantine + DEAD_LETTER.
* Shell validation only (`decode_observation_batch`): wrong `schema` / empty list / `count` mismatch →
  `INVALID_BATCH`; `envelope_version != 2` → `UNSUPPORTED_ENVELOPE_VERSION`. Items are validated one by one;
  a bad item is quarantined and never poisons its neighbours.
* Both encoders (`encode_observation_batch` and the publisher's pre-encoded splice) produce the same item
  encoding (`to_compact_dict`: null members and `keepalive=false` omitted). `created_at` formatting differs
  slightly (`_fmt_utc_us` vs `isoformat()`); consumers must parse it as ISO-8601, not compare strings.

### v1 single observation (kill switch `FACTORIX_PUBLISH_ENVELOPE=single`, spool backlog)

* `content_type = application/json`, `message_id = event_uid`, body = `CanonicalObservation.to_json_bytes()`
  (all members, nulls included).
* headers: `x-schema-version`, `x-data-epoch`, `x-config-revision`, `x-tenant-id`, `x-signal-id`, `x-value-type`,
  `x-source-sequence` (when present). Ingestion limit 256 KiB per v1 message.

## 4. Observation (schema_version 1)

Keys, in wire order: `schema_version, data_epoch, config_revision, event_uid, tenant_id, site_id,
connection_id, acquisition_job_id, source_field_id, signal_id, resource_id, source_time, acquired_at,
ingested_at, value_type, value, unit, quality, quality_reason, origin, provenance, correlation_id,
source_sequence, keepalive`.

* `event_uid = "fx-<epoch>-" + sha256("1|epoch|tenant|connection|source_field|signal|acquired_us|seq")[:32]`
  (`derive_event_uid`) — the idempotency key end to end.
* `value_type ∈ {bool,int64,float64,string,enum,json}`; `quality ∈ {GOOD,UNCERTAIN,BAD,STALE}`;
  `origin ∈ {LIVE,REPLAYED,MANUAL,TEST,DERIVED,CALCULATED}`; times are UTC ISO-8601 with microseconds and `Z`.
* `provenance` is credential-free (URL user-info and secret-looking keys redacted at construction).
* `data_epoch >= 1`, `config_revision >= 1`. Items of an older epoch are fenced (dropped) by ingestion.

## 5. Compatibility rule in force

The consumer accepts N (v2 envelope) and N-1 (v1 single); the publisher can be switched back to v1 by env.
Anything that changes the meaning of a v1 observation key needs `schema_version = 2` and a release in which
ingestion accepts both (ADR-018).

## Known discrepancies

CT-08 (queue arguments from two config sources), CT-09 (`from_settings` reads undeclared settings — the env
vars `FACTORIX_RABBITMQ_LIVE_QUEUE`, `..._BINDING_PATTERN`, `..._LIVE_BINDING_PATTERN`,
`..._LIVE_MAX_LENGTH_BYTES`, `..._FRESHNESS_WINDOW_S` are silently ignored), CT-15 (test stack versions).
