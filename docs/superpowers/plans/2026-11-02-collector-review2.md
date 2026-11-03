# FactoriX collector review 2 — implementation plan

Status: ACTIVE. No commit or push without the user's explicit permission.

## Accepted product decisions

- Work on `iiot-replace-frontend` from `a9bedf1`; selectively reuse verified ideas from `a3ee1cb`, never replace the whole tree.
- Update the existing local appliance at port 8080. Destructive automated tests use a separate, explicitly disposable database inside the appliance; never truncate its live database.
- Focus: asset structure, guided flexible hierarchy, asset CRUD/import, editable per-level Layout, Graph with business relations, four read-only acquisition protocols, Edge lifecycle and correct latest values. The user's subsequently attached navigation/module discussion expands the active scope to genuine Data Models with schema/bindings/transformations/revisions/live preview; see `2026-11-02-product-modules-v2.md` for the complete supplement and additional acceptance journeys.
- Preserve the existing light FactoriX identity, inspectors and useful controls. Preserve Coming soon product modules, Revert To Zero and temporary personal SMTP defaults. The user has now explicitly approved reorganizing the sidebar: Add Data becomes contextual CTAs, Protocol Studio capabilities move into the wizard, and Live Operations functions move into Collector Signals/Diagnostics and Model Live Preview. Old links must keep working through context-preserving redirects; this supersedes preserving those individual old sidebar entries.
- One logo in the upper-left corner; remove the adjacent duplicate brand text.
- Hierarchy: all resource types visible, recommended placements, custom types, Area, guided default and strict option. Common neutral icon with readable type label.
- One MQTT connection can map fields to multiple assets in its Site. Renaming/moving an asset never changes source subscriptions implicitly.
- Site resource codes may repeat under different parents/Enterprises; selectors show full paths. Site scope identity remains its UUID.
- Import reuses existing assets at the same path/code and preserves all their existing data. Differences are shown in the preview; import never implicitly renames, moves, retypes, restores or rebinds them.
- User confirmed explicit local-appliance enrollment: a new Site only requests it when the user selects “Use this appliance for this Site”; backend must reject assigning an appliance already bound to another Site/Edge, including concurrent requests. Creating a model Site/Edge alone must not write an enrollment token.
- Cross-Site moves of assets/subtrees with source mappings are blocked until the source is explicitly reassigned; never move a shared connection implicitly.
- Archive stops only that asset's mappings, retains latest/configuration, supports Undo/Restore and leaves shared connections collecting other assets.
- Latest per topic is the acquisition policy. Coalescing is intentional; unbounded queues and silent overflow are not. Preserve null/zero/false/text, source time and last-good data.
- Monitor: latest table and at most four trends from the current session, no invented historical windows.
- Output Groups: persist Name/Scope/Members/Aliases/Format/Template; real preview and copy. Northbound publishing and Sparkplug B deferred.
- Users/RBAC/MFA/email verification/auth hardening/HTTPS/legal approval deferred. Keep existing access checks and regression-test current login/logout/CSRF/Edge ownership.
- Layout: root enterprises; full-frame auto grid; click enters children, Values opens data, leaves open data; drag/resize/snap/Undo/Redo/Fit/zoom/pan; per-level persistence.
- Capacity test target: 1,000 assets / 10,000 signals. This is a target to measure, not an unverified claim.

## Source evidence and tracking

Review source: `Downloads/user_review2/reports/FactoriX_Commercial_Release_Review_VI.md`, its CODEMAP, action log, network/API evidence and screenshot manifest. Datasource guide: `../datasource_guide.md`.

`review2-issues.md` tracks all 84 report IDs and every unnumbered table row. A finding is complete only with relevant test evidence and computer-use evidence where UI behavior is involved. Deferred items remain deferred, not fixed.

## Delivery order

- [ ] 0. Save decisions/coverage ledger and protect destructive test targets; establish test database/fixtures and evidence manifest.
- [ ] 1. Correct data contracts, commit-to-stream boundary, timestamps, null/missing/quality/freshness and pagination.
- [ ] 2. MQTT topic routing/coalescing/bounds/recovery/config replacement; capture and truthful commissioning.
- [ ] 3. Complete MQTT 3.1.1/5 auth/TLS/QoS/session/keepalive and all Modbus TCP/OPC UA/HTTP parameters through to connectors.
- [ ] 4. Asset CRUD/guided types/custom types/Area/sibling uniqueness/atomic Site creation/CSV+MQTT preview import.
- [ ] 5. Multi-asset mappings, connection Edit/Pause/Resume/Duplicate/Archive/Restore, signal lifecycle and revision acknowledgment.
- [ ] 6. Edge health/heartbeat/configuration/credential lifecycle, independently scheduled collection and bounded outbox recovery.
- [ ] 7. Catalog/Overview/Monitor/Diagnostics/Activity with real scoped counts, provenance, errors, export and notifications.
- [ ] 8. Per-level editable Layout; versioned queued saves; preserve local drafts and surface same-node conflicts.
- [ ] 9. Typed Graph, true BFS depth 1–3/filter/recenter, relation CRUD, signal inspector, zoom/layout/export.
- [ ] 10. Persistent Output Groups and true preview; publish remains unavailable.
- [ ] 11. Shared accessible controls/tokens/time formatting/offline fonts/copy/responsive shell; preserve Coming soon and one logo.
- [ ] 12. Automated regression/contract/migration/protocol/fault/load tests and computer-use E01–E24; update release documentation honestly.
- [ ] 13. Product modules v2 supplement: four active groups, context-preserving route migration, separate Connection/Job/Field/Signal responsibilities, Data Models domain and workspace, shared safe Formula Engine and additional computer-use E25–E34. Existing gates are not replaced by these additions.

## Implementation constraints

Write regression tests and observe the expected failure before changing behavior. Keep route parsing separate from domain/repository ownership. Preserve public aliases unless a compatible additive contract is needed. Secrets never appear in logs, previews, exports or evidence.

- Resource parent is canonical current hierarchy state, updated transactionally with temporal relation history. Enforce sibling code uniqueness in Postgres, including root and archived identities; stable cursor includes UUID. Migration must upgrade existing installs and preserve data.
- Source fields carry topic/address/type/timestamp/nullability/resource scope explicitly. Missing in an unrelated topic emits no observation; invalid matching data carries a reason; valid null is not a decode error.
- Capture returns topic/payload/time structurally. Commissioning validates every draft mapping, times out centrally, invalidates on configuration changes, and never disrupts a running MQTT client's identifier.
- Applied configuration replaces cached connectors when relevant configuration/secrets change; Pause/Archive closes resources. Shared mappings stop independently.
- Transaction rollback cannot emit stream events. Stream reconnect snapshots before resubscribe, carries ordering metadata and cannot block ingest on slow clients.
- Latest, lifecycle, health, freshness and asset running state remain distinct. No label parsing to determine system health.
- UI saves await server acknowledgment; data refresh cannot replace unsaved edits. Retry is bounded. Same-object edit conflicts remain visible and recoverable.
- Graph computed acquisition edges are read-only; hierarchy editing goes through Move. `INSTALLED_AT` retains its real meaning. Resource→Signal→Connection→Edge is three hops.

## Verification and acceptance

Automated suites: domain/connector tests; API+real Postgres contract tests; migration fresh+upgrade+concurrency; protocol test servers; Playwright regression; axe+keyboard; long-running collection and capacity measurements.

All four protocols are mandatory, per the user's clarification. See [protocol acceptance matrix](protocol-acceptance.md) for each configuration, fault, recovery and UI gate. MQTT success cannot substitute for Modbus TCP, OPC UA or HTTP API acceptance.

Computer-use journeys (each records action, inputs with secrets masked, expected/actual, screenshot, related issue IDs):

1. E01 empty appliance/setup/login/Overview; no fake metrics, one logo, navigation preserved.
2. E02 complete 6-line/6-machine model, reload/path/count checks.
3. E03 guided/strict/custom type/second enterprise.
4. E04 blank/Unicode/length/duplicate validation; no partial Site creation.
5. E05 Edit/Move/Undo/cycle/concurrent edit; source topics unchanged.
6. E06 CSV+36-topic MQTT preview/type assignment/dry run/import/retry.
7. E07 one wildcard MQTT connection, multiple assets and Line production mappings.
8. E08 float/int/bool/text/null/empty/zero/false/leading zeros and topic separation.
9. E09 MQTT versions/QoS/auth/TLS/mTLS/session/keepalive verified at broker.
10. E10 bad port/topic/password/CA/JSON/path and invalidated test result.
11. E11 connection Edit/Pause/Resume/Duplicate/Archive/Restore and connector replacement.
12. E12 Modbus areas/types/endianness/scaling and failed-read commissioning.
13. E13 OPC UA Browse/security/auth/read/subscribe with out-of-order notifications.
14. E14 HTTP URL/path/query/method/headers/auth and HTTP/decode/timeouts.
15. E15 Archive/Restore one asset on a shared connection; other assets unaffected.
16. E16 Catalog edit/filter/bulk/group/export and applied configuration.
17. E17 consistent Overview/Catalog/Monitor, four current-session trends, disconnect/recovery.
18. E18 Diagnostics exact Edge/Connection/Signal, stage failures and recovery.
19. E19 Layout auto 0/1/2/3/6/12 cards, drilldown/Values/breadcrumb.
20. E20 Layout drag/resize at 25/100/400%, Undo/Redo/save/publish/reload/offline/conflict.
21. E21 Graph centers/depth/filter/direction/labels/relations/inspector/export.
22. E22 Output Group save/reload/preview/copy without outbound publish.
23. E23 scope/search keyboard/notifications/Coming soon/About/logout.
24. E24 Revert cancellation/invalid confirmation; destructive confirmation only on disposable state under computer-use policy.

Viewports: 1920×1080, 1440×900, 1366×768, 768×1024, 390×844. No page overflow, focus traps/return and tree keyboard correct, no serious/critical axe findings.

Live lab MQTT: read-only subscription with a unique client ID to `192.168.2.108:18883`; never publish. Other protocol/auth/TLS/error cases use controlled test servers. Null and differing order/progress WO are valid datasource behavior.

Gates: 30-minute live topic comparison; at least 1-hour soak; independent slow-source and Center-outage recovery; no queue/memory drift; 1,000 assets/10,000 signals without silent caps. Target p95 source→Center ≤2s, Center→visible UI ≤1s, measured on recorded hardware. Failure remains open, never weakened silently.

## Completion rule

No completion claim until every in-scope report sub-item has appropriate evidence, required computer-use journeys are verified, and no P0/P1 asset/collector defect remains. Retain the deferred auth/legal/HTTPS/publishing/Storage list. No claim of full Commercial GA. No commit/push until the user authorizes it.
