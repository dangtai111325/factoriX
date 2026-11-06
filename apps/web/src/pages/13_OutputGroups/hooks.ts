// Data hooks for the Data Model screens (own fetches; the global AppContext is not used for models).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  errorText,
  getEvents,
  getLatest,
  getLatestValues,
  getPreview,
  listModels,
  listResourceSignals,
  listTemplates,
} from './modelApi';
import { subscribeModels, subscribeSignals, useStreamStatus } from './liveAdapter';
import type {
  LatestResult,
  LatestValue,
  ModelEventItem,
  ModelKind,
  ModelListItem,
  ModelTemplate,
  PreviewResult,
  ResourceSignal,
} from './types';

export const POLL_MS = 5000;

/** source_timestamp of a pushed event body, for display only (null when absent/unparsable). */
function bodySourceTs(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed.source_timestamp === 'string' ? parsed.source_timestamp : null;
  } catch {
    return null;
  }
}

export function useModels() {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setModels((await listModels()).filter((m) => m.status !== 'ARCHIVED'));
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Could not load data models.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { models, loading, error, reload };
}

export function useTemplates(enabled: boolean) {
  const [templates, setTemplates] = useState<ModelTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await listTemplates());
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Could not load templates.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { templates, loading, error, reload };
}

/** Active signals of one resource plus their live values (stream, or 5 s poll when closed). */
export function useResourceSignals(resourceId: string, live: boolean) {
  const [signals, setSignals] = useState<ResourceSignal[]>([]);
  const [latest, setLatest] = useState<Map<string, LatestValue>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadedFor, setLoadedFor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stream = useStreamStatus();

  useEffect(() => {
    let alive = true;
    setSignals([]);
    setLatest(new Map());
    setLoadedFor('');
    if (!resourceId) return;
    setLoading(true);
    listResourceSignals(resourceId)
      .then((rows) => {
        if (!alive) return;
        setSignals(rows);
        setError(null);
        setLoadedFor(resourceId);
      })
      .catch((err) => alive && setError(errorText(err, 'Could not load signals for this resource.')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [resourceId]);

  const ids = useMemo(() => signals.map((s) => s.id), [signals]);
  const idsKey = ids.join(',');

  useEffect(() => {
    if (!live || ids.length === 0) return;
    let alive = true;
    const pull = () =>
      getLatestValues(ids)
        .then((m) => alive && setLatest(m))
        .catch((err) => alive && setError(errorText(err, 'Could not read live values.')));
    void pull();
    if (stream === 'open') {
      const unsub = subscribeSignals(ids, (msg) => {
        setLatest((prev) => {
          const next = new Map(prev);
          next.set(msg.signal_id, {
            value: msg.value,
            quality: msg.effective_status || msg.quality || null,
            receivedTime: msg.received_time ?? null,
            sourceTime: msg.source_time ?? null,
          });
          return next;
        });
      });
      return () => {
        alive = false;
        unsub();
      };
    }
    const t = setInterval(pull, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [idsKey, live, stream]);

  // Only non-null once the list for the *current* resource is loaded (never the previous one's).
  const loaded = loadedFor !== '' && loadedFor === resourceId;
  const signalIds = useMemo(() => (loaded ? new Set(ids) : null), [ids, loaded]);
  return { signals, latest, loading, error, signalIds };
}

/** Live preview of one saved model: emitted body, computed preview, events. */
export function useModelLive(groupId: string | null, kind: ModelKind, active: boolean, refreshToken: number) {
  const stream = useStreamStatus();
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [latest, setLatest] = useState<LatestResult | null>(null);
  const [liveBody, setLiveBody] = useState<{ body: string; at: number } | null>(null);
  const [events, setEvents] = useState<ModelEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const lastPreviewAt = useRef(0);

  const fetchAll = useCallback(async () => {
    if (!groupId) return;
    const tasks: Promise<unknown>[] = [
      getPreview(groupId).then(setPreview),
      getLatest(groupId).then(setLatest),
    ];
    if (kind === 'EVENT') tasks.push(getEvents(groupId, 50).then(setEvents));
    const results = await Promise.allSettled(tasks);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    setError(failed ? errorText(failed.reason, 'Could not refresh the preview.') : null);
    lastPreviewAt.current = Date.now();
    setLastFetch(Date.now());
  }, [groupId, kind]);

  useEffect(() => {
    setPreview(null);
    setLatest(null);
    setLiveBody(null);
    setEvents([]);
    setError(null);
  }, [groupId]);

  useEffect(() => {
    if (!active || !groupId) return;
    void fetchAll();
    if (stream === 'open') {
      const unsub = subscribeModels([groupId], (msg) => {
        if (msg.group_id !== groupId) return;
        if (msg.type === 'model_body') {
          setLiveBody({ body: msg.body, at: Date.now() });
        } else {
          setEvents((prev) =>
            prev.some((e) => e.id === msg.event_id)
              ? prev
              : [{ id: msg.event_id, source_ts: bodySourceTs(msg.body), body: msg.body }, ...prev].slice(0, 50),
          );
        }
        // Keep the per-field table roughly in step with the stream without hammering the API.
        if (Date.now() - lastPreviewAt.current > POLL_MS) void fetchAll();
      });
      return unsub;
    }
    const t = setInterval(() => void fetchAll(), POLL_MS);
    return () => clearInterval(t);
  }, [active, groupId, stream, fetchAll, refreshToken]);

  return { stream, preview, latest, liveBody, events, error, lastFetch, refresh: fetchAll };
}
