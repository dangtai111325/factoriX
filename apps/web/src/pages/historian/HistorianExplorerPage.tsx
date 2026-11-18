/**
 * Historian — explore time-series values, state changes and stored records (plan §8.3).
 *
 * Layout follows the other navs: page header with actions, one toolbar card, a Factory Model source picker
 * on the left and the trend workspace on the right (Trend · Records · Events · Exports tabs).
 * The full state (series, range or absolute window, mode, live, compare, layout, hidden, tab) lives in the
 * URL, so a copied link reopens exactly the same view; saved views store the same state on the server.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FileSpreadsheet,
  FolderOpen,
  History,
  Info,
  LineChart as LineChartIcon,
  Link2,
  Radio,
  RefreshCw,
  Rows3,
  Save,
  X,
  ZoomOut,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { MenuButton } from '../../components/common/MenuButton';
import { Tabs } from '../../components/common/Tabs';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { useApp } from '../../store/AppContext';
import {
  createExportJob,
  deleteView,
  ExportJob,
  HistorianQueryResponse,
  listExportJobs,
  listHistorianEvents,
  HistorianEvent,
  listSavedViews,
  queryHistorianSeries,
  retryExportJob,
  SavedView,
  saveView,
  updateView,
} from '../../lib/storagePhysicalApi';
import { HistorianTrendChart, ChartMarker } from './HistorianTrendChart';
import { SeriesPicker, PickItem } from './SeriesPicker';
import { EventRow, EventsList, ExportsPanel, PointInspector, RecordsTable, SaveViewDialog, StatsTable, ViewsDialog } from './HistorianPanels';
import {
  COMPARE_OPTIONS,
  compareOffsetMs,
  CompareOffset,
  findGaps,
  qualitySegments,
  formatBytes,
  formatClock,
  formatDateTime,
  formatDuration,
  fromLocalInput,
  Gap,
  HistorianTab,
  indexResponse,
  kindOfToken,
  liveIntervalMs,
  MAX_RANGE_MS,
  MAX_SERIES,
  MODES,
  normalizeSeries,
  paramsFromState,
  Pt,
  RANGE_PRESETS,
  RangeState,
  rangeLabel,
  resolveRange,
  safeFilePart,
  Series,
  SERIES_COLORS,
  specFromState,
  stateFromParams,
  stateFromSpec,
  statusText,
  toLocalInput,
  TZ_LABEL,
  ViewState,
} from './historianModel';
import { Banner, EmptyState, errorText, ErrorBanner, PageHeader, Segmented, selectCls, Skeleton } from './hsUi';

const LAST_SELECTION_KEY = 'fx.historian.lastSelection';

function readLastSelection(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(LAST_SELECTION_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_SERIES) : [];
  } catch {
    return [];
  }
}

function sameState(a: ViewState, b: ViewState): boolean {
  return paramsFromState(a).toString() === paramsFromState(b).toString();
}

interface QueryResult {
  res: HistorianQueryResponse;
  compare: HistorianQueryResponse | null;
  /** Comparison asked for but this server does not compute it (older Center). */
  compareUnsupported: boolean;
  startMs: number;
  endMs: number;
  fetchedAt: number;
}

export const HistorianExplorerPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const { signals, resources } = useApp();
  const { toast, show: showToast, dismiss } = useActionToast();

  // ------------------------------------------------------------------ state <-> URL
  const [state, setState] = useState<ViewState>(() => stateFromParams(params));
  const written = useRef<string>('');
  useEffect(() => {
    const next = paramsFromState(state);
    const s = next.toString();
    written.current = s;
    if (s !== params.toString()) setParams(next, { replace: true });
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // An external navigation (e.g. "Open in Historian" while this page is open, Back/Forward).
    const s = params.toString();
    if (s === written.current) return;
    const next = stateFromParams(params);
    setState((prev) => (sameState(prev, next) ? prev : next));
  }, [params]);
  const patch = useCallback((p: Partial<ViewState>) => setState((prev) => ({ ...prev, ...p })), []);

  useEffect(() => {
    if (!state.sources.length) return;
    try {
      window.localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify(state.sources));
    } catch {
      /* private mode */
    }
  }, [state.sources]);

  // ------------------------------------------------------------------ labels & colours
  const catalog = useRef(new Map<string, PickItem>());
  const [catalogVersion, setCatalogVersion] = useState(0);
  const onCatalog = useCallback((items: PickItem[]) => {
    items.forEach((it) => catalog.current.set(it.token, it));
    setCatalogVersion((v) => v + 1);
  }, []);
  const resByIdCode = useMemo(() => new Map(resources.map((r) => [r.id, r.code || r.name])), [resources]);
  const labelOf = useCallback(
    (token: string): string => {
      const c = catalog.current.get(token);
      if (c) return c.label;
      if (kindOfToken(token) === 'signal') {
        const s = signals.find((x) => x.id === token);
        if (s) return `${resByIdCode.get(s.resourceId) || 'Signal'} · ${s.key || s.name}`;
      }
      if (token.startsWith('subtable:')) return token.slice(9);
      if (token.startsWith('mod:')) return token.split(':').slice(2).join(':') || token;
      return token.slice(0, 8);
    },
    [signals, resByIdCode, catalogVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const colorRef = useRef(new Map<string, string>());
  const colorOf = useCallback(
    (token: string): string => {
      const m = colorRef.current;
      for (const k of Array.from(m.keys())) if (!state.sources.includes(k)) m.delete(k);
      if (!m.has(token)) {
        const used = new Set(m.values());
        m.set(token, SERIES_COLORS.find((c) => !used.has(c)) || SERIES_COLORS[m.size % SERIES_COLORS.length]);
      }
      return m.get(token)!;
    },
    [state.sources],
  );
  state.sources.forEach((t) => colorOf(t));

  // ------------------------------------------------------------------ query
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [events, setEvents] = useState<HistorianEvent[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const rangeKey = state.range.kind === 'preset' ? state.range.preset : `${state.range.startMs}-${state.range.endMs}`;
  const queryKey = `${state.sources.join(',')}|${state.mode}|${rangeKey}|${state.compare}`;

  const run = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      abortRef.current?.abort();
      const sources = state.sources;
      if (!sources.length) {
        setResult(null);
        setError(null);
        setLoading(false);
        return;
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const my = ++seq.current;
      const { startMs, endMs } = resolveRange(state.range);
      const offset = compareOffsetMs(state.compare, endMs - startMs);
      if (!opts.silent) setLoading(true);
      setError(null);
      setSlow(false);
      const slowTimer = window.setTimeout(() => my === seq.current && setSlow(true), 4000);
      const base = { sources, mode: state.mode, resolution: 'auto' as const, max_points: 1500 };
      try {
        const res = await queryHistorianSeries(
          { ...base, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), ...(offset ? { compare_offset: offset } : {}) },
          ctrl.signal,
        );
        // The server runs the earlier window in parallel and shifts its points onto this axis (H8/H10).
        const compare: HistorianQueryResponse | null =
          offset && res.compare && Array.isArray(res.compare.series_list) ? { ...res, series_list: res.compare.series_list, compare: null } : null;
        if (my !== seq.current) return;
        setResult({ res, compare, compareUnsupported: !!offset && !compare, startMs, endMs, fetchedAt: Date.now() });
        res.series_list.forEach((sr) => {
          if (sr.display_name && !catalog.current.has(sr.series_key))
            catalog.current.set(sr.series_key, {
              token: sr.series_key,
              kind: sr.source_kind,
              label: sr.display_name,
              name: sr.display_name,
              sub: '',
              unit: sr.unit || '',
              valueType: sr.value_type || '',
              resourceId: sr.resource_id || null,
            });
        });
      } catch (e) {
        if (ctrl.signal.aborted || my !== seq.current) return;
        setError(e);
      } finally {
        window.clearTimeout(slowTimer);
        if (my === seq.current) {
          setLoading(false);
          setSlow(false);
        }
      }
      // Appliance-wide events of the window (resets, storage changes); optional, never blocks the chart.
      // Appliance-wide resets/storage changes + the stored quality history of the selected signals (H12).
      const signalIds = sources.filter((t) => kindOfToken(t) === 'signal');
      listHistorianEvents(
        {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          types: ['EPOCH_RESET', 'STORAGE_OPERATION', ...(signalIds.length ? ['QUALITY_TRANSITION'] : [])],
          signal_ids: signalIds,
          limit: 500,
        },
        ctrl.signal,
      )
        .then((r) => my === seq.current && setEvents(r.items || []))
        .catch(() => my === seq.current && setEvents([]));
    },
    [queryKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Auto-query (debounced so ticking several series in a row sends one request).
  useEffect(() => {
    const t = window.setTimeout(() => void run(), state.sources.length ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => abortRef.current?.abort(), []);

  // Live follow: re-query after each answer (never overlapping), paused while the tab is hidden.
  const liveOn = state.live && state.range.kind === 'preset' && state.sources.length > 0;
  useEffect(() => {
    if (!liveOn || loading || error) return;
    const span = result ? result.endMs - result.startMs : 3600e3;
    const t = window.setTimeout(function tick() {
      if (document.hidden) {
        window.setTimeout(tick, 2000);
        return;
      }
      void run({ silent: true });
    }, liveIntervalMs(span));
    return () => window.clearTimeout(t);
  }, [liveOn, loading, error, result, run]);

  const cancel = () => {
    abortRef.current?.abort();
    seq.current++;
    setLoading(false);
    setSlow(false);
    showToast({ message: 'Query cancelled. The chart keeps the previous result.' });
  };

  // ------------------------------------------------------------------ derived series
  // An absolute window (zoom, pan, custom) applies at once to the points already loaded; a relative one
  // follows the last answer so "last 15 min" does not drift between refreshes.
  const win =
    state.range.kind === 'abs'
      ? { startMs: state.range.startMs, endMs: state.range.endMs }
      : result
        ? { startMs: result.startMs, endMs: result.endMs }
        : resolveRange(state.range);
  const byToken = useMemo(() => indexResponse(result?.res), [result]);
  const allSeries: Series[] = useMemo(
    () =>
      state.sources.map((tok) => {
        const sr = byToken.get(tok);
        if (!sr)
          return {
            token: tok,
            label: labelOf(tok),
            unit: catalog.current.get(tok)?.unit || '',
            valueType: catalog.current.get(tok)?.valueType || '',
            color: colorOf(tok),
            discrete: false,
            integer: false,
            status: 'LOADING',
            fidelity: '',
            total: 0,
            downsampled: false,
            bucketMs: null,
            truncated: false,
            notes: [],
            points: [],
            serverStats: null,
            segments: null,
            changeOnly: false,
          } as Series;
        return normalizeSeries(sr, colorOf(tok), labelOf(tok));
      }),
    [state.sources, byToken, labelOf, colorOf],
  );
  const visible = allSeries.filter((s) => !state.hidden.includes(s.token) && s.status !== 'LOADING');
  const compareSeries: Series[] = useMemo(() => {
    if (!result?.compare) return [];
    const idx = indexResponse(result.compare);
    return state.sources
      .filter((t) => !state.hidden.includes(t))
      .map((t) => idx.get(t))
      .filter((sr): sr is NonNullable<typeof sr> => Boolean(sr))
      .map((sr) => {
        return normalizeSeries(sr, colorOf(sr.series_key), labelOf(sr.series_key), true);
      });
  }, [result, state.sources, state.hidden, colorOf, labelOf]);
  const compareLabel = COMPARE_OPTIONS.find((c) => c.id === state.compare)?.label.toLowerCase();

  const gapsBySeries = useMemo(() => {
    const m = new Map<string, Gap[]>();
    for (const s of allSeries) m.set(s.token, findGaps(s, win.startMs, win.endMs));
    for (const c of compareSeries) m.set(`cmp:${c.token}`, []);
    return m;
  }, [allSeries, compareSeries, win.startMs, win.endMs]);

  const eventRows: EventRow[] = useMemo(() => {
    const out: EventRow[] = [];
    const byToken = new Map(allSeries.map((s) => [s.token, s]));
    // Signals: quality transitions from the stored history (H12). A response without `from_state` is the old
    // "current state" feed and is ignored.
    const serverTransitions = events.filter((e) => e.kind === 'QUALITY_TRANSITION' && e.from_state != null && e.signal_id);
    const covered = new Set(serverTransitions.map((e) => String(e.signal_id)));
    for (const e of serverTransitions) {
      const t = Date.parse(e.ts);
      const s = byToken.get(String(e.signal_id));
      if (!Number.isFinite(t) || !s) continue;
      const until = e.until ? Date.parse(e.until) : NaN;
      out.push({
        id: `q-${s.token}-${t}`,
        t,
        kind: 'quality',
        series: s,
        title: `Quality ${e.from_state} → ${e.to_state}`,
        detail: [e.samples != null ? `${e.samples.toLocaleString()} rows` : '', Number.isFinite(until) ? `until ${formatClock(until)}` : ''].filter(Boolean).join(' · ') || undefined,
      });
    }
    for (const s of allSeries) {
      // Model fields / recorded tables (and signals of an older Center): changes between the quality runs shown.
      if (!covered.has(s.token) && !(kindOfToken(s.token) === 'signal' && s.serverStats && 'gap_threshold_ms' in s.serverStats)) {
        const segs = qualitySegments(s, win.startMs, win.endMs).filter((g) => g.q !== 'GAP');
        for (let i = 1; i < segs.length; i++)
          if (segs[i].q !== segs[i - 1].q)
            out.push({ id: `q-${s.token}-${segs[i].startMs}`, t: segs[i].startMs, kind: 'quality', series: s, title: `Quality ${segs[i - 1].q} → ${segs[i].q}` });
      }
      for (const g of gapsBySeries.get(s.token) || [])
        out.push({ id: `g-${s.token}-${g.startMs}`, t: g.startMs, kind: 'gap', series: s, title: `No data for ${formatDuration(g.endMs - g.startMs)}`, detail: `${formatClock(g.startMs)} → ${formatClock(g.endMs)}` });
    }
    for (const e of events) {
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t)) continue;
      if (e.kind !== 'EPOCH_RESET' && e.kind !== 'STORAGE_OPERATION') continue;
      out.push({ id: `e-${e.id}`, t, kind: e.kind === 'EPOCH_RESET' ? 'reset' : 'storage', title: e.summary || e.kind, detail: e.message });
    }
    return out.sort((a, b) => b.t - a.t);
  }, [allSeries, gapsBySeries, events, win.startMs, win.endMs]);

  const markers: ChartMarker[] = useMemo(
    () =>
      eventRows
        .filter((e) => e.kind !== 'storage' && (!e.series || !state.hidden.includes(e.series.token)))
        .map((e) => ({ t: e.t, kind: e.kind, label: `${e.series ? `${e.series.label}: ` : ''}${e.title}` })),
    [eventRows, state.hidden],
  );

  const totalRows = allSeries.reduce((a, s) => a + (s.total || 0), 0);
  const allNoData = result && allSeries.length > 0 && allSeries.every((s) => s.status !== 'OK' && s.status !== 'LOADING');
  const notes = [
    ...(result?.compareUnsupported ? ['Comparison needs a newer Center version (the server computes the earlier period).'] : []),
    ...Array.from(new Set(allSeries.flatMap((s) => s.notes))),
  ].slice(0, 6);
  const downsampled = allSeries.some((s) => s.downsampled);

  // ------------------------------------------------------------------ actions
  const toggleSource = (it: PickItem) => {
    if (state.sources.includes(it.token)) {
      patch({ sources: state.sources.filter((t) => t !== it.token), hidden: state.hidden.filter((h) => h !== it.token) });
      return;
    }
    if (state.sources.length >= MAX_SERIES) {
      showToast({ message: `At most ${MAX_SERIES} series can be shown at once. Remove one first.`, tone: 'error' });
      return;
    }
    catalog.current.set(it.token, it);
    patch({ sources: [...state.sources, it.token] });
  };
  const removeSource = (token: string) => patch({ sources: state.sources.filter((t) => t !== token), hidden: state.hidden.filter((h) => h !== token) });
  const toggleHidden = (token: string) => patch({ hidden: state.hidden.includes(token) ? state.hidden.filter((h) => h !== token) : [...state.hidden, token] });

  const [zoomStack, setZoomStack] = useState<RangeState[]>([]);
  const setRange = (range: RangeState, pushZoom = false) => {
    if (pushZoom) setZoomStack((z) => [...z.slice(-19), state.range]);
    else setZoomStack([]);
    patch({ range, live: range.kind === 'preset' ? state.live : false });
  };
  const onBrush = (a: number, b: number) => setRange({ kind: 'abs', startMs: a, endMs: b }, true);
  const zoomBack = () => {
    const prev = zoomStack[zoomStack.length - 1];
    if (!prev) return;
    setZoomStack((z) => z.slice(0, -1));
    patch({ range: prev });
  };
  const pan = (dir: -1 | 1) => {
    const span = win.endMs - win.startMs;
    const shift = Math.round(span / 2) * dir;
    const end = Math.min(Date.now(), win.endMs + shift);
    setRange({ kind: 'abs', startMs: end - span, endMs: end }, true);
  };
  const zoomOut = () => {
    const span = Math.min(MAX_RANGE_MS, (win.endMs - win.startMs) * 2);
    const mid = (win.startMs + win.endMs) / 2;
    const end = Math.min(Date.now(), mid + span / 2);
    setRange({ kind: 'abs', startMs: Math.round(end - span), endMs: Math.round(end) }, true);
  };
  const zoomAround = (t: number) => {
    const span = Math.max(60e3, (win.endMs - win.startMs) / 10);
    setRange({ kind: 'abs', startMs: Math.round(t - span / 2), endMs: Math.round(Math.min(Date.now(), t + span / 2)) }, true);
    patch({ tab: 'trend' });
  };
  const atNow = Date.now() - win.endMs < 5000;

  // custom range inputs
  const [customOpen, setCustomOpen] = useState(state.range.kind === 'abs');
  const [customFrom, setCustomFrom] = useState(toLocalInput(win.startMs));
  const [customTo, setCustomTo] = useState(toLocalInput(win.endMs));
  useEffect(() => {
    if (state.range.kind === 'abs') {
      setCustomFrom(toLocalInput(state.range.startMs));
      setCustomTo(toLocalInput(state.range.endMs));
    }
  }, [state.range]);
  const customA = fromLocalInput(customFrom);
  const customB = fromLocalInput(customTo);
  const customError =
    customA == null || customB == null ? 'Enter a start and an end.' : customB <= customA ? 'The end must be after the start.' : customB - customA > MAX_RANGE_MS ? 'At most 366 days.' : null;

  // copy link
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast({ message: 'Link copied. It opens this exact view (series, range, mode and chart settings).', tone: 'success' });
    } catch {
      showToast({ message: 'The browser blocked the clipboard. Copy the address bar instead.', tone: 'error' });
    }
  };

  // ------------------------------------------------------------------ saved views
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [viewsLoading, setViewsLoading] = useState(false);
  const [viewsError, setViewsError] = useState<string | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openView, setOpenView] = useState<SavedView | null>(null);
  const loadViews = useCallback(async () => {
    setViewsLoading(true);
    setViewsError(null);
    try {
      setViews(await listSavedViews());
    } catch (e) {
      setViewsError(errorText(e));
    } finally {
      setViewsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadViews();
  }, [loadViews]);
  const labelsMap = () => Object.fromEntries(state.sources.map((t) => [t, labelOf(t)]));
  const applyView = (v: SavedView) => {
    const next = stateFromSpec(v.query_spec || { sources: [] });
    Object.entries(v.query_spec?.labels || {}).forEach(([tok, label]) => {
      if (!catalog.current.has(tok)) catalog.current.set(tok, { token: tok, kind: kindOfToken(tok), label: String(label), name: String(label), sub: '', unit: '', valueType: '', resourceId: null });
    });
    setZoomStack([]);
    setState(next);
    setOpenView(v);
    setViewsOpen(false);
    showToast({ message: `Opened view “${v.name}”.` });
  };
  const viewDirty = openView ? !sameState(stateFromSpec(openView.query_spec || { sources: [] }), { ...state, tab: stateFromSpec(openView.query_spec || { sources: [] }).tab }) : false;
  const doSave = async (name: string, description: string, asNew: boolean) => {
    setSaveBusy(true);
    setSaveError(null);
    const spec = specFromState(state, labelsMap());
    try {
      let v: SavedView;
      if (openView && !asNew) {
        try {
          v = await updateView(openView.id, openView.version, { name, description, query_spec: spec });
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (status === 409) throw new Error('Someone else changed this view after you opened it. Reopen it, or save yours as a new view.');
          if (status === 404 || status === 405) throw new Error('This server cannot update views yet. Use “Save as new view”.');
          throw e;
        }
      } else v = await saveView({ name, description, query_spec: spec, chart_options: { layout: state.layout } });
      setOpenView(v);
      setSaveOpen(false);
      void loadViews();
      showToast({ message: `Saved view “${v.name}”.`, tone: 'success' });
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaveBusy(false);
    }
  };
  const doDeleteView = async (v: SavedView) => {
    try {
      await deleteView(v.id);
      if (openView?.id === v.id) setOpenView(null);
      showToast({ message: `Deleted view “${v.name}”.` });
      void loadViews();
    } catch (e) {
      setViewsError(errorText(e));
    }
  };

  // ------------------------------------------------------------------ exports
  const [jobs, setJobs] = useState<ExportJob[] | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<{ fmt: 'csv' | 'json'; startedAt: number; ctrl: AbortController } | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!exporting) return;
    const t = window.setInterval(() => forceTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [exporting]);
  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      setJobs(await listExportJobs());
    } catch (e) {
      setJobsError(errorText(e));
    } finally {
      setJobsLoading(false);
    }
  }, []);
  useEffect(() => {
    if (state.tab === 'exports' && jobs === null) void loadJobs();
  }, [state.tab, jobs, loadJobs]);
  const triggerDownload = (j: ExportJob) => {
    if (!j.download_url) return;
    const a = document.createElement('a');
    a.href = j.download_url;
    if (j.file_name) a.download = j.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const doExport = async (fmt: 'csv' | 'json') => {
    if (!state.sources.length || exporting) return;
    const ctrl = new AbortController();
    setExporting({ fmt, startedAt: Date.now(), ctrl });
    const { startMs, endMs } = resolveRange(state.range);
    const first = labelOf(state.sources[0]);
    const stamp = formatDateTime(startMs).replace(/[: ]/g, '').replace(/-/g, '').slice(0, 13);
    const fileName = `historian_${safeFilePart(first)}${state.sources.length > 1 ? `_and_${state.sources.length - 1}_more` : ''}_${stamp}.${fmt}`;
    try {
      const job = await createExportJob(
        {
          sources: state.sources,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          from_ts: new Date(startMs).toISOString(),
          to_ts: new Date(endMs).toISOString(),
          mode: state.mode,
          format: fmt,
          file_name: fileName,
          title: `${state.sources.map(labelOf).slice(0, 3).join(', ')}${state.sources.length > 3 ? ` +${state.sources.length - 3}` : ''} · ${rangeLabel(state.range)}`,
          labels: labelsMap(),
        },
        ctrl.signal,
      );
      setJobs((prev) => [job, ...(prev || []).filter((j) => j.id !== job.id)]);
      const ready = ['COMPLETED', 'READY'].includes(String(job.status).toUpperCase());
      if (ready) triggerDownload(job);
      showToast({
        tone: job.truncated_series?.length ? 'error' : 'success',
        message: ready
          ? `${fmt.toUpperCase()} export ready: ${(job.row_count ?? 0).toLocaleString()} rows · ${formatBytes(job.byte_size)}.${job.truncated_series?.length ? ` Row limit reached for ${job.truncated_series.join(', ')}.` : ''}`
          : `Export ${String(job.status).toLowerCase()}. Follow it in the Exports tab.`,
        action: ready ? { label: 'Download again', run: () => triggerDownload(job) } : { label: 'Open exports', run: () => patch({ tab: 'exports' }) },
      });
    } catch (e) {
      if (!ctrl.signal.aborted) showToast({ tone: 'error', message: `Export failed: ${errorText(e)}` });
    } finally {
      setExporting(null);
    }
  };
  const doRetry = async (j: ExportJob) => {
    try {
      const nj = await retryExportJob(j.id);
      setJobs((prev) => [nj, ...(prev || [])]);
      showToast({ message: 'Export created again.', tone: 'success' });
    } catch (e) {
      showToast({ tone: 'error', message: `Could not run the export again: ${errorText(e)}` });
    }
  };

  // ------------------------------------------------------------------ inspector & mobile picker
  const [inspect, setInspect] = useState<{ s: Series; p: Pt } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(state.sources.length === 0);
  const lastSelection = useMemo(() => (state.sources.length ? [] : readLastSelection()), [state.sources.length]);

  const modeDef = MODES.find((m) => m.id === state.mode)!;
  const [explainOpen, setExplainOpen] = useState(false);

  const exportSummary = state.sources.length
    ? `${state.sources.length} series · ${rangeLabel(state.range)} · ${modeDef.label}${totalRows ? ` · about ${totalRows.toLocaleString()} rows` : ''}. Every stored row is exported (not the chart buckets); times are UTC ISO-8601.`
    : 'Pick at least one series first.';

  // ------------------------------------------------------------------ render
  const header = (
    <PageHeader
      title="Historian"
      subtitle={
        <>
          Explore time-series values, state changes and stored records.
          {openView && (
            <span className="ml-1 text-[#334568]">
              View: <span className="font-semibold">{openView.name}</span>
              {viewDirty && <span className="ml-1 text-amber-700 font-semibold">· unsaved changes</span>}
            </span>
          )}
        </>
      }
      actions={
        <>
          <MenuButton
            label="Views"
            icon={<FolderOpen className="w-4 h-4" />}
            ariaLabel="Saved views"
            items={[
              { key: 'manage', label: views && views.length ? `Open a saved view… (${views.length})` : 'Saved views…', icon: <FolderOpen className="w-3.5 h-3.5" />, onSelect: () => { setViewsOpen(true); void loadViews(); } },
              ...(views || []).slice(0, 6).map((v) => ({ key: v.id, label: v.name, icon: <History className="w-3.5 h-3.5" />, onSelect: () => applyView(v) })),
              ...(openView ? [{ key: 'close', label: `Close view “${openView.name}”`, icon: <X className="w-3.5 h-3.5" />, onSelect: () => setOpenView(null) }] : []),
            ]}
          />
          <Button variant="outline" size="md" icon={<Save className="w-4 h-4" />} disabled={!state.sources.length} onClick={() => { setSaveError(null); setSaveOpen(true); }}>
            {openView ? 'Save view' : 'Save view…'}
          </Button>
          <Button variant="outline" size="md" icon={<Link2 className="w-4 h-4" />} onClick={() => void copyLink()} title="Copy a link to this exact view">
            Copy link
          </Button>
          <MenuButton
            label={exporting ? 'Exporting…' : 'Export'}
            icon={<Download className="w-4 h-4" />}
            items={[
              { key: 'csv', label: 'Export CSV', icon: <FileSpreadsheet className="w-3.5 h-3.5" />, disabled: !state.sources.length || !!exporting, hint: state.sources.length ? undefined : 'Pick a series first', onSelect: () => void doExport('csv') },
              { key: 'json', label: 'Export JSON', icon: <FileJson className="w-3.5 h-3.5" />, disabled: !state.sources.length || !!exporting, hint: state.sources.length ? undefined : 'Pick a series first', onSelect: () => void doExport('json') },
              { key: 'hist', label: 'Export history', icon: <History className="w-3.5 h-3.5" />, onSelect: () => patch({ tab: 'exports' }) },
            ]}
          />
        </>
      }
    />
  );

  const toolbar = (
    <div className="bg-white border border-[#CBD5E1] rounded-xl p-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="History mode"
          value={state.mode}
          onChange={(m) => patch({ mode: m })}
          options={MODES.map((m) => ({ id: m.id, label: m.label, title: m.explain }))}
        />
        <button
          type="button"
          onClick={() => setExplainOpen((v) => !v)}
          aria-expanded={explainOpen}
          className="inline-flex items-center gap-1 h-8 px-2 rounded-lg text-[12px] font-semibold text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37]"
        >
          <Info className="w-3.5 h-3.5" /> What is the difference?
        </button>
        <span className="hidden xl:block w-px h-6 bg-[#E3EAF3]" aria-hidden="true" />
        <Segmented
          ariaLabel="Time range"
          value={state.range.kind === 'preset' && !customOpen ? state.range.preset : 'custom'}
          onChange={(id) => {
            if (id === 'custom') {
              setCustomOpen(true);
              return;
            }
            setCustomOpen(false);
            setRange({ kind: 'preset', preset: id });
          }}
          options={[...RANGE_PRESETS.map((p) => ({ id: p.id, label: p.label, title: `Last ${p.label}` })), { id: 'custom', label: 'Custom' }]}
        />
        <Button
          size="sm"
          variant={liveOn ? 'primary' : 'outline'}
          icon={<Radio className={`w-3.5 h-3.5 ${liveOn ? 'animate-pulse' : ''}`} />}
          aria-pressed={liveOn}
          disabled={state.range.kind !== 'preset' || !state.sources.length}
          title={state.range.kind !== 'preset' ? 'Live follow works with “last …” ranges' : `Refresh every ${liveIntervalMs(win.endMs - win.startMs) / 1000} s and keep the window ending now`}
          onClick={() => patch({ live: !state.live })}
        >
          {liveOn ? 'Live' : 'Follow live'}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-[#657794] tabular-nums" aria-live="polite">
            {loading ? (slow ? 'Still loading… long windows take longer on a busy appliance' : 'Loading…') : result ? `Updated ${formatClock(result.fetchedAt)}` : ''}
          </span>
          {loading && slow ? (
            <Button size="sm" variant="outline" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="outline" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} disabled={!state.sources.length || loading} onClick={() => void run()}>
              Refresh
            </Button>
          )}
        </div>
      </div>
      {customOpen && (
        <form
          className="flex flex-wrap items-end gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!customError && customA != null && customB != null) setRange({ kind: 'abs', startMs: customA, endMs: customB });
          }}
        >
          <label className="text-[11px] font-semibold text-[#334568]">
            From
            <input type="datetime-local" step={1} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className={`${selectCls} block mt-0.5 h-8`} />
          </label>
          <label className="text-[11px] font-semibold text-[#334568]">
            To
            <input type="datetime-local" step={1} value={customTo} onChange={(e) => setCustomTo(e.target.value)} className={`${selectCls} block mt-0.5 h-8`} />
          </label>
          <Button type="submit" size="sm" variant="primary" disabled={!!customError}>
            Apply
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setCustomOpen(false); if (state.range.kind === 'abs') setRange({ kind: 'preset', preset: '1h' }); }}>
            Back to presets
          </Button>
          <span className="text-[11px] text-[#657794]">{customError || `Times in ${TZ_LABEL}`}</span>
        </form>
      )}
      <p className="text-[12px] text-[#657794] px-0.5">
        <span className="font-semibold text-[#334568]">{modeDef.label}:</span> {modeDef.explain}
      </p>
      {explainOpen && (
        <Banner tone="info" onClose={() => setExplainOpen(false)}>
          <ul className="space-y-1">
            {MODES.map((m) => (
              <li key={m.id}>
                <span className="font-semibold">{m.label}</span> — {m.explain}
              </li>
            ))}
            <li>
              Example: a machine status read every second that changes twice in an hour shows ~3,600 raw readings, 2–3 recorded rows, and a reconstructed line that
              looks like the raw one but is drawn from those few rows.
            </li>
          </ul>
        </Banner>
      )}
    </div>
  );

  const legend = (
    <div className="flex flex-wrap items-center gap-1.5" role="list" aria-label="Selected series">
      {allSeries.map((s) => {
        const hidden = state.hidden.includes(s.token);
        const st = statusText(s.status);
        return (
          <span
            key={s.token}
            role="listitem"
            className={`inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-full border text-[12px] max-w-full ${hidden ? 'bg-white border-dashed border-[#CBD5E1] text-[#94A3B8]' : 'bg-white border-[#D4DFEC] text-[#334568]'}`}
            title={`${s.label}${s.unit ? ` (${s.unit})` : ''}${st ? ` — ${st}` : ''}`}
          >
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: hidden ? '#CBD5E1' : s.color }} aria-hidden="true" />
            <span className="truncate max-w-[220px] font-semibold">{s.label}</span>
            {s.unit && <span className="text-[11px] text-[#94A3B8]">{s.unit}</span>}
            {s.status === 'LOADING' && <RefreshCw className="w-3 h-3 animate-spin text-[#94A3B8]" aria-label="loading" />}
            {st && <span className="text-[10px] font-semibold text-amber-700">{st}</span>}
            <button type="button" onClick={() => toggleHidden(s.token)} aria-label={hidden ? `Show ${s.label}` : `Hide ${s.label}`} className="p-0.5 rounded-full hover:bg-slate-100">
              {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
            <button type="button" onClick={() => removeSource(s.token)} aria-label={`Remove ${s.label}`} className="p-0.5 rounded-full hover:bg-slate-100">
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        );
      })}
    </div>
  );

  const chartControls = (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        ariaLabel="Chart layout"
        size="sm"
        value={state.layout}
        onChange={(l) => patch({ layout: l })}
        options={[
          { id: 'overlay', label: 'One chart', icon: <Columns3 className="w-3.5 h-3.5" />, title: 'All series in one chart, one axis per unit' },
          { id: 'lanes', label: 'Split by unit', icon: <Rows3 className="w-3.5 h-3.5" />, title: 'One chart per unit, shared time axis' },
        ]}
      />
      <select className={selectCls} value={state.compare} onChange={(e) => patch({ compare: e.target.value as CompareOffset })} aria-label="Compare with">
        {COMPARE_OPTIONS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id ? `Compare: ${c.label}` : c.label}
          </option>
        ))}
      </select>
      <span className="inline-flex items-center gap-1">
        <Button size="sm" variant="outline" aria-label="Earlier" title="Move half a window earlier" onClick={() => pan(-1)}>
          <ChevronLeft className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" variant="outline" icon={<ZoomOut className="w-3.5 h-3.5" />} onClick={zoomOut} title="Show twice the time span">
          Zoom out
        </Button>
        <Button size="sm" variant="outline" aria-label="Later" title="Move half a window later" disabled={atNow} onClick={() => pan(1)}>
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
        {zoomStack.length > 0 && (
          <Button size="sm" variant="ghost" onClick={zoomBack} title="Back to the previous range">
            Undo zoom
          </Button>
        )}
      </span>
    </div>
  );

  const trendBody = (() => {
    if (error) return <ErrorBanner error={error} subject="the history" onRetry={() => void run()} />;
    if (!result && loading)
      return (
        <div className="space-y-3" aria-busy="true" aria-label="Loading history">
          <Skeleton className="h-[300px] w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      );
    if (!result) return null;
    return (
      <div className="space-y-3">
        {allNoData && (
          <Banner
            tone="info"
            action={
              state.range.kind !== 'preset' || state.range.preset !== '24h' ? (
                <Button size="sm" variant="outline" onClick={() => setRange({ kind: 'preset', preset: '24h' })}>
                  Try the last 24 h
                </Button>
              ) : undefined
            }
          >
            No stored rows for the selected series in this window.
            {state.mode !== 'operational' && ' Recorded and reconstructed views only show what your recording rules stored — try Raw readings to see every reading.'}
          </Banner>
        )}
        <HistorianTrendChart
          series={visible}
          compareSeries={compareSeries}
          compareLabel={compareLabel}
          mode={state.mode}
          layout={state.layout}
          startMs={win.startMs}
          endMs={win.endMs}
          markers={markers}
          gapsBySeries={gapsBySeries}
          loading={loading}
          onBrush={onBrush}
          onPick={(s, p) => setInspect({ s, p })}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#657794]">
          <span>
            {formatDateTime(win.startMs)} → {formatDateTime(win.endMs)} · times in {TZ_LABEL}
          </span>
          <span>Drag on the chart to zoom · click a point to inspect it</span>
          <span className="inline-flex items-center gap-2">
            {(['GOOD', 'UNCERTAIN', 'STALE', 'BAD', 'GAP'] as const).map((q) => (
              <span key={q} className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2 rounded-sm" style={{ background: { GOOD: '#0DBA67', UNCERTAIN: '#F59E0B', STALE: '#94A3B8', BAD: '#EF4444', GAP: '#E2E8F0' }[q] }} aria-hidden="true" />
                {{ GOOD: 'Good', UNCERTAIN: 'Uncertain', STALE: 'Stale', BAD: 'Bad', GAP: 'No data' }[q]}
              </span>
            ))}
          </span>
          {compareSeries.length > 0 && <span>Dashed = {compareLabel}</span>}
          {downsampled && <span className="font-semibold text-[#334568]">Long range: values are averaged per time bucket on the server (band = min/max).</span>}
        </div>
        {notes.length > 0 && (
          <ul className="text-[11px] text-[#657794] space-y-0.5">
            {notes.map((n) => (
              <li key={n}>· {n}</li>
            ))}
          </ul>
        )}
        <div>
          <h3 className="text-[13px] font-bold text-[#111B37] mb-1.5">Statistics of this window</h3>
          <StatsTable series={allSeries.filter((s) => s.status !== 'LOADING')} compare={compareSeries} compareLabel={compareLabel} mode={state.mode} startMs={win.startMs} endMs={win.endMs} hidden={state.hidden} />
          <p className="mt-1 text-[11px] text-[#94A3B8]">Per series only — values with different units are never combined.</p>
        </div>
      </div>
    );
  })();

  return (
    <div className="space-y-4 min-w-0">
      {header}
      {toolbar}
      {result && !result.res.history_available && (
        <Banner tone="warning">
          The time-series store (TDengine) is not configured on this appliance. Values come from PostgreSQL observations, which keep only a short history.
        </Banner>
      )}
      {exporting && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] text-blue-900">
          <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
          <span className="flex-1 min-w-0">
            Preparing {exporting.fmt.toUpperCase()} export of {state.sources.length} series{totalRows ? ` (about ${totalRows.toLocaleString()} rows)` : ''}… {Math.round((Date.now() - exporting.startedAt) / 1000)} s
          </span>
          <div className="w-40 h-1.5 rounded-full bg-blue-100 overflow-hidden" aria-hidden="true">
            <div className="h-full w-1/3 bg-blue-500 animate-pulse" />
          </div>
          <Button size="sm" variant="outline" onClick={() => exporting.ctrl.abort()}>
            Cancel
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-4 items-start">
        {/* Source picker: a panel on the left; collapsible above the chart on small screens */}
        <aside className="bg-white border border-[#CBD5E1] rounded-xl overflow-hidden lg:sticky lg:top-[calc(var(--fx-topbar-height)+var(--fx-banner-height,0px)+16px)]">
          <button
            type="button"
            className="lg:hidden w-full flex items-center justify-between px-3 py-2.5 text-[13px] font-bold text-[#111B37]"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
          >
            <span>
              Series · {state.sources.length}/{MAX_SERIES}
            </span>
            <ChevronDown className={`w-4 h-4 transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
          </button>
          <div className={`${pickerOpen ? 'block' : 'hidden'} lg:block border-t border-[#E3EAF3] lg:border-t-0`}>
            <SeriesPicker
              className="h-[60vh] lg:h-[calc(100vh-var(--fx-topbar-height)-var(--fx-banner-height,0px)-150px)] lg:min-h-[480px]"
              selected={state.sources}
              colorOf={colorOf}
              onToggle={toggleSource}
              onClear={() => patch({ sources: [], hidden: [] })}
              onCatalog={onCatalog}
            />
          </div>
        </aside>

        <section className="min-w-0 space-y-3" aria-label="Trend workspace">
          {state.sources.length === 0 ? (
            <EmptyState
              icon={<LineChartIcon className="w-6 h-6" />}
              title="Choose what to look at"
              action={
                <>
                  {lastSelection.length > 0 && (
                    <Button variant="primary" size="sm" icon={<History className="w-3.5 h-3.5" />} onClick={() => patch({ sources: lastSelection })}>
                      Restore last selection ({lastSelection.length})
                    </Button>
                  )}
                  {(views || []).slice(0, 3).map((v) => (
                    <Button key={v.id} variant="outline" size="sm" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={() => applyView(v)}>
                      {v.name}
                    </Button>
                  ))}
                </>
              }
            >
              <p>
                Tick signals, Data Model fields or recorded tables in the Factory Model on the left (up to {MAX_SERIES}). Series with different units get their own axis;
                text and on/off values are drawn as state bands.
              </p>
              <p className="mt-1">Tip: “Open in Historian” on a signal or a recorded table opens it here directly.</p>
            </EmptyState>
          ) : (
            <div className="bg-white border border-[#CBD5E1] rounded-xl p-3 sm:p-4 space-y-3 min-w-0">
              <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-3">
                {legend}
                {state.tab === 'trend' && chartControls}
              </div>
              <Tabs
                activeTab={state.tab}
                onChange={(id) => patch({ tab: id as HistorianTab })}
                tabs={[
                  { id: 'trend', label: 'Trend' },
                  { id: 'records', label: downsampled ? 'Records (buckets)' : 'Records', count: totalRows ? totalRows.toLocaleString() : undefined },
                  { id: 'events', label: 'Events', count: eventRows.filter((e) => e.kind !== 'storage').length },
                  { id: 'exports', label: 'Exports', count: jobs ? jobs.length : undefined },
                ]}
                className="overflow-x-auto"
              />
              {state.tab === 'trend' && trendBody}
              {state.tab === 'records' &&
                (error ? (
                  <ErrorBanner error={error} subject="the records" onRetry={() => void run()} />
                ) : !result ? (
                  <Skeleton className="h-64 w-full" />
                ) : (
                  <RecordsTable series={allSeries.filter((s) => s.status !== 'LOADING')} onInspect={(s, p) => setInspect({ s, p })} onZoomRaw={() => setRange({ kind: 'preset', preset: '15m' })} />
                ))}
              {state.tab === 'events' && <EventsList events={eventRows} onJump={(e) => zoomAround(e.t)} />}
              {state.tab === 'exports' && (
                <ExportsPanel
                  jobs={jobs}
                  loading={jobsLoading}
                  error={jobsError}
                  onReload={() => void loadJobs()}
                  onRetry={(j) => void doRetry(j)}
                  labelOf={labelOf}
                  canExport={state.sources.length > 0}
                  exporting={!!exporting}
                  onExport={(f) => void doExport(f)}
                  summary={exportSummary}
                />
              )}
            </div>
          )}
          {state.sources.length === 0 && state.tab === 'exports' && (
            <div className="bg-white border border-[#CBD5E1] rounded-xl p-4">
              <ExportsPanel
                jobs={jobs}
                loading={jobsLoading}
                error={jobsError}
                onReload={() => void loadJobs()}
                onRetry={(j) => void doRetry(j)}
                labelOf={labelOf}
                canExport={false}
                exporting={false}
                onExport={() => undefined}
                summary={exportSummary}
              />
            </div>
          )}
        </section>
      </div>

      <PointInspector target={inspect} onClose={() => setInspect(null)} onZoom={(t) => { setInspect(null); zoomAround(t); }} />
      <SaveViewDialog open={saveOpen} initialName={state.sources.length ? `${labelOf(state.sources[0])}${state.sources.length > 1 ? ` +${state.sources.length - 1}` : ''} · ${rangeLabel(state.range)}` : ''} current={openView} busy={saveBusy} error={saveError} onClose={() => setSaveOpen(false)} onSave={(n, d, asNew) => void doSave(n, d, asNew)} />
      <ViewsDialog open={viewsOpen} views={views} loading={viewsLoading} error={viewsError} onClose={() => setViewsOpen(false)} onOpen={applyView} onDelete={(v) => void doDeleteView(v)} onReload={() => void loadViews()} currentId={openView?.id} />
      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
};

export default HistorianExplorerPage;
