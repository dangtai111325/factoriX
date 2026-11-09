// Small presentational pieces shared by the Data Model screens (light theme).
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Info, X } from 'lucide-react';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { useDialogA11y } from '../../components/modals/useDialogA11y';
import { formatJsonText, jsonTokens } from './json';
import type { ModelState } from './types';

export const StateChip: React.FC<{ state: ModelState | 'NEW'; size?: 'sm' | 'md' }> = ({ state, size = 'sm' }) => {
  const map = {
    RUNNING: { label: 'Running', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-[#0DBA67] animate-pulse' },
    PAUSED: { label: 'Paused', cls: 'bg-slate-100 text-slate-700 border-slate-200', dot: 'bg-slate-400' },
    NEW: { label: 'Not saved', cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-400' },
  }[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold border whitespace-nowrap ${map.cls} ${
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${map.dot}`} aria-hidden="true" />
      {map.label}
    </span>
  );
};

export function sampleLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${+(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;
  if (ms < 3600000) return `${+(ms / 60000).toFixed(ms % 60000 ? 1 : 0)} min`;
  return `${+(ms / 3600000).toFixed(1)} h`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleString();
}

/** Re-render every `ms` (relative time labels). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export const CopyButton: React.FC<{ text: string | null | undefined; label?: string; className?: string }> = ({ text, label = 'Copy', className = '' }) => {
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
      className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-semibold border border-[#D4DFEC] bg-white text-[#334568] hover:bg-[#F1F5FA] disabled:opacity-40 ${className}`}
    >
      {state === 'ok' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
      {state === 'ok' ? 'Copied' : state === 'err' ? 'Copy blocked' : label}
    </button>
  );
};

export const Banner: React.FC<{ tone: 'error' | 'warning' | 'success' | 'info'; children: React.ReactNode; onClose?: () => void; action?: React.ReactNode }> = ({
  tone,
  children,
  onClose,
  action,
}) => {
  const cls = {
    error: 'bg-red-50 border-red-200 text-red-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-900',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  }[tone];
  return (
    <div className={`flex items-start gap-2 p-3 border rounded-lg text-[12px] ${cls}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' || tone === 'warning' ? <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-px" /> : <Info className="w-4 h-4 flex-shrink-0 mt-px" />}
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

export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded bg-slate-200/70 ${className}`} aria-hidden="true" />
);

/** Accessible dialog (role=dialog, focus trap, Escape, focus return). */
export const Dialog: React.FC<{
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  /** Block closing (e.g. while a request runs). */
  busy?: boolean;
  /** False while an inner popup (autocomplete) owns the Escape key. */
  escapeCloses?: boolean;
}> = ({ open, title, subtitle, onClose, children, footer, width = 'md', busy = false, escapeCloses = true }) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogA11y(
    open,
    ref,
    () => {
      if (!busy) onClose();
    },
    { closeOnEscape: escapeCloses },
  );
  if (!open) return null;
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[width];
  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !busy) onClose();
        }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`w-full ${w} max-h-[90vh] flex flex-col bg-white rounded-xl border border-slate-300 shadow-2xl outline-none`}
        >
          <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200">
            <div className="min-w-0">
              <h3 id={titleId} className="text-[15px] font-bold text-[#111B37]">
                {title}
              </h3>
              {subtitle && <div className="text-[12px] text-[#657794] mt-0.5">{subtitle}</div>}
            </div>
            <button type="button" onClick={onClose} disabled={busy} className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">{children}</div>
          {footer && <div className="px-5 py-3 border-t border-slate-200 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
        </div>
      </div>
    </ModalPortal>
  );
};

const JSON_CLS: Record<string, string> = {
  key: 'text-[#1D4ED8]',
  string: 'text-[#047857]',
  number: 'text-[#B45309]',
  literal: 'text-[#7C3AED]',
  punct: 'text-slate-500',
  space: '',
};

/** Highlighted ordered JSON (exact text), pretty or compact. */
export const JsonBlock: React.FC<{
  text: string | null;
  pretty?: boolean;
  maxLines?: number;
  className?: string;
  placeholder?: React.ReactNode;
  ariaLabel?: string;
}> = ({ text, pretty = true, maxLines, className = '', placeholder, ariaLabel }) => {
  const formatted = useMemo(() => {
    if (!text) return '';
    const f = formatJsonText(text, pretty);
    if (!maxLines) return f;
    const lines = f.split('\n');
    return lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n  …` : f;
  }, [text, pretty, maxLines]);
  const tokens = useMemo(() => jsonTokens(formatted), [formatted]);
  if (!text) return <div className={`font-mono text-[11px] text-slate-400 ${className}`}>{placeholder ?? 'No body yet.'}</div>;
  return (
    <pre aria-label={ariaLabel} className={`font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-all ${className}`}>
      {tokens.map((t, i) => (
        <span key={i} className={JSON_CLS[t.kind]}>
          {t.text}
        </span>
      ))}
    </pre>
  );
};

export const fieldCls =
  'w-full h-9 px-3 border border-[#D4DFEC] rounded-lg text-[13px] bg-white text-[#111B37] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';
export const labelCls = 'block text-[12px] font-semibold text-[#334568] mb-1';

export interface IconMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  hint?: string;
  danger?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
}

/** Icon-only "⋮" menu. Keyboard: Enter/Space opens, arrows move, Escape closes and refocuses the button. */
export const IconMenu: React.FC<{ label: string; icon: React.ReactNode; items: IconMenuItem[]; className?: string; align?: 'left' | 'right' }> = ({
  label,
  icon,
  items,
  className = '',
  align = 'right',
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const moveFocus = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Tab') return;
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') || []);
    if (!nodes.length) return;
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
    nodes[event.key === 'ArrowDown' ? (index + 1) % nodes.length : (index - 1 + nodes.length) % nodes.length].focus();
  };

  return (
    <div className={`relative ${className}`} ref={rootRef} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => open && e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        {icon}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={moveFocus}
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1 min-w-[210px] rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-1.5 z-40`}
        >
          {items.map((item) => (
            <React.Fragment key={item.key}>
              {item.separator && <div className="my-1 border-t border-slate-100" role="separator" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 text-[12px] outline-none disabled:opacity-45 disabled:cursor-not-allowed focus-visible:bg-[#F1F5FA] ${
                  item.danger ? 'text-[#DB2028] hover:bg-[#FFF5F5]' : 'text-[#334568] hover:bg-[#F8FAFC]'
                }`}
              >
                {item.icon && (
                  <span className="w-4 h-4 flex items-center justify-center shrink-0" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                <span>{item.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
