import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Search,
  ChevronRight,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  Layers,
  Filter,
  Download,
  Plus,
  RefreshCw,
  LayoutGrid,
  Table as TableIcon,
  Check,
  Trash2,
  Square,
  CheckSquare,
  AlertCircle,
  Activity,
  BarChart2,
  Pencil,
  X,
} from 'lucide-react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { SignalItem, ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { TrendChart } from './TrendChart';
import { SignalSparkline } from './SignalSparkline';
import { SignalInspector } from './SignalInspector';
import { SignalEditDialog } from './SignalEditDialog';
import { BulkAddressDialog } from './BulkAddressDialog';
import { BulkPropertiesDialog } from './BulkPropertiesDialog';
import { sortBySourceOrder } from './signalOrder';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { api } from '../../api/client';
import { PROTOCOL_LABEL } from '../../lib/protocols';
import { formatTimestamp, formatValue, normalizeQuality, timeAgo } from '../../lib/format';
import { fetchSignalUsage, fetchSignalsUsage } from '../../lib/impactApi';
import { indeterminateRef, useRangeSelection } from './useRangeSelection';
import { useSubmit } from '../../lib/useSubmit';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { translateApiError } from '../../utils/apiErrors';
import { ModelUsageList, useModelUsage } from './ModelUsageList';

interface CatalogTreeNodeProps {
  node: { resource: ResourceNode; children: any[] };
  selectedFilter: string;
  onSelect: (filterKey: string) => void;
  expanded: Record<string, boolean>;
  onToggle: (id: string, e: React.MouseEvent) => void;
  rollupCounts: Map<string, number>;
  directCounts: Map<string, number>;
  depth?: number;
}

const CatalogTreeItem: React.FC<CatalogTreeNodeProps> = ({
  node,
  selectedFilter,
  onSelect,
  expanded,
  onToggle,
  rollupCounts,
  directCounts,
  depth = 0,
}) => {
  const isSelected = selectedFilter === node.resource.id;
  const isExpanded = expanded[node.resource.id] !== false; // default open
  const directCount = directCounts.get(node.resource.id) || 0;
  const rollupCount = rollupCounts.get(node.resource.id) || 0;
  const hasDirectData = directCount > 0;
  const hasSubUnits = node.children.length > 0;
  const hasExpandable = hasSubUnits || hasDirectData;

  const dataFilterKey = `data:${node.resource.id}`;
  const isDataSelected = selectedFilter === dataFilterKey;

  return (
    <div className="text-[12px] select-none" role="none">
      {/* Asset Structure Row */}
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isSelected}
        aria-expanded={hasExpandable ? isExpanded : undefined}
        aria-label={`${node.resource.name || node.resource.code}, ${rollupCount} signal${rollupCount === 1 ? '' : 's'}`}
        tabIndex={0}
        title={node.resource.name}
        onClick={() => onSelect(node.resource.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(node.resource.id);
          }
        }}
        className={`flex items-center justify-between py-1 px-1.5 rounded-lg cursor-pointer transition ${
          isSelected
            ? 'bg-[#0B2545] text-white font-bold shadow-xs'
            : 'hover:bg-slate-100 text-slate-700'
        }`}
      >
        <div className="flex items-center gap-1 min-w-0 pr-1">
          {hasExpandable ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={isExpanded ? `Collapse ${node.resource.name}` : `Expand ${node.resource.name}`}
              onClick={(e) => onToggle(node.resource.id, e)}
              className="p-0.5 hover:bg-black/10 rounded shrink-0"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="truncate">{node.resource.name}</span>
        </div>
        <span
          className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold shrink-0 ${
            isSelected
              ? 'bg-white/20 text-white'
              : 'bg-slate-100 text-slate-500'
          }`}
          title={`Rollup signals in this subtree: ${rollupCount}`}
        >
          {rollupCount}
        </span>
      </div>

      {/* Expanded Sub-tree: Special Data Nav + Child Units */}
      {hasExpandable && isExpanded && (
        <div role="group" className="pl-3 border-l border-slate-200 ml-2 mt-0.5 space-y-0.5">
          {/* Distinct Special Data Nav Child */}
          {hasDirectData && (
            <div
              role="treeitem"
              aria-level={depth + 2}
              aria-selected={isDataSelected}
              aria-label={`Signals of ${node.resource.name} (${directCount})`}
              tabIndex={0}
              title={`Signals bound directly to ${node.resource.name}`}
              onClick={() => onSelect(dataFilterKey)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(dataFilterKey);
                }
              }}
              className={`flex items-center justify-between py-1 px-1.5 rounded-lg cursor-pointer transition ${
                isDataSelected
                  ? 'bg-emerald-700 text-white font-bold shadow-xs'
                  : 'hover:bg-emerald-50/80 text-emerald-800 bg-emerald-50/40'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0 pr-1">
                <Activity className={`w-3.5 h-3.5 shrink-0 ${isDataSelected ? 'text-white' : 'text-emerald-600 animate-pulse'}`} />
                <span className="truncate font-bold text-[11px]">
                  Signals
                </span>
              </div>
              <span
                className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-extrabold shrink-0 ${
                  isDataSelected
                    ? 'bg-white/25 text-white'
                    : 'bg-emerald-100 text-emerald-800'
                }`}
                title={`Direct signals: ${directCount}`}
              >
                {directCount}
              </span>
            </div>
          )}

          {/* Child Resource Units */}
          {node.children.map((child: any) => (
            <CatalogTreeItem
              key={child.resource.id}
              node={child}
              selectedFilter={selectedFilter}
              onSelect={onSelect}
              expanded={expanded}
              onToggle={onToggle}
              rollupCounts={rollupCounts}
              directCounts={directCounts}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

function classifyType(typeStr: string | undefined): 'number' | 'integer' | 'boolean' | 'text' {
  const t = (typeStr || '').toLowerCase();
  if (t === 'integer' || t === 'int' || t === 'int64' || t === 'uint16' || t === 'int32') return 'integer';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'text' || t === 'string') return 'text';
  return 'number';
}

export const SignalsCatalogPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signals, resources, connections, refresh, loadState } = useApp();
  const [bulkAddressOpen, setBulkAddressOpen] = useState(false);
  const [bulkPropertiesOpen, setBulkPropertiesOpen] = useState(false);

  // R2-SG-02: arriving from Add Data (or any navigation) starts at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  // URL Query Sync
  const viewMode = searchParams.get('view') === 'live' ? 'live' : 'table';
  const resourceFilter = searchParams.get('resourceId') || 'all';
  const connectionFilter = searchParams.get('connectionId') || 'all';
  const initialSignalId = searchParams.get('signalId') || null;

  // Local Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'number' | 'integer' | 'boolean' | 'text'>('all');
  const [qualityFilter, setQualityFilter] = useState<'all' | 'good' | 'uncertain' | 'bad' | 'stale' | 'paused' | 'no_data' | 'disabled'>('all');
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [expandedTreeNodes, setExpandedTreeNodes] = useState<Record<string, boolean>>({});

  // Inspector & Edit Dialog State
  const [selectedSignalId, setSelectedSignalIdState] = useState<string | null>(null);
  // Always derive the inspected signal from the live list so its value keeps updating.
  const selectedSignal = useMemo(
    () => (selectedSignalId ? signals.find((s) => s.id === selectedSignalId) || null : null),
    [selectedSignalId, signals]
  );
  const setSelectedSignal = (sig: SignalItem | null) => setSelectedSignalIdState(sig ? sig.id : null);
  const [editTarget, setEditTarget] = useState<SignalItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SignalItem | null>(null);
  // R3-DM-02: disabling asks for confirmation too; both dialogs list the data models that use the signal.
  const [disableTarget, setDisableTarget] = useState<SignalItem | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const impactTarget = deleteTarget || disableTarget;
  // Bumped on every open so the usage is re-read each time a dialog opens.
  const [impactSeq, setImpactSeq] = useState(0);
  const [usage, retryUsage] = useModelUsage(impactTarget ? `${impactTarget.id}:${impactSeq}` : null, () =>
    impactTarget ? fetchSignalUsage(impactTarget.id) : Promise.resolve([]),
  );

  // Bulk Selection
  // Bulk selection with Shift+click ranges over the visible (filtered) order; see below.
  const allSignalIds = useMemo(() => signals.map((s) => s.id), [signals]);
  const [trendSignals, setTrendSignals] = useState<SignalItem[]>([]);
  const [timeframe, setTimeframe] = useState<'15m' | '1h' | '6h'>('15m');

  // Toast / Feedback (shared toast: pauses on hover / focus, keyboard reachable).
  const { toast, show: showActionToast, dismiss: dismissToast } = useActionToast();
  const showToast = (msg: string, tone: 'info' | 'error' = 'info') => showActionToast({ message: msg, tone });

  // Open initial signal inspector from URL (TC-UI-SG-19)
  useEffect(() => {
    if (initialSignalId) setSelectedSignalIdState(initialSignalId);
  }, [initialSignalId]);

  // View toggle helper
  const setViewMode = (mode: 'table' | 'live') => {
    const nextParams = new URLSearchParams(searchParams);
    if (mode === 'live') nextParams.set('view', 'live');
    else nextParams.delete('view');
    setSearchParams(nextParams);
  };

  // Subtree resolver for hierarchy filtering
  const getResourceSubtree = useCallback(
    (rootId: string) => {
      const resSet = new Set<string>([rootId]);
      const queue = [rootId];
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        for (const r of resources) {
          if (r.parentId === parentId && !resSet.has(r.id)) {
            resSet.add(r.id);
            queue.push(r.id);
          }
        }
      }
      return resSet;
    },
    [resources]
  );

  // Counts: Direct signals and Rollup subtree signals
  const { directCounts, rollupCounts } = useMemo(() => {
    const direct = new Map<string, number>();
    signals.forEach((s) => {
      if (s.resourceId) direct.set(s.resourceId, (direct.get(s.resourceId) || 0) + 1);
    });

    const rollup = new Map<string, number>();
    resources.forEach((r) => {
      let count = 0;
      const sub = getResourceSubtree(r.id);
      sub.forEach((id) => {
        count += direct.get(id) || 0;
      });
      rollup.set(r.id, count);
    });

    return { directCounts: direct, rollupCounts: rollup };
  }, [resources, signals, getResourceSubtree]);

  const toggleTreeNodeExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedTreeNodes((prev) => ({
      ...prev,
      [id]: prev[id] === undefined ? false : !prev[id],
    }));
  };

  const handleExpandAll = () => {
    const next: Record<string, boolean> = {};
    for (const r of resources) {
      next[r.id] = true;
    }
    setExpandedTreeNodes(next);
  };

  const handleCollapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const r of resources) {
      next[r.id] = false;
    }
    setExpandedTreeNodes(next);
  };

  // Filtered Signals, in source order (R2-SG-02).
  const orderedSignals = useMemo(() => sortBySourceOrder(signals, resources), [signals, resources]);
  const filteredSignals = useMemo(() => {
    return orderedSignals.filter((s) => {
      // 1. Hierarchy Tree Filter
      if (selectedFilter !== 'all') {
        if (selectedFilter.startsWith('data:')) {
          const targetResId = selectedFilter.replace('data:', '');
          if (s.resourceId !== targetResId) return false;
        } else {
          const subtree = getResourceSubtree(selectedFilter);
          if (!subtree.has(s.resourceId)) return false;
        }
      }

      // 2. Dropdown Resource Filter
      if (resourceFilter !== 'all' && s.resourceId !== resourceFilter) {
        return false;
      }

      // 3. Connection Filter
      if (
        connectionFilter !== 'all' &&
        s.sourceConnectionId !== connectionFilter &&
        s.connectionId !== connectionFilter
      ) {
        return false;
      }

      // 4. Search Query (matches key, displayName, or tag)
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const matchesKey = (s.key || '').toLowerCase().includes(q);
        const matchesTag = (s.tag || '').toLowerCase().includes(q);
        const matchesDisplay = (s.displayName || s.name || '').toLowerCase().includes(q);
        if (!matchesKey && !matchesTag && !matchesDisplay) return false;
      }

      // 5. Type Filter
      if (typeFilter !== 'all' && classifyType(s.dataType) !== typeFilter) {
        return false;
      }

      // 6. Quality Filter
      if (qualityFilter !== 'all') {
        const q = normalizeQuality(s.quality).toLowerCase();
        if (q !== qualityFilter) return false;
      }

      return true;
    });
  }, [
    orderedSignals,
    selectedFilter,
    resourceFilter,
    connectionFilter,
    searchTerm,
    typeFilter,
    qualityFilter,
    getResourceSubtree,
  ]);

  // Bulk Selection: Shift+click selects a range in the visible order; the header checkbox selects or
  // clears every visible (filtered) signal and leaves hidden selections alone.
  const visibleIds = useMemo(() => filteredSignals.map((s) => s.id), [filteredSignals]);
  const selection = useRangeSelection(visibleIds, allSignalIds);
  const selectedIds = useMemo(() => Array.from(selection.selected), [selection.selected]);
  const visibleSelectionState = selection.stateOf(visibleIds);
  const hiddenSelected = selectedIds.length - visibleIds.filter((id) => selection.selected.has(id)).length;
  const setSelectedIds = (next: string[] | ((prev: string[]) => string[])) => {
    const list = typeof next === 'function' ? next(selectedIds) : next;
    selection.clear();
    selection.setMany(list, true);
  };

  const handleToggleSelectAll = () => {
    selection.setMany(visibleIds, visibleSelectionState !== 'all');
  };

  const handleToggleSelect = (id: string, shift = false) => selection.toggle(id, shift);

  // Bulk enable / disable / delete of the selected signals (POST /signals/bulk-action), confirmed with
  // the data models that use them.
  const [bulkAction, setBulkAction] = useState<'enable' | 'disable' | 'delete' | null>(null);
  const [bulkSeq, setBulkSeq] = useState(0);
  const bulkIdsRef = React.useRef<string[]>([]);
  bulkIdsRef.current = selectedIds;
  const [bulkUsage, retryBulkUsage] = useModelUsage(bulkAction && bulkAction !== 'enable' ? `bulk:${bulkSeq}` : null, () =>
    fetchSignalsUsage(bulkIdsRef.current),
  );
  const openBulk = (action: 'enable' | 'disable' | 'delete') => {
    setDialogError(null);
    setBulkSeq((n) => n + 1);
    setBulkAction(action);
  };
  const runBulk = async () => {
    const action = bulkAction;
    if (!action) return;
    const ids = selectedIds;
    try {
      const result = await api<{ affected?: number }>('/api/v1/signals/bulk-action', {
        method: 'POST',
        body: JSON.stringify({ signal_ids: ids, action }),
      });
      setBulkAction(null);
      if (action === 'delete') {
        if (selectedSignalId && ids.includes(selectedSignalId)) setSelectedSignal(null);
        setTrendSignals((prev) => prev.filter((s) => !ids.includes(s.id)));
        selection.clear();
      }
      await refresh().catch((error) => console.warn('Refresh after the bulk action failed', error));
      const n = result?.affected ?? ids.length;
      showToast(`${n} signal${n === 1 ? '' : 's'} ${action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'deleted'}`);
    } catch (error) {
      setDialogError(`Could not ${action} the selected signals: ${translateApiError(error)}`);
    }
  };

  // Trend Chart Toggle
  const handleToggleTrend = (sig: SignalItem) => {
    setTrendSignals((prev) => {
      const exists = prev.some((s) => s.id === sig.id);
      if (exists) return prev.filter((s) => s.id !== sig.id);
      if (prev.length >= 4) {
        showToast('Maximum 4 signals can be plotted on trend simultaneously');
        return prev;
      }
      return [...prev, sig];
    });
  };

  /** PATCH enabled; in-flight guarded so a double click sends one request (R3-DM-04). */
  const setEnabled = useSubmit(async (sig: SignalItem, nextEnabled: boolean): Promise<boolean> => {
    try {
      await api(`/api/v1/signals/${encodeURIComponent(sig.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: sig.version ?? 1, enabled: nextEnabled }),
      });
      await refresh().catch((error) => console.warn('Refresh after the signal update failed', error));
      showToast(`Signal ${sig.key || sig.name} ${nextEnabled ? 'enabled' : 'disabled'}`);
      return true;
    } catch (error) {
      await refresh().catch((refreshError) => console.warn('Refresh after a failed signal update failed', refreshError));
      const message = `Could not ${nextEnabled ? 'enable' : 'disable'} ${sig.key || sig.name}: ${translateApiError(error)}`;
      if (nextEnabled) showToast(message, 'error');
      else setDialogError(message);
      return false;
    }
  });

  const handleToggleEnabled = (sig: SignalItem) => {
    if (sig.enabled === false) {
      void setEnabled.run(sig, true);
      return;
    }
    setDialogError(null);
    setImpactSeq((n) => n + 1);
    setDisableTarget(sig);
  };

  const handleDisable = async () => {
    const sig = disableTarget;
    if (!sig) return;
    const ok = await setEnabled.run(sig, false);
    if (ok) setDisableTarget(null);
  };

  const handleDelete = async () => {
    const sig = deleteTarget;
    if (!sig) return;
    setDialogError(null);
    try {
      await api(`/api/v1/signals/${encodeURIComponent(sig.id)}`, { method: 'DELETE' });
      setDeleteTarget(null);
      if (selectedSignalId === sig.id) setSelectedSignal(null);
      setTrendSignals((prev) => prev.filter((s) => s.id !== sig.id));
      setSelectedIds((prev) => prev.filter((id) => id !== sig.id));
      await refresh().catch((error) => console.warn('Refresh after the signal delete failed', error));
      showToast(`Signal ${sig.key || sig.name} deleted`);
    } catch (error) {
      setDialogError(`Could not delete ${sig.key || sig.name}: ${translateApiError(error)}`);
    }
  };

  const usageModels = usage.status === 'ready' ? usage.models : [];
  const runningUsage = usageModels.filter((m) => m.status === 'RUNNING').length;

  const handleExportCsv = () => {
    const listToExport =
      selectedIds.length > 0
        ? filteredSignals.filter((s) => selectedIds.includes(s.id))
        : filteredSignals;
    // Quote every cell; neutralise spreadsheet formulas (=, +, -, @, tab, CR) like the Center CSV export.
    const cell = (value: unknown) => {
      let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = [
      ['signal_key', 'display_name', 'resource', 'value', 'unit', 'quality', 'last_read', 'last_change'],
      ...listToExport.map((s) => {
        const res = resources.find((r) => r.id === s.resourceId);
        return [
          s.key || s.tag || '',
          s.displayName || s.name || '',
          res?.name || s.resourcePath || '',
          s.value,
          s.unit || '',
          normalizeQuality(s.quality),
          s.lastAcquiredAt || s.receivedTime || s.lastUpdated || '',
          s.lastValueChangedAt || s.sourceTime || '',
        ].map(cell);
      }),
    ];
    const blob = new Blob([rows.map((e) => e.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `signals_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold text-[#111B37]">Signals</h1>
          <p className="text-[13px] text-[#657794]">
            {loadState !== 'ready' && signals.length === 0
              ? 'Signal catalog with live values (loading…)'
              : `Signal catalog with live values (${signals.length} signal${signals.length === 1 ? '' : 's'})`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View Mode Toggle */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            <button
              onClick={() => setViewMode('table')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-md transition ${
                viewMode === 'table'
                  ? 'bg-white text-[#111B37] shadow-xs'
                  : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              <TableIcon className="w-3.5 h-3.5" />
              Table
            </button>
            <button
              onClick={() => setViewMode('live')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-md transition ${
                viewMode === 'live'
                  ? 'bg-white text-[#111B37] shadow-xs'
                  : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Live
            </button>
          </div>

          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              // R2-AD-02: open the wizard on the resource the catalog is filtered by.
              const target =
                resourceFilter !== 'all'
                  ? resourceFilter
                  : selectedFilter !== 'all'
                    ? selectedFilter.replace(/^data:/, '')
                    : '';
              navigate(target ? `/collector/add-data?resourceId=${encodeURIComponent(target)}` : '/collector/add-data');
            }}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add data
          </Button>
        </div>
      </div>

      {/* 2-Column Layout: Hierarchy Tree Filter on Left, Signals on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
        {/* Left Column: Hierarchy Tree Filter */}
        <Card className="p-3 border border-[#CBD5E1] bg-white lg:col-span-1 space-y-2.5 lg:sticky lg:top-3 min-w-0">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <div className="flex items-center gap-1 text-xs font-bold text-[#0B2545]">
              <Layers className="w-3.5 h-3.5 text-[#134074]" />
              <span>Hierarchy</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleExpandAll}
                title="Expand All"
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200 transition-colors flex items-center gap-0.5"
              >
                <ChevronsDown className="w-3 h-3" />
                <span>Expand</span>
              </button>
              <button
                type="button"
                onClick={handleCollapseAll}
                title="Collapse All"
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200 transition-colors flex items-center gap-0.5"
              >
                <ChevronsUp className="w-3 h-3" />
                <span>Collapse</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedFilter('all')}
                className={`text-[11px] font-bold transition px-1.5 py-0.5 rounded ${
                  selectedFilter === 'all'
                    ? 'bg-[#0B2545] text-white'
                    : 'text-slate-500 hover:text-slate-800 bg-slate-100'
                }`}
              >
                {loadState !== 'ready' && signals.length === 0 ? 'All' : `All (${signals.length})`}
              </button>
            </div>
          </div>

          <div role="tree" aria-label="Filter signals by resource" className="max-h-[40vh] lg:max-h-none lg:h-[calc(100vh-260px)] lg:min-h-[550px] overflow-y-auto space-y-1 pr-1">
            {(() => {
              // Build tree roots
              const map = new Map<string, any>();
              resources.forEach((r) => map.set(r.id, { resource: r, children: [] }));
              const roots: any[] = [];
              resources.forEach((r) => {
                const node = map.get(r.id);
                if (r.parentId && map.has(r.parentId)) {
                  map.get(r.parentId).children.push(node);
                } else if (node) {
                  roots.push(node);
                }
              });

              const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
              const sortTree = (nodes: any[]) => {
                nodes.sort((a, b) => collator.compare(a.resource.name || a.resource.code, b.resource.name || b.resource.code));
                nodes.forEach((n) => sortTree(n.children));
              };
              sortTree(roots);
              return roots.map((root) => (
                <CatalogTreeItem
                  key={root.resource.id}
                  node={root}
                  selectedFilter={selectedFilter}
                  onSelect={(filterKey) => setSelectedFilter(filterKey)}
                  expanded={expandedTreeNodes}
                  onToggle={toggleTreeNodeExpand}
                  rollupCounts={rollupCounts}
                  directCounts={directCounts}
                />
              ));
            })()}
          </div>
        </Card>

        {/* Right Column: Filter Bar & Signals Content */}
        <div className="lg:col-span-3 space-y-3 min-w-0">
          {/* Active Hierarchy Filter Banner */}
          {selectedFilter !== 'all' && (
            <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-blue-50/80 border border-blue-200 text-xs text-[#0B2545]">
              <div className="flex items-center gap-1.5">
                <span className="font-bold">Filtered by:</span>
                <span className="font-semibold text-blue-900">
                  {selectedFilter.startsWith('data:')
                    ? `Signals bound directly to ${resources.find((r) => r.id === selectedFilter.replace('data:', ''))?.name || ''}`
                    : resources.find((r) => r.id === selectedFilter)?.name || selectedFilter}
                </span>
                <span className="text-[#64748B] font-mono">({filteredSignals.length} signals)</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedFilter('all')}
                className="text-[11px] font-bold text-blue-700 hover:underline"
              >
                Clear filter (Show all {signals.length})
              </button>
            </div>
          )}

          {/* Filter Bar */}
          <Card className="p-3 border border-[#CBD5E1] bg-white space-y-2.5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              {/* Search */}
              <div className="relative flex-1 max-w-sm">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search variable name or key…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>

              {/* Resource & Connection Pickers */}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={resourceFilter}
                  onChange={(e) => {
                    const next = new URLSearchParams(searchParams);
                    if (e.target.value === 'all') next.delete('resourceId');
                    else next.set('resourceId', e.target.value);
                    setSearchParams(next);
                  }}
                  className="px-2.5 py-1.5 border border-slate-300 rounded text-[12px] bg-white text-[#111B37] focus:outline-none"
                >
                  <option value="all">All Resources</option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.type})
                    </option>
                  ))}
                </select>

                <select
                  value={connectionFilter}
                  onChange={(e) => {
                    const next = new URLSearchParams(searchParams);
                    if (e.target.value === 'all') next.delete('connectionId');
                    else next.set('connectionId', e.target.value);
                    setSearchParams(next);
                  }}
                  className="px-2.5 py-1.5 border border-slate-300 rounded text-[12px] bg-white text-[#111B37] focus:outline-none"
                >
                  <option value="all">All Connections</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({PROTOCOL_LABEL[c.protocol]})
                    </option>
                  ))}
                </select>

                <Button variant="outline" size="sm" onClick={handleExportCsv} className="h-8 text-[11px]">
                  <Download className="w-3 h-3 mr-1" />
                  Export CSV
                </Button>
              </div>
            </div>

            {/* Filter Pills: Type & Quality */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-[12px]">
              {/* Data Type Pills */}
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[#657794] mr-1 text-[11px] font-semibold uppercase">Type:</span>
                {(['all', 'number', 'integer', 'boolean', 'text'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium capitalize transition ${
                      typeFilter === t
                        ? 'bg-blue-50 text-blue-700 border border-blue-200 font-bold'
                        : 'text-[#657794] hover:text-[#111B37]'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Quality Pills */}
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[#657794] mr-1 text-[11px] font-semibold uppercase">Quality:</span>
                {(['all', 'good', 'uncertain', 'bad', 'stale', 'paused', 'no_data', 'disabled'] as const).map((q) => (
                  <button
                    key={q}
                    onClick={() => setQualityFilter(q)}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium capitalize transition ${
                      qualityFilter === q
                        ? 'bg-slate-800 text-white font-bold'
                        : 'text-[#657794] hover:text-[#111B37]'
                    }`}
                  >
                    {q === 'no_data' ? 'no data' : q}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          {/* Bulk actions for the selected signals */}
          {selectedIds.length > 0 && (
            <div role="toolbar" aria-label="Selected signals" className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl border border-blue-200 bg-blue-50/70 text-[12px] text-[#0B2545]">
              <span className="font-bold">
                {selectedIds.length} selected
                {hiddenSelected > 0 && <span className="font-normal text-[#657794]"> ({hiddenSelected} hidden by filters)</span>}
              </span>
              {visibleSelectionState !== 'all' && visibleIds.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => selection.setMany(visibleIds, true)}>
                  Select all {visibleIds.length} shown
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => openBulk('enable')}>
                Enable
              </Button>
              <Button variant="outline" size="sm" onClick={() => openBulk('disable')}>
                Disable…
              </Button>
              <Button variant="danger" size="sm" onClick={() => openBulk('delete')}>
                <Trash2 className="w-3.5 h-3.5" /> Delete…
              </Button>
              <Button variant="outline" size="sm" onClick={() => setBulkPropertiesOpen(true)}>
                <Pencil className="w-3.5 h-3.5" /> Edit properties…
              </Button>
              <Button variant="outline" size="sm" onClick={() => setBulkAddressOpen(true)}>
                <Pencil className="w-3.5 h-3.5" /> Edit source address…
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
                <X className="w-3.5 h-3.5" /> Clear selection
              </Button>
            </div>
          )}

          {/* VIEW: LIVE CARDS */}
          {viewMode === 'live' && loadState !== 'ready' && (
            <Card className="border border-[#CBD5E1] bg-white">
              <LoadStateNotice subject="the signals" />
            </Card>
          )}
          {viewMode === 'live' && loadState === 'ready' && (
            <div className="space-y-4">
              {trendSignals.length > 0 && (
                <Card className="p-4 border border-[#CBD5E1] bg-white">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[13px] font-bold text-[#111B37] flex items-center gap-2">
                      <BarChart2 className="w-4 h-4 text-blue-600" />
                      <span>Comparative Trend ({trendSignals.length}/4)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {(['15m', '1h', '6h'] as const).map((tf) => (
                        <button
                          key={tf}
                          onClick={() => setTimeframe(tf)}
                          className={`px-2 py-0.5 text-[11px] rounded transition ${
                            timeframe === tf
                              ? 'bg-slate-800 text-white font-bold'
                              : 'text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>
                  </div>
                  <TrendChart
                    selectedSignals={trendSignals}
                    timeframe={timeframe}
                    onTimeframeChange={(tf) => setTimeframe(tf)}
                  />
                </Card>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredSignals.map((sig) => {
                  const res = resources.find((r) => r.id === sig.resourceId);
                  const isSelectedForTrend = trendSignals.some((s) => s.id === sig.id);
                  const formattedVal = formatValue(sig.value);

                  return (
                    <div
                      key={sig.id}
                      onClick={() => setSelectedSignal(sig)}
                      className={`p-3.5 rounded-xl border bg-white cursor-pointer transition hover:shadow-sm ${
                        isSelectedForTrend
                          ? 'border-blue-500 ring-2 ring-blue-100'
                          : 'border-[#CBD5E1] hover:border-slate-400'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          {/* Variable Name in font-mono */}
                          <div className="text-[13px] font-bold font-mono text-[#0B2545] truncate max-w-[150px]">
                            {sig.key || sig.tag || sig.name}
                          </div>
                          <div className="text-[11px] text-[#657794] font-mono truncate max-w-[150px]">
                            {res?.name || sig.resourcePath || '—'}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleTrend(sig);
                          }}
                          className={`p-1 rounded text-[11px] font-semibold transition ${
                            isSelectedForTrend
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                          title="Plot on trend chart"
                        >
                          Trend
                        </button>
                      </div>

                      <div className="mt-2.5">
                        <div className="text-[22px] font-black font-mono text-[#0B2545] tabular-nums truncate">
                          {formattedVal}
                        </div>
                      </div>

                      <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                        <StatusBadge status={sig.quality || 'NO_DATA'} />
                        <span
                          className="text-[#657794] font-mono text-[10px] text-right"
                          title={`Last read ${formatTimestamp(sig.lastAcquiredAt || sig.receivedTime || sig.lastUpdated)} · Last change ${formatTimestamp(sig.lastValueChangedAt || sig.sourceTime)}`}
                        >
                          read {timeAgo(sig.lastAcquiredAt || sig.receivedTime || sig.lastUpdated)}
                          {(sig.lastValueChangedAt || sig.sourceTime) ? ` · changed ${timeAgo(sig.lastValueChangedAt || sig.sourceTime)}` : ''}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* VIEW: TABLE */}
          {viewMode === 'table' && (
            <Card className="border border-[#CBD5E1] bg-white overflow-hidden">
              {loadState !== 'ready' ? (
                <LoadStateNotice subject="the signals" />
              ) : filteredSignals.length === 0 ? (
                <div className="p-12 text-center text-[#657794]">
                  <Search className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-[13px] font-semibold text-[#111B37]">{signals.length ? 'No signals found' : 'No signals yet'}</p>
                  <p className="text-[12px] text-[#657794] mt-1">
                    {signals.length ? 'Try adjusting your hierarchy filter or search term.' : 'Use "Add data" to map source fields of a connection to signals.'}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-[12px]">
                    <thead className="bg-[#F8FAFC] border-b border-[#CBD5E1] text-[#657794] font-semibold uppercase text-[10px] tracking-wider">
                      <tr>
                        <th className="py-2.5 px-3 w-8">
                          <input
                            type="checkbox"
                            ref={indeterminateRef(visibleSelectionState === 'some')}
                            checked={visibleSelectionState === 'all'}
                            onChange={handleToggleSelectAll}
                            aria-label={`Select all ${visibleIds.length} shown signals`}
                            title="Select all shown signals (respects the filters). Shift+click a row checkbox to select a range."
                            className="rounded border-slate-300 text-blue-600 focus:ring-0"
                          />
                        </th>
                        <th className="py-2.5 px-3">Signal Variable</th>
                        <th className="py-2.5 px-3">Resource</th>
                        <th className="py-2.5 px-3">Value</th>
                        <th className="py-2.5 px-3">Trend 15 min</th>
                        <th className="py-2.5 px-3">Quality</th>
                        <th className="py-2.5 px-3 text-right">Last read</th>
                        <th className="py-2.5 px-3 text-right">Last change</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredSignals.map((sig) => {
                        const res = resources.find((r) => r.id === sig.resourceId);
                        const isChecked = selection.isSelected(sig.id);
                        const formattedVal = formatValue(sig.value);

                        return (
                          <tr
                            key={sig.id}
                            onClick={(e) => {
                              if (e.shiftKey) {
                                e.preventDefault();
                                handleToggleSelect(sig.id, true);
                                return;
                              }
                              setSelectedSignal(sig);
                            }}
                            className={`hover:bg-slate-50 cursor-pointer transition ${
                              isChecked ? 'bg-blue-50/30' : ''
                            }`}
                          >
                            <td
                              className="py-2.5 px-3 w-8"
                              onClick={(e) => {
                                e.stopPropagation();
                                // A click on the cell padding acts like a click on the checkbox.
                                if (e.target === e.currentTarget) handleToggleSelect(sig.id, e.shiftKey);
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                // Toggled in onClick so Shift (range) is known; Space fires a click too.
                                onChange={() => undefined}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleToggleSelect(sig.id, e.shiftKey);
                                }}
                                aria-label={`Select ${sig.key || sig.name}`}
                                className="rounded border-slate-300 text-blue-600 focus:ring-0"
                              />
                            </td>
                            {/* Strict variable naming: s.key in font-mono */}
                            <td className="py-2.5 px-3">
                              <div className="font-mono font-bold text-xs text-[#0B2545]">
                                {sig.key || sig.tag || sig.name}
                              </div>
                              {sig.displayName && sig.displayName !== (sig.key || sig.tag) && (
                                <div className="text-[10px] text-[#657794] truncate max-w-[160px]">
                                  {sig.displayName}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-[#657794] font-mono text-[11px] max-w-[220px] truncate" title={res?.name || sig.resourcePath}>
                              {res?.name || sig.resourcePath || '—'}
                            </td>
                            <td className="py-2.5 px-3 font-mono font-black text-xs text-[#0B2545] tabular-nums">
                              {formattedVal}
                            </td>
                            <td className="py-2.5 px-3">
                              {classifyType(sig.data_type || sig.dataType) === 'text' || classifyType(sig.data_type || sig.dataType) === 'boolean' ? (
                                <span className="text-slate-300 text-[11px]">—</span>
                              ) : (
                                <SignalSparkline signalId={sig.id} quality={sig.quality || 'NO_DATA'} />
                              )}
                            </td>
                            <td className="py-2.5 px-3">
                              <StatusBadge status={sig.quality || 'NO_DATA'} />
                            </td>
                            <td
                              className="py-2.5 px-3 text-right text-[#657794] font-mono text-[11px] whitespace-nowrap"
                              title={formatTimestamp(sig.lastAcquiredAt || sig.receivedTime || sig.lastUpdated)}
                            >
                              {timeAgo(sig.lastAcquiredAt || sig.receivedTime || sig.lastUpdated)}
                            </td>
                            <td
                              className="py-2.5 px-3 text-right text-[#657794] font-mono text-[11px] whitespace-nowrap"
                              title={formatTimestamp(sig.lastValueChangedAt || sig.sourceTime)}
                            >
                              {(sig.lastValueChangedAt || sig.sourceTime) ? timeAgo(sig.lastValueChangedAt || sig.sourceTime) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {/* Inspector Drawer */}
      <SignalInspector
        signal={selectedSignal}
        isOpen={Boolean(selectedSignal)}
        resourceName={resources.find((r) => r.id === selectedSignal?.resourceId)?.name}
        connectionName={selectedSignal?.sourceConnectionName || connections.find((c) => c.id === selectedSignal?.sourceConnectionId)?.name}
        edgeName={selectedSignal?.edgeName}
        onClose={() => setSelectedSignal(null)}
        onOpenHistorian={(sig) => navigate(`/historian/historian?signalId=${sig.id}`)}
        onEdit={(sig) => setEditTarget(sig)}
        onToggleEnabled={handleToggleEnabled}
        togglePending={setEnabled.pending}
        onDelete={(sig) => {
          setDialogError(null);
          setImpactSeq((n) => n + 1);
          setDeleteTarget(sig);
        }}
      />

      {/* Signal Edit / Reassign Dialog */}
      {editTarget && (
        <SignalEditDialog
          signal={editTarget}
          isOpen={Boolean(editTarget)}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void refresh();
          }}
        />
      )}

      <BulkPropertiesDialog
        isOpen={bulkPropertiesOpen}
        signals={signals.filter((s) => selectedIds.includes(s.id))}
        onClose={() => setBulkPropertiesOpen(false)}
        onApplied={(updated, unchanged) => {
          void refresh().catch((error) => console.warn('Refresh after the property change failed', error));
          showToast(`Properties updated on ${updated} signal${updated === 1 ? '' : 's'}${unchanged ? `; ${unchanged} already had these values` : ''}.`);
        }}
      />

      <BulkAddressDialog
        isOpen={bulkAddressOpen}
        signals={signals.filter((s) => selectedIds.includes(s.id))}
        resources={resources}
        onClose={() => setBulkAddressOpen(false)}
        onApplied={(updated, unchanged) => {
          void refresh().catch((error) => console.warn('Refresh after the address change failed', error));
          showToast(`Source address updated on ${updated} signal${updated === 1 ? '' : 's'}${unchanged ? `; ${unchanged} unchanged` : ''}. The collector receives the new configuration.`);
        }}
      />

      <ConfirmDialog
        isOpen={Boolean(disableTarget)}
        title={`Disable signal "${disableTarget?.key || disableTarget?.name || ''}"?`}
        message="Collection of this signal stops until you enable it again. Its history stays in storage."
        confirmText="Disable signal"
        busyLabel="Disabling…"
        cancelText="Cancel"
        variant="warning"
        wide
        confirmDisabled={usage.status === 'loading'}
        error={dialogError}
        onConfirm={handleDisable}
        onCancel={() => setDisableTarget(null)}
      >
        <ModelUsageList
          state={usage}
          onRetry={retryUsage}
          onNavigate={() => setDisableTarget(null)}
          heading={(count) =>
            `Used in ${count} data model${count === 1 ? '' : 's'}. ${
              runningUsage
                ? 'Running data models keep sampling, but fields mapped to this signal output null until it is enabled again.'
                : 'This field stops receiving new values and is marked "Signal disabled".'
            }`
          }
        />
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title={`Delete signal "${deleteTarget?.key || deleteTarget?.name || ''}"?`}
        message="Collection stops and the signal is removed from the catalog. Its history stays in storage."
        confirmText="Delete signal"
        busyLabel="Deleting…"
        cancelText="Cancel"
        variant="danger"
        wide
        confirmDisabled={usage.status === 'loading'}
        error={dialogError}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        <ModelUsageList
          state={usage}
          onRetry={retryUsage}
          onNavigate={() => setDeleteTarget(null)}
          heading={(count) =>
            `Used in ${count} data model${count === 1 ? '' : 's'}. ${
              count === 1 ? 'That model loses' : 'These models lose'
            } this field: it is marked "Signal deleted" until you remove or replace it.`
          }
        />
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={Boolean(bulkAction)}
        title={`${bulkAction === 'enable' ? 'Enable' : bulkAction === 'disable' ? 'Disable' : 'Delete'} ${selectedIds.length} signal${selectedIds.length === 1 ? '' : 's'}?`}
        message={
          bulkAction === 'enable'
            ? 'Collection starts again for the selected signals. The collector receives the new configuration.'
            : bulkAction === 'disable'
              ? 'Collection of the selected signals stops until you enable them again. Their history stays in storage.'
              : 'Collection stops and the selected signals are removed from the catalog. Their history stays in storage.'
        }
        confirmText={bulkAction === 'enable' ? 'Enable signals' : bulkAction === 'disable' ? 'Disable signals' : 'Delete signals'}
        busyLabel={bulkAction === 'enable' ? 'Enabling…' : bulkAction === 'disable' ? 'Disabling…' : 'Deleting…'}
        variant={bulkAction === 'delete' ? 'danger' : bulkAction === 'disable' ? 'warning' : 'primary'}
        wide
        confirmDisabled={bulkAction !== 'enable' && bulkUsage.status === 'loading'}
        error={dialogError}
        onConfirm={runBulk}
        onCancel={() => setBulkAction(null)}
      >
        {bulkAction && bulkAction !== 'enable' && (
          <ModelUsageList
            state={bulkUsage}
            onRetry={retryBulkUsage}
            onNavigate={() => setBulkAction(null)}
            heading={(count) =>
              `Used in ${count} data model${count === 1 ? '' : 's'}: ${
                bulkAction === 'delete' ? 'their fields are marked "Signal deleted".' : 'their fields stop receiving new values ("Signal disabled").'
              }`
            }
          />
        )}
      </ConfirmDialog>

      <ActionToast toast={toast} onDismiss={dismissToast} />
    </div>
  );
};
