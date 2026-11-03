import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import {
  captureActive,
  captureRequestError,
  startTopicCapture,
  getTopicCapture,
  cancelTopicCapture,
  capturedResourceRows,
} from '../../features/assets/topicCapture'
import type { TopicCapture } from '../../features/assets/topicCapture'
import type { ResourceImportRow } from '../../features/assets/importSession'
import type { ResourceTypeDefinition } from '../../features/assets/model'
import { resourcePathLabel } from '../../features/assets/model'
import type { ResourceNode } from '../../types'
import { translateApiError } from '../../utils/apiErrors'
import { Button } from '../common/Button'

interface Props {
  resources: ResourceNode[]
  resourceTypes: ResourceTypeDefinition[]
  disabled: boolean
  onDraft: (rows: ResourceImportRow[], label: string) => void
  onBusy: (busy: boolean) => void
}
interface Connection {
  id: string
  name: string
  site_id: string
  protocol: string
  status: string
  config?: { topics?: string[] }
  config_json?: { topics?: string[] }
}

export const MqttImportSource: React.FC<Props> = ({
  resources,
  resourceTypes,
  disabled,
  onDraft,
  onBusy,
}) => {
  const [connections, setConnections] = useState<Connection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [filter, setFilter] = useState('')
  const [duration, setDuration] = useState('5')
  const [job, setJob] = useState<TopicCapture | null>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [connectionLoading, setConnectionLoading] = useState(false)
  const [configuredFilters, setConfiguredFilters] = useState<string[]>([])
  const [skip, setSkip] = useState('0')
  const [levels, setLevels] = useState(['enterprise', 'site', 'plant', 'zone', 'line', 'machine'])
  const [suffixes, setSuffixes] = useState(
    'state\nprocess\nenergy\ncondition\nproduction/order\nproduction/order_progress',
  )
  const [parentId, setParentId] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const generation = useRef(0)
  const currentJob = useRef<TopicCapture | null>(null)
  const active = starting || captureActive(job)
  const busy = disabled || active || cancelling
  const updateJob = (next: TopicCapture) => {
    currentJob.current = next
    setJob(next)
  }
  useEffect(() => {
    onBusy(active || cancelling)
    return () => onBusy(false)
  }, [active, cancelling, onBusy])
  useEffect(() => {
    const controller = new AbortController()
    api<{ items: Connection[] }>('/api/v1/connections', { signal: controller.signal, timeoutMs: 10_000 })
      .then((result) => {
        if (!controller.signal.aborted) {
          setConnections(
            result.items.filter(
              (c) => ['mqtt', 'mqtt_client'].includes(c.protocol) && c.status !== 'ARCHIVED',
            ),
          )
          setLoaded(true)
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(translateApiError(err))
          setLoaded(true)
        }
      })
    return () => {
      generation.current++
      controller.abort()
      if (captureActive(currentJob.current)) void cancelTopicCapture(currentJob.current!.id).catch(() => {})
    }
  }, [])
  useEffect(() => {
    setConfiguredFilters([])
    if (!connectionId) return
    const controller = new AbortController()
    setConnectionLoading(true)
    api<Connection>(`/api/v1/connections/${connectionId}`, { signal: controller.signal, timeoutMs: 10_000 })
      .then((connection) => {
        if (controller.signal.aborted) return
        const topics = connection.config?.topics || connection.config_json?.topics || []
        setConfiguredFilters(topics)
        setFilter(topics[0] || '')
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(translateApiError(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setConnectionLoading(false)
      })
    return () => controller.abort()
  }, [connectionId])
  useEffect(() => {
    if (!captureActive(job)) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      getTopicCapture(job!.id, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return
          updateJob(next)
          setPollError('')
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          setPollError(
            `Capture status could not refresh: ${translateApiError(err)}. Retrying; the Edge capture has a server deadline.`,
          )
          setJob((previous) => (previous ? { ...previous } : previous))
        })
    }, 1000)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [job])
  const clearProposal = () => onDraft([], '')
  const start = async () => {
    const revision = ++generation.current
    setStarting(true)
    setError('')
    setPollError('')
    setJob(null)
    currentJob.current = null
    clearProposal()
    try {
      const next = await startTopicCapture(connectionId, filter, Number(duration))
      if (revision !== generation.current) {
        void cancelTopicCapture(next.id).catch(() => {})
        return
      }
      updateJob(next)
      setExcluded(new Set())
      setPage(0)
    } catch (err) {
      if (revision === generation.current)
        setError(captureRequestError(err))
    } finally {
      if (revision === generation.current) setStarting(false)
    }
  }
  const cancel = async () => {
    if (!job) return
    setCancelling(true)
    setError('')
    try {
      updateJob(await cancelTopicCapture(job.id))
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setCancelling(false)
    }
  }
  const generate = () => {
    setError('')
    try {
      const topics = (job?.samples || []).map((s) => s.topic).filter((topic) => !excluded.has(topic))
      if (!topics.length) throw new Error('Select at least one captured topic.')
      const proposal = capturedResourceRows(
        topics,
        {
          skipSegments: Number(skip),
          levelTypes: levels,
          dataSuffixes: suffixes
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
        parentId,
        resources,
      )
      if (proposal.errors.some((issue) => issue.code !== 'CODE_COLLISION'))
        throw new Error(
          proposal.errors
            .slice(0, 10)
            .map((issue) => `${issue.topic}: ${issue.message}`)
            .join('\n'),
        )
      onDraft(proposal.rows, `MQTT capture · ${topics.length} actual topics`)
      if (proposal.errors.length)
        setError(
          'Some topic prefixes produce equal resource codes. Edit the proposed paths before preview; source topic prefixes stay unchanged.',
        )
    } catch (err) {
      setError(translateApiError(err))
      clearProposal()
    }
  }
  const samples = job?.samples || []
  return (
    <section aria-label="MQTT topic capture" className="space-y-4">
      <p className="text-xs text-[var(--fx-muted)]">
        Read actual topics through the connection's Edge using a separate subscriber. Capture never publishes
        MQTT or changes the running collector.
      </p>
      <fieldset disabled={busy} className="grid gap-3 md:grid-cols-2">
        <label className="block text-xs font-semibold">
          MQTT connection
          <select
            className="fx-input mt-1"
            value={connectionId}
            onChange={(event) => {
              const id = event.target.value
              setConnectionId(id)
              const c = connections.find((c) => c.id === id)
              setFilter((c?.config?.topics || c?.config_json?.topics || [])[0] || '')
              setJob(null)
              clearProposal()
            }}
          >
            <option value="">Choose a connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ·{' '}
                {(() => {
                  const site = resources.find(
                    (r) => r.type.toLowerCase() === 'site' && r.attributes?.siteId === c.site_id,
                  )
                  return site ? resourcePathLabel(resources, site.id) : c.site_id
                })()}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold">
          Topic filter
          <input
            className="fx-input mt-1"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              setJob(null)
              clearProposal()
            }}
            placeholder="Within the connection's configured filters"
          />
        </label>
        <label className="block text-xs font-semibold">
          Capture duration (seconds)
          <input
            className="fx-input mt-1"
            type="number"
            min={2}
            max={30}
            step={1}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </label>
      </fieldset>
      {configuredFilters.length ? (
        <p className="break-all text-xs text-[var(--fx-muted)]">
          Configured filters: {configuredFilters.join(', ')}
        </p>
      ) : null}
      {loaded && !connections.length ? (
        <p role="status" className="text-xs">
          Create an MQTT connection and enroll its Edge before importing captured topics.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={
            busy ||
            connectionLoading ||
            !configuredFilters.length ||
            !connectionId ||
            !filter ||
            !Number.isInteger(Number(duration)) ||
            Number(duration) < 2 ||
            Number(duration) > 30
          }
          onClick={() => void start()}
        >
          {starting ? 'Requesting capture…' : 'Capture topics'}
        </Button>
        {captureActive(job) ? (
          <Button variant="secondary" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? 'Cancelling…' : 'Cancel capture'}
          </Button>
        ) : null}
        {job ? (
          <p role="status" className="text-xs">
            {job.status}
            {job.status === 'PENDING'
              ? ' · waiting for Edge'
              : job.status === 'RUNNING'
                ? ' · collecting actual topics'
                : job.status === 'COMPLETED'
                  ? ` · ${samples.length} topics · ${job.received} messages`
                  : job.error_code
                    ? ` · ${job.error_code}`
                    : ''}
          </p>
        ) : null}
      </div>
      {pollError ? (
        <p role="alert" className="text-xs text-[var(--fx-warning)]">
          {pollError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-xs text-[var(--fx-error)]">
          {error}
        </p>
      ) : null}
      {job?.status === 'COMPLETED' ? (
        <>
          {job.truncated ? (
            <p role="alert" className="text-xs text-[var(--fx-warning)]">
              Capture reached a limit or omitted a sample. Dropped: {job.dropped}. Narrow the filter or repeat
              capture before relying on completeness.
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-xs font-semibold">
              Captured topics and latest samples ({samples.length})
            </summary>
            <div className="mt-2 max-h-72 space-y-2 overflow-auto">
              {samples.slice(page * 50, page * 50 + 50).map((sample) => (
                <div key={sample.topic} className="rounded border border-[var(--fx-border)] p-2 text-xs">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={!excluded.has(sample.topic)}
                      onChange={(event) => {
                        setExcluded((previous) => {
                          const next = new Set(previous)
                          if (event.target.checked) next.delete(sample.topic)
                          else next.add(sample.topic)
                          return next
                        })
                        clearProposal()
                      }}
                    />
                    <span className="break-all">{sample.topic}</span>
                  </label>
                  <details className="mt-1">
                    <summary className="cursor-pointer">
                      {sample.error || 'Latest sample'} · {sample.received_time}
                    </summary>
                    <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(sample.payload, null, 2)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              <Button size="sm" variant="ghost" disabled={!page} onClick={() => setPage(page - 1)}>
                Previous topics
              </Button>
              Page {page + 1} of {Math.max(1, Math.ceil(samples.length / 50))}
              <Button
                size="sm"
                variant="ghost"
                disabled={(page + 1) * 50 >= samples.length}
                onClick={() => setPage(page + 1)}
              >
                Next topics
              </Button>
            </div>
          </details>
          <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-[var(--fx-border)] p-3">
            <legend className="px-1 text-xs font-semibold">Topic hierarchy profile</legend>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-xs font-semibold">
                Skip namespace segments
                <input
                  className="fx-input mt-1"
                  type="number"
                  min={0}
                  max={32}
                  value={skip}
                  onChange={(event) => {
                    setSkip(event.target.value)
                    clearProposal()
                  }}
                />
              </label>
              <label className="block text-xs font-semibold">
                Place generated roots under
                <select
                  className="fx-input mt-1"
                  value={parentId}
                  onChange={(event) => {
                    setParentId(event.target.value)
                    clearProposal()
                  }}
                >
                  <option value="">Root level</option>
                  {resources
                    .filter((r) => r.lifecycle !== 'ARCHIVED')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {resourcePathLabel(resources, r.id)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {levels.map((level, index) => (
                <label key={index} className="block text-xs font-semibold">
                  Level {index + 1} type
                  <select
                    className="fx-input mt-1"
                    value={level}
                    onChange={(event) => {
                      setLevels((previous) => previous.map((v, i) => (i === index ? event.target.value : v)))
                      clearProposal()
                    }}
                  >
                    {resourceTypes.map((type) => (
                      <option key={type.key} value={type.key}>
                        {type.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={levels.length >= 32}
                onClick={() => {
                  setLevels([...levels, 'machine'])
                  clearProposal()
                }}
              >
                Add level
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={levels.length <= 1}
                onClick={() => {
                  setLevels(levels.slice(0, -1))
                  clearProposal()
                }}
              >
                Remove last level
              </Button>
            </div>
            <label className="block text-xs font-semibold">
              Data suffixes (one per line)
              <textarea
                className="fx-input mt-1"
                rows={6}
                value={suffixes}
                onChange={(event) => {
                  setSuffixes(event.target.value)
                  clearProposal()
                }}
              />
            </label>
            <p className="text-xs text-[var(--fx-muted)]">
              Longest suffix wins: production/order and production/order_progress stay at Line level. Raw
              topic prefixes remain unchanged when you edit resource names or paths.
            </p>
            <Button variant="secondary" onClick={generate}>
              Generate hierarchy proposal
            </Button>
          </fieldset>
        </>
      ) : null}
    </section>
  )
}
