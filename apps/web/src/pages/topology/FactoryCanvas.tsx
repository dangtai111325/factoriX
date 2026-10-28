import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  Node,
  Edge,
  NodeChange,
  EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { MachineNode } from "./MachineNode";
import { Resource, LayoutDefinition } from "../../api/types";
import { api } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Tabs";
import { CheckIcon } from "../../components/ui/Icons";

export interface FactoryCanvasProps {
  resources: Resource[];
  activeLayout: LayoutDefinition | null;
  onSelectResource: (resourceId: string) => void;
  onRefreshLayouts: () => void;
}

export const FactoryCanvas: React.FC<FactoryCanvasProps> = ({
  resources,
  activeLayout,
  onSelectResource,
  onRefreshLayouts,
}) => {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const { success, error } = useToast();

  const nodeTypes = useMemo(() => ({ machine: MachineNode as any }), []);

  // Initialize or synchronize nodes from activeLayout or resources
  useEffect(() => {
    const machineResources = resources.filter(
      (r) => r.type_key === "machine" || !r.type_key
    );

    const savedNodes = activeLayout?.draft_json?.nodes || [];
    const savedMap = new Map(savedNodes.map((n) => [n.resource_id || n.id, n]));

    const initialNodes: Node[] = machineResources.map((res, index) => {
      const saved = savedMap.get(res.id);
      const x = saved?.x ?? (index % 4) * 260 + 60;
      const y = saved?.y ?? Math.floor(index / 4) * 160 + 60;

      return {
        id: res.id,
        type: "machine",
        position: { x, y },
        data: {
          resourceId: res.id,
          code: res.code,
          name: res.name,
          status: "RUNNING",
          onSelect: onSelectResource,
        },
      };
    });

    const savedEdges: Edge[] = (activeLayout?.draft_json?.edges || []).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: true,
      style: { stroke: "var(--brand-primary)", strokeWidth: 2 },
    }));

    setNodes(initialNodes);
    setEdges(savedEdges);
  }, [resources, activeLayout, onSelectResource]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const handleSaveDraft = async () => {
    if (!activeLayout) return;
    setSaving(true);
    try {
      const draftPayload = {
        version: activeLayout.version,
        draft: {
          nodes: nodes.map((n) => ({
            id: n.id,
            resource_id: n.id,
            x: n.position.x,
            y: n.position.y,
            type: n.type,
          })),
          edges: edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
          })),
        },
      };

      await api.patch(`/api/v1/layouts/${activeLayout.id}/draft`, draftPayload);
      success("Đã lưu bản nháp mặt bằng thành công.");
      onRefreshLayouts();
    } catch (err: any) {
      error("Không thể lưu bản nháp mặt bằng: " + (err.message || ""));
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!activeLayout) return;
    setPublishing(true);
    try {
      await api.post(`/api/v1/layouts/${activeLayout.id}/publish`);
      success("Đã phát hành sơ đồ mặt bằng công nghiệp!");
      onRefreshLayouts();
    } catch (err: any) {
      error("Phát hành sơ đồ thất bại: " + (err.message || ""));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", backgroundColor: "var(--bg-inset)" }}>
      {/* Top Floating Control Toolbar */}
      <div
        style={{
          position: "absolute",
          top: "16px",
          left: "16px",
          right: "16px",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          backgroundColor: "rgba(19, 27, 42, 0.85)",
          backdropFilter: "blur(8px)",
          border: "1px solid var(--border-medium)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>
            {activeLayout?.name || "Mặt bằng Tổng thể Nhà máy"}
          </span>
          <Badge variant="brand">
            BẢN PHÁT HÀNH: v{activeLayout?.published_revision ?? 0}
          </Badge>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            ({nodes.length} máy móc trên sơ đồ)
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Button
            variant="outline"
            size="sm"
            loading={saving}
            onClick={handleSaveDraft}
          >
            Lưu bản nháp
          </Button>

          <Button
            variant="primary"
            size="sm"
            icon={<CheckIcon size={14} />}
            loading={publishing}
            onClick={handlePublish}
          >
            Phát hành Sơ đồ
          </Button>
        </div>
      </div>

      {/* React Flow 2D Canvas */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={2.5}
        style={{ width: "100%", height: "100%" }}
      >
        <Background color="var(--border-medium)" gap={24} size={1.2} />
        <Controls
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-medium)",
            borderRadius: "var(--radius-sm)",
            fill: "var(--text-primary)",
          }}
        />
        <MiniMap
          nodeColor="var(--brand-primary)"
          maskColor="rgba(0, 0, 0, 0.6)"
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-medium)",
            borderRadius: "var(--radius-sm)",
          }}
        />
      </ReactFlow>
    </div>
  );
};
