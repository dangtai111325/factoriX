/**
 * Client for the Center commissioning API (real tests run by the Edge collector):
 *   POST /api/v1/connections/{id}/tests    {mode: "CONNECTIVITY" | "FULL", fields: [...], config?, test_path?}
 *   POST /api/v1/connections/{id}/capture  {topics, topic_filter, duration_seconds, max_messages, browse_node}
 *   GET  /api/v1/commissioning/{job_id}    {status, error_code, diagnostic, stages_json, samples_json}
 */
import { useSyncExternalStore } from 'react'
import { ApiError, api } from '../api/client'

// ---------------------------------------------------------------------------------------------
// Collector start-up (R2-CN-02): right after installation the built-in collector needs a few seconds
// to enroll. A test requested meanwhile is answered 409 EDGE_NOT_ENROLLED, or its job stays PENDING
// because no collector picked it up yet. That is not an error: the request is retried / polled until
// the collector is up, and the UI shows "Collector is starting…" while waiting.
// ---------------------------------------------------------------------------------------------

/** How long a test waits for a starting collector before giving up. */
const COLLECTOR_START_WAIT_MS = 120000
/** A job still fully PENDING after this long means no collector has picked it up yet. */
const PENDING_IS_WAITING_MS = 8000

let waitingCount = 0
const waitingListeners = new Set<() => void>()

function setWaiting(delta: 1 | -1): void {
  waitingCount = Math.max(0, waitingCount + delta)
  waitingListeners.forEach((listener) => listener())
}

/** True while at least one test or capture is waiting for the collector to start. */
export function useCollectorStarting(): boolean {
  return useSyncExternalStore(
    (listener) => {
      waitingListeners.add(listener)
      return () => {
        waitingListeners.delete(listener)
      }
    },
    () => waitingCount > 0,
  )
}

export const COLLECTOR_STARTING_MESSAGE = 'Collector is starting… the test will run automatically.'

function isCollectorStarting(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'EDGE_NOT_ENROLLED'
}

/** POST a test / capture request, retrying while the collector is still enrolling. */
async function queueJob(path: string, body: unknown): Promise<{ job_id?: string }> {
  const deadline = Date.now() + COLLECTOR_START_WAIT_MS
  let waiting = false
  try {
    for (;;) {
      try {
        return await api<{ job_id?: string }>(path, { method: 'POST', body: JSON.stringify(body) })
      } catch (error) {
        if (!isCollectorStarting(error) || Date.now() > deadline) throw error
        if (!waiting) {
          waiting = true
          setWaiting(1)
        }
        await sleep(3000)
      }
    }
  } finally {
    if (waiting) setWaiting(-1)
  }
}

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

function notPickedUp(row: JobRow): boolean {
  const status = String(row.status || '').toUpperCase()
  if (status && status !== 'PENDING' && status !== 'QUEUED') return false
  const stages = Array.isArray(row.stages_json) ? row.stages_json : []
  return stages.every((stage) => String(stage.status || '').toUpperCase() === 'PENDING')
}

async function pollJob(jobId: string, timeoutMs: number): Promise<CommissionResult> {
  const started = Date.now()
  let waiting = false
  try {
    return await pollJobInner(jobId, timeoutMs, started, (next) => {
      if (next === waiting) return
      waiting = next
      setWaiting(next ? 1 : -1)
    })
  } finally {
    if (waiting) setWaiting(-1)
  }
}

async function pollJobInner(jobId: string, timeoutMs: number, started: number, markWaiting: (waiting: boolean) => void): Promise<CommissionResult> {
  let deadline = started + timeoutMs
  let waiting = false
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
    // Still queued with no stage started: the collector is starting. Keep polling (longer) instead of failing.
    if (notPickedUp(last) && Date.now() - started > PENDING_IS_WAITING_MS) {
      if (!waiting) {
        waiting = true
        markWaiting(true)
        deadline = Math.max(deadline, started + COLLECTOR_START_WAIT_MS)
      }
    } else if (waiting) {
      waiting = false
      markWaiting(false)
      // The collector picked the job up: give the test its normal time from now.
      deadline = Math.max(deadline, Date.now() + timeoutMs)
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
    message: notPickedUp(last)
      ? 'The collector did not start within 2 minutes. Check that the Edge collector is running and enrolled.'
      : 'The collector did not finish the test in time. Check that the Edge collector is online.',
    samples: last.samples_json ?? null,
  }
}

function describeRequestError(error: unknown): CommissionResult {
  if (error instanceof ApiError) {
    if (error.code === 'EDGE_NOT_ENROLLED') {
      // Only reached after waiting COLLECTOR_START_WAIT_MS for the collector to enroll.
      return errorResult(
        'EDGE_NOT_ENROLLED',
        'The collector of this site is still not enrolled after 2 minutes. Check the Edge collector, then test again.',
        'EDGE_ENROLLMENT',
      )
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
    /** HTTP only: relative data path used by the AUTH stage to prove the credentials (`test_path`). */
    testPath?: string
    timeoutMs?: number
  },
): Promise<CommissionResult> {
  return runJob(
    `/api/v1/connections/${encodeURIComponent(connectionId)}/tests`,
    {
      mode: options.mode,
      // Both `address` and `address_json` carry the same object so every Edge version can read it.
      fields: (options.fields || []).map((field) => ({ ...field, address_json: field.address })),
      ...(options.config ? { config: options.config } : {}),
      ...(options.testPath && options.testPath.trim() ? { test_path: options.testPath.trim() } : {}),
    },
    options.timeoutMs ?? 45000,
    'test',
  )
}

/**
 * Queue a job and wait for its result. While the collector is still starting (409 EDGE_NOT_ENROLLED,
 * or the Center reaped the queued job with EDGE_NOT_STARTED because nobody picked it up), the job is
 * queued again automatically until COLLECTOR_START_WAIT_MS has elapsed.
 */
async function runJob(path: string, body: unknown, timeoutMs: number, noun: 'test' | 'capture'): Promise<CommissionResult> {
  const deadline = Date.now() + COLLECTOR_START_WAIT_MS
  let waiting = false
  try {
    for (;;) {
      let queued: { job_id?: string }
      try {
        queued = await queueJob(path, body)
      } catch (error) {
        return describeRequestError(error)
      }
      if (!queued.job_id) return errorResult('NO_JOB', `The Center did not create a ${noun} job.`)
      const result = await pollJob(queued.job_id, timeoutMs)
      if (result.errorCode !== 'EDGE_NOT_STARTED' || Date.now() > deadline) return result
      if (!waiting) {
        waiting = true
        setWaiting(1)
      }
    }
  } finally {
    if (waiting) setWaiting(-1)
  }
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
  const result = await runJob(`/api/v1/connections/${encodeURIComponent(connectionId)}/capture`, request, timeoutMs, 'capture')
  const { samples, browse } = result.passed ? extractCapture(result.samples) : { samples: [], browse: [] }
  return { ...result, captured: samples, browse }
}
