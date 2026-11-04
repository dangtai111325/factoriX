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
} from 'lucide-react';
import { SignalItem } from '../../types';
import { Button } from '../../components/common/Button';
import { StatusBadge } from '../../components/common/StatusBadge';

interface SignalInspectorProps {
  signal: SignalItem | null;
  isOpen: boolean;
  onClose: () => void;
  onEdit: (signal: SignalItem) => void;
  onToggleEnabled: (signal: SignalItem) => void;
  onDelete: (signal: SignalItem) => void;
  resourceName?: string;
  connectionName?: string;
  edgeName?: string;
}

function timeAgo(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 0 || isNaN(diffSec)) return 'just now';
  if (diffSec < 60) return `${diffSec} s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} h ago`;
  return `${Math.floor(diffHour / 24)} d ago`;
}

export const SignalInspector: React.FC<SignalInspectorProps> = ({
  signal,
  isOpen,
  onClose,
  onEdit,
  onToggleEnabled,
  onDelete,
  resourceName,
  connectionName,
  edgeName,
}) => {
  if (!isOpen || !signal) return null;

  const isEnabled = signal.enabled !== false;
  const quality = !isEnabled ? 'DISABLED' : (signal.quality || 'NO_DATA').toUpperCase();

  const formattedVal =
    signal.value === null || signal.value === undefined
      ? '—'
      : typeof signal.value === 'number'
      ? Number.isInteger(signal.value)
        ? String(signal.value)
        : signal.value.toFixed(2)
      : String(signal.value);

  const staleSec = signal.expectedIntervalMs ? Math.round(signal.expectedIntervalMs / 1000) : 10;

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-96 bg-white border-l border-slate-200 shadow-xl z-40 flex flex-col justify-between">
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
                {formattedVal}{' '}
                {signal.unit && (
                  <span className="text-[14px] font-normal text-[#657794]">{signal.unit}</span>
                )}
              </div>
              <div className="text-[11px] text-[#657794] mt-0.5" title={signal.lastUpdated ? new Date(signal.lastUpdated).toLocaleString() : ''}>
                Updated {timeAgo(signal.lastUpdated)}
              </div>
            </div>
            <StatusBadge status={quality} />
          </div>

          {/* Quality Reason */}
          <div className="text-[11px] text-[#657794] bg-white p-2.5 rounded border border-slate-200">
            <span className="font-semibold text-slate-700">Quality reason: </span>
            {signal.qualityReason ||
              (quality === 'GOOD'
                ? 'Valid payload format and within expected interval'
                : quality === 'STALE'
                ? `No update received within ${staleSec} s`
                : quality === 'BAD'
                ? 'Field missing in payload or type mismatch'
                : quality === 'DISABLED'
                ? 'Signal collection paused by user'
                : 'Awaiting initial sample')}
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
              <span className="font-medium text-[#111B37]">{connectionName || 'mqtt-lab'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Topic / Address:</span>
              <span className="font-mono text-[#111B37] text-[11px] truncate max-w-[200px]" title={signal.topic || signal.address}>
                {signal.topic || signal.address || '—'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Field path:</span>
              <span className="font-mono text-[#111B37] text-[11px]">{signal.address || `$.${signal.key}`}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Edge collector:</span>
              <span className="font-medium text-[#111B37]">{edgeName || 'Edge DongNai'}</span>
            </div>
          </div>

          {/* Configuration */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-bold uppercase text-[#657794] tracking-wider">
              Configuration
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-[#657794]">Data type:</span>
              <span className="font-semibold text-[#111B37] capitalize">{signal.dataType || signal.type || 'Float32'}</span>
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
        <Button variant="outline" size="sm" onClick={() => onEdit(signal)}>
          <Edit2 className="w-3.5 h-3.5 mr-1.5" />
          Edit
        </Button>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onToggleEnabled(signal)}
          >
            {isEnabled ? 'Disable' : 'Enable'}
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
    </div>
  );
};
