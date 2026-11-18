import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  MarkerType,
  Handle,
  Position,
  ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronDown, ChevronRight, Eye, EyeOff, Map as MapIcon, Maximize, Shield } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { TopologyNode, TopologyEdge, StorageObjectStatus } from '../../lib/storagePhysicalApi';
import { EmptyState, SearchInput, selectCls } from '../historian/hsUi';
import { StorageStatusBadge, StorageTypeIcon } from './objectViews';

/**
 * Topology canvas (R1-37): readable by default. The first view shows databases and supertables only
 * (node text 12–14 px at the fitted zoom); each supertable carries a "+N subtables" toggle that expands
 * its children lazily. Search expands the supertables whose subtables match. One Fit button, minimap off.
 */

interface NodeDataProps {
  label: string;
  physicalName: string;
  status: StorageObjectStatus;
  subtableCount?: number;
  shownChildren?: number;
  columnCount?: number;
  tagCount?: number;
  isSystem?: boolean;
  selected?: boolean;
  expanded?: boolean;
  more?: boolean;
  onSelect?: () => void;
  onToggle?: () => void;
  [key: string]: unknown;
}

const nodeBox = (selected?: boolean) =>
  `bg-white border rounded-xl shadow-sm cursor-pointer transition-all hover:shadow-md ${
    selected ? 'border-[#111B37] ring-2 ring-[#111B37]/15' : 'border-[#CBD5E1] hover:border-[#94A3B8]'
  }`;

const DatabaseNode: React.FC<{ data: NodeDataProps }> = ({ data }) => (
  <div onClick={data.onSelect} className={`px-4 py-3 w-[260px] ${nodeBox(data.selected)}`}>
    <Handle type="source" position={Position.Right} className="!bg-[#94A3B8] !w-2 !h-2" />
    <div className="flex items-center gap-2">
      <StorageTypeIcon kind="database" />
      <span className="text-[11px] font-bold tracking-wider text-[#657794] uppercase">Database</span>
    </div>
    <div className="text-[14px] font-bold text-[#111B37] truncate mt-1 font-mono" title={data.physicalName}>
      {data.physicalName}
    </div>
    <div className="flex items-center justify-between text-[12px] text-[#657794] mt-1.5">
      <span>{data.subtableCount ?? 0} supertables</span>
      <StorageStatusBadge status={data.status} />
    </div>
  </div>
);

const StableNode: React.FC<{ data: NodeDataProps }> = ({ data }) => (
  <div onClick={data.onSelect} className={`px-4 py-3 w-[270px] ${nodeBox(data.selected)}`}>
    <Handle type="target" position={Position.Left} className="!bg-[#94A3B8] !w-2 !h-2" />
    <Handle type="source" position={Position.Right} className="!bg-[#94A3B8] !w-2 !h-2" />
    <div className="flex items-center gap-2">
      <StorageTypeIcon kind="stable" />
      <span className="text-[11px] font-bold tracking-wider text-[#657794] uppercase">Supertable</span>
      {data.isSystem && (
        <span className="ml-auto px-1.5 py-0.5 bg-[#F1F5F9] text-[#64748B] text-[10px] font-bold rounded inline-flex items-center gap-0.5" title="FactoriX system object (read-only)">
          <Shield className="w-3 h-3" /> System
        </span>
      )}
    </div>
    <div className="text-[14px] font-bold text-[#111B37] truncate mt-1 font-mono" title={data.physicalName}>
      {data.physicalName}
    </div>
    <div className="flex items-center justify-between gap-2 text-[12px] text-[#657794] mt-1.5">
      <span>
        {data.columnCount ?? 0} cols · {data.tagCount ?? 0} tags
      </span>
      {(data.subtableCount ?? 0) > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle?.();
          }}
          aria-expanded={!!data.expanded}
          className="nodrag inline-flex items-center gap-1 h-6 px-2 rounded-md border border-[#D4DFEC] bg-white text-[12px] font-semibold text-[#334568] hover:bg-[#F1F5FA]"
          title={data.expanded ? 'Hide subtables' : 'Show subtables'}
        >
          {data.expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {data.expanded ? 'Hide' : `+${data.subtableCount}`} subtables
        </button>
      ) : (
        <span>0 subtables</span>
      )}
    </div>
  </div>
);

const SubtableNode: React.FC<{ data: NodeDataProps }> = ({ data }) => {
  const label = data.label || data.physicalName;
  const differs = data.physicalName && data.physicalName !== label;
  if (data.more) {
    return (
      <div className="px-3 py-2 w-[260px] rounded-lg border border-dashed border-[#CBD5E1] bg-white/80 text-[12px] text-[#657794]">
        <Handle type="target" position={Position.Left} className="!opacity-0" />
        <div className="font-semibold text-[#334568]">{label}</div>
        <div>{data.physicalName}</div>
      </div>
    );
  }
  return (
    <div onClick={data.onSelect} className={`px-3 py-2 w-[260px] ${nodeBox(data.selected)} rounded-lg shadow-xs`}>
      <Handle type="target" position={Position.Left} className="!bg-[#94A3B8] !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <StorageTypeIcon kind="subtable" className="w-3.5 h-3.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-[#111B37] truncate" title={label}>
            {label}
          </div>
          {differs && (
            <div className="text-[11px] text-[#657794] font-mono truncate" title={data.physicalName}>
              {data.physicalName}
            </div>
          )}
        </div>
        <span className={`w-2 h-2 rounded-full shrink-0 ${data.status === 'ACTIVE' ? 'bg-[#0DBA67]' : 'bg-[#94A3B8]'}`} title={String(data.status)} />
      </div>
    </div>
  );
};

const nodeTypes = { database: DatabaseNode, stable: StableNode, subtable: SubtableNode };

interface StorageObjectGraphProps {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  selectedObjectId?: string | null;
  onSelectObject: (objectId: string) => void;
  onRefresh: () => void;
  loading?: boolean;
  onShowObjects?: () => void;
}

const nameOf = (n: TopologyNode) => n.physical_name || (n as unknown as { label?: string }).label || '';

export const StorageObjectGraph: React.FC<StorageObjectGraphProps> = ({
  nodes: inputNodes = [],
  edges: inputEdges = [],
  selectedObjectId,
  onSelectObject,
  loading = false,
  onShowObjects,
}) => {
  const rawNodes = useMemo(() => (Array.isArray(inputNodes) ? inputNodes : []), [inputNodes]);
  const rawEdges = useMemo(() => (Array.isArray(inputEdges) ? inputEdges : []), [inputEdges]);

  const [search, setSearch] = useState('');
  const [showBindings, setShowBindings] = useState(false);
  const [showMinimap, setShowMinimap] = useState(false);
  const [selectedDb, setSelectedDb] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);

  const databases = useMemo(() => rawNodes.filter((n) => n.object_type === 'database'), [rawNodes]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        setFocusId(id);
      }
      return next;
    });
  }, []);

  const rfNodes: Node[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (n: TopologyNode) => !q || nameOf(n).toLowerCase().includes(q) || String(n.display_name || '').toLowerCase().includes(q);
    const dbs = databases.filter((db) => selectedDb === 'all' || db.node_id === selectedDb);
    const stables = rawNodes.filter((n) => n.object_type === 'stable');
    const subtables = rawNodes.filter((n) => n.object_type === 'subtable');
    const childrenOf = (st: TopologyNode) =>
      subtables.filter((sub) => sub.parent_id === st.node_id || (sub.metadata?.stable_name as string) === st.physical_name);

    const result: Node[] = [];
    let dbY = 40;
    dbs.forEach((db) => {
      const dbX = 40;
      const dbStables = stables.filter((s) => s.parent_id === db.node_id || (s.metadata?.database_name as string) === db.physical_name);
      // A search keeps a supertable when it or one of its subtables matches.
      const visibleStables = dbStables.filter((st) => !q || matches(st) || childrenOf(st).some(matches));
      if (q && !matches(db) && visibleStables.length === 0) return;
      result.push({
        id: db.node_id,
        type: 'database',
        position: { x: dbX, y: dbY },
        data: {
          label: db.physical_name,
          physicalName: db.physical_name,
          status: db.status,
          subtableCount: (db.metadata?.stable_count as number) ?? dbStables.length,
          selected: db.node_id === selectedObjectId,
          onSelect: () => onSelectObject(db.node_id),
        },
      });
      let stY = dbY;
      // Nothing expanded: supertables in a compact grid (readable at zoom 1); otherwise one column.
      const anyOpen = visibleStables.some((st) => expanded.has(st.node_id)) || q.length > 0;
      const gridCols = anyOpen ? 1 : Math.min(3, Math.max(1, Math.ceil(visibleStables.length / 3)));
      visibleStables.forEach((st, idx) => {
        const col = gridCols > 1 ? idx % gridCols : 0;
        const stX = dbX + 340 + col * 300;
        if (gridCols > 1) stY = dbY + Math.floor(idx / gridCols) * 112;
        const kids = childrenOf(st);
        const matchingKids = q ? kids.filter(matches) : kids;
        const isOpen = expanded.has(st.node_id) || (q.length > 0 && matchingKids.length > 0 && !matches(st));
        const total = (st.metadata?.subtable_count as number) ?? kids.length;
        result.push({
          id: st.node_id,
          type: 'stable',
          position: { x: stX, y: stY },
          data: {
            label: st.physical_name,
            physicalName: st.physical_name,
            status: st.status,
            columnCount: (st.metadata?.column_count as number) || 0,
            tagCount: (st.metadata?.tag_count as number) || 0,
            subtableCount: total,
            isSystem: Boolean(st.metadata?.is_system),
            expanded: isOpen,
            selected: st.node_id === selectedObjectId,
            onSelect: () => onSelectObject(st.node_id),
            onToggle: () => toggle(st.node_id),
          },
        });
        let subY = stY;
        if (isOpen) {
          const shown = matchingKids;
          shown.forEach((sub) => {
            result.push({
              id: sub.node_id,
              type: 'subtable',
              position: { x: stX + 340, y: subY },
              data: {
                label: sub.label || sub.display_name || (sub.metadata?.display_name as string) || sub.physical_name,
                physicalName: (sub.metadata?.physical_name as string) || sub.physical_name,
                status: sub.status,
                selected: sub.node_id === selectedObjectId,
                onSelect: () => onSelectObject(sub.node_id),
              },
            });
            subY += 54;
          });
          if (!q && total > shown.length) {
            // Honest totals (G-08 / R1-37): the canvas draws the first children, the rest is counted.
            result.push({
              id: `${st.node_id}::more`,
              type: 'subtable',
              position: { x: stX + 340, y: subY },
              data: { label: `+${total - shown.length} more`, physicalName: `${total} in total · see Objects table`, status: 'ACTIVE', more: true },
            });
            subY += 54;
          }
        }
        if (gridCols === 1) stY = Math.max(stY + 112, subY + 16);
      });
      const rows = gridCols > 1 ? Math.ceil(visibleStables.length / gridCols) : 0;
      if (gridCols > 1) stY = dbY + rows * 112;
      dbY = Math.max(dbY + 150, stY + 30);
    });
    return result;
  }, [rawNodes, databases, search, selectedDb, expanded, selectedObjectId, onSelectObject, toggle]);

  const rfEdges: Edge[] = useMemo(() => {
    const present = new Set(rfNodes.map((n) => n.id));
    const out: Edge[] = rawEdges
      .filter((edge) => (showBindings || edge.edge_kind !== 'BINDS_SOURCE') && present.has(edge.source_node_id) && present.has(edge.target_node_id))
      .map((edge) => {
        const physical = edge.edge_kind === 'CONTAINS' || edge.edge_kind === 'INHERITS_SCHEMA';
        return {
          id: edge.edge_id,
          source: edge.source_node_id,
          target: edge.target_node_id,
          type: 'smoothstep',
          animated: edge.edge_kind === 'BINDS_SOURCE',
          style: { stroke: physical ? '#94A3B8' : '#2A82E7', strokeWidth: physical ? 1.5 : 1, strokeDasharray: physical ? undefined : '5,5' },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: physical ? '#94A3B8' : '#2A82E7' },
        };
      });
    rfNodes.filter((n) => n.id.endsWith('::more')).forEach((n) => {
      const parent = n.id.replace(/::more$/, '');
      out.push({ id: `${n.id}-e`, source: parent, target: n.id, type: 'smoothstep', style: { stroke: '#CBD5E1', strokeDasharray: '4,4' } });
    });
    return out;
  }, [rawEdges, rfNodes, showBindings]);

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);
  useEffect(() => setNodes(rfNodes), [rfNodes, setNodes]);
  useEffect(() => setEdges(rfEdges), [rfEdges, setEdges]);

  // Readable default: fit, but never zoom out below 0.7 (text stays ≥ ~12 px); never zoom in above 1.
  const fit = useCallback(() => {
    rfInstance?.fitView({ padding: 0.12, duration: 300, minZoom: 0.7, maxZoom: 1 });
  }, [rfInstance]);
  const nodeCount = rfNodes.length;
  // Opening a supertable puts it at the top-left at a readable zoom; otherwise fit the whole view, and when
  // that would be too small (< 0.7) anchor the first database at the top-left at zoom 0.85 instead.
  useEffect(() => {
    if (!rfInstance) return;
    const t = window.setTimeout(() => {
      const focus = focusId ? rfNodes.find((n) => n.id === focusId) : null;
      if (focus) {
        const z = 0.9;
        rfInstance.setViewport({ x: -(focus.position.x - 24) * z, y: -(focus.position.y - 80) * z, zoom: z }, { duration: 300 });
        setFocusId(null);
        return;
      }
      if (expanded.size > 0) return;
      void Promise.resolve(rfInstance.fitView({ padding: 0.12, maxZoom: 1 })).then(() => {
        if (rfInstance.getViewport().zoom >= 0.7) return;
        const first = rfNodes[0];
        const z = 0.85;
        rfInstance.setViewport({ x: -((first?.position.x ?? 0) - 24) * z, y: -((first?.position.y ?? 0) - 60) * z, zoom: z });
      });
    }, 60);
    return () => window.clearTimeout(t);
  }, [rfInstance, nodeCount, selectedDb]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative w-full h-[480px] sm:h-[600px] bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl overflow-hidden">
      <div className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-center gap-2 pointer-events-none">
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto min-w-0">
          <SearchInput className="w-48 sm:w-56" value={search} onChange={setSearch} placeholder="Search objects" ariaLabel="Search the topology" />
          {databases.length > 1 && (
            <select aria-label="Database" value={selectedDb} onChange={(e) => setSelectedDb(e.target.value)} className={selectCls}>
              <option value="all">All databases</option>
              {databases.map((db) => (
                <option key={db.node_id} value={db.node_id}>
                  {db.physical_name}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" variant="outline" aria-pressed={showBindings} icon={showBindings ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />} onClick={() => setShowBindings((v) => !v)} title="Show source lineage edges">
            Lineage
          </Button>
          {expanded.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded(new Set())}>
              Collapse all
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1.5 ml-auto pointer-events-auto">
          <Button size="sm" variant="outline" icon={<Maximize className="w-3.5 h-3.5" />} onClick={fit} title="Fit to view">
            Fit
          </Button>
          <Button size="sm" variant="ghost" aria-pressed={showMinimap} icon={<MapIcon className="w-3.5 h-3.5" />} onClick={() => setShowMinimap((v) => !v)} title="Toggle minimap">
            Map
          </Button>
        </div>
      </div>

      <div className="hidden sm:flex absolute bottom-3 left-3 z-10 items-center gap-3 px-3 py-1.5 bg-white/90 border border-[#E3EAF3] rounded-lg text-[11px] text-[#657794] pointer-events-none">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-[#94A3B8] inline-block" />
          Contains
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 border-b border-dashed border-[#2A82E7] inline-block" />
          Source lineage
        </span>
        {onShowObjects && (
          <button type="button" className="pointer-events-auto font-semibold text-[#2A82E7] hover:underline" onClick={onShowObjects}>
            All objects as a table
          </button>
        )}
      </div>

      {rfNodes.length === 0 && !loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6 pointer-events-none">
          <EmptyState title={search ? 'Nothing matches the search' : 'No storage objects yet'} className="pointer-events-auto max-w-md">
            {search ? 'Try another name.' : 'Create a TDengine database to start.'}
          </EmptyState>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onInit={setRfInstance}
        minZoom={0.2}
        maxZoom={1.5}
        nodesConnectable={false}
        defaultEdgeOptions={{ animated: false }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#CBD5E1" gap={20} size={1} />
        <Controls showInteractive={false} showFitView={false} position="bottom-right" />
        {showMinimap && (
          <MiniMap
            position="top-right"
            className="!top-12 !right-3 !border !border-[#E3EAF3] !rounded-lg !overflow-hidden"
            nodeColor={(n) => (n.type === 'database' ? '#111B37' : n.type === 'stable' ? '#2A82E7' : '#8858EA')}
          />
        )}
      </ReactFlow>
    </div>
  );
};
