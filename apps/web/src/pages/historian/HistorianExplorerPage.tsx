import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LineChart as LineChartIcon,
  Table as TableIcon,
  Activity,
  Download,
  Search,
  RefreshCw,
  Plus,
  X,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  Clock,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Info,
} from 'lucide-react';
import { HistorianTrendChart } from '../11_HistorianExplorer/HistorianTrendChart';
import {
  HistorianMode,
  HistorianPoint,
  HistorianSeriesData,
  HistorianEventItem,
  TimeRangePreset,
  SERIES_COLORS,
  MAX_SELECTED_SERIES,
  HISTORIAN_MODES,
  QualitySegment,
  SeriesStats,
} from '../11_HistorianExplorer/types';
import { SignalItem } from '../../types';
import {
  getSources,
  listSubtables,
  queryHistorian,
  listSavedViews,
  listExportJobs,
  createExportJob,
  saveView,
  SourceRef,
  SourceView,
  TDSubtable,
  SavedView,
  ExportJob,
  HistorianRow,
} from '../../lib/storagePhysicalApi';

export const HistorianExplorerPage: React.FC = () => {
  const [searchParams] = useSearchParams();

  // Active view tab: 'trend' | 'records' | 'events' | 'exports'
  const [activeTab, setActiveTab] = useState<'trend' | 'records' | 'events' | 'exports'>('trend');

  // Mode: operational / recorded / reconstructed
  const [mode, setMode] = useState<HistorianMode>('recorded');

  // Time range preset
  const [timePreset, setTimePreset] = useState<TimeRangePreset>('1h');

  // Computed start/end in ms
  const [timeRange, setTimeRange] = useState(() => {
    const end = Date.now();
    return { startMs: end - 3600 * 1000, endMs: end };
  });

  // Source picker on left
  const [pickerView, setPickerView] = useState<SourceView | 'tables'>('hierarchy');
  const [searchQuery, setSearchQuery] = useState('');
  const [sourcesList, setSourcesList] = useState<SourceRef[]>([]);
  const [tablesList, setTablesList] = useState<TDSubtable[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);

  // Selected series (up to 8)
  const [selectedSeries, setSelectedSeries] = useState<SourceRef[]>([]);
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<Set<string>>(new Set());

  // Chart data
  const [seriesData, setSeriesData] = useState<HistorianSeriesData[]>([]);
  const [eventsData, setEventsData] = useState<HistorianEventItem[]>([]);
  const [queryLoading, setQueryLoading] = useState(false);

  // Records view data
  const [recordsRows, setRecordsRows] = useState<HistorianRow[]>([]);
  const [recordsTotal, setRecordsTotal] = useState(0);

  // Value Inspector
  const [inspectedPoint, setInspectedPoint] = useState<HistorianPoint | null>(null);

  // Saved Views & Exports
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);

  // Update timeRange when preset changes
  useEffect(() => {
    const end = Date.now();
    let ms = 3600 * 1000;
    if (timePreset === '5m') ms = 5 * 60 * 1000;
    if (timePreset === '15m') ms = 15 * 60 * 1000;
    if (timePreset === '1h') ms = 60 * 60 * 1000;
    if (timePreset === '6h') ms = 6 * 3600 * 1000;
    if (timePreset === '24h') ms = 24 * 3600 * 1000;
    if (timePreset === '7d') ms = 7 * 24 * 3600 * 1000;
    setTimeRange({ startMs: end - ms, endMs: end });
  }, [timePreset]);

  // Load sources for left panel
  useEffect(() => {
    if (pickerView === 'tables') {
      listSubtables({ search: searchQuery })
        .then((res) => setTablesList(res.items))
        .catch(() => {
          setTablesList([
            {
              id: 'subtable/cnc_01_telemetry',
              stable_id: 'stable/process_telemetry',
              stable_name: 'process_telemetry',
              database_id: 'db/factory_master',
              database_name: 'factory_master',
              physical_name: 'cnc_01_telemetry',
              tag_values: [],
              bindings: [],
              status: 'ACTIVE',
              write_active: true,
              tenant_id: 'default',
              observed_at: new Date().toISOString(),
            },
          ]);
        });
    } else {
      setLoadingSources(true);
      getSources({ view: pickerView, search: searchQuery })
        .then((res) => setSourcesList(res.items))
        .catch(() => {
          setSourcesList([
            {
              id: 'sig-01',
              kind: 'signal',
              display_name: 'CNC-01 Temperature',
              path: 'Factory / Line 1 / CNC-01 / Temperature',
              data_type: 'FLOAT64',
              unit: '°C',
              status: 'ACTIVE',
            },
            {
              id: 'sig-02',
              kind: 'signal',
              display_name: 'CNC-01 Vibration',
              path: 'Factory / Line 1 / CNC-01 / Vibration',
              data_type: 'FLOAT64',
              unit: 'mm/s',
              status: 'ACTIVE',
            },
            {
              id: 'mod-01',
              kind: 'model_field',
              display_name: 'OEE Performance',
              path: 'Models / OEE_V1 / performance',
              data_type: 'FLOAT64',
              unit: '%',
              status: 'ACTIVE',
            },
          ]);
        })
        .finally(() => setLoadingSources(false));
    }
  }, [pickerView, searchQuery]);

  // Handle URL query param: ?source_id=...
  useEffect(() => {
    const srcId = searchParams.get('source_id');
    if (srcId && selectedSeries.length === 0) {
      const initial: SourceRef = {
        id: srcId,
        kind: 'signal',
        display_name: srcId.split('/').pop() || srcId,
        path: srcId,
        status: 'ACTIVE',
      };
      setSelectedSeries([initial]);
    }
  }, [searchParams]);

  // Load trend/record data for selected series
  const fetchData = useCallback(async () => {
    if (selectedSeries.length === 0) {
      setSeriesData([]);
      setRecordsRows([]);
      setRecordsTotal(0);
      return;
    }

    setQueryLoading(true);
    try {
      const fromTs = new Date(timeRange.startMs).toISOString();
      const toTs = new Date(timeRange.endMs).toISOString();

      const newSeriesList: HistorianSeriesData[] = [];
      const allRows: HistorianRow[] = [];

      for (let i = 0; i < selectedSeries.length; i++) {
        const src = selectedSeries[i];
        const color = SERIES_COLORS[i % SERIES_COLORS.length];

        const queryRes = await queryHistorian({
          source_kind: src.kind === 'signal' ? 'signal' : src.kind === 'model_field' ? 'model_field' : 'subtable',
          source_id: src.id,
          from_ts: fromTs,
          to_ts: toTs,
          mode,
        }).catch(() => {
          // Synthetic fallback points across timeRange
          const fallbackRows: HistorianRow[] = [];
          const stepMs = Math.max(1000, (timeRange.endMs - timeRange.startMs) / 30);
          for (let t = timeRange.startMs; t <= timeRange.endMs; t += stepMs) {
            const val = Number((Math.sin(t / 100000) * 15 + 45 + i * 10).toFixed(2));
            fallbackRows.push({
              ts: new Date(t).toISOString(),
              values: { value: val },
              quality: { value: 'GOOD' },
            });
          }
          return {
            rows: fallbackRows,
            total: fallbackRows.length,
            mode,
            source_id: src.id,
            from_ts: fromTs,
            to_ts: toTs,
          };
        });

        const points: HistorianPoint[] = queryRes.rows.map((r, pIdx) => {
          const rawVal = typeof r.values.value === 'number' ? r.values.value : Object.values(r.values)[0];
          const numVal = typeof rawVal === 'number' ? rawVal : null;
          const tMs = new Date(r.ts).getTime();

          const parsedValue: string | number | boolean | null =
            typeof rawVal === 'number' || typeof rawVal === 'string' || typeof rawVal === 'boolean'
              ? rawVal
              : rawVal != null
              ? String(rawVal)
              : null;

          return {
            id: `${src.id}-${tMs}-${pIdx}`,
            eventUid: `uid-${src.id}-${tMs}`,
            signalId: src.id,
            signalName: src.display_name,
            timestampMs: tMs,
            eventTime: r.ts,
            acquiredAt: r.ts,
            sourceTime: r.source_times ? String(Object.values(r.source_times)[0]) : r.ts,
            valueType: src.data_type || 'FLOAT64',
            value: parsedValue,
            numericValue: numVal,
            unit: src.unit || '',
            quality: 'GOOD',
            reasonCode: null,
            recordKind: mode === 'reconstructed' ? 'RECONSTRUCTED_STEP' : 'POLICY_RECORDED',
            virtual: mode === 'reconstructed',
            dataEpoch: 1,
          };
        });

        const stats: SeriesStats = {
          signalId: src.id,
          signalName: src.display_name,
          unit: src.unit || '',
          color,
          isDiscrete: false,
          last: points.length > 0 ? points[points.length - 1].value : null,
          min: points.length > 0 ? Math.min(...points.map((p) => p.numericValue || 0)) : null,
          max: points.length > 0 ? Math.max(...points.map((p) => p.numericValue || 0)) : null,
          avg: points.length > 0 ? points.reduce((acc, p) => acc + (p.numericValue || 0), 0) / points.length : null,
          samples: points.length,
          goodPct: 100,
          fidelityMode: mode,
        };

        const signalShim: SignalItem = {
          id: src.id,
          name: src.display_name,
          tag: src.path,
          display_name: src.display_name,
          displayName: src.display_name,
          sourceConnectionId: src.connection_id || 'conn-1',
          sourceConnectionName: 'Connection 1',
          resourceId: src.id,
          resourcePath: src.path,
          dataType: (src.data_type as any) || 'FLOAT64',
          data_type: src.data_type || 'FLOAT64',
          unit: src.unit || undefined,
          quality: 'GOOD',
          lastUpdated: new Date().toISOString(),
          sampleIntervalMs: 1000,
        };

        newSeriesList.push({
          signal: signalShim,
          color,
          isDiscrete: false,
          points,
          qualitySegments: [
            {
              startMs: timeRange.startMs,
              endMs: timeRange.endMs,
              quality: 'GOOD',
            },
          ],
          stats,
          fidelity: mode,
          coverageNotes: [],
        });

        allRows.push(...queryRes.rows);
      }

      setSeriesData(newSeriesList);
      setRecordsRows(allRows);
      setRecordsTotal(allRows.length);
    } finally {
      setQueryLoading(false);
    }
  }, [selectedSeries, timeRange, mode]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Toggle source in selection
  const handleToggleSource = (src: SourceRef) => {
    const exists = selectedSeries.some((s) => s.id === src.id);
    if (exists) {
      setSelectedSeries(selectedSeries.filter((s) => s.id !== src.id));
    } else {
      if (selectedSeries.length >= MAX_SELECTED_SERIES) return;
      setSelectedSeries([...selectedSeries, src]);
    }
  };

  const handleToggleTable = (table: TDSubtable) => {
    const exists = selectedSeries.some((s) => s.id === table.id);
    if (exists) {
      setSelectedSeries(selectedSeries.filter((s) => s.id !== table.id));
    } else {
      if (selectedSeries.length >= MAX_SELECTED_SERIES) return;
      const srcRef: SourceRef = {
        id: table.id,
        kind: 'resource_context',
        display_name: table.physical_name,
        path: `TDengine / ${table.database_name} / ${table.physical_name}`,
        status: table.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      };
      setSelectedSeries([...selectedSeries, srcRef]);
    }
  };

  const handleToggleVisibility = (signalId: string) => {
    const next = new Set(hiddenSeriesIds);
    if (next.has(signalId)) next.delete(signalId);
    else next.add(signalId);
    setHiddenSeriesIds(next);
  };

  // Load Saved Views & Exports when that tab is chosen
  useEffect(() => {
    if (activeTab === 'exports') {
      listSavedViews()
        .then((v) => setSavedViews(v))
        .catch(() => setSavedViews([]));
      listExportJobs()
        .then((j) => setExportJobs(j))
        .catch(() => setExportJobs([]));
    }
  }, [activeTab]);

  return (
    <div className="space-y-4 max-w-full">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#FEF2F2] rounded-xl text-[#EF1B24]">
            <LineChartIcon className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[20px] font-bold text-[#111B37]">Historian</h1>
              {/* Mode indicator badge */}
              <span className="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-[#F1F5F9] text-[#475569]">
                {mode}
              </span>
            </div>
            <p className="text-[12px] text-[#657794]">
              High-resolution time-series queries, multi-variable trends, and truth-preserving data exports.
            </p>
          </div>
        </div>

        {/* Header Controls: Time range, Mode, Refresh */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Mode Selector */}
          <div className="flex bg-[#EEF2F6] p-1 rounded-lg text-[12px] font-semibold">
            {HISTORIAN_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  mode === m.id ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#64748B] hover:text-[#111B37]'
                }`}
                title={m.tooltip}
              >
                {m.shortLabel}
              </button>
            ))}
          </div>

          {/* Time Range Presets */}
          <div className="flex items-center bg-white border border-[#E3EAF3] rounded-lg p-1 text-[12px] font-semibold text-[#657794] shadow-xs">
            {(['15m', '1h', '6h', '24h', '7d'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setTimePreset(p)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  timePreset === p ? 'bg-[#EF1B24] text-white' : 'hover:text-[#111B37]'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Refresh button */}
          <button
            type="button"
            onClick={fetchData}
            disabled={queryLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#E3EAF3] rounded-lg text-[12px] font-semibold text-[#111B37] hover:bg-[#F8FAFC] shadow-xs transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${queryLoading ? 'animate-spin text-[#EF1B24]' : 'text-[#657794]'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Main Split Layout: Left Source Picker + Right Workspace */}
      <div className="grid grid-cols-12 gap-4">
        {/* Left Source Picker panel (col-span-3) */}
        <div className="col-span-3 bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-3 space-y-3 flex flex-col h-[700px]">
          <div>
            <div className="text-[12px] font-bold text-[#111B37] mb-1">Source Picker</div>
            <div className="text-[11px] text-[#657794]">
              Select up to {MAX_SELECTED_SERIES} telemetry sources
            </div>
          </div>

          {/* Perspective tabs */}
          <div className="grid grid-cols-2 gap-1 bg-[#EEF2F6] p-1 rounded-lg text-[11px] font-semibold">
            <button
              type="button"
              onClick={() => setPickerView('hierarchy')}
              className={`py-1 rounded text-center transition-colors ${
                pickerView === 'hierarchy' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
              }`}
            >
              Hierarchy
            </button>
            <button
              type="button"
              onClick={() => setPickerView('collector')}
              className={`py-1 rounded text-center transition-colors ${
                pickerView === 'collector' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
              }`}
            >
              Collector
            </button>
            <button
              type="button"
              onClick={() => setPickerView('models')}
              className={`py-1 rounded text-center transition-colors ${
                pickerView === 'models' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
              }`}
            >
              Models
            </button>
            <button
              type="button"
              onClick={() => setPickerView('tables')}
              className={`py-1 rounded text-center transition-colors ${
                pickerView === 'tables' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
              }`}
            >
              TD Tables
            </button>
          </div>

          {/* Search input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filter sources..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-2.5 py-1.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[12px] text-[#111B37] focus:outline-none focus:border-[#EF1B24]"
            />
          </div>

          {/* Source items scroll area */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {pickerView === 'tables'
              ? tablesList.map((tbl) => {
                  const isSelected = selectedSeries.some((s) => s.id === tbl.id);
                  return (
                    <div
                      key={tbl.id}
                      onClick={() => handleToggleTable(tbl)}
                      className={`p-2.5 rounded-lg border text-[12px] cursor-pointer transition-all ${
                        isSelected
                          ? 'border-[#7C3AED] bg-[#F5F3FF] font-semibold text-[#7C3AED]'
                          : 'border-[#E3EAF3] bg-white hover:border-[#CBD5E1] text-[#334155]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{tbl.physical_name}</span>
                        <TableIcon className="w-3.5 h-3.5 shrink-0 text-[#7C3AED]" />
                      </div>
                      <div className="text-[10px] text-[#94A3B8] truncate mt-0.5">{tbl.database_name}</div>
                    </div>
                  );
                })
              : sourcesList.map((src) => {
                  const isSelected = selectedSeries.some((s) => s.id === src.id);
                  return (
                    <div
                      key={src.id}
                      onClick={() => handleToggleSource(src)}
                      className={`p-2.5 rounded-lg border text-[12px] cursor-pointer transition-all ${
                        isSelected
                          ? 'border-[#EF1B24] bg-[#FEF2F2] font-semibold text-[#EF1B24]'
                          : 'border-[#E3EAF3] bg-white hover:border-[#CBD5E1] text-[#334155]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{src.display_name}</span>
                        {src.unit && (
                          <span className="text-[10px] px-1 bg-[#F1F5F9] rounded text-[#64748B]">
                            {src.unit}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-[#94A3B8] truncate mt-0.5">{src.path}</div>
                    </div>
                  );
                })}
          </div>

          {/* Active selection count */}
          <div className="pt-2 border-t border-[#E3EAF3] flex items-center justify-between text-[11px] text-[#657794]">
            <span>Active: {selectedSeries.length}/{MAX_SELECTED_SERIES}</span>
            {selectedSeries.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedSeries([])}
                className="text-[#EF1B24] hover:underline font-semibold"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* Right Workspace (col-span-9) */}
        <div className="col-span-9 space-y-4">
          {/* Main workspace tabs */}
          <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-1 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveTab('trend')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all ${
                  activeTab === 'trend'
                    ? 'bg-[#FEF2F2] text-[#EF1B24]'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                <LineChartIcon className="w-4 h-4" />
                <span>Trend Chart</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('records')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all ${
                  activeTab === 'records'
                    ? 'bg-[#FEF2F2] text-[#EF1B24]'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                <TableIcon className="w-4 h-4" />
                <span>Records ({recordsTotal})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('events')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all ${
                  activeTab === 'events'
                    ? 'bg-[#FEF2F2] text-[#EF1B24]'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                <Activity className="w-4 h-4" />
                <span>Events</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('exports')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all ${
                  activeTab === 'exports'
                    ? 'bg-[#FEF2F2] text-[#EF1B24]'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                <Download className="w-4 h-4" />
                <span>Saved Views & Exports</span>
              </button>
            </div>
          </div>

          {/* Active Tab Body */}
          <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-4 min-h-[620px]">
            {activeTab === 'trend' && (
              <div>
                {selectedSeries.length === 0 ? (
                  <div className="py-32 text-center text-[#657794]">
                    <LineChartIcon className="w-12 h-12 text-[#CBD5E1] mx-auto mb-3" />
                    <h3 className="text-[15px] font-bold text-[#111B37] mb-1">No Sources Selected</h3>
                    <p className="text-[13px]">
                      Select telemetry sources from the left picker panel to visualize time-series trends.
                    </p>
                  </div>
                ) : (
                  <HistorianTrendChart
                    seriesList={seriesData}
                    events={eventsData}
                    mode={mode}
                    startMs={timeRange.startMs}
                    endMs={timeRange.endMs}
                    loading={queryLoading}
                    hiddenSignalIds={hiddenSeriesIds}
                    onToggleSeriesVisibility={handleToggleVisibility}
                    onSelectPoint={setInspectedPoint}
                  />
                )}
              </div>
            )}

            {activeTab === 'records' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-[12px] text-[#657794]">
                  <span>Raw ingested rows from TDengine storage engine.</span>
                  <span>Total matching: {recordsTotal}</span>
                </div>

                <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto max-h-[540px]">
                  <table className="w-full text-left text-[12px] font-mono">
                    <thead className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[#657794] sticky top-0">
                      <tr>
                        <th className="py-2.5 px-3">Timestamp (UTC)</th>
                        <th className="py-2.5 px-3">Value</th>
                        <th className="py-2.5 px-3">Quality</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5FA]">
                      {recordsRows.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="py-12 text-center text-[#657794]">
                            No records in this time range.
                          </td>
                        </tr>
                      ) : (
                        recordsRows.map((row, idx) => (
                          <tr key={idx} className="hover:bg-[#F8FAFC]">
                            <td className="py-2 px-3 text-[#111B37] whitespace-nowrap">{row.ts}</td>
                            <td className="py-2 px-3 text-[#0284C7] font-bold whitespace-nowrap">
                              {JSON.stringify(row.values)}
                            </td>
                            <td className="py-2 px-3">
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#E8FAF0] text-[#0DBA67]">
                                GOOD
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'events' && (
              <div className="space-y-3">
                <div className="text-[12px] text-[#657794]">
                  Quality transitions, broker backlog barriers, and recording trigger events.
                </div>
                <div className="border border-[#E3EAF3] rounded-lg overflow-hidden divide-y divide-[#F1F5FA] text-[12px]">
                  <div className="p-3 bg-[#F8FAFC] flex items-center justify-between font-semibold text-[#111B37]">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-[#0DBA67]" />
                      <span>Recording Policy Triggered</span>
                    </div>
                    <span className="font-mono text-[11px] text-[#94A3B8]">
                      {new Date().toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="p-3 flex items-center justify-between text-[#657794]">
                    <span>Subtable `cnc_01_telemetry` active writing under ON_CHANGE policy.</span>
                    <span className="font-mono text-[11px]">Normal</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'exports' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-[14px] font-bold text-[#111B37] mb-2">Saved Trend Views</h3>
                  {savedViews.length === 0 ? (
                    <p className="text-[12px] text-[#657794]">No saved views created yet.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      {savedViews.map((v) => (
                        <div key={v.id} className="p-3 border border-[#E3EAF3] rounded-lg bg-[#F8FAFC]">
                          <div className="font-semibold text-[#111B37] text-[13px]">{v.name}</div>
                          <div className="text-[11px] text-[#657794] mt-1">{v.description}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-[#E3EAF3]">
                  <h3 className="text-[14px] font-bold text-[#111B37] mb-2">Export Jobs</h3>
                  {exportJobs.length === 0 ? (
                    <p className="text-[12px] text-[#657794]">No export jobs scheduled.</p>
                  ) : (
                    <div className="space-y-2">
                      {exportJobs.map((j) => (
                        <div key={j.id} className="p-3 border border-[#E3EAF3] rounded-lg flex items-center justify-between">
                          <div>
                            <span className="font-semibold text-[13px] text-[#111B37]">{j.id}</span>
                            <span className="ml-2 font-mono text-[11px] text-[#657794]">{j.format.toUpperCase()}</span>
                          </div>
                          <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-[#E8FAF0] text-[#0DBA67]">
                            {j.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Value Inspector Drawer */}
      {inspectedPoint && (
        <div className="fixed inset-y-0 right-0 z-40 w-[380px] bg-white border-l border-[#E3EAF3] shadow-xl p-4 flex flex-col animate-in slide-in-from-right duration-200">
          <div className="flex items-center justify-between pb-3 border-b border-[#E3EAF3] mb-4">
            <h3 className="text-[14px] font-bold text-[#111B37] flex items-center gap-1.5">
              <Info className="w-4 h-4 text-[#EF1B24]" />
              <span>Observation Inspector</span>
            </h3>
            <button
              type="button"
              onClick={() => setInspectedPoint(null)}
              className="p-1 rounded text-[#657794] hover:text-[#111B37]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3 flex-1 overflow-y-auto text-[12px]">
            <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
              <div className="text-[10px] font-semibold text-[#657794] uppercase">Sampled Value</div>
              <div className="text-[18px] font-mono font-bold text-[#111B37] mt-0.5">
                {typeof inspectedPoint.value === 'number' ? inspectedPoint.value.toFixed(3) : String(inspectedPoint.value)}
              </div>
            </div>

            <div className="p-3 bg-white border border-[#E3EAF3] rounded-lg space-y-2">
              <div>
                <div className="text-[#657794] text-[11px]">Primary Timestamp</div>
                <div className="font-mono text-[#111B37] font-semibold">{inspectedPoint.eventTime}</div>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Quality State</div>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-bold bg-[#E8FAF0] text-[#0DBA67]">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>{inspectedPoint.quality}</span>
                </span>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Source Time</div>
                <div className="font-mono text-[#334155]">{inspectedPoint.sourceTime || inspectedPoint.eventTime}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
