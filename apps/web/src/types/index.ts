export type ResourceType =
  | 'enterprise'
  | 'site'
  | 'plant'
  | 'area'
  | 'zone'
  | 'line'
  | 'workshop'
  | 'cell'
  | 'utility_system'
  | 'machine'
  | 'sensor'
  | 'physical_asset';

export interface ResourceNode {
  id: string;
  name: string;
  type: ResourceType;
  code: string;
  status: 'running' | 'idle' | 'warning' | 'offline';
  parentId?: string;
  parent_id?: string;
  pathCode?: string;
  path_code?: string;
  plantId?: string;
  childrenCount?: number;
  signalsCount?: number;
  description?: string;
  attributes?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export type ProtocolType = 'modbus' | 'opcua' | 'mqtt' | 'http' | 'websocket';

/** Stored protocol keys used by the Center API (`connections.protocol`). */
export type StoredProtocol = 'modbus_tcp' | 'opcua' | 'mqtt' | 'http' | 'websocket';

/** Display state of a connection, derived from lifecycle status + server `effective_health`. */
export type ConnectionDisplayState = 'connected' | 'idle' | 'degraded' | 'paused' | 'unknown';

/** Effective signal status as computed by the Center (`latest_signal_state` evaluation). */
export type SignalQuality = 'GOOD' | 'UNCERTAIN' | 'BAD' | 'STALE' | 'NO_DATA' | 'DISABLED';

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

export interface ConnectionItem {
  id: string;
  name: string;
  protocol: ProtocolType;
  endpoint: string;
  /** Display state (see ConnectionDisplayState). */
  status: ConnectionDisplayState | string;
  /** Raw lifecycle status from the API: ACTIVE | PAUSED | DRAFT | ARCHIVED. */
  lifecycleStatus?: string;
  /** Server-computed effective health (HEALTHY | DEGRADED | IDLE | PAUSED | UNKNOWN …); falls back to `health`. */
  effectiveHealth?: string;
  version?: number;
  messagesPerMin?: number;
  secretConfigured?: boolean;
  edgeName?: string;
  lastSuccessAt?: string;
  plantId?: string;
  siteId?: string;
  site_id?: string;
  edgeId?: string;
  edge_id?: string;
  health?: string;
  latencyMs: number;
  lastConnected: string;
  signalsCount: number;
  throughputPerSec: number;
  errorRate: number;
  config: Record<string, any>;
  lastError?: string;
  lastErrorTimestamp?: string;
  updatedAt?: string;
  lastTestResult?: {
    overallStatus: TestExecutionState;
    timestamp: string;
    steps: TestStepResult[];
  };
}

export type Connection = ConnectionItem;

export type SignalDataType = 'analog' | 'boolean' | 'integer' | 'string' | 'calculated';

export type SignalBindingType = 'modbus_register' | 'opcua_node' | 'mqtt_jsonpath' | 'http_json' | 'calculated_ast';

export interface SignalItem {
  id: string;
  name: string;
  key?: string;
  tag: string;
  display_name?: string;
  displayName?: string;
  type?: string;
  enabled?: boolean;
  qualityReason?: string;
  expectedIntervalMs?: number;
  description?: string;
  connectionId?: string;
  connection_id?: string;
  topic?: string;
  address?: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  resourceId: string;
  resource_id?: string;
  resourcePath: string;
  plantId?: string;
  dataType: SignalDataType | string;
  data_type?: string;
  unit?: string;
  currentValue?: number | string | boolean | null;
  value?: number | string | boolean | null;
  /** Effective status code (SignalQuality), always upper case. */
  quality: SignalQuality | string;
  reasonCode?: string;
  /** Last read = acquisition time on the edge (`received_time`). Same as `receivedTime`. */
  lastUpdated: string;
  receivedTime?: string;
  /** Last change = source-reported group timestamp (`source_time`), metadata only. */
  sourceTime?: string;
  version?: number;
  addressKind?: string;
  addressJson?: Record<string, unknown>;
  /** Position of the source field in the request that created it (source order chosen in Add Data). */
  sourceOrdinal?: number;
  /** Position in the Center list (resource code, creation time, source ordinal). */
  listIndex?: number;
  edgeName?: string;
  connectionProtocol?: string;
  sampleIntervalMs: number;
  bindingType?: SignalBindingType;
  bindingAddress?: string;
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
  title?: string;
  description?: string;
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
  status: 'running' | 'idle' | 'warning' | 'offline';
  temperature?: number;
  pressure?: number;
  speed?: number;
  power?: number;
}

export interface OutputGroup {
  id: string;
  name: string;
  topicTemplate: string;
  enabled: boolean;
  publishIntervalMs: number;
  assignedSignals: string[];
  lastPublished: string;
  samplePayload: string;
}

export interface DiagnosticItem {
  id: string;
  connectionId: string;
  connectionName: string;
  protocol: ProtocolType;
  status: 'healthy' | 'degraded' | 'critical';
  uptimeSeconds: number;
  messagesReceived: number;
  messagesDropped: number;
  lastError?: string;
  lastErrorTimestamp?: string;
}

export interface EdgeItem {
  id: string;
  name: string;
  siteId: string;
  site_id?: string;
  enrollmentStatus: string;
  enrollment_status?: string;
  health: string;
  desiredRevision: number;
  desired_revision?: number;
  activeRevision: number;
  active_revision?: number;
  lastHeartbeat: string;
  last_heartbeat?: string;
  softwareVersion?: string;
  software_version?: string;
}
