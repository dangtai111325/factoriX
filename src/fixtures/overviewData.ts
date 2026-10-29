export const overviewKpis = [
  {
    id: 'kpi-connections',
    title: 'Active Connections',
    value: '22',
    total: '24',
    change: '+2 this week',
    changeType: 'positive',
    status: 'good',
  },
  {
    id: 'kpi-signals',
    title: 'Collected Signals',
    value: '1,428',
    total: '1,450',
    change: '+45 new tags',
    changeType: 'positive',
    status: 'good',
  },
  {
    id: 'kpi-throughput',
    title: 'Throughput',
    value: '12.4k',
    unit: 'msg/s',
    change: '99.98% delivery',
    changeType: 'neutral',
    status: 'good',
  },
  {
    id: 'kpi-buffer',
    title: 'Buffer Memory',
    value: '1.28 GB',
    total: '4.0 GB',
    change: '32% allocated',
    changeType: 'neutral',
    status: 'good',
  },
];

export const connectionHealthStats = {
  connected: 22,
  degraded: 2,
  offline: 0,
  total: 24,
};

export const signalHealthStats = {
  good: 1406,
  stale: 18,
  bad: 4,
  total: 1428,
};

export const throughputTrend = [
  { time: '10:00', value: 10.2 },
  { time: '10:15', value: 11.4 },
  { time: '10:30', value: 11.8 },
  { time: '10:45', value: 12.1 },
  { time: '11:00', value: 12.4 },
  { time: '11:15', value: 12.6 },
  { time: '11:30', value: 12.2 },
  { time: '11:45', value: 12.4 },
];

export const recentSystemEvents = [
  {
    id: 'ev-1',
    timestamp: '11:42:15',
    severity: 'success',
    source: 'OPC-UA-Server-01',
    message: 'Subscription node batch reconnected with 0 drops',
  },
  {
    id: 'ev-2',
    timestamp: '11:38:02',
    severity: 'warning',
    source: 'Modbus-GW-Assembly',
    message: 'Register poll timeout exceeded 150ms (recovered in 32ms)',
  },
  {
    id: 'ev-3',
    timestamp: '11:30:10',
    severity: 'info',
    source: 'FormulaEngine',
    message: 'Calculated tag SIG-CALC-OEE-01 activated successfully',
  },
  {
    id: 'ev-4',
    timestamp: '11:15:44',
    severity: 'info',
    source: 'MQTT-Broker-Cloud',
    message: 'Output group Packaging-UNS subscribed to 3 consumers',
  },
];

export const liveDataTable = [
  {
    id: 'sig-001',
    name: 'Spindle Bearing Temperature',
    tag: 'CNC_01.SPINDLE.TEMP',
    resource: 'Plant 1 / Line 01 / CNC Milling 01',
    value: '42.8',
    unit: '°C',
    quality: 'GOOD',
    freshness: '120ms ago',
  },
  {
    id: 'sig-002',
    name: 'Hydraulic Pressure Transducer',
    tag: 'PRESS_02.HYD.BAR',
    resource: 'Plant 1 / Line 01 / Stamping Press 02',
    value: '168.4',
    unit: 'bar',
    quality: 'GOOD',
    freshness: '45ms ago',
  },
  {
    id: 'sig-003',
    name: 'Extruder Feed Screw Speed',
    tag: 'EXTRUDER_A.RPM',
    resource: 'Plant 2 / Line 03 / Extruder A',
    value: '1,450',
    unit: 'RPM',
    quality: 'GOOD',
    freshness: '210ms ago',
  },
  {
    id: 'sig-004',
    name: 'Main Conveyor Power Consumption',
    tag: 'CONV_LINE1.KW',
    resource: 'Plant 1 / Line 01 / Main Conveyor',
    value: '18.75',
    unit: 'kW',
    quality: 'GOOD',
    freshness: '10ms ago',
  },
  {
    id: 'sig-005',
    name: 'Packaging Heat Sealer Temp',
    tag: 'PACK_SEAL.TEMP',
    resource: 'Plant 1 / Line 02 / Packaging Unit',
    value: '185.2',
    unit: '°C',
    quality: 'GOOD',
    freshness: '85ms ago',
  },
];
