/**
 * Shared presentational pieces for the two "Historian & Storage" navs (Storage Management, Historian).
 *
 * They copy the visual language of the five earlier navs instead of inventing a new one:
 *   - PageHeader      = Data models / Signals header (20 px bold title, 13 px muted subtitle, actions right)
 *   - KpiTile         = Connections KPI cards (11 px UPPERCASE label, 24 px mono number, clickable filter)
 *   - Segmented       = Signals "Table | Live" switch
 *   - FilterBar       = Data models filter bar (white card, search + selects + counter)
 *   - SideDrawer      = Connections / Signals drawer: fixed under the top bar, Esc closes
 *   - WizardStepper   = Data model wizard navy pill stepper; WizardHeader = its back link + title row
 *   - EmptyState / LoadingBlock / ErrorBanner = the one set of states used on both pages
 * Banner and Dialog are re-exported from the Data Models UI so both navs use the same ones.
 */
import React, { useEffect, useId, useRef } from 'react';
import { ArrowLeft, Check, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { parseRemoteError } from '../../components/common/RemoteResourceState';
import { Banner, Dialog, Skeleton, CopyButton } from '../13_DataModels/ui';

export { Banner, Dialog, Skeleton, CopyButton };

// ------------------------------------------------------------------ page header

export const PageHeader: React.FC<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Optional element left of the title (e.g. back button). */
  leading?: React.ReactNode;
}> = ({ title, subtitle, actions, leading }) => (
  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
    <div className="min-w-0 flex items-start gap-2">
      {leading}
      <div className="min-w-0">
        <h1 className="text-[20px] font-bold text-[#111B37] leading-tight break-words">{title}</h1>
        {subtitle && <p className="text-[13px] text-[#657794] mt-0.5">{subtitle}</p>}
      </div>
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
  </div>
);

// ------------------------------------------------------------------ KPI tiles (Connections style)

export type KpiTone = 'ink' | 'success' | 'muted' | 'error' | 'warning' | 'info';
const KPI_TONE: Record<KpiTone, string> = {
  ink: 'text-[#0B2545]',
  success: 'text-[#10B981]',
  muted: 'text-[#94A3B8]',
  error: 'text-[#EF4444]',
  warning: 'text-[#B76E00]',
  info: 'text-[#2A82E7]',
};

export const KpiTile: React.FC<{
  label: string;
  value: React.ReactNode;
  tone?: KpiTone;
  hint?: string;
  sub?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}> = ({ label, value, tone = 'ink', hint, sub, active, onClick }) => {
  const cls = `p-3.5 rounded-2xl border text-left transition-all min-w-0 ${
    active ? 'bg-white border-[#134074] ring-2 ring-[#134074]/10 shadow-sm' : 'bg-white border-[#E2E8F0]'
  } ${onClick ? 'hover:border-[#CBD5E1] cursor-pointer' : ''}`;
  const body = (
    <>
      <div className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider truncate">{label}</div>
      <div className={`text-2xl font-black mt-1 font-mono tabular-nums ${KPI_TONE[tone]}`}>{value}</div>
      {sub && <div className="text-[11px] text-[#657794] mt-0.5 truncate">{sub}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} aria-pressed={active} title={hint} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls} title={hint}>
      {body}
    </div>
  );
};

// ------------------------------------------------------------------ segmented switch (Signals style)

export interface SegmentOption<T extends string> {
  id: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 max-w-full overflow-x-auto">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = options.findIndex((x) => x.id === value);
              const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
              onChange(next.id);
              const btns = (e.currentTarget.parentElement?.querySelectorAll('button[role="radio"]') || []) as NodeListOf<HTMLButtonElement>;
              btns[options.indexOf(next)]?.focus();
            }}
            tabIndex={on ? 0 : -1}
            className={`flex items-center gap-1.5 whitespace-nowrap font-semibold rounded-md transition ${
              size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]'
            } ${on ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'}`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ filter bar (Data models style)

export const FilterBar: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`flex flex-wrap items-center gap-2 bg-white border border-[#CBD5E1] rounded-xl p-2.5 ${className}`}>{children}</div>
);

export const SearchInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel?: string;
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}> = ({ value, onChange, placeholder, ariaLabel, className = '', inputRef }) => (
  <div className={`relative min-w-0 ${className}`}>
    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
    <input
      ref={inputRef}
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel || placeholder}
      className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white focus:outline-none focus:border-blue-500"
    />
  </div>
);

export const selectCls = 'h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#334568] focus:outline-none focus:border-blue-500 max-w-full';
export const fieldCls =
  'w-full h-9 px-3 border border-[#D4DFEC] rounded-lg text-[13px] bg-white text-[#111B37] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-500';
export const labelCls = 'block text-[12px] font-semibold text-[#334568] mb-1';
export const cardCls = 'bg-white border border-[#CBD5E1] rounded-xl';

// ------------------------------------------------------------------ side drawer (under the top bar)

export const SideDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'md' | 'lg';
  ariaLabel?: string;
}> = ({ open, onClose, title, eyebrow, subtitle, actions, children, footer, width = 'md', ariaLabel }) => {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A modal dialog opened from the drawer owns Escape.
      if (document.querySelector('[aria-modal="true"]')) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-drawer-title]')?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [open]);
  if (!open) return null;
  return (
    <ModalPortal>
      <aside
        ref={ref}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-label={ariaLabel}
        style={{ top: 'calc(var(--fx-topbar-height) + var(--fx-banner-height, 0px))' }}
        className={`fixed bottom-0 right-0 w-full ${width === 'lg' ? 'sm:w-[600px]' : 'sm:w-[480px]'} max-w-full box-border overflow-x-hidden bg-white border-l border-[#E2E8F0] shadow-2xl z-20 flex flex-col animate-in slide-in-from-right duration-200`}
      >
        <div className="p-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-start justify-between gap-2">
          <div className="min-w-0">
            {eyebrow && <div className="flex items-center gap-2 mb-1 min-w-0">{eyebrow}</div>}
            <h2 id={titleId} data-drawer-title tabIndex={-1} className="text-lg font-bold text-[#0B2545] break-words outline-none">
              {title}
            </h2>
            {subtitle && <div className="text-[12px] text-[#657794] mt-0.5 break-words">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {actions && (
          <div role="toolbar" aria-label="Actions" className="px-4 py-3 border-b border-[#E2E8F0] bg-[#F1F5F9] flex flex-wrap gap-2">
            {actions}
          </div>
        )}
        <div className="flex-1 overflow-y-auto min-h-0">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-[#E2E8F0] flex flex-wrap items-center justify-end gap-2">{footer}</div>}
      </aside>
    </ModalPortal>
  );
};

// ------------------------------------------------------------------ wizard header + stepper (Data model wizard)

export interface StepDef {
  id: string;
  label: string;
}

export const WizardStepper: React.FC<{
  steps: StepDef[];
  current: number; // 0-based
  onGo?: (index: number) => void;
  /** Highest index the user may jump to (steps after it are disabled). Default: current. */
  maxReachable?: number;
}> = ({ steps, current, onGo, maxReachable }) => {
  const reach = maxReachable ?? current;
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Steps">
      {steps.map((s, i) => {
        const isCurrent = i === current;
        const done = i < current;
        const disabled = !onGo || i > reach;
        return (
          <li key={s.id} className="flex items-center gap-1.5">
            <button
              type="button"
              aria-current={isCurrent ? 'step' : undefined}
              disabled={disabled && !isCurrent}
              onClick={() => onGo && !disabled && onGo(i)}
              className={`inline-flex items-center gap-2 h-8 pl-1.5 pr-3 rounded-full text-[12px] font-semibold border transition disabled:cursor-not-allowed ${
                isCurrent
                  ? 'bg-[#111B37] text-white border-[#111B37]'
                  : done
                    ? 'bg-white text-[#111B37] border-[#D4DFEC] hover:bg-[#F8FAFC]'
                    : 'bg-white text-[#657794] border-[#E2E8F0]'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px] ${
                  isCurrent ? 'bg-white text-[#111B37]' : done ? 'bg-emerald-600 text-white' : 'bg-slate-100'
                }`}
              >
                {done ? <Check className="w-3 h-3" /> : i + 1}
              </span>
              <span className="hidden sm:inline">{s.label}</span>
              <span className="sm:hidden">{isCurrent ? s.label : ''}</span>
            </button>
            {i < steps.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
};

/** "← Storage Management" + title + status chip on the left, stepper on the right (Data model wizard layout). */
export const WizardHeader: React.FC<{
  backLabel: string;
  onBack: () => void;
  title: React.ReactNode;
  chip?: React.ReactNode;
  note?: React.ReactNode;
  stepper?: React.ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
  srStep?: string;
}> = ({ backLabel, onBack, title, chip, note, stepper, headingRef, srStep }) => (
  // R2-25: one layout for every storage wizard — back link + title row, then the stepper on its own row,
  // left-aligned (it used to sit right of the title or wrap under it depending on the title length).
  <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="ghost" size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={onBack}>
        {backLabel}
      </Button>
      <div className="min-w-0 mr-auto">
        <h1 ref={headingRef} tabIndex={-1} className="text-[18px] font-bold text-[#111B37] outline-none truncate">
          {title}
          {srStep && <span className="sr-only">, {srStep}</span>}
        </h1>
        {(chip || note) && (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#657794]">
            {chip}
            {note}
          </div>
        )}
      </div>
    </div>
    {stepper && <div className="min-w-0">{stepper}</div>}
  </div>
);

/** "Not saved" / "Draft saved" chip in the Data model wizard style. */
export const DraftChip: React.FC<{ state: 'new' | 'draft' | 'saved' | 'edit'; label?: string }> = ({ state, label }) => {
  const map = {
    new: { text: 'Not saved', cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-400' },
    draft: { text: 'Draft saved', cls: 'bg-slate-100 text-slate-700 border-slate-200', dot: 'bg-slate-400' },
    saved: { text: 'Created', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-[#0DBA67]' },
    edit: { text: 'Editing', cls: 'bg-blue-50 text-blue-800 border-blue-200', dot: 'bg-[#2A82E7]' },
  }[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold border whitespace-nowrap px-2 py-0.5 text-[11px] ${map.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${map.dot}`} aria-hidden="true" />
      {label || map.text}
    </span>
  );
};

// ------------------------------------------------------------------ states

export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  dashed?: boolean;
}> = ({ icon, title, children, action, className = '', dashed }) => (
  <div className={`bg-white border ${dashed ? 'border-dashed' : ''} border-[#CBD5E1] rounded-xl px-6 py-10 text-center ${className}`}>
    {icon && <div className="w-11 h-11 rounded-xl bg-[#EEF5FF] text-[#134074] flex items-center justify-center mx-auto mb-3">{icon}</div>}
    <h2 className="text-[15px] font-bold text-[#111B37]">{title}</h2>
    {children && <div className="mt-1.5 text-[13px] text-[#657794] max-w-xl mx-auto leading-relaxed">{children}</div>}
    {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>
);

export const LoadingBlock: React.FC<{ label: string; className?: string }> = ({ label, className = '' }) => (
  <div role="status" aria-live="polite" className={`flex flex-col items-center justify-center gap-3 py-14 text-[13px] text-[#657794] ${className}`}>
    <RefreshCw className="w-5 h-5 animate-spin text-[#94A3B8]" aria-hidden="true" />
    <span>{label}</span>
  </div>
);

/** One error banner for remote failures: plain message, status/code, Retry. */
export const ErrorBanner: React.FC<{ error: unknown; subject: string; onRetry?: () => void; onClose?: () => void }> = ({ error, subject, onRetry, onClose }) => {
  const info = parseRemoteError(error);
  return (
    <Banner
      tone="error"
      onClose={onClose}
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      <span className="font-semibold">Could not load {subject}.</span> {info.message}
      {info.statusCode ? <span className="text-red-700/70"> (HTTP {info.statusCode}{info.code ? ` · ${info.code}` : ''})</span> : null}
    </Banner>
  );
};

export function errorText(error: unknown): string {
  return parseRemoteError(error).message;
}

// ------------------------------------------------------------------ small helpers

export function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString();
}

/** "9:08:12 AM" with the full ISO in a tooltip (one line in tables). */
export const TimeCell: React.FC<{ iso?: string | null; withDate?: boolean }> = ({ iso, withDate }) => {
  if (!iso) return <span className="text-[#94A3B8]">—</span>;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return <span>{iso}</span>;
  const sameDay = new Date().toDateString() === d.toDateString();
  return (
    <span className="whitespace-nowrap tabular-nums" title={d.toISOString()}>
      {withDate || !sameDay ? d.toLocaleString() : d.toLocaleTimeString()}
    </span>
  );
};
