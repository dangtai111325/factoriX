import React, { useMemo, useState } from 'react';
import { ChevronRight, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { absoluteUtc7, relativeAge } from '../../utils/relativeTime';

function edgeHealthLabel(enrollment: string, health: string): string {
  if (enrollment !== 'ENROLLED') return 'Not enrolled';
  const value = health.toUpperCase();
  if (value === 'OFFLINE') return 'Offline';
  if (value === 'DEGRADED') return 'Degraded';
  if (value === 'HEALTHY' || value === 'ONLINE' || value === 'ACTIVE') return 'Online';
  return value || 'Unknown';
}

export const DiagnosticsPage: React.FC = () => {
  const { edges, connections, signals, diagnostics, siteNameById, testConnection } = useApp();
  const navigate = useNavigate();
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [selectedConnId, setSelectedConnId] = useState('');
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState('');

  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) || edges[0] || null;
  const edgeConnections = useMemo(() => {
    if (!selectedEdge) return connections;
    return connections.filter((c) => {
      if (c.edgeId) return c.edgeId === selectedEdge.id;
      return !c.plantId || c.plantId === selectedEdge.siteId;
    });
  }, [connections, selectedEdge]);

  const selectedConn =
    edgeConnections.find((c) => c.id === selectedConnId) || edgeConnections[0] || null;

  const connSignals = useMemo(() => {
    if (!selectedConn) return [];
    return signals.filter(
      (s) =>
        s.sourceConnectionId === selectedConn.id ||
        s.sourceConnectionName === selectedConn.name,
    );
  }, [signals, selectedConn]);

  const connDiag = diagnostics.find((d) => d.connectionId === selectedConn?.id);

  const runTest = async (connectionId: string) => {
    setTestBusy(connectionId);
    setTestMsg('');
    try {
      const result = await testConnection(connectionId);
      setTestMsg(result.success ? `Pass · ${result.latency} ms` : 'Fail — see last error');
    } catch (err) {
      setTestMsg(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setTestBusy(null);
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Health</h1>
          <p className="fx-page-subtitle">Edge → Connection → Signal. Run test on the selected connection.</p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <Card title="Edges" className="col-span-12 lg:col-span-3 p-0 overflow-hidden">
          <div className="max-h-[520px] overflow-y-auto">
            {!edges.length && (
              <p className="p-4 text-[12px] text-[#657794]">No edges enrolled yet.</p>
            )}
            {edges.map((edge) => {
              const active = (selectedEdge?.id || '') === edge.id;
              const label = edgeHealthLabel(edge.enrollmentStatus, edge.health || '');
              return (
                <button
                  key={edge.id}
                  type="button"
                  onClick={() => {
                    setSelectedEdgeId(edge.id);
                    setSelectedConnId('');
                  }}
                  className={`w-full text-left px-3 py-2.5 border-b border-[#F1F5FA] flex items-center justify-between gap-2 ${
                    active ? 'bg-[#FFF0F1]' : 'hover:bg-[#F9FAFD]'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[#111B37] truncate">{edge.name}</p>
                    <p className="text-[11px] text-[#657794] truncate">
                      {siteNameById[edge.siteId] || edge.siteId}
                    </p>
                  </div>
                  <Badge
                    variant={
                      label === 'Offline'
                        ? 'error'
                        : label === 'Online'
                          ? 'good'
                          : label === 'Degraded' || label === 'Not enrolled'
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    {label}
                  </Badge>
                </button>
              );
            })}
          </div>
        </Card>

        <Card title="Connections" className="col-span-12 lg:col-span-4 p-0 overflow-hidden">
          <div className="max-h-[520px] overflow-y-auto">
            {!edgeConnections.length && (
              <p className="p-4 text-[12px] text-[#657794]">No connections for this edge/site.</p>
            )}
            {edgeConnections.map((conn) => {
              const active = selectedConn?.id === conn.id;
              const diag = diagnostics.find((d) => d.connectionId === conn.id);
              return (
                <button
                  key={conn.id}
                  type="button"
                  onClick={() => {
                    setSelectedConnId(conn.id);
                    setTestMsg('');
                  }}
                  className={`w-full text-left px-3 py-2.5 border-b border-[#F1F5FA] ${
                    active ? 'bg-[#FFF0F1]' : 'hover:bg-[#F9FAFD]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] font-semibold text-[#111B37] truncate">{conn.name}</p>
                    <Badge
                      variant={
                        conn.status === 'connected'
                          ? 'good'
                          : conn.status === 'disconnected'
                            ? 'error'
                            : conn.status === 'warning' || conn.status === 'paused' || conn.status === 'draft'
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {conn.lifecycle || conn.status}
                    </Badge>
                  </div>
                  <p className="text-[11px] font-mono text-[#657794] mt-0.5">
                    {conn.protocol.toUpperCase()} · {conn.endpoint || '—'}
                  </p>
                  {(conn.lastError || diag?.lastError) && (
                    <p className="text-[11px] text-[#F2343B] mt-1 line-clamp-2">
                      {conn.lastError || diag?.lastError}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="col-span-12 lg:col-span-5 space-y-3.5">
          <Card title="Selected connection">
            {!selectedConn ? (
              <p className="text-[12px] text-[#657794]">Select a connection.</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[15px] font-bold text-[#111B37]">{selectedConn.name}</p>
                    <p className="text-[11px] font-mono text-[#657794]">
                      {selectedConn.protocol.toUpperCase()} · {selectedConn.endpoint}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Play className="w-3.5 h-3.5" />}
                    loading={testBusy === selectedConn.id}
                    onClick={() => void runTest(selectedConn.id)}
                  >
                    Run test
                  </Button>
                </div>
                {testMsg && <p className="text-[12px] text-[#334568]">{testMsg}</p>}
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div className="p-2 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                    <span className="text-[#657794] block text-[11px]">Dropped</span>
                    <span
                      className="font-bold text-[#111B37]"
                      title="Center does not count dropped messages per connection"
                    >
                      {typeof connDiag?.messagesDropped === 'number' ? connDiag.messagesDropped : '—'}
                    </span>
                  </div>
                  <div className="p-2 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                    <span className="text-[#657794] block text-[11px]">Edge backlog</span>
                    <span className="font-bold text-[#111B37]">
                      {selectedEdge?.outboxPending == null ? '—' : selectedEdge.outboxPending}
                    </span>
                  </div>
                  <div className="p-2 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                    <span className="text-[#657794] block text-[11px]">Last success</span>
                    <span className="font-bold text-[#111B37]" title={absoluteUtc7(selectedConn.lastConnected)}>
                      {relativeAge(selectedConn.lastConnected)}
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase text-[#94A3B8] mb-1">Last error / BAD reason</p>
                  <p className="text-[12px] text-[#334568] bg-[#FFF5F5] border border-[#FAC6C9] rounded-lg p-2">
                    {selectedConn.lastError || connDiag?.lastError || 'No error recorded'}
                  </p>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#EF1B24]"
                  onClick={() => navigate('/acquisition/connections')}
                >
                  Open Connections
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </Card>

          <Card title="Signals on connection" className="p-0 overflow-hidden">
            <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th>Value</th>
                    <th>Quality</th>
                    <th>Reason</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {!connSignals.length && (
                    <tr>
                      <td colSpan={5} className="text-[12px] text-[#657794]">
                        No signals bound to this connection.
                      </td>
                    </tr>
                  )}
                  {connSignals.map((sig) => (
                    <tr key={sig.id}>
                      <td className="font-mono text-[12px]">{sig.name}</td>
                      <td className="font-mono text-[12px]">
                        {String(sig.currentValue)} {sig.unit}
                      </td>
                      <td>
                        <Badge
                          variant={
                            sig.quality === 'GOOD' ? 'good' : sig.quality === 'BAD' ? 'error' : 'warning'
                          }
                        >
                          {sig.quality}
                        </Badge>
                      </td>
                      <td className="text-[11px] text-[#657794]">
                        {sig.quality === 'BAD' || sig.quality === 'STALE' ? sig.qualityReason || '—' : '—'}
                      </td>
                      <td
                        className="font-mono text-[11px] text-[#94A3B8]"
                        title={absoluteUtc7(sig.sourceTime || sig.lastUpdated)}
                      >
                        {relativeAge(sig.sourceTime || sig.lastUpdated)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
