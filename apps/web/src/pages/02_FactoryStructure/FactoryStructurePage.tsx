import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  ChevronsDown,
  ChevronsUp,
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
  Edit2,
  Archive,
  Layers,
  Share2,
  UploadCloud,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ResourceNode } from '../../types';
import { AddResourceModal } from '../../components/modals/AddResourceModal';
import { EditResourceModal } from '../../components/modals/EditResourceModal';
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

function statusPresentation(status?: string, signalsCount?: number, liveGoodCount?: number): {
  label: string;
  variant: 'good' | 'warning' | 'error' | 'neutral';
} {
  const total = signalsCount ?? 0;
  if (total > 0) {
    if ((liveGoodCount ?? 0) > 0) {
      return { label: `ONLINE · ${liveGoodCount}/${total} SIGNALS`, variant: 'good' };
    }
    return { label: `OFFLINE · ${total} SIGNALS`, variant: 'error' };
  }
  const s = (status || '').toLowerCase();
  if (s === 'offline') return { label: 'OFFLINE', variant: 'error' };
  if (s === 'warning') return { label: 'WARNING', variant: 'warning' };
  return { label: 'ACTIVE', variant: 'neutral' };
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
  onSelectData?: (id: string) => void;
  onKeyNavigate: (event: React.KeyboardEvent, node: HierarchyTreeNode) => void;
}

const TreeRow: React.FC<TreeRowProps> = ({
  node,
  depth,
  selectedId,
  expandedNodes,
  onToggle,
  onSelect,
  onSelectData,
  onKeyNavigate,
}) => {
  const { resource, children } = node;
  const isSelected = resource.id === selectedId;
  const signalCount = resource.signalsCount ?? 0;
  const hasDirectData = signalCount > 0;
  const hasKids = children.length > 0 || hasDirectData;
  const isExpanded = expandedNodes[resource.id] ?? true;

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
      {isExpanded && (
        <div role="group">
          {/* Distinct Data Nav Child */}
          {hasDirectData && (
            <div
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
              className="flex items-center justify-between py-1 px-2 rounded-lg cursor-pointer text-[12px] transition-colors text-emerald-700 hover:bg-emerald-50/70"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(resource.id);
                if (onSelectData) onSelectData(resource.id);
              }}
            >
              <div className="flex items-center gap-2 truncate min-w-0">
                <Activity className="w-3.5 h-3.5 text-emerald-600 animate-pulse shrink-0" />
                <span className="truncate font-bold">
                  📊 Data
                </span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded font-extrabold bg-emerald-100 text-emerald-800">
                {signalCount}
              </span>
            </div>
          )}
          {children.map((child) => (
            <TreeRow
              key={child.resource.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              onSelect={onSelect}
              onSelectData={onSelectData}
              onKeyNavigate={onKeyNavigate}
            />
          ))}
        </div>
      )}
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
    refresh,
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
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(searchParams.get('modal') === 'move');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<'children' | 'telemetry'>('children');

  const handleExpandAll = () => {
    const next: Record<string, boolean> = {};
    for (const r of resources) {
      next[r.id] = true;
    }
    setExpandedNodes(next);
  };

  const handleCollapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const r of resources) {
      next[r.id] = false;
    }
    setExpandedNodes(next);
  };

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

  // Default-expand all parents whenever resources update
  useEffect(() => {
    if (!resources.length) return;
    setExpandedNodes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const r of resources) {
        if (hasChildren(resources, r.id) && next[r.id] !== false) {
          if (!next[r.id]) {
            next[r.id] = true;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [resources]);

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
  const selectedDirectSignals = signals.filter((s) => s.resourceId === selectedResource?.id);
  const selectedLiveGood = selectedDirectSignals.filter((s) => (s.quality || '').toLowerCase() === 'good').length;
  const selectedStatus = statusPresentation(selectedResource?.status, selectedDirectSignals.length, selectedLiveGood);

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
    ? allowedChildTypes(selectedResource.type)
    : ['enterprise'];

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
            icon={<Edit2 className="w-4 h-4" />}
            onClick={() => setIsEditModalOpen(true)}
            disabled={!selectedResource}
            title={selectedResource ? `Edit ${selectedResource.name}` : 'Select a resource to edit'}
          >
            Edit
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
          <Card className="h-[calc(100vh-210px)] min-h-[620px] flex flex-col p-0">
            <div className="px-3 py-2.5 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
                Hierarchy Tree
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleExpandAll}
                  title="Expand All"
                  className="px-1.5 py-0.5 rounded text-[11px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200/80 transition-colors flex items-center gap-0.5"
                >
                  <ChevronsDown className="w-3.5 h-3.5" />
                  <span>Expand</span>
                </button>
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  title="Collapse All"
                  className="px-1.5 py-0.5 rounded text-[11px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200/80 transition-colors flex items-center gap-0.5"
                >
                  <ChevronsUp className="w-3.5 h-3.5" />
                  <span>Collapse</span>
                </button>
                <span className="text-[11px] font-semibold text-[#657794] ml-1">
                  {visibleResources.length}
                </span>
              </div>
            </div>
            <div className="p-3 overflow-y-auto flex-1 min-h-0" role="tree" aria-label="Factory hierarchy">
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
                    onSelectData={(id) => {
                      setSelectedResourceId(id);
                      setRightPanelTab('telemetry');
                    }}
                    onKeyNavigate={handleTreeKeyNavigate}
                  />
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Region 4: Child Units & Real-time Telemetry Synchronization */}
        <div className="col-span-12 lg:col-span-4">
          <Card className="h-[calc(100vh-210px)] min-h-[620px] flex flex-col p-0">
            {/* Header Tabs: Sub-units vs Telemetry Data */}
            <div className="px-3 py-2.5 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              {(() => {
                const unitSignals = signals.filter((s) => s.resourceId === selectedResource.id);
                return (
                  <div className="flex items-center gap-1 bg-slate-200/70 p-0.5 rounded-lg">
                    {childResources.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setRightPanelTab('children')}
                        className={`px-2.5 py-1 text-xs font-bold rounded-md transition ${
                          rightPanelTab === 'children'
                            ? 'bg-white text-[#0B2545] shadow-xs'
                            : 'text-[#64748B] hover:text-[#0B2545]'
                        }`}
                      >
                        Sub-units ({childResources.length})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setRightPanelTab('telemetry')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-md transition ${
                        rightPanelTab === 'telemetry' || childResources.length === 0
                          ? 'bg-emerald-700 text-white shadow-xs'
                          : 'text-emerald-800 hover:bg-emerald-50'
                      }`}
                    >
                      <Activity className="w-3.5 h-3.5" />
                      <span>📊 Telemetry Data ({unitSignals.length})</span>
                    </button>
                  </div>
                );
              })()}

              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/collector/add-data?resourceId=${encodeURIComponent(selectedResource.id)}`)}
                >
                  Add Data
                </Button>
                {allowedTypesForSelected.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Plus className="w-3.5 h-3.5" />}
                    onClick={() => setIsAddModalOpen(true)}
                  >
                    Add Child
                  </Button>
                )}
              </div>
            </div>

            <div className="p-3 overflow-y-auto flex-1 min-h-0 space-y-2.5">
              {(() => {
                const unitSignals = signals.filter((s) => s.resourceId === selectedResource.id);
                const isTelemetryView = rightPanelTab === 'telemetry' || childResources.length === 0;

                if (isTelemetryView) {
                  if (unitSignals.length === 0) {
                    return (
                      <div className="text-center py-12 space-y-2">
                        <div className="text-[#94A3B8] text-[13px] font-medium">
                          No direct telemetry signals bound under {selectedResource.name}.
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate(`/collector/add-data?resourceId=${encodeURIComponent(selectedResource.id)}`)}
                        >
                          Bind Data / Signals
                        </Button>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-[#657794] px-1 flex items-center justify-between">
                        <span className="flex items-center gap-1.5">
                          <Activity className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                          <span>{selectedResource.name} Telemetry Tags ({unitSignals.length})</span>
                        </span>
                        <span className="font-mono text-emerald-600">● Live Stream</span>
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        {unitSignals.map((sig) => {
                          const isGood = sig.quality === 'GOOD';
                          const val = sig.value !== null && sig.value !== undefined ? sig.value : (sig.currentValue ?? '—');
                          return (
                            <div
                              key={sig.id}
                              className="p-2.5 rounded-xl border border-[#E3EAF3] bg-white hover:border-emerald-500 transition-all shadow-sm"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <div className="text-xs font-bold font-mono text-[#0B2545] truncate">
                                  {sig.key || sig.tag || sig.name}
                                </div>
                                <span
                                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded font-mono uppercase ${
                                    isGood ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'
                                  }`}
                                >
                                  {sig.quality || 'NO_DATA'}
                                </span>
                              </div>
                              <div className="flex items-baseline justify-between mt-1">
                                <div className="text-lg font-black font-mono text-[#0B2545]">
                                  {String(val)}
                                  {sig.unit && <span className="text-xs font-normal text-[#657794] ml-1">{sig.unit}</span>}
                                </div>
                                <div className="text-[10px] font-mono text-[#94A3B8] truncate max-w-[130px]">
                                  {sig.tag}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                }

                return childResources.map((child) => {
                  const childStatus = statusPresentation(child.status);
                  const childSignals = signals.filter((s) => s.resourceId === child.id);
                  const statusSig = childSignals.find((s) => s.tag === 'status');
                  return (
                    <div
                      key={child.id}
                      onClick={() => setSelectedResourceId(child.id)}
                      className="p-3 rounded-xl border border-[#E3EAF3] hover:border-[#134074] cursor-pointer bg-white transition-all shadow-sm space-y-2 group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          {getIconForType(child.type)}
                          <span className="text-[13px] font-bold text-[#111B37] group-hover:text-[#134074] truncate transition-colors">
                            {child.name}
                          </span>
                        </div>
                        {statusSig && statusSig.currentValue !== '—' && (statusSig.quality || '').toLowerCase() === 'good' ? (
                          <Badge variant="good">
                            {Number(statusSig.currentValue) === 2 ? 'RUNNING' : Number(statusSig.currentValue) === 0 ? 'IDLE' : 'ONLINE'}
                          </Badge>
                        ) : childSignals.length > 0 ? (
                          <Badge variant={childStatus.variant}>{childStatus.label}</Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between text-xs text-[#657794]">
                        <span className="font-mono text-[11px] uppercase bg-slate-100 px-1.5 py-0.2 rounded">
                          {child.type}
                        </span>
                        <span className="font-mono font-semibold text-emerald-700">
                          {childSignals.length} telemetry tags
                        </span>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </Card>
        </div>

        {/* Right Inspector: Details, Specification, Topology, Activity */}
        <div className="col-span-12 lg:col-span-5 space-y-3.5 h-[calc(100vh-210px)] min-h-[620px] overflow-y-auto pr-1">
          <Card className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[18px] font-extrabold text-[#111B37]">
                    {selectedResource.name}
                  </h2>
                  {(selectedResource.signalsCount ?? 0) > 0 ? (
                    <Badge variant={selectedStatus.variant}>
                      <span
                        className={`w-1.5 h-1.5 rounded-full mr-1 inline-block ${
                          selectedStatus.variant === 'good'
                            ? 'bg-emerald-500 animate-pulse'
                            : 'bg-red-500'
                        }`}
                      />
                      {selectedStatus.label}
                    </Badge>
                  ) : (
                    <Badge variant="good">ACTIVE</Badge>
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
                  icon={<Edit2 className="w-3.5 h-3.5" />}
                  onClick={() => setIsEditModalOpen(true)}
                >
                  Edit
                </Button>
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
                    icon={<Share2 className="w-3 h-3" />}
                    onClick={() => navigate(`/factory/graph?resourceId=${selectedResource.id}`)}
                  >
                    View in Graph
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

      <EditResourceModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        resource={selectedResource}
        onSuccess={async () => {
          await refresh();
          setMoveToast({ message: `Resource "${selectedResource?.name}" updated` });
          setTimeout(() => setMoveToast(null), 5000);
        }}
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
