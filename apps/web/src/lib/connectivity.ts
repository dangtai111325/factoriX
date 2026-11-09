/**
 * Browser ↔ appliance connectivity (R3-OV-01).
 *
 * Three independent inputs:
 *   - the browser's own network state (`navigator.onLine` + online/offline events);
 *   - the outcome of every API request (`api()` reports network errors and 502/503/504 as failures,
 *     any other answer as success);
 *   - the live stream (`/stream`) status: closed for longer than STREAM_GRACE_MS while the API answers.
 *
 * `state` is the most severe one:
 *   'browser_offline' > 'api_unreachable' > 'stream_down' > 'ok'.
 * `lost` is true for the first two: nothing shown on screen is current any more, so pages must show
 * statuses as "Unknown (no connection to appliance)" instead of their last value or a client-side Stale.
 *
 * Pollers call `connectivityDelay(base)` for their next delay so they back off while the appliance is
 * unreachable, and `onConnectivityRestored(cb)` to refresh at once when it is back.
 */
import { useSyncExternalStore } from 'react'
import { getStreamStatus, onStreamStatusChange, reconnectStreamNow } from './liveStream'

export type ConnectivityState = 'ok' | 'browser_offline' | 'api_unreachable' | 'stream_down'

export interface Connectivity {
  state: ConnectivityState
  /** Browser offline or API unreachable: the data on screen is not current. */
  lost: boolean
  /** Epoch ms when the current non-ok state started (null while ok). */
  since: number | null
  /** Epoch ms of the last successful API answer (null before the first one). */
  lastOkAt: number | null
}

/** A closed stream is only reported after this long (normal reconnects take a second or two). */
const STREAM_GRACE_MS = 10000
/** Longest poll delay while the appliance is unreachable. */
const MAX_BACKOFF_MS = 30000

let browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false
let apiFailures = 0
let apiDown = false
let lastOkAt: number | null = null
let streamClosedSince: number | null = null
let streamGraceTimer: number | null = null
let snapshot: Connectivity = { state: 'ok', lost: false, since: null, lastOkAt: null }
const listeners = new Set<() => void>()
const restoredListeners = new Set<() => void>()

function computeState(): ConnectivityState {
  if (!browserOnline) return 'browser_offline'
  if (apiDown) return 'api_unreachable'
  if (streamClosedSince !== null && Date.now() - streamClosedSince >= STREAM_GRACE_MS) return 'stream_down'
  return 'ok'
}

function publish(): void {
  const state = computeState()
  const lost = state === 'browser_offline' || state === 'api_unreachable'
  const wasLost = snapshot.lost
  if (state === snapshot.state && (state !== 'ok' || snapshot.lastOkAt !== null)) return
  const since = state === 'ok' ? null : snapshot.state === state ? snapshot.since : Date.now()
  snapshot = { state, lost, since, lastOkAt }
  listeners.forEach((listener) => listener())
  if (wasLost && !lost) {
    reconnectStreamNow()
    restoredListeners.forEach((listener) => listener())
  }
}

/** Called by `api()` after every request that got an answer from the appliance. */
export function reportApiSuccess(): void {
  apiFailures = 0
  const changed = apiDown || lastOkAt === null
  apiDown = false
  // Only republish when the state changes: the snapshot keeps the lastOkAt of its last publish, so
  // ordinary successful requests never re-render subscribers.
  lastOkAt = Date.now()
  if (changed) publish()
}

/** Called by `api()` when a request failed at the network level or the gateway reported the appliance down. */
export function reportApiFailure(): void {
  apiFailures += 1
  if (!apiDown) {
    apiDown = true
    publish()
  }
}

/** True when the request outcome means "appliance not reachable" rather than an application error. */
export function isUnreachableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** Next poll delay: the base delay while connected, exponential backoff (max 30 s) while lost. */
export function connectivityDelay(baseMs: number): number {
  if (!snapshot.lost) return baseMs
  const steps = Math.min(Math.max(apiFailures, 1), 5)
  return Math.min(MAX_BACKOFF_MS, Math.max(baseMs, 1000) * 2 ** steps)
}

export function getConnectivity(): Connectivity {
  return snapshot
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribe, getConnectivity, getConnectivity)
}

/** Run `cb` when the connection comes back (browser online again / API answering again). */
export function onConnectivityRestored(cb: () => void): () => void {
  restoredListeners.add(cb)
  return () => {
    restoredListeners.delete(cb)
  }
}

/** Run `cb` on every connectivity change. */
export function onConnectivityChange(cb: () => void): () => void {
  return subscribe(cb)
}

function onStreamStatus(): void {
  const status = getStreamStatus()
  if (status === 'open') {
    streamClosedSince = null
    if (streamGraceTimer !== null) {
      window.clearTimeout(streamGraceTimer)
      streamGraceTimer = null
    }
    publish()
    return
  }
  if (streamClosedSince === null) {
    streamClosedSince = Date.now()
    if (streamGraceTimer !== null) window.clearTimeout(streamGraceTimer)
    streamGraceTimer = window.setTimeout(() => {
      streamGraceTimer = null
      publish()
    }, STREAM_GRACE_MS + 50)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    browserOnline = true
    publish()
    reconnectStreamNow()
  })
  window.addEventListener('offline', () => {
    browserOnline = false
    publish()
  })
  onStreamStatusChange(onStreamStatus)
  // The stream starts closed until the first subscriber opens it; only count it once it was used.
  if (getStreamStatus() !== 'closed') onStreamStatus()
}
