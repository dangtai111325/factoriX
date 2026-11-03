# Asset import implementation plan

Goal: close the import portion of CR-F10/E06 with real CSV and captured MQTT topics, without changing existing source addresses or silently overwriting the model.

The appliance is available on 8080. CSV computer-use verifies stale preview, preservation and acknowledged retry. Actual Edge MQTT capture received 36 lab topics/56 messages, generated 16 nodes (6 Lines/6 Machines), retained raw prefixes after root editing and committed 0 Create/16 Reuse against the QA model. Capture cancellation and over-broad-filter rejection were also observed. Hierarchy presets and complete fault/limit journeys remain pending; CR-F10/E06 is not complete. See `resource-import-contract.md` and `implementation-progress.md` for evidence and limits.

## Contract and files

- `apps/web/src/features/assets/importing.ts`: bounded CSV parsing, physical source-row diagnostics, MQTT topic-to-hierarchy proposals. No network writes or broker publishing.
- `apps/center/src/factorix/domain/resource_import.py`: pure, deterministic planning against a supplied model/type/scope snapshot, independent of SQL and HTTP.
- `apps/center/src/factorix/modules/resource_import.py`: tenant-scoped snapshot read, preview hashing, atomic application under the model lock, calls existing resource creation to preserve Site invariants and audit behavior.
- `resources.ImportIn` and the existing `/resources/import` route retain compatible fields and add unambiguous path/ID references and a preview hash. Legacy `parent_code` is accepted only when uniquely resolvable.
- `apps/web/src/components/modals/ImportResourcesModal.tsx`: staged CSV/MQTT source selection, type assignment, editable proposal, server validation, final import and truthful result.
- Real topic capture uses Edge commands and the chosen MQTT connection; never subscribe from Center or publish to the lab. Capture plumbing and fault cases must be verified with the commissioning/capture work, not replaced by a pasted-topic demo.

## Independent parser/proposal step

- [ ] CSV UTF-8/BOM, comma/semicolon/tab delimiters, quoted delimiters, escaped quotes and multiline descriptions.
- [ ] Reject malformed quoting, inconsistent field counts, duplicate/unknown columns, empty files and over-limit files/rows. Preserve text such as leading-zero codes and formula-like names as text.
- [ ] CSV path/type/name with optional code, parent path/ID/code, description, typed properties/tags, timezone and Site scope. Show exact row diagnostics.
- [ ] MQTT configurable namespace prefix skip and per-level type assignment, including custom types.
- [ ] Strip configurable data suffixes longest-first. In the provided ASSY profile, `production/order` and `production/order_progress` belong to the Line; they must never create a fake Machine named production.
- [ ] Deduplicate actual topic prefixes while preserving their exact spelling separately from display names/resource codes. Detect slug/truncation collisions; require explicit edits rather than merging.
- [ ] The supplied 36-topic guide proposes exactly 16 model nodes: Enterprise, Site, Plant, Zone, six Lines and six Machines.

## Server planner and commit

- [ ] Resolve all parents before writing; support children appearing before parents in the file.
- [ ] Full-path identity permits the same code under different parents, including repeated Site codes under Enterprises. Archived identities remain reserved and must not be silently restored.
- [ ] Validate types, names/codes, typed metadata, duplicate paths, ambiguous parent codes, missing parents, cycles, Site scope and guided/strict recommendations in the preview.
- [ ] Resolve explicit parent IDs within the tenant only; reject contradictory references and path/code mismatches.
- [ ] User confirmed: reuse existing identities and preserve their current name/metadata. Preview exposes differences. Do not rename, move, retype, restore or rebind existing assets as a side effect of import.
- [ ] Preview is read-only and includes per-row action/warnings/errors plus a deterministic plan hash. Commit recomputes the plan under the transaction model lock, rejects stale material changes and either applies all rows or none.
- [ ] Retrying an already-matching import must not create duplicates. Do not infer success from a toast; return confirmed created/reused IDs/counts.
- [ ] New Site scopes/anchors are created atomically; optional Edge creation must be explicit and must not issue enrollment tokens automatically during preview/import.

## UI and acceptance

- [ ] CSV template/download/upload; matching column documentation; errors linked to source rows. No native alert/confirm dialogs.
- [ ] MQTT connection/filter/capture status with actual topic count, cancellation/timeout/error; no capture data fabricated from the guide.
- [ ] Type mapping and editable code/display name; recalculate descendants after an ancestor's code changes. Exact source topic prefixes stay unchanged.
- [ ] Preview lists Create/Reuse (and Update only if approved), Site effects and errors. Any edit invalidates the previous server preview.
- [ ] Import awaits server acknowledgment, retains the draft on failure and offers safe retry without duplicate creation.
- [ ] Pure parser/planner regressions, real Postgres dry-run/atomicity/retry/tenant/concurrency tests, real Edge capture tests, and computer-use E06 CSV plus the 36-topic lab case.
- [ ] Save action log/screenshots and update CR-F10/related unnumbered rows only after the actual journeys pass. Keep the larger plan active and do not commit/push.
