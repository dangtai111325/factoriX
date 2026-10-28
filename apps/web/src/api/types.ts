/**
 * FactoriX IIoT Platform - TypeScript Data Contracts
 * Matched 100% to FastAPI Backend Schemas and Models
 */

export interface AuthStatus {
  admin_exists: boolean;
  bootstrap_enabled: boolean;
  setup_code_required: boolean;
  appliance: boolean;
}

export interface Principal {
  admin_id: string;
  tenant_id: string;
  login: string;
  email: string;
  role: string;
  tenant_name?: string;
  created_at?: string;
}

export type CurrentUser = Principal;

export interface Site {
  id: string;
  code: string;
  name: string;
  timezone: string;
}

export interface ResourceType {
  id: string;
  key: string;
  name: string;
  category: string;
  properties_schema?: Record<string, any>;
  parent_type_keys?: string[];
  child_type_keys?: string[];
}

export interface Resource {
  id: string;
  code: string;
  name: string;
  type_id: string;
  type_key?: string;
  type_name?: string;
  site_id: string | null;
  parent_id: string | null;
  description?: string;
  tags?: string[];
  properties?: Record<string, any>;
  archived_at?: string | null;
  version: number;
}

export interface ResourceRelation {
  id?: string;
  from_id: string;
  to_id: string;
  relation_code: "CONTAINS" | "FEEDS" | "LOCATED_AT" | "MONITORS" | string;
  valid_from?: string;
  valid_to?: string;
}

export interface LayoutDefinition {
  id: string;
  name: string;
  scope_resource_id: string | null;
  draft_json: {
    nodes?: Array<{
      id: string;
      resource_id?: string;
      label?: string;
      x: number;
      y: number;
      w?: number;
      h?: number;
      type?: string;
      custom?: Record<string, any>;
    }>;
    edges?: Array<{
      id: string;
      source: string;
      target: string;
      label?: string;
    }>;
  };
  version: number;
  published_revision: number;
  updated_at?: string;
}

export interface EdgeNode {
  id: string;
  name: string;
  site_id: string | null;
  enrollment_status: "PENDING" | "ENROLLED" | "REVOKED" | "UNENROLLED" | string;
  desired_revision: number;
  active_revision: number;
  last_heartbeat?: string | null;
  health: "HEALTHY" | "ACTIVE" | "DEGRADED" | "OFFLINE" | "CONFIG_PENDING" | "UNKNOWN" | string;
  software_version?: string;
  outbox_pending?: number;
}

export interface Connection {
  id: string;
  name: string;
  site_id: string | null;
  edge_id: string | null;
  protocol: "modbus_tcp" | "opc_ua" | "mqtt_client" | "http_pull" | string;
  config: Record<string, any>;
  status: "ACTIVE" | "PAUSED" | "ERROR";
  health: "HEALTHY" | "DEGRADED" | "UNKNOWN" | "ERROR";
  last_error?: string | null;
  updated_at?: string;
  jobs?: Array<{
    id: string;
    mode: string;
    interval_ms: number;
    timeout_ms: number;
    enabled: boolean;
  }>;
}

export interface CommissioningJob {
  id: string;
  connection_id: string;
  connection_name?: string;
  protocol?: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  error_code?: string | null;
  diagnostic?: string | null;
  started_at: string;
  completed_at?: string | null;
  stages_json: Array<{
    stage: string;
    name?: string;
    status: "PASSED" | "FAILED" | "PENDING" | "SKIPPED";
    details?: string;
    raw?: any;
  }>;
}

export interface Signal {
  id: string;
  resource_id: string;
  key: string;
  display_name: string;
  data_type: "float64" | "int64" | "boolean" | "string" | string;
  unit?: string | null;
  expected_interval_ms?: number | null;
  source_field?: {
    acquisition_job_id?: string;
    address_kind?: string;
    address?: Record<string, any>;
    mapping_expression?: string;
  };
  version: number;
}

export interface LatestSignalState {
  signal_id: string;
  value: any;
  quality: "GOOD" | "BAD" | "UNCERTAIN" | null;
  event_time?: string;
  received_time?: string;
  freshness?: "FRESH" | "STALE" | "UNKNOWN" | string;
}

export interface Formula {
  id: string;
  signal_id: string;
  resource_id: string;
  key: string;
  display_name: string;
  expression_source: string;
  unit?: string | null;
  revision: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
}

export interface OutputGroup {
  id: string;
  resource_id: string;
  resource_code?: string;
  key: string;
  display_name: string;
  topic_template: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  version: number;
  member_count?: number;
}

export interface ConfigRelease {
  id: string;
  edge_id?: string;
  edge_name?: string;
  revision: number;
  published_at: string;
  status: string;
}

export interface Dashboard {
  id: string;
  name: string;
  description?: string;
  site_id?: string | null;
  draft_revision: number;
  published_revision: number;
  version: number;
  updated_at?: string;
  draft?: {
    widgets?: Array<{
      id: string;
      title?: string;
      type: "kpi" | "chart" | "gauge" | "status_grid";
      bindings?: Array<{ signal_id: string; label?: string }>;
      config?: Record<string, any>;
    }>;
  };
}

export interface AuditEvent {
  id: string;
  event_type: string;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  before_json: any;
  after_json: any;
  correlation_id: string;
  occurred_at: string;
}

export interface OverviewData {
  resources: number;
  machines: number;
  active_connections: number;
  healthy_edges: number;
  ingest_per_minute: number;
  generated_at: string;
  edges: EdgeNode[];
  connection_health: Array<{ health: string; count: number }>;
  recent_errors: Array<{ id: string; name: string; last_error: string; health: string }>;
}

export interface StorageOverview {
  observations: number;
  ingest_per_minute: number;
  quarantine: number;
  dedup_keys: number;
  oldest?: string | null;
  newest?: string | null;
}

export interface RetentionPolicy {
  id: string;
  scope_type: string;
  scope_id: string | null;
  keep_days: number;
  status: "ENABLED" | "DISABLED";
  last_executed_at?: string | null;
}

export interface SearchResult {
  resources: Array<{ id: string; code: string; name: string }>;
  connections: Array<{ id: string; name: string; protocol: string }>;
  signals: Array<{ id: string; key: string; display_name: string }>;
}
