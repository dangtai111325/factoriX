/**
 * View mode (/dashboards/:dashboardId): the published revision, read-only. Variables and the time range
 * are kept in the URL (`?var-<id>=<uuid>&range=1h` or `from`/`to`), validated against the document and
 * the Factory Model. Kiosk (`?kiosk=1`) shows the canvas alone, optionally in browser full screen.
 * Widgets offer read-only actions only (data table, full-screen widget); links go through the allowlist.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Archive, ArrowLeft, LayoutDashboard, Maximize, Minimize, Pencil } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { useNow } from '../13_DataModels/ui';
import { EmptyState, ErrorBanner, LoadingBlock } from '../historian/hsUi';
import { errorInfo, getDashboard, getPublished } from '../../features/dashboard/api';
import { DashboardCanvas } from '../../features/dashboard/components/DashboardCanvas';
import { LiveIndicator, RefreshSelect, TimeRangePicker, VariableBar } from '../../features/dashboard/components/controls';
import { WidgetDataDialog, WidgetFullscreenDialog } from '../../features/dashboard/components/WidgetDialogs';
import { normalizeDocument } from '../../features/dashboard/document';
import { isUuid, navUrl } from '../../features/dashboard/nav';
import { useThemePresets, useWidgetRegistry } from '../../features/dashboard/registry';
import { DashboardRuntimeProvider, useRuntimeStatus } from '../../features/dashboard/runtime/RuntimeProvider';
import { useSourceCatalog } from '../../features/dashboard/sources';
import { resolveTheme } from '../../features/dashboard/theme';
import { isRefreshPolicy, rangeFromParams, sameRange, writeRangeParams } from '../../features/dashboard/timeRange';
import type { DashboardDocument, DashboardWidget, NavTarget, PublishedDashboard, RefreshPolicy, SourceResource, TimeRange } from '../../features/dashboard/types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; dash: PublishedDashboard; doc: DashboardDocument }
  | { kind: 'not_published'; name: string; description: string }
  | { kind: 'archived'; name: string }
  | { kind: 'not_found' }
  | { kind: 'error'; error: unknown };

/** Variable values from the URL, validated (UUID, known resource of the right type when the catalog is loaded). */
function variablesFrom(doc: DashboardDocument, params: URLSearchParams, resources: Map<string, SourceResource> | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const v of doc.variables) {
    const raw = params.get(`var-${v.id}`);
    let value: string | null = v.default ?? null;
    if (raw !== null) {
      if (raw === '' || raw === 'none') value = null;
      else if (isUuid(raw)) {
        const r = resources?.get(raw);
        if (!resources || (r && (!v.resource_type || r.type_key === v.resource_type))) value = raw;
      }
    }
    out[v.id] = value;
  }
  return out;
}

export const DashboardViewPage: React.FC = () => {
  const { dashboardId = '' } = useParams();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    if (!isUuid(dashboardId)) {
      // A malformed id (e.g. /dashboards/templates) is simply not a dashboard: no request, no retry banner.
      setState({ kind: 'not_found' });
      return () => ctrl.abort();
    }
    setState({ kind: 'loading' });
    getPublished(dashboardId, ctrl.signal)
      .then((dash) =>
        // Archived dashboards stop opening for viewers (the archive dialog promises it); the Studio offers unarchive.
        setState(dash.archived_at ? { kind: 'archived', name: dash.name } : { kind: 'ready', dash, doc: normalizeDocument(dash.document) }),
      )
      .catch(async (e) => {
        if (ctrl.signal.aborted) return;
        const info = errorInfo(e);
        if (info.code === 'NOT_PUBLISHED' || (info.status === 404 && info.code !== 'NOT_FOUND')) {
          try {
            const d = await getDashboard(dashboardId, ctrl.signal);
            setState({ kind: 'not_published', name: d.name, description: d.description });
            return;
          } catch (e2) {
            if (ctrl.signal.aborted) return;
            if (errorInfo(e2).status === 404) {
              setState({ kind: 'not_found' });
              return;
            }
          }
        }
        if (info.status === 404) setState({ kind: 'not_found' });
        else setState({ kind: 'error', error: e });
      });
    return () => ctrl.abort();
  }, [dashboardId, nonce]);

  if (state.kind === 'loading') return <LoadingBlock label="Opening the dashboard…" />;
  if (state.kind === 'error')
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorBanner error={state.error} subject="the dashboard" onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  if (state.kind === 'not_found')
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState icon={<LayoutDashboard className="w-6 h-6" />} title="Dashboard not found" action={<Link to="/dashboards" className="fx-btn fx-btn-secondary">All dashboards</Link>}>
          It may have been archived or deleted, or the link is wrong.
        </EmptyState>
      </div>
    );
  if (state.kind === 'archived')
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState icon={<Archive className="w-6 h-6" />} title={`“${state.name}” is archived`} action={<Link to="/dashboards" className="fx-btn fx-btn-secondary">All dashboards</Link>}>
          Archived dashboards do not open. An editor can unarchive it from the Archived filter of the dashboard list.
        </EmptyState>
      </div>
    );
  if (state.kind === 'not_published')
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState
          icon={<LayoutDashboard className="w-6 h-6" />}
          title={`“${state.name}” is not published yet`}
          action={
            <Link to={`/dashboards/${dashboardId}/edit`} className="fx-btn fx-btn-primary">
              <Pencil className="w-4 h-4" aria-hidden="true" /> Edit in Studio
            </Link>
          }
        >
          Operators see the published revision of a dashboard. Open it in the Studio, bind its widgets to data and publish it.
        </EmptyState>
      </div>
    );
  return <PublishedView dashboardId={dashboardId} dash={state.dash} doc={state.doc} />;
};

const BackLink: React.FC = () => (
  <Link to="/dashboards" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#657794] hover:text-[#111B37]">
    <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> All dashboards
  </Link>
);

const PublishedView: React.FC<{ dashboardId: string; dash: PublishedDashboard; doc: DashboardDocument }> = ({ dashboardId, dash, doc }) => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { defs, limits, error: regError, loading: regLoading, reload: reloadRegistry } = useWidgetRegistry();
  const { presets } = useThemePresets();
  const { catalog, resourcesById, loading: catLoading } = useSourceCatalog(true);
  const theme = useMemo(() => resolveTheme(doc.settings.theme, presets), [doc.settings.theme, presets]);
  const { toast, show, dismiss } = useActionToast();

  const urlRange = rangeFromParams(params);
  const [timeRange, setTimeRange] = useState<TimeRange>(urlRange || doc.settings.time_range);
  const urlRefresh = params.get('refresh');
  const [refresh, setRefresh] = useState<RefreshPolicy>(isRefreshPolicy(urlRefresh) ? urlRefresh : doc.settings.refresh);
  const [variables, setVariables] = useState<Record<string, string | null>>(() => variablesFrom(doc, params, null));
  const kiosk = params.get('kiosk') === '1';

  // Re-validate URL variables once the Factory Model is known (unknown / wrong-type ids fall back to the default).
  const validatedRef = useRef(false);
  useEffect(() => {
    if (!catalog || validatedRef.current) return;
    validatedRef.current = true;
    setVariables(variablesFrom(doc, params, resourcesById));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  // URL sync (replace: changing a selector is not a navigation step).
  useEffect(() => {
    const next = new URLSearchParams(params);
    for (const key of Array.from(next.keys())) if (key.startsWith('var-')) next.delete(key);
    for (const v of doc.variables) {
      const value = variables[v.id] ?? null;
      if (value !== (v.default ?? null)) next.set(`var-${v.id}`, value ?? 'none');
    }
    writeRangeParams(next, sameRange(timeRange, doc.settings.time_range) ? null : timeRange);
    if (refresh !== doc.settings.refresh) next.set('refresh', refresh);
    else next.delete('refresh');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables, timeRange, refresh]);

  const effectiveDoc = useMemo<DashboardDocument>(() => (refresh === doc.settings.refresh ? doc : { ...doc, settings: { ...doc.settings, refresh } }), [doc, refresh]);

  const onNavigate = useCallback(
    (target: NavTarget) => {
      const rangeParams = new URLSearchParams();
      writeRangeParams(rangeParams, timeRange);
      const url = navUrl(target, { variables, range: rangeParams });
      if (url) navigate(url);
      else show({ message: 'This link target is not allowed.', tone: 'error' });
    },
    [navigate, variables, timeRange, show],
  );

  const setKiosk = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('kiosk', '1');
    else next.delete('kiosk');
    setParams(next, { replace: true });
  };

  if (regError && !defs.size)
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorBanner error={regError} subject="the widget library" onRetry={reloadRegistry} />
      </div>
    );
  if (regLoading && !defs.size) return <LoadingBlock label="Opening the dashboard…" />;

  return (
    <DashboardRuntimeProvider
      document={effectiveDoc}
      timeRange={timeRange}
      variables={variables}
      defs={defs}
      limits={limits}
      theme={theme}
      resources={resourcesById}
      mode="view"
    >
      <ViewBody
        dashboardId={dashboardId}
        dash={dash}
        doc={effectiveDoc}
        kiosk={kiosk}
        setKiosk={setKiosk}
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        refresh={refresh}
        setRefresh={setRefresh}
        variables={variables}
        setVariable={(id, value) => setVariables((prev) => ({ ...prev, [id]: value }))}
        resources={catalog?.resources || []}
        resourcesLoading={catLoading && !catalog}
        onNavigate={onNavigate}
        canvasBg={theme.canvas}
      />
      <ActionToast toast={toast} onDismiss={dismiss} />
    </DashboardRuntimeProvider>
  );
};

const ViewBody: React.FC<{
  dashboardId: string;
  dash: PublishedDashboard;
  doc: DashboardDocument;
  kiosk: boolean;
  setKiosk: (on: boolean) => void;
  timeRange: TimeRange;
  setTimeRange: (r: TimeRange) => void;
  refresh: RefreshPolicy;
  setRefresh: (r: RefreshPolicy) => void;
  variables: Record<string, string | null>;
  setVariable: (id: string, value: string | null) => void;
  resources: SourceResource[];
  resourcesLoading: boolean;
  onNavigate: (t: NavTarget) => void;
  canvasBg: string;
}> = ({ dashboardId, dash, doc, kiosk, setKiosk, timeRange, setTimeRange, refresh, setRefresh, variables, setVariable, resources, resourcesLoading, onNavigate, canvasBg }) => {
  const status = useRuntimeStatus();
  const now = useNow(5000);
  const [dataWidget, setDataWidget] = useState<DashboardWidget | null>(null);
  const [fullWidget, setFullWidget] = useState<DashboardWidget | null>(null);
  const kioskRef = useRef<HTMLDivElement>(null);
  // Stable identity: a new object per render would re-render every widget cell (WidgetCell is memoized).
  const viewActions = useMemo(() => ({ onViewData: setDataWidget, onFullscreen: setFullWidget }), []);

  // Kiosk: Escape leaves (when no dialog is open); leaving browser full screen keeps kiosk on.
  useEffect(() => {
    if (!kiosk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      if (document.fullscreenElement) return; // the browser leaves full screen first
      setKiosk(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [kiosk, setKiosk]);

  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const on = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleBrowserFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void kioskRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  const published = new Date(dash.published_at);
  const meta = `Revision ${dash.revision} · published ${Number.isFinite(published.getTime()) ? published.toLocaleString() : '—'}`;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <TimeRangePicker value={timeRange} onChange={setTimeRange} ariaLabel="Dashboard time range" />
      <RefreshSelect value={refresh} onChange={setRefresh} onRefreshNow={status.refresh} busy={status.pending > 0} />
      <LiveIndicator stream={status.stream} lastUpdateAt={status.lastUpdateAt} now={now} />
    </div>
  );

  const canvas = (
    <DashboardCanvas
      document={doc}
      mode="view"
      view={viewActions}
      onNavigate={onNavigate}
      empty={
        <div className="text-center text-[13px]" style={{ color: 'var(--dash-text-muted)' }}>
          This revision has no widget visible at this screen width.
        </div>
      }
    />
  );

  const dialogs = (
    <>
      <WidgetDataDialog widget={dataWidget} onClose={() => setDataWidget(null)} />
      <WidgetFullscreenDialog widget={fullWidget} onClose={() => setFullWidget(null)} onNavigate={onNavigate} />
    </>
  );

  if (kiosk) {
    return (
      <div ref={kioskRef} className="fixed inset-0 z-[55] overflow-y-auto" style={{ background: canvasBg }} role="region" aria-label={`${dash.name} (kiosk)`}>
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 px-3 py-2 bg-white/90 backdrop-blur border-b border-[#E3EAF3]">
          <h1 className="text-[15px] font-bold text-[#111B37] truncate mr-auto">{dash.name}</h1>
          {doc.variables.length > 0 && <VariableBar variables={doc.variables} values={variables} onChange={setVariable} resources={resources} loading={resourcesLoading} />}
          {controls}
          <Button size="sm" variant="outline" icon={isFull ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />} onClick={toggleBrowserFullscreen}>
            {isFull ? 'Exit full screen' : 'Full screen'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setKiosk(false)} title="Leave kiosk (Esc)">
            Exit kiosk
          </Button>
        </div>
        <div className="p-1">{canvas}</div>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
        <div className="min-w-0">
          <BackLink />
          <h1 className="mt-1 text-[20px] font-bold text-[#111B37] leading-tight break-words">{dash.name}</h1>
          {dash.description && <p className="text-[13px] text-[#657794] mt-0.5">{dash.description}</p>}
          <p className="text-[11px] text-[#94A3B8] mt-0.5">{meta}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button variant="outline" icon={<Maximize className="w-4 h-4" />} onClick={() => setKiosk(true)} title="Show only the dashboard (kiosk)">
            Kiosk
          </Button>
          <Link to={`/dashboards/${dashboardId}/edit`} className="fx-btn fx-btn-secondary">
            <Pencil className="w-4 h-4" aria-hidden="true" /> Edit
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-[#CBD5E1] rounded-xl p-2.5">
        {doc.variables.length > 0 ? (
          <VariableBar variables={doc.variables} values={variables} onChange={setVariable} resources={resources} loading={resourcesLoading} />
        ) : (
          <span className="text-[12px] text-[#657794]">Live values update as they arrive; history follows the refresh setting.</span>
        )}
        {controls}
      </div>
      {status.resolveError && <ErrorBanner error={new Error(status.resolveError)} subject="the data sources" onRetry={status.refresh} />}
      <div className="rounded-xl overflow-hidden border border-[#E3EAF3]" style={{ background: canvasBg }}>
        {canvas}
      </div>
      {dialogs}
    </div>
  );
};
