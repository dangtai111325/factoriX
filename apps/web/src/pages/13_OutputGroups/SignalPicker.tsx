import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { LatestValue, ResourceSignal } from './types';
import { displayValue } from './modelLogic';

interface Props {
  signals: ResourceSignal[];
  latest: Map<string, LatestValue>;
  value: string;
  expectedKey?: string;
  invalid?: boolean;
  loading?: boolean;
  onChange: (signal: ResourceSignal) => void;
}

const qualityDot = (q: string | null | undefined) => {
  const s = String(q || '').toUpperCase();
  if (s === 'GOOD') return 'bg-[#0DBA67]';
  if (s === 'UNCERTAIN' || s === 'STALE') return 'bg-amber-400';
  if (s === 'BAD') return 'bg-red-500';
  return 'bg-slate-300';
};

export const SignalPicker: React.FC<Props> = ({ signals, latest, value, expectedKey, invalid, loading, onChange }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const selected = signals.find((s) => s.id === value);
  const live = value ? latest.get(value) : undefined;

  useEffect(() => {
    if (!open) return;
    setQ('');
    setHi(0);
    setTimeout(() => input.current?.focus(), 0);
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = signals.filter((s) => !needle || s.key.toLowerCase().includes(needle) || s.displayName.toLowerCase().includes(needle));
    // Exact key match for the expected alias first.
    const ek = (expectedKey || '').toLowerCase();
    return rows.sort((a, b) => Number(b.key.toLowerCase() === ek) - Number(a.key.toLowerCase() === ek) || a.key.localeCompare(b.key));
  }, [signals, q, expectedKey]);

  const pick = (s: ResourceSignal) => {
    onChange(s);
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full min-h-[32px] flex items-center gap-2 px-2.5 py-1 border rounded text-left text-[12px] bg-white focus:outline-none focus:border-blue-500 ${
          invalid ? 'border-red-400 bg-red-50/30' : 'border-slate-300'
        }`}
      >
        {selected ? (
          <>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${qualityDot(live?.quality)}`} />
            <span className="font-mono font-semibold text-[#111B37] truncate">{selected.key}</span>
            {selected.displayName && selected.displayName !== selected.key && (
              <span className="text-[#657794] truncate hidden xl:inline">{selected.displayName}</span>
            )}
            <span className="ml-auto font-mono text-[11px] text-[#334568] truncate max-w-[40%]">
              {live ? displayValue(live.value) : '—'}
              {selected.unit ? ` ${selected.unit}` : ''}
            </span>
          </>
        ) : value ? (
          <span className="text-red-700 truncate">Unknown signal {value.slice(0, 8)}… (not on this resource)</span>
        ) : (
          <span className="text-slate-400 truncate">
            {loading ? 'Loading signals…' : expectedKey ? `Select signal (expected "${expectedKey}")` : 'Select a signal…'}
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[320px] bg-white border border-slate-300 rounded-lg shadow-xl">
          <div className="p-2 border-b border-slate-100 relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
            <input
              ref={input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHi((h) => Math.min(h + 1, list.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHi((h) => Math.max(h - 1, 0));
                } else if (e.key === 'Enter' && list[hi]) {
                  e.preventDefault();
                  pick(list[hi]);
                } else if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="Search by key or name"
              className="w-full h-7 pl-7 pr-2 border border-slate-200 rounded text-[12px] focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1" role="listbox">
            {list.length === 0 ? (
              <div className="px-3 py-4 text-[12px] text-[#657794] text-center">
                {signals.length === 0 ? 'This resource has no active signals yet.' : 'No signal matches.'}
              </div>
            ) : (
              list.map((s, i) => {
                const lv = latest.get(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={s.id === value}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(s)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                      i === hi ? 'bg-blue-50' : ''
                    } ${s.id === value ? 'font-semibold' : ''}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${qualityDot(lv?.quality)}`} />
                    <span className="font-mono text-[#111B37]">{s.key}</span>
                    {s.displayName !== s.key && <span className="text-[#657794] truncate">{s.displayName}</span>}
                    <span className="ml-auto text-[10px] text-slate-400 uppercase">{s.dataType}</span>
                    <span className="font-mono text-[11px] text-[#334568] w-24 text-right truncate">
                      {lv ? displayValue(lv.value) : '—'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
