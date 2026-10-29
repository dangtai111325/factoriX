export type ResourceType = 'enterprise' | 'site' | 'plant' | 'zone' | 'line' | 'machine' | 'sensor';

export interface ResourceNode {
  id: string;
  name: string;
  type: ResourceType;
  code: string;
  status: 'running' | 'idle' | 'warning' | 'offline';
  parentId?: string;
  plantId?: string;
  childrenCount?: number;
  signalsCount?: number;
  description?: string;
  attributes?: Record<string, string>;
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

export interface ConnectionItem {
  id: string;
  name: string;
  protocol: ProtocolType;
  endpoint: string;
  status: 'connected' | 'disconnected' | 'warning' | 'testing';
  plantId?: string;
  latencyMs: number;
  lastConnected: string;
  signalsCount: number;
  throughputPerSec: number;
  errorRate: number;
  config: Record<string, any>;
  lastTestResult?: {
    overallStatus: TestExecutionState;
    timestamp: string;
    steps: TestStepResult[];
  };
}

export type SignalDataType = 'analog' | 'boolean' | 'integer' | 'string' | 'calculated';

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
  quality: 'GOOD' | 'UNCERTAIN' | 'BAD' | 'STALE';
  lastUpdated: string;
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
