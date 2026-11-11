import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Filter,
  FolderTree,
  Info,
  Layers,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Table as TableIcon,
  Trash2,
  X,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { Button } from '../../components/common/Button';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { formatTimestamp, formatValue, normalizeQuality } from '../../lib/format';
import { PROTOCOL_LABEL } from '../../lib/protocols';
import { useApp } from '../../store/AppContext';
import { SignalItem } from '../../types';
import { HistorianTrendChart } from './HistorianTrendChart';
import {
  AGG_OPTIONS,
  AggregationFn,
  BUCKET_OPTIONS,
  BucketResolution,
  buildQualitySegments,
  buildTdengineSqlPreview,
  computeSeriesStats,
  HISTORIAN_MODES,
  HistorianEventItem,
  HistorianExportJob,
  HistorianMode,
  HistorianPoint,
  HistorianSeriesData,
  HistorianTab,
  isDiscreteSignal,
  MAX_SELECTED_SERIES,
  PublishedDatasetItem,
  resolveBucketMs,
  SavedHistorianView,
  SERIES_COLORS,
  TIME_RANGE_PRESETS,
  TimeAxisMode,
  TimeRangePreset,
} from './types';

function toLocalDatetimeInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizeCsvField(raw: unknown): string {
  const str = raw === null || raw === undefined ? '' : String(raw);
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export const HistorianExplorerPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signals, resources, connections } = useApp();
  const { toast, show, dismiss } = useActionToast();

  // Top sub-nav tab state
  const initialTab = (searchParams.get('tab') as HistorianTab) || 'trend';
  const [activeTab, setActiveTab] = useState<HistorianTab>(
    ['trend', 'query', 'views', 'exports'].includes(initialTab) ? initialTab : 'trend',
  );

  // Mode, Time Range, Bucket, Aggregation, Time Axis
  const [mode, setMode] = useState<HistorianMode>(() => {
    const m = (searchParams.get('mode') || '').toLowerCase();
    if (m === 'recorded' || m === 'reconstructed' || m === 'operational') return m;
    return 'operational';
  });

  const [rangePreset, setRangePreset] = useState<TimeRangePreset>(() => {
    const r = (searchParams.get('range') || '').toLowerCase() as TimeRangePreset;
    if (['5m', '15m', '1h', '6h', '24h', '7d', 'custom'].includes(r)) return r;
    return '15m';
  });

  const [customStartInput, setCustomStartInput] = useState<string>(() =>
    toLocalDatetimeInputValue(Date.now() - 15 * 60 * 1000),
  );
  const [customEndInput, setCustomEndInput] = useState<string>(() =>
    toLocalDatetimeInputValue(Date.now()),
  );
  const [timezoneMode, setTimezoneMode] = useState<'local' | 'utc'>('local');
  const [bucket, setBucket] = useState<BucketResolution>('auto');
  const [agg, setAgg] = useState<AggregationFn>('avg');
  const [timeAxis, setTimeAxis] = useState<TimeAxisMode>('acquired_at');
  const [qualityFilter, setQualityFilter] = useState<string>('ALL');

  // Series & Dataset selection state
  const [selectedSignalIds, setSelectedSignalIds] = useState<string[]>(() => {
    const single = searchParams.get('signalId') || searchParams.get('signal_id');
    const multi = searchParams.get('signalIds') || searchParams.get('signal_ids');
    const list: string[] = [];
    if (single) list.push(single);
    if (multi) {
      multi
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((id) => {
          if (!list.includes(id)) list.push(id);
        });
    }
    return list.slice(0, MAX_SELECTED_SERIES);
  });

  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(
    () => searchParams.get('designId') || searchParams.get('design_id') || null,
  );
  const [selectedDatasetKey, setSelectedDatasetKey] = useState<string | null>(
    () => searchParams.get('dataset') || searchParams.get('datasetId') || null,
  );

  // Left Picker UI states
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerGroupBy, setPickerGroupBy] = useState<'resource' | 'protocol' | 'dataset'>('resource');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [datasets, setDatasets] = useState<PublishedDatasetItem[]>([]);

  // Query & Trend Data States
  const [seriesList, setSeriesList] = useState<HistorianSeriesData[]>([]);
  const [events, setEvents] = useState<HistorianEventItem[]>([]);
  const [loadingQuery, setLoadingQuery] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [hiddenSignalIds, setHiddenSignalIds] = useState<Set<string>>(new Set());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inspectedPoint, setInspectedPoint] = useState<HistorianPoint | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Query Workspace specific states
  const [workspaceLimit, setWorkspaceLimit] = useState<number>(250);
  const [workspaceRows, setWorkspaceRows] = useState<HistorianPoint[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceSql, setWorkspaceSql] = useState<string>('');

  // Saved Views state
  const [savedViews, setSavedViews] = useState<SavedHistorianView[]>([]);
  const [loadingViews, setLoadingViews] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [newViewDesc, setNewViewDesc] = useState('');
  const [newViewDefault, setNewViewDefault] = useState(false);
  const [savingView, setSavingView] = useState(false);

  // Exports & Jobs state
  const [exportJobs, setExportJobs] = useState<HistorianExportJob[]>([]);
  const [loadingExports, setLoadingExports] = useState(false);
  const [creatingExport, setCreatingExport] = useState(false);

  const signalById = useMemo(() => {
    const m = new Map<string, SignalItem>();
    signals.forEach((s) => m.set(s.id, s));
    return m;
  }, [signals]);

  const resourceNameById = useMemo(() => {
    const m = new Map<string, string>();
    resources.forEach((r) => m.set(r.id, r.name || r.code || r.id));
    return m;
  }, [resources]);

  const connectionProtocolById = useMemo(() => {
    const m = new Map<string, string>();
    connections.forEach((c) => m.set(c.id, c.protocol || 'http'));
    return m;
  }, [connections]);

  // Load published storage designs & datasets for Dataset Picker
  useEffect(() => {
    let active = true;
    const loadDatasets = async () => {
      try {
        const res = await api<{ items?: Array<Record<string, unknown>> }>('/api/v1/storage/designs');
        if (!active) return;
        const items = Array.isArray(res?.items) ? res.items : [];
        const extracted: PublishedDatasetItem[] = [];
        for (const d of items) {
          const designId = String(d.id || '');
          const designName = String(d.name || 'Storage Design');
          const designStatus = String(d.status || 'DRAFT').toUpperCase();
          const dsArr = Array.isArray(d.datasets) ? (d.datasets as Array<Record<string, unknown>>) : [];
          if (dsArr.length > 0) {
            for (const ds of dsArr) {
              const bindings = Array.isArray(ds.fields || ds.field_bindings)
                ? ((ds.fields || ds.field_bindings) as Array<Record<string, unknown>>)
                : [];
              const sigIds = bindings
                .map((b) => String(b.signal_id || b.signalId || ''))
                .filter(Boolean);
              extracted.push({
                id: String(ds.id || `${designId}:${ds.dataset_key || ds.key || 'ds'}`),
                datasetKey: String(ds.dataset_key || ds.key || ds.name || 'dataset'),
                displayName: String(ds.display_name || ds.name || ds.dataset_key || designName),
                designId,
                designName,
                designStatus,
                recordingMode: String(ds.recording_mode || ds.mode || d.recording_mode || 'ON_CHANGE'),
                signalIds: sigIds,
              });
            }
          } else {
            extracted.push({
              id: designId,
              datasetKey: String(d.dataset_key || designName.toLowerCase().replace(/[^a-z0-9]+/g, '_')),
              displayName: designName,
              designId,
              designName,
              designStatus,
              recordingMode: String(d.recording_mode || d.mode || 'ON_CHANGE'),
              signalIds: Array.isArray(d.signal_ids) ? (d.signal_ids as string[]) : [],
            });
          }
        }
        setDatasets(extracted);
      } catch {
        // Storage designs endpoint optional during initial mount
      }
    };
    void loadDatasets();
    return () => {
      active = false;
    };
  }, []);

  // Synchronize URL deep-link parameters on mount or when searchParams change externally
  const appliedDeepLinkRef = useRef<string>('');
  useEffect(() => {
    const key = searchParams.toString();
    if (key === appliedDeepLinkRef.current) return;
    appliedDeepLinkRef.current = key;

    const paramSignalId = searchParams.get('signalId') || searchParams.get('signal_id');
    const paramSignalIds = searchParams.get('signalIds') || searchParams.get('signal_ids');
    const paramDesignId = searchParams.get('designId') || searchParams.get('design_id');
    const paramDataset = searchParams.get('dataset') || searchParams.get('datasetId');
    const paramMode = (searchParams.get('mode') || '').toLowerCase();
    const paramRange = (searchParams.get('range') || '').toLowerCase() as TimeRangePreset;
    const paramTab = (searchParams.get('tab') || '').toLowerCase() as HistorianTab;

    if (paramTab && ['trend', 'query', 'views', 'exports'].includes(paramTab)) {
      setActiveTab(paramTab);
    }
    if (paramMode === 'operational' || paramMode === 'recorded' || paramMode === 'reconstructed') {
      setMode(paramMode);
    }
    if (['5m', '15m', '1h', '6h', '24h', '7d', 'custom'].includes(paramRange)) {
      setRangePreset(paramRange);
    }
    if (paramDesignId) setSelectedDesignId(paramDesignId);
    if (paramDataset) setSelectedDatasetKey(paramDataset);

    const nextIds: string[] = [];
    if (paramSignalId) nextIds.push(paramSignalId);
    if (paramSignalIds) {
      paramSignalIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((id) => {
          if (!nextIds.includes(id)) nextIds.push(id);
        });
    }
    if (nextIds.length > 0) {
      setSelectedSignalIds(nextIds.slice(0, MAX_SELECTED_SERIES));
    }
  }, [searchParams]);

  // If dataset or designId is deep-linked and no signalIds are explicitly chosen yet, auto-bind dataset signals or first available signals
  useEffect(() => {
    if (selectedSignalIds.length > 0 || signals.length === 0) return;

    if (selectedDatasetKey || selectedDesignId) {
      const match = datasets.find(
        (ds) =>
          ds.id === selectedDatasetKey ||
          ds.datasetKey === selectedDatasetKey ||
          ds.designId === selectedDesignId,
      );
      if (match && match.signalIds.length > 0) {
        setSelectedSignalIds(match.signalIds.slice(0, MAX_SELECTED_SERIES));
        return;
      }
    }

    // Default initial selection: pick first 2 signals so the chart is immediately populated on mount
    setSelectedSignalIds(signals.slice(0, 2).map((s) => s.id));
  }, [signals, datasets, selectedDatasetKey, selectedDesignId, selectedSignalIds.length]);

  // Compute startMs and endMs for current time range
  const { startMs, endMs, startIso, endIso } = useMemo(() => {
    if (rangePreset === 'custom') {
      const s = Date.parse(customStartInput);
      const e = Date.parse(customEndInput);
      const validS = Number.isFinite(s) ? s : Date.now() - 15 * 60 * 1000;
      const validE = Number.isFinite(e) && e > validS ? e : validS + 15 * 60 * 1000;
      return {
        startMs: validS,
        endMs: validE,
        startIso: new Date(validS).toISOString(),
        endIso: new Date(validE).toISOString(),
      };
    }
    const preset = TIME_RANGE_PRESETS.find((p) => p.id === rangePreset) || TIME_RANGE_PRESETS[1];
    const now = Date.now();
    const s = now - preset.ms;
    return {
      startMs: s,
      endMs: now,
      startIso: new Date(s).toISOString(),
      endIso: new Date(now).toISOString(),
    };
  }, [rangePreset, customStartInput, customEndInput, refreshTick]);

  // Normalize a raw point from either `/api/v1/historian/query` or `/api/v1/observations/history`
  const normalizePoint = useCallback(
    (raw: Record<string, unknown>, fallbackSig: SignalItem, idx: number): HistorianPoint => {
      const evTimeStr = String(
        raw.event_time || raw.ts || raw.timestamp || raw.acquired_at || raw.received_time || raw.source_time || new Date().toISOString(),
      );
      const acqTimeStr = String(raw.acquired_at || raw.received_time || evTimeStr);
      const srcTimeStr = raw.source_time ? String(raw.source_time) : null;
      const tsMs = Date.parse(timeAxis === 'source_time' && srcTimeStr ? srcTimeStr : evTimeStr) || Date.now();
      const val = (raw.value !== undefined ? raw.value : raw.val) as number | string | boolean | null;
      const numVal =
        typeof val === 'number' && Number.isFinite(val)
          ? val
          : typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val))
            ? Number(val)
            : null;
      const quality = normalizeQuality(raw.quality ?? raw.raw_quality ?? 'GOOD');

      return {
        id: String(raw.id || `${fallbackSig.id}:${tsMs}:${idx}`),
        eventUid: String(raw.event_uid || raw.eventUid || `uid-${tsMs}-${idx}`),
        signalId: String(raw.signal_id || raw.signalId || fallbackSig.id),
        signalName:
          fallbackSig.displayName || fallbackSig.name || fallbackSig.key || fallbackSig.id,
        timestampMs: tsMs,
        eventTime: evTimeStr,
        acquiredAt: acqTimeStr,
        sourceTime: srcTimeStr,
        valueType: String(raw.value_type || raw.valueType || fallbackSig.dataType || 'float64'),
        value: val,
        numericValue: numVal,
        unit: String(raw.unit ?? fallbackSig.unit ?? ''),
        quality,
        reasonCode: raw.reason_code ? String(raw.reason_code) : null,
        recordKind: String(
          raw.record_kind ||
            raw.recordKind ||
            (mode === 'reconstructed'
              ? 'RECONSTRUCTED_STEP'
              : mode === 'recorded'
                ? 'MANAGED_RECORDED'
                : 'RAW_OPERATIONAL'),
        ),
        virtual: Boolean(raw.virtual || raw.is_virtual || raw.record_kind === 'RECONSTRUCTED_STEP'),
        dataEpoch: Number(raw.data_epoch ?? raw.dataEpoch ?? 1),
        datasetId: raw.dataset_id ? String(raw.dataset_id) : null,
      };
    },
    [mode, timeAxis],
  );

  // Execute multi-series Historian Query
  const executeHistorianQuery = useCallback(
    async (cursorParam?: string | null) => {
      if (selectedSignalIds.length === 0) {
        setSeriesList([]);
        setEvents([]);
        setNextCursor(null);
        return;
      }

      if (cursorParam) setLoadingMore(true);
      else setLoadingQuery(true);
      setQueryError(null);

      const effBucketMs = resolveBucketMs(bucket, Math.max(1000, endMs - startMs));

      try {
        let builtSeries: HistorianSeriesData[] = [];
        let cursorOut: string | null = null;

        try {
          // Primary S12 endpoint: POST /api/v1/historian/query
          const res = await api<Record<string, unknown>>('/api/v1/historian/query', {
            method: 'POST',
            body: JSON.stringify({
              signal_ids: selectedSignalIds,
              design_id: selectedDesignId || undefined,
              dataset_id: selectedDatasetKey || undefined,
              mode,
              start: startIso,
              end: endIso,
              time_axis: timeAxis,
              quality: qualityFilter !== 'ALL' ? qualityFilter : undefined,
              bucket_ms: effBucketMs || undefined,
              agg: effBucketMs ? agg : undefined,
              limit: 400,
              cursor: cursorParam || undefined,
            }),
          });

          cursorOut = typeof res.next_cursor === 'string' ? res.next_cursor : null;
          const rawSeriesArr = Array.isArray(res.series)
            ? (res.series as Array<Record<string, unknown>>)
            : [];
          const flatItems = Array.isArray(res.items)
            ? (res.items as Array<Record<string, unknown>>)
            : [];

          if (rawSeriesArr.length > 0) {
            builtSeries = selectedSignalIds.map((sigId, idx) => {
              const sig =
                signalById.get(sigId) ||
                ({
                  id: sigId,
                  name: sigId,
                  tag: sigId,
                  sourceConnectionId: '',
                  sourceConnectionName: '',
                  resourceId: '',
                  resourcePath: '',
                  dataType: 'analog',
                  quality: 'GOOD',
                  lastUpdated: '',
                  sampleIntervalMs: 1000,
                } as SignalItem);
              const color = SERIES_COLORS[idx % SERIES_COLORS.length];
              const match =
                rawSeriesArr.find(
                  (s) => String(s.signal_id || s.signalId || '') === sigId,
                ) || {};
              const rawPts = Array.isArray(match.points || match.items)
                ? ((match.points || match.items) as Array<Record<string, unknown>>)
                : [];
              const pts = rawPts
                .map((p, i) => normalizePoint(p, sig, i))
                .filter((p) => qualityFilter === 'ALL' || p.quality === qualityFilter)
                .sort((a, b) => a.timestampMs - b.timestampMs);

              const fidelity = String(
                match.fidelity ||
                  (mode === 'reconstructed'
                    ? 'reconstructed'
                    : mode === 'recorded'
                      ? 'managed_recorded'
                      : 'operational_full'),
              );
              const qSegs = buildQualitySegments(
                pts,
                startMs,
                endMs,
                (sig.expectedIntervalMs || sig.sampleIntervalMs || 2000) * 3,
              );
              const stats = computeSeriesStats(sig, color, pts, fidelity);

              return {
                signal: sig,
                color,
                isDiscrete: isDiscreteSignal(sig, pts[0]?.valueType),
                points: pts,
                qualitySegments: qSegs,
                stats,
                fidelity,
                coverageNotes: Array.isArray(match.coverage_notes)
                  ? (match.coverage_notes as string[])
                  : [],
              };
            });
          } else {
            // Group flat items by signal_id
            builtSeries = selectedSignalIds.map((sigId, idx) => {
              const sig =
                signalById.get(sigId) ||
                ({
                  id: sigId,
                  name: sigId,
                  tag: sigId,
                  sourceConnectionId: '',
                  sourceConnectionName: '',
                  resourceId: '',
                  resourcePath: '',
                  dataType: 'analog',
                  quality: 'GOOD',
                  lastUpdated: '',
                  sampleIntervalMs: 1000,
                } as SignalItem);
              const color = SERIES_COLORS[idx % SERIES_COLORS.length];
              const sigRaw = flatItems.filter(
                (r) => String(r.signal_id || r.signalId || sigId) === sigId,
              );
              const pts = sigRaw
                .map((p, i) => normalizePoint(p, sig, i))
                .filter((p) => qualityFilter === 'ALL' || p.quality === qualityFilter)
                .sort((a, b) => a.timestampMs - b.timestampMs);
              const fidelity =
                mode === 'reconstructed'
                  ? 'reconstructed'
                  : mode === 'recorded'
                    ? 'managed_recorded'
                    : 'operational_full';
              const qSegs = buildQualitySegments(
                pts,
                startMs,
                endMs,
                (sig.expectedIntervalMs || sig.sampleIntervalMs || 2000) * 3,
              );
              const stats = computeSeriesStats(sig, color, pts, fidelity);
              return {
                signal: sig,
                color,
                isDiscrete: isDiscreteSignal(sig, pts[0]?.valueType),
                points: pts,
                qualitySegments: qSegs,
                stats,
                fidelity,
                coverageNotes: [],
              };
            });
          }
        } catch {
          // Fallback to per-signal `/api/v1/observations/history`
          builtSeries = await Promise.all(
            selectedSignalIds.map(async (sigId, idx) => {
              const sig =
                signalById.get(sigId) ||
                ({
                  id: sigId,
                  name: sigId,
                  tag: sigId,
                  sourceConnectionId: '',
                  sourceConnectionName: '',
                  resourceId: '',
                  resourcePath: '',
                  dataType: 'analog',
                  quality: 'GOOD',
                  lastUpdated: '',
                  sampleIntervalMs: 1000,
                } as SignalItem);
              const color = SERIES_COLORS[idx % SERIES_COLORS.length];
              try {
                const q = new URLSearchParams({
                  signal_id: sigId,
                  from: startIso,
                  to: endIso,
                  limit: '300',
                  mode,
                });
                if (selectedDatasetKey) q.set('dataset_id', selectedDatasetKey);
                if (cursorParam) q.set('cursor', cursorParam);
                const res = await api<{
                  items?: Array<Record<string, unknown>>;
                  next_cursor?: string | null;
                  fidelity?: string;
                }>(`/api/v1/observations/history?${q.toString()}`);
                if (res.next_cursor) cursorOut = res.next_cursor;
                const pts = (res.items || [])
                  .map((p, i) => normalizePoint(p, sig, i))
                  .filter((p) => qualityFilter === 'ALL' || p.quality === qualityFilter)
                  .sort((a, b) => a.timestampMs - b.timestampMs);
                const fidelity =
                  res.fidelity ||
                  (mode === 'reconstructed'
                    ? 'reconstructed'
                    : mode === 'recorded'
                      ? 'managed_recorded'
                      : 'operational_full');
                const qSegs = buildQualitySegments(
                  pts,
                  startMs,
                  endMs,
                  (sig.expectedIntervalMs || sig.sampleIntervalMs || 2000) * 3,
                );
                const stats = computeSeriesStats(sig, color, pts, fidelity);
                return {
                  signal: sig,
                  color,
                  isDiscrete: isDiscreteSignal(sig, pts[0]?.valueType),
                  points: pts,
                  qualitySegments: qSegs,
                  stats,
                  fidelity,
                  coverageNotes: [],
                };
              } catch {
                return {
                  signal: sig,
                  color,
                  isDiscrete: isDiscreteSignal(sig),
                  points: [],
                  qualitySegments: [],
                  stats: computeSeriesStats(sig, color, [], mode),
                  fidelity: mode,
                  coverageNotes: [],
                };
              }
            }),
          );
        }

        if (cursorParam) {
          setSeriesList((prev) =>
            builtSeries.map((nextS) => {
              const oldS = prev.find((p) => p.signal.id === nextS.signal.id);
              if (!oldS) return nextS;
              const combined = [...oldS.points, ...nextS.points].sort(
                (a, b) => a.timestampMs - b.timestampMs,
              );
              const qSegs = buildQualitySegments(combined, startMs, endMs);
              const stats = computeSeriesStats(nextS.signal, nextS.color, combined, nextS.fidelity);
              return {
                ...nextS,
                points: combined,
                qualitySegments: qSegs,
                stats,
              };
            }),
          );
        } else {
          setSeriesList(builtSeries);
        }
        setNextCursor(cursorOut);

        // Fetch or derive Synchronized Events & Operations Lane items
        try {
          const evQ = new URLSearchParams({
            signal_ids: selectedSignalIds.join(','),
            start: startIso,
            end: endIso,
          });
          if (selectedDesignId) evQ.set('design_id', selectedDesignId);
          const evRes = await api<{ items?: Array<Record<string, unknown>> }>(
            `/api/v1/historian/events?${evQ.toString()}`,
          );
          const rawEvs = Array.isArray(evRes.items) ? evRes.items : [];
          const mappedEvs: HistorianEventItem[] = rawEvs.map((ev, i) => {
            const tsStr = String(
              ev.timestamp || ev.event_time || ev.occurred_at || ev.created_at || startIso,
            );
            return {
              id: String(ev.id || `ev-${i}`),
              timestampMs: Date.parse(tsStr) || startMs,
              timestamp: tsStr,
              kind: String(ev.kind || ev.event_type || 'QUALITY_TRANSITION'),
              signalId: ev.signal_id ? String(ev.signal_id) : undefined,
              signalName: ev.signal_name ? String(ev.signal_name) : undefined,
              designId: ev.design_id ? String(ev.design_id) : undefined,
              fromQuality: ev.from_quality ? String(ev.from_quality) : undefined,
              toQuality: ev.to_quality ? String(ev.to_quality) : undefined,
              reasonCode: ev.reason_code ? String(ev.reason_code) : undefined,
              summary: String(
                ev.summary ||
                  ev.message ||
                  ev.description ||
                  `${ev.from_quality || 'GOOD'} → ${ev.to_quality || 'STALE'}`,
              ),
              dataEpoch: ev.data_epoch ? Number(ev.data_epoch) : undefined,
            };
          });

          if (mappedEvs.length > 0) {
            setEvents(mappedEvs);
          } else {
            // Synthesize quality transition events from points if backend events list is empty
            const derived: HistorianEventItem[] = [];
            for (const s of builtSeries) {
              const sName =
                s.signal.displayName || s.signal.name || s.signal.key || s.signal.id;
              for (let i = 1; i < s.points.length; i++) {
                const prev = s.points[i - 1];
                const curr = s.points[i];
                if (prev.quality !== curr.quality) {
                  derived.push({
                    id: `trans-${s.signal.id}-${curr.timestampMs}`,
                    timestampMs: curr.timestampMs,
                    timestamp: curr.eventTime,
                    kind: 'QUALITY_TRANSITION',
                    signalId: s.signal.id,
                    signalName: sName,
                    fromQuality: prev.quality,
                    toQuality: curr.quality,
                    reasonCode: curr.reasonCode || undefined,
                    summary: `${sName}: ${prev.quality} → ${curr.quality}${
                      curr.reasonCode ? ` (${curr.reasonCode})` : ''
                    }`,
                    dataEpoch: curr.dataEpoch,
                  });
                }
              }
            }
            setEvents(derived.sort((a, b) => a.timestampMs - b.timestampMs));
          }
        } catch {
          // Derive transitions locally on fallback
          const derived: HistorianEventItem[] = [];
          for (const s of builtSeries) {
            const sName =
              s.signal.displayName || s.signal.name || s.signal.key || s.signal.id;
            for (let i = 1; i < s.points.length; i++) {
              const prev = s.points[i - 1];
              const curr = s.points[i];
              if (prev.quality !== curr.quality) {
                derived.push({
                  id: `trans-${s.signal.id}-${curr.timestampMs}`,
                  timestampMs: curr.timestampMs,
                  timestamp: curr.eventTime,
                  kind: 'QUALITY_TRANSITION',
                  signalId: s.signal.id,
                  signalName: sName,
                  fromQuality: prev.quality,
                  toQuality: curr.quality,
                  reasonCode: curr.reasonCode || undefined,
                  summary: `${sName}: ${prev.quality} → ${curr.quality}`,
                });
              }
            }
          }
          setEvents(derived);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Historian query failed.';
        setQueryError(msg);
      } finally {
        setLoadingQuery(false);
        setLoadingMore(false);
      }
    },
    [
      selectedSignalIds,
      selectedDesignId,
      selectedDatasetKey,
      mode,
      startMs,
      endMs,
      startIso,
      endIso,
      bucket,
      agg,
      timeAxis,
      qualityFilter,
      signalById,
      normalizePoint,
    ],
  );

  // Automatically run query when parameters or selected signals change
  useEffect(() => {
    void executeHistorianQuery(null);
  }, [executeHistorianQuery]);

  // Update SQL preview for Query Workspace
  useEffect(() => {
    setWorkspaceSql(
      buildTdengineSqlPreview({
        signalIds: selectedSignalIds,
        datasetKey: selectedDatasetKey,
        mode,
        timeAxis,
        startIso,
        endIso,
        qualityFilter,
        bucket,
        agg,
        limit: workspaceLimit,
      }),
    );
  }, [
    selectedSignalIds,
    selectedDatasetKey,
    mode,
    timeAxis,
    startIso,
    endIso,
    qualityFilter,
    bucket,
    agg,
    workspaceLimit,
  ]);

  // Flatten all points across series for Raw Data Preview Table
  const allRawPoints = useMemo(() => {
    return seriesList
      .flatMap((s) => s.points)
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [seriesList]);

  // Load Saved Views
  const loadSavedViews = useCallback(async () => {
    setLoadingViews(true);
    try {
      const res = await api<{ items?: Array<Record<string, unknown>> }>('/api/v1/historian/views');
      const items = Array.isArray(res?.items)
        ? res.items
        : Array.isArray(res)
          ? (res as Array<Record<string, unknown>>)
          : [];
      setSavedViews(
        items.map((v) => {
          const spec = (v.query_spec_json || v.query_spec || {}) as Record<string, unknown>;
          return {
            id: String(v.id || ''),
            name: String(v.name || 'Saved View'),
            description: String(v.description || ''),
            mode: (String(spec.mode || v.mode || 'operational') as HistorianMode) || 'operational',
            range: (String(spec.range || v.range || '15m') as TimeRangePreset) || '15m',
            bucket: (String(spec.bucket || 'auto') as BucketResolution) || 'auto',
            agg: (String(spec.agg || 'avg') as AggregationFn) || 'avg',
            timeAxis: (String(spec.time_axis || 'acquired_at') as TimeAxisMode) || 'acquired_at',
            qualityFilter: String(spec.quality_filter || 'ALL'),
            signalIds: Array.isArray(spec.signal_ids)
              ? (spec.signal_ids as string[])
              : Array.isArray(v.signal_ids)
                ? (v.signal_ids as string[])
                : [],
            designId: spec.design_id ? String(spec.design_id) : null,
            datasetId: spec.dataset_id ? String(spec.dataset_id) : null,
            isDefault: Boolean(v.is_default),
            createdAt: String(v.created_at || new Date().toISOString()),
            updatedAt: String(v.updated_at || new Date().toISOString()),
          };
        }),
      );
    } catch {
      // Keep current list on transient error
    } finally {
      setLoadingViews(false);
    }
  }, []);

  // Load Export Jobs
  const loadExportJobs = useCallback(async () => {
    setLoadingExports(true);
    try {
      const res = await api<{ items?: Array<Record<string, unknown>> }>('/api/v1/historian/exports');
      const items = Array.isArray(res?.items)
        ? res.items
        : Array.isArray(res)
          ? (res as Array<Record<string, unknown>>)
          : [];
      setExportJobs(
        items.map((j) => {
          const rawStatus = String(j.status || 'COMPLETED').toUpperCase();
          const normStatus = rawStatus === 'READY' ? 'COMPLETED' : rawStatus;
          return {
            id: String(j.id || ''),
            status: normStatus,
            fileName: String(j.file_name || j.fileName || `historian-export-${String(j.id || '').slice(0, 8)}.csv`),
            format: String(j.format || 'csv').toUpperCase(),
            rowCount: Number(j.row_count ?? j.rowCount ?? 0),
            byteSize: j.byte_size != null ? Number(j.byte_size) : null,
            createdAt: String(j.created_at || new Date().toISOString()),
            completedAt: j.completed_at ? String(j.completed_at) : null,
            expiresAt: j.expires_at ? String(j.expires_at) : null,
            errorMessage: j.error_message ? String(j.error_message) : null,
          };
        }),
      );
    } catch {
      // Keep current list on transient error
    } finally {
      setLoadingExports(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'views') void loadSavedViews();
    if (activeTab === 'exports') void loadExportJobs();
  }, [activeTab, loadSavedViews, loadExportJobs]);

  // Toggle signal in Left Picker (up to 8 series)
  const handleToggleSignal = (sigId: string) => {
    setSelectedSignalIds((prev) => {
      if (prev.includes(sigId)) {
        return prev.filter((id) => id !== sigId);
      }
      if (prev.length >= MAX_SELECTED_SERIES) {
        show({
          message: `Maximum ${MAX_SELECTED_SERIES} concurrent series allowed on the multi-axis chart.`,
          tone: 'error',
        });
        return prev;
      }
      return [...prev, sigId];
    });
  };

  // Select a Dataset in Left Picker
  const handleSelectDataset = (ds: PublishedDatasetItem) => {
    setSelectedDatasetKey(ds.datasetKey);
    setSelectedDesignId(ds.designId);
    if (ds.signalIds.length > 0) {
      setSelectedSignalIds(ds.signalIds.slice(0, MAX_SELECTED_SERIES));
    }
    if (mode === 'operational') {
      setMode('recorded');
    }
    show({
      message: `Selected dataset “${ds.displayName}” (${ds.recordingMode}).`,
      tone: 'info',
    });
  };

  // Save current view handler
  const handleSaveView = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newViewName.trim() || savingView) return;
    setSavingView(true);
    try {
      const querySpec = {
        signal_ids: selectedSignalIds,
        design_id: selectedDesignId,
        dataset_id: selectedDatasetKey,
        mode,
        range: rangePreset,
        bucket,
        agg,
        time_axis: timeAxis,
        quality_filter: qualityFilter,
      };
      await api('/api/v1/historian/views', {
        method: 'POST',
        body: JSON.stringify({
          name: newViewName.trim(),
          description: newViewDesc.trim(),
          is_default: newViewDefault,
          query_spec_json: querySpec,
          query_spec: querySpec,
          chart_options_json: {
            hidden_signal_ids: Array.from(hiddenSignalIds),
          },
        }),
      });
      setSaveModalOpen(false);
      setNewViewName('');
      setNewViewDesc('');
      setNewViewDefault(false);
      show({ message: 'Saved Historian view.', tone: 'success' });
      void loadSavedViews();
    } catch (err: unknown) {
      show({
        message: err instanceof Error ? err.message : 'Failed to save view.',
        tone: 'error',
      });
    } finally {
      setSavingView(false);
    }
  };

  // Load a Saved View into Trend Explorer
  const handleLoadSavedView = (view: SavedHistorianView) => {
    setMode(view.mode);
    setRangePreset(view.range);
    setBucket(view.bucket);
    setAgg(view.agg);
    setTimeAxis(view.timeAxis);
    setQualityFilter(view.qualityFilter);
    if (view.signalIds.length > 0) {
      setSelectedSignalIds(view.signalIds.slice(0, MAX_SELECTED_SERIES));
    }
    setSelectedDesignId(view.designId || null);
    setSelectedDatasetKey(view.datasetId || null);
    setActiveTab('trend');
    show({ message: `Loaded view “${view.name}”.`, tone: 'success' });
  };

  // Delete a Saved View
  const handleDeleteSavedView = async (viewId: string) => {
    try {
      await api(`/api/v1/historian/views/${viewId}`, { method: 'DELETE' });
      setSavedViews((prev) => prev.filter((v) => v.id !== viewId));
      show({ message: 'Deleted saved view.', tone: 'success' });
    } catch (err: unknown) {
      show({
        message: err instanceof Error ? err.message : 'Failed to delete view.',
        tone: 'error',
      });
    }
  };

  // One-click Export CSV (creates server job AND triggers immediate download if rows are loaded)
  const handleExportCsv = async (createJobOnly = false) => {
    setCreatingExport(true);
    try {
      const fileName = `historian-${mode}-${rangePreset}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      const res = await api<Record<string, unknown>>('/api/v1/historian/exports', {
        method: 'POST',
        body: JSON.stringify({
          signal_ids: selectedSignalIds,
          design_id: selectedDesignId || undefined,
          dataset_id: selectedDatasetKey || undefined,
          mode,
          start: startIso,
          end: endIso,
          time_axis: timeAxis,
          quality: qualityFilter !== 'ALL' ? qualityFilter : undefined,
          format: 'csv',
          file_name: fileName,
        }),
      });
      const jobId = String(res?.id || '');
      show({
        message: `Export job created (${fileName}).`,
        tone: 'success',
      });
      void loadExportJobs();
      if (jobId && !createJobOnly) {
        window.open(`/api/v1/historian/exports/${jobId}/download`, '_blank', 'noopener,noreferrer');
      }
    } catch {
      // Client-side formula-injection-safe CSV fallback when offline or in standalone preview
      const pts = activeTab === 'query' && workspaceRows.length > 0 ? workspaceRows : allRawPoints;
      const header = [
        'signal_id',
        'signal_name',
        'acquired_at',
        'source_time',
        'value',
        'unit',
        'quality',
        'reason_code',
        'record_kind',
        'virtual',
        'event_uid',
        'data_epoch',
      ];
      const lines = [
        header.join(','),
        ...pts.map((p) =>
          [
            sanitizeCsvField(p.signalId),
            sanitizeCsvField(p.signalName),
            sanitizeCsvField(p.acquiredAt),
            sanitizeCsvField(p.sourceTime || ''),
            sanitizeCsvField(p.value),
            sanitizeCsvField(p.unit),
            sanitizeCsvField(p.quality),
            sanitizeCsvField(p.reasonCode || ''),
            sanitizeCsvField(p.recordKind),
            sanitizeCsvField(p.virtual),
            sanitizeCsvField(p.eventUid),
            sanitizeCsvField(p.dataEpoch),
          ].join(','),
        ),
      ];
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `historian-${mode}-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      show({ message: `Exported ${pts.length} rows to CSV.`, tone: 'success' });
    } finally {
      setCreatingExport(false);
    }
  };

  // Export Job Retry / Cancel handlers
  const handleRetryExport = async (jobId: string) => {
    try {
      await api(`/api/v1/historian/exports/${jobId}/retry`, { method: 'POST' });
      show({ message: 'Retrying export job…', tone: 'info' });
      void loadExportJobs();
    } catch (err: unknown) {
      show({
        message: err instanceof Error ? err.message : 'Could not retry export job.',
        tone: 'error',
      });
    }
  };

  const handleCancelExport = async (jobId: string) => {
    try {
      await api(`/api/v1/historian/exports/${jobId}/cancel`, { method: 'POST' });
      show({ message: 'Export job cancelled.', tone: 'info' });
      void loadExportJobs();
    } catch (err: unknown) {
      show({
        message: err instanceof Error ? err.message : 'Could not cancel export job.',
        tone: 'error',
      });
    }
  };

  // Run Query Workspace structured query
  const handleRunWorkspaceQuery = async () => {
    setWorkspaceLoading(true);
    try {
      await executeHistorianQuery(null);
      setWorkspaceRows(
        seriesList
          .flatMap((s) => s.points)
          .sort((a, b) => b.timestampMs - a.timestampMs)
          .slice(0, workspaceLimit),
      );
    } finally {
      setWorkspaceLoading(false);
    }
  };

  useEffect(() => {
    setWorkspaceRows(allRawPoints.slice(0, workspaceLimit));
  }, [allRawPoints, workspaceLimit]);

  // Filtered & Grouped Signals for Left Picker
  const groupedSignals = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    const filtered = signals.filter((s) => {
      if (!q) return true;
      const name = (s.displayName || s.name || s.key || '').toLowerCase();
      const resName = (resourceNameById.get(s.resourceId) || s.resourcePath || '').toLowerCase();
      const proto = (s.connectionProtocol || connectionProtocolById.get(s.sourceConnectionId) || '').toLowerCase();
      return name.includes(q) || resName.includes(q) || proto.includes(q) || s.id.toLowerCase().includes(q);
    });

    const groups = new Map<string, SignalItem[]>();
    for (const sig of filtered) {
      let groupLabel = 'Unassigned';
      if (pickerGroupBy === 'resource') {
        groupLabel =
          resourceNameById.get(sig.resourceId) ||
          sig.resourcePath ||
          'General Factory Resource';
      } else {
        const rawProto =
          sig.connectionProtocol ||
          connectionProtocolById.get(sig.sourceConnectionId) ||
          'modbus';
        groupLabel = PROTOCOL_LABEL[rawProto as keyof typeof PROTOCOL_LABEL] || rawProto.toUpperCase();
      }
      const list = groups.get(groupLabel) || [];
      list.push(sig);
      groups.set(groupLabel, list);
    }
    return Array.from(groups.entries());
  }, [signals, pickerSearch, pickerGroupBy, resourceNameById, connectionProtocolById]);

  const switchTab = (tab: HistorianTab) => {
    setActiveTab(tab);
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-4 pb-8">
      {/* Page Header & Workspace Sub-Navigation Tabs */}
      <div className="bg-white border border-[#E3EAF3] rounded-xl p-4 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[20px] font-extrabold text-[#111B37] tracking-tight">
              Historian Explorer
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-[#0DBA67] border border-emerald-200">
              TDengine Time-Series
            </span>
          </div>
          <p className="text-[12px] text-[#657794] mt-0.5">
            Explore operational observations, policy-recorded datasets, and step-hold reconstructed state timelines.
          </p>
        </div>

        {/* Sub-nav Tabs: Trend Explorer | Query Workspace | Saved Views | Exports & Jobs */}
        <div
          role="tablist"
          aria-label="Historian workspace tabs"
          className="flex flex-wrap items-center gap-1 bg-[#F6F8FC] p-1 rounded-xl border border-[#E3EAF3]"
        >
          {(
            [
              { id: 'trend' as const, label: 'Trend Explorer', icon: Activity, count: undefined },
              { id: 'query' as const, label: 'Query Workspace', icon: Code2, count: undefined },
              { id: 'views' as const, label: 'Saved Views', icon: Bookmark, count: savedViews.length },
              { id: 'exports' as const, label: 'Exports & Jobs', icon: FileSpreadsheet, count: exportJobs.length },
            ]
          ).map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => switchTab(t.id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-bold transition-all cursor-pointer ${
                  active
                    ? 'bg-white text-[#EF1B24] shadow-xs border border-[#E3EAF3]'
                    : 'text-[#334568] hover:text-[#111B37] hover:bg-white/60'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${active ? 'text-[#EF1B24]' : 'text-[#657794]'}`} />
                <span>{t.label}</span>
                {typeof t.count === 'number' && t.count > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-100 text-[#334568]">
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Mode Selector Pill Bar & Time Range / Resolution Toolbar */}
      <div className="bg-white border border-[#E3EAF3] rounded-xl p-3.5 shadow-xs space-y-3">
        {/* Top Row: Mode Selector Pill Bar with Clear Tooltips */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 pb-3 border-b border-[#E3EAF3]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#657794] mr-1">
              Fidelity Mode:
            </span>
            {HISTORIAN_MODES.map((m) => {
              const isSelected = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  title={m.tooltip}
                  data-testid={`historian-mode-${m.id}`}
                  className={`group relative inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-bold border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[#111B37] text-white border-[#111B37] shadow-xs'
                      : 'bg-[#F6F8FC] text-[#334568] border-[#D4DFEC] hover:border-[#94A3B8] hover:text-[#111B37]'
                  }`}
                >
                  <span>{m.label}</span>
                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.2 rounded uppercase ${
                      isSelected ? 'bg-white/20 text-white' : 'bg-white text-[#657794] border border-[#E3EAF3]'
                    }`}
                  >
                    {m.badge}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Active Mode Explanation Banner */}
          <div className="flex items-center gap-2 text-[11px] text-[#475569] bg-[#F6F8FC] px-3 py-1.5 rounded-lg border border-[#E3EAF3]">
            <Info className="w-3.5 h-3.5 text-[#EF1B24] shrink-0" />
            <span>
              {HISTORIAN_MODES.find((m) => m.id === mode)?.tooltip}
            </span>
          </div>
        </div>

        {/* Bottom Row: Time Range Presets, Custom Picker, Bucket Resolution, Aggregation, Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Time Range Presets */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 bg-[#F6F8FC] p-1 rounded-lg border border-[#E3EAF3]">
              <Clock className="w-3.5 h-3.5 text-[#657794] ml-1.5 mr-0.5" />
              {TIME_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setRangePreset(preset.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors cursor-pointer ${
                    rangePreset === preset.id
                      ? 'bg-[#EF1B24] text-white shadow-xs'
                      : 'text-[#334568] hover:text-[#111B37] hover:bg-white'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setRangePreset('custom')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors cursor-pointer ${
                  rangePreset === 'custom'
                    ? 'bg-[#EF1B24] text-white shadow-xs'
                    : 'text-[#334568] hover:text-[#111B37] hover:bg-white'
                }`}
              >
                Custom
              </button>
            </div>

            {rangePreset === 'custom' && (
              <div className="flex flex-wrap items-center gap-1.5 bg-[#F6F8FC] px-2.5 py-1 rounded-lg border border-[#D4DFEC] text-[11px]">
                <Calendar className="w-3.5 h-3.5 text-[#657794]" />
                <input
                  type="datetime-local"
                  aria-label="Custom start time"
                  value={customStartInput}
                  onChange={(e) => setCustomStartInput(e.target.value)}
                  className="bg-white border border-[#CBD5E1] rounded px-1.5 py-0.5 font-mono text-[11px] text-[#111B37]"
                />
                <span className="text-[#657794]">to</span>
                <input
                  type="datetime-local"
                  aria-label="Custom end time"
                  value={customEndInput}
                  onChange={(e) => setCustomEndInput(e.target.value)}
                  className="bg-white border border-[#CBD5E1] rounded px-1.5 py-0.5 font-mono text-[11px] text-[#111B37]"
                />
                <button
                  type="button"
                  onClick={() => setTimezoneMode((prev) => (prev === 'local' ? 'utc' : 'local'))}
                  className="px-1.5 py-0.5 rounded bg-white border border-[#CBD5E1] font-mono font-bold text-[10px] text-[#334568]"
                  title="Toggle UTC / Local display"
                >
                  {timezoneMode.toUpperCase()}
                </button>
              </div>
            )}

            {/* Bucket Resolution */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-semibold text-[#657794]">Bucket:</span>
              <select
                aria-label="Bucket resolution"
                value={bucket}
                onChange={(e) => setBucket(e.target.value as BucketResolution)}
                className="px-2 py-1 rounded-lg border border-[#D4DFEC] bg-white text-[#111B37] font-semibold text-[11px]"
              >
                {BUCKET_OPTIONS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Aggregation */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-semibold text-[#657794]">Agg:</span>
              <select
                aria-label="Aggregation function"
                value={agg}
                onChange={(e) => setAgg(e.target.value as AggregationFn)}
                className="px-2 py-1 rounded-lg border border-[#D4DFEC] bg-white text-[#111B37] font-mono font-semibold text-[11px]"
              >
                {AGG_OPTIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Right Toolbar Actions: Refresh, Save View, Export CSV */}
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className={`w-3.5 h-3.5 ${loadingQuery ? 'animate-spin' : ''}`} />}
              onClick={() => setRefreshTick((t) => t + 1)}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Save className="w-3.5 h-3.5" />}
              onClick={() => setSaveModalOpen(true)}
            >
              Save View
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={creatingExport}
              icon={<Download className="w-3.5 h-3.5" />}
              onClick={() => void handleExportCsv(false)}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </div>

      {queryError && (
        <div className="p-3 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-[12px] text-[#EF1B24] font-medium flex items-center justify-between">
          <span>{queryError}</span>
          <button
            type="button"
            onClick={() => void executeHistorianQuery(null)}
            className="px-2.5 py-1 rounded bg-white border border-[#FECACA] text-[11px] font-bold text-[#EF1B24]"
          >
            Retry
          </button>
        </div>
      )}

      {/* TAB 1: 3-PANE TREND EXPLORER */}
      {activeTab === 'trend' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* LEFT PANE: Signal & Dataset Series Picker (3 cols on lg) */}
          <div className="lg:col-span-3 bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden flex flex-col max-h-[840px]">
            <div className="p-3.5 border-b border-[#E3EAF3] bg-[#F9FAFD] space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <FolderTree className="w-4 h-4 text-[#EF1B24]" />
                  <h2 className="text-[13px] font-bold text-[#111B37]">Series &amp; Dataset Picker</h2>
                </div>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-full bg-slate-100 text-[#334568]">
                  {selectedSignalIds.length}/{MAX_SELECTED_SERIES} active
                </span>
              </div>

              {/* Search across 336 signals & published datasets */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder={`Search ${signals.length || 336} signals or datasets…`}
                  aria-label="Search signals and datasets"
                  className="w-full pl-8 pr-7 py-1.5 text-[12px] bg-white border border-[#CBD5E1] rounded-lg focus:outline-none focus:border-[#EF1B24] text-[#111B37]"
                />
                {pickerSearch && (
                  <button
                    type="button"
                    onClick={() => setPickerSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#111B37]"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Grouping Toggle: By Resource | By Protocol | Datasets */}
              <div className="grid grid-cols-3 gap-1 bg-[#F1F5FA] p-1 rounded-lg text-[11px] font-semibold">
                {(
                  [
                    { id: 'resource', label: 'By Resource' },
                    { id: 'protocol', label: 'By Protocol' },
                    { id: 'dataset', label: `Datasets (${datasets.length})` },
                  ] as const
                ).map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setPickerGroupBy(g.id)}
                    className={`py-1 rounded-md transition-colors cursor-pointer ${
                      pickerGroupBy === g.id
                        ? 'bg-white text-[#111B37] shadow-xs font-bold'
                        : 'text-[#657794] hover:text-[#111B37]'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Picker List */}
            <div className="p-2.5 overflow-y-auto flex-1 space-y-2">
              {pickerGroupBy === 'dataset' ? (
                datasets.length === 0 ? (
                  <div className="p-4 text-center text-[12px] text-[#657794]">
                    No published Managed datasets found. Create and publish a Storage Design in Designer, or browse raw
                    Signals.
                  </div>
                ) : (
                  datasets.map((ds) => {
                    const isSelected =
                      selectedDatasetKey === ds.datasetKey || selectedDesignId === ds.designId;
                    return (
                      <div
                        key={ds.id}
                        onClick={() => handleSelectDataset(ds)}
                        className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-[#FEF2F2]/60 border-[#EF1B24] shadow-xs'
                            : 'bg-white border-[#E3EAF3] hover:bg-[#F6F8FC]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-bold text-[#111B37] truncate">
                            {ds.displayName}
                          </span>
                          <StatusBadge status={ds.designStatus} />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-[#657794] mt-1">
                          <span className="font-mono">{ds.recordingMode}</span>
                          <span>{ds.signalIds.length} fields</span>
                        </div>
                      </div>
                    );
                  })
                )
              ) : groupedSignals.length === 0 ? (
                <div className="p-4 text-center text-[12px] text-[#657794]">
                  No signals match “{pickerSearch}”.
                </div>
              ) : (
                groupedSignals.map(([groupName, groupSigs]) => {
                  const isCollapsed = Boolean(collapsedGroups[groupName]);
                  return (
                    <div key={groupName} className="border border-[#E3EAF3] rounded-lg overflow-hidden">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsedGroups((prev) => ({
                            ...prev,
                            [groupName]: !prev[groupName],
                          }))
                        }
                        className="w-full px-2.5 py-1.5 bg-[#F6F8FC] hover:bg-slate-100 flex items-center justify-between text-left text-[11px] font-bold text-[#334568]"
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          {isCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span className="truncate">{groupName}</span>
                        </div>
                        <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-white border border-[#E3EAF3]">
                          {groupSigs.length}
                        </span>
                      </button>

                      {!isCollapsed && (
                        <div className="divide-y divide-[#F1F5F9]">
                          {groupSigs.slice(0, 60).map((sig) => {
                            const selIdx = selectedSignalIds.indexOf(sig.id);
                            const isChecked = selIdx !== -1;
                            const color = isChecked
                              ? SERIES_COLORS[selIdx % SERIES_COLORS.length]
                              : '#CBD5E1';
                            const label = sig.displayName || sig.name || sig.key || sig.id;
                            return (
                              <label
                                key={sig.id}
                                className={`flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] cursor-pointer transition-colors ${
                                  isChecked ? 'bg-blue-50/50 font-semibold' : 'hover:bg-slate-50'
                                }`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => handleToggleSignal(sig.id)}
                                    className="rounded border-[#CBD5E1] text-[#EF1B24] focus:ring-[#EF1B24]"
                                  />
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: color }}
                                  />
                                  <span className="truncate text-[#111B37]" title={label}>
                                    {label}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {sig.unit && (
                                    <span className="text-[10px] font-mono text-[#657794]">
                                      {sig.unit}
                                    </span>
                                  )}
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                      sig.quality === 'GOOD'
                                        ? 'bg-[#0DBA67]'
                                        : sig.quality === 'STALE'
                                          ? 'bg-slate-400'
                                          : 'bg-amber-500'
                                    }`}
                                  />
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* CENTER & BOTTOM PANES (9 cols on lg) */}
          <div className="lg:col-span-9 space-y-4">
            {/* CENTER PANE: Multi-Series Trend Chart + Quality Lane + Events Lane */}
            <HistorianTrendChart
              seriesList={seriesList}
              events={events}
              mode={mode}
              startMs={startMs}
              endMs={endMs}
              loading={loadingQuery}
              hiddenSignalIds={hiddenSignalIds}
              onToggleSeriesVisibility={(sigId) => {
                setHiddenSignalIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(sigId)) next.delete(sigId);
                  else next.add(sigId);
                  return next;
                });
              }}
              onSelectPoint={(pt) => setInspectedPoint(pt)}
            />

            {/* BOTTOM PANE 1: Per-Series Statistics Table */}
            <div
              data-testid="per-series-stats-table"
              className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[#EF1B24]" />
                  <h3 className="text-[13px] font-bold text-[#111B37]">
                    Per-Series Statistics Table
                  </h3>
                  <span className="text-[11px] text-[#657794]">
                    Computed independently per signal &amp; unit (never mixing incompatible units)
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-[#E3EAF3] bg-[#F6F8FC] text-[11px] font-bold uppercase tracking-wider text-[#657794]">
                      <th className="py-2.5 px-4">Signal</th>
                      <th className="py-2.5 px-3">Unit</th>
                      <th className="py-2.5 px-3 text-right">Last</th>
                      <th className="py-2.5 px-3 text-right">Min</th>
                      <th className="py-2.5 px-3 text-right">Max</th>
                      <th className="py-2.5 px-3 text-right">Avg</th>
                      <th className="py-2.5 px-3 text-right">Samples</th>
                      <th className="py-2.5 px-3 text-right">Good %</th>
                      <th className="py-2.5 px-4">Fidelity Mode</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E3EAF3]">
                    {seriesList.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-6 text-center text-[#657794]">
                          Select one or more signals to compute per-series statistics.
                        </td>
                      </tr>
                    ) : (
                      seriesList.map(({ stats }) => (
                        <tr key={stats.signalId} className="hover:bg-[#F9FAFD]">
                          <td className="py-2.5 px-4 font-bold text-[#111B37]">
                            <div className="flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: stats.color }}
                              />
                              <span className="truncate max-w-[200px]">{stats.signalName}</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-[#657794]">
                            {stats.unit || '—'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-[#111B37]">
                            {formatValue(stats.last)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-[#334568]">
                            {stats.min !== null ? stats.min.toFixed(2) : 'N/A'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-[#334568]">
                            {stats.max !== null ? stats.max.toFixed(2) : 'N/A'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-[#334568]">
                            {stats.avg !== null ? stats.avg.toFixed(2) : 'N/A'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-semibold text-[#111B37]">
                            {stats.samples.toLocaleString()}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold">
                            <span
                              className={
                                stats.goodPct >= 95
                                  ? 'text-[#0DBA67]'
                                  : stats.goodPct >= 70
                                    ? 'text-amber-600'
                                    : 'text-[#EF1B24]'
                              }
                            >
                              {stats.goodPct.toFixed(1)}%
                            </span>
                          </td>
                          <td className="py-2.5 px-4">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#F6F8FC] text-[#334568] border border-[#E3EAF3]">
                              {stats.fidelityMode}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* BOTTOM PANE 2: Raw Data Preview Table with Cursor Pagination */}
            <div
              data-testid="raw-data-preview-table"
              className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-[#E3EAF3] bg-[#F9FAFD] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <TableIcon className="w-4 h-4 text-[#334568]" />
                  <h3 className="text-[13px] font-bold text-[#111B37]">Raw Data Preview</h3>
                  <span className="text-[11px] font-mono text-[#657794]">
                    ({allRawPoints.length.toLocaleString()} rows loaded)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download className="w-3.5 h-3.5" />}
                    onClick={() => void handleExportCsv(false)}
                  >
                    Export CSV
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto max-h-[340px]">
                <table className="w-full text-left border-collapse text-[12px]">
                  <thead className="sticky top-0 z-10 bg-[#F6F8FC] border-b border-[#E3EAF3] text-[11px] font-bold uppercase tracking-wider text-[#657794]">
                    <tr>
                      <th className="py-2.5 px-4">Signal</th>
                      <th className="py-2.5 px-3">Acquired At (`acquired_at`)</th>
                      <th className="py-2.5 px-3">Source Time (`source_time`)</th>
                      <th className="py-2.5 px-3 text-right">Value</th>
                      <th className="py-2.5 px-3">Quality</th>
                      <th className="py-2.5 px-3">Reason Code</th>
                      <th className="py-2.5 px-4">Record Kind</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E3EAF3]">
                    {allRawPoints.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-[#657794]">
                          {loadingQuery
                            ? 'Loading TDengine time-series rows…'
                            : 'No records returned for the selected signals and time window.'}
                        </td>
                      </tr>
                    ) : (
                      allRawPoints.slice(0, 200).map((pt) => (
                        <tr
                          key={pt.id}
                          onClick={() => setInspectedPoint(pt)}
                          className="hover:bg-[#F9FAFD] cursor-pointer transition-colors"
                        >
                          <td className="py-2 px-4 font-semibold text-[#111B37] truncate max-w-[180px]">
                            {pt.signalName}
                          </td>
                          <td className="py-2 px-3 font-mono text-[11px] text-[#111B37]">
                            {formatTimestamp(pt.acquiredAt)}
                          </td>
                          <td className="py-2 px-3 font-mono text-[11px] text-[#657794]">
                            {pt.sourceTime ? formatTimestamp(pt.sourceTime) : '—'}
                          </td>
                          <td className="py-2 px-3 text-right font-mono font-bold text-[#111B37]">
                            {formatValue(pt.value)}
                            {pt.unit ? ` ${pt.unit}` : ''}
                          </td>
                          <td className="py-2 px-3">
                            <StatusBadge status={pt.quality} />
                          </td>
                          <td className="py-2 px-3 font-mono text-[11px] text-[#657794]">
                            {pt.reasonCode || '—'}
                          </td>
                          <td className="py-2 px-4">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-[#334568]">
                                {pt.recordKind}
                              </span>
                              {pt.virtual && (
                                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold">
                                  virtual
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Cursor Pagination Footer */}
              <div className="px-4 py-2.5 border-t border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between text-[11px] text-[#657794]">
                <span>
                  Showing {Math.min(allRawPoints.length, 200)} of {allRawPoints.length} loaded records
                </span>
                {nextCursor && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={loadingMore}
                    onClick={() => void executeHistorianQuery(nextCursor)}
                  >
                    Load More
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: QUERY WORKSPACE */}
      {activeTab === 'query' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Structured Query Builder Form (5 cols) */}
          <div className="lg:col-span-5 bg-white border border-[#E3EAF3] rounded-xl p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#E3EAF3]">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-[#EF1B24]" />
                <h2 className="text-[14px] font-bold text-[#111B37]">Structured Query Builder</h2>
              </div>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 text-[#334568]">
                Read-Only TDengine
              </span>
            </div>

            <div className="space-y-3.5 text-[12px]">
              <div>
                <label className="block font-semibold text-[#111B37] mb-1">
                  Target Storage Dataset (Optional)
                </label>
                <select
                  value={selectedDatasetKey || ''}
                  onChange={(e) => setSelectedDatasetKey(e.target.value || null)}
                  className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] bg-white text-[#111B37]"
                >
                  <option value="">Operational History STables (All Selected Signals)</option>
                  {datasets.map((ds) => (
                    <option key={ds.id} value={ds.datasetKey}>
                      {ds.displayName} ({ds.recordingMode})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-[#111B37] mb-1">Time Axis</label>
                  <select
                    value={timeAxis}
                    onChange={(e) => setTimeAxis(e.target.value as TimeAxisMode)}
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] bg-white text-[#111B37] font-mono"
                  >
                    <option value="acquired_at">acquired_at (ts)</option>
                    <option value="source_time">source_time</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-[#111B37] mb-1">Quality Filter</label>
                  <select
                    value={qualityFilter}
                    onChange={(e) => setQualityFilter(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] bg-white text-[#111B37]"
                  >
                    <option value="ALL">All Qualities</option>
                    <option value="GOOD">GOOD only</option>
                    <option value="UNCERTAIN">UNCERTAIN only</option>
                    <option value="STALE">STALE only</option>
                    <option value="BAD">BAD only</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block font-semibold text-[#111B37] mb-1">Bucket</label>
                  <select
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value as BucketResolution)}
                    className="w-full px-2.5 py-2 rounded-lg border border-[#CBD5E1] bg-white text-[#111B37]"
                  >
                    {BUCKET_OPTIONS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#111B37] mb-1">Aggregate</label>
                  <select
                    value={agg}
                    onChange={(e) => setAgg(e.target.value as AggregationFn)}
                    className="w-full px-2.5 py-2 rounded-lg border border-[#CBD5E1] bg-white text-[#111B37] font-mono"
                  >
                    {AGG_OPTIONS.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#111B37] mb-1">Row Limit</label>
                  <select
                    value={workspaceLimit}
                    onChange={(e) => setWorkspaceLimit(Number(e.target.value))}
                    className="w-full px-2.5 py-2 rounded-lg border border-[#CBD5E1] bg-white text-[#111B37] font-mono"
                  >
                    {[100, 250, 500, 1000, 2000].map((lim) => (
                      <option key={lim} value={lim}>
                        {lim}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Generated TDengine SQL Read-Only Summary */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-[#111B37]">
                    Generated TDengine SQL Preview (Read-Only)
                  </span>
                  <span className="text-[10px] font-mono text-[#0DBA67] font-bold">
                    Parameterized &amp; Tenant-Scoped
                  </span>
                </div>
                <pre
                  data-testid="tdengine-sql-preview"
                  className="p-3 rounded-xl bg-[#111B37] text-slate-100 font-mono text-[11px] overflow-x-auto leading-relaxed border border-slate-700"
                >
                  {workspaceSql}
                </pre>
              </div>

              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQualityFilter('ALL');
                    setBucket('auto');
                    setAgg('avg');
                    setTimeAxis('acquired_at');
                  }}
                >
                  Reset Filters
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => switchTab('trend')}
                  >
                    Open in Trend
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={workspaceLoading || loadingQuery}
                    icon={<Play className="w-3.5 h-3.5" />}
                    onClick={() => void handleRunWorkspaceQuery()}
                  >
                    Run Query
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Tabular Results Inspector (7 cols) */}
          <div className="lg:col-span-7 bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-bold text-[#111B37]">
                  Query Results ({workspaceRows.length} rows)
                </h3>
                <p className="text-[11px] text-[#657794]">
                  Axis: <span className="font-mono">{timeAxis}</span> · Mode:{' '}
                  <span className="font-mono">{mode}</span>
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<Download className="w-3.5 h-3.5" />}
                onClick={() => void handleExportCsv(false)}
              >
                Export Results CSV
              </Button>
            </div>

            <div className="overflow-x-auto max-h-[540px]">
              <table className="w-full text-left border-collapse text-[12px]">
                <thead className="sticky top-0 bg-[#F6F8FC] border-b border-[#E3EAF3] text-[11px] font-bold uppercase tracking-wider text-[#657794]">
                  <tr>
                    <th className="py-2.5 px-4">Signal</th>
                    <th className="py-2.5 px-3">Timestamp ({timeAxis})</th>
                    <th className="py-2.5 px-3 text-right">Value</th>
                    <th className="py-2.5 px-3">Quality</th>
                    <th className="py-2.5 px-3">Event UID</th>
                    <th className="py-2.5 px-3">Epoch</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E3EAF3]">
                  {workspaceRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-[#657794]">
                        Click “Run Query” to inspect structured TDengine results.
                      </td>
                    </tr>
                  ) : (
                    workspaceRows.map((r) => (
                      <tr key={r.id} className="hover:bg-[#F9FAFD]">
                        <td className="py-2 px-4 font-semibold text-[#111B37] truncate max-w-[180px]">
                          {r.signalName}
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] text-[#111B37]">
                          {formatTimestamp(
                            timeAxis === 'source_time' && r.sourceTime ? r.sourceTime : r.acquiredAt,
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-[#111B37]">
                          {formatValue(r.value)}
                          {r.unit ? ` ${r.unit}` : ''}
                        </td>
                        <td className="py-2 px-3">
                          <StatusBadge status={r.quality} />
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] text-[#657794] truncate max-w-[140px]">
                          {r.eventUid}
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] text-[#334568]">
                          #{r.dataEpoch}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: SAVED VIEWS */}
      {activeTab === 'views' && (
        <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-[#E3EAF3] bg-[#F9FAFD] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-bold text-[#111B37]">Saved Historian Views</h2>
              <p className="text-[12px] text-[#657794]">
                Persisted signal sets, fidelity modes, and time range presets (`/api/v1/historian/views`).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className={`w-3.5 h-3.5 ${loadingViews ? 'animate-spin' : ''}`} />}
                onClick={() => void loadSavedViews()}
              >
                Refresh
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => setSaveModalOpen(true)}
              >
                Save Current View
              </Button>
            </div>
          </div>

          <div className="p-5">
            {savedViews.length === 0 ? (
              <div className="p-8 text-center bg-[#F6F8FC] border border-dashed border-[#D4DFEC] rounded-xl space-y-2">
                <Bookmark className="w-7 h-7 text-[#94A3B8] mx-auto" />
                <div className="text-[13px] font-bold text-[#111B37]">No Saved Views Yet</div>
                <p className="text-[12px] text-[#657794] max-w-md mx-auto">
                  Save your current signal selection, fidelity mode, and time window for one-click reload.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {savedViews.map((v) => (
                  <div
                    key={v.id}
                    className="p-4 rounded-xl border border-[#E3EAF3] bg-white hover:border-[#94A3B8] transition-all flex flex-col justify-between gap-3 shadow-2xs"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-[14px] font-bold text-[#111B37] truncate">{v.name}</h3>
                        {v.isDefault && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-[#0DBA67] border border-emerald-200">
                            Default
                          </span>
                        )}
                      </div>
                      {v.description && (
                        <p className="text-[12px] text-[#657794] line-clamp-2">{v.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px] font-mono text-[#334568]">
                        <span className="px-2 py-0.5 rounded bg-[#F6F8FC] border border-[#E3EAF3]">
                          Mode: {v.mode}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-[#F6F8FC] border border-[#E3EAF3]">
                          Range: {v.range}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-[#F6F8FC] border border-[#E3EAF3]">
                          {v.signalIds.length} series
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-[#F1F5F9]">
                      <span className="text-[11px] text-[#94A3B8]">
                        {formatTimestamp(v.updatedAt).slice(0, 16)}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleDeleteSavedView(v.id)}
                          className="p-1.5 rounded-lg text-[#657794] hover:text-[#EF1B24] hover:bg-[#FEF2F2] transition-colors"
                          title="Delete saved view"
                          aria-label={`Delete view ${v.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleLoadSavedView(v)}
                        >
                          Load into Trend Explorer
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: EXPORTS & JOBS */}
      {activeTab === 'exports' && (
        <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-[#E3EAF3] bg-[#F9FAFD] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-bold text-[#111B37]">CSV Exports &amp; Async Jobs</h2>
              <p className="text-[12px] text-[#657794]">
                Formula-injection-safe CSV exports scoped to your tenant and active telemetry epoch (`/api/v1/historian/exports`).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className={`w-3.5 h-3.5 ${loadingExports ? 'animate-spin' : ''}`} />}
                onClick={() => void loadExportJobs()}
              >
                Refresh
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={creatingExport}
                icon={<Download className="w-3.5 h-3.5" />}
                onClick={() => void handleExportCsv(true)}
              >
                New CSV Export Job
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-[#E3EAF3] bg-[#F6F8FC] text-[11px] font-bold uppercase tracking-wider text-[#657794]">
                  <th className="py-3 px-4">File Name &amp; ID</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-3 text-right">Rows</th>
                  <th className="py-3 px-3 text-right">File Size</th>
                  <th className="py-3 px-3">Created At</th>
                  <th className="py-3 px-3">Expires At</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E3EAF3]">
                {exportJobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-[#657794]">
                      No export jobs yet. Click “Export CSV” or “New CSV Export Job” to generate a downloadable file.
                    </td>
                  </tr>
                ) : (
                  exportJobs.map((job) => {
                    const isCompleted = job.status === 'COMPLETED' || job.status === 'READY';
                    const isRunning = job.status === 'RUNNING' || job.status === 'PENDING';
                    const isFailed = job.status === 'FAILED' || job.status === 'CANCELLED';
                    const isExpired = job.status === 'EXPIRED';

                    return (
                      <tr key={job.id} className="hover:bg-[#F9FAFD]">
                        <td className="py-3 px-4">
                          <div className="font-bold text-[#111B37]">{job.fileName}</div>
                          <div className="font-mono text-[10px] text-[#657794]">ID: {job.id}</div>
                          {job.errorMessage && (
                            <div className="text-[11px] text-[#EF1B24] mt-0.5">{job.errorMessage}</div>
                          )}
                        </td>
                        <td className="py-3 px-3">
                          <StatusBadge
                            status={
                              isCompleted
                                ? 'GOOD'
                                : isRunning
                                  ? 'UNCERTAIN'
                                  : isExpired
                                    ? 'STALE'
                                    : 'BAD'
                            }
                            label={job.status}
                          />
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-semibold text-[#111B37]">
                          {job.rowCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-[#657794]">
                          {formatBytes(job.byteSize)}
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px] text-[#334568]">
                          {formatTimestamp(job.createdAt)}
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px] text-[#657794]">
                          {job.expiresAt ? formatTimestamp(job.expiresAt) : '—'}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-2">
                            {isCompleted && !isExpired && (
                              <a
                                href={`/api/v1/historian/exports/${job.id}/download`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 text-[11px] font-bold transition-colors"
                              >
                                <Download className="w-3.5 h-3.5" />
                                Download CSV
                              </a>
                            )}
                            {(isFailed || isExpired) && (
                              <button
                                type="button"
                                onClick={() => void handleRetryExport(job.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white text-[#334568] border border-[#D4DFEC] hover:bg-slate-50 text-[11px] font-semibold"
                              >
                                <RotateCcw className="w-3 h-3" />
                                Retry
                              </button>
                            )}
                            {isRunning && (
                              <button
                                type="button"
                                onClick={() => void handleCancelExport(job.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#FEF2F2] text-[#EF1B24] border border-[#FECACA] hover:bg-red-100 text-[11px] font-semibold"
                              >
                                <X className="w-3 h-3" />
                                Cancel
                              </button>
                            )}
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
      )}

      {/* Point Lineage Inspector Drawer/Modal */}
      {inspectedPoint && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/40 backdrop-blur-xs">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Observation Point Lineage Inspector"
              className="w-full max-w-md h-full bg-white shadow-2xl border-l border-[#E3EAF3] flex flex-col justify-between overflow-y-auto p-6"
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-[#E3EAF3]">
                  <div>
                    <h3 className="text-[15px] font-bold text-[#111B37]">Point Lineage Inspector</h3>
                    <p className="text-[11px] text-[#657794]">{inspectedPoint.signalName}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectedPoint(null)}
                    className="p-1.5 rounded-lg text-[#657794] hover:bg-slate-100"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="space-y-3 text-[12px]">
                  <div className="p-3 rounded-xl bg-[#F6F8FC] border border-[#E3EAF3] flex items-center justify-between">
                    <div>
                      <div className="text-[10px] font-bold uppercase text-[#657794]">Recorded Value</div>
                      <div className="text-[18px] font-extrabold font-mono text-[#111B37]">
                        {formatValue(inspectedPoint.value)}
                        {inspectedPoint.unit ? ` ${inspectedPoint.unit}` : ''}
                      </div>
                    </div>
                    <StatusBadge status={inspectedPoint.quality} />
                  </div>

                  <dl className="space-y-2 divide-y divide-[#F1F5F9]">
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Signal ID</dt>
                      <dd className="font-mono text-[#111B37] text-[11px]">{inspectedPoint.signalId}</dd>
                    </div>
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Event UID</dt>
                      <dd className="font-mono text-[#111B37] text-[11px] break-all">{inspectedPoint.eventUid}</dd>
                    </div>
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Acquired At (`acquired_at`)</dt>
                      <dd className="font-mono text-[#111B37] text-[11px]">
                        {formatTimestamp(inspectedPoint.acquiredAt)}
                      </dd>
                    </div>
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Source Time (`source_time`)</dt>
                      <dd className="font-mono text-[#111B37] text-[11px]">
                        {inspectedPoint.sourceTime ? formatTimestamp(inspectedPoint.sourceTime) : '—'}
                      </dd>
                    </div>
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Record Kind</dt>
                      <dd className="font-mono font-bold text-[#334568]">{inspectedPoint.recordKind}</dd>
                    </div>
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Reconstructed Virtual Point</dt>
                      <dd className="font-mono font-bold text-[#111B37]">
                        {inspectedPoint.virtual ? 'Yes (Step-Hold Interpolated)' : 'No (Physical TDengine Row)'}
                      </dd>
                    </div>
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Telemetry Epoch</dt>
                      <dd className="font-mono font-bold text-[#111B37]">Epoch #{inspectedPoint.dataEpoch}</dd>
                    </div>
                    <div className="pt-2 flex justify-between gap-2">
                      <dt className="text-[#657794]">Reason Code</dt>
                      <dd className="font-mono text-[#657794]">{inspectedPoint.reasonCode || 'NONE'}</dd>
                    </div>
                  </dl>
                </div>
              </div>

              <div className="pt-4 border-t border-[#E3EAF3] flex items-center justify-between gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ExternalLink className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/collector/signals?signalId=${inspectedPoint.signalId}`)}
                >
                  Inspect Signal in Collector
                </Button>
                <Button variant="primary" size="sm" onClick={() => setInspectedPoint(null)}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Save Current View Modal */}
      {saveModalOpen && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="save-view-modal-title"
              className="w-full max-w-md bg-white rounded-xl shadow-2xl border border-[#E3EAF3] overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between">
                <h3 id="save-view-modal-title" className="text-[15px] font-bold text-[#111B37]">
                  Save Historian View
                </h3>
                <button
                  type="button"
                  onClick={() => setSaveModalOpen(false)}
                  className="text-[#94A3B8] hover:text-[#111B37]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={(e) => void handleSaveView(e)} className="p-5 space-y-4 text-[12px]">
                <div>
                  <label htmlFor="view-name-input" className="block font-semibold text-[#111B37] mb-1">
                    View Name
                  </label>
                  <input
                    id="view-name-input"
                    type="text"
                    required
                    value={newViewName}
                    onChange={(e) => setNewViewName(e.target.value)}
                    placeholder="e.g., Line 1 Press & Motor Reconstructed"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-[#111B37]"
                  />
                </div>

                <div>
                  <label htmlFor="view-desc-input" className="block font-semibold text-[#111B37] mb-1">
                    Description
                  </label>
                  <textarea
                    id="view-desc-input"
                    rows={2}
                    value={newViewDesc}
                    onChange={(e) => setNewViewDesc(e.target.value)}
                    placeholder="Optional notes on signals and fidelity mode…"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-[#111B37]"
                  />
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-[#334568]">
                  <input
                    type="checkbox"
                    checked={newViewDefault}
                    onChange={(e) => setNewViewDefault(e.target.checked)}
                    className="rounded border-[#CBD5E1] text-[#EF1B24]"
                  />
                  <span>Set as default workspace view</span>
                </label>

                <div className="p-3 rounded-lg bg-[#F6F8FC] border border-[#E3EAF3] text-[11px] font-mono text-[#475569] space-y-1">
                  <div>Signals: {selectedSignalIds.length} selected</div>
                  <div>
                    Mode: {mode} · Range: {rangePreset} · Bucket: {bucket} ({agg})
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#E3EAF3]">
                  <Button variant="secondary" size="sm" type="button" onClick={() => setSaveModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    type="submit"
                    loading={savingView}
                    disabled={!newViewName.trim()}
                    icon={<Check className="w-3.5 h-3.5" />}
                  >
                    Save View
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
};

export default HistorianExplorerPage;
