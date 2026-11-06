import React from 'react';
import { ConnectionItem } from '../../types';

export interface StatusPresentation {
  label: string;
  dot: string;
  text: string;
  /** Secondary line: the real last error, or a hint for idle connections. */
  detail?: string;
  detailTone?: 'error' | 'warning' | 'muted';
}

/** Presentation of a connection's display state (computed in AppContext from `effective_health`). */
export function connectionStatus(conn: ConnectionItem): StatusPresentation {
  const lastError = conn.lastError || '';
  switch (conn.status) {
    case 'connected':
      return lastError
        ? { label: 'Connected', dot: 'bg-amber-500', text: 'text-[#0B2545]', detail: lastError, detailTone: 'warning' }
        : { label: 'Connected', dot: 'bg-[#10B981]', text: 'text-[#0B2545]' };
    case 'idle':
      return { label: 'Idle', dot: 'bg-slate-400', text: 'text-[#475569]', detail: 'No signals yet', detailTone: 'muted' };
    case 'paused':
      return { label: 'Paused', dot: 'bg-slate-500', text: 'text-[#475569]', detail: 'Collection paused', detailTone: 'muted' };
    case 'degraded':
      return { label: 'Disconnected', dot: 'bg-[#EF4444]', text: 'text-[#0B2545]', detail: lastError || 'No data from the source', detailTone: 'error' };
    default:
      // Server effective_health UNKNOWN: no evidence yet, or the Edge collector itself is not online.
      return {
        label: 'Unknown',
        dot: 'bg-slate-300',
        text: 'text-[#475569]',
        detail: lastError || 'No recent report from the Edge collector',
        detailTone: lastError ? 'error' : 'muted',
      };
  }
}

export const ConnectionStatusCell: React.FC<{ conn: ConnectionItem; compact?: boolean }> = ({ conn, compact }) => {
  const p = connectionStatus(conn);
  const tone = p.detailTone === 'error' ? 'text-red-600' : p.detailTone === 'warning' ? 'text-amber-700' : 'text-[#64748B]';
  return (
    <div className="flex items-start gap-1.5" title={p.detail || p.label}>
      <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${p.dot}`} />
      <div className="min-w-0">
        <span className={`font-bold text-[11px] ${p.text}`}>{p.label}</span>
        {p.detail && (
          <div className={`text-[10px] font-medium ${tone} ${compact ? 'truncate max-w-[180px]' : 'break-words'}`}>{p.detail}</div>
        )}
      </div>
    </div>
  );
};
