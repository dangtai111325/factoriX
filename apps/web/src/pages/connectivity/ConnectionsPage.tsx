import React, { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Connection, Site, EdgeNode } from "../../api/types";
import { CommissioningModal } from "./CommissioningModal";
import { ConnectionWizardModal } from "./ConnectionWizardModal";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Tabs";
import {
  PlusIcon,
  RefreshIcon,
  PlayIcon,
  PauseIcon,
  ActivityIcon,
} from "../../components/ui/Icons";

export const ConnectionsPage: React.FC = () => {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [edges, setEdges] = useState<EdgeNode[]>([]);
  const [selectedProtocol, setSelectedProtocol] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  // Modals state
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [activeTestJobId, setActiveTestJobId] = useState<string | null>(null);

  const { success, error } = useToast();

  const loadData = async () => {
    setLoading(true);
    try {
      const [connRes, siteRes, edgeRes] = await Promise.all([
        api.get<{ items: Connection[] }>("/api/v1/connections"),
        api.get<{ items: Site[] }>("/api/v1/sites"),
        api.get<{ items: EdgeNode[] }>("/api/v1/edges"),
      ]);
      setConnections(connRes.items || []);
      setSites(siteRes.items || []);
      setEdges(edgeRes.items || []);
    } catch (err: any) {
      error("Lỗi khi tải danh sách kết nối: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handlePauseToggle = async (conn: Connection) => {
    try {
      await api.post(`/api/v1/connections/${conn.id}/pause`);
      success(`Đã cập nhật trạng thái kết nối [${conn.name}].`);
      loadData();
    } catch (err: any) {
      error("Thao tác thất bại: " + (err.message || ""));
    }
  };

  const handleStartCommissioning = async (conn: Connection) => {
    try {
      const res = await api.post<{ job_id: string }>(`/api/v1/connections/${conn.id}/tests`);
      if (res?.job_id) {
        setActiveTestJobId(res.job_id);
      } else {
        error("Không nhận được mã phiên kiểm thử.");
      }
    } catch (err: any) {
      error("Khởi chạy kiểm thử thất bại: " + (err.message || ""));
    }
  };

  const filtered = connections.filter((c) => {
    if (selectedProtocol !== "all" && c.protocol !== selectedProtocol) return false;
    return true;
  });

  return (
    <div style={{ padding: "28px", display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Top Banner */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>
            QUẢN LÝ KẾT NỐI OT & NGHIỆM THU (COMMISSIONING)
          </h1>
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Quản trị các kết nối công nghiệp Modbus TCP, OPC UA, MQTT Client, và HTTP API Polling
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Button variant="outline" size="sm" icon={<RefreshIcon size={14} />} loading={loading} onClick={loadData}>
            Tải lại
          </Button>
          <Button variant="primary" size="sm" icon={<PlusIcon size={14} />} onClick={() => setIsWizardOpen(true)}>
            Thêm kết nối mới
          </Button>
        </div>
      </div>

      {/* Protocol Filter Tabs */}
      <div style={{ display: "flex", gap: "8px" }}>
        {[
          { key: "all", label: `Tất cả (${connections.length})` },
          { key: "modbus_tcp", label: "Modbus TCP" },
          { key: "opc_ua", label: "OPC UA" },
          { key: "mqtt_client", label: "MQTT Client" },
          { key: "http_pull", label: "HTTP Polling" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setSelectedProtocol(tab.key)}
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-medium)",
              backgroundColor: selectedProtocol === tab.key ? "var(--brand-surface)" : "var(--bg-elevated)",
              color: selectedProtocol === tab.key ? "var(--brand-primary)" : "var(--text-secondary)",
              fontWeight: selectedProtocol === tab.key ? 600 : 500,
              fontSize: "12.5px",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Connections Table */}
      <Card>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)", fontSize: "11.5px" }}>
                <th style={{ padding: "12px 16px" }}>TÊN KẾT NỐI</th>
                <th style={{ padding: "12px 16px" }}>GIAO THỨC</th>
                <th style={{ padding: "12px 16px" }}>TRẠM THU THẬP (EDGE)</th>
                <th style={{ padding: "12px 16px" }}>TRẠNG THÁI</th>
                <th style={{ padding: "12px 16px" }}>SỨC KHỎE DỮ LIỆU</th>
                <th style={{ padding: "12px 16px", textAlign: "right" }}>THAO TÁC</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length > 0 ? (
                filtered.map((conn) => {
                  const edge = edges.find((e) => e.id === conn.edge_id);
                  const isPaused = conn.status === "PAUSED";
                  return (
                    <tr
                      key={conn.id}
                      style={{
                        borderBottom: "1px solid var(--border-subtle)",
                        transition: "background-color var(--duration-fast)",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-card-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <td style={{ padding: "14px 16px" }}>
                        <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{conn.name}</div>
                        {conn.last_error && (
                          <div style={{ fontSize: "11px", color: "var(--status-bad)", marginTop: "2px", fontFamily: "var(--font-mono)" }}>
                            {conn.last_error}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        <Badge variant="neutral" style={{ fontFamily: "var(--font-mono)" }}>
                          {conn.protocol.toUpperCase()}
                        </Badge>
                      </td>
                      <td style={{ padding: "14px 16px", color: "var(--text-secondary)" }}>
                        {edge?.name || "--"}
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        <Badge variant={conn.status === "ACTIVE" ? "good" : "warning"} dot>
                          {conn.status}
                        </Badge>
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        <Badge
                          variant={
                            conn.health === "HEALTHY"
                              ? "good"
                              : conn.health === "DEGRADED"
                              ? "warning"
                              : "bad"
                          }
                          dot
                        >
                          {conn.health || "UNKNOWN"}
                        </Badge>
                      </td>
                      <td style={{ padding: "14px 16px", textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: "8px" }}>
                          <Button
                            variant="outline"
                            size="sm"
                            icon={<ActivityIcon size={13} />}
                            onClick={() => handleStartCommissioning(conn)}
                          >
                            Nghiệm thu 3 bước
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={isPaused ? <PlayIcon size={13} /> : <PauseIcon size={13} />}
                            onClick={() => handlePauseToggle(conn)}
                            title={isPaused ? "Tiếp tục" : "Tạm dừng"}
                          >
                            {isPaused ? "Chạy" : "Dừng"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "48px", color: "var(--text-muted)" }}>
                    Không có kết nối nào phù hợp với bộ lọc hiện tại.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Modals */}
      <ConnectionWizardModal
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        sites={sites}
        edges={edges}
        onCreated={loadData}
      />

      <CommissioningModal
        jobId={activeTestJobId}
        onClose={() => {
          setActiveTestJobId(null);
          loadData();
        }}
      />
    </div>
  );
};
