import { expect, test } from '@playwright/test'
import { capturedResourceRows, captureRequestError } from '../src/features/assets/topicCapture'
import { ApiError } from '../src/api/client'

test('a rejected capture is reported as rejected, while only an unconfirmed request warns about unknown state', () => {
  const rejected = captureRequestError(
    new ApiError(422, 'The filter is outside the connection.', 'TOPIC_SCOPE'),
  )
  expect(rejected).toBe('The filter is outside the connection.')
  expect(captureRequestError(new ApiError(0, 'The request timed out.', 'TIMEOUT'))).toContain(
    'could not be confirmed',
  )
  expect(captureRequestError(new Error('Failed to fetch'))).toContain('could not be confirmed')
})

test('captured topic proposal grafts under an existing parent without rewriting the source namespace', () => {
  const resources: any[] = [
    { id: 'e', code: 'QA', name: 'Enterprise', type: 'Enterprise' },
    { id: 's', code: 'DongNai', name: 'Site', type: 'Site', parentId: 'e' },
  ]
  const result = capturedResourceRows(
    ['TIPA/DongNai/Factory-1/ASSY/L/M/state', 'TIPA/DongNai/Factory-1/ASSY/L/production/order'],
    {
      skipSegments: 2,
      levelTypes: ['plant', 'zone', 'line', 'machine'],
      dataSuffixes: ['state', 'production/order'],
    },
    's',
    resources,
  )
  expect(result.errors).toEqual([])
  expect(result.rows.map((row) => row.path)).toEqual([
    'QA/DongNai/Factory-1',
    'QA/DongNai/Factory-1/ASSY',
    'QA/DongNai/Factory-1/ASSY/L',
    'QA/DongNai/Factory-1/ASSY/L/M',
  ])
  expect(result.rows[3].topic_prefix).toBe('TIPA/DongNai/Factory-1/ASSY/L/M')
  expect(result.rows[0].parent_path).toBe('QA/DongNai')
})

test('topic graft rejects missing or cyclic parents instead of silently importing at root', () => {
  const profile = { skipSegments: 0, levelTypes: ['machine'], dataSuffixes: ['state'] }
  expect(() => capturedResourceRows(['M/state'], profile, 'missing', [])).toThrow('parent')
  expect(() =>
    capturedResourceRows(['M/state'], profile, 'a', [{ id: 'a', code: 'A', parentId: 'a' }] as any),
  ).toThrow('cycle')
})
