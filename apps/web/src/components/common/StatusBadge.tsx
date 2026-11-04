import React from 'react';

interface StatusBadgeProps {
  status: string;
  label?: string;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label, className = '' }) => {
  const norm = (status || '').toUpperCase();

  let dotColor = '#94A3B8';
  let bgClasses = 'bg-slate-100 text-slate-700 border-slate-200';
  let defaultLabel = norm.replace(/_/g, ' ');

  if (norm === 'GOOD' || norm === 'ONLINE' || norm === 'HEALTHY' || norm === 'ACTIVE' || norm === 'PUBLISHED') {
    dotColor = '#0DBA67';
    bgClasses = 'bg-emerald-50 text-emerald-800 border-emerald-200';
    if (!label) defaultLabel = norm === 'GOOD' ? 'Good' : norm === 'ONLINE' ? 'Online' : norm === 'ACTIVE' ? 'Active' : 'Published';
  } else if (norm === 'UNCERTAIN' || norm === 'DEGRADED' || norm === 'WARN' || norm === 'WARNING') {
    dotColor = '#F59E0B';
    bgClasses = 'bg-amber-50 text-amber-800 border-amber-200';
    if (!label) defaultLabel = norm === 'UNCERTAIN' ? 'Uncertain' : 'Degraded';
  } else if (norm === 'BAD' || norm === 'OFFLINE' || norm === 'ERROR' || norm === 'FAILED' || norm === 'CRITICAL') {
    dotColor = '#EF4444';
    bgClasses = 'bg-red-50 text-red-800 border-red-200';
    if (!label) defaultLabel = norm === 'BAD' ? 'Bad' : norm === 'OFFLINE' ? 'Offline' : 'Error';
  } else if (norm === 'STALE' || norm === 'PAUSED') {
    dotColor = '#64748B';
    bgClasses = 'bg-slate-100 text-slate-700 border-slate-200';
    if (!label) defaultLabel = norm === 'STALE' ? 'Stale' : 'Paused';
  } else if (norm === 'DISABLED') {
    dotColor = '#94A3B8';
    bgClasses = 'bg-slate-100 text-slate-500 border-slate-200';
    if (!label) defaultLabel = 'Disabled';
  } else if (norm === 'NO_DATA') {
    dotColor = '#94A3B8';
    bgClasses = 'bg-slate-50 text-slate-500 border-slate-200';
    if (!label) defaultLabel = 'No data';
  } else if (norm === 'DRAFT') {
    dotColor = '#64748B';
    bgClasses = 'bg-slate-100 text-slate-700 border-slate-200';
    if (!label) defaultLabel = 'Draft';
  }

  const text = label || defaultLabel;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${bgClasses} ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />
      <span>{text}</span>
    </span>
  );
};
