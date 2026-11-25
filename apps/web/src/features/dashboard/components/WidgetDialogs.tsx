/** Read-only widget actions of view mode: the data table of a widget's series, and a full-screen widget. */
import React, { useMemo, useState } from 'react';
import { Dialog } from '../../../pages/13_DataModels/ui';
import { STATE_LABEL, formatTime, formatValue } from '../format';
import { useRuntime, useWidgetData } from '../runtime/RuntimeProvider';
import { themeStyle } from '../theme';
import type { DashboardWidget, NavTarget, SeriesData } from '../types';
import { WidgetCell } from './DashboardCanvas';

const PAGE = 100;

export const WidgetDataDialog: React.FC<{ widget: DashboardWidget | null; onClose: () => void }> = ({ widget, onClose }) => (
  <Dialog open={!!widget} onClose={onClose} title={widget ? `Data · ${widget.title || 'Widget'}` : ''} subtitle="Values as received, after the display scale and offset of each source." width="xl">
    {widget && <WidgetDataBody widget={widget} />}
  </Dialog>
);

const WidgetDataBody: React.FC<{ widget: DashboardWidget }> = ({ widget }) => {
  const data = useWidgetData(widget);
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState(0);
  const withHistory = data.series.filter((s) => s.history);
  const current: SeriesData | undefined = withHistory[Math.min(tab, withHistory.length - 1)];
  const rows = useMemo(() => (current?.history?.points || []).slice().reverse(), [current]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));

  if (data.status === 'unbound') return <p className="text-[13px] text-[#657794]">This widget has no data source.</p>;
  if (data.status === 'loading' && !data.series.some((s) => s.latest)) return <p className="text-[13px] text-[#657794]">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto border border-[#E3EAF3] rounded-lg">
        <table className="fx-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Latest value</th>
              <th>Quality</th>
              <th>Time</th>
              <th>History</th>
            </tr>
          </thead>
          <tbody>
            {data.series.map((s) => (
              <tr key={s.binding.id}>
                <td>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="font-semibold text-[#111B37] truncate max-w-[260px]" title={s.label}>
                        {s.label}
                      </div>
                      {s.resolved?.resource?.name && <div className="text-[11px] text-[#657794] truncate">{s.resolved.resource.name}</div>}
                    </div>
                  </div>
                </td>
                <td className="font-mono tabular-nums">{s.error ? <span className="text-red-700 font-sans">{s.error.message}</span> : formatValue(s.latest?.value, { unit: s.unit })}</td>
                <td>{s.latest ? STATE_LABEL[s.latest.state] : '—'}</td>
                <td className="whitespace-nowrap">{formatTime(s.latest?.ts ?? null)}</td>
                <td className="text-[12px]">
                  {s.history ? `${s.history.points.length.toLocaleString()} point${s.history.points.length === 1 ? '' : 's'}${s.history.downsampled ? ' · downsampled' : ''}` : 'Not used'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.warnings.length > 0 && (
        <ul className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-0.5">
          {data.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {current && (
        <div>
          {withHistory.length > 1 && (
            <div className="flex flex-wrap gap-1 mb-2" role="tablist" aria-label="Series">
              {withHistory.map((s, i) => (
                <button
                  key={s.binding.id}
                  type="button"
                  role="tab"
                  aria-selected={i === tab}
                  onClick={() => {
                    setTab(i);
                    setPage(0);
                  }}
                  className={`px-2.5 py-1 rounded-md text-[12px] font-semibold border ${i === tab ? 'bg-[#111B37] text-white border-[#111B37]' : 'bg-white text-[#334568] border-[#D4DFEC]'}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {current.history && current.history.notes.length > 0 && <p className="text-[11px] text-[#657794] mb-1.5">{current.history.notes.join(' ')}</p>}
          {rows.length === 0 ? (
            <p className="text-[12px] text-[#657794]">No history points in this time range{current.history?.status && current.history.status !== 'OK' ? ` (${current.history.status})` : ''}.</p>
          ) : (
            <>
              <div className="overflow-x-auto border border-[#E3EAF3] rounded-lg max-h-[360px] overflow-y-auto">
                <table className="fx-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Value</th>
                      <th>Quality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(page * PAGE, page * PAGE + PAGE).map((p, i) => (
                      <tr key={`${p.t}-${i}`}>
                        <td className="whitespace-nowrap font-mono text-[12px]">{formatTime(p.t)}</td>
                        <td className="font-mono tabular-nums">{formatValue(p.v, { unit: current.unit })}</td>
                        <td>{p.q || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="flex items-center justify-end gap-2 mt-2 text-[12px] text-[#657794]">
                  <button type="button" className="px-2 py-1 rounded border border-[#D4DFEC] disabled:opacity-40" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    Newer
                  </button>
                  <span>
                    Page {page + 1} of {pages}
                  </span>
                  <button type="button" className="px-2 py-1 rounded border border-[#D4DFEC] disabled:opacity-40" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                    Older
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const WidgetFullscreenDialog: React.FC<{ widget: DashboardWidget | null; onClose: () => void; onNavigate: (t: NavTarget) => void }> = ({ widget, onClose, onNavigate }) => {
  const { theme } = useRuntime();
  return (
    <Dialog open={!!widget} onClose={onClose} title={widget?.title || 'Widget'} width="xl">
      {widget && (
        <div className="h-[70vh] rounded-xl p-3" style={themeStyle(theme)}>
          <WidgetCell widget={widget} mode="view" onNavigate={onNavigate} />
        </div>
      )}
    </Dialog>
  );
};
