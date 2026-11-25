/**
 * Dashboard runtime store (contract §7). One instance per rendered dashboard (view mode, Studio canvas,
 * revision preview); widgets never open sockets or fetch on their own.
 *
 *  1. Resolution — `POST /dashboards/resolve` once per (document sources, variables) change, debounced,
 *     ≤ `max_resolve_refs` refs per call (larger sets are split), stale answers are dropped.
 *  2. Latest — signal tokens are ref-counted: one `subscribeSignals([id])` per signal id regardless of
 *     how many widgets show it, released (after the current tick) when the last consumer goes. Model
 *     fields are ref-counted per model: `subscribeModels([id])` first, then `GET /data-models/{id}/latest`
 *     (an answer older than a pushed body is ignored). While the stream does not push a signal (socket
 *     down, server cap) its latest row is polled from `/observations/latest` every 5 s; models are re-read
 *     every 5 s without push and every 30 s with push (field quality is only in the REST answer).
 *  3. History — consumers retain an entry per (range, mode, resolution, max_points, live-append, token).
 *     The coordinator groups entries by (range, mode, resolution, max_points), sends ≤ `max_series_per_query`
 *     tokens per `POST /api/v1/historian/query`, shares identical in-flight requests, aborts requests
 *     nobody needs any more and ignores answers superseded by a newer request. Re-query cadence follows
 *     `settings.refresh` (live = 60 s + live append; off = only on change); hidden tabs skip ticks and catch
 *     up when visible. Live append adds pushed values newer than the last point; a `data_epoch` change
 *     (telemetry reset) or a stream `resync` drops appended points and re-queries.
 *
 * Values are stored raw; scale/offset and data states are applied by the widget data builder.
 */
import {
  getPushedSignalIds,
  getStreamStatus,
  onPushCoverageChange,
  onStreamResync,
  onStreamStatusChange,
  serverNowMs,
  subscribeModels,
  subscribeSignals,
  type LatestMsg,
  type ModelBodyMsg,
  type ModelEventMsg,
} from '../../../lib/liveStream';
import { errorLine, getLatestObservations, getModelLatest, isAbort, queryHistorian, resolveSources } from '../api';
import { sourceKey } from '../document';
import { rangeKey, refreshMs, resolveTimeRange } from '../timeRange';
import type {
  DashboardDocument,
  HistorianQueryRequest,
  HistorianSeriesRaw,
  RefreshPolicy,
  RegistryLimits,
  ResolvedSource,
  SourceRef,
  TimeRange,
} from '../types';
import { extractField, parseModelToken, samePath } from './modelPath';

// ------------------------------------------------------------------ public shapes

export interface RawLatest {
  value: unknown;
  found: boolean;
  ts: number | null;
  quality: string | null;
  freshness: string | null;
  effective_status: string | null;
  reason_code: string | null;
  epoch: number | null;
}

export interface RawPoint {
  t: number;
  v: unknown;
  q: string | null;
  epoch: number | null;
}

export interface RawHistory {
  status: string;
  points: RawPoint[];
  downsampled: boolean;
  truncated: boolean;
  fidelity: string;
  notes: string[];
  bucket_ms: number | null;
  next_cursor: string | null;
}

export interface HistoryParams {
  range: TimeRange;
  mode: 'operational' | 'recorded';
  resolution: 'auto' | 'raw';
  maxPoints: number;
  liveAppend: boolean;
}

interface HistoryEntry {
  key: string;
  token: string;
  groupKey: string;
  params: HistoryParams;
  refs: number;
  data: RawHistory | null;
  error: string | null;
  stale: boolean;
  inflight: string | null;
  version: number;
  fetchedAt: number | null;
  appended: number;
}

interface InflightRequest {
  controller: AbortController;
  entries: Set<string>;
}

interface ModelState {
  refs: number;
  unsub: (() => void) | null;
  body: unknown;
  hasBody: boolean;
  sampledAt: number | null;
  errors: Array<{ path?: string; code?: string; message?: string }>;
  fieldQuality: Map<string, { quality: string; reason: string | null }> | null;
  loaded: boolean;
  loadError: string | null;
  version: number;
  lastFetch: number;
  fetching: boolean;
}

export interface RuntimeInputs {
  document: DashboardDocument;
  variables: Record<string, string | null>;
  refresh: RefreshPolicy;
  limits: RegistryLimits;
}

export type ResolveStatus = 'idle' | 'loading' | 'ready' | 'error';

export function groupKeyOf(p: HistoryParams): string {
  return `${rangeKey(p.range)}|${p.mode}|${p.resolution}|${p.maxPoints}`;
}

export function entryKeyOf(token: string, p: HistoryParams): string {
  return `${groupKeyOf(p)}|${p.liveAppend ? 'la' : '-'}|${token}`;
}

const SIGNAL_POLL_MS = 5000;
const MODEL_POLL_PUSH_MS = 30000;
const MODEL_POLL_NO_PUSH_MS = 5000;
const SETTLE_MS = 1500;

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function str(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Latest row from the stream (`latest` frame) or `/observations/latest`. */
function latestFromRow(row: Record<string, unknown>): RawLatest {
  const vj = row.value_json as { v?: unknown } | null | undefined;
  const value = row.value !== undefined ? row.value : vj && typeof vj === 'object' ? vj.v : null;
  return {
    value: value === undefined ? null : value,
    found: value !== undefined && value !== null,
    ts: parseTs(row.last_acquired_at) ?? parseTs(row.source_time) ?? parseTs(row.received_time) ?? parseTs(row.event_time),
    quality: str(row.quality)?.toUpperCase() ?? null,
    freshness: str(row.freshness)?.toUpperCase() ?? null,
    effective_status: str(row.effective_status)?.toUpperCase() ?? null,
    reason_code: str(row.reason_code),
    epoch: numOrNull(row.data_epoch),
  };
}

/** Data Model field quality word (good / stale / paused / no_data / missing / bad …) → server verdict fields. */
function modelFieldVerdict(q: string | undefined): Pick<RawLatest, 'quality' | 'freshness' | 'effective_status' | 'reason_code'> {
  switch ((q || '').toLowerCase()) {
    case 'good':
      return { quality: 'GOOD', freshness: 'FRESH', effective_status: 'GOOD', reason_code: null };
    case 'uncertain':
      return { quality: 'UNCERTAIN', freshness: null, effective_status: 'UNCERTAIN', reason_code: null };
    case 'bad':
      return { quality: 'BAD', freshness: null, effective_status: 'BAD', reason_code: null };
    case 'missing':
      return { quality: 'BAD', freshness: null, effective_status: 'BAD', reason_code: 'SOURCE_MISSING' };
    case 'stale':
      return { quality: null, freshness: 'STALE', effective_status: 'STALE', reason_code: null };
    case 'paused':
      return { quality: null, freshness: 'STALE', effective_status: 'STALE', reason_code: 'PAUSED' };
    case 'disabled':
      return { quality: null, freshness: 'STALE', effective_status: 'STALE', reason_code: 'DISABLED' };
    case 'no_data':
      return { quality: null, freshness: 'NO_DATA', effective_status: null, reason_code: null };
    default:
      return { quality: null, freshness: null, effective_status: null, reason_code: null };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------------ store

export class DashboardRuntimeStore {
  private listeners = new Set<() => void>();
  private emitQueued = false;
  private version = 0;

  // inputs
  private inputs: RuntimeInputs | null = null;

  // resolution
  private resolved = new Map<string, ResolvedSource>();
  private resolveSig = '';
  private resolveTimer: number | null = null;
  private resolveAbort: AbortController | null = null;
  private resolveSeq = 0;
  resolveStatus: ResolveStatus = 'idle';
  resolveError: string | null = null;
  private resolveVersion = 0;

  // latest (signals)
  private signalRefs = new Map<string, { refs: number; unsub: () => void }>();
  private latest = new Map<string, RawLatest>();
  private latestVersion = new Map<string, number>();
  private settled = new Set<string>();
  private settleTimer: number | null = null;
  private lastEpoch: number | null = null;

  // latest (models)
  private models = new Map<string, ModelState>();

  // history
  private entries = new Map<string, HistoryEntry>();
  private requests = new Map<string, InflightRequest>();
  private flushTimer: number | null = null;
  private refreshTimer: number | null = null;
  private missedTick = false;

  // lifecycle
  private started = false;
  private offs: Array<() => void> = [];
  private pollTimer: number | null = null;

  /** Newest data time seen (latest frame or history answer), for the "Last update" label. */
  lastUpdateAt: number | null = null;

  // ---------------------------------------------------------------- subscription (React)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    const run = () => {
      this.emitQueued = false;
      this.version++;
      this.listeners.forEach((l) => l());
    };
    if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else window.setTimeout(run, 50);
  }

  /** Compact version string of the parts a widget depends on (React bails out when it is unchanged). */
  signature(resolveKeys: string[], latestTokens: string[], entryKeys: string[]): string {
    let s = `${this.resolveVersion}:${this.resolveStatus}`;
    for (const k of resolveKeys) s += `|${this.resolved.has(k) ? 1 : 0}`;
    for (const t of latestTokens) {
      const m = parseModelToken(t);
      if (m) {
        const st = this.models.get(m.modelId);
        s += `|m${st ? st.version : -1}${st?.loaded ? 'L' : ''}`;
      } else s += `|s${this.latestVersion.get(t) ?? -1}${this.settled.has(t) ? 'S' : ''}`;
    }
    for (const k of entryKeys) s += `|h${this.entries.get(k)?.version ?? -1}`;
    return s;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    this.offs.push(
      onStreamResync(() => this.onResync()),
      onStreamStatusChange(() => this.emit()),
      onPushCoverageChange(() => this.emit()),
    );
    const onVisible = () => {
      if (!document.hidden && this.missedTick) {
        this.missedTick = false;
        this.tick();
      }
      if (!document.hidden) this.poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.offs.push(() => document.removeEventListener('visibilitychange', onVisible));
    this.pollTimer = window.setInterval(() => this.poll(), SIGNAL_POLL_MS);
    this.armRefresh();
    if (this.inputs) this.scheduleResolve(0);
    this.scheduleFlush();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.offs.forEach((off) => off());
    this.offs = [];
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.resolveTimer !== null) window.clearTimeout(this.resolveTimer);
    this.resolveTimer = null;
    this.resolveAbort?.abort();
    this.resolveAbort = null;
    this.resolveSig = '';
    this.requests.forEach((r) => r.controller.abort());
    this.requests.clear();
    this.entries.forEach((e) => {
      e.inflight = null;
      if (!e.data) e.stale = true;
    });
  }

  // ---------------------------------------------------------------- inputs

  setInputs(next: RuntimeInputs): void {
    const prev = this.inputs;
    this.inputs = next;
    if (!prev || prev.refresh !== next.refresh) this.armRefresh();
    this.scheduleResolve(prev ? 250 : 0);
  }

  get limits(): RegistryLimits | null {
    return this.inputs?.limits ?? null;
  }

  // ---------------------------------------------------------------- resolution

  private collectSources(doc: DashboardDocument): SourceRef[] {
    const seen = new Map<string, SourceRef>();
    for (const w of doc.widgets) for (const b of w.bindings) if (b.source.kind !== 'role') seen.set(sourceKey(b.source), b.source);
    return Array.from(seen.values());
  }

  private scheduleResolve(delay: number): void {
    if (!this.inputs || !this.started) return;
    const sources = this.collectSources(this.inputs.document);
    // Every document variable is sent (null = nothing selected), as the contract requires.
    const variables: Record<string, string | null> = {};
    for (const v of this.inputs.document.variables) variables[v.id] = this.inputs.variables[v.id] ?? null;
    const sig = JSON.stringify([sources.map(sourceKey).sort(), variables]);
    if (sig === this.resolveSig) return;
    if (this.resolveTimer !== null) window.clearTimeout(this.resolveTimer);
    // Variable-dependent results are wrong as soon as a variable changes: drop them now.
    const prevVars = this.resolveSig ? (JSON.parse(this.resolveSig)[1] as Record<string, string | null>) : {};
    let dropped = false;
    for (const [k] of this.resolved) {
      if (!k.startsWith('signal_key:')) continue;
      const variable = k.split(':')[1];
      if (prevVars[variable] !== variables[variable]) {
        this.resolved.delete(k);
        dropped = true;
      }
    }
    if (dropped) {
      this.resolveVersion++;
      this.emit();
    }
    this.resolveTimer = window.setTimeout(() => {
      this.resolveTimer = null;
      void this.runResolve(sig, sources, variables);
    }, delay);
  }

  private async runResolve(sig: string, sources: SourceRef[], variables: Record<string, string | null>): Promise<void> {
    this.resolveAbort?.abort();
    const seq = ++this.resolveSeq;
    this.resolveSig = sig;
    if (!sources.length) {
      this.resolved.clear();
      this.resolveStatus = 'ready';
      this.resolveError = null;
      this.resolveVersion++;
      this.emit();
      return;
    }
    const controller = new AbortController();
    this.resolveAbort = controller;
    this.resolveStatus = 'loading';
    this.emit();
    const max = Math.max(1, this.inputs?.limits.max_resolve_refs ?? 400);
    try {
      const answers = await Promise.all(chunk(sources, max).map((part) => resolveSources({ variables, sources: part }, controller.signal)));
      if (seq !== this.resolveSeq) return;
      const next = new Map<string, ResolvedSource>();
      answers.forEach((res, ci) => {
        const part = chunk(sources, max)[ci];
        (res.items || []).forEach((item, i) => {
          // The answer is in request order; `item.source` echoes the ref.
          const ref = item.source || part[i];
          if (ref) next.set(sourceKey(ref), item);
        });
      });
      this.resolved = next;
      this.resolveStatus = 'ready';
      this.resolveError = null;
    } catch (error) {
      if (isAbort(error) || seq !== this.resolveSeq) return;
      this.resolveStatus = 'error';
      this.resolveError = errorLine(error, 'The data sources could not be resolved.');
      // Retry the same set later (the next input change or tick also retries).
      this.resolveSig = '';
    } finally {
      if (seq === this.resolveSeq) this.resolveAbort = null;
    }
    this.resolveVersion++;
    this.emit();
  }

  getResolved(ref: SourceRef): ResolvedSource | null {
    if (ref.kind === 'role') {
      return { source: ref, ok: false, error: { code: 'ROLE_UNMAPPED', message: `Template role “${ref.role}” is not mapped to a source.` } };
    }
    return this.resolved.get(sourceKey(ref)) ?? null;
  }

  // ---------------------------------------------------------------- latest: signals

  retainSignal(id: string): void {
    const cur = this.signalRefs.get(id);
    if (cur) {
      cur.refs++;
      return;
    }
    const unsub = subscribeSignals([id], (msg) => this.onLatest(msg));
    this.signalRefs.set(id, { refs: 1, unsub });
    this.scheduleSettle();
  }

  releaseSignal(id: string): void {
    const cur = this.signalRefs.get(id);
    if (!cur) return;
    cur.refs--;
    if (cur.refs > 0) return;
    // Deferred: a consumer re-mounting in the same tick (StrictMode, layout switch) keeps the subscription.
    window.setTimeout(() => {
      const again = this.signalRefs.get(id);
      if (!again || again.refs > 0) return;
      again.unsub();
      this.signalRefs.delete(id);
    }, 0);
  }

  private onLatest(msg: LatestMsg): void {
    this.applyLatest(String(msg.signal_id), latestFromRow(msg as unknown as Record<string, unknown>), true);
  }

  private applyLatest(id: string, next: RawLatest, pushed: boolean): void {
    const prev = this.latest.get(id);
    if (!pushed && prev && prev.ts !== null && next.ts !== null && next.ts < prev.ts) return;
    this.latest.set(id, next);
    this.latestVersion.set(id, (this.latestVersion.get(id) ?? 0) + 1);
    this.settled.add(id);
    if (next.ts !== null) this.lastUpdateAt = Math.max(this.lastUpdateAt ?? 0, next.ts);
    // Telemetry reset (tenant-wide epoch change): appended points and cached history are invalid.
    if (next.epoch !== null) {
      if (this.lastEpoch !== null && next.epoch !== this.lastEpoch) this.invalidateHistory(true);
      this.lastEpoch = next.epoch;
    }
    if (next.found && next.ts !== null) this.appendLive(id, next.ts, next.value, next.quality, next.epoch);
    this.emit();
  }

  private scheduleSettle(): void {
    if (this.settleTimer !== null) return;
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      const missing = Array.from(this.signalRefs.keys()).filter((id) => !this.settled.has(id));
      if (!missing.length) return;
      // No snapshot pushed yet: read the stored latest once, then the signal counts as settled either way.
      getLatestObservations(missing)
        .then((rows) => rows.forEach((r) => this.applyLatest(String(r.signal_id), latestFromRow(r), false)))
        .catch(() => undefined)
        .finally(() => {
          missing.forEach((id) => this.settled.add(id));
          this.emit();
        });
    }, SETTLE_MS);
  }

  getLatestSignal(id: string): RawLatest | null {
    return this.latest.get(id) ?? null;
  }

  isSettled(token: string): boolean {
    const m = parseModelToken(token);
    if (m) return this.models.get(m.modelId)?.loaded ?? false;
    return this.settled.has(token);
  }

  // ---------------------------------------------------------------- latest: models

  retainModel(modelId: string): void {
    const cur = this.models.get(modelId);
    if (cur && cur.refs > 0) {
      cur.refs++;
      return;
    }
    const st: ModelState = cur || {
      refs: 0,
      unsub: null,
      body: null,
      hasBody: false,
      sampledAt: null,
      errors: [],
      fieldQuality: null,
      loaded: false,
      loadError: null,
      version: 0,
      lastFetch: 0,
      fetching: false,
    };
    st.refs = 1;
    this.models.set(modelId, st);
    if (!st.unsub) {
      // Subscribe first, then read the stored sample: a push that arrives meanwhile wins.
      st.unsub = subscribeModels([modelId], (msg) => this.onModelMsg(modelId, msg));
    }
    void this.fetchModel(modelId);
  }

  releaseModel(modelId: string): void {
    const st = this.models.get(modelId);
    if (!st) return;
    st.refs--;
    if (st.refs > 0) return;
    window.setTimeout(() => {
      const again = this.models.get(modelId);
      if (!again || again.refs > 0) return;
      again.unsub?.();
      again.unsub = null;
      this.models.delete(modelId);
    }, 0);
  }

  private async fetchModel(modelId: string): Promise<void> {
    const st = this.models.get(modelId);
    if (!st || st.fetching) return;
    st.fetching = true;
    st.lastFetch = Date.now();
    try {
      const res = await getModelLatest(modelId);
      const cur = this.models.get(modelId);
      if (!cur) return;
      const at = parseTs(res.sampled_at);
      if (!cur.hasBody || cur.sampledAt === null || (at !== null && at >= cur.sampledAt)) {
        let body: unknown = null;
        let ok = false;
        if (res.body !== null) {
          try {
            body = JSON.parse(res.body);
            ok = true;
          } catch {
            ok = false;
          }
        }
        cur.body = body;
        cur.hasBody = ok;
        cur.sampledAt = at;
        cur.errors = res.errors;
      }
      if (res.fields) cur.fieldQuality = new Map(res.fields.map((f) => [f.path, { quality: f.quality, reason: f.reason ?? null }]));
      cur.loaded = true;
      cur.loadError = null;
      cur.version++;
      if (cur.sampledAt !== null) this.lastUpdateAt = Math.max(this.lastUpdateAt ?? 0, cur.sampledAt);
    } catch (error) {
      const cur = this.models.get(modelId);
      if (cur) {
        cur.loaded = true;
        cur.loadError = errorLine(error, 'Could not read the latest model sample.');
        cur.version++;
      }
    } finally {
      const cur = this.models.get(modelId);
      if (cur) cur.fetching = false;
      this.emit();
    }
  }

  private onModelMsg(modelId: string, msg: ModelBodyMsg | ModelEventMsg): void {
    if (msg.type !== 'model_body') return;
    const st = this.models.get(modelId);
    if (!st) return;
    let body: unknown;
    try {
      body = JSON.parse(msg.body);
    } catch {
      return;
    }
    const at = parseTs(msg.sampled_at) ?? serverNowMs();
    if (st.sampledAt !== null && at < st.sampledAt) return;
    st.body = body;
    st.hasBody = true;
    st.sampledAt = at;
    if (msg.errors !== undefined) st.errors = Array.isArray(msg.errors) ? msg.errors : [];
    st.loaded = true;
    st.version++;
    this.lastUpdateAt = Math.max(this.lastUpdateAt ?? 0, at);
    // Live append for every model field of this model that a live-append consumer shows.
    this.entries.forEach((e) => {
      if (!e.params.liveAppend) return;
      const m = parseModelToken(e.token);
      if (!m || m.modelId !== modelId) return;
      const f = extractField(body, m.path);
      if (f.found) this.appendTo(e, at, f.value, this.modelLatest(e.token)?.quality ?? null, null);
    });
    this.emit();
  }

  /** Latest value of a model-field token, from the model's last body and field quality. */
  modelLatest(token: string): RawLatest | null {
    const m = parseModelToken(token);
    if (!m) return null;
    const st = this.models.get(m.modelId);
    if (!st || !st.loaded) return null;
    const f = st.hasBody ? extractField(st.body, m.path) : { found: false, value: null };
    let quality: { quality: string; reason: string | null } | undefined;
    if (st.fieldQuality) {
      for (const [p, q] of st.fieldQuality) {
        if (samePath(p, m.path)) {
          quality = q;
          break;
        }
      }
    }
    const verdict = modelFieldVerdict(quality?.quality);
    const err = st.errors.find((e) => e.path && samePath(e.path, m.path));
    if (err) {
      verdict.quality = 'BAD';
      verdict.effective_status = 'BAD';
      verdict.reason_code = err.code || 'EVALUATION_ERROR';
    }
    if (!f.found && !verdict.freshness) verdict.freshness = 'NO_DATA';
    return { value: f.found ? f.value : null, found: f.found, ts: st.sampledAt, ...verdict, reason_code: verdict.reason_code ?? quality?.reason ?? null, epoch: null };
  }

  modelError(token: string): string | null {
    const m = parseModelToken(token);
    return m ? this.models.get(m.modelId)?.loadError ?? null : null;
  }

  // ---------------------------------------------------------------- polling fallback

  private poll(): void {
    if (!this.started || document.hidden) return;
    const pushed = getPushedSignalIds();
    const notPushed = Array.from(this.signalRefs.keys()).filter((id) => !pushed.has(id));
    if (notPushed.length) {
      getLatestObservations(notPushed)
        .then((rows) => rows.forEach((r) => this.applyLatest(String(r.signal_id), latestFromRow(r), false)))
        .catch(() => undefined);
    }
    const open = getStreamStatus() === 'open';
    const now = Date.now();
    this.models.forEach((st, id) => {
      if (st.refs <= 0) return;
      const every = open ? MODEL_POLL_PUSH_MS : MODEL_POLL_NO_PUSH_MS;
      if (now - st.lastFetch >= every - 250) void this.fetchModel(id);
    });
  }

  private onResync(): void {
    // The server may have missed pushes: re-read latest values and history.
    const ids = Array.from(this.signalRefs.keys());
    if (ids.length) {
      getLatestObservations(ids)
        .then((rows) => rows.forEach((r) => this.applyLatest(String(r.signal_id), latestFromRow(r), false)))
        .catch(() => undefined);
    }
    this.models.forEach((st, id) => st.refs > 0 && void this.fetchModel(id));
    this.invalidateHistory(true);
  }

  // ---------------------------------------------------------------- history

  retainHistory(token: string, params: HistoryParams): string {
    const key = entryKeyOf(token, params);
    const cur = this.entries.get(key);
    if (cur) {
      cur.refs++;
      return key;
    }
    this.entries.set(key, {
      key,
      token,
      groupKey: groupKeyOf(params),
      params,
      refs: 1,
      data: null,
      error: null,
      stale: true,
      inflight: null,
      version: 0,
      fetchedAt: null,
      appended: 0,
    });
    this.scheduleFlush();
    return key;
  }

  releaseHistory(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.refs--;
    if (e.refs > 0) return;
    window.setTimeout(() => {
      const again = this.entries.get(key);
      if (!again || again.refs > 0) return;
      this.entries.delete(key);
      if (again.inflight) this.maybeAbort(again.inflight);
    }, 0);
  }

  private maybeAbort(reqKey: string): void {
    const req = this.requests.get(reqKey);
    if (!req) return;
    const stillNeeded = Array.from(req.entries).some((k) => {
      const e = this.entries.get(k);
      return e && e.refs > 0 && e.inflight === reqKey;
    });
    if (!stillNeeded) {
      req.controller.abort();
      this.requests.delete(reqKey);
    }
  }

  getHistory(key: string): { data: RawHistory | null; error: string | null; loading: boolean } | null {
    const e = this.entries.get(key);
    if (!e) return null;
    return { data: e.data, error: e.error, loading: e.inflight !== null || (e.stale && !e.data && !e.error) };
  }

  private invalidateHistory(dropAppended: boolean): void {
    this.entries.forEach((e) => {
      e.stale = true;
      if (dropAppended && e.data && e.appended > 0) {
        e.data = null;
        e.appended = 0;
        e.version++;
      }
    });
    this.scheduleFlush();
    this.emit();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.started) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 30);
  }

  private flush(): void {
    if (!this.started) return;
    const maxSeries = Math.max(1, Math.min(20, this.inputs?.limits.max_series_per_query ?? 20));
    const groups = new Map<string, { params: HistoryParams; tokens: Set<string> }>();
    this.entries.forEach((e) => {
      if (e.refs <= 0 || !e.stale || e.inflight) return;
      let g = groups.get(e.groupKey);
      if (!g) groups.set(e.groupKey, (g = { params: e.params, tokens: new Set() }));
      g.tokens.add(e.token);
    });
    groups.forEach((g, groupKey) => {
      const window_ = resolveTimeRange(g.params.range, serverNowMs());
      for (const part of chunk(Array.from(g.tokens).sort(), maxSeries)) {
        const body: HistorianQueryRequest = {
          sources: part,
          start: new Date(window_.start).toISOString(),
          end: new Date(window_.end).toISOString(),
          mode: g.params.mode,
          resolution: g.params.resolution,
          max_points: g.params.maxPoints,
        };
        const reqKey = JSON.stringify(body);
        const tokens = new Set(part);
        const entryKeys: string[] = [];
        this.entries.forEach((e) => {
          if (e.groupKey === groupKey && tokens.has(e.token) && e.refs > 0) entryKeys.push(e.key);
        });
        const existing = this.requests.get(reqKey);
        if (existing) {
          // Identical request already in flight: share it.
          entryKeys.forEach((k) => {
            existing.entries.add(k);
            const e = this.entries.get(k)!;
            e.inflight = reqKey;
            e.stale = false;
          });
          continue;
        }
        const controller = new AbortController();
        const req: InflightRequest = { controller, entries: new Set(entryKeys) };
        this.requests.set(reqKey, req);
        entryKeys.forEach((k) => {
          const e = this.entries.get(k)!;
          e.inflight = reqKey;
          e.stale = false;
        });
        void this.runQuery(reqKey, body, req);
      }
    });
    this.emit();
  }

  private async runQuery(reqKey: string, body: HistorianQueryRequest, req: InflightRequest): Promise<void> {
    let series: Map<string, HistorianSeriesRaw> | null = null;
    let topNotes: string[] = [];
    let errorText: string | null = null;
    try {
      const res = await queryHistorian(body, req.controller.signal);
      series = new Map((res.series_list || []).map((s) => [s.series_key, s]));
      topNotes = res.history_available === false ? res.coverage_notes || [] : [];
    } catch (error) {
      if (isAbort(error)) {
        req.entries.forEach((k) => {
          const e = this.entries.get(k);
          if (e && e.inflight === reqKey) {
            e.inflight = null;
            e.stale = true;
          }
        });
        if (this.requests.get(reqKey) === req) this.requests.delete(reqKey);
        return;
      }
      errorText = errorLine(error, 'The Historian query failed.');
    }
    if (this.requests.get(reqKey) === req) this.requests.delete(reqKey);
    const now = Date.now();
    req.entries.forEach((k) => {
      const e = this.entries.get(k);
      // A newer request for this entry supersedes this answer.
      if (!e || e.inflight !== reqKey) return;
      e.inflight = null;
      e.fetchedAt = now;
      if (errorText !== null) {
        e.error = errorText;
        e.version++;
        return;
      }
      const sr = series?.get(e.token);
      e.error = null;
      e.appended = 0;
      e.data = sr
        ? {
            status: String(sr.status || 'OK'),
            points: (sr.points || [])
              .map((p) => ({ t: Date.parse(p.ts), v: p.value === undefined ? null : p.value, q: p.quality ?? null, epoch: numOrNull(p.data_epoch) }))
              .filter((p) => Number.isFinite(p.t))
              .sort((a, b) => a.t - b.t),
            downsampled: !!sr.downsampled,
            truncated: !!sr.truncated,
            fidelity: String(sr.fidelity || ''),
            notes: [...(sr.coverage_notes || []), ...topNotes],
            bucket_ms: sr.bucket_ms ?? null,
            next_cursor: sr.next_cursor ?? null,
          }
        : { status: 'NOT_FOUND', points: [], downsampled: false, truncated: false, fidelity: '', notes: ['The Historian did not return this series.'], bucket_ms: null, next_cursor: null };
      const last = e.data.points[e.data.points.length - 1];
      if (last) this.lastUpdateAt = Math.max(this.lastUpdateAt ?? 0, last.t);
      e.version++;
    });
    this.emit();
    // Entries that became stale while this request ran (tick, resync) are fetched now.
    this.scheduleFlush();
  }

  private appendLive(token: string, t: number, v: unknown, q: string | null, epoch: number | null): void {
    this.entries.forEach((e) => {
      if (e.token === token && e.params.liveAppend) this.appendTo(e, t, v, q, epoch);
    });
  }

  private appendTo(e: HistoryEntry, t: number, v: unknown, q: string | null, epoch: number | null): void {
    if (!e.data || e.inflight || e.params.range.kind !== 'relative') return;
    const pts = e.data.points;
    const last = pts[pts.length - 1];
    if (last && t <= last.t) return; // dedupe by timestamp, only newer points
    if (last && epoch !== null && last.epoch !== null && epoch !== last.epoch) {
      // Different data epoch: never join across a reset.
      e.stale = true;
      this.scheduleFlush();
      return;
    }
    const { start } = resolveTimeRange(e.params.range, serverNowMs());
    let firstKept = 0;
    while (firstKept < pts.length && pts[firstKept].t < start) firstKept++;
    const next = firstKept > 0 ? pts.slice(firstKept) : pts.slice();
    next.push({ t, v, q, epoch });
    const cap = Math.max(10, Math.round(e.params.maxPoints * 1.2));
    e.data = { ...e.data, points: next.length > cap ? next.slice(next.length - cap) : next };
    e.appended++;
    e.version++;
  }

  // ---------------------------------------------------------------- re-query cadence

  private armRefresh(): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (!this.started || !this.inputs) return;
    const ms = refreshMs(this.inputs.refresh);
    if (ms === null) return;
    this.refreshTimer = window.setInterval(() => this.tick(), Math.max(10000, ms));
  }

  private tick(): void {
    if (document.hidden) {
      this.missedTick = true;
      return;
    }
    const now = serverNowMs();
    let any = false;
    this.entries.forEach((e) => {
      if (e.refs <= 0 || e.inflight) return;
      const r = e.params.range;
      if (r.kind === 'absolute' && Date.parse(r.end) < now - 60e3) return; // a closed window does not change
      e.stale = true;
      any = true;
    });
    if (this.resolveStatus === 'error') {
      this.resolveSig = '';
      this.scheduleResolve(0);
    }
    if (any) this.scheduleFlush();
  }

  /** Re-query everything now (refresh button). */
  refreshNow(): void {
    this.entries.forEach((e) => {
      if (!e.inflight) e.stale = true;
    });
    this.resolveSig = '';
    this.scheduleResolve(0);
    this.scheduleFlush();
    this.poll();
  }

  pendingRequests(): number {
    return this.requests.size + (this.resolveStatus === 'loading' ? 1 : 0);
  }
}
