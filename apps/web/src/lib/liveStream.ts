/**
 * Shared live stream client (one WebSocket per browser tab) for the Center `/stream` endpoint.
 *
 * Server -> client messages (see release contract "Push to UI"):
 *   {type:"latest", signal_id, value, quality, effective_status, reason_code, received_time, source_time}
 *   {type:"health", entity:"edge"|"connection", id, health, effective_health, last_error, last_success_at}
 *   {type:"model_body", group_id, body}     body = exact ordered JSON text
 *   {type:"model_event", group_id, event_id, body}
 *   {type:"subscribed", count}              ack for a signal subscription
 * Client -> server:
 *   {op:"subscribe", signal_ids:[...]}      replaces the signal subscription of this socket
 *   {op:"subscribe_models", group_ids:[...]}
 *   {op:"subscribe_health"}
 *   {op:"ping"}
 *
 * The socket is opened lazily when the first subscriber registers and closed when the last one leaves.
 * It reconnects with exponential backoff and re-sends every subscription after a reconnect.
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
const coverageListeners = new Set<() => void>()

const MAX_BACKOFF_MS = 30000
const PING_INTERVAL_MS = 25000

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
  if (!raw || typeof raw !== 'object') return
  const msg = raw as { type?: string } & Record<string, unknown>
  switch (msg.type) {
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
    setStatus('open')
    sendSubscriptions()
    pingTimer = window.setInterval(() => send({ op: 'ping' }), PING_INTERVAL_MS)
  }
  ws.onmessage = (event) => {
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
  return new Set(lastRequestedSignalIds.slice(0, acknowledgedCount))
}

/** Listen for changes of `getPushedSignalIds()` (socket state or subscription acknowledgement). */
export function onPushCoverageChange(listener: () => void): () => void {
  coverageListeners.add(listener)
  return () => {
    coverageListeners.delete(listener)
  }
}
