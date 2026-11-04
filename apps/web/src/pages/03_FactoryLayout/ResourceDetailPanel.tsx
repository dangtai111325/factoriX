import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ExternalLink, PlusCircle, Activity } from 'lucide-react';
import { ResourceNode, SignalItem } from '../../types';
import { Badge } from '../../components/common/Badge';
import { api } from '../../api/client';

interface ResourceDetailPanelProps {
  resource: ResourceNode;
  signals: SignalItem[];
  onClose: () => void;
}

export const ResourceDetailPanel: React.FC<ResourceDetailPanelProps> = ({
  resource,
  signals,
  onClose,
}) => {
  const navigate = useNavigate();
  const resourceSignals = signals.filter(
    (s) => s.resourceId === resource.id || s.resource_id === resource.id
  );

  return (
    <div className="w-80 md:w-96 bg-white border-l border-[#E2E8F0] h-full flex flex-col shadow-xl z-20 animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="p-4 border-b border-[#E2E8F0] flex items-center justify-between bg-[#F8FAFC]">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono uppercase px-2 py-0.5 rounded bg-[#E2E8F0] text-[#475569] font-bold">
              {resource.type}
            </span>
            <span className="text-[11px] font-mono text-[#64748B]">{resource.code}</span>
          </div>
          <h2 className="text-base font-bold text-[#0B2545] truncate mt-1">{resource.name}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="p-1 rounded-md text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Action shortcuts */}
      <div className="p-3 border-b border-[#E2E8F0] flex items-center gap-2 bg-[#F1F5F9]">
        <button
          type="button"
          onClick={() => navigate(`/collector/signals?resourceId=${encodeURIComponent(resource.id)}`)}
          className="flex-1 py-1.5 px-3 rounded-lg bg-white border border-[#CBD5E1] hover:border-[#134074] text-[12px] font-semibold text-[#134074] flex items-center justify-center gap-1.5 shadow-sm transition-all"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          <span>Open in Signals</span>
        </button>
        <button
          type="button"
          onClick={() => navigate(`/collector/add-data?resourceId=${encodeURIComponent(resource.id)}`)}
          className="flex-1 py-1.5 px-3 rounded-lg bg-[#0B2545] hover:bg-[#134074] text-[12px] font-semibold text-white flex items-center justify-center gap-1.5 shadow-sm transition-all"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span>Add data</span>
        </button>
      </div>

      {/* Signals list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <div className="flex items-center justify-between text-xs font-bold text-[#475569] uppercase tracking-wider">
          <span>Signals ({resourceSignals.length})</span>
          <Activity className="w-3.5 h-3.5" />
        </div>

        {resourceSignals.length === 0 ? (
          <div className="py-8 text-center border-2 border-dashed border-[#CBD5E1] rounded-xl text-xs text-[#64748B]">
            No signals bound to this resource yet.
          </div>
        ) : (
          resourceSignals.map((sig) => (
            <SignalHistoryRow key={sig.id} signal={sig} />
          ))
        )}
      </div>
    </div>
  );
};

const SignalHistoryRow: React.FC<{ signal: SignalItem }> = ({ signal }) => {
  const [history, setHistory] = useState<number[]>([]);
  const quality = (signal.quality || 'UNKNOWN').toUpperCase();

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await api<{ items: Array<{ value: number | null }> }>(
          `/api/v1/observations/history?signal_id=${encodeURIComponent(signal.id)}&from=-15m&limit=30`
        );
        if (active && res.items) {
          const numbers = res.items
            .map((item) => item.value)
            .filter((v): v is number => typeof v === 'number');
          setHistory(numbers);
        }
      } catch {
        // Sparkline remains empty if history is unavailable
      }
    })();
    return () => {
      active = false;
    };
  }, [signal.id]);

  const qualityColor =
    quality === 'GOOD'
      ? 'bg-[#10B981]'
      : quality === 'UNCERTAIN'
      ? 'bg-[#F59E0B]'
      : quality === 'BAD'
      ? 'bg-[#EF4444]'
      : 'bg-[#6B7280]';

  return (
    <div className="p-3 rounded-xl border border-[#E2E8F0] bg-white hover:border-[#134074] transition-all shadow-sm space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-[#0B2545] truncate">
            {signal.display_name || signal.name || signal.key}
          </div>
          <div className="text-[10px] font-mono text-[#64748B]">{signal.key}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`w-2 h-2 rounded-full ${qualityColor}`} />
          <span className="text-[11px] font-bold text-[#475569]">{quality}</span>
        </div>
      </div>

      <div className="flex items-baseline justify-between pt-1 border-t border-[#F1F5F9]">
        <div className="text-base font-black text-[#0B2545] font-mono">
          {signal.value !== undefined && signal.value !== null ? String(signal.value) : '—'}{' '}
          <span className="text-xs font-normal text-[#64748B]">{signal.unit || ''}</span>
        </div>
        {/* 15m Trend mini-sparkline */}
        <div className="w-20 h-6 flex items-center">
          {history.length >= 2 ? (
            <MiniSparkline data={history} />
          ) : (
            <span className="text-[10px] text-[#94A3B8]">No history</span>
          )}
        </div>
      </div>
    </div>
  );
};

const MiniSparkline: React.FC<{ data: number[] }> = ({ data }) => {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((val, idx) => {
      const x = (idx / (data.length - 1)) * 76 + 2;
      const y = 22 - ((val - min) / range) * 18;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg className="w-full h-full overflow-visible" viewBox="0 0 80 24">
      <polyline
        fill="none"
        stroke="#134074"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
};
