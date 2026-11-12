import React, { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Play, Pause, PlusCircle, Activity, Edit2 } from 'lucide-react';
import { ConnectionItem, SignalItem, ResourceNode } from '../../types';
import { StatusBadge } from '../../components/common/StatusBadge';
import { CommissionResult } from '../../lib/commissioning';
import { formatTimestamp, formatValue, timeAgo } from '../../lib/format';
import { ConnectionStatusCell } from './connectionStatus';
import { TestResultPanel } from './TestResultPanel';
import { PROTOCOL_LABEL } from '../../lib/protocols';

interface ConnectionDetailDrawerProps {
  connection: ConnectionItem;
  signals: SignalItem[];
  resources: ResourceNode[];
  edgeName?: string;
  testing?: boolean;
  testResult?: CommissionResult | null;
  onClose: () => void;
  onTest: (id: string) => void;
  onPauseResume: (conn: ConnectionItem) => void;
  /** True while a pause / resume request runs. */
  pauseBusy?: boolean;
  onEdit: (conn: ConnectionItem) => void;
}

export const ConnectionDetailDrawer: React.FC<ConnectionDetailDrawerProps> = ({
  connection,
  signals,
  resources,
  edgeName,
  testing,
  testResult,
  onClose,
  onTest,
  onPauseResume,
  pauseBusy = false,
  onEdit,
}) => {
  const navigate = useNavigate();
  const titleId = useId();
  const [activeTab, setActiveTab] = useState<'overview' | 'signals' | 'addresses'>('overview');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const connSignals = signals.filter((s) => (s.sourceConnectionId || s.connectionId) === connection.id);
  const signalsByResource = new Map<string, SignalItem[]>();
  connSignals.forEach((sig) => {
    const list = signalsByResource.get(sig.resourceId) || [];
    list.push(sig);
    signalsByResource.set(sig.resourceId, list);
  });
  const resourceMap = new Map(resources.map((r) => [r.id, r]));
  const addresses = Array.from(new Set(connSignals.map((s) => s.bindingAddress).filter((a): a is string => Boolean(a)))).sort();
  const paused = connection.lifecycleStatus === 'PAUSED';

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      style={{ top: 'var(--fx-topbar-height)' }}
      className="fixed bottom-0 right-0 w-full sm:w-[520px] max-w-full box-border overflow-x-hidden bg-white border-l border-[#E2E8F0] shadow-2xl z-20 flex flex-col animate-in slide-in-from-right duration-200"
    >
      <div className="p-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] px-2 py-0.5 rounded bg-[#EFF6FF] text-[#134074] font-bold whitespace-nowrap">{PROTOCOL_LABEL[connection.protocol]}</span>
            <span className="text-[11px] font-mono text-[#64748B] truncate" title={connection.endpoint}>{connection.endpoint}</span>
          </div>
          <h2 id={titleId} className="text-lg font-bold text-[#0B2545] truncate">{connection.name}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors shrink-0">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div role="toolbar" aria-label="Connection actions" className="px-4 py-3 border-b border-[#E2E8F0] bg-[#F1F5F9] flex flex-wrap gap-2 [&>button]:flex-1 [&>button]:min-w-[96px] [&>button]:whitespace-nowrap">
        <button type="button" disabled={testing} onClick={() => onTest(connection.id)} className="py-1.5 px-2 rounded-lg bg-white border border-[#CBD5E1] hover:border-[#134074] text-xs font-semibold text-[#134074] flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50">
          <Activity className="w-3.5 h-3.5" />
          <span>{testing ? 'Testing…' : 'Test'}</span>
        </button>
        <button type="button" onClick={() => onEdit(connection)} className="py-1.5 px-2 rounded-lg bg-white border border-[#CBD5E1] hover:border-[#134074] text-xs font-semibold text-[#0B2545] flex items-center justify-center gap-1.5 shadow-sm">
          <Edit2 className="w-3.5 h-3.5" />
          <span>Edit</span>
        </button>
        <button type="button" disabled={pauseBusy} onClick={() => onPauseResume(connection)} className="py-1.5 px-2 rounded-lg bg-white border border-[#CBD5E1] hover:border-[#134074] text-xs font-semibold text-[#0B2545] flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50">
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          <span>{pauseBusy ? (paused ? 'Resuming…' : 'Pausing…') : paused ? 'Resume' : 'Pause…'}</span>
        </button>
        <button type="button" onClick={() => navigate(`/collector/add-data?connectionId=${encodeURIComponent(connection.id)}`)} className="py-1.5 px-2 rounded-lg bg-[#EF1B24] hover:bg-[#D9141D] active:bg-[#C7111A] text-xs font-semibold text-white flex items-center justify-center gap-1.5 shadow-sm">
          <PlusCircle className="w-3.5 h-3.5" />
          <span>Add data</span>
        </button>
      </div>

      <div role="tablist" className="flex border-b border-[#E2E8F0] px-4 bg-white text-xs font-semibold">
        {([
          { key: 'overview', label: 'Overview' },
          { key: 'signals', label: `Signals (${connSignals.length})` },
          { key: 'addresses', label: `Addresses (${addresses.length})` },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`py-3 px-3 border-b-2 transition-all ${activeTab === tab.key ? 'border-[#134074] text-[#0B2545] font-bold' : 'border-transparent text-[#64748B] hover:text-[#0B2545]'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {(testing || testResult) && (
          <TestResultPanel running={testing} result={testResult || null} successLabel="The Edge collector reached the endpoint" />
        )}

        {activeTab === 'overview' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]">
                <div className="text-[10px] font-bold uppercase text-[#64748B] mb-1">Status</div>
                <ConnectionStatusCell conn={connection} />
              </div>
              <div className="p-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]">
                <div className="text-[10px] font-bold uppercase text-[#64748B]">Samples (last 60 s)</div>
                <div className="text-sm font-bold text-[#0B2545] mt-1 font-mono">{connection.messagesPerMin ?? 0}</div>
              </div>
            </div>
            <dl className="p-3 rounded-xl border border-[#E2E8F0] bg-white text-xs divide-y divide-[#F1F5F9]">
              {[
                ['Endpoint', <span className="font-mono break-all">{connection.endpoint}</span>],
                ['Edge collector', edgeName || '—'],
                ['Lifecycle', connection.lifecycleStatus || '—'],
                ['Health (server)', connection.effectiveHealth || connection.health || '—'],
                ['Last data received', connection.lastSuccessAt ? `${formatTimestamp(connection.lastSuccessAt)} (${timeAgo(connection.lastSuccessAt)})` : '—'],
                ['Last error', <span className={connection.lastError ? 'text-red-600 break-words' : ''}>{connection.lastError || '—'}</span>],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex items-start justify-between gap-3 py-1.5">
                  <dt className="text-[#64748B] shrink-0">{label}</dt>
                  <dd className="font-medium text-[#0B2545] text-right min-w-0">{value}</dd>
                </div>
              ))}
            </dl>
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
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#E2E8F0] text-[#475569] font-bold">{res?.type || 'resource'}</span>
                        <span className="text-xs font-bold text-[#0B2545] truncate">{res?.name || resId}</span>
                      </div>
                      <span className="text-[11px] font-semibold text-[#64748B]">{sigList.length} signals</span>
                    </div>
                    <div className="p-2 divide-y divide-[#F1F5F9]">
                      {sigList.map((s) => (
                        <div key={s.id} className="py-2 px-1 flex items-center justify-between gap-2 text-xs">
                          <div className="min-w-0">
                            <div className="font-bold font-mono text-[#0B2545] truncate">{s.key}</div>
                            <div className="text-[10px] font-mono text-[#64748B] truncate" title={s.bindingAddress}>{s.bindingAddress || '—'}</div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-mono font-black text-[#0B2545]">
                              {formatValue(s.value)} <span className="font-normal text-[10px] text-[#64748B]">{s.unit || ''}</span>
                            </div>
                            <StatusBadge status={s.quality || 'NO_DATA'} />
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

        {activeTab === 'addresses' && (
          <div className="space-y-2">
            {addresses.length === 0 ? (
              <div className="p-8 text-center border-2 border-dashed border-[#CBD5E1] rounded-xl text-xs text-[#94A3B8]">No addresses configured yet.</div>
            ) : (
              addresses.map((address) => (
                <div key={address} className="p-2.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] font-mono text-xs text-[#0B2545] break-all">
                  {address}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
