import React from 'react';
import { ChevronRight, ArrowUpRight, Activity, Cpu, Layers } from 'lucide-react';
import { ResourceNode, SignalItem } from '../../types';
import { ItemGeometry } from './AutoGrid';

interface ResourceCardProps {
  resource: ResourceNode;
  childrenCount: number;
  childTypeLabel: string;
  signals: SignalItem[];
  rollup: { totalMachines: number; goodCount: number; badCount: number; hasSignals: boolean };
  geometry: ItemGeometry;
  containerWidth: number;
  containerHeight: number;
  isEditMode: boolean;
  isSelected: boolean;
  onDrillDown: () => void;
  onSelectLeaf: () => void;
  onMouseDownResize?: (e: React.MouseEvent, corner: string) => void;
  onMouseDownMove?: (e: React.MouseEvent) => void;
}

export const ResourceCard: React.FC<ResourceCardProps> = ({
  resource,
  childrenCount,
  childTypeLabel,
  signals,
  rollup,
  geometry,
  containerWidth,
  containerHeight,
  isEditMode,
  isSelected,
  onDrillDown,
  onSelectLeaf,
  onMouseDownResize,
  onMouseDownMove,
}) => {
  const hasChildren = childrenCount > 0;
  const directSignals = signals.filter(
    (s) => s.resourceId === resource.id || (s as any).resource_id === resource.id
  );
  const hasDirectSignals = directSignals.length > 0;
  const hasData = hasDirectSignals || rollup.hasSignals;

  // Calculate live freshness
  const liveGoodCount = directSignals.filter(
    (s) => (s.quality || '').toUpperCase() === 'GOOD'
  ).length;
  const isDirectOnline = liveGoodCount > 0;

  // Calculate pixel bounds leaving 12px gutters
  const gutter = 12;
  const left = Math.round(geometry.x * containerWidth + gutter / 2);
  const top = Math.round(geometry.y * containerHeight + gutter / 2);
  const width = Math.max(160, Math.round(geometry.w * containerWidth - gutter));
  const height = Math.max(110, Math.round(geometry.h * containerHeight - gutter));

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isEditMode) {
      onSelectLeaf();
      return;
    }
    // If it has direct signals, clicking card body opens the telemetry panel
    if (hasDirectSignals) {
      onSelectLeaf();
    } else if (hasChildren) {
      onDrillDown();
    } else {
      onSelectLeaf();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (hasDirectSignals) {
        onSelectLeaf();
      } else if (hasChildren) {
        onDrillDown();
      } else {
        onSelectLeaf();
      }
    }
  };

  // Up to 4 top signals for telemetry display
  const topSignals = directSignals.slice(0, 4);

  const dotColor = isDirectOnline ? 'bg-[#10B981]' : 'bg-[#EF4444]';

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={`${resource.name} (${resource.type})`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseDown={isEditMode ? onMouseDownMove : undefined}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      }}
      className={`group absolute rounded-xl p-3 flex flex-col justify-between transition-all select-none outline-none focus-visible:ring-2 focus-visible:ring-[#134074] overflow-hidden ${
        !hasData
          ? 'bg-slate-50 border-2 border-dashed border-[#CBD5E1] text-[#94A3B8]'
          : isDirectOnline || rollup.goodCount > 0
          ? 'bg-white border-2 border-[#1E293B]/20 shadow-sm hover:border-[#0284C7] hover:shadow-lg hover:shadow-sky-900/5'
          : 'bg-white border-2 border-red-200 shadow-sm hover:border-red-400'
      } ${
        isSelected
          ? 'ring-2 ring-[#0284C7] border-[#0284C7] shadow-md bg-sky-50/10'
          : ''
      } ${isEditMode ? 'cursor-move' : 'cursor-pointer'}`}
    >

      {/* Edit Mode Resize Handles on corners */}
      {isEditMode && isSelected && (
        <>
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'se')}
            className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-se-resize z-20 shadow"
          />
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'sw')}
            className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-sw-resize z-20 shadow"
          />
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'ne')}
            className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-ne-resize z-20 shadow"
          />
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'nw')}
            className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-nw-resize z-20 shadow"
          />
        </>
      )}

      {/* Card Header */}
      <div className="relative z-10 w-full pb-1.5 border-b border-slate-100 flex items-center justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#0B2545]/5 text-[#0B2545] font-bold tracking-wider flex items-center gap-1">
              <Cpu className="w-2.5 h-2.5" />
              {resource.type}
            </span>
            <span className="text-[10px] font-mono text-[#64748B] truncate">
              {resource.code || resource.name}
            </span>
          </div>
          <h3 className="text-xs md:text-sm font-bold text-[#0B2545] font-mono truncate tracking-tight">
            {resource.name}
          </h3>
        </div>

        {hasChildren && (
          <button
            type="button"
            title={`Drill down into ${childrenCount} ${childTypeLabel}`}
            onClick={(e) => {
              e.stopPropagation();
              onDrillDown();
            }}
            className="p-1 rounded-md bg-slate-100/80 hover:bg-[#0284C7] hover:text-white text-slate-600 transition-colors shrink-0 shadow-2xs"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Card Body: Live or Offline Telemetry */}
      <div className="relative z-10 my-2 flex-1 flex flex-col justify-center w-full">
        {hasDirectSignals ? (
          <div className="w-full space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-mono">
              {isDirectOnline ? (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor} animate-pulse`} />
                  ONLINE · {liveGoodCount}/{directSignals.length} SIGNALS
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-red-600">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                  OFFLINE · {directSignals.length} SIGNALS
                </span>
              )}
              <span className="text-[9px] text-slate-400">
                {isDirectOnline ? '1 Hz live' : 'No data source'}
              </span>
            </div>

            {/* Telemetry Chips Mini-Grid */}
            <div className="grid grid-cols-2 gap-1.5">
              {topSignals.map((sig) => {
                const isSigGood = (sig.quality || '').toUpperCase() === 'GOOD';
                return (
                  <div
                    key={sig.id}
                    className={`border rounded px-2 py-1 flex items-center justify-between min-w-0 ${
                      isSigGood
                        ? 'bg-slate-50/90 border-slate-200/70'
                        : 'bg-red-50/60 border-red-200'
                    }`}
                  >
                    <span
                      className="text-[10px] font-mono text-slate-600 truncate mr-1"
                      title={sig.displayName || sig.key}
                    >
                      {sig.key}
                    </span>
                    <span
                      className={`text-[11px] font-mono font-bold shrink-0 ${
                        isSigGood ? 'text-[#0B2545]' : 'text-red-600'
                      }`}
                    >
                      {isSigGood && sig.value !== undefined && sig.value !== null
                        ? sig.value
                        : '—'}
                      {isSigGood && sig.unit ? (
                        <span className="text-[8px] font-normal text-slate-400 ml-0.5">
                          {sig.unit}
                        </span>
                      ) : (
                        ''
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : hasChildren && rollup.hasSignals ? (
          <div className="w-full space-y-1.5 text-center">
            {rollup.goodCount > 0 ? (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
                <span>
                  {rollup.totalMachines} {childTypeLabel} · {rollup.goodCount} active signals
                </span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
                <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                <span>
                  {rollup.totalMachines} {childTypeLabel} · Subsystem Offline
                </span>
              </div>
            )}
            <div className="text-[10px] font-mono text-slate-400">
              {rollup.goodCount > 0
                ? 'Subsystem operational · Aggregated flow'
                : 'Data source stopped · No incoming stream'}
            </div>
          </div>
        ) : hasChildren ? (
          <div className="text-center py-2">
            <div className="text-xs font-semibold text-slate-600 font-mono flex items-center justify-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-slate-400" />
              {childrenCount} {childTypeLabel}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">Click "Drill Down" to expand</div>
          </div>
        ) : (
          <div className="text-center py-2 text-xs text-slate-400 italic">No telemetry bound</div>
        )}
      </div>

      {/* Card Footer: Dual Action Ports (View Data vs Drill Down) */}
      <div className="relative z-10 pt-2 border-t border-slate-100 flex items-center justify-between gap-2 text-[11px]">
        {/* Button 1: View Data */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelectLeaf();
          }}
          className={`px-2 py-1 rounded-md font-mono text-[10px] font-bold transition-all flex items-center gap-1 shadow-2xs ${
            hasDirectSignals
              ? 'bg-[#0B2545] hover:bg-[#134074] text-white'
              : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
          }`}
          title={`View telemetry for ${resource.name}`}
        >
          <Activity className="w-3 h-3 text-cyan-400" />
          <span>📊 View Data ({directSignals.length})</span>
        </button>

        {/* Button 2: Drill Down into Sub-units */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDrillDown();
            }}
            className="px-2 py-1 rounded-md font-mono text-[10px] font-bold bg-sky-50 hover:bg-sky-100 text-[#0284C7] border border-sky-200 transition-all flex items-center gap-1 shadow-2xs"
            title={`Drill down into ${childrenCount} ${childTypeLabel}`}
          >
            <span>📂 Drill Down ({childrenCount})</span>
            <ArrowUpRight className="w-3 h-3" />
          </button>
        ) : (
          <span className="text-[10px] font-mono text-slate-400">Leaf Unit</span>
        )}
      </div>
    </div>
  );
};
