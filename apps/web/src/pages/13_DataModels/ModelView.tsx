// Model view: live full body (pretty / compact, copy, download), fields table, recent snapshots and the
// "Outputs — coming soon" placeholder.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Clock, Copy, CopyPlus, Download, Pause, Pencil, Play, Radio, RefreshCw, Send, Trash2 } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { errorText, getModel, getSnapshots } from './api';
import { useCatalog, useModelBody } from './hooks';
import { downloadText, formatJsonText, nodeAt, nodeText, safeFileName, tryParse } from './json';
import { signalRef, signalTooltip } from './rules';
import { errorsByUid, flatten, fromApi } from './spec';
import type { FieldNode, ModelDetail, ModelListItem, Snapshot } from './types';
import { isContainer } from './types';
import { RuleText } from './wizard/RuleEditor';
import { Banner, CopyButton, JsonBlock, Skeleton, StateChip, sampleLabel, timeAgo, useNow } from './ui';

interface Props {
  modelId: string;
  /** List row, shown while the detail loads. */
  summary: ModelListItem | null;
  refreshToken: number;
  busy: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDuplicate: (m: ModelListItem) => void;
  onDuplicateToMachines: (m: ModelListItem) => void;
  onToggleRunning: (m: ModelListItem) => void;
  onDelete: (m: ModelListItem) => void;
}

export const ModelView: React.FC<Props> = ({ modelId, summary, refreshToken, busy, onBack, onEdit, onDuplicate, onDuplicateToMachines, onToggleRunning, onDelete }) => {
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pretty, setPretty] = useState(true);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [openSnap, setOpenSnap] = useState<string | null>(null);
  const { index } = useCatalog();
  const now = useNow(1000);

  const load = useCallback(async () => {
    try {
      setDetail(await getModel(modelId));
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Could not load the model.'));
    }
  }, [modelId]);
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const info: ModelListItem | null = detail || summary;
  const running = info?.state === 'RUNNING';
  const live = useModelBody(modelId, { enabled: Boolean(info), initial: detail?.latest?.body ?? summary?.latest_body ?? null, pollMs: Math.max(1000, info?.sample_ms || 1000) });
  const body = live.body ?? detail?.latest?.body ?? null;
  const errors = live.errors.length ? live.errors : detail?.latest?.errors || [];

  const loadSnapshots = useCallback(async () => {
    try {
      setSnapshots(await getSnapshots(modelId, 20));
      setSnapError(null);
    } catch (err) {
      setSnapError(errorText(err, 'Could not load recent snapshots.'));
    }
  }, [modelId]);
  useEffect(() => {
    void loadSnapshots();
    if (!running) return;
    const t = window.setInterval(() => void loadSnapshots(), Math.max(5000, info?.sample_ms || 0));
    return () => window.clearInterval(t);
  }, [loadSnapshots, running, info?.sample_ms, refreshToken]);

  const root = useMemo(() => (detail ? fromApi(detail.spec) : null), [detail]);
  const parsed = useMemo(() => tryParse(body), [body]);
  const issueMap = useMemo(() => (root ? errorsByUid(root, [...(detail?.issues || []), ...errors]) : new Map()), [root, detail, errors]);
  const rows = useMemo(() => (root ? flatten(root) : []), [root]);

  const displayBody = body ? formatJsonText(body, pretty) : null;

  if (error && !info) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={onBack}>
          Data models
        </Button>
        <Banner tone="error" action={<Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Banner>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={onBack}>
          Data models
        </Button>
        <div className="min-w-0 flex-1">
          {info ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[20px] font-bold text-[#111B37] truncate">{info.name}</h1>
                <StateChip state={info.state} size="md" />
              </div>
              {info.description && <p className="text-[13px] text-[#657794]">{info.description}</p>}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#334568]">
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-slate-400" /> every {sampleLabel(info.sample_ms)}
                </span>
                <span>{info.field_count} fields</span>
                <span>{info.ref_count} references</span>
                {info.machines.length > 0 && <span>Resources: {info.machines.join(', ')}</span>}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-6 w-64" />
              <Skeleton className="h-3 w-40" />
            </div>
          )}
        </div>
        {info && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" icon={running ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />} disabled={busy} onClick={() => onToggleRunning(info)}>
              {running ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="outline" size="sm" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => onDuplicate(info)}>
              Duplicate…
            </Button>
            <Button variant="outline" size="sm" icon={<CopyPlus className="w-3.5 h-3.5" />} onClick={() => onDuplicateToMachines(info)}>
              Duplicate to machines…
            </Button>
            <Button variant="danger" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => onDelete(info)}>
              Delete
            </Button>
            <Button variant="primary" size="sm" icon={<Pencil className="w-3.5 h-3.5" />} onClick={onEdit}>
              Edit
            </Button>
          </div>
        )}
      </div>

      {error && info && <Banner tone="warning">{error}</Banner>}
      {(detail?.issues || []).some((i) => i.severity !== 'warning' || i.code === 'MISSING_REF') && (
        <Banner tone="warning">
          Some references point to deleted or archived data. Those fields output null; the model keeps running. Edit the model to fix them.
        </Banner>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-4">
        <section aria-label="Live body" className="bg-white border border-[#CBD5E1] rounded-xl p-4 flex flex-col min-h-[360px]">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h2 className="text-[14px] font-bold text-[#111B37] mr-auto inline-flex items-center gap-2">
              Live body
              {running && live.stream === 'open' && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#0DBA67] animate-pulse" /> live
                </span>
              )}
            </h2>
            <div role="group" aria-label="Format" className="inline-flex rounded-md border border-[#D4DFEC] overflow-hidden text-[11px] font-semibold">
              <button type="button" aria-pressed={pretty} onClick={() => setPretty(true)} className={`px-2 h-7 ${pretty ? 'bg-[#111B37] text-white' : 'bg-white text-[#334568]'}`}>
                Pretty
              </button>
              <button type="button" aria-pressed={!pretty} onClick={() => setPretty(false)} className={`px-2 h-7 ${!pretty ? 'bg-[#111B37] text-white' : 'bg-white text-[#334568]'}`}>
                Compact
              </button>
            </div>
            <CopyButton text={displayBody} />
            <button
              type="button"
              disabled={!body}
              onClick={() => body && downloadText(`${safeFileName(info?.name || 'data-model')}.json`, formatJsonText(body, pretty))}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-semibold border border-[#D4DFEC] bg-white text-[#334568] hover:bg-[#F1F5FA] disabled:opacity-40"
            >
              <Download className="w-3 h-3" /> .json
            </button>
          </div>
          <p className="text-[11px] text-[#657794] mb-2" aria-live="polite">
            {running ? `Sampled ${timeAgo(live.sampledAt ?? info?.last_sampled_at, now)}` : 'Paused: no new body is produced. The last body is shown.'}
            {live.error && <span className="text-red-700"> · {live.error}</span>}
          </p>
          <div className="flex-1 overflow-auto rounded-lg border border-slate-200 bg-[#FBFCFE] p-3 max-h-[60vh]">
            {live.loading && !body ? (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className={`h-3 ${i % 2 ? 'w-1/2' : 'w-2/3'}`} />
                ))}
              </div>
            ) : (
              <JsonBlock text={body} pretty={pretty} ariaLabel="Live body" placeholder={running ? 'Waiting for the first sample…' : 'No body yet.'} />
            )}
          </div>
          {errors.length > 0 && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 space-y-1 max-h-32 overflow-y-auto">
              {errors.map((e, i) => (
                <p key={i} className="flex items-start gap-1.5 text-[11px] text-red-800">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>
                    {e.path && <span className="font-mono font-semibold">{e.path} </span>}
                    {e.message}
                  </span>
                </p>
              ))}
            </div>
          )}
        </section>

        <section aria-label="Recent snapshots" className="bg-white border border-[#CBD5E1] rounded-xl p-4 flex flex-col min-h-[360px]">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[14px] font-bold text-[#111B37] mr-auto">Recent snapshots</h2>
            <button type="button" onClick={() => void loadSnapshots()} className="p-1 rounded text-slate-500 hover:bg-slate-100" aria-label="Reload snapshots" title="Reload">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {snapError && <p className="text-[11px] text-red-700 mb-2">{snapError}</p>}
          <ul className="flex-1 overflow-y-auto divide-y divide-slate-100 border border-slate-100 rounded-lg max-h-[60vh]">
            {snapshots.length === 0 && <li className="px-3 py-6 text-center text-[12px] text-[#657794]">{running ? 'No snapshot yet.' : 'No snapshots.'}</li>}
            {snapshots.map((s, i) => {
              const key = `${s.id}-${i}`;
              const open = openSnap === key;
              return (
                <li key={key}>
                  <button type="button" aria-expanded={open} onClick={() => setOpenSnap(open ? null : key)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#F8FAFC]">
                    {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                    <span className="font-mono text-[11px] text-[#111B37]">{s.sampledAt ? new Date(s.sampledAt).toLocaleTimeString(undefined, { hour12: false }) : '—'}</span>
                    <span className="text-[10px] text-[#94A3B8]">{timeAgo(s.sampledAt, now)}</span>
                    {s.errorCount > 0 && <span className="ml-auto text-[10px] font-semibold text-red-700">{s.errorCount} error(s)</span>}
                    {!open && !s.errorCount && <span className="ml-auto font-mono text-[10px] text-[#657794] truncate max-w-[55%]">{formatJsonText(s.body, false).slice(0, 80)}</span>}
                  </button>
                  {open && (
                    <div className="px-3 pb-2">
                      <div className="flex justify-end mb-1">
                        <CopyButton text={formatJsonText(s.body, true)} />
                      </div>
                      <JsonBlock text={s.body} pretty className="bg-[#FBFCFE] border border-slate-200 rounded-lg p-2 max-h-72 overflow-auto" />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <section aria-label="Fields" className="bg-white border border-[#CBD5E1] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center">
          <h2 className="text-[14px] font-bold text-[#111B37]">Fields</h2>
          <span className="ml-2 text-[12px] text-[#657794]">{rows.filter((r) => !isContainer(r.node)).length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[720px]">
            <thead className="bg-[#F8FAFC] text-[10px] uppercase tracking-wide text-[#657794]">
              <tr>
                <th scope="col" className="text-left font-bold px-4 py-2">Key path</th>
                <th scope="col" className="text-left font-bold px-2 py-2">Type</th>
                <th scope="col" className="text-left font-bold px-2 py-2">Mapping / Rule</th>
                <th scope="col" className="text-left font-bold px-2 py-2">Current value</th>
                <th scope="col" className="text-left font-bold px-4 py-2">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!root &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={5} className="px-4 py-2">
                      <Skeleton className="h-3 w-full" />
                    </td>
                  </tr>
                ))}
              {rows.map((r) => {
                const n = r.node;
                const errs = issueMap.get(n.uid) || [];
                const container = isContainer(n);
                const f = container ? null : (n as FieldNode);
                const ref = f && f.mode === 'mapping' ? (f.signalId && !f.missing ? signalRef(index, f.signalId) : null) || f.refDisplay : '';
                const value = container ? '' : nodeText(nodeAt(parsed, r.segments));
                return (
                  <tr key={n.uid} className={errs.length ? 'bg-red-50/40' : ''}>
                    <td className="px-4 py-1.5 font-mono text-[#111B37] whitespace-nowrap" style={{ paddingLeft: 16 + r.depth * 14 }}>
                      {r.path || '(root)'}
                    </td>
                    <td className="px-2 py-1.5 text-[#657794]">{container ? n.type : f!.valueType}</td>
                    <td className="px-2 py-1.5 max-w-[420px]">
                      {container ? (
                        <span className="text-[#94A3B8]">{n.children.length} item(s)</span>
                      ) : f!.mode === 'mapping' ? (
                        <span className={`font-mono text-[11px] ${f!.missing ? 'text-red-700' : 'text-[#1D4ED8]'}`} title={f!.signalId && index.sigById.has(f!.signalId) ? signalTooltip(index, f!.signalId) : f!.refTooltip}>
                          {ref || '—'}
                        </span>
                      ) : (
                        <RuleText text={f!.exprText} index={index} />
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px] text-[#334568] max-w-[260px] truncate" title={value}>
                      {value || (container ? '' : '—')}
                    </td>
                    <td className="px-4 py-1.5 text-[11px] text-red-700">{errs.map((e: { message: string }) => e.message).join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Outputs" aria-disabled="true" className="bg-white border border-dashed border-[#CBD5E1] rounded-xl p-4 opacity-80">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-bold text-[#64748B]">Outputs</h2>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#FEF2F2] text-[#EF1B24] border border-[#FECACA]">Coming soon</span>
        </div>
        <p className="mt-1 text-[12px] text-[#657794]">Deliver this body to other systems (MES, WMS, …). Today the body stays on the platform and is shown live here.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled icon={<Radio className="w-3.5 h-3.5" />} title="Coming soon">
            MQTT topic
          </Button>
          <Button variant="outline" size="sm" disabled icon={<Send className="w-3.5 h-3.5" />} title="Coming soon">
            REST endpoint
          </Button>
        </div>
      </section>
    </div>
  );
};
