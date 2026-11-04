import React, { useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeProps,
  getBezierPath,
} from '@xyflow/react';

const RELATION_VERB_MAP: Record<string, string> = {
  CONTAINS: 'contains',
  PART_OF: 'part of',
  HAS_SIGNAL: 'has signal',
  COLLECTED_VIA: 'collected via',
  RUNS_ON: 'runs on',
  USED_IN: 'used in',
  FEEDS: 'feeds',
  CONNECTED_TO: 'connected to',
  MONITORED_BY: 'monitored by',
  INSTALLED_AT: 'installed at',
};

export const LabeledEdge: React.FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const relationCode = String(data?.relation_code || 'CONNECTED_TO');
  const verb = RELATION_VERB_MAP[relationCode] || relationCode.toLowerCase().replace(/_/g, ' ');
  const sourceLabel = String(data?.sourceLabel || 'Source');
  const targetLabel = String(data?.targetLabel || 'Target');
  const tooltipText = `${sourceLabel} ${verb} ${targetLabel}`;

  const isDataEdge = ['HAS_SIGNAL', 'COLLECTED_VIA', 'RUNS_ON', 'USED_IN'].includes(relationCode);

  const edgeStyle = {
    ...style,
    stroke: isHovered ? '#0B2545' : isDataEdge ? '#134074' : '#64748B',
    strokeWidth: isHovered ? 2.5 : 1.75,
    strokeDasharray: isDataEdge ? '4 3' : undefined,
  };

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={edgeStyle} markerEnd={markerEnd} />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="cursor-pointer"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="relative group"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <div
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold tracking-tight select-none shadow-sm transition-all border ${
              isHovered
                ? 'bg-[#0B2545] text-white border-[#0B2545]'
                : isDataEdge
                ? 'bg-[#EFF6FF] text-[#134074] border-[#BFDBFE]'
                : 'bg-white text-[#475569] border-[#CBD5E1]'
            }`}
          >
            {verb}
          </div>

          {/* Hover tooltip (§9.6 TC-UI-KG-06) */}
          {isHovered && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1 rounded-md bg-[#0B2545] text-white text-[11px] font-medium whitespace-nowrap shadow-lg z-50 pointer-events-none">
              {tooltipText}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
};
