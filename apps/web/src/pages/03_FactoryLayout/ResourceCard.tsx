import React from 'react';
import { ChevronRight, ArrowUpRight } from 'lucide-react';
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
    (s) => s.resourceId === resource.id || s.resource_id === resource.id
  );
  const hasDirectSignals = directSignals.length > 0;
  const hasData = hasDirectSignals || rollup.hasSignals;

  // Calculate pixel bounds leaving 12px gutters
  const gutter = 12;
  const left = Math.round(geometry.x * containerWidth + gutter / 2);
  const top = Math.round(geometry.y * containerHeight + gutter / 2);
  const width = Math.max(120, Math.round(geometry.w * containerWidth - gutter));
  const height = Math.max(80, Math.round(geometry.h * containerHeight - gutter));

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isEditMode) {
      onSelectLeaf();
      return;
    }
    if (hasChildren) {
      onDrillDown();
    } else {
      onSelectLeaf();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (hasChildren) {
        onDrillDown();
      } else {
        onSelectLeaf();
      }
    }
  };

  // Top 3 signals for leaf or resource with direct signals
  const topSignals = directSignals.slice(0, 3);
  const worstQuality = directSignals.some((s) => s.quality?.toUpperCase() === 'BAD')
    ? 'BAD'
    : directSignals.some((s) => s.quality?.toUpperCase() === 'UNCERTAIN')
    ? 'UNCERTAIN'
    : directSignals.some((s) => s.quality?.toUpperCase() === 'GOOD')
    ? 'GOOD'
    : 'UNKNOWN';

  const dotColor =
    worstQuality === 'GOOD'
      ? 'bg-[#10B981]'
      : worstQuality === 'UNCERTAIN'
      ? 'bg-[#F59E0B]'
      : worstQuality === 'BAD'
      ? 'bg-[#EF4444]'
      : 'bg-[#6B7280]';

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
      className={`absolute rounded-2xl p-4 flex flex-col justify-between transition-all select-none outline-none focus-visible:ring-2 focus-visible:ring-[#134074] ${
        !hasData
          ? 'bg-white border-2 border-dashed border-[#CBD5E1] text-[#94A3B8]'
          : 'bg-white border border-[#E2E8F0] shadow-sm hover:border-[#134074] hover:shadow-md'
      } ${
        isSelected
          ? 'ring-2 ring-[#134074] border-[#134074] shadow-md'
          : ''
      } ${isEditMode ? 'cursor-move' : hasChildren ? 'cursor-pointer' : 'cursor-default'}`}
    >
      {/* Edit Mode Resize Handles on corners */}
      {isEditMode && isSelected && (
        <>
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'se')}
            className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-se-resize z-10 shadow"
          />
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'sw')}
            className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-sw-resize z-10 shadow"
          />
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'ne')}
            className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-ne-resize z-10 shadow"
          />
          <div
            onMouseDown={(e) => onMouseDownResize?.(e, 'nw')}
            className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 bg-white border-2 border-[#134074] rounded-sm cursor-nw-resize z-10 shadow"
          />
        </>
      )}

      {/* Card Header: Type Chip + Code + Drill icon (Centered layout) */}
      <div className="flex flex-col items-center justify-center text-center relative w-full mb-1">
        <div className="flex items-center justify-center gap-1.5 mb-1">
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#F1F5F9] text-[#475569] font-bold">
            {resource.type}
          </span>
          <span className="text-[10px] font-mono text-[#64748B] truncate">{resource.code}</span>
        </div>
        <h3 className="text-sm md:text-base font-bold text-[#0B2545] truncate tracking-tight text-center w-full">
          {resource.name}
        </h3>

        {hasChildren && (
          <div className="absolute right-0 top-0 p-1 rounded-full bg-[#F8FAFC] text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] shrink-0">
            <ChevronRight className="w-4 h-4" />
          </div>
        )}
      </div>

      {/* Card Body: Live values OR Roll-up statistics OR No data (Centered) */}
      <div className="my-2 flex-1 flex flex-col items-center justify-center text-center w-full">
        {hasDirectSignals ? (
          <div className="space-y-1 w-full flex flex-col items-center justify-center">
            <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-[#0B2545] truncate w-full text-center">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
              <span className="truncate text-center">
                {topSignals
                  .map(
                    (s) =>
                      `${s.display_name || s.key} ${
                        s.value !== undefined && s.value !== null ? s.value : '—'
                      }`
                  )
                  .join(' · ')}
              </span>
            </div>
            <div className="text-[10px] text-[#64748B] text-center">Updated recently</div>
          </div>
        ) : hasChildren && rollup.hasSignals ? (
          <div className="space-y-1 w-full flex flex-col items-center justify-center">
            <div className="flex items-center justify-center gap-1.5 text-xs font-bold text-[#0B2545] text-center">
              <span className="w-2 h-2 rounded-full bg-[#10B981] shrink-0" />
              <span>
                {rollup.totalMachines} {childTypeLabel} · {rollup.goodCount} good
                {rollup.badCount > 0 ? ` · ${rollup.badCount} bad` : ''}
              </span>
            </div>
            <div className="text-[10px] text-[#64748B] text-center">Active operational telemetry</div>
          </div>
        ) : hasChildren ? (
          <div className="text-xs text-[#64748B] font-medium text-center">
            {childrenCount} {childTypeLabel}
          </div>
        ) : (
          <div className="text-xs text-[#94A3B8] italic text-center">No data</div>
        )}
      </div>

      {/* Card Footer: Centered */}
      <div className="pt-2 border-t border-[#F1F5F9] flex items-center justify-center gap-3 text-[11px] text-[#64748B] text-center">
        <span>
          {hasChildren ? `${childrenCount} ${childTypeLabel}` : `${directSignals.length} signals`}
        </span>
        {hasChildren && (
          <span className="text-[10px] text-[#134074] font-semibold flex items-center gap-0.5">
            Drill down <ArrowUpRight className="w-3 h-3" />
          </span>
        )}
      </div>
    </div>
  );
};
