import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  Activity,
  RotateCcw,
  X,
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
  const { scopedResources, resources, signals } = useApp();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedEntity, setSelectedEntity] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [layoutTrigger, setLayoutTrigger] = useState(0);
  const isInitialLayoutDoneRef = useRef(false);

  const resourceList = useMemo(() => {
    return scopedResources.length > 0 ? scopedResources : resources;
  }, [scopedResources, resources]);

  // Topology fingerprint: changes ONLY when resources or signal-to-resource mappings change.
  // Crucially: live telemetry value updates do NOT alter this key, eliminating graph flickering.
  const topologyFingerprint = useMemo(() => {
    const rPart = resourceList
      .map((r) => `${r.id}:${r.parentId}:${r.name}:${r.code}:${r.type}`)
      .sort()
      .join(';');
    const sPart = signals
      .map((s) => `${s.id}:${s.resourceId || ''}`)
      .sort()
      .join(';');
    return `${rPart}###${sPart}`;
  }, [resourceList, signals.map((s) => `${s.id}:${s.resourceId || ''}`).join(';')]);

  // Build full factory topology DAG (§9.6 TC-UI-KG-01..09)
  useEffect(() => {
    let active = true;

    void (async () => {
      try {
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
          const teleNodeId = `telemetry-${resId}`;

          rawNodes.push({
            id: teleNodeId,
            type: 'telemetryGroup',
            data: {
              id: teleNodeId,
              kind: 'telemetryGroup',
              resourceId: resId,
              label: `Data (${sigList.length})`,
              signalCount: sigList.length,
              resourceName: resName,
              onClick: () => {
                setSelectedEntity({
                  kind: 'telemetryGroup',
                  id: teleNodeId,
                  resourceId: resId,
                  name: `${resName} Data`,
                  resourceName: resName,
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
              targetLabel: 'Data',
            },
          });
        });

        // Check if user has already positioned or dragged existing nodes
        if (isInitialLayoutDoneRef.current && layoutTrigger === 0 && nodes.length > 0) {
          const currentPositions = new Map<string, { x: number; y: number }>();
          nodes.forEach((n) => currentPositions.set(n.id, n.position));

          const allNodesExist = rawNodes.every((n) => currentPositions.has(n.id));
          if (allNodesExist) {
            setNodes(
              rawNodes.map((n) => ({
                ...n,
                position: currentPositions.get(n.id) || n.position,
              }))
            );
            setEdges(rawEdges);
            return;
          }
        }

        // Layout DAG with ELK (horizontal Right flow)
        setIsLoading(true);
        const layouted = await layoutGraph(rawNodes, rawEdges, 'RIGHT');
        if (!active) return;
        setNodes(layouted.nodes);
        setEdges(layouted.edges);
        isInitialLayoutDoneRef.current = true;
      } catch (err) {
        console.error('Failed to layout factory graph', err);
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [topologyFingerprint, layoutTrigger]);

  const handleNodeClick = (_: React.MouseEvent, node: Node) => {
    setSelectedEntity(node.data as Record<string, unknown>);
  };

  const handleResetLayout = () => {
    setLayoutTrigger((prev) => prev + 1);
  };

  // Live signals for the selected entity in the drawer (updates in real time without touching canvas)
  const drawerSignals = useMemo(() => {
    if (!selectedEntity) return [];
    const targetId = (selectedEntity.resourceId as string) || (selectedEntity.id as string);
    return signals.filter((s) => s.resourceId === targetId);
  }, [selectedEntity, signals]);

  const resourceCount = resourceList.length;

  if (resourceCount === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold text-[#0B2545]">Factory Graph</h1>
        <p className="text-xs text-[#64748B]">
          The graph is populated from the factory model. Create an enterprise and its children in Factory Structure first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200 select-none pb-8">
      {/* Top Header - Factory Graph */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1 text-xs text-[#64748B]">
            <span className="font-bold uppercase text-[#134074]">Plant Topology</span>
            <span>·</span>
            <span className="font-mono">TIPA · DongNai · Factory 1 · ASSY</span>
          </div>
          <h1 className="text-xl md:text-2xl font-black text-[#0B2545] tracking-tight">
            Factory Graph: TIPA Enterprise
          </h1>
          <p className="text-xs text-[#64748B] mt-0.5">
            Full enterprise asset topology and telemetry graph (16 structure nodes · 12 live data groups · 192 streaming signals).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-bold">
            <Activity className="w-4 h-4 text-emerald-600 animate-pulse" />
            <span>192 Signals Active (1 Hz)</span>
          </div>
          <button
            type="button"
            onClick={handleResetLayout}
            title="Reset layout to auto-aligned hierarchical graph"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-bold text-[#0B2545] shadow-sm transition active:scale-95"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Layout</span>
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
            nodesDraggable={true}
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
              <span>Data Group (HAS_SIGNAL)</span>
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
                      {drawerSignals.length} TAGS ACTIVE
                    </span>
                  </div>
                  <p className="text-[11px] text-emerald-700 mt-1">
                    Real-time streaming telemetry from broker at 192.168.2.108:1883
                  </p>
                </div>

                <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
                  {drawerSignals.length === 0 ? (
                    <div className="text-center py-6 text-xs text-slate-400">No signals assigned to this unit.</div>
                  ) : (
                    drawerSignals.map((sig, idx) => {
                      const val =
                        sig.value !== undefined && sig.value !== null
                          ? typeof sig.value === 'object'
                            ? (sig.value as any)?.v ?? JSON.stringify(sig.value)
                            : sig.value
                          : sig.currentValue !== undefined && sig.currentValue !== null
                          ? sig.currentValue
                          : '—';
                      const isGood = (sig.quality || '').toLowerCase() === 'good';
                      return (
                        <div
                          key={sig.id || idx}
                          className="p-2.5 rounded-xl bg-[#F8FAFC] border border-[#CBD5E1] hover:border-emerald-400 transition"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-xs font-bold text-[#0B2545]">
                              {sig.key || sig.tag || sig.name}
                            </span>
                            <span
                              className={`text-[9px] font-bold px-1.5 py-0.2 rounded ${
                                isGood ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                              }`}
                            >
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
                    })
                  )}
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
                        {resources.find((r) => r.id === selectedEntity.parentId)?.name ||
                          String(selectedEntity.parentId)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Direct Signals under this resource */}
                {drawerSignals.length > 0 && (
                  <div className="space-y-2 mt-4">
                    <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                      <span>Direct Signals ({drawerSignals.length})</span>
                      <span className="text-emerald-600 font-mono">● 1 Hz stream</span>
                    </div>
                    <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                      {drawerSignals.map((sig) => {
                        const val =
                          sig.value !== undefined && sig.value !== null
                            ? typeof sig.value === 'object'
                              ? (sig.value as any)?.v ?? JSON.stringify(sig.value)
                              : sig.value
                            : sig.currentValue !== undefined && sig.currentValue !== null
                            ? sig.currentValue
                            : '—';
                        const isGood = (sig.quality || '').toLowerCase() === 'good';
                        return (
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
                                {String(val)}
                              </div>
                              <div
                                className={`text-[9px] font-bold ${
                                  isGood ? 'text-emerald-600' : 'text-red-600'
                                }`}
                              >
                                {sig.quality || 'GOOD'}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
