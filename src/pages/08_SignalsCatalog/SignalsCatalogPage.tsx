import React, { useState } from 'react';
import {
  Search,
  Plus,
  Filter,
  Activity,
  Edit2,
  Trash2,
  ArrowUpDown,
  Download,
  X,
  Sigma,
  Zap,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { SignalItem, SignalDataType } from '../../types';
import { useNavigate } from 'react-router-dom';

const MicroSparkline: React.FC<{ value: number; quality: string }> = ({ value, quality }) => {
  const seed = Math.abs(Math.sin(value)) * 10;
  const points = [
    [0, 12],
    [10, 10 + (seed % 4)],
    [20, 7 + ((seed * 2) % 6)],
    [30, 11 - ((seed * 1.5) % 5)],
    [40, 5 + ((seed * 3) % 7)],
    [50, 9 - ((seed * 2) % 4)],
    [60, 6 + (seed % 6)],
    [70, 4 + ((seed * 2.5) % 7)],
    [80, 8],
  ];
  const strokeColor = quality === 'GOOD' ? '#0DBA67' : '#FFAA23';
  const pointsStr = points.map((p) => `${p[0]},${p[1]}`).join(' ');

  return (
    <svg className="w-20 h-4 overflow-visible" viewBox="0 0 80 18">
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pointsStr}
      />
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r="2" fill={strokeColor} />
    </svg>
  );
};

export const SignalsCatalogPage: React.FC = () => {
  const {
    signals,
    selectedSignalId,
    setSelectedSignalId,
    addSignal,
    bulkDeleteSignals,
    bulkAssignOutputGroup,
    outputGroups,
  } = useApp();
  const [filterType, setFilterType] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [drawerOpen, setDrawerOpen] = useState<boolean>(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [assignModalOpen, setAssignModalOpen] = useState<boolean>(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [undoDelete, setUndoDelete] = useState<(() => void) | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleExportCSV = (signalsToExport: SignalItem[]) => {
    const headers = ['Tag', 'Parameter Name', 'Resource Path', 'Data Type', 'Live Value', 'Unit', 'Quality', 'Last Updated'];
    const rows = signalsToExport.map((s) => [
      `"${s.tag}"`,
      `"${s.name}"`,
      `"${s.resourcePath}"`,
      `"${s.dataType}"`,
      `"${s.currentValue}"`,
      `"${s.unit || ''}"`,
      `"${s.quality}"`,
      `"${s.lastUpdated}"`,
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
    setToastMsg(`Downloaded CSV with ${signalsToExport.length} signals`);
    setTimeout(() => setToastMsg(null), 4000);
  };

  const handleDeleteSelected = () => {
    const { count, undo } = bulkDeleteSignals(selectedIds);
    setSelectedIds([]);
    setUndoDelete(() => undo);
    setToastMsg(`Deleted ${count} signals from catalog`);
    setTimeout(() => {
      setToastMsg(null);
      setUndoDelete(null);
    }, 6000);
  };

  const handleConfirmAssign = () => {
    if (!selectedGroupId && outputGroups.length > 0) {
      bulkAssignOutputGroup(selectedIds, outputGroups[0].id);
    } else if (selectedGroupId) {
      bulkAssignOutputGroup(selectedIds, selectedGroupId);
    }
    setAssignModalOpen(false);
    setSelectedIds([]);
    setToastMsg(`Assigned signals to output group`);
    setTimeout(() => setToastMsg(null), 4000);
  };

  const selectedSignal =
    signals.find((s) => s.id === selectedSignalId) || signals[0];

  const filteredSignals = signals.filter((s) => {
    const matchesType = filterType === 'all' || s.dataType === filterType;
    const matchesSearch =
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.tag.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.resourcePath.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesType && matchesSearch;
  });

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredSignals.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredSignals.map((s) => s.id));
    }
  };

  const toggleSelectOne = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1: Heading */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Signals Catalog</h1>
          <p className="fx-page-subtitle">
            Central tag inventory, real-time measurements, engineering units, and signal bindings.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="primary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => navigate('/acquisition/add-data')}
          >
            Create Signal
          </Button>
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            onClick={() => handleExportCSV(filteredSignals)}
          >
            Export CSV
          </Button>
        </div>
      </div>

      {/* Region 2: Filter Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-2">
          {[
            { id: 'all', label: 'All Signals' },
            { id: 'analog', label: 'Analog' },
            { id: 'boolean', label: 'Discrete' },
            { id: 'integer', label: 'Integer' },
            { id: 'calculated', label: 'Calculated' },
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
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#94A3B8]" />
          <input
            type="text"
            placeholder="Search tags or parameters..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="fx-input pl-9 h-9 text-[13px]"
          />
        </div>
      </div>

      {/* Main Grid: Signals Table (Reg 3) & Inspector Drawer (Reg 4) */}
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
                        onChange={toggleSelectAll}
                        className="rounded text-[#EF1B24]"
                      />
                    </th>
                    <th>Signal Tag</th>
                    <th>Parameter Name</th>
                    <th>Asset Location</th>
                    <th>Type</th>
                    <th>Live Value</th>
                    <th className="w-24">Trend (60s)</th>
                    <th>Quality</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSignals.map((sig) => {
                    const isSelected = sig.id === selectedSignal.id;
                    const isChecked = selectedIds.includes(sig.id);
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
                            onChange={(e) => toggleSelectOne(sig.id, e as any)}
                            className="rounded text-[#EF1B24]"
                          />
                        </td>
                        <td className="font-mono font-bold text-[#111B37] text-[12px]">{sig.tag}</td>
                        <td className="font-semibold text-[#334568]">{sig.name}</td>
                        <td className="text-[#657794] text-[12px] truncate max-w-[180px]">
                          {sig.resourcePath}
                        </td>
                        <td>
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase ${
                              sig.dataType === 'calculated'
                                ? 'bg-[#F5F0FF] text-[#7B3AE0]'
                                : 'bg-[#F1F5FA] text-[#657794]'
                            }`}
                          >
                            {sig.dataType}
                          </span>
                        </td>
                        <td className="font-extrabold text-[#111B37] tabular-nums text-[13px]">
                          {String(sig.currentValue)}{' '}
                          <span className="font-normal text-[11px] text-[#657794]">{sig.unit}</span>
                        </td>
                        <td className="w-24">
                          <MicroSparkline value={Number(sig.currentValue) || 45} quality={sig.quality} />
                        </td>
                        <td>
                          <Badge variant={sig.quality === 'GOOD' ? 'good' : 'warning'}>{sig.quality}</Badge>
                        </td>
                        <td className="text-[#94A3B8] font-mono text-[11px]">{sig.lastUpdated}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Region 5: Summary & Pagination */}
            <div className="px-5 py-3 border-t border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between text-[12px] text-[#657794]">
              <span>
                Showing <strong className="text-[#111B37]">{filteredSignals.length}</strong> of{' '}
                <strong className="text-[#111B37]">1,428</strong> collected signals
              </span>
              <div className="flex items-center gap-3">
                <span className="text-[#0DBA67] font-bold">1,406 Good</span>
                <span>·</span>
                <span className="text-[#FFAA23] font-bold">18 Stale</span>
                <span>·</span>
                <span className="text-[#F2343B] font-bold">4 Bad</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Region 4: Selected Signal Inspector Drawer */}
        {drawerOpen && (
          <div className="col-span-12 lg:col-span-4">
            <Card className="h-full p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between pb-3 border-b border-[#E3EAF3]">
                  <div>
                    <h3 className="text-[16px] font-extrabold text-[#111B37]">{selectedSignal.name}</h3>
                    <p className="font-mono text-[12px] text-[#EF1B24] font-bold mt-0.5">{selectedSignal.tag}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(false)}
                    className="p-1 rounded-md text-[#94A3B8] hover:text-[#111B37]"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-3 pt-3 text-[12px]">
                  <div className="p-3 rounded-xl bg-[#F9FAFD] border border-[#E3EAF3]">
                    <span className="text-[#657794] block text-[11px] uppercase font-bold">Current Measurement</span>
                    <div className="text-[28px] font-extrabold text-[#111B37] mt-1 tabular-nums">
                      {String(selectedSignal.currentValue)}{' '}
                      <span className="text-[14px] font-bold text-[#657794]">{selectedSignal.unit}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="good">{selectedSignal.quality}</Badge>
                      <span className="text-[#94A3B8] font-mono text-[11px]">Updated {selectedSignal.lastUpdated}</span>
                    </div>
                  </div>

                  <div className="space-y-2 pt-2 border-t border-[#E3EAF3]">
                    <div className="flex justify-between">
                      <span className="text-[#657794]">Source Gateway:</span>
                      <span className="font-semibold text-[#111B37]">{selectedSignal.sourceConnectionName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#657794]">Resource Binding:</span>
                      <span className="font-semibold text-[#111B37]">{selectedSignal.resourcePath}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#657794]">Sample Rate:</span>
                      <span className="font-mono font-bold text-[#111B37]">{selectedSignal.sampleIntervalMs} ms</span>
                    </div>
                    {selectedSignal.formula && (
                      <div className="pt-2">
                        <span className="text-[#657794] block mb-1">AST Expression:</span>
                        <code className="block p-2 rounded bg-[#111B2E] text-[#0DBA67] font-mono text-[11px] overflow-x-auto">
                          {selectedSignal.formula}
                        </code>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-[#E3EAF3] flex gap-2">
                <Button size="sm" variant="secondary" className="w-full" icon={<Edit2 className="w-3.5 h-3.5" />}>
                  Edit Signal
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 className="w-3.5 h-3.5" />}>
                  Delete
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* Floating Sticky Bulk Action Bar (From Images 27 & 39) */}
      {selectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl bg-[#0F172A] text-white shadow-2xl border border-slate-700 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-[13px] font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#34D399] animate-pulse" />
            {selectedIds.length} signal{selectedIds.length > 1 ? 's' : ''} selected
          </span>
          <div className="h-4 w-px bg-slate-700" />
          <button
            type="button"
            onClick={() => setAssignModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[12px] font-semibold text-slate-200 transition-colors"
          >
            <Zap className="w-3.5 h-3.5 text-[#38BDF8]" />
            Assign Output Group
          </button>
          <button
            type="button"
            onClick={() => {
              const selectedSigs = signals.filter((s) => selectedIds.includes(s.id));
              handleExportCSV(selectedSigs);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[12px] font-semibold text-slate-200 transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-[#34D399]" />
            Export CSV ({selectedIds.length})
          </button>
          <button
            type="button"
            onClick={handleDeleteSelected}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EF1B24]/20 hover:bg-[#EF1B24]/30 text-[12px] font-semibold text-[#F87171] transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete Selected
          </button>
          <div className="h-4 w-px bg-slate-700" />
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            className="p-1 rounded-md text-slate-400 hover:text-white"
            title="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Assign Output Group Modal (Review FX-07, FX-11) */}
      {assignModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#2A82E7]" />
                Assign Signals to Output Group
              </h3>
              <button
                type="button"
                onClick={() => setAssignModalOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Select an existing output group to bundle the <strong>{selectedIds.length}</strong> selected signals
              for automated MQTT/Kafka publishing.
            </p>
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">Target Output Group</label>
              <select
                value={selectedGroupId || outputGroups[0]?.id}
                onChange={(e) => setSelectedGroupId(e.target.value)}
                className="w-full text-xs p-2.5 rounded-lg border border-slate-300 bg-white text-slate-800 font-semibold"
              >
                {outputGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.topicTemplate})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button size="sm" variant="secondary" onClick={() => setAssignModalOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={handleConfirmAssign}>
                Confirm Assignment
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Undo Toast Notification (Review FX-07) */}
      {toastMsg && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-900 text-white shadow-2xl border border-slate-700 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-xs font-semibold">{toastMsg}</span>
          {undoDelete && (
            <button
              type="button"
              onClick={() => {
                undoDelete();
                setToastMsg('Deletion undone! Signals restored.');
                setUndoDelete(null);
              }}
              className="text-xs font-bold text-amber-400 hover:text-amber-300 underline ml-2"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
};
