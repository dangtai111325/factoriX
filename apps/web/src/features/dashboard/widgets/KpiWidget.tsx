/**
 * KPI / stat card body.
 *
 * - `value_mode` latest shows `latest.value` (server verdict state); other modes reduce the bounded history
 *   with `format.reduce` and label the mode ("Avg · 1h"), noting downsampled/truncated history.
 * - null/undefined shows `null_text` (never 0); NaN/Infinity are not displayable. Booleans and strings are
 *   shown as text, never averaged; a numeric mode over non-numeric data shows `null_text` with a note.
 * - `color_mode`: value (text colored by thresholds, base = accent_color or text), background (body tile
 *   filled with the threshold/accent color), none. Stale/bad/no-data values are dimmed and never take a
 *   threshold color; with `show_quality` a badge says e.g. "Stale · 3m ago".
 * - prefix/suffix/show_unit/compact/decimals/font_size/icon/sparkline (gaps are not joined).
 */
import React, { useId } from 'react';
import { Activity, Cpu, Droplet, Factory, Fan, Gauge, Thermometer, Zap, type LucideIcon } from 'lucide-react';
import type { WidgetRendererProps } from '../types';
import { formatValue, isNumber, thresholdColor, thresholdLabel, type ValueMode } from '../format';
import { modeValue, numericPoints, unitOf, VALUE_MODES, withGaps } from './data';
import {
  BodyMessage,
  clamp,
  decimalsOf,
  fontScale,
  hexAlpha,
  isDegraded,
  optBool,
  optColor,
  optEnum,
  optStr,
  optThresholds,
  QualityBadge,
  readableOn,
  StateDot,
  stateText,
  TABULAR,
  useNow,
} from './shared';

const ICONS: Record<string, LucideIcon | null> = {
  none: null,
  activity: Activity,
  gauge: Gauge,
  thermometer: Thermometer,
  zap: Zap,
  droplet: Droplet,
  fan: Fan,
  cpu: Cpu,
  factory: Factory,
};

const SIZE_FACTOR = { sm: 0.36, md: 0.48, lg: 0.6, xl: 0.76 } as const;

export function KpiWidget({ options: o, data, theme, size, mode, timeRange }: WidgetRendererProps) {
  const now = useNow();
  const s = data.series[0];
  const valueMode = optEnum<ValueMode>(o, 'value_mode', VALUE_MODES, 'latest');
  const prefix = optStr(o, 'prefix', '');
  const suffix = optStr(o, 'suffix', '');
  const showUnit = optBool(o, 'show_unit', true);
  const compact = optBool(o, 'compact', false);
  const sparkline = optBool(o, 'sparkline', false);
  const colorMode = optEnum(o, 'color_mode', ['value', 'background', 'none'] as const, 'value');
  const fontSize = optEnum(o, 'font_size', ['sm', 'md', 'lg', 'xl'] as const, 'lg');
  const iconKey = optStr(o, 'icon', 'none');
  const nullText = optStr(o, 'null_text', '—') || '—';
  const thresholds = optThresholds(o);
  const decimals = decimalsOf(o);
  const showQuality = optBool(o, 'show_quality', true);
  const accentOpt = optColor(o, 'accent_color');

  if (!s) return <BodyMessage theme={theme} text="No source" hint={mode === 'edit' ? 'Bind a signal or model field' : null} />;

  const mv = modeValue(s, valueMode, timeRange);
  const v = mv.value;
  const degraded = isDegraded(mv.state);
  const unit = unitOf(s);
  const numeric = isNumber(v);

  let body: string;
  if (v === null || v === undefined) body = nullText;
  else {
    body = formatValue(v, { decimals, compact, showUnit: false, nullText });
    if (numeric && valueMode === 'delta' && v > 0) body = `+${body}`;
  }
  const hasValue = v !== null && v !== undefined;
  const text = hasValue ? `${prefix}${body}${suffix}` : body;
  const unitText = hasValue && numeric && showUnit && unit ? unit : '';

  const fs = fontScale(size, theme);
  const W = size.width;
  const H = size.height;
  const tiny = H < 56 || W < 110;
  const Icon = ICONS[iconKey] ?? null;

  // colors
  const base = accentOpt ?? theme.text;
  const thrColor = numeric ? thresholdColor(v, thresholds, colorMode === 'background' ? accentOpt ?? theme.accent : base) : colorMode === 'background' ? accentOpt ?? theme.accent : base;
  const thrName = numeric ? thresholdLabel(v, thresholds) : null;
  let valueColor = colorMode === 'none' ? theme.text : thrColor;
  let tileBg: string | null = null;
  if (colorMode === 'background') {
    tileBg = degraded || !hasValue ? theme.surface_alt : thrColor;
    valueColor = degraded || !hasValue ? theme.text_muted : readableOn(thrColor);
  }
  if (degraded || !hasValue) valueColor = tileBg ? valueColor : theme.text_muted;
  const subColor = tileBg && !degraded && hasValue ? hexAlpha(readableOn(thrColor) === '#FFFFFF' ? '#FFFFFF' : '#111B37', 0.78) : theme.text_muted;

  // layout
  const spark = sparkline && H >= 84 && W >= 120 ? numericPoints(s.history?.points) : null;
  const sparkH = spark && spark.length > 1 ? Math.round(clamp(H * 0.26, 18, 64)) : 0;
  const showMeta = !tiny;
  const metaH = showMeta ? Math.round(16 * fs) : 0;
  const avail = H - sparkH - metaH * (mv.modeLabel ? 2 : 1) - 8;
  const iconSize = Icon ? Math.round(clamp(avail * 0.45, 14, 44)) : 0;
  const chars = Math.max(1, text.length + (unitText ? unitText.length * 0.55 + 0.4 : 0));
  const widthFit = (W - 16 - (Icon ? iconSize + 10 : 0)) / (chars * 0.64);
  const valuePx = Math.round(clamp(Math.min(avail * SIZE_FACTOR[fontSize], widthFit, 96 * fs), 11, 120));

  const badge = showQuality && showMeta ? (
    <QualityBadge state={mv.state} ts={mv.ts} theme={theme} now={now} fontSize={Math.round(11 * fs)} style={tileBg && !degraded ? { color: subColor } : undefined} />
  ) : null;

  const noteText = mv.notes.join(' · ');
  return (
    <div
      title={[thrName, noteText].filter(Boolean).join(' · ') || undefined}
      style={{
        width: W,
        height: H,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: tileBg ? Math.max(4, theme.radius - 4) : 0,
        background: tileBg ?? 'transparent',
        transition: 'background-color 200ms ease',
        padding: tileBg ? '4px 8px' : 0,
      }}
    >
      {mv.modeLabel && showMeta ? (
        <div style={{ height: metaH, fontSize: Math.round(11 * fs), color: subColor, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {mv.modeLabel}
          {mv.notes.length ? <span style={{ opacity: 0.8 }}> · {mv.notes[0]}</span> : null}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        {Icon ? <Icon size={iconSize} strokeWidth={1.75} color={tileBg && !degraded ? valueColor : hexAlpha(accentOpt ?? theme.accent, degraded ? 0.4 : 0.9)} style={{ flex: '0 0 auto' }} /> : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: Math.round(valuePx * 0.12),
            minWidth: 0,
            color: valueColor,
            opacity: degraded ? 0.62 : 1,
            fontWeight: 650,
            letterSpacing: valuePx > 28 ? '-0.02em' : 0,
            lineHeight: 1.05,
            whiteSpace: 'nowrap',
            ...TABULAR,
          }}
        >
          <span style={{ fontSize: valuePx, overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
          {unitText ? <span style={{ fontSize: Math.max(10, Math.round(valuePx * 0.42)), fontWeight: 500, color: tileBg ? valueColor : theme.text_muted }}>{unitText}</span> : null}
        </div>
        {tiny && showQuality && mv.state !== 'good' ? <StateDot state={mv.state} theme={theme} size={7} title={stateText(mv.state, mv.ts, now)} /> : null}
      </div>
      {showMeta ? (
        <div style={{ height: metaH, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {badge}
          {thrName && !degraded && !badge ? <span style={{ fontSize: Math.round(11 * fs), color: subColor, whiteSpace: 'nowrap' }}>{thrName}</span> : null}
        </div>
      ) : null}
      {sparkH && spark ? (
        <Sparkline
          points={spark}
          bucket={s.history?.bucket_ms ?? null}
          range={timeRange}
          width={W - (tileBg ? 16 : 0)}
          height={sparkH}
          color={degraded ? theme.stale : tileBg ? valueColor : thresholds.length && numeric ? thrColor : accentOpt ?? theme.accent}
        />
      ) : null}
    </div>
  );
}

function Sparkline({
  points,
  bucket,
  range,
  width,
  height,
  color,
}: {
  points: ReturnType<typeof numericPoints>;
  bucket: number | null;
  range: { start: number; end: number };
  width: number;
  height: number;
  color: string;
}) {
  const id = `spk${useId().replace(/:/g, '')}`;
  const { data } = withGaps(points, bucket);
  const vals = data.map((d) => d[1]).filter(isNumber);
  if (vals.length < 2) return <div style={{ height }} />;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  const t0 = Math.min(range.start, data[0][0]);
  const t1 = Math.max(range.end, data[data.length - 1][0]);
  const tx = (t: number) => ((t - t0) / (t1 - t0 || 1)) * (width - 2) + 1;
  const ty = (v: number) => height - 2 - ((v - (hi === lo ? lo - span / 2 : lo)) / span) * (height - 4);
  const runs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  for (const [t, v] of data) {
    if (v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push([tx(t), ty(v)]);
  }
  if (cur.length) runs.push(cur);
  return (
    <svg width={width} height={height} style={{ display: 'block', flex: '0 0 auto' }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {runs.map((r, i) =>
        r.length === 1 ? (
          <circle key={i} cx={r[0][0]} cy={r[0][1]} r={1.5} fill={color} />
        ) : (
          <g key={i}>
            <path d={`M${r[0][0]},${height} ${r.map((p) => `L${p[0]},${p[1]}`).join(' ')} L${r[r.length - 1][0]},${height} Z`} fill={`url(#${id})`} />
            <path d={`M${r.map((p) => `${p[0]},${p[1]}`).join(' L')}`} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ),
      )}
    </svg>
  );
}
