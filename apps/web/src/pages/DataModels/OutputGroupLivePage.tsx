import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api/client'
import { Button } from '../../components/common/Button'
import { Card } from '../../components/common/Card'
import { useApp } from '../../store/AppContext'
import { resourcePathLabel } from '../../features/assets/model'
import { translateApiError } from '../../utils/apiErrors'

export function useOutputGroupPreview(id: string, frozen = false) {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')
  const [received, setReceived] = useState('')
  useEffect(() => {
    setPayload(null)
    setReceived('')
    setError('')
  }, [id])
  useEffect(() => {
    if (!id || id.startsWith('grp-draft-') || frozen) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await api<Record<string, unknown>>(`/api/v1/output-groups/${id}/preview`, {
          signal: controller.signal,
          timeoutMs: 10_000,
        })
        if (!controller.signal.aborted) {
          setPayload(result)
          setReceived(new Date().toISOString())
          setError('')
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(translateApiError(err))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [id, frozen])
  return { payload, error, received }
}

interface Group {
  id: string
  resource_id: string
  display_name: string
  key: string
  version: number
  status: string
}
export const OutputGroupLivePage: React.FC = () => {
  const [query, setQuery] = useSearchParams()
  const { modelResources } = useApp()
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [error, setError] = useState('')
  const [frozen, setFrozen] = useState(false)
  const [copied, setCopied] = useState(false)
  const id = query.get('groupId') || ''
  useEffect(() => {
    const controller = new AbortController()
    api<{ items: Group[] }>('/api/v1/output-groups', { signal: controller.signal, timeoutMs: 10_000 })
      .then((result) => {
        if (!controller.signal.aborted) setGroups(result.items)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(translateApiError(err))
      })
    return () => controller.abort()
  }, [])
  const selected = groups?.find((group) => group.id === id) || (!id ? groups?.[0] : undefined)
  const preview = useOutputGroupPreview(selected?.id || '', frozen)
  return (
    <div className="space-y-4">
      <div>
        <h1 className="fx-page-title">Live Preview</h1>
        <p className="fx-page-subtitle">
          Inspect JSON output groups using collected signal values and quality.
        </p>
      </div>
      {error || preview.error ? (
        <p role="alert" className="text-sm text-[var(--fx-error)]">
          {error || preview.error}
        </p>
      ) : null}
      {groups === null ? (
        <p role="status">Loading output groups…</p>
      ) : groups.length === 0 ? (
        <Card className="p-6">
          <p>No output groups configured.</p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-xs font-semibold">
              Output group
              <select
                className="fx-input mt-1"
                value={selected?.id || ''}
                onChange={(event) => {
                  const next = new URLSearchParams(query)
                  next.set('groupId', event.target.value)
                  setQuery(next)
                }}
              >
                <option value="">Select an output group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.display_name} · {resourcePathLabel(modelResources, group.resource_id)}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="secondary" onClick={() => setFrozen(!frozen)}>
              {frozen ? 'Resume Preview' : 'Freeze Preview'}
            </Button>
            <Button
              variant="secondary"
              disabled={!preview.payload}
              onClick={() =>
                void navigator.clipboard
                  .writeText(JSON.stringify(preview.payload, null, 2))
                  .then(() => setCopied(true))
                  .catch(() => setError('Could not copy the preview.'))
              }
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </Button>
          </div>
          {!selected ? (
            <p role="status">Output group not found.</p>
          ) : (
            <Card className="space-y-3 p-4">
              <p className="text-xs text-[var(--fx-muted)]">
                {preview.received ? `Last refreshed: ${preview.received}` : 'Waiting for data'}
              </p>
              <pre className="max-h-[65dvh] overflow-auto whitespace-pre-wrap break-all text-xs">
                {preview.payload ? JSON.stringify(preview.payload, null, 2) : 'No Data'}
              </pre>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
