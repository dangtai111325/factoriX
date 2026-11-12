import React from 'react';
import {
  X,
  Edit2,
  Trash2,
  Radio,
  Clock,
  Network,
  Server,
  Code2,
  CheckCircle2,
  AlertTriangle,
  Play,
  Square,
  LineChart,
} from 'lucide-react';
import { SignalItem } from '../../types';
import { Button } from '../../components/common/Button';
import { StatusBadge } from '../../components/common/StatusBadge';
import { QUALITY_HINT, QUALITY_LABEL, formatTimestamp, formatValue, normalizeQuality, timeAgo } from '../../lib/format';

interface SignalInspectorProps {
  signal: SignalItem | null;
  isOpen: boolean;
  onClose: () => void;
  onEdit: (signal: SignalItem) => void;
  onToggleEnabled: (signal: SignalItem) => void;
  onDelete: (signal: SignalItem) => void;
  onOpenHistorian?: (signal: SignalItem) => void;
  /** True while an enable / disable request runs (the button is disabled). */
  togglePending?: boolean;
  resourceName?: string;
  connectionName?: string;
  edgeName?: string;
}

export const SignalInspector: React.FC<SignalInspectorProps> = ({
  signal,
  isOpen,
  onClose,
  onEdit,
  onToggleEnabled,
  onDelete,
  onOpenHistorian,
  togglePending = false,
  resourceName,
  connectionName,
  edgeName,
}) => {
  if (!isOpen || !signal) return null;

  const isEnabled = signal.enabled !== false;
  const quality = !isEnabled ? 'DISABLED' : normalizeQuality(signal.quality);
  const formattedVal = formatValue(signal.value);
  // Center rule: stale after max(2 x expected interval, 12 s) without a new read.
  const staleSec = Math.round((signal.staleAfterMs ?? Math.max(2 * (signal.expectedIntervalMs || 1000), 12000)) / 1000);
  const lastRead = signal.lastAcquiredAt || signal.receivedTime || signal.lastUpdated;
  const lastChange = signal.lastValueChangedAt || signal.sourceTime;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={`Signal ${signal.key || signal.name}`}
      style={{ top: 'var(--fx-topbar-height)' }}
      className="fixed bottom-0 right-0 w-full sm:w-96 bg-white border-l border-slate-200 shadow-xl z-20 flex flex-col justify-between"
    >
      {/* Top Header */}
      <div>
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-blue-600" />
            <h3 className="text-[14px] font-bold text-[#111B37] truncate max-w-[240px]">
              {signal.displayName || signal.name || signal.key}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Live Value & Quality Card */}
        <div className="p-4 bg-slate-50 border-b border-slate-100 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[28px] font-extrabold text-[#111B37] tabular-nums">
                {formattedVal}
              </div>
              <div className="text-[11px] text-[#657794] mt-0.5" title={formatTimestamp(lastRead)}>
                Last read {timeAgo(lastRead)}
              </div>
              <div className="text-[11px] text-[#657794]" title={formatTimestamp(lastChange)}>
                Last change {lastChange ? timeAgo(lastChange) : '—'}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <StatusBadge status={quality} />
              <button
                type="button"
                onClick={() =>
                  onOpenHistorian
                    ? onOpenHistorian(signal)
                    : window.location.assign(`/historian/historian?signalId=${signal.id}`)
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold text-[#EF1B24] bg-white border border-[#FAC6C9] hover:bg-[#FEF2F2] transition-colors shadow-2xs cursor-pointer"
                title="Open this signal in Historian & Storage trend workspace"
              >
                <LineChart className="w-3.5 h-3.5 text-[#EF1B24]" />
                Open in Historian
              </button>
            </div>
          </div>

          {/* Quality Reason */}
          <div className="text-[11px] text-[#657794] bg-white p-2.5 rounded border border-slate-200">
            <span className="font-semibold text-slate-700">Quality: </span>
            <span className="font-semibold text-slate-700">{QUALITY_LABEL[quality]}</span>
            {signal.reasonCode ? <span className="font-mono"> · {signal.reasonCode}</span> : null}
            {' — '}
            {quality === 'GOOD'
              ? 'Value read successfully within the expected interval.'
              : quality === 'STALE'
              ? `No new read within ${staleSec} s.`
              : quality === 'UNCERTAIN' && signal.reasonCode === 'UNVERIFIED_AFTER_RESTART'
              ? 'Restored from historian after restart; waiting for the first fresh acquisition.'
              : quality === 'UNCERTAIN'
              ? 'The source or the collector flagged this value as uncertain.'
              : quality === 'BAD'
              ? 'The last read failed or could not be decoded.'
              : quality === 'DISABLED'
              ? 'Collection is disabled for this signal.'
              : quality === 'PAUSED' || quality === 'NO_CONNECTION'
              ? QUALITY_HINT[quality]
              : 'No sample received yet.'}
          </div>
        </div>

        {/* Details List */}
        <div className="p-4 space-y-4 text-[12px] overflow-y-auto max-h-[calc(100vh-320px)]">
          {/* Resource & Location */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-bold uppercase text-[#657794] tracking-wider">
              Location
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Resource:</span>
              <span className="font-semibold text-[#111B37]">{resourceName || signal.resourcePath || '—'}</span>
            </div>
          </div>

          {/* Source Binding */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-bold uppercase text-[#657794] tracking-wider">
              Source
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Connection:</span>
              <span className="font-medium text-[#111B37]">{connectionName || '—'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Address:</span>
              <span className="font-mono text-[#111B37] text-[11px] break-all text-right max-w-[220px]" title={signal.bindingAddress}>
                {signal.bindingAddress || '—'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Edge collector:</span>
              <span className="font-medium text-[#111B37]">{edgeName || '—'}</span>
            </div>
          </div>

          {/* Configuration */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-bold uppercase text-[#657794] tracking-wider">
              Configuration
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Data type:</span>
              <span className="font-semibold text-[#111B37] capitalize">{signal.data_type || signal.dataType || '—'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Unit:</span>
              <span className="font-medium text-[#111B37]">{signal.unit || '—'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Stale after:</span>
              <span className="font-medium text-[#111B37]">{staleSec} s</span>
            </div>
            {signal.description && (
              <div className="pt-1">
                <span className="text-[#657794] block text-[11px] mb-1">Description:</span>
                <p className="text-[#111B37] bg-slate-50 p-2 rounded border border-slate-200">
                  {signal.description}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Actions Bar (TC-UI-SG-10..12) */}
      <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => onEdit(signal)}>
            <Edit2 className="w-3.5 h-3.5 mr-1.5" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onOpenHistorian
                ? onOpenHistorian(signal)
                : window.location.assign(`/historian/historian?signalId=${signal.id}`)
            }
            className="text-[#EF1B24] border-[#FAC6C9] hover:bg-[#FEF2F2]"
            title="Open in Historian"
          >
            <LineChart className="w-3.5 h-3.5 mr-1.5 text-[#EF1B24]" />
            Historian
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onToggleEnabled(signal)}
            disabled={togglePending}
          >
            {togglePending ? (isEnabled ? 'Disabling…' : 'Enabling…') : isEnabled ? 'Disable…' : 'Enable'}
          </Button>

          <Button
            variant="danger"
            size="sm"
            onClick={() => onDelete(signal)}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Delete
          </Button>
        </div>
      </div>
    </aside>
  );
};
