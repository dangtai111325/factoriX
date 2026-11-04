import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Building2,
  Factory,
  Boxes,
  Cpu,
  ChevronRight,
  ChevronDown,
  Activity,
  ArrowRightLeft,
  Copy,
  Archive,
  Layers,
  UploadCloud,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ResourceNode } from '../../types';
import { AddResourceModal } from '../../components/modals/AddResourceModal';
import { MoveResourceModal } from '../../components/modals/MoveResourceModal';
import { ImportTopicsModal } from '../../components/modals/ImportTopicsModal';
import { translateApiError } from '../../utils/apiErrors';
import {
  allowedChildTypes,
  ancestorPath,
  buildResourceTree,
  childrenOf,
  filterResourcesWithAncestors,
  hasChildren,
  HierarchyTreeNode,
} from '../../utils/resourceHierarchy';

function titleCaseType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function getIconForType(type: string) {
  switch (type.toLowerCase()) {
    case 'enterprise':
    case 'site':
      return <Building2 className="w-4 h-4 text-[#2A82E7]" />;
    case 'plant':
      return <Factory className="w-4 h-4 text-[#8858EA]" />;
    case 'line':
    case 'zone':
    case 'workshop':
      return <Boxes className="w-4 h-4 text-[#FFAA23]" />;
    default:
      return <Cpu className="w-4 h-4 text-[#EF1B24]" />;
  }
}

function statusPresentation(status?: string): {
  label: string;
  variant: 'good' | 'warning' | 'error' | 'neutral';
} {
  switch (status) {
    case 'running':
      return { label: 'RUNNING', variant: 'good' };
    case 'offline':
      return { label: 'OFFLINE', variant: 'error' };
    case 'warning':
      return { label: 'WARNING', variant: 'warning' };
    default:
      return { label: 'NO DATA', variant: 'neutral' };
  }
}

/** Fill missing childrenCount / signalsCount from the live graph. */
function enrichResourceCounts(
  resources: ResourceNode[],
  signals: Array<{ resourceId: string }>,
): ResourceNode[] {
  const childCounts = new Map<string, number>();
  const signalCounts = new Map<string, number>();

  for (const resource of resources) {
    if (!resource.parentId) continue;
    childCounts.set(resource.parentId, (childCounts.get(resource.parentId) || 0) + 1);
  }
  for (const signal of signals) {
    if (!signal.resourceId) continue;
    signalCounts.set(signal.resourceId, (signalCounts.get(signal.resourceId) || 0) + 1);
  }

  return resources.map((resource) => ({
    ...resource,
    childrenCount: resource.childrenCount ?? childCounts.get(resource.id) ?? 0,
    signalsCount: resource.signalsCount ?? signalCounts.get(resource.id) ?? 0,
  }));
}

interface TreeRowProps {
  node: HierarchyTreeNode;
  depth: number;
  selectedId: string;
  expandedNodes: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onKeyNavigate: (event: React.KeyboardEvent, node: HierarchyTreeNode) => void;
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
  const { resource, children } = node;
  const isSelected = resource.id === selectedId;
  const hasKids = children.length > 0;
  const isExpanded = expandedNodes[resource.id] ?? true;
  const signalCount = resource.signalsCount ?? 0;

  return (
    <>
      <div
        role="treeitem"
        aria-label={`${resource.name}, ${signalCount} bound signals`}
        aria-expanded={hasKids ? isExpanded : undefined}
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
                e.stopPropagation();
                onToggle(resource.id);
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
        </div>
        <span className="text-[11px] font-mono text-[#94A3B8] ml-2 flex-shrink-0" aria-hidden="true">
          {signalCount}
        </span>
      </div>
      {children.length > 0 && isExpanded ? (
        <div role="group">
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
  );
};

export const FactoryStructurePage: React.FC = () => {
  const {
    resources: rawResources,
    signals,
    activities,
    selectedResourceId,
    setSelectedResourceId,
    addResource,
    moveResource,
    archiveResource,
  } = useApp();
  const [searchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [moveToast, setMoveToast] = useState<{
    message: string;
    undoParentId?: string;
    linkTo?: string;
  } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [expandedInitialized, setExpandedInitialized] = useState(false);

  const [isAddModalOpen, setIsAddModalOpen] = useState(searchParams.get('modal') === 'add');
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(searchParams.get('modal') === 'move');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const navigate = useNavigate();

  const resources = useMemo(
    () => enrichResourceCounts(rawResources, signals),
    [rawResources, signals],
  );

  const visibleResources = useMemo(
    () => filterResourcesWithAncestors(resources, searchTerm),
    [resources, searchTerm],
  );

  const tree = useMemo(() => buildResourceTree(visibleResources), [visibleResources]);

  const flatVisibleOrder = useMemo(() => {
    const order: HierarchyTreeNode[] = [];
    const walk = (nodes: HierarchyTreeNode[]) => {
      for (const node of nodes) {
        order.push(node);
        const expanded = expandedNodes[node.resource.id] ?? true;
        if (expanded && node.children.length) walk(node.children);
      }
    };
    walk(tree);
    return order;
  }, [tree, expandedNodes]);

  // Default-expand all parents once resources load
  useEffect(() => {
    if (!resources.length || expandedInitialized) return;
    const next: Record<string, boolean> = {};
    for (const r of resources) {
      if (hasChildren(resources, r.id)) next[r.id] = true;
    }
    setExpandedNodes(next);
    setExpandedInitialized(true);
  }, [resources, expandedInitialized]);

  // Expand path to deep-linked resource
  useEffect(() => {
    const resourceId = searchParams.get('resourceId');
    if (resourceId && resources.some((item) => item.id === resourceId)) {
      setSelectedResourceId(resourceId);
    }
  }, [resources, searchParams, setSelectedResourceId]);

  // Keep ancestors of the selected node expanded so it stays visible
  useEffect(() => {
    const focusId = selectedResourceId || resources[0]?.id;
    if (!focusId) return;
    const path = ancestorPath(resources, focusId);
    if (path.length < 2) return;
    setExpandedNodes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of path.slice(0, -1)) {
        if (next[id] !== true) {
          next[id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedResourceId, resources]);

  // While filtering, keep ancestors expanded
  useEffect(() => {
    if (!searchTerm.trim()) return;
    setExpandedNodes((prev) => {
      const next = { ...prev };
      for (const r of visibleResources) {
        if (hasChildren(visibleResources, r.id)) next[r.id] = true;
      }
      return next;
    });
  }, [searchTerm, visibleResources]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedNodes((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  }, []);

  const selectedResource =
    resources.find((r) => r.id === selectedResourceId) || resources[0];
  const selectedStatus = statusPresentation(selectedResource?.status);

  const childResources = selectedResource
    ? childrenOf(resources, selectedResource.id)
    : [];

  const canArchive = selectedResource
    ? !hasChildren(resources, selectedResource.id)
    : false;

  const canonicalPath = (() => {
    if (!selectedResource) return '';
    const names: string[] = [];
    const seen = new Set<string>();
    let current: ResourceNode | undefined = selectedResource;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = resources.find((item) => item.id === current?.parentId);
    }
    return names.join(' / ');
  })();

  const declaredAttributes = Object.entries(selectedResource?.attributes || {}).filter(
    ([key]) => key !== 'siteId' && key !== 'version',
  );

  const allowedTypesForSelected = selectedResource
    ? allowedChildTypes(selectedResource.type).map(titleCaseType)
    : ['Enterprise'];

  const handleCreateResource = async (data: {
    name: string;
    code: string;
    type: string;
    parent_id?: string | null;
    description: string;
    properties: Record<string, string>;
  }) => {
    setPageError(null);
    try {
      const result = await addResource({
        name: data.name,
        code: data.code,
        parentId: data.parent_id || selectedResource?.id || undefined,
        type: (data.type.toLowerCase() || 'enterprise') as ResourceNode['type'],
        description: data.description,
        attributes: data.properties,
      });
      if (result?.edgeCreated) {
        setMoveToast({
          message: `Edge "${result.edgeName || 'collector'}" was created and needs enrollment before commissioning.`,
          linkTo: '/collector/edges',
        });
        setTimeout(() => setMoveToast(null), 8000);
      }
    } catch (caught) {
      throw new Error(translateApiError(caught));
    }
  };

  const handleMoveResource = async (targetParentId: string) => {
    if (!selectedResource) return { success: false, error: 'No resource selected.' };
    const oldParentId = selectedResource.parentId;
    const res = await moveResource(selectedResource.id, targetParentId);
    if (!res.success) {
      return { success: false, error: translateApiError(res.error || 'Move failed') };
    }
    setExpandedNodes((prev) => ({ ...prev, [targetParentId]: true }));
    setMoveToast({
      message: `Successfully moved "${selectedResource.name}"`,
      undoParentId: oldParentId,
    });
    setTimeout(() => setMoveToast(null), 5000);
    setPageError(null);
    return { success: true };
  };

  const handleUndoMove = () => {
    if (moveToast?.undoParentId && selectedResource) {
      void moveResource(selectedResource.id, moveToast.undoParentId);
      setMoveToast(null);
    }
  };

  const handleArchive = async () => {
    if (!selectedResource) return;
    if (!canArchive) {
      setPageError('Archive child resources first.');
      return;
    }
    setPageError(null);
    const res = await archiveResource(selectedResource.id);
    if (!res.success) {
      setPageError(translateApiError(res.error || 'Archive failed'));
    }
  };

  const handleTreeKeyNavigate = useCallback(
    (event: React.KeyboardEvent, node: HierarchyTreeNode) => {
      const { resource, children } = node;
      const expanded = expandedNodes[resource.id] ?? true;
      const index = flatVisibleOrder.findIndex((n) => n.resource.id === resource.id);

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (children.length && !expanded) {
          toggleExpand(resource.id);
        } else if (children.length && expanded) {
          setSelectedResourceId(children[0].resource.id);
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (children.length && expanded) {
          toggleExpand(resource.id);
        } else if (resource.parentId) {
          setSelectedResourceId(resource.parentId);
        }
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = flatVisibleOrder[index + 1];
        if (next) setSelectedResourceId(next.resource.id);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = flatVisibleOrder[index - 1];
        if (prev) setSelectedResourceId(prev.resource.id);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setSelectedResourceId(resource.id);
      }
    },
    [expandedNodes, flatVisibleOrder, setSelectedResourceId, toggleExpand],
  );

  if (!selectedResource) {
    return (
      <div className="space-y-4">
        <h1 className="fx-page-title">Hierarchy Structure</h1>
        <p className="fx-page-subtitle">
          The model is empty. Create an enterprise, then a site, plant, line and machine. Each step
          is checked by the server.
        </p>
        {pageError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {pageError}
          </p>
        )}
        <Button
          variant="primary"
          icon={<Plus className="w-4 h-4" />}
          onClick={() => setIsAddModalOpen(true)}
        >
          Create enterprise
        </Button>
        <AddResourceModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          parentPath="(root)"
          parentName="Root"
          recommendedTypes={['enterprise']}
          onAddResource={handleCreateResource}
        />
      </div>
    );
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
        <div className="flex items-center gap-2.5">
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
          <Button
            variant="secondary"
            icon={<UploadCloud className="w-4 h-4" />}
            onClick={() => setIsImportModalOpen(true)}
          >
            Import Topics
          </Button>
          <Button
            variant="primary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => setIsAddModalOpen(true)}
            disabled={allowedTypesForSelected.length === 0}
          >
            Add Resource
          </Button>
          <Button
            variant="secondary"
            icon={<ArrowRightLeft className="w-4 h-4" />}
            onClick={() => setIsMoveModalOpen(true)}
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
            onClick={() => void handleArchive()}
            disabled={!canArchive}
            title={
              canArchive
                ? 'Archive this resource'
                : 'Archive child resources first before archiving this node'
            }
          >
            Archive
          </Button>
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
                {visibleResources.length} nodes
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
                onClick={() => setIsAddModalOpen(true)}
                disabled={allowedTypesForSelected.length === 0}
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
                  const childStatus = statusPresentation(child.status);
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
                        {(child.signalsCount ?? 0) > 0 ? (
                          <Badge variant={childStatus.variant}>{childStatus.label}</Badge>
                        ) : (
                          <span className="text-[10px] text-slate-400 font-medium px-2 py-0.5 rounded bg-slate-100">
                            NO SIGNALS
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-[#657794] font-mono">
                        <span>{child.code || 'ASSET-NODE'}</span>
                        <span>{child.signalsCount ?? 0} signals linked</span>
                      </div>
                    </div>
                  );
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
                  <h2 className="text-[18px] font-extrabold text-[#111B37]">
                    {selectedResource.name}
                  </h2>
                  {(selectedResource.signalsCount ?? 0) > 0 ? (
                    <Badge variant={selectedStatus.variant}>{selectedStatus.label}</Badge>
                  ) : (
                    <span className="text-[10px] text-slate-400 font-medium px-2 py-0.5 rounded bg-slate-100">
                      NO SIGNALS
                    </span>
                  )}
                </div>
                <div className="text-[12px] font-mono text-[#657794] mt-1">
                  ID:{' '}
                  <span className="text-[#111B37] font-semibold">
                    {selectedResource.code || 'RES-01'}
                  </span>{' '}
                  · Type:{' '}
                  <span className="uppercase text-[#2A82E7] font-bold">{selectedResource.type}</span>
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
                  onClick={() =>
                    navigate(`/collector/add-data?resourceId=${selectedResource.id}`)
                  }
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
                      <span className="font-semibold text-[#111B37]">{String(v)}</span>
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
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">
                    Canonical Path
                  </span>
                  <p className="font-mono text-[#111B37] font-medium text-[12px] mt-0.5">
                    {canonicalPath}
                  </p>
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

      <AddResourceModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        parentId={selectedResource?.id || null}
        parentName={selectedResource?.name}
        parentPath={
          selectedResource ? `${selectedResource.code} · ${selectedResource.name}` : '(root)'
        }
        recommendedTypes={allowedTypesForSelected}
        onAddResource={handleCreateResource}
      />

      <ImportTopicsModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={() => window.location.reload()}
      />

      <MoveResourceModal
        isOpen={isMoveModalOpen}
        onClose={() => setIsMoveModalOpen(false)}
        selectedResource={selectedResource}
        allResources={resources}
        onMoveResource={handleMoveResource}
      />

      {moveToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-900 text-white shadow-2xl border border-slate-700 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-xs font-semibold">{moveToast.message}</span>
          {moveToast.linkTo && (
            <button
              type="button"
              onClick={() => {
                setMoveToast(null);
                navigate(moveToast.linkTo!);
              }}
              className="text-xs font-bold text-sky-300 hover:text-sky-200 underline ml-2"
            >
              Open Edges
            </button>
          )}
          {moveToast.undoParentId && (
            <button
              type="button"
              onClick={handleUndoMove}
              className="text-xs font-bold text-amber-400 hover:text-amber-300 underline ml-2"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
};
