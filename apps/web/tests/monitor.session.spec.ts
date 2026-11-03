import { expect, test } from '@playwright/test'
import { SessionTrends, displayValue, signalsCsv, isNumericSignal } from '../src/features/monitor/session'
import type { SignalItem } from '../src/types'

function sample(id: string, value: number | string | boolean, observationId: string): SignalItem {
  return {
    id,
    name: id,
    tag: 'speed',
    resourceId: id,
    resourcePath: `Line / ${id}`,
    sourceConnectionId: 'c',
    sourceConnectionName: 'MQTT',
    dataType: 'analog',
    quality: 'GOOD',
    currentValue: value,
    lastUpdated: observationId,
    sampleIntervalMs: 1000,
  }
}

test('a numeric trend remains selectable through bad quality and missing observations', () => {
  expect(isNumericSignal({ ...sample('a', '—', '1'), rawValue: null, quality: 'BAD', hasObservation: true })).toBe(true)
  expect(isNumericSignal({ ...sample('a', '—', ''), hasObservation: false })).toBe(true)
  expect(isNumericSignal({ ...sample('a', '42', '1'), dataType: 'string', canonicalType: 'string' })).toBe(false)
})

test('session trends keep separate signals with the same tag and deduplicate refreshes', () => {
  const trends = new SessionTrends(3)
  trends.select(['a', 'b'])
  trends.observe([sample('a', 0, 'event-1'), sample('b', -10, 'event-1')], 1000)
  trends.observe([sample('a', 0, 'event-1'), sample('b', -10, 'event-1')], 2000)
  expect(trends.snapshot()).toEqual({ a: [{ at: 1000, value: 0 }], b: [{ at: 1000, value: -10 }] })
  trends.observe([sample('a', 2, 'event-2'), sample('b', -9, 'event-2')], 3000)
  expect(trends.snapshot().a.map((point) => point.value)).toEqual([0, 2])
})

test('session trends are bounded and discard removed selections', () => {
  const trends = new SessionTrends(2)
  trends.select(['a', 'b'])
  for (let index = 0; index < 4; index++) trends.observe([sample('a', index, `event-${index}`)], index)
  expect(trends.snapshot().a.map((point) => point.value)).toEqual([2, 3])
  trends.select(['b'])
  expect(trends.snapshot()).toEqual({ b: [] })
  expect(() => trends.select(['a', 'b', 'c', 'd', 'e'])).toThrow()
})

test('freezing only holds the visible chart while collection continues, and removed trends stay removed', () => {
  const trends = new SessionTrends()
  trends.select(['a'])
  trends.observe([sample('a', 1, 'event-1')], 1000)
  expect(trends.snapshot().a).toEqual([{ at: 1000, value: 1 }])
  trends.observe([sample('a', 2, 'event-2')], 2000)
  expect(trends.snapshot(true).a).toEqual([{ at: 1000, value: 1 }])
  expect(trends.snapshot(false).a.map((point) => point.value)).toEqual([1, 2])
  trends.select([])
  trends.select(['a'])
  expect(trends.snapshot(true)).toEqual({ a: [] })
})

test('session trends never convert text, missing or bad quality into numeric points', () => {
  const trends = new SessionTrends()
  trends.select(['a', 'b', 'c', 'd'])
  trends.observe(
    [
      sample('a', '42', '1'),
      sample('b', false, '1'),
      { ...sample('c', 42, '1'), quality: 'BAD' },
      sample('d', Number.NaN, '1'),
    ],
    1000,
  )
  expect(Object.values(trends.snapshot()).every((points) => points.length === 0)).toBe(true)
})

test('a configured signal without an observation cannot create a chart point', () => {
  const trends = new SessionTrends()
  trends.select(['a'])
  trends.observe([{ ...sample('a', 0, ''), hasObservation: false }], 1000)
  trends.observe([sample('a', 0, '')], 2000)
  expect(trends.snapshot()).toEqual({ a: [] })
})

test('live value display preserves zero, false, text identifiers, null and JSON', () => {
  expect(displayValue({ ...sample('a', 0, '1'), rawValue: 0, hasObservation: true })).toBe('0')
  expect(displayValue({ ...sample('a', false, '1'), rawValue: false, hasObservation: true })).toBe('false')
  expect(displayValue(sample('a', '0021113185', '1'))).toBe('0021113185')
  expect(displayValue({ ...sample('a', '—', '1'), rawValue: null, hasObservation: true })).toBe('null')
  expect(displayValue({ ...sample('a', '—', '1'), rawValue: null, hasObservation: false })).toBe('—')
  expect(
    displayValue({ ...sample('a', '—', '1'), rawValue: { running: false, qty: 0 }, hasObservation: true }),
  ).toBe('{"running":false,"qty":0}')
})

test('CSV exports only selected real rows, quotes fields and neutralizes spreadsheet formulas', () => {
  const csv = signalsCsv([{ ...sample('a', 0, '1'), name: '=HYPERLINK("example")', resourcePath: 'Line, A' }])
  expect(csv).toContain('"\'=HYPERLINK(""example"")"')
  expect(csv).toContain('"Line, A"')
  expect(csv).toContain('"0"')
  expect(csv.split('\r\n')).toHaveLength(2)
})

test('CSV keeps negative numbers numeric and nullable values explicit', () => {
  const csv = signalsCsv([
    sample('a', -42, '1'),
    { ...sample('b', '—', '1'), rawValue: null, hasObservation: true },
  ])
  expect(csv).toContain(',"-42",')
  expect(csv).not.toContain('"\'-42"')
  expect(csv).toContain(',"null",')
})
