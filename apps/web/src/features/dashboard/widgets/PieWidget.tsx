/**
 * Pie / doughnut body (ECharts): one slice per binding.
 *
 * - Value per binding like the bar chart (`value_mode` latest or a labelled reduction over history).
 * - Only positive numeric values make slices. Negative values, nulls and non-numeric bindings are
 *   excluded and listed in a note; zeros are kept out of the drawing but count as 0 in the total.
 *   A zero (or empty) total shows an empty state instead of a meaningless circle.
 * - Mixed units are noted (shares of different physical units are not comparable).
 * - `doughnut` + `inner_radius`, `label` percent/value/name/none, `legend` right/bottom/hidden,
 *   `show_total` (center of the doughnut, or the footer for a full pie). Stale/bad/no-data slices faded.
 */
import React, { useMemo } from 'react';
import type { WidgetRendererProps } from '../types';
import { formatNumber, formatValue, isNumber, STATE_LABEL, type ValueMode } from '../format';
import { isNumericSeries, modeValue, uniqueNotes, unitOf, VALUE_MODES } from './data';
import { dotHtml, EChart, esc, tooltipBase, type ChartOption } from './EChart';
import { BodyMessage, clamp, decimalsOf, hexAlpha, fontScale, FOOTNOTE_H, Footnote, isDegraded, optBool, optEnum, optInt, seriesColor, TABULAR } from './shared';

interface Slice {
  name: string;
  value: number;
  color: string;
  state: ReturnType<typeof modeValue>['state'];
  unit: string;
}

export function PieWidget({ options: o, data, theme, size, timeRange, mode }: WidgetRendererProps) {
  const valueMode = optEnum<ValueMode>(o, 'value_mode', VALUE_MODES, 'latest');
  const doughnut = optBool(o, 'doughnut', true);
  const inner = optInt(o, 'inner_radius', 55, 0, 90);
  const labelMode = optEnum(o, 'label', ['percent', 'value', 'name', 'none'] as const, 'percent');
  const legendPos = optEnum(o, 'legend', ['right', 'bottom', 'hidden'] as const, 'right');
  const showTotal = optBool(o, 'show_total', true);
  const decimals = decimalsOf(o);
  const fs = fontScale(size, theme);

  const built = useMemo(() => {
    const notes: string[] = [];
    const slices: Slice[] = [];
    const negative: string[] = [];
    const missing: string[] = [];
    let modeLabel: string | null = null;
    let zeroCount = 0;
    data.series.forEach((s, i) => {
      if (s.error) {
        notes.push(`${s.label}: ${s.error.message}`);
        return;
      }
      if (!isNumericSeries(s)) {
        notes.push(`${s.label} excluded (not numeric)`);
        return;
      }
      const mv = modeValue(s, valueMode, timeRange);
      modeLabel = mv.modeLabel;
      notes.push(...mv.notes);
      if (!isNumber(mv.value)) {
        missing.push(s.label);
        return;
      }
      if (mv.value < 0) {
        negative.push(s.label);
        return;
      }
      if (mv.value === 0) zeroCount++;
      slices.push({ name: s.label, value: mv.value, color: seriesColor(s, i, theme), state: mv.state, unit: unitOf(s) || '' });
    });
    if (negative.length) notes.push(`Excluded (negative): ${negative.join(', ')}`);
    if (missing.length) notes.push(`No data: ${missing.join(', ')}`);
    const units = Array.from(new Set(slices.map((x) => x.unit).filter(Boolean)));
    if (units.length > 1) notes.push(`Mixed units: ${units.join(', ')} — shares are not comparable`);
    const total = slices.reduce((a, b) => a + b.value, 0);
    return { slices, notes: uniqueNotes(notes), modeLabel: modeLabel as string | null, total, unit: units.length === 1 ? units[0] : '', zeroCount };
  }, [data.series, valueMode, timeRange.start, timeRange.end, theme]);

  const { slices, notes, modeLabel, total, unit } = built;
  const W = size.width;
  const H = size.height;
  const fmtTotal = formatValue(total, { decimals, unit: unit || null, compact: Math.abs(total) >= 100000 });
  const footerItems = [modeLabel ?? '', showTotal && !doughnut && total > 0 ? `Total ${fmtTotal}` : '', ...notes].filter(Boolean);
  const showFooter = footerItems.length > 0 && H >= 100;
  const chartH = Math.max(40, H - (showFooter ? FOOTNOTE_H : 0));
  const showLegend = legendPos !== 'hidden' && W >= 200 && chartH >= 100;
  const legendRight = showLegend && legendPos === 'right' && W >= 260;
  const legendBottom = showLegend && !legendRight;
  const legendW = legendRight ? clamp(W * 0.36, 90, 200) : 0;
  const plotW = W - legendW;
  const plotH = chartH - (legendBottom ? 26 : 0);
  const cx = plotW / 2;
  const cy = plotH / 2;
  const showLabels = labelMode !== 'none' && Math.min(plotW, plotH) >= 150;
  const outer = Math.max(16, Math.min(plotW, plotH) / 2 - (showLabels ? 26 : 6));
  const innerR = doughnut ? (outer * inner) / 100 : 0;

  const option = useMemo<ChartOption>(() => {
    const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
    const fmtPct = (v: number) => `${formatNumber(pct(v), pct(v) < 10 ? 1 : 0)}%`;
    return {
      tooltip: {
        trigger: 'item',
        ...tooltipBase(theme, fs),
        formatter: (p: any) => {
          const sl = slices[p.dataIndex];
          if (!sl) return '';
          return `<div style="display:flex;align-items:center">${dotHtml(sl.color)}<b>${esc(sl.name)}</b></div><div style="margin-top:3px">${esc(formatValue(sl.value, { decimals, unit: sl.unit || null }))} · ${esc(fmtPct(sl.value))}</div>${modeLabel ? `<div style="color:${theme.text_muted}">${esc(modeLabel)}</div>` : ''}${sl.state !== 'good' ? `<div style="color:${theme.text_muted}">${esc(sl.state === 'unknown' ? 'Quality unknown' : STATE_LABEL[sl.state])}</div>` : ''}`;
        },
      },
      legend: showLegend
        ? {
            type: 'scroll',
            icon: 'circle',
            itemWidth: 8,
            itemHeight: 8,
            itemGap: 8,
            data: slices.map((s) => s.name),
            textStyle: { color: theme.text, fontSize: Math.round(11 * fs), width: legendRight ? legendW - 24 : undefined, overflow: 'truncate', rich: { v: { color: theme.text_muted, fontSize: Math.round(10.5 * fs) } } },
            formatter: (name: string) => {
              const sl = slices.find((x) => x.name === name);
              return sl ? `${name}  {v|${fmtPct(sl.value)}}` : name;
            },
            pageIconColor: theme.text_muted,
            pageTextStyle: { color: theme.text_muted },
            ...(legendRight ? { orient: 'vertical', right: 4, top: 'middle', width: legendW } : { bottom: 0, left: 'center' }),
          }
        : { show: false },
      series: [
        {
          type: 'pie',
          center: [cx, cy],
          radius: [innerR, outer],
          avoidLabelOverlap: true,
          minAngle: 2,
          padAngle: slices.length > 1 ? 1 : 0,
          itemStyle: { borderColor: theme.surface, borderWidth: 1.5, borderRadius: doughnut ? 3 : 0 },
          label: {
            show: showLabels,
            color: theme.text,
            fontSize: Math.round(10.5 * fs),
            formatter: (p: { dataIndex: number }) => {
              const sl = slices[p.dataIndex];
              if (!sl) return '';
              if (labelMode === 'percent') return fmtPct(sl.value);
              if (labelMode === 'value') return formatValue(sl.value, { decimals, compact: Math.abs(sl.value) >= 100000 });
              return sl.name;
            },
          },
          labelLine: { show: showLabels, length: 6, length2: 8, lineStyle: { color: theme.chart_axis } },
          emphasis: { scaleSize: 4 },
          data: slices.map((s) => ({
            name: s.name,
            value: s.value,
            // degraded slices: faint fill + dashed outline (legend keeps the identity color)
            itemStyle: isDegraded(s.state) ? { color: hexAlpha(s.color, 0.18), borderColor: s.color, borderWidth: 1.2, borderType: 'dashed' } : { color: s.color },
          })),
        },
      ],
    };
  }, [slices, total, theme, fs, showLegend, legendRight, legendW, cx, cy, innerR, outer, showLabels, labelMode, decimals, doughnut, modeLabel]);

  if (!data.series.length) return <BodyMessage theme={theme} text="No series" hint={mode === 'edit' ? 'Bind one or more numeric sources' : null} />;
  if (!(total > 0)) {
    return <BodyMessage theme={theme} text={slices.length ? 'Total is 0 — nothing to compare' : 'No values to compare'} hint={notes.join(' · ') || null} fontSize={12 * fs} />;
  }
  const totalPx = clamp(innerR * 0.42, 11, 30);
  return (
    <div style={{ width: W, height: H, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      <EChart option={option} width={W} height={chartH} theme={theme} ariaLabel="Pie chart" />
      {doughnut && showTotal && innerR >= 22 ? (
        <div style={{ position: 'absolute', left: cx - innerR, top: cy - innerR, width: innerR * 2, height: innerR * 2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', ...TABULAR }}>
          {innerR >= 34 ? <span style={{ fontSize: Math.max(9, totalPx * 0.42), color: theme.text_muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total</span> : null}
          <span style={{ fontSize: totalPx, fontWeight: 650, color: theme.text, whiteSpace: 'nowrap', maxWidth: innerR * 1.8, overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatValue(total, { decimals, compact: Math.abs(total) >= 10000, showUnit: false })}</span>
          {unit && innerR >= 34 ? <span style={{ fontSize: Math.max(9, totalPx * 0.45), color: theme.text_muted }}>{unit}</span> : null}
        </div>
      ) : null}
      {showFooter ? <Footnote theme={theme} items={footerItems} height={FOOTNOTE_H} /> : null}
    </div>
  );
}
