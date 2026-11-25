/**
 * Reusable ECharts host for dashboard chart widgets.
 *
 * - Tree-shaken `echarts/core`: only Line, Bar, Pie, Scatter and Custom series plus Grid, Tooltip, Legend,
 *   DataZoom (inside + slider), MarkLine, MarkArea, MarkPoint and the Canvas renderer are registered.
 *   (The gauge widget is SVG and does not need ECharts.)
 * - One instance per mount: `init` once, `setOption` on every change (`notMerge`, or `replaceMerge` for
 *   charts that must keep interaction state such as zoom across live frames), `resize` on size change,
 *   `dispose` on unmount. A live frame never re-creates the instance.
 * - Theme: text/axis/grid/tooltip colors come from `ThemeTokens` (dark and light); helpers below build the
 *   common axis and tooltip blocks. Animation is off under `prefers-reduced-motion`.
 */
import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CustomChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ThemeTokens } from '../types';
import { prefersReducedMotion } from './shared';
import { timeTick } from './data';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

export type EChartsInstance = echarts.ECharts;
// ECharts option objects are deeply polymorphic; renderers build them as plain objects.
export type ChartOption = Record<string, any>;

export const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface EChartProps {
  option: ChartOption;
  width: number;
  height: number;
  theme: ThemeTokens;
  /** Keep components of these main types matched by id (e.g. zoom state) instead of a full replace. */
  replaceMerge?: string[];
  onEvents?: Record<string, (params: any) => void>;
  onInstance?: (chart: EChartsInstance | null) => void;
  ariaLabel?: string;
}

export function EChart({ option, width, height, theme, replaceMerge, onEvents, onInstance, ariaLabel }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsInstance | null>(null);
  const events = useRef(onEvents);
  events.current = onEvents;
  const bound = useRef<string[]>([]);

  // init once / dispose on unmount
  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: 'canvas', width: Math.max(1, width), height: Math.max(1, height) });
    chart.current = c;
    onInstance?.(c);
    return () => {
      onInstance?.(null);
      bound.current = [];
      c.dispose();
      chart.current = null;
    };
  }, []);

  // option updates
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const reduced = prefersReducedMotion();
    const full: ChartOption = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: FONT_FAMILY, color: theme.text_muted },
      animationDuration: 350,
      animationDurationUpdate: 220,
      ...option,
      animation: reduced ? false : option.animation ?? true,
    };
    if (replaceMerge?.length) c.setOption(full, { replaceMerge, lazyUpdate: true });
    else c.setOption(full, { notMerge: true, lazyUpdate: true });
  }, [option, theme, replaceMerge]);

  // event wiring (handlers read through a ref so changing closures do not rebind)
  const eventKeys = Object.keys(onEvents || {}).sort().join('|');
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const name of bound.current) c.off(name);
    const names = eventKeys ? eventKeys.split('|') : [];
    for (const name of names) c.on(name, (p: unknown) => events.current?.[name]?.(p));
    bound.current = names;
  }, [eventKeys]);

  useEffect(() => {
    chart.current?.resize({ width: Math.max(1, width), height: Math.max(1, height) });
  }, [width, height]);

  return <div ref={el} role="img" aria-label={ariaLabel} style={{ width, height, overflow: 'hidden' }} />;
}

// ------------------------------------------------------------------------------------------ style helpers

export function axisFont(fs: number): number {
  return Math.round(10.5 * fs * 10) / 10;
}

export function tooltipBase(theme: ThemeTokens, fs = 1): ChartOption {
  return {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: theme.text, fontFamily: FONT_FAMILY, fontSize: Math.round(12 * Math.min(fs, 1.15)) },
    extraCssText: `border-radius:8px;box-shadow:0 6px 24px rgba(15,23,42,${theme.dark ? 0.45 : 0.12});`,
    appendTo: 'body',
    confine: false,
  };
}

export function valueAxisStyle(theme: ThemeTokens, fs: number): ChartOption {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: theme.text_muted, fontSize: axisFont(fs), hideOverlap: true },
    splitLine: { lineStyle: { color: theme.chart_grid, width: 1 } },
    nameTextStyle: { color: theme.text_muted, fontSize: axisFont(fs), align: 'center' },
  };
}

export function categoryAxisStyle(theme: ThemeTokens, fs: number): ChartOption {
  return {
    axisLine: { show: true, lineStyle: { color: theme.chart_axis } },
    axisTick: { show: false },
    axisLabel: { color: theme.text_muted, fontSize: axisFont(fs) },
    splitLine: { show: false },
  };
}

export function timeAxisStyle(theme: ThemeTokens, fs: number): ChartOption {
  return {
    axisLine: { show: true, lineStyle: { color: theme.chart_axis } },
    axisTick: { show: true, lineStyle: { color: theme.chart_axis } },
    axisLabel: { color: theme.text_muted, fontSize: axisFont(fs), hideOverlap: true },
    splitLine: { show: false },
    axisPointer: { lineStyle: { color: theme.chart_axis, type: 'dashed' } },
  };
}

/** Escape text inserted into HTML tooltips. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function dotHtml(color: string): string {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(color)};margin-right:6px;flex:0 0 auto"></span>`;
}

/** Complete time x-axis over the widget window: tick density from the width, edge labels kept inside. */
export function timeAxis(theme: ThemeTokens, fs: number, range: { start: number; end: number }, width: number): ChartOption {
  const span = range.end - range.start;
  return {
    type: 'time',
    min: range.start,
    max: range.end,
    splitNumber: Math.max(2, Math.min(8, Math.floor(width / 95))),
    ...timeAxisStyle(theme, fs),
    axisLabel: {
      color: theme.text_muted,
      fontSize: axisFont(fs),
      hideOverlap: true,
      alignMinLabel: 'left',
      alignMaxLabel: 'right',
      formatter: (v: number) => timeTick(v, span),
    },
  };
}
