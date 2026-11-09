import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  ChevronsDown,
  ChevronsUp,
  Search,
  ChevronRight,
  ChevronDown,
  Activity,
  ArrowRightLeft,
  Edit2,
  Archive,
  ArchiveRestore,
  Share2,
  UploadCloud,
  MoreHorizontal,
  RefreshCw,
  X,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge, BadgeVariant } from '../../components/common/Badge';
import { MenuButton } from '../../components/common/MenuButton';
import { ResourceTypeIcon, resourceTypeLabel } from '../../components/common/ResourceTypeIcon';
import { useApp } from '../../store/AppContext';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { useAuth } from '../../features/auth';
import { ApiError, api } from '../../api/client';
import { ResourceNode, SignalItem } from '../../types';
import { AddResourceModal, NewResourceInput } from '../../components/modals/AddResourceModal';
import { EditResourceModal } from '../../components/modals/EditResourceModal';
import { MoveResourceModal } from '../../components/modals/MoveResourceModal';
import { ImportTopicsModal } from '../../components/modals/ImportTopicsModal';
import { ArchiveResourceModal } from '../../components/modals/ArchiveResourceModal';
import { translateApiError } from '../../utils/apiErrors';
import { AuditRow, describeAudit } from '../../utils/auditText';
import { formatTimestamp, formatValue, normalizeQuality, QUALITY_HINT, QUALITY_LABEL, timeAgo } from '../../lib/format';
import { ActionToast, ToastSpec, useActionToast } from '../../components/common/ActionToast';
import { ImpactModel, archiveResourceWithModels } from '../../lib/impactApi';
import { useConnectivity } from '../../lib/connectivity';
import {
  allowedChildTypes,
  ancestorPath,
  buildResourceTree,
  childrenOf,
  filterResourcesWithAncestors,
  hasChildren,
  HierarchyTreeNode,
} from '../../utils/resourceHierarchy';

/**
 * Summary of the data bound directly to a resource, from the live signal qualities.
 * Paused (connection paused) and disabled signals are neutral: they are not problems (R3-CN-02).
 * While the appliance cannot be reached the status is unknown, not "no good data" (R3-OV-01).
 */
function dataStatus(signals: SignalItem[]): { label: string; variant: BadgeVariant } {
  const total = signals.length;
  if (total === 0) return { label: 'No data bound', variant: 'neutral' };
  const qualities = signals.map((s) => normalizeQuality(s.quality));
  const noun = total === 1 ? 'signal' : 'signals';
  if (qualities.some((q) => q === 'NO_CONNECTION')) {
    return { label: `Unknown · no connection to appliance · ${total} ${noun}`, variant: 'neutral' };
  }
  const paused = qualities.filter((q) => q === 'PAUSED').length;
  const disabled = qualities.filter((q) => q === 'DISABLED').length;
  const active = total - paused - disabled;
  const good = qualities.filter((q) => q === 'GOOD').length;
  const reporting = signals.filter((s, i) => Boolean(s.lastUpdated) && qualities[i] !== 'PAUSED' && qualities[i] !== 'DISABLED').length;
  const inactive = [paused ? `${paused} paused` : '', disabled ? `${disabled} disabled` : ''].filter(Boolean).join(', ');
  const suffix = inactive ? ` · ${inactive}` : '';
  if (active === 0) return { label: paused ? `Paused · ${total} ${noun}` : `Disabled · ${total} ${noun}`, variant: 'neutral' };
  const activeNoun = active === 1 ? 'signal' : 'signals';
  if (good === active) return { label: `Receiving data · ${active} ${activeNoun}${suffix}`, variant: 'good' };
  if (good > 0) return { label: `${good} of ${active} ${activeNoun} good${suffix}`, variant: 'warning' };
  if (reporting === 0) return { label: `Waiting for data · ${active} ${activeNoun}${suffix}`, variant: 'neutral' };
  return { label: `No good data · ${active} ${activeNoun}${suffix}`, variant: 'error' };
}

/** Quality chip colours: neutral gray for states that are not data problems. */
function qualityChipClass(quality: ReturnType<typeof normalizeQuality>): string {
  if (quality === 'GOOD') return 'bg-emerald-50 text-emerald-700';
  if (quality === 'UNCERTAIN') return 'bg-amber-50 text-amber-700';
  if (quality === 'NO_DATA' || quality === 'DISABLED' || quality === 'PAUSED' || quality === 'NO_CONNECTION') {
    return 'bg-slate-100 text-slate-600';
  }
  if (quality === 'STALE') return 'bg-slate-100 text-slate-700';
  return 'bg-red-50 text-red-700';
}

/** Fill missing childrenCount / signalsCount from the loaded lists. */
function enrichResourceCounts(resources: ResourceNode[], signals: Array<{ resourceId: string }>): ResourceNode[] {
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

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

async function fetchArchivedResources(): Promise<ResourceNode[]> {
  const result: ResourceNode[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const query: string = `/api/v1/resources?view=all&include_archived=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res: { items?: Array<Record<string, unknown>>; next_cursor?: string | null } = await api(query);
    for (const row of res.items || []) {
      if (!row.archived_at) continue;
      result.push({
        id: text(row.id),
        name: text(row.name),
        code: text(row.code),
        type: text(row.type_key) as ResourceNode['type'],
        status: 'offline',
        parentId: row.parent_id ? text(row.parent_id) : undefined,
        attributes: { siteId: text(row.site_id), version: text(row.version || 1), archivedAt: text(row.archived_at) },
      });
    }
    cursor = res.next_cursor || null;
    if (!cursor) break;
  }
  return result;
}

interface ResourceDetail {
  description?: string | null;
  properties_json?: Record<string, unknown> | null;
}

interface TreeRowProps {
  node: HierarchyTreeNode;
  depth: number;
  selectedId: string;
  archivedIds: Set<string>;
  restoringId: string | null;
  expandedNodes: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onSelectData: (id: string) => void;
  onRestore: (resource: ResourceNode) => void;
  onKeyNavigate: (event: React.KeyboardEvent, node: HierarchyTreeNode) => void;
}

const TreeRow: React.FC<TreeRowProps> = ({
  node,
  depth,
  selectedId,
  archivedIds,
  restoringId,
  expandedNodes,
  onToggle,
  onSelect,
  onSelectData,
  onRestore,
  onKeyNavigate,
}) => {
  const { resource, children } = node;
  const archived = archivedIds.has(resource.id);
  const isSelected = !archived && resource.id === selectedId;
  const signalCount = archived ? 0 : resource.signalsCount ?? 0;
  const hasDirectData = signalCount > 0;
  const hasKids = children.length > 0 || hasDirectData;
  const isExpanded = expandedNodes[resource.id] ?? true;
  const typeLabel = resourceTypeLabel(resource.type);

  return (
    <>
      <div
        role="treeitem"
        aria-label={
          archived
            ? `${resource.name}, ${typeLabel}, archived`
            : `${resource.name}, ${typeLabel}${signalCount ? `, ${signalCount} signals` : ''}`
        }
        aria-level={depth + 1}
        aria-expanded={hasKids ? isExpanded : undefined}
        aria-selected={isSelected}
        data-archived={archived || undefined}
        tabIndex={isSelected ? 0 : -1}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={`group flex items-center justify-between py-1.5 pr-2 rounded-lg text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#EF1B24]/40 ${
          archived
            ? 'text-[#94A3B8] cursor-default'
            : isSelected
              ? 'bg-[#FFF0F1] text-[#C8151D] font-semibold cursor-pointer'
              : 'text-[#334568] hover:bg-[#F1F5FA] cursor-pointer'
        }`}
        onClick={() => {
          if (!archived) onSelect(resource.id);
        }}
        onKeyDown={(event) => {
          if (!archived) onKeyNavigate(event, node);
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {hasKids ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={isExpanded ? `Collapse ${resource.name}` : `Expand ${resource.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(resource.id);
              }}
              className="p-0.5 text-[#94A3B8] hover:text-[#111B37] flex-shrink-0"
            >
              {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          ) : (
            <span className="w-[18px] flex-shrink-0" />
          )}
          <span className={isSelected ? 'text-current' : archived ? 'text-[#B6C2D3]' : 'text-[#7A8AA3]'}>
            {archived ? <Archive className="w-3.5 h-3.5" aria-hidden="true" /> : <ResourceTypeIcon type={resource.type} />}
          </span>
          {/* R3-HS-03: an archived row keeps its name (muted, italic); the tooltip says it is archived. */}
          <span
            className={`truncate ${archived ? 'italic text-[#8A9AB2] min-w-[3rem]' : ''}`}
            title={archived ? `${resource.name} (${typeLabel.toLowerCase()}, archived${resource.code ? ` · ${resource.code}` : ''})` : resource.name}
          >
            {resource.name}
          </span>
        </div>
        {archived ? (
          <span className="flex items-center gap-1.5 ml-2 flex-shrink-0">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (restoringId !== resource.id) onRestore(resource);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              aria-busy={restoringId === resource.id || undefined}
              aria-label={`Restore ${resource.name}`}
              title={`Restore "${resource.name}" and its contents to the active hierarchy`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-[#D4DFEC] bg-white text-[11px] font-semibold text-[#334568] hover:text-[#111B37] hover:bg-[#F1F5FA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EF1B24]/40"
            >
              <ArchiveRestore className={`w-3.5 h-3.5 ${restoringId === resource.id ? 'animate-pulse' : ''}`} aria-hidden="true" />
              {restoringId === resource.id ? 'Restoring…' : 'Restore'}
            </button>
          </span>
        ) : signalCount > 0 ? (
          <span
            className="text-[11px] font-mono text-[#94A3B8] ml-2 flex-shrink-0"
            title={`${signalCount} ${signalCount === 1 ? 'signal' : 'signals'}`}
            aria-hidden="true"
          >
            {signalCount}
          </span>
        ) : null}
      </div>
      {isExpanded && (
        <div role="group">
          {hasDirectData && (
            <div
              role="treeitem"
              aria-level={depth + 2}
              aria-selected={false}
              aria-label={`Signals of ${resource.name}, ${signalCount} ${signalCount === 1 ? 'signal' : 'signals'}`}
              tabIndex={-1}
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
              className="flex items-center justify-between py-1 pr-2 rounded-lg cursor-pointer text-[12px] transition-colors text-emerald-700 hover:bg-emerald-50/70 outline-none focus-visible:ring-2 focus-visible:ring-[#EF1B24]/40"
              title={`Signals of ${resource.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectData(resource.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectData(resource.id);
                }
              }}
            >
              <div className="flex items-center gap-2 truncate min-w-0 pl-[22px]">
                <Activity className="w-3.5 h-3.5 text-emerald-600 animate-pulse shrink-0" aria-hidden="true" />
                <span className="truncate font-semibold">Signals</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 rounded font-bold bg-emerald-100 text-emerald-800" aria-hidden="true">
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
              archivedIds={archivedIds}
              restoringId={restoringId}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              onSelect={onSelect}
              onSelectData={onSelectData}
              onRestore={onRestore}
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
    connections,
    selectedResourceId,
    setSelectedResourceId,
    addResource,
    moveResource,
    refresh,
    loadState,
  } = useApp();
  const { state: authState } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [searchTerm, setSearchTerm] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [rightPanelTab, setRightPanelTab] = useState<'children' | 'telemetry'>('children');

  const [isAddModalOpen, setIsAddModalOpen] = useState(searchParams.get('modal') === 'add');
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(searchParams.get('modal') === 'move');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ResourceNode | null>(null);

  const [showArchived, setShowArchived] = useState(false);
  const [archivedResources, setArchivedResources] = useState<ResourceNode[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // R3-HS-01: shared toast. An Undo toast stays at least 15 s, pauses on hover / focus, and its
  // action is a keyboard-reachable button (also Ctrl+Z).
  // Dismissal is per toast id: an Undo that shows a result toast keeps that toast.
  const { toast, show: showToastSpec, dismiss: dismissToast } = useActionToast();

  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditState, setAuditState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [historyTick, setHistoryTick] = useState(0);

  const resources = useMemo(() => enrichResourceCounts(rawResources, signals), [rawResources, signals]);

  const showToast = useCallback((next: ToastSpec) => showToastSpec(next), [showToastSpec]);
  // One restore at a time per resource (in-flight guard for the Restore buttons and Undo).
  const restoringRef = useRef(new Set<string>());

  const reloadArchived = useCallback(async () => {
    try {
      setArchivedResources(await fetchArchivedResources());
    } catch (caught) {
      setPageError(`Archived resources could not be loaded: ${translateApiError(caught)}`);
    }
  }, []);

  useEffect(() => {
    if (showArchived) void reloadArchived();
  }, [showArchived, reloadArchived]);

  const safeRefresh = useCallback(async () => {
    try {
      await refresh();
    } catch (caught) {
      setPageError(`The model could not be reloaded: ${translateApiError(caught)}`);
    }
  }, [refresh]);

  // Archived resources the active model no longer lists (a restore makes them active again).
  const visibleArchived = useMemo(() => {
    if (!showArchived) return [];
    const activeIds = new Set(resources.map((item) => item.id));
    return archivedResources.filter((item) => !activeIds.has(item.id));
  }, [showArchived, archivedResources, resources]);
  const archivedIds = useMemo(() => new Set(visibleArchived.map((item) => item.id)), [visibleArchived]);

  const treeSource = useMemo(() => [...resources, ...visibleArchived], [resources, visibleArchived]);
  const visibleResources = useMemo(() => filterResourcesWithAncestors(treeSource, searchTerm), [treeSource, searchTerm]);
  const tree = useMemo(() => buildResourceTree(visibleResources), [visibleResources]);

  const flatVisibleOrder = useMemo(() => {
    const order: HierarchyTreeNode[] = [];
    const walk = (nodes: HierarchyTreeNode[]) => {
      for (const node of nodes) {
        if (!archivedIds.has(node.resource.id)) order.push(node);
        const expanded = expandedNodes[node.resource.id] ?? true;
        if (expanded && node.children.length) walk(node.children);
      }
    };
    walk(tree);
    return order;
  }, [tree, expandedNodes, archivedIds]);

  // Apply a deep link (?resourceId=) once per link, not on every data refresh.
  const appliedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    const resourceId = searchParams.get('resourceId');
    if (!resourceId || appliedDeepLink.current === resourceId) return;
    if (resources.some((item) => item.id === resourceId)) {
      appliedDeepLink.current = resourceId;
      setSelectedResourceId(resourceId);
    }
  }, [resources, searchParams, setSelectedResourceId]);

  const selectedResource = resources.find((r) => r.id === selectedResourceId) || resources[0];
  const selectedId = selectedResource?.id || '';

  // Keep ancestors of the selected node expanded so it stays visible.
  useEffect(() => {
    if (!selectedId) return;
    const path = ancestorPath(resources, selectedId);
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
  }, [selectedId, resources]);

  // While filtering, keep ancestors expanded.
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

  const setAllExpanded = (value: boolean) => {
    const next: Record<string, boolean> = {};
    for (const r of treeSource) next[r.id] = value;
    setExpandedNodes(next);
  };

  const childResources = useMemo(
    () => (selectedResource ? childrenOf(resources, selectedResource.id) : []),
    [resources, selectedResource],
  );
  const selectedSignals = useMemo(
    () => signals.filter((s) => s.resourceId === selectedId),
    [signals, selectedId],
  );
  const selectedStatus = dataStatus(selectedSignals);

  // Default tab per selected resource: its children when it has any, otherwise its signals.
  // Evaluated when the selection changes only, so a data refresh never switches the user's tab.
  const hasChildResourcesRef = useRef(false);
  hasChildResourcesRef.current = childResources.length > 0;
  const requestedTabRef = useRef<'children' | 'telemetry' | null>(null);
  useEffect(() => {
    const requested = requestedTabRef.current;
    requestedTabRef.current = null;
    setRightPanelTab(requested || (hasChildResourcesRef.current ? 'children' : 'telemetry'));
  }, [selectedId]);

  // "Add resource" adds under the selection; for leaf types (e.g. a machine) it adds a sibling under
  // the nearest ancestor that can hold children.
  const defaultAddParentId = useMemo(() => {
    if (!selectedResource) return null;
    const byId = new Map(resources.map((item) => [item.id, item]));
    let cursor: ResourceNode | undefined = selectedResource;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (allowedChildTypes(cursor.type).length > 0) return cursor.id;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return selectedResource.id;
  }, [resources, selectedResource]);
  const defaultAddParentName = resources.find((item) => item.id === defaultAddParentId)?.name || '';

  const breadcrumb = useMemo(() => {
    if (!selectedResource) return [] as ResourceNode[];
    const byId = new Map(resources.map((item) => [item.id, item]));
    return ancestorPath(resources, selectedResource.id)
      .map((id) => byId.get(id))
      .filter(Boolean) as ResourceNode[];
  }, [resources, selectedResource]);

  // Change log and details of the selected resource. Reloaded when the resource changes
  // (version bump), when its signal count changes, or after an action on this page.
  const selectedVersion = selectedResource?.attributes?.version || '';
  const selectedSignalCount = selectedSignals.length;
  useEffect(() => {
    if (!selectedId) {
      setAuditRows([]);
      setDetail(null);
      return;
    }
    let active = true;
    setAuditState('loading');
    Promise.all([
      api<{ items?: AuditRow[] }>(`/api/v1/audit-events?entity_id=${encodeURIComponent(selectedId)}&limit=25`),
      api<ResourceDetail>(`/api/v1/resources/${encodeURIComponent(selectedId)}`),
    ])
      .then(([page, row]) => {
        if (!active) return;
        setAuditRows(page.items || []);
        setDetail(row);
        setAuditState('idle');
      })
      .catch((caught) => {
        if (!active) return;
        console.warn('Resource history could not be loaded', caught);
        setAuditState('error');
      });
    return () => {
      active = false;
    };
  }, [selectedId, selectedVersion, selectedSignalCount, historyTick]);

  const nameLookup = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of [...resources, ...archivedResources]) names.set(item.id, item.name);
    for (const item of connections) names.set(item.id, item.name);
    if (selectedId) names.set(selectedId, 'this resource');
    return names;
  }, [resources, archivedResources, connections, selectedId]);

  const currentActorId = authState.status === 'authenticated' ? authState.user.admin_id : undefined;
  const historyItems = useMemo(
    () =>
      auditRows.map((row) => ({
        row,
        text: describeAudit(row, { names: nameLookup, currentActorId, currentActorName: 'You' }),
      })),
    [auditRows, nameLookup, currentActorId],
  );

  const declaredProperties = Object.entries(detail?.properties_json || {}).filter(([key]) => !key.startsWith('_'));

  // ---- actions ----

  const handleCreateResource = async (input: NewResourceInput) => {
    setPageError(null);
    await addResource({
      name: input.name,
      code: input.code,
      parentId: input.parent_id || undefined,
      type: input.type.toLowerCase() as ResourceNode['type'],
      description: input.description,
    });
    if (input.parent_id) setExpandedNodes((prev) => ({ ...prev, [input.parent_id as string]: true }));
    showToast({ message: `Added "${input.name}"`, tone: 'info' });
  };

  const handleMoveResource = async (targetParentId: string) => {
    if (!selectedResource) return { success: false, error: 'No resource selected.' };
    const moved = selectedResource;
    const oldParentId = moved.parentId;
    const res = await moveResource(moved.id, targetParentId);
    if (!res.success) return { success: false, error: translateApiError(res.error || 'Move failed') };
    setExpandedNodes((prev) => ({ ...prev, [targetParentId]: true }));
    setPageError(null);
    const newParent = resources.find((item) => item.id === targetParentId);
    showToast({
      message: `Moved "${moved.name}"${newParent ? ` under ${newParent.name}` : ''}`,
      tone: 'info',
      action: oldParentId
        ? {
            label: 'Undo',
            run: async () => {
              const undo = await moveResource(moved.id, oldParentId);
              if (undo.success) {
                showToast({ message: `Moved "${moved.name}" back`, tone: 'info' });
              } else {
                showToast({ message: `Undo failed: ${translateApiError(undo.error || 'Move failed')}`, tone: 'error' });
              }
            },
          }
        : undefined,
    });
    return { success: true };
  };

  const restoreResource = useCallback(
    async (target: ResourceNode, archivedModels: ImpactModel[] = []) => {
      if (restoringRef.current.has(target.id)) return;
      restoringRef.current.add(target.id);
      setRestoringId(target.id);
      try {
        await api(`/api/v1/resources/${encodeURIComponent(target.id)}/restore`, { method: 'POST' });
        await safeRefresh();
        if (showArchived) await reloadArchived();
        setSelectedResourceId(target.id);
        setHistoryTick((value) => value + 1);
        // The Center has no restore for data models: models archived together stay archived.
        const kept = archivedModels.length;
        showToast({
          message: kept
            ? `Restored "${target.name}". ${kept === 1 ? 'The data model archived with it stays' : `The ${kept} data models archived with it stay`} archived.`
            : `Restored "${target.name}"`,
          tone: 'info',
        });
      } catch (caught) {
        let message = translateApiError(caught);
        if (caught instanceof ApiError && caught.code === 'ARCHIVED_PARENT') {
          const parent = archivedResources.find((item) => item.id === target.parentId);
          message = parent
            ? `Restore "${parent.name}" first; "${target.name}" is inside it.`
            : `The parent of "${target.name}" is archived. Restore the parent first.`;
        }
        showToast({ message: `Could not restore "${target.name}". ${message}`, tone: 'error' });
      } finally {
        restoringRef.current.delete(target.id);
        setRestoringId(null);
      }
    },
    [archivedResources, reloadArchived, safeRefresh, setSelectedResourceId, showArchived, showToast],
  );

  const confirmArchive = async (options: {
    archiveModels: boolean;
    models: ImpactModel[];
  }): Promise<{ success: boolean; error?: string }> => {
    const target = archiveTarget;
    if (!target) return { success: false, error: 'No resource selected.' };
    const affected = signals.filter((s) => s.resourceId === target.id).length;
    let archivedModels: ImpactModel[] = [];
    try {
      const result = await archiveResourceWithModels(target.id, options.archiveModels, options.models);
      const ids = new Set(result.archivedModelIds);
      archivedModels = options.models.filter((model) => ids.has(model.id));
    } catch (caught) {
      return { success: false, error: translateApiError(caught) };
    }
    await safeRefresh();
    if (showArchived) await reloadArchived();
    // Keep the user in context: select the parent of the archived resource.
    setSelectedResourceId(target.parentId || '');
    setPageError(null);
    const keptModels = options.models.length - archivedModels.length;
    const parts = [
      affected ? `${affected} ${affected === 1 ? 'signal' : 'signals'} stopped` : '',
      archivedModels.length ? `${archivedModels.length} data ${archivedModels.length === 1 ? 'model' : 'models'} archived` : '',
      keptModels > 0 ? `${keptModels} data ${keptModels === 1 ? 'model receives' : 'models receive'} no new values` : '',
    ].filter(Boolean);
    showToast({
      message: `Archived "${target.name}"${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
      tone: 'info',
      action: { label: 'Undo', run: () => restoreResource(target, archivedModels) },
    });
    return { success: true };
  };

  const handleTreeKeyNavigate = useCallback(
    (event: React.KeyboardEvent, node: HierarchyTreeNode) => {
      const { resource, children } = node;
      const expanded = expandedNodes[resource.id] ?? true;
      const index = flatVisibleOrder.findIndex((n) => n.resource.id === resource.id);
      const focusRow = (id: string) => {
        setSelectedResourceId(id);
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')?.focus();
        });
      };

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (children.length && !expanded) toggleExpand(resource.id);
        else if (children.length && expanded) focusRow(children[0].resource.id);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (children.length && expanded) toggleExpand(resource.id);
        else if (resource.parentId) focusRow(resource.parentId);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = flatVisibleOrder[index + 1];
        if (next) focusRow(next.resource.id);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = flatVisibleOrder[index - 1];
        if (prev) focusRow(prev.resource.id);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setSelectedResourceId(resource.id);
        return;
      }
      // Shortcuts (WAI-ARIA tree pattern + actions on the focused resource).
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const target = event.key === 'Home' ? flatVisibleOrder[0] : flatVisibleOrder[flatVisibleOrder.length - 1];
        if (target) focusRow(target.resource.id);
        return;
      }
      if (event.key === '*') {
        // Expand every sibling on this level that has children.
        event.preventDefault();
        const siblings = treeSource.filter((item) => (item.parentId || '') === (resource.parentId || '') && !archivedIds.has(item.id));
        setExpandedNodes((prev) => {
          const next = { ...prev };
          for (const item of siblings) if (hasChildren(treeSource, item.id)) next[item.id] = true;
          return next;
        });
        return;
      }
      if (event.key === 'F2') {
        event.preventDefault();
        setSelectedResourceId(resource.id);
        setIsEditModalOpen(true);
        return;
      }
      if (event.key === 'Delete') {
        // Opens the confirmation dialog; nothing is archived without it.
        event.preventDefault();
        setSelectedResourceId(resource.id);
        setArchiveTarget(resource);
        return;
      }
      if (event.key === 'Insert' || (event.key.toLowerCase() === 'n' && event.altKey)) {
        event.preventDefault();
        setSelectedResourceId(resource.id);
        setIsAddModalOpen(true);
        return;
      }
      // Type-ahead: a letter or digit moves to the next visible resource whose name starts with it.
      if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const char = event.key.toLocaleLowerCase();
        const count = flatVisibleOrder.length;
        for (let step = 1; step <= count; step += 1) {
          const candidate = flatVisibleOrder[(index + step) % count];
          if (candidate.resource.name.trim().toLocaleLowerCase().startsWith(char)) {
            event.preventDefault();
            focusRow(candidate.resource.id);
            return;
          }
        }
      }
    },
    [archivedIds, expandedNodes, flatVisibleOrder, setSelectedResourceId, toggleExpand, treeSource],
  );

  const goToAddData = () => {
    if (selectedResource) navigate(`/collector/add-data?resourceId=${encodeURIComponent(selectedResource.id)}`);
  };

  const toastView = <ActionToast toast={toast} onDismiss={dismissToast} />;

  if (!selectedResource && loadState !== 'ready') {
    // Never show the "empty" onboarding while the model is loading or could not be loaded.
    return (
      <div className="space-y-4">
        <div>
          <h1 className="fx-page-title">Hierarchy Structure</h1>
          <p className="fx-page-subtitle">Sites, areas, lines and machines of the factory, and the data bound to them.</p>
        </div>
        <Card className="border border-[#E3EAF3]">
          <LoadStateNotice subject="the factory model" />
        </Card>
        {toastView}
      </div>
    );
  }

  if (!selectedResource) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="fx-page-title">Hierarchy Structure</h1>
          <p className="fx-page-subtitle">
            The factory model is empty. Start with an enterprise, then add its sites, areas, lines and machines.
          </p>
        </div>
        {pageError && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {pageError}
          </p>
        )}
        <div className="flex items-center gap-2.5">
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setIsAddModalOpen(true)}>
            Add enterprise
          </Button>
          <Button variant="secondary" icon={<UploadCloud className="w-4 h-4" />} onClick={() => setIsImportModalOpen(true)}>
            Import from MQTT topics
          </Button>
        </div>
        <AddResourceModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          resources={resources}
          defaultParentId={null}
          onAddResource={handleCreateResource}
        />
        <ImportTopicsModal
          isOpen={isImportModalOpen}
          onClose={() => setIsImportModalOpen(false)}
          onSuccess={async (count) => {
            await safeRefresh();
            showToast({ message: `Imported ${count} ${count === 1 ? 'resource' : 'resources'}`, tone: 'info' });
          }}
        />
        {toastView}
      </div>
    );
  }

  const unitSignals = selectedSignals;
  const isTelemetryView = rightPanelTab === 'telemetry';
  const lastUpdate = unitSignals.reduce<string>(
    (latest, s) => (s.lastUpdated && (!latest || s.lastUpdated > latest) ? s.lastUpdated : latest),
    '',
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Heading and page toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="fx-page-title">Hierarchy Structure</h1>
          <p className="fx-page-subtitle">Sites, areas, lines and machines of the factory, and the data bound to them.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap w-full sm:w-auto">
          <div className="relative w-full sm:w-56">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#94A3B8]" aria-hidden="true" />
            <input
              type="search"
              aria-label="Filter the hierarchy by name or code"
              placeholder="Filter by name or code"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="fx-input !pl-9 h-9 text-[13px]"
            />
          </div>
          <Button
            variant="primary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => setIsAddModalOpen(true)}
            className="whitespace-nowrap"
            title={defaultAddParentName ? `Add a resource under ${defaultAddParentName}` : 'Add a resource'}
          >
            Add resource
          </Button>
          <MenuButton
            label="More"
            ariaLabel="More hierarchy actions"
            icon={<MoreHorizontal className="w-4 h-4" />}
            items={[
              {
                key: 'import',
                label: 'Import from MQTT topics…',
                icon: <UploadCloud className="w-4 h-4" />,
                onSelect: () => setIsImportModalOpen(true),
              },
              {
                key: 'refresh',
                label: 'Reload model',
                icon: <RefreshCw className="w-4 h-4" />,
                onSelect: () => {
                  void safeRefresh();
                  if (showArchived) void reloadArchived();
                  setHistoryTick((value) => value + 1);
                },
              },
            ]}
          />
        </div>
      </div>

      {pageError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-start justify-between gap-3">
          <span>{pageError}</span>
          <button type="button" onClick={() => setPageError(null)} aria-label="Dismiss error" className="text-red-500 hover:text-red-700">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-12 gap-3.5">
        {/* Hierarchy tree */}
        <div className="col-span-12 lg:col-span-3 min-w-0">
          <Card className="h-[420px] lg:h-[calc(100vh-210px)] lg:min-h-[620px] flex flex-col p-0">
            <div className="px-3 py-2 border-b border-[#E3EAF3] flex items-center justify-between gap-2 bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">Hierarchy</span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setAllExpanded(true)}
                  title="Expand all"
                  aria-label="Expand all"
                  className="p-1 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-200/80 transition-colors"
                >
                  <ChevronsDown className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setAllExpanded(false)}
                  title="Collapse all"
                  aria-label="Collapse all"
                  className="p-1 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-200/80 transition-colors"
                >
                  <ChevronsUp className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] font-semibold text-[#657794] ml-1 tabular-nums" title="Resources shown">
                  {visibleResources.filter((item) => !archivedIds.has(item.id)).length}
                </span>
              </div>
            </div>
            <div
              className="p-2 overflow-y-auto flex-1 min-h-0"
              role="tree"
              aria-label="Factory hierarchy"
              aria-describedby="hierarchy-tree-keys"
            >
              {tree.length === 0 ? (
                <div className="text-center py-8 text-[#94A3B8] text-[13px]">No resource matches “{searchTerm}”.</div>
              ) : (
                tree.map((node) => (
                  <TreeRow
                    key={node.resource.id}
                    node={node}
                    depth={0}
                    selectedId={selectedId}
                    archivedIds={archivedIds}
                    restoringId={restoringId}
                    expandedNodes={expandedNodes}
                    onToggle={toggleExpand}
                    onSelect={setSelectedResourceId}
                    onSelectData={(id) => {
                      if (id === selectedId) {
                        setRightPanelTab('telemetry');
                      } else {
                        requestedTabRef.current = 'telemetry';
                        setSelectedResourceId(id);
                      }
                    }}
                    onRestore={(resource) => void restoreResource(resource)}
                    onKeyNavigate={handleTreeKeyNavigate}
                  />
                ))
              )}
            </div>
            <p
              id="hierarchy-tree-keys"
              className="px-3 pt-1.5 text-[10px] leading-snug text-[#94A3B8] border-t border-[#E3EAF3] bg-[#F9FAFD]"
              title="Keyboard: arrows move and expand, Home / End jump, * expands the level, a letter jumps to a name, F2 edits, Insert adds under it, Delete asks to archive."
            >
              Keys: ↑↓←→ · * expand level · F2 edit · Ins add · Del archive
            </p>
            <div className="px-3 py-2 bg-[#F9FAFD] flex items-center justify-between">
              <label className="flex items-center gap-2 text-[12px] text-[#475569] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                  className="rounded border-slate-300 text-[#EF1B24] focus:ring-[#EF1B24]/30"
                />
                Show archived
              </label>
              {showArchived && (
                <span className="text-[11px] text-[#94A3B8]">
                  {archivedIds.size === 0 ? 'None archived' : `${archivedIds.size} archived`}
                </span>
              )}
            </div>
          </Card>
        </div>

        {/* Contents of the selected resource: sub-units or signals */}
        <div className="col-span-12 lg:col-span-4 min-w-0">
          <Card className="h-[460px] lg:h-[calc(100vh-210px)] lg:min-h-[620px] flex flex-col p-0">
            <div className="px-3 py-2 border-b border-[#E3EAF3] flex items-center justify-between gap-2 bg-[#F9FAFD]">
              <div className="flex items-center gap-1 bg-slate-200/70 p-0.5 rounded-lg" role="tablist" aria-label="Contents">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isTelemetryView}
                  onClick={() => setRightPanelTab('children')}
                  className={`px-2.5 py-1 text-xs font-bold rounded-md transition ${
                    !isTelemetryView ? 'bg-white text-[#0B2545] shadow-xs' : 'text-[#64748B] hover:text-[#0B2545]'
                  }`}
                >
                  Sub-units ({childResources.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isTelemetryView}
                  onClick={() => setRightPanelTab('telemetry')}
                  className={`px-2.5 py-1 text-xs font-bold rounded-md transition ${
                    isTelemetryView ? 'bg-white text-[#0B2545] shadow-xs' : 'text-[#64748B] hover:text-[#0B2545]'
                  }`}
                >
                  Signals ({unitSignals.length})
                </button>
              </div>
              {isTelemetryView && unitSignals.length > 0 && (
                <button
                  type="button"
                  onClick={() => navigate(`/collector/signals?resourceId=${encodeURIComponent(selectedResource.id)}`)}
                  className="text-[12px] font-semibold text-[#2A82E7] hover:underline whitespace-nowrap"
                >
                  Open in Signals
                </button>
              )}
            </div>

            <div className="p-3 overflow-y-auto flex-1 min-h-0 space-y-2">
              {isTelemetryView ? (
                unitSignals.length === 0 ? (
                  <div className="text-center py-12 px-4 space-y-1.5">
                    <p className="text-[13px] font-semibold text-[#334568]">No signals bound to {selectedResource.name}</p>
                    <p className="text-[12px] text-[#94A3B8]">Use Add data to connect a source and bind its fields.</p>
                  </div>
                ) : (
                  <>
                    <div className="text-[11px] text-[#657794] px-1 flex items-center justify-between">
                      <span>{selectedStatus.label}</span>
                      <span title={lastUpdate ? formatTimestamp(lastUpdate) : undefined}>
                        {lastUpdate ? `Updated ${timeAgo(lastUpdate)}` : 'No value received yet'}
                      </span>
                    </div>
                    {unitSignals.map((sig) => {
                      const quality = normalizeQuality(sig.quality);
                      const label = sig.displayName || sig.key || sig.name;
                      return (
                        <button
                          key={sig.id}
                          type="button"
                          onClick={() => navigate(`/collector/signals?signalId=${encodeURIComponent(sig.id)}`)}
                          className="w-full text-left p-2.5 rounded-xl border border-[#E3EAF3] bg-white hover:border-[#94A3B8] transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[#0B2545] truncate" title={label}>
                              {label}
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${qualityChipClass(quality)}`}
                              title={QUALITY_HINT[quality]}
                            >
                              {QUALITY_LABEL[quality]}
                            </span>
                          </div>
                          <div className="flex items-baseline justify-between gap-2 mt-1">
                            <span className="text-base font-bold font-mono text-[#0B2545] truncate" title={formatValue(sig.value)}>
                              {formatValue(sig.value)}
                              {sig.unit && <span className="text-xs font-normal text-[#657794] ml-1">{sig.unit}</span>}
                            </span>
                            <span className="text-[10px] text-[#94A3B8] shrink-0" title={sig.lastUpdated ? formatTimestamp(sig.lastUpdated) : undefined}>
                              {sig.lastUpdated ? timeAgo(sig.lastUpdated) : '—'}
                            </span>
                          </div>
                          {sig.key && sig.key !== label && (
                            <div className="text-[10px] font-mono text-[#94A3B8] truncate mt-0.5">{sig.key}</div>
                          )}
                        </button>
                      );
                    })}
                  </>
                )
              ) : childResources.length === 0 ? (
                <div className="text-center py-12 px-4 space-y-1.5">
                  <p className="text-[13px] font-semibold text-[#334568]">Nothing under {selectedResource.name} yet</p>
                  <p className="text-[12px] text-[#94A3B8]">Use Add resource to add an area, line or machine here.</p>
                  {allowedChildTypes(selectedResource.type).length > 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2"
                      icon={<Plus className="w-3.5 h-3.5" />}
                      onClick={() => setIsAddModalOpen(true)}
                    >
                      Add under {selectedResource.name}
                    </Button>
                  )}
                </div>
              ) : (
                childResources.map((child) => {
                  const childSignals = signals.filter((s) => s.resourceId === child.id);
                  const childStatus = dataStatus(childSignals);
                  const grandChildren = resources.filter((item) => item.parentId === child.id).length;
                  return (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => setSelectedResourceId(child.id)}
                      className="w-full text-left p-3 rounded-xl border border-[#E3EAF3] hover:border-[#94A3B8] bg-white transition-colors space-y-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[#7A8AA3]">
                          <ResourceTypeIcon type={child.type} />
                        </span>
                        <span className="text-[13px] font-semibold text-[#111B37] truncate" title={child.name}>
                          {child.name}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-[#657794]">
                        <span>
                          {resourceTypeLabel(child.type)}
                          {grandChildren > 0 ? ` · ${grandChildren} ${grandChildren === 1 ? 'sub-unit' : 'sub-units'}` : ''}
                        </span>
                        <Badge variant={childStatus.variant} dot={childSignals.length > 0}>
                          {childStatus.label}
                        </Badge>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </Card>
        </div>

        {/* Inspector */}
        <div className="col-span-12 lg:col-span-5 min-w-0 space-y-3.5 lg:h-[calc(100vh-210px)] lg:min-h-[620px] lg:overflow-y-auto lg:pr-1">
          <section className="fx-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[#7A8AA3]">
                    <ResourceTypeIcon type={selectedResource.type} size={18} />
                  </span>
                  <h2 className="text-[18px] font-extrabold text-[#111B37] break-words min-w-0">{selectedResource.name}</h2>
                </div>
                <div className="text-[12px] text-[#657794] mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{resourceTypeLabel(selectedResource.type)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Code <span className="font-mono text-[#111B37] font-semibold">{selectedResource.code}</span>
                  </span>
                  <Badge variant={selectedStatus.variant} dot={selectedSignals.length > 0}>
                    {selectedStatus.label}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={goToAddData}>
                  Add data
                </Button>
                <Button size="sm" variant="secondary" icon={<Edit2 className="w-3.5 h-3.5" />} onClick={() => setIsEditModalOpen(true)}>
                  Edit
                </Button>
                <MenuButton
                  size="sm"
                  label="More"
                  ariaLabel={`More actions for ${selectedResource.name}`}
                  icon={<MoreHorizontal className="w-3.5 h-3.5" />}
                  items={[
                    {
                      key: 'move',
                      label: 'Move…',
                      icon: <ArrowRightLeft className="w-4 h-4" />,
                      onSelect: () => setIsMoveModalOpen(true),
                    },
                    {
                      key: 'archive',
                      label: 'Archive…',
                      icon: <Archive className="w-4 h-4" />,
                      danger: true,
                      onSelect: () => setArchiveTarget(selectedResource),
                    },
                  ]}
                />
              </div>
            </div>
          </section>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
            <Card title="Details" className="min-h-[220px]">
              <div className="space-y-3 text-[12px]">
                <div>
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">Description</span>
                  <p className="text-[#111B37] mt-0.5 whitespace-pre-wrap break-words">
                    {detail?.description ? detail.description : <span className="text-[#94A3B8]">No description</span>}
                  </p>
                </div>
                <div className="pt-2 border-t border-[#E3EAF3]">
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold mb-1">Properties</span>
                  {declaredProperties.length > 0 ? (
                    declaredProperties.map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 py-1 border-b border-[#F1F5FA] last:border-0">
                        <span className="text-[#657794] break-all">{k}</span>
                        <span className="font-semibold text-[#111B37] text-right break-all">
                          {typeof v === 'string' ? v : JSON.stringify(v)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-[#94A3B8]">No properties. Add them with Edit.</p>
                  )}
                </div>
              </div>
            </Card>

            <Card title="Location" className="min-h-[220px]">
              <div className="space-y-3 text-[12px]">
                <div>
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">Path</span>
                  <nav aria-label="Path" className="mt-1 flex flex-wrap items-center gap-1 text-[#111B37]">
                    {breadcrumb.map((item, idx) => (
                      <React.Fragment key={item.id}>
                        {idx > 0 && <ChevronRight className="w-3 h-3 text-[#CBD5E1]" aria-hidden="true" />}
                        {item.id === selectedResource.id ? (
                          <span className="font-semibold break-words">{item.name}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSelectedResourceId(item.id)}
                            className="hover:underline text-[#334568] break-words text-left"
                          >
                            {item.name}
                          </button>
                        )}
                      </React.Fragment>
                    ))}
                  </nav>
                </div>
                <div className="pt-2 border-t border-[#E3EAF3] grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">Sub-units</span>
                    <span className="text-[18px] font-extrabold text-[#111B37] tabular-nums">{childResources.length}</span>
                  </div>
                  <div>
                    <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">Signals</span>
                    <span className="text-[18px] font-extrabold text-[#111B37] tabular-nums">{selectedSignals.length}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  icon={<Share2 className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/factory/graph?resourceId=${encodeURIComponent(selectedResource.id)}`)}
                >
                  View in Knowledge Graph
                </Button>
              </div>
            </Card>
          </div>

          <Card title="Change history" subtitle={`Changes made to ${selectedResource.name}`}>
            {auditState === 'error' ? (
              <p className="text-[12px] text-[#94A3B8] py-2">
                The change history could not be loaded.{' '}
                <button type="button" className="text-[#2A82E7] hover:underline" onClick={() => setHistoryTick((v) => v + 1)}>
                  Try again
                </button>
              </p>
            ) : historyItems.length === 0 ? (
              <p className="text-[12px] text-[#94A3B8] py-2">{auditState === 'loading' ? 'Loading…' : 'No changes recorded yet.'}</p>
            ) : (
              <ol className="divide-y divide-[#F1F5FA]">
                {historyItems.map(({ row, text: entry }) => (
                  <li key={row.id} className="py-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[12px] text-[#111B37]">
                        <span className="font-semibold">{entry.actor}</span> {entry.action}
                      </p>
                      {entry.detail && <p className="text-[11px] text-[#657794] mt-0.5 break-words">{entry.detail}</p>}
                    </div>
                    <time
                      dateTime={row.occurred_at}
                      title={formatTimestamp(row.occurred_at)}
                      className="text-[11px] text-[#94A3B8] whitespace-nowrap shrink-0"
                    >
                      {timeAgo(row.occurred_at)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>

      <AddResourceModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        resources={resources}
        defaultParentId={defaultAddParentId}
        onAddResource={handleCreateResource}
      />

      <ImportTopicsModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={async (count) => {
          await safeRefresh();
          showToast({ message: `Imported ${count} ${count === 1 ? 'resource' : 'resources'}`, tone: 'info' });
        }}
      />

      <EditResourceModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        resource={selectedResource}
        resources={resources}
        onSuccess={async (updated) => {
          await safeRefresh();
          setHistoryTick((value) => value + 1);
          showToast({ message: `Saved "${updated.name}"`, tone: 'info' });
        }}
      />

      <MoveResourceModal
        isOpen={isMoveModalOpen}
        onClose={() => setIsMoveModalOpen(false)}
        selectedResource={selectedResource}
        allResources={resources}
        onMoveResource={handleMoveResource}
      />

      <ArchiveResourceModal
        isOpen={Boolean(archiveTarget)}
        resource={archiveTarget}
        childCount={archiveTarget ? resources.filter((item) => item.parentId === archiveTarget.id).length : 0}
        signalCount={archiveTarget ? signals.filter((s) => s.resourceId === archiveTarget.id).length : 0}
        onClose={() => setArchiveTarget(null)}
        onConfirm={confirmArchive}
      />

      {toastView}
    </div>
  );
};
