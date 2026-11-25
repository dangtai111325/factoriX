import { api, ApiError } from '../api/client';

export { ApiError };

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const row = document.cookie.split('; ').find((item) => item.startsWith('fx_csrf='));
  return row ? decodeURIComponent(row.slice('fx_csrf='.length)) : '';
}

/**
 * Typed fetch wrapper using the shared FactoriX `api` client (same-origin credentials + `X-CSRF-Token` from `fx_csrf`).
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return api<T>(path, init);
}

// ============================================================================
// Storage DSL & AST Types (factorix.io/storage/v1)
// ============================================================================

export type StorageValueType = 'bool' | 'int64' | 'float64' | 'string' | 'enum' | 'json' | 'timestamp';
export type DatasetSemantics = 'state_series' | 'event_stream' | 'structured_record' | 'model_projection';
export type DatasetSourceKind = 'signals' | 'model_fields' | 'mixed';
export type TimeAxisMode = 'acquired_at' | 'source_time';
export type RecordingMode = 'ON_CHANGE' | 'EVERY_ACQUISITION' | 'INTERVAL';
export type MissingPolicyMode = 'GAP_MARKER' | 'NULL' | 'HOLD_LAST_WITH_QUALITY';
export type ScopeMode = 'all_sites' | 'site' | 'subtree' | 'resources';
export type StorageDesignStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'RUNNING'
  | 'PAUSED'
  | 'APPLYING'
  | 'ERROR'
  | 'ARCHIVED'
  | 'RETIRED';

export interface DeadbandSpec {
  kind: 'absolute' | 'percent';
  value: number;
}

export interface RecordingSpec {
  mode: RecordingMode;
  qualityTransitions: boolean;
  deadband?: DeadbandSpec | null;
  maxCheckpointInterval?: string | null;
  interval?: string | null;
  lateTolerance?: string | null;
  missingPolicy: MissingPolicyMode;
}

export interface RetentionSpec {
  days: number;
  legalHold: boolean;
}

export interface TagSpec {
  key: string;
  value: string;
}

export interface FieldAst {
  key: string;
  from: string;
  type: StorageValueType;
  displayName?: string;
  description?: string;
  nullable?: boolean;
  required?: boolean;
  unit?: string | null;
  maxLength?: number | null;
  transform?: string | null;
  sourceKind?: 'signal' | 'model_field' | 'constant' | 'expression';
  signalId?: string | null;
  modelId?: string | null;
  modelFieldPath?: string | null;
  resourceId?: string | null;
  sourceRevision?: number;
}

export interface RelationshipAst {
  id: string;
  from: string;
  to: string;
  kind: 'derived_from' | 'belongs_to' | 'references' | 'mapped_from';
  description?: string;
}

export interface DatasetAst {
  id?: string | null;
  key: string;
  displayName?: string;
  description?: string;
  semantics: 'state_series' | 'event_stream' | 'structured_record';
  sourceKind: DatasetSourceKind;
  timeAxis: TimeAxisMode;
  tags?: TagSpec[];
  fields: FieldAst[];
  relationships?: RelationshipAst[];
  recording: RecordingSpec;
  retention: RetentionSpec;
}

export interface ScopeSpec {
  mode: ScopeMode;
  resource?: string | null;
  siteId?: string | null;
  resourceIds?: string[];
}

export interface DestinationSpec {
  engine: 'tdengine';
  dbStrategy?: string;
}

export interface DesignMetadata {
  name: string;
  description?: string;
  owner?: string | null;
  labels?: Record<string, string>;
}

export interface StorageDesignAst {
  apiVersion: string;
  kind: string;
  metadata: DesignMetadata;
  spec: {
    scope: ScopeSpec;
    destination: DestinationSpec;
    datasets: DatasetAst[];
    uiMeta?: Record<string, unknown>;
  };
}

export interface DslIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
  line?: number | null;
  column?: number | null;
}

// ============================================================================
// Storage Designs, Physical Plan & Simulation Types
// ============================================================================

export interface StorageDesignSummary {
  id: string;
  tenant_id?: string;
  name: string;
  description: string;
  status: StorageDesignStatus;
  current_version: number;
  draft_revision?: number;
  published_version?: number | null;
  published_version_id?: string | null;
  scope?: ScopeSpec | Record<string, unknown>;
  scope_summary?: string;
  dataset_count: number;
  field_count: number;
  signal_count: number;
  model_count: number;
  recording_modes: RecordingMode[];
  primary_recording_mode: RecordingMode;
  retention_days: number;
  legal_hold: boolean;
  destination: 'TDengine';
  td_database?: string;
  health?: string;
  owner_id?: string | null;
  created_at?: string;
  updated_at?: string;
  published_at?: string | null;
  archived_at?: string | null;
}

export interface StorageDesignVersion {
  id: string;
  design_id: string;
  version: number;
  ast_json?: StorageDesignAst | Record<string, unknown>;
  ast_hash: string;
  semantic_hash: string;
  compiler_version: string;
  ddl_plan_json?: CompiledStoragePlan | Record<string, unknown>;
  plan_hash: string;
  publish_state: 'PENDING' | 'APPLIED' | 'FAILED' | 'SUPERSEDED';
  effective_from_epoch: number;
  effective_at?: string | null;
  created_by?: string | null;
  created_at: string;
  applied_at?: string | null;
  diagnostics_json?: Record<string, unknown>;
}

export interface StoragePhysicalEntry {
  id: string;
  tier: 'OPERATIONAL' | 'MANAGED' | 'MODEL_SNAPSHOT';
  design_id?: string | null;
  dataset_id?: string | null;
  dataset_key?: string;
  signal_id?: string | null;
  series_key: string;
  field_key?: string;
  value_type: string;
  td_database: string;
  td_stable: string;
  td_subtable: string;
  physical_schema_hash: string;
  generation: number;
  status: 'ACTIVE' | 'PAUSED' | 'RETIRED';
  created_at?: string;
  updated_at?: string;
}

export interface StorageOperation {
  id: string;
  tenant_id?: string;
  operation_type: string;
  target_type: string;
  target_id?: string | null;
  design_id?: string | null;
  design_name?: string | null;
  actor_id?: string | null;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PAUSED_RETRYABLE';
  requested_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  step_state_json?: Record<string, unknown>;
  error_code?: string | null;
  error_message?: string | null;
  trace_id?: string;
}

export interface StorageDependencyItem {
  id: string;
  type: 'signal' | 'resource' | 'data_model' | 'saved_view' | 'export';
  target_id: string;
  name: string;
  key?: string;
  subpath?: string;
  status?: string;
  protocol?: string;
  resource_name?: string;
  kind?: string;
}

export interface StorageDependenciesResponse {
  design_id: string;
  signals: StorageDependencyItem[];
  resources: StorageDependencyItem[];
  data_models: StorageDependencyItem[];
  saved_views: StorageDependencyItem[];
  exports: StorageDependencyItem[];
  total_count: number;
}

export interface StorageDesignDetail extends StorageDesignSummary {
  ast: StorageDesignAst;
  yaml: string;
  datasets: DatasetAst[];
  versions: StorageDesignVersion[];
  physical_registry: StoragePhysicalEntry[];
  physical_plan?: CompiledStoragePlan | null;
  operations: StorageOperation[];
  dependencies: StorageDependenciesResponse;
  validation_issues: DslIssue[];
}

export interface StorageCoverageSummary {
  signals_mapped: number;
  signals_total: number;
  models_mapped: number;
  models_total: number;
  operational_signals_active?: number;
}

export interface StorageDesignsListResponse {
  items: StorageDesignSummary[];
  counts: {
    all: number;
    running: number;
    drafts: number;
    paused: number;
    archived: number;
    needs_review?: number;
  };
  coverage: StorageCoverageSummary;
  recent_publishes?: Array<{
    design_id: string;
    design_name: string;
    version: number;
    published_at: string;
    status: string;
  }>;
  next_cursor?: string | null;
}

export interface ValidateDesignResponse {
  valid: boolean;
  ast: StorageDesignAst | null;
  yaml: string;
  issues: DslIssue[];
  semantic_hash?: string;
  ast_hash?: string;
  row_width_bytes?: number;
  max_row_width_bytes?: number;
  dataset_row_widths?: Record<string, number>;
}

export interface CompiledSeries {
  dataset_key: string;
  series_key: string;
  field_key: string;
  value_type: string;
  td_database: string;
  td_stable: string;
  td_subtable: string;
  signal_id?: string | null;
  model_id?: string | null;
  model_field_path?: string | null;
  physical_schema_hash: string;
  tags: Record<string, string>;
}

export interface SchemaDiff {
  is_breaking: boolean;
  breaking_changes: string[];
  non_breaking_changes: string[];
  ddl_statements: string[];
  actions?: Array<{
    action: 'CREATE_DATABASE' | 'CREATE_STABLE' | 'ADD_COLUMN' | 'ENSURE_SUBTABLE' | 'BREAKING_CHANGE';
    target: string;
    ddl?: string;
    description?: string;
  }>;
}

export interface CompiledDatasetPlan {
  dataset_id: string;
  dataset_key: string;
  td_stable: string;
  schema_epoch: number;
  semantics: string;
  recording_mode: RecordingMode;
  retention_days: number;
  legal_hold: boolean;
  row_width_bytes?: number;
  max_row_width_bytes?: number;
  columns: Array<{
    key: string;
    value_type: string;
    td_type: string;
    nullable: boolean;
    bytes?: number;
  }>;
  tags?: Array<{
    key: string;
    td_type: string;
    value?: string;
  }>;
  subtable_count?: number;
  physical_schema_hash: string;
}

export interface CompiledStoragePlan {
  compiler_version: string;
  td_database: string;
  destination: 'TDengine';
  semantic_hash: string;
  ast_hash: string;
  plan_hash: string;
  row_width_bytes: number;
  max_row_width_bytes: number;
  ddl_statements: string[];
  datasets: CompiledDatasetPlan[];
  series: CompiledSeries[];
  diff: SchemaDiff;
  impact: {
    dataset_count: number;
    series_count: number;
    field_count: number;
    estimated_daily_rows_min: number;
    estimated_daily_rows_max: number;
    estimated_daily_bytes_min: number;
    estimated_daily_bytes_max: number;
    assumptions: string;
  };
  warnings: string[];
}

export interface SimulateSampleRow {
  index: number;
  ts: string;
  acquired_at?: string;
  source_time?: string | null;
  dataset_key: string;
  field_key: string;
  source_ref: string;
  signal_id?: string | null;
  raw_value: unknown;
  transformed_value: unknown;
  quality: string;
  reason_code?: string | null;
  would_write: boolean;
  record_kind: string;
  skip_reason: string;
}

export interface SimulateDesignResponse {
  evaluated_samples: number;
  would_write: number;
  skipped_total: number;
  skipped_by_reason: Record<string, number>;
  checkpoints_written: number;
  gap_markers_written: number;
  estimated_reduction_pct: number;
  compression_ratio: number;
  estimated_bytes_per_day?: number;
  exactness_warnings: string[];
  samples: SimulateSampleRow[];
}

export interface PublishDesignResponse {
  design_id: string;
  status: StorageDesignStatus;
  version: number;
  version_id: string;
  operation_id: string;
  semantic_hash: string;
  plan_hash: string;
  td_database: string;
  applied_statements: number;
  verified_subtables: number;
  published_at: string;
}

export interface StorageHealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';
  destination: 'TDengine';
  tdengine: {
    status: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';
    reachable: boolean;
    engine: 'TDengine';
    version?: string;
    database?: string;
    stables_count?: number;
    managed_subtables_count?: number;
    operational_subtables_count?: number;
    last_write_at?: string | null;
    write_latency_ms?: number | null;
    message?: string;
  };
  ingestion: {
    status: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';
    transport: 'RabbitMQ';
    broker_reachable?: boolean;
    consumer_ready?: boolean;
    queue_depth?: number;
    dlq_depth?: number;
    active_epoch?: number;
    managed_bindings_active?: number;
    last_ingested_at?: string | null;
  };
  retention: {
    status: 'HEALTHY' | 'IDLE' | 'BLOCKED_LEGAL_HOLD';
    active_policies_count?: number;
    legal_holds_count?: number;
    last_run_at?: string | null;
  };
  checked_at: string;
}

export interface RetentionPreviewDatasetItem {
  dataset_id: string;
  dataset_key: string;
  design_id: string;
  design_name: string;
  td_stable: string;
  subtable_count: number;
  retention_days: number;
  legal_hold: boolean;
  cutoff_timestamp: string;
  estimated_expired_rows: number;
  blocked_by_legal_hold: boolean;
  status: 'READY' | 'BLOCKED_LEGAL_HOLD' | 'NO_EXPIRED_DATA';
}

export interface RetentionPreviewResponse {
  design_id?: string | null;
  can_execute: boolean;
  blocked_by_legal_hold: boolean;
  legal_hold_datasets: string[];
  total_subtables_evaluated: number;
  total_estimated_expired_rows: number;
  datasets: RetentionPreviewDatasetItem[];
  evaluated_at: string;
}

export interface ExportDesignBundle {
  format: 'yaml' | 'json';
  design_id: string;
  name: string;
  version: number;
  semantic_hash: string;
  content: string;
  ast: StorageDesignAst;
  exported_at: string;
}

// ============================================================================
// Historian Types (S12)
// ============================================================================

export interface HistorianLatestItem {
  signal_id: string;
  key?: string;
  display_name?: string;
  resource_id?: string;
  resource_name?: string;
  value: unknown;
  value_type?: string;
  unit?: string | null;
  quality: string;
  reason_code?: string | null;
  source_time?: string | null;
  last_acquired_at?: string | null;
  last_value_changed_at?: string | null;
  data_epoch?: number;
  source_health?: string;
  connection_health?: string;
  broker_health?: string;
  storage_health?: string;
}

export interface HistorianPoint {
  id?: string;
  ts: string;
  event_time?: string;
  acquired_at?: string;
  received_time?: string;
  source_time?: string | null;
  signal_id: string;
  dataset_id?: string | null;
  value: unknown;
  value_type?: string;
  unit?: string | null;
  quality: string;
  reason_code?: string | null;
  event_uid?: string;
  record_kind?: string;
  virtual?: boolean;
  data_epoch?: number;
}

export interface HistorianSeriesStats {
  signal_id: string;
  key?: string;
  display_name?: string;
  unit?: string | null;
  value_type?: string;
  min: number | null;
  max: number | null;
  avg: number | null;
  last: unknown;
  last_ts?: string | null;
  count: number;
  good_count?: number;
  good_pct: number;
  fidelity?: string;
}

export interface HistorianQualitySegment {
  signal_id?: string;
  start: string;
  end: string;
  quality: 'GOOD' | 'UNCERTAIN' | 'STALE' | 'BAD' | 'PAUSED' | 'NO_DATA';
  reason_code?: string | null;
}

export interface HistorianSeriesResult {
  signal_id: string;
  key?: string;
  display_name?: string;
  resource_id?: string;
  resource_name?: string;
  value_type: string;
  unit?: string | null;
  mode: 'operational' | 'recorded' | 'reconstructed';
  fidelity: string;
  points: HistorianPoint[];
  stats: HistorianSeriesStats;
  quality_segments: HistorianQualitySegment[];
  coverage_notes?: string[];
}

export interface HistorianQueryRequest {
  signal_ids?: string[];
  design_id?: string | null;
  dataset_id?: string | null;
  dataset_key?: string | null;
  mode?: 'operational' | 'recorded' | 'reconstructed';
  time_axis?: 'acquired_at' | 'source_time';
  start?: string;
  end?: string;
  range?: string;
  bucket_ms?: number | null;
  agg?: 'avg' | 'min' | 'max' | 'sum' | 'count' | 'first' | 'last' | null;
  quality_filter?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface HistorianQueryResponse {
  mode: 'operational' | 'recorded' | 'reconstructed';
  start: string;
  end: string;
  bucket_ms?: number | null;
  agg?: string | null;
  downsampled: boolean;
  series: HistorianSeriesResult[];
  points: HistorianPoint[];
  stats: HistorianSeriesStats[];
  quality_segments: HistorianQualitySegment[];
  sql_preview?: string;
  next_cursor?: string | null;
  coverage_notes?: string[];
}

export interface HistorianEventItem {
  id: string;
  ts: string;
  kind: 'QUALITY_TRANSITION' | 'STORAGE_OPERATION' | 'EPOCH_RESET' | 'CHECKPOINT' | 'GAP';
  signal_id?: string | null;
  signal_key?: string | null;
  design_id?: string | null;
  design_name?: string | null;
  from_state?: string | null;
  to_state?: string | null;
  quality?: string | null;
  reason_code?: string | null;
  message: string;
  data_epoch?: number;
}

export interface SavedViewItem {
  id: string;
  name: string;
  description: string;
  query_spec: HistorianQueryRequest & Record<string, unknown>;
  chart_options?: Record<string, unknown>;
  is_default: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ExportJobItem {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'READY' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  format: 'csv';
  file_name: string;
  row_count?: number | null;
  byte_size?: number | null;
  query_spec?: Record<string, unknown>;
  error_code?: string | null;
  error_message?: string | null;
  data_epoch?: number;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  expires_at?: string | null;
  download_url?: string | null;
}

// ============================================================================
// Safe Telemetry Reset Types (S13)
// ============================================================================

export interface TelemetryResetPreviewResponse {
  active_epoch: number;
  next_epoch: number;
  lifecycle_state: string;
  can_execute: boolean;
  will_clear: {
    observations: number;
    latest_signal_state: number;
    model_snapshots: number;
    model_state: number;
    ingest_dedup: number;
    observation_quarantine: number;
    commissioning_jobs: number;
    export_jobs: number;
    tdengine_operational_subtables: number;
    tdengine_managed_subtables: number;
  };
  preserved: {
    connections: number;
    signals_active: number;
    signals_archived: number;
    data_models: number;
    storage_designs: number;
    resources: number;
    admin_accounts: number;
    sessions: number;
    secret_store: number;
    formulas: number;
  };
  required_phrase: 'CLEAR TELEMETRY';
  preview_at?: string;
}

export interface TelemetryResetExecuteRequest {
  confirm_phrase: string;
  password: string;
}

export interface TelemetryResetExecuteResponse {
  status: string;
  operation_id?: string;
  previous_epoch: number;
  active_epoch: number;
  cleared: Record<string, number>;
  preserved: Record<string, number>;
  stay_authenticated: boolean;
  completed_at?: string;
}

export interface TelemetryResetStatusResponse {
  active_epoch: number;
  lifecycle_state: string;
  last_operation?: StorageOperation | null;
}

// ============================================================================
// Normalization Helpers (Defensive against camelCase / snake_case variations)
// ============================================================================

type Raw = Record<string, any>;

function asArray<T = Raw>(val: unknown): T[] {
  if (Array.isArray(val)) return val as T[];
  if (val && typeof val === 'object') return Object.values(val) as T[];
  return [];
}

function str(val: unknown, fallback = ''): string {
  return val === null || val === undefined ? fallback : String(val);
}

function num(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function createDefaultStorageDesignAst(name = 'plant_telemetry_history'): StorageDesignAst {
  return {
    apiVersion: 'factorix.io/storage/v1',
    kind: 'StorageDesign',
    metadata: {
      name,
      description: 'Managed TDengine historical storage policy for selected plant signals and data models.',
    },
    spec: {
      scope: {
        mode: 'all_sites',
      },
      destination: {
        engine: 'tdengine',
        dbStrategy: 'tenant_isolated',
      },
      datasets: [
        {
          key: 'process_state_series',
          displayName: 'Process State Series',
          description: 'Change-driven state history with mandatory quality transitions.',
          semantics: 'state_series',
          sourceKind: 'signals',
          timeAxis: 'acquired_at',
          tags: [{ key: 'tier', value: 'managed' }],
          fields: [],
          recording: {
            mode: 'ON_CHANGE',
            qualityTransitions: true,
            deadband: { kind: 'absolute', value: 0 },
            maxCheckpointInterval: '60s',
            lateTolerance: '300s',
            missingPolicy: 'GAP_MARKER',
          },
          retention: {
            days: 90,
            legalHold: false,
          },
        },
      ],
    },
  };
}

/**
 * Deterministic client-side YAML serializer for `StorageDesignAst` (`factorix.io/storage/v1`).
 */
export function serializeAstToYaml(ast: StorageDesignAst): string {
  const q = (v: string) => {
    if (
      v === '' ||
      /[:#{}[\],&*!|>'"%@`\n\r\t]/.test(v) ||
      /^\s|\s$/.test(v) ||
      /^(true|false|null|yes|no|on|off|\d+(\.\d+)?)$/i.test(v)
    ) {
      return JSON.stringify(v);
    }
    return v;
  };

  const lines: string[] = [];
  lines.push(`apiVersion: ${q(ast.apiVersion || 'factorix.io/storage/v1')}`);
  lines.push(`kind: ${q(ast.kind || 'StorageDesign')}`);
  lines.push('metadata:');
  lines.push(`  name: ${q(ast.metadata?.name || 'untitled_design')}`);
  if (ast.metadata?.description) {
    lines.push(`  description: ${q(ast.metadata.description)}`);
  }
  if (ast.metadata?.owner) {
    lines.push(`  owner: ${q(ast.metadata.owner)}`);
  }
  lines.push('spec:');
  lines.push('  scope:');
  lines.push(`    mode: ${q(ast.spec?.scope?.mode || 'all_sites')}`);
  if (ast.spec?.scope?.resource) {
    lines.push(`    resource: ${q(ast.spec.scope.resource)}`);
  }
  if (ast.spec?.scope?.siteId) {
    lines.push(`    siteId: ${q(ast.spec.scope.siteId)}`);
  }
  if (ast.spec?.scope?.resourceIds && ast.spec.scope.resourceIds.length > 0) {
    lines.push('    resourceIds:');
    for (const rid of ast.spec.scope.resourceIds) {
      lines.push(`      - ${q(rid)}`);
    }
  }
  lines.push('  destination:');
  lines.push('    engine: tdengine');
  lines.push(`    dbStrategy: ${q(ast.spec?.destination?.dbStrategy || 'tenant_isolated')}`);
  lines.push('  datasets:');
  for (const ds of ast.spec?.datasets || []) {
    lines.push(`    - key: ${q(ds.key || 'dataset_1')}`);
    if (ds.displayName) lines.push(`      displayName: ${q(ds.displayName)}`);
    if (ds.description) lines.push(`      description: ${q(ds.description)}`);
    lines.push(`      semantics: ${q(ds.semantics || 'state_series')}`);
    lines.push(`      sourceKind: ${q(ds.sourceKind || 'signals')}`);
    lines.push(`      timeAxis: ${q(ds.timeAxis || 'acquired_at')}`);
    if (ds.tags && ds.tags.length > 0) {
      lines.push('      tags:');
      for (const t of ds.tags) {
        lines.push(`        - key: ${q(t.key)}`);
        lines.push(`          value: ${q(t.value || '')}`);
      }
    }
    if (!ds.fields || ds.fields.length === 0) {
      lines.push('      fields: []');
    } else {
      lines.push('      fields:');
      for (const f of ds.fields) {
        lines.push(`        - key: ${q(f.key)}`);
        lines.push(`          from: ${q(f.from)}`);
        lines.push(`          type: ${q(f.type || 'float64')}`);
        lines.push(`          sourceKind: ${q(f.sourceKind || 'signal')}`);
        if (f.displayName) lines.push(`          displayName: ${q(f.displayName)}`);
        if (f.unit) lines.push(`          unit: ${q(f.unit)}`);
        if (f.transform) lines.push(`          transform: ${q(f.transform)}`);
        if (f.maxLength != null) lines.push(`          maxLength: ${Number(f.maxLength)}`);
        if (f.signalId) lines.push(`          signalId: ${q(f.signalId)}`);
        if (f.modelId) lines.push(`          modelId: ${q(f.modelId)}`);
        if (f.modelFieldPath) lines.push(`          modelFieldPath: ${q(f.modelFieldPath)}`);
        if (f.resourceId) lines.push(`          resourceId: ${q(f.resourceId)}`);
        lines.push(`          nullable: ${f.nullable !== false ? 'true' : 'false'}`);
        lines.push(`          required: ${f.required ? 'true' : 'false'}`);
      }
    }
    lines.push('      recording:');
    lines.push(`        mode: ${q(ds.recording?.mode || 'ON_CHANGE')}`);
    lines.push(`        qualityTransitions: ${ds.recording?.qualityTransitions !== false ? 'true' : 'false'}`);
    lines.push(`        missingPolicy: ${q(ds.recording?.missingPolicy || 'GAP_MARKER')}`);
    if (ds.recording?.deadband && ds.recording.deadband.value >= 0) {
      lines.push('        deadband:');
      lines.push(`          kind: ${q(ds.recording.deadband.kind || 'absolute')}`);
      lines.push(`          value: ${Number(ds.recording.deadband.value)}`);
    }
    if (ds.recording?.maxCheckpointInterval) {
      lines.push(`        maxCheckpointInterval: ${q(ds.recording.maxCheckpointInterval)}`);
    }
    if (ds.recording?.interval) {
      lines.push(`        interval: ${q(ds.recording.interval)}`);
    }
    if (ds.recording?.lateTolerance) {
      lines.push(`        lateTolerance: ${q(ds.recording.lateTolerance)}`);
    }
    lines.push('      retention:');
    lines.push(`        days: ${Number(ds.retention?.days || 90)}`);
    lines.push(`        legalHold: ${ds.retention?.legalHold ? 'true' : 'false'}`);
  }
  return lines.join('\n') + '\n';
}

export function normalizeAst(raw: Raw | null | undefined, fallbackName = 'plant_telemetry_history'): StorageDesignAst {
  if (!raw || typeof raw !== 'object') {
    return createDefaultStorageDesignAst(fallbackName);
  }
  const metaRaw = (raw.metadata || {}) as Raw;
  const specRaw = (raw.spec || {}) as Raw;
  const scopeRaw = (specRaw.scope || {}) as Raw;
  const destRaw = (specRaw.destination || {}) as Raw;
  const dsRawList = asArray<Raw>(specRaw.datasets);

  const datasets: DatasetAst[] = dsRawList.map((ds, idx) => {
    const recRaw = (ds.recording || ds.policy_json || {}) as Raw;
    const retRaw = (ds.retention || ds.retention_json || {}) as Raw;
    const dbRaw = recRaw.deadband;
    let deadband: DeadbandSpec | null = null;
    if (typeof dbRaw === 'number') {
      deadband = { kind: 'absolute', value: dbRaw };
    } else if (dbRaw && typeof dbRaw === 'object') {
      deadband = {
        kind: dbRaw.kind === 'percent' ? 'percent' : 'absolute',
        value: num(dbRaw.value, 0),
      };
    }

    const fields: FieldAst[] = asArray<Raw>(ds.fields || ds.field_bindings).map((f, fIdx) => ({
      key: str(f.key || f.field_key, `field_${fIdx + 1}`),
      from: str(f.from || f.fromRef || f.from_ref || f.source_ref, ''),
      type: (str(f.type || f.valueType || f.value_type, 'float64') as StorageValueType) || 'float64',
      displayName: str(f.displayName || f.display_name, ''),
      description: str(f.description, ''),
      nullable: f.nullable !== false,
      required: Boolean(f.required),
      unit: f.unit != null ? str(f.unit) : null,
      maxLength: f.maxLength != null ? num(f.maxLength) : f.max_length != null ? num(f.max_length) : null,
      transform:
        typeof f.transform === 'string'
          ? f.transform
          : f.transform_json && typeof f.transform_json === 'object' && f.transform_json.expr
            ? str(f.transform_json.expr)
            : null,
      sourceKind: (str(
        f.sourceKind || f.source_kind,
        str(f.from || f.source_ref).startsWith('$model[') || str(f.from || f.source_ref).startsWith('{{model:')
          ? 'model_field'
          : 'signal',
      ) as FieldAst['sourceKind']),
      signalId: f.signalId || f.signal_id ? str(f.signalId || f.signal_id) : null,
      modelId: f.modelId || f.model_id ? str(f.modelId || f.model_id) : null,
      modelFieldPath: f.modelFieldPath || f.model_field_path ? str(f.modelFieldPath || f.model_field_path) : null,
      resourceId: f.resourceId || f.resource_id ? str(f.resourceId || f.resource_id) : null,
      sourceRevision: num(f.sourceRevision || f.source_revision, 1),
    }));

    return {
      id: ds.id ? str(ds.id) : null,
      key: str(ds.key || ds.dataset_key, `dataset_${idx + 1}`),
      displayName: str(ds.displayName || ds.display_name, ''),
      description: str(ds.description, ''),
      semantics: (str(ds.semantics, 'state_series') as DatasetAst['semantics']) || 'state_series',
      sourceKind: (str(ds.sourceKind || ds.source_kind, 'signals') as DatasetSourceKind) || 'signals',
      timeAxis: (str(ds.timeAxis || ds.time_axis, 'acquired_at') as TimeAxisMode) || 'acquired_at',
      tags: asArray<Raw>(ds.tags || ds.tags_json).map((t) => ({
        key: str(t.key),
        value: str(t.value),
      })),
      fields,
      relationships: asArray<Raw>(ds.relationships).map((r, rIdx) => ({
        id: str(r.id, `rel-${rIdx}`),
        from: str(r.from || r.from_node),
        to: str(r.to || r.to_node),
        kind: (str(r.kind, 'mapped_from') as RelationshipAst['kind']) || 'mapped_from',
        description: str(r.description, ''),
      })),
      recording: {
        mode: (str(recRaw.mode || ds.recording_mode, 'ON_CHANGE').toUpperCase() as RecordingMode) || 'ON_CHANGE',
        qualityTransitions: true,
        deadband,
        maxCheckpointInterval:
          recRaw.maxCheckpointInterval !== undefined
            ? recRaw.maxCheckpointInterval
            : recRaw.max_checkpoint_interval !== undefined
              ? recRaw.max_checkpoint_interval
              : '60s',
        interval: recRaw.interval || null,
        lateTolerance:
          recRaw.lateTolerance !== undefined
            ? recRaw.lateTolerance
            : recRaw.late_tolerance !== undefined
              ? recRaw.late_tolerance
              : '300s',
        missingPolicy:
          (str(recRaw.missingPolicy || recRaw.missing_policy, 'GAP_MARKER').toUpperCase() as MissingPolicyMode) ||
          'GAP_MARKER',
      },
      retention: {
        days: num(retRaw.days ?? ds.retention_days, 90),
        legalHold: Boolean(retRaw.legalHold ?? retRaw.legal_hold ?? ds.legal_hold),
      },
    };
  });

  return {
    apiVersion: str(raw.apiVersion || raw.api_version, 'factorix.io/storage/v1'),
    kind: str(raw.kind, 'StorageDesign'),
    metadata: {
      name: str(metaRaw.name || raw.name, fallbackName),
      description: str(metaRaw.description ?? raw.description, ''),
      owner: metaRaw.owner ? str(metaRaw.owner) : null,
      labels: metaRaw.labels && typeof metaRaw.labels === 'object' ? (metaRaw.labels as Record<string, string>) : {},
    },
    spec: {
      scope: {
        mode: (str(scopeRaw.mode, 'all_sites') as ScopeMode) || 'all_sites',
        resource: scopeRaw.resource ? str(scopeRaw.resource) : null,
        siteId: scopeRaw.siteId || scopeRaw.site_id ? str(scopeRaw.siteId || scopeRaw.site_id) : null,
        resourceIds: asArray<string>(scopeRaw.resourceIds || scopeRaw.resource_ids).map(String),
      },
      destination: {
        engine: 'tdengine',
        dbStrategy: str(destRaw.dbStrategy || destRaw.db_strategy, 'tenant_isolated'),
      },
      datasets: datasets.length > 0 ? datasets : createDefaultStorageDesignAst(fallbackName).spec.datasets,
      uiMeta: (specRaw.uiMeta || specRaw.ui_meta || {}) as Record<string, unknown>,
    },
  };
}

function normalizeSummary(r: Raw): StorageDesignSummary {
  const ast = r.ast || r.draft_ast_json || r.ast_json;
  const dsList = asArray<Raw>(r.datasets || ast?.spec?.datasets);
  const modes = Array.from(
    new Set(
      (
        asArray<string>(r.recording_modes).length
          ? asArray<string>(r.recording_modes)
          : dsList.map((d) => str(d.recording?.mode || d.recording_mode || 'ON_CHANGE'))
      ).map((m) => m.toUpperCase() as RecordingMode),
    ),
  );
  const primaryMode: RecordingMode =
    (str(r.primary_recording_mode || r.recording_mode || modes[0], 'ON_CHANGE').toUpperCase() as RecordingMode) ||
    'ON_CHANGE';
  const retentionDays = num(
    r.retention_days ?? dsList[0]?.retention?.days ?? dsList[0]?.retention_days,
    90,
  );
  const legalHold = Boolean(
    r.legal_hold ?? dsList.some((d) => Boolean(d.retention?.legalHold ?? d.retention?.legal_hold ?? d.legal_hold)),
  );
  const fieldCount =
    r.field_count !== undefined
      ? num(r.field_count)
      : dsList.reduce((acc, d) => acc + asArray(d.fields || d.field_bindings).length, 0);

  return {
    id: str(r.id),
    tenant_id: r.tenant_id ? str(r.tenant_id) : undefined,
    name: str(r.name || ast?.metadata?.name, 'Untitled Storage Design'),
    description: str(r.description ?? ast?.metadata?.description, ''),
    status: (str(r.status, 'DRAFT').toUpperCase() as StorageDesignStatus) || 'DRAFT',
    current_version: num(r.current_version ?? r.version, 1),
    draft_revision: num(r.draft_revision, 1),
    published_version: r.published_version != null ? num(r.published_version) : null,
    published_version_id: r.published_version_id ? str(r.published_version_id) : null,
    scope: (r.scope || r.scope_json || ast?.spec?.scope || { mode: 'all_sites' }) as ScopeSpec,
    scope_summary: str(r.scope_summary || r.scope?.mode || r.scope_json?.mode, 'all_sites'),
    dataset_count: r.dataset_count !== undefined ? num(r.dataset_count) : Math.max(1, dsList.length),
    field_count: fieldCount,
    signal_count: num(r.signal_count, fieldCount),
    model_count: num(r.model_count, 0),
    recording_modes: modes.length ? modes : [primaryMode],
    primary_recording_mode: primaryMode,
    retention_days: retentionDays,
    legal_hold: legalHold,
    destination: 'TDengine',
    td_database: r.td_database ? str(r.td_database) : undefined,
    health: str(r.health || r.status, 'DRAFT'),
    owner_id: r.owner_id ? str(r.owner_id) : null,
    created_at: r.created_at ? str(r.created_at) : undefined,
    updated_at: r.updated_at ? str(r.updated_at) : undefined,
    published_at: r.published_at ? str(r.published_at) : null,
    archived_at: r.archived_at ? str(r.archived_at) : null,
  };
}

function normalizeDependencies(designId: string, raw: Raw | null | undefined): StorageDependenciesResponse {
  if (!raw || typeof raw !== 'object') {
    return {
      design_id: designId,
      signals: [],
      resources: [],
      data_models: [],
      saved_views: [],
      exports: [],
      total_count: 0,
    };
  }
  const mapDep = (item: Raw, defaultType: StorageDependencyItem['type']): StorageDependencyItem => ({
    id: str(item.id || item.target_id || item.signal_id || item.resource_id || item.model_id),
    type: (str(item.type || item.target_type, defaultType) as StorageDependencyItem['type']) || defaultType,
    target_id: str(item.target_id || item.id || item.signal_id || item.resource_id || item.model_id),
    name: str(item.name || item.display_name || item.key || item.file_name || item.target_id, 'Unnamed'),
    key: item.key ? str(item.key) : undefined,
    subpath: item.subpath || item.target_subpath || item.model_field_path ? str(item.subpath || item.target_subpath || item.model_field_path) : undefined,
    status: item.status || item.state ? str(item.status || item.state) : undefined,
    protocol: item.protocol ? str(item.protocol) : undefined,
    resource_name: item.resource_name ? str(item.resource_name) : undefined,
    kind: str(item.kind, 'reads_from'),
  });

  const signals = asArray<Raw>(raw.signals).map((x) => mapDep(x, 'signal'));
  const resources = asArray<Raw>(raw.resources).map((x) => mapDep(x, 'resource'));
  const data_models = asArray<Raw>(raw.data_models || raw.models).map((x) => mapDep(x, 'data_model'));
  const saved_views = asArray<Raw>(raw.saved_views || raw.views).map((x) => mapDep(x, 'saved_view'));
  const exportsList = asArray<Raw>(raw.exports || raw.export_jobs).map((x) => mapDep(x, 'export'));

  return {
    design_id: str(raw.design_id, designId),
    signals,
    resources,
    data_models,
    saved_views,
    exports: exportsList,
    total_count:
      raw.total_count !== undefined
        ? num(raw.total_count)
        : signals.length + resources.length + data_models.length + saved_views.length + exportsList.length,
  };
}

function normalizeCompiledPlan(raw: Raw | null | undefined): CompiledStoragePlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const datasets: CompiledDatasetPlan[] = asArray<Raw>(raw.datasets).map((d) => {
    const cols = asArray<Raw>(d.columns).map((c) => ({
      key: str(c.key),
      value_type: str(c.value_type || c.type, 'float64'),
      td_type: str(c.td_type, 'DOUBLE'),
      nullable: c.nullable !== false,
      bytes: c.bytes != null ? num(c.bytes) : undefined,
    }));
    const rowWidth =
      d.row_width_bytes != null
        ? num(d.row_width_bytes)
        : 900 + cols.reduce((acc, c) => acc + (c.bytes ?? (c.td_type.startsWith('NCHAR') ? 4100 : 9)), 0);
    return {
      dataset_id: str(d.dataset_id || d.id),
      dataset_key: str(d.dataset_key || d.key),
      td_stable: str(d.td_stable),
      schema_epoch: num(d.schema_epoch, 1),
      semantics: str(d.semantics, 'state_series'),
      recording_mode: (str(d.recording_mode, 'ON_CHANGE').toUpperCase() as RecordingMode) || 'ON_CHANGE',
      retention_days: num(d.retention_days, 90),
      legal_hold: Boolean(d.legal_hold),
      row_width_bytes: rowWidth,
      max_row_width_bytes: num(d.max_row_width_bytes, 64500),
      columns: cols,
      tags: asArray<Raw>(d.tags).map((t) => ({
        key: str(t.key),
        td_type: str(t.td_type, 'NCHAR(128)'),
        value: t.value != null ? str(t.value) : undefined,
      })),
      subtable_count: d.subtable_count != null ? num(d.subtable_count) : undefined,
      physical_schema_hash: str(d.physical_schema_hash),
    };
  });

  const series: CompiledSeries[] = asArray<Raw>(raw.series).map((s) => ({
    dataset_key: str(s.dataset_key),
    series_key: str(s.series_key),
    field_key: str(s.field_key),
    value_type: str(s.value_type, 'float64'),
    td_database: str(s.td_database || raw.td_database),
    td_stable: str(s.td_stable),
    td_subtable: str(s.td_subtable),
    signal_id: s.signal_id ? str(s.signal_id) : null,
    model_id: s.model_id ? str(s.model_id) : null,
    model_field_path: s.model_field_path ? str(s.model_field_path) : null,
    physical_schema_hash: str(s.physical_schema_hash),
    tags: (s.tags && typeof s.tags === 'object' ? s.tags : {}) as Record<string, string>,
  }));

  const maxDatasetRowWidth = datasets.reduce((max, d) => Math.max(max, d.row_width_bytes || 900), 900);
  const diffRaw = (raw.diff || {}) as Raw;
  const ddlStatements = asArray<string>(raw.ddl_statements).map(String);

  const actions = asArray<Raw>(diffRaw.actions).length
    ? asArray<Raw>(diffRaw.actions).map((a) => ({
        action: (str(a.action, 'CREATE_STABLE') as NonNullable<SchemaDiff['actions']>[number]['action']),
        target: str(a.target),
        ddl: a.ddl ? str(a.ddl) : undefined,
        description: a.description ? str(a.description) : undefined,
      }))
    : [
        ...datasets.map((d) => ({
          action: 'CREATE_STABLE' as const,
          target: `${str(raw.td_database, 'fx_t_tenant')}.${d.td_stable}`,
          description: `Ensure supertable ${d.td_stable} (${d.columns.length} value columns)`,
        })),
        ...asArray<string>(diffRaw.ddl_statements).map((stmt) => ({
          action: 'ADD_COLUMN' as const,
          target: str(raw.td_database, 'fx_t_tenant'),
          ddl: String(stmt),
          description: String(stmt),
        })),
        ...series.map((s) => ({
          action: 'ENSURE_SUBTABLE' as const,
          target: `${s.td_database}.${s.td_subtable}`,
          description: `Bind series ${s.series_key} -> subtable ${s.td_subtable} USING ${s.td_stable}`,
        })),
      ];

  const impactRaw = (raw.impact || {}) as Raw;

  return {
    compiler_version: str(raw.compiler_version, '1.0.0'),
    td_database: str(raw.td_database, 'fx_t_default'),
    destination: 'TDengine',
    semantic_hash: str(raw.semantic_hash),
    ast_hash: str(raw.ast_hash || raw.semantic_hash),
    plan_hash: str(raw.plan_hash),
    row_width_bytes: num(raw.row_width_bytes, maxDatasetRowWidth),
    max_row_width_bytes: num(raw.max_row_width_bytes, 64500),
    ddl_statements: ddlStatements,
    datasets,
    series,
    diff: {
      is_breaking: Boolean(diffRaw.is_breaking),
      breaking_changes: asArray<string>(diffRaw.breaking_changes).map(String),
      non_breaking_changes: asArray<string>(diffRaw.non_breaking_changes).map(String),
      ddl_statements: asArray<string>(diffRaw.ddl_statements).map(String),
      actions,
    },
    impact: {
      dataset_count: num(impactRaw.dataset_count, datasets.length),
      series_count: num(impactRaw.series_count, series.length),
      field_count: num(
        impactRaw.field_count,
        datasets.reduce((acc, d) => acc + d.columns.length, 0),
      ),
      estimated_daily_rows_min: num(impactRaw.estimated_daily_rows_min, 0),
      estimated_daily_rows_max: num(impactRaw.estimated_daily_rows_max, 0),
      estimated_daily_bytes_min: num(impactRaw.estimated_daily_bytes_min, 0),
      estimated_daily_bytes_max: num(impactRaw.estimated_daily_bytes_max, 0),
      assumptions: str(impactRaw.assumptions, 'Projected from mapped series and recording mode.'),
    },
    warnings: asArray<string>(raw.warnings).map(String),
  };
}

function normalizeDetail(r: Raw): StorageDesignDetail {
  const summary = normalizeSummary(r);
  const rawAst = r.ast || r.draft_ast_json || r.ast_json || {
    apiVersion: 'factorix.io/storage/v1',
    kind: 'StorageDesign',
    metadata: { name: summary.name, description: summary.description },
    spec: {
      scope: summary.scope,
      destination: { engine: 'tdengine', dbStrategy: 'tenant_isolated' },
      datasets: r.datasets || [],
    },
  };
  const ast = normalizeAst(rawAst, summary.name);
  const yaml = typeof r.yaml === 'string' && r.yaml.trim() ? r.yaml : serializeAstToYaml(ast);

  const versions: StorageDesignVersion[] = asArray<Raw>(r.versions).map((v) => ({
    id: str(v.id),
    design_id: str(v.design_id, summary.id),
    version: num(v.version, 1),
    ast_json: v.ast_json,
    ast_hash: str(v.ast_hash),
    semantic_hash: str(v.semantic_hash),
    compiler_version: str(v.compiler_version, '1.0.0'),
    ddl_plan_json: v.ddl_plan_json,
    plan_hash: str(v.plan_hash),
    publish_state: (str(v.publish_state, 'APPLIED').toUpperCase() as StorageDesignVersion['publish_state']),
    effective_from_epoch: num(v.effective_from_epoch, 1),
    effective_at: v.effective_at ? str(v.effective_at) : null,
    created_by: v.created_by ? str(v.created_by) : null,
    created_at: str(v.created_at),
    applied_at: v.applied_at ? str(v.applied_at) : null,
    diagnostics_json: v.diagnostics_json,
  }));

  const physical_registry: StoragePhysicalEntry[] = asArray<Raw>(r.physical_registry || r.registry).map((p) => ({
    id: str(p.id || `${p.td_database}:${p.td_subtable}`),
    tier: (str(p.tier, 'MANAGED').toUpperCase() as StoragePhysicalEntry['tier']),
    design_id: p.design_id ? str(p.design_id) : summary.id,
    dataset_id: p.dataset_id ? str(p.dataset_id) : null,
    dataset_key: p.dataset_key ? str(p.dataset_key) : undefined,
    signal_id: p.signal_id ? str(p.signal_id) : null,
    series_key: str(p.series_key),
    field_key: p.field_key ? str(p.field_key) : undefined,
    value_type: str(p.value_type, 'float64'),
    td_database: str(p.td_database),
    td_stable: str(p.td_stable),
    td_subtable: str(p.td_subtable),
    physical_schema_hash: str(p.physical_schema_hash),
    generation: num(p.generation, 1),
    status: (str(p.status, 'ACTIVE').toUpperCase() as StoragePhysicalEntry['status']),
    created_at: p.created_at ? str(p.created_at) : undefined,
    updated_at: p.updated_at ? str(p.updated_at) : undefined,
  }));

  const operations: StorageOperation[] = asArray<Raw>(r.operations).map((op) => ({
    id: str(op.id),
    tenant_id: op.tenant_id ? str(op.tenant_id) : undefined,
    operation_type: str(op.operation_type || op.kind),
    target_type: str(op.target_type, 'storage_design'),
    target_id: op.target_id ? str(op.target_id) : summary.id,
    design_id: op.design_id ? str(op.design_id) : summary.id,
    design_name: op.design_name ? str(op.design_name) : summary.name,
    actor_id: op.actor_id ? str(op.actor_id) : null,
    status: (str(op.status, 'COMPLETED').toUpperCase() as StorageOperation['status']),
    requested_at: str(op.requested_at || op.created_at),
    started_at: op.started_at ? str(op.started_at) : null,
    completed_at: op.completed_at ? str(op.completed_at) : null,
    step_state_json: op.step_state_json,
    error_code: op.error_code ? str(op.error_code) : null,
    error_message: op.error_message ? str(op.error_message) : null,
    trace_id: op.trace_id ? str(op.trace_id) : undefined,
  }));

  const validation_issues: DslIssue[] = asArray<Raw>(
    r.validation_issues || r.issues || r.last_validation_json?.issues,
  ).map((i) => ({
    severity: (str(i.severity, 'error') as DslIssue['severity']),
    code: str(i.code, 'VALIDATION_ISSUE'),
    message: str(i.message),
    path: str(i.path),
    line: i.line != null ? num(i.line) : null,
    column: i.column != null ? num(i.column) : null,
  }));

  return {
    ...summary,
    ast,
    yaml,
    datasets: ast.spec.datasets,
    versions,
    physical_registry,
    physical_plan: normalizeCompiledPlan(r.physical_plan || versions[0]?.ddl_plan_json),
    operations,
    dependencies: normalizeDependencies(summary.id, r.dependencies),
    validation_issues,
  };
}

// ============================================================================
// S10 & S11 Storage Designer & Catalog API Functions
// ============================================================================

export interface ListStorageDesignsParams {
  status?: string;
  search?: string;
  scope?: string;
  mode?: string;
  retention?: string;
  updated?: string;
  limit?: number;
  cursor?: string;
}

export async function listStorageDesigns(params: ListStorageDesignsParams = {}): Promise<StorageDesignsListResponse> {
  const qs = new URLSearchParams();
  if (params.status && params.status !== 'all' && params.status !== 'ALL') qs.set('status', params.status);
  if (params.search?.trim()) qs.set('search', params.search.trim());
  if (params.scope && params.scope !== 'all') qs.set('scope', params.scope);
  if (params.mode && params.mode !== 'all') qs.set('mode', params.mode);
  if (params.retention && params.retention !== 'all') qs.set('retention', params.retention);
  if (params.updated) qs.set('updated', params.updated);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);

  const query = qs.toString();
  const res = await api<Raw>(`/api/v1/storage/designs${query ? `?${query}` : ''}`);
  const items = asArray<Raw>(res?.items ?? res).map(normalizeSummary);
  const countsRaw = (res?.counts || res?.summary || {}) as Raw;
  const covRaw = (res?.coverage || countsRaw?.coverage || {}) as Raw;

  const running = countsRaw.running !== undefined ? num(countsRaw.running) : items.filter((x) => x.status === 'RUNNING').length;
  const drafts = countsRaw.drafts !== undefined ? num(countsRaw.drafts) : items.filter((x) => x.status === 'DRAFT' || x.status === 'VALIDATED').length;
  const paused = countsRaw.paused !== undefined ? num(countsRaw.paused) : items.filter((x) => x.status === 'PAUSED').length;
  const archived = countsRaw.archived !== undefined ? num(countsRaw.archived) : items.filter((x) => x.status === 'ARCHIVED' || x.status === 'RETIRED').length;
  const all = countsRaw.all !== undefined ? num(countsRaw.all) : items.length;

  return {
    items,
    counts: {
      all,
      running,
      drafts,
      paused,
      archived,
      needs_review: num(countsRaw.needs_review, items.filter((x) => x.status === 'ERROR').length),
    },
    coverage: {
      signals_mapped: num(covRaw.signals_mapped ?? covRaw.mapped_signals, 0),
      signals_total: num(covRaw.signals_total ?? covRaw.total_signals, 336),
      models_mapped: num(covRaw.models_mapped ?? covRaw.mapped_models, 0),
      models_total: num(covRaw.models_total ?? covRaw.total_models, 36),
      operational_signals_active: num(covRaw.operational_signals_active, num(covRaw.signals_total, 336)),
    },
    recent_publishes: asArray<Raw>(res?.recent_publishes).map((p) => ({
      design_id: str(p.design_id || p.id),
      design_name: str(p.design_name || p.name),
      version: num(p.version, 1),
      published_at: str(p.published_at || p.applied_at || p.created_at),
      status: str(p.status, 'APPLIED'),
    })),
    next_cursor: res?.next_cursor ? str(res.next_cursor) : null,
  };
}

export interface CreateStorageDesignPayload {
  name?: string;
  description?: string;
  ast?: StorageDesignAst | Record<string, unknown>;
  dsl?: string;
  yaml?: string;
  format?: 'yaml' | 'json' | 'auto';
  ui_meta?: Record<string, unknown>;
}

export async function createStorageDesign(payload: CreateStorageDesignPayload): Promise<StorageDesignDetail> {
  const res = await api<Raw>('/api/v1/storage/designs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return normalizeDetail(res?.design || res);
}

export async function getStorageDesign(designId: string): Promise<StorageDesignDetail> {
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}`);
  return normalizeDetail(res?.design || res);
}

export interface UpdateStorageDesignPayload {
  name?: string;
  description?: string;
  ast?: StorageDesignAst | Record<string, unknown>;
  dsl?: string;
  yaml?: string;
  format?: 'yaml' | 'json' | 'auto';
  ui_meta?: Record<string, unknown>;
  expected_version?: number;
  version?: number;
}

export async function updateStorageDesign(
  designId: string,
  payload: UpdateStorageDesignPayload,
): Promise<StorageDesignDetail> {
  const headers: Record<string, string> = {};
  const expectedVer = payload.expected_version ?? payload.version;
  if (expectedVer !== undefined) {
    headers['If-Match'] = String(expectedVer);
  }
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      ...payload,
      expected_version: expectedVer,
      version: expectedVer,
    }),
  });
  return normalizeDetail(res?.design || res);
}

export interface ValidateStorageDesignPayload {
  ast?: StorageDesignAst | Record<string, unknown>;
  dsl?: string;
  yaml?: string;
  format?: 'yaml' | 'json' | 'auto';
}

export async function validateStorageDesign(
  payload: ValidateStorageDesignPayload,
  designId?: string | null,
): Promise<ValidateDesignResponse> {
  const path = designId
    ? `/api/v1/storage/designs/${encodeURIComponent(designId)}/validate`
    : '/api/v1/storage/designs/validate';
  const res = await api<Raw>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const issues: DslIssue[] = asArray<Raw>(res?.issues || res?.errors).map((i) => ({
    severity: (str(i.severity, 'error') as DslIssue['severity']),
    code: str(i.code, 'INVALID_DSL'),
    message: str(i.message),
    path: str(i.path),
    line: i.line != null ? num(i.line) : null,
    column: i.column != null ? num(i.column) : null,
  }));
  const rawAst = res?.ast || res?.normalized_ast || payload.ast;
  const ast = rawAst ? normalizeAst(rawAst as Raw) : null;
  const yaml = typeof res?.yaml === 'string' && res.yaml.trim() ? res.yaml : ast ? serializeAstToYaml(ast) : str(payload.yaml || payload.dsl);
  const valid = res?.valid !== undefined ? Boolean(res.valid) : !issues.some((i) => i.severity === 'error');
  return {
    valid,
    ast,
    yaml,
    issues,
    semantic_hash: res?.semantic_hash ? str(res.semantic_hash) : undefined,
    ast_hash: res?.ast_hash ? str(res.ast_hash) : undefined,
    row_width_bytes: res?.row_width_bytes != null ? num(res.row_width_bytes) : undefined,
    max_row_width_bytes: num(res?.max_row_width_bytes, 64500),
    dataset_row_widths:
      res?.dataset_row_widths && typeof res.dataset_row_widths === 'object'
        ? (res.dataset_row_widths as Record<string, number>)
        : undefined,
  };
}

export async function compileStoragePhysicalPlan(
  designId: string | null | undefined,
  payload?: ValidateStorageDesignPayload,
): Promise<CompiledStoragePlan> {
  const path = designId
    ? `/api/v1/storage/designs/${encodeURIComponent(designId)}/physical-plan`
    : '/api/v1/storage/designs/physical-plan';
  const res = await api<Raw>(path, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
  const plan = normalizeCompiledPlan(res?.plan || res);
  if (!plan) {
    throw new Error('Could not compile physical TDengine plan.');
  }
  return plan;
}

export interface SimulateStorageDesignPayload extends ValidateStorageDesignPayload {
  dataset_key?: string;
  limit?: number;
  window_minutes?: number;
  samples?: Array<Record<string, unknown>>;
}

export async function simulateStorageDesign(
  designId: string | null | undefined,
  payload?: SimulateStorageDesignPayload,
): Promise<SimulateDesignResponse> {
  const path = designId
    ? `/api/v1/storage/designs/${encodeURIComponent(designId)}/simulate`
    : '/api/v1/storage/designs/simulate';
  const res = await api<Raw>(path, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
  const evaluated = num(res?.evaluated_samples ?? res?.acquired_evaluated ?? res?.total_samples, 0);
  const wouldWrite = num(res?.would_write ?? res?.managed_written ?? res?.written_count, 0);
  const skippedTotal = num(res?.skipped_total ?? res?.skipped_count, Math.max(0, evaluated - wouldWrite));
  const reductionPct =
    res?.estimated_reduction_pct !== undefined
      ? num(res.estimated_reduction_pct)
      : evaluated > 0
        ? Math.round(((evaluated - wouldWrite) / evaluated) * 1000) / 10
        : 0;
  const samples: SimulateSampleRow[] = asArray<Raw>(res?.samples || res?.preview_rows || res?.decisions).map(
    (s, idx) => ({
      index: num(s.index, idx + 1),
      ts: str(s.ts || s.acquired_at || s.event_time),
      acquired_at: s.acquired_at ? str(s.acquired_at) : undefined,
      source_time: s.source_time ? str(s.source_time) : null,
      dataset_key: str(s.dataset_key, 'default'),
      field_key: str(s.field_key, 'value'),
      source_ref: str(s.source_ref || s.signal_key || s.signal_id),
      signal_id: s.signal_id ? str(s.signal_id) : null,
      raw_value: s.raw_value !== undefined ? s.raw_value : s.value,
      transformed_value: s.transformed_value !== undefined ? s.transformed_value : s.value,
      quality: str(s.quality || s.raw_quality, 'GOOD'),
      reason_code: s.reason_code ? str(s.reason_code) : null,
      would_write: Boolean(s.would_write ?? s.write_row),
      record_kind: str(s.record_kind, s.would_write ? 'change' : 'skipped'),
      skip_reason: str(s.skip_reason, s.would_write ? 'NONE' : 'UNCHANGED'),
    }),
  );

  return {
    evaluated_samples: evaluated,
    would_write: wouldWrite,
    skipped_total: skippedTotal,
    skipped_by_reason:
      res?.skipped_by_reason && typeof res.skipped_by_reason === 'object'
        ? (res.skipped_by_reason as Record<string, number>)
        : {},
    checkpoints_written: num(res?.checkpoints_written ?? res?.managed_checkpoints, 0),
    gap_markers_written: num(res?.gap_markers_written ?? res?.managed_gap_markers, 0),
    estimated_reduction_pct: reductionPct,
    compression_ratio: num(res?.compression_ratio, evaluated > 0 && wouldWrite > 0 ? +(evaluated / wouldWrite).toFixed(2) : 1),
    estimated_bytes_per_day: res?.estimated_bytes_per_day != null ? num(res.estimated_bytes_per_day) : undefined,
    exactness_warnings: asArray<string>(res?.exactness_warnings || res?.warnings).map(String),
    samples,
  };
}

export async function publishStorageDesign(
  designId: string,
  payload: { expected_version?: number; reason?: string; idempotency_key?: string } = {},
): Promise<PublishDesignResponse> {
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return {
    design_id: str(res?.design_id || res?.id, designId),
    status: (str(res?.status, 'RUNNING').toUpperCase() as StorageDesignStatus),
    version: num(res?.version ?? res?.current_version, 1),
    version_id: str(res?.version_id || res?.published_version_id),
    operation_id: str(res?.operation_id),
    semantic_hash: str(res?.semantic_hash),
    plan_hash: str(res?.plan_hash),
    td_database: str(res?.td_database),
    applied_statements: num(res?.applied_statements, 0),
    verified_subtables: num(res?.verified_subtables, 0),
    published_at: str(res?.published_at || res?.effective_at || new Date().toISOString()),
  };
}

export async function pauseStorageDesign(designId: string, reason?: string): Promise<StorageDesignDetail> {
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || 'Paused by operator' }),
  });
  return normalizeDetail(res?.design || res);
}

export async function resumeStorageDesign(designId: string, reason?: string): Promise<StorageDesignDetail> {
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || 'Resumed by operator' }),
  });
  return normalizeDetail(res?.design || res);
}

export async function duplicateStorageDesign(
  designId: string,
  payload: string | { name?: string; description?: string } = {},
): Promise<StorageDesignDetail> {
  const body = typeof payload === 'string' ? { name: payload } : payload;
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return normalizeDetail(res?.design || res);
}

export async function archiveStorageDesign(
  designId: string,
  payload: { force?: boolean; reason?: string } = {},
): Promise<StorageDesignDetail> {
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}/archive`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return normalizeDetail(res?.design || res);
}

export async function restoreStorageDesign(
  designId: string,
  payload: { target_status?: 'PAUSED' | 'DRAFT' } = {},
): Promise<StorageDesignDetail> {
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}/restore`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return normalizeDetail(res?.design || res);
}

export async function bulkStorageDesigns(
  action: 'pause' | 'resume' | 'archive',
  designIds: string[],
  opts: { force?: boolean; reason?: string } = {},
): Promise<{ affected: number; ids: string[]; errors?: Array<{ id: string; message: string }> }> {
  const res = await api<Raw>('/api/v1/storage/designs/bulk', {
    method: 'POST',
    body: JSON.stringify({
      action,
      design_ids: designIds,
      ...opts,
    }),
  });
  return {
    affected: num(res?.affected ?? res?.updated_count, designIds.length),
    ids: asArray<string>(res?.ids || designIds).map(String),
    errors: asArray<Raw>(res?.errors).map((e) => ({ id: str(e.id), message: str(e.message) })),
  };
}

export async function getStorageDependencies(designId: string): Promise<StorageDependenciesResponse> {
  const res = await api<Raw>(`/api/v1/storage/designs/${encodeURIComponent(designId)}/dependencies`);
  return normalizeDependencies(designId, res);
}

export async function exportStorageDesign(
  designId: string,
  format: 'yaml' | 'json' = 'yaml',
): Promise<ExportDesignBundle> {
  const res = await api<Raw>(
    `/api/v1/storage/designs/${encodeURIComponent(designId)}/export?format=${encodeURIComponent(format)}`,
  );
  const ast = normalizeAst(res?.ast || res?.bundle?.ast || res, str(res?.name, 'exported_design'));
  const content =
    typeof res?.content === 'string'
      ? res.content
      : typeof res?.yaml === 'string'
        ? res.yaml
        : format === 'json'
          ? JSON.stringify(ast, null, 2)
          : serializeAstToYaml(ast);

  return {
    format,
    design_id: str(res?.design_id || res?.id, designId),
    name: str(res?.name, ast.metadata.name),
    version: num(res?.version, 1),
    semantic_hash: str(res?.semantic_hash),
    content,
    ast,
    exported_at: str(res?.exported_at, new Date().toISOString()),
  };
}

export async function importStorageDesign(payload: {
  content?: string;
  dsl?: string;
  yaml?: string;
  ast?: StorageDesignAst | Record<string, unknown>;
  name?: string;
  format?: 'yaml' | 'json' | 'auto';
}): Promise<StorageDesignDetail> {
  const body = {
    ...payload,
    dsl: payload.dsl || payload.content || payload.yaml,
    yaml: payload.yaml || payload.content || payload.dsl,
  };
  const res = await api<Raw>('/api/v1/storage/designs/import', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return normalizeDetail(res?.design || res);
}

export async function getStorageHealth(): Promise<StorageHealthStatus> {
  const res = await api<Raw>('/api/v1/storage/health');
  const tdRaw = (res?.tdengine || {}) as Raw;
  const ingRaw = (res?.ingestion || res?.broker || {}) as Raw;
  const retRaw = (res?.retention || {}) as Raw;
  const topStatus = str(res?.status || tdRaw.status, 'HEALTHY').toUpperCase() as StorageHealthStatus['status'];

  return {
    status: topStatus,
    destination: 'TDengine',
    tdengine: {
      status: (str(tdRaw.status, topStatus).toUpperCase() as StorageHealthStatus['status']),
      reachable: tdRaw.reachable !== false,
      engine: 'TDengine',
      version: tdRaw.version ? str(tdRaw.version) : '3.3.x',
      database: tdRaw.database || tdRaw.td_database ? str(tdRaw.database || tdRaw.td_database) : undefined,
      stables_count: tdRaw.stables_count != null ? num(tdRaw.stables_count) : undefined,
      managed_subtables_count: tdRaw.managed_subtables_count != null ? num(tdRaw.managed_subtables_count) : undefined,
      operational_subtables_count:
        tdRaw.operational_subtables_count != null ? num(tdRaw.operational_subtables_count) : undefined,
      last_write_at: tdRaw.last_write_at ? str(tdRaw.last_write_at) : null,
      write_latency_ms: tdRaw.write_latency_ms != null ? num(tdRaw.write_latency_ms) : null,
      message: tdRaw.message ? str(tdRaw.message) : undefined,
    },
    ingestion: {
      status: (str(ingRaw.status, 'HEALTHY').toUpperCase() as StorageHealthStatus['status']),
      transport: 'RabbitMQ',
      broker_reachable: ingRaw.broker_reachable !== false,
      consumer_ready: ingRaw.consumer_ready !== false,
      queue_depth: ingRaw.queue_depth != null ? num(ingRaw.queue_depth) : 0,
      dlq_depth: ingRaw.dlq_depth != null ? num(ingRaw.dlq_depth) : 0,
      active_epoch: num(ingRaw.active_epoch ?? res?.active_epoch, 1),
      managed_bindings_active:
        ingRaw.managed_bindings_active != null ? num(ingRaw.managed_bindings_active) : undefined,
      last_ingested_at: ingRaw.last_ingested_at ? str(ingRaw.last_ingested_at) : null,
    },
    retention: {
      status: (str(retRaw.status, 'HEALTHY').toUpperCase() as StorageHealthStatus['retention']['status']),
      active_policies_count: retRaw.active_policies_count != null ? num(retRaw.active_policies_count) : undefined,
      legal_holds_count: retRaw.legal_holds_count != null ? num(retRaw.legal_holds_count) : undefined,
      last_run_at: retRaw.last_run_at ? str(retRaw.last_run_at) : null,
    },
    checked_at: str(res?.checked_at, new Date().toISOString()),
  };
}

export async function listStorageOperations(params: {
  design_id?: string;
  kind?: string;
  status?: string;
  limit?: number;
} = {}): Promise<StorageOperation[]> {
  const qs = new URLSearchParams();
  if (params.design_id) qs.set('design_id', params.design_id);
  if (params.kind) qs.set('kind', params.kind);
  if (params.status) qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  const res = await api<Raw>(`/api/v1/storage/operations${query ? `?${query}` : ''}`);
  return asArray<Raw>(res?.items ?? res).map((op) => ({
    id: str(op.id),
    tenant_id: op.tenant_id ? str(op.tenant_id) : undefined,
    operation_type: str(op.operation_type || op.kind),
    target_type: str(op.target_type, 'storage_design'),
    target_id: op.target_id ? str(op.target_id) : null,
    design_id: op.design_id || op.target_id ? str(op.design_id || op.target_id) : null,
    design_name: op.design_name ? str(op.design_name) : null,
    actor_id: op.actor_id ? str(op.actor_id) : null,
    status: (str(op.status, 'COMPLETED').toUpperCase() as StorageOperation['status']),
    requested_at: str(op.requested_at || op.created_at),
    started_at: op.started_at ? str(op.started_at) : null,
    completed_at: op.completed_at ? str(op.completed_at) : null,
    step_state_json: op.step_state_json,
    error_code: op.error_code ? str(op.error_code) : null,
    error_message: op.error_message ? str(op.error_message) : null,
    trace_id: op.trace_id ? str(op.trace_id) : undefined,
  }));
}

export async function previewStorageRetention(
  payload: { design_id?: string; dataset_id?: string; retention_days_override?: number } = {},
): Promise<RetentionPreviewResponse> {
  const res = await api<Raw>('/api/v1/storage/retention/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const datasets: RetentionPreviewDatasetItem[] = asArray<Raw>(res?.datasets || res?.items).map((d) => ({
    dataset_id: str(d.dataset_id || d.id),
    dataset_key: str(d.dataset_key || d.key),
    design_id: str(d.design_id || payload.design_id),
    design_name: str(d.design_name, ''),
    td_stable: str(d.td_stable),
    subtable_count: num(d.subtable_count, 0),
    retention_days: num(d.retention_days, 90),
    legal_hold: Boolean(d.legal_hold),
    cutoff_timestamp: str(d.cutoff_timestamp || d.cutoff_at),
    estimated_expired_rows: num(d.estimated_expired_rows ?? d.expired_rows, 0),
    blocked_by_legal_hold: Boolean(d.blocked_by_legal_hold ?? d.legal_hold),
    status: (str(
      d.status,
      d.legal_hold ? 'BLOCKED_LEGAL_HOLD' : 'READY',
    ).toUpperCase() as RetentionPreviewDatasetItem['status']),
  }));
  const legalHoldDatasets = asArray<string>(res?.legal_hold_datasets).length
    ? asArray<string>(res?.legal_hold_datasets).map(String)
    : datasets.filter((d) => d.legal_hold).map((d) => d.dataset_key);
  const blocked = Boolean(res?.blocked_by_legal_hold ?? legalHoldDatasets.length > 0);
  return {
    design_id: payload.design_id || (res?.design_id ? str(res.design_id) : null),
    can_execute: res?.can_execute !== undefined ? Boolean(res.can_execute) : !blocked,
    blocked_by_legal_hold: blocked,
    legal_hold_datasets: legalHoldDatasets,
    total_subtables_evaluated: num(
      res?.total_subtables_evaluated,
      datasets.reduce((acc, d) => acc + d.subtable_count, 0),
    ),
    total_estimated_expired_rows: num(
      res?.total_estimated_expired_rows,
      datasets.reduce((acc, d) => acc + d.estimated_expired_rows, 0),
    ),
    datasets,
    evaluated_at: str(res?.evaluated_at, new Date().toISOString()),
  };
}

// ============================================================================
// S12 Historian API Functions
// ============================================================================

export async function getHistorianLatest(params: {
  signal_ids?: string[];
  design_id?: string;
  dataset_id?: string;
} = {}): Promise<{ items: HistorianLatestItem[]; active_epoch?: number }> {
  const qs = new URLSearchParams();
  if (params.signal_ids && params.signal_ids.length > 0) {
    qs.set('signal_ids', params.signal_ids.join(','));
  }
  if (params.design_id) qs.set('design_id', params.design_id);
  if (params.dataset_id) qs.set('dataset_id', params.dataset_id);
  const query = qs.toString();
  const res = await api<Raw>(`/api/v1/historian/latest${query ? `?${query}` : ''}`);
  const items: HistorianLatestItem[] = asArray<Raw>(res?.items ?? res).map((r) => ({
    signal_id: str(r.signal_id || r.id),
    key: r.key ? str(r.key) : undefined,
    display_name: r.display_name ? str(r.display_name) : undefined,
    resource_id: r.resource_id ? str(r.resource_id) : undefined,
    resource_name: r.resource_name ? str(r.resource_name) : undefined,
    value: r.value !== undefined ? r.value : r.value_json?.v ?? null,
    value_type: r.value_type ? str(r.value_type) : undefined,
    unit: r.unit != null ? str(r.unit) : null,
    quality: str(r.effective_status || r.quality, 'NO_DATA'),
    reason_code: r.reason_code ? str(r.reason_code) : null,
    source_time: r.source_time ? str(r.source_time) : null,
    last_acquired_at: r.last_acquired_at || r.received_time ? str(r.last_acquired_at || r.received_time) : null,
    last_value_changed_at: r.last_value_changed_at ? str(r.last_value_changed_at) : null,
    data_epoch: r.data_epoch != null ? num(r.data_epoch) : undefined,
    source_health: r.source_health ? str(r.source_health) : undefined,
    connection_health: r.connection_health ? str(r.connection_health) : undefined,
    broker_health: r.broker_health ? str(r.broker_health) : undefined,
    storage_health: r.storage_health ? str(r.storage_health) : undefined,
  }));
  return {
    items,
    active_epoch: res?.active_epoch != null ? num(res.active_epoch) : undefined,
  };
}

export async function queryHistorian(payload: HistorianQueryRequest): Promise<HistorianQueryResponse> {
  const res = await api<Raw>('/api/v1/historian/query', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const mapPoint = (p: Raw): HistorianPoint => ({
    id: p.id ? str(p.id) : undefined,
    ts: str(p.ts || p.event_time || p.acquired_at || p.received_time),
    event_time: p.event_time || p.ts ? str(p.event_time || p.ts) : undefined,
    acquired_at: p.acquired_at || p.received_time ? str(p.acquired_at || p.received_time) : undefined,
    received_time: p.received_time || p.acquired_at ? str(p.received_time || p.acquired_at) : undefined,
    source_time: p.source_time ? str(p.source_time) : null,
    signal_id: str(p.signal_id),
    dataset_id: p.dataset_id ? str(p.dataset_id) : null,
    value: p.value !== undefined ? p.value : p.val,
    value_type: p.value_type ? str(p.value_type) : undefined,
    unit: p.unit != null ? str(p.unit) : null,
    quality: str(p.quality || p.raw_quality, 'GOOD'),
    reason_code: p.reason_code ? str(p.reason_code) : null,
    event_uid: p.event_uid ? str(p.event_uid) : undefined,
    record_kind: p.record_kind ? str(p.record_kind) : undefined,
    virtual: Boolean(p.virtual),
    data_epoch: p.data_epoch != null ? num(p.data_epoch) : undefined,
  });

  const mapStats = (s: Raw): HistorianSeriesStats => ({
    signal_id: str(s.signal_id),
    key: s.key ? str(s.key) : undefined,
    display_name: s.display_name ? str(s.display_name) : undefined,
    unit: s.unit != null ? str(s.unit) : null,
    value_type: s.value_type ? str(s.value_type) : undefined,
    min: s.min != null && Number.isFinite(Number(s.min)) ? Number(s.min) : null,
    max: s.max != null && Number.isFinite(Number(s.max)) ? Number(s.max) : null,
    avg: s.avg != null && Number.isFinite(Number(s.avg)) ? Number(s.avg) : null,
    last: s.last !== undefined ? s.last : null,
    last_ts: s.last_ts ? str(s.last_ts) : null,
    count: num(s.count ?? s.sample_count, 0),
    good_count: s.good_count != null ? num(s.good_count) : undefined,
    good_pct: num(s.good_pct, 100),
    fidelity: s.fidelity ? str(s.fidelity) : undefined,
  });

  const mapSegment = (seg: Raw): HistorianQualitySegment => ({
    signal_id: seg.signal_id ? str(seg.signal_id) : undefined,
    start: str(seg.start),
    end: str(seg.end),
    quality: (str(seg.quality, 'GOOD').toUpperCase() as HistorianQualitySegment['quality']),
    reason_code: seg.reason_code ? str(seg.reason_code) : null,
  });

  const series: HistorianSeriesResult[] = asArray<Raw>(res?.series).map((sr) => ({
    signal_id: str(sr.signal_id),
    key: sr.key ? str(sr.key) : undefined,
    display_name: sr.display_name ? str(sr.display_name) : undefined,
    resource_id: sr.resource_id ? str(sr.resource_id) : undefined,
    resource_name: sr.resource_name ? str(sr.resource_name) : undefined,
    value_type: str(sr.value_type, 'float64'),
    unit: sr.unit != null ? str(sr.unit) : null,
    mode: (str(sr.mode || res?.mode || payload.mode, 'operational') as HistorianSeriesResult['mode']),
    fidelity: str(sr.fidelity, 'operational_full'),
    points: asArray<Raw>(sr.points || sr.items).map(mapPoint),
    stats: mapStats((sr.stats || { signal_id: sr.signal_id }) as Raw),
    quality_segments: asArray<Raw>(sr.quality_segments).map(mapSegment),
    coverage_notes: asArray<string>(sr.coverage_notes).map(String),
  }));

  const flatPoints = asArray<Raw>(res?.points || res?.items).length
    ? asArray<Raw>(res?.points || res?.items).map(mapPoint)
    : series.flatMap((s) => s.points);

  const flatStats = asArray<Raw>(res?.stats).length
    ? asArray<Raw>(res?.stats).map(mapStats)
    : series.map((s) => s.stats);

  const flatSegments = asArray<Raw>(res?.quality_segments).length
    ? asArray<Raw>(res?.quality_segments).map(mapSegment)
    : series.flatMap((s) => s.quality_segments);

  return {
    mode: (str(res?.mode || payload.mode, 'operational') as HistorianQueryResponse['mode']),
    start: str(res?.start || payload.start),
    end: str(res?.end || payload.end),
    bucket_ms: res?.bucket_ms != null ? num(res.bucket_ms) : payload.bucket_ms ?? null,
    agg: res?.agg ? str(res.agg) : payload.agg ?? null,
    downsampled: Boolean(res?.downsampled),
    series,
    points: flatPoints,
    stats: flatStats,
    quality_segments: flatSegments,
    sql_preview: res?.sql_preview ? str(res.sql_preview) : undefined,
    next_cursor: res?.next_cursor ? str(res.next_cursor) : null,
    coverage_notes: asArray<string>(res?.coverage_notes).map(String),
  };
}

export async function getHistorianEvents(params: {
  signal_ids?: string[];
  design_id?: string;
  start?: string;
  end?: string;
  range?: string;
  limit?: number;
} = {}): Promise<{ items: HistorianEventItem[] }> {
  const qs = new URLSearchParams();
  if (params.signal_ids?.length) qs.set('signal_ids', params.signal_ids.join(','));
  if (params.design_id) qs.set('design_id', params.design_id);
  if (params.start) qs.set('start', params.start);
  if (params.end) qs.set('end', params.end);
  if (params.range) qs.set('range', params.range);
  if (params.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  const res = await api<Raw>(`/api/v1/historian/events${query ? `?${query}` : ''}`);
  return {
    items: asArray<Raw>(res?.items ?? res).map((e, idx) => ({
      id: str(e.id, `evt-${idx}`),
      ts: str(e.ts || e.occurred_at || e.timestamp),
      kind: (str(e.kind || e.event_type, 'QUALITY_TRANSITION').toUpperCase() as HistorianEventItem['kind']),
      signal_id: e.signal_id ? str(e.signal_id) : null,
      signal_key: e.signal_key ? str(e.signal_key) : null,
      design_id: e.design_id ? str(e.design_id) : null,
      design_name: e.design_name ? str(e.design_name) : null,
      from_state: e.from_state ? str(e.from_state) : null,
      to_state: e.to_state ? str(e.to_state) : null,
      quality: e.quality ? str(e.quality) : null,
      reason_code: e.reason_code ? str(e.reason_code) : null,
      message: str(e.message || e.description || e.kind),
      data_epoch: e.data_epoch != null ? num(e.data_epoch) : undefined,
    })),
  };
}

export async function listHistorianViews(): Promise<SavedViewItem[]> {
  const res = await api<Raw>('/api/v1/historian/views');
  return asArray<Raw>(res?.items ?? res).map((v) => ({
    id: str(v.id),
    name: str(v.name),
    description: str(v.description),
    query_spec: (v.query_spec || v.query_spec_json || {}) as SavedViewItem['query_spec'],
    chart_options: (v.chart_options || v.chart_options_json || {}) as Record<string, unknown>,
    is_default: Boolean(v.is_default),
    version: num(v.version, 1),
    created_at: str(v.created_at),
    updated_at: str(v.updated_at || v.created_at),
  }));
}

export async function createHistorianView(payload: {
  name: string;
  description?: string;
  query_spec: Record<string, unknown>;
  chart_options?: Record<string, unknown>;
  is_default?: boolean;
}): Promise<SavedViewItem> {
  const res = await api<Raw>('/api/v1/historian/views', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const v = (res?.view || res) as Raw;
  return {
    id: str(v.id),
    name: str(v.name, payload.name),
    description: str(v.description, payload.description || ''),
    query_spec: (v.query_spec || v.query_spec_json || payload.query_spec) as SavedViewItem['query_spec'],
    chart_options: (v.chart_options || v.chart_options_json || payload.chart_options || {}) as Record<string, unknown>,
    is_default: Boolean(v.is_default ?? payload.is_default),
    version: num(v.version, 1),
    created_at: str(v.created_at, new Date().toISOString()),
    updated_at: str(v.updated_at, new Date().toISOString()),
  };
}

export async function deleteHistorianView(viewId: string): Promise<void> {
  await api(`/api/v1/historian/views/${encodeURIComponent(viewId)}`, {
    method: 'DELETE',
  });
}

function normalizeExportJob(r: Raw): ExportJobItem {
  const id = str(r.id);
  return {
    id,
    status: (str(r.status, 'COMPLETED').toUpperCase() as ExportJobItem['status']),
    format: 'csv',
    file_name: str(r.file_name, `historian_export_${id.slice(0, 8)}.csv`),
    row_count: r.row_count != null ? num(r.row_count) : null,
    byte_size: r.byte_size != null ? num(r.byte_size) : null,
    query_spec: (r.query_spec || r.query_spec_json) as Record<string, unknown> | undefined,
    error_code: r.error_code ? str(r.error_code) : null,
    error_message: r.error_message ? str(r.error_message) : null,
    data_epoch: r.data_epoch != null ? num(r.data_epoch) : undefined,
    created_at: str(r.created_at),
    started_at: r.started_at ? str(r.started_at) : null,
    completed_at: r.completed_at ? str(r.completed_at) : null,
    expires_at: r.expires_at ? str(r.expires_at) : null,
    download_url: r.download_url ? str(r.download_url) : `/api/v1/historian/exports/${encodeURIComponent(id)}/download`,
  };
}

export async function listHistorianExports(): Promise<ExportJobItem[]> {
  const res = await api<Raw>('/api/v1/historian/exports');
  return asArray<Raw>(res?.items ?? res).map(normalizeExportJob);
}

export async function createHistorianExport(payload: HistorianQueryRequest & { file_name?: string }): Promise<ExportJobItem> {
  const res = await api<Raw>('/api/v1/historian/exports', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return normalizeExportJob((res?.export || res?.job || res) as Raw);
}

export async function getHistorianExport(exportId: string): Promise<ExportJobItem> {
  const res = await api<Raw>(`/api/v1/historian/exports/${encodeURIComponent(exportId)}`);
  return normalizeExportJob((res?.export || res?.job || res) as Raw);
}

export async function cancelHistorianExport(exportId: string): Promise<ExportJobItem> {
  const res = await api<Raw>(`/api/v1/historian/exports/${encodeURIComponent(exportId)}/cancel`, {
    method: 'POST',
    body: '{}',
  });
  return normalizeExportJob((res?.export || res?.job || res) as Raw);
}

export async function retryHistorianExport(exportId: string): Promise<ExportJobItem> {
  const res = await api<Raw>(`/api/v1/historian/exports/${encodeURIComponent(exportId)}/retry`, {
    method: 'POST',
    body: '{}',
  });
  return normalizeExportJob((res?.export || res?.job || res) as Raw);
}

export function getHistorianExportDownloadUrl(exportId: string): string {
  return `/api/v1/historian/exports/${encodeURIComponent(exportId)}/download`;
}

export async function downloadHistorianExportCsv(exportId: string, fallbackFileName = 'historian_export.csv'): Promise<void> {
  const response = await fetch(getHistorianExportDownloadUrl(exportId), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': readCsrfCookie() },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const msg = body?.error?.message || body?.message || response.statusText;
    throw new ApiError(response.status, msg, body?.error?.code || '');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fallbackFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// S13 Safe Telemetry Reset API Functions
// ============================================================================

export async function previewTelemetryReset(): Promise<TelemetryResetPreviewResponse> {
  let res: Raw;
  try {
    res = await api<Raw>('/api/v1/admin/telemetry-reset/preview');
  } catch (err) {
    if (err instanceof ApiError && err.status === 405) {
      res = await api<Raw>('/api/v1/admin/telemetry-reset/preview', { method: 'POST', body: '{}' });
    } else {
      throw err;
    }
  }
  const clr = (res?.will_clear || res?.cleared || {}) as Raw;
  const pres = (res?.preserved || {}) as Raw;
  const activeEpoch = num(res?.active_epoch, 1);

  return {
    active_epoch: activeEpoch,
    next_epoch: num(res?.next_epoch, activeEpoch + 1),
    lifecycle_state: str(res?.lifecycle_state, 'ACTIVE'),
    can_execute: res?.can_execute !== false,
    will_clear: {
      observations: num(clr.observations, 0),
      latest_signal_state: num(clr.latest_signal_state, 0),
      model_snapshots: num(clr.model_snapshots, 0),
      model_state: num(clr.model_state, 0),
      ingest_dedup: num(clr.ingest_dedup, 0),
      observation_quarantine: num(clr.observation_quarantine, 0),
      commissioning_jobs: num(clr.commissioning_jobs, 0),
      export_jobs: num(clr.export_jobs, 0),
      tdengine_operational_subtables: num(clr.tdengine_operational_subtables ?? clr.operational_subtables, 0),
      tdengine_managed_subtables: num(clr.tdengine_managed_subtables ?? clr.managed_subtables, 0),
    },
    preserved: {
      connections: num(pres.connections, 5),
      signals_active: num(pres.signals_active, 336),
      signals_archived: num(pres.signals_archived, 8),
      data_models: num(pres.data_models, 36),
      storage_designs: num(pres.storage_designs, 0),
      resources: num(pres.resources, 0),
      admin_accounts: num(pres.admin_accounts, 1),
      sessions: num(pres.sessions, 1),
      secret_store: num(pres.secret_store, 0),
      formulas: num(pres.formulas, 0),
    },
    required_phrase: 'CLEAR TELEMETRY',
    preview_at: res?.preview_at ? str(res.preview_at) : undefined,
  };
}

export async function executeTelemetryReset(
  payload: TelemetryResetExecuteRequest,
): Promise<TelemetryResetExecuteResponse> {
  const res = await api<Raw>('/api/v1/admin/telemetry-reset/execute', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return {
    status: str(res?.status, 'SUCCEEDED'),
    operation_id: res?.operation_id ? str(res.operation_id) : undefined,
    previous_epoch: num(res?.previous_epoch, 1),
    active_epoch: num(res?.active_epoch, 2),
    cleared: (res?.cleared || {}) as Record<string, number>,
    preserved: (res?.preserved || {}) as Record<string, number>,
    stay_authenticated: res?.stay_authenticated !== false,
    completed_at: res?.completed_at ? str(res.completed_at) : undefined,
  };
}

export async function getTelemetryResetStatus(operationId?: string): Promise<TelemetryResetStatusResponse> {
  const path = operationId
    ? `/api/v1/admin/telemetry-reset/status?operation_id=${encodeURIComponent(operationId)}`
    : '/api/v1/admin/telemetry-reset/status';
  const res = await api<Raw>(path);
  return {
    active_epoch: num(res?.active_epoch, 1),
    lifecycle_state: str(res?.lifecycle_state, 'ACTIVE'),
    last_operation: res?.last_operation ? (res.last_operation as StorageOperation) : null,
  };
}

export const storageApi = {
  apiFetch,
  listDesigns: listStorageDesigns,
  listStorageDesigns,
  createDesign: createStorageDesign,
  createStorageDesign,
  getDesign: getStorageDesign,
  getStorageDesign,
  updateDesign: updateStorageDesign,
  updateStorageDesign,
  validateDesign: validateStorageDesign,
  validateStorageDesign,
  getPhysicalPlan: compileStoragePhysicalPlan,
  compileStoragePhysicalPlan,
  simulateDesign: simulateStorageDesign,
  simulateStorageDesign,
  publishDesign: publishStorageDesign,
  publishStorageDesign,
  pauseDesign: pauseStorageDesign,
  pauseStorageDesign,
  resumeDesign: resumeStorageDesign,
  resumeStorageDesign,
  duplicateDesign: duplicateStorageDesign,
  duplicateStorageDesign,
  archiveDesign: archiveStorageDesign,
  archiveStorageDesign,
  restoreDesign: restoreStorageDesign,
  restoreStorageDesign,
  bulkDesigns: bulkStorageDesigns,
  bulkStorageDesigns,
  getDependencies: getStorageDependencies,
  getStorageDependencies,
  exportDesign: exportStorageDesign,
  exportStorageDesign,
  importDesign: importStorageDesign,
  importStorageDesign,
  getHealth: getStorageHealth,
  getStorageHealth,
  listOperations: listStorageOperations,
  listStorageOperations,
  previewRetention: previewStorageRetention,
  previewStorageRetention,
  getHistorianLatest,
  queryHistorian,
  getHistorianEvents,
  listHistorianViews,
  createHistorianView,
  deleteHistorianView,
  listHistorianExports,
  createHistorianExport,
  getHistorianExport,
  cancelHistorianExport,
  retryHistorianExport,
  getHistorianExportDownloadUrl,
  downloadHistorianExportCsv,
  previewTelemetryReset,
  executeTelemetryReset,
  getTelemetryResetStatus,
  createDefaultStorageDesignAst,
  serializeAstToYaml,
  normalizeAst,
};
