import { useRef, useState, useCallback } from 'react';
import { api, ApiError } from '../../api/client';
import { ItemGeometry } from './AutoGrid';

export interface LevelDraft {
  mode: 'auto' | 'custom';
  items: Record<string, ItemGeometry>;
}

export interface LayoutDraftJson {
  version: number;
  levels: Record<string, LevelDraft>;
}

export function useLayoutPersistence(
  layoutId: string | null,
  initialVersion: number = 1
) {
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const versionRef = useRef<number>(initialVersion);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<number | null>(null);
  const draftRef = useRef<Record<string, LevelDraft>>({});

  const saveLevel = useCallback(
    (levelId: string, levelState: LevelDraft) => {
      draftRef.current[levelId] = levelState;
      if (!layoutId) return;

      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }

      setSaveStatus('saving');

      timerRef.current = window.setTimeout(() => {
        queueRef.current = queueRef.current
          .then(async () => {
            const payload = {
              version: versionRef.current,
              draft: {
                version: 2,
                levels: draftRef.current,
              },
            };
            try {
              const res = await api<{ version: number }>(
                `/api/v1/layouts/${encodeURIComponent(layoutId)}/draft`,
                {
                  method: 'PATCH',
                  body: JSON.stringify(payload),
                }
              );
              versionRef.current = res.version;
              setSaveStatus('saved');
              setLastSavedTime('just now');
            } catch (err: unknown) {
              if (err instanceof ApiError && err.status === 409) {
                // Fetch fresh layout version and retry once
                try {
                  const fresh = await api<{ id: string; version: number; draft_json: LayoutDraftJson }>(
                    `/api/v1/layouts/${encodeURIComponent(layoutId)}`
                  );
                  versionRef.current = fresh.version;
                  const freshLevels = fresh.draft_json?.levels || {};
                  draftRef.current = { ...freshLevels, [levelId]: levelState };

                  const retryRes = await api<{ version: number }>(
                    `/api/v1/layouts/${encodeURIComponent(layoutId)}/draft`,
                    {
                      method: 'PATCH',
                      body: JSON.stringify({
                        version: versionRef.current,
                        draft: { version: 2, levels: draftRef.current },
                      }),
                    }
                  );
                  versionRef.current = retryRes.version;
                  setSaveStatus('saved');
                  setLastSavedTime('just now');
                  return;
                } catch {
                  setSaveStatus('error');
                  return;
                }
              }
              setSaveStatus('error');
            }
          })
          .catch(() => {
            setSaveStatus('error');
          });
      }, 800);
    },
    [layoutId]
  );

  return {
    saveStatus,
    lastSavedTime,
    saveLevel,
    draftLevels: draftRef.current,
    setVersion: (v: number) => {
      versionRef.current = v;
    },
  };
}
