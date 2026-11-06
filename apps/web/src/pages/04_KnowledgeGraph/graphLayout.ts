import ELK from 'elkjs/lib/elk.bundled.js';
import { Node, Edge } from '@xyflow/react';

const elk = new ELK();

export async function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: 'RIGHT' | 'DOWN' = 'RIGHT'
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (nodes.length === 0) return { nodes: [], edges: [] };

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      // Keep the input order (siblings are sorted by name before layout) instead of reshuffling them.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    },
    children: nodes.map((node) => {
      const width =
        node.type === 'signal'
          ? 170
          : node.type === 'connection'
          ? 160
          : node.type === 'edgeNode'
          ? 150
          : node.type === 'telemetryGroup'
          ? 220
          : 200;
      const height =
        node.type === 'signal'
          ? 56
          : node.type === 'connection'
          ? 48
          : node.type === 'edgeNode'
          ? 44
          : node.type === 'telemetryGroup'
          ? 84
          : 70;
      return {
        id: node.id,
        width,
        height,
      };
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layouted = await elk.layout(graph);

  const nodePositions = new Map<string, { x: number; y: number }>();
  layouted.children?.forEach((child) => {
    nodePositions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  });

  const layoutedNodes: Node[] = nodes.map((node) => {
    const pos = nodePositions.get(node.id) || { x: 0, y: 0 };
    return {
      ...node,
      position: pos,
    };
  });

  return { nodes: layoutedNodes, edges };
}
