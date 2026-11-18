# ADR-018: Contract versioning for everything that crosses a process boundary

- **Status:** Accepted (v6, 2026-11-18). (R2-E called this "ADR-017"; see the numbering note in ADR-017.)
- **Scope:** AMQP telemetry messages, PostgreSQL NOTIFY payloads, heartbeat rows (`queues_json`), the connection report,
  the acquisition config snapshot, WebSocket `/stream` frames, REST responses used by the web client.
- **Related:** `contracts/*.md` (what each contract is today), ADR-017 (who owns it), ADR-005 / ADR-011 (idempotency).

## Context

Acquisition, ingestion and the API are separate processes that are restarted independently, and two of the
contracts outlive a process: RabbitMQ queues and the acquisition SQLite spool can hold messages written by the
previous build for hours. Today only the telemetry wire format is versioned (`schema_version=1`,
`envelope_version=2`); NOTIFY payloads are distinguished by sniffing a substring, and `queues_json` has no version.

## Decision

1. **Version markers.** Every cross-process payload carries an explicit version:
   - AMQP observation: `schema_version` (today 1); AMQP envelope: `envelope_version` + header `x-envelope` (today `obs-batch.v2`).
   - NOTIFY: `"v": N` and `"kind"` in every new payload. Existing v1 payloads without `v` are "version 1" by definition.
   - Heartbeat: `queues_json.schema_version` when the first breaking change is made (absent = 1).
   - Config snapshot: `schema_version` string (today `fx.acquisition.config.v1`).
   - WebSocket frames: `type`; REST: the URL prefix `/api/v1`.
2. **What needs a new version.** Adding an optional key never does. Removing a key, renaming it, changing its type,
   unit or meaning, or making an optional key mandatory does.
3. **N / N-1 rule.** A consumer must accept version N and N-1 for at least one release before a producer emits N
   by default. The producer switch is an environment kill switch so a rollback needs no rebuild
   (precedents: `FACTORIX_PUBLISH_ENVELOPE=single|batch`, `FACTORIX_NOTIFY_FORMAT=v1|v2`).
4. **Durable backlog.** For AMQP the N-1 window is "until the queues and every spool are drained of N-1", not one
   release; the consumer keeps decoding v1 single messages until then.
5. **Frozen runtime resources.** Queue, exchange, binding, channel, table and column names, and quorum-queue
   arguments are never changed in place (a changed argument fails every declare with `PRECONDITION_FAILED`). A change
   means a new resource plus a migration step, documented in its own ADR.
6. **Readers are tolerant.** Unknown keys and unknown `kind` / `type` values are ignored; malformed payloads are
   dropped with a log line, never crash a listener.
7. **Characterization first.** Each contract has golden or shape tests under `apps/center/tests/contracts/`. A change
   to a golden file or a route snapshot must be deliberate (see each test's docstring) and is reviewed as a contract
   change. Known gaps are `xfail(strict=True)` with a `CT-nn` reason; fixing the gap flips the test and forces the
   doc update in the same change.

## Consequences

- `FACTORIX_NOTIFY_FORMAT=v2` can become the default only after CT-03 is fixed (the API live cache must be refreshed
  on the v2 path) and the bridge parses by `v`/`kind` instead of a substring (CT-04).
- The first change of a `queues_json` key that any reader uses must introduce `schema_version`.
- A future `CanonicalObservation` v2 needs ingestion support for v1 **and** v2 deployed before any acquisition emits v2.
