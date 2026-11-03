# Resource import contract

Status: backend implemented/tested and deployed to the live Center in checkpoint 61547; not connected to an importer UI yet. Actual Edge topic capture and computer-use E06 remain pending.

`POST /api/v1/resources/import` remains authenticated and CSRF-protected. Existing CSV-style `rows`, `site_id` and default `dry_run=true` remain supported. Rows may also contain typed JSON properties/tags and a numeric physical `source_row`.

Requests accept `default_parent_id`, `hierarchy_mode` (`guided` or `strict`) and `plan_hash`. Rows are limited to 1–2,000 and their compact UTF-8 JSON representation to 2 MB. This DTO limit does not replace a streaming HTTP request-body limit.

Identity is the full current path of sibling codes. `path`, `parent_path` and tenant-scoped `parent_id` are unambiguous references; contradictory references are errors. Legacy `parent_code` is accepted only if unique across existing and imported identities. File ordering does not determine parent ordering. Archived identities remain reserved and require explicit Restore outside import.

Preview runs without model writes. A successful response retains `dry_run`, `accepted`, `created` and adds `reused`, `items`, `warnings` and `plan_hash`. Each item carries its original row/index, action (`CREATE`/`REUSE`), full path, parent reference, Site effects, proposed/retained metadata and existing identity/version where applicable. Incoming differences on reused resources appear in `differences` and `EXISTING_VALUES_KEPT` warnings. Existing name, description, properties, tags, UUID, version and update time remain unchanged.

Invalid rows return 422 `IMPORT_INVALID`, with `error.row_errors`, `error.warnings` and partial diagnostic `error.items`. No rows are written. A commit (`dry_run=false`) requires a preview hash; omission returns 409 `PREVIEW_REQUIRED`.

Commit recomputes the tenant snapshot and plan while holding the same transaction lock as resource mutations. Material changes that alter a plan which still creates resources return 409 `IMPORT_STALE`; the client must review again. Unrelated model changes do not invalidate a plan. If every row now resolves to `REUSE`, an earlier hash may be safely retried as a no-op, because no resource is changed. This supports lost-response retry and simultaneous requests without duplicate creation.

All creates, Site scopes/anchors and audit records commit together or roll back together. New Site scope UUIDs flow to their imported descendants. No source address/topic is changed; no Edge or enrollment token is implicitly created. Completed responses include confirmed IDs and created/reused counts. Clients must await the response before showing success and retain the draft on failure.

Verification: `apps/center/tests/integration/test_resource_import_api.py` uses real HTTP transaction handling and isolated Postgres, with pure planning and DTO tests in `apps/center/tests/unit/`. Actual CSV/MQTT browser acceptance remains required by E06.
