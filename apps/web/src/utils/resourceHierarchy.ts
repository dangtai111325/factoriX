import { ResourceNode } from '../types'

/** ISA-95 CONTAINS adjacency (mirrors backend catalog CONTAINS_PAIRS). */
export const CONTAINS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['enterprise', 'site'],
  ['site', 'area'],
  ['site', 'plant'],
  ['area', 'plant'],
  ['area', 'zone'],
  ['area', 'line'],
  ['area', 'workshop'],
  ['area', 'machine'],
  ['plant', 'area'],
  ['plant', 'zone'],
  ['plant', 'line'],
  ['plant', 'workshop'],
  ['plant', 'machine'],
  ['plant', 'utility_system'],
  ['zone', 'line'],
  ['zone', 'cell'],
  ['zone', 'machine'],
  ['zone', 'workshop'],
  ['zone', 'physical_asset'],
  ['zone', 'functional_position'],
  ['line', 'machine'],
  ['line', 'cell'],
  ['line', 'sensor'],
  ['line', 'physical_asset'],
  ['line', 'functional_position'],
  ['workshop', 'machine'],
  ['workshop', 'cell'],
  ['cell', 'machine'],
  ['cell', 'sensor'],
  ['utility_system', 'sensor'],
  ['utility_system', 'machine'],
  ['machine', 'sensor'],
  ['machine', 'physical_asset'],
  ['machine', 'functional_position'],
  ['functional_position', 'sensor'],
]

export const ALL_RESOURCE_TYPE_KEYS = [
  'enterprise',
  'site',
  'area',
  'plant',
  'zone',
  'line',
  'workshop',
  'cell',
  'utility_system',
  'machine',
  'sensor',
  'physical_asset',
  'functional_position',
] as const

export type ResourceTypeKey = (typeof ALL_RESOURCE_TYPE_KEYS)[number]

const TYPE_LABELS: Record<string, string> = {
  enterprise: 'Enterprise',
  site: 'Site',
  area: 'Area',
  plant: 'Plant',
  zone: 'Zone',
  line: 'Line',
  workshop: 'Workshop',
  cell: 'Cell',
  utility_system: 'Utility system',
  machine: 'Machine',
  sensor: 'Sensor',
  physical_asset: 'Physical asset',
  functional_position: 'Functional position',
}

const TYPE_ABBREV: Record<string, string> = {
  enterprise: 'ENT',
  site: 'SITE',
  area: 'AREA',
  plant: 'AREA',
  zone: 'AREA',
  line: 'LINE',
  workshop: 'LINE',
  cell: 'LINE',
  utility_system: 'LINE',
  machine: 'MACH',
  sensor: 'MACH',
  physical_asset: 'MACH',
  functional_position: 'MACH',
}

export const ISA95_TYPE_GROUPS: ReadonlyArray<{
  id: string
  label: string
  types: string[]
}> = [
  { id: 'enterprise', label: 'Enterprise', types: ['enterprise'] },
  { id: 'site', label: 'Site', types: ['site'] },
  { id: 'area', label: 'Area', types: ['area', 'plant', 'zone'] },
  {
    id: 'work_center',
    label: 'Work center',
    types: ['line', 'workshop', 'cell', 'utility_system'],
  },
  {
    id: 'asset',
    label: 'Asset / position',
    types: ['machine', 'sensor', 'physical_asset', 'functional_position'],
  },
]

export interface HierarchyTreeNode {
  resource: ResourceNode
  children: HierarchyTreeNode[]
}

export function typeDisplayLabel(type: string): string {
  const key = type.toLowerCase()
  return TYPE_LABELS[key] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function typeAbbrev(type: string): string {
  return TYPE_ABBREV[type.toLowerCase()] || type.slice(0, 4).toUpperCase()
}

/** Child types allowed under a parent type (recommended). */
export function allowedChildTypes(parentType: string): string[] {
  const key = parentType.toLowerCase()
  return CONTAINS_PAIRS.filter(([parent]) => parent === key).map(([, child]) => child)
}

/** Parent types that may contain the given child type (Move Resource). */
export function allowedParentTypes(childType: string): string[] {
  const key = childType.toLowerCase()
  return CONTAINS_PAIRS.filter(([, child]) => child === key).map(([parent]) => parent)
}

/** True when parentType may contain childType per ISA-95 adjacency. */
export function isValidParentFor(childType: string, parentType: string): boolean {
  const child = childType.toLowerCase()
  const parent = parentType.toLowerCase()
  return CONTAINS_PAIRS.some(([p, c]) => p === parent && c === child)
}

export function isLeafMachineType(type: string): boolean {
  const key = type.toLowerCase()
  return allowedChildTypes(key).length === 0
}

export function addChildDisabledReason(parentType: string | undefined): string | null {
  if (!parentType) return 'Select a parent resource first.'
  const recommended = allowedChildTypes(parentType)
  if (recommended.length === 0) {
    if (parentType.toLowerCase() === 'machine' || parentType.toLowerCase() === 'sensor') {
      return 'Leaf machines and sensors cannot contain children in the recommended model.'
    }
    return `Type "${typeDisplayLabel(parentType)}" has no recommended child types.`
  }
  return null
}

/** Collect id of resource and all descendants (for cycle prevention). */
export function descendantIds(all: ResourceNode[], rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const item of all) {
    if (!item.parentId) continue
    const list = children.get(item.parentId) || []
    list.push(item.id)
    children.set(item.parentId, list)
  }
  const keep = new Set<string>()
  const walk = (id: string) => {
    keep.add(id)
    for (const childId of children.get(id) || []) walk(childId)
  }
  walk(rootId)
  return keep
}

export function childrenOf(all: ResourceNode[], parentId: string): ResourceNode[] {
  return all
    .filter((r) => r.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function hasChildren(all: ResourceNode[], resourceId: string): boolean {
  return all.some((r) => r.parentId === resourceId)
}

function sortByName(a: ResourceNode, b: ResourceNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** Build a sorted forest from flat resources keyed by parentId. */
export function buildResourceTree(resources: ResourceNode[]): HierarchyTreeNode[] {
  const idSet = new Set(resources.map((r) => r.id))
  const byParent = new Map<string, ResourceNode[]>()

  for (const r of resources) {
    const parentKey = r.parentId && idSet.has(r.parentId) ? r.parentId : ''
    const list = byParent.get(parentKey) || []
    list.push(r)
    byParent.set(parentKey, list)
  }

  for (const list of byParent.values()) {
    list.sort(sortByName)
  }

  const build = (parentKey: string): HierarchyTreeNode[] =>
    (byParent.get(parentKey) || []).map((resource) => ({
      resource,
      children: build(resource.id),
    }))

  return build('')
}

/**
 * When filtering, keep matching nodes and all ancestors so context remains visible.
 */
export function filterResourcesWithAncestors(
  resources: ResourceNode[],
  searchTerm: string,
): ResourceNode[] {
  const term = searchTerm.trim().toLowerCase()
  if (!term) return resources

  const byId = new Map(resources.map((r) => [r.id, r]))
  const keep = new Set<string>()

  for (const r of resources) {
    const matches =
      r.name.toLowerCase().includes(term) || r.code.toLowerCase().includes(term)
    if (!matches) continue
    let cursor: ResourceNode | undefined = r
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      keep.add(cursor.id)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
  }

  return resources.filter((r) => keep.has(r.id))
}

/** Ancestor chain from root → node (inclusive), for expand-path. */
export function ancestorPath(resources: ResourceNode[], resourceId: string): string[] {
  const byId = new Map(resources.map((r) => [r.id, r]))
  const path: string[] = []
  const seen = new Set<string>()
  let cursor = byId.get(resourceId)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    path.unshift(cursor.id)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return path
}

/** Generate a code preview from a display name (mirrors AppContext codeFrom). */
export function codePreviewFromName(name: string): string {
  const raw = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!raw) return ''
  return /^[A-Za-z0-9]/.test(raw) ? raw : `R-${raw}`.slice(0, 64)
}

export const FORBIDDEN_NAME_CHARS = /[/#+$]/

export function validateResourceName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Resource name is required.'
  if (trimmed.length > 200) return 'Resource name must be 200 characters or fewer.'
  if (FORBIDDEN_NAME_CHARS.test(trimmed)) {
    return 'Resource names cannot contain /, #, +, or $.'
  }
  return null
}

export function placeholderForType(type: string): string {
  switch (type.toLowerCase()) {
    case 'enterprise':
      return 'e.g. TIPA Group'
    case 'site':
      return 'e.g. Dong Nai Plant'
    case 'area':
    case 'plant':
      return 'e.g. Assembly Area A'
    case 'zone':
      return 'e.g. Welding Zone'
    case 'line':
      return 'e.g. Line 04'
    case 'workshop':
      return 'e.g. Packaging Workshop'
    case 'cell':
      return 'e.g. Cell B2'
    case 'utility_system':
      return 'e.g. Compressed Air'
    case 'machine':
      return 'e.g. CNC-03'
    case 'sensor':
      return 'e.g. Temp Probe T-12'
    case 'physical_asset':
      return 'e.g. Spindle Assembly'
    case 'functional_position':
      return 'e.g. Motor Seat M1'
    default:
      return 'Display name'
  }
}

export function pluralizeResources(count: number): string {
  return count === 1 ? '1 resource' : `${count} resources`
}

/** Parse uns/.../# MQTT topic into import rows (enterprise→…→machine). */
export function mqttTopicToImportRows(topic: string): Array<{
  code: string
  name: string
  type_key: string
  parent_code: string
}> {
  const cleaned = topic.trim().replace(/^uns\//i, '').replace(/\/#$/, '').replace(/\/$/, '')
  const parts = cleaned.split('/').map((p) => p.trim()).filter(Boolean)
  const typeOrder = ['enterprise', 'site', 'area', 'line', 'machine']
  const rows: Array<{ code: string; name: string; type_key: string; parent_code: string }> = []
  parts.forEach((part, index) => {
    const type_key = typeOrder[Math.min(index, typeOrder.length - 1)]
    rows.push({
      code: codePreviewFromName(part) || `seg-${index + 1}`,
      name: part,
      type_key,
      parent_code: index === 0 ? '' : codePreviewFromName(parts[index - 1]) || `seg-${index}`,
    })
  })
  return rows
}
