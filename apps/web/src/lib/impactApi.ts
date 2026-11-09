/**
 * Impact lookups shown in confirmation dialogs (R3-DM-02, R3-HS-01, R3-CN-02).
 *
 * Each helper calls the dedicated Center endpoint. When the Center does not have it (older build:
 * 404 / 405), the impact is derived from the data model list and details instead, so the dialogs
 * never claim "no impact" just because the endpoint is missing. Any other error is thrown.
 */
import { api, ApiError } from '../api/client'

type Raw = Record<string, unknown>

export interface ImpactModel {
  id: string
  displayName: string
  /** RUNNING | PAUSED (ARCHIVED for deleted models) as returned by the Center. */
  status: string
}

function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function itemsOf(res: unknown): Raw[] {
  if (Array.isArray(res)) return res as Raw[]
  if (res && typeof res === 'object' && Array.isArray((res as Raw).items)) return (res as Raw).items as Raw[]
  return []
}

function toModel(row: Raw): ImpactModel {
  return {
    id: text(row.id),
    displayName: text(row.display_name || row.name || row.key) || 'Untitled model',
    status: text(row.state || row.status).toUpperCase(),
  }
}

/**
 * The Center build has no such route. Unknown API GET paths may also be answered by the SPA
 * fallback with index.html (200, not JSON → `api()` resolves to null), see `hasKey` below.
 */
function isMissingEndpoint(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405) && !error.code
}

class MissingEndpointError extends Error {}

/** Guard for a GET answer: a real answer is a JSON object with one of the expected keys. */
function hasKey(res: unknown, ...keys: string[]): res is Raw {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return false
  return keys.some((key) => key in (res as Raw))
}

/** Active (not archived) models, sorted by name. */
function activeSorted(models: ImpactModel[]): ImpactModel[] {
  return models
    .filter((model) => model.id && model.status !== 'ARCHIVED')
    .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true }))
}

/** Models referencing a resource, its descendants or their signals: `GET /data-models/usage?resource_id=`. */
async function resourceUsageRows(resourceId: string): Promise<Raw[]> {
  const res = await api<unknown>(`/api/v1/data-models/usage?resource_id=${encodeURIComponent(resourceId)}`)
  return hasKey(res, 'models') ? itemsOf(res.models) : []
}

/** Run `fn` over `items` with at most `limit` requests in flight. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Models that use a signal: `GET /api/v1/signals/{id}/usage` → `{models:[{id, display_name, status}]}`.
 * When the Center has no such route the list is empty and the dialogs show nothing (lead decision:
 * the Data Model pages are being rebuilt, so their details are not scanned from here).
 */
export async function fetchSignalUsage(signalId: string): Promise<ImpactModel[]> {
  try {
    const res = await api<unknown>(`/api/v1/signals/${encodeURIComponent(signalId)}/usage`)
    if (!hasKey(res, 'models')) return []
    return activeSorted(itemsOf(res.models).map(toModel))
  } catch (error) {
    if (isMissingEndpoint(error)) return []
    throw error
  }
}

/** Models that use any signal of a connection (pause impact). Derived from the per-signal usage. */
export async function fetchSignalsUsage(signalIds: string[]): Promise<ImpactModel[]> {
  const unique = Array.from(new Set(signalIds.filter(Boolean)))
  if (!unique.length) return []
  const lists = await mapLimited(unique, 6, (id) => fetchSignalUsage(id))
  const byId = new Map<string, ImpactModel>()
  lists.flat().forEach((model) => byId.set(model.id, model))
  return activeSorted(Array.from(byId.values()))
}

export interface ArchiveImpact {
  /** Active models defined on the resource. */
  models: ImpactModel[]
  /** Active signals bound to the resource, when the Center reports it. */
  signalCount: number | null
}

/**
 * What archiving a resource affects. Uses the Center's archive impact when available
 * (`GET /api/v1/resources/{id}/archive-impact`); otherwise the models whose resource is this one.
 */
export async function fetchArchiveImpact(resourceId: string): Promise<ArchiveImpact> {
  try {
    const res = await api<unknown>(`/api/v1/resources/${encodeURIComponent(resourceId)}/archive-impact`)
    if (!hasKey(res, 'models', 'affected_models')) throw new MissingEndpointError()
    const models = itemsOf(res.models ?? res.affected_models).map(toModel)
    const signals = res.signal_count ?? res.affected_signals
    return { models: activeSorted(models), signalCount: signals == null ? null : Number(signals) || 0 }
  } catch (error) {
    if (!(error instanceof MissingEndpointError) && !isMissingEndpoint(error)) throw error
  }
  return { models: activeSorted((await resourceUsageRows(resourceId)).map(toModel)), signalCount: null }
}

export interface ArchiveResult {
  /** Models the Center archived together with the resource. */
  archivedModelIds: string[]
}

/**
 * Archive a resource, optionally with its models (`{archive_models: true}`).
 * If the Center does not archive the models itself (older build), they are archived one by one.
 */
export async function archiveResourceWithModels(resourceId: string, archiveModels: boolean, models: ImpactModel[]): Promise<ArchiveResult> {
  const res = await api<Raw>(`/api/v1/resources/${encodeURIComponent(resourceId)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ archive_models: archiveModels }),
  })
  if (!archiveModels) return { archivedModelIds: [] }
  const reported = res?.archived_models ?? res?.archived_model_ids
  if (Array.isArray(reported)) {
    return { archivedModelIds: reported.map((row) => (row && typeof row === 'object' ? text((row as Raw).id) : text(row))) }
  }
  const archived: string[] = []
  for (const model of models) {
    await api(`/api/v1/data-models/${encodeURIComponent(model.id)}`, { method: 'DELETE' })
    archived.push(model.id)
  }
  return { archivedModelIds: archived }
}

export function modelStatusLabel(status: string): string {
  const s = status.toUpperCase()
  if (s === 'RUNNING') return 'Running'
  if (s === 'PAUSED') return 'Paused'
  if (s === 'ARCHIVED') return 'Archived'
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : 'Unknown'
}
