/**
 * Client for the Center commissioning API (real tests run by the Edge collector):
 *   POST /api/v1/connections/{id}/tests    {mode: "CONNECTIVITY" | "FULL", fields: [...]}
 *   POST /api/v1/connections/{id}/capture  {topics, topic_filter, duration_seconds, max_messages, browse_node}
 *   GET  /api/v1/commissioning/{job_id}    {status, error_code, diagnostic, stages_json, samples_json}
 */
import { ApiError, api } from '../api/client'

export interface CommissionStage {
  stage: string
  status: string
  duration_ms?: number | null
  detail?: string
}

export interface CommissionResult {
  /** Terminal job status as returned by the API (COMPLETED | FAILED | CANCELLED | TIMEOUT). */
  status: string
  passed: boolean
  stages: CommissionStage[]
  errorCode?: string
  /** Human-readable reason from the Edge (or the client when the job never finished). */
  message?: string
  samples: unknown
}

interface JobRow {
  status?: string
  error_code?: string | null
  diagnostic?: string | null
  stages_json?: CommissionStage[]
  samples_json?: unknown
}

const TERMINAL = new Set(['COMPLETED', 'PASSED', 'FAILED', 'CANCELLED', 'ERROR'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function errorResult(code: string, message: string, stage = 'REQUEST'): CommissionResult {
  return {
    status: 'FAILED',
    passed: false,
    errorCode: code,
    message,
    stages: [{ stage, status: 'FAILED', detail: message }],
    samples: null,
  }
}

async function pollJob(jobId: string, timeoutMs: number): Promise<CommissionResult> {
  const deadline = Date.now() + timeoutMs
  let last: JobRow = {}
  let lastError: unknown = null
  while (Date.now() < deadline) {
    await sleep(800)
    try {
      last = await api<JobRow>(`/api/v1/commissioning/${encodeURIComponent(jobId)}`)
      lastError = null
    } catch (error) {
      lastError = error
      continue
    }
    const status = String(last.status || '').toUpperCase()
    if (TERMINAL.has(status)) {
      const stages = Array.isArray(last.stages_json) ? last.stages_json : []
      const passed = status === 'COMPLETED' || status === 'PASSED'
      return {
        status,
        passed,
        stages,
        errorCode: last.error_code || undefined,
        message: passed ? undefined : last.diagnostic || last.error_code || 'The collector reported a failure without details.',
        samples: last.samples_json ?? null,
      }
    }
  }
  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : 'Could not read the test status.'
    return errorResult('POLL_FAILED', message, 'STATUS')
  }
  const stages = Array.isArray(last.stages_json) ? last.stages_json : []
  return {
    status: 'TIMEOUT',
    passed: false,
    stages,
    errorCode: 'TIMEOUT',
    message: 'The collector did not finish the test in time. Check that the Edge collector is online.',
    samples: last.samples_json ?? null,
  }
}

function describeRequestError(error: unknown): CommissionResult {
  if (error instanceof ApiError) {
    if (error.code === 'EDGE_NOT_ENROLLED') {
      return errorResult('EDGE_NOT_ENROLLED', error.message || 'No enrolled collector for this site.', 'EDGE_ENROLLMENT')
    }
    return errorResult(error.code || `HTTP_${error.status}`, error.message || 'The request failed.')
  }
  return errorResult('NETWORK', error instanceof Error ? error.message : 'Network error.')
}

export interface TestFieldInput {
  key: string
  name?: string
  data_type?: string
  address: Record<string, unknown>
}

/** Run a commissioning test on the Edge and wait for the result. Never throws. */
export async function runConnectionTest(
  connectionId: string,
  options: {
    mode: 'CONNECTIVITY' | 'FULL'
    fields?: TestFieldInput[]
    /** Unsaved connection config to test instead of the stored one (the stored config is not changed). */
    config?: Record<string, unknown>
    timeoutMs?: number
  },
): Promise<CommissionResult> {
  let queued: { job_id?: string }
  try {
    queued = await api<{ job_id?: string }>(`/api/v1/connections/${encodeURIComponent(connectionId)}/tests`, {
      method: 'POST',
      body: JSON.stringify({
        mode: options.mode,
        // Both `address` and `address_json` carry the same object so every Edge version can read it.
        fields: (options.fields || []).map((field) => ({ ...field, address_json: field.address })),
        ...(options.config ? { config: options.config } : {}),
      }),
    })
  } catch (error) {
    return describeRequestError(error)
  }
  if (!queued.job_id) return errorResult('NO_JOB', 'The Center did not create a test job.')
  return pollJob(queued.job_id, options.timeoutMs ?? 45000)
}

export interface CaptureRequest {
  topics?: string[]
  topic_filter?: string
  duration_seconds?: number
  max_messages?: number
  browse_node?: string
}

export interface CapturedSample {
  /** MQTT topic, HTTP path or WebSocket URL the payload came from. */
  topic: string
  count: number
  /** Parsed payload as stored by the Center (key order may not be the source order). */
  payload: unknown
  /** Original payload text when the Edge provides it (keeps source key order and number formatting). */
  raw?: string
  receivedAt?: string
}

export interface BrowseNode {
  node_id: string
  browse_name: string
  display_name: string
  node_class: string
  has_children: boolean
}

export interface CaptureResult extends CommissionResult {
  captured: CapturedSample[]
  browse: BrowseNode[]
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function extractCapture(samplesJson: unknown): { samples: CapturedSample[]; browse: BrowseNode[] } {
  const container = samplesJson && typeof samplesJson === 'object' && !Array.isArray(samplesJson) ? (samplesJson as Record<string, unknown>) : null
  const sampleRows = Array.isArray(samplesJson) ? samplesJson : asArray(container?.samples)
  const browseRows = asArray(container?.browse)
  const samples: CapturedSample[] = sampleRows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row) => {
      const raw = typeof row.raw === 'string' ? row.raw : typeof row.payload_text === 'string' ? row.payload_text : undefined
      return {
        topic: String(row.topic ?? row.path ?? row.url ?? ''),
        count: Number(row.count) || 1,
        payload: row.payload,
        raw,
        receivedAt: typeof row.received_at === 'string' ? row.received_at : undefined,
      }
    })
  const browse: BrowseNode[] = browseRows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row) => ({
      node_id: String(row.node_id ?? ''),
      browse_name: String(row.browse_name ?? ''),
      display_name: String(row.display_name ?? row.browse_name ?? ''),
      node_class: String(row.node_class ?? ''),
      has_children: Boolean(row.has_children),
    }))
    .filter((row) => row.node_id)
  return { samples, browse }
}

/** Ask the Edge to capture live payloads (MQTT/HTTP/WebSocket) or browse an OPC UA node. Never throws. */
export async function runCapture(connectionId: string, request: CaptureRequest, timeoutMs = 45000): Promise<CaptureResult> {
  let queued: { job_id?: string }
  try {
    queued = await api<{ job_id?: string }>(`/api/v1/connections/${encodeURIComponent(connectionId)}/capture`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  } catch (error) {
    return { ...describeRequestError(error), captured: [], browse: [] }
  }
  if (!queued.job_id) return { ...errorResult('NO_JOB', 'The Center did not create a capture job.'), captured: [], browse: [] }
  const result = await pollJob(queued.job_id, timeoutMs)
  const { samples, browse } = result.passed ? extractCapture(result.samples) : { samples: [], browse: [] }
  return { ...result, captured: samples, browse }
}
