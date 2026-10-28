import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type GraphData = { label: string; kind: string };

function GraphNode({ data }: NodeProps) {
  const row = data as GraphData;
  return (
    <div className={row.kind === "signal" ? "fx-output-card" : "fx-node-card"}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <strong>{row.label}</strong>
      <span>{row.kind}</span>
    </div>
  );
}

const nodeTypes = { graph: GraphNode };

export function GraphBoard(props: {
  center: string;
  nodes: { id: string; label: string; kind: string }[];
  edges: { id: string; source: string; target: string; label: string }[];
  onOpen: (id: string) => void;
}) {
  const built = useMemo(() => layout(props.nodes, props.edges), [props.nodes, props.edges]);
  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  useEffect(() => setNodes(built.nodes), [built.nodes, setNodes]);
  return (
    <div className="fx-flow" data-connectable="false">
      <ReactFlowProvider>
        <ReactFlow
          key={props.center}
          nodes={nodes}
          edges={built.edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDoubleClick={(_event, node) => { if (!node.id.startsWith("signal-")) props.onOpen(node.id); }}
          nodesConnectable={false}
          edgesReconnectable={false}
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

function layout(
  items: { id: string; label: string; kind: string }[],
  links: { id: string; source: string; target: string; label: string }[],
): { nodes: Node[]; edges: Edge[] } {
  const nodes = items.map((item, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(items.length, 1);
    return {
      id: item.id,
      type: "graph",
      position: { x: 360 + Math.cos(angle) * 220, y: 220 + Math.sin(angle) * 160 },
      data: { label: item.label, kind: item.kind },
      draggable: !item.id.startsWith("signal-"),
    };
  });
  const edges = links.map((item) => ({
    id: item.id,
    source: item.source,
    target: item.target,
    label: item.label,
    selectable: false,
    focusable: false,
    deletable: false,
  }));
  return { nodes, edges };
}
