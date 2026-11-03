# Navigation v2 implementation — NM01–NM10 / E25–E26

User explicitly prioritized synchronizing this navigation before resuming collector fixes. Review2 remains the release checklist. No backend module/data deletion and no commit/push.

| Product location | Canonical URL | Existing capability preserved |
|---|---|---|
| Overview | /overview | Existing overview |
| Factory Model / Hierarchy Structure | /factory/structure | Hierarchy editor/import/inspector |
| Factory Model / Layout Designer | /factory/layout | Existing layout controls |
| Factory Model / Knowledge Graph | /factory/graph | Existing graph |
| Data Collector / Connections | /collector/connections | Connection list/profile/tests |
| Data Collector / Signals / Catalog | /collector/signals | Signal catalog/inspector |
| Data Collector / Signals / Live Monitor | /collector/signals/live | Latest values, filters, session trends/export/freeze |
| Data Collector / Edge Collectors | /collector/edges | Enrollment/heartbeat/revisions/assignment guard |
| Data Collector / Diagnostics / Sources | /collector/diagnostics | Source diagnostics |
| Data Collector / Diagnostics / Activity | /collector/diagnostics/activity | Operational activity |
| Contextual Add Data action | /collector/add-data | Existing shared wizard, resource/connection/protocol query context |
| Data Models / Model Catalog | /models | Truthful entry retaining Output Groups during model-domain implementation |
| Data Models / Output Groups | /models/output-groups | Existing groups and configuration, not relabelled ModelDefinitions |
| Shared Formula Editor entry | /models/formulas | Existing planned calculated entry until real shared editor is implemented |

Every old /acquisition/*, /signals*, /live/* and /storage deep link gets an explicit context-preserving replacement. Protocol Studio aliases open the shared wizard with protocol selected. Unknown context parameters and hashes survive. Internal links use canonical paths; no new independent Add Data/Studio/Live Operations sidebar entry.

Six collapsible future modules: Dashboards, Historian & Storage, Alarms & Events, Analytics, Reports, Administration. Descriptions state intended capabilities; they do not claim a historian, scheduler, RBAC or alarm engine is active.

Model Catalog initially exposes the retained real Output Groups plus honest upcoming workspace information, as specified by the supplement's transition sequence. Schema/bindings/transforms/validation/revisions and real Model Designer/Live Preview still require the model-domain implementation; navigation alone cannot close NM28–NM57 or E27–E34.

Checks: pure route/query/hash contracts and sidebar render/active/collapse assertions; production typecheck/build; CUA main/legacy navigation, tab consolidation, contextual actions, future modules, keyboard and responsive drawer. Keep E25/E26 open until all required scope/collector/model behaviors are verified.
