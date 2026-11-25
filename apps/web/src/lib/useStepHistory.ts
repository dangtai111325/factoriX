/**
 * Wizard steps in the browser history (R1-28 / OP-08 / B-07).
 *
 * Every step change pushes a history entry on the same page (`?step=N`, 1-based; no parameter on step 1), so the
 * browser Back / Forward buttons move between steps and Back on step 1 leaves the wizard like any page. The
 * in-app leave guard (`useLeaveGuard`) only holds navigation to another pathname, so these entries pass it.
 *
 * - The wizard's own Back button walks back through the entry it created (`window.history.back()`), so Back /
 *   Next / Back never piles up duplicate entries.
 * - A step in the URL is shown only when `reachable` says the earlier steps pass their checks with the data
 *   the wizard holds now:
 *   - entering / reloading on `?step=N` (also a deep link): the step is restored when its earlier steps are valid
 *     (an edit wizard's object, a reopened server draft, a restored Add Data draft), otherwise the wizard is
 *     normalised to step 1 (`replace`, no new entry); it never shows a step whose earlier state is missing;
 *   - browser Forward onto a step whose earlier step no longer passes (edited after going back) is undone
 *     (`history.go` back to where it came from) and `onRefused(step)` shows why;
 *   - browser Back onto an entry that can not be shown (left over from before a reload) keeps going back.
 *   `ready = false` delays that first decision until the data is loaded (object, server draft, connection).
 * - Each entry carries `{step, depth, prev}` in `history.state` (kept across reloads by the browser): `prev` lets
 *   the Back button step back through history, `depth` = number of wizard entries above the one the wizard was
 *   entered on, so "Cancel" can leave with `navigate(-(depth + 1))`.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

const STEP_PARAM = 'step';
const STATE_KEY = 'fxWizardStep';

interface StepEntry {
  step: number;
  depth: number;
  prev: number | null;
}

export interface StepHistoryOptions {
  /** The wizard shows its steps (false on a kind picker, a success page, while the page is a spinner). */
  enabled?: boolean;
  /** The data that decides whether a URL step can be shown is loaded (edit object, server draft, ...). */
  ready?: boolean;
  /** Furthest step `<= target` whose earlier steps all pass their checks now (may ask the server). */
  reachable?: (target: number) => number | Promise<number>;
  /** Browser Forward was refused: `step` is the first step that does not pass (show its errors). */
  onRefused?: (step: number) => void;
}

function parseStep(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n - 1 : 0;
}

function entryOf(state: unknown): StepEntry | null {
  const e = state && typeof state === 'object' ? (state as Record<string, unknown>)[STATE_KEY] : null;
  if (!e || typeof e !== 'object') return null;
  const { step, depth, prev } = e as Record<string, unknown>;
  if (typeof step !== 'number' || typeof depth !== 'number') return null;
  return { step, depth, prev: typeof prev === 'number' ? prev : null };
}

/** Position of the current entry in the session history (react-router's BrowserRouter keeps `idx` there). */
function historyIdx(): number | null {
  const s = window.history.state as { idx?: unknown } | null;
  return s && typeof s.idx === 'number' ? s.idx : null;
}

/**
 * @param currentStep 0-based step the wizard shows.
 * @param setCurrentStep sets the shown step (0-based).
 * @returns `depth`: wizard entries above the entry the wizard was entered on (leave with `navigate(-(depth + 1))`).
 */
export function useStepHistory(
  currentStep: number,
  setCurrentStep: (step: number) => void,
  options: StepHistoryOptions = {},
): { depth: number } {
  const { enabled = true, ready = true } = options;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const urlStep = parseStep(searchParams.get(STEP_PARAM));
  const latest = useRef({ location, currentStep, setCurrentStep, options });
  latest.current = { location, currentStep, setCurrentStep, options };
  // off: not started (or disabled) | init: first decision pending | on: following steps and URL
  const phase = useRef<'off' | 'init' | 'on'>('off');
  const seq = useRef(0);
  const lastIdx = useRef<number | null>(historyIdx());

  const write = useCallback(
    (step: number, mode: 'push' | 'replace') => {
      const loc = latest.current.location;
      const params = new URLSearchParams(loc.search);
      const shown = parseStep(params.get(STEP_PARAM)) ?? 0;
      if (step > 0) params.set(STEP_PARAM, String(step + 1));
      else params.delete(STEP_PARAM);
      const search = params.toString();
      const here = entryOf(loc.state);
      const entry: StepEntry =
        mode === 'push'
          ? { step, depth: (here?.depth ?? 0) + 1, prev: shown }
          : { step, depth: here?.depth ?? 0, prev: here?.prev ?? null };
      const base = loc.state && typeof loc.state === 'object' ? (loc.state as Record<string, unknown>) : {};
      navigate({ search: search ? `?${search}` : '' }, { replace: mode === 'replace', state: { ...base, [STATE_KEY]: entry } });
    },
    [navigate],
  );

  const check = (target: number): Promise<number> => {
    const reachable = latest.current.options.reachable;
    if (target <= 0 || !reachable) return Promise.resolve(Math.max(0, target));
    return Promise.resolve()
      .then(() => reachable(target))
      .catch(() => 0);
  };

  // First decision once the wizard shows steps and its data is loaded: restore the URL step or normalise to 1.
  useEffect(() => {
    if (!enabled) {
      phase.current = 'off';
      seq.current += 1;
      return;
    }
    if (!ready || phase.current !== 'off') return;
    phase.current = 'init';
    const mine = ++seq.current;
    const desired = urlStep ?? latest.current.currentStep;
    void check(desired).then((r) => {
      if (mine !== seq.current) return;
      const step = r >= desired ? desired : 0;
      phase.current = 'on';
      lastIdx.current = historyIdx();
      if (step !== latest.current.currentStep) latest.current.setCurrentStep(step);
      const shown = parseStep(new URLSearchParams(latest.current.location.search).get(STEP_PARAM));
      if ((shown ?? 0) !== step || (shown !== null && step === 0)) write(step, 'replace');
    });
  }, [enabled, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step changed inside the wizard -> one history entry, or back through the entry that is already there.
  useEffect(() => {
    if (phase.current !== 'on' || !enabled) return;
    if (currentStep === (urlStep ?? 0)) return;
    const here = entryOf(location.state);
    if (here && here.depth > 0 && here.prev === currentStep) {
      // window.history (not navigate(-1)): the leave guard holds navigator.go, and this stays on the page.
      window.history.back();
      return;
    }
    write(currentStep, 'push');
  }, [currentStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Browser Back / Forward changed the URL -> show that step if its earlier steps pass.
  useEffect(() => {
    const idx = historyIdx();
    const prevIdx = lastIdx.current;
    lastIdx.current = idx;
    if (phase.current !== 'on' || !enabled) return;
    const target = urlStep ?? 0;
    const shown = latest.current.currentStep;
    if (target === shown) return;
    if (target < shown) {
      latest.current.setCurrentStep(target); // an earlier step: the data it needs is there
      return;
    }
    const mine = ++seq.current;
    void check(target).then((r) => {
      if (mine !== seq.current) return;
      if (r >= target) {
        latest.current.setCurrentStep(target);
        return;
      }
      if (idx !== null && prevIdx !== null && idx < prevIdx) {
        window.history.back(); // Back onto a stale entry (before a reload): keep going back
        return;
      }
      if (idx !== null && prevIdx !== null && idx > prevIdx) window.history.go(prevIdx - idx); // undo the Forward
      else write(latest.current.currentStep, 'replace');
      latest.current.options.onRefused?.(r);
    });
  }, [urlStep]); // eslint-disable-line react-hooks/exhaustive-deps

  return { depth: entryOf(location.state)?.depth ?? 0 };
}
