/**
 * Pure presentation helpers shared by the runtime and every widget renderer.
 * No I/O, no React. Semantics follow docs/architecture/contracts/dashboard.md §4.
 */
import type { DataState, HistoryPoint, LatestValue, Mapping, Threshold } from './types';

export function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Numeric view of a value; booleans and strings are NOT numbers (plan §16.1). */
export function toNumber(v: unknown): number | null {
  return isNumber(v) ? v : null;
}

export function applyTransform(v: unknown, scale: number, offset: number): unknown {
  if (!isNumber(v)) return v;
  const out = v * (isNumber(scale) ? scale : 1) + (isNumber(offset) ? offset : 0);
  return Number.isFinite(out) ? out : null;
}

export interface FormatOptions {
  decimals?: number | null;
  unit?: string | null;
  prefix?: string;
  suffix?: string;
  compact?: boolean;
  nullText?: string;
  showUnit?: boolean;
}

function autoDecimals(v: number): number {
  const a = Math.abs(v);
  if (a === 0 || Number.isInteger(v)) return 0;
  if (a >= 1000) return 0;
  if (a >= 100) return 1;
  if (a >= 1) return 2;
  return 3;
}

const COMPACT = [
  { v: 1e12, s: 'T' },
  { v: 1e9, s: 'B' },
  { v: 1e6, s: 'M' },
  { v: 1e3, s: 'k' },
];

export function formatNumber(v: number, decimals?: number | null, compact = false): string {
  if (compact) {
    const hit = COMPACT.find((c) => Math.abs(v) >= c.v);
    if (hit) {
      const scaled = v / hit.v;
      const d = decimals ?? (Math.abs(scaled) >= 100 ? 0 : 1);
      return `${scaled.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}${hit.s}`;
    }
  }
  const d = decimals ?? autoDecimals(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Display text of any value. `null`/`undefined` → nullText (never "0"). */
export function formatValue(v: unknown, opts: FormatOptions = {}): string {
  const nullText = opts.nullText ?? '—';
  if (v === null || v === undefined) return nullText;
  let body: string;
  if (isNumber(v)) body = formatNumber(v, opts.decimals, opts.compact);
  else if (typeof v === 'boolean') body = v ? 'true' : 'false';
  else if (typeof v === 'string') body = v;
  else if (typeof v === 'number') return nullText; // NaN / Infinity are not displayable values
  else {
    try {
      body = JSON.stringify(v);
    } catch {
      body = String(v);
    }
  }
  const unit = opts.showUnit === false ? '' : opts.unit ? ` ${opts.unit}` : '';
  return `${opts.prefix ?? ''}${body}${isNumber(v) ? unit : ''}${opts.suffix ?? ''}`;
}

/** Highest threshold whose value ≤ v wins; below all → base. Non-numbers → base. */
export function thresholdColor(v: unknown, thresholds: Threshold[] | undefined, base: string): string {
  if (!isNumber(v) || !thresholds?.length) return base;
  let color = base;
  let best = -Infinity;
  for (const t of thresholds) {
    if (isNumber(t.value) && v >= t.value && t.value >= best) {
      best = t.value;
      color = t.color;
    }
  }
  return color;
}

export function thresholdLabel(v: unknown, thresholds: Threshold[] | undefined): string | null {
  if (!isNumber(v) || !thresholds?.length) return null;
  let label: string | null = null;
  let best = -Infinity;
  for (const t of thresholds) {
    if (isNumber(t.value) && v >= t.value && t.value >= best) {
      best = t.value;
      label = t.label || null;
    }
  }
  return label;
}

export function valueKey(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return '';
  return String(v);
}

/** First matching mapping (value mappings by string form, ranges from ≤ v < to). */
export function mapValue(v: unknown, mappings: Mapping[] | undefined): { label: string; color: string } | null {
  if (!mappings?.length || v === null || v === undefined) return null;
  const key = valueKey(v);
  for (const m of mappings) {
    if (m.kind === 'value' && m.value === key) return { label: m.label || key, color: m.color };
  }
  if (isNumber(v)) {
    for (const m of mappings) {
      if (m.kind !== 'range') continue;
      const lo = m.from ?? -Infinity;
      const hi = m.to ?? Infinity;
      if (v >= lo && v < hi) return { label: m.label || key, color: m.color };
    }
  }
  return null;
}

/** Server verdict → display state. Missing information is `unknown`, never good. */
export function dataState(input: {
  quality?: string | null;
  freshness?: string | null;
  effective_status?: string | null;
  hasValue: boolean;
}): DataState {
  const fresh = (input.freshness || '').toUpperCase();
  const eff = (input.effective_status || '').toUpperCase();
  const q = (input.quality || '').toUpperCase();
  if (!input.hasValue && (fresh === 'NO_DATA' || !fresh)) return 'no_data';
  if (fresh === 'STALE' || eff === 'STALE') return 'stale';
  if (q === 'BAD' || eff === 'BAD') return 'bad';
  if (fresh === 'NO_DATA') return 'no_data';
  if (q === 'UNCERTAIN' || eff === 'UNCERTAIN') return 'uncertain';
  if (fresh === 'DELAYED' || eff === 'DELAYED') return 'delayed';
  if (q === 'GOOD' && (fresh === 'FRESH' || fresh === '' || eff === 'GOOD')) return 'good';
  return 'unknown';
}

export const STATE_LABEL: Record<DataState, string> = {
  good: 'Good',
  uncertain: 'Uncertain',
  bad: 'Bad',
  stale: 'Stale',
  delayed: 'Delayed',
  no_data: 'No data',
  unknown: 'Unknown',
};

export function stateColor(state: DataState, t: { good: string; warning: string; bad: string; stale: string; text_muted: string }): string {
  switch (state) {
    case 'good':
      return t.good;
    case 'uncertain':
    case 'delayed':
      return t.warning;
    case 'bad':
      return t.bad;
    case 'stale':
      return t.stale;
    default:
      return t.text_muted;
  }
}

export type ValueMode = 'latest' | 'min' | 'max' | 'avg' | 'sum' | 'count' | 'delta' | 'first';

/** Reduction over history points; numbers only (count counts every point with a value). */
export function reduce(points: HistoryPoint[], mode: ValueMode): number | null {
  if (mode === 'count') return points.filter((p) => p.v !== null && p.v !== undefined).length;
  const nums = points.map((p) => p.v).filter(isNumber);
  if (!nums.length) return null;
  switch (mode) {
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'first':
      return nums[0];
    case 'delta':
      return nums[nums.length - 1] - nums[0];
    case 'latest':
    default:
      return nums[nums.length - 1];
  }
}

export const VALUE_MODE_LABEL: Record<ValueMode, string> = {
  latest: 'Latest',
  min: 'Minimum',
  max: 'Maximum',
  avg: 'Average',
  sum: 'Sum',
  count: 'Count',
  delta: 'Change',
  first: 'First',
};

export function formatTime(ms: number | null | undefined, withSeconds = true): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
  });
}

export function formatAge(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function latestOf(points: HistoryPoint[] | undefined): HistoryPoint | null {
  return points && points.length ? points[points.length - 1] : null;
}

export function isLatestDisplayable(l: LatestValue | null): boolean {
  return Boolean(l && l.value !== null && l.value !== undefined);
}
