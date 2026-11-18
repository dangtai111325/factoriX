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
  ChevronDown,
  Check,
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
  queryHistorianSeries,
  HistorianSeriesResult,
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

/** Stable token the backend understands for a picked source (signal | model field | subtable). */
function sourceToken(src: SourceRef): string {
  if (src.kind === 'model_field' && src.model_id && src.field_path) return `mod:${src.model_id}:${src.field_path}`;
  if (src.kind === 'subtable' || src.kind === 'resource_context') return src.id.startsWith('subtable:') ? src.id : `subtable:${src.id}`;
  return src.id.startsWith('sig:') ? src.id.slice(4) : src.id;
}

function tokenToSource(token: string, kind?: string | null): SourceRef {
  const t = token.trim();
  if (t.startsWith('mod:')) {
    const [, mid, ...rest] = t.split(':');
    return { id: t, kind: 'model_field', model_id: mid, field_path: rest.join(':'), display_name: rest.join(':'), path: t, status: 'ACTIVE' };
  }
  if (t.startsWith('subtable:') || kind === 'subtable') {
    const id = t.startsWith('subtable:') ? t : `subtable:${t}`;
    return { id, kind: 'subtable', display_name: id.split('.').pop() || id, path: id, status: 'ACTIVE' };
  }
  const id = t.startsWith('sig:') ? t.slice(4) : t;
  return { id, kind: 'signal', display_name: id, path: id, status: 'ACTIVE' };
}

const PRESETS: Record<string, number> = { '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

export const HistorianExplorerPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Active view tab: 'trend' | 'records' | 'events' | 'exports'
  const [activeTab, setActiveTab] = useState<'trend' | 'records' | 'events' | 'exports'>('trend');

  // Mode: recorded (strict raw events) vs reconstructed (interpolated timeline) vs operational
  const [mode, setMode] = useState<HistorianMode>(() => {
    const m = searchParams.get('mode');
    return m === 'recorded' || m === 'reconstructed' ? m : 'operational';
  });

  // Time range preset (a deep link without range starts at 15 minutes, plan §8.3)
  const [timePreset, setTimePreset] = useState<TimeRangePreset>(() => {
    const r = searchParams.get('range');
    if (r && r in PRESETS) return r as TimeRangePreset;
    return searchParams.get('source_id') || searchParams.get('signalId') || searchParams.get('signal_id') || searchParams.get('sources') ? '15m' : '1h';
  });
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<{ downsampled: boolean; notes: string[]; available: boolean }>({ downsampled: false, notes: [], available: true });

  // Computed start/end in ms
  const [timeRange, setTimeRange] = useState(() => {
    const end = Date.now();
    return { startMs: end - 3600 * 1000, endMs: end };
  });

  // Source picker on left
  const [pickerView, setPickerView] = useState<SourceView | 'tables'>('hierarchy');
  const [searchQuery, setSearchQuery] = useState('');
  const [sourcesList, setSourcesList] = useState<SourceRef[]>([]);
  const [groupsList, setGroupsList] = useState<
    { id: string; name: string; protocol?: string; signals: SourceRef[]; signals_count: number }[]
  >([]);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [tablesList, setTablesList] = useState<TDSubtable[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [sourcesError, setSourcesError] = useState<unknown | null>(null);

  const toggleGroupExpand = (groupId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

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
          setGroupsList([]);
          setSourcesList([]);
        })
        .catch((err) => {
          console.error('Failed to list subtables for Historian:', err);
          setSourcesError(err);
          setTablesList([]);
          setGroupsList([]);
          setSourcesList([]);
        })
        .finally(() => setLoadingSources(false));
    } else {
      getSources({ view: pickerView, search: searchQuery || undefined })
        .then((res: any) => {
          const rawItems = res?.items || [];
          const leaves: SourceRef[] = res?.leaves || res?.sources || [];
          if (rawItems.length > 0 && (rawItems[0].signals || rawItems[0].fields)) {
            const normalizedGroups = rawItems.map((g: any) => ({
              id: String(g.id),
              name: String(g.display_name || g.name || 'Unnamed Group'),
              protocol: g.protocol,
              signals: (g.signals || g.fields || []) as SourceRef[],
              signals_count: (g.signals || g.fields || []).length,
            }));
            setGroupsList(normalizedGroups);
            const autoExpand = new Set<string>(
              searchQuery
                ? normalizedGroups.map((g: any) => g.id)
                : normalizedGroups.slice(0, 4).map((g: any) => g.id)
            );
            setExpandedGroupIds(autoExpand);
          } else {
            setGroupsList([]);
          }
          setSourcesList(leaves.length > 0 ? leaves : rawItems);
          setTablesList([]);
        })
        .catch((err) => {
          console.error('Failed to get sources for Historian:', err);
          setSourcesError(err);
          setGroupsList([]);
          setSourcesList([]);
        })
        .finally(() => setLoadingSources(false));
    }
  }, [pickerView, searchQuery]);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  // Deep links: ?source_id=<id>&kind=signal|model_field|subtable, legacy ?signalId= / ?signal_id=,
  // and ?sources=<token>,<token> (the selection is kept in the URL so Back/refresh restore it).
  useEffect(() => {
    if (selectedSeries.length > 0) return;
    const many = searchParams.get('sources');
    const one = searchParams.get('source_id') || searchParams.get('signalId') || searchParams.get('signal_id');
    const tokens = many ? many.split(',').filter(Boolean) : one ? [one] : [];
    if (tokens.length) setSelectedSeries(tokens.slice(0, MAX_SELECTED_SERIES).map((t) => tokenToSource(t, searchParams.get('kind'))));
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    ['source_id', 'signalId', 'signal_id', 'kind'].forEach((k) => next.delete(k));
    if (selectedSeries.length) next.set('sources', selectedSeries.map(sourceToken).join(','));
    else next.delete('sources');
    next.set('range', timePreset);
    next.set('mode', mode);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [selectedSeries, timePreset, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load trend/record data for selected series - strictly real queries, NO Math.sin fallback!
  // Re-query only when the SET of series changes (label updates from the backend must not refetch).
  const selectionKey = selectedSeries.map(sourceToken).join(',');
  const selectedRef = React.useRef(selectedSeries);
  selectedRef.current = selectedSeries;
  const fetchData = useCallback(async () => {
    const selectedSeries = selectedRef.current;
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

      const res = await queryHistorianSeries({
        sources: selectedSeries.map(sourceToken),
        start: fromTs,
        end: toTs,
        mode,
        resolution: 'auto',
        max_points: 1500,
      });
      const byKey = new Map<string, HistorianSeriesResult>(res.series_list.map((sr) => [sr.series_key, sr]));
      setCoverage({ downsampled: res.downsampled, notes: res.coverage_notes || [], available: res.history_available });
      // Show the backend's real display names (a deep link only knows the id).
      setSelectedSeries((prev) => {
        let changed = false;
        const next = prev.map((p) => {
          const sr = byKey.get(sourceToken(p));
          if (sr && sr.display_name && sr.display_name !== p.display_name) { changed = true; return { ...p, display_name: sr.display_name, unit: sr.unit ?? p.unit, data_type: sr.value_type ?? p.data_type }; }
          return p;
        });
        return changed ? next : prev;
      });

      for (let i = 0; i < selectedSeries.length; i++) {
        const src = selectedSeries[i];
        const color = SERIES_COLORS[i % SERIES_COLORS.length];
        const sr = byKey.get(sourceToken(src));
        const label = sr?.display_name || src.display_name;
        const rows = sr?.points || [];
        const points: HistorianPoint[] = rows.map((r, pIdx) => {
          const rawVal = r.value;
          const numVal = typeof rawVal === 'number' ? rawVal : typeof rawVal === 'boolean' ? (rawVal ? 1 : 0) : null;
          const tMs = new Date(r.ts).getTime();
          const parsedValue: string | number | boolean | null =
            typeof rawVal === 'number' || typeof rawVal === 'string' || typeof rawVal === 'boolean' ? rawVal : rawVal != null ? JSON.stringify(rawVal) : null;
          // Quality is shown only when the storage has it; never defaulted to GOOD (P2).
          const q = String(r.quality || '').toUpperCase();
          return {
            id: `${src.id}-${tMs}-${pIdx}`,
            eventUid: r.event_uid || r.id,
            signalId: src.id,
            signalName: label,
            timestampMs: tMs,
            eventTime: r.ts,
            acquiredAt: r.ts,
            sourceTime: r.source_time || r.ts,
            valueType: sr?.value_type || src.data_type || 'FLOAT64',
            value: parsedValue,
            numericValue: numVal,
            unit: sr?.unit || src.unit || '',
            quality: q || 'UNKNOWN',
            reasonCode: r.reason_code || null,
            recordKind: r.record_kind,
            virtual: !!r.virtual,
            dataEpoch: Number(r.data_epoch ?? 1),
          };
        });

        const qualitySegments: QualitySegment[] = [];
        const known = points.filter((p) => ['GOOD', 'BAD', 'UNCERTAIN', 'STALE'].includes(String(p.quality)));
        if (known.length > 0) {
          let segStart = known[0].timestampMs;
          let currentQual = known[0].quality as QualitySegment['quality'];
          for (let pIdx = 1; pIdx < known.length; pIdx++) {
            const nextQual = known[pIdx].quality as QualitySegment['quality'];
            if (nextQual !== currentQual) {
              qualitySegments.push({ startMs: segStart, endMs: known[pIdx].timestampMs, quality: currentQual });
              segStart = known[pIdx].timestampMs;
              currentQual = nextQual;
            }
          }
          qualitySegments.push({ startMs: segStart, endMs: known[known.length - 1].timestampMs, quality: currentQual });
        }

        const st = sr?.stats;
        const stats: SeriesStats = {
          signalId: src.id,
          signalName: label,
          unit: sr?.unit || src.unit || '',
          color,
          isDiscrete: false,
          last: points.length > 0 ? points[points.length - 1].value : null,
          min: st?.min ?? null,
          max: st?.max ?? null,
          avg: st?.avg != null ? Number(st.avg.toFixed(3)) : null,
          samples: st?.count ?? points.length,
          goodPct: st?.good_pct ?? (null as unknown as number),
          fidelityMode: mode,
        };

        const signalShim: SignalItem = {
          id: src.id,
          name: label,
          tag: src.path,
          display_name: label,
          displayName: label,
          sourceConnectionId: src.connection_id || '',
          sourceConnectionName: src.connection_name || '',
          resourceId: src.resource_id || src.id,
          resourcePath: src.path,
          dataType: ((sr?.value_type || src.data_type) as any) || 'FLOAT64',
          data_type: sr?.value_type || src.data_type || 'FLOAT64',
          unit: sr?.unit || src.unit || undefined,
          quality: (points.length > 0 ? points[points.length - 1].quality : 'UNKNOWN') as any,
          lastUpdated: points.length > 0 ? points[points.length - 1].eventTime : '',
          sampleIntervalMs: sr?.bucket_ms || 1000,
        };

        const notes = [...(sr?.coverage_notes || [])];
        if (sr?.downsampled) notes.unshift(`Downsampled: ${sr.total.toLocaleString()} rows shown as ${points.length} buckets of ${Math.round((sr.bucket_ms || 0) / 1000)} s (avg; min/max per bucket).`);
        if (sr?.truncated) notes.unshift(`Showing the most recent ${points.length} of ${sr.total.toLocaleString()} rows; narrow the range for all rows.`);
        if (sr && sr.status !== 'OK') notes.push(sr.status === 'NO_DATA' ? 'No data in this window.' : `Status: ${sr.status}`);

        newSeriesList.push({ signal: signalShim, color, isDiscrete: false, points, qualitySegments, stats, fidelity: mode, coverageNotes: notes });

        allRows.push(...rows.map((r) => ({ ...r, series_name: label } as unknown as HistorianRow)));

        for (let pIdx = 1; pIdx < known.length; pIdx++) {
          if (known[pIdx].quality !== known[pIdx - 1].quality) {
            extractedEvents.push({
              id: `evt-${src.id}-${known[pIdx].timestampMs}`,
              timestampMs: known[pIdx].timestampMs,
              timestamp: known[pIdx].eventTime,
              kind: 'QUALITY_TRANSITION',
              signalId: src.id,
              signalName: label,
              fromQuality: String(known[pIdx - 1].quality),
              toQuality: String(known[pIdx].quality),
              summary: `Quality changed from ${known[pIdx - 1].quality} to ${known[pIdx].quality}`,
            });
          }
        }
      }

      setSeriesData(newSeriesList);
      allRows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      setRecordsRows(allRows);
      setRecordsTotal(res.series_list.reduce((acc, sr) => acc + (sr.total || 0), 0));
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
  }, [selectionKey, timeRange, mode]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const job = await createExportJob({
        sources: selectedSeries.map(sourceToken),
        from_ts: new Date(timeRange.startMs).toISOString(),
        to_ts: new Date(timeRange.endMs).toISOString(),
        start: new Date(timeRange.startMs).toISOString(),
        end: new Date(timeRange.endMs).toISOString(),
        mode,
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
      if (selectedSeries.length >= MAX_SELECTED_SERIES) {
        setSelectionNotice(`At most ${MAX_SELECTED_SERIES} series can be shown at once. Remove one first.`);
        return;
      }
      setSelectionNotice(null);
      setSelectedSeries([...selectedSeries, src]);
    }
  };

  const handleToggleTable = (table: TDSubtable) => {
    const exists = selectedSeries.some((s) => s.id === `subtable:${table.id}`);
    if (exists) {
      setSelectedSeries(selectedSeries.filter((s) => s.id !== `subtable:${table.id}`));
    } else {
      if (selectedSeries.length >= MAX_SELECTED_SERIES) {
        setSelectionNotice(`At most ${MAX_SELECTED_SERIES} series can be shown at once. Remove one first.`);
        return;
      }
      const srcRef: SourceRef = {
        id: `subtable:${table.id}`,
        kind: 'subtable',
        display_name: table.display_name || table.physical_name,
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-[#111B37]">Historian</h1>
          <p className="text-[13px] text-[#657794]">Explore time-series values, state changes and stored records.</p>
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

      {(selectionNotice || !coverage.available || coverage.downsampled || coverage.notes.length > 0) && (
        <div className="space-y-1.5">
          {selectionNotice && (
            <div role="status" className="px-3 py-2 rounded-lg border border-[#FFE2B3] bg-[#FFF6E5] text-[12px] text-[#334568] flex items-center justify-between gap-2">
              <span>{selectionNotice}</span>
              <button type="button" onClick={() => setSelectionNotice(null)} aria-label="Dismiss" className="text-[#657794]"><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
          {!coverage.available && (
            <div className="px-3 py-2 rounded-lg border border-[#FAC6C9] bg-[#FFF0F1] text-[12px] text-[#334568]">
              Time-series storage is not configured; only PostgreSQL observations can be shown.
            </div>
          )}
          {(coverage.downsampled || coverage.notes.length > 0) && (
            <div className="px-3 py-2 rounded-lg border border-[#E3EAF3] bg-white text-[12px] text-[#334568] space-y-0.5">
              {coverage.downsampled && <div>Long range: values are aggregated per time bucket on the server (average, with min/max per bucket).</div>}
              {[...new Set(coverage.notes)].slice(0, 6).map((n) => <div key={n} className="text-[#657794]">{n}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Main split layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Source Picker (col-span-3) */}
        <div className="lg:col-span-3 bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-3 flex flex-col space-y-3 max-h-[360px] lg:max-h-none lg:min-h-[680px]">
          <div>
            <div className="text-[11px] font-bold text-[#657794] uppercase tracking-wider mb-2">
              Select Series
            </div>

            {/* Picker tabs: Hierarchy | Collector | Models | Tables */}
            <div className="grid grid-cols-4 gap-1 bg-[#F1F5FA] p-1 rounded-lg text-[11px] font-semibold">
              <button
                type="button"
                onClick={() => setPickerView('hierarchy')}
                className={`py-1 px-1 rounded text-center truncate whitespace-nowrap transition-all ${
                  pickerView === 'hierarchy' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
                }`}
                title="Hierarchy Tree"
              >
                Tree
              </button>
              <button
                type="button"
                onClick={() => setPickerView('collector')}
                className={`py-1 px-1 rounded text-center truncate whitespace-nowrap transition-all ${
                  pickerView === 'collector' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
                }`}
                title="Collector Connections"
              >
                Conn
              </button>
              <button
                type="button"
                onClick={() => setPickerView('models')}
                className={`py-1 px-1 rounded text-center truncate whitespace-nowrap transition-all ${
                  pickerView === 'models' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
                }`}
                title="Data Models"
              >
                Models
              </button>
              <button
                type="button"
                onClick={() => setPickerView('tables')}
                className={`py-1 px-1 rounded text-center truncate whitespace-nowrap transition-all ${
                  pickerView === 'tables' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
                }`}
                title="Physical Subtables"
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
                  const isSelected = selectedSeries.some((s) => s.id === `subtable:${tbl.id}`);
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
            ) : groupsList.length > 0 ? (
              groupsList.map((grp) => {
                const isExpanded = expandedGroupIds.has(grp.id);
                return (
                  <div key={grp.id} className="border border-[#E3EAF3] rounded-lg overflow-hidden bg-white mb-1.5 shadow-2xs">
                    <button
                      type="button"
                      onClick={() => toggleGroupExpand(grp.id)}
                      className="w-full px-2.5 py-1.5 flex items-center justify-between bg-[#F8FAFC] hover:bg-[#F1F5FA] text-left transition-colors"
                    >
                      <div className="flex items-center gap-1.5 min-w-0 pr-1">
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-[#657794] shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-[#657794] shrink-0" />
                        )}
                        <span className="text-[12px] font-semibold text-[#111B37] truncate" title={grp.name}>
                          {grp.name}
                        </span>
                        {grp.protocol && (
                          <span className="text-[9px] uppercase px-1 py-0.2 bg-[#E2E8F0] text-[#475569] rounded font-mono">
                            {grp.protocol}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-semibold text-[#657794] bg-white px-1.5 py-0.5 rounded border border-[#E3EAF3] shrink-0">
                        {grp.signals_count}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="p-1 space-y-1 divide-y divide-[#F8FAFC]">
                        {grp.signals.length === 0 ? (
                          <div className="py-2 text-center text-[#94A3B8] text-[11px] italic">
                            No signals in this group
                          </div>
                        ) : (
                          grp.signals.map((sig: SourceRef) => {
                            const isSelected = selectedSeries.some((s) => s.id === sig.id);
                            return (
                              <div
                                key={sig.id}
                                onClick={() => handleToggleSource(sig)}
                                className={`p-1.5 rounded-md text-[11px] cursor-pointer transition-all flex items-center justify-between gap-1.5 ${
                                  isSelected
                                    ? 'border border-[#EF1B24] bg-[#FEF2F2] font-semibold text-[#EF1B24]'
                                    : 'hover:bg-[#F8FAFC] text-[#334155]'
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium" title={sig.display_name || sig.path}>
                                    {(sig as any).key || (sig as any).name || sig.display_name?.split('/').pop()?.trim() || sig.display_name}
                                  </div>
                                  <div className="text-[9px] text-[#94A3B8] font-mono truncate">
                                    {sig.data_type || 'float64'}{sig.unit ? ` · ${sig.unit}` : ''}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                      typeof navigator !== 'undefined' && !navigator.onLine
                                        ? 'bg-[#CBD5E1]'
                                        : (sig.quality || '').includes('BAD')
                                        ? 'bg-[#F2343B]'
                                        : (sig.quality || '').includes('GOOD') && sig.freshness === 'FRESH'
                                        ? 'bg-[#0DBA67]'
                                        : sig.freshness === 'STALE'
                                        ? 'bg-[#FFAA23]'
                                        : 'bg-[#CBD5E1]'
                                    }`}
                                    title={`${sig.quality || 'UNKNOWN'}${sig.freshness ? ` · ${sig.freshness}` : ''}`}
                                  />
                                  {isSelected && <Check className="w-3.5 h-3.5 text-[#EF1B24]" />}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })
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
                    className={`p-2 rounded-lg border text-[12px] cursor-pointer transition-all ${
                      isSelected
                        ? 'border-[#EF1B24] bg-[#FEF2F2] font-semibold text-[#EF1B24]'
                        : 'border-[#E3EAF3] bg-white hover:border-[#CBD5E1] text-[#334155]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate">{src.display_name || (src as any).name}</span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-[#EF1B24] shrink-0" />}
                    </div>
                    <div className="text-[10px] text-[#94A3B8] truncate mt-0.5">{src.path || src.display_name}</div>
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
        <div className="lg:col-span-9 space-y-4 min-w-0">
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
                  <span>{coverage.downsampled ? 'Long ranges are aggregated server-side; narrow the range to see every stored row.' : 'Stored rows, newest first.'}</span>
                  <span>Rows in window: {recordsTotal.toLocaleString()}</span>
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
                          <th className="py-2.5 px-3">Time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</th>
                          <th className="py-2.5 px-3">Series</th>
                          <th className="py-2.5 px-3">Value</th>
                          <th className="py-2.5 px-3">Quality</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5FA]">
                        {recordsRows.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-12 text-center text-[#657794]">
                              No records found for the selected time range.
                            </td>
                          </tr>
                        ) : (
                          recordsRows.map((row, idx) => {
                            const rawQual = row.quality ? String(row.quality).toUpperCase() : '—';
                            const isGood = rawQual.includes('GOOD');
                            const isBad = rawQual.includes('BAD');

                            return (
                              <tr key={idx} className="hover:bg-[#F8FAFC]">
                                <td className="py-2 px-3 text-[#111B37] whitespace-nowrap" title={String(row.ts)}>{new Date(String(row.ts)).toLocaleString()}</td>
                                <td className="py-2 px-3 text-[#334568] whitespace-nowrap">{String((row as Record<string, unknown>).series_name || '')}</td>
                                <td className="py-2 px-3 text-[#111B37] font-semibold whitespace-nowrap">
                                  {(row as Record<string, unknown>).value === null || (row as Record<string, unknown>).value === undefined
                                    ? 'null'
                                    : typeof (row as Record<string, unknown>).value === 'object'
                                    ? JSON.stringify((row as Record<string, unknown>).value)
                                    : String((row as Record<string, unknown>).value)}
                                  {String(row.record_kind || '') === 'AGGREGATE' && <span className="ml-1 text-[10px] text-[#657794]">avg</span>}
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
