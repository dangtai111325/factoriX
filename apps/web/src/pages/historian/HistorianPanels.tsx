/** Historian sub-panels: statistics, records table, events list, exports, inspector, saved-view dialogs. */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ArrowDownWideNarrow, ArrowUpWideNarrow, Download, ExternalLink, FileJson, FileSpreadsheet, RefreshCw, RotateCcw, Trash2, ZoomIn } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { StatusBadge } from '../../components/common/StatusBadge';
import type { ExportJob, SavedView } from '../../lib/storagePhysicalApi';
import {
  computeStats,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatValue,
  HistorianMode,
  Pt,
  Series,
  SeriesStats,
  TZ_LABEL,
} from './historianModel';
import { Banner, CopyButton, Dialog, EmptyState, fieldCls, labelCls, selectCls, SideDrawer } from './hsUi';
import { QUALITY_COLORS } from './HistorianTrendChart';

// ------------------------------------------------------------------ helpers

export const RECORD_KIND_TEXT: Record<string, string> = {
  RAW_OPERATIONAL: 'Raw reading',
  MANAGED_RECORDED: 'Recorded row',
  AGGREGATE: 'Bucket (average)',
  MODEL_SAMPLE: 'Model sample',
  RECONSTRUCTED: 'Reconstructed',
};

function qualityBadge(q: string) {
  if (!q) return <span className="text-[#94A3B8]">—</span>;
  return <StatusBadge status={q} />;
}

const thBtn = 'inline-flex items-center gap-1 hover:text-[#111B37]';

// ------------------------------------------------------------------ statistics

export const StatsTable: React.FC<{
  series: Series[];
  compare: Series[];
  compareLabel?: string;
  mode: HistorianMode;
  startMs: number;
  endMs: number;
  hidden: string[];
}> = ({ series, compare, compareLabel, mode, startMs, endMs, hidden }) => {
  const rows = useMemo(
    () =>
      series.map((s) => {
        const st = computeStats(s, mode, startMs, endMs);
        const c = compare.find((x) => x.token === s.token);
        const cst = c ? computeStats(c, mode, startMs, endMs) : null;
        return { s, st, cst };
      }),
    [series, compare, mode, startMs, endMs],
  );
  if (!rows.length) return null;
  const changeOnly = mode !== 'operational';
  const num = (v: number | null, unit?: string) => (v == null ? '—' : `${formatNumber(v)}${unit ? ` ${unit}` : ''}`);
  const delta = (a: number | null, b: number | null) => {
    if (a == null || b == null) return null;
    const d = a - b;
    return (
      <span className={`block text-[10px] ${d > 0 ? 'text-emerald-700' : d < 0 ? 'text-red-700' : 'text-[#657794]'}`}>
        {d > 0 ? '+' : ''}
        {formatNumber(d)} vs {compareLabel || 'compare'}
      </span>
    );
  };
  return (
    <div className="overflow-x-auto border border-[#E3EAF3] rounded-lg">
      <table className="fx-table min-w-[860px]">
        <thead>
          <tr>
            <th>Series</th>
            <th className="text-right">Last</th>
            <th className="text-right">Min</th>
            <th className="text-right">Max</th>
            <th className="text-right">Average</th>
            <th className="text-right" title={changeOnly ? 'Stored rows (change-only data: one row per change)' : 'Raw readings in the window'}>
              {changeOnly ? 'Rows / changes' : 'Readings'}
            </th>
            <th className="text-right" title="Share of rows with GOOD quality">Good</th>
            <th className="text-right" title="Periods with no reading longer than the expected interval (raw readings only)">Gaps</th>
            <th className="text-right" title="Share of the window covered by readings">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ s, st, cst }) => (
            <StatsRow key={s.token} s={s} st={st} cst={cst} hidden={hidden.includes(s.token)} num={num} delta={delta} changeOnly={changeOnly} />
          ))}
        </tbody>
      </table>
    </div>
  );
};

const StatsRow: React.FC<{
  s: Series;
  st: SeriesStats;
  cst: SeriesStats | null;
  hidden: boolean;
  num: (v: number | null, unit?: string) => string;
  delta: (a: number | null, b: number | null) => React.ReactNode;
  changeOnly: boolean;
}> = ({ s, st, cst, hidden, num, delta, changeOnly }) => (
  <tr className={hidden ? 'opacity-50' : ''}>
    <td className="max-w-[260px]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden="true" />
        <span className="truncate font-semibold text-[#111B37]" title={s.label}>
          {s.label}
        </span>
      </div>
      <div className="text-[11px] text-[#94A3B8] pl-4">
        {[s.valueType.toLowerCase(), s.unit, s.downsampled && s.bucketMs ? `buckets of ${formatDuration(s.bucketMs)}` : ''].filter(Boolean).join(' · ')}
      </div>
    </td>
    <td className="text-right tabular-nums whitespace-nowrap">
      <span className="font-semibold text-[#111B37]">{formatValue(st.last, s.unit)}</span>
      {st.lastTs && <span className="block text-[10px] text-[#94A3B8]">{formatDateTime(st.lastTs)}</span>}
    </td>
    {s.discrete ? (
      <td colSpan={3} className="text-right text-[12px] text-[#657794]">
        {st.distinct != null ? `${st.distinct} distinct value${st.distinct === 1 ? '' : 's'}` : 'Not applicable (text / state)'}
      </td>
    ) : (
      <>
        <td className="text-right tabular-nums whitespace-nowrap">{num(st.min, s.unit)}</td>
        <td className="text-right tabular-nums whitespace-nowrap">{num(st.max, s.unit)}</td>
        <td className="text-right tabular-nums whitespace-nowrap">
          {num(st.avg, s.unit)}
          {cst && delta(st.avg, cst.avg)}
        </td>
      </>
    )}
    <td className="text-right tabular-nums whitespace-nowrap">
      {st.count.toLocaleString()}
      {changeOnly && st.changes != null && <span className="block text-[10px] text-[#94A3B8]">{st.changes} changes</span>}
      {!changeOnly && (s.discrete || s.integer) && st.changes != null && <span className="block text-[10px] text-[#94A3B8]">{st.changes} changes</span>}
    </td>
    <td className="text-right tabular-nums whitespace-nowrap">{st.goodPct == null ? '—' : `${st.goodPct.toFixed(st.goodPct >= 99.95 || st.goodPct === 0 ? 0 : 1)} %`}</td>
    <td className="text-right tabular-nums whitespace-nowrap">
      {st.gaps == null ? <span className="text-[#94A3B8]" title="Change-only data is silent by design">n/a</span> : st.gaps}
      {st.longestGapMs ? <span className="block text-[10px] text-[#94A3B8]">longest {formatDuration(st.longestGapMs)}</span> : null}
    </td>
    <td className="text-right tabular-nums whitespace-nowrap">{st.coveragePct == null ? '—' : `${st.coveragePct.toFixed(st.coveragePct >= 99.95 ? 0 : 1)} %`}</td>
  </tr>
);

// ------------------------------------------------------------------ records

interface RecordRow {
  s: Series;
  p: Pt;
}

export const RecordsTable: React.FC<{
  series: Series[];
  onInspect: (s: Series, p: Pt) => void;
  onZoomRaw: () => void;
}> = ({ series, onInspect, onZoomRaw }) => {
  const [seriesFilter, setSeriesFilter] = useState('');
  const [qualityFilter, setQualityFilter] = useState('');
  const [newestFirst, setNewestFirst] = useState(true);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const rows: RecordRow[] = useMemo(() => {
    const out: RecordRow[] = [];
    for (const s of series) {
      if (seriesFilter && s.token !== seriesFilter) continue;
      for (const p of s.points) if (!qualityFilter || (qualityFilter === 'NONE' ? !p.q : p.q === qualityFilter)) out.push({ s, p });
    }
    out.sort((a, b) => (newestFirst ? b.p.t - a.p.t : a.p.t - b.p.t));
    return out;
  }, [series, seriesFilter, qualityFilter, newestFirst]);
  useEffect(() => setPage(0), [seriesFilter, qualityFilter, newestFirst, pageSize, series]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
  const aggregated = series.some((s) => s.downsampled);
  const truncated = series.filter((s) => s.truncated);
  const qualities = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.q)))).filter(Boolean).sort();

  return (
    <div className="space-y-3">
      {aggregated && (
        <Banner tone="info" action={<Button size="sm" variant="outline" onClick={onZoomRaw}>Show the last 15 minutes</Button>}>
          This window is too long to list every stored row, so the rows below are time buckets (average, with min/max and the number of rows per
          bucket). Zoom in on the chart or pick a shorter range to see each stored row.
        </Banner>
      )}
      {truncated.length > 0 && (
        <Banner tone="warning">
          {truncated.map((s) => s.label).join(', ')}: only the most recent {truncated[0].points.length.toLocaleString()} of {truncated[0].total.toLocaleString()} rows are
          listed. Narrow the range to see all rows, or export them (exports contain every row).
        </Banner>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={seriesFilter} onChange={(e) => setSeriesFilter(e.target.value)} aria-label="Filter by series">
          <option value="">All series</option>
          {series.map((s) => (
            <option key={s.token} value={s.token}>
              {s.label}
            </option>
          ))}
        </select>
        <select className={selectCls} value={qualityFilter} onChange={(e) => setQualityFilter(e.target.value)} aria-label="Filter by quality">
          <option value="">All qualities</option>
          {qualities.map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
          <option value="NONE">No quality stored</option>
        </select>
        <span className="text-[11px] text-[#657794] ml-auto" aria-live="polite">
          {rows.length.toLocaleString()} {aggregated ? 'rows/buckets' : 'rows'} · times in {TZ_LABEL}
        </span>
      </div>
      <div className="overflow-x-auto border border-[#E3EAF3] rounded-lg">
        <table className="fx-table min-w-[820px]">
          <thead>
            <tr>
              <th>
                <button type="button" className={thBtn} onClick={() => setNewestFirst((v) => !v)} aria-label={`Sort by time, ${newestFirst ? 'newest first' : 'oldest first'}`}>
                  Time {newestFirst ? <ArrowDownWideNarrow className="w-3.5 h-3.5" /> : <ArrowUpWideNarrow className="w-3.5 h-3.5" />}
                </button>
              </th>
              <th>Series</th>
              <th className="text-right">Value</th>
              <th>Quality</th>
              <th>Record</th>
              <th>Source time</th>
              <th className="w-10" aria-label="Inspect" />
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-[#657794]">
                  No rows match.
                </td>
              </tr>
            ) : (
              slice.map(({ s, p }, i) => (
                <tr
                  key={`${s.token}-${p.t}-${i}`}
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => onInspect(s, p)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onInspect(s, p);
                  }}
                >
                  <td className="whitespace-nowrap tabular-nums font-mono text-[12px]" title={new Date(p.t).toISOString()}>
                    {formatDateTime(p.t, true)}
                  </td>
                  <td className="max-w-[240px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden="true" />
                      <span className="truncate" title={s.label}>
                        {s.label}
                      </span>
                    </div>
                  </td>
                  <td className="text-right tabular-nums whitespace-nowrap font-semibold text-[#111B37]">
                    {formatValue(p.raw, s.unit)}
                    {p.min != null && p.max != null && (
                      <span className="block text-[10px] font-normal text-[#657794]">
                        {formatNumber(p.min)}–{formatNumber(p.max)} · {p.count ?? '?'} rows
                      </span>
                    )}
                  </td>
                  <td>{qualityBadge(p.q)}</td>
                  <td className="whitespace-nowrap text-[12px]">
                    {RECORD_KIND_TEXT[p.kind] || p.kind || '—'}
                    {p.virtual && <span className="ml-1 text-[10px] text-amber-700">(drawn, not stored)</span>}
                  </td>
                  <td className="whitespace-nowrap tabular-nums text-[12px]">{p.sourceTime ? formatDateTime(Date.parse(p.sourceTime), true) : <span className="text-[#94A3B8]">—</span>}</td>
                  <td>
                    <ExternalLink className="w-3.5 h-3.5 text-[#94A3B8]" aria-hidden="true" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#657794]">
        <label className="inline-flex items-center gap-2">
          Rows per page
          <select className={selectCls} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {[25, 50, 100, 250].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <span className="tabular-nums">
            {rows.length ? `${(page * pageSize + 1).toLocaleString()}–${Math.min(rows.length, (page + 1) * pageSize).toLocaleString()} of ${rows.length.toLocaleString()}` : '0 rows'}
          </span>
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(0)}>
            First
          </Button>
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ events

export interface EventRow {
  id: string;
  t: number;
  kind: 'quality' | 'gap' | 'reset' | 'storage';
  series?: Series;
  title: string;
  detail?: string;
}

const EVENT_KIND_LABEL: Record<EventRow['kind'], string> = { quality: 'Quality change', gap: 'No data', reset: 'Telemetry reset', storage: 'Storage change' };

export const EventsList: React.FC<{ events: EventRow[]; onJump: (e: EventRow) => void }> = ({ events, onJump }) => {
  const [kinds, setKinds] = useState<Set<EventRow['kind']>>(new Set(['quality', 'gap', 'reset']));
  const shown = events.filter((e) => kinds.has(e.kind));
  const counts = (k: EventRow['kind']) => events.filter((e) => e.kind === k).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Event types">
        {(Object.keys(EVENT_KIND_LABEL) as EventRow['kind'][]).map((k) => {
          const on = kinds.has(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setKinds((prev) => {
                  const n = new Set(prev);
                  if (n.has(k)) n.delete(k);
                  else n.add(k);
                  return n;
                })
              }
              className={`h-8 px-3 rounded-lg border text-[12px] font-semibold ${on ? 'bg-[#111B37] text-white border-[#111B37]' : 'bg-white text-[#334568] border-[#D4DFEC] hover:bg-[#F8FAFC]'}`}
            >
              {EVENT_KIND_LABEL[k]} ({counts(k)})
            </button>
          );
        })}
        <span className="text-[11px] text-[#657794] ml-auto">Storage changes and resets are appliance-wide; quality changes and gaps come from the selected series.</span>
      </div>
      {shown.length === 0 ? (
        <EmptyState dashed title="No events in this window">
          Quality changes, periods without data and telemetry resets of the selected series appear here.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-[#E3EAF3] rounded-lg">
          <table className="fx-table min-w-[720px]">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Series</th>
                <th>What happened</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap tabular-nums font-mono text-[12px]">{formatDateTime(e.t)}</td>
                  <td className="whitespace-nowrap">{EVENT_KIND_LABEL[e.kind]}</td>
                  <td className="max-w-[220px]">
                    {e.series ? (
                      <span className="inline-flex items-center gap-1.5 min-w-0">
                        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: e.series.color }} aria-hidden="true" />
                        <span className="truncate">{e.series.label}</span>
                      </span>
                    ) : (
                      <span className="text-[#94A3B8]">All</span>
                    )}
                  </td>
                  <td>
                    {e.title}
                    {e.detail && <span className="block text-[11px] text-[#657794]">{e.detail}</span>}
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" icon={<ZoomIn className="w-3.5 h-3.5" />} onClick={() => onJump(e)}>
                      Show
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ exports

const EXPORT_STATUS: Record<string, { status: string; label: string }> = {
  COMPLETED: { status: 'GOOD', label: 'Ready' },
  READY: { status: 'GOOD', label: 'Ready' },
  RUNNING: { status: 'WARN', label: 'Running' },
  PENDING: { status: 'WARN', label: 'Queued' },
  QUEUED: { status: 'WARN', label: 'Queued' },
  FAILED: { status: 'ERROR', label: 'Failed' },
  ERROR: { status: 'ERROR', label: 'Failed' },
  CANCELLED: { status: 'DISABLED', label: 'Cancelled' },
  EXPIRED: { status: 'STALE', label: 'Expired' },
};

export function exportTitle(j: ExportJob, labelOf: (token: string) => string): string {
  if (j.title) return j.title;
  const q = (j.query_spec || {}) as Record<string, unknown>;
  const sources = (Array.isArray(q.sources) ? q.sources : q.source_id ? [q.source_id] : []) as string[];
  const names = (j.series && j.series.length ? j.series : sources.map((s) => labelOf(String(s).replace(/^sig:/, '')))).filter(Boolean);
  const from = (j.start || q.start || q.from_ts) as string | undefined;
  const to = (j.end || q.end || q.to_ts) as string | undefined;
  const who = names.length ? (names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')) : 'Historian export';
  const when = from && to ? ` · ${formatDateTime(Date.parse(from))} → ${formatDateTime(Date.parse(to))}` : '';
  return `${who}${when}`;
}

export const ExportsPanel: React.FC<{
  jobs: ExportJob[] | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onRetry: (j: ExportJob) => void;
  labelOf: (token: string) => string;
  canExport: boolean;
  exporting: boolean;
  onExport: (fmt: 'csv' | 'json') => void;
  summary: string;
}> = ({ jobs, loading, error, onReload, onRetry, labelOf, canExport, exporting, onExport, summary }) => (
  <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E3EAF3] bg-[#F8FAFC] p-4">
      <div className="min-w-0">
        <h3 className="text-[14px] font-bold text-[#111B37]">Export the current selection</h3>
        <p className="text-[12px] text-[#657794] mt-0.5">{summary}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" icon={<FileSpreadsheet className="w-3.5 h-3.5" />} disabled={!canExport || exporting} onClick={() => onExport('csv')}>
          Export CSV
        </Button>
        <Button variant="outline" size="sm" icon={<FileJson className="w-3.5 h-3.5" />} disabled={!canExport || exporting} onClick={() => onExport('json')}>
          Export JSON
        </Button>
      </div>
    </div>
    <div className="flex items-center justify-between">
      <h3 className="text-[14px] font-bold text-[#111B37]">Recent exports</h3>
      <Button size="sm" variant="ghost" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={onReload}>
        Reload
      </Button>
    </div>
    {error && <Banner tone="error">{error}</Banner>}
    {jobs && jobs.length === 0 ? (
      <EmptyState dashed title="No exports yet">
        Exports contain every stored row of the window (not the chart’s buckets). Files are kept for 7 days.
      </EmptyState>
    ) : (
      <div className="overflow-x-auto border border-[#E3EAF3] rounded-lg">
        <table className="fx-table min-w-[820px]">
          <thead>
            <tr>
              <th>Export</th>
              <th>Format</th>
              <th>Status</th>
              <th className="text-right">Rows</th>
              <th className="text-right">Size</th>
              <th>Created</th>
              <th>Expires</th>
              <th className="w-32"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {(jobs || []).map((j) => {
              const st = EXPORT_STATUS[String(j.status).toUpperCase()] || { status: 'UNKNOWN', label: j.status };
              const ready = st.label === 'Ready' && j.download_url;
              return (
                <tr key={j.id}>
                  <td className="max-w-[300px]">
                    <div className="truncate font-semibold text-[#111B37]" title={exportTitle(j, labelOf)}>
                      {exportTitle(j, labelOf)}
                    </div>
                    <div className="text-[11px] text-[#94A3B8] truncate font-mono">{j.file_name || j.id}</div>
                    {j.truncated_series && j.truncated_series.length > 0 && <div className="text-[11px] text-amber-700">Row limit reached for {j.truncated_series.join(', ')}</div>}
                    {j.error_message && <div className="text-[11px] text-red-700">{j.error_message}</div>}
                  </td>
                  <td className="uppercase text-[12px] font-semibold">{j.format}</td>
                  <td>
                    <StatusBadge status={st.status} label={st.label} />
                  </td>
                  <td className="text-right tabular-nums">{j.row_count == null ? '—' : j.row_count.toLocaleString()}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatBytes(j.byte_size)}</td>
                  <td className="whitespace-nowrap tabular-nums text-[12px]">{j.created_at ? formatDateTime(Date.parse(j.created_at)) : '—'}</td>
                  <td className="whitespace-nowrap tabular-nums text-[12px]">{j.expires_at ? formatDateTime(Date.parse(j.expires_at)) : '—'}</td>
                  <td className="text-right whitespace-nowrap">
                    {ready ? (
                      <a
                        href={j.download_url || undefined}
                        download={j.file_name || undefined}
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[#D4DFEC] bg-white text-[12px] font-semibold text-[#334568] hover:bg-[#F9FAFD]"
                      >
                        <Download className="w-3.5 h-3.5" /> Download
                      </a>
                    ) : (
                      ['Failed', 'Expired', 'Cancelled'].includes(st.label) && (
                        <Button size="sm" variant="outline" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => onRetry(j)}>
                          Run again
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

// ------------------------------------------------------------------ inspector

export const PointInspector: React.FC<{
  target: { s: Series; p: Pt } | null;
  onClose: () => void;
  onZoom: (t: number) => void;
}> = ({ target, onClose, onZoom }) => {
  const navigate = useNavigate();
  if (!target) return null;
  const { s, p } = target;
  const token = s.token;
  const kind = token.startsWith('mod:') ? 'model_field' : token.startsWith('subtable:') ? 'subtable' : 'signal';
  const modelId = kind === 'model_field' ? token.split(':')[1] : null;
  const tableRef = kind === 'subtable' ? token.slice('subtable:'.length).split(':')[0] : null;
  const row = (label: string, value: React.ReactNode, mono = false) => (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-2 py-1.5 border-b border-[#F1F5FA] text-[12px]">
      <dt className="text-[#657794]">{label}</dt>
      <dd className={`text-[#111B37] break-words ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</dd>
    </div>
  );
  return (
    <SideDrawer
      open
      onClose={onClose}
      title={formatValue(p.raw, s.unit)}
      eyebrow={
        <span className="inline-flex items-center gap-1.5 min-w-0 text-[12px] text-[#334568]">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden="true" />
          <span className="truncate">{s.label}</span>
        </span>
      }
      subtitle={`${formatDateTime(p.t, true)} · ${TZ_LABEL}`}
      actions={
        <>
          <Button size="sm" variant="outline" icon={<ZoomIn className="w-3.5 h-3.5" />} onClick={() => onZoom(p.t)}>
            Zoom here
          </Button>
          {kind === 'signal' && (
            <Button size="sm" variant="outline" icon={<Activity className="w-3.5 h-3.5" />} onClick={() => navigate(`/collector/signals?signalId=${encodeURIComponent(token)}`)}>
              Open signal
            </Button>
          )}
          {modelId && (
            <Button size="sm" variant="outline" icon={<ExternalLink className="w-3.5 h-3.5" />} onClick={() => navigate(`/models?model=${encodeURIComponent(modelId)}`)}>
              Open data model
            </Button>
          )}
          {tableRef && (
            <Button size="sm" variant="outline" icon={<ExternalLink className="w-3.5 h-3.5" />} onClick={() => navigate(`/historian/storage/object/${encodeURIComponent(`subtable:${tableRef}`)}`)}>
              Open table
            </Button>
          )}
        </>
      }
    >
      <dl className="px-4 py-3">
        {row('Value', <span className="font-semibold">{formatValue(p.raw, s.unit)}</span>)}
        {p.min != null && p.max != null && row('Bucket', `${p.count ?? '?'} rows · min ${formatNumber(p.min)} · max ${formatNumber(p.max)}`)}
        {row('Quality', p.q ? <span className="inline-flex items-center gap-2"><StatusBadge status={p.q} />{p.reason && <span className="font-mono text-[11px] text-[#657794]">{p.reason}</span>}</span> : 'Not stored for this row')}
        {row('Time (local)', formatDateTime(p.t, true))}
        {row('Time (UTC)', new Date(p.t).toISOString(), true)}
        {p.originalTs && row('Real time (compare)', p.originalTs, true)}
        {row('Source time', p.sourceTime || '—', true)}
        {row('Record', `${RECORD_KIND_TEXT[p.kind] || p.kind || '—'}${p.virtual ? ' — drawn for display, not a stored row' : ''}`)}
        {row('Series', s.label)}
        {row('Type / unit', [s.valueType || '—', s.unit].filter(Boolean).join(' · '))}
        {p.epoch != null && row('Data epoch', String(p.epoch))}
        {p.uid && row('Event UID', <span className="inline-flex items-center gap-2"><span className="font-mono text-[11px]">{p.uid}</span><CopyButton text={p.uid} /></span>)}
        {row('Series token', <span className="inline-flex items-center gap-2 min-w-0"><span className="font-mono text-[11px] break-all">{token}</span><CopyButton text={token} /></span>)}
      </dl>
      {s.notes.length > 0 && (
        <div className="px-4 pb-4">
          <Banner tone="info">{Array.from(new Set(s.notes)).join(' ')}</Banner>
        </div>
      )}
    </SideDrawer>
  );
};

// ------------------------------------------------------------------ saved views

export const SaveViewDialog: React.FC<{
  open: boolean;
  initialName: string;
  current: SavedView | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (name: string, description: string, asNew: boolean) => void;
}> = ({ open, initialName, current, busy, error, onClose, onSave }) => {
  const [name, setName] = useState(initialName);
  const [desc, setDesc] = useState('');
  useEffect(() => {
    if (open) {
      setName(current?.name || initialName);
      setDesc(current?.description || '');
    }
  }, [open, current, initialName]);
  const valid = name.trim().length > 0 && name.trim().length <= 120;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      title={current ? 'Save view' : 'Save as a view'}
      subtitle="Saves the series, time range (relative ranges stay relative), mode, comparison and chart layout."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {current && (
            <Button variant="outline" size="sm" onClick={() => onSave(name.trim(), desc.trim(), true)} disabled={!valid || busy}>
              Save as new view
            </Button>
          )}
          <Button variant="primary" size="sm" loading={busy} onClick={() => onSave(name.trim(), desc.trim(), false)} disabled={!valid || busy}>
            {current ? `Update “${current.name}”` : 'Save view'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) onSave(name.trim(), desc.trim(), !current);
        }}
      >
        {error && <Banner tone="error">{error}</Banner>}
        <div>
          <label htmlFor="hv-name" className={labelCls}>
            Name <span className="text-red-600">*</span>
          </label>
          <input id="hv-name" className={fieldCls} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. AA10 spindle speeds, last 24 h" />
        </div>
        <div>
          <label htmlFor="hv-desc" className={labelCls}>
            Description
          </label>
          <textarea
            id="hv-desc"
            rows={2}
            maxLength={500}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full px-3 py-2 border border-[#D4DFEC] rounded-lg text-[13px] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </form>
    </Dialog>
  );
};

export const ViewsDialog: React.FC<{
  open: boolean;
  views: SavedView[] | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpen: (v: SavedView) => void;
  onDelete: (v: SavedView) => void;
  onReload: () => void;
  currentId?: string | null;
}> = ({ open, views, loading, error, onClose, onOpen, onDelete, onReload, currentId }) => {
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const list = (views || []).filter((v) => !q || `${v.name} ${v.description || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title="Saved views"
      subtitle="Open a saved selection of series, range and chart settings."
      footer={
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <input className={fieldCls} placeholder="Search views" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search views" />
          <Button size="md" variant="outline" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={onReload}>
            Reload
          </Button>
        </div>
        {error && <Banner tone="error">{error}</Banner>}
        {views && list.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-[#657794]">{views.length ? 'No view matches.' : 'No saved views yet. Use “Save view” to keep the current selection.'}</p>
        ) : (
          <ul className="divide-y divide-[#F1F5FA] border border-[#E3EAF3] rounded-lg">
            {list.map((v) => {
              const n = Array.isArray(v.query_spec?.sources) ? v.query_spec.sources.length : 0;
              const range = v.query_spec?.range ? `last ${v.query_spec.range}` : v.query_spec?.start ? 'fixed window' : '';
              return (
                <li key={v.id} className="flex items-center gap-3 px-3 py-2.5">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(v)}>
                    <div className="font-semibold text-[13px] text-[#111B37] truncate">
                      {v.name} {currentId === v.id && <span className="text-[11px] font-normal text-[#2A82E7]">(open)</span>}
                    </div>
                    <div className="text-[11px] text-[#657794] truncate">
                      {[`${n} series`, range, v.query_spec?.mode, v.description].filter(Boolean).join(' · ')} · updated {formatDateTime(Date.parse(v.updated_at))}
                    </div>
                  </button>
                  {confirm === v.id ? (
                    <span className="flex items-center gap-1.5">
                      <Button size="sm" variant="danger" onClick={() => { setConfirm(null); onDelete(v); }}>
                        Delete
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => onOpen(v)}>
                        Open
                      </Button>
                      <button type="button" aria-label={`Delete view ${v.name}`} title="Delete view" className="p-1.5 rounded text-[#657794] hover:bg-red-50 hover:text-red-700" onClick={() => setConfirm(v.id)}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
};

export { QUALITY_COLORS };
