/**
 * Header controls shared by view mode and the Studio: time range picker, refresh selector, live
 * indicator, status chip, resource picker and the variable bar.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Calendar, Check, ChevronDown, Clock, RefreshCw, Search, Wifi, WifiOff, X } from 'lucide-react';
import type { StreamStatus } from '../../../lib/liveStream';
import { formatAge } from '../format';
import { resourcePath } from '../sources';
import {
  RELATIVE_RANGES,
  REFRESH_OPTIONS,
  absoluteRangeError,
  fromLocalInput,
  rangeLabel,
  rangeShortLabel,
  resolveTimeRange,
  toLocalInput,
} from '../timeRange';
import type { DashboardVariable, RefreshPolicy, SourceResource, TimeRange } from '../types';

// ------------------------------------------------------------------ popover

export function usePopover(): {
  open: boolean;
  setOpen: (v: boolean) => void;
  rootRef: React.RefObject<HTMLDivElement>;
  buttonRef: React.RefObject<HTMLButtonElement>;
} {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return { open, setOpen, rootRef, buttonRef };
}

const triggerCls =
  'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[#D4DFEC] bg-white text-[12px] font-semibold text-[#334568] hover:bg-[#F9FAFD] hover:text-[#111B37] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 whitespace-nowrap max-w-full';
const panelCls = 'absolute z-40 mt-1.5 rounded-xl bg-white border border-[#D4DFEC] shadow-xl';

// ------------------------------------------------------------------ time range

export const TimeRangePicker: React.FC<{
  value: TimeRange;
  onChange: (r: TimeRange) => void;
  align?: 'left' | 'right';
  /** Label prefix for screen readers ("Dashboard time range"). */
  ariaLabel?: string;
}> = ({ value, onChange, align = 'right', ariaLabel = 'Time range' }) => {
  const { open, setOpen, rootRef, buttonRef } = usePopover();
  const resolved = resolveTimeRange(value);
  const [from, setFrom] = useState(toLocalInput(resolved.start));
  const [to, setTo] = useState(toLocalInput(resolved.end));
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const r = resolveTimeRange(value);
    setFrom(toLocalInput(r.start));
    setTo(toLocalInput(r.end));
  }, [open, value]);
  const fromMs = fromLocalInput(from);
  const toMs = fromLocalInput(to);
  const error = absoluteRangeError(fromMs, toMs);
  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={triggerCls}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${rangeLabel(value)}`}
        title={rangeLabel(value)}
        onClick={() => setOpen(!open)}
      >
        <Clock className="w-3.5 h-3.5 text-[#657794]" aria-hidden="true" />
        <span className="truncate max-w-[220px]">{value.kind === 'relative' ? rangeLabel(value) : rangeLabel(value)}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[#94A3B8]" aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label={ariaLabel} className={`${panelCls} ${align === 'right' ? 'right-0' : 'left-0'} w-[min(92vw,460px)] p-3 grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-3`}>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] mb-1">Quick ranges</div>
            <ul className="space-y-0.5" role="listbox" aria-label="Quick ranges">
              {RELATIVE_RANGES.map((r) => {
                const on = value.kind === 'relative' && value.last === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => {
                        onChange({ kind: 'relative', last: r.id });
                        setOpen(false);
                      }}
                      className={`w-full text-left px-2 py-1 rounded-md text-[12px] flex items-center justify-between ${on ? 'bg-[#EEF5FF] text-[#0B2545] font-semibold' : 'text-[#334568] hover:bg-[#F8FAFC]'}`}
                    >
                      {r.label}
                      {on && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="sm:border-l sm:border-[#E3EAF3] sm:pl-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" aria-hidden="true" /> Custom range
            </div>
            <label htmlFor={`${id}-from`} className="block text-[11px] font-semibold text-[#334568] mt-1">
              From
            </label>
            <input id={`${id}-from`} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="fx-input h-8 text-[12px]" />
            <label htmlFor={`${id}-to`} className="block text-[11px] font-semibold text-[#334568] mt-2">
              To
            </label>
            <input id={`${id}-to`} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="fx-input h-8 text-[12px]" />
            {error && (from || to) ? <p className="text-[11px] text-red-700 mt-1.5">{error}</p> : null}
            <p className="text-[10px] text-[#94A3B8] mt-1.5">Local time. At most 366 days.</p>
            <button
              type="button"
              disabled={!!error}
              onClick={() => {
                if (fromMs == null || toMs == null) return;
                onChange({ kind: 'absolute', start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() });
                setOpen(false);
              }}
              className="mt-2 w-full h-8 rounded-lg text-[12px] font-semibold text-white bg-[#EF1B24] hover:bg-[#D9141D] disabled:opacity-100"
            >
              Apply custom range
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export { rangeShortLabel };

// ------------------------------------------------------------------ refresh

export const RefreshSelect: React.FC<{ value: RefreshPolicy; onChange: (v: RefreshPolicy) => void; onRefreshNow?: () => void; busy?: boolean }> = ({
  value,
  onChange,
  onRefreshNow,
  busy,
}) => (
  <div className="inline-flex items-center rounded-lg border border-[#D4DFEC] bg-white h-8 overflow-hidden">
    {onRefreshNow && (
      <button
        type="button"
        onClick={onRefreshNow}
        className="h-full px-2 text-[#334568] hover:bg-[#F9FAFD] border-r border-[#E3EAF3] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
        title="Refresh now"
        aria-label="Refresh now"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
      </button>
    )}
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as RefreshPolicy)}
      aria-label="History refresh"
      title="How often history is re-queried (live values always update)"
      className="h-full pl-2 pr-6 text-[12px] font-semibold text-[#334568] bg-white focus:outline-none"
    >
      {REFRESH_OPTIONS.map((o) => (
        <option key={o.id} value={o.id}>
          {o.id === 'live' ? 'Live' : o.id === 'off' ? 'Refresh off' : o.label}
        </option>
      ))}
    </select>
  </div>
);

// ------------------------------------------------------------------ live indicator

export const LiveIndicator: React.FC<{ stream: StreamStatus; lastUpdateAt: number | null; now: number }> = ({ stream, lastUpdateAt, now }) => {
  const map = {
    open: { label: 'Live', cls: 'text-emerald-800 bg-emerald-50 border-emerald-200', dot: 'bg-[#0DBA67] animate-pulse', icon: <Wifi className="w-3.5 h-3.5" aria-hidden="true" /> },
    connecting: { label: 'Reconnecting', cls: 'text-amber-900 bg-amber-50 border-amber-200', dot: 'bg-amber-400', icon: <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> },
    closed: { label: 'Push unavailable', cls: 'text-slate-700 bg-slate-100 border-slate-200', dot: 'bg-slate-400', icon: <WifiOff className="w-3.5 h-3.5" aria-hidden="true" /> },
  }[stream];
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[12px] font-semibold whitespace-nowrap ${map.cls}`}
      title={
        stream === 'open'
          ? 'Live values are pushed by the appliance.'
          : stream === 'connecting'
            ? 'Reconnecting to the live stream; values are read every few seconds meanwhile.'
            : 'The live stream is not connected; values are read every few seconds.'
      }
    >
      {map.icon}
      {map.label}
      <span className="font-normal opacity-80">· {lastUpdateAt ? `updated ${formatAge(lastUpdateAt, now)}` : 'no data yet'}</span>
    </span>
  );
};

// ------------------------------------------------------------------ status chip

export const DashboardStatusChip: React.FC<{
  published_revision: number | null;
  has_unpublished_changes: boolean;
  archived_at?: string | null;
  size?: 'sm' | 'md';
  /** Keep the chips on one line (toolbars). */
  nowrap?: boolean;
}> = ({ published_revision, has_unpublished_changes, archived_at, size = 'sm', nowrap }) => {
  const chips: Array<{ text: string; cls: string; dot: string; title: string }> = [];
  if (archived_at) chips.push({ text: 'Archived', cls: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400', title: 'Archived: hidden from the default list.' });
  if (published_revision) {
    chips.push({ text: `Published r${published_revision}`, cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-[#0DBA67]', title: `Revision ${published_revision} is what viewers see.` });
    if (has_unpublished_changes) chips.push({ text: 'Unpublished changes', cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-400', title: 'The draft differs from the published revision.' });
  } else {
    chips.push({ text: 'Draft', cls: 'bg-slate-100 text-slate-700 border-slate-200', dot: 'bg-slate-400', title: 'Never published: only editors can see it.' });
  }
  return (
    <span className={`inline-flex items-center gap-1 ${nowrap ? 'flex-nowrap' : 'flex-wrap'}`}>
      {chips.map((c) => (
        <span
          key={c.text}
          title={c.title}
          className={`inline-flex items-center gap-1.5 rounded-full font-semibold border whitespace-nowrap ${c.cls} ${size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]'}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} aria-hidden="true" />
          {c.text}
        </span>
      ))}
    </span>
  );
};

// ------------------------------------------------------------------ resource picker

export const ResourceSelect: React.FC<{
  value: string | null;
  onChange: (id: string | null) => void;
  resources: SourceResource[];
  /** Resource type key filter (null = any). */
  typeKey?: string | null;
  allowNone?: boolean;
  noneLabel?: string;
  placeholder?: string;
  ariaLabel: string;
  compact?: boolean;
  disabled?: boolean;
}> = ({ value, onChange, resources, typeKey, allowNone, noneLabel = 'None', placeholder = 'Choose a resource', ariaLabel, compact, disabled }) => {
  const { open, setOpen, rootRef, buttonRef } = usePopover();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const byId = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);
  const options = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return resources
      .filter((r) => !typeKey || r.type_key === typeKey)
      .map((r) => ({ r, path: resourcePath(r, byId) }))
      .filter(({ r, path }) => !needle || `${r.name} ${r.code} ${path.join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => `${a.path.join('/')}/${a.r.name}`.localeCompare(`${b.path.join('/')}/${b.r.name}`, undefined, { numeric: true }))
      .slice(0, 300);
  }, [resources, typeKey, q, byId]);
  const current = value ? byId.get(value) : undefined;
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);
  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
    buttonRef.current?.focus();
  };
  return (
    <div className="relative min-w-0" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        className={`${triggerCls} ${compact ? '' : 'w-full justify-between'} disabled:opacity-50`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${current ? current.name : value ? 'unknown resource' : allowNone ? noneLabel : placeholder}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`truncate ${current ? '' : 'text-[#94A3B8] font-normal'}`}>
          {current ? current.name : value ? 'Unknown resource' : allowNone ? noneLabel : placeholder}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-[#94A3B8] shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div className={`${panelCls} left-0 w-[min(92vw,340px)] p-2`}>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              autoFocus
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                const total = options.length + (allowNone ? 1 : 0);
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(total - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (allowNone && active === 0) choose(null);
                  else {
                    const o = options[active - (allowNone ? 1 : 0)];
                    if (o) choose(o.r.id);
                  }
                }
              }}
              placeholder="Search by name or code"
              aria-label="Search resources"
              aria-controls={listId}
              className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] focus:outline-none focus:border-blue-500"
            />
          </div>
          <ul id={listId} role="listbox" aria-label={ariaLabel} className="mt-1.5 max-h-[280px] overflow-y-auto">
            {allowNone && (
              <li
                role="option"
                aria-selected={value === null}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(null)}
                className={`px-2 py-1.5 rounded-md text-[12px] cursor-pointer ${active === 0 ? 'bg-[#F1F5FA]' : ''} ${value === null ? 'font-semibold text-[#0B2545]' : 'text-[#657794]'}`}
              >
                {noneLabel}
              </li>
            )}
            {options.map(({ r, path }, i) => {
              const idx = i + (allowNone ? 1 : 0);
              return (
                <li
                  key={r.id}
                  role="option"
                  aria-selected={value === r.id}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(r.id)}
                  className={`px-2 py-1.5 rounded-md cursor-pointer ${active === idx ? 'bg-[#F1F5FA]' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-[12px] truncate flex-1 ${value === r.id ? 'font-bold text-[#0B2545]' : 'text-[#111B37] font-medium'}`}>{r.name}</span>
                    <span className="text-[10px] font-mono text-[#94A3B8] shrink-0">{r.code}</span>
                    {value === r.id && <Check className="w-3.5 h-3.5 text-[#0B2545] shrink-0" aria-hidden="true" />}
                  </div>
                  {path.length > 0 && <div className="text-[10px] text-[#94A3B8] truncate">{path.join(' › ')}</div>}
                </li>
              );
            })}
            {options.length === 0 && (
              <li className="px-2 py-4 text-center text-[12px] text-[#657794]">
                {typeKey ? `No ${typeKey} resource matches.` : 'No resource matches.'}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ variable bar

export const VariableBar: React.FC<{
  variables: DashboardVariable[];
  values: Record<string, string | null>;
  onChange: (id: string, value: string | null) => void;
  resources: SourceResource[];
  loading?: boolean;
}> = ({ variables, values, onChange, resources, loading }) => {
  if (!variables.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-label="Dashboard variables">
      {variables.map((v) => (
        <div key={v.id} className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#657794] whitespace-nowrap">{v.label || v.id}</span>
          <div className="min-w-[160px] max-w-[260px]">
            <ResourceSelect
              ariaLabel={v.label || v.id}
              value={values[v.id] ?? null}
              onChange={(id) => onChange(v.id, id)}
              resources={resources}
              typeKey={v.resource_type}
              allowNone
              noneLabel={loading ? 'Loading…' : 'Not set'}
            />
          </div>
          {values[v.id] && (
            <button
              type="button"
              onClick={() => onChange(v.id, null)}
              className="p-1 rounded text-[#94A3B8] hover:text-[#111B37] hover:bg-slate-100"
              aria-label={`Clear ${v.label || v.id}`}
              title="Clear"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
