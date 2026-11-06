/**
 * HTTP rate budget of a connection (R2-CN-04). The collector requests every distinct path of an HTTP
 * connection once per poll interval, so the load on the source is
 *   distinct paths × (60000 / interval_ms)  requests per minute,
 * which must stay under the connection's `rate_limit_per_min` (otherwise the collector throttles).
 */
import { SignalItem } from '../../types';

export const DEFAULT_HTTP_RATE_LIMIT = 60;

/** Distinct request paths already bound on a connection (from the signals' address_json.path). */
export function httpPathsOfConnection(signals: SignalItem[], connectionId: string): Set<string> {
  const paths = new Set<string>();
  if (!connectionId) return paths;
  signals.forEach((signal) => {
    if (signal.sourceConnectionId !== connectionId) return;
    const path = (signal.addressJson as Record<string, unknown> | undefined)?.path;
    paths.add(typeof path === 'string' && path.trim() ? path.trim() : '/');
  });
  return paths;
}

export function requestsPerMinute(pathCount: number, intervalMs: number): number {
  if (!pathCount || !Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return Math.ceil((pathCount * 60000) / intervalMs);
}

/** Smallest poll interval (ms, rounded up to 500 ms) that keeps `pathCount` paths under `limit`. */
export function minIntervalFor(pathCount: number, limit: number): number {
  if (!pathCount || limit <= 0) return 1000;
  return Math.max(1000, Math.ceil((pathCount * 60000) / limit / 500) * 500);
}

export interface RateBudget {
  paths: number;
  perMinute: number;
  limit: number;
  over: boolean;
  /** Plain-English summary for the UI. */
  message: string;
}

export function rateBudget(pathCount: number, intervalMs: number, limit: number): RateBudget {
  const perMinute = requestsPerMinute(pathCount, intervalMs);
  const over = perMinute > limit;
  const pathsText = `${pathCount} path${pathCount === 1 ? '' : 's'}`;
  let message = `${pathsText} × every ${intervalMs / 1000} s = ${perMinute} requests/min for this connection (rate limit ${limit}/min).`;
  if (over) {
    message += ` Over the limit: the collector throttles requests and values arrive late. Raise the rate limit to at least ${perMinute}/min or the poll interval to at least ${minIntervalFor(pathCount, limit)} ms.`;
  }
  return { paths: pathCount, perMinute, limit, over, message };
}
