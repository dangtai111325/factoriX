import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';

/**
 * Toast with an optional action (Undo), R3-HS-01:
 *   - a toast with an action stays at least 15 s (plain toasts 6 s, errors 10 s);
 *   - the countdown pauses while the pointer is over the toast or focus is inside it;
 *   - the action is a real button in the tab order, labelled for screen readers, and Ctrl+Z / ⌘Z
 *     runs it while focus is not in a text field;
 *   - Escape (with focus inside) dismisses it.
 */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastSpec {
  message: string;
  tone?: 'info' | 'success' | 'error';
  action?: ToastAction;
  /** Override the visible duration (ms). Values below the minimum for an action toast are raised. */
  durationMs?: number;
}

interface ToastState extends ToastSpec {
  id: number;
}

export const ACTION_TOAST_MIN_MS = 15000;

function durationOf(spec: ToastSpec): number {
  const base = spec.durationMs ?? (spec.action ? ACTION_TOAST_MIN_MS : spec.tone === 'error' ? 10000 : 6000);
  return spec.action ? Math.max(base, ACTION_TOAST_MIN_MS) : base;
}

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * One toast at a time; a new toast replaces the current one. `dismiss(id)` only closes that toast,
 * so a toast shown by an Undo action (e.g. "Restored X") survives the Undo toast closing itself.
 */
export function useActionToast(): { toast: ToastState | null; show: (spec: ToastSpec) => void; dismiss: (id?: number) => void } {
  const [toast, setToast] = useState<ToastState | null>(null);
  const show = useCallback((spec: ToastSpec) => setToast({ ...spec, id: Date.now() + Math.random() }), []);
  const dismiss = useCallback((id?: number) => setToast((current) => (id === undefined || current?.id === id ? null : current)), []);
  return { toast, show, dismiss };
}

/** `onDismiss` receives the id of the toast that closes; ignore it when the toast was replaced meanwhile. */
export const ActionToast: React.FC<{ toast: ToastState | null; onDismiss: (id: number) => void }> = ({ toast, onDismiss }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const remainingRef = useRef(0);
  const startedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const [running, setRunning] = useState(false);
  const toastId = toast?.id ?? 0;
  const dismissByIdRef = useRef(onDismiss);
  dismissByIdRef.current = onDismiss;
  const onDismissRef = useRef(() => onDismiss(toastId));
  onDismissRef.current = () => onDismiss(toastId);

  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const resume = useCallback(() => {
    clear();
    if (hoverRef.current || focusRef.current || remainingRef.current <= 0) return;
    startedRef.current = Date.now();
    timerRef.current = window.setTimeout(() => onDismissRef.current(), remainingRef.current);
  }, []);
  const pause = useCallback(() => {
    if (timerRef.current === null) return;
    clear();
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
  }, []);

  useEffect(() => {
    clear();
    hoverRef.current = false;
    focusRef.current = false;
    setRunning(false);
    if (!toast) return;
    remainingRef.current = durationOf(toast);
    resume();
    return clear;
  }, [toast, resume]);

  const runAction = useCallback(async () => {
    if (!toast?.action || running) return;
    // Capture the id: the action may show a new toast, which must stay.
    const id = toast.id;
    setRunning(true);
    try {
      await toast.action.run();
    } finally {
      setRunning(false);
      dismissByIdRef.current(id);
    }
  }, [toast, running]);

  // Ctrl+Z / Cmd+Z runs the action of the visible toast (outside text fields).
  useEffect(() => {
    if (!toast?.action) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return;
      if (isTextField(document.activeElement)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      void runAction();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toast, runAction]);

  if (!toast) return null;
  const tone = toast.tone || 'info';
  const shortcut = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';

  return (
    <ModalPortal>
      <div
        ref={rootRef}
        role={tone === 'error' ? 'alert' : 'status'}
        aria-live={tone === 'error' ? 'assertive' : 'polite'}
        className={`fixed bottom-4 right-4 left-4 sm:left-auto z-[60] sm:max-w-md flex items-center gap-3 rounded-xl border px-4 py-3 text-white shadow-2xl ${
          tone === 'error' ? 'bg-[#7F1D1D] border-[#991B1B]' : 'bg-slate-900 border-slate-700'
        }`}
        onMouseEnter={() => {
          hoverRef.current = true;
          pause();
        }}
        onMouseLeave={() => {
          hoverRef.current = false;
          resume();
        }}
        onFocus={() => {
          focusRef.current = true;
          pause();
        }}
        onBlur={(event) => {
          if (rootRef.current && event.relatedTarget instanceof Node && rootRef.current.contains(event.relatedTarget)) return;
          focusRef.current = false;
          resume();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onDismissRef.current();
          }
        }}
      >
        <span className="text-xs font-semibold leading-snug flex-1 min-w-0 break-words">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            onClick={() => void runAction()}
            disabled={running}
            aria-keyshortcuts="Control+Z Meta+Z"
            title={`${toast.action.label} (${shortcut})`}
            className="shrink-0 h-7 px-2.5 rounded-md bg-white/15 hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white text-xs font-bold disabled:opacity-60"
          >
            {running ? `${toast.action.label}…` : toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismissRef.current()}
          aria-label="Dismiss notification"
          className="shrink-0 p-1 rounded-md text-white/70 hover:text-white hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </ModalPortal>
  );
};
