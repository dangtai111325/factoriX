/**
 * Gauge body (SVG, no ECharts): radial (270°), semicircle, horizontal bar, vertical bar.
 *
 * - Numbers only: a boolean/string latest value is reported as "Not numeric", never coerced.
 * - Values outside [min, max] are NOT silently clamped: the fill stops at the end of the track and an
 *   overflow indicator (▲ above max / ▼ below min) is shown together with the real value.
 * - Fill color = thresholds over the value (base = accent_color/theme accent); thresholds are also drawn as
 *   a band along the track. `target` draws a marker. `show_ticks` draws major ticks + labels.
 * - Stale/bad/no data: fill is neutral and the value dimmed; `show_quality` adds a state badge.
 * - min ≥ max is an invalid configuration and is explained instead of drawing a misleading gauge.
 */
import React from 'react';
import type { Threshold, WidgetRendererProps } from '../types';
import { formatNumber, formatValue, isNumber, thresholdColor } from '../format';
import { unitOf } from './data';
import {
  accentOf,
  BodyMessage,
  clamp,
  decimalsOf,
  fontScale,
  isDegraded,
  latestState,
  optBool,
  optEnum,
  optNum,
  optNumOrNull,
  optThresholds,
  QualityBadge,
  TABULAR,
  useNow,
} from './shared';

type Variant = 'radial' | 'semicircle' | 'horizontal' | 'vertical';

function pt(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

/** Clockwise arc from angle `from` down to angle `to` (math degrees, from > to). */
function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  if (from - to < 0.01) return '';
  const [x0, y0] = pt(cx, cy, r, from);
  const [x1, y1] = pt(cx, cy, r, to);
  const large = from - to > 180 ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

function ticks(min: number, max: number, n = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(min + ((max - min) * i) / n);
  return out;
}

/** Threshold bands as [from, to, color] inside [min, max]. */
function bands(thresholds: Threshold[], min: number, max: number): Array<[number, number, string]> {
  const list = thresholds.filter((t) => t.value < max);
  const out: Array<[number, number, string]> = [];
  list.forEach((t, i) => {
    const from = Math.max(min, t.value);
    const to = i + 1 < list.length ? Math.min(max, list[i + 1].value) : max;
    if (to > from) out.push([from, to, t.color]);
  });
  return out;
}

export function GaugeWidget({ options: o, data, theme, size, mode }: WidgetRendererProps) {
  const now = useNow();
  const s = data.series[0];
  const variant = optEnum<Variant>(o, 'variant', ['radial', 'semicircle', 'horizontal', 'vertical'], 'radial');
  const min = optNum(o, 'min', 0);
  const max = optNum(o, 'max', 100);
  const target = optNumOrNull(o, 'target');
  const showValue = optBool(o, 'show_value', true);
  const showTicks = optBool(o, 'show_ticks', true);
  const showQuality = optBool(o, 'show_quality', true);
  const thresholds = optThresholds(o);
  const decimals = decimalsOf(o);
  const accent = accentOf(o, theme);
  const fs = fontScale(size, theme);

  if (!s) return <BodyMessage theme={theme} text="No source" hint={mode === 'edit' ? 'Bind a numeric signal or model field' : null} />;
  if (!(max > min)) return <BodyMessage theme={theme} tone="warning" text="Invalid range" hint="Max must be greater than min" fontSize={12 * fs} />;

  const raw = s.latest?.value;
  const state = latestState(s);
  const unit = unitOf(s);
  const hasValue = raw !== null && raw !== undefined && !(typeof raw === 'number' && !Number.isFinite(raw));
  const notNumeric = hasValue && !isNumber(raw);
  const v = isNumber(raw) ? raw : null;
  const degraded = isDegraded(state) || v === null;
  const over = v !== null && v > max;
  const under = v !== null && v < min;
  const frac = v === null ? 0 : clamp((v - min) / (max - min), 0, 1);
  const fill = degraded ? theme.stale : thresholdColor(v, thresholds, accent);
  const valueText = notNumeric ? String(raw) : formatValue(v, { decimals, showUnit: false });
  const overflow = over ? `▲ Above max ${formatNumber(max, decimals)}` : under ? `▼ Below min ${formatNumber(min, decimals)}` : null;
  const tickFmt = (t: number) => formatNumber(t, decimals ?? (Math.abs(max - min) >= 10 ? 0 : Math.abs(max - min) >= 1 ? 1 : 2), Math.abs(max) >= 10000);

  const track = theme.dark ? 'rgba(148,163,184,0.18)' : 'rgba(100,116,139,0.13)';
  const valueBlock = (px: number, align: 'center' | 'left' = 'center') => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'center' ? 'center' : 'flex-start', gap: 2, minWidth: 0, maxWidth: '100%' }}>
      {showValue ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, color: degraded ? theme.text_muted : theme.text, opacity: degraded && hasValue ? 0.65 : 1, fontWeight: 650, lineHeight: 1.05, whiteSpace: 'nowrap', ...TABULAR }}>
          <span style={{ fontSize: px }}>{valueText}</span>
          {unit && v !== null ? <span style={{ fontSize: Math.max(10, px * 0.45), fontWeight: 500, color: theme.text_muted }}>{unit}</span> : null}
        </div>
      ) : null}
      {notNumeric ? <div style={{ fontSize: 11 * fs, color: theme.warning }}>Not numeric</div> : null}
      {overflow ? <div style={{ fontSize: Math.max(10, 11 * fs), fontWeight: 600, color: theme.warning, whiteSpace: 'nowrap' }}>{overflow}</div> : null}
      {showQuality && px > 13 ? <QualityBadge state={state} ts={s.latest?.ts} theme={theme} now={now} fontSize={Math.max(10, Math.round(10.5 * fs))} /> : null}
    </div>
  );

  const W = size.width;
  const H = size.height;

  if (variant === 'horizontal' || variant === 'vertical') {
    const horizontal = variant === 'horizontal';
    const bandList = bands(thresholds, min, max);
    if (horizontal) {
      const th = Math.round(clamp(H * 0.16, 8, 24));
      const labelH = showTicks && H > 70 ? 14 * fs : 0;
      const valuePx = clamp(Math.min(H * 0.28, W / 7), 13, 40 * fs);
      const x0 = 4;
      const x1 = W - 4;
      const tx = (val: number) => x0 + ((clamp(val, min, max) - min) / (max - min)) * (x1 - x0);
      return (
        <div style={{ width: W, height: H, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, overflow: 'hidden' }}>
          {valueBlock(valuePx, 'left')}
          <svg width={W} height={th + 6 + labelH} style={{ display: 'block', overflow: 'visible' }} aria-hidden>
            <rect x={x0} y={0} width={x1 - x0} height={th} rx={th / 2} fill={track} />
            {frac > 0 ? <rect x={x0} y={0} width={Math.max(th, (x1 - x0) * frac)} height={th} rx={th / 2} fill={fill} /> : null}
            {over ? <path d={`M${x1 - 1},${th / 2 - 5} l6,5 l-6,5 z`} fill={theme.warning} /> : null}
            {under ? <path d={`M${x0 + 1},${th / 2 - 5} l-6,5 l6,5 z`} fill={theme.warning} /> : null}
            {bandList.map(([a, b, c], i) => (
              <rect key={i} x={tx(a)} y={th + 2} width={Math.max(1, tx(b) - tx(a))} height={3} fill={c} rx={1} />
            ))}
            {target !== null && target >= min && target <= max ? <line x1={tx(target)} x2={tx(target)} y1={-3} y2={th + 3} stroke={theme.text} strokeWidth={2} /> : null}
            {labelH
              ? ticks(min, max, W > 260 ? 5 : 2).map((t, i, all) => (
                  <text key={i} x={tx(t)} y={th + 6 + labelH - 2} fontSize={10 * fs} fill={theme.text_muted} textAnchor={i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'} style={TABULAR}>
                    {tickFmt(t)}
                  </text>
                ))
              : null}
          </svg>
        </div>
      );
    }
    // vertical
    const tw = Math.round(clamp(W * 0.12, 10, 28));
    const valuePx = clamp(Math.min(W / 6, H * 0.14), 13, 34 * fs);
    const top = 6;
    const barH = Math.max(20, H - 12);
    const ty = (val: number) => top + barH - ((clamp(val, min, max) - min) / (max - min)) * barH;
    const labelW = showTicks ? 40 * fs : 0;
    const svgW = tw + 10 + labelW;
    return (
      <div style={{ width: W, height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, overflow: 'hidden' }}>
        <svg width={svgW} height={H} style={{ display: 'block', flex: '0 0 auto', overflow: 'visible' }} aria-hidden>
          <rect x={0} y={top} width={tw} height={barH} rx={tw / 2} fill={track} />
          {frac > 0 ? <rect x={0} y={top + barH - Math.max(tw, barH * frac)} width={tw} height={Math.max(tw, barH * frac)} rx={tw / 2} fill={fill} /> : null}
          {over ? <path d={`M${tw / 2 - 5},${top + 1} l5,-6 l5,6 z`} fill={theme.warning} /> : null}
          {under ? <path d={`M${tw / 2 - 5},${top + barH - 1} l5,6 l5,-6 z`} fill={theme.warning} /> : null}
          {bandList.map(([a, b, c], i) => (
            <rect key={i} x={tw + 2} y={ty(b)} width={3} height={Math.max(1, ty(a) - ty(b))} fill={c} rx={1} />
          ))}
          {target !== null && target >= min && target <= max ? <line x1={-3} x2={tw + 3} y1={ty(target)} y2={ty(target)} stroke={theme.text} strokeWidth={2} /> : null}
          {showTicks
            ? ticks(min, max, H > 200 ? 5 : 2).map((t, i) => (
                <text key={i} x={tw + 9} y={ty(t) + 3.5} fontSize={10 * fs} fill={theme.text_muted} style={TABULAR}>
                  {tickFmt(t)}
                </text>
              ))
            : null}
        </svg>
        <div style={{ minWidth: 0 }}>{valueBlock(valuePx, 'left')}</div>
      </div>
    );
  }

  // radial / semicircle
  const radial = variant === 'radial';
  const a0 = radial ? 225 : 180;
  const a1 = radial ? -45 : 0;
  const ang = (val: number) => a0 + (a1 - a0) * clamp((val - min) / (max - min), 0, 1);
  const bandList = bands(thresholds, min, max);
  const hasBands = bandList.length > 0;
  const hf = radial ? 1 + Math.sin(Math.PI / 4) : 1.0;
  const labelPx = Math.max(9, 10 * fs);
  const bottomExtra = (showTicks ? labelPx + 6 : 2) + (radial ? 0 : 4);
  const R = Math.max(10, Math.min((W - 8) / 2, (H - 6 - bottomExtra) / hf));
  const tw = clamp(R * 0.15, 5, 22);
  const bandW = hasBands ? Math.max(2.5, tw * 0.22) : 0;
  const rt = R - bandW - (hasBands ? 3 : 0) - tw / 2;
  const cx = W / 2;
  const contentH = R * hf + bottomExtra;
  const cy = (H - contentH) / 2 + R;
  const fillTo = v === null ? a0 : ang(v);
  const innerW = Math.max(10, 2 * (rt - tw / 2 - 4));
  const chars = Math.max(2, valueText.length + (unit && v !== null ? unit.length * 0.5 + 0.5 : 0));
  const valuePx = clamp(Math.min(R * (radial ? 0.3 : 0.32), innerW / (chars * 0.62)), 11, 52 * fs);
  const [minX, minY] = pt(cx, cy, rt, a0);
  const [maxX] = pt(cx, cy, rt, a1);
  const labelTop = minY + tw / 2 + 2;

  return (
    <div style={{ width: W, height: H, position: 'relative', overflow: 'hidden' }}>
      <svg width={W} height={H} style={{ display: 'block' }} aria-hidden>
        <path d={arc(cx, cy, rt, a0, a1)} stroke={track} strokeWidth={tw} fill="none" strokeLinecap="round" />
        {v !== null && fillTo < a0 - 0.01 ? <path d={arc(cx, cy, rt, a0, fillTo)} stroke={fill} strokeWidth={tw} fill="none" strokeLinecap="round" style={{ transition: 'all 300ms ease' }} /> : null}
        {bandList.map(([a, b, c], i) => (
          <path key={i} d={arc(cx, cy, R - bandW / 2, ang(a), ang(b))} stroke={c} strokeWidth={bandW} fill="none" />
        ))}
        {showTicks
          ? ticks(min, max).map((t, i) => {
              const [x0, y0] = pt(cx, cy, rt - tw / 2 - 1, ang(t));
              const [x1, y1] = pt(cx, cy, rt - tw / 2 - 1 - Math.max(3, tw * 0.35), ang(t));
              return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={theme.chart_axis} strokeWidth={1} />;
            })
          : null}
        {target !== null && target >= min && target <= max
          ? (() => {
              const [x0, y0] = pt(cx, cy, rt + tw / 2 + 2, ang(target));
              const [x1, y1] = pt(cx, cy, rt - tw / 2 - 2, ang(target));
              return <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={theme.text} strokeWidth={2.5} strokeLinecap="round" />;
            })()
          : null}
        {over || under
          ? (() => {
              const [x, y] = pt(cx, cy, rt, over ? a1 : a0);
              return <circle cx={x} cy={y} r={Math.max(3, tw * 0.28)} fill={theme.warning} stroke={theme.surface} strokeWidth={1.5} />;
            })()
          : null}
      </svg>
      {showTicks ? (
        <>
          <span style={{ position: 'absolute', left: minX - 30, width: 60, textAlign: 'center', top: labelTop, fontSize: labelPx, lineHeight: 1, color: theme.text_muted, ...TABULAR }}>{tickFmt(min)}</span>
          <span style={{ position: 'absolute', left: maxX - 30, width: 60, textAlign: 'center', top: labelTop, fontSize: labelPx, lineHeight: 1, color: theme.text_muted, ...TABULAR }}>{tickFmt(max)}</span>
        </>
      ) : null}
      <div
        style={
          radial
            ? { position: 'absolute', left: cx - innerW / 2, width: innerW, top: cy - valuePx * 0.62, display: 'flex', justifyContent: 'center' }
            : { position: 'absolute', left: cx - innerW / 2, width: innerW, bottom: H - cy - 2, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }
        }
      >
        {valueBlock(valuePx)}
      </div>
    </div>
  );
}

