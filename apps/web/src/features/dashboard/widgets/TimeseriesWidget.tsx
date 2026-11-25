/**
 * Time series chart body (ECharts).
 *
 * - One series per binding, binding color (fallback theme palette). Numeric points only: non-numeric
 *   values become holes; a binding whose data is boolean/string is skipped with a note (State timeline).
 * - Gaps are never connected: a null is inserted when two points are further apart than 2 × bucket_ms
 *   (bucketed history) or 3 × the median interval (`data.withGaps`), and `connectNulls` is off.
 * - Y axes by unit (`split_axes_by_unit`): first unit left, second right; further units go to the axis
 *   whose value magnitude is nearest and a note says so. Without splitting, mixed units are noted.
 *   `y_min`/`y_max` fix the primary (left) axis.
 * - Variants line/area/step/bar, `smooth` (line/area only), `show_points`, `stack` (per axis), legend
 *   position + values (last / min-max-avg from the points), thresholds as dashed markLines.
 * - `quality_marks`: BAD/UNCERTAIN points get triangle marks. Tooltip: time, value + unit, quality.
 * - `zoom`: inside zoom (Ctrl + wheel, drag to pan; slider when tall enough) + a "Reset zoom" button;
 *   zoom survives live frames (replaceMerge by id).
 * - X axis = props.timeRange. Footer: downsampled/truncated/server notes/axis notes.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { ThemeTokens, WidgetRendererProps } from '../types';
import { formatValue, isNumber } from '../format';
import { historyNotes, isNumericSeries, numericPoints, stats, timeFull, timeTick, uniqueNotes, unitOf, withGaps } from './data';
import { dotHtml, EChart, esc, timeAxis, tooltipBase, valueAxisStyle, type ChartOption, type EChartsInstance } from './EChart';
import { BodyMessage, clamp, decimalsOf, fontScale, FOOTNOTE_H, Footnote, hexAlpha, optBool, optEnum, optNumOrNull, optThresholds, seriesColor } from './shared';

const REPLACE = ['series', 'yAxis', 'legend', 'dataZoom', 'grid', 'tooltip'];

interface Prepared {
  id: string;
  name: string;
  color: string;
  unit: string;
  axis: number;
  data: Array<[number, number | null]>;
  qs: Array<string | null>;
  marks: Array<{ t: number; v: number; q: string }>;
  st: ReturnType<typeof stats>;
  magnitude: number | null;
}

function magnitudeOf(st: ReturnType<typeof stats>): number | null {
  if (st.max === null || st.min === null) return null;
  const m = Math.max(Math.abs(st.max), Math.abs(st.min));
  return m > 0 ? Math.log10(m) : 0;
}

export function TimeseriesWidget({ options: o, data, theme, size, timeRange, mode }: WidgetRendererProps) {
  const variant = optEnum(o, 'variant', ['line', 'area', 'step', 'bar'] as const, 'line');
  const smooth = optBool(o, 'smooth', false);
  const showPoints = optBool(o, 'show_points', false);
  const stack = optBool(o, 'stack', false);
  const legendPos = optEnum(o, 'legend', ['top', 'bottom', 'right', 'hidden'] as const, 'bottom');
  const legendValues = optEnum(o, 'legend_values', ['none', 'last', 'minmaxavg'] as const, 'none');
  const yMin = optNumOrNull(o, 'y_min');
  const yMax = optNumOrNull(o, 'y_max');
  const split = optBool(o, 'split_axes_by_unit', true);
  const thresholds = useMemo(() => optThresholds(o), [o.thresholds]);
  const qualityMarks = optBool(o, 'quality_marks', true);
  const zoom = optBool(o, 'zoom', true);
  const decimals = decimalsOf(o);
  const fs = fontScale(size, theme);

  const chartRef = useRef<EChartsInstance | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const prepared = useMemo(() => {
    const notes: string[] = [];
    const list: Prepared[] = [];
    data.series.forEach((s, i) => {
      if (s.error) {
        notes.push(`${s.label}: ${s.error.message}`);
        return;
      }
      if (!isNumericSeries(s)) {
        notes.push(`${s.label} is not numeric (use a State timeline)`);
        return;
      }
      notes.push(...historyNotes(s.history, data.series.length > 1 ? s.label : undefined));
      const pts = numericPoints(s.history?.points);
      const { data: d, qs } = withGaps(pts, s.history?.bucket_ms);
      const marks: Prepared['marks'] = [];
      for (const p of pts) {
        const q = (p.q || '').toUpperCase();
        if (p.v !== null && (q === 'BAD' || q === 'UNCERTAIN')) marks.push({ t: p.t, v: p.v, q });
      }
      const st = stats(pts);
      list.push({
        id: s.binding?.id || `s${i}`,
        name: s.label,
        color: seriesColor(s, i, theme),
        unit: unitOf(s) || '',
        axis: 0,
        data: d,
        qs,
        marks,
        st,
        magnitude: magnitudeOf(st),
      });
    });
    // unit → axis
    const units = Array.from(new Set(list.map((p) => p.unit)));
    const axisUnits: string[][] = [[units[0] ?? '']];
    if (split && units.length > 1) {
      axisUnits.push([units[1]]);
      const mag = (u: string) => {
        const ms = list.filter((p) => p.unit === u).map((p) => p.magnitude).filter(isNumber);
        return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
      };
      const m0 = mag(units[0]);
      const m1 = mag(units[1]);
      for (const u of units.slice(2)) {
        const mu = mag(u);
        const ax = mu === null || m0 === null || m1 === null ? 0 : Math.abs(mu - m0) <= Math.abs(mu - m1) ? 0 : 1;
        axisUnits[ax].push(u);
        notes.push(`${u || 'no unit'} shares the ${ax === 0 ? 'left' : 'right'} axis`);
      }
      for (const p of list) p.axis = axisUnits[1].includes(p.unit) ? 1 : 0;
    } else {
      axisUnits[0] = units;
      if (units.filter(Boolean).length > 1) notes.push(`Mixed units on one axis: ${units.filter(Boolean).join(', ')}`);
    }
    const marked = list.reduce((a, p) => a + p.marks.length, 0);
    if (qualityMarks && marked) notes.push(`${marked} BAD/UNCERTAIN point${marked > 1 ? 's' : ''} marked`);
    return { list, axisUnits, notes: uniqueNotes(notes) };
  }, [data.series, split, theme, qualityMarks]);

  const { list, axisUnits, notes } = prepared;
  const totalPoints = list.reduce((a, p) => a + p.st.count, 0);
  const W = size.width;
  const H = size.height;
  const showFooter = notes.length > 0 && H >= 120;
  const chartH = Math.max(40, H - (showFooter ? FOOTNOTE_H : 0));
  const showLegend = legendPos !== 'hidden' && list.length > 0 && H >= 120 && W >= 180;
  const slider = zoom && chartH >= 260;

  const option = useMemo<ChartOption>(() => {
    const span = timeRange.end - timeRange.start;
    const fsAxis = fs;
    const fmt = (v: number | null, unit: string) => formatValue(v, { decimals, unit: unit || null });
    const legendText = (p: Prepared) => {
      if (legendValues === 'last') return `${fmt(p.st.last, p.unit)}`;
      if (legendValues === 'minmaxavg') return `min ${fmt(p.st.min, '')} · max ${fmt(p.st.max, '')} · avg ${fmt(p.st.avg, p.unit)}`;
      return '';
    };
    const byName = new Map(list.map((p) => [p.name, p]));
    const rightLegendW = clamp(W * 0.3, 90, legendValues === 'minmaxavg' ? 240 : 170);
    const legend: ChartOption | undefined = showLegend
      ? {
          id: 'lg',
          type: 'scroll',
          data: list.map((p) => p.name),
          icon: 'roundRect',
          itemWidth: 12,
          itemHeight: 4,
          itemGap: 12,
          pageIconColor: theme.text_muted,
          pageIconInactiveColor: theme.border,
          pageTextStyle: { color: theme.text_muted },
          textStyle: {
            color: theme.text,
            fontSize: Math.round(11 * fsAxis),
            rich: { v: { color: theme.text_muted, fontSize: Math.round(10.5 * fsAxis), padding: [0, 0, 0, 4] } },
            ...(legendPos === 'right' ? { width: rightLegendW - 30, overflow: 'truncate' } : null),
          },
          formatter: (name: string) => {
            const p = byName.get(name);
            const extra = p ? legendText(p) : '';
            return extra ? (legendPos === 'right' ? `${name}\n{v|${extra}}` : `${name} {v|${extra}}`) : name;
          },
          tooltip: { show: true },
          ...(legendPos === 'right'
            ? { orient: 'vertical', right: 0, top: 'middle', width: rightLegendW }
            : legendPos === 'top'
              ? { top: 0, left: 'center' }
              : { bottom: slider ? 30 : 0, left: 'center' }),
        }
      : undefined;
    const legendH = showLegend && legendPos !== 'right' ? 22 : 0;
    const grid: ChartOption = {
      id: 'g',
      left: 6,
      right: showLegend && legendPos === 'right' ? rightLegendW + 10 : 10,
      top: (legendPos === 'top' ? legendH : 0) + 22 + (thresholds.length ? 8 : 0),
      bottom: (legendPos === 'bottom' ? legendH : 0) + (slider ? 34 : 4),
      containLabel: true,
    };
    const yAxis = axisUnits.map((units, i) => ({
      id: `y${i}`,
      type: 'value',
      position: i === 0 ? 'left' : 'right',
      name: units.filter(Boolean).join(', '),
      nameLocation: 'end',
      nameGap: 10,
      scale: !(variant === 'bar' || variant === 'area' || stack),
      splitNumber: Math.max(2, Math.min(6, Math.floor((chartH - 70) / 38))),
      min: i === 0 && yMin !== null ? yMin : undefined,
      max: i === 0 && yMax !== null ? yMax : undefined,
      ...valueAxisStyle(theme, fsAxis),
      splitLine: { show: i === 0, lineStyle: { color: theme.chart_grid } },
      axisLabel: {
        color: theme.text_muted,
        fontSize: Math.round(10.5 * fsAxis * 10) / 10,
        hideOverlap: true,
        formatter: (v: number) => formatValue(v, { decimals: decimals ?? undefined, compact: Math.abs(v) >= 10000 }),
      },
    }));
    const thresholdSeriesIndex = list.findIndex((p) => p.axis === 0);
    const series: ChartOption[] = list.map((p, i) => {
      const base: ChartOption = {
        id: p.id,
        name: p.name,
        yAxisIndex: p.axis,
        data: p.data,
        connectNulls: false,
        color: p.color,
        emphasis: { focus: 'series', lineStyle: { width: 2.4 } },
        animationDurationUpdate: 0,
      };
      if (variant === 'bar') {
        Object.assign(base, { type: 'bar', barMaxWidth: 14, itemStyle: { borderRadius: [2, 2, 0, 0] }, stack: stack ? `ax${p.axis}` : undefined });
      } else {
        Object.assign(base, {
          type: 'line',
          step: variant === 'step' ? 'end' : false,
          smooth: smooth && (variant === 'line' || variant === 'area') ? 0.35 : false,
          showSymbol: showPoints,
          symbol: 'circle',
          symbolSize: showPoints ? 5 : 4,
          lineStyle: { width: 1.7 },
          stack: stack ? `ax${p.axis}` : undefined,
          areaStyle:
            variant === 'area'
              ? {
                  opacity: 1,
                  color: {
                    type: 'linear',
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    colorStops: [
                      { offset: 0, color: hexAlpha(p.color, stack ? 0.45 : 0.28) },
                      { offset: 1, color: hexAlpha(p.color, stack ? 0.25 : 0.02) },
                    ],
                  },
                }
              : undefined,
        });
      }
      if (qualityMarks && p.marks.length) {
        base.markPoint = {
          silent: true,
          symbol: 'triangle',
          symbolSize: 7,
          label: { show: false },
          animation: false,
          data: p.marks.slice(-500).map((m) => ({
            coord: [m.t, m.v],
            symbolOffset: [0, -7],
            itemStyle: { color: m.q === 'BAD' ? theme.bad : theme.warning, borderColor: theme.surface, borderWidth: 1 },
          })),
        };
      }
      if (i === thresholdSeriesIndex && thresholds.length) {
        base.markLine = {
          silent: true,
          symbol: 'none',
          animation: false,
          data: thresholds.map((t) => ({
            yAxis: t.value,
            lineStyle: { color: t.color, type: 'dashed', width: 1.2 },
            label: {
              show: W >= 220,
              position: 'insideStartTop',
              color: t.color,
              fontSize: Math.round(10 * fsAxis),
              formatter: t.label ? `${t.label} ${formatValue(t.value, { decimals })}` : formatValue(t.value, { decimals }),
            },
          })),
        };
      }
      return base;
    });

    const tooltip: ChartOption = {
      id: 'tt',
      trigger: 'axis',
      ...tooltipBase(theme, fs),
      axisPointer: { type: 'line', lineStyle: { color: theme.chart_axis, type: 'dashed' } },
      formatter: (params: any) => {
        const arr = Array.isArray(params) ? params : [params];
        if (!arr.length) return '';
        const t = arr[0].axisValue as number;
        const rows: string[] = [];
        for (const pr of arr) {
          const p = list[pr.seriesIndex];
          if (!p) continue;
          const v = Array.isArray(pr.value) ? pr.value[1] : pr.data?.[1];
          if (v === null || v === undefined) continue;
          const pt = p.data[pr.dataIndex];
          const q = (p.qs[pr.dataIndex] || '').toUpperCase();
          const qText = q === 'GOOD' ? '' : q ? q.charAt(0) + q.slice(1).toLowerCase() : 'Quality unknown';
          const qColor = q === 'BAD' ? theme.bad : q === 'UNCERTAIN' ? theme.warning : theme.text_muted;
          const at = pt && Math.abs(pt[0] - t) > 999 ? ` <span style="color:${theme.text_muted}">at ${esc(timeTick(pt[0], 0))}</span>` : '';
          rows.push(
            `<div style="display:flex;align-items:center;gap:8px;line-height:1.6">${dotHtml(p.color)}<span style="flex:1;color:${theme.text_muted};max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>` +
              `<b style="font-variant-numeric:tabular-nums;color:${theme.text}">${esc(fmt(v, p.unit))}</b>${qText ? `<span style="color:${qColor};font-size:11px">${esc(qText)}</span>` : ''}${at}</div>`,
          );
        }
        return `<div style="font-weight:600;margin-bottom:4px">${esc(timeFull(t))}</div>${rows.join('') || `<div style="color:${theme.text_muted}">No value</div>`}`;
      },
    };

    const dataZoom: ChartOption[] = zoom
      ? [
          { id: 'dzi', type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: true },
          ...(slider
            ? [
                {
                  id: 'dzs',
                  type: 'slider',
                  xAxisIndex: 0,
                  filterMode: 'none',
                  height: 18,
                  bottom: 4,
                  borderColor: theme.border,
                  backgroundColor: 'transparent',
                  fillerColor: hexAlpha(theme.text_muted, 0.12),
                  handleStyle: { color: theme.surface, borderColor: theme.chart_axis },
                  moveHandleStyle: { color: theme.chart_axis, opacity: 0.4 },
                  dataBackground: { lineStyle: { color: theme.chart_axis, opacity: 0.5 }, areaStyle: { color: theme.chart_grid, opacity: 0.6 } },
                  selectedDataBackground: { lineStyle: { color: theme.text_muted, opacity: 0.7 }, areaStyle: { color: theme.chart_axis, opacity: 0.35 } },
                  textStyle: { color: theme.text_muted, fontSize: 10 },
                  labelFormatter: (v: number) => timeTick(v, span),
                  brushSelect: false,
                },
              ]
            : []),
        ]
      : [];

    return {
      animation: totalPoints < 3000,
      grid,
      legend: legend ?? { show: false },
      tooltip,
      xAxis: { id: 'x', ...timeAxis(theme, fsAxis, timeRange, W) },
      yAxis,
      dataZoom,
      series,
    };
  }, [list, axisUnits, theme, fs, decimals, legendValues, legendPos, showLegend, slider, W, variant, smooth, showPoints, stack, yMin, yMax, thresholds, qualityMarks, zoom, timeRange, totalPoints, chartH]);

  const onInstance = useCallback((c: EChartsInstance | null) => {
    chartRef.current = c;
  }, []);
  const onEvents = useMemo(
    () => ({
      datazoom: () => {
        const c = chartRef.current;
        const dz = (c?.getOption() as any)?.dataZoom?.[0];
        setZoomed(!!dz && (dz.start > 0.01 || dz.end < 99.99));
      },
    }),
    [],
  );

  if (!data.series.length) return <BodyMessage theme={theme} text="No series" hint={mode === 'edit' ? 'Bind one or more numeric sources' : null} />;

  return (
    <div style={{ width: W, height: H, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <EChart option={option} width={W} height={chartH} theme={theme} replaceMerge={REPLACE} onInstance={onInstance} onEvents={zoom ? onEvents : undefined} ariaLabel="Time series chart" />
      {totalPoints === 0 ? <EmptyOverlay theme={theme} text={list.length ? 'No data in the selected time range' : 'No numeric series'} top={22} bottom={chartH - 30} /> : null}
      {zoom && zoomed ? (
        <button
          type="button"
          onClick={() => {
            chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
            setZoomed(false);
          }}
          style={{
            position: 'absolute',
            right: 6,
            top: 0,
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 6,
            border: `1px solid ${theme.border}`,
            background: theme.surface,
            color: theme.text,
            cursor: 'pointer',
          }}
        >
          Reset zoom
        </button>
      ) : null}
      {showFooter ? <Footnote theme={theme} items={notes} height={FOOTNOTE_H} /> : null}
    </div>
  );
}

function EmptyOverlay({ theme, text, top, bottom }: { theme: ThemeTokens; text: string; top: number; bottom: number }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top, height: Math.max(20, bottom - top), display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <span style={{ fontSize: 12, color: theme.text_muted, background: hexAlpha(theme.surface, 0.85), padding: '3px 10px', borderRadius: 6 }}>{text}</span>
    </div>
  );
}
