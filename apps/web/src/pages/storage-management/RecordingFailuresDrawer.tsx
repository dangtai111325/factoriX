import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { listRecordingFailures, RecordingFailure } from '../../lib/storagePhysicalApi';
import { EmptyState, ErrorBanner, LoadingBlock, SideDrawer, TimeCell } from '../historian/hsUi';
import { StorageStatusBadge } from './objectViews';

/**
 * "N with write errors" (R2-07 / OP-03): which subtables have rows the writer could not store, and why.
 * Data: GET /api/v1/storage/recording/failures (one row per subtable, newest failure first).
 */
export const RecordingFailuresDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  /** Switch the Objects table to the "Error" filter. */
  onShowInTable?: () => void;
}> = ({ open, onClose, onShowInTable }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState<RecordingFailure[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    listRecordingFailures(controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setItems(Array.isArray(r?.items) ? r.items : []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, reload]);

  const openObject = useCallback(
    (f: RecordingFailure) =>
      navigate(`/historian/storage/object/${encodeURIComponent(f.object_id)}`, { state: { from: `${location.pathname}${location.search}` } }),
    [navigate, location.pathname, location.search],
  );

  const total = items?.reduce((sum, f) => sum + f.failed, 0) ?? 0;
  return (
    <SideDrawer
      open={open}
      onClose={onClose}
      width="lg"
      title="Subtables with write errors"
      subtitle={
        items && items.length
          ? `${items.length.toLocaleString()} subtable${items.length === 1 ? '' : 's'} · ${total.toLocaleString()} row${total === 1 ? '' : 's'} not stored`
          : 'Rows the writer could not store into TDengine'
      }
      actions={
        <>
          <Button size="sm" variant="outline" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={() => setReload((v) => v + 1)} disabled={loading}>
            Refresh
          </Button>
          {onShowInTable && (
            <Button size="sm" variant="outline" onClick={onShowInTable}>
              Show in Objects table
            </Button>
          )}
        </>
      }
    >
      <div className="p-4">
        {error != null ? (
          <ErrorBanner error={error} subject="the write errors" onRetry={() => setReload((v) => v + 1)} />
        ) : items == null ? (
          <LoadingBlock label="Loading write errors…" />
        ) : items.length === 0 ? (
          <EmptyState dashed title="No write errors">
            Every row bound to a subtable was stored. Failed rows that belonged to deleted objects are not listed.
          </EmptyState>
        ) : (
          <ul className="space-y-2" aria-label="Subtables with write errors">
            {items.map((f) => (
              <li key={f.object_id} className="border border-[#E2E8F0] rounded-xl p-3 bg-white">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[13px] text-[#111B37] truncate" title={f.subtable}>
                      {f.display_name || f.subtable}
                    </div>
                    <div className="font-mono text-[11px] text-[#657794] truncate" title={`${f.database}.${f.subtable}`}>
                      {f.database}.{f.subtable}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {f.object_status && <StorageStatusBadge status={f.object_status} />}
                    <Button size="sm" variant="outline" icon={<ExternalLink className="w-3.5 h-3.5" />} onClick={() => openObject(f)}>
                      Open
                    </Button>
                  </div>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                  <div>
                    <dt className="text-[#657794]">Failed rows</dt>
                    <dd className="font-mono tabular-nums text-[#DB2028] font-semibold">{f.failed.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-[#657794]">Last failure</dt>
                    <dd><TimeCell iso={f.last_failed_at} withDate /></dd>
                  </div>
                  <div>
                    <dt className="text-[#657794]">Attempts</dt>
                    <dd className="font-mono tabular-nums">{f.attempts.toLocaleString()}</dd>
                  </div>
                </dl>
                <div className="mt-2">
                  <div className="text-[12px] text-[#657794]">Last error</div>
                  <div className="mt-0.5 text-[12px] font-mono text-[#334568] bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-2 py-1.5 break-words whitespace-pre-wrap">
                    {f.last_error || 'No reason recorded'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SideDrawer>
  );
};
