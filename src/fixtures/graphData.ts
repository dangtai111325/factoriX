export interface GraphNode {
  id: string;
  name: string;
  type: 'machine' | 'line' | 'connection' | 'power' | 'utility' | 'signal' | 'mes';
  category: 'center' | 'incoming' | 'outgoing';
  status: 'running' | 'idle' | 'warning' | 'normal';
  details?: Record<string, string>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  type: 'feeds' | 'part_of' | 'powers' | 'collects' | 'depends_on';
}

export const knowledgeGraphData: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: [
    {
      id: 'node-center',
      name: 'CNC Milling Center 01',
      type: 'machine',
      category: 'center',
      status: 'running',
      details: {
        AssetTag: 'MC-CNC-001',
        Line: 'Line 01 - CNC',
        Gateway: 'OPC-UA Plant01',
        Uptime: '99.4%',
      },
    },
    {
      id: 'node-in-line',
      name: 'Line 01 - Machining',
      type: 'line',
      category: 'incoming',
      status: 'normal',
    },
    {
      id: 'node-in-power',
      name: '400V Bus Feeder A',
      type: 'power',
      category: 'incoming',
      status: 'normal',
    },
    {
      id: 'node-in-coolant',
      name: 'Central Coolant Loop 2',
      type: 'utility',
      category: 'incoming',
      status: 'normal',
    },
    {
      id: 'node-in-gateway',
      name: 'OPC-UA Gateway #1',
      type: 'connection',
      category: 'incoming',
      status: 'running',
    },
    {
      id: 'node-out-robot',
      name: 'Transfer Robot 03',
      type: 'machine',
      category: 'outgoing',
      status: 'idle',
    },
    {
      id: 'node-out-conveyor',
      name: 'Chip Conveyor Subsystem',
      type: 'utility',
      category: 'outgoing',
      status: 'running',
    },
    {
      id: 'node-out-formula',
      name: 'SIG-CALC-THERMAL',
      type: 'signal',
      category: 'outgoing',
      status: 'normal',
    },
    {
      id: 'node-out-mes',
      name: 'MES Order Dispatch #8421',
      type: 'mes',
      category: 'outgoing',
      status: 'normal',
    },
  ],
  edges: [
    { id: 'e1', from: 'node-in-line', to: 'node-center', label: 'contains', type: 'part_of' },
    { id: 'e2', from: 'node-in-power', to: 'node-center', label: 'powers', type: 'powers' },
    { id: 'e3', from: 'node-in-coolant', to: 'node-center', label: 'cools', type: 'feeds' },
    { id: 'e4', from: 'node-in-gateway', to: 'node-center', label: 'collects', type: 'collects' },
    { id: 'e5', from: 'node-center', to: 'node-out-robot', label: 'hands off parts', type: 'feeds' },
    { id: 'e6', from: 'node-center', to: 'node-out-conveyor', label: 'discharges chips', type: 'feeds' },
    { id: 'e7', from: 'node-center', to: 'node-out-formula', label: 'derived input', type: 'depends_on' },
    { id: 'e8', from: 'node-center', to: 'node-out-mes', label: 'reports completion', type: 'depends_on' },
  ],
};
