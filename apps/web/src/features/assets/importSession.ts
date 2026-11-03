export type ResourceImportRow = Record<string, unknown>
export interface ImportIssue {
  row: number
  code: string
  message: string
  field?: string
}
export interface ResourceImportItem {
  index: number
  row: number
  action: 'CREATE' | 'REUSE'
  path: string
  name: string
  type_key: string
  id?: string | null
  existing_id?: string | null
  differences?: Record<string, { incoming: unknown; existing: unknown }>
  site_index?: number | null
  site_id?: string | null
}
export interface ResourceImportResult {
  dry_run: boolean
  accepted: number
  created: number
  reused: number
  plan_hash: string
  items: ResourceImportItem[]
  warnings: ImportIssue[]
}
export interface ImportState {
  rows: ResourceImportRow[]
  revision: number
  parentId: string
  hierarchyMode: 'guided' | 'strict'
  busy: 'preview' | 'commit' | null
  preview: ResourceImportResult | null
  result: ResourceImportResult | null
  error: string
  issues: ImportIssue[]
}
export type ImportSessionAction =
  | { type: 'reset' }
  | { type: 'draft'; rows: ResourceImportRow[] }
  | { type: 'options'; parentId: string; hierarchyMode: 'guided' | 'strict' }
  | { type: 'request'; operation: 'preview' | 'commit' }
  | { type: 'previewed'; revision: number; result: ResourceImportResult }
  | { type: 'committed'; revision: number; result: ResourceImportResult }
  | { type: 'failed'; revision: number; message: string; code?: string; issues?: ImportIssue[] }

export function emptyImportState(): ImportState {
  return {
    rows: [],
    revision: 0,
    parentId: '',
    hierarchyMode: 'guided',
    busy: null,
    preview: null,
    result: null,
    error: '',
    issues: [],
  }
}

export function importSession(state: ImportState, action: ImportSessionAction): ImportState {
  if (action.type === 'reset') return { ...emptyImportState(), revision: state.revision + 1 }
  if (action.type === 'draft' || action.type === 'options') {
    return {
      ...state,
      ...(action.type === 'draft'
        ? { rows: action.rows }
        : { parentId: action.parentId, hierarchyMode: action.hierarchyMode }),
      revision: state.revision + 1,
      preview: null,
      result: null,
      error: '',
      issues: [],
      busy: null,
    }
  }
  if (action.type === 'request') return { ...state, busy: action.operation, error: '', issues: [] }
  if (action.revision !== state.revision) return state
  if (action.type === 'previewed')
    return { ...state, preview: action.result, busy: null, error: '', issues: [] }
  if (action.type === 'committed')
    return { ...state, result: action.result, busy: null, error: '', issues: [] }
  return {
    ...state,
    busy: null,
    error: action.message,
    issues: action.issues || [],
    preview: ['IMPORT_STALE', 'PREVIEW_REQUIRED', 'IMPORT_INVALID'].includes(action.code || '')
      ? null
      : state.preview,
  }
}

export function editImportIdentity(
  rows: ResourceImportRow[],
  index: number,
  value: string,
): ResourceImportRow[] {
  const target = rows[index]
  if (!target) return rows
  if (typeof target.path !== 'string' || !target.path)
    return rows.map((row, at) => (at === index ? { ...row, code: value } : row))
  const oldPath = target.path
  const duplicate = rows.some((row, at) => at !== index && row.path === oldPath)
  const replace = (path: string) =>
    path === oldPath ? value : path.startsWith(`${oldPath}/`) ? value + path.slice(oldPath.length) : path
  return rows.map((row, at) => {
    if (at === index)
      return {
        ...row,
        path: value,
        code: value.split('/').slice(-1)[0] || '',
        ...(row.parent_path !== undefined ? { parent_path: value.split('/').slice(0, -1).join('/') } : {}),
      }
    const sourceChild =
      typeof target.topic_prefix === 'string'
        ? typeof row.topic_prefix === 'string' && row.topic_prefix.startsWith(`${target.topic_prefix}/`)
        : !duplicate
    if (!sourceChild || typeof row.path !== 'string' || !row.path.startsWith(`${oldPath}/`)) return row
    return {
      ...row,
      path: replace(row.path),
      ...(typeof row.parent_path === 'string' ? { parent_path: replace(row.parent_path) } : {}),
    }
  })
}
