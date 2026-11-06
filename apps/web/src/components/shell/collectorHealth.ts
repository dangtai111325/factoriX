/**
 * Effective health of the data collector(s) (edge nodes), shared by the top bar and the Overview.
 *
 * Source of truth: GET /api/v1/edges (polled) plus `health` push messages for entity "edge" from the
 * live stream. The raw edge health is used (`effective_health`, else `health_raw`, else `health`):
 * the list endpoint folds CONFIG_PENDING and other configuration states into "OFFLINE", although
 * the edge is alive and applying a new configuration.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../../api/client';
import { HealthMsg, subscribeHealth } from '../../lib/liveStream';

export type EdgeState = 'online' | 'degraded' | 'offline' | 'waiting';
export type CollectorState = 'loading' | 'not_configured' | 'waiting' | 'online' | 'degraded' | 'offline';

export interface EdgeHealthRow {
  id: string;
  name: string;
  siteId: string;
  enrollmentStatus: string;
  health: string;
  lastHeartbeat: string | null;
  state: EdgeState;
}

export interface CollectorHealth {
  state: CollectorState;
  /** Short label for the status pill, e.g. "Online", "Not configured". */
  label: string;
  /** One sentence explaining the state (tooltip / helper text). */
  detail: string;
  edges: EdgeHealthRow[];
  online: number;
  total: number;
  /** Edges that had contacted the Center before and are now unreachable. */
  offlineEdges: EdgeHealthRow[];
}

const POLL_MS = 5000;

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

export function classifyEdge(row: {
  enrollmentStatus: string;
  health: string;
  lastHeartbeat: string | null;
}): EdgeState {
  if (row.enrollmentStatus.toUpperCase() !== 'ENROLLED') return 'waiting';
  // An edge that never sent a heartbeat has not started yet, whatever its stored health says.
  if (!row.lastHeartbeat) return 'waiting';
  const health = row.health.toUpperCase();
  if (health === 'ONLINE' || health === 'HEALTHY' || health === 'ACTIVE') return 'online';
  if (health.startsWith('CONFIG_')) return /FAIL|REJECT|ERROR/.test(health) ? 'degraded' : 'online';
  if (health === 'DEGRADED' || health === 'RATE_LIMITED') return 'degraded';
  if (health === 'OFFLINE' || health === 'NOT_ENROLLED') return 'offline';
  return 'waiting';
}

function toRow(raw: Record<string, unknown>): EdgeHealthRow {
  const base = {
    id: text(raw.id),
    name: text(raw.name) || 'Collector',
    siteId: text(raw.site_id),
    enrollmentStatus: text(raw.enrollment_status),
    health: text(raw.effective_health || raw.health_raw || raw.health),
    lastHeartbeat: raw.last_heartbeat ? text(raw.last_heartbeat) : null,
  };
  return { ...base, state: classifyEdge(base) };
}

export function summarize(edges: EdgeHealthRow[] | null): CollectorHealth {
  if (edges === null) {
    return { state: 'loading', label: 'Checking…', detail: 'Reading collector status.', edges: [], online: 0, total: 0, offlineEdges: [] };
  }
  const total = edges.length;
  const online = edges.filter((edge) => edge.state === 'online').length;
  const degraded = edges.filter((edge) => edge.state === 'degraded').length;
  const offlineEdges = edges.filter((edge) => edge.state === 'offline');
  const base = { edges, online, total, offlineEdges };
  if (total === 0) {
    return {
      ...base,
      state: 'not_configured',
      label: 'Not configured',
      detail: 'The built-in collector starts when you add the first data connection.',
    };
  }
  if (online === total) {
    return {
      ...base,
      state: 'online',
      label: 'Online',
      detail: total === 1 ? 'The collector is connected and reporting.' : `All ${total} collectors are connected and reporting.`,
    };
  }
  if (offlineEdges.length > 0 && online === 0 && degraded === 0) {
    return {
      ...base,
      state: 'offline',
      label: 'Offline',
      detail:
        offlineEdges.length === 1
          ? `${offlineEdges[0].name} stopped reporting.`
          : `${offlineEdges.length} collectors stopped reporting.`,
    };
  }
  if (degraded > 0 || offlineEdges.length > 0) {
    return {
      ...base,
      state: 'degraded',
      label: total > 1 ? `${online} of ${total} online` : 'Degraded',
      detail: degraded > 0 ? 'A collector reports a problem. Check Connections.' : 'Some collectors stopped reporting.',
    };
  }
  return {
    ...base,
    state: 'waiting',
    label: 'Waiting for collector',
    detail: 'The collector has not reported yet. It connects automatically after start-up.',
  };
}

// ---- shared store (one poller and one stream subscription for the whole app) ----

let rows: EdgeHealthRow[] | null = null;
let snapshot: CollectorHealth = summarize(null);
const listeners = new Set<() => void>();
let timer: number | null = null;
let unsubscribeStream: (() => void) | null = null;
let inflight = false;

function publish(next: EdgeHealthRow[]): void {
  rows = next;
  snapshot = summarize(next);
  listeners.forEach((listener) => listener());
}

async function poll(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const page = await api<{ items?: Array<Record<string, unknown>> }>('/api/v1/edges');
    publish((page.items || []).map(toRow));
  } catch (error) {
    // Keep the last known state; the next poll retries. Signed-out sessions stop polling on unmount.
    console.warn('collectorHealth: cannot read /api/v1/edges', error);
  } finally {
    inflight = false;
  }
}

function onHealth(msg: HealthMsg): void {
  if (msg.entity !== 'edge' || !rows) return;
  const index = rows.findIndex((row) => row.id === msg.id);
  if (index < 0) {
    void poll();
    return;
  }
  const current = rows[index];
  const health = text(msg.effective_health || msg.health) || current.health;
  const lastHeartbeat = current.lastHeartbeat || new Date().toISOString();
  const updated = { ...current, health, lastHeartbeat };
  const next = rows.slice();
  next[index] = { ...updated, state: classifyEdge(updated) };
  publish(next);
}

function start(): void {
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
  unsubscribeStream = subscribeHealth(onHealth);
}

function stop(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  unsubscribeStream?.();
  unsubscribeStream = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

function getSnapshot(): CollectorHealth {
  return snapshot;
}

/** Live collector health; the first component that uses it starts polling, the last one stops it. */
export function useCollectorHealth(): CollectorHealth {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Ask for an immediate refresh (e.g. after the user pressed Refresh). */
export function refreshCollectorHealth(): void {
  void poll();
}
