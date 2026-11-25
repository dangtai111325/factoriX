/**
 * Bar chart body (ECharts): one category (bar) per binding.
 *
 * - Value per binding: `value_mode` latest = latest value; other modes reduce the bounded history with
 *   `format.reduce`; the mode is labelled ("Avg · 1h") and downsampled/truncated history is noted.
 * - Numbers only: boolean/string bindings are excluded with a note. null → no bar and "no data" in the
 *   category label (never a zero bar).
 * - Bar color = thresholds over the value (base = binding color); thresholds are also dashed markLines.
 *   Stale/bad/no-data values are drawn faded with "(stale)" etc. in the label and tooltip.
 * - `orientation`, `sort` (nulls last), `show_labels`, `y_min`/`y_max` on the value axis, decimals.
 *   Mixed units on one value axis are noted.
 */
import React, { useMemo } from 'react';
import type { WidgetRendererProps } from '../types';
import { formatValue, isNumber, STATE_LABEL, thresholdColor, type ValueMode } from '../format';
import { isNumericSeries, modeValue, uniqueNotes, unitOf, VALUE_MODES } from './data';
import { categoryAxisStyle, dotHtml, EChart, esc, tooltipBase, valueAxisStyle, type ChartOption } from './EChart';
import { BodyMessage, clamp, decimalsOf, hexAlpha, fontScale, FOOTNOTE_H, Footnote, isDegraded, optBool, optEnum, optNumOrNull, optThresholds, seriesColor } from './shared';

interface Item {
  name: string;
  value: number | null;
  color: string;
  state: ReturnType<typeof modeValue>['state'];
  unit: string;
}

export function BarWidget({ options: o, data, theme, size, timeRange, mode }: WidgetRendererProps) {
  const valueMode = optEnum<ValueMode>(o, 'value_mode', VALUE_MODES, 'latest');
  const orientation = optEnum(o, 'orientation', ['vertical', 'horizontal'] as const, 'vertical');
  const sort = optEnum(o, 'sort', ['none', 'asc', 'desc'] as const, 'none');
  const showLabels = optBool(o, 'show_labels', true);
  const yMin = optNumOrNull(o, 'y_min');
  const yMax = optNumOrNull(o, 'y_max');
  const thresholds = useMemo(() => optThresholds(o), [o.thresholds]);
  const decimals = decimalsOf(o);
  const fs = fontScale(size, theme);

  const { items, notes, modeLabel } = useMemo(() => {
    const notes: string[] = [];
    const items: Item[] = [];
    let modeLabel: string | null = null;
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
      const base = seriesColor(s, i, theme);
      const v = isNumber(mv.value) ? mv.value : null;
      items.push({ name: s.label, value: v, color: thresholdColor(v, thresholds, base), state: mv.state, unit: unitOf(s) || '' });
    });
    if (sort !== 'none') {
      items.sort((a, b) => {
        if (a.value === null) return b.value === null ? 0 : 1;
        if (b.value === null) return -1;
        return sort === 'asc' ? a.value - b.value : b.value - a.value;
      });
    }
    const units = Array.from(new Set(items.map((x) => x.unit).filter(Boolean)));
    if (units.length > 1) notes.push(`Mixed units: ${units.join(', ')}`);
    return { items, notes: uniqueNotes(notes), modeLabel: modeLabel as string | null };
  }, [data.series, valueMode, timeRange.start, timeRange.end, theme, thresholds, sort]);

  const W = size.width;
  const H = size.height;
  const footerItems = [modeLabel ?? '', ...notes].filter(Boolean);
  const showFooter = footerItems.length > 0 && H >= 90;
  const chartH = Math.max(40, H - (showFooter ? FOOTNOTE_H : 0));
  const units = Array.from(new Set(items.map((x) => x.unit).filter(Boolean)));
  const axisUnit = units.length === 1 ? units[0] : '';

  const option = useMemo<ChartOption>(() => {
    const vertical = orientation === 'vertical';
    const suffix = (it: Item) => (it.value === null ? ' (no data)' : isDegraded(it.state) ? ` (${STATE_LABEL[it.state].toLowerCase()})` : '');
    const cats = items.map((it) => it.name);
    const catLabelW = vertical ? Math.max(30, (W - 50) / Math.max(1, items.length) - 6) : clamp(W * 0.3, 50, 140);
    const valueAxis = {
      type: 'value',
      min: yMin ?? undefined,
      max: yMax ?? undefined,
      name: axisUnit,
      nameLocation: 'end',
      ...valueAxisStyle(theme, fs),
      axisLabel: { color: theme.text_muted, fontSize: Math.round(10.5 * fs), hideOverlap: true, formatter: (v: number) => formatValue(v, { compact: Math.abs(v) >= 10000 }) },
    };
    const catAxis = {
      type: 'category',
      data: cats,
      inverse: !vertical,
      ...categoryAxisStyle(theme, fs),
      axisLabel: {
        color: theme.text,
        fontSize: Math.round(11 * fs),
        interval: 0,
        width: catLabelW,
        overflow: 'truncate',
        formatter: (name: string, idx: number) => {
          const it = items[idx];
          return it && it.value === null ? `${name}\n{m|no data}` : name;
        },
        rich: { m: { color: theme.text_muted, fontSize: Math.round(10 * fs) } },
      },
    };
    return {
      grid: { left: 6, right: vertical ? 10 : showLabels ? 54 : 14, top: axisUnit ? 24 : 14, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'item',
        ...tooltipBase(theme, fs),
        formatter: (p: any) => {
          const it = items[p.dataIndex];
          if (!it) return '';
          return `<div style="display:flex;align-items:center">${dotHtml(it.color)}<b>${esc(it.name)}</b></div><div style="margin-top:3px">${esc(formatValue(it.value, { decimals, unit: it.unit || null }))}${modeLabel ? ` <span style="color:${theme.text_muted}">${esc(modeLabel)}</span>` : ''}</div>${it.state !== 'good' ? `<div style="color:${theme.text_muted}">${esc(it.state === 'unknown' ? 'Quality unknown' : STATE_LABEL[it.state])}</div>` : ''}`;
        },
      },
      xAxis: vertical ? catAxis : valueAxis,
      yAxis: vertical ? valueAxis : catAxis,
      series: [
        {
          type: 'bar',
          barMaxWidth: 44,
          barCategoryGap: '30%',
          data: items.map((it) => ({
            value: it.value,
            // degraded (stale/bad/no data) values are drawn as a ghost bar: faint fill + dashed outline
            itemStyle: isDegraded(it.state)
              ? { color: hexAlpha(it.color, 0.16), borderColor: hexAlpha(it.color, 0.75), borderWidth: 1, borderType: 'dashed', borderRadius: vertical ? [4, 4, 0, 0] : [0, 4, 4, 0] }
              : { color: it.color, borderRadius: vertical ? [4, 4, 0, 0] : [0, 4, 4, 0] },
            label: {
              show: showLabels && it.value !== null,
              position: vertical ? 'top' : 'right',
              color: isDegraded(it.state) ? theme.text_muted : theme.text,
              fontSize: Math.round(10.5 * fs),
              formatter: () => `${formatValue(it.value, { decimals, compact: Math.abs(it.value ?? 0) >= 100000 })}${suffix(it)}`,
            },
          })),
          markLine: thresholds.length
            ? {
                silent: true,
                symbol: 'none',
                animation: false,
                data: thresholds.map((t) => ({
                  [vertical ? 'yAxis' : 'xAxis']: t.value,
                  lineStyle: { color: t.color, type: 'dashed', width: 1.2 },
                  label: { show: !!t.label && W > 200, formatter: t.label, color: t.color, fontSize: Math.round(10 * fs), position: 'insideEndTop' },
                })),
              }
            : undefined,
        },
      ],
    };
  }, [items, orientation, theme, fs, yMin, yMax, axisUnit, showLabels, thresholds, decimals, W, modeLabel]);

  if (!data.series.length) return <BodyMessage theme={theme} text="No series" hint={mode === 'edit' ? 'Bind one or more numeric sources' : null} />;
  if (!items.length) return <BodyMessage theme={theme} text="No numeric series" hint={notes[0]} />;
  return (
    <div style={{ width: W, height: H, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <EChart option={option} width={W} height={chartH} theme={theme} ariaLabel="Bar chart" />
      {showFooter ? <Footnote theme={theme} items={footerItems} height={FOOTNOTE_H} /> : null}
    </div>
  );
}
