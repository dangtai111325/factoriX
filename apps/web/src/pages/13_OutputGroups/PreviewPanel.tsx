import React, { useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Trophy } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { StatusBadge } from '../../components/common/StatusBadge';
import { MEMBER_KIND_LABEL, ModelKind, ModelStatus } from './types';
import { useModelLive } from './hooks';
import { displayValue, fmtTs, prettyJsonText, timeAgo } from './modelLogic';
import { Banner, CopyButton, StreamIndicator } from './ui';

interface Props {
  modelId: string;
  kind: ModelKind;
  status: ModelStatus;
  dirty: boolean;
  refreshToken: number;
}

const BodyBox: React.FC<{ text: string | null; label: React.ReactNode; empty: string }> = ({ text, label, empty }) => {
  const [pretty, setPretty] = useState(true);
  return (
    <div className="rounded-xl overflow-hidden border border-slate-800 shadow-inner">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-800 text-slate-200 text-[11px]">
        <span className="font-semibold">{label}</span>
        <div className="flex items-center gap-1.5">
          <div className="inline-flex rounded border border-slate-600 overflow-hidden">
            {(['Pretty', 'Exact'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPretty(m === 'Pretty')}
                className={`px-2 py-1 font-semibold ${pretty === (m === 'Pretty') ? 'bg-slate-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <CopyButton text={text} label="Copy exact" />
        </div>
      </div>
      <pre className="bg-slate-900 text-slate-100 p-4 font-mono text-[12px] leading-relaxed overflow-x-auto whitespace-pre max-h-[420px]">
        {text ? (pretty ? prettyJsonText(text) : text) : <span className="text-slate-500">{empty}</span>}
      </pre>
    </div>
  );
};

export const PreviewPanel: React.FC<Props> = ({ modelId, kind, status, dirty, refreshToken }) => {
  const { stream, preview, latest, liveBody, events, error, lastFetch, refresh } = useModelLive(modelId, kind, true, refreshToken);
  const [openEvent, setOpenEvent] = useState<string | null>(null);

  const emitted = liveBody?.body || (status === 'PUBLISHED' ? latest?.body : null) || null;
  const winner = preview?.source_timestamp_from || null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-bold text-[#111B37]">Live preview</h3>
          <p className="text-[12px] text-[#657794]">Exactly the text consumers receive, with key order preserved.</p>
        </div>
        <div className="flex items-center gap-3">
          <StreamIndicator stream={stream} lastFetch={lastFetch} />
          <Button size="sm" variant="outline" onClick={() => void refresh()} icon={<RefreshCw className="w-3.5 h-3.5" />}>
            Refresh
          </Button>
        </div>
      </div>

      {dirty && <Banner tone="warning">You have unsaved changes. The preview shows the last saved version of this model.</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      {status !== 'PUBLISHED' && (
        <Banner tone="info">
          This model is a draft, so nothing is emitted yet. The body below is computed on demand from the current signal values.
          Publish the model to start emitting.
        </Banner>
      )}

      {preview?.topic_error && <Banner tone="warning">Topic cannot be resolved for this resource: {preview.topic_error}</Banner>}
      {preview?.topic && (
        <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase font-bold text-[#657794]">Topic</span>
          <span className="font-mono text-[12px] text-[#111B37] font-semibold break-all">{preview.topic}</span>
        </div>
      )}

      {kind === 'STATE' ? (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          {status === 'PUBLISHED' && (
            <BodyBox
              text={emitted}
              empty="// No body emitted yet. A body is emitted when a member signal receives data."
              label={
                <>
                  Emitted body
                  {liveBody ? ` · received ${timeAgo(new Date(liveBody.at).toISOString())}` : latest?.published_at ? ` · published ${fmtTs(latest.published_at)}` : ''}
                </>
              }
            />
          )}
          <BodyBox text={preview?.body ?? null} label="Computed from current values" empty="// Waiting for the preview…" />
        </div>
      ) : (
        <BodyBox text={preview?.body ?? null} label="Next event body (computed from current values)" empty="// Waiting for the preview…" />
      )}

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <span className="text-[12px] font-bold text-[#111B37]">Fields</span>
          {winner ? (
            <span className="text-[11px] text-[#657794]">
              source_timestamp{' '}
              {preview?.source_timestamp && <span className="font-mono text-[#111B37]">{fmtTs(preview.source_timestamp)}</span>} taken from{' '}
              <span className="font-mono font-semibold text-[#111B37]">{winner}</span>
            </span>
          ) : (
            <span className="text-[11px] text-[#657794]">No contributing signal has data yet; source_timestamp is null.</span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[#657794] font-semibold border-b border-slate-100">
                <th className="py-2 px-3">#</th>
                <th className="py-2 px-3">Key</th>
                <th className="py-2 px-3">Kind</th>
                <th className="py-2 px-3">Value</th>
                <th className="py-2 px-3">Quality</th>
                <th className="py-2 px-3">Source time</th>
                <th className="py-2 px-3">Received</th>
                <th className="py-2 px-3 text-center">Src ts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(preview?.fields || []).map((f, i) => (
                <tr key={`${f.alias}-${i}`} className={f.alias === winner ? 'bg-emerald-50/50' : ''}>
                  <td className="py-1.5 px-3 text-slate-400 font-mono">{i + 1}</td>
                  <td className="py-1.5 px-3 font-mono font-semibold text-[#111B37] whitespace-nowrap">
                    {f.alias}
                    {f.alias === winner && <Trophy className="inline w-3 h-3 ml-1 text-emerald-600" aria-label="Provides source_timestamp" />}
                  </td>
                  <td className="py-1.5 px-3 text-[#657794] whitespace-nowrap">{MEMBER_KIND_LABEL[f.kind]}</td>
                  <td className="py-1.5 px-3 font-mono text-[#111B37] max-w-[260px] truncate" title={displayValue(f.value)}>
                    {displayValue(f.value)}
                  </td>
                  <td className="py-1.5 px-3">{f.quality ? <StatusBadge status={f.quality} /> : <span className="text-slate-300">—</span>}</td>
                  <td className="py-1.5 px-3 font-mono text-[11px] text-[#334568] whitespace-nowrap">{f.source_time ? fmtTs(f.source_time) : '—'}</td>
                  <td className="py-1.5 px-3 font-mono text-[11px] text-[#657794] whitespace-nowrap">{f.received_time ? fmtTs(f.received_time) : '—'}</td>
                  <td className="py-1.5 px-3 text-center">{f.contributes_ts ? '✓' : <span className="text-slate-300">—</span>}</td>
                </tr>
              ))}
              {preview && preview.fields.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-[#657794]">
                    No field details returned for this model.
                  </td>
                </tr>
              )}
              {!preview && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-[#657794]">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {kind === 'EVENT' && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-[12px] font-bold text-[#111B37]">Recent events</span>
            <span className="text-[11px] text-[#657794]">Newest first · last 50</span>
          </div>
          {events.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-[#657794]">
              {status === 'PUBLISHED' ? 'No events yet. An event is recorded when a trigger signal gets a new source time.' : 'Publish the model to start recording events.'}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {events.map((ev) => {
                const open = openEvent === ev.id;
                return (
                  <li key={ev.id}>
                    <button
                      type="button"
                      onClick={() => setOpenEvent(open ? null : ev.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                    >
                      {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                      <span className="font-mono text-[11px] text-[#334568] whitespace-nowrap">{ev.source_ts ? fmtTs(ev.source_ts) : 'live'}</span>
                      <span className="font-mono text-[11px] text-[#657794] truncate">{ev.body}</span>
                    </button>
                    {open && (
                      <div className="px-3 pb-3">
                        <BodyBox text={ev.body} label="Event body" empty="" />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
