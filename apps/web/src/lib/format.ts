/** Display helpers for live values, qualities and timestamps (no rounding of received values). */
import { serverNowMs } from './liveStream'

/**
 * PAUSED: the signal's connection is paused (server effective_status, R3-CN-02) — neutral, not an error.
 * NO_CONNECTION: client-side only, the browser cannot reach the appliance (R3-OV-01) — status unknown.
 */
export const QUALITY_CODES = ['GOOD', 'UNCERTAIN', 'BAD', 'STALE', 'NO_DATA', 'DISABLED', 'PAUSED', 'NO_CONNECTION'] as const
export type QualityCode = (typeof QUALITY_CODES)[number]

/** Normalise an effective status from the API into one of QUALITY_CODES. */
export function normalizeQuality(value: unknown): QualityCode {
  const raw = String(value ?? '').trim().toUpperCase()
  const code = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw
  if ((QUALITY_CODES as readonly string[]).includes(code)) return code as QualityCode
  if (code === '' || code === 'UNKNOWN' || code === 'NONE') return 'NO_DATA'
  return 'BAD'
}

export const QUALITY_LABEL: Record<QualityCode, string> = {
  GOOD: 'Good',
  UNCERTAIN: 'Uncertain',
  BAD: 'Bad',
  STALE: 'Stale',
  NO_DATA: 'No data',
  DISABLED: 'Disabled',
  PAUSED: 'Paused',
  NO_CONNECTION: 'Unknown',
}

/** Tooltip / helper text for the two neutral states that are not data problems. */
export const QUALITY_HINT: Partial<Record<QualityCode, string>> = {
  PAUSED: 'The connection of this signal is paused. Resume it to collect again.',
  NO_CONNECTION: 'The browser cannot reach the appliance. The current value is unavailable.',
  DISABLED: 'This signal is disabled and does not collect.',
}

/** Neutral states: shown gray, never counted as problems. */
export function isNeutralQuality(code: string): boolean {
  return code === 'PAUSED' || code === 'NO_CONNECTION' || code === 'DISABLED'
}

/**
 * Format a received value for display without losing precision:
 * numbers are shown exactly as JavaScript received them (0.080123 stays 0.080123, 88 stays 88),
 * null / undefined become an em dash, strings are shown verbatim, objects as compact JSON.
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    // Avoid exponent notation for ordinary magnitudes while keeping every received digit.
    const text = String(value)
    if (!/e/i.test(text)) return text
    return value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 17 })
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value === '' ? '""' : value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Current value for tables and cards. The last value stays visible when it is late (DELAYED, shown
 * as GOOD + "Delayed N s") or old (STALE: dimmed + Stale badge + age) — the operator must still see
 * the last known value (R1-10). It is hidden only when there is no trustworthy value: BAD, no data,
 * disabled signal.
 */
export function formatCurrentSignalValue(value: unknown, quality: unknown, enabled = true): string {
  const status = normalizeQuality(quality)
  return formatValue(enabled && (status === 'GOOD' || status === 'UNCERTAIN' || status === 'STALE' || status === 'PAUSED') ? value : null)
}

/** The value is shown but is not current: render it dimmed next to its badge. */
export function isDimmedValue(quality: unknown, freshness?: unknown): boolean {
  const status = normalizeQuality(quality)
  return status === 'STALE' || status === 'PAUSED' || String(freshness ?? '').toUpperCase() === 'DELAYED'
}

/** "Delayed 34 s" when the server says the value is current at the source but late in the pipeline. */
export function delayLabel(freshness: unknown, lastAcquiredAt?: string | null, lagMs?: number | null): string | null {
  if (String(freshness ?? '').toUpperCase() !== 'DELAYED') return null
  let ms = typeof lagMs === 'number' && Number.isFinite(lagMs) ? lagMs : null
  if (lastAcquiredAt) {
    const ts = Date.parse(lastAcquiredAt)
    if (Number.isFinite(ts)) ms = serverNowMs() - ts
  }
  if (ms === null) return 'Delayed'
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec < 120 ? `Delayed ${sec} s` : `Delayed ${Math.round(sec / 60)} min`
}

export const DELAYED_HINT =
  'The source is being read normally, but this value reached the appliance late. The last value is shown; it updates when the backlog clears.'

/** Relative time using the server clock (heartbeat offset), so a skewed PC clock does not mislead. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return '—'
  const diffSec = Math.floor((serverNowMs() - ts) / 1000)
  if (diffSec < 0) return 'just now'
  if (diffSec < 60) return `${diffSec} s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} h ago`
  return `${Math.floor(diffHour / 24)} d ago`
}

/** Absolute local timestamp with milliseconds, e.g. 2026-11-06 10:41:25.123 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
