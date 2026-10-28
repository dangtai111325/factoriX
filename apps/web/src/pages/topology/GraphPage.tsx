import React, { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Resource } from "../../api/types";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { LayersIcon, RefreshIcon, ChevronRightIcon } from "../../components/ui/Icons";

interface GraphNeighborResponse {
  nodes: Array<{ id: string; code: string; name: string; type_key?: string }>;
  edges: Array<{ from_id: string; to_id: string; relation_code: string }>;
}

export const GraphPage: React.FC = () => {
  const [resources, setResources] = useState<Resource[]>([]);
  const [selectedResourceId, setSelectedResourceId] = useState<string>("");
  const [depth, setDepth] = useState<number>(2);
  const [graphData, setGraphData] = useState<GraphNeighborResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function loadResources() {
      try {
        const res = await api.get<{ items: Resource[] }>("/api/v1/resources?view=all&limit=200");
        const list = res.items || [];
        setResources(list);
        if (list.length > 0) {
          setSelectedResourceId(list[0].id);
        }
      } catch {
        // Ignore
      }
    }
    loadResources();
  }, []);

  const fetchGraph = async () => {
    if (!selectedResourceId) return;
    setLoading(true);
    try {
      const data = await api.get<GraphNeighborResponse>(
        `/api/v1/graph/neighbors?resource_id=${selectedResourceId}&depth=${depth}`
      );
      setGraphData(data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedResourceId) {
      fetchGraph();
    }
  }, [selectedResourceId, depth]);

  return (
    <div style={{ padding: "28px", display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Top Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>
            KHÁM PHÁ ĐỒ THỊ QUAN HỆ TÀI SẢN (GRAPH TOPOLOGY)
          </h1>
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Trực quan hóa các mối liên kết thực thể công nghiệp: Chứa đựng (CONTAINS), Cung cấp (FEEDS), Tọa lạc (LOCATED_AT)
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <select
            value={selectedResourceId}
            onChange={(e) => setSelectedResourceId(e.target.value)}
            style={{
              height: "36px",
              padding: "0 12px",
              backgroundColor: "var(--bg-inset)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-medium)",
              borderRadius: "var(--radius-sm)",
              fontSize: "13px",
              cursor: "pointer",
            }}
          >
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} - {r.name}
              </option>
            ))}
          </select>

          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            style={{
              height: "36px",
              padding: "0 12px",
              backgroundColor: "var(--bg-inset)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-medium)",
              borderRadius: "var(--radius-sm)",
              fontSize: "13px",
              cursor: "pointer",
            }}
          >
            <option value={1}>Cấp liên kết 1</option>
            <option value={2}>Cấp liên kết 2</option>
            <option value={3}>Cấp liên kết 3</option>
          </select>

          <Button variant="outline" size="sm" icon={<RefreshIcon size={14} />} loading={loading} onClick={fetchGraph}>
            Tải lại
          </Button>
        </div>
      </div>

      {/* Graph Visual Content */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.8fr", gap: "20px" }}>
        {/* Nodes List */}
        <Card title={`Thực Thể Lân Cận (${graphData?.nodes?.length || 0})`}>
          {graphData?.nodes && graphData.nodes.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {graphData.nodes.map((node) => {
                const isCenter = node.id === selectedResourceId;
                return (
                  <div
                    key={node.id}
                    onClick={() => setSelectedResourceId(node.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 14px",
                      backgroundColor: isCenter ? "var(--brand-surface)" : "var(--bg-inset)",
                      border: `1px solid ${isCenter ? "var(--brand-primary)" : "var(--border-subtle)"}`,
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <LayersIcon size={16} style={{ color: isCenter ? "var(--brand-primary)" : "var(--text-muted)" }} />
                      <div>
                        <div className="tabular" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
                          {node.code}
                        </div>
                        <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{node.name}</div>
                      </div>
                    </div>
                    {isCenter && <Badge variant="brand">TRỌNG TÂM</Badge>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: "13px" }}>
              Chưa có thực thể lân cận nào.
            </div>
          )}
        </Card>

        {/* Relations Edges */}
        <Card title={`Quan Hệ Liên Kết (${graphData?.edges?.length || 0})`}>
          {graphData?.edges && graphData.edges.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {graphData.edges.map((edge, idx) => {
                const sourceNode = graphData.nodes.find((n) => n.id === edge.from_id);
                const targetNode = graphData.nodes.find((n) => n.id === edge.to_id);
                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 14px",
                      backgroundColor: "var(--bg-inset)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: "13px",
                    }}
                  >
                    <span className="tabular" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                      {sourceNode?.code || edge.from_id.slice(0, 8)}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <Badge variant="brand" style={{ fontSize: "11px" }}>
                        {edge.relation_code}
                      </Badge>
                      <ChevronRightIcon size={14} style={{ color: "var(--text-muted)" }} />
                    </div>
                    <span className="tabular" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                      {targetNode?.code || edge.to_id.slice(0, 8)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: "13px" }}>
              Không có quan hệ liên kết nào trong bán kính tìm kiếm.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};
