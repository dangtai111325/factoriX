import { expect, test } from '@playwright/test'
import { normalizeLiveState } from '../src/features/signals/live'

test('explicit null is an observation and is distinct from no collected value', () => {
  const observed = normalizeLiveState({
    value_json: { v: null },
    quality: 'GOOD',
    event_time: '2026-11-02T09:00:00Z',
    observation_id: 'o1',
  })
  expect(observed.currentValue).toBe('null')
  expect(observed).toMatchObject({ rawValue: null, hasObservation: true, observationId: 'o1' })
  expect(normalizeLiveState(undefined)).toMatchObject({
    currentValue: '—',
    hasObservation: false,
    quality: 'UNKNOWN',
  })
})

test('the latest-state contract retains source time, receive time, freshness and last good value', () => {
  const state = normalizeLiveState({
    value_json: { v: 0 },
    quality: 'UNCERTAIN',
    freshness: 'STALE',
    source_time: '2026-11-02T08:00:00Z',
    received_time: '2026-11-02T09:00:00Z',
    event_time: '2026-11-02T08:00:00Z',
    last_good_value_json: { v: 42.5 },
    quality_reason: 'Source clock is behind.',
  })
  expect(state).toMatchObject({
    currentValue: 0,
    rawValue: 0,
    quality: 'UNCERTAIN',
    freshness: 'STALE',
    sourceTime: '2026-11-02T08:00:00Z',
    receivedTime: '2026-11-02T09:00:00Z',
    lastGoodValue: 42.5,
    qualityReason: 'Source clock is behind.',
  })
})

test('JSON remains structured while its display representation is readable', () => {
  const state = normalizeLiveState({ value_json: { v: { running: false, qty: 0 } }, quality: 'GOOD' })
  expect(state.currentValue).toBe('{"running":false,"qty":0}')
  expect(state).toMatchObject({ rawValue: { running: false, qty: 0 }, hasObservation: true })
})
