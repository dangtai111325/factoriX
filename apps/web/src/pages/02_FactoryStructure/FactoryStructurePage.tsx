import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Plus,
  Search,
  Pencil,
  ChevronRight,
  ChevronDown,
  Activity,
  ArrowRightLeft,
  Copy,
  Archive,
  Layers,
} from 'lucide-react'
import { Button } from '../../components/common/Button'
import { Card } from '../../components/common/Card'
import { Badge } from '../../components/common/Badge'
import { Dialog } from '../../components/common/Dialog'
import { useApp } from '../../store/AppContext'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ResourceNode } from '../../types'
import { AddResourceModal } from '../../components/modals/AddResourceModal'
import { MoveResourceModal } from '../../components/modals/MoveResourceModal'
import { ImportResourcesModal } from '../../components/modals/ImportResourcesModal'
import { translateApiError } from '../../utils/apiErrors'
import type {
  ResourceEditorSnapshot,
  ResourceFormValues,
  LocalApplianceStatus,
} from '../../features/assets/model'
import { loadLocalAppliance } from '../../features/assets/api'
import {
  ancestorPath,
  buildResourceTree,
  childrenOf,
  filterResourcesWithAncestors,
  hasChildren,
  HierarchyTreeNode,
} from '../../utils/resourceHierarchy'

function titleCaseType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1)
}

function getIconForType(type: string) {
  const labels: Record<string, string> = {
    enterprise: 'ENT',
    site: 'SITE',
    area: 'AREA',
    plant: 'PLANT',
    line: 'LINE',
    machine: 'MACH',
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[var(--fx-muted)]"
      title={type.replace(/_/g, ' ')}
    >
      <Layers className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-[10px] font-semibold uppercase">{labels[type] || type.replace(/_/g, ' ')}</span>
    </span>
  )
}

function statusPresentation(status?: string): {
  label: string
  variant: 'good' | 'warning' | 'error' | 'neutral'
} {
  switch (status) {
    case 'running':
      return { label: 'RUNNING', variant: 'good' }
    case 'offline':
      return { label: 'OFFLINE', variant: 'error' }
    case 'warning':
      return { label: 'WARNING', variant: 'warning' }
    default:
      return { label: 'NO DATA', variant: 'neutral' }
  }
}

/** Fill missing childrenCount / signalsCount from the live graph. */
function enrichResourceCounts(
  resources: ResourceNode[],
  signals: Array<{ resourceId: string }>,
): ResourceNode[] {
  const childCounts = new Map<string, number>()
  const signalCounts = new Map<string, number>()

  for (const resource of resources) {
    if (!resource.parentId) continue
    childCounts.set(resource.parentId, (childCounts.get(resource.parentId) || 0) + 1)
  }
  for (const signal of signals) {
    if (!signal.resourceId) continue
    signalCounts.set(signal.resourceId, (signalCounts.get(signal.resourceId) || 0) + 1)
  }

  return resources.map((resource) => ({
    ...resource,
    childrenCount: resource.childrenCount ?? childCounts.get(resource.id) ?? 0,
    signalsCount: resource.signalsCount ?? signalCounts.get(resource.id) ?? 0,
  }))
}

interface TreeRowProps {
  node: HierarchyTreeNode
  depth: number
  selectedId: string
  expandedNodes: Record<string, boolean>
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onKeyNavigate: (event: React.KeyboardEvent, node: HierarchyTreeNode) => void
}

const TreeRow: React.FC<TreeRowProps> = ({
  node,
  depth,
  selectedId,
  expandedNodes,
  onToggle,
  onSelect,
  onKeyNavigate,
}) => {
  const { resource, children } = node
  const isSelected = resource.id === selectedId
  const hasKids = children.length > 0
  const isExpanded = expandedNodes[resource.id] ?? true
  const signalCount = resource.signalsCount ?? 0

  return (
    <>
      <div
        role="treeitem"
        id={`resource-tree-${resource.id}`}
        aria-level={depth + 1}
        title={`${resource.name} [${resource.code}]`}
        aria-label={`${resource.name}, ${signalCount} bound signals`}
        aria-expanded={hasKids ? isExpanded : undefined}
        aria-owns={hasKids && isExpanded ? `resource-group-${resource.id}` : undefined}
        aria-selected={isSelected}
        tabIndex={isSelected ? 0 : -1}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={`flex items-center justify-between py-1.5 px-2 rounded-lg cursor-pointer text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#EF1B24]/40 ${
          isSelected
            ? 'bg-[#FFF0F1] text-[#EF1B24] font-bold border-l-2 border-[#EF1B24]'
            : 'text-[#334568] hover:bg-[#F1F5FA]'
        }`}
        onClick={() => onSelect(resource.id)}
        onKeyDown={(event) => onKeyNavigate(event, node)}
      >
        <div className="flex items-center gap-2 truncate min-w-0">
          {hasKids ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation()
                onToggle(resource.id)
              }}
              className="p-0.5 text-[#94A3B8] hover:text-[#111B37] flex-shrink-0"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}
          {getIconForType(resource.type)}
          <span className="truncate">{resource.name}</span>
          {resource.lifecycle === 'ARCHIVED' ? (
            <span className="text-[10px] font-semibold text-[var(--fx-muted)]">ARCHIVED</span>
          ) : null}
        </div>
        <span className="text-[11px] font-mono text-[#94A3B8] ml-2 flex-shrink-0" aria-hidden="true">
          {signalCount}
        </span>
      </div>
      {children.length > 0 && isExpanded ? (
        <div role="group" id={`resource-group-${resource.id}`}>
          {children.map((child) => (
            <TreeRow
              key={child.resource.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              onSelect={onSelect}
              onKeyNavigate={onKeyNavigate}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

export const FactoryStructurePage: React.FC = () => {
  const {
    modelResources: rawResources,
    modelSignals: signals,
    resourceTypes,
    activities,
    selectedResourceId,
    setSelectedResourceId,
    addResource,
    loadResourceEditor,
    editResource,
    createResourceType,
    moveResource,
    archiveResource,
    restoreResource,
    refresh,
  } = useApp()
  const [searchParams] = useSearchParams()
  const [searchTerm, setSearchTerm] = useState('')
  const [moveToast, setMoveToast] = useState<{
    message: string
    undoMove?: { id: string; parentId: string | null; version: number }
    undoArchive?: { id: string; version: number }
    linkTo?: string
  } | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<ResourceNode | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({})
  const [expandedInitialized, setExpandedInitialized] = useState(false)

  const [isAddModalOpen, setIsAddModalOpen] = useState(searchParams.get('modal') === 'add')
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [editingResource, setEditingResource] = useState<ResourceEditorSnapshot | undefined>()
  const [editingLoading, setEditingLoading] = useState(false)
  const [applianceStatus, setApplianceStatus] = useState<LocalApplianceStatus | null>(null)
  const [applianceStatusError, setApplianceStatusError] = useState('')
  useEffect(() => {
    if (!isAddModalOpen || editingResource) return
    let closed = false
    setApplianceStatus(null)
    setApplianceStatusError('')
    loadLocalAppliance()
      .then((status) => {
        if (!closed) setApplianceStatus(status)
      })
      .catch((error) => {
        if (!closed) setApplianceStatusError(translateApiError(error))
      })
    return () => {
      closed = true
    }
  }, [isAddModalOpen, editingResource?.id])
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(searchParams.get('modal') === 'move')
  const [movingResource, setMovingResource] = useState<ResourceNode | null>(null)
  useEffect(() => {
    if (!moveToast) return
    const timer = window.setTimeout(() => setMoveToast(null), 10000)
    return () => window.clearTimeout(timer)
  }, [moveToast])

  const navigate = useNavigate()

  const resources = useMemo(() => enrichResourceCounts(rawResources, signals), [rawResources, signals])

  const visibleResources = useMemo(
    () =>
      filterResourcesWithAncestors(
        resources.filter((resource) => showArchived || resource.lifecycle !== 'ARCHIVED'),
        searchTerm,
      ),
    [resources, searchTerm, showArchived],
  )

  const tree = useMemo(() => buildResourceTree(visibleResources), [visibleResources])

  const flatVisibleOrder = useMemo(() => {
    const order: HierarchyTreeNode[] = []
    const walk = (nodes: HierarchyTreeNode[]) => {
      for (const node of nodes) {
        order.push(node)
        const expanded = expandedNodes[node.resource.id] ?? true
        if (expanded && node.children.length) walk(node.children)
      }
    }
    walk(tree)
    return order
  }, [tree, expandedNodes])

  // Default-expand all parents once resources load
  useEffect(() => {
    if (!resources.length || expandedInitialized) return
    const next: Record<string, boolean> = {}
    for (const r of resources) {
      if (hasChildren(resources, r.id)) next[r.id] = true
    }
    setExpandedNodes(next)
    setExpandedInitialized(true)
  }, [resources, expandedInitialized])

  // Expand path to deep-linked resource
  useEffect(() => {
    const resourceId = searchParams.get('resourceId')
    if (resourceId && resources.some((item) => item.id === resourceId)) {
      setSelectedResourceId(resourceId)
    }
  }, [resources, searchParams, setSelectedResourceId])

  // Keep ancestors of the selected node expanded so it stays visible
  useEffect(() => {
    const focusId = selectedResourceId || resources[0]?.id
    if (!focusId) return
    const path = ancestorPath(resources, focusId)
    if (path.length < 2) return
    setExpandedNodes((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of path.slice(0, -1)) {
        if (next[id] !== true) {
          next[id] = true
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [selectedResourceId, resources])

  // While filtering, keep ancestors expanded
  useEffect(() => {
    if (!searchTerm.trim()) return
    setExpandedNodes((prev) => {
      const next = { ...prev }
      for (const r of visibleResources) {
        if (hasChildren(visibleResources, r.id)) next[r.id] = true
      }
      return next
    })
  }, [searchTerm, visibleResources])

  const toggleExpand = useCallback((id: string) => {
    setExpandedNodes((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))
  }, [])

  const selectedResource =
    resources.find((r) => r.id === selectedResourceId && (showArchived || r.lifecycle !== 'ARCHIVED')) ||
    resources.find((r) => showArchived || r.lifecycle !== 'ARCHIVED')
  const selectedStatus =
    selectedResource?.lifecycle === 'ARCHIVED'
      ? { label: 'ARCHIVED', variant: 'neutral' as const }
      : !selectedResource?.signalsCount
        ? {
            label: selectedResource?.type.replace(/_/g, ' ').toUpperCase() || 'RESOURCE',
            variant: 'neutral' as const,
          }
        : statusPresentation(selectedResource?.status)

  const childResources = selectedResource
    ? childrenOf(resources, selectedResource.id).filter(
        (resource) => showArchived || resource.lifecycle !== 'ARCHIVED',
      )
    : []

  const canArchive = selectedResource
    ? selectedResource.lifecycle !== 'ARCHIVED' &&
      !resources.some(
        (resource) => resource.parentId === selectedResource.id && resource.lifecycle !== 'ARCHIVED',
      )
    : false

  const canonicalPath = (() => {
    if (!selectedResource) return ''
    const names: string[] = []
    const seen = new Set<string>()
    let current: ResourceNode | undefined = selectedResource
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      names.unshift(current.name)
      current = resources.find((item) => item.id === current?.parentId)
    }
    return names.join(' / ')
  })()

  const declaredAttributes = Object.entries(selectedResource?.properties || {})

  const openCreate = () => {
    setEditingResource(undefined)
    setIsAddModalOpen(true)
  }
  const openEdit = async () => {
    if (!selectedResource) return
    setEditingLoading(true)
    setPageError(null)
    try {
      setEditingResource(await loadResourceEditor(selectedResource.id))
      setIsAddModalOpen(true)
    } catch (caught) {
      setPageError(translateApiError(caught))
    } finally {
      setEditingLoading(false)
    }
  }
  const handleCreateResource = async (data: ResourceFormValues) => {
    setPageError(null)
    try {
      if (editingResource) {
        await editResource(editingResource, data)
        setMoveToast({ message: `Saved "${data.name}".` })
        return
      }
      const result = await addResource(data)
      if (result?.edgeCreated) {
        const enrollment = result.enrollmentError
          ? `Site was created. Local enrollment was not queued: ${result.enrollmentError}`
          : result.enrollmentStatus === 'already_enrolled'
            ? 'This appliance is already enrolled for the Edge.'
            : result.enrollmentStatus
              ? 'Local enrollment was requested; wait for the Edge heartbeat to confirm it.'
              : 'Enroll the Edge from Edge Collectors before commissioning.'
        setMoveToast({
          message:
            `Edge "${result.edgeName || 'collector'}" was created. ${enrollment} ${(result.warnings || []).map((warning) => warning.message).join(' ')}`.trim(),
          linkTo: '/collector/edges',
        })
      } else if (result.warnings?.length) {
        setMoveToast({ message: result.warnings.map((warning) => warning.message).join(' ') })
      }
    } catch (caught) {
      throw new Error(translateApiError(caught))
    }
  }

  const handleMoveResource = async (targetParentId: string | null, hierarchyMode: 'guided' | 'strict') => {
    const resource = movingResource || selectedResource
    if (!resource) return { success: false, error: 'No resource selected.' }
    const oldParentId = resource.parentId
    const res = await moveResource(resource.id, targetParentId, {
      version: Number(resource.version || resource.attributes?.version || 1),
      hierarchyMode,
    })
    if (!res.success) {
      return { success: false, error: translateApiError(res.error || 'Move failed') }
    }
    if (targetParentId) setExpandedNodes((prev) => ({ ...prev, [targetParentId]: true }))
    setMoveToast({
      message: `Moved "${resource.name}".${res.warnings?.length ? ` ${res.warnings.map((warning) => warning.message).join(' ')}` : ''}`,
      undoMove: { id: resource.id, parentId: oldParentId || null, version: res.version! },
    })
    setPageError(null)
    return { success: true }
  }

  const handleUndoMove = async () => {
    const undo = moveToast?.undoMove
    if (!undo) return
    const result = await moveResource(undo.id, undo.parentId, { version: undo.version })
    if (!result.success) {
      setPageError(result.error || 'Undo failed.')
      return
    }
    setSelectedResourceId(undo.id)
    setMoveToast(null)
  }

  const handleArchive = async () => {
    if (!archiveTarget) return
    setArchiveBusy(true)
    setArchiveError('')
    try {
      const res = await archiveResource(
        archiveTarget.id,
        Number(archiveTarget.version || archiveTarget.attributes?.version || 1),
      )
      if (!res.success) {
        setArchiveError(translateApiError(res.error || 'Archive failed'))
        return
      }
      setSelectedResourceId(archiveTarget.parentId || '')
      setMoveToast({
        message: res.deploymentPending ? 'Archived. Collector update queued.' : 'Archived.',
        undoArchive: { id: archiveTarget.id, version: res.version! },
      })
      setArchiveTarget(null)
    } finally {
      setArchiveBusy(false)
    }
  }
  const handleRestore = async (id: string, version: number) => {
    setPageError(null)
    try {
      await restoreResource(id, version)
      setMoveToast({ message: 'Resource restored. Collector updates are applied through its Edge.' })
    } catch (caught) {
      setPageError(translateApiError(caught))
    }
  }

  const handleTreeKeyNavigate = useCallback(
    (event: React.KeyboardEvent, node: HierarchyTreeNode) => {
      const { resource, children } = node
      const expanded = expandedNodes[resource.id] ?? true
      const index = flatVisibleOrder.findIndex((n) => n.resource.id === resource.id)
      const focusNode = (id: string) => {
        setSelectedResourceId(id)
        requestAnimationFrame(() => document.getElementById(`resource-tree-${id}`)?.focus())
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (children.length && !expanded) {
          toggleExpand(resource.id)
        } else if (children.length && expanded) {
          focusNode(children[0].resource.id)
        }
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (children.length && expanded) {
          toggleExpand(resource.id)
        } else if (resource.parentId) {
          focusNode(resource.parentId)
        }
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const next = flatVisibleOrder[index + 1]
        if (next) focusNode(next.resource.id)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const prev = flatVisibleOrder[index - 1]
        if (prev) focusNode(prev.resource.id)
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        const target =
          event.key === 'Home' ? flatVisibleOrder[0] : flatVisibleOrder[flatVisibleOrder.length - 1]
        if (target) focusNode(target.resource.id)
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setSelectedResourceId(resource.id)
      }
    },
    [expandedNodes, flatVisibleOrder, setSelectedResourceId, toggleExpand],
  )

  const resourceModal = (
    <AddResourceModal
      isOpen={isAddModalOpen}
      onClose={() => setIsAddModalOpen(false)}
      resources={resources.filter((resource) => resource.lifecycle !== 'ARCHIVED')}
      resourceTypes={resourceTypes}
      parentId={selectedResource?.lifecycle === 'ARCHIVED' ? undefined : selectedResource?.id}
      initialResource={editingResource}
      appliance={applianceStatus}
      applianceError={applianceStatusError}
      onSave={handleCreateResource}
      onCreateType={createResourceType}
    />
  )

  const importModal = (
    <ImportResourcesModal
      key="asset-import"
      isOpen={isImportOpen}
      onClose={() => setIsImportOpen(false)}
      resources={rawResources}
      resourceTypes={resourceTypes}
      onImported={async (result) => {
        await refresh()
        const first =
          result.items.find((item) => item.action === 'CREATE' && item.id) ||
          result.items.find((item) => item.id)
        if (first?.id) setSelectedResourceId(first.id)
      }}
    />
  )
  const notification = moveToast ? (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-white shadow-xl"
    >
      <span className="break-words text-xs font-semibold">{moveToast.message}</span>
      {moveToast.linkTo ? (
        <Button
          variant="ghost"
          className="!text-white"
          onClick={() => {
            navigate(moveToast.linkTo!)
            setMoveToast(null)
          }}
        >
          Open Edges
        </Button>
      ) : null}
      {moveToast.undoMove ? (
        <Button variant="ghost" className="!text-white" onClick={() => void handleUndoMove()}>
          Undo
        </Button>
      ) : null}
      {moveToast.undoArchive ? (
        <Button
          variant="ghost"
          className="!text-white"
          onClick={() => void handleRestore(moveToast.undoArchive!.id, moveToast.undoArchive!.version)}
        >
          Undo
        </Button>
      ) : null}
    </div>
  ) : null

  if (!selectedResource) {
    return (
      <div className="space-y-4">
        <h1 className="fx-page-title">Factory Structure</h1>
        <p className="fx-page-subtitle">
          Create an enterprise and build your factory model. Recommended types guide the hierarchy; you can
          adapt it to your operation.
        </p>
        {pageError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {pageError}
          </p>
        )}
        <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
          Create enterprise
        </Button>
        <Button variant="secondary" onClick={() => setIsImportOpen(true)}>
          Import resources
        </Button>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
        {resourceModal}
        {importModal}
        {notification}
      </div>
    )
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1 & 2: Heading & Actions Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Hierarchy Structure</h1>
          <p className="fx-page-subtitle">
            Enterprise asset topology, functional locations, and resource hierarchy.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show archived
          </label>
          <div className="relative w-56">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#94A3B8]" />
            <input
              type="text"
              placeholder="Filter hierarchy..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="fx-input !pl-9 h-9 text-[13px]"
            />
          </div>
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
            Add Resource
          </Button>
          <Button variant="secondary" onClick={() => setIsImportOpen(true)}>
            Import resources
          </Button>
          <Button
            variant="secondary"
            icon={<Pencil className="h-4 w-4" />}
            onClick={() => void openEdit()}
            loading={editingLoading}
            disabled={selectedResource.lifecycle === 'ARCHIVED'}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            icon={<ArrowRightLeft className="w-4 h-4" />}
            onClick={() => {
              setMovingResource(selectedResource)
              setIsMoveModalOpen(true)
            }}
            disabled={selectedResource.lifecycle === 'ARCHIVED'}
          >
            Move
          </Button>
          <Button
            variant="secondary"
            icon={<Copy className="w-4 h-4" />}
            disabled
            title="Duplicate is not available in this appliance build"
          >
            Duplicate
          </Button>
          <Button
            variant="secondary"
            icon={<Archive className="w-4 h-4" />}
            onClick={() => {
              setArchiveError('')
              setArchiveTarget(selectedResource)
            }}
            disabled={!canArchive}
            title={
              canArchive
                ? 'Archive this resource'
                : 'Archive child resources first before archiving this node'
            }
          >
            Archive
          </Button>
          {selectedResource.lifecycle === 'ARCHIVED' ? (
            <Button
              variant="secondary"
              onClick={() => void handleRestore(selectedResource.id, Number(selectedResource.version))}
            >
              Restore
            </Button>
          ) : null}
        </div>
      </div>

      {pageError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {pageError}
        </div>
      )}

      {/* 3-Column Layout: Hierarchy Tree, Child Units, and Detail Inspector */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Region 3: Asset Hierarchy Tree */}
        <div className="col-span-12 lg:col-span-3">
          <Card className="h-[760px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
                Hierarchy Tree
              </span>
              <span className="text-[11px] font-semibold text-[#657794]">
                {visibleResources.length} {visibleResources.length === 1 ? 'node' : 'nodes'}
              </span>
            </div>
            <div className="p-3 overflow-y-auto flex-1" role="tree" aria-label="Factory hierarchy">
              {tree.length === 0 ? (
                <div className="text-center py-8 text-[#94A3B8] text-[13px]">No matching resources.</div>
              ) : (
                tree.map((node) => (
                  <TreeRow
                    key={node.resource.id}
                    node={node}
                    depth={0}
                    selectedId={selectedResource.id}
                    expandedNodes={expandedNodes}
                    onToggle={toggleExpand}
                    onSelect={setSelectedResourceId}
                    onKeyNavigate={handleTreeKeyNavigate}
                  />
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Region 4: Resources List in current container */}
        <div className="col-span-12 lg:col-span-4">
          <Card className="h-[760px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
                Child Units ({childResources.length})
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={openCreate}
                disabled={selectedResource.lifecycle === 'ARCHIVED'}
              >
                Add Child
              </Button>
            </div>
            <div className="p-3 overflow-y-auto flex-1 space-y-2">
              {childResources.length === 0 ? (
                <div className="text-center py-12 text-[#94A3B8] text-[13px]">
                  No sub-resources configured under this unit.
                </div>
              ) : (
                childResources.map((child) => {
                  const childStatus =
                    child.lifecycle === 'ARCHIVED'
                      ? { label: 'ARCHIVED', variant: 'neutral' as const }
                      : !child.signalsCount
                        ? { label: child.type.replace(/_/g, ' ').toUpperCase(), variant: 'neutral' as const }
                        : statusPresentation(child.status)
                  return (
                    <div
                      key={child.id}
                      onClick={() => setSelectedResourceId(child.id)}
                      className="p-3 rounded-xl border border-[#E3EAF3] hover:border-[#EF1B24] cursor-pointer bg-white transition-all shadow-sm"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          {getIconForType(child.type)}
                          <span className="text-[13px] font-bold text-[#111B37]">{child.name}</span>
                        </div>
                        <Badge variant={childStatus.variant}>{childStatus.label}</Badge>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-[#657794] font-mono">
                        <span>{child.code || 'ASSET-NODE'}</span>
                        <span>{child.signalsCount ?? 0} signals linked</span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </Card>
        </div>

        {/* Right Inspector: Details, Specification, Topology, Activity */}
        <div className="col-span-12 lg:col-span-5 space-y-3.5">
          <Card className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[18px] font-extrabold text-[#111B37]">{selectedResource.name}</h2>
                  <Badge variant={selectedStatus.variant}>{selectedStatus.label}</Badge>
                </div>
                <div className="text-[12px] font-mono text-[#657794] mt-1">
                  Code:{' '}
                  <span className="text-[#111B37] font-semibold">{selectedResource.code || 'RES-01'}</span> ·
                  Type: <span className="uppercase text-[#2A82E7] font-bold">{selectedResource.type}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
                  onClick={() => setIsMoveModalOpen(true)}
                >
                  Move
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Activity className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/collector/add-data?resourceId=${selectedResource.id}`)}
                >
                  Add Signals
                </Button>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3.5">
            <Card title="Specification & Attributes" className="h-[240px]">
              <div className="space-y-2 text-[12px]">
                {declaredAttributes.length > 0 ? (
                  declaredAttributes.map(([k, v]) => (
                    <div key={k} className="flex justify-between py-1 border-b border-[#F1F5FA]">
                      <span className="text-[#657794]">{k}</span>
                      <span className="break-all font-semibold text-[#111B37]">
                        {v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="py-6 text-center text-[12px] text-[#94A3B8]">
                    No attributes declared for this resource.
                  </p>
                )}
              </div>
            </Card>

            <Card title="Topology Context" className="h-[240px]">
              <div className="space-y-3 text-[12px]">
                <div>
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">Canonical Path</span>
                  <p className="font-mono text-[#111B37] font-medium text-[12px] mt-0.5">{canonicalPath}</p>
                </div>
                <div className="pt-2 border-t border-[#E3EAF3]">
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">
                    Bound Telemetry
                  </span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-[20px] font-extrabold text-[#111B37]">
                      {selectedResource.signalsCount ?? 0}
                    </span>
                    <span className="text-[#657794]">active collector tags</span>
                  </div>
                </div>
                <div className="pt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full text-[11px]"
                    icon={<Layers className="w-3 h-3" />}
                    onClick={() => navigate('/factory/layout')}
                  >
                    Layout View
                  </Button>
                </div>
              </div>
            </Card>
          </div>

          <Card title="Asset Change & Synchronization Log">
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Operator</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {activities.slice(0, 8).map((act) => (
                    <tr key={act.id}>
                      <td className="font-mono text-[11px] text-[#94A3B8]">{act.timestamp}</td>
                      <td className="font-semibold text-[#111B37] text-[12px]">{act.eventType}</td>
                      <td className="text-[#657794] text-[12px]">{act.source}</td>
                      <td className="text-[#334568] text-[12px]">{act.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      {resourceModal}
      {importModal}
      <Dialog
        isOpen={Boolean(archiveTarget)}
        title={`Archive "${archiveTarget?.name || ''}"?`}
        busy={archiveBusy}
        onClose={() => setArchiveTarget(null)}
      >
        <div className="space-y-4 p-6 text-sm">
          <p>
            The resource will be hidden from the active model and its signal mappings will stop collecting.
            Configuration and latest values are retained. Shared connections continue collecting other
            resources.
          </p>
          <p>You can restore it later using Show archived.</p>
          {archiveError ? (
            <p role="alert" className="text-[var(--fx-error)]">
              {archiveError}
            </p>
          ) : null}
          <div className="flex justify-end gap-3">
            <Button variant="secondary" disabled={archiveBusy} onClick={() => setArchiveTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={archiveBusy} onClick={() => void handleArchive()}>
              Archive resource
            </Button>
          </div>
        </div>
      </Dialog>

      <MoveResourceModal
        isOpen={isMoveModalOpen}
        onClose={() => setIsMoveModalOpen(false)}
        selectedResource={movingResource || selectedResource}
        allResources={resources}
        resourceTypes={resourceTypes}
        onMoveResource={handleMoveResource}
      />

      {notification}
    </div>
  )
}
