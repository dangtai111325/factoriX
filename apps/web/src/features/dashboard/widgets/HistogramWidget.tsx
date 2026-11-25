/**
 * Histogram body (ECharts custom series): distribution of the numeric history points of one binding.
 * The X axis is the value range, not time.
 *
 * - Samples = finite numeric points; null/non-numeric points are counted as missing; BAD-quality points
 *   are excluded from the distribution and counted. Footer: "n samples · m missing · k BAD excluded".
 * - Bins: `bin_count` > 0 fixed; 0 = auto (Freedman–Diaconis, Sturges when the IQR is 0), 1..100.
 *   A constant series gets one bin around its value.
 * - `show_mean` / `show_median` draw labelled vertical markLines. Downsampled history is noted as a
 *   distribution of bucket averages.
 */
import React, { useMemo } from 'react';
import type { WidgetRendererProps } from '../types';
import { formatNumber, formatValue, isNumber } from '../format';
import { historyNotes, isNumericSeries, quantile, uniqueNotes, unitOf } from './data';
import { EChart, esc, tooltipBase, valueAxisStyle, type ChartOption } from './EChart';
import { BodyMessage, decimalsOf, fontScale, FOOTNOTE_H, Footnote, hexAlpha, optBool, optColor, optInt, seriesColor } from './shared';

export function autoBins(sorted: number[]): number {
  const n = sorted.length;
  if (n < 2) return 1;
  const range = sorted[n - 1] - sorted[0];
  if (range <= 0) return 1;
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  let k: number;
  if (iqr > 0) {
    const h = (2 * iqr) / Math.cbrt(n);
    k = Math.ceil(range / h);
  } else k = Math.ceil(Math.log2(n) + 1);
  return Math.max(1, Math.min(100, Number.isFinite(k) ? k : 10));
}

export function HistogramWidget({ options: o, data, theme, size, mode }: WidgetRendererProps) {
  const binCount = optInt(o, 'bin_count', 0, 0, 100);
  const showMean = optBool(o, 'show_mean', true);
  const showMedian = optBool(o, 'show_median', false);
  const decimals = decimalsOf(o);
  const fs = fontScale(size, theme);
  const s = data.series[0];

  const built = useMemo(() => {
    if (!s) return null;
    const notes: string[] = [];
    if (s.error) return { error: s.error.message } as const;
    if (!isNumericSeries(s)) return { error: `${s.label} is not numeric` } as const;
    const pts = s.history?.points ?? [];
    const values: number[] = [];
    let missing = 0;
    let bad = 0;
    for (const p of pts) {
      if (!isNumber(p.v)) {
        missing++;
        continue;
      }
      if ((p.q || '').toUpperCase() === 'BAD') {
        bad++;
        continue;
      }
      values.push(p.v);
    }
    values.sort((a, b) => a - b);
    const n = values.length;
    const k = n ? (binCount > 0 ? binCount : autoBins(values)) : 0;
    let lo = n ? values[0] : 0;
    let hi = n ? values[n - 1] : 1;
    if (hi === lo) {
      const pad = Math.abs(lo) * 0.01 || 0.5;
      lo -= pad;
      hi += pad;
    }
    const width = (hi - lo) / Math.max(1, k);
    const counts = new Array(k).fill(0);
    for (const v of values) {
      const i = Math.min(k - 1, Math.floor((v - lo) / width));
      counts[i]++;
    }
    const mean = n ? values.reduce((a, b) => a + b, 0) / n : null;
    const median = n ? quantile(values, 0.5) : null;
    notes.push(`${n.toLocaleString('en-US')} sample${n === 1 ? '' : 's'}`);
    if (missing) notes.push(`${missing.toLocaleString('en-US')} missing`);
    if (bad) notes.push(`${bad.toLocaleString('en-US')} BAD excluded`);
    if (k) notes.push(`${k} bin${k === 1 ? '' : 's'}${binCount > 0 ? '' : ' (auto)'}`);
    if (s.history?.downsampled) notes.push('distribution of bucket averages');
    notes.push(...historyNotes(s.history).filter((x) => !x.startsWith('downsampled')));
    return { n, k, lo, hi, width, counts, mean, median, notes: uniqueNotes(notes), unit: unitOf(s) || '', color: seriesColor(s, 0, theme) };
  }, [s, binCount, theme]);

  const option = useMemo<ChartOption | null>(() => {
    if (!built || 'error' in built || !built.n) return null;
    const { lo, hi, width, counts, mean, median, unit, n } = built;
    const color = optColor(o, 'accent_color') ?? built.color;
    // precision from the bin width (one digit finer), axis labels without trailing zeros
    const autoD = Math.max(0, Math.min(4, 1 - Math.floor(Math.log10(width || 1))));
    const fmt = (v: number) => formatNumber(v, decimals ?? autoD);
    const axisFmt = (v: number) => formatNumber(v, decimals ?? autoD).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const close = mean !== null && median !== null && Math.abs(mean - median) < (hi - lo) * 0.12;
    const marks: ChartOption[] = [];
    if (showMean && mean !== null) marks.push({ xAxis: mean, name: 'Mean', lineStyle: { color: theme.text, type: 'dashed', width: 1.3 }, label: { formatter: showMedian && close && median !== null ? `Mean ${fmt(mean)} · Median ${fmt(median)}` : `Mean ${fmt(mean)}`, color: theme.text } });
    if (showMedian && median !== null) marks.push({ xAxis: median, name: 'Median', lineStyle: { color: theme.warning, type: 'dotted', width: 1.6 }, label: { show: !(showMean && close), formatter: `Median ${fmt(median)}`, color: theme.warning } });
    return {
      grid: { left: 6, right: unit ? Math.min(60, 14 + unit.length * 7) : 14, top: marks.length ? 26 : 14, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'item',
        ...tooltipBase(theme, fs),
        formatter: (p: any) => {
          const i = p.value?.[3];
          if (!isNumber(i)) return '';
          const a = lo + i * width;
          const b = a + width;
          const c = counts[i];
          return `<div style="font-weight:600">${esc(fmt(a))} – ${esc(fmt(b))}${unit ? ` ${esc(unit)}` : ''}</div><div>${c.toLocaleString('en-US')} sample${c === 1 ? '' : 's'} <span style="color:${theme.text_muted}">(${formatNumber((c / n) * 100, 1)}%)</span></div>`;
        },
      },
      xAxis: { type: 'value', min: lo, max: hi, name: unit, nameLocation: 'end', ...valueAxisStyle(theme, fs), splitLine: { show: false }, axisLine: { show: true, lineStyle: { color: theme.chart_axis } }, axisLabel: { color: theme.text_muted, fontSize: Math.round(10.5 * fs), hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: axisFmt } },
      yAxis: { type: 'value', minInterval: 1, ...valueAxisStyle(theme, fs) },
      series: [
        {
          type: 'custom',
          encode: { x: [0, 1], y: 2 },
          data: counts.map((c, i) => [lo + i * width, lo + (i + 1) * width, c, i]),
          renderItem: (_params: any, api: any) => {
            const a = api.coord([api.value(0), api.value(2)]);
            const b = api.coord([api.value(1), 0]);
            const w = Math.max(1, b[0] - a[0] - (b[0] - a[0] > 6 ? 1.5 : 0));
            return { type: 'rect', shape: { x: a[0], y: a[1], width: w, height: Math.max(0, b[1] - a[1]), r: [2, 2, 0, 0] }, style: { fill: color }, emphasis: { style: { fill: hexAlpha(color, 0.75) } } };
          },
          markLine: marks.length
            ? { silent: true, symbol: 'none', animation: false, label: { position: 'end', fontSize: Math.round(10 * fs) }, data: marks }
            : undefined,
        },
      ],
    };
  }, [built, theme, fs, showMean, showMedian, decimals, o]);

  if (!s) return <BodyMessage theme={theme} text="No source" hint={mode === 'edit' ? 'Bind a numeric source with history' : null} />;
  if (!built) return null;
  if ('error' in built) return <BodyMessage theme={theme} tone="warning" text={built.error ?? 'Unavailable'} />;
  const W = size.width;
  const H = size.height;
  if (!built.n || !option) return <BodyMessage theme={theme} text="No numeric samples in the selected time range" hint={built.notes.slice(1).join(' · ') || null} fontSize={12 * fs} />;
  const showFooter = H >= 100;
  const chartH = Math.max(40, H - (showFooter ? FOOTNOTE_H : 0));
  return (
    <div style={{ width: W, height: H, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <EChart option={option} width={W} height={chartH} theme={theme} ariaLabel="Histogram" />
      {showFooter ? <Footnote theme={theme} items={built.notes} height={FOOTNOTE_H} /> : null}
    </div>
  );
}

