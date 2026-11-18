/**
 * R1-42: keep the configuration lists (resources, connections, …) current across browser tabs.
 *
 * - A page that changes the model calls `notifyModelChanged()` after the server accepted the change.
 *   Every other tab of this browser reloads its lists at once (BroadcastChannel).
 * - A tab that becomes visible again reloads its lists when they may be out of date (a change made
 *   by another browser or user arrives at the latest with the periodic metadata refresh).
 *
 * The hook is mounted once by the shell (Topbar).
 */
import { useEffect, useRef } from 'react';

const CHANNEL = 'factorix-model-sync';
/** A tab coming back reloads only when its lists are older than this. */
const VISIBLE_RELOAD_AFTER_MS = 5000;

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  return channel;
}

/** Tell the other tabs that the configuration changed (resources, connections, signals, models). */
export function notifyModelChanged(kind: string = 'model'): void {
  try {
    getChannel()?.postMessage({ type: 'model-changed', kind, at: Date.now() });
  } catch {
    // Cross-tab sync is a convenience; the periodic refresh still applies.
  }
}

/** Reload the lists when another tab changed the model, or when this tab becomes visible again. */
export function useModelSync(refresh: () => Promise<void>): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastRunRef = useRef(Date.now());

  useEffect(() => {
    let pending: number | null = null;
    const run = () => {
      if (pending !== null) return;
      // Coalesce bursts (a bulk change posts several messages).
      pending = window.setTimeout(() => {
        pending = null;
        lastRunRef.current = Date.now();
        void refreshRef.current().catch((error) => console.warn('Reload after a change in another tab failed', error));
      }, 150);
    };
    const bc = getChannel();
    const onMessage = (event: MessageEvent) => {
      if (event.data && (event.data as { type?: string }).type === 'model-changed') run();
    };
    bc?.addEventListener('message', onMessage);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRunRef.current > VISIBLE_RELOAD_AFTER_MS) run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      bc?.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
      if (pending !== null) window.clearTimeout(pending);
    };
  }, []);
}
