import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Radio, Server, Braces, Activity, Cable } from 'lucide-react';
import { ResourceTypeIcon, resourceTypeLabel } from '../../components/common/ResourceTypeIcon';

export const ResourceNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const isCenter = Boolean(data?.isCenter);
  const typeKey = String(data?.type_key || data?.type || 'resource');
  const name = String(data?.label || data?.name || 'Resource');
  const code = String(data?.code || '');

  return (
    <div
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (typeof data?.onDoubleClick === 'function') {
          data.onDoubleClick();
        }
      }}
      className={`rounded-xl bg-white border p-3 shadow-sm select-none transition-all min-w-[180px] max-w-[220px] ${
        selected
          ? 'ring-2 ring-[#0B2545] border-[#0B2545] shadow-md'
          : isCenter
          ? 'ring-2 ring-[#134074] border-[#134074] shadow-md bg-[#F8FAFC]'
          : 'border-[#E2E8F0] hover:border-[#134074]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-[#134074]" />
      <div className="flex items-center justify-between gap-1 mb-1">
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[#F1F5F9] text-[#475569]">
          <ResourceTypeIcon type={typeKey} size={12} />
          {resourceTypeLabel(typeKey)}
        </span>
        {code && (
          <span className="text-[11px] font-mono text-[#64748B] truncate" title={code}>
            {code}
          </span>
        )}
      </div>
      <div className="text-[14px] leading-snug font-bold text-[#0B2545] truncate" title={name}>
        {name}
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-[#134074]" />
    </div>
  );
};

export const SignalNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const name = String(data?.label || data?.key || 'Signal');
  const quality = String(data?.quality || 'UNKNOWN').toUpperCase();
  const value = data?.value !== undefined && data?.value !== null ? String(data.value) : '—';

  const dotColor =
    quality === 'GOOD'
      ? 'bg-[#10B981]'
      : quality === 'UNCERTAIN'
      ? 'bg-[#F59E0B]'
      : quality === 'BAD'
      ? 'bg-[#EF4444]'
      : 'bg-[#6B7280]';

  return (
    <div
      className={`rounded-lg bg-white border p-2 shadow-sm select-none transition-all min-w-[150px] max-w-[180px] ${
        selected
          ? 'ring-2 ring-[#134074] border-[#134074] shadow-md'
          : 'border-[#E2E8F0] hover:border-[#134074]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-[#134074]" />
      <div className="flex items-center justify-between gap-1 mb-0.5">
        <div className="flex items-center gap-1 min-w-0">
          <Radio className="w-3 h-3 text-[#134074] shrink-0" />
          <span className="text-[11px] font-bold text-[#0B2545] truncate">{name}</span>
        </div>
        <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
      </div>
      <div className="text-[11px] font-mono font-extrabold text-[#0B2545] pl-4">{value}</div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-[#134074]" />
    </div>
  );
};

export const ConnectionNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const name = String(data?.label || data?.name || 'Connection');
  const protocol = String(data?.protocolLabel || data?.protocol || '');
  const health = String(data?.health || 'UNKNOWN').toUpperCase();

  const isOnline = health === 'ONLINE' || health === 'HEALTHY' || health === 'ACTIVE';
  const isIdle = health === 'IDLE' || health === 'UNKNOWN' || health === 'PAUSED';

  return (
    <div
      className={`rounded-full bg-white border px-3 py-1.5 shadow-sm select-none transition-all flex items-center gap-2 min-w-[140px] ${
        selected
          ? 'ring-2 ring-[#134074] border-[#134074] shadow-md'
          : 'border-[#CBD5E1] hover:border-[#134074]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-[#134074]" />
      <Cable className="w-3.5 h-3.5 text-[#134074] shrink-0" aria-hidden="true" />
      {protocol && (
        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[#EFF6FF] text-[#134074] shrink-0">{protocol}</span>
      )}
      <span className="text-[11px] font-bold text-[#0B2545] truncate flex-1" title={name}>
        {name}
      </span>
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${isOnline ? 'bg-[#10B981]' : isIdle ? 'bg-[#94A3B8]' : 'bg-[#F59E0B]'}`}
        title={health.toLowerCase()}
      />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-[#134074]" />
    </div>
  );
};

export const EdgeInfraNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const name = String(data?.label || data?.name || 'Edge');
  const health = String(data?.health || 'UNKNOWN').toUpperCase();
  const isOnline = health === 'ONLINE' || health === 'HEALTHY' || health === 'ACTIVE';

  return (
    <div
      className={`rounded-xl bg-[#F8FAFC] border px-3 py-2 shadow-sm select-none transition-all flex items-center gap-2 min-w-[140px] ${
        selected
          ? 'ring-2 ring-[#0B2545] border-[#0B2545] shadow-md'
          : 'border-[#CBD5E1] hover:border-[#0B2545]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-[#0B2545]" />
      <Server className="w-3.5 h-3.5 text-[#0B2545] shrink-0" />
      <span className="text-[11px] font-bold text-[#0B2545] truncate flex-1">{name}</span>
      <span className={`w-2 h-2 rounded-full shrink-0 ${isOnline ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`} />
    </div>
  );
};

export const ModelNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const name = String(data?.label || data?.name || 'Data Model');

  return (
    <div
      className={`rounded-xl bg-white border p-2.5 shadow-sm select-none transition-all min-w-[150px] ${
        selected
          ? 'ring-2 ring-[#7C3AED] border-[#7C3AED] shadow-md'
          : 'border-[#DDD6FE] hover:border-[#7C3AED]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-[#7C3AED]" />
      <div className="flex items-center gap-1.5">
        <Braces className="w-3.5 h-3.5 text-[#7C3AED] shrink-0" aria-hidden="true" />
        <span className="text-xs font-bold text-[#0B2545] truncate" title={name}>
          {name}
        </span>
      </div>
    </div>
  );
};

export const TelemetryGroupNodeComponent: React.FC<NodeProps> = ({ data, selected }) => {
  const signalCount = Number(data?.signalCount || 0);
  const goodCount = Number(data?.goodCount || 0);
  const resourceName = String(data?.resourceName || '');
  const tone =
    signalCount === 0 ? 'bg-[#94A3B8]' : goodCount === signalCount ? 'bg-emerald-500' : goodCount > 0 ? 'bg-amber-500' : 'bg-[#94A3B8]';

  return (
    <div
      className={`rounded-2xl bg-emerald-50/95 border-2 px-3 py-2.5 shadow-sm select-none transition-all cursor-pointer min-w-[190px] max-w-[240px] ${
        selected ? 'ring-2 ring-emerald-500 border-emerald-600 shadow-md' : 'border-emerald-300 hover:border-emerald-500 hover:shadow-md'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-emerald-600" />
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800">Signals</span>
        </div>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-200/80 text-emerald-900">
          {signalCount} {signalCount === 1 ? 'signal' : 'signals'}
        </span>
      </div>
      <div className="text-[14px] leading-snug font-bold text-slate-900 truncate" title={resourceName}>
        {resourceName || 'Signals'}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-emerald-800">
        <span className={`w-1.5 h-1.5 rounded-full ${tone}`} aria-hidden="true" />
        <span>
          {goodCount} of {signalCount} good
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-emerald-600" />
    </div>
  );
};
