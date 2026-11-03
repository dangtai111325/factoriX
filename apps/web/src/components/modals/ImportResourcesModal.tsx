import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Download, Trash2 } from 'lucide-react'
import { ApiError } from '../../api/client'
import { importResources } from '../../features/assets/api'
import { parseResourceCsv } from '../../features/assets/importing'
import { emptyImportState, editImportIdentity, importSession } from '../../features/assets/importSession'
import type { ImportIssue, ResourceImportResult } from '../../features/assets/importSession'
import { resourcePathLabel } from '../../features/assets/model'
import type { ResourceTypeDefinition } from '../../features/assets/model'
import type { ResourceNode } from '../../types'
import { translateApiError } from '../../utils/apiErrors'
import { Button } from '../common/Button'
import { Dialog } from '../common/Dialog'
import { MqttImportSource } from './MqttImportSource'

interface ImportResourcesModalProps {
  isOpen: boolean
  onClose: () => void
  resources: ResourceNode[]
  resourceTypes: ResourceTypeDefinition[]
  onImported: (result: ResourceImportResult) => Promise<void>
}

const csvTemplate =
  'path,name,type_key,description,properties,tags,timezone\r\nImportExample,Example enterprise,enterprise,,,,\r\nImportExample/Site,Example Site,site,,,,Asia/Ho_Chi_Minh\r\nImportExample/Site/Area,Example area,area,,,,\r\nImportExample/Site/Area/M01,Example machine,machine,,,,\r\n'
const text = (value: unknown) => (value == null ? '' : String(value))

function rowIssues(error: unknown): ImportIssue[] {
  const issues = error instanceof ApiError ? error.details.row_errors : null
  if (!Array.isArray(issues)) return []
  return issues
    .filter((issue) => issue && typeof issue === 'object')
    .map((issue) => ({
      row: Number(issue.row) || 0,
      code: text(issue.code),
      message: text(issue.message),
      field: text(issue.field),
    }))
}

export const ImportResourcesModal: React.FC<ImportResourcesModalProps> = ({
  isOpen,
  onClose,
  resources,
  resourceTypes,
  onImported,
}) => {
  const [state, dispatch] = useReducer(importSession, undefined, emptyImportState)
  const [filename, setFilename] = useState('')
  const [reading, setReading] = useState(false)
  const [page, setPage] = useState(0)
  const [refreshError, setRefreshError] = useState('')
  const [source, setSource] = useState<'csv' | 'mqtt'>('csv')
  const [captureBusy, setCaptureBusy] = useState(false)
  const captureDraft = useCallback((rows: Record<string, unknown>[], label: string) => {
    dispatch({ type: 'draft', rows })
    setFilename(label)
    setPage(0)
  }, [])
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const errorPanel = useRef<HTMLDivElement>(null)
  const previewPanel = useRef<HTMLElement>(null)
  useEffect(() => {
    generation.current++
    if (!isOpen) return
    dispatch({ type: 'reset' })
    setFilename('')
    setReading(false)
    setPage(0)
    setRefreshError('')
    setSource('csv')
    setCaptureBusy(false)
    return () => {
      generation.current++
      controller.current?.abort()
    }
  }, [isOpen])
  useEffect(() => {
    if (state.error) errorPanel.current?.scrollIntoView({ block: 'nearest' })
  }, [state.error])
  useEffect(() => {
    if (state.preview) previewPanel.current?.scrollIntoView({ block: 'nearest' })
  }, [state.preview])
  useEffect(() => {
    if (state.result) body.current?.scrollTo({ top: 0 })
  }, [state.result])

  const parents = useMemo(
    () =>
      resources
        .filter((resource) => resource.lifecycle !== 'ARCHIVED')
        .map((resource) => ({ id: resource.id, label: resourcePathLabel(resources, resource.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [resources],
  )
  const types = useMemo(
    () => [...resourceTypes].sort((a, b) => a.name.localeCompare(b.name)),
    [resourceTypes],
  )
  const preview = state.preview
  const busy = reading || Boolean(state.busy) || captureBusy
  const items = useMemo(() => new Map((preview?.items || []).map((item) => [item.index, item])), [preview])
  const pages = Math.max(1, Math.ceil(state.rows.length / 50))
  const currentPage = Math.min(page, pages - 1)
  const visibleRows = state.rows.slice(currentPage * 50, currentPage * 50 + 50)
  const invalidRows = new Set(state.issues.map((issue) => issue.row))
  const proposedCreates = preview?.items.filter((item) => item.action === 'CREATE').length || 0
  const proposedSites =
    preview?.items.filter((item) => item.action === 'CREATE' && item.type_key === 'site').length || 0

  const loadCsv = async (file: File | undefined) => {
    if (!file) return
    const request = ++generation.current
    dispatch({ type: 'draft', rows: state.rows })
    setReading(true)
    try {
      if (file.size > 2_000_000) throw new Error('CSV files are limited to 2 MB.')
      let contents: string
      try {
        contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      } catch {
        throw new Error('The file could not be read as UTF-8. Check the file and its encoding.')
      }
      const parsed = parseResourceCsv(contents)
      if (request !== generation.current) return
      dispatch({
        type: 'draft',
        rows: parsed.rows.map((row, index) => ({ ...row, source_row: parsed.rowNumbers[index] })),
      })
      setFilename(file.name)
      setPage(0)
      body.current?.scrollTo({ top: 0 })
    } catch (error) {
      if (request === generation.current)
        dispatch({
          type: 'failed',
          revision: state.revision + 1,
          message: `${file.name}: ${translateApiError(error)}${state.rows.length ? ' The previous draft was kept.' : ''}`,
          code: 'FILE',
        })
    } finally {
      if (request === generation.current) setReading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }
  const update = (index: number, key: string, value: string) => {
    const rows =
      key === 'identity'
        ? editImportIdentity(state.rows, index, value)
        : state.rows.map((row, at) => (at === index ? { ...row, [key]: value } : row))
    dispatch({ type: 'draft', rows })
  }
  const run = async (dryRun: boolean) => {
    if (!state.rows.length || (!dryRun && !preview)) return
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const revision = state.revision
    dispatch({ type: 'request', operation: dryRun ? 'preview' : 'commit' })
    try {
      const result = await importResources(state.rows, {
        dryRun,
        parentId: state.parentId,
        hierarchyMode: state.hierarchyMode,
        planHash: dryRun ? undefined : preview?.plan_hash,
        signal: abort.signal,
      })
      if (abort.signal.aborted) return
      dispatch({ type: dryRun ? 'previewed' : 'committed', revision, result })
      if (!dryRun) {
        try {
          await onImported(result)
        } catch {
          setRefreshError(
            'Import succeeded, but the model could not refresh. Retry refresh or reload the page.',
          )
        }
      }
    } catch (error) {
      if (!abort.signal.aborted)
        dispatch({
          type: 'failed',
          revision,
          message:
            !dryRun && error instanceof ApiError && error.code === 'TIMEOUT'
              ? 'The import request timed out. Keep this draft and retry to check the result without creating duplicates.'
              : translateApiError(error),
          code: error instanceof ApiError ? error.code : 'NETWORK',
          issues: rowIssues(error),
        })
    }
  }
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([csvTemplate], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'factorix-resource-import.csv'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const footer = state.result ? (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        variant="secondary"
        onClick={() => {
          dispatch({ type: 'reset' })
          setFilename('')
          setPage(0)
          setRefreshError('')
          body.current?.scrollTo({ top: 0 })
        }}
      >
        Import another file
      </Button>
      <Button onClick={onClose}>Done</Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="secondary" disabled={reading || Boolean(state.busy)} onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="secondary"
        disabled={busy || !state.rows.length}
        loading={state.busy === 'preview'}
        onClick={() => void run(true)}
      >
        Preview import
      </Button>
      <Button disabled={busy || !preview} loading={state.busy === 'commit'} onClick={() => void run(false)}>
        Import {preview?.accepted || state.rows.length} resource
        {(preview?.accepted || state.rows.length) === 1 ? '' : 's'}
      </Button>
    </div>
  )

  return (
    <Dialog
      isOpen={isOpen}
      title="Import resources"
      size="wide"
      busy={reading || Boolean(state.busy)}
      onClose={onClose}
      footer={footer}
    >
      <div ref={body} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 text-sm">
        {state.result ? (
          <section aria-label="Import result" className="space-y-4">
            <h3 className="text-base font-semibold">Import completed</h3>
            <p role="status">
              Created {state.result.created} · Reused {state.result.reused}. Existing resource data was
              preserved.
            </p>
            <p className="text-xs text-[var(--fx-muted)]">
              No source mapping, subscription or appliance enrollment was changed.
            </p>
            {refreshError ? (
              <div role="alert" className="space-y-2 text-[var(--fx-error)]">
                <p>{refreshError}</p>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void onImported(state.result!)
                      .then(() => setRefreshError(''))
                      .catch(() => setRefreshError('The model still could not refresh. Reload the page.'))
                  }
                >
                  Retry refresh
                </Button>
              </div>
            ) : null}
            <div className="max-h-64 overflow-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Resource path</th>
                    <th>Confirmed ID</th>
                  </tr>
                </thead>
                <tbody>
                  {state.result.items.map((item) => (
                    <tr key={item.index}>
                      <td>{item.action === 'CREATE' ? 'Created' : 'Reused'}</td>
                      <td className="break-all">{item.path}</td>
                      <td className="break-all font-mono text-xs">{item.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <>
            <section aria-label="Import source" className="space-y-3">
              <div className="flex flex-wrap gap-2" aria-label="Import source type">
                <Button
                  variant={source === 'csv' ? 'primary' : 'secondary'}
                  aria-pressed={source === 'csv'}
                  disabled={busy}
                  onClick={() => {
                    setSource('csv')
                    captureDraft([], '')
                  }}
                >
                  CSV file
                </Button>
                <Button
                  variant={source === 'mqtt' ? 'primary' : 'secondary'}
                  aria-pressed={source === 'mqtt'}
                  disabled={busy}
                  onClick={() => {
                    setSource('mqtt')
                    captureDraft([], '')
                  }}
                >
                  MQTT topics
                </Button>
              </div>
              {source === 'csv' ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">1. Choose a CSV file</h3>
                      <p className="mt-1 text-xs text-[var(--fx-muted)]">
                        UTF-8 CSV/TSV · up to 2 MB and 2,000 rows. Preview validates every row before anything
                        is created.
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Download className="h-4 w-4" />}
                      disabled={busy}
                      onClick={downloadTemplate}
                    >
                      Download template
                    </Button>
                  </div>
                  <label className="block text-xs font-semibold" htmlFor="resource-import-file">
                    Resource CSV file
                  </label>
                  <input
                    ref={fileInput}
                    id="resource-import-file"
                    type="file"
                    accept=".csv,.tsv,text/csv,text/tab-separated-values"
                    disabled={busy}
                    className="fx-input block w-full text-xs"
                    onChange={(event) => void loadCsv(event.target.files?.[0])}
                  />
                  {filename ? (
                    <p className="text-xs">
                      {filename} · {state.rows.length} proposed resource{state.rows.length === 1 ? '' : 's'}
                    </p>
                  ) : null}
                  <details className="text-xs text-[var(--fx-muted)]">
                    <summary className="cursor-pointer">CSV columns and identity rules</summary>
                    <p className="mt-2 leading-relaxed">
                      Required: name, type_key, and path or code. Optional: parent_path, parent_id,
                      parent_code, description, properties (JSON object), tags (JSON array or
                      semicolon-separated), timezone and site_id. Full paths are absolute code paths. Parent
                      codes must be unique. Existing identities are reused with all existing data retained;
                      archived identities must be restored separately.
                    </p>
                  </details>
                </>
              ) : (
                <MqttImportSource
                  resources={resources}
                  resourceTypes={resourceTypes}
                  disabled={reading || Boolean(state.busy)}
                  onDraft={captureDraft}
                  onBusy={setCaptureBusy}
                />
              )}
            </section>
            <fieldset
              disabled={busy}
              className="grid gap-3 border-t border-[var(--fx-border)] pt-4 md:grid-cols-[1fr_auto]"
            >
              <div>
                <label className="mb-1 block text-xs font-semibold" htmlFor="resource-import-parent">
                  Default parent for code-only rows
                </label>
                <select
                  id="resource-import-parent"
                  className="fx-input"
                  value={state.parentId}
                  onChange={(event) =>
                    dispatch({
                      type: 'options',
                      parentId: event.target.value,
                      hierarchyMode: state.hierarchyMode,
                    })
                  }
                >
                  <option value="">Root level</option>
                  {parents.map((parent) => (
                    <option key={parent.id} value={parent.id}>
                      {parent.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={state.hierarchyMode === 'strict'}
                  onChange={(event) =>
                    dispatch({
                      type: 'options',
                      parentId: state.parentId,
                      hierarchyMode: event.target.checked ? 'strict' : 'guided',
                    })
                  }
                />
                Strict hierarchy
              </label>
            </fieldset>
            {state.error ? (
              <div
                ref={errorPanel}
                role="alert"
                className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-[var(--fx-error)]"
              >
                <p>{state.error}</p>
                {state.issues.length ? (
                  <ul className="max-h-36 list-disc space-y-1 overflow-auto pl-5">
                    {state.issues.map((issue, index) => (
                      <li key={index}>
                        Row {issue.row}
                        {issue.field ? ` · ${issue.field}` : ''}: {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {state.rows.length ? (
              <section aria-label="Import proposal" className="space-y-3">
                <h3 className="font-semibold">2. Review the proposal</h3>
                <p className="text-xs text-[var(--fx-muted)]">
                  Edit names, paths or types before preview. Changing an ancestor path updates its proposed
                  descendants. Any edit invalidates the previous preview.
                </p>
                <div className="overflow-x-auto rounded-lg border border-[var(--fx-border)]">
                  <table className="fx-table min-w-[54rem]">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Path / code</th>
                        <th>Display name</th>
                        <th>Type</th>
                        <th>Action</th>
                        <th>Details</th>
                        <th>
                          <span className="sr-only">Remove</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row, offset) => {
                        const index = currentPage * 50 + offset
                        const number = Number(row.source_row) || index + 1
                        const item = items.get(index)
                        const typeKey = text(row.type_key)
                        const metadata = Object.fromEntries(
                          Object.entries(row).filter(
                            ([key]) => !['name', 'path', 'code', 'type_key', 'source_row'].includes(key),
                          ),
                        )
                        return (
                          <tr key={index} className={invalidRows.has(number) ? 'bg-red-50' : ''}>
                            <td>{number}</td>
                            <td className="min-w-56">
                              <input
                                className="fx-input w-full text-xs"
                                aria-label={`Row ${number} path or code`}
                                disabled={busy}
                                value={text(row.path || row.code)}
                                onChange={(event) => update(index, 'identity', event.target.value)}
                              />
                            </td>
                            <td className="min-w-40">
                              <input
                                className="fx-input w-full text-xs"
                                aria-label={`Row ${number} name`}
                                disabled={busy}
                                value={text(row.name)}
                                onChange={(event) => update(index, 'name', event.target.value)}
                              />
                            </td>
                            <td className="min-w-36">
                              <select
                                className="fx-input w-full text-xs"
                                aria-label={`Row ${number} type`}
                                disabled={busy}
                                value={typeKey}
                                onChange={(event) => update(index, 'type_key', event.target.value)}
                              >
                                <option value="">Choose type</option>
                                {typeKey && !types.some((type) => type.key === typeKey) ? (
                                  <option value={typeKey}>Unknown: {typeKey}</option>
                                ) : null}
                                {types.map((type) => (
                                  <option key={type.key} value={type.key}>
                                    {type.name}
                                    {type.is_system ? '' : ' · Custom'}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <span className="text-xs font-semibold">
                                {item ? (item.action === 'CREATE' ? 'Create' : 'Reuse') : 'Not validated'}
                              </span>
                              {item?.action === 'REUSE' ? (
                                <p className="mt-1 text-xs text-[var(--fx-muted)]">Keep: {item.name}</p>
                              ) : null}
                            </td>
                            <td>
                              <details className="text-xs">
                                <summary className="cursor-pointer">
                                  Details
                                  {item?.differences && Object.keys(item.differences).length
                                    ? ' · differences kept'
                                    : ''}
                                </summary>
                                <pre className="mt-2 max-h-40 max-w-64 overflow-auto whitespace-pre-wrap break-all">
                                  {JSON.stringify(
                                    item?.differences && Object.keys(item.differences).length
                                      ? { incomingDifferences: item.differences, metadata }
                                      : metadata,
                                    null,
                                    2,
                                  )}
                                </pre>
                              </details>
                            </td>
                            <td>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                aria-label={`Remove row ${number}`}
                                icon={<Trash2 className="h-4 w-4" />}
                                onClick={() =>
                                  dispatch({
                                    type: 'draft',
                                    rows: state.rows.filter((_, at) => at !== index),
                                  })
                                }
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>
                    Page {currentPage + 1} of {pages} · {state.rows.length} row
                    {state.rows.length === 1 ? '' : 's'}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || currentPage >= pages - 1}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </section>
            ) : null}
            {preview ? (
              <section
                ref={previewPanel}
                aria-label="Validated import preview"
                className="space-y-2 rounded-lg bg-[var(--fx-bg-soft)] p-3 text-xs"
              >
                <h3 className="font-semibold">
                  Preview ready · Create {proposedCreates} · Reuse {preview.reused} · New Site
                  {proposedSites === 1 ? '' : 's'} {proposedSites}
                </h3>
                <p>
                  Existing data stays unchanged. New Sites are added to the factory model. Set up their
                  collectors separately.
                </p>
                {preview.warnings.length ? (
                  <details>
                    <summary className="cursor-pointer">
                      {preview.warnings.length} warning{preview.warnings.length === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-2 max-h-36 list-disc space-y-1 overflow-auto pl-5">
                      {preview.warnings.map((warning, index) => (
                        <li key={index}>
                          Row {warning.row}: {warning.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
