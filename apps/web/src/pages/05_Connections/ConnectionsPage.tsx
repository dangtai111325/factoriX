import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Search,
  Network,
  RadioTower,
  Cable,
  Cloud,
  MoreVertical,
  Activity,
  Play,
  Pause,
  Edit2,
  Trash2,
  ExternalLink,
  PlusCircle,
  AlertCircle,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { ConnectionItem, ProtocolType } from '../../types';
import { ConnectionDetailDrawer } from './ConnectionDetailDrawer';
import { ConnectionFormModal } from './ConnectionFormModal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { api } from '../../api/client';

export const ConnectionsPage: React.FC = () => {
  const {
    connections,
    signals,
    scopedResources,
    edges,
    refresh,
    testConnection,
  } = useApp();

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Selected connection for Drawer
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);

  // Filter & Search states
  const [kpiFilter, setKpiFilter] = useState<'all' | 'online' | 'degraded' | 'paused'>('all');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Modals state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionItem | null>(null);
  const [archivingConn, setArchivingConn] = useState<ConnectionItem | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // Sync deep link `?connectionId=` (TC-UI-CN-12)
  useEffect(() => {
    const qId = searchParams.get('connectionId');
    if (qId) {
      setSelectedConnId(qId);
    }
  }, [searchParams]);

  const selectedConn = useMemo(() => {
    return connections.find((c) => c.id === selectedConnId) || null;
  }, [connections, selectedConnId]);

  // KPI Calculations
  const totalCount = connections.length;
  const onlineCount = connections.filter(
    (c) =>
      c.status === 'connected' ||
      (c as any).health === 'ONLINE' ||
      (c as any).health === 'HEALTHY' ||
      (c as any).status === 'ACTIVE' ||
      !(c as any).lastError
  ).length;
  const pausedCount = connections.filter(
    (c) => (c as any).status === 'PAUSED' || (c as any).lifecycle_status === 'PAUSED'
  ).length;
  const degradedCount = totalCount - onlineCount;

  // Filtered connections list (TC-UI-CN-24)
  const filteredConnections = useMemo(() => {
    return connections.filter((conn) => {
      // Protocol filter
      if (protocolFilter !== 'all' && conn.protocol !== protocolFilter) return false;

      // KPI pill filter
      if (kpiFilter === 'online') {
        const isOnline =
          conn.status === 'connected' ||
          (conn as any).health === 'ONLINE' ||
          (conn as any).health === 'HEALTHY';
        if (!isOnline) return false;
      } else if (kpiFilter === 'paused') {
        if ((conn as any).status !== 'PAUSED' && (conn as any).lifecycle_status !== 'PAUSED')
          return false;
      } else if (kpiFilter === 'degraded') {
        const isDegraded =
          (conn as any).health === 'DEGRADED' || (conn as any).health === 'OFFLINE';
        if (!isDegraded) return false;
      }

      // Search query
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        return (
          conn.name.toLowerCase().includes(q) ||
          conn.endpoint.toLowerCase().includes(q) ||
          conn.protocol.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [connections, protocolFilter, kpiFilter, searchTerm]);

  const handlePauseResume = async (id: string, currentStatus: string) => {
    const isPaused = currentStatus === 'disconnected' || currentStatus === 'PAUSED';
    const action = isPaused ? 'resume' : 'pause';
    try {
      await api(`/api/v1/connections/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      await refresh();
    } catch {
      // error handled
    }
  };

  const handleArchive = async () => {
    if (!archivingConn) return;
    try {
      // If currently active, pause first if required
      if (archivingConn.status === 'connected') {
        await api(`/api/v1/connections/${encodeURIComponent(archivingConn.id)}/pause`, {
          method: 'POST',
        });
      }
      await api(`/api/v1/connections/${encodeURIComponent(archivingConn.id)}`, {
        method: 'DELETE',
      });
      setArchivingConn(null);
      if (selectedConnId === archivingConn.id) {
        setSelectedConnId(null);
        setSearchParams({});
      }
      await refresh();
    } catch {
      setArchivingConn(null);
    }
  };

  const getProtocolIcon = (proto: ProtocolType) => {
    switch (proto) {
      case 'mqtt':
        return <RadioTower className="w-4 h-4 text-[#149580]" />;
      case 'modbus':
        return <Network className="w-4 h-4 text-[#1D63BD]" />;
      case 'opcua':
        return <Cable className="w-4 h-4 text-[#7B3AE0]" />;
      case 'http':
        return <Cloud className="w-4 h-4 text-[#C76114]" />;
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200 select-none pb-8">
      {/* Top Header & New Connection Button */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-black text-[#0B2545] tracking-tight">
            Data Connections
          </h1>
          <p className="text-xs text-[#64748B]">
            Hardware gateways, PLCs, broker channels, and REST endpoints across sites.
          </p>
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

      {/* KPI Filter Pills (§6.1 & TC-UI-CN-24) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { key: 'all', label: 'Total Connections', count: totalCount },
          { key: 'online', label: 'Connected', count: onlineCount, color: 'text-[#10B981]' },
          { key: 'degraded', label: 'Disconnected', count: totalCount - onlineCount, color: 'text-[#EF4444]' },
        ].map((kpi) => {
          const active = kpiFilter === kpi.key;
          return (
            <button
              key={kpi.key}
              type="button"
              onClick={() => setKpiFilter(kpi.key as any)}
              className={`p-3.5 rounded-2xl border text-left transition-all ${
                active
                  ? 'bg-white border-[#134074] ring-2 ring-[#134074]/10 shadow-sm'
                  : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E1]'
              }`}
            >
              <div className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider truncate">
                {kpi.label}
              </div>
              <div className={`text-2xl font-black mt-1 font-mono ${kpi.color || 'text-[#0B2545]'}`}>
                {kpi.count}
              </div>
            </button>
          );
        })}
      </div>

      {/* Toolbar: Search + Protocol Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* Search Input */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[#CBD5E1] bg-white text-xs shadow-sm w-64">
            <Search className="w-3.5 h-3.5 text-[#64748B]" />
            <input
              type="text"
              placeholder="Search connections…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full text-xs font-medium text-[#0B2545] outline-none placeholder:text-[#94A3B8]"
            />
          </div>

          {/* Protocol filter chips */}
          <div className="flex items-center gap-1 bg-[#F1F5F9] p-1 rounded-xl border border-[#E2E8F0] text-xs">
            {['all', 'mqtt', 'modbus', 'opcua', 'http'].map((proto) => (
              <button
                key={proto}
                type="button"
                onClick={() => setProtocolFilter(proto)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all uppercase ${
                  protocolFilter === proto
                    ? 'bg-white text-[#0B2545] shadow-sm'
                    : 'text-[#64748B] hover:text-[#0B2545]'
                }`}
              >
                {proto}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Connections Table (§6.1 & TC-UI-CN-10..12) */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm overflow-hidden">
        {filteredConnections.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-[#F1F5F9] flex items-center justify-center mx-auto text-[#64748B]">
              <Network className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-bold text-[#0B2545]">No connections found</h3>
            <p className="text-xs text-[#64748B] max-w-sm mx-auto">
              No industrial connections match your filters. Click "New Connection" to connect a broker or PLC.
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
                  <th className="py-3 px-4">Last Data</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1F5F9]">
                {filteredConnections.map((conn) => {
                  const connSigCount = signals.filter(
                    (s) =>
                      s.sourceConnectionId === conn.id ||
                      s.connectionId === conn.id ||
                      (s as any).connection_id === conn.id
                  ).length || ((conn as any).signal_count ?? signals.length);
                  const isOnline =
                    conn.status === 'connected' ||
                    (conn as any).health === 'ONLINE' ||
                    (conn as any).health === 'HEALTHY' ||
                    (conn as any).status === 'ACTIVE' ||
                    !(conn as any).lastError;

                  return (
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
                          <div className="p-1.5 rounded-lg bg-[#F1F5F9]">
                            {getProtocolIcon(conn.protocol)}
                          </div>
                          <div>
                            <div className="font-bold text-[#0B2545] group-hover:text-[#134074] transition-colors">
                              {conn.name}
                            </div>
                            <div className="text-[10px] font-mono uppercase text-[#64748B]">
                              {conn.protocol}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 font-mono text-xs text-[#475569] truncate max-w-[200px]">
                        {conn.endpoint}
                      </td>

                      <td className="py-3.5 px-4 text-xs font-semibold text-[#0B2545]">
                        {(conn as any).edge_name || 'Edge Collector'}
                      </td>

                      <td className="py-3.5 px-4 font-mono font-bold text-xs text-[#0B2545]">
                        {(conn as any).signal_count ?? connSigCount}
                      </td>

                      <td className="py-3.5 px-4 text-xs text-[#64748B]">
                        {conn.lastConnected || '—'}
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5" title={conn.lastError || (isOnline ? 'Active and streaming' : 'Disconnected')}>
                          <span
                            className={`w-2 h-2 rounded-full ${
                              isOnline ? 'bg-[#10B981]' : 'bg-[#EF4444]'
                            }`}
                          />
                          <div>
                            <span className="font-bold text-[11px] text-[#0B2545]">
                              {isOnline ? 'Connected' : 'Disconnected'}
                            </span>
                            {!isOnline && conn.lastError && (
                              <div className="text-[10px] text-red-500 font-medium truncate max-w-[160px]" title={conn.lastError}>
                                {conn.lastError}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Actions Menu (TC-UI-CN-13..19) */}
                      <td className="py-3.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="relative inline-block">
                          <button
                            type="button"
                            onClick={() =>
                              setActiveMenuId(activeMenuId === conn.id ? null : conn.id)
                            }
                            className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>

                          {activeMenuId === conn.id && (
                            <div className="absolute right-0 top-full mt-1 w-52 bg-white border border-[#CBD5E1] rounded-xl shadow-xl z-30 p-1 space-y-0.5 text-left text-xs font-semibold animate-in fade-in duration-100">
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void testConnection(conn.id);
                                }}
                                className="w-full px-3 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#0B2545] flex items-center gap-2"
                              >
                                <Activity className="w-3.5 h-3.5 text-[#134074]" />
                                <span>Test connection</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  navigate(`/collector/add-data?connectionId=${encodeURIComponent(conn.id)}`);
                                }}
                                className="w-full px-3 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#0B2545] flex items-center gap-2"
                              >
                                <PlusCircle className="w-3.5 h-3.5 text-[#10B981]" />
                                <span>Add data from this</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setEditingConn(conn);
                                  setIsFormOpen(true);
                                }}
                                className="w-full px-3 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#0B2545] flex items-center gap-2"
                              >
                                <Edit2 className="w-3.5 h-3.5 text-[#64748B]" />
                                <span>Edit</span>
                              </button>

                              <div className="h-px bg-[#F1F5F9] my-1" />
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setArchivingConn(conn);
                                }}
                                className="w-full px-3 py-1.5 rounded-lg hover:bg-red-50 text-red-600 flex items-center gap-2"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>Archive</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Connection Detail Drawer (TC-UI-CN-12) */}
      {selectedConn && (
        <ConnectionDetailDrawer
          connection={selectedConn}
          signals={signals}
          resources={scopedResources}
          onClose={() => {
            setSelectedConnId(null);
            setSearchParams({});
          }}
          onTest={(id) => void testConnection(id)}
          onPauseResume={(id, status) => void handlePauseResume(id, status)}
          onEdit={(conn) => {
            setEditingConn(conn);
            setIsFormOpen(true);
          }}
        />
      )}

      {/* Connection New / Edit Modal */}
      <ConnectionFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        connectionToEdit={editingConn}
        onSuccess={() => void refresh()}
        sites={scopedResources.filter((r) => r.type === 'site' || r.type === 'plant')}
        edges={edges}
      />

      {/* Archive Confirmation Dialog (§9.7 TC-UI-CN-17) */}
      <ConfirmDialog
        isOpen={Boolean(archivingConn)}
        title={`Pause and archive "${archivingConn?.name}"?`}
        message={`Its ${
          signals.filter((s) => s.sourceConnectionId === archivingConn?.id).length
        } signals stop collecting.`}
        confirmText="Pause and archive"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleArchive}
        onCancel={() => setArchivingConn(null)}
      />
    </div>
  );
};
