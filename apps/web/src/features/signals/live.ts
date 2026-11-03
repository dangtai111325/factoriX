import type { SignalItem } from '../../types'

/** Translate the Center latest-state envelope at the UI boundary. */
export function normalizeLiveState(state: Record<string, unknown> | undefined) {
  const value =
    state?.value_json && typeof state.value_json === 'object'
      ? (state.value_json as { v?: unknown }).v
      : state?.value
  const quality = String(state?.quality || 'UNKNOWN')
  const freshness = String(state?.freshness || 'UNKNOWN')
  const currentValue =
    !state || value === undefined
      ? '—'
      : value === null
        ? 'null'
        : typeof value === 'object'
          ? JSON.stringify(value)
          : (value as number | string | boolean)
  return {
    currentValue,
    rawValue: value,
    hasObservation: state !== undefined,
    observationId: typeof state?.observation_id === 'string' ? state.observation_id : undefined,
    quality: (['GOOD', 'UNCERTAIN', 'BAD'].includes(quality) ? quality : 'UNKNOWN') as SignalItem['quality'],
    freshness: (['FRESH', 'STALE'].includes(freshness) ? freshness : 'UNKNOWN') as SignalItem['freshness'],
    lastUpdated: String(state?.event_time || ''),
    sourceTime: typeof state?.source_time === 'string' ? state.source_time : undefined,
    receivedTime: typeof state?.received_time === 'string' ? state.received_time : undefined,
    lastGoodValue: (state?.last_good_value_json as { v?: unknown } | undefined)?.v,
    qualityReason: typeof state?.quality_reason === 'string' ? state.quality_reason : undefined,
  }
}
