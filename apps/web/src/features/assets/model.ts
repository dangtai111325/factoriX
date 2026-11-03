import type { ResourceNode } from '../../types'
import { ancestorPath } from '../../utils/resourceHierarchy'

export interface ResourceTypeDefinition {
  key: string
  name: string
  category: string
  is_system: boolean
  parent_type_keys: string[]
  child_type_keys: string[]
}

export interface ResourceEditorSnapshot {
  id: string
  version: number
  name: string
  code: string
  type: string
  parentId?: string
  description: string
  properties: Record<string, unknown>
}

export interface ResourceFormValues {
  name: string
  code: string
  type: string
  parentId?: string
  description: string
  properties: Record<string, unknown>
  hierarchyMode: 'guided' | 'strict'
  timezone: string
  useAppliance?: boolean
}

export interface LocalApplianceStatus {
  enabled: boolean
  available: boolean
  state:
    | 'DISABLED'
    | 'AVAILABLE'
    | 'BOUND'
    | 'QUEUED'
    | 'DELIVERY_PENDING'
    | 'EXPIRED'
    | 'CREDENTIAL_MISSING'
    | 'CONFLICT'
  edge_id: string | null
  site_id: string | null
}

export interface ResourceTypeInput {
  key: string
  name: string
  category: string
  parent_type_keys: string[]
  child_type_keys: string[]
}

export type PropertyKind = 'string' | 'number' | 'boolean' | 'null' | 'json'
export interface PropertyRow {
  key: string
  value: string
  kind: PropertyKind
}

export function propertyRows(properties: Record<string, unknown>): PropertyRow[] {
  return Object.entries(properties).map(([key, value]) => ({
    key,
    kind: value === null ? 'null' : typeof value === 'object' ? 'json' : (typeof value as PropertyKind),
    value: typeof value === 'object' ? JSON.stringify(value) : String(value),
  }))
}

export function propertyValues(rows: PropertyRow[]): Record<string, unknown> {
  const properties: Record<string, unknown> = Object.create(null)
  for (const [index, row] of rows.entries()) {
    const key = row.key.trim()
    if (!key && !row.value) continue
    if (!key) throw new Error(`Property ${index + 1} needs a name.`)
    if (Object.prototype.hasOwnProperty.call(properties, key))
      throw new Error(`Property "${key}" is duplicated.`)
    if (row.kind === 'null') properties[key] = null
    else if (row.kind === 'string') properties[key] = row.value
    else if (row.kind === 'boolean') {
      if (row.value !== 'true' && row.value !== 'false') throw new Error(`Select true or false for "${key}".`)
      properties[key] = row.value === 'true'
    } else if (row.kind === 'number') {
      const value = Number(row.value)
      if (!row.value.trim() || !Number.isFinite(value)) throw new Error(`Enter a finite number for "${key}".`)
      properties[key] = value
    } else {
      try {
        properties[key] = JSON.parse(row.value)
      } catch {
        throw new Error(`Enter valid JSON for "${key}".`)
      }
    }
  }
  return properties
}

export function resourcePathLabel(resources: ResourceNode[], id: string): string {
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  return ancestorPath(resources, id)
    .map((key) => {
      const resource = byId.get(key)!
      return `${resource.name} [${resource.code}]`
    })
    .join(' / ')
}

export function recommendedType(type: ResourceTypeDefinition, parentType?: string): boolean {
  return parentType ? (type.parent_type_keys || []).includes(parentType) : type.key === 'enterprise'
}
