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
  | 'PAUSED'
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
  | 'ATOMIC_EVENT'
  | 'LATEST_AS_OF_TRIGGER'
  | 'TIME_BUCKET'
  | 'EXACT_TIMESTAMP';

/** ON_NEW_EVENT = one atomic row per new event identity (completion events, guide F4). */
export type RecordingMode = 'ON_CHANGE' | 'ON_NEW_EVENT' | 'EVERY_ACQUISITION' | 'INTERVAL';

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
  /** Second column only: TDengine composite primary key (`... COMPOSITE KEY`). */
  primary_key?: boolean;
  immutable?: boolean;     // ts column is immutable
  length?: number | null;
  default_value?: string | null;
}

export interface TDTag {
  name: string;
  td_type: string;
  length?: number | null;
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
  /** @deprecated not sent since H-R4.2 (kept optional for older Centers). */
  cache_mb?: number | null;
  status: StorageObjectStatus;
  stable_count: number;
  subtable_count: number;
  owner?: string | null;
  tenant_id: string;
  observed_at: string;
  last_verified_at?: string | null;
  /** @deprecated not sent since H-R4.2. */
  drift_status?: 'OK' | 'OUT_OF_SYNC' | 'UNKNOWN' | null;
  // H-R4.2: real TDengine values of the database
  object_id?: string;
  keep?: string | null;
  replica?: number | null;
  cache_model?: string | null;
  table_count?: number | null;
  is_tenant_default?: boolean;
  is_system?: boolean;
  managed?: boolean;
  revision?: number | null;
  created_at?: string | null;
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
  /** Bulk wizard name prefix proposed by the server (R2-14), e.g. `order_` for `st_production_order_change`. */
  suggested_prefix?: string | null;
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
  label?: string | null;
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

export interface StorageCatalogRow {
  id: string;
  physical_name: string;
  display_name: string;
  object_type: TDObjectType;
  parent_name?: string;
  column_count?: number;
  tag_count?: number;
  subtable_count?: number;
  binding_count?: number;
  last_verified_at: string;
  status: StorageObjectStatus;
  /** Only on `?status=ERROR` rows: the writer could not store rows into this subtable (R2-07). */
  recording_error?: boolean;
}

export function getTDStorageCatalog(params: URLSearchParams, signal: AbortSignal): Promise<PaginatedList<StorageCatalogRow>> {
  return api(`/api/v1/storage/td/catalog?${params}`, { signal });
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
  kind: 'signal' | 'model_field' | 'resource_context' | 'subtable';
  key?: string | null;
  name?: string | null;
  field_path?: string | null;
  value_type?: string | null;
  freshness?: string | null;
  has_last_value?: boolean;
  bound_to?: { database: string; subtable: string; column: string } | null;
  /** Server suggestion for `auto` fields (R2-14): the type of the mapped signal, else of the live value. */
  inferred_type?: string | null;
  /** Where `inferred_type` comes from: `declared`, `signal` or `live_value`. */
  type_source?: 'declared' | 'signal' | 'live_value' | string | null;
  /** Value column of the standard template the server proposes for this field. */
  suggested_column?: string | null;
  resource_code?: string | null;
  is_timestamp?: boolean;
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

export interface FactoryRef {
  id: string;
  name: string;
  code: string;
  type_key: string;
}

/** A Data Model group of the `models` view: never bindable itself, only its `fields` are. */
export interface ModelSourceGroup {
  id: string;
  kind: 'model';
  name: string;
  display_name: string;
  key?: string;
  model_kind?: string;
  model_revision?: number;
  resource: FactoryRef | null;
  ancestors: FactoryRef[];
  fields: SourceRef[];
  fields_count: number;
  freshness?: string;
  quality?: string;
}

export interface SourcesResponse {
  view: SourceView;
  items: SourceRef[];
  groups?: unknown[];
  leaves?: SourceRef[];
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
  role?: ColumnRole;
  primary_key?: boolean;
}

export interface TagDefinition {
  name: string;
  td_type: string;
  length?: number | null;
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
  /** Data Model field binding (G-02): the model and the leaf path, both persisted. */
  model_id?: string | null;
  field_path?: string | null;
  signal_id?: string | null;
}

export interface CreateSubtableIntent {
  stable_id: string;
  database?: string;
  stable?: string;
  name?: string;
  physical_name: string;
  /** Explicit choice to create a subtable without any binding (nothing will be recorded). */
  no_binding?: boolean;
  identity_paths?: string[];
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
  include_subtable_tags?: boolean;
}, signal?: AbortSignal): Promise<TopologyResponse> {
  const qs = new URLSearchParams();
  if (params?.database) qs.set('database', params.database);
  if (params?.depth != null) qs.set('depth', String(params.depth));
  if (params?.cursor) qs.set('cursor', params.cursor);
  if (params?.show_bindings) qs.set('show_bindings', '1');
  if (params?.include_subtable_tags != null) qs.set('include_subtable_tags', String(params.include_subtable_tags));
  return api(`/api/v1/storage/td/topology${qs.size ? '?' + qs : ''}`, { signal });
}

// --- Databases ---

export async function listDatabases(): Promise<PaginatedList<TDDatabase>> {
  return api('/api/v1/storage/td/databases');
}

export async function getDatabase(nameOrId: string): Promise<TDDatabase> {
  return api(`/api/v1/storage/td/databases/${encodeURIComponent(nameOrId)}`);
}

// --- Name check (wizard step 1, R1-17a / R1-29) ---

export type StorageNameErrorCode =
  | 'RESERVED_NAME'
  | 'IDENTIFIER_TOO_LONG'
  | 'INVALID_IDENTIFIER'
  | 'RESERVED_PREFIX'
  | 'SYSTEM_OBJECT'
  | 'DESCRIPTION_TOO_LONG'
  | 'NAME_CONFLICT'
  | string;

export interface StorageNameCheck {
  valid: boolean;
  errors: { field?: string; code: StorageNameErrorCode; message: string }[];
  exists: boolean;
}

/** `POST /storage/td/validate-name`: the create validators for the name (+ description) only, plus NAME_CONFLICT. */
export function validateStorageName(
  body: { kind: TDObjectType; name: string; database?: string; stable?: string; description?: string },
  signal?: AbortSignal,
): Promise<StorageNameCheck> {
  return api('/api/v1/storage/td/validate-name', { method: 'POST', body: JSON.stringify(body), signal });
}

export async function createDatabase(intent: CreateDatabaseIntent, idempotencyKey?: string): Promise<StorageOperation> {
  return api('/api/v1/storage/td/databases', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
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

export async function createStable(intent: CreateStableIntent, idempotencyKey?: string): Promise<StorageOperation> {
  return api('/api/v1/storage/td/stables', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
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
  /** Page size (server default 50, max 500). */
  limit?: number;
}): Promise<PaginatedList<TDSubtable>> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
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

export async function createSubtable(intent: CreateSubtableIntent, idempotencyKey?: string): Promise<StorageOperation> {
  return api('/api/v1/storage/td/subtables', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify(intent),
  });
}

// --- Backend plan (exact DDL), bulk, templates, drafts, recording health ---

export interface StoragePlan {
  valid: boolean;
  exists: boolean;
  /** `expected` (TAG_MACHINE_MISMATCH, R2-09): the machine id the bound field belongs to. */
  errors: { field?: string; code?: string; message: string; expected?: string }[];
  warnings: { field?: string; code?: string; message: string }[];
  ddl: string[];
  steps: { action: string; sql: string; description?: string }[];
  bindings?: {
    source_kind: string; model_id?: string | null; model_field_path?: string | null;
    signal_id?: string | null; target_column: string; source_data_type?: string; model_name?: string;
  }[] | null;
  recording?: { mode: RecordingMode; row_assembly: RowAssemblyPolicy; start_recording: boolean; identity_paths: string[] } | null;
}

/** POST /api/v1/storage/td/plan — validation + the DDL the backend will execute (Review step). */
export async function planStorageObject(kind: TDObjectType, spec: Record<string, unknown>): Promise<StoragePlan> {
  return api('/api/v1/storage/td/plan', { method: 'POST', body: JSON.stringify({ kind, spec }) });
}

export interface BulkRowResult {
  name: string;
  database?: string;
  stable?: string;
  status: 'CREATED' | 'EXISTS' | 'VALID' | 'INVALID' | 'FAILED';
  operation_id?: string;
  replay?: boolean;
  code?: string;
  message?: string;
  errors?: { field?: string; code?: string; message: string; expected?: string }[];
  ddl?: string[];
}

/** A background bulk-create job (H-R4.3): progress in memory on the Center, kept 1 h, lost on an API restart (404). */
export interface BulkJob {
  job_id: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | string;
  total: number;
  done: number;
  progress_pct?: number;
  summary: Record<string, number>;
  items?: BulkRowResult[];
  error?: string | null;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  status_url?: string;
  poll_after_ms?: number;
}

/**
 * POST /api/v1/storage/td/subtables/bulk. `dry_run` (≤ 50 rows) answers in the request; a real create (≤ 1000 rows)
 * answers 202 with a job to poll (H-R4.3). Older Centers answered every create synchronously with `items`.
 */
export async function bulkCreateSubtables(
  rows: Record<string, unknown>[],
  dryRun: boolean,
): Promise<{ items: BulkRowResult[]; summary: Record<string, number>; dry_run: boolean } & Partial<BulkJob>> {
  return api('/api/v1/storage/td/subtables/bulk', { method: 'POST', body: JSON.stringify({ rows, dry_run: dryRun }) });
}

/** GET /api/v1/storage/td/bulk-jobs/{id} — progress and the rows finished so far. */
export async function getBulkJob(jobId: string): Promise<BulkJob> {
  return api(`/api/v1/storage/td/bulk-jobs/${encodeURIComponent(jobId)}`);
}

export interface StableTemplate {
  id: string;
  name: string;
  description: string;
  columns: ColumnDefinition[];
  value_columns: ColumnDefinition[];
  tags: TagDefinition[];
  recording_mode: RecordingMode;
}

export async function listStableTemplates(): Promise<{ items: StableTemplate[] }> {
  return api('/api/v1/storage/td/templates');
}

export interface StorageDraftItem {
  id: string;
  object_kind: TDObjectType;
  name: string;
  revision: number;
  state: string;
  spec: Record<string, unknown>;
  updated_at?: string | null;
}

export async function listStorageDrafts(kind?: TDObjectType): Promise<{ items: StorageDraftItem[]; total: number }> {
  return api(`/api/v1/storage/td/drafts${kind ? `?kind=${kind}` : ''}`);
}

export interface StorageDraftDetail extends StorageDraftItem {
  created_at?: string | null;
}

/** GET /api/v1/storage/td/drafts/{id} → the draft with its `spec` (= the create body of its kind), H14. */
export async function getStorageDraft(id: string): Promise<StorageDraftDetail> {
  return api(`/api/v1/storage/td/drafts/${encodeURIComponent(id)}`);
}

/** POST /api/v1/storage/td/objects/drafts {kind, name, spec} → the new draft (revision 1). */
export async function createStorageDraft(body: { kind: TDObjectType; name: string; spec: Record<string, unknown> }): Promise<StorageDraftDetail> {
  return api('/api/v1/storage/td/objects/drafts', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * PATCH /api/v1/storage/td/objects/drafts/{id} {revision, name, spec}: optimistic lock on `revision`
 * (409 when the draft changed elsewhere). The server MERGES `spec` at the top level, so callers send every key
 * (null for cleared values).
 */
export async function patchStorageDraft(id: string, body: { revision: number; name?: string; spec: Record<string, unknown> }): Promise<StorageDraftDetail> {
  return api(`/api/v1/storage/td/objects/drafts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** POST /api/v1/storage/td/objects/drafts/{id}/publish (202) → `{operation_id, status, object_key, …}`. */
export async function publishStorageDraft(id: string, idempotencyKey?: string): Promise<{
  operation_id: string;
  status: string;
  object_key?: string | null;
  error_message?: string | null;
  idempotent_replay?: boolean;
}> {
  return api(`/api/v1/storage/td/objects/drafts/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify({}),
  });
}

/** DELETE /api/v1/storage/td/drafts/{id} → state CANCELLED (contract H9; 404/405 on older servers). */
export async function discardStorageDraft(id: string): Promise<{ id: string; state: string }> {
  return api(`/api/v1/storage/td/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface RecordingStatus {
  pending: number;
  failed: number;
  confirmed_last_hour: number;
  last_write_at: string | null;
  oldest_pending_at: string | null;
  dispatcher_running: boolean;
  failed_by_target: { database: string; subtable: string; error: string; count: number }[];
}

export async function getRecordingStatus(signal?: AbortSignal): Promise<RecordingStatus> {
  return api('/api/v1/storage/recording/status', { signal });
}

// --- Lifecycle (user objects only; FactoriX system objects answer 403) ---

export async function pauseStorageObject(objectId: string): Promise<{ status: string }> {
  return api(`/api/v1/storage/td/objects/${encodeURIComponent(objectId)}/pause`, { method: 'POST' });
}

export async function resumeStorageObject(objectId: string): Promise<{ status: string }> {
  return api(`/api/v1/storage/td/objects/${encodeURIComponent(objectId)}/resume`, { method: 'POST' });
}

export async function retireStorageObject(objectId: string): Promise<{ status: string }> {
  return api(`/api/v1/storage/td/objects/${encodeURIComponent(objectId)}/retire`, { method: 'POST' });
}

export async function purgeStorageObject(objectId: string, confirmName: string): Promise<{ status: string }> {
  return api(
    `/api/v1/storage/td/objects/${encodeURIComponent(objectId)}?confirm_name=${encodeURIComponent(confirmName)}`,
    { method: 'DELETE' },
  );
}

/** FactoriX-owned objects (operational history / snapshots): read-only in the Storage UI. */
export const SYSTEM_STABLES = new Set(['op_bool', 'op_float64', 'op_int64', 'op_string', 'op_json', 'model_snapshots']);
export function isSystemStorageName(name: string | null | undefined): boolean {
  if (!name) return false;
  return SYSTEM_STABLES.has(name) || name.startsWith('op_') || name.startsWith('ms_');
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
// Contract: v6_contracts.md H5/H6/H8. Fields marked "newer servers" are optional: the UI degrades
// gracefully when an older Center does not send them.

export interface HistorianQueryParams {
  source_kind: 'subtable' | 'signal' | 'model_field';
  source_id: string;
  from_ts: string; // ISO
  to_ts: string; // ISO
  resolution?: string | null;
  mode?: 'recorded' | 'reconstructed' | 'operational';
  limit?: number;
  cursor?: string;
}

export interface HistorianRow {
  ts: string;
  values?: Record<string, unknown>;
  quality?: Record<string, string> | string | null;
  source_times?: Record<string, string> | null;
  carry_forward_flags?: Record<string, boolean> | null;
  event_uid?: string | null;
  eventUid?: string | null;
  data_epoch?: number | null;
  dataEpoch?: number | null;
  reason_code?: string | null;
  reasonCode?: string | null;
  record_kind?: string | null;
  recordKind?: string | null;
  virtual?: boolean | null;
  acquired_at?: string | null;
  acquiredAt?: string | null;
  source_time?: string | null;
  sourceTime?: string | null;
  [key: string]: unknown;
}

/**
 * Compact point (H10): `ts, value, quality, record_kind` always; the rest only when present. Lineage that is the
 * same for every point (unit, value type, series key) lives on the series.
 */
export interface HistorianSeriesPoint {
  id?: string;
  ts: string;
  value: unknown;
  quality: string | null;
  record_kind: string;
  min?: number | null;
  max?: number | null;
  count?: number;
  /** Bucket: last value of the bucket. */
  last?: unknown;
  source_time?: string | null;
  acquired_at?: string | null;
  reason_code?: string | null;
  event_uid?: string | null;
  data_epoch?: number | null;
  virtual?: boolean;
  series_key?: string;
  signal_key?: string | null;
  /** Compare period: real timestamp of a point shifted onto the main axis (newer servers). */
  original_ts?: string | null;
}

export interface HistorianSeriesStats {
  min: number | null;
  max: number | null;
  avg: number | null;
  last: unknown;
  last_ts: string | null;
  count: number;
  total: number;
  good_pct: number | null;
  // newer servers
  first?: unknown;
  first_ts?: string | null;
  gap_count?: number | null;
  longest_gap_ms?: number | null;
  coverage_pct?: number | null;
  gap_threshold_ms?: number | null;
}

export interface HistorianSeriesResult {
  series_key: string;
  source_kind: 'signal' | 'model_field' | 'subtable';
  display_name: string;
  resource_id?: string | null;
  resource_name?: string | null;
  value_type?: string | null;
  unit?: string | null;
  status: 'OK' | 'NO_DATA' | 'NOT_FOUND' | 'UNAVAILABLE' | 'ERROR' | 'NO_TABLE' | 'NO_VALUE_COLUMN';
  fidelity: string;
  points: HistorianSeriesPoint[];
  total: number;
  downsampled: boolean;
  bucket_ms?: number | null;
  truncated: boolean;
  next_cursor?: string | null;
  column?: string | null;
  coverage_notes: string[];
  stats: HistorianSeriesStats;
  /** Merged runs of equal quality; `STALE` + `reason_code: STALE_GAP` for silences past the stale threshold; [] when downsampled. */
  quality_segments?: HistorianQualitySegment[];
  /** H-R4.1: a raw signal with no rows in Recorded mode — the tables that record it (directly or via its Data Model field). */
  recorded_in?: { token: string; label: string; recording?: string | null }[];
}

export interface HistorianQualitySegment {
  start: string;
  end: string;
  quality: 'GOOD' | 'UNCERTAIN' | 'STALE' | 'BAD' | string;
  reason_code?: string | null;
}

export interface HistorianMultiQuery {
  sources: string[];
  start: string;
  end: string;
  mode: 'operational' | 'recorded' | 'reconstructed';
  resolution?: 'auto' | 'raw' | 'bucket';
  max_points?: number;
  bucket_ms?: number;
  cursor?: string;
  /** "1h" | "1d" | "7d" or milliseconds (newer servers; older ones ignore it). */
  compare_offset?: string | number;
}

export interface HistorianQueryResponse {
  series_list: HistorianSeriesResult[];
  downsampled: boolean;
  history_available: boolean;
  coverage_notes: string[];
  next_cursor: string | null;
  start?: string;
  end?: string;
  /** Newer servers: the same series over the earlier window, points shifted onto the main axis. */
  compare?: { offset_ms: number; start: string; end: string; series_list: HistorianSeriesResult[] } | null;
}

/** POST /api/v1/historian/query — every series in one call; values are in `point.value`. */
export async function queryHistorianSeries(params: HistorianMultiQuery, signal?: AbortSignal): Promise<HistorianQueryResponse> {
  return api('/api/v1/historian/query', { method: 'POST', body: JSON.stringify(params), signal });
}

/** Legacy single-source query (kept for older callers). */
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

export interface HistorianEvent {
  id: string;
  ts: string;
  kind: 'QUALITY_TRANSITION' | 'STORAGE_OPERATION' | 'EPOCH_RESET' | string;
  summary?: string;
  message?: string;
  signal_id?: string;
  signal_key?: string;
  /** QUALITY_TRANSITION (H12): stored history of the signal's raw quality. */
  from_state?: string | null;
  to_state?: string | null;
  samples?: number | null;
  until?: string | null;
  data_epoch?: number;
}

/**
 * GET /api/v1/historian/events. Storage operations and telemetry resets are tenant-wide; quality transitions
 * (H12) come from the stored rows of the named signals only (`signal_ids` required for them).
 */
export async function listHistorianEvents(
  params: { start: string; end: string; types?: string[]; signal_ids?: string[]; limit?: number },
  signal?: AbortSignal,
): Promise<{ items: HistorianEvent[] }> {
  const qs = new URLSearchParams({ start: params.start, end: params.end, limit: String(params.limit ?? 200) });
  if (params.types?.length) qs.set('types', params.types.join(','));
  if (params.signal_ids?.length) qs.set('signal_ids', params.signal_ids.join(','));
  return api(`/api/v1/historian/events?${qs}`, { signal });
}

/** One machine group of GET /api/v1/historian/sources (H8). Only the parts the UI reads are typed. */
export interface HistorianSourceGroup {
  resource: { id: string | null; name: string; code?: string | null; type_key?: string | null } | null;
  path?: string[];
  subtables?: {
    token: string;
    label: string;
    database: string;
    subtable: string;
    column?: string | null;
    recording?: string | null;
    /** `<signal uuid>` or `mod:<model>:<field path>` the table records. */
    source?: string | null;
  }[];
}

/** One bound value column of a user subtable (H-R4.1). */
export interface RecordedSeriesItem {
  kind: 'subtable';
  token: string;
  label: string;
  database: string;
  subtable: string;
  stable?: string | null;
  column?: string | null;
  value_type?: string | null;
  unit?: string | null;
  recording?: string | null;
  binding_status?: string | null;
  source?: string | null;
  source_kind?: string | null;
  model_name?: string | null;
  field_path?: string | null;
  signal_key?: string | null;
  machine?: { id: string; name: string; code?: string | null; type_key?: string | null } | null;
}

/**
 * GET /api/v1/historian/sources/recorded?q&page&page_size (≤500) — the recorded-table catalogue, searchable on the
 * server (H-R4.1, R2-03). 404 on older Centers.
 */
export async function listRecordedSeries(
  params: { q?: string; page?: number; page_size?: number; machine_id?: string },
  signal?: AbortSignal,
): Promise<{ items: RecordedSeriesItem[]; total: number; page: number; page_size: number; has_more: boolean }> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.page) qs.set('page', String(params.page));
  if (params.page_size) qs.set('page_size', String(params.page_size));
  if (params.machine_id) qs.set('machine_id', params.machine_id);
  return api(`/api/v1/historian/sources/recorded?${qs}`, { signal });
}

/**
 * GET /api/v1/historian/sources?kinds=subtable[&search=] — every recorded table (no 50-row page), grouped by the
 * machine it records, with the source it records (R2-03).
 */
export async function getHistorianSources(params: { kinds?: string[]; search?: string }, signal?: AbortSignal): Promise<{ items: HistorianSourceGroup[] }> {
  const qs = new URLSearchParams();
  if (params.kinds?.length) qs.set('kinds', params.kinds.join(','));
  if (params.search) qs.set('search', params.search);
  return api(`/api/v1/historian/sources?${qs}`, { signal });
}

/** What a saved view stores (free-form JSON on the server; this is the Historian UI's own shape). */
export interface HistorianViewSpec {
  v?: number;
  sources: string[];
  labels?: Record<string, string>;
  mode?: 'operational' | 'recorded' | 'reconstructed';
  range?: string | null;
  start?: string | null;
  end?: string | null;
  compare_offset?: string | null;
  live?: boolean;
  layout?: string;
  hidden?: string[];
  tab?: string;
  [key: string]: unknown;
}

export interface SavedView {
  id: string;
  name: string;
  description?: string | null;
  query_spec: HistorianViewSpec;
  chart_options?: Record<string, unknown>;
  is_default?: boolean;
  visibility?: 'PRIVATE' | 'TEAM' | string;
  version?: number;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
}

export async function listSavedViews(q?: string): Promise<SavedView[]> {
  const res = await api<SavedView[] | { items: SavedView[] }>(`/api/v1/historian/views${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  return Array.isArray(res) ? res : res?.items || [];
}

export async function saveView(view: {
  name: string;
  description?: string;
  query_spec: HistorianViewSpec;
  chart_options?: Record<string, unknown>;
  visibility?: 'PRIVATE' | 'TEAM';
  is_default?: boolean;
}): Promise<SavedView> {
  return api('/api/v1/historian/views', { method: 'POST', body: JSON.stringify(view) });
}

/** PATCH with optimistic concurrency (newer servers; 409 VERSION_CONFLICT when someone else saved first). */
export async function updateView(
  id: string,
  version: number | undefined,
  patch: Partial<{ name: string; description: string; query_spec: HistorianViewSpec; chart_options: Record<string, unknown> }>,
): Promise<SavedView> {
  return api(`/api/v1/historian/views/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: version != null ? { 'If-Match': String(version) } : undefined,
    body: JSON.stringify(version != null ? { ...patch, version } : patch),
  });
}

export async function deleteView(id: string): Promise<{ ok: boolean }> {
  return api(`/api/v1/historian/views/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface ExportJob {
  id: string;
  status: 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'READY' | 'FAILED' | 'ERROR' | 'CANCELLED' | 'EXPIRED' | string;
  format: 'csv' | 'json' | string;
  file_name?: string | null;
  row_count?: number | null;
  byte_size?: number | null;
  download_url?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  truncated_series?: string[];
  query_spec?: Record<string, unknown>;
  created_at: string;
  completed_at?: string | null;
  expires_at?: string | null;
  // newer servers
  title?: string | null;
  series?: string[];
  start?: string | null;
  end?: string | null;
  mode?: string | null;
  progress_pct?: number | null;
}

export async function createExportJob(
  params: {
    sources: string[];
    start: string;
    end: string;
    from_ts?: string;
    to_ts?: string;
    mode?: string;
    format: 'csv' | 'json';
    file_name?: string;
    title?: string;
    labels?: Record<string, string>;
  },
  signal?: AbortSignal,
): Promise<ExportJob> {
  return api('/api/v1/historian/exports', { method: 'POST', body: JSON.stringify(params), signal });
}

export async function getExportJob(id: string): Promise<ExportJob> {
  return api(`/api/v1/historian/exports/${encodeURIComponent(id)}`);
}

export async function listExportJobs(): Promise<ExportJob[]> {
  const res = await api<ExportJob[] | { items: ExportJob[] }>('/api/v1/historian/exports');
  return Array.isArray(res) ? res : res?.items || [];
}

export async function retryExportJob(id: string): Promise<ExportJob> {
  return api(`/api/v1/historian/exports/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

export async function cancelExportJob(id: string): Promise<ExportJob> {
  return api(`/api/v1/historian/exports/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

// --- KPI stats ---

export async function getStorageStats(signal?: AbortSignal): Promise<{
  database_count: number;
  stable_count: number;
  subtable_count: number;
  recording_active: number;
  recording_paused: number;
  recording_error: number;
  /** `db.subtable` of (up to 50 of) the subtables counted in `recording_error`. */
  recording_error_objects?: string[];
  observed_at: string;
}> {
  return api('/api/v1/storage/td/stats', { signal });
}

/** One subtable whose rows the writer could not store (`GET /storage/recording/failures`, R2-07). */
export interface RecordingFailure {
  object_id: string;
  database: string;
  subtable: string;
  display_name: string;
  object_status: string | null;
  failed: number;
  attempts: number;
  last_error: string | null;
  first_failed_at: string | null;
  last_failed_at: string | null;
}

export function listRecordingFailures(signal?: AbortSignal): Promise<{ items: RecordingFailure[]; total: number }> {
  return api('/api/v1/storage/recording/failures', { signal });
}
