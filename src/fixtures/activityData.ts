import { ActivityEvent } from '../types';

export const initialActivities: ActivityEvent[] = [
  {
    id: 'act-evt-101',
    timestamp: '2026-10-29 11:55:42',
    severity: 'info',
    source: 'OPC-UA Engine',
    eventType: 'SUBSCRIPTION_RENEWED',
    message: 'Subscription #8401 renewed 520 monitored items successfully',
    details: {
      publishingIntervalMs: 100,
      revisedSamplingInterval: 50,
      revisedQueueSize: 10,
      clientHandleCount: 520,
    },
  },
  {
    id: 'act-evt-102',
    timestamp: '2026-10-29 11:52:10',
    severity: 'warning',
    source: 'Modbus Adapter',
    eventType: 'FRAME_CRC_ERROR',
    message: 'CRC16 mismatch detected on unitId 2 register block 40100..40110',
    details: {
      unitId: 2,
      expectedCrc: '0x4A1F',
      receivedCrc: '0x4A22',
      retryAttempt: 2,
      gateway: '192.168.10.24:502',
    },
  },
  {
    id: 'act-evt-103',
    timestamp: '2026-10-29 11:45:00',
    severity: 'success',
    source: 'Configuration Manager',
    eventType: 'REVISION_ACTIVATED',
    message: 'Configuration revision #14 activated across all worker nodes',
    details: {
      revision: 14,
      author: 'Local Operator (Web UI)',
      changesApplied: {
        addedSignals: 4,
        modifiedCalculated: 1,
      },
    },
  },
  {
    id: 'act-evt-104',
    timestamp: '2026-10-29 11:30:15',
    severity: 'info',
    source: 'Formula Engine',
    eventType: 'AST_DAG_COMPILED',
    message: 'Formula SIG-CALC-THERMAL compiled with 2 upstream dependencies',
    details: {
      dagNodes: ['CNC_01.SPINDLE.TEMP', 'CNC_01.SPINDLE.ACTUAL_RPM'],
      estimatedCostMicrosec: 4.2,
    },
  },
  {
    id: 'act-evt-105',
    timestamp: '2026-10-29 11:15:30',
    severity: 'info',
    source: 'MQTT Northbound',
    eventType: 'CLIENT_CONNECTED',
    message: 'Connected to MQTT Edge Broker mqtt://192.168.10.5:1883',
    details: {
      clientId: 'factorix-collector-prod-01',
      assignedSession: true,
      protocolVersion: 'MQTT v5.0',
    },
  },
  {
    id: 'act-evt-106',
    timestamp: '2026-10-29 10:48:19',
    severity: 'error',
    source: 'HTTP Client',
    eventType: 'HTTP_504_GATEWAY_TIMEOUT',
    message: 'Gateway timeout polling https://mes-api.factorix.local/v1/telemetry',
    details: {
      statusCode: 504,
      durationMs: 5002,
      recoveryAction: 'Exponential backoff applied (next in 10s)',
    },
  },
];
