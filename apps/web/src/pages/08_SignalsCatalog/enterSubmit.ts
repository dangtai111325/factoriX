import type React from 'react';

/**
 * True when a keydown is a plain Enter that should submit the surrounding dialog: not inside a
 * textarea (new line), not on a button / link / select / checkbox (Enter already activates those),
 * not while an IME composition is running, and no modifier other than Ctrl/Cmd.
 * Callers run their in-flight-guarded submit handler, so a held key never submits twice.
 */
export function isEnterSubmit(event: React.KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return false;
  const target = event.target as HTMLElement;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return false;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') return false;
  }
  if (target.isContentEditable) return false;
  return true;
}
