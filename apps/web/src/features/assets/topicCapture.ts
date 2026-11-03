import { api, ApiError } from '../../api/client'
import { translateApiError } from '../../utils/apiErrors'
import { proposeTopicResources } from './importing'
import type { TopicImportProfile } from './importing'
import type { ResourceImportRow } from './importSession'
import type { ResourceNode } from '../../types'

export interface TopicCapture {
  id: string
  connection_id: string
  topic_filter: string
  duration_s: number
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  error_code?: string | null
  samples?: Array<{
    topic: string
    payload: unknown
    error: string | null
    received_time: string
    source_time: string | null
  }>
  received?: number
  dropped?: number
  truncated?: boolean
}

export const captureActive = (job: TopicCapture | null) =>
  Boolean(job && ['PENDING', 'RUNNING'].includes(job.status))

export function captureRequestError(error: unknown): string {
  const message = translateApiError(error)
  return error instanceof ApiError && error.status > 0
    ? message
    : `${message} The capture request could not be confirmed. Its server deadline still applies; wait before retrying.`
}
export const startTopicCapture = (connectionId: string, topicFilter: string, duration: number) =>
  api<TopicCapture>(`/api/v1/connections/${connectionId}/topic-captures`, {
    method: 'POST',
    timeoutMs: 10_000,
    body: JSON.stringify({ topic_filter: topicFilter, duration_s: duration }),
  })
export const getTopicCapture = (id: string, signal?: AbortSignal) =>
  api<TopicCapture>(`/api/v1/topic-captures/${id}`, { signal, timeoutMs: 10_000 })
export const cancelTopicCapture = (id: string) =>
  api<TopicCapture>(`/api/v1/topic-captures/${id}/cancel`, { method: 'POST', timeoutMs: 10_000 })

export function capturedResourceRows(
  topics: string[],
  profile: TopicImportProfile,
  parentId: string,
  resources: ResourceNode[],
) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  const visited = new Set<string>(),
    codes: string[] = []
  let current = parentId
  while (current) {
    if (visited.has(current)) throw new Error('The selected parent has a hierarchy cycle. Refresh the model.')
    visited.add(current)
    const node = byId.get(current)
    if (!node || node.lifecycle === 'ARCHIVED')
      throw new Error('The selected parent is unavailable. Choose an active parent.')
    codes.unshift(node.code)
    current = node.parentId || ''
  }
  const prefix = codes.join('/')
  const proposal = proposeTopicResources(topics, profile)
  const rows: ResourceImportRow[] = proposal.rows.map((row, index) => ({
    path: [prefix, row.path].filter(Boolean).join('/'),
    parent_path: [prefix, row.parent_path].filter(Boolean).join('/'),
    code: row.code,
    name: row.name,
    type_key: row.type_key,
    topic_prefix: row.topicPrefix,
    source_row: index + 1,
  }))
  return { rows, errors: proposal.errors }
}
