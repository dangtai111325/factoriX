/**
 * Poll / emit interval of a connection's acquisition job (R3-AD-01).
 * The interval belongs to the connection job, so it applies to every machine read through that
 * connection. HTTP requests are rate limited at the source, so HTTP polls at most once per second.
 */
export const POLL_INTERVAL_MAX_MS = 86_400_000;

export function pollIntervalMin(protocol: string): number {
  return protocol === 'http' ? 1000 : 200;
}

/** Error message for an interval value, or null when it is valid. */
export function validatePollInterval(protocol: string, value: number): string | null {
  const min = pollIntervalMin(protocol);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return 'Enter a whole number of milliseconds.';
  if (value < min) {
    return protocol === 'http'
      ? `HTTP sources are polled at most once per second: enter ${min} ms or more.`
      : `Enter ${min} ms or more.`;
  }
  if (value > POLL_INTERVAL_MAX_MS) return 'Enter at most 86 400 000 ms (one day).';
  return null;
}

/** "1 s", "1.5 s", "2 min", "250 ms": a readable form of an interval for helper texts. */
export function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(3))} s`;
  if (ms < 3_600_000) return `${Number((ms / 60_000).toFixed(2))} min`;
  return `${Number((ms / 3_600_000).toFixed(2))} h`;
}
