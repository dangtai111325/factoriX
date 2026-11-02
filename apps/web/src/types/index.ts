export type ResourceType =
  | 'enterprise'
  | 'site'
  | 'area'
  | 'plant'
  | 'zone'
  | 'line'
  | 'workshop'
  | 'cell'
  | 'utility_system'
  | 'machine'
  | 'sensor'
  | 'physical_asset'
  | 'functional_position'
  | string;

export interface ResourceNode {
  id: string;
  name: string;
  type: ResourceType;
  code: string;
  status: 'running' | 'idle' | 'warning' | 'offline' | 'archived';
  parentId?: string;
  plantId?: string;
  childrenCount?: number;
  signalsCount?: number;
  description?: string;
  attributes?: Record<string, string>;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ProtocolType = 'modbus' | 'opcua' | 'mqtt' | 'http';

export type DemoScenario = 'healthy' | 'degraded_modbus' | 'timeout_opcua' | 'auth_fail_mqtt' | 'offline';

export type TestExecutionState = 'NOT_TESTED' | 'IN_PROGRESS' | 'PASS' | 'FAIL' | 'TIMEOUT' | 'AUTH_ERROR';

export interface TestStepResult {
  stage: 'TCP_HANDSHAKE' | 'PROTOCOL_CONNECT' | 'NODE_BROWSE' | 'REGISTER_READ' | 'SUBSCRIBE';
  status: TestExecutionState;
  latencyMs?: number;
  details: string;
  timestamp: string;
  errorCode?: string;
}

export interface PlantScope {
  id: string;
  name: string;
  code: string;
  zone: string;
  status: 'operational' | 'warning' | 'maintenance';
  assetsCount: number;
}

export type ConnectionLifecycle = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export interface ConnectionItem {
  id: string;
  name: string;
  protocol: ProtocolType;
  endpoint: string;
  /** Derived health presentation for badges; DRAFT must not appear as DISCONNECTED. */
  status: 'connected' | 'disconnected' | 'warning' | 'testing' | 'paused' | 'draft';
  lifecycle: ConnectionLifecycle;
  health: string;
  plantId?: string;
  siteId?: string;
  edgeId?: string;
  /** Last connection error from Center, when one was recorded. */
  lastError?: string;
  version?: number;
  /** True when a secret is stored and cannot be copied into a duplicate. */
  secretConfigured?: boolean;
  latencyMs: number | null;
  lastConnected: string;
  signalsCount: number | null;
  throughputPerSec: number | null;
  errorRate: number;
  config: Record<string, any>;
  lastTestResult?: {
    overallStatus: TestExecutionState;
    timestamp: string;
    steps: TestStepResult[];
  };
}

export type SignalDataType = 'number' | 'boolean' | 'integer' | 'text' | 'calculated' | 'analog' | 'string';

export type SignalBindingType = 'modbus_register' | 'opcua_node' | 'mqtt_jsonpath' | 'http_json' | 'calculated_ast';

export interface SignalItem {
  id: string;
  name: string;
  tag: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  resourceId: string;
  resourcePath: string;
  plantId?: string;
  dataType: SignalDataType;
  unit?: string;
  currentValue: number | string | boolean;
  quality: 'GOOD' | 'UNCERTAIN' | 'BAD' | 'STALE' | 'UNKNOWN';
  qualityReason?: string;
  lastUpdated: string;
  /** Event time from payload source_timestamp when available (CR-Q04). */
  sourceTime?: string;
  /** Collector receive / ingest time. */
  receivedTime?: string;
  sampleIntervalMs: number;
  version?: number;
  status?: 'ACTIVE' | 'DISABLED' | 'ARCHIVED';
  bindingType?: SignalBindingType;
  bindingAddress?: string;
  topic?: string;
  jsonpath?: string;
  description?: string;
  /** Edge that owns the source connection, when the connection is assigned to one. */
  edgeName?: string;
  lastGoodValue?: string;
  lastGoodTime?: string;
  history?: number[];
  formula?: string;
  dependencies?: string[];
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'error' | 'success';
  source: string;
  eventType: string;
  message: string;
  entityId?: string;
  entityType?: string;
  actorName?: string;
  details?: Record<string, any>;
}

export interface LayoutMachineNode {
  id: string;
  resourceId: string;
  name: string;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: 'running' | 'idle' | 'warning' | 'offline' | 'archived';
  temperature?: number;
  pressure?: number;
  speed?: number;
  power?: number;
}

export interface OutputGroup {
  id: string;
  name: string;
  key?: string;
  topicTemplate: string;
  enabled: boolean;
  publishIntervalMs: number;
  assignedSignals: string[];
  resourceId?: string;
  version?: number;
  /** flat = compact JSON values; uns = value/unit/quality objects. */
  payloadFormat?: 'flat' | 'uns';
  lastPublished: string;
  samplePayload: string;
  members?: Array<{ signal_id: string; alias: string }>;
}

export interface DiagnosticItem {
  id: string;
  connectionId: string;
  connectionName: string;
  protocol: ProtocolType;
  status: 'healthy' | 'degraded' | 'critical';
  uptimeSeconds: number;
  messagesReceived: number;
  /** Null when Center does not count drops for this connection. */
  messagesDropped: number | null;
  lastError?: string;
  lastErrorTimestamp?: string;
}

export interface EdgeItem {
  id: string;
  name: string;
  siteId: string;
  enrollmentStatus: string;
  health: string;
  desiredRevision: number;
  activeRevision: number;
  lastHeartbeat: string;
  softwareVersion?: string;
  /** Messages still waiting on the edge, when the edge reports a count. */
  outboxPending?: number | null;
}
