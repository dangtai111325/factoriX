export type ResourceType = 'enterprise' | 'site' | 'plant' | 'zone' | 'line' | 'machine' | 'sensor';

export interface ResourceNode {
  id: string;
  name: string;
  type: ResourceType;
  code: string;
  status: 'running' | 'idle' | 'warning' | 'offline';
  parentId?: string;
  childrenCount?: number;
  signalsCount?: number;
  description?: string;
  attributes?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export type ProtocolType = 'modbus' | 'opcua' | 'mqtt' | 'http';

export interface ConnectionItem {
  id: string;
  name: string;
  protocol: ProtocolType;
  endpoint: string;
  status: 'connected' | 'disconnected' | 'warning' | 'testing';
  latencyMs: number;
  lastConnected: string;
  signalsCount: number;
  throughputPerSec: number;
  errorRate: number;
  config: Record<string, any>;
}

export type SignalDataType = 'analog' | 'boolean' | 'integer' | 'string' | 'calculated';

export interface SignalItem {
  id: string;
  name: string;
  tag: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  resourceId: string;
  resourcePath: string;
  dataType: SignalDataType;
  unit?: string;
  currentValue: number | string | boolean;
  quality: 'GOOD' | 'UNCERTAIN' | 'BAD' | 'STALE';
  lastUpdated: string;
  sampleIntervalMs: number;
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
