/**
 * Checkbox multi-select with Shift+click range selection (Signals table, Add Data field table).
 *
 * `order` is the visible order of the rows (after filters / sorting). A plain click toggles one row and
 * makes it the anchor; Shift+click sets every visible row between the anchor and the clicked row to the
 * clicked row's new state. Space on a focused checkbox toggles one row (keyboard).
 * Ids that no longer exist are dropped from the selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface RangeSelection {
  selected: Set<string>;
  count: number;
  isSelected: (id: string) => boolean;
  /** Toggle `id`; with `shift` the range from the anchor to `id` follows its new state. */
  toggle: (id: string, shift: boolean) => void;
  /** Select (or unselect) every id of `ids`, leaving the others as they are. */
  setMany: (ids: string[], on: boolean) => void;
  clear: () => void;
  /** Header checkbox state for `ids` (usually the visible rows). */
  stateOf: (ids: string[]) => 'none' | 'some' | 'all';
}

export function useRangeSelection(order: string[], existing?: string[]): RangeSelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  // Drop ids that disappeared (deleted rows / signals).
  const existingKey = (existing ?? order).join('|');
  useEffect(() => {
    const keep = new Set(existing ?? orderRef.current);
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (keep.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
    // existingKey captures the content of `existing` / `order`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingKey]);

  const toggle = useCallback((id: string, shift: boolean) => {
    const anchor = anchorRef.current;
    anchorRef.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(id);
      const list = orderRef.current;
      const from = anchor ? list.indexOf(anchor) : -1;
      const to = list.indexOf(id);
      if (shift && from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i += 1) {
          if (on) next.add(list[i]);
          else next.delete(list[i]);
        }
      } else if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelected(new Set());
  }, []);

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const stateOf = useCallback(
    (ids: string[]): 'none' | 'some' | 'all' => {
      if (!ids.length) return 'none';
      let n = 0;
      ids.forEach((id) => {
        if (selected.has(id)) n += 1;
      });
      return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
    },
    [selected],
  );

  return useMemo(
    () => ({ selected, count: selected.size, isSelected, toggle, setMany, clear, stateOf }),
    [selected, isSelected, toggle, setMany, clear, stateOf],
  );
}

/** Ref callback setting a checkbox's `indeterminate` flag (not expressible as an attribute). */
export function indeterminateRef(on: boolean) {
  return (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = on;
  };
}
