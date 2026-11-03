import { ResourceNode } from '../types'

/** ISA-95 CONTAINS adjacency (mirrors backend catalog CONTAINS_PAIRS). */
export const CONTAINS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['enterprise', 'site'],
  ['site', 'plant'],
  ['plant', 'zone'],
  ['plant', 'line'],
  ['plant', 'workshop'],
  ['plant', 'machine'],
  ['plant', 'utility_system'],
  ['zone', 'line'],
  ['zone', 'cell'],
  ['zone', 'machine'],
  ['zone', 'workshop'],
  ['line', 'machine'],
  ['line', 'cell'],
  ['line', 'sensor'],
  ['workshop', 'machine'],
  ['workshop', 'cell'],
  ['cell', 'machine'],
  ['cell', 'sensor'],
  ['utility_system', 'sensor'],
  ['utility_system', 'machine'],
]

export interface HierarchyTreeNode {
  resource: ResourceNode
  children: HierarchyTreeNode[]
}

/** Child types allowed under a parent type (Add Resource). */
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
    const parentKey =
      r.parentId && idSet.has(r.parentId) ? r.parentId : ''
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
    .replace(/Đ/g, 'D').replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!raw) return ''
  return /^[A-Za-z0-9]/.test(raw) ? raw : `R-${raw}`.slice(0, 64)
}

export function validateResourceName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Resource name is required.'
  if (trimmed.length > 200) return 'Resource name must be at most 200 characters.'
  return null
}
