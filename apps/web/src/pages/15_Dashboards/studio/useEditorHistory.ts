/**
 * Studio editing state with undo/redo: a stack of immutable snapshots {name, description, document}.
 * Consecutive edits with the same `coalesce` key within 800 ms (typing in a field, nudging a slider)
 * form one undo step. `dirty` compares the current snapshot id with the last saved one, so undoing back
 * to the saved state clears the indicator.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { DashboardDocument } from '../../../features/dashboard/types';

export interface EditorSnapshot {
  id: number;
  name: string;
  description: string;
  document: DashboardDocument;
}

const LIMIT = 100;
const COALESCE_MS = 800;

interface HistoryState {
  past: EditorSnapshot[];
  present: EditorSnapshot;
  future: EditorSnapshot[];
}

let nextId = 1;

export function useEditorHistory(initial: Omit<EditorSnapshot, 'id'>) {
  const [state, setState] = useState<HistoryState>(() => ({ past: [], present: { ...initial, id: nextId++ }, future: [] }));
  const [savedId, setSavedId] = useState<number>(() => state.present.id);
  const lastEdit = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });

  const apply = useCallback((update: (s: EditorSnapshot) => Partial<Omit<EditorSnapshot, 'id'>> | null, coalesce?: string) => {
    setState((h) => {
      const patch = update(h.present);
      if (!patch) return h;
      const next: EditorSnapshot = { ...h.present, ...patch, id: nextId++ };
      if (next.name === h.present.name && next.description === h.present.description && next.document === h.present.document) return h;
      const now = Date.now();
      const merge = coalesce && lastEdit.current.key === coalesce && now - lastEdit.current.at < COALESCE_MS && h.past.length > 0;
      lastEdit.current = { key: coalesce ?? null, at: now };
      if (merge) return { past: h.past, present: next, future: [] };
      const past = [...h.past, h.present];
      return { past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past, present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    lastEdit.current = { key: null, at: 0 };
    setState((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h));
  }, []);

  const redo = useCallback(() => {
    lastEdit.current = { key: null, at: 0 };
    setState((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));
  }, []);

  /** Replace everything (after a reload or a restore): no undo across it. */
  const reset = useCallback((snap: Omit<EditorSnapshot, 'id'>) => {
    const present = { ...snap, id: nextId++ };
    lastEdit.current = { key: null, at: 0 };
    setState({ past: [], present, future: [] });
    setSavedId(present.id);
  }, []);

  /** Mark a snapshot as saved (the server accepted it). */
  const markSaved = useCallback((id: number) => setSavedId(id), []);

  return useMemo(
    () => ({
      present: state.present,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      dirty: state.present.id !== savedId,
      apply,
      undo,
      redo,
      reset,
      markSaved,
    }),
    [state, savedId, apply, undo, redo, reset, markSaved],
  );
}
