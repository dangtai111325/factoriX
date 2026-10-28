import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export type Placement = { resource_id: string; x: number; y: number; w: number; h: number; locked?: boolean };

type ResourceData = { code: string; name: string; kind?: string; locked?: boolean };
type OutputData = { label: string };

function ResourceNode({ data, selected }: NodeProps) {
  const row = data as ResourceData;
  return (
    <button type="button" className="fx-node-card" aria-label={row.code}>
      {selected && !row.locked ? <NodeResizer minWidth={160} minHeight={72} color="#E11F25" /> : null}
      <Handle type="source" position={Position.Right} />
      <strong>{row.code}</strong>
      <span>{row.kind}</span>
      <span>{row.name}</span>
    </button>
  );
}

function OutputNode({ data }: NodeProps) {
  const row = data as OutputData;
  return (
    <div className="fx-output-card">
      <Handle type="target" position={Position.Left} />
      <span>{row.label}</span>
    </div>
  );
}

const nodeTypes = { resource: ResourceNode, output: OutputNode };

export function LayoutBoard(props: {
  resources: { id: string; code: string; name: string; kind?: string }[];
  outputs: { resourceId: string; label: string }[];
  placements: Placement[];
  onCommit: (placements: Placement[]) => void;
  onOpen: (id: string) => void;
  onOutput: (resourceId: string) => void;
}) {
  const built = useMemo(() => build(props.resources, props.outputs, props.placements), [props.resources, props.outputs, props.placements]);
  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  useEffect(() => setNodes(built.nodes), [built.nodes, setNodes]);

  function commit(next: Node[]) {
    props.onCommit(next.filter((node) => node.type === "resource").map((node) => ({
      resource_id: node.id,
      x: node.position.x,
      y: node.position.y,
      w: node.measured?.width || Number(node.style?.width) || 180,
      h: node.measured?.height || Number(node.style?.height) || 88,
      locked: Boolean((node.data as ResourceData).locked),
    })));
  }

  return (
    <div className="fx-flow" data-connectable="false">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={built.edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_event, _node, next) => commit(next)}
          onSelectionDragStop={(_event, next) => commit(next)}
          onNodeClick={(_event, node) => { if (node.type === "output") props.onOutput(String(node.data && (node.data as { resourceId?: string }).resourceId)); }}
          onNodeDoubleClick={(_event, node) => { if (node.type === "resource") props.onOpen(node.id); }}
          nodesConnectable={false}
          edgesReconnectable={false}
          nodesDraggable
          elementsSelectable
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

function build(
  resources: { id: string; code: string; name: string; kind?: string }[],
  outputs: { resourceId: string; label: string }[],
  placements: Placement[],
): { nodes: Node[]; edges: Edge[] } {
  const saved = new Map(placements.map((item) => [item.resource_id, item]));
  const nodes: Node[] = resources.map((item, index) => {
    const place = saved.get(item.id);
    const width = place?.w || 180;
    const height = place?.h || 88;
    return {
      id: item.id,
      type: "resource",
      ariaLabel: item.code,
      position: { x: place?.x ?? (index % 4) * 280, y: place?.y ?? Math.floor(index / 4) * 160 },
      data: { code: item.code, name: item.name, kind: item.kind, locked: place?.locked },
      style: { width, height },
      draggable: !place?.locked,
    };
  });
  const edges: Edge[] = [];
  outputs.forEach((item) => {
    const source = nodes.find((node) => node.id === item.resourceId);
    if (!source) return;
    const id = `out-${item.resourceId}`;
    nodes.push({
      id,
      type: "output",
      position: { x: source.position.x + Number(source.style?.width || 180) + 48, y: source.position.y },
      data: { label: item.label, resourceId: item.resourceId },
      draggable: false,
      selectable: true,
    });
    edges.push({ id: `edge-${id}`, source: item.resourceId, target: id, selectable: false, focusable: false, deletable: false });
  });
  return { nodes, edges };
}
