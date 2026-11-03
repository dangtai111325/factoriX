# Resource model contract — review2 work in progress

This contract is implemented in the worktree and isolated test tree. The live volume has reached the new schema, but deployment is currently waiting for Docker host recovery; see `implementation-progress.md`. Computer-use acceptance remains open.

## Identity and hierarchy

`resources.parent_id` is the canonical current CONTAINS parent. A transaction updates it together with temporal relationship history. Postgres enforces code uniqueness per `(tenant_id, parent_id)`, including null root parents and archived identities. A Site's scope UUID remains stable when its resource is renamed or moved between Enterprises. Site codes may repeat under different parents.

Create/Patch/Move take a transaction-scoped tenant model lock. Mapping creation takes the same lock, so a concurrent cross-Site Move cannot race a newly attached source. Ingestion does not acquire this lock. Patch and Move require the current version and return `RESOURCE_VERSION_CONFLICT` on stale writes.

## Additive resource API fields

`POST /api/v1/resources` accepts:

- `hierarchy_mode`: `guided` (default) or `strict`. Guided returns a `NOT_RECOMMENDED` warning for placements outside type recommendations; strict rejects those placements with `ADJACENCY`.
- `timezone`: IANA timezone, default `Asia/Ho_Chi_Minh`, used when creating a new Site scope.
- `create_edge`: false by default; available for Site resources. The Site scope, model resource, anchor and optional unenrolled Edge are created in one transaction. The optional `edge` response field identifies that Edge. Enrollment remains a separate operation.

The existing `site_id` form remains supported for legacy clients creating a Site resource for an unanchored Site scope. A second anchor is rejected. A non-Site resource inherits its scoped parent's Site; an explicit conflicting scope is rejected. An unscoped model resource is allowed with a `SITE_UNASSIGNED` warning; source mapping requires an actual Site.

`POST /resources/{id}/move` accepts the same `hierarchy_mode`. Cycles, archived parents and invalid Site boundaries are hard errors in both modes. A subtree with any open source binding cannot change physical Site scope, including paused connections or disabled bindings. The error is `SOURCE_REASSIGNMENT_REQUIRED`. Mapping-free descendants inherit the destination Site atomically and receive new versions. Nested Site anchors retain their own scope when moved between unscoped ancestors; they cannot be nested inside another physical Site.

Generic `POST /resource-relations` rejects CONTAINS writes with `USE_RESOURCE_MOVE`; business relations remain available. New future-dated hierarchy placements are explicitly rejected with `FUTURE_HIERARCHY` because no scheduler applies them. Past/current temporal history is retained. A Move cannot close its current placement at or before that placement began.

Move accepts an explicit `parent_id: null` for the root level, including Undo to a previous root placement. Strict mode recommends Enterprise at root and enforces the same rule on Create and Move; guided mode permits other root types with a warning.

Rename and Move never change MQTT topics, source addresses, shared connections or Edge Site IDs. Renaming a Site also updates the Site scope's display name and code in the same transaction.

`POST /resource-types` validates name, key, category and referenced recommendation types before saving. Duplicate keys return `DUPLICATE`. `GET /resource-types` adds real `parent_type_keys` and `child_type_keys` arrays to each type, including custom types; the frontend can use this catalog rather than a separate hardcoded placement restriction.

## Pagination

Resource pages sort by `(code, id)` and return an opaque `next_cursor` containing both values. Clients must pass it unchanged. Existing code-only cursors remain accepted for compatibility. The model frontend now drains all resource pages, including archived rows needed for Restore, and filters active rows for other model consumers. Signal/latest pagination remains a separate open follow-up.

## Archive and restore

Archive accepts an optional `{version}` body for compatibility with older callers; the current UI always supplies it. Restore requires `{version}`. Stale writes return `RESOURCE_VERSION_CONFLICT`. Archive requires all active children to be archived first. Restore requires an active parent. Configuration, identity, temporal placement, signals and latest values are retained; individual disabled bindings are not enabled by Restore.

Both actions publish updated releases for the affected Edges in the same database transaction. Release snapshots include only active resources/signals owned by the actual Edge and Site. The response's `deployments` identifies queued configuration revisions; it does not claim an Edge has already acknowledged them. Ingestion rejects late updates to archived assets, and calculated outputs on archived assets do not advance. Shared connections retain their other mappings.

## Migration and rollout

`0007_resource_identity` expands the schema, validates current temporal parents, backfills canonical parents and Site anchors, adds tenant-scoped foreign keys and sibling uniqueness, and removes tenant-wide Site-code uniqueness. Invalid legacy cycles, multiple current parents, cross-tenant hierarchy edges or ambiguous Site anchors abort the migration without guessing or discarding data.

Fresh install and upgrade are covered by real Postgres tests. Downgrade refuses duplicate Site codes that the old tenant-wide constraint cannot represent. Roll back code/schema only after assessing these identities; use the saved appliance backup when the old model cannot represent new data.

Before live deployment: finish relevant asset UI, run full tests, back up current live data/code again, apply the migration before switching the Center code, deploy the matching frontend bundle, verify the Windows host URL and perform the required computer-use journeys. No commit/push is authorized.
