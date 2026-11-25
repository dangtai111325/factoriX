/**
 * Progress / target body.
 *
 * - Roles: `actual` (required) and `target` (optional). With a target binding its latest numeric value is
 *   the target (null/non-numeric → explained, the static `target_value` is NOT substituted); without a
 *   target binding `target_value` is used. The static target never changes source data.
 * - percent = (actual − min) / (target − min) × 100. target − min = 0 or a missing target → no division,
 *   the reason is shown instead of a percent. Over target: the bar is full and "Over target +x%" is shown;
 *   below target "Remaining x unit" (when `show_values`).
 * - `thresholds` apply to the percent. `direction` horizontal/vertical. `show_percent`, `show_values`.
 * - Stale/bad/no-data actual (or target): neutral fill + dimmed text + badge (`show_quality`).
 */
import React from 'react';
import type { SeriesData, WidgetRendererProps } from '../types';
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
  optThresholds,
  QualityBadge,
  TABULAR,
  useNow,
} from './shared';

function byRole(series: SeriesData[], role: string): SeriesData | undefined {
  return series.find((s) => (s.role ?? s.binding?.role) === role);
}

export function ProgressWidget({ options: o, data, theme, size, mode }: WidgetRendererProps) {
  const now = useNow();
  const actualS = byRole(data.series, 'actual') ?? data.series.find((s) => (s.role ?? s.binding?.role) !== 'target');
  const targetS = byRole(data.series, 'target');
  const targetValue = optNum(o, 'target_value', 100);
  const min = optNum(o, 'min', 0);
  const direction = optEnum(o, 'direction', ['horizontal', 'vertical'] as const, 'horizontal');
  const showPercent = optBool(o, 'show_percent', true);
  const showValues = optBool(o, 'show_values', true);
  const showQuality = optBool(o, 'show_quality', true);
  const thresholds = optThresholds(o);
  const decimals = decimalsOf(o);
  const accent = accentOf(o, theme);
  const fs = fontScale(size, theme);

  if (!actualS) return <BodyMessage theme={theme} text="No actual source" hint={mode === 'edit' ? 'Bind the Actual role' : null} />;

  const unit = unitOf(actualS);
  const rawActual = actualS.latest?.value;
  const actual = isNumber(rawActual) ? rawActual : null;
  const actualState = latestState(actualS);
  const targetState = targetS ? latestState(targetS) : 'good';
  const rawTarget = targetS ? targetS.latest?.value : targetValue;
  const target = isNumber(rawTarget) ? rawTarget : null;

  let reason: string | null = null;
  if (rawActual !== null && rawActual !== undefined && actual === null) reason = 'Actual is not numeric';
  else if (target === null) reason = targetS ? (rawTarget === null || rawTarget === undefined ? 'Target unavailable' : 'Target is not numeric') : 'No target';
  else if (target - min === 0) reason = target === 0 ? 'Target is 0 — percent undefined' : 'Target equals min — percent undefined';

  const pct = actual !== null && target !== null && !reason ? ((actual - min) / (target - min)) * 100 : null;
  const pctOk = pct !== null && Number.isFinite(pct);
  const degraded = isDegraded(actualState) || actual === null || (targetS ? isDegraded(targetState) : false);
  const fill = degraded ? theme.stale : thresholdColor(pctOk ? pct : null, thresholds, accent);
  const frac = pctOk ? clamp(pct / 100, 0, 1) : 0;
  const overBy = pctOk && pct > 100 ? pct - 100 : null;
  const worstState = isDegraded(actualState) ? actualState : targetS && targetState !== 'good' ? targetState : actualState;

  const fmt = (v: number | null) => formatValue(v, { decimals, showUnit: false });
  const pctText = pctOk ? `${formatNumber(pct, decimals ?? (Math.abs(pct) < 10 ? 1 : 0))}%` : '—';
  const valuesText = `${fmt(actual)} / ${fmt(target)}${unit ? ` ${unit}` : ''}`;
  const remaining = actual !== null && target !== null && !reason && actual < target ? `Remaining ${formatValue(target - actual, { decimals, unit })}` : null;
  const sub = overBy !== null ? `Over target +${formatNumber(overBy, decimals ?? (overBy < 10 ? 1 : 0))}%` : remaining;

  const W = size.width;
  const H = size.height;
  const horizontal = direction === 'horizontal';
  const track = theme.dark ? 'rgba(148,163,184,0.18)' : 'rgba(100,116,139,0.13)';
  const bigPx = clamp(Math.min(horizontal ? H * 0.32 : W * 0.2, 34 * fs), 12, 40);
  const smallPx = Math.max(10, Math.round(11 * fs));
  const tiny = H < 48 || W < 110;
  const textColor = degraded ? theme.text_muted : theme.text;

  const head = (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: horizontal ? 'space-between' : 'center', flexDirection: horizontal ? 'row' : 'column', gap: horizontal ? 8 : 2, minWidth: 0, ...TABULAR }}>
      {showPercent ? (
        <span style={{ fontSize: bigPx, fontWeight: 650, color: textColor, opacity: degraded && actual !== null ? 0.65 : 1, lineHeight: 1.05, whiteSpace: 'nowrap' }}>{reason ? '—' : pctText}</span>
      ) : null}
      {showValues && !tiny ? (
        <span style={{ fontSize: showPercent ? smallPx + 1 : bigPx, color: showPercent ? theme.text_muted : textColor, fontWeight: showPercent ? 500 : 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          {valuesText}
        </span>
      ) : null}
    </div>
  );
  const foot =
    !tiny && (reason || sub || (showQuality && worstState !== 'good')) ? (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: horizontal ? 'space-between' : 'center', flexWrap: horizontal ? 'nowrap' : 'wrap', minWidth: 0, fontSize: smallPx }}>
        {reason ? <span style={{ color: theme.warning, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reason}</span> : null}
        {!reason && sub && showValues ? <span style={{ color: overBy !== null ? theme.warning : theme.text_muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span> : null}
        {showQuality ? <QualityBadge state={worstState} ts={(isDegraded(actualState) ? actualS : targetS ?? actualS).latest?.ts} theme={theme} now={now} fontSize={smallPx} /> : null}
      </div>
    ) : null;

  if (horizontal) {
    const th = Math.round(clamp(H * 0.2, 6, 20));
    return (
      <div style={{ width: W, height: H, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(clamp(H * 0.07, 3, 8)), overflow: 'hidden' }}>
        {head}
        <div style={{ position: 'relative', height: th, borderRadius: th / 2, background: track, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, borderRadius: th / 2, background: fill, transition: 'width 300ms ease' }} />
          {overBy !== null ? <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 3, background: theme.warning }} /> : null}
        </div>
        {foot}
      </div>
    );
  }
  const tw = Math.round(clamp(W * 0.16, 10, 28));
  return (
    <div style={{ width: W, height: H, display: 'flex', alignItems: 'stretch', justifyContent: 'center', gap: 12, overflow: 'hidden', padding: '2px 0' }}>
      <div style={{ position: 'relative', width: tw, borderRadius: tw / 2, background: track, overflow: 'hidden', flex: '0 0 auto' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${frac * 100}%`, borderRadius: tw / 2, background: fill, transition: 'height 300ms ease' }} />
        {overBy !== null ? <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, background: theme.warning }} /> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, minWidth: 0 }}>
        {head}
        {foot}
      </div>
    </div>
  );
}
