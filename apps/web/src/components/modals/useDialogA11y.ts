import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Shared dialog behaviour: Escape closes, focus moves to the first form field (or the element
 * marked `data-autofocus`) when the dialog opens, Tab stays inside the dialog, and focus returns
 * to the element that opened it when the dialog closes.
 *
 * `onClose` is read through a ref so callers may pass an inline arrow function without
 * re-running the open/close effect on every parent render.
 */
export function useDialogA11y(
  isOpen: boolean,
  dialogRef: RefObject<HTMLElement>,
  onClose: () => void,
  options: { closeOnEscape?: boolean } = {},
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscape = options.closeOnEscape !== false;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusFirst = window.setTimeout(() => {
      const root = dialogRef.current;
      if (!root) return;
      const preferred = root.querySelector<HTMLElement>('[data-autofocus]');
      const field = root.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]):not([type="radio"]), select:not([disabled]), textarea:not([disabled])',
      );
      const checkedRadio = root.querySelector<HTMLElement>('input[type="radio"]:checked');
      const fallback = root.querySelector<HTMLElement>(FOCUSABLE);
      (preferred || field || checkedRadio || fallback || root).focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (item) => item.offsetParent !== null || item === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(focusFirst);
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [isOpen, dialogRef]);
}
