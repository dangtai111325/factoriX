/**
 * Widget registry and theme presets, fetched once per page load (module cache) from
 * `GET /dashboards/widget-types` and `GET /dashboards/themes`. The registry is the single source of
 * truth for option keys, defaults, sizes and binding rules (contract §4).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getThemes, getWidgetTypes } from './api';
import type { DashboardWidget, OptionSpec, RegistryLimits, ThemePreset, WidgetRegistry, WidgetTypeDef } from './types';

export const FALLBACK_LIMITS: RegistryLimits = {
  max_widgets: 40,
  max_series_per_query: 20,
  default_points: 1500,
  max_points: 5000,
  max_range_days: 366,
  max_resolve_refs: 400,
  max_document_bytes: 1_500_000,
  max_variables: 10,
  max_bindings_per_document: 400,
  max_widget_height: 40,
  max_y: 2000,
};

function humanize(v: string): string {
  const t = v.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The server sends enum `choices` as plain strings and limits under its own names
 * (`default_max_points`, `max_window_days`); normalise once so the UI reads one shape.
 */
export function normalizeRegistry(raw: WidgetRegistry): WidgetRegistry {
  const limits = { ...FALLBACK_LIMITS, ...(raw.limits || {}) } as RegistryLimits;
  if (typeof raw.limits?.default_max_points === 'number') limits.default_points = raw.limits.default_max_points;
  if (typeof raw.limits?.max_window_days === 'number') limits.max_range_days = raw.limits.max_window_days;
  return {
    ...raw,
    limits,
    widget_types: (raw.widget_types || []).map((d) => ({
      ...d,
      options: (d.options || []).map((o) => ({
        ...o,
        choices: Array.isArray(o.choices)
          ? (o.choices as unknown[]).map((c) =>
              c && typeof c === 'object' ? (c as { value: string; label: string }) : { value: String(c), label: humanize(String(c)) },
            )
          : o.choices,
      })),
    })),
  };
}

/** Frame options every widget has (contract §4 "Common options"), used when a def omits one. */
export const COMMON_DEFAULTS: Record<string, unknown> = {
  show_title: true,
  description: '',
  background: 'inherit',
  background_color: null,
  accent_color: null,
  border: true,
  padding: 'normal',
  title_align: 'left',
};

function cached<T>(load: (signal?: AbortSignal) => Promise<T>) {
  let promise: Promise<T> | null = null;
  let value: T | null = null;
  return {
    get: (force = false): Promise<T> => {
      if (!force && promise) return promise;
      const p = load();
      promise = p;
      p.then((v) => {
        value = v;
      }).catch(() => {
        if (promise === p) promise = null;
      });
      return p;
    },
    peek: (): T | null => value,
  };
}

const registryCache = cached(async () => normalizeRegistry(await getWidgetTypes()));
const themesCache = cached(async () => (await getThemes()).items || []);

export interface RegistryState {
  registry: WidgetRegistry | null;
  defs: Map<string, WidgetTypeDef>;
  limits: RegistryLimits;
  loading: boolean;
  error: unknown;
  reload: () => void;
}

const EMPTY_DEFS = new Map<string, WidgetTypeDef>();

function defsOf(reg: WidgetRegistry | null): Map<string, WidgetTypeDef> {
  if (!reg) return EMPTY_DEFS;
  const cache = defsMemo.get(reg);
  if (cache) return cache;
  const m = new Map((reg.widget_types || []).map((d) => [d.type, d]));
  defsMemo.set(reg, m);
  return m;
}
const defsMemo = new WeakMap<WidgetRegistry, Map<string, WidgetTypeDef>>();

export function useWidgetRegistry(): RegistryState {
  const [registry, setRegistry] = useState<WidgetRegistry | null>(() => registryCache.peek());
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!registry);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    registryCache
      .get(nonce > 0)
      .then((r) => {
        if (!alive) return;
        setRegistry(r);
        setError(null);
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const limits = useMemo(() => ({ ...FALLBACK_LIMITS, ...(registry?.limits || {}) }), [registry]);
  return { registry, defs: defsOf(registry), limits, loading, error, reload };
}

export function useThemePresets(): { presets: ThemePreset[]; error: unknown; loading: boolean } {
  const [presets, setPresets] = useState<ThemePreset[]>(() => themesCache.peek() || []);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!themesCache.peek());
  useEffect(() => {
    let alive = true;
    themesCache
      .get()
      .then((p) => alive && setPresets(p))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);
  return { presets, error, loading };
}

function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}

/** Options with every registry default filled in; keys the registry does not declare are dropped. */
export function mergeOptions(def: WidgetTypeDef | undefined, options: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const given = options || {};
  if (!def) return { ...COMMON_DEFAULTS, ...given };
  for (const [k, v] of Object.entries(COMMON_DEFAULTS)) out[k] = v;
  for (const spec of def.options || []) {
    out[spec.key] = Object.prototype.hasOwnProperty.call(given, spec.key) ? given[spec.key] : clone(spec.default);
  }
  return out;
}

/** `show_if` (inspector visibility only). */
export function optionVisible(spec: OptionSpec, merged: Record<string, unknown>): boolean {
  if (!spec.show_if) return true;
  const v = merged[spec.show_if.key];
  return spec.show_if.in.some((x) => x === v);
}

/** The widget needs history: registry `required`, a reduction `value_mode`, or a sparkline (contract §7). */
export function widgetNeedsHistory(def: WidgetTypeDef | undefined, merged: Record<string, unknown>): boolean {
  if (!def || def.data.max_bindings === 0 || def.data.history === 'none') return false;
  if (def.data.history === 'required') return true;
  const mode = merged.value_mode;
  if (typeof mode === 'string' && mode !== 'latest') return true;
  return merged.sparkline === true;
}

/** Live points are appended to the history of this widget (timeseries `live_append`, KPI sparkline). */
export function widgetLiveAppend(def: WidgetTypeDef | undefined, merged: Record<string, unknown>): boolean {
  if (!def) return false;
  if (merged.live_append === true) return true;
  return merged.sparkline === true;
}

export const CATEGORY_LABEL: Record<WidgetTypeDef['category'], string> = {
  value: 'Values',
  status: 'Status',
  trend: 'Trends',
  compare: 'Comparison',
  distribution: 'Distribution',
  table: 'Tables',
  industrial: 'Equipment',
  content: 'Content',
};

export const CATEGORY_ORDER: WidgetTypeDef['category'][] = ['value', 'status', 'trend', 'compare', 'distribution', 'table', 'industrial', 'content'];

export function widgetDef(defs: Map<string, WidgetTypeDef>, w: DashboardWidget): WidgetTypeDef | undefined {
  return defs.get(w.type);
}
