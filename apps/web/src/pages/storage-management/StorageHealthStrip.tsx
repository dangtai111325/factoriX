import React from 'react';
import { Database, Layers, Table, Activity, AlertCircle, CheckCircle2 } from 'lucide-react';

interface StorageHealthStripProps {
  databaseCount: number;
  stableCount: number;
  subtableCount: number;
  recordingActive: number;
  recordingPaused: number;
  recordingError: number;
  lastObservedAt?: string;
  onFilterStatus?: (status: string | null) => void;
}

export const StorageHealthStrip: React.FC<StorageHealthStripProps> = ({
  databaseCount,
  stableCount,
  subtableCount,
  recordingActive,
  recordingPaused,
  recordingError,
  lastObservedAt,
  onFilterStatus,
}) => {
  return (
    <div className="flex flex-wrap items-center gap-3 py-2 px-1">
      {/* Databases */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-[#E3EAF3] rounded-lg shadow-xs">
        <Database className="w-4 h-4 text-[#EF1B24]" />
        <span className="text-[12px] font-medium text-[#657794]">Databases</span>
        <span className="text-[13px] font-bold text-[#111B37]">{databaseCount}</span>
      </div>

      {/* Supertables */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-[#E3EAF3] rounded-lg shadow-xs">
        <Layers className="w-4 h-4 text-[#0284C7]" />
        <span className="text-[12px] font-medium text-[#657794]">Supertables</span>
        <span className="text-[13px] font-bold text-[#111B37]">{stableCount}</span>
      </div>

      {/* Subtables */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-[#E3EAF3] rounded-lg shadow-xs">
        <Table className="w-4 h-4 text-[#7C3AED]" />
        <span className="text-[12px] font-medium text-[#657794]">Subtables</span>
        <span className="text-[13px] font-bold text-[#111B37]">{subtableCount}</span>
      </div>

      {/* Recording Status */}
      <div className="flex items-center gap-2.5 px-3 py-1.5 bg-white border border-[#E3EAF3] rounded-lg shadow-xs">
        <Activity className="w-4 h-4 text-[#657794]" />
        <span className="text-[12px] font-medium text-[#657794]">Recording:</span>
        <button
          type="button"
          onClick={() => onFilterStatus?.('ACTIVE')}
          className="flex items-center gap-1 text-[12px] font-semibold text-[#0DBA67] hover:underline"
          title="Active subtables"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>{recordingActive} active</span>
        </button>
        {recordingPaused > 0 && (
          <button
            type="button"
            onClick={() => onFilterStatus?.('PAUSED')}
            className="flex items-center gap-1 text-[12px] font-medium text-[#D97706] hover:underline"
            title="Paused recording"
          >
            <span>• {recordingPaused} paused</span>
          </button>
        )}
        {recordingError > 0 && (
          <button
            type="button"
            onClick={() => onFilterStatus?.('ERROR')}
            className="flex items-center gap-1 text-[12px] font-medium text-[#DC2626] hover:underline"
            title="Subtables with errors"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{recordingError} errors</span>
          </button>
        )}
      </div>

      {lastObservedAt && (
        <span className="ml-auto text-[11px] text-[#94A3B8]">
          Observed {new Date(lastObservedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
};
