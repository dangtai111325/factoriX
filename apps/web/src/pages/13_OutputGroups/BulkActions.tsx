// Bulk actions of the Model Catalog: publish, unpublish, archive and re-publish interval for many models.
// Each model is changed with its own per-model endpoint (limited concurrency); one failure never stops the rest.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, CircleMinus, Loader2, XCircle } from 'lucide-react';
import { Button } from '../../components/common/Button';
import type { ModelListItem } from './types';
import { archiveModel, errorText, isVersionConflict, publishModel, setRepublishInterval, unpublishModel } from './modelApi';
import { MAX_REPUBLISH_SEC, durationLabel } from './modelLogic';
import { Banner, Modal } from './ui';

export type BulkAction = 'publish' | 'unpublish' | 'archive' | 'republish';

/** Requests in flight at the same time. */
export const BULK_CONCURRENCY = 4;

type ItemState = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

interface ItemResult {
  state: ItemState;
  message?: string;
}

export interface BulkModel {
  model: ModelListItem;
  /** Display name of the scope resource. */
  scopeName: string;
}

/** Run `worker` over `items` with at most `limit` in flight; never rejects. */
export async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}

const TITLES: Record<BulkAction, string> = {
  publish: 'Publish models',
  unpublish: 'Unpublish models',
  archive: 'Archive models',
  republish: 'Set re-publish interval',
};

const VERB_DONE: Record<BulkAction, string> = {
  publish: 'Published',
  unpublish: 'Unpublished',
  archive: 'Archived',
  republish: 'Updated',
};

/** Reason a model is left unchanged by the action, or null when it must be sent to the server. */
function skipReason(action: BulkAction, m: ModelListItem, republishMs: number | null): string | null {
  switch (action) {
    case 'publish':
      return m.status === 'PUBLISHED' ? 'Already published' : null;
    case 'unpublish':
      return m.status !== 'PUBLISHED' ? 'Not published' : null;
    case 'republish':
      if (m.kind === 'EVENT') return 'Event models emit one body per trigger and are not re-published';
      if (m.emit_policy && (m.emit_policy.republish_ms ?? null) === republishMs) return 'Already set to this interval';
      return null;
    default:
      return null;
  }
}

export const BulkActionDialog: React.FC<{
  action: BulkAction | null;
  items: BulkModel[];
  onClose: () => void;
  /** Called once after a run finished (the catalog reloads). */
  onFinished: () => void;
}> = ({ action, items, onClose, onFinished }) => {
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const [mode, setMode] = useState<'off' | 'every'>('every');
  const [seconds, setSeconds] = useState('5');
  const [secondsTouched, setSecondsTouched] = useState(false);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!action) return;
    setPhase('confirm');
    setResults({});
    setSecondsTouched(false);
    // Start from the interval the selected state models already share, if any.
    const states = items.filter((i) => i.model.kind === 'STATE');
    const values = Array.from(new Set(states.map((i) => i.model.emit_policy?.republish_ms ?? null)));
    if (values.length === 1 && values[0] === null) {
      setMode('off');
      setSeconds('5');
    } else if (values.length === 1 && values[0]) {
      setMode('every');
      setSeconds(String(Math.round(values[0] / 1000)));
    } else {
      setMode('every');
      setSeconds('5');
    }
    // Initialise only when the dialog opens for a new action (items are fixed while it is open).
  }, [action]);

  const secondsNum = Number(seconds);
  const secondsError =
    mode === 'every' && (seconds.trim() === '' || !Number.isInteger(secondsNum) || secondsNum < 1 || secondsNum > MAX_REPUBLISH_SEC)
      ? `Enter a whole number of seconds from 1 to ${MAX_REPUBLISH_SEC}.`
      : null;
  const republishMs = mode === 'off' || secondsError ? null : secondsNum * 1000;

  const plan = useMemo(
    () =>
      items.map((item) => ({
        item,
        skip: action ? skipReason(action, item.model, action === 'republish' && mode === 'every' && secondsError ? -1 : republishMs) : null,
      })),
    [items, action, republishMs, mode, secondsError],
  );
  const toRun = plan.filter((p) => !p.skip);
  const skipped = plan.length - toRun.length;

  const counts = useMemo(() => {
    const c = { ok: 0, error: 0, skipped: 0, done: 0 };
    plan.forEach(({ item }) => {
      const r = results[item.model.id];
      if (!r) return;
      if (r.state === 'ok') c.ok += 1;
      if (r.state === 'error') c.error += 1;
      if (r.state === 'skipped') c.skipped += 1;
      if (r.state === 'ok' || r.state === 'error' || r.state === 'skipped') c.done += 1;
    });
    return c;
  }, [plan, results]);

  if (!action) return null;

  const setResult = (id: string, r: ItemResult) => setResults((prev) => ({ ...prev, [id]: r }));

  const run = async () => {
    if (runningRef.current || (action === 'republish' && secondsError)) return;
    runningRef.current = true;
    setPhase('running');
    const initial: Record<string, ItemResult> = {};
    plan.forEach(({ item, skip }) => {
      initial[item.model.id] = skip ? { state: 'skipped', message: skip } : { state: 'pending' };
    });
    setResults(initial);
    await runPool(toRun, BULK_CONCURRENCY, async ({ item }) => {
      const m = item.model;
      setResult(m.id, { state: 'running' });
      try {
        if (action === 'publish') await publishModel(m.id, m.version);
        else if (action === 'unpublish') await unpublishModel(m.id, m.version);
        else if (action === 'archive') await archiveModel(m.id);
        else await setRepublishInterval(m.id, m.version, republishMs);
        setResult(m.id, { state: 'ok', message: VERB_DONE[action] });
      } catch (err) {
        const text = isVersionConflict(err)
          ? 'Changed elsewhere since the list was loaded. Reload the catalog and try again.'
          : errorText(err, 'Request failed.');
        setResult(m.id, { state: 'error', message: text });
      }
    });
    runningRef.current = false;
    setPhase('done');
    onFinished();
  };

  const running = phase === 'running';
  const total = plan.length;
  const confirmLabel = (() => {
    const n = toRun.length;
    const models = `${n} model${n === 1 ? '' : 's'}`;
    if (action === 'publish') return `Publish ${models}`;
    if (action === 'unpublish') return `Unpublish ${models}`;
    if (action === 'archive') return `Archive ${models}`;
    return `Apply to ${models}`;
  })();

  const intro = (() => {
    if (action === 'publish') return 'Each model starts emitting bodies on its topic whenever a contributing signal changes.';
    if (action === 'unpublish') return 'Consumers stop receiving bodies from these models. You can publish them again at any time.';
    if (action === 'archive')
      return 'Archived models stop emitting immediately and are removed from the catalog. Archived models cannot be restored from the user interface.';
    return 'State models re-send their last body at this interval while no value changes. Re-published bodies keep source_timestamp and get a new publish_timestamp.';
  })();

  const stateIcon = (r: ItemResult | undefined, skip: string | null) => {
    if (phase === 'confirm') return skip ? <CircleMinus className="w-3.5 h-3.5 text-slate-400" /> : <CircleDashed className="w-3.5 h-3.5 text-slate-400" />;
    if (!r || r.state === 'pending') return <CircleDashed className="w-3.5 h-3.5 text-slate-400" />;
    if (r.state === 'running') return <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />;
    if (r.state === 'ok') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />;
    if (r.state === 'skipped') return <CircleMinus className="w-3.5 h-3.5 text-slate-400" />;
    return <XCircle className="w-3.5 h-3.5 text-red-600" />;
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!running) onClose();
      }}
      width="lg"
      title={TITLES[action]}
      subtitle={`${total} selected model${total === 1 ? '' : 's'}`}
      footer={
        phase === 'done' ? (
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" disabled={running} onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={action === 'archive' ? 'danger' : 'primary'}
              loading={running}
              disabled={running || toRun.length === 0 || (action === 'republish' && Boolean(secondsError))}
              onClick={() => void run()}
            >
              {running ? `Working… ${counts.done} / ${total}` : confirmLabel}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {phase === 'confirm' && <Banner tone={action === 'archive' ? 'warning' : 'info'}>{intro}</Banner>}

        {phase === 'confirm' && action === 'republish' && (
          <fieldset className="p-3 border border-slate-200 rounded-lg space-y-2 text-[12px] text-[#334568]">
            <legend className="px-1 text-[11px] font-semibold uppercase text-[#657794]">Re-publish when unchanged</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="bulk-republish" checked={mode === 'off'} onChange={() => setMode('off')} />
              Off — emit only when a value changes
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input type="radio" name="bulk-republish" checked={mode === 'every'} onChange={() => setMode('every')} />
              Every
              <input
                type="number"
                min={1}
                max={MAX_REPUBLISH_SEC}
                step={1}
                value={seconds}
                aria-label="Re-publish interval in seconds"
                aria-invalid={Boolean(secondsError && secondsTouched)}
                disabled={mode !== 'every'}
                onFocus={() => setMode('every')}
                onChange={(e) => {
                  setSeconds(e.target.value);
                  setSecondsTouched(true);
                }}
                className={`w-24 h-8 px-2 border rounded text-[12px] focus:outline-none focus:border-blue-500 disabled:bg-slate-50 disabled:text-slate-400 ${
                  secondsError && mode === 'every' ? 'border-red-400' : 'border-slate-300'
                }`}
              />
              seconds
              {!secondsError && mode === 'every' && secondsNum >= 60 && <span className="text-[#657794]">({durationLabel(secondsNum)})</span>}
            </label>
            {secondsError && mode === 'every' && <p className="text-[11px] text-red-600">{secondsError}</p>}
          </fieldset>
        )}

        {phase !== 'confirm' && (
          <div>
            <div className="flex items-center justify-between text-[12px] mb-1">
              <span className="font-semibold text-[#111B37]">
                {phase === 'running' ? `Working… ${counts.done} of ${total}` : `Finished: ${counts.ok} ${VERB_DONE[action].toLowerCase()}, ${counts.error} failed, ${counts.skipped} skipped`}
              </span>
              <span className="text-[#657794]">{total ? Math.round((counts.done / total) * 100) : 100}%</span>
            </div>
            <div
              className="h-1.5 rounded-full bg-slate-100 overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={counts.done}
              aria-label="Progress"
            >
              <div
                className={`h-full transition-all ${counts.error ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${total ? (counts.done / total) * 100 : 100}%` }}
              />
            </div>
          </div>
        )}

        {phase === 'done' && counts.error > 0 && (
          <Banner tone="error">
            {counts.error} model{counts.error === 1 ? '' : 's'} could not be changed. The others were processed; see the reason on each row.
          </Banner>
        )}

        <div className="border border-slate-200 rounded-lg max-h-[45vh] overflow-y-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="text-[#657794] font-semibold border-b border-slate-200">
                <th className="w-8 py-2 pl-3" aria-label="Result" />
                <th className="text-left py-2 px-2">Model</th>
                <th className="text-left py-2 px-2">Resource</th>
                <th className="text-left py-2 px-3">{phase === 'confirm' ? 'Plan' : 'Result'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plan.map(({ item, skip }) => {
                const r = results[item.model.id];
                const text =
                  phase === 'confirm'
                    ? skip
                      ? `Skipped: ${skip}`
                      : action === 'republish'
                        ? republishMs
                          ? `Every ${durationLabel(republishMs / 1000)}`
                          : 'Off'
                        : TITLES[action].split(' ')[0]
                    : r?.state === 'skipped'
                      ? `Skipped: ${r.message}`
                      : r?.state === 'running'
                        ? 'Working…'
                        : r?.state === 'pending'
                          ? 'Waiting'
                          : r?.message || '';
                return (
                  <tr key={item.model.id}>
                    <td className="py-1.5 pl-3 align-top">{stateIcon(r, skip)}</td>
                    <td className="py-1.5 px-2 align-top">
                      <div className="font-semibold text-[#111B37]">{item.model.display_name || item.model.key}</div>
                      <div className="font-mono text-[10px] text-[#657794]">{item.model.key}</div>
                    </td>
                    <td className="py-1.5 px-2 align-top text-[#334568]">{item.scopeName}</td>
                    <td
                      className={`py-1.5 px-3 align-top ${
                        r?.state === 'error' ? 'text-red-700' : r?.state === 'ok' ? 'text-emerald-700' : skip || r?.state === 'skipped' ? 'text-slate-500' : 'text-[#334568]'
                      }`}
                    >
                      {text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {phase === 'confirm' && skipped > 0 && (
          <p className="text-[11px] text-[#657794]">
            {skipped} model{skipped === 1 ? ' is' : 's are'} skipped because the action would not change {skipped === 1 ? 'it' : 'them'}.
          </p>
        )}
      </div>
    </Modal>
  );
};
