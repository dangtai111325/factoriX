import React, { useState } from 'react';
import {
  Plus,
  Search,
  Network,
  Cable,
  RadioTower,
  Cloud,
  CheckCircle2,
  RefreshCw,
  Edit2,
  Trash2,
  ExternalLink,
  ShieldCheck,
  Zap,
  Activity,
  FileDown,
  Cpu,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { Tabs } from '../../components/common/Tabs';
import { useApp } from '../../store/AppContext';
import { ConnectionItem, ProtocolType } from '../../types';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AddDataWizardModal } from '../../components/modals/AddDataWizardModal';
import { ConnectionTestModal } from '../../components/modals/ConnectionTestModal';

export const ConnectionsPage: React.FC = () => {
  const { connections, selectedConnectionId, setSelectedConnectionId, testConnection } = useApp();
  const [searchParams] = useSearchParams();
  const [filterProtocol, setFilterProtocol] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('config');
  const [testingId, setTestingId] = useState<string | null>(null);

  // Modals (supports query param deep-linking)
  const [isWizardOpen, setIsWizardOpen] = useState(searchParams.get('modal') === 'wizard');
  const [isTestModalOpen, setIsTestModalOpen] = useState(searchParams.get('modal') === 'test');

  const navigate = useNavigate();

  const selectedConn =
    connections.find((c) => c.id === selectedConnectionId) || connections[0];

  const filteredConnections = connections.filter((c) => {
    const matchesProto = filterProtocol === 'all' || c.protocol === filterProtocol;
    const matchesSearch =
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.endpoint.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesProto && matchesSearch;
  });

  const getProtocolIcon = (proto: ProtocolType) => {
    switch (proto) {
      case 'modbus':
        return <Network className="w-4 h-4 text-[#1D63BD]" />;
      case 'opcua':
        return <Cable className="w-4 h-4 text-[#7B3AE0]" />;
      case 'mqtt':
        return <RadioTower className="w-4 h-4 text-[#149580]" />;
      case 'http':
        return <Cloud className="w-4 h-4 text-[#C76114]" />;
    }
  };

  const handleTest = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingId(id);
    await testConnection(id);
    setTestingId(null);
    setIsTestModalOpen(true);
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1: Heading & Action Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Industrial Connections</h1>
          <p className="fx-page-subtitle">
            Hardware gateways, PLC adapters, and protocol channel management.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="primary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => setIsWizardOpen(true)}
          >
            New Connection
          </Button>
          <Button
            variant="secondary"
            icon={<FileDown className="w-4 h-4" />}
            onClick={() => setIsTestModalOpen(true)}
          >
            Import Template
          </Button>
          <Button
            variant="secondary"
            icon={<Activity className="w-4 h-4" />}
            onClick={() => setIsTestModalOpen(true)}
          >
            Test Diagnostics
          </Button>
        </div>
      </div>

      {/* KPI Cards (Discovered from Image 24) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 block">Total Connections</span>
          <span className="text-2xl font-black text-slate-900 mt-1 block">18</span>
          <span className="text-[11px] text-emerald-600 font-semibold mt-0.5 block">16 Online</span>
        </div>
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 block">Modbus TCP</span>
          <span className="text-2xl font-black text-[#1D63BD] mt-1 block">6</span>
          <span className="text-[11px] text-slate-500 mt-0.5 block">Port 502 / RTU</span>
        </div>
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 block">OPC UA</span>
          <span className="text-2xl font-black text-[#7B3AE0] mt-1 block">5</span>
          <span className="text-[11px] text-slate-500 mt-0.5 block">IEC 62541</span>
        </div>
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 block">MQTT / Sparkplug</span>
          <span className="text-2xl font-black text-[#149580] mt-1 block">3</span>
          <span className="text-[11px] text-slate-500 mt-0.5 block">Brokers active</span>
        </div>
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 block">HTTP / REST</span>
          <span className="text-2xl font-black text-[#C76114] mt-1 block">2</span>
          <span className="text-[11px] text-slate-500 mt-0.5 block">Webhooks</span>
        </div>
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 block">Formula Engine</span>
          <span className="text-2xl font-black text-[#EF1B24] mt-1 block">2</span>
          <span className="text-[11px] text-slate-500 mt-0.5 block">Derived rules</span>
        </div>
      </div>

      {/* Region 2 & 3: Protocol Filter Tabs and Search Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-2">
          {[
            { id: 'all', label: 'All Protocols' },
            { id: 'opcua', label: 'OPC UA' },
            { id: 'modbus', label: 'Modbus TCP' },
            { id: 'mqtt', label: 'MQTT' },
            { id: 'http', label: 'HTTP / API' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterProtocol(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-all ${
                filterProtocol === tab.id
                  ? 'bg-[#FFF0F1] text-[#EF1B24] border border-[#FAC6C9]'
                  : 'bg-white text-[#657794] border border-[#D4DFEC] hover:text-[#111B37]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-64">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#94A3B8]" />
          <input
            type="text"
            placeholder="Search endpoint or name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="fx-input pl-9 h-9 text-[13px]"
          />
        </div>
      </div>

      {/* Region 4: Connection Table */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="fx-table">
            <thead>
              <tr>
                <th>Protocol</th>
                <th>Gateway / Connection Name</th>
                <th>Target Endpoint</th>
                <th>Signals</th>
                <th>Latency</th>
                <th>Throughput</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredConnections.map((conn) => {
                const isSelected = conn.id === selectedConn.id;
                return (
                  <tr
                    key={conn.id}
                    onClick={() => setSelectedConnectionId(conn.id)}
                    data-selected={isSelected}
                    className="cursor-pointer"
                  >
                    <td>
                      <Badge variant={conn.protocol as any}>
                        <div className="flex items-center gap-1.5">
                          {getProtocolIcon(conn.protocol)}
                          <span>{conn.protocol.toUpperCase()}</span>
                        </div>
                      </Badge>
                    </td>
                    <td className="font-bold text-[#111B37] text-[13px]">{conn.name}</td>
                    <td className="font-mono text-[#657794] text-[12px]">{conn.endpoint}</td>
                    <td className="font-semibold text-[#111B37]">{conn.signalsCount} tags</td>
                    <td className="font-mono text-[12px] text-[#657794]">{conn.latencyMs} ms</td>
                    <td className="font-mono text-[12px] text-[#111B37] font-semibold">
                      {conn.throughputPerSec} msg/s
                    </td>
                    <td>
                      <Badge
                        variant={
                          conn.status === 'connected'
                            ? 'good'
                            : conn.status === 'warning'
                            ? 'warning'
                            : conn.status === 'testing'
                            ? 'info'
                            : 'error'
                        }
                      >
                        {conn.status.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="text-[11px] h-7 px-2"
                          onClick={(e) => handleTest(conn.id, e)}
                          loading={testingId === conn.id}
                        >
                          Test
                        </Button>
                        <button
                          type="button"
                          className="p-1 rounded text-[#94A3B8] hover:text-[#111B37]"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(
                              conn.protocol === 'modbus'
                                ? '/acquisition/add-data'
                                : conn.protocol === 'opcua'
                                ? '/acquisition/studio/opcua'
                                : '/acquisition/studio/mqtt'
                            );
                          }}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Detail Pane for Selected Connection */}
      <Card title={`Connection Profile: ${selectedConn.name}`}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
          <div>
            <span className="text-slate-500 block mb-1">Target Endpoint</span>
            <span className="font-mono font-bold text-slate-800 text-sm">{selectedConn.endpoint}</span>
          </div>
          <div>
            <span className="text-slate-500 block mb-1">Polling / Keep-Alive</span>
            <span className="font-mono text-slate-800">Interval: 1000ms · Timeout: 3000ms</span>
          </div>
          <div>
            <span className="text-slate-500 block mb-1">Telemetry Throughput</span>
            <span className="font-bold text-emerald-600">{selectedConn.throughputPerSec} msg/sec</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="w-full text-xs"
              icon={<Activity className="w-3.5 h-3.5" />}
              onClick={() => setIsTestModalOpen(true)}
            >
              Run Handshake Test
            </Button>
          </div>
        </div>
      </Card>

      {/* Interactive Modals */}
      <AddDataWizardModal
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        initialResource={`FactoriX / BinhDuong / Plant01 / ${selectedConn.name}`}
      />

      <ConnectionTestModal
        isOpen={isTestModalOpen}
        onClose={() => setIsTestModalOpen(false)}
        connectionId={selectedConn.id}
        connectionName={selectedConn.name}
        protocol={selectedConn.protocol.toUpperCase()}
        endpoint={selectedConn.endpoint}
      />
    </div>
  );
};
