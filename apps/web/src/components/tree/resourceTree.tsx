/**
 * Hierarchy tree helpers shared by the Add Data "Choose target resource" step and the Data Model
 * builder's data picker: tree building, search matching and the resource type glyph.
 * (Extracted from pages/06_AddDataWizard/AddDataWizardPage.tsx without behaviour change.)
 */
import React from 'react';
import { Cpu, FolderTree, Layers, Network } from 'lucide-react';

export interface TreeResource {
  id: string;
  parentId?: string | null;
  name: string;
  code: string;
  type: string;
}

export interface ResourceTreeNode<R extends TreeResource = TreeResource> {
  resource: R;
  children: ResourceTreeNode<R>[];
}

/** Build the forest from a flat list (parents missing from the list make their children roots). */
export function buildResourceTree<R extends TreeResource>(items: R[]): ResourceTreeNode<R>[] {
  const map = new Map<string, ResourceTreeNode<R>>();
  items.forEach((r) => map.set(r.id, { resource: r, children: [] }));
  const roots: ResourceTreeNode<R>[] = [];
  items.forEach((r) => {
    const node = map.get(r.id)!;
    if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(node);
    else roots.push(node);
  });
  return roots;
}

/** True when the node or one of its descendants matches the query (name or code, case-insensitive). */
export function resourceTreeMatches<R extends TreeResource>(node: ResourceTreeNode<R>, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if ((node.resource.name || '').toLowerCase().includes(q) || (node.resource.code || '').toLowerCase().includes(q)) return true;
  return node.children.some((child) => resourceTreeMatches(child, query));
}

/** Icon of a resource type, as used by the hierarchy trees. */
export function resourceTypeGlyph(type: string): React.ReactElement {
  switch ((type || '').toLowerCase()) {
    case 'site':
    case 'plant':
      return <Network className="w-4 h-4 text-emerald-600 shrink-0" />;
    case 'area':
      return <FolderTree className="w-4 h-4 text-amber-600 shrink-0" />;
    case 'line':
    case 'machine':
      return <Cpu className="w-4 h-4 text-slate-600 shrink-0" />;
    default:
      return <Layers className="w-4 h-4 text-slate-500 shrink-0" />;
  }
}
