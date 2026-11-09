// Data hooks for the Data Model screens: list, catalog (data picker), live bodies and the editor preview.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../store/AppContext';
import { subscribeModels, subscribeSignals, useStreamStatus } from '../../lib/liveStream';
import { errorText, getCatalog, getLatest, getLatestValues, isNotFound, listModels, normErrors, previewSpec, validateSpec } from './api';
import { CatalogIndex, indexCatalog } from './rules';
import type { ApiSpec, Catalog, FieldError, LatestBody, ModelListItem, PreviewResult, ValidateResult } from './types';
import type { SignalItem } from '../../types';

/**
 * Raw source group of a signal, from its source address: the JSON object holding the field (MQTT /
 * HTTP / WebSocket), the node folder (OPC UA), else the topic / connection. Used by the "grouped" layout.
 */
export function rawGroupOf(sig: SignalItem | undefined): string {
  if (!sig) return '';
  const a = (sig.addressJson || {}) as Record<string, unknown>;
  const jsonpath = typeof a.jsonpath === 'string' ? a.jsonpath : '';
  if (jsonpath) {
    const parts = jsonpath.replace(/\[["']?([^\]"']+)["']?\]/g, '.$1').split('.').filter((x) => x && x !== '$');
    if (parts.length > 1) return parts[parts.length - 2];
  }
  const node = typeof a.node_id === 'string' ? a.node_id : '';
  if (node) {
    const id = /;s=(.*)$/.exec(node)?.[1] ?? node;
    const segs = id.split('.');
    if (segs.length > 1) return segs[segs.length - 2];
  }
  const topic = typeof a.topic === 'string' ? a.topic : typeof a.path === 'string' ? a.path : '';
  if (topic) {
    const segs = topic.split('/').filter(Boolean);
    return segs[segs.length - 1] || topic;
  }
  return sig.sourceConnectionName || '';
}

export const POLL_MS = 5000;

function useVisibleDocument(): boolean {
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

// ------------------------------------------------------------------ list

export function useModelList() {
  const [models, setModelsState] = useState<ModelListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useVisibleDocument();
  const seqRef = useRef(0);

  const setModels = useCallback((val: React.SetStateAction<ModelListItem[]>) => {
    seqRef.current += 1;
    setModelsState(val);
  }, []);

  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const seq = ++seqRef.current;
    try {
      const data = await listModels();
      if (seq === seqRef.current) {
        setModelsState(data);
        setError(null);
        setLoaded(true);
      }
    } catch (err) {
      if (seq === seqRef.current) {
        setError(errorText(err, 'Could not load data models.'));
      }
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Background refresh for counters / last sample time (bodies are live per card).
  useEffect(() => {
    if (!visible) return;
    const t = window.setInterval(() => void reload(true), 15000);
    return () => window.clearInterval(t);
  }, [reload, visible]);
  return { models, setModels, loading, loaded, error, reload };
}

// ------------------------------------------------------------------ catalog

/**
 * Signal tree for the data picker. Uses GET /data-models/catalog; when the server does not offer it
 * (older Center) the tree is built from the resources and signals already loaded by the app.
 */
export function useCatalog() {
  const { resources, signals } = useApp();
  const [remote, setRemote] = useState<Catalog | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRemote(await getCatalog());
      setUnsupported(false);
      setError(null);
    } catch (err) {
      if (isNotFound(err)) setUnsupported(true);
      else setError(errorText(err, 'Could not load the data tree.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // The app's signal list changes on every live tick; the tree only depends on its structure, so the
  // derived catalog is rebuilt when ids / keys / owners / addresses change, not when values change
  // (values come from useLiveValues).
  const latest = useRef({ resources, signals });
  latest.current = { resources, signals };
  const structureKey = useMemo(
    () =>
      `${resources.map((r) => `${r.id}:${r.parentId || ''}:${r.type}:${r.name}:${r.code}`).join('|')}#${signals
        .map((s) => `${s.id}:${s.resourceId}:${s.key || s.tag}:${s.topic || ''}:${s.address || ''}:${s.sourceConnectionName || ''}`)
        .join('|')}`,
    [resources, signals],
  );

  const fallback = useMemo<Catalog>(() => {
    const { resources: res, signals: sigs } = latest.current;
    return {
      typeNames: {},
      resources: res.map((r) => ({ id: r.id, parentId: r.parentId || null, type: String(r.type || '').toLowerCase(), name: r.name || r.code, code: r.code || '' })),
      signals: sigs
        .filter((s) => s.resourceId && (s.key || s.tag))
        .map((s) => ({
          id: s.id,
          resourceId: s.resourceId,
          key: s.key || s.tag,
          name: s.displayName || s.name || s.key || s.tag,
          dataType: String(s.dataType || ''),
          unit: s.unit || '',
          value: s.currentValue ?? s.value ?? null,
          quality: s.quality ? String(s.quality) : null,
          receivedTime: s.receivedTime || null,
          sourceTime: s.sourceTime || null,
          protocol: s.connectionProtocol || '',
          connectionName: s.sourceConnectionName || '',
          group: rawGroupOf(s),
          ref: '',
        })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // Enrich the server catalog with the raw source group known from the signal addresses.
  const catalog = useMemo<Catalog>(() => {
    if (!remote || unsupported) return fallback;
    const bySignal = new Map(latest.current.signals.map((s) => [s.id, s]));
    return { ...remote, signals: remote.signals.map((s) => ({ ...s, group: rawGroupOf(bySignal.get(s.id)) || s.group })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, unsupported, fallback, structureKey]);
  const index = useMemo<CatalogIndex>(() => indexCatalog(catalog), [catalog]);
  return { index, loading: loading && !remote, error, reload, unsupported };
}

// ------------------------------------------------------------------ live signal values

export interface LiveValue {
  value: unknown;
  quality: string | null;
  receivedTime: string | null;
}

/** Live values for the given signals: pushed over the stream, polled every 5 s otherwise. */
export function useLiveValues(ids: string[]): Map<string, LiveValue> {
  const [values, setValues] = useState<Map<string, LiveValue>>(new Map());
  const stream = useStreamStatus();
  const visible = useVisibleDocument();
  const key = useMemo(() => Array.from(new Set(ids)).sort().join(','), [ids]);

  useEffect(() => {
    const list = key ? key.split(',') : [];
    if (!list.length || !visible) return;
    let alive = true;
    const pull = () =>
      getLatestValues(list)
        .then((m) => alive && setValues((prev) => new Map([...prev, ...m])))
        .catch(() => undefined); // the tree keeps the catalog values; the banner shows API errors
    void pull();
    if (stream === 'open') {
      const unsub = subscribeSignals(list, (msg) =>
        setValues((prev) => {
          const next = new Map(prev);
          next.set(msg.signal_id, { value: msg.value, quality: msg.effective_status || msg.quality || null, receivedTime: msg.received_time ?? null });
          return next;
        }),
      );
      return () => {
        alive = false;
        unsub();
      };
    }
    const t = window.setInterval(pull, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [key, stream, visible]);
  return values;
}

// ------------------------------------------------------------------ live model body

/** Latest body of a saved model: pushed (`model_body`) or polled when the stream is not open. */
export function useModelBody(modelId: string | null, opts: { enabled: boolean; pollMs?: number; initial?: string | null }) {
  const stream = useStreamStatus();
  const visible = useVisibleDocument();
  const [state, setState] = useState<LatestBody>({ body: opts.initial ?? null, sampledAt: null, errors: [] });
  const [loading, setLoading] = useState(!opts.initial);
  const [error, setError] = useState<string | null>(null);
  const [pushes, setPushes] = useState(0);
  const pollMs = Math.max(1000, opts.pollMs ?? POLL_MS);

  const fetchNow = useCallback(async () => {
    if (!modelId) return;
    try {
      const latest = await getLatest(modelId);
      setState(latest);
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Could not read the latest body.'));
    } finally {
      setLoading(false);
    }
  }, [modelId]);

  useEffect(() => {
    if (!modelId || !opts.enabled || !visible) return;
    void fetchNow();
    if (stream === 'open') {
      return subscribeModels([modelId], (msg) => {
        if (msg.group_id !== modelId || msg.type !== 'model_body') return;
        setState((prev) => ({
          body: msg.body,
          sampledAt: msg.sampled_at ?? new Date().toISOString(),
          errors: msg.errors !== undefined ? normErrors(msg.errors) : prev.errors,
        }));
        setPushes((n) => n + 1);
        setLoading(false);
      });
    }
    const t = window.setInterval(() => void fetchNow(), pollMs);
    return () => window.clearInterval(t);
  }, [modelId, opts.enabled, stream, visible, fetchNow, pollMs]);

  return { ...state, loading, error, stream, pushes, refresh: fetchNow };
}

/**
 * Source quality of a saved model's fields (R4-DM-08): GET /latest every `pollMs` while visible. The
 * pushed bodies carry no quality, so this runs next to useModelBody.
 */
export function useModelQuality(modelId: string | null, opts: { enabled: boolean; initial?: LatestBody | null; pollMs?: number }) {
  const visible = useVisibleDocument();
  const [state, setState] = useState<{ fields: NonNullable<LatestBody['fields']>; quality: LatestBody['quality'] }>({
    fields: opts.initial?.fields || [],
    quality: opts.initial?.quality ?? null,
  });
  useEffect(() => {
    if (opts.initial?.quality !== undefined) setState({ fields: opts.initial.fields || [], quality: opts.initial.quality ?? null });
  }, [opts.initial]);
  const pollMs = Math.max(3000, opts.pollMs ?? POLL_MS);
  useEffect(() => {
    if (!modelId || !opts.enabled || !visible) return;
    let alive = true;
    const pull = () =>
      getLatest(modelId)
        .then((r) => alive && r.quality !== undefined && setState({ fields: r.fields || [], quality: r.quality ?? null }))
        .catch(() => undefined); // the body hook reports connection problems
    const t = window.setInterval(pull, pollMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [modelId, opts.enabled, visible, pollMs]);
  return state;
}

// ------------------------------------------------------------------ editor preview / validation

/**
 * Live preview of an unsaved spec: POST /data-models/preview every `sampleMs` (min 1 s) and shortly after
 * every change. Requests never overlap; a newer spec aborts the running one.
 */
export function usePreviewLoop(spec: ApiSpec | null, sampleMs: number, enabled: boolean, modelId: string | null) {
  // Keeps stateful filter state between preview calls on the server (5 min idle TTL).
  const sessionId = useMemo(() => `pv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, []);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [paused, setPaused] = useState(false);
  const visible = useVisibleDocument();
  const specText = useMemo(() => (spec ? JSON.stringify(spec) : ''), [spec]);
  const inflight = useRef<AbortController | null>(null);
  const lastText = useRef('');

  const run = useCallback(async (text: string) => {
    if (!text) return;
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setRunning(true);
    try {
      const res = await previewSpec(JSON.parse(text) as ApiSpec, { sessionId, modelId }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      lastText.current = text;
      setResult(res);
      setError(null);
      setUnsupported(false);
    } catch (err) {
      if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      if (isNotFound(err)) setUnsupported(true);
      else setError(errorText(err, 'Preview failed.'));
    } finally {
      if (inflight.current === ctrl) {
        inflight.current = null;
        setRunning(false);
      }
    }
  }, [sessionId, modelId]);

  // Debounced run after a change.
  useEffect(() => {
    if (!enabled || !specText || unsupported) return;
    const t = window.setTimeout(() => void run(specText), 400);
    return () => window.clearTimeout(t);
  }, [specText, enabled, run, unsupported]);

  // Heartbeat at the model's sampling rate.
  useEffect(() => {
    if (!enabled || !specText || !visible || paused || unsupported) return;
    const every = Math.max(1000, sampleMs || 1000);
    const t = window.setInterval(() => {
      if (!inflight.current) void run(specText);
    }, every);
    return () => window.clearInterval(t);
  }, [specText, sampleMs, enabled, visible, paused, run, unsupported]);

  useEffect(() => () => inflight.current?.abort(), []);

  return { result, error, running, unsupported, paused, setPaused, refresh: () => void run(specText) };
}

/** Debounced POST /data-models/validate for the editor. */
export function useValidation(spec: ApiSpec | null, enabled: boolean, modelId: string | null, delayMs = 600) {
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const specText = useMemo(() => (spec ? JSON.stringify(spec) : ''), [spec]);
  useEffect(() => {
    if (!enabled || !specText || unsupported) return;
    const ctrl = new AbortController();
    setPending(true);
    const t = window.setTimeout(() => {
      validateSpec(JSON.parse(specText) as ApiSpec, modelId, ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setResult(r);
          setError(null);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          if (isNotFound(err)) setUnsupported(true);
          else setError(errorText(err, 'Validation failed.'));
        })
        .finally(() => !ctrl.signal.aborted && setPending(false));
    }, delayMs);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [specText, enabled, delayMs, unsupported, modelId]);
  return { result, error, pending, unsupported };
}

export type { FieldError };
