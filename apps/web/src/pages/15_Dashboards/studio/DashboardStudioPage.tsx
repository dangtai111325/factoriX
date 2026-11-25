/**
 * Dashboard Studio (/dashboards/:dashboardId/edit). Three areas under one toolbar:
 *   left   — Widgets / Data / Variables / Settings
 *   center — the grid canvas (react-grid-layout) at the chosen breakpoint, or a view-mode preview
 *   right  — the inspector of the selected widget
 * The draft is edited locally with undo/redo and saved explicitly (Ctrl+S); a version conflict offers
 * reload or overwrite; publishing validates first and is blocked by errors. Leaving with unsaved changes
 * asks first. The Studio covers the main navigation (it needs the width) and requires ≥ 1024 px.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileStack,
  Grid3x3,
  History,
  LayoutGrid,
  ListChecks,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  Send,
  Settings2,
  Smartphone,
  Tablet,
  Undo2,
  Variable,
  Database,
  ZoomIn,
} from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { MenuButton } from '../../../components/common/MenuButton';
import { ActionToast, useActionToast } from '../../../components/common/ActionToast';
import { useNow } from '../../13_DataModels/ui';
import { EmptyState, ErrorBanner, LoadingBlock } from '../../historian/hsUi';
import { useLeaveGuard } from '../../06_AddDataWizard/useLeaveGuard';
import {
  archiveDashboard,
  createTemplate,
  downloadJson,
  errorInfo,
  errorLine,
  exportDashboard,
  getDashboard,
  patchDashboard,
  publishDashboard,
  restoreRevision,
  safeFileName,
  unarchiveDashboard,
  validateDashboard,
} from '../../../features/dashboard/api';
import { DashboardCanvas, type CanvasEditProps } from '../../../features/dashboard/components/DashboardCanvas';
import { DashboardStatusChip, LiveIndicator, RefreshSelect, TimeRangePicker, VariableBar } from '../../../features/dashboard/components/controls';
import { WidgetDataDialog, WidgetFullscreenDialog } from '../../../features/dashboard/components/WidgetDialogs';
import {
  BREAKPOINTS,
  BREAKPOINT_LABEL,
  applyGridLayout,
  createWidget,
  documentBytes,
  duplicateWidgetIn,
  isBreakpointCustomized,
  newBinding,
  normalizeDocument,
  resetBreakpoint,
  sourceFromToken,
} from '../../../features/dashboard/document';
import { useThemePresets, useWidgetRegistry } from '../../../features/dashboard/registry';
import { DashboardRuntimeProvider, useRuntimeStatus } from '../../../features/dashboard/runtime/RuntimeProvider';
import { isUuid } from '../../../features/dashboard/nav';
import { useSourceCatalog } from '../../../features/dashboard/sources';
import { resolveTheme } from '../../../features/dashboard/theme';
import type {
  Breakpoint,
  DashboardDetail,
  DashboardDocument,
  DashboardWidget,
  NavTarget,
  RefreshPolicy,
  SourceItem,
  TimeRange,
  ValidationIssue,
  WidgetTypeDef,
} from '../../../features/dashboard/types';
import { DuplicateDialog } from '../DashboardListPage';
import { EmptyInspector, Inspector, type InspectorTab } from './Inspector';
import { DataPanel, SettingsPanel, VariablesPanel, WidgetsPanel } from './LeftPanels';
import { ConflictDialog, PublishDialog, RevisionsDialog, SaveTemplateDialog, ValidateDialog } from './StudioDialogs';
import { useEditorHistory } from './useEditorHistory';

// ------------------------------------------------------------------ page (load + guards)

function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [ok, setOk] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setOk(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return ok;
}

export const DashboardStudioPage: React.FC = () => {
  const { dashboardId = '' } = useParams();
  const wide = useMinWidth(1024);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; detail: DashboardDetail; key: number } | { kind: 'error'; error: unknown } | { kind: 'not_found' }>({
    kind: 'loading',
  });
  const [nonce, setNonce] = useState(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const detail = await getDashboard(dashboardId, signal);
        setState({ kind: 'ready', detail, key: Date.now() });
      } catch (e) {
        if (signal?.aborted) return;
        setState(errorInfo(e).status === 404 ? { kind: 'not_found' } : { kind: 'error', error: e });
      }
    },
    [dashboardId],
  );
  useEffect(() => {
    const ctrl = new AbortController();
    if (!isUuid(dashboardId)) {
      setState({ kind: 'not_found' });
      return () => ctrl.abort();
    }
    setState({ kind: 'loading' });
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, nonce]);

  if (!wide)
    return (
      <EmptyState
        icon={<Monitor className="w-6 h-6" />}
        title="The Studio needs a wider screen"
        action={
          <>
            <Link to={`/dashboards/${dashboardId}`} className="fx-btn fx-btn-secondary">
              Open the published view
            </Link>
            <Link to="/dashboards" className="fx-btn fx-btn-secondary">
              All dashboards
            </Link>
          </>
        }
      >
        Editing a dashboard needs a screen at least 1024 px wide. Viewing works on any screen.
      </EmptyState>
    );
  if (state.kind === 'loading') return <LoadingBlock label="Opening the Studio…" />;
  if (state.kind === 'not_found')
    return (
      <EmptyState icon={<LayoutGrid className="w-6 h-6" />} title="Dashboard not found" action={<Link to="/dashboards" className="fx-btn fx-btn-secondary">All dashboards</Link>}>
        It may have been deleted, or the link is wrong.
      </EmptyState>
    );
  if (state.kind === 'error') return <ErrorBanner error={state.error} subject="the dashboard" onRetry={() => setNonce((n) => n + 1)} />;
  if (state.detail.archived_at) return <ArchivedNotice detail={state.detail} onUnarchived={() => setNonce((n) => n + 1)} />;
  return <StudioEditor key={state.key} initial={state.detail} reloadPage={() => setNonce((n) => n + 1)} />;
};

const ArchivedNotice: React.FC<{ detail: DashboardDetail; onUnarchived: () => void }> = ({ detail, onUnarchived }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <EmptyState
      icon={<Archive className="w-6 h-6" />}
      title={`“${detail.name}” is archived`}
      action={
        <>
          <Button
            variant="primary"
            loading={busy}
            icon={<ArchiveRestore className="w-4 h-4" />}
            onClick={async () => {
              setBusy(true);
              try {
                await unarchiveDashboard(detail.id, detail.version);
                onUnarchived();
              } catch (e) {
                setError(errorLine(e, 'Could not unarchive the dashboard.'));
              } finally {
                setBusy(false);
              }
            }}
          >
            Unarchive and edit
          </Button>
          <Link to="/dashboards" className="fx-btn fx-btn-secondary">
            All dashboards
          </Link>
        </>
      }
    >
      Archived dashboards cannot be edited. Unarchive it to continue.
      {error && <span className="block text-red-700 mt-1">{error}</span>}
    </EmptyState>
  );
};

// ------------------------------------------------------------------ editor

type LeftTab = 'widgets' | 'data' | 'variables' | 'settings';

interface Meta {
  version: number;
  draft_revision: number;
  published_revision: number | null;
  published_at: string | null;
  has_unpublished_changes: boolean;
}

function metaOf(d: DashboardDetail): Meta {
  return {
    version: d.version,
    draft_revision: d.draft_revision,
    published_revision: d.published_revision,
    published_at: d.published_at,
    has_unpublished_changes: d.has_unpublished_changes,
  };
}

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes(type);
}

const StudioEditor: React.FC<{ initial: DashboardDetail; reloadPage: () => void }> = ({ initial, reloadPage }) => {
  const navigate = useNavigate();
  const dashboardId = initial.id;
  const { defs, limits, registry, error: regError, reload: reloadRegistry } = useWidgetRegistry();
  const { presets } = useThemePresets();
  const catalog = useSourceCatalog(true);
  const history = useEditorHistory({ name: initial.name, description: initial.description || '', document: normalizeDocument(initial.document) });
  const { present, dirty } = history;
  const doc = present.document;
  const [meta, setMeta] = useState<Meta>(() => metaOf(initial));
  const [upgradeNotes, setUpgradeNotes] = useState<string[]>(() => (Array.isArray(initial.upgrade_notes) ? initial.upgrade_notes : []));
  const { toast, show, dismiss } = useActionToast();
  const location = useLocation();
  useEffect(() => {
    const w = (location.state as { createdWarnings?: string[] } | null)?.createdWarnings;
    if (!w?.length) return;
    show({ message: `Created “${initial.name}”. ${w.length} item${w.length === 1 ? '' : 's'} need attention: ${w[0]}${w.length > 1 ? ' Use Validate to see all.' : ''}`, tone: 'info', durationMs: 12000 });
    window.history.replaceState({ ...window.history.state, usr: null }, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>('widgets');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('general');
  const [bp, setBp] = useState<Breakpoint>('lg');
  const [zoom, setZoom] = useState<'fit' | '100'>('fit');
  const [showGrid, setShowGrid] = useState(true);
  const [preview, setPreview] = useState(false);
  const [panels, setPanels] = useState<{ left: boolean; right: boolean }>(() => {
    try {
      const raw = localStorage.getItem('fx.dashboard.studio.panels');
      if (raw) return { left: true, right: true, ...(JSON.parse(raw) as object) };
    } catch {
      /* UI preference only */
    }
    return { left: true, right: true };
  });
  useEffect(() => {
    try {
      localStorage.setItem('fx.dashboard.studio.panels', JSON.stringify(panels));
    } catch {
      /* not remembered */
    }
  }, [panels]);

  // Runtime inputs of the Studio canvas / preview (session only, never saved).
  const [runVars, setRunVars] = useState<Record<string, string | null>>(() => Object.fromEntries(doc.variables.map((v) => [v.id, v.default ?? null])));
  useEffect(() => {
    setRunVars((prev) => {
      const next: Record<string, string | null> = {};
      for (const v of doc.variables) next[v.id] = v.id in prev ? prev[v.id] : v.default ?? null;
      return next;
    });
  }, [doc.variables]);
  const [runRange, setRunRange] = useState<TimeRange | null>(null);
  const [runRefresh, setRunRefresh] = useState<RefreshPolicy | null>(null);
  const effectiveRange = runRange || doc.settings.time_range;
  const runtimeDoc = useMemo<DashboardDocument>(() => (runRefresh && runRefresh !== doc.settings.refresh ? { ...doc, settings: { ...doc.settings, refresh: runRefresh } } : doc), [doc, runRefresh]);
  const theme = useMemo(() => resolveTheme(doc.settings.theme, presets), [doc.settings.theme, presets]);

  const selected = selectedId ? doc.widgets.find((w) => w.id === selectedId) || null : null;
  const selectedDef = selected ? defs.get(selected.type) : undefined;
  useEffect(() => {
    if (selectedId && !doc.widgets.some((w) => w.id === selectedId)) setSelectedId(null);
  }, [doc.widgets, selectedId]);

  // ---------------------------------------------------------------- mutations

  const updateDoc = useCallback((fn: (d: DashboardDocument) => DashboardDocument, coalesce?: string) => history.apply((s) => ({ document: fn(s.document) }), coalesce), [history]);
  const updateWidget = useCallback(
    (id: string, fn: (w: DashboardWidget) => DashboardWidget, coalesce?: string) =>
      updateDoc((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === id ? fn(w) : w)) }), coalesce),
    [updateDoc],
  );
  const maxWidgets = limits.max_widgets || 40;
  const atCap = doc.widgets.length >= maxWidgets;

  const addWidget = useCallback(
    (def: WidgetTypeDef, at?: { bp: Breakpoint; x: number; y: number }) => {
      if (doc.widgets.length >= maxWidgets) {
        show({ message: `A dashboard holds at most ${maxWidgets} widgets.`, tone: 'error' });
        return;
      }
      const w = createWidget(def, doc, defs, at);
      updateDoc((d) => ({ ...d, widgets: [...d.widgets, w] }));
      setSelectedId(w.id);
      setInspectorTab(def.data.max_bindings > 0 ? 'data' : 'general');
      if (def.data.max_bindings > 0) setLeftTab('data');
      setPanels((p) => ({ ...p, right: true }));
    },
    [doc, defs, maxWidgets, updateDoc, show],
  );

  const deleteWidget = useCallback(
    (id: string) => {
      const w = doc.widgets.find((x) => x.id === id);
      if (!w) return;
      updateDoc((d) => ({ ...d, widgets: d.widgets.filter((x) => x.id !== id) }));
      setSelectedId(null);
      show({ message: `Deleted “${w.title || defs.get(w.type)?.label || 'widget'}”.`, action: { label: 'Undo', run: () => history.undo() } });
    },
    [doc.widgets, updateDoc, show, defs, history],
  );

  const duplicateWidget = useCallback(
    (id: string) => {
      const w = doc.widgets.find((x) => x.id === id);
      if (!w) return;
      if (doc.widgets.length >= maxWidgets) {
        show({ message: `A dashboard holds at most ${maxWidgets} widgets.`, tone: 'error' });
        return;
      }
      const copy = duplicateWidgetIn(doc, w, defs);
      updateDoc((d) => ({ ...d, widgets: [...d.widgets, copy] }));
      setSelectedId(copy.id);
    },
    [doc, defs, maxWidgets, updateDoc, show],
  );

  const addBinding = useCallback(
    (item: SourceItem, role?: string) => {
      if (!selected || !selectedDef) return;
      // The catalog's `source` is stored verbatim (contract §5); the token is only a fallback.
      const src = item.source ?? sourceFromToken(item.token, item.kind);
      if (!src) return;
      const total = doc.widgets.reduce((a, w) => a + w.bindings.length, 0);
      const maxBindings = limits.max_bindings_per_document ?? 400;
      if (total >= maxBindings) {
        show({ message: `A dashboard holds at most ${maxBindings} data sources in total.`, tone: 'error' });
        return;
      }
      if (selected.bindings.length >= selectedDef.data.max_bindings) {
        show({ message: `This widget takes at most ${selectedDef.data.max_bindings} source${selectedDef.data.max_bindings === 1 ? '' : 's'}.`, tone: 'error' });
        return;
      }
      updateWidget(selected.id, (w) => ({ ...w, bindings: [...w.bindings, newBinding(w, src, role)] }));
      setInspectorTab('data');
      setPanels((p) => ({ ...p, right: true }));
    },
    [selected, selectedDef, updateWidget, show, doc.widgets, limits.max_bindings_per_document],
  );

  const chooseData = useCallback((id: string) => {
    setSelectedId(id);
    setInspectorTab('data');
    setLeftTab('data');
    setPanels({ left: true, right: true });
    setPreview(false);
  }, []);

  // ---------------------------------------------------------------- save / validate / publish

  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [validation, setValidation] = useState<{ open: boolean; loading: boolean; error: string | null; issues: ValidationIssue[] }>({ open: false, loading: false, error: null, issues: [] });
  const nameError = !present.name.trim() ? 'The dashboard needs a name.' : null;
  const bytes = useMemo(() => documentBytes(doc), [doc]);
  const tooBig = bytes > (limits.max_document_bytes || 1_500_000);

  const saveNow = useCallback(
    async (opts: { quiet?: boolean; versionOverride?: number } = {}): Promise<DashboardDetail | null> => {
      if (savingRef.current) return null;
      if (nameError) {
        show({ message: nameError, tone: 'error' });
        return null;
      }
      if (tooBig) {
        show({ message: `The dashboard is larger than ${(limits.max_document_bytes / 1e6).toFixed(1)} MB (images count). Remove an image or widgets.`, tone: 'error' });
        return null;
      }
      const snap = history.present;
      savingRef.current = true;
      setSaving(true);
      try {
        const res = await patchDashboard(dashboardId, {
          version: opts.versionOverride ?? meta.version,
          name: snap.name.trim(),
          description: snap.description,
          document: snap.document,
        });
        setMeta(metaOf(res));
        history.markSaved(snap.id);
        if (!opts.quiet) show({ message: 'Draft saved.', tone: 'success', durationMs: 2500 });
        return res;
      } catch (e) {
        const info = errorInfo(e);
        if (info.status === 409 && info.code !== 'ARCHIVED') setConflict(true);
        else if (info.status === 422 && info.issues.length) {
          setValidation({ open: true, loading: false, error: null, issues: info.issues });
          show({ message: 'The draft was not saved: fix the issues listed.', tone: 'error' });
        } else show({ message: errorLine(e, 'The draft could not be saved.'), tone: 'error' });
        return null;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [history, dashboardId, meta.version, nameError, tooBig, limits.max_document_bytes, show],
  );

  const runValidate = useCallback(async (): Promise<ValidationIssue[] | null> => {
    setValidation((v) => ({ ...v, loading: true, error: null }));
    try {
      const res = await validateDashboard(dashboardId, history.present.document);
      setValidation((v) => ({ ...v, loading: false, issues: res.issues || [] }));
      return res.issues || [];
    } catch (e) {
      const info = errorInfo(e);
      const issues = info.issues;
      setValidation((v) => ({ ...v, loading: false, error: issues.length ? null : errorLine(e, 'Validation failed.'), issues }));
      return issues.length ? issues : null;
    }
  }, [dashboardId, history.present.document]);

  const [publishOpen, setPublishOpen] = useState(false);
  const openPublish = () => {
    setPublishOpen(true);
    void runValidate();
  };

  const publish = async (note: string) => {
    let version = meta.version;
    if (history.dirty) {
      const saved = await saveNow({ quiet: true });
      if (!saved) throw new Error('The draft could not be saved, so it was not published.');
      version = saved.version;
    }
    try {
      const res = await publishDashboard(dashboardId, { version, note: note || undefined });
      setMeta(metaOf(res));
      setPublishOpen(false);
      show({ message: `Published revision ${res.published_revision ?? ''}.`, tone: 'success', action: { label: 'Open view', run: () => navigate(`/dashboards/${dashboardId}`) } });
    } catch (e) {
      const info = errorInfo(e);
      if (info.issues.length) setValidation((v) => ({ ...v, issues: info.issues }));
      if (info.status === 409 && info.code === 'RESOURCE_VERSION_CONFLICT') {
        setPublishOpen(false);
        setConflict(true);
      }
      throw e;
    }
  };

  const pickIssue = (i: ValidationIssue) => {
    if (!i.widget_id || !doc.widgets.some((w) => w.id === i.widget_id)) return;
    setSelectedId(i.widget_id);
    setInspectorTab(i.binding_id || /BIND|SOURCE|ROLE|RESOLVE|REF/i.test(i.code) ? 'data' : 'general');
    setPanels((p) => ({ ...p, right: true }));
    setPreview(false);
    setValidation((v) => ({ ...v, open: false }));
    setPublishOpen(false);
  };
  const widgetTitle = useCallback((id: string) => {
    const w = doc.widgets.find((x) => x.id === id);
    return w ? w.title || defs.get(w.type)?.label || w.type : null;
  }, [doc.widgets, defs]);

  // ---------------------------------------------------------------- more actions

  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const doExport = async () => {
    try {
      const data = await exportDashboard(dashboardId);
      downloadJson(data, `${safeFileName(present.name)}.dashboard.json`);
      show({ message: dirty ? 'Exported the last saved draft (unsaved changes are not included).' : 'Exported.', tone: 'success' });
    } catch (e) {
      show({ message: errorLine(e, 'Could not export the dashboard.'), tone: 'error' });
    }
  };

  // ---------------------------------------------------------------- leave guard + keyboard

  const guard = useLeaveGuard(dirty);
  const hasToastAction = !!toast?.action;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const typing = isTextField(document.activeElement);
      if (mod && key === 's') {
        e.preventDefault();
        void saveNow();
        return;
      }
      if (mod && (key === 'z' || key === 'y') && !typing) {
        // A visible "Undo" toast runs its own action on Ctrl+Z.
        if (key === 'z' && !e.shiftKey && hasToastAction) return;
        e.preventDefault();
        if (key === 'y' || e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (typing || preview) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteWidget(selectedId);
      } else if (e.key === 'Escape' && selectedId) {
        setSelectedId(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [saveNow, history, selectedId, deleteWidget, preview, hasToastAction]);

  // The Studio covers the main navigation; the top bar stays above it.
  useEffect(() => {
    document.documentElement.classList.add('fx-studio-open');
    return () => document.documentElement.classList.remove('fx-studio-open');
  }, []);

  const onNavigate = useCallback(
    (_t: NavTarget) => {
      if (!preview) show({ message: 'Links are not followed while editing. Use Preview, or open the published view.' });
      else show({ message: 'Links open in the published view; this is a preview.' });
    },
    [preview, show],
  );

  const editProps = useMemo<CanvasEditProps>(
    () => ({
      breakpoint: bp,
      zoom,
      selectedId,
      onSelect: setSelectedId,
      onLayoutCommit: (b, items) => updateDoc((d) => applyGridLayout(d, b, items, defs)),
      onDropType: (type, b, x, y) => {
        const def = defs.get(type);
        if (def) addWidget(def, { bp: b, x, y });
      },
      onDuplicate: duplicateWidget,
      onDelete: deleteWidget,
      onChooseData: chooseData,
      showGrid,
    }),
    [bp, zoom, selectedId, updateDoc, defs, addWidget, duplicateWidget, deleteWidget, chooseData, showGrid],
  );

  const hiddenHere = doc.widgets.filter((w) => w.hidden[bp]);
  const defList = useMemo(() => registry?.widget_types || [], [registry]);

  if (regError && !defs.size) return <ErrorBanner error={regError} subject="the widget library" onRetry={reloadRegistry} />;

  return (
    <DashboardRuntimeProvider
      document={runtimeDoc}
      timeRange={effectiveRange}
      variables={runVars}
      defs={defs}
      limits={limits}
      theme={theme}
      resources={catalog.resourcesById}
      mode={preview ? 'view' : 'edit'}
    >
      <div className="fixed left-0 right-0 bottom-0 z-[41] flex flex-col bg-[#EEF2F7]" style={{ top: 'calc(var(--fx-topbar-height) + var(--fx-banner-height, 0px))' }}>
        {/* ---------------------------------------------------------- toolbar */}
        <div className="h-12 shrink-0 bg-white border-b border-[#E3EAF3] flex items-center gap-2 px-2.5 min-w-0" role="toolbar" aria-label="Studio">
          <Button variant="ghost" size="sm" icon={<ArrowLeft className="w-4 h-4" />} onClick={() => navigate('/dashboards')} title="All dashboards" aria-label="All dashboards">
            <span className="hidden xl:inline">Dashboards</span>
          </Button>
          <div className="min-w-0 flex items-center gap-2">
            <label htmlFor="studio-name" className="sr-only">
              Dashboard name
            </label>
            <input
              id="studio-name"
              value={present.name}
              maxLength={160}
              onChange={(e) => {
                const name = e.target.value;
                history.apply(() => ({ name }), 'name');
              }}
              className={`h-8 min-w-[120px] w-[clamp(120px,14vw,300px)] px-2 rounded-md text-[14px] font-bold text-[#111B37] border hover:border-[#D4DFEC] focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 ${nameError ? 'border-red-400' : 'border-transparent'}`}
              aria-invalid={!!nameError}
              title={nameError || 'Rename'}
            />
            <span className="hidden xl:inline-flex">
              <DashboardStatusChip nowrap published_revision={meta.published_revision} has_unpublished_changes={meta.has_unpublished_changes || dirty} />
            </span>
            <span className={`text-[11px] whitespace-nowrap ${dirty ? 'text-amber-700 font-semibold' : 'text-[#94A3B8]'}`} aria-live="polite">
              {saving ? 'Saving…' : dirty ? (
                <>
                  Unsaved<span className="hidden xl:inline"> changes</span>
                </>
              ) : (
                'Saved'
              )}
            </span>
          </div>
          <div className="mx-auto flex items-center gap-1 shrink-0">
            <ToolIcon label="Undo (Ctrl+Z)" onClick={history.undo} disabled={!history.canUndo || preview}>
              <Undo2 className="w-4 h-4" />
            </ToolIcon>
            <ToolIcon label="Redo (Ctrl+Shift+Z)" onClick={history.redo} disabled={!history.canRedo || preview}>
              <Redo2 className="w-4 h-4" />
            </ToolIcon>
            <span className="w-px h-6 bg-[#E3EAF3] mx-1" aria-hidden="true" />
            <div role="radiogroup" aria-label="Breakpoint" className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
              {BREAKPOINTS.map((b) => {
                const Icon = b === 'lg' ? Monitor : b === 'md' ? Tablet : Smartphone;
                const on = b === bp;
                const custom = b !== 'lg' && isBreakpointCustomized(doc, b);
                return (
                  <button
                    key={b}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={preview}
                    onClick={() => setBp(b)}
                    title={`${BREAKPOINT_LABEL[b]}${b === 'lg' ? '' : custom ? ' (own layout)' : ' (derived from Desktop)'}`}
                    className={`relative inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold disabled:opacity-40 ${on ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'}`}
                  >
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="hidden 2xl:inline">{BREAKPOINT_LABEL[b]}</span>
                    {custom && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[#2A82E7]" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
            <ToolIcon label={zoom === 'fit' ? 'Zoom: fit (click for 100%)' : 'Zoom: 100% (click to fit)'} onClick={() => setZoom(zoom === 'fit' ? '100' : 'fit')} pressed={zoom === '100'} disabled={preview}>
              <ZoomIn className="w-4 h-4" />
            </ToolIcon>
            <ToolIcon label={showGrid ? 'Hide grid' : 'Show grid'} onClick={() => setShowGrid(!showGrid)} pressed={showGrid} disabled={preview}>
              <Grid3x3 className="w-4 h-4" />
            </ToolIcon>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant={preview ? 'secondary' : 'outline'} icon={preview ? <Pencil className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />} onClick={() => setPreview(!preview)} aria-pressed={preview}>
              <span className="hidden xl:inline">{preview ? 'Back to editing' : 'Preview'}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<ListChecks className="w-3.5 h-3.5" />}
              onClick={() => {
                setValidation((v) => ({ ...v, open: true }));
                void runValidate();
              }}
              title="Validate the draft"
            >
              <span className="hidden xl:inline">Validate</span>
            </Button>
            <Button size="sm" variant="outline" icon={<Save className="w-3.5 h-3.5" />} onClick={() => void saveNow()} loading={saving} disabled={!dirty || !!nameError} title="Save the draft (Ctrl+S)">
              Save
            </Button>
            <Button size="sm" variant="primary" icon={<Send className="w-3.5 h-3.5" />} onClick={openPublish} disabled={!!nameError} title="Publish a new revision">
              Publish
            </Button>
            <MenuButton
              label="More"
              size="sm"
              icon={<MoreHorizontal className="w-4 h-4" />}
              ariaLabel="More actions"
              items={[
                { key: 'rev', label: 'Revisions…', icon: <History className="w-3.5 h-3.5" />, onSelect: () => setRevisionsOpen(true) },
                { key: 'view', label: 'Open published view', icon: <Eye className="w-3.5 h-3.5" />, onSelect: () => navigate(`/dashboards/${dashboardId}`), disabled: !meta.published_revision },
                { key: 'export', label: 'Export JSON', icon: <Download className="w-3.5 h-3.5" />, onSelect: () => void doExport() },
                { key: 'tpl', label: 'Save as template…', icon: <FileStack className="w-3.5 h-3.5" />, onSelect: () => setTemplateOpen(true), disabled: doc.widgets.length === 0 },
                { key: 'dup', label: 'Duplicate…', icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => setDupOpen(true) },
                {
                  key: 'arch',
                  label: 'Archive…',
                  icon: <Archive className="w-3.5 h-3.5" />,
                  danger: true,
                  onSelect: () => {
                    setArchiveError(null);
                    setArchiveOpen(true);
                  },
                },
              ]}
            />
          </div>
        </div>

        {/* ---------------------------------------------------------- body */}
        <div className="flex-1 min-h-0 flex">
          {!preview && (
            <aside className={`shrink-0 bg-white border-r border-[#E3EAF3] flex ${panels.left ? 'w-[300px] xl:w-[320px]' : 'w-11'} transition-[width] duration-150`} aria-label="Studio tools">
              <div className="w-11 shrink-0 border-r border-[#F1F5F9] flex flex-col items-center gap-1 py-2" role="tablist" aria-orientation="vertical" aria-label="Panels">
                {(
                  [
                    ['widgets', 'Widgets', LayoutGrid],
                    ['data', 'Data', Database],
                    ['variables', 'Variables', Variable],
                    ['settings', 'Settings', Settings2],
                  ] as const
                ).map(([id, label, Icon]) => {
                  const on = panels.left && leftTab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      title={label}
                      aria-label={label}
                      onClick={() => {
                        if (on) setPanels((p) => ({ ...p, left: false }));
                        else {
                          setLeftTab(id);
                          setPanels((p) => ({ ...p, left: true }));
                        }
                      }}
                      className={`w-9 h-9 rounded-lg flex flex-col items-center justify-center text-[9px] font-semibold gap-0.5 ${on ? 'bg-[#FEF2F2] text-[#EF1B24]' : 'text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37]'}`}
                    >
                      <Icon className="w-4 h-4" aria-hidden="true" />
                    </button>
                  );
                })}
                <div className="mt-auto">
                  <ToolIcon label={panels.left ? 'Collapse panel' : 'Expand panel'} onClick={() => setPanels((p) => ({ ...p, left: !p.left }))}>
                    {panels.left ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                  </ToolIcon>
                </div>
              </div>
              {panels.left && (
                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                  <div className="h-9 shrink-0 px-3 flex items-center border-b border-[#E3EAF3] text-[12px] font-bold text-[#111B37]">
                    {leftTab === 'widgets' ? 'Widgets' : leftTab === 'data' ? 'Data' : leftTab === 'variables' ? 'Variables' : 'Dashboard settings'}
                  </div>
                  <div className="flex-1 min-h-0 flex flex-col">
                    {leftTab === 'widgets' && <WidgetsPanel defs={defList} disabled={atCap} limit={maxWidgets} onAdd={(d) => addWidget(d)} />}
                    {leftTab === 'data' && <DataPanel selected={selected} selectedDef={selectedDef} onAdd={addBinding} />}
                    {leftTab === 'variables' && (
                      <VariablesPanel doc={doc} catalog={catalog} max={limits.max_variables ?? 10} onChange={(variables) => updateDoc((d) => ({ ...d, variables }))} />
                    )}
                    {leftTab === 'settings' && (
                      <SettingsPanel
                        settings={doc.settings}
                        presets={presets}
                        description={present.description}
                        onDescription={(description) => history.apply(() => ({ description }), 'description')}
                        onChange={(settings, coalesce) => updateDoc((d) => ({ ...d, settings }), coalesce)}
                      />
                    )}
                  </div>
                </div>
              )}
            </aside>
          )}

          <main className="flex-1 min-w-0 flex flex-col min-h-0" aria-label={preview ? 'Preview' : 'Canvas'}>
            <CanvasHeader
              preview={preview}
              doc={doc}
              bp={bp}
              hidden={hiddenHere}
              defs={defs}
              onShow={(id) => updateWidget(id, (w) => ({ ...w, hidden: { ...w.hidden, [bp]: false } }))}
              onReset={(b) => updateDoc((d) => resetBreakpoint(d, b))}
              runVars={runVars}
              setRunVar={(id, value) => setRunVars((p) => ({ ...p, [id]: value }))}
              range={effectiveRange}
              setRange={setRunRange}
              refresh={runRefresh || doc.settings.refresh}
              setRefresh={setRunRefresh}
              resources={catalog.catalog?.resources || []}
              atCap={atCap}
              maxWidgets={maxWidgets}
              tooBig={tooBig}
            />
            {upgradeNotes.length > 0 && (
              <div className="mx-3 mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 flex items-start gap-2" role="status">
                <span className="flex-1">
                  <strong>This draft was upgraded from an older dashboard format.</strong> Check the widgets below, then save.
                  <ul className="list-disc pl-4 mt-0.5">
                    {upgradeNotes.slice(0, 5).map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                    {upgradeNotes.length > 5 && <li>+{upgradeNotes.length - 5} more</li>}
                  </ul>
                </span>
                <button type="button" className="text-[11px] font-semibold underline" onClick={() => setUpgradeNotes([])}>
                  Dismiss
                </button>
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-auto p-3">
              {preview ? (
                <PreviewCanvas doc={runtimeDoc} onNavigate={onNavigate} />
              ) : (
                <DashboardCanvas
                  document={doc}
                  mode="edit"
                  edit={editProps}
                  onNavigate={onNavigate}
                  empty={
                    <div className="text-center max-w-sm rounded-xl border-2 border-dashed px-6 py-8" style={{ borderColor: 'var(--dash-border)', color: 'var(--dash-text-muted)' }}>
                      <LayoutGrid className="w-7 h-7 mx-auto mb-2" aria-hidden="true" />
                      <p className="text-[14px] font-semibold" style={{ color: 'var(--dash-text)' }}>
                        {doc.widgets.length ? `Every widget is hidden on ${BREAKPOINT_LABEL[bp]}` : 'Start with a widget'}
                      </p>
                      <p className="text-[12px] mt-1">
                        {doc.widgets.length ? 'Show one from the bar above, or switch the breakpoint.' : 'Drag a widget from the Widgets panel here, or click one to add it. Then choose its data in the Data panel.'}
                      </p>
                    </div>
                  }
                />
              )}
            </div>
          </main>

          {!preview && (
            <aside className={`shrink-0 bg-white border-l border-[#E3EAF3] flex flex-col min-h-0 ${panels.right ? 'w-[320px] xl:w-[340px]' : 'w-11'}`} aria-label="Inspector">
              <div className={`h-9 shrink-0 flex items-center border-b border-[#E3EAF3] ${panels.right ? 'px-2 justify-between' : 'justify-center'}`}>
                {panels.right && <span className="text-[12px] font-bold text-[#111B37] px-1">Inspector</span>}
                <ToolIcon label={panels.right ? 'Collapse inspector' : 'Expand inspector'} onClick={() => setPanels((p) => ({ ...p, right: !p.right }))}>
                  {panels.right ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
                </ToolIcon>
              </div>
              {panels.right && (
                <div className="flex-1 min-h-0">
                  {selected ? (
                    <Inspector
                      key={selected.id}
                      widget={selected}
                      def={selectedDef}
                      doc={doc}
                      defs={defs}
                      bp={bp}
                      tab={inspectorTab}
                      setTab={setInspectorTab}
                      update={(fn, coalesce) => updateWidget(selected.id, fn, coalesce)}
                      catalog={catalog}
                      theme={theme}
                      dashboardId={dashboardId}
                      onAddSource={() => {
                        setLeftTab('data');
                        setPanels((p) => ({ ...p, left: true }));
                      }}
                      onDuplicate={() => duplicateWidget(selected.id)}
                      onDelete={() => deleteWidget(selected.id)}
                    />
                  ) : (
                    <EmptyInspector doc={doc} limit={maxWidgets} />
                  )}
                </div>
              )}
            </aside>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------ dialogs */}
      <ValidateDialog
        open={validation.open}
        loading={validation.loading}
        error={validation.error}
        issues={validation.issues}
        widgetTitle={widgetTitle}
        onPick={pickIssue}
        onClose={() => setValidation((v) => ({ ...v, open: false }))}
        onRerun={() => void runValidate()}
      />
      <PublishDialog
        open={publishOpen}
        dirty={dirty}
        checking={validation.loading}
        checkError={validation.error}
        issues={validation.issues}
        widgetCount={doc.widgets.length}
        nextRevision={(meta.published_revision || 0) + 1}
        widgetTitle={widgetTitle}
        onPick={pickIssue}
        onClose={() => setPublishOpen(false)}
        onPublish={publish}
      />
      <ConflictDialog
        open={conflict}
        onClose={() => setConflict(false)}
        onReload={async () => {
          guard.allowNext();
          setConflict(false);
          reloadPage();
        }}
        onOverwrite={async () => {
          try {
            const latest = await getDashboard(dashboardId);
            const res = await saveNow({ versionOverride: latest.version });
            if (res) setConflict(false);
          } catch (e) {
            show({ message: errorLine(e, 'Could not read the latest version.'), tone: 'error' });
          }
        }}
      />
      <RevisionsDialog
        open={revisionsOpen}
        dashboardId={dashboardId}
        publishedRevision={meta.published_revision}
        defs={defs}
        limits={limits}
        presets={presets}
        resources={catalog.resourcesById}
        onClose={() => setRevisionsOpen(false)}
        onRestore={async (revision) => {
          const res = await restoreRevision(dashboardId, { revision, version: meta.version });
          setMeta(metaOf(res));
          history.reset({ name: res.name, description: res.description || '', document: normalizeDocument(res.document) });
          setSelectedId(null);
          show({ message: `Revision ${revision} restored to the draft.`, tone: 'success' });
        }}
      />
      <SaveTemplateDialog
        open={templateOpen}
        defaultName={present.name}
        dirty={dirty}
        onClose={() => setTemplateOpen(false)}
        onSave={async (name, description, category) => {
          if (history.dirty) {
            const saved = await saveNow({ quiet: true });
            if (!saved) throw new Error('Save the draft first.');
          }
          await createTemplate({ dashboard_id: dashboardId, name, description: description || undefined, category: category || undefined });
          setTemplateOpen(false);
          show({ message: `Template “${name}” saved. It appears under “Your templates” in New dashboard.`, tone: 'success' });
        }}
      />
      <DuplicateDialog
        source={dupOpen ? { id: dashboardId, name: present.name } : null}
        onClose={() => setDupOpen(false)}
        onDone={(id, name) => {
          setDupOpen(false);
          show({
            message: dirty ? `Created “${name}” from the last saved draft.` : `Created “${name}”.`,
            tone: 'success',
            action: { label: 'Edit copy', run: () => navigate(`/dashboards/${id}/edit`) },
          });
        }}
      />
      <ConfirmDialog
        isOpen={archiveOpen}
        title={`Archive “${present.name}”?`}
        message={`It disappears from the list and its links stop opening. Nothing is deleted; unarchive it from the Archived filter.${dirty ? ' Unsaved changes are lost.' : ''}`}
        confirmLabel="Archive"
        busyLabel="Archiving…"
        variant="warning"
        error={archiveError}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={async () => {
          try {
            await archiveDashboard(dashboardId, meta.version);
            guard.allowNext();
            setArchiveOpen(false);
            navigate('/dashboards');
          } catch (e) {
            setArchiveError(errorLine(e, 'Could not archive the dashboard.'));
          }
        }}
      />
      <ConfirmDialog
        isOpen={!!guard.pending}
        title="Leave without saving?"
        message="Your changes to this dashboard are not saved. Leave anyway and lose them, or stay and save."
        confirmLabel="Leave without saving"
        cancelLabel="Stay"
        variant="danger"
        onCancel={guard.cancel}
        onConfirm={guard.proceed}
      />
      <ActionToast toast={toast} onDismiss={dismiss} />
    </DashboardRuntimeProvider>
  );
};

// ------------------------------------------------------------------ pieces

const ToolIcon: React.FC<{ label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: React.ReactNode }> = ({ label, onClick, disabled, pressed, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-[#334568] hover:bg-[#F1F5FA] hover:text-[#111B37] disabled:opacity-35 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 ${pressed ? 'bg-[#EEF5FF] text-[#0B2545]' : ''}`}
  >
    {children}
  </button>
);

const CanvasHeader: React.FC<{
  preview: boolean;
  doc: DashboardDocument;
  bp: Breakpoint;
  hidden: DashboardWidget[];
  defs: Map<string, WidgetTypeDef>;
  onShow: (id: string) => void;
  onReset: (bp: 'md' | 'sm') => void;
  runVars: Record<string, string | null>;
  setRunVar: (id: string, v: string | null) => void;
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  refresh: RefreshPolicy;
  setRefresh: (r: RefreshPolicy) => void;
  resources: import('../../../features/dashboard/types').SourceResource[];
  atCap: boolean;
  maxWidgets: number;
  tooBig: boolean;
}> = ({ preview, doc, bp, hidden, defs, onShow, onReset, runVars, setRunVar, range, setRange, refresh, setRefresh, resources, atCap, maxWidgets, tooBig }) => {
  const status = useRuntimeStatus();
  const now = useNow(5000);
  const custom = bp !== 'lg' && isBreakpointCustomized(doc, bp);
  return (
    <div className="shrink-0 px-3 pt-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {doc.variables.length > 0 && <VariableBar variables={doc.variables} values={runVars} onChange={setRunVar} resources={resources} />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TimeRangePicker value={range} onChange={setRange} ariaLabel="Preview time range" />
          <RefreshSelect value={refresh} onChange={setRefresh} onRefreshNow={status.refresh} busy={status.pending > 0} />
          <LiveIndicator stream={status.stream} lastUpdateAt={status.lastUpdateAt} now={now} />
        </div>
      </div>
      {!preview && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#657794]">
          <span className="font-semibold text-[#334568]">
            {BREAKPOINT_LABEL[bp]} · {bp === 'lg' ? '12' : bp === 'md' ? '6' : '1'} column{bp === 'sm' ? '' : 's'}
          </span>
          {bp !== 'lg' && (
            <span>
              {custom ? 'Own layout.' : 'Derived from Desktop until you move or resize a widget here.'}
              {custom && (
                <button type="button" onClick={() => onReset(bp)} className="ml-1 inline-flex items-center gap-0.5 font-semibold text-[#2A82E7] hover:underline">
                  <RotateCcw className="w-3 h-3" aria-hidden="true" /> Reset to Desktop order
                </button>
              )}
            </span>
          )}
          {hidden.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1">
              <EyeOff className="w-3 h-3" aria-hidden="true" /> Hidden here:
              {hidden.map((w) => (
                <button key={w.id} type="button" onClick={() => onShow(w.id)} className="px-1.5 py-0.5 rounded border border-[#D4DFEC] bg-white font-semibold text-[#334568] hover:bg-[#F1F5FA]" title="Show on this breakpoint">
                  {w.title || defs.get(w.type)?.label || w.type}
                </button>
              ))}
            </span>
          )}
          <span className="ml-auto">
            {doc.widgets.length}/{maxWidgets} widgets{atCap ? ' — limit reached' : ''}
          </span>
          {tooBig && <span className="text-red-700 font-semibold">The dashboard is over the size limit (images count).</span>}
        </div>
      )}
      {preview && <p className="text-[11px] text-[#657794]">Preview: as viewers see it (with your unsaved changes). Variable and time choices here are not saved.</p>}
      {status.resolveError && <p className="text-[11px] text-red-700">Data sources could not be resolved: {status.resolveError}</p>}
    </div>
  );
};

const PreviewCanvas: React.FC<{ doc: DashboardDocument; onNavigate: (t: NavTarget) => void }> = ({ doc, onNavigate }) => {
  const [dataWidget, setDataWidget] = useState<DashboardWidget | null>(null);
  const [fullWidget, setFullWidget] = useState<DashboardWidget | null>(null);
  return (
    <div className="rounded-xl overflow-hidden border border-[#E3EAF3]">
      <DashboardCanvas document={doc} mode="view" view={{ onViewData: setDataWidget, onFullscreen: setFullWidget }} onNavigate={onNavigate} empty={<span className="text-[13px]">No widget yet.</span>} />
      <WidgetDataDialog widget={dataWidget} onClose={() => setDataWidget(null)} />
      <WidgetFullscreenDialog widget={fullWidget} onClose={() => setFullWidget(null)} onNavigate={onNavigate} />
    </div>
  );
};
