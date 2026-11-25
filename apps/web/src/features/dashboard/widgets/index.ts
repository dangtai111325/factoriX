/**
 * Widget renderer registry: one body renderer per registry type (docs/architecture/contracts/dashboard.md §4).
 * Renderers draw only the widget BODY inside `size.width × size.height`; the chrome (title, background,
 * border, padding, loading/unbound/error states) belongs to the runtime.
 *
 * Chart widgets (ECharts) are code-split: each is a `React.lazy` module wrapped in its own Suspense
 * boundary with a skeleton, so pages that never show a chart do not download ECharts. Value, table and
 * content widgets are plain React/SVG and load eagerly.
 */
import { createElement, lazy, Suspense, type ComponentType } from 'react';
import type { WidgetRendererProps } from '../types';
import { ChartPlaceholder } from './shared';
import { KpiWidget } from './KpiWidget';
import { GaugeWidget } from './GaugeWidget';
import { ProgressWidget } from './ProgressWidget';
import { StatusWidget } from './StatusWidget';
import { LatestTableWidget } from './LatestTableWidget';
import { HistoryTableWidget } from './HistoryTableWidget';
import { EquipmentWidget } from './EquipmentWidget';
import { TextWidget } from './TextWidget';
import { ImageWidget } from './ImageWidget';
import { DividerWidget } from './DividerWidget';
import { LinkWidget } from './LinkWidget';

type Renderer = ComponentType<WidgetRendererProps>;

function lazyChart(name: string, load: () => Promise<Renderer>): Renderer {
  const Lazy = lazy(async () => ({ default: await load() }));
  const Chart = (props: WidgetRendererProps) => createElement(Suspense, { fallback: createElement(ChartPlaceholder, { theme: props.theme, size: props.size }) }, createElement(Lazy, props));
  Chart.displayName = name;
  return Chart;
}

export const WIDGET_RENDERERS: Record<string, ComponentType<WidgetRendererProps>> = {
  kpi: KpiWidget,
  gauge: GaugeWidget,
  progress: ProgressWidget,
  status: StatusWidget,
  timeseries: lazyChart('TimeseriesWidget', () => import('./TimeseriesWidget').then((m) => m.TimeseriesWidget)),
  state_timeline: lazyChart('StateTimelineWidget', () => import('./StateTimelineWidget').then((m) => m.StateTimelineWidget)),
  bar: lazyChart('BarWidget', () => import('./BarWidget').then((m) => m.BarWidget)),
  pie: lazyChart('PieWidget', () => import('./PieWidget').then((m) => m.PieWidget)),
  histogram: lazyChart('HistogramWidget', () => import('./HistogramWidget').then((m) => m.HistogramWidget)),
  scatter: lazyChart('ScatterWidget', () => import('./ScatterWidget').then((m) => m.ScatterWidget)),
  latest_table: LatestTableWidget,
  history_table: HistoryTableWidget,
  equipment: EquipmentWidget,
  text: TextWidget,
  image: ImageWidget,
  divider: DividerWidget,
  link: LinkWidget,
};
