# ADR-019: Dashboard Studio — a read-side context that stores metadata only

- **Status:** Accepted (v6, 2026-11-25).
- **Scope:** Center API `application/dashboards/`, routes `/api/v1/dashboards/*`, tables `dashboards`,
  `dashboard_revisions`, `dashboard_templates` (migration `0013_dashboard_studio`), the web Studio/runtime.
- **Related:** `contracts/dashboard.md` (the API and document schema v1), ADR-017 (ownership), ADR-018 (contract
  versioning), ADR-016 (model-field recording), ADR-004 (live state and freshness).

## Context

Users need to compose their own monitoring screens: many dashboards, free layout, many widget types, themes,
templates, versions. The platform already owns every piece of data such a screen can show — Data Collector
signals (live state + operational history in TDengine) and Data Model fields (live bodies + recordings or
recent snapshots) — and already has one read path for each: the `/stream` WebSocket for live values and the
Historian (`historian_service.query_historian`, `POST /api/v1/historian/query`) for history, with its limits
(20 series, 5000 points, 366 days), fidelity and coverage notes.

The pre-Studio implementation was a single module with a free-form `{"widgets": [...]}` draft, a fixed type
list, signal-only bindings checked one SQL query per binding, and no revision content beyond the widget list.

## Decision

1. **Read-side bounded context.** Dashboards are read-only views. The context owns `dashboards`,
   `dashboard_revisions` and `dashboard_templates` and nothing else; it reads signals, models, resources and
   storage bindings through queries of their tables (read-only) and the existing read models
   (`historian_catalog.sources_by_machine`, `storage_bindings` helpers). It never writes to another context's
   tables, never adds a consumer, queue, recorder or TDengine object, and has no command or write path to devices.
2. **Sources are only signals and model fields.** A binding source is `signal` (id), `model_field` (model id +
   exact leaf path) or `signal_key` (the ACTIVE signal with exactly that key on the resource selected by a
   dashboard variable). There is no URL, SQL, table, TDengine or script source kind, and no way to add one
   through the document (unknown keys and kinds are rejected).
3. **Metadata + resolution, no query facade.** The backend stores and validates documents and resolves source
   references to the server-issued Historian tokens (`POST /resolve`, batched, ≤ 400 refs, exact, tenant-scoped).
   The browser then calls the Historian and subscribes to `/stream` itself. A dashboard query facade was
   rejected: it would duplicate the Historian's planning, limits and fidelity rules (a second history API that
   drifts), add a hop and a second place to secure, and buy nothing — the Historian already takes tokens,
   enforces the caps and reports fidelity, and the live stream already fans out per signal/model.
4. **Capabilities are computed by the backend** from the same switches the Historian uses (history provider
   configured, `pg_fallback_enabled()`, managed recordings, ACTIVE model-field storage bindings) and returned
   with every source (`latest`, `live`, `historical`, `history_modes`, `fidelity`, `notes`). The browser never
   guesses whether history exists.
5. **Registry-driven validation.** `registry.py` declares every widget type (sizes, binding counts, roles,
   accepted value kinds, history need) and every option (type, default, range, choices, length, nullability,
   visibility). The API validates options with it — unknown keys rejected, missing keys filled from defaults —
   and the Studio renders its inspector from `GET /widget-types`, so the two cannot drift. A unit test parses
   the widget table of the contract and compares it with the registry.
6. **Two validation levels.** Structural validation (shape, bounds, ids, layout, limits, option specs) guards
   every write: a draft with structural errors is rejected (422 `VALIDATION`). Publish additionally requires
   completeness (minimum bindings, required roles, link targets) and that every binding resolves and *fits*
   its widget (value kind, history availability, recorded mode) — 422 `PUBLISH_BLOCKED`. Drafts may be
   incomplete; published revisions may not.
7. **Versioning.** The draft is stored normalized (schema v1). Every mutation is optimistic on `version`
   (checked, then a `WHERE version = :expected` UPDATE). Publish appends an immutable revision with the full
   document (`document_json`) and still writes `breakpoints_json` / `widget_configs_json` for older readers;
   restore copies a revision into the draft; nothing ever updates or deletes a revision. Create, update,
   publish, restore, archive/unarchive, permanent delete (archived dashboards only), duplicate, import and template changes are audited.
8. **Forward-only, data-safe migration.** `0013_dashboard_studio` only adds nullable/defaulted columns and a new
   table. Legacy drafts are upgraded on read (deterministically, so widget ids are stable); revisions without
   `document_json` are rebuilt from `widget_configs_json` on read.
9. **Templates use data roles.** Built-in templates (machine overview, process trends, line status board,
   energy monitoring) contain no identifiers, keys or customer data; the user maps every role to a source when
   creating a dashboard. Nothing is matched by name. Tenant templates are saved from a dashboard (each distinct
   source becomes a role).

### Deliberate simplifications versus the product plan

- **Transformations** are limited to the binding display transform (`scale`, `offset`), the reductions of
  `value_mode` (min/max/avg/sum/count/first/delta over bounded Historian points), value/range mappings and
  thresholds. No expression language, joins or user formulas (Data Models are the place for derived values).
- **Variables** are resource selectors only, used by `signal_key` bindings. Model fields have no shared key
  across machines (each machine has its own model), so a variable cannot re-target a model field; such
  dashboards bind fields explicitly or use one dashboard per model.
- **No process diagram / SVG canvas, no custom JavaScript, no iframe** in this release. Images are embedded
  raster data URLs (no SVG, no remote URL); Markdown links are restricted to http(s) and internal paths.
- **Themes** are three presets plus a few per-dashboard token overrides (accent, canvas, surface, text, radius,
  gap, font scale); there is no theme table and no arbitrary CSS.
- **No widget templates and no dashboard folders**; the 40-widget cap and the Historian caps are unchanged.

## Consequences

- The Dashboard context depends on the Historian and live-stream contracts but does not extend them; a change
  of Historian tokens or limits is a contract change for dashboards too (`limits` are served from the
  Historian constants).
- Adding a widget type or option is a registry change plus a contract-table row; the registry test fails if
  the two disagree. Removing or retyping an option is a breaking change of document schema v1 (ADR-018):
  it needs `schema_version` 2 and an upgrade step like `upgrade_document()`.
- Publishing can be blocked by changes elsewhere (a signal archived, a model field removed); that is intended:
  `validate` shows exactly which binding broke, and published revisions keep rendering with per-binding
  errors in the runtime rather than silently showing other data.
- Ownership map (ADR-017): context *Dashboards*, process API, owns `dashboards, dashboard_revisions,
  dashboard_templates`; public interface `application/dashboards/service.py` and `/api/v1/dashboards/*`.
