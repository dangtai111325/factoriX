/**
 * Historian page model: series tokens, URL/view state, time ranges, point normalisation, statistics,
 * quality segments and value formatting. Pure functions only (no React), so the page and the chart
 * share one definition of "what the user is looking at".
 */
import type { HistorianQueryResponse, HistorianSeriesResult, HistorianViewSpec } from '../../lib/storagePhysicalApi';

export type HistorianMode = 'operational' | 'recorded' | 'reconstructed';
export type ChartLayout = 'overlay' | 'lanes';
export type HistorianTab = 'trend' | 'records' | 'events' | 'exports';
export type CompareOffset = '' | 'prev' | '1d' | '7d';

export const MAX_SERIES = 8;

/** Distinct, colour-blind-friendly order (blue, orange, green, purple, cyan, magenta, olive, brown). */
export const SERIES_COLORS = ['#2563EB', '#EA7A12', '#0E9F6E', '#8B5CF6', '#0891B2', '#DB2777', '#65A30D', '#92400E'] as const;

export const MODES: { id: HistorianMode; label: string; short: string; explain: string }[] = [
  {
    id: 'operational',
    label: 'Raw readings',
    short: 'Raw',
    explain: 'Every value the collector read, exactly as stored in the raw time-series store (kept for the raw retention period).',
  },
  {
    id: 'recorded',
    label: 'Recorded',
    short: 'Recorded',
    explain:
      'Only the rows your recording rules stored (on change, every reading or at an interval) in the tables of Storage Management. Dots are stored rows; the line holds each value until the next row.',
  },
  {
    id: 'reconstructed',
    label: 'Reconstructed',
    short: 'Reconstructed',
    explain:
      'The recorded rows drawn as a continuous timeline: each value holds until the next stored change. Periods where the source was stale or bad stay empty instead of being filled in.',
  },
];

export const RANGE_PRESETS: { id: string; label: string; ms: number }[] = [
  { id: '5m', label: '5m', ms: 5 * 60e3 },
  { id: '15m', label: '15m', ms: 15 * 60e3 },
  { id: '1h', label: '1h', ms: 3600e3 },
  { id: '6h', label: '6h', ms: 6 * 3600e3 },
  { id: '24h', label: '24h', ms: 24 * 3600e3 },
  { id: '7d', label: '7d', ms: 7 * 86400e3 },
  { id: '30d', label: '30d', ms: 30 * 86400e3 },
];
const PRESET_MS = new Map(RANGE_PRESETS.map((p) => [p.id, p.ms]));
export const MAX_RANGE_MS = 366 * 86400e3;

export const COMPARE_OPTIONS: { id: CompareOffset; label: string }[] = [
  { id: '', label: 'No comparison' },
  { id: 'prev', label: 'Previous period' },
  { id: '1d', label: 'Same time yesterday' },
  { id: '7d', label: 'Same time last week' },
];

// ------------------------------------------------------------------ series tokens

export type SeriesKind = 'signal' | 'model_field' | 'subtable';

/** Backend series token: `<signal uuid>` | `mod:<model uuid>:<field path>` | `subtable:<db>.<table>[:<col>]`. */
export function kindOfToken(token: string): SeriesKind {
  if (token.startsWith('mod:')) return 'model_field';
  if (token.startsWith('subtable:')) return 'subtable';
  return 'signal';
}

export function normalizeToken(raw: string, kindHint?: string | null): string | null {
  const t = (raw || '').trim();
  if (!t) return null;
  if (t.startsWith('sig:')) return t.slice(4);
  if (t.startsWith('mod:') || t.startsWith('subtable:')) return t;
  if (kindHint === 'subtable') return `subtable:${t}`;
  if (kindHint === 'model_field' && t.includes(':')) return `mod:${t}`;
  return t;
}

// ------------------------------------------------------------------ view state (URL <-> state)

export type RangeState = { kind: 'preset'; preset: string } | { kind: 'abs'; startMs: number; endMs: number };

export interface ViewState {
  sources: string[];
  mode: HistorianMode;
  range: RangeState;
  live: boolean;
  compare: CompareOffset;
  layout: ChartLayout;
  hidden: string[];
  tab: HistorianTab;
}

export const DEFAULT_STATE: ViewState = {
  sources: [],
  mode: 'operational',
  range: { kind: 'preset', preset: '1h' },
  live: false,
  compare: '',
  layout: 'overlay',
  hidden: [],
  tab: 'trend',
};

function parseTime(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && /^\d{10,}$/.test(v)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Read the page state from the URL. Accepted (v6_contracts Q4/H6): `sources=` (comma tokens), `source_id`+`kind`,
 * legacy `signalId` / `signal_id`; `range` preset or `from`/`to` (ISO); `mode`; `live=1`; `cmp`; `layout`; `hide`; `tab`.
 */
export function stateFromParams(p: URLSearchParams): ViewState {
  const kind = p.get('kind');
  const many = p.get('sources');
  const one = p.get('source_id') || p.get('signalId') || p.get('signal_id');
  const tokens = (many ? many.split(',') : one ? [one] : [])
    .map((t) => normalizeToken(t, many ? null : kind))
    .filter((t): t is string => Boolean(t));
  const sources = Array.from(new Set(tokens)).slice(0, MAX_SERIES);
  const mode = (['operational', 'recorded', 'reconstructed'] as const).find((m) => m === p.get('mode')) || 'operational';
  const from = parseTime(p.get('from'));
  const to = parseTime(p.get('to'));
  let range: RangeState;
  if (from != null && to != null && to > from) range = { kind: 'abs', startMs: from, endMs: Math.min(to, from + MAX_RANGE_MS) };
  else {
    const r = p.get('range');
    // A deep link without a range starts at 15 minutes (plan §8.3); a plain visit at 1 hour.
    range = { kind: 'preset', preset: r && PRESET_MS.has(r) ? r : sources.length ? '15m' : '1h' };
  }
  const cmp = (['prev', '1d', '7d'] as const).find((c) => c === p.get('cmp')) || '';
  const tab = (['trend', 'records', 'events', 'exports'] as const).find((t) => t === p.get('tab')) || 'trend';
  return {
    sources,
    mode,
    range,
    live: p.get('live') === '1' && range.kind === 'preset',
    compare: cmp,
    layout: p.get('layout') === 'lanes' ? 'lanes' : 'overlay',
    hidden: (p.get('hide') || '').split(',').filter((h) => sources.includes(h)),
    tab,
  };
}

export function paramsFromState(s: ViewState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.sources.length) p.set('sources', s.sources.join(','));
  if (s.range.kind === 'preset') p.set('range', s.range.preset);
  else {
    p.set('from', new Date(s.range.startMs).toISOString());
    p.set('to', new Date(s.range.endMs).toISOString());
  }
  p.set('mode', s.mode);
  if (s.live && s.range.kind === 'preset') p.set('live', '1');
  if (s.compare) p.set('cmp', s.compare);
  if (s.layout !== 'overlay') p.set('layout', s.layout);
  const hidden = s.hidden.filter((h) => s.sources.includes(h));
  if (hidden.length) p.set('hide', hidden.join(','));
  if (s.tab !== 'trend') p.set('tab', s.tab);
  return p;
}

export function specFromState(s: ViewState, labels: Record<string, string>): HistorianViewSpec {
  const lab: Record<string, string> = {};
  s.sources.forEach((t) => {
    if (labels[t]) lab[t] = labels[t];
  });
  return {
    v: 1,
    sources: s.sources,
    labels: lab,
    mode: s.mode,
    // Relative ranges stay relative, absolute ranges stay exact (plan §8.3 Saved Views).
    range: s.range.kind === 'preset' ? s.range.preset : null,
    start: s.range.kind === 'abs' ? new Date(s.range.startMs).toISOString() : null,
    end: s.range.kind === 'abs' ? new Date(s.range.endMs).toISOString() : null,
    compare_offset: s.compare || null,
    layout: s.layout,
    hidden: s.hidden,
    tab: s.tab,
  };
}

export function stateFromSpec(spec: HistorianViewSpec): ViewState {
  const p = new URLSearchParams();
  const sources = Array.isArray(spec.sources) ? spec.sources : [];
  if (sources.length) p.set('sources', sources.join(','));
  if (spec.start && spec.end) {
    p.set('from', String(spec.start));
    p.set('to', String(spec.end));
  } else if (spec.range) p.set('range', String(spec.range));
  if (spec.mode) p.set('mode', spec.mode);
  if (spec.compare_offset) p.set('cmp', String(spec.compare_offset));
  if (spec.layout) p.set('layout', String(spec.layout));
  if (Array.isArray(spec.hidden) && spec.hidden.length) p.set('hide', spec.hidden.join(','));
  const st = stateFromParams(p);
  return { ...st, tab: (['trend', 'records', 'events', 'exports'] as const).find((t) => t === spec.tab) || 'trend' };
}

export function resolveRange(r: RangeState, now = Date.now()): { startMs: number; endMs: number } {
  if (r.kind === 'abs') return { startMs: r.startMs, endMs: r.endMs };
  const ms = PRESET_MS.get(r.preset) ?? 3600e3;
  return { startMs: now - ms, endMs: now };
}

export function compareOffsetMs(c: CompareOffset, spanMs: number): number {
  if (c === 'prev') return spanMs;
  if (c === '1d') return 86400e3;
  if (c === '7d') return 7 * 86400e3;
  return 0;
}

/** Poll interval of live follow mode: about 1/100 of the window, between 5 s and 60 s. */
export function liveIntervalMs(spanMs: number): number {
  return Math.min(60e3, Math.max(5e3, Math.round(spanMs / 100 / 5e3) * 5e3));
}

export function rangeLabel(r: RangeState): string {
  if (r.kind === 'preset') return `Last ${r.preset}`;
  return `${formatDateTime(r.startMs)} → ${formatDateTime(r.endMs)}`;
}

// ------------------------------------------------------------------ time formatting (one time zone everywhere)

export const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
})();

export function utcOffsetLabel(at = Date.now()): string {
  const off = -new Date(at).getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export const TZ_LABEL = `${TIME_ZONE} (${utcOffsetLabel()})`;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatDateTime(ms: number, withMs = false): string {
  const d = new Date(ms);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

export function formatClock(ms: number, withMs = false): string {
  const d = new Date(ms);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

/** For `<input type="datetime-local">` (local time, seconds). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime(); // datetime-local without zone = local time
  return Number.isFinite(t) ? t : null;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`;
  return `${Math.floor(s / 86400)} d${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} h` : ''}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------------------ values

export function isDiscreteType(valueType: string | null | undefined): boolean {
  const t = (valueType || '').toLowerCase();
  return t === 'bool' || t === 'boolean' || t === 'string' || t === 'text' || t === 'json' || t === 'enum' || t.includes('char') || t === 'binary';
}

export function isIntegerType(valueType: string | null | undefined): boolean {
  const t = (valueType || '').toLowerCase();
  return /int/.test(t) && !/point/.test(t);
}

export function formatNumber(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  const maxFrac = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : digits;
  return v.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

export function formatValue(v: unknown, unit?: string | null): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return `${formatNumber(v)}${unit ? ` ${unit}` : ''}`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  }
  const s = String(v);
  return `${s.length > 80 ? `${s.slice(0, 77)}…` : s}${unit && s !== '' && !Number.isNaN(Number(s)) ? ` ${unit}` : ''}`;
}

// ------------------------------------------------------------------ normalised series

export interface Pt {
  t: number;
  /** Numeric value used for drawing (null = gap / non-numeric). */
  v: number | null;
  raw: unknown;
  q: string; // upper-case quality, '' when the storage has none
  min?: number | null;
  max?: number | null;
  count?: number;
  kind: string; // RAW_OPERATIONAL | MANAGED_RECORDED | AGGREGATE | MODEL_SAMPLE | ...
  virtual?: boolean;
  sourceTime?: string | null;
  reason?: string | null;
  epoch?: number | null;
  uid?: string | null;
  originalTs?: string | null;
}

export interface QualitySeg {
  startMs: number;
  endMs: number;
  q: 'GOOD' | 'UNCERTAIN' | 'STALE' | 'BAD' | 'GAP';
}

export interface Series {
  token: string;
  label: string;
  resourceName?: string | null;
  unit: string;
  valueType: string;
  color: string;
  discrete: boolean;
  integer: boolean;
  status: HistorianSeriesResult['status'] | 'LOADING';
  fidelity: string;
  total: number;
  downsampled: boolean;
  bucketMs: number | null;
  truncated: boolean;
  notes: string[];
  points: Pt[];
  serverStats: HistorianSeriesResult['stats'] | null;
  compare?: boolean;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export function normalizeSeries(sr: HistorianSeriesResult, color: string, fallbackLabel: string, compare = false): Series {
  const valueType = String(sr.value_type || '');
  const discrete = isDiscreteType(valueType);
  const points: Pt[] = (sr.points || [])
    .map((p) => {
      const t = Date.parse(p.ts);
      return {
        t,
        v: discrete ? null : toNumber(p.value),
        raw: p.value,
        q: String(p.quality || '').toUpperCase(),
        min: p.min ?? null,
        max: p.max ?? null,
        count: p.count,
        kind: String(p.record_kind || ''),
        virtual: !!p.virtual,
        sourceTime: p.source_time || null,
        reason: p.reason_code || null,
        epoch: p.data_epoch ?? null,
        uid: p.event_uid || null,
        originalTs: p.original_ts || null,
      };
    })
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  return {
    token: sr.series_key,
    label: sr.display_name || fallbackLabel,
    resourceName: sr.resource_name,
    unit: String(sr.unit || ''),
    valueType,
    color,
    discrete,
    integer: isIntegerType(valueType),
    status: sr.status,
    fidelity: sr.fidelity,
    total: sr.total ?? points.length,
    downsampled: !!sr.downsampled,
    bucketMs: sr.bucket_ms ?? null,
    truncated: !!sr.truncated,
    notes: sr.coverage_notes || [],
    points,
    serverStats: sr.stats || null,
    compare,
  };
}

/** Index series of a response by token (the backend echoes the token as `series_key`). */
export function indexResponse(res: HistorianQueryResponse | null | undefined): Map<string, HistorianSeriesResult> {
  return new Map((res?.series_list || []).map((s) => [s.series_key, s]));
}

/** Shift every point of a series forward (client-side period compare for servers without `compare`). */
export function shiftSeries(s: Series, offsetMs: number): Series {
  return { ...s, points: s.points.map((p) => ({ ...p, originalTs: new Date(p.t).toISOString(), t: p.t + offsetMs })) };
}

// ------------------------------------------------------------------ gaps, quality, statistics

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Gap threshold for "the source was silent": only meaningful for raw readings (operational) and for
 * downsampled buckets. Change-only recorded data is silent by design, so no gaps are reported there.
 */
export function gapThresholdMs(s: Series, mode: HistorianMode): number | null {
  if (s.serverStats?.gap_threshold_ms) return s.serverStats.gap_threshold_ms;
  if (s.downsampled && s.bucketMs) return s.bucketMs * 2.5;
  if (mode !== 'operational' || s.token.startsWith('mod:') || s.token.startsWith('subtable:')) return null;
  const deltas: number[] = [];
  for (let i = 1; i < s.points.length; i++) deltas.push(s.points[i].t - s.points[i - 1].t);
  const med = median(deltas);
  if (!med) return null;
  return Math.max(12_000, med * 3);
}

export interface Gap {
  startMs: number;
  endMs: number;
}

export function findGaps(s: Series, mode: HistorianMode, startMs: number, endMs: number): Gap[] {
  const th = gapThresholdMs(s, mode);
  if (!th || !s.points.length) return [];
  const out: Gap[] = [];
  const pts = s.points;
  if (pts[0].t - startMs > th) out.push({ startMs, endMs: pts[0].t });
  for (let i = 1; i < pts.length; i++) if (pts[i].t - pts[i - 1].t > th) out.push({ startMs: pts[i - 1].t, endMs: pts[i].t });
  if (endMs - pts[pts.length - 1].t > th && !s.compare) out.push({ startMs: pts[pts.length - 1].t, endMs });
  return out;
}

function normQ(q: string): QualitySeg['q'] {
  if (q === 'GOOD') return 'GOOD';
  if (q === 'UNCERTAIN' || q === 'WARN' || q === 'WARNING' || q === 'DELAYED') return 'UNCERTAIN';
  if (q === 'STALE' || q === 'PAUSED' || q === 'NO_DATA') return 'STALE';
  return 'BAD';
}

/** Quality timeline: each row's quality holds until the next row; silent periods longer than the gap threshold are GAP. */
export function qualitySegments(s: Series, mode: HistorianMode, startMs: number, endMs: number): QualitySeg[] {
  const pts = s.points.filter((p) => p.q);
  if (!pts.length) return [];
  const th = gapThresholdMs(s, mode);
  const segs: QualitySeg[] = [];
  const push = (a: number, b: number, q: QualitySeg['q']) => {
    if (b <= a) return;
    const last = segs[segs.length - 1];
    if (last && last.q === q && Math.abs(last.endMs - a) < 1) last.endMs = b;
    else segs.push({ startMs: a, endMs: b, q });
  };
  for (let i = 0; i < pts.length; i++) {
    const a = Math.max(startMs, pts[i].t);
    const next = i + 1 < pts.length ? pts[i + 1].t : s.compare ? pts[i].t : endMs;
    const b = Math.min(endMs, next);
    const q = normQ(pts[i].q);
    if (th && b - a > th) {
      push(a, a + th, q);
      push(a + th, b, 'GAP');
    } else push(a, b, q);
  }
  return segs;
}

export interface SeriesStats {
  count: number; // rows (or underlying rows when aggregated)
  shown: number; // points drawn
  min: number | null;
  max: number | null;
  avg: number | null;
  first: unknown;
  last: unknown;
  lastTs: number | null;
  goodPct: number | null;
  gaps: number | null;
  longestGapMs: number | null;
  coveragePct: number | null;
  changes: number | null; // value changes (discrete series)
  distinct: number | null;
}

export function computeStats(s: Series, mode: HistorianMode, startMs: number, endMs: number): SeriesStats {
  const pts = s.points.filter((p) => p.t >= startMs - 1 && p.t <= endMs + 1);
  const inWindow = pts.length === s.points.length;
  const nums = pts.filter((p) => p.v != null) as (Pt & { v: number })[];
  let min: number | null = null;
  let max: number | null = null;
  let avg: number | null = null;
  if (nums.length) {
    if (s.downsampled) {
      min = Math.min(...nums.map((p) => (p.min != null ? p.min : p.v)));
      max = Math.max(...nums.map((p) => (p.max != null ? p.max : p.v)));
      const w = nums.reduce((a, p) => a + (p.count || 1), 0);
      avg = nums.reduce((a, p) => a + p.v * (p.count || 1), 0) / (w || 1);
    } else {
      min = Infinity;
      max = -Infinity;
      let sum = 0;
      for (const p of nums) {
        if (p.v < min) min = p.v;
        if (p.v > max) max = p.v;
        sum += p.v;
      }
      avg = sum / nums.length;
    }
  }
  const withQ = pts.filter((p) => p.q);
  const goodPct = withQ.length && !s.downsampled ? (withQ.filter((p) => p.q === 'GOOD').length / withQ.length) * 100 : s.serverStats?.good_pct ?? null;
  const th = gapThresholdMs(s, mode);
  let gaps: number | null = null;
  let longest: number | null = null;
  let coverage: number | null = null;
  if (s.serverStats?.gap_count != null && !s.compare && inWindow) {
    gaps = s.serverStats.gap_count;
    longest = s.serverStats.longest_gap_ms ?? null;
    coverage = s.serverStats.coverage_pct ?? null;
  } else if (th) {
    const g = findGaps({ ...s, points: pts }, mode, startMs, endMs);
    gaps = g.length;
    longest = g.reduce((a, x) => Math.max(a, x.endMs - x.startMs), 0) || null;
    const silent = g.reduce((a, x) => a + (x.endMs - x.startMs), 0);
    coverage = Math.max(0, Math.min(100, 100 - (silent / Math.max(1, endMs - startMs)) * 100));
  }
  let changes: number | null = null;
  let distinct: number | null = null;
  if (s.discrete || s.integer) {
    const vals = pts.map((p) => JSON.stringify(p.raw));
    distinct = new Set(vals).size;
    changes = vals.reduce((a, v, i) => a + (i > 0 && v !== vals[i - 1] ? 1 : 0), 0);
  }
  const count = s.downsampled ? pts.reduce((a, p) => a + (p.count || 0), 0) || s.total : inWindow ? s.total || pts.length : pts.length;
  return {
    count,
    shown: pts.length,
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
    avg,
    first: pts.length ? pts[0].raw : null,
    last: pts.length ? pts[pts.length - 1].raw : null,
    lastTs: pts.length ? pts[pts.length - 1].t : null,
    goodPct,
    gaps,
    longestGapMs: longest,
    coveragePct: coverage,
    changes,
    distinct,
  };
}

/** Value of a series at time t (step: last point at or before t; nearest for raw lines within half a step). */
export function valueAt(s: Series, t: number, step: boolean): Pt | null {
  const pts = s.points;
  if (!pts.length) return null;
  let lo = 0;
  let hi = pts.length - 1;
  if (t < pts[0].t) return step ? null : Math.abs(pts[0].t - t) < 0.02 * Math.max(1, pts[pts.length - 1].t - pts[0].t) ? pts[0] : null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  if (step) return pts[lo];
  const next = pts[lo + 1];
  return next && next.t - t < t - pts[lo].t ? next : pts[lo];
}

// ------------------------------------------------------------------ misc

export function shortLabel(label: string): { machine: string; name: string } {
  const parts = label.split(' · ');
  if (parts.length >= 2) return { machine: parts[0], name: parts.slice(1).join(' · ') };
  return { machine: '', name: label };
}

export function statusText(status: Series['status']): string | null {
  switch (status) {
    case 'NO_DATA':
      return 'No data in this window';
    case 'NOT_FOUND':
      return 'Source not found (deleted or renamed?)';
    case 'UNAVAILABLE':
      return 'History storage unavailable';
    case 'ERROR':
      return 'Query failed';
    case 'NO_TABLE':
      return 'Not recorded yet';
    case 'NO_VALUE_COLUMN':
      return 'Table has no value column';
    default:
      return null;
  }
}

export function safeFilePart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'series';
}
