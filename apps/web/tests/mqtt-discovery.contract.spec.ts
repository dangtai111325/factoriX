import { expect, test } from '@playwright/test'
import { discoverPayloadFields, appendDiscoveredFields } from '../src/features/acquisition/mqttDiscovery'

test('captured JSON preserves zero, false, null and text with unambiguous JSONPaths', () => {
  const result = discoverPayloadFields({
    speed: 0, running: false, employee: '0007', empty: null,
    'a.b': { "operator's id": 'A' }, batches: [{ count: 12 }],
  })
  expect(result.truncated).toBe(false)
  expect(result.fields.map(({ address, dataType, value }) => ({ address, dataType, value }))).toEqual([
    { address: '$["speed"]', dataType: 'Int64', value: 0 },
    { address: '$["running"]', dataType: 'Bool', value: false },
    { address: '$["employee"]', dataType: 'String', value: '0007' },
    { address: '$["empty"]', dataType: 'JSON', value: null },
    { address: '$["a.b"]["operator\'s id"]', dataType: 'String', value: 'A' },
    { address: '$["batches"][0]["count"]', dataType: 'Int64', value: 12 },
  ])
})

test('scalar and empty JSON values are selectable without inventing a numeric value', () => {
  expect(discoverPayloadFields('idle').fields).toEqual([
    { address: '$', name: 'value', dataType: 'String', unit: '', type: 'JSONPath', value: 'idle' },
  ])
  expect(discoverPayloadFields([]).fields[0]).toMatchObject({ address: '$', dataType: 'JSON', value: [] })
  expect(discoverPayloadFields({ temperature: 3.25 }).fields[0].dataType).toBe('Float64')
})

test('large payload discovery is bounded and explicitly reports omitted fields', () => {
  const result = discoverPayloadFields(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, i])))
  expect(result.fields).toHaveLength(256)
  expect(result.truncated).toBe(true)
  let nested: unknown = 1
  for (let i = 0; i < 30; i++) nested = { child: nested }
  expect(discoverPayloadFields(nested).truncated).toBe(true)
})

test('adding fields preserves exact source topics, existing edits and unique signal keys', () => {
  const existing = [{ topic: 'f/M/process', address: '$["speed"]', name: 'Speed', dataType: 'Float32', unit: 'rpm', type: 'JSONPath' }]
  const selected = discoverPayloadFields({ speed: 0, employee: '007' }).fields
  const result = appendDiscoveredFields(existing, ' f/M/state ', selected)
  expect(result).toEqual([
    existing[0],
    { topic: ' f/M/state ', address: '$["speed"]', name: 'speed_2', dataType: 'Int64', unit: '', type: 'JSONPath' },
    { topic: ' f/M/state ', address: '$["employee"]', name: 'employee', dataType: 'String', unit: '', type: 'JSONPath' },
  ])
  expect(appendDiscoveredFields(result, ' f/M/state ', selected)).toEqual(result)
  expect(appendDiscoveredFields([{ address: '$.', name: '', dataType: 'Float32', unit: '', type: 'JSONPath' }], 'f/state', selected)).toHaveLength(2)
})
