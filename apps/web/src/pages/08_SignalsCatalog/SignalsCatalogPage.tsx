import React, { useEffect, useState, useMemo } from 'react';
import {
  Search,
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
} from 'lucide-react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { SignalItem } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { TrendChart } from './TrendChart';
import { SignalSparkline } from './SignalSparkline';
import { SignalInspector } from './SignalInspector';
import { SignalEditDialog } from './SignalEditDialog';
import { api } from '../../api/client';

function timeAgo(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 0 || isNaN(diffSec)) return 'just now';
  if (diffSec < 60) return `${diffSec} s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} h ago`;
  return `${Math.floor(diffHour / 24)} d ago`;
}

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
  const { signals, resources, connections, edges, refresh } = useApp();

  // URL Query Sync
  const viewMode = searchParams.get('view') === 'live' ? 'live' : 'table';
  const resourceFilter = searchParams.get('resourceId') || 'all';
  const connectionFilter = searchParams.get('connectionId') || 'all';
  const initialSignalId = searchParams.get('signalId') || null;

  // Local Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'number' | 'integer' | 'boolean' | 'text'>('all');
  const [qualityFilter, setQualityFilter] = useState<'all' | 'good' | 'uncertain' | 'bad' | 'stale' | 'disabled'>('all');

  // Inspector & Edit Dialog State
  const [selectedSignal, setSelectedSignal] = useState<SignalItem | null>(null);
  const [editTarget, setEditTarget] = useState<SignalItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SignalItem | null>(null);

  // Bulk Selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [trendSignals, setTrendSignals] = useState<SignalItem[]>([]);
  const [timeframe, setTimeframe] = useState<'15m' | '1h' | '6h'>('15m');

  // Toast / Feedback
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [undoAction, setUndoAction] = useState<(() => void) | null>(null);

  const showToast = (msg: string, undo?: () => void) => {
    setToastMessage(msg);
    setUndoAction(undo ? () => undo : null);
    setTimeout(() => {
      setToastMessage(null);
      setUndoAction(null);
    }, 4000);
  };

  // Open initial signal inspector from URL (TC-UI-SG-19)
  useEffect(() => {
    if (initialSignalId) {
      const match = signals.find((s) => s.id === initialSignalId);
      if (match) setSelectedSignal(match);
    }
  }, [initialSignalId, signals]);

  // View toggle helper
  const setViewMode = (mode: 'table' | 'live') => {
    const nextParams = new URLSearchParams(searchParams);
    if (mode === 'live') nextParams.set('view', 'live');
    else nextParams.delete('view');
    setSearchParams(nextParams);
  };

  // Filtered Signals
  const filteredSignals = useMemo(() => {
    return signals.filter((s) => {
      // Resource Filter
      if (resourceFilter !== 'all' && s.resourceId !== resourceFilter) {
        const res = resources.find((r) => r.id === s.resourceId);
        if (res?.code !== resourceFilter && res?.id !== resourceFilter) return false;
      }
      // Connection Filter
      if (connectionFilter !== 'all' && s.connectionId !== connectionFilter) {
        return false;
      }
      // Type Filter
      if (typeFilter !== 'all') {
        const cType = classifyType(s.dataType || s.type);
        if (cType !== typeFilter) return false;
      }
      // Quality Filter
      if (qualityFilter !== 'all') {
        const isEnabled = s.enabled !== false;
        if (qualityFilter === 'disabled') {
          if (isEnabled) return false;
        } else {
          if (!isEnabled) return false;
          const q = (s.quality || 'NO_DATA').toLowerCase();
          if (q !== qualityFilter) return false;
        }
      }
      // Search
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const name = (s.displayName || s.name || '').toLowerCase();
        const key = (s.key || '').toLowerCase();
        if (!name.includes(term) && !key.includes(term)) return false;
      }
      return true;
    });
  }, [signals, resourceFilter, connectionFilter, typeFilter, qualityFilter, searchTerm, resources]);

  // Bulk selection handlers
  const handleSelectAll = () => {
    if (selectedIds.length === filteredSignals.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredSignals.map((s) => s.id));
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // Trend selection for Live View (max 4)
  const handleToggleTrend = (signal: SignalItem) => {
    if (trendSignals.some((s) => s.id === signal.id)) {
      setTrendSignals((prev) => prev.filter((s) => s.id !== signal.id));
    } else {
      if (trendSignals.length >= 4) {
        showToast('Up to 4 signals can be plotted together.');
        return;
      }
      setTrendSignals((prev) => [...prev, signal]);
    }
  };

  // Single Actions
  const handleToggleEnabled = async (signal: SignalItem) => {
    const nextState = signal.enabled === false;
    try {
      await api(`/api/v1/signals/${signal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: nextState }),
      });
      await refresh();
      showToast(`Signal ${nextState ? 'enabled' : 'disabled'}`);
      if (selectedSignal?.id === signal.id) {
        setSelectedSignal({ ...signal, enabled: nextState });
      }
    } catch {
      showToast('Could not update signal');
    }
  };

  const handleDeleteSignal = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await api(`/api/v1/signals/${target.id}`, { method: 'DELETE' });
      await refresh();
      showToast('Signal deleted');
      if (selectedSignal?.id === target.id) setSelectedSignal(null);
    } catch {
      showToast('Could not delete signal');
    }
  };

  // Bulk Actions (TC-UI-SG-13..14)
  const handleBulkDisable = async () => {
    if (selectedIds.length === 0) return;
    const count = selectedIds.length;
    const idsToDisable = [...selectedIds];
    try {
      await api('/api/v1/signals/bulk-action', {
        method: 'POST',
        body: JSON.stringify({ ids: idsToDisable, action: 'disable' }),
      });
      await refresh();
      setSelectedIds([]);
      showToast(`${count} signals disabled`, async () => {
        await api('/api/v1/signals/bulk-action', {
          method: 'POST',
          body: JSON.stringify({ ids: idsToDisable, action: 'enable' }),
        });
        await refresh();
        showToast('Restored disabled signals');
      });
    } catch {
      showToast('Bulk disable failed');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    const count = selectedIds.length;
    try {
      await api('/api/v1/signals/bulk-action', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds, action: 'delete' }),
      });
      await refresh();
      setSelectedIds([]);
      showToast(`${count} signals deleted`);
      if (selectedSignal && selectedIds.includes(selectedSignal.id)) {
        setSelectedSignal(null);
      }
    } catch {
      showToast('Bulk delete failed');
    }
  };

  const handleExportCsv = () => {
    const listToExport = selectedIds.length > 0
      ? filteredSignals.filter((s) => selectedIds.includes(s.id))
      : filteredSignals;

    const rows = [
      ['signal', 'resource_path', 'value', 'unit', 'quality', 'source_time', 'received_time'],
      ...listToExport.map((s) => {
        const res = resources.find((r) => r.id === s.resourceId);
        const sigName = s.displayName || s.name || s.key || '';
        return [
          `"${sigName.replace(/"/g, '""')}"`,
          `"${(res?.name || s.resourcePath || '').replace(/"/g, '""')}"`,
          s.value !== null && s.value !== undefined ? String(s.value) : '',
          `"${(s.unit || '').replace(/"/g, '""')}"`,
          s.quality || 'NO_DATA',
          s.lastUpdated || '',
          s.lastUpdated || '',
        ];
      }),
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `signals_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-[#111B37]">Signals</h1>
          <p className="text-[13px] text-[#657794]">
            Unified signal catalog and live real-time observation stream
          </p>
        </div>

        <div className="flex items-center gap-2">
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
            onClick={() => navigate('/collector/add-data')}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add data
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <Card className="p-4 border border-[#CBD5E1] bg-white space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search signals by name or key…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:border-blue-500"
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
              className="px-2.5 py-1.5 border border-slate-300 rounded text-[12px] bg-white text-slate-700 focus:outline-none focus:border-blue-500"
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
              className="px-2.5 py-1.5 border border-slate-300 rounded text-[12px] bg-white text-slate-700 focus:outline-none focus:border-blue-500"
            >
              <option value="all">All Connections</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.protocol})
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
          <div className="flex items-center gap-1">
            <span className="text-[#657794] mr-1 text-[11px] font-semibold uppercase">Type:</span>
            {(['all', 'number', 'integer', 'boolean', 'text'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium capitalize transition ${
                  typeFilter === t
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Quality Pills */}
          <div className="flex items-center gap-1">
            <span className="text-[#657794] mr-1 text-[11px] font-semibold uppercase">Quality:</span>
            {(['all', 'good', 'uncertain', 'bad', 'stale', 'disabled'] as const).map((q) => (
              <button
                key={q}
                onClick={() => setQualityFilter(q)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium capitalize transition ${
                  qualityFilter === q
                    ? 'bg-slate-800 text-white'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Bulk Action Floating Bar */}
      {selectedIds.length > 0 && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between text-[12px]">
          <span className="font-semibold text-blue-900">
            {selectedIds.length} signal{selectedIds.length > 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleBulkDisable}>
              Disable
            </Button>
            <Button size="sm" variant="danger" onClick={handleBulkDelete}>
              Delete
            </Button>
            <Button size="sm" variant="outline" onClick={handleExportCsv}>
              <Download className="w-3 h-3 mr-1" />
              Export
            </Button>
            <button
              onClick={() => setSelectedIds([])}
              className="text-blue-700 font-medium hover:underline ml-2"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* VIEW: LIVE OPERATIONS (TC-UI-SG-15..17) */}
      {viewMode === 'live' && (
        <div className="space-y-4">
          {/* Trend Chart for up to 4 selected signals */}
          <TrendChart
            selectedSignals={trendSignals}
            timeframe={timeframe}
            onTimeframeChange={setTimeframe}
          />

          {/* Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredSignals.map((sig) => {
              const res = resources.find((r) => r.id === sig.resourceId);
              const isSelectedForTrend = trendSignals.some((s) => s.id === sig.id);
              const formattedVal =
                sig.value === null || sig.value === undefined
                  ? '—'
                  : typeof sig.value === 'number'
                  ? Number.isInteger(sig.value)
                    ? String(sig.value)
                    : sig.value.toFixed(2)
                  : String(sig.value);

              return (
                <div
                  key={sig.id}
                  onClick={() => setSelectedSignal(sig)}
                  className={`p-4 rounded-xl border bg-white cursor-pointer transition hover:shadow-sm ${
                    isSelectedForTrend
                      ? 'border-blue-500 ring-2 ring-blue-100'
                      : 'border-[#CBD5E1] hover:border-slate-400'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[13px] font-bold text-[#111B37] truncate max-w-[150px]">
                        {sig.displayName || sig.name || sig.key}
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
                      title="Plot on trend chart (up to 4)"
                    >
                      Trend
                    </button>
                  </div>

                  <div className="mt-3">
                    <div className="text-[24px] font-extrabold text-[#111B37] tabular-nums truncate">
                      {formattedVal}{' '}
                      {sig.unit && <span className="text-[13px] font-normal text-[#657794]">{sig.unit}</span>}
                    </div>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px]">
                    <StatusBadge status={sig.quality || 'NO_DATA'} />
                    <span className="text-[#657794]" title={sig.lastUpdated ? new Date(sig.lastUpdated).toLocaleString() : ''}>
                      {timeAgo(sig.lastUpdated)}
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
          {filteredSignals.length === 0 ? (
            <div className="p-12 text-center text-[#657794]">
              <Search className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-[13px] font-semibold text-[#111B37]">No signals found</p>
              <p className="text-[12px] text-[#657794] mt-1">
                Try adjusting your search filters or add a new signal.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/50 text-[#657794] font-semibold">
                    <th className="py-2.5 px-3 w-8">
                      <input
                        type="checkbox"
                        checked={selectedIds.length === filteredSignals.length && filteredSignals.length > 0}
                        onChange={handleSelectAll}
                        className="rounded border-slate-300 text-blue-600 focus:ring-0"
                      />
                    </th>
                    <th className="py-2.5 px-3">Signal</th>
                    <th className="py-2.5 px-3">Resource</th>
                    <th className="py-2.5 px-3">Value</th>
                    <th className="py-2.5 px-3">Trend 15 min</th>
                    <th className="py-2.5 px-3">Quality</th>
                    <th className="py-2.5 px-3 text-right">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSignals.map((sig) => {
                    const isChecked = selectedIds.includes(sig.id);
                    const res = resources.find((r) => r.id === sig.resourceId);
                    const formattedVal =
                      sig.value === null || sig.value === undefined
                        ? '—'
                        : typeof sig.value === 'number'
                        ? Number.isInteger(sig.value)
                          ? String(sig.value)
                          : sig.value.toFixed(2)
                        : String(sig.value);

                    return (
                      <tr
                        key={sig.id}
                        onClick={() => setSelectedSignal(sig)}
                        className={`hover:bg-slate-50 cursor-pointer transition ${
                          isChecked ? 'bg-blue-50/30' : ''
                        }`}
                      >
                        <td
                          className="py-2.5 px-3 w-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleSelect(sig.id);
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleSelect(sig.id)}
                            className="rounded border-slate-300 text-blue-600 focus:ring-0"
                          />
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-[#111B37]">
                          <div>{sig.displayName || sig.name || sig.key}</div>
                          {sig.displayName && sig.key && (
                            <div className="text-[10px] text-[#657794] font-mono">{sig.key}</div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-[#657794] font-mono text-[11px]">
                          {res?.name || sig.resourcePath || '—'}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-[#111B37] tabular-nums">
                          {formattedVal}{' '}
                          {sig.unit && <span className="font-normal text-[#657794] text-[11px]">{sig.unit}</span>}
                        </td>
                        <td className="py-2.5 px-3">
                          <SignalSparkline signalId={sig.id} quality={sig.quality || 'NO_DATA'} />
                        </td>
                        <td className="py-2.5 px-3">
                          <StatusBadge status={sig.quality || 'NO_DATA'} />
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#657794] whitespace-nowrap" title={sig.lastUpdated ? new Date(sig.lastUpdated).toLocaleString() : ''}>
                          {timeAgo(sig.lastUpdated)}
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

      {/* Inspector Drawer */}
      <SignalInspector
        signal={selectedSignal}
        isOpen={Boolean(selectedSignal)}
        onClose={() => setSelectedSignal(null)}
        onEdit={(sig) => setEditTarget(sig)}
        onToggleEnabled={(sig) => void handleToggleEnabled(sig)}
        onDelete={(sig) => setDeleteTarget(sig)}
        resourceName={resources.find((r) => r.id === selectedSignal?.resourceId)?.name}
        connectionName={connections.find((c) => c.id === selectedSignal?.connectionId)?.name}
        edgeName={edges[0]?.name}
      />

      {/* Edit Signal Modal */}
      {editTarget && (
        <SignalEditDialog
          signal={editTarget}
          isOpen={Boolean(editTarget)}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            void refresh();
            showToast('Signal updated');
          }}
        />
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title={`Delete signal "${deleteTarget?.displayName || deleteTarget?.name || deleteTarget?.key}"?`}
        message="This signal will be archived and will stop collecting data. This key can be reused later."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteSignal}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Toast Feedback */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 bg-[#111B37] text-white px-4 py-3 rounded-xl shadow-xl flex items-center gap-3 z-50 text-[13px] animate-fade-in">
          <span>{toastMessage}</span>
          {undoAction && (
            <button
              onClick={() => {
                undoAction();
                setToastMessage(null);
              }}
              className="font-bold text-blue-400 hover:text-blue-300 underline ml-2"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
};
