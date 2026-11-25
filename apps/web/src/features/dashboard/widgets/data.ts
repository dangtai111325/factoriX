/**
 * Pure data helpers for widget renderers (no React, no ECharts).
 *
 * - Numbers only where numbers are meant: booleans and strings are never coerced (`format.toNumber`).
 * - Gaps: consecutive points further apart than the gap threshold are never joined. Threshold =
 *   2 × bucket_ms for bucketed (downsampled) history, otherwise 3 × the median sampling interval.
 * - Reductions (`value_mode` ≠ latest) run over the bounded Historian points via `format.reduce` and carry
 *   a mode label ("Avg · 1h") plus fidelity notes (downsampled → bucket averages, truncated, server notes).
 */
import type { DataState, HistoryData, HistoryPoint, SeriesData } from '../types';
import { isNumber, reduce, type ValueMode } from '../format';

export interface NumPoint {
  t: number;
  v: number | null;
  q: string | null;
}

/** History points with non-numeric values turned into null (a hole, not a zero). */
export function numericPoints(points: HistoryPoint[] | undefined | null): NumPoint[] {
  if (!points?.length) return [];
  const out: NumPoint[] = [];
  for (const p of points) {
    if (!isNumber(p.t)) continue;
    out.push({ t: p.t, v: isNumber(p.v) ? p.v : null, q: p.q ?? null });
  }
  return out;
}

export function medianInterval(ts: number[]): number | null {
  if (ts.length < 2) return null;
  const d: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (dt > 0) d.push(dt);
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/** Distance above which two consecutive points are not connected. */
export function gapThreshold(ts: number[], bucketMs: number | null | undefined): number | null {
  const candidates: number[] = [];
  if (isNumber(bucketMs) && bucketMs > 0) candidates.push(bucketMs * 2);
  const med = medianInterval(ts);
  if (med) candidates.push(med * 3);
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * Inserts a null point inside every gap so a line renderer never connects across it.
 * Returns parallel arrays (data for the chart, quality per data index; inserted holes have q = null).
 */
export function withGaps(points: NumPoint[], bucketMs: number | null | undefined): { data: Array<[number, number | null]>; qs: Array<string | null>; gaps: number } {
  const data: Array<[number, number | null]> = [];
  const qs: Array<string | null> = [];
  const thr = gapThreshold(
    points.map((p) => p.t),
    bucketMs,
  );
  let gaps = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0 && thr !== null) {
      const prev = points[i - 1];
      if (p.t - prev.t > thr && prev.v !== null && p.v !== null) {
        data.push([prev.t + (p.t - prev.t) / 2, null]);
        qs.push(null);
        gaps++;
      }
    }
    data.push([p.t, p.v]);
    qs.push(p.q);
  }
  return { data, qs, gaps };
}

export interface Stats {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | null;
}

export function stats(points: NumPoint[]): Stats {
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let last: number | null = null;
  for (const p of points) {
    if (p.v === null) continue;
    n++;
    sum += p.v;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    last = p.v;
  }
  return n ? { count: n, min, max, avg: sum / n, last } : { count: 0, min: null, max: null, avg: null, last: null };
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ------------------------------------------------------------------------------------------ time

export function formatDuration(ms: number): string {
  if (!isNumber(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rs = s % 60;
    return rs && m < 10 ? `${m}m ${rs}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** Compact label of the widget time window ("1h", "7d"). */
export function rangeLabel(r: { start: number; end: number }): string {
  return formatDuration(r.end - r.start);
}

/** Axis tick label adapted to the span of the window. */
export function timeTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (spanMs <= 15 * 60_000) return `${hm}:${p(d.getSeconds())}`;
  if (spanMs <= 36 * 3600_000) return hm;
  if (spanMs <= 8 * 86400_000) return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${hm}`;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}

export function timeFull(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ------------------------------------------------------------------------------------------ fidelity

/** Discreet notes describing the history fidelity (shown in chart footers). */
export function historyNotes(h: HistoryData | null | undefined, label?: string): string[] {
  if (!h) return [];
  const pre = label ? `${label}: ` : '';
  const out: string[] = [];
  const st = (h.status || '').toUpperCase();
  if (st === 'ERROR') out.push(`${pre}history query failed`);
  else if (st === 'PARTIAL') out.push(`${pre}partial history`);
  if (h.downsampled) out.push(`${pre}downsampled${isNumber(h.bucket_ms) && h.bucket_ms > 0 ? ` (${formatDuration(h.bucket_ms)} buckets)` : ''}`);
  if (h.truncated) out.push(`${pre}truncated at ${h.points.length.toLocaleString('en-US')} points`);
  for (const n of h.notes || []) if (n) out.push(`${pre}${operatorNote(n)}`);
  return out;
}

/** Server coverage notes may name internal storage ("Recorded in db.table (col); …"); operators get the meaning only. */
export function operatorNote(n: string): string {
  return /^Recorded in \S+ \([^)]*\); rows are changes only\.?$/.test(n) ? 'recorded changes only' : n;
}

/** Merge equal notes from several series (keeps first-seen order). */
export function uniqueNotes(notes: string[]): string[] {
  return Array.from(new Set(notes.filter(Boolean)));
}

// ------------------------------------------------------------------------------------------ value modes

export const VALUE_MODES: readonly ValueMode[] = ['latest', 'min', 'max', 'avg', 'sum', 'count', 'delta', 'first'];

const SHORT_MODE: Record<ValueMode, string> = {
  latest: 'Latest',
  min: 'Min',
  max: 'Max',
  avg: 'Avg',
  sum: 'Sum',
  count: 'Count',
  delta: 'Change',
  first: 'First',
};

export interface ModeValue {
  /** number for reductions; any latest value (boolean/string/number) for `latest`. */
  value: unknown;
  state: DataState;
  ts: number | null;
  /** e.g. "Avg · 1h" (null for latest). */
  modeLabel: string | null;
  notes: string[];
}

/** Quality summary of reduced points: any BAD/UNCERTAIN → uncertain, all GOOD → good, else unknown. */
function pointsState(points: HistoryPoint[]): DataState {
  const withValue = points.filter((p) => p.v !== null && p.v !== undefined);
  if (!withValue.length) return 'no_data';
  let allGood = true;
  for (const p of withValue) {
    const q = (p.q || '').toUpperCase();
    if (q === 'BAD' || q === 'UNCERTAIN') return 'uncertain';
    if (q !== 'GOOD') allGood = false;
  }
  return allGood ? 'good' : 'unknown';
}

/** Value of a series for a `value_mode` (latest value or a reduction over the history points). */
export function modeValue(s: SeriesData | undefined, mode: ValueMode, range: { start: number; end: number }): ModeValue {
  if (!s) return { value: null, state: 'no_data', ts: null, modeLabel: null, notes: [] };
  if (mode === 'latest') {
    const l = s.latest;
    const v = l?.value;
    return {
      value: v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v,
      state: s.error ? 'bad' : l?.state ?? 'no_data',
      ts: l?.ts ?? null,
      modeLabel: null,
      notes: [],
    };
  }
  const label = `${SHORT_MODE[mode]} · ${rangeLabel(range)}`;
  const h = s.history;
  if (!h) return { value: null, state: 'no_data', ts: null, modeLabel: label, notes: ['History not available'] };
  const notes: string[] = [];
  const pts = h.points || [];
  const hasNonNumeric = pts.some((p) => p.v !== null && p.v !== undefined && !isNumber(p.v));
  let value: number | null = reduce(pts, mode);
  if (mode !== 'count' && hasNonNumeric && !pts.some((p) => isNumber(p.v))) {
    value = null;
    notes.push(`${SHORT_MODE[mode]} needs numeric values`);
  }
  if (h.downsampled) notes.push(mode === 'count' ? 'Downsampled: counts buckets, not samples' : 'Downsampled: computed over bucket averages');
  if (h.truncated) notes.push(`Truncated at ${pts.length.toLocaleString('en-US')} points`);
  for (const n of h.notes || []) if (n) notes.push(n);
  const last = pts.length ? pts[pts.length - 1].t : null;
  const st = (h.status || '').toUpperCase();
  const state: DataState = st === 'ERROR' ? 'bad' : pointsState(pts);
  return { value, state, ts: last, modeLabel: label, notes };
}

export function modeLabelShort(mode: ValueMode): string {
  return SHORT_MODE[mode];
}

/** Unit of a series (display override first). */
export function unitOf(s: SeriesData): string | null {
  return s.binding?.unit || s.unit || null;
}

/** Distinct non-empty units of the given series, in order. */
export function unitsOf(list: SeriesData[]): string[] {
  return Array.from(new Set(list.map(unitOf).map((u) => u || '')));
}

export function isNumericSeries(s: SeriesData): boolean {
  if (s.value_kind === 'number') return true;
  if (s.value_kind === 'boolean' || s.value_kind === 'string' || s.value_kind === 'json') return false;
  // unknown kind: decide from the data present (never coerce)
  const pts = s.history?.points ?? [];
  const sample = pts.find((p) => p.v !== null && p.v !== undefined);
  if (sample) return isNumber(sample.v);
  const lv = s.latest?.value;
  return lv === null || lv === undefined || isNumber(lv);
}

// ------------------------------------------------------------------------------------------ pairing

export interface Pair {
  x: number;
  y: number;
  tx: number;
  ty: number;
  qx: string | null;
  qy: string | null;
}

/**
 * Pairs X and Y samples by timestamp: each X point is matched with the nearest Y point within
 * `toleranceMs` (0 = exact timestamps only); every point is used at most once (closest pairs first).
 * Points outside the tolerance are never paired; they are reported as unmatched.
 */
export function pairByTime(xs: NumPoint[], ys: NumPoint[], toleranceMs: number): { pairs: Pair[]; unmatchedX: number; unmatchedY: number } {
  const X = xs.filter((p) => p.v !== null).sort((a, b) => a.t - b.t);
  const Y = ys.filter((p) => p.v !== null).sort((a, b) => a.t - b.t);
  const tol = Math.max(0, toleranceMs);
  const cand: Array<[number, number, number]> = []; // [dt, xi, yi]
  let m = 0; // first Y index with Y[m].t >= t (monotonic over the sorted X)
  for (let i = 0; i < X.length; i++) {
    const t = X[i].t;
    while (m < Y.length && Y[m].t < t) m++;
    // the two nearest Y on each side are enough for a nearest-first greedy assignment
    for (let k = Math.max(0, m - 2); k < Math.min(Y.length, m + 2); k++) {
      const dt = Math.abs(Y[k].t - t);
      if (dt <= tol) cand.push([dt, i, k]);
    }
  }
  cand.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const usedX = new Uint8Array(X.length);
  const usedY = new Uint8Array(Y.length);
  const pairs: Pair[] = [];
  for (const [, i, k] of cand) {
    if (usedX[i] || usedY[k]) continue;
    usedX[i] = 1;
    usedY[k] = 1;
    pairs.push({ x: X[i].v as number, y: Y[k].v as number, tx: X[i].t, ty: Y[k].t, qx: X[i].q, qy: Y[k].q });
  }
  pairs.sort((a, b) => a.tx - b.tx);
  return { pairs, unmatchedX: X.length - pairs.length, unmatchedY: Y.length - pairs.length };
}
