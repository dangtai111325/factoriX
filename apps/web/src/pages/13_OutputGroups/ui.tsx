// Small presentational pieces shared by the Data Model screens.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, X } from 'lucide-react';
import type { ModelKind, ModelStatus } from './types';
import { ModalPortal } from '../../components/modals/ModalPortal';

export const KindBadge: React.FC<{ kind: ModelKind }> = ({ kind }) => (
  <span
    className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${
      kind === 'EVENT' ? 'bg-[#F5F0FF] text-[#7B3AE0] border-[#E3D5FB]' : 'bg-[#EEF5FF] text-[#1D63BD] border-[#D2E3FA]'
    }`}
  >
    {kind === 'EVENT' ? 'Event' : 'State'}
  </span>
);

export const ModelStatusBadge: React.FC<{ status: ModelStatus | 'NEW' }> = ({ status }) => {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    PUBLISHED: { label: 'Published', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: '#0DBA67' },
    DRAFT: { label: 'Draft', cls: 'bg-slate-100 text-slate-700 border-slate-200', dot: '#64748B' },
    ARCHIVED: { label: 'Archived', cls: 'bg-slate-50 text-slate-500 border-slate-200', dot: '#94A3B8' },
    NEW: { label: 'Not saved', cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: '#F59E0B' },
  };
  const s = map[status] || map.DRAFT;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${s.cls}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {s.label}
    </span>
  );
};

export const Toggle: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  title?: string;
}> = ({ checked, onChange, disabled, label, title }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    title={title || label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-[18px] w-8 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 disabled:cursor-not-allowed ${
      checked ? 'bg-[#0A9855]' : 'bg-slate-300'
    }`}
  >
    <span
      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-[15px]' : 'translate-x-[2px]'
      }`}
    />
  </button>
);

export const CopyButton: React.FC<{ text: string | null | undefined; label?: string; className?: string }> = ({
  text,
  label = 'Copy',
  className = '',
}) => {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1800);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      disabled={!text}
      onClick={() => {
        if (!text) return;
        navigator.clipboard
          .writeText(text)
          .then(() => setState('ok'))
          .catch(() => setState('err'));
      }}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border border-slate-600 text-slate-200 hover:bg-slate-700 disabled:opacity-40 ${className}`}
    >
      {state === 'ok' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {state === 'ok' ? 'Copied' : state === 'err' ? 'Copy blocked' : label}
    </button>
  );
};

export const Banner: React.FC<{
  tone: 'error' | 'warning' | 'success' | 'info';
  children: React.ReactNode;
  onClose?: () => void;
  action?: React.ReactNode;
}> = ({ tone, children, onClose, action }) => {
  const cls = {
    error: 'bg-red-50 border-red-200 text-red-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-900',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  }[tone];
  return (
    <div className={`flex items-start gap-2 p-3 border rounded-lg text-[12px] ${cls}`} role={tone === 'error' ? 'alert' : 'status'}>
      {(tone === 'error' || tone === 'warning') && <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" />}
      <div className="flex-1 min-w-0">{children}</div>
      {action}
      {onClose && (
        <button type="button" onClick={onClose} className="p-0.5 rounded hover:bg-black/5" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};

export const Modal: React.FC<{
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'md' | 'lg' | 'xl';
}> = ({ open, title, subtitle, onClose, children, footer, width = 'lg' }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const w = { md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-6xl' }[width];
  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${w} max-h-[90vh] flex flex-col bg-white rounded-xl border border-slate-300 shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200">
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-[#111B37]">{title}</h3>
            {subtitle && <p className="text-[12px] text-[#657794] mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded text-slate-500 hover:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
    </ModalPortal>
  );
};

export const StreamIndicator: React.FC<{ stream: 'connecting' | 'open' | 'closed'; lastFetch: number | null }> = ({
  stream,
  lastFetch,
}) => (
  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#334568]">
    <span
      className={`w-2 h-2 rounded-full ${
        stream === 'open' ? 'bg-[#0DBA67] animate-pulse' : stream === 'connecting' ? 'bg-amber-400' : 'bg-slate-400'
      }`}
    />
    {stream === 'open'
      ? 'Live stream'
      : stream === 'connecting'
      ? 'Connecting to live stream… (polling every 5 s)'
      : `Polling every 5 s${lastFetch ? ` · last ${new Date(lastFetch).toLocaleTimeString()}` : ''}`}
  </span>
);
