import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Search,
  Network,
  RadioTower,
  Cable,
  Cloud,
  Waypoints,
  MoreVertical,
  Activity,
  Play,
  Pause,
  Edit2,
  Trash2,
  PlusCircle,
  X,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { ConnectionItem, ProtocolType } from '../../types';
import { ConnectionDetailDrawer } from './ConnectionDetailDrawer';
import { ConnectionFormModal } from './ConnectionFormModal';
import { ConnectionStatusCell } from './connectionStatus';
import { TestResultPanel } from './TestResultPanel';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { api, ApiError } from '../../api/client';
import { CommissionResult, runConnectionTest } from '../../lib/commissioning';
import { timeAgo } from '../../lib/format';

type KpiFilter = 'all' | 'connected' | 'idle' | 'degraded' | 'paused';

export const getProtocolIcon = (proto: ProtocolType) => {
  switch (proto) {
    case 'mqtt':
      return <RadioTower className="w-4 h-4 text-[#149580]" />;
    case 'modbus':
      return <Network className="w-4 h-4 text-[#1D63BD]" />;
    case 'opcua':
      return <Cable className="w-4 h-4 text-[#7B3AE0]" />;
    case 'websocket':
      return <Waypoints className="w-4 h-4 text-[#0E7490]" />;
    default:
      return <Cloud className="w-4 h-4 text-[#C76114]" />;
  }
};

const PROTOCOL_LABEL: Record<ProtocolType, string> = {
  mqtt: 'MQTT',
  modbus: 'Modbus TCP',
  opcua: 'OPC UA',
  http: 'HTTP',
  websocket: 'WebSocket',
};

export const ConnectionsPage: React.FC = () => {
  const { connections, signals, scopedResources, edges, refresh } = useApp();

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>('all');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionItem | null>(null);
  const [archivingConn, setArchivingConn] = useState<ConnectionItem | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Real Edge test results, per connection.
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, CommissionResult>>({});
  const [testPanelId, setTestPanelId] = useState<string | null>(null);

  useEffect(() => {
    const qId = searchParams.get('connectionId');
    if (qId) setSelectedConnId(qId);
  }, [searchParams]);

  useEffect(() => {
    if (!activeMenuId) return;
    const close = () => setActiveMenuId(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [activeMenuId]);

  const selectedConn = useMemo(() => connections.find((c) => c.id === selectedConnId) || null, [connections, selectedConnId]);

  const counts = useMemo(() => {
    const out: Record<KpiFilter, number> = { all: connections.length, connected: 0, idle: 0, degraded: 0, paused: 0 };
    connections.forEach((c) => {
      if (c.status === 'connected') out.connected += 1;
      else if (c.status === 'idle') out.idle += 1;
      else if (c.status === 'paused') out.paused += 1;
      else out.degraded += 1;
    });
    return out;
  }, [connections]);

  const filteredConnections = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return connections.filter((conn) => {
      if (protocolFilter !== 'all' && conn.protocol !== protocolFilter) return false;
      if (kpiFilter === 'connected' && conn.status !== 'connected') return false;
      if (kpiFilter === 'idle' && conn.status !== 'idle') return false;
      if (kpiFilter === 'paused' && conn.status !== 'paused') return false;
      if (kpiFilter === 'degraded' && !(conn.status === 'degraded' || conn.status === 'unknown')) return false;
      if (q) {
        return conn.name.toLowerCase().includes(q) || conn.endpoint.toLowerCase().includes(q) || conn.protocol.toLowerCase().includes(q);
      }
      return true;
    });
  }, [connections, protocolFilter, kpiFilter, searchTerm]);

  const edgeName = (conn: ConnectionItem) => conn.edgeName || edges.find((e) => e.id === conn.edgeId)?.name || '—';

  const handleTest = async (id: string) => {
    setTestPanelId(id);
    setTesting((prev) => ({ ...prev, [id]: true }));
    const result = await runConnectionTest(id, { mode: 'CONNECTIVITY' });
    setTestResults((prev) => ({ ...prev, [id]: result }));
    setTesting((prev) => ({ ...prev, [id]: false }));
  };

  const handlePauseResume = async (conn: ConnectionItem) => {
    const action = conn.lifecycleStatus === 'PAUSED' ? 'resume' : 'pause';
    setActionError(null);
    try {
      await api(`/api/v1/connections/${encodeURIComponent(conn.id)}/${action}`, { method: 'POST' });
      await refresh();
    } catch (error) {
      setActionError(`Could not ${action} "${conn.name}": ${error instanceof Error ? error.message : 'request failed'}`);
    }
  };

  const handleArchive = async () => {
    const conn = archivingConn;
    if (!conn) return;
    setActionError(null);
    try {
      if (conn.lifecycleStatus !== 'PAUSED' && conn.lifecycleStatus !== 'DRAFT') {
        await api(`/api/v1/connections/${encodeURIComponent(conn.id)}/pause`, { method: 'POST' });
      }
      await api(`/api/v1/connections/${encodeURIComponent(conn.id)}`, { method: 'DELETE' });
      setArchivingConn(null);
      if (selectedConnId === conn.id) {
        setSelectedConnId(null);
        setSearchParams({});
      }
      await refresh();
    } catch (error) {
      setArchivingConn(null);
      const message = error instanceof ApiError || error instanceof Error ? error.message : 'request failed';
      setActionError(`Could not archive "${conn.name}": ${message}`);
      await refresh().catch(() => undefined);
    }
  };

  const openEdit = (conn: ConnectionItem) => {
    setEditingConn(conn);
    setIsFormOpen(true);
  };

  const panelConn = testPanelId ? connections.find((c) => c.id === testPanelId) : null;

  return (
    <div className="space-y-4 animate-in fade-in duration-200 pb-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-black text-[#0B2545] tracking-tight">Data Connections</h1>
          <p className="text-xs text-[#64748B]">PLCs, OPC UA servers, MQTT brokers, REST APIs and WebSocket streams read by the Edge collector.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingConn(null);
            setIsFormOpen(true);
          }}
          className="py-2 px-4 rounded-xl bg-[#0B2545] hover:bg-[#134074] text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>New Connection</span>
        </button>
      </div>

      {actionError && (
        <div role="alert" className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center justify-between gap-2">
          <span>{actionError}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setActionError(null)} className="text-red-500 hover:text-red-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {([
          { key: 'all', label: 'Total', color: 'text-[#0B2545]' },
          { key: 'connected', label: 'Connected', color: 'text-[#10B981]' },
          { key: 'idle', label: 'Idle', color: 'text-[#64748B]' },
          { key: 'degraded', label: 'Needs attention', color: 'text-[#EF4444]' },
          { key: 'paused', label: 'Paused', color: 'text-[#475569]' },
        ] as const).map((kpi) => {
          const active = kpiFilter === kpi.key;
          return (
            <button
              key={kpi.key}
              type="button"
              aria-pressed={active}
              onClick={() => setKpiFilter(kpi.key)}
              className={`p-3.5 rounded-2xl border text-left transition-all ${
                active ? 'bg-white border-[#134074] ring-2 ring-[#134074]/10 shadow-sm' : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E1]'
              }`}
            >
              <div className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider truncate">{kpi.label}</div>
              <div className={`text-2xl font-black mt-1 font-mono ${kpi.color}`}>{counts[kpi.key]}</div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[#CBD5E1] bg-white text-xs shadow-sm w-64">
          <Search className="w-3.5 h-3.5 text-[#64748B]" />
          <input
            type="text"
            aria-label="Search connections"
            placeholder="Search connections…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full text-xs font-medium text-[#0B2545] outline-none placeholder:text-[#94A3B8]"
          />
        </div>
        <div className="flex items-center gap-1 bg-[#F1F5F9] p-1 rounded-xl border border-[#E2E8F0] text-xs flex-wrap">
          {(['all', 'mqtt', 'modbus', 'opcua', 'http', 'websocket'] as const).map((proto) => (
            <button
              key={proto}
              type="button"
              aria-pressed={protocolFilter === proto}
              onClick={() => setProtocolFilter(proto)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                protocolFilter === proto ? 'bg-white text-[#0B2545] shadow-sm' : 'text-[#64748B] hover:text-[#0B2545]'
              }`}
            >
              {proto === 'all' ? 'All' : PROTOCOL_LABEL[proto]}
            </button>
          ))}
        </div>
      </div>

      {panelConn && (testing[panelConn.id] || testResults[panelConn.id]) && (
        <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-[#0B2545]">Test result · {panelConn.name}</span>
            <button type="button" aria-label="Close test result" onClick={() => setTestPanelId(null)} className="text-[#64748B] hover:text-[#0B2545]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <TestResultPanel
            running={testing[panelConn.id]}
            runningLabel="The Edge collector is testing reachability and authentication…"
            result={testResults[panelConn.id] || null}
            successLabel="The Edge collector reached the endpoint"
          />
        </div>
      )}

      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm overflow-visible">
        {filteredConnections.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-[#F1F5F9] flex items-center justify-center mx-auto text-[#64748B]">
              <Network className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-bold text-[#0B2545]">No connections found</h3>
            <p className="text-xs text-[#64748B] max-w-sm mx-auto">
              {connections.length === 0 ? 'Click "New Connection" to connect a PLC, server, broker or API.' : 'No connection matches the filters.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-bold text-[#475569] uppercase tracking-wider">
                  <th className="py-3 px-4">Name & Protocol</th>
                  <th className="py-3 px-4">Endpoint</th>
                  <th className="py-3 px-4">Edge</th>
                  <th className="py-3 px-4">Signals</th>
                  <th className="py-3 px-4">Last data</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1F5F9]">
                {filteredConnections.map((conn) => (
                  <tr
                    key={conn.id}
                    onClick={() => {
                      setSelectedConnId(conn.id);
                      setSearchParams({ connectionId: conn.id });
                    }}
                    className="hover:bg-[#F8FAFC] cursor-pointer transition-colors group"
                  >
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="p-1.5 rounded-lg bg-[#F1F5F9]">{getProtocolIcon(conn.protocol)}</div>
                        <div>
                          <div className="font-bold text-[#0B2545] group-hover:text-[#134074] transition-colors">{conn.name}</div>
                          <div className="text-[10px] font-mono text-[#64748B]">{PROTOCOL_LABEL[conn.protocol]}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-[#475569] truncate max-w-[220px]" title={conn.endpoint}>
                      {conn.endpoint}
                    </td>
                    <td className="py-3.5 px-4 text-xs font-semibold text-[#0B2545]">{edgeName(conn)}</td>
                    <td className="py-3.5 px-4 font-mono font-bold text-xs text-[#0B2545]">{conn.signalsCount}</td>
                    <td className="py-3.5 px-4 text-xs text-[#64748B]" title={conn.lastSuccessAt || ''}>
                      {conn.lastSuccessAt ? timeAgo(conn.lastSuccessAt) : '—'}
                    </td>
                    <td className="py-3.5 px-4">
                      <ConnectionStatusCell conn={conn} compact />
                    </td>
                    <td className="py-3.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="relative inline-block">
                        <button
                          type="button"
                          aria-label={`Actions for ${conn.name}`}
                          aria-haspopup="menu"
                          aria-expanded={activeMenuId === conn.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveMenuId(activeMenuId === conn.id ? null : conn.id);
                          }}
                          className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>
                        {activeMenuId === conn.id && (
                          <div role="menu" className="absolute right-0 top-full mt-1 w-52 bg-white border border-[#CBD5E1] rounded-xl shadow-xl z-30 p-1 space-y-0.5 text-left text-xs font-semibold">
                            <button type="button" role="menuitem" onClick={() => { setActiveMenuId(null); void handleTest(conn.id); }} className="w-full px-3 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#0B2545] flex items-center gap-2">
                              <Activity className="w-3.5 h-3.5 text-[#134074]" />
                              <span>Test connection</span>
                            </button>
                            <button type="button" role="menuitem" onClick={() => { setActiveMenuId(null); navigate(`/collector/add-data?connectionId=${encodeURIComponent(conn.id)}`); }} className="w-full px-3 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#0B2545] flex items-center gap-2">
                              <PlusCircle className="w-3.5 h-3.5 text-[#10B981]" />
                              <span>Add data from this</span>
                            </button>
                            <button type="button" role="menuitem" onClick={() => { setActiveMenuId(null); openEdit(conn); }} className="w-full px-3 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#0B2545] flex items-center gap-2">
                              <Edit2 className="w-3.5 h-3.5 text-[#64748B]" />
                              <span>Edit</span>
                            </button>
                            <button type="button" role="menuitem" onClick={() => { setActiveMenuId(null); void handlePauseResume(conn); }} className="w-full px-3 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#0B2545] flex items-center gap-2">
                              {conn.lifecycleStatus === 'PAUSED' ? <Play className="w-3.5 h-3.5 text-[#10B981]" /> : <Pause className="w-3.5 h-3.5 text-[#64748B]" />}
                              <span>{conn.lifecycleStatus === 'PAUSED' ? 'Resume' : 'Pause'}</span>
                            </button>
                            <div className="h-px bg-[#F1F5F9] my-1" />
                            <button type="button" role="menuitem" onClick={() => { setActiveMenuId(null); setArchivingConn(conn); }} className="w-full px-3 py-1.5 rounded-lg hover:bg-red-50 text-red-600 flex items-center gap-2">
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Archive</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedConn && (
        <ConnectionDetailDrawer
          connection={selectedConn}
          signals={signals}
          resources={scopedResources}
          edgeName={edgeName(selectedConn)}
          testing={Boolean(testing[selectedConn.id])}
          testResult={testResults[selectedConn.id] || null}
          onClose={() => {
            setSelectedConnId(null);
            setSearchParams({});
          }}
          onTest={(id) => void handleTest(id)}
          onPauseResume={(conn) => void handlePauseResume(conn)}
          onEdit={openEdit}
        />
      )}

      <ConnectionFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        connectionToEdit={editingConn}
        onSuccess={() => void refresh()}
        edges={edges}
      />

      <ConfirmDialog
        isOpen={Boolean(archivingConn)}
        title={`Archive "${archivingConn?.name}"?`}
        message={`The connection is paused first. Its ${archivingConn?.signalsCount ?? 0} signal(s) stop collecting.`}
        confirmText="Pause and archive"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleArchive}
        onCancel={() => setArchivingConn(null)}
      />
    </div>
  );
};
