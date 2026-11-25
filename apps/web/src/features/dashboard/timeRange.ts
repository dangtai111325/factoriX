/** Time ranges and refresh policies of the document (contract §1), URL encoding and display. */
import type { RefreshPolicy, RelativeRange, TimeRange } from './types';

export const RELATIVE_RANGES: Array<{ id: RelativeRange; label: string; ms: number }> = [
  { id: '5m', label: 'Last 5 minutes', ms: 5 * 60e3 },
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60e3 },
  { id: '30m', label: 'Last 30 minutes', ms: 30 * 60e3 },
  { id: '1h', label: 'Last 1 hour', ms: 3600e3 },
  { id: '3h', label: 'Last 3 hours', ms: 3 * 3600e3 },
  { id: '6h', label: 'Last 6 hours', ms: 6 * 3600e3 },
  { id: '12h', label: 'Last 12 hours', ms: 12 * 3600e3 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3600e3 },
  { id: '2d', label: 'Last 2 days', ms: 2 * 86400e3 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86400e3 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86400e3 },
];
const REL_MS = new Map(RELATIVE_RANGES.map((r) => [r.id, r.ms]));
export const MAX_RANGE_MS = 366 * 86400e3;

export function isRelativeRange(v: unknown): v is RelativeRange {
  return typeof v === 'string' && REL_MS.has(v as RelativeRange);
}

export const REFRESH_OPTIONS: Array<{ id: RefreshPolicy; label: string; ms: number | null }> = [
  { id: 'live', label: 'Live', ms: 60e3 },
  { id: '10s', label: 'Every 10 s', ms: 10e3 },
  { id: '30s', label: 'Every 30 s', ms: 30e3 },
  { id: '1m', label: 'Every 1 min', ms: 60e3 },
  { id: '5m', label: 'Every 5 min', ms: 300e3 },
  { id: 'off', label: 'Off', ms: null },
];

export function isRefreshPolicy(v: unknown): v is RefreshPolicy {
  return REFRESH_OPTIONS.some((o) => o.id === v);
}

/** History re-query period of a refresh policy (live = 60 s plus live append; off = only on change). */
export function refreshMs(p: RefreshPolicy): number | null {
  return REFRESH_OPTIONS.find((o) => o.id === p)?.ms ?? null;
}

export function resolveTimeRange(r: TimeRange, now = Date.now()): { start: number; end: number } {
  if (r.kind === 'absolute') {
    const s = Date.parse(r.start);
    const e = Date.parse(r.end);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) return { start: s, end: Math.min(e, s + MAX_RANGE_MS) };
    return { start: now - 3600e3, end: now };
  }
  const ms = REL_MS.get(r.last) ?? 3600e3;
  return { start: now - ms, end: now };
}

/** Stable identity of a range (relative ranges do not change identity as time passes). */
export function rangeKey(r: TimeRange): string {
  return r.kind === 'relative' ? `rel:${r.last}` : `abs:${r.start}|${r.end}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function formatShortDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function rangeLabel(r: TimeRange): string {
  if (r.kind === 'relative') return RELATIVE_RANGES.find((x) => x.id === r.last)?.label || `Last ${r.last}`;
  const s = Date.parse(r.start);
  const e = Date.parse(r.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 'Custom range';
  return `${formatShortDateTime(s)} → ${formatShortDateTime(e)}`;
}

export function rangeShortLabel(r: TimeRange): string {
  if (r.kind === 'relative') return `Last ${r.last}`;
  return 'Custom';
}

/** `<input type="datetime-local">` helpers (local time, minutes). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Validate an absolute range: start < end, ≤ 366 days. Returns an error message or null. */
export function absoluteRangeError(startMs: number | null, endMs: number | null): string | null {
  if (startMs == null || endMs == null) return 'Enter a start and an end.';
  if (endMs <= startMs) return 'The end must be after the start.';
  if (endMs - startMs > MAX_RANGE_MS) return 'The window is limited to 366 days.';
  return null;
}

/** `?range=1h` or `?from=<ISO>&to=<ISO>`; anything invalid yields null (the document default applies). */
export function rangeFromParams(p: URLSearchParams): TimeRange | null {
  const range = p.get('range');
  if (range && isRelativeRange(range)) return { kind: 'relative', last: range };
  const from = p.get('from');
  const to = p.get('to');
  if (from && to) {
    const s = Date.parse(from);
    const e = Date.parse(to);
    if (Number.isFinite(s) && Number.isFinite(e) && absoluteRangeError(s, e) === null) {
      return { kind: 'absolute', start: new Date(s).toISOString(), end: new Date(e).toISOString() };
    }
  }
  return null;
}

export function writeRangeParams(p: URLSearchParams, r: TimeRange | null): void {
  p.delete('range');
  p.delete('from');
  p.delete('to');
  if (!r) return;
  if (r.kind === 'relative') p.set('range', r.last);
  else {
    p.set('from', r.start);
    p.set('to', r.end);
  }
}

export function sameRange(a: TimeRange | null | undefined, b: TimeRange | null | undefined): boolean {
  if (!a || !b) return a === b;
  return rangeKey(a) === rangeKey(b);
}
