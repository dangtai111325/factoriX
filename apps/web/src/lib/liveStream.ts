/**
 * Shared live stream client (one WebSocket per browser tab) for the Center `/stream` endpoint.
 *
 * Server -> client messages (see release contract "Push to UI"):
 *   {type:"latest", signal_id, value, quality, effective_status, reason_code, received_time, source_time}
 *   {type:"health", entity:"edge"|"connection", id, health, effective_health, last_error, last_success_at}
 *   {type:"model_body", group_id, body}     body = exact ordered JSON text
 *   {type:"model_event", group_id, event_id, body}
 *   {type:"subscribed", count, rejected?, heartbeat_s?}  ack for a signal subscription
 *   {type:"heartbeat", seq, server_time, pipeline?:{[connection_id]:{source_ok_at, delivered_at, delivery_lag_ms}}}
 *                                           every 5 s on every socket (liveness + server clock)
 *   {type:"resync"}                         the server missed events (e.g. its NOTIFY bridge reconnected)
 * Client -> server:
 *   {op:"subscribe", signal_ids:[...]}      replaces the signal subscription of this socket
 *   {op:"subscribe_models", group_ids:[...]}
 *   {op:"subscribe_health"}
 *   {op:"ping"}
 *
 * The socket is opened lazily when the first subscriber registers and closed when the last one leaves.
 * It reconnects with exponential backoff and re-sends every subscription after a reconnect.
 *
 * Liveness: an "open" socket is not trusted blindly. If no frame (heartbeat, pong or data) arrives
 * for 3 heartbeat periods the socket is dropped, push coverage becomes empty (callers poll REST)
 * and a reconnect starts. Freshness (FRESH / DELAYED / STALE) is decided by the server; the client
 * only renders it and computes the displayed age with the server clock offset.
 */
import { useSyncExternalStore } from 'react'

export type StreamStatus = 'connecting' | 'open' | 'closed'

export interface LatestMsg {
  type: 'latest'
  signal_id: string
  value: unknown
  quality?: string | null
  effective_status?: string | null
  reason_code?: string | null
  received_time?: string | null
  source_time?: string | null
  evaluated_at?: string | null
  stale_after_ms?: number | null
  data_epoch?: number | null
  last_acquired_at?: string | null
  last_value_changed_at?: string | null
  source_health?: string | null
  connection_health?: string | null
  broker_health?: string | null
  storage_health?: string | null
  /** FRESH | DELAYED | STALE | UNKNOWN | NO_DATA (server evaluated). */
  freshness?: string | null
  /** Set when DELAYED: the value is current at the source but late in the pipeline. */
  delivery_lag_ms?: number | null
  age_ms?: number | null
  connection_id?: string | null
}

export interface PipelineEntry {
  source_ok_at?: string | null
  delivered_at?: string | null
  delivery_lag_ms?: number | null
}

export interface HealthMsg {
  type: 'health'
  entity: 'edge' | 'connection' | string
  id: string
  health?: string | null
  effective_health?: string | null
  last_error?: string | null
  last_success_at?: string | null
}

export interface ModelBodyMsg {
  type: 'model_body'
  /** Data model id. */
  group_id: string
  /** Exact ordered JSON text of the sample. Never re-serialise it if key order matters. */
  body: string
  /** Sample time (ISO ms Z); pushed every sample_ms while the model runs. */
  sampled_at?: string | null
  /** Runtime errors of this sample: [{path, node_id?, code, message}]. */
  errors?: Array<{ path?: string; node_id?: string; code?: string; message?: string }>
}

export interface ModelEventMsg {
  type: 'model_event'
  group_id: string
  event_id: string
  body: string
}

type SignalCb = (msg: LatestMsg) => void
type ModelCb = (msg: ModelBodyMsg | ModelEventMsg) => void
type HealthCb = (msg: HealthMsg) => void

const signalSubs = new Map<string, Set<SignalCb>>()
const modelSubs = new Map<string, Set<ModelCb>>()
const healthSubs = new Set<HealthCb>()
const statusListeners = new Set<() => void>()

let socket: WebSocket | null = null
let status: StreamStatus = 'closed'
let reconnectTimer: number | null = null
let pingTimer: number | null = null
let flushQueued = false
let backoffMs = 1000
/** Signal ids in the order of the last subscribe request sent to the server. */
let lastRequestedSignalIds: string[] = []
/** How many of `lastRequestedSignalIds` the server acknowledged (it may cap the list). */
let acknowledgedCount = 0
/** Ids the server refused (unknown / other tenant); everything else requested is pushed. */
let rejectedIds = new Set<string>()
const coverageListeners = new Set<() => void>()
const resyncListeners = new Set<() => void>()
const pipelineListeners = new Set<() => void>()
let lastFrameAt = 0
let heartbeatSeen = false
let heartbeatMs = 5000
let livenessTimer: number | null = null
/** server_time - Date.now(), from heartbeats and pongs. */
let serverOffsetMs = 0
let pipeline: Record<string, PipelineEntry> = {}

const MAX_BACKOFF_MS = 30000
const PING_INTERVAL_MS = 10000
/** Without heartbeats (older server) the 10 s ping/pong is the liveness probe. */
const PONG_TIMEOUT_MS = 25000

function setStatus(next: StreamStatus): void {
  if (status === next) return
  status = next
  statusListeners.forEach((listener) => listener())
  coverageListeners.forEach((listener) => listener())
}

function hasSubscribers(): boolean {
  return signalSubs.size > 0 || modelSubs.size > 0 || healthSubs.size > 0
}

function streamUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/stream`
}

function send(payload: Record<string, unknown>): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

function sendSubscriptions(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  lastRequestedSignalIds = Array.from(signalSubs.keys())
  acknowledgedCount = 0
  rejectedIds = new Set()
  send({ op: 'subscribe', signal_ids: lastRequestedSignalIds })
  if (modelSubs.size > 0) send({ op: 'subscribe_models', group_ids: Array.from(modelSubs.keys()) })
  if (healthSubs.size > 0) send({ op: 'subscribe_health' })
  coverageListeners.forEach((listener) => listener())
}

/** Coalesce many subscribe/unsubscribe calls made in the same tick into one message. */
function scheduleFlush(): void {
  if (flushQueued) return
  flushQueued = true
  queueMicrotask(() => {
    flushQueued = false
    if (!hasSubscribers()) {
      disconnect()
      return
    }
    if (!socket) {
      connect()
      return
    }
    sendSubscriptions()
  })
}

function clearTimers(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (pingTimer !== null) {
    window.clearInterval(pingTimer)
    pingTimer = null
  }
  if (livenessTimer !== null) {
    window.clearInterval(livenessTimer)
    livenessTimer = null
  }
}

function noteServerTime(value: unknown): void {
  if (typeof value !== 'string') return
  const ms = Date.parse(value)
  if (Number.isFinite(ms)) serverOffsetMs = ms - Date.now()
}

/** Drop a socket that looks open but delivers nothing (half-open TCP, stuck server sender). */
function checkLiveness(): void {
  if (!socket || status !== 'open') return
  const limit = heartbeatSeen ? heartbeatMs * 3 : PONG_TIMEOUT_MS
  if (Date.now() - lastFrameAt <= limit) return
  console.warn(`liveStream: no frame for ${Math.round((Date.now() - lastFrameAt) / 1000)} s; reconnecting`)
  const dead = socket
  socket = null
  dead.onopen = null
  dead.onclose = null
  dead.onerror = null
  dead.onmessage = null
  try {
    dead.close()
  } catch {
    // already broken
  }
  clearTimers()
  lastRequestedSignalIds = []
  acknowledgedCount = 0
  setStatus('closed')
  backoffMs = 1000
  scheduleReconnect()
}

function disconnect(): void {
  clearTimers()
  const current = socket
  socket = null
  if (current) {
    current.onopen = null
    current.onclose = null
    current.onerror = null
    current.onmessage = null
    try {
      current.close()
    } catch (error) {
      console.warn('liveStream: close failed', error)
    }
  }
  lastRequestedSignalIds = []
  acknowledgedCount = 0
  setStatus('closed')
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null || !hasSubscribers()) return
  const delay = backoffMs
  backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    if (hasSubscribers()) connect()
  }, delay)
}

function dispatch(raw: unknown): void {
  // The server coalesces bursts into one frame: {type: "batch", messages: [...]}.
  if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'batch') {
    const messages = (raw as { messages?: unknown }).messages
    if (Array.isArray(messages)) for (const item of messages) dispatch(item)
    return
  }
  if (!raw || typeof raw !== 'object') return
  const msg = raw as { type?: string } & Record<string, unknown>
  switch (msg.type) {
    case 'heartbeat': {
      heartbeatSeen = true
      noteServerTime(msg.server_time)
      if (msg.pipeline && typeof msg.pipeline === 'object') {
        pipeline = { ...pipeline, ...(msg.pipeline as Record<string, PipelineEntry>) }
        pipelineListeners.forEach((listener) => listener())
      }
      break
    }
    case 'pong':
      noteServerTime(msg.server_time)
      break
    case 'resync':
      resyncListeners.forEach((listener) => listener())
      break
    case 'latest': {
      const id = String(msg.signal_id ?? '')
      const subs = signalSubs.get(id)
      if (subs) subs.forEach((cb) => cb(msg as unknown as LatestMsg))
      break
    }
    case 'health':
      healthSubs.forEach((cb) => cb(msg as unknown as HealthMsg))
      break
    case 'model_body':
    case 'model_event': {
      const id = String(msg.group_id ?? '')
      const subs = modelSubs.get(id)
      if (subs) subs.forEach((cb) => cb(msg as unknown as ModelBodyMsg | ModelEventMsg))
      break
    }
    case 'subscribed': {
      const count = Number(msg.count)
      acknowledgedCount = Number.isFinite(count) ? count : 0
      rejectedIds = new Set(Array.isArray(msg.rejected) ? (msg.rejected as unknown[]).map(String) : [])
      const hb = Number(msg.heartbeat_s)
      if (Number.isFinite(hb) && hb > 0) heartbeatMs = hb * 1000
      coverageListeners.forEach((listener) => listener())
      break
    }
    default:
      break
  }
}

function connect(): void {
  if (socket || typeof window === 'undefined' || typeof WebSocket === 'undefined') return
  clearTimers()
  setStatus('connecting')
  let ws: WebSocket
  try {
    ws = new WebSocket(streamUrl())
  } catch (error) {
    console.warn('liveStream: cannot open socket', error)
    setStatus('closed')
    scheduleReconnect()
    return
  }
  socket = ws
  ws.onopen = () => {
    backoffMs = 1000
    lastFrameAt = Date.now()
    heartbeatSeen = false
    setStatus('open')
    sendSubscriptions()
    pingTimer = window.setInterval(() => send({ op: 'ping' }), PING_INTERVAL_MS)
    livenessTimer = window.setInterval(checkLiveness, 2000)
  }
  ws.onmessage = (event) => {
    lastFrameAt = Date.now()
    try {
      dispatch(JSON.parse(String(event.data)))
    } catch (error) {
      console.warn('liveStream: invalid message', error)
    }
  }
  ws.onerror = () => {
    // The close handler that follows owns the reconnect.
  }
  ws.onclose = (event) => {
    if (socket !== ws) return
    socket = null
    clearTimers()
    lastRequestedSignalIds = []
    acknowledgedCount = 0
    setStatus('closed')
    if (event.code === 4401) {
      // Session expired: do not hammer the server, retry at the slowest pace.
      backoffMs = MAX_BACKOFF_MS
    }
    scheduleReconnect()
  }
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key)
  if (!set) {
    set = new Set<V>()
    map.set(key, set)
  }
  set.add(value)
}

function removeFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key)
  if (!set) return
  set.delete(value)
  if (set.size === 0) map.delete(key)
}

export function subscribeSignals(ids: string[], cb: (msg: LatestMsg) => void): () => void {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  unique.forEach((id) => addTo(signalSubs, id, cb))
  scheduleFlush()
  return () => {
    unique.forEach((id) => removeFrom(signalSubs, id, cb))
    scheduleFlush()
  }
}

export function subscribeModels(groupIds: string[], cb: (msg: ModelBodyMsg | ModelEventMsg) => void): () => void {
  const unique = Array.from(new Set(groupIds.filter(Boolean)))
  unique.forEach((id) => addTo(modelSubs, id, cb))
  scheduleFlush()
  return () => {
    unique.forEach((id) => removeFrom(modelSubs, id, cb))
    scheduleFlush()
  }
}

export function subscribeHealth(cb: (msg: HealthMsg) => void): () => void {
  healthSubs.add(cb)
  scheduleFlush()
  return () => {
    healthSubs.delete(cb)
    scheduleFlush()
  }
}

export function getStreamStatus(): StreamStatus {
  return status
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** Listen for stream status changes (used by the connectivity store). */
export function onStreamStatusChange(listener: () => void): () => void {
  return subscribeStatus(listener)
}

/**
 * Reconnect now instead of waiting for the backoff timer (e.g. the browser came back online).
 * No-op while the socket is open or nobody is subscribed.
 */
export function reconnectStreamNow(): void {
  if (socket || !hasSubscribers()) return
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  backoffMs = 1000
  connect()
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribeStatus, getStreamStatus, () => 'closed' as StreamStatus)
}

/**
 * Signal ids for which the server currently pushes `latest` messages.
 * The server may cap one subscription (it keeps the first N ids), so callers should poll the rest.
 * Returns an empty set while the socket is not open or before the server acknowledged.
 */
export function getPushedSignalIds(): Set<string> {
  if (status !== 'open') return new Set()
  // The server reports what it refused (unknown ids): coverage is the accepted ids, capped at its count.
  const accepted = rejectedIds.size > 0 ? lastRequestedSignalIds.filter((id) => !rejectedIds.has(id)) : lastRequestedSignalIds
  return new Set(accepted.slice(0, acknowledgedCount))
}

/** Server clock minus browser clock (ms), learned from heartbeats/pongs. 0 until known. */
export function getServerOffsetMs(): number {
  return serverOffsetMs
}

/** Server "now" in epoch ms (browser clock corrected by the heartbeat offset). */
export function serverNowMs(): number {
  return Date.now() + serverOffsetMs
}

/** Per-connection delivery evidence from the latest heartbeat (source read time, newest delivered data). */
export function getPipeline(): Record<string, PipelineEntry> {
  return pipeline
}

export function onPipelineChange(listener: () => void): () => void {
  pipelineListeners.add(listener)
  return () => {
    pipelineListeners.delete(listener)
  }
}

/** React hook: delivery evidence of one connection from the stream heartbeat (undefined if unknown). */
export function usePipelineEntry(connectionId: string | undefined): PipelineEntry | undefined {
  const snapshot = useSyncExternalStore(onPipelineChange, getPipeline, getPipeline)
  return connectionId ? snapshot[connectionId.toLowerCase()] : undefined
}

/** Called when the server asks clients to refetch (it may have missed pushes). */
export function onStreamResync(listener: () => void): () => void {
  resyncListeners.add(listener)
  return () => {
    resyncListeners.delete(listener)
  }
}

/** Listen for changes of `getPushedSignalIds()` (socket state or subscription acknowledgement). */
export function onPushCoverageChange(listener: () => void): () => void {
  coverageListeners.add(listener)
  return () => {
    coverageListeners.delete(listener)
  }
}
