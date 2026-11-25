/**
 * Dashboard Studio contract types (document schema v1, registry, runtime data).
 * Source of truth: docs/architecture/contracts/dashboard.md. Keys mirror the backend JSON (snake_case).
 */

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

export type Breakpoint = 'lg' | 'md' | 'sm';
export const BREAKPOINT_COLUMNS: Record<Breakpoint, number> = { lg: 12, md: 6, sm: 1 };

export type RelativeRange = '5m' | '15m' | '30m' | '1h' | '3h' | '6h' | '12h' | '24h' | '2d' | '7d' | '30d';
export type TimeRange =
  | { kind: 'relative'; last: RelativeRange }
  | { kind: 'absolute'; start: string; end: string };

export type ThemePresetId = 'factorix_light' | 'control_room_dark' | 'industrial_neutral';

export interface ThemeSettings {
  preset: ThemePresetId;
  accent: string | null;
  canvas: string | null;
  surface: string | null;
  text: string | null;
  radius: number;
  gap: number;
  font_scale: number;
}

export type RefreshPolicy = 'live' | '10s' | '30s' | '1m' | '5m' | 'off';

export interface DashboardSettings {
  theme: ThemeSettings;
  time_range: TimeRange;
  refresh: RefreshPolicy;
  row_height: number;
}

export interface DashboardVariable {
  id: string;
  label: string;
  type: 'resource';
  resource_type: string | null;
  default: string | null;
}

export type SourceRef =
  | { kind: 'signal'; signal_id: string }
  | { kind: 'model_field'; model_id: string; field_path: string }
  | { kind: 'signal_key'; variable: string; key: string }
  | { kind: 'role'; role: string };

export interface Binding {
  id: string;
  role?: string;
  source: SourceRef;
  label: string | null;
  color: string | null;
  unit: string | null;
  scale: number;
  offset: number;
}

export interface GridRect { x: number; y: number; w: number; h: number }

export interface DashboardWidget {
  id: string;
  type: string;
  version: number;
  title: string;
  layout: { lg: GridRect; md: GridRect | null; sm: GridRect | null };
  hidden: Record<Breakpoint, boolean>;
  time: { mode: 'dashboard' } | { mode: 'custom'; range: TimeRange };
  bindings: Binding[];
  options: Record<string, unknown>;
}

export interface DashboardDocument {
  schema_version: 1;
  settings: DashboardSettings;
  variables: DashboardVariable[];
  widgets: DashboardWidget[];
}

// ---------------------------------------------------------------------------------------------
// API entities
// ---------------------------------------------------------------------------------------------

export interface DashboardSummary {
  id: string;
  name: string;
  description: string;
  status: 'DRAFT' | 'PUBLISHED';
  draft_revision: number;
  published_revision: number | null;
  published_at: string | null;
  has_unpublished_changes: boolean;
  widget_count: number;
  theme_preset: ThemePresetId | string;
  version: number;
  updated_at: string;
  archived_at: string | null;
}

export interface DashboardDetail extends Omit<DashboardSummary, 'status' | 'widget_count' | 'theme_preset'> {
  document: DashboardDocument;
  status?: 'DRAFT' | 'PUBLISHED';
  site_id?: string | null;
  created_at?: string;
  /** Notes of a legacy draft upgraded on read. */
  upgrade_notes?: string[];
}

export interface PublishedDashboard {
  id: string;
  name: string;
  description: string;
  revision: number;
  published_at: string;
  archived_at?: string | null;
  document: DashboardDocument;
}

export interface RevisionSummary {
  revision: number;
  published_at: string;
  published_by: string | null;
  published_by_name?: string | null;
  note: string;
  widget_count: number;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  widget_id?: string;
  binding_id?: string;
  path?: string;
}

export interface TemplateRole { id: string; label: string; value_kinds: ValueKind[]; required: boolean; description?: string }
export interface DashboardTemplate {
  id: string;
  label: string;
  description: string;
  category: string;
  builtin: boolean;
  roles: TemplateRole[];
  widget_count: number;
  variables: DashboardVariable[];
}

export interface ThemePreset {
  id: ThemePresetId;
  label: string;
  description: string;
  tokens: ThemeTokens;
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export type ValueKind = 'number' | 'boolean' | 'string' | 'any';
export type OptionGroup = 'general' | 'data' | 'display' | 'thresholds' | 'style';
export type OptionType =
  | 'boolean' | 'integer' | 'number' | 'string' | 'text' | 'color' | 'enum'
  | 'thresholds' | 'mappings' | 'image' | 'dashboard_ref' | 'page_ref' | 'resource_ref' | 'variable_ref';

export interface OptionSpec {
  key: string;
  label: string;
  group: OptionGroup;
  type: OptionType;
  default: unknown;
  min?: number;
  max?: number;
  choices?: Array<{ value: string; label: string }>;
  max_length?: number;
  nullable?: boolean;
  help?: string;
  show_if?: { key: string; in: unknown[] };
}

export interface WidgetRole { id: string; label: string; required: boolean; max?: number }

export interface WidgetTypeDef {
  type: string;
  version: number;
  label: string;
  category: 'value' | 'status' | 'trend' | 'compare' | 'distribution' | 'table' | 'industrial' | 'content';
  description: string;
  icon: string;
  default_size: { w: number; h: number };
  min_size: { w: number; h: number };
  data: {
    min_bindings: number;
    max_bindings: number;
    value_kinds: ValueKind[];
    history: 'none' | 'optional' | 'required';
    roles: WidgetRole[] | null;
  };
  options: OptionSpec[];
}

export interface RegistryLimits {
  max_widgets: number;
  max_series_per_query: number;
  default_points: number;
  max_points: number;
  max_range_days: number;
  max_resolve_refs: number;
  max_document_bytes: number;
  /** Server names (dash-be): the client normalises them onto the fields above. */
  default_max_points?: number;
  max_window_days?: number;
  max_variables?: number;
  max_bindings_per_document?: number;
  max_widget_height?: number;
  max_y?: number;
}

export interface WidgetRegistry {
  schema_version: number;
  widget_types: WidgetTypeDef[];
  limits: RegistryLimits;
  enums?: Record<string, string[]>;
}

export interface Threshold { value: number; color: string; label?: string }
export type Mapping =
  | { kind: 'value'; value: string; label: string; color: string }
  | { kind: 'range'; from: number | null; to: number | null; label: string; color: string };

// ---------------------------------------------------------------------------------------------
// Sources and resolution
// ---------------------------------------------------------------------------------------------

export interface SourceCapabilities {
  latest: boolean;
  live: boolean;
  historical: boolean;
  history_modes: Array<'operational' | 'recorded'>;
  fidelity: 'operational_full' | 'managed_recorded' | 'model_snapshots' | 'postgres_fallback' | 'unavailable';
  notes: string[];
}

export interface ResolvedSource {
  source: SourceRef;
  ok: boolean;
  token?: string;
  kind?: 'signal' | 'model_field';
  label?: string;
  resource?: { id: string | null; name: string; code?: string } | null;
  value_type?: string | null;
  /** number | boolean | string | json | unknown (server verdict). */
  value_kind?: string | null;
  unit?: string | null;
  signal_id?: string;
  key?: string;
  model_id?: string;
  field_path?: string;
  is_timestamp?: boolean;
  capabilities?: SourceCapabilities;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------------------------
// Runtime data handed to renderers
// ---------------------------------------------------------------------------------------------

/** Server verdict of a value; `unknown` when the server did not say (never assumed GOOD). */
export type DataState = 'good' | 'uncertain' | 'bad' | 'stale' | 'delayed' | 'no_data' | 'unknown';

export interface LatestValue {
  value: unknown;               // after scale/offset for numbers
  raw: unknown;                 // as received
  ts: number | null;            // acquisition/sample time (ms epoch)
  quality: string | null;       // GOOD | UNCERTAIN | BAD | null
  freshness: string | null;     // FRESH | DELAYED | STALE | NO_DATA | null
  effective_status: string | null;
  reason_code: string | null;
  state: DataState;
}

export interface HistoryPoint { t: number; v: unknown; q: string | null }

export interface HistoryData {
  status: string;               // OK | NO_DATA | PARTIAL | ERROR … as returned by the Historian
  points: HistoryPoint[];       // ascending time, scale/offset applied to numbers
  downsampled: boolean;
  truncated: boolean;
  fidelity: string;
  notes: string[];
  bucket_ms: number | null;
  next_cursor: string | null;
}

export interface SeriesData {
  binding: Binding;
  role: string | null;
  resolved: ResolvedSource | null;
  error: { code: string; message: string } | null;
  label: string;
  unit: string | null;
  color: string;
  value_kind: 'number' | 'boolean' | 'string' | 'json' | 'unknown';
  latest: LatestValue | null;
  history: HistoryData | null;
}

export interface WidgetData {
  status: 'loading' | 'ready' | 'error' | 'unbound';
  error: string | null;
  series: SeriesData[];
  warnings: string[];
  /** Resolved resource for widgets bound to a resource (equipment). */
  resource: { id: string; name: string; code?: string; path: string[] } | null;
}

export interface ThemeTokens {
  canvas: string;
  surface: string;
  surface_alt: string;
  text: string;
  text_muted: string;
  border: string;
  accent: string;
  good: string;
  warning: string;
  bad: string;
  stale: string;
  palette: string[];
  chart_grid: string;
  chart_axis: string;
  radius: number;
  gap: number;
  font_scale: number;
  dark: boolean;
}

export type NavTarget =
  | { kind: 'dashboard'; dashboard_id: string; carry_variables: boolean }
  | { kind: 'page'; page: string }
  | { kind: 'signal'; signal_id: string }
  | { kind: 'resource'; resource_id: string };

export interface WidgetRendererProps {
  widget: DashboardWidget;
  def: WidgetTypeDef;
  /** options merged with registry defaults */
  options: Record<string, unknown>;
  data: WidgetData;
  theme: ThemeTokens;
  size: { width: number; height: number };
  mode: 'view' | 'edit';
  timeRange: { start: number; end: number };
  onNavigate: (target: NavTarget) => void;
}

// ---------------------------------------------------------------------------------------------
// Frontend core additions (API envelopes, source catalog). Added by the Studio/runtime layer;
// every type above is unchanged.
// ---------------------------------------------------------------------------------------------

export interface DashboardListResponse { items: DashboardSummary[] }

export interface DashboardImportResult extends DashboardDetail {
  warnings?: Array<string | { code?: string; message: string; widget_id?: string; binding_id?: string }>;
}

export interface DashboardExport {
  format: 'factorix.dashboard';
  format_version: number;
  exported_at: string;
  name: string;
  description: string;
  document: DashboardDocument;
}

export interface ValidationResult { ok: boolean; issues: ValidationIssue[] }

export interface RevisionDetail {
  revision: number;
  published_at: string;
  note: string;
  document: DashboardDocument;
}

/** One Factory Model resource of `GET /dashboards/sources` (`resources[]`). */
export interface SourceResource {
  id: string;
  name: string;
  code: string;
  type_key: string;
  path: string[] | string | null;
  parent_id: string | null;
}

/** One selectable source of the catalog (signal or Data Model field), normalised by the client. */
export interface SourceItem {
  kind: 'signal' | 'model_field';
  token: string;
  key: string;
  label: string;
  value_type: string | null;
  unit: string | null;
  quality: string | null;
  freshness: string | null;
  last_value: unknown;
  has_last_value: boolean;
  last_at: string | null;
  resource_id: string | null;
  signal_id?: string;
  model_id?: string;
  model_name?: string;
  field_path?: string;
  /** The SourceRef to store verbatim in a binding (from the server). */
  source: SourceRef | null;
  /** number | boolean | string | json | unknown (server verdict). */
  value_kind: string | null;
  capabilities: SourceCapabilities | null;
}

export interface SourceCatalog {
  items: SourceItem[];
  resources: SourceResource[];
}

export interface ResolveResponse { items: ResolvedSource[] }

/** `GET /api/v1/data-models/{id}/latest`. `body` is the exact JSON text of the last sample. */
export interface ModelLatest {
  body: string | null;
  sampled_at: string | null;
  errors: Array<{ path?: string; code?: string; message?: string }>;
  fields?: Array<{ path: string; quality: string; reason?: string | null }>;
}

/** `POST /api/v1/historian/query` request (only the keys the dashboard runtime sends). */
export interface HistorianQueryRequest {
  sources: string[];
  start: string;
  end: string;
  mode: 'operational' | 'recorded';
  resolution: 'auto' | 'raw';
  max_points: number;
}

export interface HistorianPointRaw {
  ts: string;
  value: unknown;
  quality: string | null;
  record_kind: string;
  data_epoch?: number | null;
}

export interface HistorianSeriesRaw {
  series_key: string;
  status: string;
  fidelity: string;
  points: HistorianPointRaw[];
  downsampled: boolean;
  truncated: boolean;
  bucket_ms?: number | null;
  next_cursor?: string | null;
  coverage_notes?: string[];
  unit?: string | null;
  value_type?: string | null;
  display_name?: string;
}

export interface HistorianQueryResponseRaw {
  series_list: HistorianSeriesRaw[];
  downsampled?: boolean;
  history_available?: boolean;
  coverage_notes?: string[];
  next_cursor?: string | null;
  start?: string;
  end?: string;
}
