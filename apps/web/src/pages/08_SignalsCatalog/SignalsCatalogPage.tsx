import React, { useEffect, useMemo, useState } from 'react';
import { Search, Plus, Download, X, Zap, Edit2, Trash2, Ban } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge, type BadgeVariant } from '../../components/common/Badge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { useApp } from '../../store/AppContext';
import { SignalItem } from '../../types';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { translateApiError } from '../../utils/apiErrors';
import { api } from '../../api/client';
import { absoluteUtc7, relativeAge } from '../../utils/relativeTime';

function qualityVariant(quality: string): BadgeVariant {
  if (quality === 'GOOD') return 'good';
  if (quality === 'BAD') return 'error';
  if (quality === 'STALE' || quality === 'UNCERTAIN') return 'warning';
  return 'neutral';
}

function typeLabel(dataType: string): string {
  switch (dataType) {
    case 'boolean':
      return 'Boolean';
    case 'integer':
      return 'Integer';
    case 'text':
    case 'string':
      return 'Text';
    case 'number':
    case 'analog':
      return 'Number';
    default:
      return dataType || '—';
  }
}

function MicroSparkline({ history, quality }: { history?: number[]; quality: string }) {
  if (!history || history.length < 2) {
    return <span className="text-[11px] text-[#94A3B8]">—</span>;
  }
  const min = Math.min(...history);
  const max = Math.max(...history);
  const span = max - min || 1;
  const points = history
    .map((v, i) => {
      const x = (i / (history.length - 1)) * 80;
      const y = 16 - ((v - min) / span) * 14;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const stroke = quality === 'GOOD' ? '#0DBA67' : quality === 'BAD' ? '#F2343B' : '#94A3B8';
  return (
    <svg className="w-20 h-4 overflow-visible" viewBox="0 0 80 18" aria-label="Recent history">
      <polyline fill="none" stroke={stroke} strokeWidth="1.6" points={points} />
    </svg>
  );
}

export const SignalsCatalogPage: React.FC = () => {
  const {
    signals,
    selectedSignalId,
    setSelectedSignalId,
    outputGroups,
    updateSignal,
    bulkDeleteSignals,
    bulkAssignOutputGroup,
  } = useApp();
  const [searchParams] = useSearchParams();
  const [filterType, setFilterType] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editUnit, setEditUnit] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editInterval, setEditInterval] = useState('');
  const [editType, setEditType] = useState('number');
  const [confirmAction, setConfirmAction] = useState<'delete' | 'disable' | null>(null);
  const [disableIds, setDisableIds] = useState<string[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [historyById, setHistoryById] = useState<Record<string, number[]>>({});
  const navigate = useNavigate();

  useEffect(() => {
    const signalId = searchParams.get('signalId');
    if (signalId && signals.some((item) => item.id === signalId)) {
      setSelectedSignalId(signalId);
      setDrawerOpen(true);
    }
  }, [searchParams, setSelectedSignalId, signals]);

  const catalogSignals = useMemo(
    () => signals.filter((s) => s.dataType !== 'calculated'),
    [signals],
  );

  const selectedSignal =
    catalogSignals.find((s) => s.id === selectedSignalId) || catalogSignals[0] || null;

  const filteredSignals = useMemo(() => {
    return catalogSignals.filter((s) => {
      const matchesType =
        filterType === 'all' ||
        (filterType === 'number' && (s.dataType === 'number' || s.dataType === 'analog')) ||
        (filterType === 'text' && (s.dataType === 'text' || s.dataType === 'string')) ||
        s.dataType === filterType;
      const haystack = `${s.name} ${s.tag} ${s.resourcePath}`.toLowerCase();
      const matchesSearch = !searchTerm.trim() || haystack.includes(searchTerm.toLowerCase());
      return matchesType && matchesSearch;
    });
  }, [catalogSignals, filterType, searchTerm]);

  const historyKey = filteredSignals
    .filter((s) => s.dataType === 'number' || s.dataType === 'integer' || s.dataType === 'analog')
    .slice(0, 12)
    .map((s) => s.id)
    .join(',');

  useEffect(() => {
    if (!historyKey) {
      setHistoryById({});
      return;
    }
    const ids = historyKey.split(',');
    let cancelled = false;
    const end = new Date();
    const start = new Date(end.getTime() - 60_000);
    void Promise.all(
      ids.map(async (id) => {
        try {
          const hist = await api<{
            items?: Array<{ value?: unknown; value_json?: { v?: unknown } }>;
          }>(
            `/api/v1/observations/history?signal_id=${id}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&limit=30`,
          );
          const points = (hist.items || [])
            .map((row) => {
              const raw = row.value_json?.v ?? row.value;
              const n = typeof raw === 'number' ? raw : Number(raw);
              return Number.isFinite(n) ? n : null;
            })
            .filter((n): n is number => n != null);
          return [id, points] as const;
        } catch {
          return [id, [] as number[]] as const;
        }
      }),
    ).then((rows) => {
      if (!cancelled) setHistoryById(Object.fromEntries(rows));
    });
    return () => {
      cancelled = true;
    };
  }, [historyKey]);

  const handleExportCSV = (signalsToExport: SignalItem[]) => {
    const headers = ['Tag', 'Name', 'Resource', 'Type', 'Value', 'Unit', 'Quality', 'Source time', 'Age'];
    const rows = signalsToExport.map((s) => [
      `"${s.tag}"`,
      `"${s.name}"`,
      `"${s.resourcePath}"`,
      `"${typeLabel(s.dataType)}"`,
      `"${s.currentValue}"`,
      `"${s.unit || ''}"`,
      `"${s.quality}"`,
      `"${s.sourceTime || s.lastUpdated || ''}"`,
      `"${relativeAge(s.sourceTime || s.lastUpdated)}"`,
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `factorix_signals_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setToastMsg(`Downloaded CSV with ${signalsToExport.length} signals`);
    setTimeout(() => setToastMsg(null), 4000);
  };

  const handleDeleteSelected = async () => {
    try {
      const result = await bulkDeleteSignals(
        selectedIds.length ? selectedIds : selectedSignal ? [selectedSignal.id] : [],
      );
      setSelectedIds([]);
      setConfirmAction(null);
      setToastMsg(`Archived ${result.count} signal(s)`);
      setTimeout(() => setToastMsg(null), 4000);
    } catch (error) {
      setConfirmAction(null);
      setPageError(translateApiError(error));
    }
  };

  const handleDisable = async () => {
    const ids = disableIds.length ? disableIds : selectedSignal ? [selectedSignal.id] : [];
    setConfirmAction(null);
    for (const id of ids) {
      const res = await updateSignal(id, { status: 'DISABLED' });
      if (!res.success) {
        setPageError(translateApiError(res.error || 'Disable failed'));
        return;
      }
    }
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    setToastMsg(`Disabled ${ids.length} signal(s)`);
    setTimeout(() => setToastMsg(null), 4000);
  };

  const askDisable = (ids: string[]) => {
    setDisableIds(ids);
    setConfirmAction('disable');
  };

  const handleConfirmAssign = async () => {
    const groupId = selectedGroupId || outputGroups[0]?.id;
    if (!groupId) {
      setPageError('Create an output group first.');
      return;
    }
    try {
      await bulkAssignOutputGroup(selectedIds, groupId);
      setAssignModalOpen(false);
      setToastMsg(`Assigned ${selectedIds.length} signal(s) to output group`);
      setTimeout(() => setToastMsg(null), 4000);
    } catch (error) {
      setPageError(translateApiError(error));
    }
  };

  const openEdit = () => {
    if (!selectedSignal) return;
    setEditName(selectedSignal.name);
    setEditUnit(selectedSignal.unit || '');
    setEditDescription(selectedSignal.description || '');
    setEditInterval(selectedSignal.sampleIntervalMs > 0 ? String(selectedSignal.sampleIntervalMs) : '');
    const currentType =
      selectedSignal.dataType === 'analog'
        ? 'number'
        : selectedSignal.dataType === 'string'
          ? 'text'
          : selectedSignal.dataType;
    setEditType(currentType === 'calculated' ? 'number' : currentType);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!selectedSignal) return;
    const interval = Number(editInterval);
    const res = await updateSignal(selectedSignal.id, {
      display_name: editName.trim() || selectedSignal.tag,
      unit: editUnit,
      description: editDescription,
      data_type: editType,
      expected_interval_ms: Number.isFinite(interval) && interval > 0 ? Math.round(interval) : undefined,
    });
    if (!res.success) {
      setPageError(translateApiError(res.error || 'Update failed'));
      return;
    }
    setEditOpen(false);
    setToastMsg('Signal saved');
    setTimeout(() => setToastMsg(null), 3000);
  };

  if (!selectedSignal) {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Signals Catalog</h1>
        <p className="fx-page-subtitle">
          No signals yet. Activate a connection from Add Data and they will be listed here.
        </p>
      </div>
    );
  }

  const lastGood = [selectedSignal.lastGoodValue, relativeAge(selectedSignal.lastGoodTime)]
    .filter((part) => part && part !== '—')
    .join(' · ');

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Signals Catalog</h1>
          <p className="fx-page-subtitle">
            Signals, live values, engineering units, and bindings.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/acquisition/add-data')}>
            Create Signal
          </Button>
          <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={() => handleExportCSV(filteredSignals)}>
            Export CSV
          </Button>
        </div>
      </div>

      {pageError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{pageError}</div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { id: 'all', label: 'All' },
            { id: 'number', label: 'Number' },
            { id: 'integer', label: 'Integer' },
            { id: 'boolean', label: 'Boolean' },
            { id: 'text', label: 'Text' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilterType(t.id)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-all ${
                filterType === t.id
                  ? 'bg-[#FFF0F1] text-[#EF1B24] border border-[#FAC6C9]'
                  : 'bg-white text-[#657794] border border-[#D4DFEC] hover:text-[#111B37]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative w-72">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94A3B8] pointer-events-none" />
          <input
            type="text"
            placeholder="Search signals…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="fx-input !pl-8 h-9 text-[13px] w-full"
          />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <div className={drawerOpen ? 'col-span-12 lg:col-span-8' : 'col-span-12'}>
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th className="w-10 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.length > 0 && selectedIds.length === filteredSignals.length}
                        onChange={() =>
                          setSelectedIds(
                            selectedIds.length === filteredSignals.length ? [] : filteredSignals.map((s) => s.id),
                          )
                        }
                        className="rounded text-[#EF1B24]"
                      />
                    </th>
                    <th>Name</th>
                    <th>Asset</th>
                    <th>Type</th>
                    <th>Live value</th>
                    <th className="w-24">Trend</th>
                    <th>Quality</th>
                    <th className="min-w-[150px]">Source time</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSignals.map((sig) => {
                    const isSelected = sig.id === selectedSignal.id;
                    const isChecked = selectedIds.includes(sig.id);
                    const displayName =
                      sig.name && sig.name !== sig.tag ? `${sig.name} · ${sig.tag}` : sig.tag || sig.name;
                    const source = sig.sourceTime || sig.lastUpdated;
                    return (
                      <tr
                        key={sig.id}
                        onClick={() => {
                          setSelectedSignalId(sig.id);
                          setDrawerOpen(true);
                        }}
                        data-selected={isSelected}
                        className="cursor-pointer"
                      >
                        <td className="text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() =>
                              setSelectedIds((prev) =>
                                prev.includes(sig.id) ? prev.filter((i) => i !== sig.id) : [...prev, sig.id],
                              )
                            }
                            className="rounded text-[#EF1B24]"
                          />
                        </td>
                        <td className="font-semibold text-[#111B37] text-[12px]" title={displayName}>
                          {displayName}
                        </td>
                        <td className="text-[#657794] text-[12px] truncate max-w-[180px]" title={sig.resourcePath}>
                          {sig.resourcePath}
                        </td>
                        <td>
                          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-bold bg-[#F1F5FA] text-[#657794]">
                            {typeLabel(sig.dataType)}
                          </span>
                        </td>
                        <td className="font-extrabold text-[#111B37] tabular-nums text-[13px]">
                          {String(sig.currentValue)}{' '}
                          <span className="font-normal text-[11px] text-[#657794]">{sig.unit}</span>
                        </td>
                        <td>
                          <MicroSparkline history={historyById[sig.id]} quality={sig.quality} />
                        </td>
                        <td>
                          <Badge variant={qualityVariant(sig.quality)}>{sig.quality || 'UNKNOWN'}</Badge>
                        </td>
                        <td
                          className="text-[#94A3B8] font-mono text-[11px] whitespace-nowrap"
                          title={absoluteUtc7(source)}
                        >
                          {absoluteUtc7(source) || '—'}
                        </td>
                        <td className="text-[#94A3B8] font-mono text-[11px] whitespace-nowrap">
                          {relativeAge(source)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {drawerOpen && (
          <div className="col-span-12 lg:col-span-4">
            <Card className="h-full p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between pb-3 border-b border-[#E3EAF3]">
                  <div>
                    <h3 className="text-[16px] font-extrabold text-[#111B37]">{selectedSignal.name}</h3>
                    <p className="font-mono text-[12px] text-[#EF1B24] font-bold mt-0.5">{selectedSignal.tag}</p>
                  </div>
                  <button type="button" onClick={() => setDrawerOpen(false)} className="p-1 rounded-md text-[#94A3B8]">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="space-y-2 pt-3 text-[12px]">
                  <div className="p-3 rounded-xl bg-[#F9FAFD] border border-[#E3EAF3]">
                    <span className="text-[#657794] block text-[11px] uppercase font-bold">Current</span>
                    <div className="text-[28px] font-extrabold text-[#111B37] mt-1 tabular-nums">
                      {String(selectedSignal.currentValue)}{' '}
                      <span className="text-[14px] font-bold text-[#657794]">{selectedSignal.unit}</span>
                    </div>
                    <div className="mt-1">
                      <Badge variant={qualityVariant(selectedSignal.quality)}>
                        {selectedSignal.quality || 'UNKNOWN'}
                      </Badge>
                    </div>
                  </div>
                  {[
                    ['Connection', selectedSignal.sourceConnectionName || '—'],
                    ['Topic', selectedSignal.topic || '—'],
                    ['JSONPath', selectedSignal.jsonpath || selectedSignal.bindingAddress || '—'],
                    ['Type', typeLabel(selectedSignal.dataType)],
                    ['Unit', selectedSignal.unit || '—'],
                    ['Edge', selectedSignal.edgeName || '—'],
                    ['Last good', lastGood || '—'],
                    [
                      'BAD reason',
                      selectedSignal.quality === 'BAD' || selectedSignal.quality === 'STALE'
                        ? selectedSignal.qualityReason || '—'
                        : '—',
                    ],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <span className="text-[#657794]">{label}</span>
                      <span className="font-semibold text-[#111B37] text-right break-all">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="pt-4 border-t border-[#E3EAF3] flex gap-2">
                <Button size="sm" variant="secondary" className="w-full" icon={<Edit2 className="w-3.5 h-3.5" />} onClick={openEdit}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Ban className="w-3.5 h-3.5" />}
                  onClick={() => {
                    if (selectedSignal.status === 'DISABLED') {
                      void updateSignal(selectedSignal.id, { status: 'ACTIVE' }).then((res) => {
                        if (!res.success) setPageError(translateApiError(res.error || 'Update failed'));
                      });
                      return;
                    }
                    askDisable([selectedSignal.id]);
                  }}
                >
                  {selectedSignal.status === 'DISABLED' ? 'Enable' : 'Disable'}
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => setConfirmAction('delete')}>
                  Delete
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>

      {selectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl bg-[#0F172A] text-white shadow-2xl border border-slate-700">
          <span className="text-[13px] font-bold">
            {selectedIds.length} signal{selectedIds.length === 1 ? '' : 's'} selected
          </span>
          {outputGroups.length > 0 && (
            <button
              type="button"
              onClick={() => setAssignModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1E293B] text-[12px] font-semibold"
            >
              <Zap className="w-3.5 h-3.5 text-[#38BDF8]" />
              Assign output group
            </button>
          )}
          <button
            type="button"
            onClick={() => askDisable(selectedIds)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1E293B] text-[12px] font-semibold"
          >
            <Ban className="w-3.5 h-3.5" />
            Disable
          </button>
          <button
            type="button"
            onClick={() => setConfirmAction('delete')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EF1B24]/20 text-[12px] font-semibold text-[#F87171]"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
          <button type="button" onClick={() => setSelectedIds([])} className="p-1 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {assignModalOpen && outputGroups.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-bold">Assign to output group</h3>
            <select
              value={selectedGroupId || outputGroups[0]?.id}
              onChange={(e) => setSelectedGroupId(e.target.value)}
              className="w-full text-xs p-2.5 rounded-lg border border-slate-300"
            >
              {outputGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setAssignModalOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={() => void handleConfirmAssign()}>
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}

      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-bold">Edit signal</h3>
            <div>
              <label className="block text-xs font-semibold mb-1">Display name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
              <p className="text-[11px] text-slate-500 mt-1 font-mono">Signal key: {selectedSignal.tag}</p>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Unit</label>
              <input
                value={editUnit}
                onChange={(e) => setEditUnit(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Description</label>
              <input
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Stale after (ms)</label>
              <input
                value={editInterval}
                onChange={(e) => setEditInterval(e.target.value)}
                inputMode="numeric"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Type</label>
              <select
                value={editType}
                onChange={(e) => setEditType(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              >
                <option value="number">Number</option>
                <option value="integer">Integer</option>
                <option value="boolean">Boolean</option>
                <option value="text">Text</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={() => void saveEdit()}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmAction === 'delete'}
        title="Delete signals?"
        message={`Archive ${selectedIds.length || 1} signal(s)? They will be removed from the active catalog.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDeleteSelected}
      />
      <ConfirmDialog
        isOpen={confirmAction === 'disable'}
        title="Disable signals?"
        message={`Disable ${disableIds.length || 1} signal(s)? They stay in the catalog and can be enabled again.`}
        confirmLabel="Disable"
        danger
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDisable}
      />

      {toastMsg && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl bg-slate-900 text-white text-xs font-semibold shadow-2xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
};
