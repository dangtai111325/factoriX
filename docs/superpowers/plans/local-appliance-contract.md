# Explicit local appliance enrollment

User decision: Site creation must not automatically enroll the local appliance. An unchecked “Use this appliance for this Site” option explicitly requests enrollment. An existing assignment to another Edge/Site must be blocked, including two simultaneous requests.

## Owners and contract

- Site/resource creation remains an atomic model operation that can create an unenrolled Edge. The frontend only calls the separate appliance request after the resource creation response when the user opted in. Enrollment errors are reported separately from a successfully created Site; they must not invite a duplicate create.
- `GET /api/v1/appliance` is authenticated and read-only. It returns `enabled`, `available`, state and owning Edge/Site IDs only when owned by the authenticated tenant. It never returns a credential, token or ciphertext. Unreadable identity files fail closed.
- `POST /api/v1/edges/{edge_id}/appliance` retains authentication, CSRF and tenant ownership checks. A PostgreSQL transaction lock serializes claims for the single local appliance across tenants. A durable `appliance_bindings` row pins the Edge identity before token delivery; different assignments return 409 `APPLIANCE_ASSIGNED`.
- Existing local credential files and legacy pending tokens are recognized. A matching active credential is idempotently acknowledged as `already_enrolled`, without rotating it. An enrolled remote Edge cannot have its credential silently replaced. Unknown/inconsistent local identity fails closed.
- A pending token is stored encrypted with the existing instance data key. A private after-commit effect publishes it atomically with restricted file permissions; secret effects never enter WebSocket events. Rollback discards both private effects and public events, including on reused sessions.
- The POST acknowledges a durable request as `pending`; it does not claim the Edge is enrolled. Delivery/heartbeat establish later state. A failed file delivery leaves a recoverable request; retry for the same Edge reuses its live token. Expired requests can issue a replacement only for the assigned Edge. Lost delivery or expiry never makes the appliance available to another Site.
- Site selectors in Edge Collectors use actual Site resources and full model paths. They must not take the first machine sharing `site_id` as the Site name. The UI disables reassignment and shows the current appliance state; backend guards remain authoritative if UI state is stale.

## States

| State | Meaning |
|---|---|
| DISABLED | This instance does not expose local appliance enrollment. |
| AVAILABLE | No local credential, live legacy token or durable assignment exists. |
| BOUND | The local credential identifies an enrolled Edge. |
| QUEUED | A live token is available to the waiting local agent. |
| DELIVERY_PENDING | The assignment/token committed, but delivery has not completed; retry the same Edge. |
| EXPIRED | The assigned Edge's pending token expired; retry that Edge explicitly. |
| CREDENTIAL_MISSING | An assigned/enrolled Edge lacks its local credential file; ordinary enrollment must not rotate it implicitly. |
| CONFLICT | Local files and database identity disagree or cannot be recognized; no implicit replacement. |

## Rollout and acceptance

Migration `0008_local_appliance` adds a table without modifying existing resources, Edge credentials or data. Existing credentials are inspected without being printed. Back up the live DB/code before deploying. The port-repair fallback must recognize the new revision graph if the replacement commits the migration; preserve the old migration scripts before extending that graph. Never downgrade the live data to restore a host-port mapping.

Focused tests cover explicit/default behavior, concurrent requests, existing credentials, legacy tokens, durable delivery retry, expiry, rollback, CSRF, tenant privacy and isolated reset retaining migrations. The full suite and actual computer-use Site/Edge checks remain required before closing NM25/E26. Live Revert To Zero is never part of these automated tests; only `factorix_test` and temporary test files may be reset.

Detachment/reassignment is deliberately not automatic. An explicit future reassignment workflow must account for active mappings, outbox/configuration and the original Edge identity; this fix does not delete a credential to force reassignment.
