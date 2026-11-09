import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  ControlButton,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Node,
  Edge,
  ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Activity, Cable, ChevronRight, Crosshair, ListTree, Loader2, Map as MapIcon, Maximize, RotateCcw, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { api } from '../../api/client';
import { ResourceNode, SignalItem } from '../../types';
import { resourceTypeLabel } from '../../components/common/ResourceTypeIcon';
import { formatValue, normalizeQuality, QUALITY_HINT, QUALITY_LABEL } from '../../lib/format';
import { qualityLine, summarizeQualities, useValuesReady } from '../01_Overview/signalSummary';
import { translateApiError } from '../../utils/apiErrors';
import { ancestorPath, compareResourcesByName, descendantIds } from '../../utils/resourceHierarchy';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
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

/**
 * Frame the graph without shrinking it below a readable size: large models overflow and are panned
 * (the overview map, toggled from the controls, helps to navigate).
 */
const FIT_VIEW_OPTIONS = { padding: 0.08, minZoom: 0.75, maxZoom: 1.25, duration: 300 };

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

/** Relations between resources that the structure view does not already draw. */
const CROSS_RELATIONS = new Set(['FEEDS', 'CONNECTED_TO', 'INSTALLED_AT', 'MONITORED_BY', 'PART_OF']);

interface NeighborNode {
  id: string;
  kind?: string;
  label?: string;
  name?: string;
  protocol?: string;
  health?: string;
  status?: string;
  archived_at?: string | null;
}

interface NeighborEdge {
  from: string;
  to: string;
  relation_code: string;
}

interface Expansion {
  nodes: Node[];
  edges: Edge[];
  connections: number;
  models: number;
}

type SelectedEntity =
  | { kind: 'resource'; id: string }
  | { kind: 'telemetryGroup'; resourceId: string }
  | { kind: 'connection'; id: string; name: string; protocol: string; health: string }
  | { kind: 'model'; id: string; name: string; status: string };

function protocolLabel(value: string): string {
  const key = value.toLowerCase();
  if (key.includes('modbus')) return 'Modbus TCP';
  if (key.includes('opc')) return 'OPC UA';
  if (key.includes('mqtt')) return 'MQTT';
  if (key.includes('websocket') || key === 'ws') return 'WebSocket';
  if (key.includes('http')) return 'HTTP';
  return value.toUpperCase();
}

function labeledEdge(id: string, source: string, target: string, relation: string, sourceLabel: string, targetLabel: string, color: string): Edge {
  return {
    id,
    source,
    target,
    type: 'labeled',
    markerEnd: { type: MarkerType.ArrowClosed, color },
    data: { relation_code: relation, sourceLabel, targetLabel },
  };
}

/** Convert a /graph/neighbors response into extra nodes/edges hung off the structure graph. */
function buildExpansion(
  payload: { nodes?: NeighborNode[]; edges?: NeighborEdge[] },
  resourceNames: Map<string, string>,
): Expansion {
  const nodesById = new Map((payload.nodes || []).map((node) => [String(node.id), node]));
  const signalOwner = new Map<string, string>();
  for (const edge of payload.edges || []) {
    if (edge.relation_code === 'HAS_SIGNAL') signalOwner.set(String(edge.to), String(edge.from));
  }
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  let connections = 0;
  let models = 0;

  for (const edge of payload.edges || []) {
    const from = String(edge.from);
    const to = String(edge.to);
    if (edge.relation_code === 'COLLECTED_VIA' || edge.relation_code === 'USED_IN') {
      const owner = signalOwner.get(from);
      const target = nodesById.get(to);
      if (!owner || !target || !resourceNames.has(owner)) continue;
      const isConnection = edge.relation_code === 'COLLECTED_VIA';
      const nodeId = `${isConnection ? 'conn' : 'model'}-${to}`;
      const name = String(target.label || target.name || (isConnection ? 'Connection' : 'Data model'));
      if (!nodes.has(nodeId)) {
        if (isConnection) connections += 1;
        else models += 1;
        nodes.set(nodeId, {
          id: nodeId,
          type: isConnection ? 'connection' : 'model',
          position: { x: 0, y: 0 },
          data: isConnection
            ? {
                kind: 'connection',
                id: to,
                label: name,
                protocol: String(target.protocol || ''),
                protocolLabel: protocolLabel(String(target.protocol || '')),
                health: String(target.health || ''),
              }
            : { kind: 'model', id: to, label: name, status: String(target.status || '') },
        });
      }
      const groupId = `telemetry-${owner}`;
      const edgeId = `${groupId}->${nodeId}-${edge.relation_code}`;
      if (!edges.has(edgeId)) {
        edges.set(
          edgeId,
          labeledEdge(
            edgeId,
            groupId,
            nodeId,
            edge.relation_code,
            `${resourceNames.get(owner)} data`,
            name,
            isConnection ? '#2563EB' : '#7C3AED',
          ),
        );
      }
      continue;
    }
    if (CROSS_RELATIONS.has(edge.relation_code) && resourceNames.has(from) && resourceNames.has(to)) {
      const edgeId = `${from}->${to}-${edge.relation_code}`;
      edges.set(
        edgeId,
        labeledEdge(edgeId, from, to, edge.relation_code, resourceNames.get(from) || '', resourceNames.get(to) || '', '#64748B'),
      );
    }
  }
  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()), connections, models };
}

/** Counts shown on a "Signals" node of the graph (see TelemetryGroupNodeComponent). */
function groupCounts(list: SignalItem[], valuesReady: boolean) {
  const summary = summarizeQualities(list);
  return {
    signalCount: summary.total,
    goodCount: summary.good,
    activeCount: summary.active,
    pausedCount: summary.paused,
    valuesLoading: !valuesReady,
    statusUnknown: summary.noConnection > 0,
  };
}

export const KnowledgeGraphPage: React.FC = () => {
  const { resources, signals, setSelectedResourceId, loadState } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusParam = searchParams.get('resourceId') || '';

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<SelectedEntity | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [layoutTrigger, setLayoutTrigger] = useState(0);
  const [expansions, setExpansions] = useState<Record<string, Expansion>>({});
  const [expanding, setExpanding] = useState<string | null>(null);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;
  const appliedLayoutTrigger = useRef(0);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  /**
   * Fit the graph; when it is too large to fit at a readable zoom, start from its top-left corner
   * (the root of the hierarchy) instead of showing the clipped middle.
   */
  const frameGraph = useCallback(async () => {
    const instance = flowRef.current;
    const canvas = canvasRef.current;
    if (!instance || !canvas) return;
    await instance.fitView(FIT_VIEW_OPTIONS);
    const current = instance.getNodes();
    if (!current.length) return;
    const { zoom, x, y } = instance.getViewport();
    if (zoom > FIT_VIEW_OPTIONS.minZoom + 0.001) return;
    const bounds = instance.getNodesBounds(current);
    const margin = 24;
    const overflowX = bounds.width * zoom + 2 * margin > canvas.clientWidth;
    const overflowY = bounds.height * zoom + 2 * margin > canvas.clientHeight;
    if (!overflowX && !overflowY) return;
    await instance.setViewport(
      {
        x: overflowX ? margin - bounds.x * zoom : x,
        y: overflowY ? margin - bounds.y * zoom : y,
        zoom,
      },
      { duration: 200 },
    );
  }, []);

  const resourceById = useMemo(() => new Map(resources.map((item) => [item.id, item])), [resources]);
  const focus = focusParam ? resourceById.get(focusParam) : undefined;

  // Resources in view: the whole model, or the focused resource with its ancestors and descendants.
  // Sorted naturally by name: the layout keeps this order, so siblings read 01, 02, 03…
  const viewResources = useMemo(() => {
    const sorted = [...resources].sort(compareResourcesByName);
    if (!focus) return sorted;
    const keep = descendantIds(resources, focus.id);
    ancestorPath(resources, focus.id).forEach((id) => keep.add(id));
    return sorted.filter((item) => keep.has(item.id));
  }, [resources, focus]);

  const viewIds = useMemo(() => new Set(viewResources.map((item) => item.id)), [viewResources]);
  const viewSignals = useMemo(() => signals.filter((s) => viewIds.has(s.resourceId)), [signals, viewIds]);

  const signalsByResource = useMemo(() => {
    const map = new Map<string, SignalItem[]>();
    for (const s of viewSignals) {
      const list = map.get(s.resourceId) || [];
      list.push(s);
      map.set(s.resourceId, list);
    }
    return map;
  }, [viewSignals]);

  // R3-KG-01: no "0 of N good" while the first latest values are still loading.
  const valuesReady = useValuesReady(loadState, signals);
  const viewSummary = useMemo(() => summarizeQualities(viewSignals), [viewSignals]);
  const viewLine = qualityLine(viewSummary, valuesReady);

  const resourceNames = useMemo(() => new Map(viewResources.map((item) => [item.id, item.name])), [viewResources]);
  const visibleExpansions = useMemo(
    () => Object.entries(expansions).filter(([resourceId]) => viewIds.has(resourceId)),
    [expansions, viewIds],
  );

  // Topology fingerprint: changes only when the structure, signal ownership or expansions change.
  // Live value updates do not alter it, so the canvas does not re-layout on every sample.
  const topologyFingerprint = useMemo(() => {
    const rPart = viewResources
      .map((r) => `${r.id}:${r.parentId}:${r.name}:${r.code}:${r.type}`)
      .sort()
      .join(';');
    const sPart = viewSignals
      .map((s) => `${s.id}:${s.resourceId}`)
      .sort()
      .join(';');
    const ePart = visibleExpansions
      .map(([id, exp]) => `${id}:${exp.nodes.map((n) => n.id).join(',')}:${exp.edges.length}`)
      .sort()
      .join(';');
    return `${focus?.id || ''}#${rPart}#${sPart}#${ePart}`;
  }, [viewResources, viewSignals, visibleExpansions, focus]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (viewResources.length === 0) {
          setNodes([]);
          setEdges([]);
          return;
        }
        const rawNodes: Node[] = viewResources.map((r) => ({
          id: r.id,
          type: 'resource',
          position: { x: 0, y: 0 },
          data: { label: r.name, name: r.name, code: r.code, type: r.type, type_key: r.type, isCenter: r.id === focus?.id },
        }));
        const rawEdges: Edge[] = [];
        for (const r of viewResources) {
          const parent = r.parentId ? resourceById.get(r.parentId) : undefined;
          if (parent && viewIds.has(parent.id)) {
            rawEdges.push(labeledEdge(`${parent.id}->${r.id}-CONTAINS`, parent.id, r.id, 'CONTAINS', parent.name, r.name, '#134074'));
          }
        }
        // Data nodes follow the resource order (Map iteration order is insertion order, not sorted).
        const dataOrder = viewResources.filter((r) => signalsByResource.has(r.id)).map((r) => r.id);
        dataOrder.forEach((resId) => {
          const list = signalsByResource.get(resId) || [];
          const res = resourceById.get(resId);
          const groupId = `telemetry-${resId}`;
          rawNodes.push({
            id: groupId,
            type: 'telemetryGroup',
            position: { x: 0, y: 0 },
            data: {
              kind: 'telemetryGroup',
              resourceId: resId,
              resourceName: res?.name || '',
              ...groupCounts(list, valuesReady),
            },
          });
          rawEdges.push(labeledEdge(`${resId}->${groupId}-HAS_SIGNAL`, resId, groupId, 'HAS_SIGNAL', res?.name || '', 'Signals', '#10B981'));
        });
        const nodeIds = new Set(rawNodes.map((n) => n.id));
        for (const [, exp] of visibleExpansions) {
          for (const node of exp.nodes) {
            if (!nodeIds.has(node.id)) {
              nodeIds.add(node.id);
              rawNodes.push(node);
            }
          }
        }
        const edgeIds = new Set(rawEdges.map((e) => e.id));
        for (const [, exp] of visibleExpansions) {
          for (const edge of exp.edges) {
            if (!edgeIds.has(edge.id) && nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
              edgeIds.add(edge.id);
              rawEdges.push(edge);
            }
          }
        }

        // Keep the user's arrangement unless new nodes appeared or Reset layout was pressed.
        const resetRequested = appliedLayoutTrigger.current !== layoutTrigger;
        const current = nodesRef.current;
        if (!resetRequested && current.length > 0) {
          const positions = new Map(current.map((n) => [n.id, n.position]));
          if (rawNodes.every((n) => positions.has(n.id))) {
            setNodes(rawNodes.map((n) => ({ ...n, position: positions.get(n.id) || n.position })));
            setEdges(rawEdges);
            return;
          }
        }

        setIsLoading(true);
        const layouted = await layoutGraph(rawNodes, rawEdges, 'RIGHT');
        if (!active) return;
        appliedLayoutTrigger.current = layoutTrigger;
        setNodes(layouted.nodes);
        setEdges(layouted.edges);
        // Frame the new arrangement once React Flow has measured the nodes.
        window.setTimeout(() => {
          if (active) void frameGraph();
        }, 60);
      } catch (err) {
        console.error('Failed to lay out the knowledge graph', err);
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // The fingerprint captures every structural input; values are patched by the effect below.
  }, [topologyFingerprint, layoutTrigger]);

  // Live quality counts on data nodes, without re-layout.
  const qualityFingerprint = useMemo(
    () => `${valuesReady}#` + viewSignals.map((s) => `${s.id}:${normalizeQuality(s.quality)}`).join(';'),
    [viewSignals, valuesReady],
  );
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.type !== 'telemetryGroup') return node;
        const list = signalsByResource.get(String(node.data?.resourceId || '')) || [];
        const counts = groupCounts(list, valuesReady);
        const same = (Object.keys(counts) as Array<keyof typeof counts>).every((key) => node.data?.[key] === counts[key]);
        if (same) return node;
        return { ...node, data: { ...node.data, ...counts } };
      }),
    );
  }, [qualityFingerprint, signalsByResource, setNodes, valuesReady]);

  const handleNodeClick = (_: React.MouseEvent, node: Node) => {
    const data = (node.data || {}) as Record<string, unknown>;
    if (node.type === 'resource') setSelected({ kind: 'resource', id: node.id });
    else if (node.type === 'telemetryGroup') setSelected({ kind: 'telemetryGroup', resourceId: String(data.resourceId || '') });
    else if (node.type === 'connection')
      setSelected({
        kind: 'connection',
        id: String(data.id || ''),
        name: String(data.label || ''),
        protocol: String(data.protocolLabel || ''),
        health: String(data.health || ''),
      });
    else if (node.type === 'model')
      setSelected({ kind: 'model', id: String(data.id || ''), name: String(data.label || ''), status: String(data.status || '') });
  };

  const expand = useCallback(
    async (resourceId: string) => {
      setExpanding(resourceId);
      setExpandError(null);
      try {
        const payload = await api<{ nodes?: NeighborNode[]; edges?: NeighborEdge[] }>(
          `/api/v1/graph/neighbors?resource_id=${encodeURIComponent(resourceId)}&depth=2&include_data=true`,
        );
        const live = (payload.nodes || []).filter((node) => !node.archived_at);
        const exp = buildExpansion({ nodes: live, edges: payload.edges }, resourceNames);
        setExpansions((prev) => ({ ...prev, [resourceId]: exp }));
      } catch (caught) {
        setExpandError(translateApiError(caught));
      } finally {
        setExpanding(null);
      }
    },
    [resourceNames],
  );

  // Escape closes the details panel (unless a dialog is open or focus is in a text field).
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      setSelected(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const collapse = (resourceId: string) => {
    setExpansions((prev) => {
      const next = { ...prev };
      delete next[resourceId];
      return next;
    });
  };

  const focusOn = (resourceId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (resourceId) next.set('resourceId', resourceId);
    else next.delete('resourceId');
    setSearchParams(next, { replace: true });
    setLayoutTrigger((value) => value + 1);
  };

  const openInHierarchy = (resourceId: string) => {
    setSelectedResourceId(resourceId);
    navigate(`/factory/structure?resourceId=${encodeURIComponent(resourceId)}`);
  };

  // ---- header content (all real data) ----
  const focusPath = focus
    ? ancestorPath(resources, focus.id)
        .map((id) => resourceById.get(id))
        .filter(Boolean) as ResourceNode[]
    : [];
  const roots = resources.filter((item) => !item.parentId || !resourceById.has(item.parentId));
  const groupCount = signalsByResource.size;
  const signalTotal = viewSignals.length;

  if (resources.length === 0 && loadState !== 'ready') {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Knowledge Graph</h1>
        <div className="fx-card border border-[#E3EAF3]">
          <LoadStateNotice subject="the factory model" />
        </div>
      </div>
    );
  }

  if (resources.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Knowledge Graph</h1>
        <p className="fx-page-subtitle">
          The graph is drawn from the factory model. Add an enterprise and its sites, lines and machines in Hierarchy
          Structure first.
        </p>
        <button
          type="button"
          onClick={() => navigate('/factory/structure')}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[#EF1B24] text-white text-[13px] font-semibold hover:bg-[#D9141D]"
        >
          <ListTree className="w-4 h-4" aria-hidden="true" />
          Open Hierarchy Structure
        </button>
      </div>
    );
  }

  const drawerResource =
    selected?.kind === 'resource'
      ? resourceById.get(selected.id)
      : selected?.kind === 'telemetryGroup'
        ? resourceById.get(selected.resourceId)
        : undefined;
  const drawerSignals = drawerResource ? signals.filter((s) => s.resourceId === drawerResource.id) : [];
  const drawerExpansion = drawerResource ? expansions[drawerResource.id] : undefined;

  return (
    <div className="space-y-4 animate-in fade-in duration-200 pb-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="Graph scope" className="flex flex-wrap items-center gap-1 mb-1 text-xs text-[#64748B]">
            {focus ? (
              <>
                <button type="button" onClick={() => focusOn(null)} className="hover:underline">
                  Whole model
                </button>
                {focusPath.map((item) => (
                  <React.Fragment key={item.id}>
                    <ChevronRight className="w-3 h-3 text-[#CBD5E1]" aria-hidden="true" />
                    {item.id === focus.id ? (
                      <span className="font-semibold text-[#334568]">{item.name}</span>
                    ) : (
                      <button type="button" onClick={() => focusOn(item.id)} className="hover:underline">
                        {item.name}
                      </button>
                    )}
                  </React.Fragment>
                ))}
              </>
            ) : (
              <span>{roots.length === 1 ? roots[0].name : `${roots.length} top-level resources`}</span>
            )}
          </nav>
          <h1 className="fx-page-title">{focus ? `Knowledge Graph: ${focus.name}` : 'Knowledge Graph'}</h1>
          <p className="fx-page-subtitle">
            {viewResources.length} {viewResources.length === 1 ? 'resource' : 'resources'} · {groupCount}{' '}
            {groupCount === 1 ? 'resource with data' : 'resources with data'} · {signalTotal}{' '}
            {signalTotal === 1 ? 'signal' : 'signals'}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div
            role="status"
            aria-busy={viewLine.tone === 'loading' || undefined}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-semibold ${
              viewLine.tone === 'good'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : viewLine.tone === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-slate-50 border-slate-200 text-slate-600'
            }`}
          >
            {viewLine.tone === 'loading' ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Activity className="w-4 h-4" aria-hidden="true" />
            )}
            <span>{viewLine.text}</span>
          </div>
          {focus && (
            <button
              type="button"
              onClick={() => focusOn(null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B2545]"
            >
              Show whole model
            </button>
          )}
          <button
            type="button"
            onClick={() => setLayoutTrigger((prev) => prev + 1)}
            title="Arrange the graph automatically again"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B2545]"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Reset layout</span>
          </button>
        </div>
      </div>

      {focusParam && !focus && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          The requested resource is not in the model (it may have been archived). Showing the whole model.
        </p>
      )}

      <div className="relative h-[560px] md:h-[720px] rounded-2xl border border-[#CBD5E1] bg-[#F8FAFC] shadow-sm overflow-hidden flex">
        <div ref={canvasRef} className="flex-1 h-full relative">
          {isLoading && (
            <div className="absolute inset-0 bg-white/70 backdrop-blur-xs flex items-center justify-center z-10">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#0B2545]">
                <Loader2 className="w-4 h-4 animate-spin text-[#134074]" aria-hidden="true" />
                <span>Arranging the graph…</span>
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
            onPaneClick={() => setSelected(null)}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            nodesDraggable
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={0.15}
            maxZoom={2.5}
            defaultEdgeOptions={{ type: 'labeled' }}
          >
            <Background color="#CBD5E1" gap={20} size={1} />
            <Controls
              showFitView={false}
              className="!bg-white !border !border-[#E2E8F0] !shadow-sm !rounded-xl overflow-hidden"
            >
              <ControlButton onClick={() => void frameGraph()} title="Fit the graph" aria-label="Fit the graph">
                <Maximize className="w-3.5 h-3.5" aria-hidden="true" />
              </ControlButton>
              <ControlButton
                onClick={() => setShowMiniMap((value) => !value)}
                title={showMiniMap ? 'Hide overview map' : 'Show overview map'}
                aria-label={showMiniMap ? 'Hide overview map' : 'Show overview map'}
                aria-pressed={showMiniMap}
              >
                <MapIcon className="w-3.5 h-3.5" aria-hidden="true" />
              </ControlButton>
            </Controls>
            {showMiniMap && (
              <MiniMap
                position="top-right"
                pannable
                zoomable
                ariaLabel="Overview map"
                nodeColor={(node) => {
                  if (node.type === 'telemetryGroup') return '#10B981';
                  if (node.type === 'connection') return '#3B82F6';
                  if (node.type === 'model') return '#7C3AED';
                  return '#64748B';
                }}
                className="!border !border-[#E2E8F0] !rounded-xl !overflow-hidden !shadow-sm"
              />
            )}
          </ReactFlow>

          <div className="absolute bottom-3 left-14 bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-xl border border-[#E2E8F0] shadow-sm flex flex-wrap items-center gap-3 text-[11px] font-medium text-[#475569] pointer-events-none">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-[#64748B]" />
              Resource (contains)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-[#10B981]" />
              Signals (has data)
            </span>
            {visibleExpansions.some(([, exp]) => exp.connections + exp.models > 0) && (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-[#3B82F6]" />
                  Connection (collected via)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-[#7C3AED]" />
                  Data model (used in)
                </span>
              </>
            )}
          </div>
        </div>

        {selected && (
          <aside
            aria-label="Details"
            className="absolute inset-0 w-full md:relative md:inset-auto md:w-96 bg-white border-l border-[#E2E8F0] h-full flex flex-col p-4 shadow-xl z-20 animate-in slide-in-from-right duration-200 overflow-y-auto"
          >
            <div className="flex items-start justify-between gap-2 pb-3 border-b border-[#E2E8F0]">
              <div className="min-w-0">
                <span className="text-[10px] uppercase px-2 py-0.5 rounded bg-[#F1F5F9] text-[#475569] font-semibold">
                  {selected.kind === 'resource' && drawerResource
                    ? resourceTypeLabel(drawerResource.type)
                    : selected.kind === 'telemetryGroup'
                      ? 'Signals'
                      : selected.kind === 'connection'
                        ? 'Connection'
                        : 'Data model'}
                </span>
                <h2 className="text-sm font-bold text-[#0B2545] mt-1 break-words">
                  {selected.kind === 'connection' || selected.kind === 'model'
                    ? selected.name
                    : selected.kind === 'telemetryGroup'
                      ? `Signals of ${drawerResource?.name || ''}`
                      : drawerResource?.name}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close details"
                className="p-1 rounded-md text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {selected.kind === 'connection' && (
              <div className="mt-3 space-y-3 text-xs">
                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748B]">Protocol</span>
                    <span className="font-semibold text-[#0B2545]">{selected.protocol || '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#64748B]">Health</span>
                    <span className="font-semibold text-[#0B2545] capitalize">{selected.health.toLowerCase() || '—'}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/collector/connections')}
                  className="w-full h-8 rounded-lg border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B2545]"
                >
                  Open Connections
                </button>
              </div>
            )}

            {selected.kind === 'model' && (
              <div className="mt-3 space-y-3 text-xs">
                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-between">
                  <span className="text-[#64748B]">Status</span>
                  <span className="font-semibold text-[#0B2545] capitalize">{selected.status.toLowerCase() || '—'}</span>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(selected.id ? `/models?model=${encodeURIComponent(selected.id)}` : '/models')}
                  className="w-full h-8 rounded-lg border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B2545]"
                >
                  Open data model
                </button>
              </div>
            )}

            {drawerResource && (selected.kind === 'resource' || selected.kind === 'telemetryGroup') && (
              <div className="mt-3 space-y-3 text-xs">
                {selected.kind === 'resource' && (
                  <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#64748B]">Code</span>
                      <span className="font-mono font-semibold text-[#0B2545] break-all text-right">{drawerResource.code}</span>
                    </div>
                    {drawerResource.parentId && resourceById.get(drawerResource.parentId) && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[#64748B]">Parent</span>
                        <span className="font-semibold text-[#0B2545] text-right break-words">
                          {resourceById.get(drawerResource.parentId)?.name}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#64748B]">Sub-units</span>
                      <span className="font-semibold text-[#0B2545]">
                        {resources.filter((item) => item.parentId === drawerResource.id).length}
                      </span>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => openInHierarchy(drawerResource.id)}
                    className="h-8 rounded-lg border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B2545] inline-flex items-center justify-center gap-1.5"
                  >
                    <ListTree className="w-3.5 h-3.5" aria-hidden="true" />
                    Open in hierarchy
                  </button>
                  <button
                    type="button"
                    onClick={() => focusOn(drawerResource.id)}
                    disabled={focus?.id === drawerResource.id}
                    className="h-8 rounded-lg border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B2545] inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
                    Focus here
                  </button>
                </div>

                <div className="p-3 rounded-xl border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[#0B2545]">Connections and data models</span>
                    {drawerExpansion ? (
                      <button type="button" onClick={() => collapse(drawerResource.id)} className="text-[#2A82E7] hover:underline">
                        Hide
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void expand(drawerResource.id)}
                        disabled={expanding === drawerResource.id}
                        className="inline-flex items-center gap-1 text-[#2A82E7] hover:underline disabled:opacity-60"
                      >
                        {expanding === drawerResource.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <Cable className="w-3 h-3" aria-hidden="true" />
                        )}
                        Show in graph
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-[#64748B]">
                    {drawerExpansion
                      ? `${drawerExpansion.connections} ${drawerExpansion.connections === 1 ? 'connection' : 'connections'} and ${drawerExpansion.models} ${drawerExpansion.models === 1 ? 'data model' : 'data models'} linked to this resource and the resources around it.`
                      : 'Adds the connections that collect this data and the data models that use it.'}
                  </p>
                  {expandError && expanding === null && !drawerExpansion && (
                    <p role="alert" className="text-[11px] text-red-600">
                      {expandError}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#64748B]">
                    Signals ({drawerSignals.length})
                  </div>
                  {drawerSignals.length === 0 ? (
                    <p className="text-[#94A3B8]">No signals are bound to this resource.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                      {drawerSignals.map((sig) => {
                        const quality = normalizeQuality(sig.quality);
                        const label = sig.displayName || sig.key || sig.name;
                        return (
                          <div key={sig.id} className="p-2 rounded-lg bg-[#F8FAFC] border border-slate-200 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-xs text-[#0B2545] truncate" title={label}>
                                {label}
                              </div>
                              {sig.key && sig.key !== label && (
                                <div className="text-[10px] text-slate-500 font-mono truncate">{sig.key}</div>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-mono font-bold text-xs text-[#0B2545]">
                                {formatValue(sig.value)}
                                {sig.unit ? <span className="font-sans font-normal text-[10px] text-slate-500 ml-1">{sig.unit}</span> : null}
                              </div>
                              <div
                                title={QUALITY_HINT[quality]}
                                className={`text-[10px] font-semibold ${
                                  quality === 'GOOD'
                                    ? 'text-emerald-600'
                                    : quality === 'UNCERTAIN'
                                      ? 'text-amber-600'
                                      : quality === 'NO_DATA' ||
                                          quality === 'DISABLED' ||
                                          quality === 'PAUSED' ||
                                          quality === 'NO_CONNECTION' ||
                                          quality === 'STALE'
                                        ? 'text-slate-500'
                                        : 'text-red-600'
                                }`}
                              >
                                {QUALITY_LABEL[quality]}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
};
