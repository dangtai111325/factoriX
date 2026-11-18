import React from 'react';
import { ConnectionItem } from '../../types';
import { PipelineEntry, usePipelineEntry } from '../../lib/liveStream';

/** Data older than this at the appliance while the source is read normally = "data delayed". */
const DELAY_NOTICE_MS = 15000;

/** Source silent (transport up, no data) as reported by acquisition, or Center's "No samples" sweep. */
function isSilentSource(lastError: string): boolean {
  return lastError.startsWith('Connected, but') || lastError.startsWith('No samples received') || lastError.startsWith('No read completed');
}

export interface StatusPresentation {
  label: string;
  dot: string;
  text: string;
  /** Secondary line: the real last error, or a hint for idle connections. */
  detail?: string;
  detailTone?: 'error' | 'warning' | 'muted';
}

/** Presentation of a connection's display state (computed in AppContext from `effective_health`). */
export function connectionStatus(conn: ConnectionItem, pipeline?: PipelineEntry): StatusPresentation {
  const lastError = conn.lastError || '';
  if (conn.noConnection) {
    // R3-OV-01: the browser cannot reach the appliance, so the last state is not current.
    return { label: 'Unknown', dot: 'bg-slate-300', text: 'text-[#475569]', detail: 'No connection to appliance', detailTone: 'muted' };
  }
  switch (conn.status) {
    case 'connected': {
      // Three different things, never conflated: the connector works (this state), data is late on
      // its way to the appliance (delivery delayed), or some reads failed (intermittent warning).
      const lag = pipeline?.delivery_lag_ms;
      if (typeof lag === 'number' && lag > DELAY_NOTICE_MS) {
        const sec = Math.round(lag / 1000);
        return {
          label: 'Connected',
          dot: 'bg-amber-500',
          text: 'text-[#0B2545]',
          detail: `Source read normally; data delayed ${sec < 120 ? `${sec} s` : `${Math.round(sec / 60)} min`} on the way to the appliance`,
          detailTone: 'warning',
        };
      }
      return lastError
        ? { label: 'Connected', dot: 'bg-amber-500', text: 'text-[#0B2545]', detail: lastError, detailTone: 'warning' }
        : { label: 'Connected', dot: 'bg-[#10B981]', text: 'text-[#0B2545]' };
    }
    case 'idle':
      return { label: 'Idle', dot: 'bg-slate-400', text: 'text-[#475569]', detail: 'No signals yet', detailTone: 'muted' };
    case 'paused':
      return { label: 'Paused', dot: 'bg-slate-500', text: 'text-[#475569]', detail: 'Collection paused', detailTone: 'muted' };
    case 'degraded':
      if (isSilentSource(lastError)) {
        // Connector is up but the source sends nothing: a silent source, not a lost connection.
        return { label: 'No data', dot: 'bg-[#EF4444]', text: 'text-[#0B2545]', detail: lastError, detailTone: 'error' };
      }
      return { label: 'Disconnected', dot: 'bg-[#EF4444]', text: 'text-[#0B2545]', detail: lastError || 'Source is unreachable', detailTone: 'error' };
    default:
      // Server effective_health UNKNOWN: no evidence yet, or the collector itself is not online.
      return {
        label: 'Unknown',
        dot: 'bg-slate-300',
        text: 'text-[#475569]',
        detail: lastError || 'No recent report from the collector',
        detailTone: lastError ? 'error' : 'muted',
      };
  }
}

export const ConnectionStatusCell: React.FC<{ conn: ConnectionItem; compact?: boolean }> = ({ conn, compact }) => {
  const pipeline = usePipelineEntry(conn.id);
  const p = connectionStatus(conn, pipeline);
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
