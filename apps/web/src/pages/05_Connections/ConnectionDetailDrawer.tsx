import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  Play,
  Pause,
  ExternalLink,
  PlusCircle,
  Radio,
  Clock,
  Layers,
  History,
  AlertTriangle,
  CheckCircle2,
  Activity,
  FileCode,
} from 'lucide-react';
import { ConnectionItem, SignalItem, ResourceNode } from '../../types';
import { Badge } from '../../components/common/Badge';

interface ConnectionDetailDrawerProps {
  connection: ConnectionItem;
  signals: SignalItem[];
  resources: ResourceNode[];
  onClose: () => void;
  onTest: (id: string) => void;
  onPauseResume: (id: string, currentStatus: string) => void;
  onEdit: (conn: ConnectionItem) => void;
}

export const ConnectionDetailDrawer: React.FC<ConnectionDetailDrawerProps> = ({
  connection,
  signals,
  resources,
  onClose,
  onTest,
  onPauseResume,
  onEdit,
}) => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'overview' | 'signals' | 'topics' | 'history'>('overview');

  const connSignals = signals.filter(
    (s) => s.sourceConnectionId === connection.id
  );

  // Group signals by resource
  const signalsByResource = new Map<string, SignalItem[]>();
  connSignals.forEach((sig) => {
    const list = signalsByResource.get(sig.resourceId) || [];
    list.push(sig);
    signalsByResource.set(sig.resourceId, list);
  });

  const resourceMap = new Map(resources.map((r) => [r.id, r]));

  // Extract topics or addresses
  const topicsList = Array.from(
    new Set(connSignals.map((s) => s.bindingAddress).filter(Boolean))
  );

  const isPaused = connection.status === 'disconnected' || (connection as any).lifecycle_status === 'PAUSED';

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[500px] bg-white border-l border-[#E2E8F0] shadow-2xl z-40 flex flex-col animate-in slide-in-from-right duration-200">
      {/* Drawer Header */}
      <div className="p-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-[#EFF6FF] text-[#134074] font-bold">
              {connection.protocol}
            </span>
            <span className="text-[11px] font-mono text-[#64748B] truncate">{connection.endpoint}</span>
          </div>
          <h2 className="text-lg font-bold text-[#0B2545] truncate">{connection.name}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drawer"
          className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Action Toolbar */}
      <div className="p-3 border-b border-[#E2E8F0] bg-[#F1F5F9] flex items-center gap-2">
        <button
          type="button"
          onClick={() => onTest(connection.id)}
          className="flex-1 py-1.5 px-3 rounded-lg bg-white border border-[#CBD5E1] hover:border-[#134074] text-xs font-semibold text-[#134074] flex items-center justify-center gap-1.5 shadow-sm transition-all"
        >
          <Activity className="w-3.5 h-3.5" />
          <span>Test connection</span>
        </button>
        <button
          type="button"
          onClick={() => navigate(`/collector/add-data?connectionId=${encodeURIComponent(connection.id)}`)}
          className="flex-1 py-1.5 px-3 rounded-lg bg-[#0B2545] hover:bg-[#134074] text-xs font-semibold text-white flex items-center justify-center gap-1.5 shadow-sm transition-all"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span>Add data</span>
        </button>
        <button
          type="button"
          onClick={() => onPauseResume(connection.id, connection.status)}
          className="p-1.5 rounded-lg bg-white border border-[#CBD5E1] hover:border-[#134074] text-[#475569] shadow-sm transition-all"
          title={isPaused ? 'Resume' : 'Pause'}
        >
          {isPaused ? <Play className="w-4 h-4 text-[#10B981]" /> : <Pause className="w-4 h-4 text-[#F59E0B]" />}
        </button>
      </div>

      {/* Tabs Bar */}
      <div className="flex border-b border-[#E2E8F0] px-4 bg-white text-xs font-semibold">
        {[
          { key: 'overview', label: 'Overview' },
          { key: 'signals', label: `Signals (${connSignals.length})` },
          { key: 'topics', label: `Topics / Addresses (${topicsList.length})` },
          { key: 'history', label: 'History' },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key as any)}
            className={`py-3 px-3 border-b-2 transition-all ${
              activeTab === tab.key
                ? 'border-[#134074] text-[#0B2545] font-bold'
                : 'border-transparent text-[#64748B] hover:text-[#0B2545]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === 'overview' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]">
                <div className="text-[10px] font-bold uppercase text-[#64748B]">Status</div>
                <div className="text-sm font-bold text-[#0B2545] mt-1 capitalize">{connection.status}</div>
              </div>
              <div className="p-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]">
                <div className="text-[10px] font-bold uppercase text-[#64748B]">Throughput</div>
                <div className="text-sm font-bold text-[#0B2545] mt-1">
                  {connection.throughputPerSec || 0} msg/min
                </div>
              </div>
            </div>

            <div className="p-3 rounded-xl border border-[#E2E8F0] bg-white space-y-2 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-[#F1F5F9]">
                <span className="text-[#64748B]">Endpoint</span>
                <span className="font-mono font-semibold text-[#0B2545] truncate max-w-[240px]">
                  {connection.endpoint}
                </span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[#F1F5F9]">
                <span className="text-[#64748B]">Last data received</span>
                <span className="font-medium text-[#0B2545]">{connection.lastConnected || '—'}</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-[#64748B]">Last error</span>
                <span className="font-medium text-[#475569]">{connection.errorRate > 0 ? 'Connection error' : '—'}</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'signals' && (
          <div className="space-y-4">
            {connSignals.length === 0 ? (
              <div className="p-8 text-center border-2 border-dashed border-[#CBD5E1] rounded-xl text-xs text-[#94A3B8]">
                No signals bound to this connection yet. Click "Add data" above to collect signals.
              </div>
            ) : (
              Array.from(signalsByResource.entries()).map(([resId, sigList]) => {
                const res = resourceMap.get(resId);
                return (
                  <div key={resId} className="border border-[#E2E8F0] rounded-xl overflow-hidden shadow-sm">
                    <div className="bg-[#F8FAFC] px-3 py-2 border-b border-[#E2E8F0] flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#E2E8F0] text-[#475569] font-bold">
                          {res?.type || 'Resource'}
                        </span>
                        <span className="text-xs font-bold text-[#0B2545]">{res?.name || resId}</span>
                      </div>
                      <span className="text-[11px] font-semibold text-[#64748B]">{sigList.length} signals</span>
                    </div>
                    <div className="p-2 divide-y divide-[#F1F5F9]">
                      {sigList.map((s) => (
                        <div key={s.id} className="py-2 px-1 flex items-center justify-between text-xs">
                          <div>
                            <div className="font-bold text-[#0B2545]">{s.name}</div>
                            <div className="text-[10px] font-mono text-[#64748B]">{s.tag}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono font-black text-[#0B2545]">
                              {s.currentValue !== undefined && s.currentValue !== null ? String(s.currentValue) : '—'}{' '}
                              <span className="font-normal text-[10px] text-[#64748B]">{s.unit || ''}</span>
                            </div>
                            <span className="text-[10px] font-semibold text-[#10B981]">{s.quality}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'topics' && (
          <div className="space-y-2">
            {topicsList.length === 0 ? (
              <div className="p-8 text-center border-2 border-dashed border-[#CBD5E1] rounded-xl text-xs text-[#94A3B8]">
                No topics or addresses configured yet.
              </div>
            ) : (
              topicsList.map((topic, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] font-mono text-xs text-[#0B2545] break-all"
                >
                  {topic}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="p-6 text-center text-xs text-[#64748B]">
            Operational logs and heartbeat events for this connection.
          </div>
        )}
      </div>
    </div>
  );
};
