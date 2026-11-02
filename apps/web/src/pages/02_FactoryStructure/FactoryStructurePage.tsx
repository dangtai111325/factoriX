import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Search,
  Activity,
  ArrowRightLeft,
  Copy,
  Archive,
  Layers,
  Pencil,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { useApp } from '../../store/AppContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ResourceNode, SignalItem } from '../../types';
import { AddResourceModal } from '../../components/modals/AddResourceModal';
import { EditResourceModal } from '../../components/modals/EditResourceModal';
import { MoveResourceModal } from '../../components/modals/MoveResourceModal';
import { translateApiError } from '../../utils/apiErrors';
import {
  addChildDisabledReason,
  allowedChildTypes,
  ancestorPath,
  buildResourceTree,
  childrenOf,
  filterResourcesWithAncestors,
  hasChildren,
  HierarchyTreeNode,
  mqttTopicToImportRows,
  pluralizeResources,
  typeAbbrev,
  typeDisplayLabel,
} from '../../utils/resourceHierarchy';

function qualityDot(
  resourceId: string,
  signals: Array<Pick<SignalItem, 'resourceId' | 'quality'>>,
): { color: string; label: string } | null {
  const related = signals.filter(
    (signal) => signal.resourceId === resourceId && signal.quality && signal.quality !== 'UNKNOWN',
  );
  if (!related.length) return null;
  if (related.some((signal) => signal.quality === 'BAD')) {
    return { color: 'bg-[#F2343B]', label: 'Bad data quality' };
  }
  if (related.some((signal) => signal.quality === 'STALE' || signal.quality === 'UNCERTAIN')) {
    return { color: 'bg-[#FFAA23]', label: 'Uncertain data quality' };
  }
  if (related.every((signal) => signal.quality === 'GOOD')) {
    return { color: 'bg-[#0DBA67]', label: 'Good data quality' };
  }
  return null;
}

function signalCountLabel(count: number): string {
  return count === 1 ? '1 signal' : `${count} signals`;
}

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
  rowRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  signals: Array<Pick<SignalItem, 'resourceId' | 'quality'>>;
}

const TreeRow: React.FC<TreeRowProps> = ({
  node,
  depth,
  selectedId,
  expandedNodes,
  onToggle,
  onSelect,
  onKeyNavigate,
  rowRefs,
  signals,
}) => {
  const { resource, children } = node;
  const isSelected = resource.id === selectedId;
  const hasKids = children.length > 0;
  const isExpanded = expandedNodes[resource.id] ?? true;
  const signalCount = resource.signalsCount ?? 0;
  const archived = resource.status === 'archived' || Boolean(resource.archivedAt);
  const quality = archived ? null : qualityDot(resource.id, signals);
  const fullName = resource.name;

  return (
    <>
      <div
        ref={(el) => {
          rowRefs.current.set(resource.id, el);
        }}
        role="treeitem"
        aria-level={depth + 1}
        aria-label={`${fullName}, ${typeDisplayLabel(resource.type)}${archived ? ', archived' : ''}`}
        aria-expanded={hasKids ? isExpanded : undefined}
        aria-selected={isSelected}
        tabIndex={isSelected ? 0 : -1}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={fullName}
        className={`flex items-center justify-between py-1.5 px-2 rounded-lg cursor-pointer text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#EF1B24]/40 ${
          isSelected
            ? 'bg-[#FFF0F1] text-[#EF1B24] font-bold border-l-2 border-[#EF1B24]'
            : 'text-[#334568] hover:bg-[#F1F5FA]'
        } ${archived ? 'opacity-60' : ''}`}
        onClick={() => onSelect(resource.id)}
        onKeyDown={(event) => onKeyNavigate(event, node)}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
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
              <span className="text-[10px] font-bold">{isExpanded ? '▼' : '▶'}</span>
            </button>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}
          <span className="text-[10px] font-bold tracking-wide text-[#657794] flex-shrink-0 w-9">
            {typeAbbrev(resource.type)}
          </span>
          {quality ? (
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${quality.color}`} title={quality.label} />
          ) : (
            <span className="w-1.5 h-1.5 flex-shrink-0" />
          )}
          <span className="truncate" title={fullName}>
            {fullName}
          </span>
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
              rowRefs={rowRefs}
              signals={signals}
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
    updateResource,
    moveResource,
    archiveResource,
    restoreResource,
    importResources,
    showArchivedResources,
    setShowArchivedResources,
    createResourceType,
  } = useApp();
  const [searchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [toast, setToast] = useState<{
    message: string;
    undo?: () => void;
    linkTo?: string;
  } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [expandedInitialized, setExpandedInitialized] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(searchParams.get('modal') === 'add');
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(searchParams.get('modal') === 'move');
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [treeWidth, setTreeWidth] = useState(280);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState('');
  const [importMqtt, setImportMqtt] = useState('');
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const keyboardFocus = useRef(false);
  const toastTimer = useRef<number | null>(null);
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

  useEffect(() => {
    if (!resources.length || expandedInitialized) return;
    const next: Record<string, boolean> = {};
    for (const r of resources) {
      if (hasChildren(resources, r.id)) next[r.id] = true;
    }
    setExpandedNodes(next);
    setExpandedInitialized(true);
  }, [resources, expandedInitialized]);

  useEffect(() => {
    const resourceId = searchParams.get('resourceId');
    if (resourceId && resources.some((item) => item.id === resourceId)) {
      setSelectedResourceId(resourceId);
    }
  }, [resources, searchParams, setSelectedResourceId]);

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

  useEffect(() => {
    if (!keyboardFocus.current || !selectedResourceId) return;
    keyboardFocus.current = false;
    rowRefs.current.get(selectedResourceId)?.focus({ preventScroll: true });
  }, [selectedResourceId]);

  const showToast = useCallback((message: string, undo?: () => void, linkTo?: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ message, undo, linkTo });
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 10000 : 5000);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedNodes((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  }, []);

  const selectedResource =
    resources.find((r) => r.id === selectedResourceId) || resources[0];
  const childResources = selectedResource ? childrenOf(resources, selectedResource.id) : [];
  const canArchive = selectedResource
    ? !hasChildren(resources, selectedResource.id) && selectedResource.status !== 'archived'
    : false;
  const isArchived =
    selectedResource?.status === 'archived' || Boolean(selectedResource?.archivedAt);
  const addDisabledReason = selectedResource
    ? addChildDisabledReason(selectedResource.type)
    : null;
  const recommendedChildTypes = selectedResource
    ? allowedChildTypes(selectedResource.type)
    : ['enterprise'];

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

  const parentLine = selectedResource?.parentId
    ? resources.find((r) => r.id === selectedResource.parentId)
    : undefined;

  const declaredAttributes = Object.entries(selectedResource?.attributes || {}).filter(
    ([key]) => key !== 'siteId' && key !== 'version',
  );

  const resourceActivities = useMemo(() => {
    if (!selectedResource) return [];
    return activities
      .filter((act) => {
        if (act.entityId === selectedResource.id) return true;
        if (act.entityType !== 'resource') return false;
        return (
          act.details?.id === selectedResource.id ||
          String(act.message || '').includes(selectedResource.code) ||
          String(act.message || '').includes(selectedResource.name)
        );
      })
      .slice(0, 8);
  }, [activities, selectedResource]);

  const handleCreateResource = async (data: {
    name: string;
    type: string;
    parentPath: string;
    description: string;
    properties: Record<string, string>;
    force?: boolean;
  }) => {
    setPageError(null);
    try {
      const result = await addResource({
        name: data.name,
        parentId: selectedResource?.id,
        type: data.type.toLowerCase() as ResourceNode['type'],
        description: data.description,
        attributes: data.properties,
        force: data.force,
      });
      if (result?.edgeCreated) {
        showToast(
          `Edge "${result.edgeName || 'new edge'}" was created and needs enrollment.`,
          undefined,
          '/acquisition/edges',
        );
      }
    } catch (caught) {
      throw new Error(translateApiError(caught));
    }
  };

  const handleEditSave = async (patch: {
    name: string;
    code: string;
    description: string;
    properties: Record<string, string>;
  }) => {
    if (!selectedResource) return;
    const res = await updateResource(selectedResource.id, patch);
    if (!res.success) throw new Error(translateApiError(res.error || 'Update failed'));
    showToast(`Saved “${patch.name}”`);
  };

  const handleMoveResource = async (targetParentId: string) => {
    if (!selectedResource) return { success: false, error: 'No resource selected.' };
    const oldParentId = selectedResource.parentId;
    const res = await moveResource(selectedResource.id, targetParentId);
    if (!res.success) {
      return { success: false, error: translateApiError(res.error || 'Move failed') };
    }
    setExpandedNodes((prev) => ({ ...prev, [targetParentId]: true }));
    showToast(`Moved “${selectedResource.name}”`, () => {
      if (oldParentId) void moveResource(selectedResource.id, oldParentId);
    });
    setPageError(null);
    return { success: true };
  };

  const handleConfirmArchive = async () => {
    if (!selectedResource) return;
    setArchiving(true);
    setPageError(null);
    const archived = selectedResource;
    const parentId = archived.parentId;
    const res = await archiveResource(archived.id);
    setArchiving(false);
    setArchiveConfirmOpen(false);
    if (!res.success) {
      setPageError(translateApiError(res.error || 'Archive failed'));
      return;
    }
    showToast(`Archived “${archived.name}”`, () => {
      void restoreResource(archived.id);
    });
    if (parentId) setSelectedResourceId(parentId);
  };

  const handleTreeKeyNavigate = useCallback(
    (event: React.KeyboardEvent, node: HierarchyTreeNode) => {
      const { resource, children } = node;
      const expanded = expandedNodes[resource.id] ?? true;
      const index = flatVisibleOrder.findIndex((n) => n.resource.id === resource.id);
      const moveFocus = (id?: string) => {
        if (!id) return;
        keyboardFocus.current = true;
        setSelectedResourceId(id);
      };

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (children.length && !expanded) toggleExpand(resource.id);
        else if (children.length && expanded) moveFocus(children[0].resource.id);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (children.length && expanded) toggleExpand(resource.id);
        else if (resource.parentId) moveFocus(resource.parentId);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveFocus(flatVisibleOrder[index + 1]?.resource.id);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(flatVisibleOrder[index - 1]?.resource.id);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        moveFocus(flatVisibleOrder[0]?.resource.id);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        moveFocus(flatVisibleOrder[flatVisibleOrder.length - 1]?.resource.id);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setSelectedResourceId(resource.id);
      }
    },
    [expandedNodes, flatVisibleOrder, setSelectedResourceId, toggleExpand],
  );

  const handleImport = async () => {
    const rows: Array<Record<string, string>> = [];
    if (importCsv.trim()) {
      const lines = importCsv.trim().split(/\r?\n/);
      const header = lines[0]?.toLowerCase() || '';
      const start = header.includes('code') ? 1 : 0;
      for (const line of lines.slice(start)) {
        const [code, name, type_key, parent_code] = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        if (!code) continue;
        rows.push({
          code,
          name: name || code,
          type_key: type_key || 'machine',
          parent_code: parent_code || '',
        });
      }
    }
    if (importMqtt.trim()) {
      rows.push(...mqttTopicToImportRows(importMqtt));
    }
    if (!rows.length) {
      setPageError('Provide CSV rows or an MQTT topic path such as uns/enterprise/site/#.');
      return;
    }
    const siteId = selectedResource?.attributes?.siteId;
    const res = await importResources(rows, { siteId });
    if (!res.success) {
      setPageError(translateApiError(res.error || 'Import failed'));
      return;
    }
    setImportOpen(false);
    setImportCsv('');
    setImportMqtt('');
    showToast(`Imported ${res.created || rows.length} resource(s)`);
  };

  if (!selectedResource) {
    return (
      <div className="space-y-4">
        <h1 className="fx-page-title">Factory Structure</h1>
        <p className="fx-page-subtitle">
          The model is empty. Create an enterprise, then a site, area, line and machine.
        </p>
        <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setIsAddModalOpen(true)}>
          Create enterprise
        </Button>
        <AddResourceModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          parentPath="(root)"
          recommendedTypes={['enterprise']}
          onAddResource={handleCreateResource}
          onCreateCustomType={async (input) => {
            await createResourceType({
              key: input.key,
              name: input.name,
              parent_type_keys: input.parentType ? [input.parentType] : [],
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Factory Structure</h1>
          <p className="fx-page-subtitle">
            Enterprise asset topology, functional locations, and resource hierarchy.
          </p>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="relative w-56">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#94A3B8]" />
            <input
              type="text"
              placeholder="Filter hierarchy..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="fx-input !pl-8 h-9 text-[13px]"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-[#657794] font-semibold cursor-pointer">
            <input
              type="checkbox"
              checked={showArchivedResources}
              onChange={(e) => setShowArchivedResources(e.target.checked)}
            />
            Show archived
          </label>
          <span title={addDisabledReason || undefined}>
            <Button
              variant="primary"
              icon={<Plus className="w-4 h-4" />}
              onClick={() => setIsAddModalOpen(true)}
              disabled={Boolean(addDisabledReason)}
            >
              Add Resource
            </Button>
          </span>
          <Button variant="secondary" icon={<Pencil className="w-4 h-4" />} onClick={() => setIsEditModalOpen(true)}>
            Edit
          </Button>
          <Button variant="secondary" icon={<ArrowRightLeft className="w-4 h-4" />} onClick={() => setIsMoveModalOpen(true)}>
            Move
          </Button>
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setImportOpen(true)}
          >
            Import
          </Button>
          <Button variant="secondary" icon={<Copy className="w-4 h-4" />} disabled title="Duplicate is not available in this appliance build">
            Duplicate
          </Button>
          {isArchived ? (
            <Button
              variant="secondary"
              icon={<RotateCcw className="w-4 h-4" />}
              onClick={() => void restoreResource(selectedResource.id).then((r) => {
                if (!r.success) setPageError(translateApiError(r.error || 'Restore failed'));
                else showToast(`Restored “${selectedResource.name}”`);
              })}
            >
              Restore
            </Button>
          ) : (
            <Button
              variant="secondary"
              icon={<Archive className="w-4 h-4" />}
              onClick={() => {
                if (!canArchive) {
                  setPageError('Archive child resources first.');
                  return;
                }
                setArchiveConfirmOpen(true);
              }}
              disabled={!canArchive}
              title={canArchive ? 'Archive this resource' : 'Archive child resources first'}
            >
              Archive
            </Button>
          )}
        </div>
      </div>

      {pageError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{pageError}</div>
      )}

      <div className="flex gap-3.5 items-stretch min-h-[760px]">
        <div style={{ width: treeWidth }} className="flex-shrink-0 relative">
          <Card className="h-full flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
                Hierarchy Tree
              </span>
              <span className="text-[11px] font-semibold text-[#657794]">
                {pluralizeResources(visibleResources.length)}
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
                    rowRefs={rowRefs}
                    signals={signals}
                  />
                ))
              )}
            </div>
          </Card>
          <div
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            onMouseDown={(event) => {
              event.preventDefault();
              const startX = event.clientX;
              const startWidth = treeWidth;
              const onMove = (ev: MouseEvent) => {
                setTreeWidth(Math.min(480, Math.max(200, startWidth + (ev.clientX - startX))));
              };
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
            className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-[#EF1B24]/30"
          />
        </div>

        <div className="w-[340px] flex-shrink-0">
          <Card className="h-full flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
                Child Units ({childResources.length})
              </span>
              <span title={addDisabledReason || undefined}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={() => setIsAddModalOpen(true)}
                  disabled={Boolean(addDisabledReason)}
                >
                  Add Child
                </Button>
              </span>
            </div>
            <div className="p-3 overflow-y-auto flex-1 space-y-2">
              {childResources.length === 0 ? (
                <div className="text-center py-12 text-[#94A3B8] text-[13px]">
                  No sub-resources under this unit.
                </div>
              ) : (
                childResources.map((child) => {
                  const childQuality =
                    child.status === 'archived' ? null : qualityDot(child.id, signals);
                  return (
                  <div
                    key={child.id}
                    onClick={() => setSelectedResourceId(child.id)}
                    className="p-3 rounded-xl border border-[#E3EAF3] hover:border-[#EF1B24] cursor-pointer bg-white transition-all shadow-sm"
                    title={child.name}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-bold text-[#657794]">{typeAbbrev(child.type)}</span>
                        {childQuality ? (
                          <span
                            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${childQuality.color}`}
                            title={childQuality.label}
                          />
                        ) : null}
                        <span className="text-[13px] font-bold text-[#111B37] truncate" title={child.name}>
                          {child.name}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-[#657794] font-mono">
                      <span className="truncate" title={child.code}>
                        {child.code || '—'}
                      </span>
                      <span>{signalCountLabel(child.signalsCount ?? 0)}</span>
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>

        <div className="flex-1 min-w-0 space-y-3.5">
          <Card className="p-4 overflow-visible">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-[18px] font-extrabold text-[#111B37] truncate" title={selectedResource.name}>
                    {selectedResource.name}
                  </h2>
                  <span className="text-[11px] font-bold uppercase tracking-wide text-[#2A82E7]">
                    {typeAbbrev(selectedResource.type)}
                  </span>
                  {isArchived && <Badge variant="neutral">ARCHIVED</Badge>}
                </div>
                <div className="text-[12px] font-mono text-[#657794] mt-1">
                  {selectedResource.code || '—'} · {typeDisplayLabel(selectedResource.type)}
                </div>
                {parentLine && (
                  <div className="text-[12px] text-[#657794] mt-1">
                    Parent:{' '}
                    <button
                      type="button"
                      className="font-semibold text-[#111B37] hover:underline"
                      onClick={() => setSelectedResourceId(parentLine.id)}
                    >
                      {parentLine.name}
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button size="sm" variant="secondary" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setIsEditModalOpen(true)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Activity className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/acquisition/add-data?resourceId=${selectedResource.id}`)}
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

            <Card title="Topology Context" className="h-[240px] overflow-visible">
              <div className="space-y-3 text-[12px]">
                <div>
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">Canonical Path</span>
                  <p className="font-mono text-[#111B37] font-medium text-[12px] mt-0.5 break-words" title={canonicalPath}>
                    {canonicalPath}
                  </p>
                </div>
                <div className="pt-2 border-t border-[#E3EAF3]">
                  <button
                    type="button"
                    className="text-[#2A82E7] font-semibold hover:underline"
                    onClick={() => navigate(`/acquisition/add-data?resourceId=${selectedResource.id}`)}
                  >
                    {`Signals ${selectedResource.signalsCount ?? 0} · Add signals`}
                  </button>
                </div>
                <div className="pt-2">
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

          <Card title="Change history">
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>By</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {resourceActivities.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-center text-[#94A3B8] text-[12px] py-6">
                        No history for this resource yet.
                      </td>
                    </tr>
                  ) : (
                    resourceActivities.map((act) => (
                      <tr key={act.id}>
                        <td className="font-mono text-[11px] text-[#94A3B8] whitespace-nowrap">
                          {act.timestamp}
                        </td>
                        <td className="text-[#657794] text-[12px]">{act.actorName || act.source || '—'}</td>
                        <td className="text-[#334568] text-[12px]">{act.message}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      <AddResourceModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        parentPath={
          selectedResource ? `${selectedResource.code} · ${selectedResource.name}` : '(root)'
        }
        parentType={selectedResource?.type}
        recommendedTypes={recommendedChildTypes}
        onAddResource={handleCreateResource}
        onCreateCustomType={async (input) => {
          await createResourceType({
            key: input.key,
            name: input.name,
            parent_type_keys: input.parentType ? [input.parentType] : [],
            child_type_keys: [],
          });
        }}
      />

      <EditResourceModal
        isOpen={isEditModalOpen}
        resource={selectedResource}
        onClose={() => setIsEditModalOpen(false)}
        onSave={handleEditSave}
      />

      <MoveResourceModal
        isOpen={isMoveModalOpen}
        onClose={() => setIsMoveModalOpen(false)}
        selectedResource={selectedResource}
        allResources={resources}
        onMoveResource={handleMoveResource}
      />

      <ConfirmDialog
        isOpen={archiveConfirmOpen}
        title="Archive resource?"
        message={`Archive “${selectedResource.name}”? You can undo for 10 seconds, or restore later from Show archived.`}
        confirmLabel="Archive"
        danger
        loading={archiving}
        onCancel={() => setArchiveConfirmOpen(false)}
        onConfirm={handleConfirmArchive}
      />

      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg p-5 space-y-4">
            <h3 className="text-base font-bold text-slate-900">Import resources</h3>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                CSV (code,name,type_key,parent_code)
              </label>
              <textarea
                rows={5}
                value={importCsv}
                onChange={(e) => setImportCsv(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono text-xs"
                placeholder={'ENT,TIPA,enterprise,\nDN,DongNai,site,ENT'}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Or MQTT topic path (uns/…/#)
              </label>
              <input
                type="text"
                value={importMqtt}
                onChange={(e) => setImportMqtt(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono text-xs"
                placeholder="uns/TIPA/DongNai/Assembly/Line04/CNC03/#"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setImportOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={() => void handleImport()}>
                Import
              </Button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-900 text-white shadow-2xl border border-slate-700">
          <span className="text-xs font-semibold">{toast.message}</span>
          {toast.linkTo && (
            <button
              type="button"
              onClick={() => {
                setToast(null);
                navigate(toast.linkTo!);
              }}
              className="text-xs font-bold text-sky-300 underline"
            >
              Open
            </button>
          )}
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
              className="text-xs font-bold text-amber-400 underline"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
};
