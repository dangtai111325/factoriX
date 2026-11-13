/**
 * storagePhysicalApi.ts
 * Typed fetch client for the physical TDengine & PostgreSQL Storage APIs.
 * Routes: /api/v1/storage/td/*, /api/v1/storage/pg/*, /api/v1/storage/engines, /api/v1/storage/operations/*
 */

import { api } from '../api/client';

export { ApiError } from '../api/client';

// ============================================================================
// Shared enums & primitives
// ============================================================================

export type StorageObjectStatus =
  | 'ACTIVE'
  | 'DRAFT'
  | 'CREATING'
  | 'VERIFYING'
  | 'OUT_OF_SYNC'
  | 'ERROR'
  | 'RETIRED'
  | 'READ_ONLY'
  | 'UNKNOWN';

export type TDObjectType = 'database' | 'stable' | 'subtable';

export type EdgeKind =
  | 'CONTAINS'
  | 'INHERITS_SCHEMA'
  | 'BINDS_SOURCE'
  | 'SAME_RESOURCE'
  | 'TEMPORAL_ASSOCIATION';

export type RowAssemblyPolicy =
  | 'INDEPENDENT_EVENTS'
  | 'LATEST_AS_OF_TRIGGER'
  | 'TIME_BUCKET'
  | 'EXACT_TIMESTAMP';

export type RecordingMode = 'ON_CHANGE' | 'EVERY_ACQUISITION' | 'INTERVAL';

export type ColumnRole = 'timestamp' | 'value' | 'tag';

export type OperationStatus = 'PENDING' | 'PLAN' | 'PREPARED' | 'APPLYING' | 'APPLIED' | 'FAILED' | 'CANCELLED';

// ============================================================================
// TDengine physical objects
// ============================================================================

export interface TDColumn {
  name: string;
  td_type: string;         // e.g. TIMESTAMP, DOUBLE, VARCHAR(255)
  nullable: boolean;
  role: ColumnRole;
  immutable?: boolean;     // ts column is immutable
  length?: number | null;
  default_value?: string | null;
}

export interface TDTag {
  name: string;
  td_type: string;
  value?: string | null;   // subtable-level value (subtable inspector)
}

export interface SourceBinding {
  id: string;
  source_kind: 'signal' | 'model_field' | 'resource_context';
  source_id: string;
  source_path: string;
  source_type?: string | null;
  source_unit?: string | null;
  destination_column: string;
  row_assembly_policy?: RowAssemblyPolicy | null;
  recording_mode?: RecordingMode | null;
  status: 'ACTIVE' | 'PAUSED' | 'UNBOUND';
  last_sample_at?: string | null;
  last_quality?: string | null;
  effective_revision?: number | null;
  created_at: string;
}

export interface TDDatabase {
  id: string;             // internal FactoriX registry ID
  physical_name: string;
  display_name?: string | null;
  description?: string | null;
  precision: 'ms' | 'us' | 'ns';
  retention_days?: number | null;
  vgroups?: number | null;
  cache_mb?: number | null;
  status: StorageObjectStatus;
  stable_count: number;
  subtable_count: number;
  owner?: string | null;
  tenant_id: string;
  observed_at: string;
  last_verified_at?: string | null;
  drift_status?: 'OK' | 'OUT_OF_SYNC' | 'UNKNOWN' | null;
}

export interface TDStable {
  id: string;
  database_id: string;
  database_name: string;
  physical_name: string;
  display_name?: string | null;
  description?: string | null;
  columns: TDColumn[];
  tags: TDTag[];
  subtable_count: number;
  status: StorageObjectStatus;
  owner?: string | null;
  tenant_id: string;
  observed_at: string;
  last_verified_at?: string | null;
  drift_status?: 'OK' | 'OUT_OF_SYNC' | 'UNKNOWN' | null;
  source_mapping_template?: SourceBinding[] | null;
  default_recording_mode?: RecordingMode | null;
  retention_days?: number | null;
}

export interface TDSubtable {
  id: string;
  stable_id: string;
  stable_name: string;
  database_id: string;
  database_name: string;
  physical_name: string;
  display_name?: string | null;
  description?: string | null;
  tag_values: TDTag[];
  bindings: SourceBinding[];
  row_assembly_policy?: RowAssemblyPolicy | null;
  recording_mode?: RecordingMode | null;
  status: StorageObjectStatus;
  write_active: boolean;
  owner?: string | null;
  tenant_id: string;
  observed_at: string;
  last_verified_at?: string | null;
  drift_status?: 'OK' | 'OUT_OF_SYNC' | 'UNKNOWN' | null;
  latest_row_at?: string | null;
  row_count_estimate?: number | null;
}

// ============================================================================
// Topology graph
// ============================================================================

export interface TopologyNode {
  node_id: string;        // e.g. "db/my_db", "stable/my_stable", "subtable/my_sub"
  object_type: TDObjectType | 'engine';
  physical_name: string;
  display_name?: string | null;
  status: StorageObjectStatus;
  parent_id?: string | null;
  metadata: Record<string, unknown>;
  position?: { x: number; y: number } | null; // saved UI layout
}

export interface TopologyEdge {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_kind: EdgeKind;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TopologyResponse {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  source: string;        // "tdengine_information_schema"
  observed_at: string;
  partial_error?: string | null;
  next_cursor?: string | null;
  total_node_count?: number | null;
}

// ============================================================================
// Paginated lists
// ============================================================================

export interface PaginatedList<T> {
  items: T[];
  total: number;
  next_cursor?: string | null;
  observed_at?: string;
}

// ============================================================================
// Storage operations / journal
// ============================================================================

export interface StorageOperation {
  id: string;
  object_type: TDObjectType;
  object_name: string;
  operation_kind: 'CREATE' | 'ALTER' | 'DROP' | 'BIND' | 'UNBIND' | 'RETIRE' | 'PURGE' | 'RECONCILE';
  status: OperationStatus;
  ddl_plan?: string | null;
  actual_result?: string | null;
  error_message?: string | null;
  initiated_by?: string | null;
  idempotency_key?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

// ============================================================================
// Source references (for 3-perspective picker)
// ============================================================================

export type SourceView = 'hierarchy' | 'collector' | 'models';

export interface SourceRef {
  id: string;
  kind: 'signal' | 'model_field' | 'resource_context';
  display_name: string;
  path: string;
  data_type?: string | null;
  unit?: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'NO_DATA';
  last_value?: unknown;
  last_at?: string | null;
  quality?: string | null;
  resource_id?: string | null;
  resource_name?: string | null;
  connection_id?: string | null;
  connection_name?: string | null;
  model_id?: string | null;
  model_name?: string | null;
  revision?: number | null;
}

export interface SourcesResponse {
  view: SourceView;
  items: SourceRef[];
  total: number;
  next_cursor?: string | null;
}

// ============================================================================
// PostgreSQL read-only explorer
// ============================================================================

export interface PgSchema {
  schema_name: string;
  table_count: number;
  view_count: number;
  owner?: string | null;
}

export interface PgTable {
  schema_name: string;
  table_name: string;
  table_type: 'TABLE' | 'VIEW' | 'MATERIALIZED_VIEW';
  row_count_estimate?: number | null;
  comment?: string | null;
}

export interface PgColumn {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default?: string | null;
  is_primary_key: boolean;
  is_foreign_key: boolean;
  foreign_table?: string | null;
  foreign_column?: string | null;
  comment?: string | null;
}

export interface PgRelationship {
  constraint_name: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  is_inferred: boolean;  // true = business link, dashed on ERD
}

export interface PgIndex {
  index_name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
}

export interface PgTableDetail {
  schema_name: string;
  table_name: string;
  columns: PgColumn[];
  relationships: PgRelationship[];
  indexes: PgIndex[];
}

export interface PgErdResponse {
  tables: PgTable[];
  relationships: PgRelationship[];
  source: string;
  observed_at: string;
}

// ============================================================================
// Wizard intent types
// ============================================================================

export interface CreateDatabaseIntent {
  physical_name: string;
  display_name?: string;
  description?: string;
  precision: 'ms' | 'us' | 'ns';
  retention_days?: number | null;
  vgroups?: number | null;
  cache_mb?: number | null;
}

export interface ColumnDefinition {
  name: string;
  td_type: string;
  nullable?: boolean;
  length?: number | null;
  immutable?: boolean;
}

export interface TagDefinition {
  name: string;
  td_type: string;
}

export interface CreateStableIntent {
  database_name: string;
  physical_name: string;
  display_name?: string;
  description?: string;
  columns: ColumnDefinition[];  // ts TIMESTAMP must be first
  tags: TagDefinition[];
  source_mapping_template?: SourceBinding[];
  default_recording_mode?: RecordingMode;
  retention_days?: number | null;
}

export interface TagValueAssignment {
  tag_name: string;
  value: string;
}

export interface FieldBindingIntent {
  column_name: string;
  source_kind: 'signal' | 'model_field' | 'resource_context';
  source_id: string;
  source_path: string;
}

export interface CreateSubtableIntent {
  stable_id: string;
  physical_name: string;
  display_name?: string;
  description?: string;
  tag_values: TagValueAssignment[];
  bindings: FieldBindingIntent[];
  row_assembly_policy: RowAssemblyPolicy;
  recording_mode: RecordingMode;
  max_age_seconds?: number | null;
  time_bucket_seconds?: number | null;
  start_recording?: boolean;
}

// ============================================================================
// API functions
// ============================================================================

/** GET /api/v1/storage/engines */
export async function getStorageEngines(): Promise<{
  tdengine: { reachable: boolean; version?: string; last_checked_at: string };
  postgresql: { reachable: boolean; version?: string; last_checked_at: string };
}> {
  return api('/api/v1/storage/engines');
}

// --- TDengine topology ---

export async function getTDTopology(params?: {
  database?: string;
  depth?: number;
  cursor?: string;
  show_bindings?: boolean;
}): Promise<TopologyResponse> {
  const qs = new URLSearchParams();
  if (params?.database) qs.set('database', params.database);
  if (params?.depth != null) qs.set('depth', String(params.depth));
  if (params?.cursor) qs.set('cursor', params.cursor);
  if (params?.show_bindings) qs.set('show_bindings', '1');
  return api(`/api/v1/storage/td/topology${qs.size ? '?' + qs : ''}`);
}

// --- Databases ---

export async function listDatabases(): Promise<PaginatedList<TDDatabase>> {
  return api('/api/v1/storage/td/databases');
}

export async function getDatabase(nameOrId: string): Promise<TDDatabase> {
  return api(`/api/v1/storage/td/databases/${encodeURIComponent(nameOrId)}`);
}

export async function createDatabase(intent: CreateDatabaseIntent): Promise<StorageOperation> {
  return api('/api/v1/storage/td/databases', {
    method: 'POST',
    body: JSON.stringify(intent),
  });
}

// --- Stables ---

export async function listStables(params?: {
  database?: string;
  cursor?: string;
  search?: string;
}): Promise<PaginatedList<TDStable>> {
  const qs = new URLSearchParams();
  if (params?.database) qs.set('database', params.database);
  if (params?.cursor) qs.set('cursor', params.cursor);
  if (params?.search) qs.set('search', params.search);
  return api(`/api/v1/storage/td/stables${qs.size ? '?' + qs : ''}`);
}

export async function getStable(id: string): Promise<TDStable> {
  return api(`/api/v1/storage/td/stables/${encodeURIComponent(id)}`);
}

export async function createStable(intent: CreateStableIntent): Promise<StorageOperation> {
  return api('/api/v1/storage/td/stables', {
    method: 'POST',
    body: JSON.stringify(intent),
  });
}

export async function validateStable(intent: Partial<CreateStableIntent>): Promise<{ valid: boolean; errors: { field: string; message: string }[] }> {
  return api('/api/v1/storage/td/stables/validate', {
    method: 'POST',
    body: JSON.stringify(intent),
  });
}

// --- Subtables ---

export async function listSubtables(params?: {
  stable?: string;
  database?: string;
  cursor?: string;
  search?: string;
  status?: StorageObjectStatus;
}): Promise<PaginatedList<TDSubtable>> {
  const qs = new URLSearchParams();
  if (params?.stable) qs.set('stable', params.stable);
  if (params?.database) qs.set('database', params.database);
  if (params?.cursor) qs.set('cursor', params.cursor);
  if (params?.search) qs.set('search', params.search);
  if (params?.status) qs.set('status', params.status);
  return api(`/api/v1/storage/td/subtables${qs.size ? '?' + qs : ''}`);
}

export async function getSubtable(id: string): Promise<TDSubtable> {
  return api(`/api/v1/storage/td/subtables/${encodeURIComponent(id)}`);
}

export async function createSubtable(intent: CreateSubtableIntent): Promise<StorageOperation> {
  return api('/api/v1/storage/td/subtables', {
    method: 'POST',
    body: JSON.stringify(intent),
  });
}

// --- Generic object lookup (by objectId which may be db/stable/subtable) ---

export async function getStorageObject(objectId: string): Promise<TDDatabase | TDStable | TDSubtable> {
  return api(`/api/v1/storage/td/objects/${encodeURIComponent(objectId)}`);
}

export async function patchStorageObject(
  objectId: string,
  patch: Record<string, unknown>,
  ifMatch?: string
): Promise<StorageOperation | TDDatabase | TDStable | TDSubtable> {
  return api(`/api/v1/storage/td/objects/${encodeURIComponent(objectId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(ifMatch ? { 'If-Match': ifMatch } : {}),
    },
    body: JSON.stringify(patch),
  });
}

// --- Operations / journal ---

export async function getOperation(id: string): Promise<StorageOperation> {
  return api(`/api/v1/storage/operations/${encodeURIComponent(id)}`);
}

export async function listOperations(params?: {
  object_type?: TDObjectType;
  status?: OperationStatus;
  cursor?: string;
}): Promise<PaginatedList<StorageOperation>> {
  const qs = new URLSearchParams();
  if (params?.object_type) qs.set('object_type', params.object_type);
  if (params?.status) qs.set('status', params.status);
  if (params?.cursor) qs.set('cursor', params.cursor);
  return api(`/api/v1/storage/operations${qs.size ? '?' + qs : ''}`);
}

// --- Source picker ---

export async function getSources(params: {
  view: SourceView;
  search?: string;
  resource_id?: string;
  connection_id?: string;
  model_id?: string;
  cursor?: string;
}): Promise<SourcesResponse> {
  const qs = new URLSearchParams({ view: params.view });
  if (params.search) qs.set('search', params.search);
  if (params.resource_id) qs.set('resource_id', params.resource_id);
  if (params.connection_id) qs.set('connection_id', params.connection_id);
  if (params.model_id) qs.set('model_id', params.model_id);
  if (params.cursor) qs.set('cursor', params.cursor);
  return api(`/api/v1/storage/sources?${qs}`);
}

// --- PostgreSQL read-only explorer ---

export async function listPgSchemas(): Promise<PgSchema[]> {
  return api('/api/v1/storage/pg/schemas');
}

export async function listPgTables(schema: string): Promise<PgTable[]> {
  return api(`/api/v1/storage/pg/tables?schema=${encodeURIComponent(schema)}`);
}

export async function getPgTableDetail(schema: string, table: string): Promise<PgTableDetail> {
  return api(`/api/v1/storage/pg/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`);
}

export async function getPgErd(schema?: string): Promise<PgErdResponse> {
  const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
  return api(`/api/v1/storage/pg/relationships${qs}`);
}

export async function getPgTablePreview(
  schema: string,
  table: string,
  params?: { limit?: number; offset?: number; sort_column?: string; sort_dir?: 'asc' | 'desc' }
): Promise<{ columns: string[]; rows: (unknown[] | Record<string, unknown>)[]; total_estimate: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.sort_column) qs.set('sort_column', params.sort_column);
  if (params?.sort_dir) qs.set('sort_dir', params.sort_dir);
  return api(`/api/v1/storage/pg/preview/${encodeURIComponent(schema)}/${encodeURIComponent(table)}${qs.size ? '?' + qs : ''}`);
}

// --- Historian queries ---

export interface HistorianQueryParams {
  source_kind: 'subtable' | 'signal' | 'model_field';
  source_id: string;
  from_ts: string;   // ISO
  to_ts: string;     // ISO
  resolution?: string | null;
  mode?: 'recorded' | 'reconstructed' | 'operational';
  limit?: number;
  cursor?: string;
}

export interface HistorianRow {
  ts: string;
  values: Record<string, unknown>;
  quality?: Record<string, string> | null;
  source_times?: Record<string, string> | null;
  carry_forward_flags?: Record<string, boolean> | null;
}

export async function queryHistorian(params: HistorianQueryParams): Promise<{
  rows: HistorianRow[];
  total: number;
  next_cursor?: string | null;
  mode: string;
  source_id: string;
  from_ts: string;
  to_ts: string;
}> {
  return api('/api/v1/historian/query', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export interface SavedView {
  id: string;
  name: string;
  description?: string | null;
  query_params: HistorianQueryParams;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
}

export async function listSavedViews(): Promise<SavedView[]> {
  return api('/api/v1/historian/views');
}

export async function saveView(view: Omit<SavedView, 'id' | 'created_at' | 'updated_at'>): Promise<SavedView> {
  return api('/api/v1/historian/views', {
    method: 'POST',
    body: JSON.stringify(view),
  });
}

export interface ExportJob {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'ERROR' | 'CANCELLED';
  format: 'csv' | 'json';
  source_id: string;
  from_ts: string;
  to_ts: string;
  row_count?: number | null;
  download_url?: string | null;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
  expires_at?: string | null;
}

export async function createExportJob(params: {
  source_kind: string;
  source_id: string;
  from_ts: string;
  to_ts: string;
  format: 'csv' | 'json';
}): Promise<ExportJob> {
  return api('/api/v1/historian/exports', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function getExportJob(id: string): Promise<ExportJob> {
  return api(`/api/v1/historian/exports/${encodeURIComponent(id)}`);
}

export async function listExportJobs(): Promise<ExportJob[]> {
  return api('/api/v1/historian/exports');
}

// --- KPI stats ---

export async function getStorageStats(): Promise<{
  database_count: number;
  stable_count: number;
  subtable_count: number;
  recording_active: number;
  recording_paused: number;
  recording_error: number;
  observed_at: string;
}> {
  return api('/api/v1/storage/td/stats');
}
