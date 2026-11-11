import { SignalItem } from '../../types';

export type HistorianTab = 'trend' | 'query' | 'views' | 'exports';

export type HistorianMode = 'operational' | 'recorded' | 'reconstructed';

export type TimeRangePreset = '5m' | '15m' | '1h' | '6h' | '24h' | '7d' | 'custom';

export type BucketResolution = 'auto' | 'raw' | '1s' | '10s' | '1m' | '5m' | '1h';

export type AggregationFn = 'avg' | 'min' | 'max' | 'sum' | 'count' | 'first' | 'last';

export type TimeAxisMode = 'acquired_at' | 'source_time';

export const SERIES_COLORS = [
  '#2563EB', // Blue
  '#0DBA67', // FactoriX Green
  '#EF1B24', // FactoriX Red
  '#8B5CF6', // Purple
  '#F59E0B', // Amber
  '#06B6D4', // Cyan
  '#EC4899', // Pink
  '#14B8A6', // Teal
] as const;

export const MAX_SELECTED_SERIES = 8;

export interface ModeDefinition {
  id: HistorianMode;
  label: string;
  shortLabel: string;
  badge: string;
  tooltip: string;
}

export const HISTORIAN_MODES: ModeDefinition[] = [
  {
    id: 'operational',
    label: 'Operational (Raw)',
    shortLabel: 'Operational',
    badge: 'RAW STABLE',
    tooltip:
      'Every acquired observation in TDengine operational STables (op_float64, op_int64, op_bool, op_string, op_json) within the active telemetry epoch.',
  },
  {
    id: 'recorded',
    label: 'Recorded (Policy)',
    shortLabel: 'Recorded',
    badge: 'POLICY',
    tooltip:
      'Only policy-persisted rows in Managed datasets (ON_CHANGE / INTERVAL / EVERY_ACQUISITION). Unchanged intervals are compressed.',
  },
  {
    id: 'reconstructed',
    label: 'Reconstructed (Step-Hold)',
    shortLabel: 'Reconstructed',
    badge: 'STEP-HOLD',
    tooltip:
      'Truthful step-interpolated state timeline with canonical_stale_after_ms gap truncation (never fabricating GOOD across STALE/BAD gaps).',
  },
];

export const TIME_RANGE_PRESETS: Array<{ id: TimeRangePreset; label: string; ms: number }> = [
  { id: '5m', label: 'Last 5m', ms: 5 * 60 * 1000 },
  { id: '15m', label: '15m', ms: 15 * 60 * 1000 },
  { id: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

export const BUCKET_OPTIONS: Array<{ id: BucketResolution; label: string; ms: number | null }> = [
  { id: 'auto', label: 'Auto', ms: null },
  { id: 'raw', label: 'Raw', ms: 0 },
  { id: '1s', label: '1s', ms: 1000 },
  { id: '10s', label: '10s', ms: 10_000 },
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
  { id: '1h', label: '1h', ms: 3_600_000 },
];

export const AGG_OPTIONS: Array<{ id: AggregationFn; label: string }> = [
  { id: 'avg', label: 'avg' },
  { id: 'min', label: 'min' },
  { id: 'max', label: 'max' },
  { id: 'sum', label: 'sum' },
  { id: 'count', label: 'count' },
  { id: 'first', label: 'first' },
  { id: 'last', label: 'last' },
];

export interface HistorianPoint {
  id: string;
  eventUid: string;
  signalId: string;
  signalName: string;
  timestampMs: number;
  eventTime: string;
  acquiredAt: string;
  sourceTime: string | null;
  valueType: string;
  value: number | string | boolean | null;
  numericValue: number | null;
  unit: string;
  quality: 'GOOD' | 'UNCERTAIN' | 'STALE' | 'BAD' | string;
  reasonCode: string | null;
  recordKind: string;
  virtual: boolean;
  dataEpoch: number;
  datasetId?: string | null;
}

export interface QualitySegment {
  startMs: number;
  endMs: number;
  quality: 'GOOD' | 'UNCERTAIN' | 'STALE' | 'BAD';
  reasonCode?: string | null;
}

export interface SeriesStats {
  signalId: string;
  signalName: string;
  unit: string;
  color: string;
  isDiscrete: boolean;
  last: number | string | boolean | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  samples: number;
  goodPct: number;
  fidelityMode: string;
}

export interface HistorianSeriesData {
  signal: SignalItem;
  color: string;
  isDiscrete: boolean;
  points: HistorianPoint[];
  qualitySegments: QualitySegment[];
  stats: SeriesStats;
  fidelity: string;
  coverageNotes: string[];
}

export interface HistorianEventItem {
  id: string;
  timestampMs: number;
  timestamp: string;
  kind: 'QUALITY_TRANSITION' | 'STORAGE_OPERATION' | 'EPOCH_RESET' | string;
  signalId?: string;
  signalName?: string;
  designId?: string;
  fromQuality?: string;
  toQuality?: string;
  reasonCode?: string;
  summary: string;
  dataEpoch?: number;
}

export interface PublishedDatasetItem {
  id: string;
  datasetKey: string;
  displayName: string;
  designId: string;
  designName: string;
  designStatus: string;
  recordingMode: string;
  signalIds: string[];
}

export interface SavedHistorianView {
  id: string;
  name: string;
  description: string;
  mode: HistorianMode;
  range: TimeRangePreset;
  bucket: BucketResolution;
  agg: AggregationFn;
  timeAxis: TimeAxisMode;
  qualityFilter: string;
  signalIds: string[];
  designId?: string | null;
  datasetId?: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HistorianExportJob {
  id: string;
  status: 'COMPLETED' | 'RUNNING' | 'PENDING' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | string;
  fileName: string;
  format: string;
  rowCount: number;
  byteSize: number | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  mode?: string;
  signalCount?: number;
}

export function isDiscreteSignal(sig: SignalItem | undefined, valueType?: string): boolean {
  const raw = (valueType || sig?.dataType || sig?.data_type || sig?.type || '').toLowerCase();
  return (
    raw === 'boolean' ||
    raw === 'bool' ||
    raw === 'string' ||
    raw === 'text' ||
    raw === 'enum' ||
    raw === 'json'
  );
}

export function resolveBucketMs(
  bucket: BucketResolution,
  spanMs: number,
): number | null {
  if (bucket === 'raw') return null;
  if (bucket !== 'auto') {
    const found = BUCKET_OPTIONS.find((b) => b.id === bucket);
    return found?.ms ?? null;
  }
  // Auto resolution: keep raw for <= 1h, downsample for multi-hour / multi-day ranges
  if (spanMs <= 60 * 60 * 1000) return null;
  if (spanMs <= 6 * 60 * 60 * 1000) return 10_000; // 10s
  if (spanMs <= 24 * 60 * 60 * 1000) return 60_000; // 1m
  return 300_000; // 5m
}

export function buildQualitySegments(
  points: HistorianPoint[],
  startMs: number,
  endMs: number,
  staleAfterMs = 15_000,
): QualitySegment[] {
  if (points.length === 0) {
    return [];
  }
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs);
  const segments: QualitySegment[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i];
    const nextPt = sorted[i + 1];
    const segStart = Math.max(startMs, pt.timestampMs);
    const naturalEnd = nextPt ? Math.min(endMs, nextPt.timestampMs) : endMs;
    if (naturalEnd <= segStart) continue;

    const normQ = normalizeSegmentQuality(pt.quality);
    const maxHold = Math.max(staleAfterMs, 12_000);

    if (normQ === 'GOOD' || normQ === 'UNCERTAIN') {
      const validUntil = Math.min(naturalEnd, segStart + maxHold);
      if (validUntil > segStart) {
        segments.push({
          startMs: segStart,
          endMs: validUntil,
          quality: normQ,
          reasonCode: pt.reasonCode,
        });
      }
      if (naturalEnd > validUntil) {
        segments.push({
          startMs: validUntil,
          endMs: naturalEnd,
          quality: 'STALE',
          reasonCode: 'STALE_GAP_TRUNCATED',
        });
      }
    } else {
      segments.push({
        startMs: segStart,
        endMs: naturalEnd,
        quality: normQ,
        reasonCode: pt.reasonCode,
      });
    }
  }

  // Merge adjacent segments with identical quality
  const merged: QualitySegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.quality === seg.quality && Math.abs(last.endMs - seg.startMs) <= 50) {
      last.endMs = seg.endMs;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

export function normalizeSegmentQuality(q: string | undefined): 'GOOD' | 'UNCERTAIN' | 'STALE' | 'BAD' {
  const upper = (q || 'GOOD').toUpperCase();
  if (upper === 'GOOD') return 'GOOD';
  if (upper === 'UNCERTAIN' || upper === 'WARN' || upper === 'WARNING') return 'UNCERTAIN';
  if (upper === 'STALE' || upper === 'PAUSED' || upper === 'NO_DATA') return 'STALE';
  return 'BAD';
}

export function computeSeriesStats(
  signal: SignalItem,
  color: string,
  points: HistorianPoint[],
  fidelityMode: string,
): SeriesStats {
  const discrete = isDiscreteSignal(signal, points[0]?.valueType);
  const numericPts = points
    .filter((p) => p.numericValue !== null && Number.isFinite(p.numericValue))
    .map((p) => p.numericValue as number);
  const goodPts = points.filter((p) => (p.quality || '').toUpperCase() === 'GOOD');
  const lastPt = points.length > 0 ? points[points.length - 1] : null;

  const minVal = !discrete && numericPts.length > 0 ? Math.min(...numericPts) : null;
  const maxVal = !discrete && numericPts.length > 0 ? Math.max(...numericPts) : null;
  const avgVal =
    !discrete && numericPts.length > 0
      ? numericPts.reduce((acc, v) => acc + v, 0) / numericPts.length
      : null;
  const goodPct = points.length > 0 ? (goodPts.length / points.length) * 100 : 0;

  return {
    signalId: signal.id,
    signalName: signal.displayName || signal.name || signal.key || signal.id,
    unit: signal.unit || points[0]?.unit || '',
    color,
    isDiscrete: discrete,
    last: lastPt ? lastPt.value : (signal.currentValue ?? signal.value ?? null),
    min: minVal,
    max: maxVal,
    avg: avgVal,
    samples: points.length,
    goodPct,
    fidelityMode,
  };
}

export function buildTdengineSqlPreview(params: {
  signalIds: string[];
  datasetKey?: string | null;
  mode: HistorianMode;
  timeAxis: TimeAxisMode;
  startIso: string;
  endIso: string;
  qualityFilter: string;
  bucket: BucketResolution;
  agg: AggregationFn;
  limit: number;
}): string {
  const timeCol = params.timeAxis === 'source_time' ? '`source_time`' : '`ts`';
  const tableTarget =
    params.mode === 'recorded' && params.datasetKey
      ? `\`fx_t_<tenant>\`.\`md_${params.datasetKey.replace(/[^a-zA-Z0-9_]/g, '_')}\``
      : '`fx_t_<tenant>`.`op_float64`';

  const sigClause =
    params.signalIds.length > 0
      ? ` AND \`signal_id\` IN (${params.signalIds
          .slice(0, 4)
          .map((id) => `'${id.slice(0, 8)}…'`)
          .join(', ')}${params.signalIds.length > 4 ? `, /* +${params.signalIds.length - 4} more */` : ''})`
      : '';

  const qualClause =
    params.qualityFilter && params.qualityFilter !== 'ALL'
      ? ` AND \`raw_quality\` = '${params.qualityFilter}'`
      : '';

  const startMs = Date.parse(params.startIso) || Date.now() - 900_000;
  const endMs = Date.parse(params.endIso) || Date.now();
  const bucketMs = resolveBucketMs(params.bucket, Math.max(1000, endMs - startMs));

  if (bucketMs && bucketMs > 0) {
    const fnSql = params.agg.toUpperCase();
    return [
      `-- Read-only TDengine Parameterized Query Preview (${params.mode.toUpperCase()})`,
      `SELECT _WSTART AS \`bucket_ts\`, \`signal_id\`, ${fnSql}(\`val\`) AS \`${params.agg}_val\`, COUNT(\`val\`) AS \`samples\``,
      `FROM ${tableTarget}`,
      `WHERE ${timeCol} >= '${params.startIso}' AND ${timeCol} < '${params.endIso}'`,
      `  AND \`data_epoch\` >= :active_epoch${sigClause}${qualClause}`,
      `PARTITION BY \`signal_id\` INTERVAL(${bucketMs}a) FILL(NONE)`,
      `ORDER BY \`bucket_ts\` ASC LIMIT ${params.limit};`,
    ].join('\n');
  }

  return [
    `-- Read-only TDengine Parameterized Query Preview (${params.mode.toUpperCase()})`,
    `SELECT \`ts\`, \`val\`, \`acquired_at\`, \`source_time\`, \`raw_quality\`, \`reason_code\`, \`event_uid\`, \`record_kind\`, \`data_epoch\``,
    `FROM ${tableTarget}`,
    `WHERE ${timeCol} >= '${params.startIso}' AND ${timeCol} < '${params.endIso}'`,
    `  AND \`data_epoch\` >= :active_epoch${sigClause}${qualClause}`,
    `ORDER BY ${timeCol} ASC LIMIT ${params.limit};`,
  ].join('\n');
}
