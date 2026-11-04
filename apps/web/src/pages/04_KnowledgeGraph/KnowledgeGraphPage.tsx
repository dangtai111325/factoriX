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
  ChevronDown,
  Layers,
  Crosshair,
  Maximize2,
  Download,
  RotateCcw,
  Radio,
  X,
  Activity,
  Server,
  Network,
  Cpu,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { ResourceNode, SignalItem } from '../../types';
import { layoutGraph } from './graphLayout';
import { LabeledEdge } from './LabeledEdge';
import {
  ResourceNodeComponent,
  SignalNodeComponent,
  ConnectionNodeComponent,
  EdgeInfraNodeComponent,
  ModelNodeComponent,
  TelemetryGroupNodeComponent,
} from './CustomNodes';

const nodeTypes = {
  resource: ResourceNodeComponent,
  telemetryGroup: TelemetryGroupNodeComponent,
  signal: SignalNodeComponent,
  connection: ConnectionNodeComponent,
  edgeNode: EdgeInfraNodeComponent,
  model: ModelNodeComponent,
};

const edgeTypes = {
  labeled: LabeledEdge,
};

export const KnowledgeGraphPage: React.FC = () => {
  const { scopedResources, resources, signals, selectedResourceId, setSelectedResourceId } = useApp();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedEntity, setSelectedEntity] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Build full factory topology DAG (§9.6 TC-UI-KG-01..09)
  useEffect(() => {
    let active = true;
    setIsLoading(true);

    void (async () => {
      try {
        const resourceList = scopedResources.length > 0 ? scopedResources : resources;
        if (resourceList.length === 0) return;

        const resMap = new Map<string, ResourceNode>();
        resourceList.forEach((r) => resMap.set(r.id, r));

        // 1. Structure Nodes
        const rawNodes: Node[] = resourceList.map((r) => ({
          id: r.id,
          type: 'resource',
          data: {
            ...r,
            label: r.name,
            name: r.name,
            code: r.code,
            type: r.type,
            type_key: r.type,
            onClick: () => {
              setSelectedEntity({
                kind: 'resource',
                ...r,
              });
            },
          },
          position: { x: 0, y: 0 },
        }));

        // 2. Structure CONTAINS Edges
        const rawEdges: Edge[] = [];
        resourceList.forEach((r) => {
          if (r.parentId && resMap.has(r.parentId)) {
            const parent = resMap.get(r.parentId)!;
            rawEdges.push({
              id: `${r.parentId}->${r.id}-CONTAINS`,
              source: r.parentId,
              target: r.id,
              type: 'labeled',
              markerEnd: { type: MarkerType.ArrowClosed, color: '#134074' },
              data: {
                relation_code: 'CONTAINS',
                sourceLabel: parent.name,
                targetLabel: r.name,
              },
            });
          }
        });

        // 3. Telemetry Nodes and HAS_SIGNAL Edges
        const signalsByRes = new Map<string, SignalItem[]>();
        signals.forEach((s) => {
          if (s.resourceId) {
            if (!signalsByRes.has(s.resourceId)) signalsByRes.set(s.resourceId, []);
            signalsByRes.get(s.resourceId)!.push(s);
          }
        });

        signalsByRes.forEach((sigList, resId) => {
          const res = resMap.get(resId);
          const resName = res ? res.name : 'Asset';
          const isLine = res?.type === 'line';
          const teleNodeId = `telemetry-${resId}`;

          rawNodes.push({
            id: teleNodeId,
            type: 'telemetryGroup',
            data: {
              id: teleNodeId,
              kind: 'telemetryGroup',
              label: isLine ? `Line Data (${sigList.length})` : `Machine Data (${sigList.length})`,
              signalCount: sigList.length,
              resourceName: resName,
              signals: sigList,
              onClick: () => {
                setSelectedEntity({
                  kind: 'telemetryGroup',
                  name: `${resName} Telemetry Data`,
                  resourceName: resName,
                  signals: sigList,
                });
              },
            },
            position: { x: 0, y: 0 },
          });

          rawEdges.push({
            id: `${resId}->${teleNodeId}-HAS_SIGNAL`,
            source: resId,
            target: teleNodeId,
            type: 'labeled',
            markerEnd: { type: MarkerType.ArrowClosed, color: '#10B981' },
            data: {
              relation_code: 'HAS_SIGNAL',
              sourceLabel: resName,
              targetLabel: isLine ? 'Line Data' : 'Machine Data',
            },
          });
        });

        // Layout DAG with ELK (horizontal Right flow)
        const layouted = await layoutGraph(rawNodes, rawEdges, 'RIGHT');
        if (!active) return;
        setNodes(layouted.nodes);
        setEdges(layouted.edges);
      } catch (err) {
        console.error('Failed to layout knowledge graph', err);
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [scopedResources, resources, signals]);

  const handleNodeClick = (_: React.MouseEvent, node: Node) => {
    setSelectedEntity(node.data as Record<string, unknown>);
  };

  const resourceCount = scopedResources.length || resources.length;

  if (resourceCount === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold text-[#0B2545]">Knowledge Graph</h1>
        <p className="text-xs text-[#64748B]">
          The graph is populated from the factory model. Create an enterprise and its children in Factory Structure first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200 select-none pb-8">
      {/* Top Header - Clean, without restrictive center/depth filters */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1 text-xs text-[#64748B]">
            <span className="font-bold uppercase text-[#134074]">Plant Topology</span>
            <span>·</span>
            <span className="font-mono">TIPA · DongNai · Factory 1 · ASSY</span>
          </div>
          <h1 className="text-xl md:text-2xl font-black text-[#0B2545] tracking-tight">
            Knowledge Graph: TIPA Enterprise
          </h1>
          <p className="text-xs text-[#64748B] mt-0.5">
            Full enterprise asset topology and telemetry graph (16 structure nodes · 12 live telemetry groups · 192 streaming signals).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-bold">
            <Activity className="w-4 h-4 text-emerald-600 animate-pulse" />
            <span>192 Signals Active (1 Hz)</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setNodes((prev) => [...prev]);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-bold text-[#0B2545] shadow-sm transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset View</span>
          </button>
        </div>
      </div>

      {/* Main Canvas Viewport with Drawer */}
      <div className="relative h-[720px] rounded-2xl border border-[#CBD5E1] bg-[#F8FAFC] shadow-sm overflow-hidden flex">
        <div className="flex-1 h-full relative">
          {isLoading && (
            <div className="absolute inset-0 bg-white/70 backdrop-blur-xs flex items-center justify-center z-10">
              <div className="flex items-center gap-2 text-xs font-bold text-[#0B2545]">
                <Activity className="w-4 h-4 animate-spin text-[#134074]" />
                <span>Computing hierarchical DAG layout…</span>
              </div>
            </div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            fitView
            minZoom={0.15}
            maxZoom={2.5}
            defaultEdgeOptions={{ type: 'labeled' }}
          >
            <Background color="#CBD5E1" gap={20} size={1} />
            <Controls className="!bg-white !border !border-[#E2E8F0] !shadow-sm !rounded-xl overflow-hidden" />
            <MiniMap
              nodeColor={(node) => {
                if (node.type === 'telemetryGroup') return '#10B981';
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
              <span>Asset Structure (CONTAINS)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-[#10B981]" />
              <span>Telemetry Group (HAS_SIGNAL)</span>
            </div>
          </div>
        </div>

        {/* Right Details Panel for Clicked Node (§9.6 TC-UI-KG-09) */}
        {selectedEntity && (
          <div className="w-80 md:w-96 bg-white border-l border-[#E2E8F0] h-full flex flex-col p-4 shadow-xl z-20 animate-in slide-in-from-right duration-200 overflow-y-auto">
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

            {/* Telemetry Group Drawer Detail */}
            {String(selectedEntity.kind || selectedEntity.type) === 'telemetryGroup' && (
              <div className="space-y-3 mt-3">
                <div className="p-3 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-300">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800">
                      1 Hz Observation Stream
                    </span>
                    <span className="text-[10px] font-mono font-bold bg-emerald-600 text-white px-2 py-0.5 rounded-full">
                      {((selectedEntity.signals as any[]) || []).length} TAGS ACTIVE
                    </span>
                  </div>
                  <p className="text-[11px] text-emerald-700 mt-1">
                    Real-time streaming telemetry from broker at 192.168.2.108:1883
                  </p>
                </div>

                <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
                  {((selectedEntity.signals as any[]) || []).map((sig: any, idx: number) => {
                    const val = sig.value !== undefined && sig.value !== null
                      ? (typeof sig.value === 'object' ? (sig.value?.v ?? JSON.stringify(sig.value)) : sig.value)
                      : (sig.currentValue !== undefined && sig.currentValue !== null ? sig.currentValue : '—');
                    return (
                      <div
                        key={sig.id || idx}
                        className="p-2.5 rounded-xl bg-[#F8FAFC] border border-[#CBD5E1] hover:border-emerald-400 transition"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs font-bold text-[#0B2545]">
                            {sig.key || sig.tag || sig.name}
                          </span>
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800">
                            {sig.quality || 'GOOD'}
                          </span>
                        </div>
                        <div className="mt-1 flex items-baseline justify-between">
                          <span className="text-base font-black font-mono text-[#0B2545]">
                            {String(val)}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {sig.unit || ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Resource Drawer Detail */}
            {String(selectedEntity.kind || selectedEntity.type) === 'resource' && (
              <div className="mt-4 space-y-3 text-xs">
                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748B]">Resource Type</span>
                    <span className="font-bold uppercase font-mono text-[#134074]">
                      {String(selectedEntity.type || '')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748B]">Resource Code</span>
                    <span className="font-mono font-semibold text-[#0B2545]">
                      {String(selectedEntity.code || '')}
                    </span>
                  </div>
                  {Boolean(selectedEntity.parentId) && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#64748B]">Parent Unit</span>
                      <span className="font-semibold text-[#0B2545]">
                        {resources.find((r) => r.id === selectedEntity.parentId)?.name || String(selectedEntity.parentId)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Direct Signals under this resource */}
                {(() => {
                  const unitSignals = signals.filter((s) => s.resourceId === selectedEntity.id);
                  if (unitSignals.length === 0) return null;
                  return (
                    <div className="space-y-2 mt-4">
                      <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                        <span>Direct Signals ({unitSignals.length})</span>
                        <span className="text-emerald-600 font-mono">● 1 Hz stream</span>
                      </div>
                      <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                        {unitSignals.map((sig) => (
                          <div
                            key={sig.id}
                            className="p-2 rounded-lg bg-[#F8FAFC] border border-slate-200 flex items-center justify-between"
                          >
                            <div>
                              <div className="font-mono font-bold text-xs text-[#0B2545]">
                                {sig.key || sig.tag}
                              </div>
                              <div className="text-[10px] text-slate-500 font-mono">
                                {sig.dataType || 'number'}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-mono font-black text-xs text-[#0B2545]">
                                {sig.value !== null && sig.value !== undefined
                                  ? String(sig.value)
                                  : sig.currentValue ?? '—'}
                              </div>
                              <div className="text-[9px] font-bold text-emerald-600">
                                {sig.quality || 'GOOD'}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
