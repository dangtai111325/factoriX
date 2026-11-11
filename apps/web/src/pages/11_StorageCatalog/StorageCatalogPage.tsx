import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Archive,
  Boxes,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Download,
  Edit3,
  Eye,
  FileUp,
  Filter,
  Layers,
  LineChart,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {
  RecordingMode,
  StorageCoverageSummary,
  StorageDesignStatus,
  StorageDesignSummary,
  StorageHealthStatus,
  StorageOperation,
  archiveStorageDesign,
  bulkStorageDesigns,
  duplicateStorageDesign,
  exportStorageDesign,
  getStorageHealth,
  importStorageDesign,
  listStorageDesigns,
  listStorageOperations,
  pauseStorageDesign,
  restoreStorageDesign,
  resumeStorageDesign,
} from '../../lib/storageApi';
import { StorageCatalogDetailPage } from './StorageCatalogDetailPage';

type FilterTab = 'ALL' | 'RUNNING' | 'DRAFTS' | 'PAUSED' | 'ARCHIVED';

function formatRelativeOrShortDate(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusPillMeta(status: StorageDesignStatus | string): {
  bg: string;
  text: string;
  border: string;
  dot: string;
  label: string;
} {
  const s = String(status || 'DRAFT').toUpperCase();
  switch (s) {
    case 'RUNNING':
      return {
        bg: 'bg-[#ECFDF5]',
        text: 'text-[#059669]',
        border: 'border-[#A7F3D0]',
        dot: 'bg-[#0DBA67]',
        label: 'RUNNING',
      };
    case 'PAUSED':
      return {
        bg: 'bg-[#FFFBEB]',
        text: 'text-[#D97706]',
        border: 'border-[#FDE68A]',
        dot: 'bg-[#F59E0B]',
        label: 'PAUSED',
      };
    case 'VALIDATED':
      return {
        bg: 'bg-[#EFF6FF]',
        text: 'text-[#2563EB]',
        border: 'border-[#BFDBFE]',
        dot: 'bg-[#3B82F6]',
        label: 'VALIDATED',
      };
    case 'ARCHIVED':
    case 'RETIRED':
      return {
        bg: 'bg-[#F1F5F9]',
        text: 'text-[#475569]',
        border: 'border-[#CBD5E1]',
        dot: 'bg-[#64748B]',
        label: s,
      };
    case 'ERROR':
      return {
        bg: 'bg-[#FEF2F2]',
        text: 'text-[#DC2626]',
        border: 'border-[#FECACA]',
        dot: 'bg-[#EF1B24]',
        label: 'ERROR',
      };
    default:
      return {
        bg: 'bg-[#F8FAFC]',
        text: 'text-[#334155]',
        border: 'border-[#E2E8F0]',
        dot: 'bg-[#94A3B8]',
        label: s || 'DRAFT',
      };
  }
}

const DEFAULT_IMPORT_YAML = `apiVersion: factorix.io/storage/v1
kind: StorageDesign
metadata:
  name: Imported Packaging Line Storage Contract
  description: Governed TDengine STable storage contract for packaging telemetry
spec:
  scope:
    mode: all_sites
  destination:
    engine: tdengine
  datasets:
    - key: packaging_telemetry
      semantics: state_series
      sourceKind: signals
      timeAxis: acquired_at
      recording:
        mode: ON_CHANGE
        qualityTransitions: true
        deadband:
          kind: absolute
          value: 0.2
        maxCheckpointInterval: 60s
        lateTolerance: 30s
        missingPolicy: GAP_MARKER
      retention:
        days: 90
        legalHold: false
      fields:
        - key: conveyor_speed_rpm
          from: signal:conveyor.speed_rpm
          type: float64
          unit: rpm
          transform: round(value * 1.0, 2)
`;

export const StorageCatalogPage: React.FC = () => {
  const params = useParams<{ designId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const activeDetailId = params.designId || searchParams.get('designId') || '';

  const [designs, setDesigns] = useState<StorageDesignSummary[]>([]);
  const [counts, setCounts] = useState({
    all: 0,
    running: 0,
    drafts: 0,
    paused: 0,
    archived: 0,
  });
  const [coverage, setCoverage] = useState<StorageCoverageSummary>({
    signals_mapped: 0,
    signals_total: 336,
    models_mapped: 0,
    models_total: 36,
  });
  const [health, setHealth] = useState<StorageHealthStatus | null>(null);
  const [operations, setOperations] = useState<StorageOperation[]>([]);

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(
    null,
  );

  // Filters & UI state
  const [activeTab, setActiveTab] = useState<FilterTab>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<string>('ALL');
  const [scopeFilter, setScopeFilter] = useState<string>('ALL');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Modals / Drawers
  const [opsDrawerOpen, setOpsDrawerOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importFormat, setImportFormat] = useState<'yaml' | 'json'>('yaml');
  const [importContent, setImportContent] = useState(DEFAULT_IMPORT_YAML);
  const [importBusy, setImportBusy] = useState(false);
  const [archivePromptTarget, setArchivePromptTarget] = useState<StorageDesignSummary | null>(null);

  const showToast = useCallback((kind: 'success' | 'error' | 'info', message: string) => {
    setToast({ kind, message });
    window.setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 4500);
  }, []);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, healthRes, opsRes] = await Promise.all([
        listStorageDesigns(),
        getStorageHealth().catch(() => null),
        listStorageOperations({ limit: 40 }).catch(() => []),
      ]);
      setDesigns(listRes.items);
      setCounts({
        all: listRes.counts.all,
        running: listRes.counts.running,
        drafts: listRes.counts.drafts,
        paused: listRes.counts.paused,
        archived: listRes.counts.archived,
      });
      setCoverage(listRes.coverage);
      if (healthRes) setHealth(healthRes);
      setOperations(opsRes);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to load Storage Catalog');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!activeDetailId) {
      void fetchCatalog();
    }
  }, [activeDetailId, fetchCatalog]);

  const filteredDesigns = useMemo(() => {
    return designs.filter((item) => {
      const statusUpper = String(item.status || 'DRAFT').toUpperCase();
      if (activeTab === 'RUNNING' && statusUpper !== 'RUNNING') return false;
      if (
        activeTab === 'DRAFTS' &&
        statusUpper !== 'DRAFT' &&
        statusUpper !== 'VALIDATED'
      ) {
        return false;
      }
      if (activeTab === 'PAUSED' && statusUpper !== 'PAUSED') return false;
      if (
        activeTab === 'ARCHIVED' &&
        statusUpper !== 'ARCHIVED' &&
        statusUpper !== 'RETIRED'
      ) {
        return false;
      }

      if (modeFilter !== 'ALL') {
        const modes = item.recording_modes || [item.primary_recording_mode];
        if (!modes.includes(modeFilter as RecordingMode)) return false;
      }

      if (scopeFilter !== 'ALL') {
        const itemScope = String(
          (item.scope as { mode?: string } | undefined)?.mode || item.scope_summary || 'all_sites',
        ).toLowerCase();
        if (!itemScope.includes(scopeFilter.toLowerCase())) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const hay = `${item.name} ${item.description} ${item.id} ${item.scope_summary || ''} ${
          item.td_database || ''
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }, [designs, activeTab, modeFilter, scopeFilter, searchQuery]);

  // If a specific designId is active via URL param or query string, render the 6-tab Detail Page
  if (activeDetailId) {
    return (
      <StorageCatalogDetailPage
        designId={activeDetailId}
        onBack={() => {
          if (params.designId) {
            navigate('/historian/catalog');
          } else {
            const next = new URLSearchParams(searchParams);
            next.delete('designId');
            next.delete('tab');
            setSearchParams(next);
          }
        }}
      />
    );
  }

  const handleOpenDetail = (designId: string) => {
    navigate(`/historian/catalog/${encodeURIComponent(designId)}?designId=${encodeURIComponent(designId)}`);
  };

  const handleOpenDesigner = (designId?: string) => {
    if (designId) {
      navigate(
        `/historian/designer/${encodeURIComponent(designId)}?designId=${encodeURIComponent(designId)}`,
      );
    } else {
      navigate('/historian/designer');
    }
  };

  const handleOpenHistorian = (designId: string) => {
    navigate(`/historian/historian?designId=${encodeURIComponent(designId)}&mode=recorded`);
  };

  const handleToggleSelectAll = () => {
    if (selectedIds.length === filteredDesigns.length && filteredDesigns.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredDesigns.map((d) => d.id));
    }
  };

  const handleToggleRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const handleBulkAction = async (action: 'pause' | 'resume' | 'archive') => {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkStorageDesigns(action, selectedIds);
      const errCount = res.errors?.length || 0;
      showToast(
        'success',
        `Bulk ${action.toUpperCase()} completed (${res.affected} succeeded${
          errCount ? `, ${errCount} skipped` : ''
        }).`,
      );
      setSelectedIds([]);
      await fetchCatalog();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : `Bulk ${action} failed`);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleRowPauseResume = async (design: StorageDesignSummary) => {
    setBusyId(design.id);
    try {
      if (design.status === 'RUNNING') {
        await pauseStorageDesign(design.id);
        showToast('success', `Paused TDengine recording for "${design.name}".`);
      } else {
        await resumeStorageDesign(design.id);
        showToast('success', `Resumed TDengine recording for "${design.name}".`);
      }
      await fetchCatalog();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Status transition failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleRowDuplicate = async (design: StorageDesignSummary) => {
    setBusyId(design.id);
    try {
      const dup = await duplicateStorageDesign(design.id, { name: `${design.name} (Copy)` });
      showToast('success', `Duplicated "${design.name}" as Draft "${dup.name}".`);
      await fetchCatalog();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Duplicate failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleRowExport = async (design: StorageDesignSummary, format: 'yaml' | 'json' = 'yaml') => {
    setBusyId(design.id);
    try {
      const bundle = await exportStorageDesign(design.id, format);
      const blob = new Blob([bundle.content], {
        type: format === 'yaml' ? 'text/yaml;charset=utf-8' : 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = design.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
      a.href = url;
      a.download = `${safeName}_v${design.current_version}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('success', `Downloaded ${format.toUpperCase()} bundle for "${design.name}".`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmArchiveOrRestore = async () => {
    if (!archivePromptTarget) return;
    const target = archivePromptTarget;
    setBusyId(target.id);
    try {
      if (target.status === 'ARCHIVED') {
        await restoreStorageDesign(target.id);
        showToast('success', `Restored "${target.name}" to PAUSED state.`);
      } else {
        if (target.status === 'RUNNING') {
          await pauseStorageDesign(target.id);
        }
        await archiveStorageDesign(target.id);
        showToast(
          'success',
          `Archived "${target.name}". Historical TDengine STables remain preserved and queryable.`,
        );
      }
      setArchivePromptTarget(null);
      await fetchCatalog();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Archive/Restore failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importContent.trim()) return;
    setImportBusy(true);
    try {
      const created = await importStorageDesign({
        name: importName.trim() || undefined,
        format: importFormat,
        content: importContent,
      });
      setImportModalOpen(false);
      showToast('success', `Imported storage design "${created.name}".`);
      await fetchCatalog();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to import design bundle');
    } finally {
      setImportBusy(false);
    }
  };

  const signalCoveragePct = Math.min(
    100,
    Math.round((coverage.signals_mapped / Math.max(1, coverage.signals_total || 336)) * 100),
  );
  const modelCoveragePct = Math.min(
    100,
    Math.round((coverage.models_mapped / Math.max(1, coverage.models_total || 36)) * 100),
  );

  return (
    <div className="min-h-screen bg-[#F6F8FC] text-[#111B37] pb-16">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md bg-white border border-[#E3EAF3] shadow-lg rounded-xl px-4 py-3 flex items-center gap-3">
          {toast.kind === 'success' && <CheckCircle2 className="w-4 h-4 text-[#0DBA67] shrink-0" />}
          {toast.kind === 'error' && <AlertTriangle className="w-4 h-4 text-[#EF1B24] shrink-0" />}
          {toast.kind === 'info' && <Sparkles className="w-4 h-4 text-[#2563EB] shrink-0" />}
          <span className="text-xs font-medium text-[#111B37]">{toast.message}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="bg-white border-b border-[#E3EAF3] px-6 py-5">
        <div className="max-w-[1600px] mx-auto flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[#EFF6FF] text-[#134074] border border-[#BFDBFE]">
                S11 · Governance & Registry
              </span>
              <span className="text-xs text-[#657794]">
                Storage & Historian Pillar
              </span>
            </div>
            <h1 className="text-2xl font-bold text-[#111B37] tracking-tight mt-1">
              Storage Catalog
            </h1>
            <p className="text-xs text-[#657794] mt-0.5">
              Governed catalog of logical StorageDSL designs, TDengine STable deployments, recording & retention policies, and lineage dependencies.
            </p>
          </div>

          <div className="flex items-center flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => void fetchCatalog()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border border-[#E3EAF3] bg-white text-[#111B37] hover:bg-[#F8FAFC]"
              title="Refresh Storage Catalog"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>

            <button
              type="button"
              onClick={() => setOpsDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-[#E3EAF3] bg-white text-[#111B37] hover:bg-[#F8FAFC]"
            >
              <Activity className="w-3.5 h-3.5 text-[#134074]" />
              Operations Log ({operations.length})
            </button>

            <button
              type="button"
              onClick={() => setImportModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-[#CBD5E1] bg-white text-[#111B37] hover:bg-[#F8FAFC]"
            >
              <Upload className="w-3.5 h-3.5 text-[#134074]" />
              Import Design
            </button>

            <button
              type="button"
              onClick={() => handleOpenDesigner()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#EF1B24] text-white hover:bg-[#DC2626] shadow-sm transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Storage Design
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-[1600px] mx-auto px-6 pt-6 space-y-6">
        {/* Top KPI Strip (4 Cards) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* KPI 1: Total Designs */}
          <div className="bg-white border border-[#E3EAF3] rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                Total Designs
              </span>
              <Layers className="w-4 h-4 text-[#134074]" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-[#111B37]">{counts.all}</span>
              <span className="text-xs text-[#657794]">
                governed storage contracts
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3 text-[11px] text-[#657794]">
              <span>
                Drafts: <strong className="text-[#111B37]">{counts.drafts}</strong>
              </span>
              <span>•</span>
              <span>
                Archived: <strong className="text-[#111B37]">{counts.archived}</strong>
              </span>
            </div>
          </div>

          {/* KPI 2: Running Designs */}
          <div className="bg-white border border-[#E3EAF3] rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                Running Designs
              </span>
              <Play className="w-4 h-4 text-[#0DBA67]" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-[#059669]">{counts.running}</span>
              <span className="text-xs text-[#657794]">
                actively persisting to TDengine
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3 text-[11px] text-[#657794]">
              <span>
                Paused: <strong className="text-[#D97706]">{counts.paused}</strong>
              </span>
              <span>•</span>
              <span>Two-phase DDL verified</span>
            </div>
          </div>

          {/* KPI 3: Signal & Model Coverage */}
          <div className="bg-white border border-[#E3EAF3] rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                Signal & Model Coverage
              </span>
              <Boxes className="w-4 h-4 text-[#2563EB]" />
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <div>
                <span className="text-lg font-bold text-[#111B37]">
                  {coverage.signals_mapped} / {coverage.signals_total || 336}
                </span>
                <span className="text-[11px] text-[#657794] ml-1">Signals</span>
              </div>
              <span className="text-[#CBD5E1]">·</span>
              <div>
                <span className="text-lg font-bold text-[#111B37]">
                  {coverage.models_mapped} / {coverage.models_total || 36}
                </span>
                <span className="text-[11px] text-[#657794] ml-1">Models</span>
              </div>
            </div>
            <div className="mt-2.5 w-full h-1.5 bg-[#E2E8F0] rounded-full overflow-hidden flex">
              <div
                className="h-full bg-[#2563EB]"
                style={{ width: `${Math.max(4, signalCoveragePct)}%` }}
                title={`Signal coverage: ${signalCoveragePct}%`}
              />
              <div
                className="h-full bg-[#0DBA67]"
                style={{ width: `${Math.max(2, modelCoveragePct / 3)}%` }}
                title={`Model coverage: ${modelCoveragePct}%`}
              />
            </div>
          </div>

          {/* KPI 4: Storage Engine: TDengine (Healthy) */}
          <div className="bg-white border border-[#E3EAF3] rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                Storage Engine
              </span>
              <Database className="w-4 h-4 text-[#0DBA67]" />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#0DBA67]" />
              <span className="text-lg font-bold text-[#111B37]">
                TDengine ({health?.tdengine?.status === 'DEGRADED' ? 'Degraded' : 'Healthy'})
              </span>
            </div>
            <div className="mt-2 text-[11px] text-[#657794] flex items-center justify-between">
              <span>Destination: TDengine</span>
              <span className="font-mono text-[#047857]">
                DB: {health?.tdengine?.database || 'fx_t_default'}
              </span>
            </div>
          </div>
        </div>

        {/* Filter Bar + Search + Bulk Selection Bar */}
        <div className="bg-white border border-[#E3EAF3] rounded-xl p-4 shadow-sm space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            {/* Status Tabs */}
            <div className="flex items-center gap-1 bg-[#F8FAFC] p-1 rounded-lg border border-[#E3EAF3] overflow-x-auto">
              {[
                { id: 'ALL' as const, label: 'All', count: counts.all },
                { id: 'RUNNING' as const, label: 'Running', count: counts.running },
                { id: 'DRAFTS' as const, label: 'Drafts', count: counts.drafts },
                { id: 'PAUSED' as const, label: 'Paused', count: counts.paused },
                { id: 'ARCHIVED' as const, label: 'Archived', count: counts.archived },
              ].map((tab) => {
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-[#111B37] text-white shadow-sm'
                        : 'text-[#657794] hover:text-[#111B37]'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                        active ? 'bg-white/20 text-white' : 'bg-[#E2E8F0] text-[#475569]'
                      }`}
                    >
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Search & Mode/Scope Filters */}
            <div className="flex items-center flex-wrap gap-2">
              <div className="relative min-w-[240px] flex-1 sm:flex-initial">
                <Search className="w-3.5 h-3.5 text-[#657794] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search design name, scope, STable…"
                  className="w-full pl-8 pr-7 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs text-[#111B37] placeholder-[#94A3B8] focus:outline-none focus:border-[#134074]"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#111B37]"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5 bg-[#F8FAFC] border border-[#CBD5E1] rounded-lg px-2.5 py-1.5">
                <Filter className="w-3.5 h-3.5 text-[#657794]" />
                <span className="text-[11px] text-[#657794]">Mode:</span>
                <select
                  value={modeFilter}
                  onChange={(e) => setModeFilter(e.target.value)}
                  className="text-xs font-semibold text-[#111B37] bg-transparent focus:outline-none"
                >
                  <option value="ALL">All Modes</option>
                  <option value="ON_CHANGE">ON_CHANGE</option>
                  <option value="EVERY_ACQUISITION">EVERY_ACQUISITION</option>
                  <option value="INTERVAL">INTERVAL</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-[#F8FAFC] border border-[#CBD5E1] rounded-lg px-2.5 py-1.5">
                <span className="text-[11px] text-[#657794]">Scope:</span>
                <select
                  value={scopeFilter}
                  onChange={(e) => setScopeFilter(e.target.value)}
                  className="text-xs font-semibold text-[#111B37] bg-transparent focus:outline-none"
                >
                  <option value="ALL">All Scopes</option>
                  <option value="all_sites">All Sites</option>
                  <option value="site">Site</option>
                  <option value="subtree">Subtree</option>
                  <option value="resources">Selected Resources</option>
                </select>
              </div>
            </div>
          </div>

          {/* Bulk Selection Bar */}
          {selectedIds.length > 0 && (
            <div className="pt-3 border-t border-[#E3EAF3] flex items-center justify-between bg-[#EFF6FF]/60 -mx-4 -mb-4 px-4 py-2.5 rounded-b-xl">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#134074]">
                <CheckCircle2 className="w-4 h-4 text-[#2563EB]" />
                <span>
                  {selectedIds.length} storage design{selectedIds.length > 1 ? 's' : ''} selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void handleBulkAction('pause')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-[#FDE68A] text-[#B45309] hover:bg-[#FFFBEB]"
                >
                  <Pause className="w-3.5 h-3.5" />
                  Pause Selected
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void handleBulkAction('resume')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-[#A7F3D0] text-[#047857] hover:bg-[#ECFDF5]"
                >
                  <Play className="w-3.5 h-3.5" />
                  Resume Selected
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void handleBulkAction('archive')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-[#FECACA] text-[#DC2626] hover:bg-[#FEF2F2]"
                >
                  <Archive className="w-3.5 h-3.5" />
                  Archive Selected
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds([])}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-[#657794] hover:text-[#111B37]"
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Storage Designs Table */}
        <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                  <th className="py-3.5 pl-4 pr-2 w-9">
                    <input
                      type="checkbox"
                      checked={
                        filteredDesigns.length > 0 &&
                        selectedIds.length === filteredDesigns.length
                      }
                      onChange={handleToggleSelectAll}
                      className="rounded border-[#CBD5E1] text-[#111B37] focus:ring-0"
                    />
                  </th>
                  <th className="py-3.5 px-4">Design Name & Description</th>
                  <th className="py-3.5 px-3">Status</th>
                  <th className="py-3.5 px-3">Scope & Datasets</th>
                  <th className="py-3.5 px-3">Recording Mode</th>
                  <th className="py-3.5 px-3">Retention</th>
                  <th className="py-3.5 px-3">Destination</th>
                  <th className="py-3.5 px-3">Version / Updated</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E3EAF3] text-xs">
                {loading && designs.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-[#657794]">
                      <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-[#134074]" />
                      Loading governed storage designs…
                    </td>
                  </tr>
                ) : filteredDesigns.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center">
                      <div className="max-w-sm mx-auto">
                        <Layers className="w-7 h-7 text-[#94A3B8] mx-auto mb-2" />
                        <div className="text-sm font-bold text-[#111B37]">
                          No storage designs match the current filters
                        </div>
                        <p className="text-xs text-[#657794] mt-1">
                          Create a new StorageDSL design in the Storage Designer or clear your active search filters.
                        </p>
                        <div className="mt-4 flex items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveTab('ALL');
                              setSearchQuery('');
                              setModeFilter('ALL');
                              setScopeFilter('ALL');
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#E3EAF3] bg-white text-[#111B37] hover:bg-[#F8FAFC]"
                          >
                            Reset Filters
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenDesigner()}
                            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-[#EF1B24] text-white hover:bg-[#DC2626]"
                          >
                            + New Storage Design
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredDesigns.map((design) => {
                    const badge = statusPillMeta(design.status);
                    const isChecked = selectedIds.includes(design.id);
                    const isBusy = busyId === design.id;

                    return (
                      <tr
                        key={design.id}
                        className={`hover:bg-[#F8FAFC]/90 transition-colors ${
                          isChecked ? 'bg-[#EFF6FF]/40' : ''
                        }`}
                      >
                        <td className="py-3.5 pl-4 pr-2 align-top">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleRow(design.id)}
                            className="mt-1 rounded border-[#CBD5E1] text-[#111B37] focus:ring-0"
                          />
                        </td>

                        {/* Design Name & Description */}
                        <td className="py-3.5 px-4 align-top max-w-xs">
                          <button
                            type="button"
                            onClick={() => handleOpenDetail(design.id)}
                            className="text-left group"
                          >
                            <div className="font-bold text-[#111B37] group-hover:text-[#134074] group-hover:underline">
                              {design.name}
                            </div>
                            <div className="text-[11px] text-[#657794] line-clamp-2 mt-0.5">
                              {design.description || 'Governed TDengine telemetry storage contract'}
                            </div>
                          </button>
                        </td>

                        {/* Status */}
                        <td className="py-3.5 px-3 align-top">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${badge.bg} ${badge.text} ${badge.border}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                            {badge.label}
                          </span>
                        </td>

                        {/* Scope & Datasets */}
                        <td className="py-3.5 px-3 align-top">
                          <div className="font-semibold text-[#111B37]">
                            {design.dataset_count} dataset{design.dataset_count === 1 ? '' : 's'} ·{' '}
                            {design.field_count} field{design.field_count === 1 ? '' : 's'}
                          </div>
                          <div className="text-[11px] text-[#657794] mt-0.5">
                            Scope: {design.scope_summary || 'all_sites'} ({design.signal_count} sig /{' '}
                            {design.model_count} mdl)
                          </div>
                        </td>

                        {/* Recording Mode */}
                        <td className="py-3.5 px-3 align-top">
                          <div className="flex flex-wrap gap-1">
                            {(design.recording_modes?.length
                              ? design.recording_modes
                              : [design.primary_recording_mode]
                            ).map((mode) => (
                              <span
                                key={mode}
                                className="px-2 py-0.5 rounded font-mono text-[11px] font-semibold bg-[#F1F5F9] text-[#111B37] border border-[#CBD5E1]"
                              >
                                {mode}
                              </span>
                            ))}
                          </div>
                        </td>

                        {/* Retention */}
                        <td className="py-3.5 px-3 align-top">
                          <div className="font-semibold text-[#111B37]">
                            {design.retention_days} days
                          </div>
                          {design.legal_hold ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#B91C1C] mt-0.5">
                              <Lock className="w-3 h-3" /> Legal Hold
                            </span>
                          ) : (
                            <span className="text-[11px] text-[#657794]">Standard TTL</span>
                          )}
                        </td>

                        {/* Destination (Always TDengine) */}
                        <td className="py-3.5 px-3 align-top">
                          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0] font-semibold text-[11px]">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#0DBA67]" />
                            TDengine
                          </div>
                          <div className="text-[10px] font-mono text-[#657794] mt-0.5">
                            {design.td_database || 'fx_t_default'}
                          </div>
                        </td>

                        {/* Version / Updated */}
                        <td className="py-3.5 px-3 align-top">
                          <div className="flex items-center gap-1.5">
                            <span className="px-2 py-0.5 rounded font-mono text-[11px] font-bold bg-[#F1F5F9] text-[#111B37] border border-[#E2E8F0]">
                              v{design.current_version}
                            </span>
                            {design.published_version && (
                              <span className="text-[10px] text-[#059669] font-semibold">
                                pub v{design.published_version}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[#657794] mt-0.5">
                            {formatRelativeOrShortDate(design.updated_at || design.created_at)}
                          </div>
                        </td>

                        {/* Row Actions */}
                        <td className="py-3.5 px-4 align-top text-right">
                          <div className="inline-flex items-center justify-end flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() => handleOpenDetail(design.id)}
                              className="px-2 py-1 rounded border border-[#E3EAF3] bg-white text-[#111B37] hover:bg-[#F8FAFC] font-semibold inline-flex items-center gap-1"
                              title="View 6-Tab Catalog Detail"
                            >
                              <Eye className="w-3 h-3 text-[#134074]" />
                              Detail
                            </button>

                            <button
                              type="button"
                              onClick={() => handleOpenDesigner(design.id)}
                              className="px-2 py-1 rounded border border-[#E3EAF3] bg-white text-[#111B37] hover:bg-[#F8FAFC] font-semibold inline-flex items-center gap-1"
                              title="Edit in Storage Designer"
                            >
                              <Edit3 className="w-3 h-3 text-[#134074]" />
                              Edit
                            </button>

                            <button
                              type="button"
                              onClick={() => handleOpenHistorian(design.id)}
                              className="px-2 py-1 rounded border border-[#BFDBFE] bg-[#EFF6FF] text-[#1D4ED8] hover:bg-[#DBEAFE] font-semibold inline-flex items-center gap-1"
                              title="Open in Historian Explorer"
                            >
                              <LineChart className="w-3 h-3" />
                              Historian
                            </button>

                            {(design.status === 'RUNNING' || design.status === 'PAUSED') && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleRowPauseResume(design)}
                                className={`p-1.5 rounded border ${
                                  design.status === 'RUNNING'
                                    ? 'border-[#FDE68A] bg-[#FFFBEB] text-[#B45309] hover:bg-[#FEF3C7]'
                                    : 'border-[#A7F3D0] bg-[#ECFDF5] text-[#047857] hover:bg-[#D1FAE5]'
                                }`}
                                title={
                                  design.status === 'RUNNING'
                                    ? 'Pause Recording'
                                    : 'Resume Recording'
                                }
                              >
                                {design.status === 'RUNNING' ? (
                                  <Pause className="w-3.5 h-3.5" />
                                ) : (
                                  <Play className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleRowDuplicate(design)}
                              className="p-1.5 rounded border border-[#E3EAF3] bg-white text-[#475569] hover:bg-[#F8FAFC]"
                              title="Duplicate Design"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleRowExport(design, 'yaml')}
                              className="p-1.5 rounded border border-[#E3EAF3] bg-white text-[#475569] hover:bg-[#F8FAFC]"
                              title="Export YAML Bundle"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setArchivePromptTarget(design)}
                              className="p-1.5 rounded border border-[#E3EAF3] bg-white text-[#475569] hover:bg-[#FEF2F2] hover:text-[#DC2626] hover:border-[#FECACA]"
                              title={
                                design.status === 'ARCHIVED' ? 'Restore Design' : 'Archive Design'
                              }
                            >
                              {design.status === 'ARCHIVED' ? (
                                <RotateCcw className="w-3.5 h-3.5" />
                              ) : (
                                <Archive className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Operations Log Slide-over Drawer */}
      {opsDrawerOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex justify-end">
          <div className="bg-white w-full max-w-xl h-full shadow-2xl border-l border-[#E3EAF3] flex flex-col">
            <div className="px-6 py-4 border-b border-[#E3EAF3] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#134074]" />
                <h2 className="text-sm font-bold text-[#111B37]">
                  Storage Operations Audit Log ({operations.length})
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOpsDrawerOpen(false)}
                className="p-1.5 rounded-lg text-[#657794] hover:text-[#111B37] hover:bg-[#F8FAFC]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-[#F8FAFC] border-b border-[#E3EAF3] text-xs text-[#657794]">
              Tracks two-phase TDengine DDL execution, publish transitions, pause/resume commands, and retention enforcement jobs across all designs.
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-[#E3EAF3]">
              {operations.length === 0 ? (
                <div className="p-10 text-center text-xs text-[#657794]">
                  <Clock className="w-6 h-6 mx-auto mb-2 text-[#94A3B8]" />
                  No storage operations recorded yet. Publish or update a design to see audit records.
                </div>
              ) : (
                operations.map((op) => (
                  <div key={op.id} className="p-4 hover:bg-[#F8FAFC] text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-[#111B37]">
                        {op.operation_type}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          op.status === 'COMPLETED' || op.status === 'SUCCEEDED'
                            ? 'bg-[#ECFDF5] text-[#059669] border-[#A7F3D0]'
                            : op.status === 'FAILED'
                            ? 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]'
                            : 'bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]'
                        }`}
                      >
                        {op.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-[#657794]">
                      <span className="font-mono">ID: {op.id}</span>
                      <span>{formatRelativeOrShortDate(op.requested_at)}</span>
                    </div>
                    {op.design_id && (
                      <div className="text-[11px]">
                        Target Design:{' '}
                        <button
                          type="button"
                          onClick={() => {
                            setOpsDrawerOpen(false);
                            handleOpenDetail(op.design_id!);
                          }}
                          className="font-semibold text-[#134074] hover:underline"
                        >
                          {op.design_name || op.design_id}
                        </button>
                      </div>
                    )}
                    {op.error_message && (
                      <div className="text-[11px] text-[#DC2626] font-mono">
                        {op.error_message}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import Storage Design Modal */}
      {importModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white border border-[#E3EAF3] rounded-xl max-w-2xl w-full shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-[#E3EAF3] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileUp className="w-4 h-4 text-[#134074]" />
                <h2 className="text-sm font-bold text-[#111B37]">
                  Import Storage Design Bundle (YAML / JSON)
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setImportModalOpen(false)}
                className="p-1 text-[#657794] hover:text-[#111B37]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleImportSubmit(e)} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-[#111B37] mb-1">
                    Override Design Name (optional)
                  </label>
                  <input
                    type="text"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="Uses metadata.name from bundle if blank"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs text-[#111B37] focus:outline-none focus:border-[#134074]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#111B37] mb-1">
                    Bundle Format
                  </label>
                  <select
                    value={importFormat}
                    onChange={(e) => setImportFormat(e.target.value as 'yaml' | 'json')}
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs font-semibold text-[#111B37] bg-white focus:outline-none focus:border-[#134074]"
                  >
                    <option value="yaml">StorageDSL YAML</option>
                    <option value="json">StorageDSL JSON</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#111B37] mb-1">
                  StorageDSL Specification Content
                </label>
                <textarea
                  rows={12}
                  value={importContent}
                  onChange={(e) => setImportContent(e.target.value)}
                  className="w-full p-3 rounded-lg border border-[#CBD5E1] bg-[#0F172A] text-[#E2E8F0] font-mono text-xs focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setImportModalOpen(false)}
                  className="px-4 py-2 rounded-lg text-xs font-semibold border border-[#E3EAF3] bg-white text-[#111B37] hover:bg-[#F8FAFC]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={importBusy}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#EF1B24] text-white hover:bg-[#DC2626] disabled:opacity-50"
                >
                  {importBusy ? 'Importing…' : 'Validate & Import Design'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Archive / Restore Confirmation Modal */}
      {archivePromptTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white border border-[#E3EAF3] rounded-xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <Archive className="w-5 h-5 text-[#EF1B24] shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-bold text-[#111B37]">
                  {archivePromptTarget.status === 'ARCHIVED'
                    ? `Restore "${archivePromptTarget.name}"?`
                    : `Archive "${archivePromptTarget.name}"?`}
                </h3>
                <p className="text-xs text-[#657794] mt-1.5 leading-relaxed">
                  {archivePromptTarget.status === 'ARCHIVED'
                    ? 'Restoring returns this design to PAUSED state so it can be resumed or edited.'
                    : archivePromptTarget.status === 'RUNNING'
                    ? 'This design is currently RUNNING. Confirming will pause active ingestion bindings and archive the design. Historical TDengine STables and subtables are preserved and remain queryable in the Historian.'
                    : 'Archiving retires active ingestion bindings while preserving all historical TDengine STables and subtables.'}
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setArchivePromptTarget(null)}
                className="px-3.5 py-2 rounded-lg text-xs font-semibold border border-[#E3EAF3] bg-white text-[#111B37] hover:bg-[#F8FAFC]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void handleConfirmArchiveOrRestore()}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#EF1B24] text-white hover:bg-[#DC2626] disabled:opacity-50"
              >
                {archivePromptTarget.status === 'ARCHIVED' ? 'Confirm Restore' : 'Confirm Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorageCatalogPage;
