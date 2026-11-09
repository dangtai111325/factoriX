import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Layers, Loader2, RefreshCw } from 'lucide-react';
import { ImpactModel, modelStatusLabel } from '../../lib/impactApi';
import { translateApiError } from '../../utils/apiErrors';

export type UsageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; models: ImpactModel[] };

/**
 * Loads the data models affected by an action (R3-DM-02 / R3-CN-02). `load` is called again when
 * `key` changes or the user presses Retry. Returns the state and a retry function.
 */
export function useModelUsage(key: string | null, load: () => Promise<ImpactModel[]>): [UsageState, () => void] {
  const [state, setState] = useState<UsageState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loadRef = React.useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState({ status: 'loading' });
    loadRef
      .current()
      .then((models) => {
        if (!cancelled) setState({ status: 'ready', models });
      })
      .catch((error) => {
        console.warn('Data model usage could not be loaded', error);
        if (!cancelled) setState({ status: 'error', message: translateApiError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}

const statusTone = (status: string): string => {
  const s = status.toUpperCase();
  if (s === 'RUNNING') return 'bg-emerald-50 text-emerald-800 border-emerald-200';
  return 'bg-slate-100 text-slate-600 border-slate-200';
};

/** List of affected data models with status and a link to each, plus loading / error / empty states. */
export const ModelUsageList: React.FC<{
  state: UsageState;
  onRetry: () => void;
  /** Sentence before the list, e.g. "Used by 3 data models:". Receives the count. */
  heading: (count: number) => string;
  /** Unused: nothing is shown when no model is affected. Kept for callers. */
  emptyText?: string;
  /** Close the surrounding dialog before navigating to a model. */
  onNavigate?: () => void;
}> = ({ state, onRetry, heading, onNavigate }) => {
  if (state.status === 'loading') {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-[#657794]" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
        Checking which data models use it…
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="flex items-start gap-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p>The data models that use it could not be checked: {state.message}</p>
          <button type="button" onClick={onRetry} className="mt-1 inline-flex items-center gap-1 font-semibold underline hover:no-underline">
            <RefreshCw className="w-3 h-3" aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    );
  }
  // Lead decision (R3 scope change): no list and no "not used" sentence when no model uses it.
  if (state.models.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] font-semibold text-[#111B37]">{heading(state.models.length)}</p>
      <ul className="max-h-40 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100">
        {state.models.map((model) => (
          <li key={model.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <Link
              to={`/models?model=${encodeURIComponent(model.id)}`}
              onClick={onNavigate}
              className="min-w-0 flex items-center gap-1.5 text-[12px] font-semibold text-[#134074] hover:underline"
            >
              <Layers className="w-3.5 h-3.5 shrink-0 text-[#657794]" aria-hidden="true" />
              <span className="truncate" title={model.displayName}>{model.displayName}</span>
            </Link>
            <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${statusTone(model.status)}`}>
              {modelStatusLabel(model.status)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};
