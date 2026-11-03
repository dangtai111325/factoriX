import { expect, test } from '@playwright/test'
import { parseResourceCsv, proposeTopicResources } from '../src/features/assets/importing'
import { codePreviewFromName } from '../src/utils/resourceHierarchy'

test('CSV preserves BOM/UTF-8, commas, multiline fields, quotes and original source row', () => {
  const parsed = parseResourceCsv('\uFEFFpath,type_key,name,description\r\n"E1/DN",site,"Đồng Nai, Site","Dòng một\r\nDòng ""hai"""\r\n')
  expect(parsed.rows).toEqual([{ path: 'E1/DN', type_key: 'site', name: 'Đồng Nai, Site', description: 'Dòng một\r\nDòng "hai"' }])
  expect(parsed.rowNumbers).toEqual([2])
})

test('CSV detects semicolon/tab files and retains leading zeros and formula-like text', () => {
  expect(parseResourceCsv('code;type_key;display name\n0007;machine;=CNC + 1\n').rows)
    .toEqual([{ code: '0007', type_key: 'machine', name: '=CNC + 1' }])
  expect(parseResourceCsv('code\ttype_key\tname\nM1\tmachine\tMáy một\n').rows[0].name).toBe('Máy một')
})

test('CSV rejects malformed quoting, mismatched records and ambiguous headers', () => {
  for (const text of [
    'code,type_key,name\nM1,machine,"Unclosed',
    'code,type_key,name\nM1,machine,"Name"oops',
    'code,type_key,name\nM1,machine',
    'code,type_key,name,display_name\nM1,machine,One,Two',
    'code,type_key,name,typo_column\nM1,machine,One,Oops',
  ]) expect(() => parseResourceCsv(text)).toThrow()
})

test('CSV limits are explicit and blank trailing spreadsheet rows are harmless', () => {
  expect(() => parseResourceCsv('')).toThrow()
  expect(() => parseResourceCsv('code,type_key,name\n' + 'M,machine,Machine\n'.repeat(2001))).toThrow()
  expect(() => parseResourceCsv('code,type_key,name\n' + 'x'.repeat(2_000_001))).toThrow()
  expect(parseResourceCsv('code,type_key,name\nM1,machine,One\n,,\n\n').rows).toHaveLength(1)
})

const profile = {
  skipSegments: 1,
  levelTypes: ['enterprise', 'site', 'plant', 'zone', 'line', 'machine'],
  dataSuffixes: ['state', 'process', 'energy', 'condition', 'production/order', 'production/order_progress'],
}

test('the real guide structure yields sixteen resources from 36 topics, with production at Line', () => {
  const lines = ['Assembly-AA10-01-A1', 'Assembly-AA10-02-AB', 'Assembly-AA10-03-A3', 'Assembly-AA10-04-A4', 'Assembly-AA10-05-MM', 'Assembly-AA10-06-A6']
  const topics = lines.flatMap((line, index) => {
    const prefix = `uns/TIPA/DongNai/Factory-1/ASSY/${line}`
    const machine = `AA10-0${index + 1}`
    return ['state', 'process', 'energy', 'condition'].map(group => `${prefix}/${machine}/${group}`)
      .concat([`${prefix}/production/order`, `${prefix}/production/order_progress`])
  })
  const proposal = proposeTopicResources(topics, profile)
  expect(proposal.errors).toEqual([])
  expect(proposal.rows).toHaveLength(16)
  expect(proposal.rows.filter(row => row.type_key === 'line')).toHaveLength(6)
  expect(proposal.rows.filter(row => row.type_key === 'machine')).toHaveLength(6)
  expect(proposal.rows.some(row => row.code === 'production')).toBe(false)
  expect(proposal.rows.find(row => row.code === 'AA10-02')?.topicPrefix)
    .toBe('uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02')
})

test('topic deduplication permits equal machine codes in different branches and preserves raw prefixes', () => {
  const proposal = proposeTopicResources(['uns/E/S/A/M01/state', 'uns/E/S/B/M01/state', 'uns/E/S/A/M01/state'],
    { skipSegments: 1, levelTypes: ['enterprise', 'site', 'line', 'machine'], dataSuffixes: ['state'] })
  expect(proposal.errors).toEqual([])
  expect(proposal.rows).toHaveLength(6)
  expect(proposal.rows.filter(row => row.code === 'M01').map(row => row.path).sort()).toEqual(['E/S/A/M01', 'E/S/B/M01'])
})

test('topic proposals report code collisions and unknown suffixes instead of silently inventing assets', () => {
  const proposal = proposeTopicResources(['uns/E/Line A/M1/state', 'uns/E/Line@A/M1/state', 'uns/E/A/M1/unrecognized'],
    { skipSegments: 1, levelTypes: ['enterprise', 'line', 'machine'], dataSuffixes: ['state'] })
  expect(proposal.errors.some(error => error.code === 'CODE_COLLISION')).toBe(true)
  expect(proposal.errors.some(error => error.code === 'UNKNOWN_SUFFIX')).toBe(true)
  expect(proposal.rows.some(row => row.code === 'unrecognized')).toBe(false)
})

test('CSV finds the real header after empty lines without losing source row numbers', () => {
  const parsed = parseResourceCsv('\r\n  \r\ncode;type_key;name\r\nM1;machine;Machine\r\n')
  expect(parsed.rows).toEqual([{ code: 'M1', type_key: 'machine', name: 'Machine' }])
  expect(parsed.rowNumbers).toEqual([4])
})

test('wildcard and empty-level topics are rejected and topic limits are bounded', () => {
  const proposal = proposeTopicResources(['uns/E/+/state', 'uns/E//state'],
    { skipSegments: 1, levelTypes: ['enterprise', 'machine'], dataSuffixes: ['state'] })
  expect(proposal.rows).toEqual([])
  expect(proposal.errors.map(error => error.code)).toEqual(['INVALID_TOPIC', 'EMPTY_LEVEL'])
  expect(() => proposeTopicResources(Array(10001).fill('uns/E/state'), profile)).toThrow()
})

test('Vietnamese display names generate readable codes without altering the original MQTT prefix', () => {
  expect(codePreviewFromName('Đồng Nai')).toBe('Dong-Nai')
  const proposal = proposeTopicResources(['uns/Đồng Nai/M01/value'],
    { skipSegments: 1, levelTypes: ['site', 'pump'], dataSuffixes: ['value'] })
  expect(proposal.rows[0].code).toBe('Dong-Nai')
  expect(proposal.rows[0].name).toBe('Đồng Nai')
  expect(proposal.rows[0].topicPrefix).toBe('uns/Đồng Nai')
})
