import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Node,
  Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Share2,
  Filter,
  Search,
  Maximize2,
  Download,
  RotateCcw,
  Radio,
  Layers,
  X,
  Activity,
  Server,
  Network,
  Cpu,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { api } from '../../api/client';
import { layoutGraph } from './graphLayout';
import { LabeledEdge } from './LabeledEdge';
import {
  ResourceNodeComponent,
  SignalNodeComponent,
  ConnectionNodeComponent,
  EdgeInfraNodeComponent,
  ModelNodeComponent,
} from './CustomNodes';

const nodeTypes = {
  resource: ResourceNodeComponent,
  signal: SignalNodeComponent,
  connection: ConnectionNodeComponent,
  edgeNode: EdgeInfraNodeComponent,
  model: ModelNodeComponent,
};

const edgeTypes = {
  labeled: LabeledEdge,
};

const ALL_RELATIONS = [
  { code: 'CONTAINS', label: 'Contains' },
  { code: 'HAS_SIGNAL', label: 'Has signal' },
  { code: 'COLLECTED_VIA', label: 'Collected via' },
  { code: 'RUNS_ON', label: 'Runs on' },
  { code: 'USED_IN', label: 'Used in' },
];

export const KnowledgeGraphPage: React.FC = () => {
  const { scopedResources, selectedResourceId, setSelectedResourceId } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  // Current center & depth from URL (§9.6 TC-UI-KG-01)
  const centerParam = searchParams.get('center');
  const depthParam = searchParams.get('depth');

  const depth = depthParam === '2' ? 2 : depthParam === '3' ? 3 : 1;

  // Derive initial center resource
  const centerResource = useMemo(() => {
    if (centerParam) {
      const match = scopedResources.find((r) => r.id === centerParam);
      if (match) return match;
    }
    if (selectedResourceId) {
      const match = scopedResources.find((r) => r.id === selectedResourceId);
      if (match) return match;
    }
    return scopedResources.find((r) => r.type === 'machine') || scopedResources[0];
  }, [centerParam, selectedResourceId, scopedResources]);

  // Active relations filter set
  const [activeRelations, setActiveRelations] = useState<Set<string>>(
    new Set(['CONTAINS', 'HAS_SIGNAL', 'COLLECTED_VIA', 'RUNS_ON', 'USED_IN'])
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedEntity, setSelectedEntity] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch graph neighbors when center, depth, or relations change
  useEffect(() => {
    if (!centerResource) return;

    let active = true;
    setIsLoading(true);

    void (async () => {
      try {
        const relationCodes = Array.from(activeRelations).join(',');
        const res = await api<{
          nodes: Array<Record<string, unknown>>;
          edges: Array<Record<string, unknown>>;
        }>(
          `/api/v1/graph/neighbors?resource_id=${encodeURIComponent(
            centerResource.id
          )}&depth=${depth}&relation_types=${encodeURIComponent(
            relationCodes
          )}&include_data=true`
        );

        if (!active) return;

        const nodeLabelMap = new Map<string, string>();
        res.nodes.forEach((n) => {
          const label = String(n.label || n.name || n.key || 'Node');
          nodeLabelMap.set(String(n.id), label);
        });

        // Map backend nodes to React Flow nodes
        const rawNodes: Node[] = res.nodes.map((n) => {
          const id = String(n.id);
          const kind = String(n.kind || n.type || 'resource').toLowerCase();
          const rfType =
            kind === 'signal'
              ? 'signal'
              : kind === 'connection'
              ? 'connection'
              : kind === 'edge'
              ? 'edgeNode'
              : kind === 'model'
              ? 'model'
              : 'resource';

          return {
            id,
            type: rfType,
            data: {
              ...n,
              isCenter: id === centerResource.id,
              onDoubleClick: () => {
                if (kind === 'resource') {
                  setSearchParams({ center: id, depth: '2' });
                  setSelectedResourceId(id);
                }
              },
            },
            position: { x: 0, y: 0 },
          };
        });

        // Map backend edges to React Flow edges with LabeledEdge
        const rawEdges: Edge[] = res.edges.map((e) => {
          const fromId = String(e.from || e.from_id);
          const toId = String(e.to || e.to_id);
          const relCode = String(e.relation_code);

          return {
            id: String(e.id || `${fromId}->${toId}-${relCode}`),
            source: fromId,
            target: toId,
            type: 'labeled',
            markerEnd: { type: MarkerType.ArrowClosed, color: '#134074' },
            data: {
              relation_code: relCode,
              sourceLabel: nodeLabelMap.get(fromId) || 'Source',
              targetLabel: nodeLabelMap.get(toId) || 'Target',
            },
          };
        });

        // Run ELK layered layout
        const layouted = await layoutGraph(rawNodes, rawEdges, 'RIGHT');
        setNodes(layouted.nodes);
        setEdges(layouted.edges);
      } catch {
        // Fallback or empty state
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [centerResource, depth, activeRelations, setSearchParams, setSelectedResourceId]);

  const handleNodeClick = (_: React.MouseEvent, node: Node) => {
    setSelectedEntity(node.data as Record<string, unknown>);
  };

  const handleToggleRelation = (code: string) => {
    setActiveRelations((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  };

  if (!centerResource) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold text-[#0B2545]">Knowledge Graph</h1>
        <p className="text-xs text-[#64748B]">
          The graph is populated from the factory model. Create an enterprise and its children in Factory Structure first.
        </p>
      </div>
    );
  }

  // Filtered resources for "Center on..." search selector (TC-UI-KG-08)
  const filteredResourceOptions = searchQuery.trim()
    ? scopedResources.filter(
        (r) =>
          r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          r.code.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : scopedResources.slice(0, 8);

  return (
    <div className="space-y-4 animate-in fade-in duration-200 select-none pb-8">
      {/* Header & Controls Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1 text-xs text-[#64748B]">
            <span className="font-bold uppercase text-[#134074]">{centerResource.type}</span>
            <span>·</span>
            <span className="font-mono">{centerResource.code}</span>
          </div>
          <h1 className="text-xl md:text-2xl font-black text-[#0B2545] tracking-tight">
            Knowledge Graph: {centerResource.name}
          </h1>
        </div>

        {/* Action Controls: Center Selector + Depth + Relations */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* "Center on…" Searchable Selector (TC-UI-KG-08) */}
          <div className="relative">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#CBD5E1] bg-white text-xs shadow-sm">
              <Search className="w-3.5 h-3.5 text-[#64748B]" />
              <input
                type="text"
                placeholder="Center on…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-32 md:w-40 text-xs font-medium text-[#0B2545] outline-none placeholder:text-[#94A3B8]"
              />
            </div>
            {searchQuery.trim().length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-56 max-h-60 overflow-y-auto bg-white border border-[#CBD5E1] rounded-xl shadow-xl z-50 p-1 space-y-1">
                {filteredResourceOptions.map((res) => (
                  <button
                    key={res.id}
                    type="button"
                    onClick={() => {
                      setSearchParams({ center: res.id, depth: String(depth) });
                      setSelectedResourceId(res.id);
                      setSearchQuery('');
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[#F1F5F9] text-xs font-semibold text-[#0B2545] flex items-center justify-between"
                  >
                    <span className="truncate">{res.name}</span>
                    <span className="text-[10px] font-mono text-[#64748B] uppercase">{res.type}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Depth Selector Buttons: 1, 2, 3 (TC-UI-KG-02, 03, 04) */}
          <div className="bg-[#F1F5F9] p-1 rounded-xl flex items-center border border-[#E2E8F0]">
            <span className="text-[11px] font-bold text-[#64748B] px-2">Depth</span>
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setSearchParams({ center: centerResource.id, depth: String(d) })}
                className={`w-7 h-7 rounded-lg text-xs font-bold transition-all ${
                  depth === d
                    ? 'bg-white text-[#0B2545] shadow-sm'
                    : 'text-[#64748B] hover:text-[#0B2545]'
                }`}
              >
                {d}
              </button>
            ))}
          </div>

          {/* Relations Filter Toggles (TC-UI-KG-05) */}
          <div className="flex items-center gap-1.5 bg-[#F8FAFC] p-1 rounded-xl border border-[#E2E8F0]">
            {ALL_RELATIONS.map((rel) => {
              const active = activeRelations.has(rel.code);
              return (
                <button
                  key={rel.code}
                  type="button"
                  onClick={() => handleToggleRelation(rel.code)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all border ${
                    active
                      ? 'bg-white text-[#134074] border-[#BFDBFE] shadow-sm'
                      : 'bg-transparent text-[#94A3B8] border-transparent hover:text-[#64748B]'
                  }`}
                >
                  {rel.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Graph Canvas Area + Right Node Inspector */}
      <div className="flex gap-4 items-start relative h-[720px] rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden shadow-sm">
        <div className="flex-1 h-full relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            fitView
            minZoom={0.2}
            maxZoom={2.5}
            defaultEdgeOptions={{ type: 'labeled' }}
          >
            <Background color="#CBD5E1" gap={20} size={1} />
            <Controls className="!bg-white !border !border-[#E2E8F0] !shadow-sm !rounded-xl overflow-hidden" />
            <MiniMap
              nodeColor={(node) => {
                if (node.type === 'signal') return '#10B981';
                if (node.type === 'connection') return '#3B82F6';
                if (node.type === 'edgeNode') return '#0B2545';
                return '#64748B';
              }}
              className="!border !border-[#E2E8F0] !rounded-xl !overflow-hidden !shadow-sm"
            />
          </ReactFlow>

          {/* Legend Banner */}
          <div className="absolute bottom-3 left-3 bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-xl border border-[#E2E8F0] shadow-sm flex items-center gap-3 text-[11px] font-semibold text-[#475569] pointer-events-none">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-[#0B2545]" />
              <span>Resource</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-[#10B981]" />
              <span>Signal</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#3B82F6]" />
              <span>Connection</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-[#475569]" />
              <span>Edge</span>
            </div>
          </div>
        </div>

        {/* Right Details Panel for Clicked Node (§9.6 TC-UI-KG-09) */}
        {selectedEntity && (
          <div className="w-80 md:w-88 bg-white border-l border-[#E2E8F0] h-full flex flex-col p-4 shadow-xl z-20 animate-in slide-in-from-right duration-200 overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
              <div>
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-[#F1F5F9] text-[#475569] font-bold">
                  {String(selectedEntity.kind || selectedEntity.type || 'Entity')}
                </span>
                <h3 className="text-sm font-bold text-[#0B2545] mt-1 truncate">
                  {String(selectedEntity.label || selectedEntity.name || selectedEntity.key || 'Node details')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEntity(null)}
                className="p-1 rounded-md text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Clean Metadata without Technical IDs */}
            <div className="mt-4 space-y-3 text-xs">
              {selectedEntity.value !== undefined && (
                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <div className="text-[10px] font-bold uppercase text-[#64748B] mb-1">Live Telemetry Value</div>
                  <div className="text-lg font-black font-mono text-[#0B2545]">
                    {String(selectedEntity.value)}
                  </div>
                </div>
              )}

              {selectedEntity.quality !== undefined && (
                <div className="flex items-center justify-between py-1.5 border-b border-[#F1F5F9]">
                  <span className="text-[#64748B]">Quality</span>
                  <span className="font-bold text-[#0B2545]">{String(selectedEntity.quality)}</span>
                </div>
              )}

              {selectedEntity.protocol !== undefined && (
                <div className="flex items-center justify-between py-1.5 border-b border-[#F1F5F9]">
                  <span className="text-[#64748B]">Protocol</span>
                  <span className="font-bold uppercase font-mono text-[#134074]">
                    {String(selectedEntity.protocol)}
                  </span>
                </div>
              )}

              {selectedEntity.health !== undefined && (
                <div className="flex items-center justify-between py-1.5 border-b border-[#F1F5F9]">
                  <span className="text-[#64748B]">Health</span>
                  <span className="font-bold text-[#0B2545]">{String(selectedEntity.health)}</span>
                </div>
              )}

              {Boolean(selectedEntity.code) && (
                <div className="flex items-center justify-between py-1.5 border-b border-[#F1F5F9]">
                  <span className="text-[#64748B]">Code</span>
                  <span className="font-mono font-semibold text-[#0B2545]">{String(selectedEntity.code)}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
