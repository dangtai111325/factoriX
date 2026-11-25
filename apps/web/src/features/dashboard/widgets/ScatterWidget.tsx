/**
 * XY scatter body (ECharts): roles `x` and `y`, both numeric with history.
 *
 * - Samples are paired by timestamp (`data.pairByTime`): nearest Y within `pair_tolerance_ms` of each X,
 *   every point used once, closest pairs first. Nothing is paired outside the tolerance; unmatched X/Y
 *   counts are reported in the footer. Two samples from different moments are never joined implicitly.
 * - Pairs with a BAD/UNCERTAIN sample are drawn in the bad/warning color when `show_quality` is on.
 * - `point_size`, `x_min`/`x_max`/`y_min`/`y_max`; axis names carry label + unit; tooltip shows both
 *   values, the time and the time offset of the pair.
 */
import React, { useMemo } from 'react';
import type { SeriesData, WidgetRendererProps } from '../types';
import { formatValue } from '../format';
import { formatDuration, historyNotes, isNumericSeries, numericPoints, pairByTime, timeFull, uniqueNotes, unitOf } from './data';
import { EChart, esc, tooltipBase, valueAxisStyle, type ChartOption } from './EChart';
import { BodyMessage, decimalsOf, fontScale, FOOTNOTE_H, Footnote, hexAlpha, optBool, optColor, optInt, optNumOrNull, seriesColor } from './shared';

function byRole(series: SeriesData[], role: string, fallbackIndex: number): SeriesData | undefined {
  return series.find((s) => (s.role ?? s.binding?.role) === role) ?? (series.every((s) => !(s.role ?? s.binding?.role)) ? series[fallbackIndex] : undefined);
}

export function ScatterWidget({ options: o, data, theme, size, mode }: WidgetRendererProps) {
  const tolerance = optInt(o, 'pair_tolerance_ms', 1000, 0, 600000);
  const pointSize = optInt(o, 'point_size', 6, 2, 20);
  const xMin = optNumOrNull(o, 'x_min');
  const xMax = optNumOrNull(o, 'x_max');
  const yMin = optNumOrNull(o, 'y_min');
  const yMax = optNumOrNull(o, 'y_max');
  const showQuality = optBool(o, 'show_quality', true);
  const decimals = decimalsOf(o);
  const fs = fontScale(size, theme);
  const sx = byRole(data.series, 'x', 0);
  const sy = byRole(data.series, 'y', 1);

  const built = useMemo(() => {
    if (!sx || !sy) return null;
    for (const s of [sx, sy]) {
      if (s.error) return { error: `${s.label}: ${s.error.message}` } as const;
      if (!isNumericSeries(s)) return { error: `${s.label} is not numeric` } as const;
    }
    const r = pairByTime(numericPoints(sx.history?.points), numericPoints(sy.history?.points), tolerance);
    const notes: string[] = [`${r.pairs.length.toLocaleString('en-US')} pair${r.pairs.length === 1 ? '' : 's'}`];
    if (r.unmatchedX) notes.push(`${r.unmatchedX.toLocaleString('en-US')} X unmatched`);
    if (r.unmatchedY) notes.push(`${r.unmatchedY.toLocaleString('en-US')} Y unmatched`);
    notes.push(tolerance === 0 ? 'exact timestamps' : `tolerance ${tolerance < 1000 ? `${tolerance} ms` : formatDuration(tolerance)}`);
    notes.push(...historyNotes(sx.history, 'X'), ...historyNotes(sy.history, 'Y'));
    return { ...r, notes: uniqueNotes(notes) };
  }, [sx, sy, tolerance]);

  const color = optColor(o, 'accent_color') ?? (sy ? seriesColor(sy, 1, theme) : theme.accent);
  const option = useMemo<ChartOption | null>(() => {
    if (!built || 'error' in built || !sx || !sy) return null;
    const ux = unitOf(sx) || '';
    const uy = unitOf(sy) || '';
    const qColor = (a: string | null, b: string | null) => {
      const qa = (a || '').toUpperCase();
      const qb = (b || '').toUpperCase();
      if (qa === 'BAD' || qb === 'BAD') return theme.bad;
      if (qa === 'UNCERTAIN' || qb === 'UNCERTAIN') return theme.warning;
      return null;
    };
    const axisFmt = (v: number) => formatValue(v, { compact: Math.abs(v) >= 10000 });
    return {
      animation: built.pairs.length < 2000,
      grid: { left: 8, right: 18, top: 26, bottom: 22, containLabel: true },
      tooltip: {
        trigger: 'item',
        ...tooltipBase(theme, fs),
        formatter: (p: any) => {
          const pr = built.pairs[p.dataIndex];
          if (!pr) return '';
          const dt = Math.abs(pr.ty - pr.tx);
          return `<div style="font-weight:600;margin-bottom:3px">${esc(timeFull(pr.tx))}</div><div>${esc(sx.label)}: <b>${esc(formatValue(pr.x, { decimals, unit: ux || null }))}</b></div><div>${esc(sy.label)}: <b>${esc(formatValue(pr.y, { decimals, unit: uy || null }))}</b></div>${dt ? `<div style="color:${theme.text_muted}">Δt ${dt < 1000 ? `${dt} ms` : esc(formatDuration(dt))}</div>` : ''}${qColor(pr.qx, pr.qy) ? `<div style="color:${qColor(pr.qx, pr.qy)}">Quality: ${esc([pr.qx, pr.qy].filter((q) => q && q.toUpperCase() !== 'GOOD').join(' / ').toLowerCase())}</div>` : ''}`;
        },
      },
      xAxis: { type: 'value', scale: true, min: xMin ?? undefined, max: xMax ?? undefined, name: `${sx.label}${ux ? ` (${ux})` : ''}`, nameLocation: 'middle', nameGap: 22, ...valueAxisStyle(theme, fs), axisLine: { show: true, lineStyle: { color: theme.chart_axis } }, axisLabel: { color: theme.text_muted, fontSize: Math.round(10.5 * fs), hideOverlap: true, formatter: axisFmt } },
      yAxis: { type: 'value', scale: true, min: yMin ?? undefined, max: yMax ?? undefined, name: `${sy.label}${uy ? ` (${uy})` : ''}`, nameLocation: 'end', nameGap: 10, ...valueAxisStyle(theme, fs), nameTextStyle: { color: theme.text_muted, fontSize: Math.round(10.5 * fs), align: 'left' }, axisLabel: { color: theme.text_muted, fontSize: Math.round(10.5 * fs), hideOverlap: true, formatter: axisFmt } },
      series: [
        {
          type: 'scatter',
          symbolSize: pointSize,
          large: built.pairs.length > 3000,
          data: built.pairs.map((pr) => {
            const qc = showQuality ? qColor(pr.qx, pr.qy) : null;
            return qc ? { value: [pr.x, pr.y], itemStyle: { color: qc, opacity: 0.95 } } : [pr.x, pr.y];
          }),
          itemStyle: { color: hexAlpha(color, 0.7), borderColor: color, borderWidth: pointSize >= 6 ? 0.8 : 0 },
          emphasis: { scale: 1.6 },
        },
      ],
    };
  }, [built, sx, sy, theme, fs, xMin, xMax, yMin, yMax, pointSize, showQuality, color, decimals]);

  if (!sx || !sy) return <BodyMessage theme={theme} text="X and Y sources required" hint={mode === 'edit' ? 'Bind the X and Y roles' : null} />;
  if (!built) return null;
  if ('error' in built) return <BodyMessage theme={theme} tone="warning" text={built.error ?? 'Unavailable'} />;
  const W = size.width;
  const H = size.height;
  const showFooter = H >= 100;
  const chartH = Math.max(40, H - (showFooter ? FOOTNOTE_H : 0));
  return (
    <div style={{ width: W, height: H, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {option ? <EChart option={option} width={W} height={chartH} theme={theme} ariaLabel="Scatter chart" /> : null}
      {!built.pairs.length ? (
        <div style={{ position: 'absolute', inset: 0, bottom: showFooter ? FOOTNOTE_H : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ fontSize: 12, color: theme.text_muted, background: hexAlpha(theme.surface, 0.85), padding: '3px 10px', borderRadius: 6, textAlign: 'center' }}>No X/Y samples within the pairing tolerance</span>
        </div>
      ) : null}
      {showFooter ? <Footnote theme={theme} items={built.notes} height={FOOTNOTE_H} /> : null}
    </div>
  );
}

