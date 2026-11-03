import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from '@playwright/test'
import { LiveOperationsView } from '../src/pages/10_LiveOperations/LiveOperationsPage'
import { LineChart } from '../src/components/charts/LineChart'
import type { SignalItem } from '../src/types'

const signal: SignalItem = {
  id: 'employee-1',
  name: 'Employee',
  tag: 'employee',
  sourceConnectionId: 'conn-1',
  sourceConnectionName: 'Factory MQTT',
  resourceId: 'machine-1',
  resourcePath: 'Test / Line A / M1',
  dataType: 'string',
  currentValue: '0021113185',
  quality: 'GOOD',
  lastUpdated: '2026-11-02T09:00:00Z',
  sampleIntervalMs: 1000,
}

test('Monitor with real signals never adds invented operational telemetry', () => {
  const html = renderToStaticMarkup(<LiveOperationsView signals={[signal]} />)
  expect(html).toContain('0021113185')
  expect(html).toContain('Factory MQTT')
  for (const fictional of [
    '18/20 Online',
    'All Systems Operational',
    '1,242 messages/min',
    'CPU: 32%',
    '4d 12h',
    'Tank_03',
    'temp_reactor_01',
  ]) {
    expect(html).not.toContain(fictional)
  }
})

test('Monitor never presents an unavailable historical window as collected data', () => {
  const html = renderToStaticMarkup(<LiveOperationsView signals={[signal]} />)
  expect(html).not.toContain('1h Window')
  expect(html).not.toContain('Average (1h)')
  expect(html).not.toContain('61.2 °C')
})

test('a single observed chart point has finite coordinates', () => {
  const html = renderToStaticMarkup(<LineChart data={[{ time: '09:00', value: 42 }]} />)
  expect(html).not.toMatch(/NaN|Infinity/)
  expect(html).toContain('42')
})

test('negative chart values stay within a correctly ordered axis', () => {
  const html = renderToStaticMarkup(
    <LineChart
      data={[
        { time: '09:00', value: -100 },
        { time: '09:01', value: -50 },
      ]}
    />,
  )
  const points = [...html.matchAll(/\bcy="([\d.-]+)"/g)].map((item) => Number(item[1]))
  expect(points).toHaveLength(2)
  expect(points.every((point) => point >= 20 && point <= 120)).toBe(true)
  expect(points[1]).toBeLessThan(points[0])
})

test('a session chart preserves the elapsed time between observed updates', () => {
  const html = renderToStaticMarkup(<LineChart data={[
    { time: '09:00:00', value: 1, at: 0 }, { time: '09:00:01', value: 2, at: 1000 },
    { time: '09:00:10', value: 3, at: 10000 },
  ]} />)
  const x = [...html.matchAll(/\bcx="([\d.-]+)"/g)].map(item => Number(item[1]))
  expect(x).toHaveLength(3)
  expect(x[1] - x[0]).toBeCloseTo((x[2] - x[0]) / 10)
})

test('a 10,000-signal UI snapshot renders a page while retaining its full count', () => {
  const signals = Array.from({ length: 10000 }, (_, index) => ({ ...signal, id: `s${index}`, name: `Employee ${index}` }))
  const html = renderToStaticMarkup(<LiveOperationsView signals={signals} />)
  const body = html.match(/<tbody>(.*?)<\/tbody>/s)?.[1] || ''
  expect([...body.matchAll(/<tr\b/g)]).toHaveLength(50)
  expect(html.includes('of 10000')).toBe(true)
})
