/**
 * Shared building blocks for widget bodies (no ECharts here, so value/table/content widgets stay light).
 *
 * - Option readers: `props.options` is merged with registry defaults but may still carry a wrong type
 *   (legacy drafts, imports). Every reader falls back to the default on a wrong type or out-of-range value.
 * - Data-state presentation: the state always comes from the server verdict (`latest.state`), never from
 *   timestamps; `unknown` is shown as unknown, never as good. Degraded states (stale/bad/no data) are dimmed.
 * - Sizing: `fontScale()` combines the dashboard `font_scale` with the body box so text shrinks in small boxes.
 */
import React, { useEffect, useState } from 'react';
import type { DataState, Mapping, SeriesData, ThemeTokens, Threshold } from '../types';
import { formatAge, isNumber, STATE_LABEL, stateColor } from '../format';

// ------------------------------------------------------------------------------------------ options

type Opts = Record<string, unknown>;

export function optBool(o: Opts, key: string, def: boolean): boolean {
  const v = o[key];
  return typeof v === 'boolean' ? v : def;
}

export function optNum(o: Opts, key: string, def: number, min = -Infinity, max = Infinity): number {
  const v = o[key];
  if (!isNumber(v) || v < min || v > max) return def;
  return v;
}

export function optInt(o: Opts, key: string, def: number, min = -Infinity, max = Infinity): number {
  const v = optNum(o, key, def, min, max);
  return Number.isInteger(v) ? v : def;
}

/** Nullable numeric option (`null`, missing or wrong type → null). */
export function optNumOrNull(o: Opts, key: string): number | null {
  const v = o[key];
  return isNumber(v) ? v : null;
}

export function optStr(o: Opts, key: string, def: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : def;
}

export function optEnum<T extends string>(o: Opts, key: string, choices: readonly T[], def: T): T {
  const v = o[key];
  return typeof v === 'string' && (choices as readonly string[]).includes(v) ? (v as T) : def;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

export function optColor(o: Opts, key: string): string | null {
  const v = o[key];
  return isHexColor(v) ? v : null;
}

/** Valid thresholds sorted ascending by value. */
export function optThresholds(o: Opts, key = 'thresholds'): Threshold[] {
  const v = o[key];
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is Threshold => !!t && typeof t === 'object' && isNumber((t as Threshold).value) && isHexColor((t as Threshold).color))
    .map((t) => ({ value: t.value, color: t.color, label: typeof t.label === 'string' ? t.label : '' }))
    .sort((a, b) => a.value - b.value);
}

export function optMappings(o: Opts, key = 'mappings'): Mapping[] {
  const v = o[key];
  if (!Array.isArray(v)) return [];
  const out: Mapping[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object' || !isHexColor((m as Mapping).color)) continue;
    const label = typeof (m as Mapping).label === 'string' ? (m as Mapping).label : '';
    if ((m as Mapping).kind === 'value' && typeof (m as { value: unknown }).value === 'string') {
      out.push({ kind: 'value', value: (m as { value: string }).value, label, color: (m as Mapping).color });
    } else if ((m as Mapping).kind === 'range') {
      const r = m as { from: unknown; to: unknown };
      out.push({
        kind: 'range',
        from: isNumber(r.from) ? r.from : null,
        to: isNumber(r.to) ? r.to : null,
        label,
        color: (m as Mapping).color,
      });
    }
  }
  return out;
}

/** `decimals` common option: integer 0..8, anything else → auto (null). */
export function decimalsOf(o: Opts): number | null {
  const v = o.decimals;
  return isNumber(v) && Number.isInteger(v) && v >= 0 && v <= 8 ? v : null;
}

export function accentOf(o: Opts, theme: ThemeTokens): string {
  return optColor(o, 'accent_color') ?? theme.accent;
}

// ------------------------------------------------------------------------------------------ colors

export function hexAlpha(color: string, alpha: number): string {
  if (!isHexColor(color)) return color;
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function luminance(color: string): number {
  if (!isHexColor(color)) return 1;
  const n = parseInt(color.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Text color with enough contrast on a solid background. */
export function readableOn(bg: string): string {
  return luminance(bg) > 0.45 ? '#111B37' : '#FFFFFF';
}

export function seriesColor(s: SeriesData, index: number, theme: ThemeTokens): string {
  if (isHexColor(s.color)) return s.color;
  if (isHexColor(s.binding?.color)) return s.binding.color as string;
  const p = theme.palette?.length ? theme.palette : [theme.accent];
  return p[index % p.length];
}

export function neutralColor(theme: ThemeTokens): string {
  return theme.stale || theme.text_muted;
}

// ------------------------------------------------------------------------------------------ sizing

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Font multiplier from the dashboard font scale and the body box (shrinks in small boxes). */
export function fontScale(size: { width: number; height: number }, theme: ThemeTokens): number {
  const fs = isNumber(theme.font_scale) ? clamp(theme.font_scale, 0.8, 1.4) : 1;
  const box = clamp(Math.min(size.width / 240, size.height / 110), 0.78, 1.1);
  return fs * box;
}

export const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace";
export const TABULAR: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };

// ------------------------------------------------------------------------------------------ state

/** Display state of a series' latest value (no latest → no data; never assumed good). */
export function latestState(s: SeriesData | undefined | null): DataState {
  if (!s) return 'no_data';
  if (s.error) return 'bad';
  return s.latest?.state ?? 'no_data';
}

/** Stale / bad / no data: the value must not look healthy. */
export function isDegraded(state: DataState): boolean {
  return state === 'stale' || state === 'bad' || state === 'no_data';
}

export function stateText(state: DataState, ts: number | null | undefined, now: number): string {
  const label = state === 'unknown' ? 'Quality unknown' : STATE_LABEL[state];
  if ((state === 'stale' || state === 'delayed' || state === 'bad') && ts) return `${label} · ${formatAge(ts, now)}`;
  return label;
}

/** Re-render periodically so relative ages ("3m ago") keep moving without new data. */
export function useNow(intervalMs = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function StateDot({ state, theme, size = 7, title }: { state: DataState; theme: ThemeTokens; size?: number; title?: string }) {
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: stateColor(state, theme),
        boxShadow: state === 'unknown' ? `inset 0 0 0 1.5px ${theme.text_muted}` : undefined,
        ...(state === 'unknown' ? { background: 'transparent' } : null),
      }}
    />
  );
}

/**
 * Small quality badge: dot + "Stale · 3m ago". Hidden for `good` unless `always`.
 */
export function QualityBadge({
  state,
  ts,
  theme,
  fontSize = 11,
  always = false,
  now,
  style,
}: {
  state: DataState;
  ts?: number | null;
  theme: ThemeTokens;
  fontSize?: number;
  always?: boolean;
  now: number;
  style?: React.CSSProperties;
}) {
  if (state === 'good' && !always) return null;
  const color = state === 'good' ? theme.good : state === 'unknown' || state === 'no_data' ? theme.text_muted : stateColor(state, theme);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize,
        lineHeight: 1.2,
        fontWeight: 500,
        color,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
        ...style,
      }}
      title={stateText(state, ts, now)}
    >
      <StateDot state={state} theme={theme} size={Math.max(5, Math.round(fontSize * 0.6))} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{stateText(state, ts, now)}</span>
    </span>
  );
}

/** Centered message inside the body (no data, invalid config …). Edit mode may add a hint. */
export function BodyMessage({
  theme,
  text,
  hint,
  icon,
  fontSize = 12,
  tone = 'muted',
}: {
  theme: ThemeTokens;
  text: string;
  hint?: string | null;
  icon?: React.ReactNode;
  fontSize?: number;
  tone?: 'muted' | 'warning' | 'bad';
}) {
  const color = tone === 'bad' ? theme.bad : tone === 'warning' ? theme.warning : theme.text_muted;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: 6,
        textAlign: 'center',
        overflow: 'hidden',
        color,
        fontSize,
        lineHeight: 1.35,
      }}
    >
      {icon}
      <div style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</div>
      {hint ? <div style={{ fontSize: Math.max(10, fontSize - 1), color: theme.text_muted, opacity: 0.85 }}>{hint}</div> : null}
    </div>
  );
}

/** One discreet line under charts (fidelity, truncation, notes). Full text in the tooltip. */
export function Footnote({ theme, items, fontSize = 10.5, height }: { theme: ThemeTokens; items: string[]; fontSize?: number; height: number }) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  const text = list.join(' · ');
  return (
    <div
      title={list.join('\n')}
      style={{
        height,
        lineHeight: `${height}px`,
        fontSize,
        color: theme.text_muted,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: '0 0 auto',
        padding: '0 2px',
      }}
    >
      {text}
    </div>
  );
}

export const FOOTNOTE_H = 16;

/** Placeholder shown while a lazily-loaded chart module arrives. */
export function ChartPlaceholder({ theme, size }: { theme: ThemeTokens; size: { width: number; height: number } }) {
  ensureWidgetStyles();
  return (
    <div style={{ width: size.width, height: size.height, padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="fx-w-skeleton" style={{ flex: 1, borderRadius: 8, background: theme.surface_alt }} />
      <div className="fx-w-skeleton" style={{ height: 10, width: '40%', borderRadius: 4, background: theme.surface_alt }} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------ CSS

let stylesInjected = false;
/** Keyframes used by widgets (blink, skeleton). Injected once; disabled under prefers-reduced-motion. */
export function ensureWidgetStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.setAttribute('data-fx-widgets', '');
  el.textContent = `
@keyframes fx-w-blink { 0%, 100% { opacity: 1 } 50% { opacity: 0.25 } }
@keyframes fx-w-pulse { 0%, 100% { opacity: 0.55 } 50% { opacity: 1 } }
.fx-w-blink { animation: fx-w-blink 1.6s ease-in-out infinite; }
.fx-w-skeleton { animation: fx-w-pulse 1.4s ease-in-out infinite; }
.fx-w-table tbody tr:hover td { background: var(--fx-w-hover); }
.fx-w-link:focus-visible { outline: 2px solid var(--fx-w-focus); outline-offset: 2px; }
.fx-w-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.fx-w-scroll::-webkit-scrollbar-thumb { background: var(--fx-w-thumb, #D4DFEC); border-radius: 4px; }
@media (prefers-reduced-motion: reduce) { .fx-w-blink, .fx-w-skeleton { animation: none; } }
`;
  document.head.appendChild(el);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
