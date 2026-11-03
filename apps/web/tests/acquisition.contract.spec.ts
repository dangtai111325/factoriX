import { expect, test } from '@playwright/test'
import {
  sourceType,
  commissioningPassed,
  mappingContract,
  mappingRowIssues,
  validMqttFilter,
} from '../src/features/acquisition/contracts'

test('text mapping preserves text instead of declaring a float', () => {
  expect(sourceType('String')).toEqual({ dataType: 'string' })
})

test('mapping rows require explicit MQTT topics and detect keys that collide after normalization', () => {
  const issues = mappingRowIssues('mqtt', [
    { name: 'status', address: '$.status', dataType: 'Int32', unit: '', topic: '' },
    { name: 'status!', address: '$.status', dataType: 'Int32', unit: '', topic: 'factory/M/state' },
  ])
  expect(issues.some((i) => i.row === 0 && i.field === 'topic')).toBe(true)
  expect(issues.filter((i) => i.field === 'name')).toHaveLength(2)
  expect(
    mappingRowIssues('mqtt', [
      { name: 'Employee', address: '$.employee', dataType: 'String', unit: '', topic: 'factory/M/state' },
    ]),
  ).toEqual([])
})

test('MQTT filter validation rejects malformed wildcard levels and retains significant spaces', () => {
  for (const filter of ['f/a+b', 'f/#/x', 'f/a#', 'f/\u0000']) expect(validMqttFilter(filter)).toBe(false)
  for (const filter of ['f/+/state', 'f/#', 'f//state', ' f/state '])
    expect(validMqttFilter(filter)).toBe(true)
})

test('a wildcard connection retains a different explicit source topic for every mapping', () => {
  const draft = { protocol: 'mqtt' as const, extra: 'uns/E/S/#', mqttQos: 1 }
  const field = {
    name: 'Employee',
    address: '$.employee',
    dataType: 'String',
    unit: '',
    topic: 'uns/E/S/L/M/state',
  }
  expect(mappingContract(draft, field).address).toEqual({
    topic: 'uns/E/S/L/M/state',
    jsonpath: '$.employee',
    qos: 1,
  })
  expect(
    mappingContract(draft, {
      ...field,
      name: 'Speed',
      address: '$.speed_1',
      dataType: 'Float32',
      topic: 'uns/E/S/L/M/process',
    }).address,
  ).toEqual({ topic: 'uns/E/S/L/M/process', jsonpath: '$.speed_1', qos: 1 })
})

test('Modbus Int32 reads two signed registers rather than uint16', () => {
  expect(sourceType('Int32')).toEqual({ dataType: 'int64', nativeType: 'int32' })
})

test('Float64 preserves its native register width', () => {
  expect(sourceType('Float64')).toEqual({ dataType: 'float64', nativeType: 'float64' })
})

test('failed commissioning cannot pass because the broker was reachable', () => {
  expect(commissioningPassed('FAILED', [{ name: 'NETWORK', status: 'PASSED' }])).toBe(false)
})

test('untested mapping cannot enable activation', () => {
  const stages = ['NETWORK', 'AUTH', 'PROTOCOL', 'READ_OR_SUBSCRIBE', 'DECODE', 'MAPPING', 'VALIDATION'].map(
    (name) => ({ name, status: name === 'MAPPING' ? 'NOT_TESTED' : 'PASSED' }),
  )
  expect(commissioningPassed('COMPLETED', stages)).toBe(false)
})

test('all required stages and successful terminal result enable activation', () => {
  const stages = ['NETWORK', 'AUTH', 'PROTOCOL', 'READ_OR_SUBSCRIBE', 'DECODE', 'MAPPING', 'VALIDATION'].map(
    (name) => ({ name, status: name === 'AUTH' ? 'NOT_APPLICABLE' : 'PASSED' }),
  )
  expect(commissioningPassed('COMPLETED', stages)).toBe(true)
  expect(commissioningPassed('RUNNING', stages)).toBe(false)
  expect(commissioningPassed('COMPLETED', [])).toBe(false)
})

test('mapping validation cannot be marked not applicable', () => {
  const stages = ['NETWORK', 'AUTH', 'PROTOCOL', 'READ_OR_SUBSCRIBE', 'DECODE', 'MAPPING', 'VALIDATION'].map(
    (name) => ({ name, status: name === 'MAPPING' ? 'NOT_APPLICABLE' : 'PASSED' }),
  )
  expect(commissioningPassed('COMPLETED', stages)).toBe(false)
})

test('the MQTT mapping tested and activated carries QoS zero and text type', () => {
  expect(
    mappingContract(
      { protocol: 'mqtt', extra: 'factory/#', mqttQos: 0 },
      {
        name: 'Employee',
        address: '$.employee',
        dataType: 'String',
        unit: '',
      },
    ),
  ).toEqual({
    name: 'Employee',
    data_type: 'string',
    address: { topic: 'factory/#', jsonpath: '$.employee', qos: 0 },
  })
})

test('Modbus and OPC draft addresses retain their native meaning', () => {
  expect(
    mappingContract(
      { protocol: 'modbus', extra: '1' },
      {
        name: 'Speed',
        address: '12',
        dataType: 'Int32',
        unit: '',
      },
    ),
  ).toEqual({
    name: 'Speed',
    data_type: 'int64',
    address: { offset: 12, register_area: 'holding', native_type: 'int32', word_order: 'big' },
  })
  expect(
    mappingContract(
      { protocol: 'opcua', extra: '' },
      {
        name: 'Speed',
        address: 'ns=2;s=Speed',
        dataType: 'Float32',
        unit: '',
      },
    ),
  ).toEqual({ name: 'Speed', data_type: 'float64', address: { node_id: 'ns=2;s=Speed' } })
})

test('HTTP mapping uses the configured request path rather than overriding it', () => {
  expect(
    mappingContract(
      { protocol: 'http', extra: '/sample' },
      {
        name: 'Speed',
        address: '$.speed',
        dataType: 'Float32',
        unit: '',
      },
    ),
  ).toEqual({ name: 'Speed', data_type: 'float64', address: { jsonpath: '$.speed' } })
})
