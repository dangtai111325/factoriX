/**
 * In-flight guard for create / save / publish actions (R3-DM-04).
 *
 * `run()` starts the action only when no earlier call of the same hook is still running. The guard
 * is a ref, so a triple-click inside one React render frame starts the action exactly once (a
 * `disabled={pending}` attribute alone is not enough: it only applies after the next render).
 * Later calls while running resolve to `undefined` without calling the action.
 *
 *   const save = useSubmit(async () => api(...))
 *   <Button disabled={save.pending} onClick={() => void save.run()}>Save</Button>
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface Submit<A extends unknown[], R> {
  /** Run the action unless it is already running; resolves to undefined when the call was ignored. */
  run: (...args: A) => Promise<R | undefined>
  /** True while the action runs (use it for `disabled` and the busy label). */
  pending: boolean
  /** Synchronous check, for callers that must not wait for a re-render. */
  isRunning: () => boolean
}

export function useSubmit<A extends unknown[], R>(action: (...args: A) => Promise<R>): Submit<A, R> {
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const actionRef = useRef(action)
  actionRef.current = action
  const [pending, setPending] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (runningRef.current) return undefined
    runningRef.current = true
    setPending(true)
    try {
      return await actionRef.current(...args)
    } finally {
      runningRef.current = false
      if (mountedRef.current) setPending(false)
    }
  }, [])

  const isRunning = useCallback(() => runningRef.current, [])

  return { run, pending, isRunning }
}

/**
 * Module-level guard keyed by a string, for actions started from several components (or several
 * mounted copies of one dialog) that must still run once: `once('publish:<id>', () => api(...))`.
 * A second call with the same key while the first runs returns the first call's promise.
 */
const inflight = new Map<string, Promise<unknown>>()

export function once<R>(key: string, action: () => Promise<R>): Promise<R> {
  const current = inflight.get(key)
  if (current) return current as Promise<R>
  const promise = action().finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}
