import { expect, test } from '@playwright/test'
import { emptyImportState, importSession, editImportIdentity } from '../src/features/assets/importSession'

const rows = [{ path: 'E/S/M', name: 'Machine', type_key: 'machine', properties: { serial: '0007' } }]
const plan = {
  dry_run: true,
  accepted: 1,
  created: 0,
  reused: 0,
  plan_hash: 'a'.repeat(64),
  items: [],
  warnings: [],
}

test('editing a proposal or changing options invalidates approval and ignores a late preview', () => {
  let state = importSession(emptyImportState(), { type: 'draft', rows })
  const revision = state.revision
  state = importSession(state, { type: 'request', operation: 'preview' })
  state = importSession(state, { type: 'draft', rows: [{ ...rows[0], name: 'Edited' }] })
  state = importSession(state, { type: 'previewed', revision, result: plan })
  expect(state.rows[0].name).toBe('Edited')
  expect(state.preview).toBeNull()
  expect(state.busy).toBeNull()
  state = importSession(state, { type: 'previewed', revision: state.revision, result: plan })
  state = importSession(state, { type: 'options', parentId: 'site-a', hierarchyMode: 'strict' })
  expect(state.preview).toBeNull()
  expect(state.parentId).toBe('site-a')
  expect(state.hierarchyMode).toBe('strict')
})

test('failed import preserves rows and a valid preview for retry; stale plans require re-preview', () => {
  let state = importSession(emptyImportState(), { type: 'draft', rows })
  state = importSession(state, { type: 'previewed', revision: state.revision, result: plan })
  state = importSession(state, { type: 'request', operation: 'commit' })
  state = importSession(state, {
    type: 'failed',
    revision: state.revision,
    message: 'Network disconnected',
    code: 'NETWORK',
  })
  expect(state.rows).toEqual(rows)
  expect(state.preview?.plan_hash).toBe('a'.repeat(64))
  expect(state.result).toBeNull()
  expect(state.error).toBe('Network disconnected')
  state = importSession(state, {
    type: 'failed',
    revision: state.revision,
    message: 'Preview again',
    code: 'IMPORT_STALE',
  })
  expect(state.preview).toBeNull()
  expect(state.rows).toEqual(rows)
})

test('only server acknowledgment supplies created/reused counts and confirmed IDs', () => {
  let state = importSession(emptyImportState(), { type: 'draft', rows })
  state = importSession(state, { type: 'previewed', revision: state.revision, result: plan })
  state = importSession(state, { type: 'request', operation: 'commit' })
  expect(state.result).toBeNull()
  const result = {
    ...plan,
    dry_run: false,
    created: 0,
    reused: 1,
    items: [
      {
        index: 0,
        row: 1,
        action: 'REUSE' as const,
        path: 'E/S/M',
        name: 'Kept',
        type_key: 'machine',
        id: 'confirmed-id',
      },
    ],
  }
  state = importSession(state, { type: 'committed', revision: state.revision, result })
  expect(state.result?.items[0].id).toBe('confirmed-id')
  expect(state.result?.created).toBe(0)
  expect(state.result?.reused).toBe(1)
  expect(state.rows[0].properties).toEqual({ serial: '0007' })
})

test('closing/reopening discards late network results instead of reviving an old import', () => {
  let state = importSession(emptyImportState(), { type: 'draft', rows })
  const oldRevision = state.revision
  state = importSession(state, { type: 'reset' })
  state = importSession(state, {
    type: 'committed',
    revision: oldRevision,
    result: { ...plan, dry_run: false },
  })
  expect(state.rows).toEqual([])
  expect(state.result).toBeNull()
  expect(state.revision).toBeGreaterThan(oldRevision)
})

test('ancestor code edits update proposed descendants while preserving every original topic prefix', () => {
  const proposal = [
    { path: 'E', code: 'E', name: 'Enterprise', type_key: 'enterprise', topic_prefix: 'Raw Enterprise' },
    {
      path: 'E/S',
      code: 'S',
      parent_path: 'E',
      name: 'Site',
      type_key: 'site',
      topic_prefix: 'Raw Enterprise/Raw Site',
    },
    {
      path: 'E/S/M',
      code: 'M',
      parent_path: 'E/S',
      name: 'Machine',
      type_key: 'machine',
      topic_prefix: 'Raw Enterprise/Raw Site/Raw Machine',
    },
    { path: 'Elsewhere/E', name: 'Other', type_key: 'area', topic_prefix: 'Other/E' },
  ]
  const changed = editImportIdentity(proposal, 0, 'NewE')
  expect(changed.map((row) => row.path)).toEqual(['NewE', 'NewE/S', 'NewE/S/M', 'Elsewhere/E'])
  expect(changed[0].code).toBe('NewE')
  expect(changed[2].parent_path).toBe('NewE/S')
  expect(changed.map((row) => row.topic_prefix)).toEqual([
    'Raw Enterprise',
    'Raw Enterprise/Raw Site',
    'Raw Enterprise/Raw Site/Raw Machine',
    'Other/E',
  ])
  expect(proposal[0].path).toBe('E')
})
