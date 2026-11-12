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
import {
  Database,
  Layers,
  Table,
  Search,
  Maximize,
  Filter,
  Eye,
  EyeOff,
  RotateCw,
  ExternalLink,
  ChevronRight,
  Shield,
  Activity,
} from 'lucide-react';
import { TopologyNode, TopologyEdge, EdgeKind, StorageObjectStatus } from '../../lib/storagePhysicalApi';

// Custom node components
interface NodeDataProps {
  label: string;
  type: string;
  physicalName: string;
  status: StorageObjectStatus;
  subtableCount?: number;
  columnCount?: number;
  tagCount?: number;
  isSystem?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}

const DatabaseNodeComponent: React.FC<{ data: NodeDataProps }> = ({ data }) => {
  return (
    <div
      onClick={data.onSelect}
      className={`px-4 py-3 bg-white border-2 rounded-xl shadow-sm min-w-[200px] cursor-pointer transition-all hover:shadow-md ${
        data.selected ? 'border-[#EF1B24] ring-2 ring-[#EF1B24]/20' : 'border-[#E3EAF3] hover:border-[#CBD5E1]'
      }`}
    >
      <Handle type="source" position={Position.Right} className="!bg-[#EF1B24] !w-2.5 !h-2.5" />
      <div className="flex items-center gap-2 mb-1.5">
        <div className="p-1.5 bg-[#FEF2F2] rounded-lg">
          <Database className="w-4 h-4 text-[#EF1B24]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold tracking-wider text-[#EF1B24] uppercase">Database</div>
          <div className="text-[13px] font-bold text-[#111B37] truncate" title={data.physicalName}>
            {data.physicalName}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-[#657794] pt-1.5 border-t border-[#F1F5FA]">
        <span>{data.subtableCount ?? 0} stables</span>
        <span
          className={`px-1.5 py-0.2 rounded text-[10px] font-semibold ${
            data.status === 'ACTIVE' ? 'bg-[#E8FAF0] text-[#0DBA67]' : 'bg-[#FEF2F2] text-[#EF1B24]'
          }`}
        >
          {data.status}
        </span>
      </div>
    </div>
  );
};

const StableNodeComponent: React.FC<{ data: NodeDataProps }> = ({ data }) => {
  return (
    <div
      onClick={data.onSelect}
      className={`px-4 py-3 bg-white border-2 rounded-xl shadow-sm min-w-[210px] cursor-pointer transition-all hover:shadow-md ${
        data.selected ? 'border-[#0284C7] ring-2 ring-[#0284C7]/20' : 'border-[#E3EAF3] hover:border-[#CBD5E1]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-[#0284C7] !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-[#0284C7] !w-2.5 !h-2.5" />
      <div className="flex items-center gap-2 mb-1.5">
        <div className="p-1.5 bg-[#F0F9FF] rounded-lg">
          <Layers className="w-4 h-4 text-[#0284C7]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-[#0284C7] uppercase">Supertable</span>
            {data.isSystem && (
              <span className="px-1 py-0.2 bg-[#F1F5F9] text-[#64748B] text-[9px] font-bold rounded flex items-center gap-0.5">
                <Shield className="w-2.5 h-2.5" /> SYS
              </span>
            )}
          </div>
          <div className="text-[13px] font-bold text-[#111B37] truncate" title={data.physicalName}>
            {data.physicalName}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-[#657794] pt-1.5 border-t border-[#F1F5FA]">
        <span>
          {data.columnCount ?? 0} cols · {data.tagCount ?? 0} tags
        </span>
        <span className="font-semibold text-[#0284C7]">{data.subtableCount ?? 0} subtables</span>
      </div>
    </div>
  );
};

const SubtableNodeComponent: React.FC<{ data: NodeDataProps }> = ({ data }) => {
  return (
    <div
      onClick={data.onSelect}
      className={`px-3 py-2 bg-white border-2 rounded-lg shadow-xs min-w-[180px] cursor-pointer transition-all hover:shadow-sm ${
        data.selected ? 'border-[#7C3AED] ring-2 ring-[#7C3AED]/20' : 'border-[#E3EAF3] hover:border-[#CBD5E1]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-[#7C3AED] !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <Table className="w-3.5 h-3.5 text-[#7C3AED] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-[#111B37] truncate" title={data.physicalName}>
            {data.physicalName}
          </div>
        </div>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            data.status === 'ACTIVE' ? 'bg-[#0DBA67]' : 'bg-[#F59E0B]'
          }`}
          title={data.status}
        />
      </div>
    </div>
  );
};

const nodeTypes = {
  database: DatabaseNodeComponent,
  stable: StableNodeComponent,
  subtable: SubtableNodeComponent,
};

interface StorageObjectGraphProps {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  selectedObjectId?: string | null;
  onSelectObject: (objectId: string) => void;
  onRefresh: () => void;
  loading?: boolean;
}

export const StorageObjectGraph: React.FC<StorageObjectGraphProps> = ({
  nodes: rawNodes,
  edges: rawEdges,
  selectedObjectId,
  onSelectObject,
  onRefresh,
  loading = false,
}) => {
  const [search, setSearch] = useState('');
  const [showBindings, setShowBindings] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [selectedDb, setSelectedDb] = useState<string>('all');
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);

  // Extract database options
  const databases = useMemo(() => {
    return rawNodes.filter((n) => n.object_type === 'database');
  }, [rawNodes]);

  // Filter nodes & edges based on search and selectedDb
  const filteredNodes = useMemo(() => {
    return rawNodes.filter((node) => {
      if (search) {
        const query = search.toLowerCase();
        const matches =
          node.physical_name.toLowerCase().includes(query) ||
          (node.display_name && node.display_name.toLowerCase().includes(query));
        if (!matches) return false;
      }
      if (selectedDb !== 'all') {
        if (node.object_type === 'database') return node.node_id === selectedDb;
        if (node.parent_id) {
          const parent = rawNodes.find((n) => n.node_id === node.parent_id);
          if (parent && parent.object_type === 'database') return parent.node_id === selectedDb;
        }
      }
      return true;
    });
  }, [rawNodes, search, selectedDb]);

  // Convert rawNodes to React Flow Node objects with simple hierarchy positioning
  const rfNodes: Node[] = useMemo(() => {
    // Group by layer: databases -> stables -> subtables
    const dbs = filteredNodes.filter((n) => n.object_type === 'database');
    const stables = filteredNodes.filter((n) => n.object_type === 'stable');
    const subtables = filteredNodes.filter((n) => n.object_type === 'subtable');

    const result: Node[] = [];
    let dbY = 50;

    dbs.forEach((db, dbIdx) => {
      const dbX = 60;
      const curDbY = dbY;
      result.push({
        id: db.node_id,
        type: 'database',
        position: db.position || { x: dbX, y: curDbY },
        data: {
          label: db.physical_name,
          physicalName: db.physical_name,
          status: db.status,
          subtableCount: (db.metadata?.stable_count as number) || 0,
          selected: db.node_id === selectedObjectId,
          onSelect: () => onSelectObject(db.node_id),
        },
      });

      // Find children stables
      const childStables = stables.filter(
        (s) => s.parent_id === db.node_id || (s.metadata?.database_name as string) === db.physical_name
      );

      let stableY = curDbY;
      childStables.forEach((st, stIdx) => {
        const stX = dbX + 300;
        const curStY = stableY;
        result.push({
          id: st.node_id,
          type: 'stable',
          position: st.position || { x: stX, y: curStY },
          data: {
            label: st.physical_name,
            physicalName: st.physical_name,
            status: st.status,
            columnCount: (st.metadata?.column_count as number) || 0,
            tagCount: (st.metadata?.tag_count as number) || 0,
            subtableCount: (st.metadata?.subtable_count as number) || 0,
            isSystem: Boolean(st.metadata?.is_system),
            selected: st.node_id === selectedObjectId,
            onSelect: () => onSelectObject(st.node_id),
          },
        });

        // Find child subtables (limit to first 10 for canvas clarity per §4)
        const childSubtables = subtables
          .filter((sub) => sub.parent_id === st.node_id || (sub.metadata?.stable_name as string) === st.physical_name)
          .slice(0, 10);

        let subY = curStY;
        childSubtables.forEach((sub, subIdx) => {
          const subX = stX + 310;
          result.push({
            id: sub.node_id,
            type: 'subtable',
            position: sub.position || { x: subX, y: subY },
            data: {
              label: sub.physical_name,
              physicalName: sub.physical_name,
              status: sub.status,
              selected: sub.node_id === selectedObjectId,
              onSelect: () => onSelectObject(sub.node_id),
            },
          });
          subY += 56;
        });

        stableY = Math.max(curStY + 120, subY + 20);
      });

      dbY = Math.max(curDbY + 160, stableY + 40);
    });

    return result;
  }, [filteredNodes, selectedObjectId, onSelectObject]);

  // Convert rawEdges to React Flow Edge objects
  // Solid for CONTAINS and INHERITS_SCHEMA, dashed for others per plan.md §2.2
  const rfEdges: Edge[] = useMemo(() => {
    return rawEdges
      .filter((edge) => {
        if (!showBindings && edge.edge_kind === 'BINDS_SOURCE') return false;
        // Verify both nodes exist in filtered nodes
        const hasSource = filteredNodes.some((n) => n.node_id === edge.source_node_id);
        const hasTarget = filteredNodes.some((n) => n.node_id === edge.target_node_id);
        return hasSource && hasTarget;
      })
      .map((edge) => {
        const isPhysical = edge.edge_kind === 'CONTAINS' || edge.edge_kind === 'INHERITS_SCHEMA';
        return {
          id: edge.edge_id,
          source: edge.source_node_id,
          target: edge.target_node_id,
          type: 'smoothstep',
          animated: edge.edge_kind === 'BINDS_SOURCE',
          style: {
            stroke: isPhysical ? '#94A3B8' : '#3B82F6',
            strokeWidth: isPhysical ? 1.5 : 1,
            strokeDasharray: isPhysical ? undefined : '5,5',
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: isPhysical ? '#94A3B8' : '#3B82F6',
          },
        };
      });
  }, [rawEdges, filteredNodes, showBindings]);

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);

  useEffect(() => {
    setNodes(rfNodes);
  }, [rfNodes, setNodes]);

  useEffect(() => {
    setEdges(rfEdges);
  }, [rfEdges, setEdges]);

  const handleFitView = useCallback(() => {
    rfInstance?.fitView({ padding: 0.15, duration: 400 });
  }, [rfInstance]);

  return (
    <div className="relative w-full h-[640px] bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl overflow-hidden shadow-xs">
      {/* Canvas top toolbar */}
      <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search objects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 bg-white/95 backdrop-blur border border-[#E3EAF3] rounded-lg text-[12px] text-[#111B37] placeholder-[#94A3B8] shadow-xs focus:outline-none focus:border-[#EF1B24] w-48"
            />
          </div>

          {/* Database filter */}
          {databases.length > 0 && (
            <div className="flex items-center bg-white/95 backdrop-blur border border-[#E3EAF3] rounded-lg px-2 py-1 shadow-xs">
              <Filter className="w-3 h-3 text-[#94A3B8] mr-1.5" />
              <select
                value={selectedDb}
                onChange={(e) => setSelectedDb(e.target.value)}
                className="bg-transparent text-[12px] font-medium text-[#111B37] focus:outline-none cursor-pointer"
              >
                <option value="all">All Databases</option>
                {databases.map((db) => (
                  <option key={db.node_id} value={db.node_id}>
                    {db.physical_name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Show Bindings toggle */}
          <button
            type="button"
            onClick={() => setShowBindings(!showBindings)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium border shadow-xs transition-colors ${
              showBindings
                ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]'
                : 'bg-white/95 border-[#E3EAF3] text-[#657794] hover:text-[#111B37]'
            }`}
          >
            {showBindings ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span>Lineage</span>
          </button>
        </div>

        {/* Canvas right controls */}
        <div className="flex items-center gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={handleFitView}
            className="p-1.5 bg-white/95 backdrop-blur border border-[#E3EAF3] rounded-lg text-[#657794] hover:text-[#111B37] shadow-xs transition-colors"
            title="Fit to view"
          >
            <Maximize className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setShowMinimap(!showMinimap)}
            className={`px-2 py-1 bg-white/95 backdrop-blur border border-[#E3EAF3] rounded-lg text-[11px] font-semibold shadow-xs ${
              showMinimap ? 'text-[#EF1B24]' : 'text-[#657794]'
            }`}
            title="Toggle minimap"
          >
            Map
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="p-1.5 bg-white/95 backdrop-blur border border-[#E3EAF3] rounded-lg text-[#657794] hover:text-[#111B37] shadow-xs transition-colors"
            title="Refresh topology"
          >
            <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#EF1B24]' : ''}`} />
          </button>
        </div>
      </div>

      {/* Legend overlay at bottom left */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3 px-3 py-1.5 bg-white/90 backdrop-blur border border-[#E3EAF3] rounded-lg text-[11px] text-[#657794] shadow-xs pointer-events-none">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-[#94A3B8] inline-block" />
          <span>Physical Contains / Inherits</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 border-b border-dashed border-[#3B82F6] inline-block" />
          <span>Source Lineage</span>
        </div>
      </div>

      {/* Empty state */}
      {rfNodes.length === 0 && !loading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/80 backdrop-blur pointer-events-none">
          <Database className="w-12 h-12 text-[#CBD5E1] mb-3" />
          <h3 className="text-[15px] font-bold text-[#111B37] mb-1">No Storage Objects Found</h3>
          <p className="text-[13px] text-[#657794] max-w-sm text-center">
            {search
              ? 'No objects match your search filter.'
              : 'Create a TDengine Database to begin organizing your time-series tables.'}
          </p>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onInit={setRfInstance}
        fitView
        minZoom={0.2}
        maxZoom={1.5}
        defaultEdgeOptions={{ animated: false }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#CBD5E1" gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-right" className="!bottom-3 !right-3" />
        {showMinimap && (
          <MiniMap
            position="top-right"
            className="!top-12 !right-3 !border !border-[#E3EAF3] !rounded-lg !overflow-hidden"
            nodeColor={(n) => {
              if (n.type === 'database') return '#EF1B24';
              if (n.type === 'stable') return '#0284C7';
              return '#7C3AED';
            }}
          />
        )}
      </ReactFlow>
    </div>
  );
};
