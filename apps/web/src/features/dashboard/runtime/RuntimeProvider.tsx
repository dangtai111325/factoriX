/**
 * React side of the dashboard runtime: one `DashboardRuntimeStore` per provider (= per rendered
 * dashboard), and `useWidgetData(widget)` which turns the store's raw state into the `WidgetData` handed
 * to renderers (scale/offset applied, data states from server verdicts only, history only when needed).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useStreamStatus } from '../../../lib/liveStream';
import { applyTransform, dataState } from '../format';
import { mergeOptions, widgetLiveAppend, widgetNeedsHistory } from '../registry';
import { resourcePath, valueKindOf } from '../sources';
import { paletteColor } from '../theme';
import { sourceKey } from '../document';
import type {
  Binding,
  DashboardDocument,
  DashboardWidget,
  HistoryData,
  LatestValue,
  RegistryLimits,
  ResolvedSource,
  SeriesData,
  SourceResource,
  ThemeTokens,
  TimeRange,
  WidgetData,
  WidgetTypeDef,
} from '../types';
import { DashboardRuntimeStore, entryKeyOf, type HistoryParams, type RawHistory, type RawLatest } from './store';
import { parseModelToken } from './modelPath';

export interface RuntimeContextValue {
  store: DashboardRuntimeStore;
  defs: Map<string, WidgetTypeDef>;
  limits: RegistryLimits;
  theme: ThemeTokens;
  timeRange: TimeRange;
  variables: Record<string, string | null>;
  resources: Map<string, SourceResource>;
  mode: 'view' | 'edit';
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function useRuntime(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('useRuntime must be used inside <DashboardRuntimeProvider>');
  return ctx;
}

export const DashboardRuntimeProvider: React.FC<{
  document: DashboardDocument;
  /** Effective global range (view: URL override or document default). */
  timeRange: TimeRange;
  variables: Record<string, string | null>;
  defs: Map<string, WidgetTypeDef>;
  limits: RegistryLimits;
  theme: ThemeTokens;
  resources: Map<string, SourceResource>;
  mode: 'view' | 'edit';
  children: React.ReactNode;
}> = ({ document: doc, timeRange, variables, defs, limits, theme, resources, mode, children }) => {
  const [store] = useState(() => new DashboardRuntimeStore());
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  useEffect(() => {
    store.setInputs({ document: doc, variables, refresh: doc.settings.refresh, limits });
  }, [store, doc, variables, limits]);
  const value = useMemo<RuntimeContextValue>(
    () => ({ store, defs, limits, theme, timeRange, variables, resources, mode }),
    [store, defs, limits, theme, timeRange, variables, resources, mode],
  );
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
};

/** Re-render on every runtime change (inspector panels that read resolution results). */
export function useRuntimeVersion(): number {
  const { store } = useRuntime();
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

/** Header status of the runtime (live connection, last update, pending work). */
export function useRuntimeStatus(): { stream: ReturnType<typeof useStreamStatus>; lastUpdateAt: number | null; pending: number; resolveError: string | null; refresh: () => void } {
  const { store } = useRuntime();
  const stream = useStreamStatus();
  // Snapshot of exactly what the header shows (last update to the second): the page that renders the
  // header (and the whole canvas below it) must not re-render on every pushed value.
  useSyncExternalStore(store.subscribe, () => `${Math.floor((store.lastUpdateAt ?? 0) / 1000)}|${store.pendingRequests()}|${store.resolveError ?? ''}`);
  const refresh = useCallback(() => store.refreshNow(), [store]);
  return { stream, lastUpdateAt: store.lastUpdateAt, pending: store.pendingRequests(), resolveError: store.resolveError, refresh };
}

// ------------------------------------------------------------------ widget data

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(hi, Math.max(lo, n));
}

export function historyParamsOf(widget: DashboardWidget, merged: Record<string, unknown>, globalRange: TimeRange, limits: RegistryLimits, liveAppend: boolean): HistoryParams {
  return {
    range: widget.time.mode === 'custom' ? widget.time.range : globalRange,
    mode: merged.history_mode === 'recorded' ? 'recorded' : 'operational',
    resolution: merged.resolution === 'raw' ? 'raw' : 'auto',
    maxPoints: clampInt(merged.max_points, 1, limits.max_points || 5000, limits.default_points || 1500),
    liveAppend,
  };
}

function toLatestValue(raw: RawLatest | null, b: Binding, contactLost = false): LatestValue | null {
  if (!raw) return null;
  if (contactLost && raw.found) {
    // The appliance has not answered for a while: the value is the last known one, never "Good/Fresh".
    return {
      value: applyTransform(raw.value, b.scale, b.offset),
      raw: raw.value,
      ts: raw.ts,
      quality: raw.quality,
      freshness: 'STALE',
      effective_status: 'STALE',
      reason_code: 'NO_CONNECTION',
      state: 'stale',
    };
  }
  return {
    value: raw.found ? applyTransform(raw.value, b.scale, b.offset) : null,
    raw: raw.found ? raw.value : null,
    ts: raw.ts,
    quality: raw.quality,
    freshness: raw.freshness,
    effective_status: raw.effective_status,
    reason_code: raw.reason_code,
    state: dataState({ quality: raw.quality, freshness: raw.freshness, effective_status: raw.effective_status, hasValue: raw.found }),
  };
}

function toHistory(raw: RawHistory | null, error: string | null, b: Binding): HistoryData | null {
  if (!raw) {
    if (!error) return null;
    return { status: 'ERROR', points: [], downsampled: false, truncated: false, fidelity: '', notes: [error], bucket_ms: null, next_cursor: null };
  }
  const transform = b.scale !== 1 || b.offset !== 0;
  return {
    status: raw.status,
    points: raw.points.map((p) => ({ t: p.t, v: transform ? applyTransform(p.v, b.scale, b.offset) : p.v, q: p.q })),
    downsampled: raw.downsampled,
    truncated: raw.truncated,
    fidelity: raw.fidelity,
    notes: error ? [...raw.notes, `Last refresh failed: ${error}`] : raw.notes,
    bucket_ms: raw.bucket_ms,
    next_cursor: raw.next_cursor,
  };
}

function tokenOf(r: ResolvedSource | null): string | null {
  return r && r.ok && r.token ? r.token : null;
}

/**
 * Data of one widget. History is requested only when the widget needs it (registry `history: required`,
 * a reduction `value_mode`, or a sparkline) and the source can provide it.
 */
/** Visibility gate of a rendered widget: off-screen widgets defer their re-renders until they scroll in. */
export interface VisibilityGate {
  visible: React.MutableRefObject<boolean>;
  onVisible: Set<() => void>;
}

export function useWidgetData(widget: DashboardWidget, gate?: VisibilityGate): WidgetData {
  const { store, defs, limits, theme, timeRange, variables, resources } = useRuntime();
  const def = defs.get(widget.type);
  const merged = useMemo(() => mergeOptions(def, widget.options), [def, widget.options]);
  const needsHistory = widgetNeedsHistory(def, merged);
  const liveAppend = needsHistory && widgetLiveAppend(def, merged);
  const params = useMemo(
    () => historyParamsOf(widget, merged, timeRange, limits, liveAppend),
    [widget, merged, timeRange, limits, liveAppend],
  );

  // Subscribe to the store; the snapshot is a version string of exactly the parts this widget reads,
  // so React re-renders the widget only when one of them changed.
  const resolveKeys = useMemo(() => widget.bindings.map((b) => sourceKey(b.source)), [widget.bindings]);
  const keysOf = useCallback(() => {
    const resolvedList = widget.bindings.map((b) => store.getResolved(b.source));
    const tokens = resolvedList.map(tokenOf);
    const historyCapable = resolvedList.map((r) => !!(r?.ok && r.token && r.capabilities?.historical !== false));
    const historyKey = needsHistory ? tokens.map((t, i) => (t && historyCapable[i] ? entryKeyOf(t, params) : '')).join('\u0002') : '';
    return { resolvedList, tokens, tokenKey: tokens.map((t) => t ?? '').join(','), historyKey };
  }, [store, widget.bindings, needsHistory, params]);
  const getSignature = useCallback(() => {
    const k = keysOf();
    return store.signature(resolveKeys, k.tokens.filter(Boolean) as string[], k.historyKey ? k.historyKey.split('\u0002').filter(Boolean) : []);
  }, [store, keysOf, resolveKeys]);
  // History widgets (charts, tables over up to 20 × 5000 points) re-render at most once a second, and
  // charts with many series less often (1 s per 5 series, ≤ 4 s): every push (≈20/s for a 20-series chart)
  // used to re-render the chart, and a 40-widget dashboard pinned the main thread at 100 %. Widgets
  // outside the viewport do not re-render until they scroll in. Latest-only widgets follow every frame.
  const minIntervalMs = needsHistory ? 1000 * Math.min(4, Math.max(1, Math.ceil(widget.bindings.length / 5))) : 0;
  const subscribe = useCallback(
    (onChange: () => void) => {
      let timer: number | null = null;
      let last = 0;
      let deferred = false;
      const fire = () => {
        if (gate && !gate.visible.current) {
          deferred = true;
          return;
        }
        last = performance.now();
        onChange();
      };
      const wake = () => {
        if (!deferred) return;
        deferred = false;
        fire();
      };
      gate?.onVisible.add(wake);
      const throttled = () => {
        if (!minIntervalMs) {
          fire();
          return;
        }
        const wait = minIntervalMs - (performance.now() - last);
        if (wait <= 0) fire();
        else if (timer === null) {
          timer = window.setTimeout(() => {
            timer = null;
            fire();
          }, wait);
        }
      };
      const off = store.subscribe(throttled);
      return () => {
        off();
        gate?.onVisible.delete(wake);
        if (timer !== null) window.clearTimeout(timer);
      };
    },
    [store, minIntervalMs, gate],
  );
  const signature = useSyncExternalStore(subscribe, getSignature);
  const { resolvedList, tokens, tokenKey, historyKey } = keysOf();

  // Ref-counted retain/release of live subscriptions and history entries.
  useEffect(() => {
    const ts = tokenKey.split(',').filter(Boolean);
    const unique = Array.from(new Set(ts));
    const models = new Set<string>();
    for (const t of unique) {
      const m = parseModelToken(t);
      if (m) models.add(m.modelId);
      else store.retainSignal(t);
    }
    models.forEach((id) => store.retainModel(id));
    return () => {
      for (const t of unique) if (!parseModelToken(t)) store.releaseSignal(t);
      models.forEach((id) => store.releaseModel(id));
    };
  }, [store, tokenKey]);

  useEffect(() => {
    if (!historyKey) return;
    const keys: string[] = [];
    const ts = tokenKey.split(',');
    const capable = historyKey.split('\u0002');
    const seen = new Set<string>();
    ts.forEach((t, i) => {
      if (!t || !capable[i] || seen.has(t)) return;
      seen.add(t);
      keys.push(store.retainHistory(t, params));
    });
    return () => keys.forEach((k) => store.releaseHistory(k));
    // params identity is captured by historyKey (it embeds the group key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, historyKey]);

  return useMemo<WidgetData>(() => {
    if (!def) {
      return { status: 'error', error: `Widget type “${widget.type}” is not available on this server.`, series: [], warnings: [], resource: null };
    }
    const resource = equipmentResource(widget, merged, variables, resources);
    if (def.data.max_bindings === 0) return { status: 'ready', error: null, series: [], warnings: [], resource };
    if (!widget.bindings.length) {
      // A widget that needs no source (equipment: min 0) with a resource shows that resource, not "No data source".
      if (def.data.min_bindings === 0 && resource) return { status: 'ready', error: null, series: [], warnings: [], resource };
      return { status: 'unbound', error: null, series: [], warnings: [], resource };
    }

    const warnings: string[] = [];
    let waiting = false;
    const series: SeriesData[] = widget.bindings.map((b, i) => {
      const resolved = resolvedList[i];
      const token = tokens[i];
      const label = b.label || resolved?.label || (b.source.kind === 'signal_key' ? b.source.key : 'Data source');
      const base: SeriesData = {
        binding: b,
        role: b.role ?? null,
        resolved,
        error: null,
        label,
        unit: b.unit ?? resolved?.unit ?? null,
        color: b.color || paletteColor(theme, i),
        value_kind: valueKindOf(resolved?.value_type, resolved?.value_kind),
        latest: null,
        history: null,
      };
      if (!resolved) {
        if (store.resolveStatus === 'error') base.error = { code: 'RESOLVE_FAILED', message: store.resolveError || 'The data sources could not be resolved.' };
        else waiting = true;
        return base;
      }
      if (!resolved.ok || !token) {
        base.error = resolved.error || { code: 'INVALID_REF', message: 'This data source cannot be used.' };
        return base;
      }
      const raw = resolved.kind === 'model_field' || token.startsWith('mod:') ? store.modelLatest(token) : store.getLatestSignal(token);
      base.latest = toLatestValue(raw, b, store.contactLost);
      if (!raw && !store.isSettled(token)) waiting = true;
      const modelErr = token.startsWith('mod:') ? store.modelError(token) : null;
      if (modelErr) warnings.push(`${label}: ${modelErr}`);
      if (needsHistory) {
        if (resolved.capabilities && resolved.capabilities.historical === false) {
          base.history = { status: 'UNAVAILABLE', points: [], downsampled: false, truncated: false, fidelity: resolved.capabilities.fidelity, notes: resolved.capabilities.notes.length ? resolved.capabilities.notes : ['This source has no history.'], bucket_ms: null, next_cursor: null };
          warnings.push(`${label}: no history is available for this source.`);
        } else {
          const h = store.getHistory(entryKeyOf(token, params));
          base.history = toHistory(h?.data ?? null, h?.error ?? null, b);
          if (!h || (!h.data && !h.error)) waiting = true;
          if (h?.data?.downsampled) warnings.push(`${label}: downsampled to ${h.data.bucket_ms ? `${Math.round(h.data.bucket_ms / 1000)} s` : 'bucket'} averages.`);
          if (h?.data?.truncated) warnings.push(`${label}: the point limit was reached; older points are not shown.`);
          for (const n of h?.data?.notes || []) warnings.push(`${label}: ${n}`);
          if (params.mode === 'recorded' && resolved.capabilities && !resolved.capabilities.history_modes.includes('recorded')) {
            warnings.push(`${label}: this source is not recorded; the Recorded history may be empty.`);
          }
        }
      }
      return base;
    });

    const failed = series.filter((s) => s.error);
    if (failed.length === series.length && !waiting) {
      return {
        status: 'error',
        error: failed.length === 1 ? failed[0].error!.message : 'None of the data sources could be resolved.',
        series,
        warnings,
        resource,
      };
    }
    for (const s of failed) warnings.unshift(`${s.label}: ${s.error!.message}`);
    return { status: waiting ? 'loading' : 'ready', error: null, series, warnings: Array.from(new Set(warnings)), resource };
    // signature captures every store value read above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, def, widget, merged, theme, variables, resources, needsHistory, params]);
}

function equipmentResource(
  widget: DashboardWidget,
  merged: Record<string, unknown>,
  variables: Record<string, string | null>,
  resources: Map<string, SourceResource>,
): WidgetData['resource'] {
  if (!('resource_source' in merged)) return null;
  const id =
    merged.resource_source === 'variable'
      ? typeof merged.variable === 'string'
        ? variables[merged.variable] ?? null
        : null
      : typeof merged.resource_id === 'string'
        ? merged.resource_id
        : null;
  if (!id) return null;
  const r = resources.get(id);
  if (!r) return { id, name: 'Unknown resource', path: [] };
  return { id, name: r.name, code: r.code, path: resourcePath(r, resources) };
}
