import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../components/common/Button'
import {
  cancelTopicCapture, captureActive, captureRequestError, getTopicCapture, startTopicCapture,
} from '../assets/topicCapture'
import type { TopicCapture } from '../assets/topicCapture'
import { discoverPayloadFields } from './mqttDiscovery'
import type { DiscoveredField } from './mqttDiscovery'
import { translateApiError } from '../../utils/apiErrors'

interface Props {
  filter: string
  prepare: () => Promise<string>
  onBusy: (busy: boolean) => void
  onAdd: (topic: string, fields: DiscoveredField[]) => void
}

export const MqttFieldCapture: React.FC<Props> = ({ filter, prepare, onBusy, onAdd }) => {
  const [duration, setDuration] = useState('5')
  const [job, setJob] = useState<TopicCapture | null>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [topic, setTopic] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [added, setAdded] = useState('')
  const generation = useRef(0)
  const latestJob = useRef<TopicCapture | null>(null)
  const busy = starting || cancelling || captureActive(job)
  const updateJob = (next: TopicCapture) => {
    latestJob.current = next
    setJob(next)
  }
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  useEffect(() => () => {
    generation.current++
    if (captureActive(latestJob.current)) void cancelTopicCapture(latestJob.current!.id).catch(() => {})
  }, [])
  useEffect(() => {
    if (!captureActive(job)) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      getTopicCapture(job!.id, controller.signal).then(next => {
        if (controller.signal.aborted) return
        updateJob(next)
        setPollError('')
      }).catch(err => {
        if (controller.signal.aborted) return
        setPollError(`Status could not refresh: ${translateApiError(err)}. Retrying until the server deadline.`)
        setJob(previous => previous ? { ...previous } : previous)
      })
    }, 1000)
    return () => { clearTimeout(timer); controller.abort() }
  }, [job])
  const start = async () => {
    const revision = ++generation.current
    setStarting(true)
    setError('')
    setPollError('')
    setTopic('')
    setSelected(new Set())
    setAdded('')
    setJob(null)
    latestJob.current = null
    try {
      const connectionId = await prepare()
      if (revision !== generation.current) return
      const next = await startTopicCapture(connectionId, filter, Number(duration))
      if (revision !== generation.current) {
        void cancelTopicCapture(next.id).catch(() => {})
        return
      }
      updateJob(next)
    } catch (err) {
      if (revision === generation.current) setError(captureRequestError(err))
    } finally {
      if (revision === generation.current) setStarting(false)
    }
  }
  const cancel = async () => {
    if (!job) return
    setCancelling(true)
    setError('')
    try { updateJob(await cancelTopicCapture(job.id)) }
    catch (err) { setError(translateApiError(err)) }
    finally { setCancelling(false) }
  }
  const sample = job?.samples?.find(item => item.topic === topic)
  const discovery = useMemo(() => sample && !sample.error ? discoverPayloadFields(sample.payload) : null, [sample])
  return <section className="mb-4 space-y-3 rounded-lg border border-[var(--fx-border)] p-3" aria-label="Discover MQTT fields">
    <h3 className="text-sm font-semibold">Discover fields from actual MQTT payloads</h3>
    <p className="text-xs text-[var(--fx-muted)]">Capture reads through this connection's Edge without publishing or activating signals. Creating the connection draft is required; mapping and activation remain separate.</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs font-semibold">Capture duration (seconds)
        <input className="fx-input mt-1 w-28" type="number" min={2} max={30} step={1} value={duration} disabled={busy} onChange={event => setDuration(event.target.value)} />
      </label>
      <Button variant="secondary" disabled={busy || !Number.isInteger(Number(duration)) || Number(duration) < 2 || Number(duration) > 30} onClick={() => void start()}>{starting ? 'Preparing capture…' : 'Capture source topics'}</Button>
      {captureActive(job) ? <Button variant="secondary" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Cancelling…' : 'Cancel capture'}</Button> : null}
    </div>
    {job ? <p role="status" className="text-xs">{job.status}{job.status === 'COMPLETED' ? ` · ${job.samples?.length || 0} topics · ${job.received ?? 0} received messages` : job.error_code ? ` · ${job.error_code}` : ''}</p> : null}
    {error ? <p role="alert" className="break-words text-xs text-[var(--fx-error)]">{error}</p> : null}
    {pollError ? <p role="alert" className="text-xs text-[var(--fx-warning)]">{pollError}</p> : null}
    {job?.status === 'COMPLETED' ? <>
      {job.truncated ? <p role="alert" className="text-xs text-[var(--fx-warning)]">Some samples were omitted or a limit was reached. Dropped: {job.dropped ?? 0}. Narrow the filter and capture again to check completeness.</p> : null}
      {!job.samples?.length ? <p className="text-xs">No topics received. Check the filter and source, then capture again.</p> : <label className="block text-xs font-semibold">Captured topic
        <select className="fx-input mt-1 font-mono" value={topic} onChange={event => { setTopic(event.target.value); setSelected(new Set()); setAdded('') }}>
          <option value="">Choose an actual source topic</option>
          {job.samples.map(item => <option key={item.topic} value={item.topic}>{item.topic}{item.error ? ` · ${item.error}` : ''}</option>)}
        </select>
      </label>}
      {sample ? <div className="space-y-2">
        <p className="break-all text-xs text-[var(--fx-muted)]">Received: {sample.received_time} · Source timestamp: {sample.source_time || 'Not provided'}</p>
        {sample.error ? <p role="alert" className="text-xs text-[var(--fx-error)]">This payload could not be decoded: {sample.error}. It cannot generate JSON fields.</p> : <>
          <details><summary className="cursor-pointer text-xs">Actual captured payload</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(sample.payload, null, 2)}</pre></details>
          {discovery?.truncated ? <p role="alert" className="text-xs text-[var(--fx-warning)]">Field discovery reached its size or nesting limit. You can add further JSONPaths manually.</p> : null}
          <div className="max-h-72 overflow-auto rounded border border-[var(--fx-border)]">
            <table className="fx-table"><thead><tr><th>Select</th><th>JSONPath</th><th>Suggested type</th><th>Captured value</th></tr></thead><tbody>
              {discovery?.fields.map(field => <tr key={field.address}>
                <td><input type="checkbox" aria-label={`Select ${field.address}`} checked={selected.has(field.address)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(field.address); else next.delete(field.address); return next })} /></td>
                <td className="break-all font-mono">{field.address}</td><td>{field.dataType}</td><td className="max-w-64 break-all font-mono">{JSON.stringify(field.value)?.slice(0, 256)}</td>
              </tr>)}
            </tbody></table>
          </div>
          <Button size="sm" variant="secondary" disabled={!selected.size} onClick={() => {
            onAdd(topic, discovery!.fields.filter(field => selected.has(field.address)))
            setSelected(new Set())
            setAdded('Selected fields added to the mapping table. Existing mappings were preserved; review types before testing.')
          }}>Add selected fields</Button>
          {added ? <p role="status" className="text-xs">{added}</p> : null}
        </>}
      </div> : null}
    </> : null}
  </section>
}
