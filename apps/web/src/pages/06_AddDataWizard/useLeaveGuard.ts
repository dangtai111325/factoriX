/**
 * R3-AD-02: warn before leaving a page with unsaved settings.
 *
 * - Reload / close tab / typed URL: the browser's own `beforeunload` prompt.
 * - In-app navigation: the app uses <BrowserRouter> (not a data router), so `useBlocker` is not
 *   available. Every in-app navigation (NavLink / Link clicks, `navigate()` from any component,
 *   `navigate(-1)`) goes through the router's navigator object, so while `when` is true its
 *   push / replace / go are wrapped: a navigation to another page is held and `pending` is set;
 *   the page shows its own dialog and calls `proceed()` or `cancel()`.
 *   Navigation inside the same pathname (query changes) is never held.
 * - The browser Back button cannot be held without a data router; the page keeps a session draft
 *   so its state comes back when the user returns.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';

type To = string | { pathname?: string; search?: string; hash?: string };

interface NavigatorLike {
  push: (to: To, state?: unknown, opts?: unknown) => void;
  replace: (to: To, state?: unknown, opts?: unknown) => void;
  go: (delta: number) => void;
}

export interface PendingNavigation {
  /** Human readable target, for the dialog ("Signals", "/collector/signals", "the previous page"). */
  label: string;
  run: () => void;
}

function pathnameOf(to: To): string {
  if (typeof to === 'string') {
    try {
      return new URL(to, window.location.href).pathname;
    } catch {
      return to;
    }
  }
  return to.pathname ?? window.location.pathname;
}

export function useLeaveGuard(when: boolean): {
  pending: PendingNavigation | null;
  proceed: () => void;
  cancel: () => void;
  /** Navigate without a prompt (e.g. after a successful save); valid until the page unmounts. */
  allowNext: () => void;
} {
  const { navigator } = useContext(UNSAFE_NavigationContext) as unknown as { navigator: NavigatorLike };
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const allowRef = useRef(false);

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowRef.current) return;
      event.preventDefault();
      // Chrome needs returnValue set; the text itself is not shown.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    const original = { push: navigator.push, replace: navigator.replace, go: navigator.go };
    const here = window.location.pathname;
    const hold = (label: string, run: () => void) => setPending({ label, run });
    navigator.push = (to, state, opts) => {
      if (allowRef.current || pathnameOf(to) === here) return original.push.call(navigator, to, state, opts);
      hold(pathnameOf(to), () => original.push.call(navigator, to, state, opts));
    };
    navigator.replace = (to, state, opts) => {
      if (allowRef.current || pathnameOf(to) === here) return original.replace.call(navigator, to, state, opts);
      hold(pathnameOf(to), () => original.replace.call(navigator, to, state, opts));
    };
    navigator.go = (delta) => {
      if (allowRef.current || delta === 0) return original.go.call(navigator, delta);
      hold('the previous page', () => original.go.call(navigator, delta));
    };
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      navigator.push = original.push;
      navigator.replace = original.replace;
      navigator.go = original.go;
    };
  }, [when, navigator]);

  const proceed = useCallback(() => {
    const next = pending;
    allowRef.current = true;
    setPending(null);
    next?.run();
  }, [pending]);

  const cancel = useCallback(() => setPending(null), []);
  const allowNext = useCallback(() => {
    allowRef.current = true;
  }, []);

  return { pending, proceed, cancel, allowNext };
}
