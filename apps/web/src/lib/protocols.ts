import { ProtocolType } from '../types';

/** One display name per protocol, used for badges, tables and filters (R2-CN-05). */
export const PROTOCOL_LABEL: Record<ProtocolType, string> = {
  mqtt: 'MQTT',
  modbus: 'Modbus TCP',
  opcua: 'OPC UA',
  http: 'HTTP',
  websocket: 'WebSocket',
};

const DEFAULT_SCHEME: Record<ProtocolType, string> = {
  modbus: 'modbus',
  opcua: 'opc.tcp',
  mqtt: 'mqtt',
  http: 'http',
  websocket: 'ws',
};

/**
 * Endpoint as a URL with its scheme for every protocol, e.g. `modbus://host:502`. The Center already
 * returns a scheme for every protocol except Modbus TCP (`host:port`).
 */
export function endpointWithScheme(protocol: ProtocolType, endpoint: string): string {
  const text = (endpoint || '').trim();
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `${DEFAULT_SCHEME[protocol]}://${text}`;
}
