/**
 * Inspector editors generated from the registry `OptionSpec` (contract §4), one per OptionType.
 * Values are written as given; the server validates every key again.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { listDashboards } from '../../../features/dashboard/api';
import { ResourceSelect } from '../../../features/dashboard/components/controls';
import { PAGE_ROUTES } from '../../../features/dashboard/nav';
import { isHexColor } from '../../../features/dashboard/theme';
import type { DashboardSummary, DashboardVariable, Mapping, OptionSpec, SourceResource, ThemeTokens, Threshold } from '../../../features/dashboard/types';

export interface OptionContext {
  theme: ThemeTokens;
  variables: DashboardVariable[];
  resources: SourceResource[];
  dashboardId: string;
}

const inputCls =
  'w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#111B37] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400';
const smallBtn = 'inline-flex items-center justify-center w-7 h-7 rounded-md text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37] disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300';

function same(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return a === b;
  }
}

export const OptionField: React.FC<{
  spec: OptionSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  ctx: OptionContext;
}> = ({ spec, value, onChange, ctx }) => {
  const id = useId();
  const isDefault = same(value, spec.default);
  const inline = spec.type === 'boolean';
  const editor = renderEditor(spec, value, onChange, ctx, id);
  return (
    <div className={inline ? 'flex items-start justify-between gap-3' : ''}>
      <div className={`flex items-center justify-between gap-2 ${inline ? 'min-w-0 flex-1' : 'mb-1'}`}>
        <label htmlFor={id} className="text-[12px] font-semibold text-[#334568] min-w-0">
          {spec.label}
          {spec.help && <span className="block text-[10px] font-normal text-[#94A3B8] leading-snug">{spec.help}</span>}
        </label>
        {!isDefault && !inline && (
          <button type="button" onClick={() => onChange(cloneDefault(spec.default))} className="text-[10px] font-semibold text-[#657794] hover:text-[#111B37] inline-flex items-center gap-0.5 shrink-0" title="Reset to default">
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Default
          </button>
        )}
      </div>
      {editor}
    </div>
  );
};

function cloneDefault(v: unknown): unknown {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

function renderEditor(spec: OptionSpec, value: unknown, onChange: (v: unknown) => void, ctx: OptionContext, id: string): React.ReactNode {
  switch (spec.type) {
    case 'boolean':
      return <Switch id={id} checked={value === true} onChange={(v) => onChange(v)} label={spec.label} />;
    case 'integer':
    case 'number':
      return <NumberEditor id={id} spec={spec} value={value} onChange={onChange} />;
    case 'string':
      return <input id={id} className={inputCls} value={typeof value === 'string' ? value : ''} maxLength={spec.max_length} onChange={(e) => onChange(e.target.value)} />;
    case 'text':
      return (
        <div>
          <textarea
            id={id}
            className={`${inputCls} h-auto min-h-[120px] py-2 font-mono text-[12px] leading-relaxed`}
            value={typeof value === 'string' ? value : ''}
            maxLength={spec.max_length}
            onChange={(e) => onChange(e.target.value)}
          />
          {spec.max_length ? (
            <div className="text-right text-[10px] text-[#94A3B8]">
              {(typeof value === 'string' ? value.length : 0).toLocaleString()} / {spec.max_length.toLocaleString()}
            </div>
          ) : null}
        </div>
      );
    case 'color':
      return <ColorEditor id={id} value={value} onChange={onChange} nullable={spec.default === null || spec.nullable === true} ctx={ctx} />;
    case 'enum':
      return <EnumEditor id={id} spec={spec} value={value} onChange={onChange} />;
    case 'thresholds':
      return <ThresholdsEditor value={Array.isArray(value) ? (value as Threshold[]) : []} onChange={onChange} ctx={ctx} />;
    case 'mappings':
      return <MappingsEditor value={Array.isArray(value) ? (value as Mapping[]) : []} onChange={onChange} ctx={ctx} />;
    case 'image':
      return <ImageEditor id={id} value={typeof value === 'string' ? value : null} onChange={onChange} />;
    case 'dashboard_ref':
      return <DashboardRefEditor id={id} value={typeof value === 'string' ? value : null} onChange={onChange} currentId={ctx.dashboardId} />;
    case 'page_ref':
      return (
        <select id={id} className={inputCls} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          {Object.entries(PAGE_ROUTES).map(([k, p]) => (
            <option key={k} value={k}>
              {p.label}
            </option>
          ))}
        </select>
      );
    case 'resource_ref':
      return (
        <ResourceSelect
          ariaLabel={spec.label}
          value={typeof value === 'string' ? value : null}
          onChange={(v) => onChange(v)}
          resources={ctx.resources}
          allowNone
          noneLabel="None"
        />
      );
    case 'variable_ref':
      return (
        <select id={id} className={inputCls} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">None</option>
          {ctx.variables.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label || v.id} ({v.id})
            </option>
          ))}
        </select>
      );
    default:
      return <p className="text-[11px] text-[#94A3B8]">This option type is not editable here.</p>;
  }
}

// ------------------------------------------------------------------ primitives

export const Switch: React.FC<{ id?: string; checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }> = ({ id, checked, onChange, label, disabled }) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:opacity-40 ${checked ? 'bg-[#2A82E7]' : 'bg-[#CBD5E1]'}`}
  >
    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
  </button>
);

const NumberEditor: React.FC<{ id: string; spec: OptionSpec; value: unknown; onChange: (v: unknown) => void }> = ({ id, spec, value, onChange }) => {
  const nullable = spec.default === null || spec.nullable === true;
  const isNull = value === null || value === undefined;
  const [text, setText] = useState(isNull ? '' : String(value));
  useEffect(() => {
    setText(isNull ? '' : String(value));
  }, [value, isNull]);
  const parse = (t: string): number | null => {
    if (t.trim() === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return spec.type === 'integer' ? Math.round(n) : n;
  };
  const n = parse(text);
  const outOfRange = n !== null && ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max));
  const commit = (t: string) => {
    const v = parse(t);
    if (v === null) {
      if (nullable) onChange(null);
      return;
    }
    if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) return;
    onChange(v);
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode={spec.type === 'integer' ? 'numeric' : 'decimal'}
          step={spec.type === 'integer' ? 1 : 'any'}
          min={spec.min}
          max={spec.max}
          className={`${inputCls} ${outOfRange ? 'border-red-400' : ''}`}
          value={text}
          placeholder={nullable ? 'Auto' : undefined}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => setText(isNull ? '' : String(value))}
          aria-invalid={outOfRange || undefined}
        />
        {nullable && (
          <label className="inline-flex items-center gap-1 text-[11px] text-[#334568] whitespace-nowrap">
            <input type="checkbox" checked={isNull} onChange={(e) => onChange(e.target.checked ? null : spec.min ?? 0)} /> Auto
          </label>
        )}
      </div>
      {(spec.min !== undefined || spec.max !== undefined) && (
        <p className={`text-[10px] mt-0.5 ${outOfRange ? 'text-red-700' : 'text-[#94A3B8]'}`}>
          {spec.min !== undefined && spec.max !== undefined ? `From ${spec.min} to ${spec.max}` : spec.min !== undefined ? `At least ${spec.min}` : `At most ${spec.max}`}
          {spec.type === 'integer' ? ', whole numbers' : ''}
        </p>
      )}
    </div>
  );
};

const EnumEditor: React.FC<{ id: string; spec: OptionSpec; value: unknown; onChange: (v: unknown) => void }> = ({ id, spec, value, onChange }) => {
  const choices = spec.choices || [];
  const segmented = choices.length > 0 && choices.length <= 4 && choices.every((c) => c.label.length <= 12);
  if (segmented) {
    return (
      <div id={id} role="radiogroup" aria-label={spec.label} className="flex w-full bg-slate-100 p-0.5 rounded-lg border border-slate-200">
        {choices.map((c) => {
          const on = c.value === value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(c.value)}
              className={`flex-1 px-1.5 py-1 text-[11px] font-semibold rounded-md truncate transition ${on ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <select id={id} className={inputCls} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
};

export const ColorEditor: React.FC<{ id?: string; value: unknown; onChange: (v: string | null) => void; nullable: boolean; ctx: { theme: ThemeTokens }; nullLabel?: string }> = ({
  id,
  value,
  onChange,
  nullable,
  ctx,
  nullLabel = 'Inherit',
}) => {
  const hex = isHexColor(value) ? value : null;
  const [text, setText] = useState(hex || '');
  useEffect(() => setText(hex || ''), [hex]);
  const swatches = Array.from(new Set([...ctx.theme.palette.slice(0, 8), ctx.theme.good, ctx.theme.warning, ctx.theme.bad, ctx.theme.stale].filter(isHexColor)));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1" role="listbox" aria-label="Theme colors">
        {nullable && (
          <button
            type="button"
            role="option"
            aria-selected={hex === null}
            onClick={() => onChange(null)}
            className={`h-6 px-1.5 rounded-md border text-[10px] font-semibold ${hex === null ? 'border-[#2A82E7] text-[#0B2545] bg-[#EEF5FF]' : 'border-[#D4DFEC] text-[#657794]'}`}
          >
            {nullLabel}
          </button>
        )}
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            role="option"
            aria-selected={hex?.toUpperCase() === c.toUpperCase()}
            aria-label={c}
            title={c}
            onClick={() => onChange(c.toUpperCase())}
            className={`w-6 h-6 rounded-md border ${hex?.toUpperCase() === c.toUpperCase() ? 'ring-2 ring-offset-1 ring-[#2A82E7] border-transparent' : 'border-black/10'}`}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label="Pick a color"
          value={hex || '#2A82E7'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="w-8 h-8 p-0.5 rounded-md border border-[#D4DFEC] bg-white cursor-pointer"
        />
        <input
          id={id}
          className={`${inputCls} font-mono uppercase ${text && !isHexColor(text) ? 'border-red-400' : ''}`}
          value={text}
          placeholder={nullable ? nullLabel : '#RRGGBB'}
          maxLength={7}
          onChange={(e) => {
            const t = e.target.value.trim();
            setText(t);
            if (isHexColor(t)) onChange(t.toUpperCase());
            else if (!t && nullable) onChange(null);
          }}
          aria-invalid={(text && !isHexColor(text)) || undefined}
        />
      </div>
    </div>
  );
};

const NumberCell: React.FC<{ value: number | null; onChange: (v: number | null) => void; label: string; nullable?: boolean; placeholder?: string }> = ({ value, onChange, label, nullable, placeholder }) => {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => setText(value === null || value === undefined ? '' : String(value)), [value]);
  return (
    <input
      type="number"
      step="any"
      aria-label={label}
      placeholder={placeholder}
      className={`${inputCls} px-1.5`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === '') {
          if (nullable) onChange(null);
          return;
        }
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
};

const SwatchButton: React.FC<{ value: string; onChange: (c: string) => void; ctx: OptionContext; label: string }> = ({ value, onChange, ctx, label }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-label={`${label}: ${value}`} aria-expanded={open} onClick={() => setOpen(!open)} className="w-8 h-8 rounded-md border border-black/10 shrink-0" style={{ background: isHexColor(value) ? value : '#FFFFFF' }} />
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[220px] p-2 rounded-lg bg-white border border-[#D4DFEC] shadow-xl">
          <ColorEditor value={value} onChange={(c) => c && onChange(c)} nullable={false} ctx={ctx} />
        </div>
      )}
    </div>
  );
};

function move<T>(arr: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const out = arr.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

const ThresholdsEditor: React.FC<{ value: Threshold[]; onChange: (v: Threshold[]) => void; ctx: OptionContext }> = ({ value, onChange, ctx }) => {
  const MAX = 10;
  const set = (i: number, patch: Partial<Threshold>) => onChange(value.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  return (
    <div className="space-y-1.5">
      {value.length === 0 && <p className="text-[11px] text-[#94A3B8]">No thresholds: the base color is used. A value at or above a threshold takes its color (highest wins).</p>}
      {value.map((t, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className="w-[84px] shrink-0">
            <NumberCell value={t.value} onChange={(v) => v !== null && set(i, { value: v })} label={`Threshold ${i + 1} value`} />
          </div>
          <SwatchButton value={t.color} onChange={(c) => set(i, { color: c })} ctx={ctx} label={`Threshold ${i + 1} color`} />
          <input className={`${inputCls} px-1.5`} value={t.label || ''} maxLength={40} placeholder="Label" aria-label={`Threshold ${i + 1} label`} onChange={(e) => set(i, { label: e.target.value })} />
          <button type="button" className={smallBtn} onClick={() => onChange(move(value, i, -1))} disabled={i === 0} aria-label="Move up">
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button type="button" className={smallBtn} onClick={() => onChange(move(value, i, 1))} disabled={i === value.length - 1} aria-label="Move down">
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button type="button" className={smallBtn} onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label={`Remove threshold ${i + 1}`}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={value.length >= MAX}
        onClick={() => {
          const last = value[value.length - 1];
          const colors = [ctx.theme.warning, ctx.theme.bad, ctx.theme.good];
          onChange([...value, { value: last ? last.value + 10 : 80, color: colors[value.length % colors.length], label: '' }]);
        }}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2A82E7] hover:underline disabled:opacity-40 disabled:no-underline"
      >
        <Plus className="w-3 h-3" aria-hidden="true" /> Add threshold {value.length >= MAX ? `(max ${MAX})` : ''}
      </button>
    </div>
  );
};

const MappingsEditor: React.FC<{ value: Mapping[]; onChange: (v: Mapping[]) => void; ctx: OptionContext }> = ({ value, onChange, ctx }) => {
  const MAX = 30;
  const set = (i: number, next: Mapping) => onChange(value.map((m, k) => (k === i ? next : m)));
  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-[11px] text-[#94A3B8]">No mappings: values are shown as they are. Map a value (e.g. “true”, “3”) or a range to a label and a color.</p>}
      {value.map((m, i) => (
        <div key={i} className="rounded-lg border border-[#E3EAF3] p-1.5 space-y-1">
          <div className="flex items-center gap-1">
            <select
              aria-label={`Mapping ${i + 1} kind`}
              className={`${inputCls} w-[84px] px-1`}
              value={m.kind}
              onChange={(e) =>
                set(i, e.target.value === 'range' ? { kind: 'range', from: null, to: null, label: m.label, color: m.color } : { kind: 'value', value: '', label: m.label, color: m.color })
              }
            >
              <option value="value">Value</option>
              <option value="range">Range</option>
            </select>
            {m.kind === 'value' ? (
              <input className={`${inputCls} px-1.5`} value={m.value} maxLength={80} placeholder="Value, e.g. true or 3" aria-label={`Mapping ${i + 1} value`} onChange={(e) => set(i, { ...m, value: e.target.value })} />
            ) : (
              <>
                <NumberCell value={m.from} nullable placeholder="From" onChange={(v) => set(i, { ...m, from: v })} label={`Mapping ${i + 1} from`} />
                <NumberCell value={m.to} nullable placeholder="To" onChange={(v) => set(i, { ...m, to: v })} label={`Mapping ${i + 1} to`} />
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <input className={`${inputCls} px-1.5`} value={m.label} maxLength={40} placeholder="Label shown" aria-label={`Mapping ${i + 1} label`} onChange={(e) => set(i, { ...m, label: e.target.value })} />
            <SwatchButton value={m.color} onChange={(c) => set(i, { ...m, color: c })} ctx={ctx} label={`Mapping ${i + 1} color`} />
            <button type="button" className={smallBtn} onClick={() => onChange(move(value, i, -1))} disabled={i === 0} aria-label="Move up">
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button type="button" className={smallBtn} onClick={() => onChange(move(value, i, 1))} disabled={i === value.length - 1} aria-label="Move down">
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button type="button" className={smallBtn} onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label={`Remove mapping ${i + 1}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          {m.kind === 'range' && <p className="text-[10px] text-[#94A3B8]">Matches from ≤ value &lt; to; an empty bound is open.</p>}
        </div>
      ))}
      <button
        type="button"
        disabled={value.length >= MAX}
        onClick={() => onChange([...value, { kind: 'value', value: '', label: '', color: ctx.theme.palette[value.length % ctx.theme.palette.length] || '#2563EB' }])}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2A82E7] hover:underline disabled:opacity-40"
      >
        <Plus className="w-3 h-3" aria-hidden="true" /> Add mapping {value.length >= MAX ? `(max ${MAX})` : ''}
      </button>
    </div>
  );
};

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_MAX_BYTES = 300 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const ImageEditor: React.FC<{ id: string; value: string | null; onChange: (v: string | null) => void }> = ({ id, value, onChange }) => {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onFile = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setError('Use a PNG, JPEG, WebP or GIF image (SVG is not allowed).');
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError(`The image is ${Math.round(file.size / 1024)} KB; the limit is 300 KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      if (!DATA_URL_RE.test(url) || url.length > 400000) {
        setError('The image could not be embedded.');
        return;
      }
      onChange(url);
    };
    reader.onerror = () => setError('The file could not be read.');
    reader.readAsDataURL(file);
  };
  const safe = value && DATA_URL_RE.test(value) ? value : null;
  return (
    <div className="space-y-1.5">
      <input ref={ref} id={id} type="file" accept={IMAGE_TYPES.join(',')} className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
      {safe ? (
        <div className="relative rounded-lg border border-[#E3EAF3] bg-[repeating-conic-gradient(#F1F5FA_0%_25%,#FFFFFF_0%_50%)] bg-[length:16px_16px] p-2">
          <img src={safe} alt="" className="max-h-32 mx-auto object-contain" />
          <button type="button" onClick={() => onChange(null)} className="absolute top-1 right-1 p-1 rounded-md bg-white/90 border border-[#D4DFEC] text-[#657794] hover:text-red-600" aria-label="Remove image">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : null}
      <button type="button" onClick={() => ref.current?.click()} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[#D4DFEC] bg-white text-[12px] font-semibold text-[#334568] hover:bg-[#F9FAFD]">
        <ImagePlus className="w-3.5 h-3.5" aria-hidden="true" /> {safe ? 'Replace image' : 'Upload image'}
      </button>
      <p className="text-[10px] text-[#94A3B8]">PNG, JPEG, WebP or GIF, up to 300 KB. The image is stored inside the dashboard.</p>
      {error && (
        <p role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
};

let dashboardsCache: Promise<DashboardSummary[]> | null = null;
function loadDashboardRefs(): Promise<DashboardSummary[]> {
  if (!dashboardsCache) {
    dashboardsCache = listDashboards({ includeArchived: false }).then((r) => r.items || []);
    dashboardsCache.catch(() => {
      dashboardsCache = null;
    });
    // Short-lived: a dashboard created meanwhile shows up on the next open.
    window.setTimeout(() => {
      dashboardsCache = null;
    }, 30000);
  }
  return dashboardsCache;
}

const DashboardRefEditor: React.FC<{ id: string; value: string | null; onChange: (v: string | null) => void; currentId: string }> = ({ id, value, onChange, currentId }) => {
  const [items, setItems] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadDashboardRefs()
      .then((r) => alive && setItems(r))
      .catch(() => alive && setError('Could not load the dashboards.'));
    return () => {
      alive = false;
    };
  }, []);
  const known = items?.some((d) => d.id === value);
  return (
    <div>
      <select id={id} className={inputCls} value={value || ''} onChange={(e) => onChange(e.target.value || null)} disabled={!items && !error}>
        <option value="">{items ? 'None' : 'Loading…'}</option>
        {value && items && !known && <option value={value}>Unknown or archived dashboard</option>}
        {(items || [])
          .filter((d) => d.id !== currentId)
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.published_revision ? '' : ' (not published)'}
            </option>
          ))}
      </select>
      {error && <p className="text-[11px] text-red-700 mt-0.5">{error}</p>}
    </div>
  );
};
