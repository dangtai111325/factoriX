# Contract: Dashboard Studio (`/api/v1/dashboards/*`, document schema v1)

| | |
|---|---|
| Owner | `application/dashboards/` (Center API) — read-side context, see ADR-019 |
| Consumers | web `features/dashboard/*`, `pages/15_Dashboards/*` |
| Auth | session cookie, `Depends(admin)` like every other navigation; tenant always from the principal |
| Tests | `apps/center/tests/unit/test_dashboard_*.py`, `apps/center/tests/contracts/golden/routes.txt` |

Dashboards are **read-only views** over data FactoriX already owns: Data Collector **signals** and Data
Model **fields**. A dashboard never connects to an external URL/database, never runs SQL or scripts,
never writes to a device and never adds a pipeline: live values come from the existing live stream
(`/stream`), history from the existing Historian (`POST /api/v1/historian/query`). The Dashboard
backend stores metadata (PostgreSQL) and resolves/validates source references.

## 1. Document schema v1 (`dashboards.draft_json`, `dashboard_revisions.document_json`)

All keys are snake_case. Unknown keys are rejected (422). Strings are bounded.

```jsonc
{
  "schema_version": 1,
  "settings": {
    "theme": {
      "preset": "factorix_light",          // factorix_light | control_room_dark | industrial_neutral
      "accent": null,                      // "#RRGGBB" | null  (override of the preset token)
      "canvas": null, "surface": null, "text": null,
      "radius": 12,                        // 0..24 px
      "gap": 12,                           // 4..32 px (grid margin)
      "font_scale": 1.0                    // 0.8..1.4
    },
    "time_range": { "kind": "relative", "last": "1h" },
    //            | { "kind": "absolute", "start": "2026-11-25T00:00:00Z", "end": "2026-11-25T08:00:00Z" }
    //  last ∈ 5m 15m 30m 1h 3h 6h 12h 24h 2d 7d 30d
    "refresh": "live",                     // live | 10s | 30s | 1m | 5m | off  (history re-query cadence)
    "row_height": 40                       // 24..96 px
  },
  "variables": [
    { "id": "machine", "label": "Machine", "type": "resource",
      "resource_type": "machine",          // resource type key filter | null = any resource
      "default": "<resource uuid>" }      // | null
  ],
  "widgets": [ /* ≤ 40, see §2 */ ]
}
```

A legacy draft (`{"widgets":[...]}` written before v1, no `schema_version`) is upgraded on read by
`documents.upgrade_document()` (deterministic, so widget ids are stable across reads); widgets and their
bindings are kept, unknown legacy widget types become `text` quoting their legacy configuration, a legacy
widget with more sources than its v1 type accepts becomes a `latest_table`. The notes are returned in
`upgrade_notes` (detail) / as `LEGACY_UPGRADED` warnings (validate). Variables: at most 10 per document.

## 2. Widget

```jsonc
{
  "id": "w_3f9a1c",                        // ^[a-z0-9_]{3,40}$, unique in the document
  "type": "kpi",                           // registry key (§4)
  "version": 1,
  "title": "Spindle speed",                // ≤ 120
  "layout": {
    "lg": { "x": 0, "y": 0, "w": 3, "h": 3 },   // 12 columns, required
    "md": { "x": 0, "y": 0, "w": 3, "h": 3 },   // 6 columns, optional (null = derived from lg)
    "sm": { "x": 0, "y": 0, "w": 1, "h": 3 }    // 1 column, optional (null = stacked in lg order)
  },
  "hidden": { "lg": false, "md": false, "sm": false },
  "time": { "mode": "dashboard" },         // | { "mode": "custom", "range": <time_range> }
  "bindings": [ /* §3, count bounded by the registry */ ],
  "options": { /* only keys declared by the registry for this type (§4) */ }
}
```

Layout rules: integers, `x ≥ 0`, `0 ≤ y ≤ 2000`, `w ≥ min(min_w, columns)` (so every widget fits the
1-column `sm` grid), `h ≥ min_h`, `x + w ≤ columns`, `h ≤ 40`. `hidden`, `time`, `title`, `version` (= 1),
`bindings` and `options` may be omitted (defaults); the stored draft is always the normalized document.

## 3. Binding (source reference)

```jsonc
{
  "id": "b_1",                             // unique inside the widget
  "role": "value",                         // only for widgets that declare roles (§4); else omitted
  "source": { "kind": "signal", "signal_id": "<uuid>" },
  //      | { "kind": "model_field", "model_id": "<uuid>", "field_path": "spindle/speed" }
  //      | { "kind": "signal_key", "variable": "machine", "key": "speed_1" }
  //        (the ACTIVE signal with that key on the resource selected in the variable;
  //         resolution is exact on (resource_id, key) — never by display name)
  "label": null,                           // ≤ 120, null = source label
  "color": null,                           // "#RRGGBB" | null = theme palette by position
  "unit": null,                            // ≤ 24, display override
  "scale": 1, "offset": 0                  // numeric display transform v' = v × scale + offset
}
```

Only these three kinds exist. There is no URL, SQL, table or script kind. Inside a saved *template*
the source is `{ "kind": "role", "role": "<role id>" }` until the template is instantiated; a draft may
keep such a placeholder (an unmapped required template role): it never resolves (`UNBOUND`) and blocks
publishing.

`field_path` is the Data Model leaf path exactly as listed by `GET /sources` (`field_path`): segments
separated by `/` (JSON-pointer escaping: `~1` = `/`, `~0` = `~`), a leading `/` is ignored; containers
(objects/arrays) are not bindable. Binding ids match `^[A-Za-z0-9_-]{1,40}$`, variable and role ids
`^[a-z][a-z0-9_]{0,39}$`. `scale`/`offset` are finite numbers.

## 4. Widget registry (`GET /api/v1/dashboards/widget-types`)

The backend registry (`application/dashboards/registry.py`) is the single source of truth: the API
validates `options` with it and the Studio renders the inspector from it. Each entry:

```jsonc
{ "type": "kpi", "version": 1, "label": "Value", "category": "value", "description": "…",
  "icon": "gauge",                          // lucide icon name
  "default_size": {"w": 3, "h": 3}, "min_size": {"w": 2, "h": 2},
  "data": { "min_bindings": 1, "max_bindings": 1,
            "value_kinds": ["number"],      // accepted kinds: number | boolean | string | any (any = everything);
                                            // the first entry is the preferred kind for the source picker
            "history": "optional",          // none | optional | required
            "roles": null },                // or [{"id":"actual","label":"Actual","required":true,"max":1}, …]
  "options": [ /* OptionSpec */ ] }
```

`OptionSpec` = `{ key, label, group, type, default, nullable, min?, max?, choices?, max_length?, help?, show_if? }`
with `group ∈ general | data | display | thresholds | style` and
`type ∈ boolean | integer | number | string | text | color | enum | thresholds | mappings | image | dashboard_ref | page_ref | resource_ref | variable_ref`.
`show_if` = `{ "key": "<other option>", "in": [values] }` (inspector visibility only; validation still
applies to every key).

Composite option values:

* `thresholds`: ≤ 10 × `{ "value": number, "color": "#RRGGBB", "label": string ≤ 40 }` — a value ≥
  `value` takes that color (highest matching threshold wins); below every threshold → base color.
  Two thresholds may not have the same `value`; `label` defaults to `""`.
* `mappings`: ≤ 30 × `{ "kind": "value", "value": string ≤ 80, "label": string ≤ 40, "color": "#RRGGBB" }`
  or `{ "kind": "range", "from": number|null, "to": number|null, "label", "color" }` (from ≤ v < to).
  Value matching compares the string form (`true`/`false` for booleans). `label` defaults to `""`, `color`
  may be `null` (= keep the widget color); for a range `from < to` when both are set.
* `image`: `data:image/(png|jpeg|webp|gif);base64,…` ≤ 400 000 chars (no SVG, no remote URL); the base64
  must decode and the bytes must match the declared format.
* `text` (`content`): Markdown link targets must be `http(s)://…`, an internal path `/…` or `#…`.
* `dashboard_ref` / `resource_ref`: a UUID (checked to exist in the tenant at validate/publish);
  `variable_ref`: the id of a variable of the same document.
* `page_ref`: one of `overview, factory_structure, factory_graph, connections, signals, models, storage, historian`.

**Common options (every type):** `show_title` (boolean, true, general), `description` (string ≤ 300,
general), `background` (enum inherit|transparent|custom, style), `background_color` (color, style,
show_if background=custom), `accent_color` (color|null, style), `border` (boolean, true, style),
`padding` (enum compact|normal|roomy = normal, style), `title_align` (enum left|center = left, style).

**Common data-widget options** (every type with `max_bindings > 0`): `decimals` (integer 0..8 or
null = auto, display), `show_quality` (boolean, true, display).

| type | category | bindings / roles | history | type-specific options (key = default) |
|---|---|---|---|---|
| `kpi` | value | 1, number/any | optional | `value_mode`=latest (latest min max avg sum count delta first) · `prefix`="" · `suffix`="" · `show_unit`=true · `compact`=false · `sparkline`=false · `color_mode`=value (value background none) · `font_size`=lg (sm md lg xl) · `icon`=none (none activity gauge thermometer zap droplet fan cpu factory) · `null_text`="—" · `thresholds`=[] |
| `gauge` | value | 1, number | none | `variant`=radial (radial semicircle horizontal vertical) · `min`=0 · `max`=100 · `target`=null · `show_value`=true · `show_ticks`=true · `thresholds`=[] |
| `progress` | value | roles actual (req) + target (opt), number | none | `target_value`=100 (used without a target binding) · `min`=0 · `direction`=horizontal (horizontal vertical) · `show_percent`=true · `show_values`=true · `thresholds`=[] (on percent) |
| `status` | status | 1, any | none | `variant`=pill (led pill tile text) · `mappings`=[] · `show_raw`=false · `show_time`=true · `unknown_label`="Unknown" · `unknown_color`="#94A3B8" · `blink`=off (off slow) |
| `timeseries` | trend | 1..20, number | required | `variant`=line (line area step bar) · `smooth`=false · `show_points`=false · `stack`=false · `legend`=bottom (top bottom right hidden) · `legend_values`=none (none last minmaxavg) · `y_min`=null · `y_max`=null · `split_axes_by_unit`=true · `thresholds`=[] · `live_append`=true · `history_mode`=operational (operational recorded) · `resolution`=auto (auto raw) · `max_points`=1500 (100..5000) · `quality_marks`=true · `zoom`=true |
| `state_timeline` | trend | 1..10, any | required | `mappings`=[] · `show_values`=true · `history_mode`=operational · `max_points`=1500 |
| `bar` | compare | 1..20, number | optional | `value_mode`=latest · `orientation`=vertical (vertical horizontal) · `sort`=none (none asc desc) · `show_labels`=true · `y_min`=null · `y_max`=null · `thresholds`=[] |
| `pie` | compare | 1..12, number | optional | `value_mode`=latest · `doughnut`=true · `inner_radius`=55 (0..90) · `label`=percent (percent value name none) · `legend`=right (right bottom hidden) · `show_total`=true |
| `histogram` | distribution | 1, number | required | `bin_count`=0 (0 = auto, 0..100) · `show_mean`=true · `show_median`=false · `history_mode`=operational · `max_points`=1500 |
| `scatter` | distribution | roles x (req) + y (req), number | required | `pair_tolerance_ms`=1000 (0..600000) · `point_size`=6 (2..20) · `x_min` `x_max` `y_min` `y_max`=null · `history_mode`=operational · `max_points`=1500 |
| `latest_table` | table | 1..50, any | none | `show_resource`=true · `show_unit`=true · `show_quality`=true (common) · `show_freshness`=true · `show_time`=true · `sort`=none (none label value) · `density`=normal (compact normal) · `thresholds`=[] · `mappings`=[] |
| `history_table` | table | 1..10, any | required | `page_size`=25 (10..200) · `order`=newest (newest oldest) · `history_mode`=operational · `max_points`=1500 |
| `equipment` | industrial | roles status (opt) + value ×0..6, any | none | `resource_source`=fixed (fixed variable) · `resource_id`=null (resource_ref) · `variable`=null (variable_ref) · `mappings`=[] · `show_time`=true · `layout`=standard (compact standard) · `link_dashboard_id`=null (dashboard_ref) |
| `text` | content | 0 | none | `content`="" (text ≤ 10000, Markdown subset: headings, bold, italic, lists, `code`, links to http(s) or internal paths) · `font_size`=md (sm md lg xl) · `align`=left (left center right) · `text_color`=null |
| `image` | content | 0 | none | `image_data`=null (image) · `fit`=contain (contain cover fill) · `alt`="" |
| `divider` | content | 0 | none | `label`="" · `orientation`=horizontal (horizontal vertical) · `thickness`=1 (1..8) · `line_style`=solid (solid dashed) · `color`=null |
| `link` | content | 0 | none | `target_type`=dashboard (dashboard page) · `dashboard_id`=null (dashboard_ref) · `page`=overview (page_ref) · `label`="Open" · `carry_variables`=true · `style`=button (button card text) |

Sizes (lg grid units, row height 40 px): kpi 3×3 (min 2×2) · gauge 3×4 (2×3) · progress 3×2 (2×2) ·
status 3×2 (2×2) · timeseries 6×6 (3×4) · state_timeline 6×4 (3×3) · bar 4×5 (3×3) · pie 4×5 (3×4) ·
histogram 4×5 (3×3) · scatter 4×5 (3×4) · latest_table 4×6 (3×3) · history_table 6×6 (3×4) ·
equipment 3×4 (2×3) · text 4×2 (1×1) · image 3×3 (1×1) · divider 12×1 (1×1) · link 2×1 (1×1).

`value_mode` other than `latest` (and `sparkline`) reads the widget time range from the Historian; the
reduction (min/max/avg/sum/count/first/delta = last − first) is computed over the returned points and
labelled with the Historian fidelity/notes (a downsampled series reduces bucket averages and says so).

Limits (returned in `limits`): 40 widgets, 20 series per Historian request, 1500 default / 5000 max
points, 366-day window, 400 resolve refs per call, 1.5 MB document, 400 bindings per document (so one
resolve call covers a whole dashboard), 10 variables.

## 5. Endpoints

All under `/api/v1/dashboards`, JSON, errors `{error:{code,message,details?}}` as elsewhere (issues are in
`error.details.issues`). Request bodies reject unknown keys (FastAPI 422 `detail`), so a `tenant_id` in a body
is never accepted. Every mutation takes the `version` the client read; a mismatch is 409
`RESOURCE_VERSION_CONFLICT` (`error.current_version`) and nothing changes. A mutation of an archived
dashboard (other than unarchive) is 409 `ARCHIVED`.

| Method · path | Body / query | Result |
|---|---|---|
| `GET /` | `?include_archived=false&q=` | `{items:[{id,name,description,status,draft_revision,published_revision,published_at,has_unpublished_changes,widget_count,theme_preset,version,created_at,updated_at,archived_at}]}` · `status ∈ DRAFT PUBLISHED` (archived = `archived_at ≠ null`) · `has_unpublished_changes` = never published, or draft ≠ published document |
| `POST /` | `{name, description?, template_id?, role_map?, source_dashboard_id?, site_id?}` | 201 detail + `warnings:[issue]`. `template_id` (built-in id or tenant template UUID) instantiates a template (`role_map: {role_id: source}`; unmapped optional roles drop their binding and a data widget left without bindings is removed; unmapped required roles stay as `role` placeholders and are reported as `UNBOUND`); `source_dashboard_id` copies that draft. Unknown role / invalid mapped source → 422 `VALIDATION`; `template_id` + `source_dashboard_id` together → 422 |
| `GET /{id}` | | detail `{id,name,description,status,version,draft_revision,published_revision,published_at,archived_at,has_unpublished_changes,site_id,created_at,updated_at,document,upgrade_notes:[string]}` (`document` = the normalized draft) |
| `PATCH /{id}` | `{version, name?, description?, document?}` | detail; 409 `RESOURCE_VERSION_CONFLICT`; 422 `VALIDATION` `details.issues[]` (structural errors only: a draft may be incomplete) |
| `POST /{id}/validate` | `{document?}` (default: stored draft) | `{ok, issues:[issue]}` — structural + completeness + every binding resolves (variables at their defaults) and fits the widget; `ok` = no `error` issue |
| `POST /{id}/publish` | `{version, note? ≤ 500}` | detail; 422 `PUBLISH_BLOCKED` with `details.issues` when `ok=false` (an empty dashboard is `EMPTY_DASHBOARD`) |
| `GET /{id}/published` | | `{id,name,description,revision,published_at,archived_at,document}`; 404 `NOT_PUBLISHED` |
| `GET /{id}/revisions` | | `{items:[{revision,published_at,published_by,published_by_name,note,widget_count}]}` newest first |
| `GET /{id}/revisions/{revision}` | | `{revision,published_at,published_by,published_by_name,note,document}`; 404 `REVISION_NOT_FOUND` |
| `POST /{id}/restore` | `{revision, version}` | detail — the revision's document becomes the draft (draft_revision + 1); revisions are immutable, newer ones are kept |
| `POST /{id}/duplicate` | `{name}` | 201 detail (draft copy, unpublished) |
| `POST /{id}/archive` · `POST /{id}/unarchive` | `{version}` | detail; 409 `ARCHIVED` / `NOT_ARCHIVED` when already in that state |
| `GET /{id}/export` | | `{format:"factorix.dashboard",format_version:1,exported_at,name,description,document}` (the draft) |
| `POST /import` | `{name?, payload}` (`payload` = an export) | 201 detail + `warnings:[issue]` (bindings that do not resolve in this tenant stay, are reported, and block publish); 422 `IMPORT_FORMAT` (format/version), 422 `VALIDATION` (structural) |
| `GET /widget-types` | | `{schema_version:1, widget_types:[…], limits:{…}, enums:{relative_ranges,refresh,theme_presets,pages,value_kinds,option_groups,option_types}}` |
| `GET /themes` | | `{items:[{id,label,description,tokens}]}` · tokens `canvas, surface, surface_alt, text, text_muted, border, accent, good, warning, bad, stale, palette[8], chart_grid, chart_axis, radius, gap, font_scale, dark`; `accent` (= `palette[0]`) is the default data fill (bars, gauges, progress, series 1) and is never a status color; `good`/`warning`/`bad`/`stale` are reserved for status |
| `GET /templates` | | `{items:[{id,label,description,category,builtin,roles:[{id,label,value_kinds,required,description}],widget_count,variables,created_at}]}` (built-ins first; built-in ids are stable keys such as `machine_overview`, tenant ids are UUIDs) |
| `POST /templates` | `{dashboard_id, name, description?, category? = "custom"}` | 201 template item (every distinct source of the draft becomes a required role; variable defaults are cleared) |
| `DELETE /templates/{id}` | | 204; 409 `TEMPLATE_BUILTIN`; 404 `TEMPLATE_NOT_FOUND` |
| `GET /sources` | `?q=` | see below |
| `POST /resolve` | `{variables:{id: resource_id or null}, sources:[source]}` (≤ 400, else 422 `LIMIT`) | `{items:[result]}` in request order, see below |

`issue` = `{severity: "error"|"warning", code, message, widget_id?, binding_id?, path?}`.

**`GET /sources`** — the Historian picker read model restricted to `signal` + `model_field`:

```jsonc
{ "items": [ {                                       // one group per resource that owns data
    "resource": {"id","name","code","type_key"}, "path": ["Site","Line"], "ancestors": [{…}],
    "signals": [ { "kind": "signal", "token": "<uuid>", "key", "label", "value_type", "unit", "quality",
                   "freshness", "last_value", "last_at",
                   "source": {"kind": "signal", "signal_id": "<uuid>"}, "value_kind", "capabilities" } ],
    "models": [ { "model_id", "name", "state", "freshness",
                  "fields": [ { "kind": "model_field", "token": "mod:<uuid>:<path>", "key", "field_path", "label",
                                "value_type", "is_timestamp", "freshness", "model_state", "quality", "last_value",
                                "has_last_value", "last_at", "recorded_in",
                                "source": {"kind": "model_field", "model_id", "field_path"}, "model_id",
                                "value_kind", "capabilities" } ] } ] } ],
  "total_groups", "total_series", "observed_at",
  "resources": [ {"id","name","code","type_key","parent_id","path"} ] }   // every non-archived resource (variable pickers)
```

**`POST /resolve`** result: `{source, ok: true, token, kind: "signal"|"model_field", label, resource:
{id,name,code,type_key,parent_id,path}|null, value_type, value_kind, unit, capabilities}` plus `signal_id`,
`key` (signals, also for `signal_key`) or `model_id`, `field_path` (normalized), `is_timestamp` (model
fields); or `{source, ok: false, error: {code, message}}`. `source` echoes the request item. `variables`
must list every document variable (`null` = no resource selected). Matching is exact and tenant-scoped:
signal by id, model by id + exact leaf path, `signal_key` by the ACTIVE signal with exactly that key on the
selected resource. Duplicate references are resolved once.

`value_kind` ∈ `number | boolean | string | json | unknown` (signal `int64/float64` → number, `bool` →
boolean, `string/enum` → string, `json` → json; model `float/int` → number, `bool` → boolean,
`string/timestamp` → string, `json` → json, `auto` → the kind of the signal it maps, else unknown). A widget
accepting `any` takes every kind; otherwise an `unknown` kind is a warning and another kind an error.

`token` is the Historian series token (`<signal uuid>` or `mod:<model uuid>:<field path>`), used as-is
in `POST /api/v1/historian/query`; for signals it is also the live-stream `signal_id`.

Resolve error codes: `NOT_FOUND`, `ARCHIVED`, `FIELD_NOT_FOUND`, `VARIABLE_UNSET`, `VARIABLE_UNKNOWN`,
`KEY_NOT_ON_RESOURCE`, `INVALID_REF` (malformed or unsupported kind), `UNBOUND` (template role placeholder).

Publish additionally reports (all `error` unless noted): `EMPTY_DASHBOARD`, `TOO_FEW_BINDINGS`,
`ROLE_MISSING`, `UNBOUND`, `VALUE_KIND_MISMATCH`, `VALUE_KIND_UNKNOWN` (warning), `HISTORY_UNAVAILABLE`
(the widget needs history: `history: required`, `value_mode ≠ latest`, `sparkline`), `HISTORY_LIMITED`
(warning: model snapshots / PostgreSQL fallback), `HISTORY_MODE_UNAVAILABLE` (`history_mode=recorded` on a
source without a recording), `VARIABLE_UNSET` (warning: a `signal_key` whose variable has no default is
resolved at view time), `VARIABLE_DEFAULT_NOT_FOUND`, `VARIABLE_TYPE_MISMATCH`, `RESOURCE_NOT_FOUND`,
`LINK_TARGET_MISSING`, `LINK_TARGET_NOT_FOUND`, `OPTION_MISSING`, `ARCHIVED` (warning) and the resolve codes.

## 6. Source capabilities (computed by the backend, never guessed by the browser)

```jsonc
{ "latest": true, "live": true, "historical": true,
  "history_modes": ["operational"],                 // + "recorded" when a recording exists; [] when not historical
  "fidelity": "operational_full",                   // operational_full | postgres_fallback | managed_recorded | model_snapshots | unavailable
  "notes": ["Not recorded: only recent model snapshots are kept."] }
```

* Signal: live via `/stream`; history `operational_full` when TDengine history is configured, otherwise
  `postgres_fallback` if enabled, else `unavailable`. `recorded` is listed when the signal has an
  ACTIVE/PAUSED managed recording (what `mode=recorded` reads).
* Model field: live via `model_body`; history `managed_recorded` when an ACTIVE storage binding records
  it, otherwise `model_snapshots` (≤ 500 recent samples, noted); `unavailable` without TDengine history.

## 7. Runtime data flow (browser)

1. `POST /resolve` once for every binding of the document (re-run when a variable changes).
2. Latest: signal tokens → `subscribeSignals` (shared socket; the server sends the snapshot on
   subscribe); model fields → `GET /api/v1/data-models/{id}/latest` then `subscribeModels`. Freshness and
   quality are the server's verdict (`freshness`, `effective_status`, `quality`); missing quality is
   shown as unknown, never as GOOD.
3. History: bindings that need history are grouped by (time window, mode, resolution, max_points) and
   sent as `POST /api/v1/historian/query` with ≤ 20 tokens per request; identical requests are shared;
   obsolete requests are aborted; re-query cadence = `settings.refresh` (≥ 10 s). With `live_append`, live
   frames newer than the last point are appended (deduped by timestamp, cleared on `data_epoch` change
   or `telemetry_reset`), never joined across a gap.
4. Display transform (`scale`, `offset`) and reductions run client-side on bounded data only.
