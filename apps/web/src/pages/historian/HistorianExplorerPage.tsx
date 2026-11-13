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
  AlertTriangle,
  FileSpreadsheet,
  Clock,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Info,
  Shield,
  Layers,
} from 'lucide-react';
import { HistorianTrendChart } from './HistorianTrendChart';
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
} from './types';
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
import {
  RemoteErrorState,
  RemoteLoadingState,
  RemoteEmptyState,
} from '../../components/common/RemoteResourceState';

export const HistorianExplorerPage: React.FC = () => {
  const [searchParams] = useSearchParams();

  // Active view tab: 'trend' | 'records' | 'events' | 'exports'
  const [activeTab, setActiveTab] = useState<'trend' | 'records' | 'events' | 'exports'>('trend');

  // Mode: recorded (strict raw events) vs reconstructed (interpolated timeline) vs operational
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
  const [sourcesError, setSourcesError] = useState<unknown | null>(null);

  // Selected series (up to 8)
  const [selectedSeries, setSelectedSeries] = useState<SourceRef[]>([]);
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<Set<string>>(new Set());

  // Chart data
  const [seriesData, setSeriesData] = useState<HistorianSeriesData[]>([]);
  const [eventsData, setEventsData] = useState<HistorianEventItem[]>([]);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<unknown | null>(null);

  // Records view data
  const [recordsRows, setRecordsRows] = useState<HistorianRow[]>([]);
  const [recordsTotal, setRecordsTotal] = useState(0);

  // Value Inspector
  const [inspectedPoint, setInspectedPoint] = useState<HistorianPoint | null>(null);

  // Saved Views & Exports
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [exportSubmitting, setExportSubmitting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

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

  // Load sources for left panel - strictly real data
  const fetchSources = useCallback(() => {
    setLoadingSources(true);
    setSourcesError(null);

    if (pickerView === 'tables') {
      listSubtables({ search: searchQuery || undefined })
        .then((res) => {
          setTablesList(res?.items || []);
        })
        .catch((err) => {
          console.error('Failed to list subtables for Historian:', err);
          setSourcesError(err);
          setTablesList([]);
        })
        .finally(() => setLoadingSources(false));
    } else {
      getSources({ view: pickerView, search: searchQuery || undefined })
        .then((res) => {
          setSourcesList(res?.items || []);
        })
        .catch((err) => {
          console.error('Failed to get sources for Historian:', err);
          setSourcesError(err);
          setSourcesList([]);
        })
        .finally(() => setLoadingSources(false));
    }
  }, [pickerView, searchQuery]);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

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

  // Load trend/record data for selected series - strictly real queries, NO Math.sin fallback!
  const fetchData = useCallback(async () => {
    if (selectedSeries.length === 0) {
      setSeriesData([]);
      setRecordsRows([]);
      setRecordsTotal(0);
      setEventsData([]);
      setQueryError(null);
      return;
    }

    setQueryLoading(true);
    setQueryError(null);
    try {
      const fromTs = new Date(timeRange.startMs).toISOString();
      const toTs = new Date(timeRange.endMs).toISOString();

      const newSeriesList: HistorianSeriesData[] = [];
      const allRows: HistorianRow[] = [];
      const extractedEvents: HistorianEventItem[] = [];

      for (let i = 0; i < selectedSeries.length; i++) {
        const src = selectedSeries[i];
        const color = SERIES_COLORS[i % SERIES_COLORS.length];

        const queryRes = await queryHistorian({
          source_kind: src.kind === 'signal' ? 'signal' : src.kind === 'model_field' ? 'model_field' : 'subtable',
          source_id: src.id,
          from_ts: fromTs,
          to_ts: toTs,
          mode,
        });

        const rows = Array.isArray(queryRes?.rows) ? queryRes.rows : [];

        const points: HistorianPoint[] = rows.map((r, pIdx) => {
          const rawVal = typeof r.values?.value === 'number' ? r.values.value : Object.values(r.values || {})[0];
          const numVal = typeof rawVal === 'number' ? rawVal : typeof rawVal === 'string' && !isNaN(Number(rawVal)) ? Number(rawVal) : null;
          const tMs = new Date(r.ts).getTime();

          const parsedValue: string | number | boolean | null =
            typeof rawVal === 'number' || typeof rawVal === 'string' || typeof rawVal === 'boolean'
              ? rawVal
              : rawVal != null
              ? String(rawVal)
              : null;

          // Parse actual quality from record
          const rawQualStr = r.quality ? String(r.quality.value || Object.values(r.quality)[0] || 'GOOD').toUpperCase() : 'GOOD';
          const pointQuality: 'GOOD' | 'BAD' | 'UNCERTAIN' | 'STALE' =
            rawQualStr.includes('BAD')
              ? 'BAD'
              : rawQualStr.includes('UNCERTAIN')
              ? 'UNCERTAIN'
              : rawQualStr.includes('STALE')
              ? 'STALE'
              : 'GOOD';

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
            quality: pointQuality,
            reasonCode: null,
            recordKind: mode === 'reconstructed' ? 'RECONSTRUCTED_STEP' : 'POLICY_RECORDED',
            virtual: mode === 'reconstructed',
            dataEpoch: 1,
          };
        });

        // Helper to normalize quality to valid segment union
        const toQuality = (q: unknown): 'GOOD' | 'UNCERTAIN' | 'STALE' | 'BAD' => {
          const s = String(q || '').toUpperCase();
          if (s.includes('BAD')) return 'BAD';
          if (s.includes('UNCERTAIN')) return 'UNCERTAIN';
          if (s.includes('STALE')) return 'STALE';
          return 'GOOD';
        };

        // Compute actual quality segments
        const qualitySegments: QualitySegment[] = [];
        if (points.length > 0) {
          let segStart = points[0].timestampMs;
          let currentQual = toQuality(points[0].quality);
          for (let pIdx = 1; pIdx < points.length; pIdx++) {
            const nextQual = toQuality(points[pIdx].quality);
            if (nextQual !== currentQual) {
              qualitySegments.push({
                startMs: segStart,
                endMs: points[pIdx].timestampMs,
                quality: currentQual,
              });
              segStart = points[pIdx].timestampMs;
              currentQual = nextQual;
            }
          }
          qualitySegments.push({
            startMs: segStart,
            endMs: points[points.length - 1].timestampMs,
            quality: currentQual,
          });
        }

        // Calculate REAL statistical aggregates from actual points
        const numPoints = points.filter((p) => p.numericValue !== null);
        const goodCount = points.filter((p) => p.quality === 'GOOD').length;
        const actualGoodPct = points.length > 0 ? Number(((goodCount / points.length) * 100).toFixed(1)) : 0;

        const stats: SeriesStats = {
          signalId: src.id,
          signalName: src.display_name,
          unit: src.unit || '',
          color,
          isDiscrete: false,
          last: points.length > 0 ? points[points.length - 1].value : null,
          min: numPoints.length > 0 ? Math.min(...numPoints.map((p) => p.numericValue!)) : null,
          max: numPoints.length > 0 ? Math.max(...numPoints.map((p) => p.numericValue!)) : null,
          avg:
            numPoints.length > 0
              ? Number((numPoints.reduce((acc, p) => acc + p.numericValue!, 0) / numPoints.length).toFixed(2))
              : null,
          samples: points.length,
          goodPct: actualGoodPct,
          fidelityMode: mode,
        };

        const signalShim: SignalItem = {
          id: src.id,
          name: src.display_name,
          tag: src.path,
          display_name: src.display_name,
          displayName: src.display_name,
          sourceConnectionId: src.connection_id || 'conn-1',
          sourceConnectionName: src.connection_name || 'Industrial Connection',
          resourceId: src.resource_id || src.id,
          resourcePath: src.path,
          dataType: (src.data_type as any) || 'FLOAT64',
          data_type: src.data_type || 'FLOAT64',
          unit: src.unit || undefined,
          quality: points.length > 0 ? points[points.length - 1].quality : 'GOOD',
          lastUpdated: points.length > 0 ? points[points.length - 1].eventTime : new Date().toISOString(),
          sampleIntervalMs: 1000,
        };

        newSeriesList.push({
          signal: signalShim,
          color,
          isDiscrete: false,
          points,
          qualitySegments,
          stats,
          fidelity: mode,
          coverageNotes: [],
        });

        allRows.push(...rows);

        // Extract quality transition events
        for (let pIdx = 1; pIdx < points.length; pIdx++) {
          if (points[pIdx].quality !== points[pIdx - 1].quality) {
            extractedEvents.push({
              id: `evt-${src.id}-${points[pIdx].timestampMs}`,
              timestampMs: points[pIdx].timestampMs,
              timestamp: points[pIdx].eventTime,
              kind: 'QUALITY_TRANSITION',
              signalId: src.id,
              signalName: src.display_name,
              fromQuality: String(points[pIdx - 1].quality),
              toQuality: String(points[pIdx].quality),
              summary: `Quality changed from ${points[pIdx - 1].quality} to ${points[pIdx].quality}`,
            });
          }
        }
      }

      setSeriesData(newSeriesList);
      setRecordsRows(allRows);
      setRecordsTotal(allRows.length);
      setEventsData(extractedEvents);
    } catch (err: unknown) {
      console.error('Historian query failed:', err);
      setQueryError(err);
      setSeriesData([]);
      setRecordsRows([]);
      setRecordsTotal(0);
      setEventsData([]);
    } finally {
      setQueryLoading(false);
    }
  }, [selectedSeries, timeRange, mode]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Load Saved Views & Exports when switching to exports tab
  useEffect(() => {
    if (activeTab === 'exports') {
      listSavedViews().then(setSavedViews).catch(console.warn);
      listExportJobs().then(setExportJobs).catch(console.warn);
    }
  }, [activeTab]);

  // Trigger export job
  const handleCreateExport = async (format: 'csv' | 'json') => {
    if (selectedSeries.length === 0) return;
    setExportSubmitting(true);
    setExportError(null);
    try {
      const src = selectedSeries[0];
      const job = await createExportJob({
        source_kind: src.kind,
        source_id: src.id,
        from_ts: new Date(timeRange.startMs).toISOString(),
        to_ts: new Date(timeRange.endMs).toISOString(),
        format,
      });
      setExportJobs((prev) => [job, ...prev]);
    } catch (err: any) {
      setExportError(err?.message || 'Failed to schedule export job');
    } finally {
      setExportSubmitting(false);
    }
  };

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
    setHiddenSeriesIds((prev) => {
      const next = new Set(prev);
      if (next.has(signalId)) next.delete(signalId);
      else next.add(signalId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div>
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#657794] mb-0.5">
            <span>Historian & Storage</span>
            <span>/</span>
            <span className="text-[#111B37] font-semibold">Historian</span>
          </div>
          <h1 className="text-[20px] font-bold text-[#111B37] leading-tight">Historian Explorer</h1>
          <p className="text-[13px] text-[#657794] mt-0.5">
            High-fidelity historical analysis powered by TDengine time-series data plane.
          </p>
        </div>

        {/* Header Right: Mode switcher & Time Range presets */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Mode Switcher: recorded vs reconstructed */}
          <div className="flex items-center bg-[#F1F5FA] p-1 rounded-lg border border-[#E3EAF3]">
            {HISTORIAN_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`px-3 py-1 rounded-md text-[12px] font-semibold transition-all ${
                  mode === m.id
                    ? 'bg-white text-[#111B37] shadow-xs'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
                title={m.tooltip}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Time presets */}
          <div className="flex items-center bg-[#F1F5FA] p-1 rounded-lg border border-[#E3EAF3]">
            {(['5m', '15m', '1h', '6h', '24h', '7d'] as TimeRangePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setTimePreset(p)}
                className={`px-2.5 py-1 rounded-md text-[12px] font-semibold transition-all ${
                  timePreset === p
                    ? 'bg-[#EF1B24] text-white shadow-xs'
                    : 'text-[#657794] hover:text-[#111B37]'
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
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#E3EAF3] rounded-lg text-[13px] font-semibold text-[#111B37] hover:bg-[#F8FAFC] shadow-xs transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${queryLoading ? 'animate-spin text-[#EF1B24]' : 'text-[#657794]'}`} />
            <span>Query</span>
          </button>
        </div>
      </div>

      {/* Main split layout */}
      <div className="grid grid-cols-12 gap-4">
        {/* Left Source Picker (col-span-3) */}
        <div className="col-span-3 bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-3 flex flex-col space-y-3 min-h-[680px]">
          <div>
            <div className="text-[11px] font-bold text-[#657794] uppercase tracking-wider mb-2">
              Select Series
            </div>

            {/* Picker tabs: Hierarchy | Collector | Models | Tables */}
            <div className="grid grid-cols-4 gap-1 bg-[#F1F5FA] p-1 rounded-lg text-[11px] font-semibold">
              <button
                type="button"
                onClick={() => setPickerView('hierarchy')}
                className={`py-1 rounded text-center transition-all ${
                  pickerView === 'hierarchy' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
                }`}
              >
                Tree
              </button>
              <button
                type="button"
                onClick={() => setPickerView('collector')}
                className={`py-1 rounded text-center transition-all ${
                  pickerView === 'collector' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
                }`}
              >
                Conn
              </button>
              <button
                type="button"
                onClick={() => setPickerView('models')}
                className={`py-1 rounded text-center transition-all ${
                  pickerView === 'models' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
                }`}
              >
                Models
              </button>
              <button
                type="button"
                onClick={() => setPickerView('tables')}
                className={`py-1 rounded text-center transition-all ${
                  pickerView === 'tables' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
                }`}
              >
                Tables
              </button>
            </div>
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
            {loadingSources ? (
              <div className="py-12 text-center text-[#657794] text-[12px]">
                <RefreshCw className="w-4 h-4 animate-spin text-[#EF1B24] mx-auto mb-1.5" />
                Loading sources...
              </div>
            ) : sourcesError ? (
              <div className="p-3 bg-[#FEF2F2] border border-[#FAC6C9] rounded-lg text-center">
                <p className="text-[12px] text-[#EF1B24] font-medium mb-1.5">Failed to load sources</p>
                <button
                  type="button"
                  onClick={fetchSources}
                  className="px-2.5 py-1 bg-white border border-[#FAC6C9] text-[#EF1B24] rounded text-[11px] font-semibold hover:bg-[#FEF2F2]"
                >
                  Retry
                </button>
              </div>
            ) : pickerView === 'tables' ? (
              tablesList.length === 0 ? (
                <div className="py-8 text-center text-[#8C9BAE] text-[12px] italic">
                  No subtables found.
                </div>
              ) : (
                tablesList.map((tbl) => {
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
              )
            ) : sourcesList.length === 0 ? (
              <div className="py-8 text-center text-[#8C9BAE] text-[12px] italic">
                No sources found.
              </div>
            ) : (
              sourcesList.map((src) => {
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
                    </div>
                    <div className="text-[10px] text-[#94A3B8] truncate mt-0.5">{src.path}</div>
                  </div>
                );
              })
            )}
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
                <span>Events ({eventsData.length})</span>
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
                ) : queryError ? (
                  <RemoteErrorState
                    error={queryError}
                    subject="historian trend query"
                    onRetry={fetchData}
                  />
                ) : !queryLoading && recordsTotal === 0 ? (
                  <RemoteEmptyState
                    title="No Telemetry Data Recorded"
                    description={`No observations found for the selected ${selectedSeries.length} source(s) in this ${timePreset} window.`}
                    icon={LineChartIcon}
                  />
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

                {queryError ? (
                  <RemoteErrorState
                    error={queryError}
                    subject="historian records"
                    onRetry={fetchData}
                  />
                ) : queryLoading ? (
                  <RemoteLoadingState subject="historian records" />
                ) : (
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
                              No records found for the selected time range.
                            </td>
                          </tr>
                        ) : (
                          recordsRows.map((row, idx) => {
                            const rawQual = row.quality
                              ? String(row.quality.value || Object.values(row.quality)[0] || 'GOOD').toUpperCase()
                              : 'GOOD';
                            const isGood = rawQual.includes('GOOD');
                            const isBad = rawQual.includes('BAD');

                            return (
                              <tr key={idx} className="hover:bg-[#F8FAFC]">
                                <td className="py-2 px-3 text-[#111B37] whitespace-nowrap">{row.ts}</td>
                                <td className="py-2 px-3 text-[#0284C7] font-bold whitespace-nowrap">
                                  {JSON.stringify(row.values)}
                                </td>
                                <td className="py-2 px-3">
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                      isGood
                                        ? 'bg-[#E8FAF0] text-[#0DBA67]'
                                        : isBad
                                        ? 'bg-[#FEF2F2] text-[#EF1B24]'
                                        : 'bg-[#FFFBEB] text-[#D97706]'
                                    }`}
                                  >
                                    {rawQual}
                                  </span>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'events' && (
              <div className="space-y-3">
                <div className="text-[12px] text-[#657794]">
                  Quality transitions, recording policy triggers, and alarms recorded across the time window.
                </div>
                {eventsData.length === 0 ? (
                  <div className="py-16 text-center text-[#657794] text-[13px] border border-[#E3EAF3] rounded-lg">
                    No transition events recorded in this time range.
                  </div>
                ) : (
                  <div className="border border-[#E3EAF3] rounded-lg overflow-hidden divide-y divide-[#F1F5FA] text-[12px]">
                    {eventsData.map((evt) => {
                      const isBad = evt.toQuality?.includes('BAD');
                      const isWarn = evt.toQuality?.includes('UNCERTAIN');
                      return (
                        <div key={evt.id} className="p-3 flex items-center justify-between hover:bg-[#F8FAFC]">
                          <div className="flex items-center gap-2.5">
                            <Activity
                              className={`w-4 h-4 ${
                                isBad
                                  ? 'text-[#EF1B24]'
                                  : isWarn
                                  ? 'text-[#D97706]'
                                  : 'text-[#0DBA67]'
                              }`}
                            />
                            <div>
                              <span className="font-semibold text-[#111B37]">{evt.summary}</span>
                              <div className="text-[11px] text-[#657794]">
                                {evt.signalName ? `${evt.signalName} (${evt.kind})` : evt.kind}
                              </div>
                            </div>
                          </div>
                          <span className="font-mono text-[11px] text-[#94A3B8]">
                            {new Date(evt.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'exports' && (
              <div className="space-y-6">
                {/* Export Action Card */}
                <div className="p-4 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl flex items-center justify-between">
                  <div>
                    <h3 className="text-[14px] font-bold text-[#111B37]">Export Active Selection</h3>
                    <p className="text-[12px] text-[#657794] mt-0.5">
                      Download historical records ({recordsTotal} rows) in CSV or JSON format.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={selectedSeries.length === 0 || exportSubmitting}
                      onClick={() => handleCreateExport('csv')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#EF1B24] hover:bg-[#D9141D] text-white rounded-lg text-[12px] font-semibold shadow-xs disabled:opacity-50 transition-colors"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      <span>Export CSV</span>
                    </button>
                    <button
                      type="button"
                      disabled={selectedSeries.length === 0 || exportSubmitting}
                      onClick={() => handleCreateExport('json')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#E3EAF3] hover:bg-[#F1F5FA] text-[#111B37] rounded-lg text-[12px] font-semibold shadow-xs disabled:opacity-50 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Export JSON</span>
                    </button>
                  </div>
                </div>

                {exportError && (
                  <div className="p-3 bg-[#FEF2F2] border border-[#FAC6C9] rounded-lg text-[12px] text-[#EF1B24]">
                    {exportError}
                  </div>
                )}

                <div>
                  <h3 className="text-[14px] font-bold text-[#111B37] mb-2">Saved Trend Views</h3>
                  {savedViews.length === 0 ? (
                    <p className="text-[12px] text-[#657794] italic">No saved views created yet.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      {savedViews.map((v) => (
                        <div key={v.id} className="p-3 border border-[#E3EAF3] rounded-lg bg-[#F8FAFC]">
                          <div className="font-semibold text-[#111B37] text-[13px]">{v.name}</div>
                          <div className="text-[11px] text-[#657794] mt-1">{v.description || 'No description'}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-[#E3EAF3]">
                  <h3 className="text-[14px] font-bold text-[#111B37] mb-2">Export Jobs</h3>
                  {exportJobs.length === 0 ? (
                    <p className="text-[12px] text-[#657794] italic">No export jobs recorded.</p>
                  ) : (
                    <div className="space-y-2">
                      {exportJobs.map((j) => (
                        <div key={j.id} className="p-3 border border-[#E3EAF3] rounded-lg flex items-center justify-between bg-white">
                          <div className="flex items-center gap-3">
                            <Download className="w-4 h-4 text-[#657794]" />
                            <div>
                              <div className="font-semibold text-[13px] text-[#111B37]">{j.id}</div>
                              <div className="text-[11px] text-[#657794]">
                                Format: <span className="font-mono uppercase">{j.format}</span> · {j.row_count ?? 0} rows
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                                j.status === 'DONE'
                                  ? 'bg-[#E8FAF0] text-[#0DBA67]'
                                  : j.status === 'ERROR'
                                  ? 'bg-[#FEF2F2] text-[#EF1B24]'
                                  : 'bg-[#FFFBEB] text-[#D97706]'
                              }`}
                            >
                              {j.status}
                            </span>
                            {j.download_url && (
                              <a
                                href={j.download_url}
                                download
                                className="px-2.5 py-1 bg-[#1976D2] text-white rounded text-[11px] font-semibold hover:bg-[#1565C0]"
                              >
                                Download
                              </a>
                            )}
                          </div>
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

      {/* Value Inspector Drawer with Real Observation Provenance */}
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

            <div className="p-3 bg-white border border-[#E3EAF3] rounded-lg space-y-2.5">
              <div>
                <div className="text-[#657794] text-[11px]">Signal / Source</div>
                <div className="font-semibold text-[#111B37] truncate">{inspectedPoint.signalName}</div>
                <div className="font-mono text-[10px] text-[#94A3B8] truncate">{inspectedPoint.signalId}</div>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Primary Event Time</div>
                <div className="font-mono text-[#111B37] font-semibold">{inspectedPoint.eventTime}</div>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Acquired At</div>
                <div className="font-mono text-[#334155]">{inspectedPoint.acquiredAt}</div>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Source Time (Device Clock)</div>
                <div className="font-mono text-[#334155]">{inspectedPoint.sourceTime || inspectedPoint.eventTime}</div>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Quality State</div>
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    inspectedPoint.quality === 'GOOD'
                      ? 'bg-[#E8FAF0] text-[#0DBA67]'
                      : inspectedPoint.quality === 'BAD'
                      ? 'bg-[#FEF2F2] text-[#EF1B24]'
                      : 'bg-[#FFFBEB] text-[#D97706]'
                  }`}
                >
                  <CheckCircle2 className="w-3 h-3" />
                  <span>{inspectedPoint.quality}</span>
                </span>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Reason Code</div>
                <div className="font-mono text-[#334155]">{inspectedPoint.reasonCode || 'NORMAL'}</div>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Record Origin</div>
                <span className="font-mono text-[11px] px-1.5 py-0.5 bg-[#F1F5FA] rounded text-[#334568]">
                  {inspectedPoint.recordKind}
                </span>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Fidelity Semantics</div>
                <div className="text-[#334568]">
                  {inspectedPoint.virtual ? 'Virtual Step (Reconstructed Timeline)' : 'Exact Ingested Observation'}
                </div>
              </div>

              <div>
                <div className="text-[#657794] text-[11px]">Data Epoch</div>
                <div className="font-mono text-[#334568]">{inspectedPoint.dataEpoch}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
