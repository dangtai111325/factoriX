# FactoriX product modules v2 — approved scope supplement

Status: ACTIVE / implementation incomplete. Supplements the collector review2 plan and its 84 numbered plus unnumbered findings; does not replace any acceptance gate. No commit/push. Continue using the current branch and localhost:8080, protect live data, and verify actual user journeys with computer use.

## Source and decisions

User supplied and requested all proposals in `C:/Users/Ave-T14-001/.codex/attachments/0e076182-2c53-405c-a058-d6b77282239b/Văn bản đã dán.txt` (36,525 bytes), read in full. It contains a product/module review of the earlier branch, not runtime acceptance evidence. Current worktree and running appliance remain authoritative for implementation status.

The new active product scope is Overview, Factory Model, Data Collector and Data Models. Dashboards, Historian & Storage, Alarms & Events, Analytics, Reports and Administration remain Coming soon; their existing backend schemas/APIs are preserved. The previous decision to show the old Protocol Studio/Add Data/Live Operations sidebar entries is superseded by this explicit navigation proposal. Useful capabilities and old deep links must survive their move.

Existing latest-only collection policy remains: do not begin retaining every source sample or JSON output merely because the architecture describes future storage layers. Northbound MQTT/API publishing, Sparkplug B, RBAC/MFA/email verification/HTTPS/legal expansion remain deferred. No external dispatch or API-key success claims before those features actually exist.

User additionally confirmed the Live Preview failure policy: retain the most recent good value when an input is BAD or STALE, show explicit per-field quality and clocks plus aggregate model state, and show No Data when no good value has ever existed. Never synthesize zero/GOOD, and preserve valid explicit null/false/zero as distinct from missing data. Carry this policy into schema/evaluation/API and E32 tests.

Model Designer and Live Preview will be tabs in a versioned model workspace with reopenable URLs. Model Catalog is the single sidebar entry for Data Models. Add Data/Create Model are creation actions. Do not rename Output Groups and declare a Data Model domain complete.

## Complete proposal-to-work mapping

All IDs below are pending until evidence is recorded. Some underlying code exists; that is not acceptance.

| ID | Concrete required behavior | Owner / implementation boundary | Acceptance evidence |
|---|---|---|---|
| NM01 | Four clear active groups, with Overview having no unnecessary child nav | Sidebar and route configuration | E25 + responsive screenshots |
| NM02 | Factory Model: Hierarchy Structure, Layout Designer, Knowledge Graph | Existing factory pages; preserve inspectors/controls | E02–E06/E19–E21/E25 |
| NM03 | Collector: Connections, Signals, Edge Collectors, Diagnostics | Existing acquisition/signal/Edge/diagnostics owners | E07–E18/E25 |
| NM04 | Data Models sidebar leads to Model Catalog; workspace tabs Overview, Design, Live Preview, Versions | New model routes and workspace | E27–E32 |
| NM05 | Add Data CTAs on Signals, Connection Detail and Resource Detail open one wizard with selected context | Shared wizard URL/state | E26 |
| NM06 | Create Model is a Catalog action; saved model/draft URLs reopen correctly | Model Catalog/workspace | E27/E31 |
| NM07 | Remove old independent Add Data/Protocol Studio/Live Operations nav without dropping capabilities | Sidebar, wizard, Signals and Diagnostics tabs | E25/E26/E33 |
| NM08 | Preserve old routes, query context, selected resource and scope while redirecting | Route adapters and AppContext | E25/E33 |
| NM09 | Keep all six future modules, add Analytics, rename Storage, and allow Planned Modules to collapse | Sidebar/ComingSoonPage | E23/E25 |
| NM10 | Future module descriptions include the proposed libraries/builders/policies/rules/workspaces/settings, without functional placeholders pretending to work | Coming soon content | E23/E25 |
| NM11 | Overview scope explicitly Entire System / Site / Plant | Scope owner + overview API/state | E17/E25 |
| NM12 | Resource/plant/machine/connection/Edge/signal/throughput/ingest/model counts use exactly the selected scope and truthful health | Overview/backend aggregates | E17/E18/E27 |
| NM13 | Resource Inspector shows stable UUID, current path, namespace/context preview and related signals | Hierarchy inspector/domain path helpers | E02/E05/E26 |
| NM14 | Layout drag changes placement only, never resource topology | Layout owner | E19/E20 |
| NM15 | Graph uses actual resource relations and signal bindings; no arbitrary connection slices | Graph API/BFS/typed edges | E21 |
| NM16 | Connections are real endpoint/auth/TLS/session profiles, distinct from a protocol definition | Connection contract/API/form | E09–E14/E26 |
| NM17 | Acquisition jobs own subscriptions/polling/sampling/schedules; fields own addresses/JSONPath/decode/scale | Existing Job/SourceField/Mapping domain | Protocol matrix + E07/E12–E14 |
| NM18 | One MQTT subscription can supply many signals and assets without redundant subscriptions | MQTT job + stable field routing | E07/E08/E30 |
| NM19 | Modbus profile vs register/type/order/scale/group settings remain clear and complete | Modbus profile/job/fields | E12 |
| NM20 | OPC profile vs Browse/NodeId/read/subscribe/sampling/publishing remain clear and complete | OPC connector + Discover UI | E13 |
| NM21 | MQTT broker/session/auth/TLS vs subscriptions and per-field JSON mapping remain clear | MQTT profile/job/mapper | E07–E10 |
| NM22 | HTTP base URL/auth/common headers vs path/query/method/poll/response mapping remain clear | HTTP profile/job/mapper | E14 |
| NM23 | Collector Signals includes catalog, canonical bindings, units/types/context, latest values, quality, provenance, export and current-session live trends | Signal API + Catalog/Monitor consolidation | E08/E16/E17 |
| NM24 | Edge stays an independent runtime/identity with enrollment, heartbeat, desired/active revisions, outbox and deployment health | Edge owner; rename UI to Edge Collectors | E09–E15/E18/E33 |
| NM25 | Explicit local-appliance opt-in and persistent guard prevent silent reassignment, including simultaneous requests | Site form + appliance enrollment owner | Appliance API/fault tests + E03/E26 |
| NM26 | OPC Browser, MQTT/HTTP JSON Mapper, Modbus bulk register editor are functional wizard capabilities rather than duplicate Studio implementations | Reused/refactored wizard components | E12–E14/E26 |
| NM27 | Diagnostics tabs include source tests, acquisition/quality failures and operational activity; future administrative audit remains distinct | Diagnostics/activity APIs/UI | E18/E25 |
| NM28 | ModelDefinition has stable identity, description, resource scope and lifecycle | New model domain/API/schema | Model API/tenant/migration tests + E27 |
| NM29 | ModelSchema supports typed output structure, required/null semantics and nested objects | Server schema/validation owner | E28 |
| NM30 | ModelFieldBindings refer to stable signal IDs and explicitly supported model dependencies | Model revision bindings/dependency index | E28/E30 |
| NM31 | Designer adds/removes fields, objects, aliases, sources and calculations, with nested live JSON preview | Model editor | E28/E29 |
| NM32 | Transformations normalize/map/calculate/filter with documented deterministic semantics and no secret/raw-connector configuration in models | Shared backend transformation/evaluation owner | E29 + type/error tests |
| NM33 | Validation and quality policy are separate from whether data is currently available | Model validation/live evaluation | E28/E32 |
| NM34 | Draft, validated, active and previous revisions are distinct; activation/deactivation and previous revision restore are explicit | Model revision/deployment owner | E31 |
| NM35 | ModelLiveState is truthful structured output with per-input/output quality, source/receive clocks, staleness and dependency/mapping errors | Server evaluation + Live Preview | E29/E32 |
| NM36 | One signal can feed many models; rename cannot break bindings; hierarchy move cannot change IDs | Stable-ID dependencies | E30 |
| NM37 | Catalog shows scope, input count, schema/lifecycle/version and actual live state; search/filter/create/template/duplicate/edit | Model Catalog | E27/E31 |
| NM38 | Templates and duplicates produce independent drafts without rewriting sources or activating themselves | Model create/duplicate/template use cases | E27/E31 |
| NM39 | Reuse the existing Formula Engine: validation, bind/dependency/cycle rules, preview, publish and ingest evaluation | Formula domain/API + shared editor | E29/E30/E33 |
| NM40 | Remove JavaScript Function/eval evaluation of user formulas from frontend; safe server preview is authoritative | Calculated editor conversion | E29 + security/type tests |
| NM41 | Add Data Custom Rule opens the shared Formula Editor; creating a derived signal registers a stable identity | Shared Formula Editor/action | E26/E29 |
| NM42 | Preserve existing Output Groups, repair scope/members/aliases/format/template persistence, use backend preview | Legacy group owner + migration/adapter | E22/E33 |
| NM43 | No simulated Test Dispatch; actual preview/copy works and publishing remains unavailable | Model/group Outputs UI | E22/E29 |
| NM44 | Migrate/reuse useful group configuration as model projections without losing legacy APIs/configuration or silently changing meaning | Migration/compatibility adapters | Fresh/upgrade tests + E33 |
| NM45 | Keep raw/canonical/model-output concepts separate; future storage policies are optional, with no automatic full JSON snapshot history | Collector/model/storage contracts | Contract tests + E33 |
| NM46 | Existing observations/latest/dedup/quarantine/history/aggregation/retention/export/dashboard APIs survive UI reorganization | Existing backend owners | Full regression suite + E33 |
| NM47 | Future Dashboards consume signals/models instead of opening protocol connections from widgets | Future-module contract/content | Design review + E25 |
| NM48 | Diagnostics technical failures remain distinct from future industrial/business alarms | Domain labels/event categorization | E18/E25 |
| NM49 | Shared destination credentials may later live in Admin Integrations; per-model destinations/topics belong to model workspace | Deferred OutputDestination contract | Design review + E25/E29 |
| NM50 | No second Formula Engine, parallel source config UI or model that reads PLC/broker directly | Dependency/import checks + full flow | E26/E29/E33 |
| NM51 | Restart/reconnect preserves model definitions/versions/bindings and recovers truthful live values | Persistence/recovery owners | E32/E33 + soak |
| NM52 | Model errors and disconnected inputs never manufacture GOOD/Healthy output | Model quality policy | E32 + controlled protocol failures |
| NM53 | Auth/CSRF/tenant isolation and masked evidence continue across new model/APIs/routes | Existing security boundaries | E34 + API denied-path tests |
| NM54 | Responsive, keyboard-accessible navigation/forms/editors; common time display; no fake metrics | Shared UI system | All agreed viewports + axe/keyboard |
| NM55 | Derived signal output type/nullability is explicit and matches formula results; do not hard-code every derived output as float64 | Formula contracts/ingest | E29/E30 + typed formula regressions |
| NM56 | Editing a published formula draft leaves the active expression/dependencies evaluating until explicit activation of the validated replacement | Formula revision/activation owner | E29/E31/E33 + active/draft API tests |
| NM57 | Group/model projection distinguishes valid explicit null from missing input, computes freshness and applies the agreed last-good policy honestly | Projection/quality owner | E22/E28/E32 |

Additional current-source evidence: `collect.FormulaIn`/formula draft saving writes the current formula row and dependencies and sets it to DRAFT; its calculated signal creation currently uses float64. `preview_output_group` tests `raw is None` for missing/omit and does not yet implement the new model freshness/last-good policy. These findings require regression tests and fixes; existence of the APIs is not evidence that the new model lifecycle is complete.

## Domain and API design tasks before UI relabeling

1. Document the existing Connection → AcquisitionJob → SourceField/Mapping → Canonical Signal boundary, including all four protocols. Keep existing IDs/public API aliases; additive changes must have consumer tests.
2. Define a genuine ModelDefinition/ModelRevision/Schema/FieldBinding/Transformation/Validation/LiveState contract and dependency representation. Logical concepts need clear owners; they do not each require a table. Immutable activated revisions, optimistic draft editing, stable IDs, cycle detection, deterministic evaluation and tenant isolation are mandatory.
3. Use server schema validation and the existing formula engine. Specify null vs missing, required fields, arrays if supported, coercion, rounding, filters, source clock, last-good/stale/quality propagation and partial-output policy before implementation. Never silently claim unsupported schema keywords work.
4. Source observations and model outputs are different contracts. Model evaluation reads canonical signals/explicit model references, not connection credentials or raw OT addresses. Derived-signal creation uses the shared formula pipeline and stable UUIDs.
5. Plan an upgrade preserving existing Output Groups and their APIs. Preserve the old configuration while creating/linking model projections only when meaning is equivalent; add explicit diagnostics for unsupported legacy configuration rather than dropping it.
6. Define pending/deferred OutputDestination semantics without enabling any publish side effects or API-key transmission. Keep existing historian/dashboard/retention APIs available; do not enable storage modules as a navigation side effect.

## Delivery sequence and affected files

- Finish the explicit appliance enrollment guard immediately; it affects real collector ownership. Add transactional persistence, after-commit delivery/retry and API/status checks. Existing local credentials must be recognized without printing or rotating them.
- Finish the asset CSV/MQTT importer and actual capture, preserving its accepted reuse rule. This remains part of E06 and the original review ledger.
- Write the module contract/route migration map using `App.tsx`, `Sidebar.tsx`, `AppContext.tsx`, the existing wizard/Catalog/Monitor/Diagnostics/Activity pages, Output Groups and Formula APIs as evidence.
- Implement routing/nav consolidation with context-preserving aliases, functional contextual CTAs and truthful future-module descriptions. Preserve existing functionality during the transition; Model Catalog must expose retained legacy groups until real model migration/workspace is available.
- Complete four-protocol collector lifecycle and wizard discovery/mapping, independent scheduling/outbox/stream recovery, all remaining original review items, Layout and Graph. The new navigation must not conceal those unfinished responsibilities.
- Build the model backend, migrations, evaluator and shared Formula Editor, then Catalog and workspace tabs. Add model integration/quality/concurrency/migration regressions before UI acceptance.
- Execute original E01–E24 plus E25–E34 with computer use, record screenshots/actions, run load/fault/live comparison/soak and reconcile both requirement ledgers. Report limitations honestly; no GA/perfection claim based on unit tests.

## Additional end-to-end computer-use journeys

| Journey | Required path and checks |
|---|---|
| E25 | New sidebar and every legacy deep link; Entire System/Site/Plant scope; selected resource survives navigation; six future modules; all agreed viewports and keyboard. |
| E26 | Create factory/Edge, create connection separately, contextual Add Data from Resource/Connection/Signals, shared Discover/Mapper/Custom Rule; explicit appliance checkbox and reassignment denial. |
| E27 | Create a real model from scratch/template, scope it, inspect Catalog status/count/version, duplicate to an independent draft, reopen by URL. |
| E28 | Add nested objects, signal aliases and typed/nullable/required fields; invalid schema/missing dependencies expose actionable paths and prevent activation. |
| E29 | Shared Formula Editor previews and publishes safely, model transforms produce real nested JSON, metadata/quality/clocks are visible, copy works, no outbound dispatch occurs. |
| E30 | One MQTT subscription supplies many canonical signals; one signal feeds multiple models; signal rename and hierarchy Move preserve dependencies/IDs; model/derived cycles are rejected. |
| E31 | Edit draft while polling, conflicting second editor, validate/activate/deactivate, view revisions and explicitly restore a previous revision without losing the working configuration. |
| E32 | Disconnect/slow/malformed source, explicit null vs missing, stale/last-good output, recovery and restart; invalid/disconnected inputs cannot become GOOD. |
| E33 | Complete plant → Edge → Connection → Add Data → observation → Model → live JSON flow, then restart/reconnect; verify legacy Output Groups, commissioning, formula execution, historian ingestion and deferred publishing/storage boundaries. |
| E34 | New model/appliance/capture/API tenant/auth/CSRF denied paths; no credentials in UI errors/exports/screenshots/logs; read-only lab behavior preserved. |

The old E22 still verifies all Output Group settings/persistence/backend preview/copy; moving it into Data Models does not cancel that gate. E17's current-session trends move into Collector Signals and remain required. All original four-protocol cases, 30-minute lab comparison, one-hour soak, 1,000 assets/10,000 signals and latency targets remain in force; include active models in those measurements.
