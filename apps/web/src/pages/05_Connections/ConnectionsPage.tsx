import React, { useEffect, useState } from 'react';
import {
  Plus,
  Search,
  Network,
  Cable,
  RadioTower,
  Cloud,
  Edit2,
  Trash2,
  Pause,
  Play,
  Copy,
  MoreHorizontal,
  Activity,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { useApp } from '../../store/AppContext';
import { ConnectionItem, ProtocolType } from '../../types';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ConnectionTestModal } from '../../components/modals/ConnectionTestModal';
import { translateApiError } from '../../utils/apiErrors';

function formatMetric(value: number | null | undefined, suffix: string): string {
  if (value == null || Number.isNaN(value) || value === 0) return '—';
  return `${value}${suffix}`;
}

function signalCountLabel(count: number | null | undefined): string {
  if (count == null || Number.isNaN(count)) return '—';
  return count === 1 ? '1 signal' : `${count} signals`;
}

function canArchiveConnection(conn: ConnectionItem): boolean {
  return conn.lifecycle === 'PAUSED' || conn.lifecycle === 'DRAFT';
}

function statusBadge(conn: ConnectionItem): { label: string; variant: 'good' | 'warning' | 'error' | 'neutral' } {
  if (conn.lifecycle === 'ACTIVE') return { label: 'ACTIVE', variant: 'good' };
  if (conn.lifecycle === 'PAUSED') return { label: 'PAUSED', variant: 'warning' };
  if (conn.lifecycle === 'ARCHIVED') return { label: 'ARCHIVED', variant: 'neutral' };
  return { label: 'DRAFT', variant: 'neutral' };
}

function healthLabel(conn: ConnectionItem): string {
  const health = (conn.health || '').toUpperCase();
  if (!health || health === 'UNKNOWN') return '—';
  return health;
}

export const ConnectionsPage: React.FC = () => {
  const {
    connections,
    selectedConnectionId,
    setSelectedConnectionId,
    testConnection,
    deleteConnection,
    pauseConnection,
    resumeConnection,
    duplicateConnection,
    resources,
  } = useApp();
  const [searchParams] = useSearchParams();
  const [filterProtocol, setFilterProtocol] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ConnectionItem | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [isTestModalOpen, setIsTestModalOpen] = useState(searchParams.get('modal') === 'test');
  const [testConnectionId, setTestConnectionId] = useState<string | null>(null);

  const navigate = useNavigate();

  useEffect(() => {
    const connectionId = searchParams.get('connectionId');
    if (connectionId && connections.some((item) => item.id === connectionId)) {
      setSelectedConnectionId(connectionId);
    }
  }, [connections, searchParams, setSelectedConnectionId]);

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

  const machineForEdit = (conn: ConnectionItem) => {
    // Never pass site_id as machine — find a machine on this site, else leave blank.
    const siteId = conn.siteId || conn.plantId;
    const machine = resources.find(
      (r) => r.type === 'machine' && r.attributes?.siteId === siteId,
    );
    return machine?.id || '';
  };

  const handleTest = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setTestingId(id);
    setTestConnectionId(id);
    setSelectedConnectionId(id);
    await testConnection(id);
    setTestingId(null);
    setIsTestModalOpen(true);
    setMenuId(null);
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    if (!canArchiveConnection(archiveTarget)) {
      setPageError('Pause the connection before archiving. Draft connections can be archived directly.');
      setArchiveTarget(null);
      return;
    }
    try {
      await deleteConnection(archiveTarget.id);
      setArchiveTarget(null);
    } catch (error) {
      setPageError(translateApiError(error));
    }
  };

  const testedConn =
    connections.find((c) => c.id === testConnectionId) || selectedConn;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
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
            onClick={() => navigate('/acquisition/add-data')}
          >
            New Connection
          </Button>
        </div>
      </div>

      {pageError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{pageError}</div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 block">Total</span>
          <span className="text-2xl font-black text-slate-900 mt-1 block">{connections.length}</span>
        </div>
        {(['modbus', 'opcua', 'mqtt', 'http'] as ProtocolType[]).map((proto) => (
          <div key={proto} className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
            <span className="text-xs font-semibold text-slate-500 block uppercase">{proto === 'mqtt' ? 'MQTT' : proto}</span>
            <span className="text-2xl font-black text-slate-900 mt-1 block">
              {connections.filter((item) => item.protocol === proto).length}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-2 flex-wrap">
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
            className="fx-input !pl-8 h-9 text-[13px]"
          />
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="fx-table">
            <thead>
              <tr>
                <th>Protocol</th>
                <th>Name</th>
                <th>Endpoint</th>
                <th>Signals</th>
                <th>Latency</th>
                <th>Throughput</th>
                <th>Status</th>
                <th>Health</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredConnections.map((conn) => {
                const isSelected = conn.id === selectedConn?.id;
                const badge = statusBadge(conn);
                return (
                  <tr
                    key={conn.id}
                    onClick={() => setSelectedConnectionId(conn.id)}
                    data-selected={isSelected}
                    className="cursor-pointer"
                  >
                    <td>
                      <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                        {getProtocolIcon(conn.protocol)}
                        <span>{conn.protocol.toUpperCase()}</span>
                      </div>
                    </td>
                    <td className="font-bold text-[#111B37] text-[13px]">{conn.name}</td>
                    <td className="font-mono text-[#657794] text-[12px]">{conn.endpoint}</td>
                    <td className="font-semibold text-[#111B37]">{signalCountLabel(conn.signalsCount)}</td>
                    <td className="font-mono text-[12px] text-[#657794]">
                      {formatMetric(conn.latencyMs, ' ms')}
                    </td>
                    <td className="font-mono text-[12px] text-[#111B37] font-semibold">
                      {formatMetric(conn.throughputPerSec, ' msg/s')}
                    </td>
                    <td>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    <td className="text-[11px] text-[#657794] font-mono">{healthLabel(conn)}</td>
                    <td className="text-right relative">
                      <div className="flex items-center justify-end gap-1.5">
                        {conn.lifecycle === 'PAUSED' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="text-[11px] h-7 px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              void resumeConnection(conn.id).catch((err) => setPageError(translateApiError(err)));
                            }}
                          >
                            Resume
                          </Button>
                        ) : conn.lifecycle === 'ACTIVE' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="text-[11px] h-7 px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              void pauseConnection(conn.id).catch((err) => setPageError(translateApiError(err)));
                            }}
                          >
                            Pause
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="secondary"
                          className="text-[11px] h-7 px-2"
                          onClick={(e) => void handleTest(conn.id, e)}
                          loading={testingId === conn.id}
                        >
                          Test
                        </Button>
                        <button
                          type="button"
                          className="p-1 rounded text-[#94A3B8] hover:text-[#111B37]"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(menuId === conn.id ? null : conn.id);
                          }}
                          aria-label="Connection menu"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                      </div>
                      {menuId === conn.id && (
                        <div
                          className="absolute right-2 top-9 z-20 w-44 rounded-lg border border-slate-200 bg-white shadow-xl py-1 text-left"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="w-full px-3 py-2 text-xs text-left hover:bg-slate-50 flex items-center gap-2"
                            onClick={() => {
                              const machineId = machineForEdit(conn);
                              navigate(
                                `/acquisition/add-data?connectionId=${encodeURIComponent(conn.id)}${
                                  machineId ? `&resourceId=${encodeURIComponent(machineId)}` : ''
                                }`,
                              );
                              setMenuId(null);
                            }}
                          >
                            <Edit2 className="w-3.5 h-3.5" /> Edit
                          </button>
                          <button
                            type="button"
                            className="w-full px-3 py-2 text-xs text-left hover:bg-slate-50 flex items-center gap-2"
                            onClick={() => void handleTest(conn.id)}
                          >
                            <Activity className="w-3.5 h-3.5" /> Test
                          </button>
                          {conn.lifecycle === 'PAUSED' ? (
                            <button
                              type="button"
                              className="w-full px-3 py-2 text-xs text-left hover:bg-slate-50 flex items-center gap-2"
                              onClick={() => {
                                void resumeConnection(conn.id).catch((err) =>
                                  setPageError(translateApiError(err)),
                                );
                                setMenuId(null);
                              }}
                            >
                              <Play className="w-3.5 h-3.5" /> Resume
                            </button>
                          ) : conn.lifecycle === 'ACTIVE' ? (
                            <button
                              type="button"
                              className="w-full px-3 py-2 text-xs text-left hover:bg-slate-50 flex items-center gap-2"
                              onClick={() => {
                                void pauseConnection(conn.id).catch((err) =>
                                  setPageError(translateApiError(err)),
                                );
                                setMenuId(null);
                              }}
                            >
                              <Pause className="w-3.5 h-3.5" /> Pause
                            </button>
                          ) : null}
                          <span
                            className="block"
                            title={
                              conn.secretConfigured
                                ? 'Duplicate is unavailable because the connection secret is not copied'
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              disabled={conn.secretConfigured}
                              className="w-full px-3 py-2 text-xs text-left hover:bg-slate-50 flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent"
                              onClick={() => {
                                if (conn.secretConfigured) return;
                                void duplicateConnection(conn.id)
                                  .then((id) => setSelectedConnectionId(id))
                                  .catch((err) => setPageError(translateApiError(err)));
                                setMenuId(null);
                              }}
                            >
                              <Copy className="w-3.5 h-3.5" /> Duplicate
                            </button>
                          </span>
                          <span
                            className="block"
                            title={
                              canArchiveConnection(conn)
                                ? 'Archive this connection'
                                : 'Pause the connection before archiving'
                            }
                          >
                            <button
                              type="button"
                              disabled={!canArchiveConnection(conn)}
                              className="w-full px-3 py-2 text-xs text-left hover:bg-red-50 text-red-600 flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent disabled:text-slate-400"
                              onClick={() => {
                                if (!canArchiveConnection(conn)) return;
                                setArchiveTarget(conn);
                                setMenuId(null);
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" /> Archive
                            </button>
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selectedConn ? (
        <Card title={`Connection: ${selectedConn.name}`}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-slate-500 block mb-1">Endpoint</span>
              <span className="font-mono font-bold text-slate-800 text-sm">{selectedConn.endpoint}</span>
            </div>
            <div>
              <span className="text-slate-500 block mb-1">Lifecycle</span>
              <span className="font-semibold text-slate-800">{selectedConn.lifecycle}</span>
            </div>
            <div>
              <span className="text-slate-500 block mb-1">Health</span>
              <span className="font-semibold text-slate-800">{healthLabel(selectedConn)}</span>
            </div>
            <div>
              <span className="text-slate-500 block mb-1">Last received</span>
              <span className="font-mono text-slate-800">
                {selectedConn.lastConnected || '—'}
              </span>
            </div>
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        isOpen={Boolean(archiveTarget)}
        title="Archive connection?"
        message={`Archive connection “${archiveTarget?.name}”? It stays archived and stops collecting.`}
        confirmLabel="Archive"
        danger
        onCancel={() => setArchiveTarget(null)}
        onConfirm={handleArchive}
      />

      <ConnectionTestModal
        isOpen={isTestModalOpen}
        onClose={() => setIsTestModalOpen(false)}
        connectionId={testedConn?.id}
        connectionName={testedConn?.name}
        protocol={testedConn?.protocol?.toUpperCase()}
        endpoint={testedConn?.endpoint}
      />
    </div>
  );
};
