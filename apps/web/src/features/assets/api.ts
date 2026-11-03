import { api } from '../../api/client'
import type { ResourceImportResult, ResourceImportRow } from './importSession'
import type { ResourceFormValues, LocalApplianceStatus } from './model'
import type { ResourceNode } from '../../types'

export interface CreatedAsset {
  id: string
  site_id: string | null
  edge?: { id: string; name: string }
  warnings?: Array<{ code: string; message: string }>
  enrollmentStatus?: string
  enrollmentError?: string
}

export async function createAsset(
  resource: ResourceFormValues,
  parent?: ResourceNode,
): Promise<CreatedAsset> {
  const typeKey = resource.type.toLowerCase()
  const created = await api<CreatedAsset>('/api/v1/resources', {
    method: 'POST',
    body: JSON.stringify({
      type_key: typeKey,
      code: resource.code,
      name: resource.name,
      site_id: typeKey === 'enterprise' || typeKey === 'site' ? null : parent?.attributes?.siteId || null,
      parent_id: resource.parentId || parent?.id || null,
      relation_code: 'CONTAINS',
      timezone: resource.timezone,
      hierarchy_mode: resource.hierarchyMode,
      create_edge: typeKey === 'site',
      description: resource.description || '',
      properties: resource.properties,
    }),
  })
  if (typeKey === 'site' && resource.useAppliance === true && created.edge) {
    try {
      const result = await api<{ status: string }>(`/api/v1/edges/${created.edge.id}/appliance`, {
        method: 'POST',
      })
      created.enrollmentStatus = result.status
    } catch (error) {
      // The Site already exists. Report enrollment separately; never invite a duplicate create.
      created.enrollmentError =
        error instanceof Error ? error.message : 'Local appliance enrollment could not be requested.'
    }
  }
  return created
}

export async function loadLocalAppliance(): Promise<LocalApplianceStatus> {
  return api('/api/v1/appliance')
}

interface ResourcePage {
  items: Array<Record<string, unknown>>
  next_cursor?: string | null
}

/** Drain the server cursor so a large factory is not silently clipped to one page. */
export async function loadModelResources(): Promise<ResourcePage> {
  const items: ResourcePage['items'] = []
  const cursors = new Set<string>()
  let cursor: string | null | undefined
  do {
    const page: ResourcePage = await api(
      `/api/v1/resources?view=all&include_archived=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )
    items.push(...page.items)
    cursor = page.next_cursor
    if (cursor) {
      if (cursors.has(cursor))
        throw new Error('The factory model could not be loaded completely. Refresh and try again.')
      cursors.add(cursor)
    }
  } while (cursor)
  return { items }
}

export async function importResources(
  rows: ResourceImportRow[],
  options: {
    dryRun: boolean
    parentId: string
    hierarchyMode: 'guided' | 'strict'
    planHash?: string
    signal?: AbortSignal
  },
): Promise<ResourceImportResult> {
  return api('/api/v1/resources/import', {
    method: 'POST',
    timeoutMs: options.dryRun ? 60_000 : 120_000,
    signal: options.signal,
    body: JSON.stringify({
      rows,
      dry_run: options.dryRun,
      default_parent_id: options.parentId || null,
      hierarchy_mode: options.hierarchyMode,
      ...(options.planHash ? { plan_hash: options.planHash } : {}),
    }),
  })
}
