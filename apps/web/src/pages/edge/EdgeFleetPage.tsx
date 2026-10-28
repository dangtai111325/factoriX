import { useState, useEffect, useCallback } from "react";
import { api, ApiError } from "../../api/client";
import type { EdgeNode, Site } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Modal } from "../../components/ui/Modal";
import { Drawer } from "../../components/ui/Drawer";
import { Input, Select } from "../../components/ui/Input";
import { Icons } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/Toast";

interface DeploymentEvent {
  id: string;
  revision: number;
  state: string;
  diagnostic_redacted?: string;
  at: string;
}

export function EdgeFleetPage() {
  const [edges, setEdges] = useState<EdgeNode[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create Modal state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSiteId, setCreateSiteId] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);

  // Token Modal state
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ token: string; expiresAt: string; edgeName: string } | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);

  // Publish Release Modal
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [selectedEdgeForPublish, setSelectedEdgeForPublish] = useState<string>("");
  const [publishSubmitting, setPublishSubmitting] = useState(false);

  // Deployment History Drawer
  const [historyEdge, setHistoryEdge] = useState<EdgeNode | null>(null);
  const [deployments, setDeployments] = useState<DeploymentEvent[]>([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(false);

  const { addToast } = useToast();

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [edgeRes, siteRes] = await Promise.all([
        api.get<{ items: EdgeNode[] }>("/api/v1/edges"),
        api.get<{ items: Site[] }>("/api/v1/sites"),
      ]);
      setEdges(edgeRes.items || []);
      const siteList = siteRes.items || [];
      setSites(siteList);
      if (siteList.length > 0 && !createSiteId) {
        setCreateSiteId(siteList[0].id);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Không thể tải danh sách trạm Edge.");
      }
    } finally {
      setLoading(false);
    }
  }, [createSiteId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Create Edge
  const handleCreateEdge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim() || !createSiteId) return;

    setCreateSubmitting(true);
    try {
      await api.post("/api/v1/edges", {
        name: createName.trim(),
        site_id: createSiteId,
      });
      addToast("success", "Đã tạo thành công cấu hình trạm Edge mới.");
      setIsCreateOpen(false);
      setCreateName("");
      fetchData();
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi tạo trạm Edge.");
    } finally {
      setCreateSubmitting(false);
    }
  };

  // Issue Enrollment Token
  const handleIssueToken = async (edge: EdgeNode) => {
    setTokenLoading(true);
    try {
      const res = await api.post<{ enrollment_token: string; expires_at: string; edge_id: string }>(
        `/api/v1/edges/${edge.id}/enrollment-token`
      );
      setIssuedToken({
        token: res.enrollment_token,
        expiresAt: res.expires_at,
        edgeName: edge.name,
      });
      setTokenModalOpen(true);
      fetchData();
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Không thể tạo mã ghi danh.");
    } finally {
      setTokenLoading(false);
    }
  };

  // Publish Release
  const handlePublishRelease = async () => {
    if (!selectedEdgeForPublish) return;
    setPublishSubmitting(true);
    try {
      await api.post("/api/v1/config-releases/publish", {
        edge_id: selectedEdgeForPublish,
      });
      addToast("success", "Đã phát hành bản cấu hình mới cho trạm Edge thành công.");
      setPublishModalOpen(false);
      fetchData();
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi phát hành cấu hình.");
    } finally {
      setPublishSubmitting(false);
    }
  };

  // Open Deployment History
  const handleOpenHistory = async (edge: EdgeNode) => {
    setHistoryEdge(edge);
    setDeploymentsLoading(true);
    try {
      const res = await api.get<{ items: DeploymentEvent[] }>(`/api/v1/edges/${edge.id}/deployments`);
      setDeployments(res.items || []);
    } catch (err) {
      addToast("error", "Không thể tải lịch sử triển khai của trạm Edge.");
    } finally {
      setDeploymentsLoading(false);
    }
  };

  // Metrics
  const totalEdges = edges.length;
  const healthyCount = edges.filter((e) => e.health === "HEALTHY" || e.health === "ACTIVE").length;
  const degradedCount = edges.filter((e) => e.health === "DEGRADED" || e.health === "CONFIG_PENDING").length;
  const offlineCount = edges.filter((e) => e.health === "OFFLINE" || e.health === "UNKNOWN").length;

  const getHealthBadge = (health: string) => {
    switch (health) {
      case "HEALTHY":
      case "ACTIVE":
        return <Badge variant="success" dot>Hoạt động tốt</Badge>;
      case "CONFIG_PENDING":
        return <Badge variant="warning" dot>Chờ đồng bộ</Badge>;
      case "DEGRADED":
        return <Badge variant="warning" dot>Cảnh báo</Badge>;
      case "OFFLINE":
      default:
        return <Badge variant="neutral" dot>Mất kết nối</Badge>;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Page Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          borderBottom: "1px solid var(--fx-border-subtle)",
          paddingBottom: "16px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                backgroundColor: "rgba(229, 57, 53, 0.12)",
                color: "var(--fx-brand-red)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icons.Server size={20} />
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: "20px",
                fontWeight: 700,
                color: "var(--fx-text-primary)",
                letterSpacing: "-0.01em",
              }}
            >
              Mạng Lưới Trạm Thu Thập Edge (Edge Fleet)
            </h1>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              color: "var(--fx-text-muted)",
              lineHeight: 1.5,
            }}
          >
            Quản lý tập trung các thiết bị gateway phân tán tại phân xưởng, giám sát nhịp đập heartbeat,
            cấp mã ghi danh an toàn và phát hành bản cấu hình OT không gián đoạn.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px" }}>
          <Button
            variant="secondary"
            icon={<Icons.Upload size={16} />}
            onClick={() => {
              if (edges.length > 0) {
                setSelectedEdgeForPublish(edges[0].id);
                setPublishModalOpen(true);
              }
            }}
            disabled={edges.length === 0}
          >
            Phát hành cấu hình
          </Button>
          <Button
            variant="primary"
            icon={<Icons.Plus size={16} />}
            onClick={() => setIsCreateOpen(true)}
          >
            Đăng ký Edge mới
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "16px",
        }}
      >
        <Card style={{ padding: "16px" }}>
          <div style={{ fontSize: "12px", color: "var(--fx-text-muted)", marginBottom: "4px" }}>
            Tổng số Edge Nodes
          </div>
          <div
            style={{
              fontSize: "28px",
              fontWeight: 700,
              color: "var(--fx-text-primary)",
              fontFamily: "var(--fx-font-mono)",
            }}
          >
            {totalEdges}
          </div>
        </Card>

        <Card style={{ padding: "16px" }}>
          <div style={{ fontSize: "12px", color: "var(--fx-status-good)", marginBottom: "4px" }}>
            Trực tuyến / Hoạt động
          </div>
          <div
            style={{
              fontSize: "28px",
              fontWeight: 700,
              color: "var(--fx-status-good)",
              fontFamily: "var(--fx-font-mono)",
            }}
          >
            {healthyCount}
          </div>
        </Card>

        <Card style={{ padding: "16px" }}>
          <div style={{ fontSize: "12px", color: "var(--fx-status-warning)", marginBottom: "4px" }}>
            Chờ đồng bộ / Cảnh báo
          </div>
          <div
            style={{
              fontSize: "28px",
              fontWeight: 700,
              color: "var(--fx-status-warning)",
              fontFamily: "var(--fx-font-mono)",
            }}
          >
            {degradedCount}
          </div>
        </Card>

        <Card style={{ padding: "16px" }}>
          <div style={{ fontSize: "12px", color: "var(--fx-text-muted)", marginBottom: "4px" }}>
            Mất kết nối (Offline)
          </div>
          <div
            style={{
              fontSize: "28px",
              fontWeight: 700,
              color: "var(--fx-text-muted)",
              fontFamily: "var(--fx-font-mono)",
            }}
          >
            {offlineCount}
          </div>
        </Card>
      </div>

      {/* Edge Fleet Table */}
      <Card style={{ overflow: "hidden" }}>
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--fx-border-subtle)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: "14px", color: "var(--fx-text-primary)" }}>
            Danh sách thiết bị Edge phân tán ({edges.length})
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icons.RefreshCw size={14} />}
            onClick={fetchData}
            loading={loading}
          >
            Làm mới
          </Button>
        </div>

        {error ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--fx-brand-red)" }}>
            {error}
          </div>
        ) : edges.length === 0 ? (
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <Icons.Server size={36} style={{ color: "var(--fx-text-muted)", marginBottom: "12px" }} />
            <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--fx-text-primary)", marginBottom: "4px" }}>
              Chưa có trạm Edge nào
            </div>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "var(--fx-text-muted)" }}>
              Bắt đầu kết nối tầng OT bằng cách khởi tạo trạm Edge đầu tiên.
            </p>
            <Button variant="primary" icon={<Icons.Plus size={16} />} onClick={() => setIsCreateOpen(true)}>
              Đăng ký Edge mới
            </Button>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "13px",
                textAlign: "left",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--fx-border-subtle)",
                    backgroundColor: "var(--fx-bg-tertiary)",
                    color: "var(--fx-text-secondary)",
                    fontWeight: 600,
                  }}
                >
                  <th style={{ padding: "12px 16px" }}>Tên trạm Edge</th>
                  <th style={{ padding: "12px 16px" }}>Ghi danh</th>
                  <th style={{ padding: "12px 16px" }}>Trạng thái sức khỏe</th>
                  <th style={{ padding: "12px 16px" }}>Phiên bản phần mềm</th>
                  <th style={{ padding: "12px 16px" }}>Bản cấu hình</th>
                  <th style={{ padding: "12px 16px" }}>Nhịp tim (Heartbeat)</th>
                  <th style={{ padding: "12px 16px" }}>Hàng đợi chờ gửi</th>
                  <th style={{ padding: "12px 16px", textAlign: "right" }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((edge) => {
                  const revisionMismatch = edge.active_revision !== edge.desired_revision;
                  return (
                    <tr
                      key={edge.id}
                      style={{
                        borderBottom: "1px solid var(--fx-border-subtle)",
                        transition: "background-color 0.15s ease",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--fx-bg-tertiary)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ fontWeight: 600, color: "var(--fx-text-primary)" }}>
                          {edge.name}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: "var(--fx-text-muted)",
                            fontFamily: "var(--fx-font-mono)",
                          }}
                        >
                          {edge.id.slice(0, 16)}...
                        </div>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        {edge.enrollment_status === "ENROLLED" ? (
                          <Badge variant="success">Đã ghi danh</Badge>
                        ) : (
                          <Badge variant="warning">Chưa ghi danh</Badge>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        {getHealthBadge(edge.health)}
                      </td>
                      <td style={{ padding: "12px 16px", fontFamily: "var(--fx-font-mono)", fontSize: "12px" }}>
                        {edge.software_version || "—"}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span
                            style={{
                              fontFamily: "var(--fx-font-mono)",
                              fontSize: "12px",
                              fontWeight: 600,
                              color: revisionMismatch ? "var(--fx-status-warning)" : "var(--fx-text-primary)",
                            }}
                          >
                            rev {edge.active_revision}
                          </span>
                          {revisionMismatch && (
                            <span style={{ fontSize: "11px", color: "var(--fx-text-muted)" }}>
                              (mục tiêu: rev {edge.desired_revision})
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: "12px 16px", color: "var(--fx-text-secondary)", fontSize: "12px" }}>
                        {edge.last_heartbeat
                          ? new Date(edge.last_heartbeat).toLocaleTimeString("vi-VN")
                          : "Chưa nhận"}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            fontFamily: "var(--fx-font-mono)",
                            fontSize: "12px",
                            padding: "2px 8px",
                            borderRadius: "4px",
                            backgroundColor: (edge.outbox_pending ?? 0) > 0 ? "rgba(245, 158, 11, 0.15)" : "transparent",
                            color: (edge.outbox_pending ?? 0) > 0 ? "var(--fx-status-warning)" : "var(--fx-text-muted)",
                          }}
                        >
                          {edge.outbox_pending ?? 0} gói tin
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Icons.Key size={13} />}
                            onClick={() => handleIssueToken(edge)}
                            loading={tokenLoading}
                            title="Tạo mã Token ghi danh thiết bị mới"
                          >
                            Cấp mã
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Icons.Clock size={13} />}
                            onClick={() => handleOpenHistory(edge)}
                            title="Xem nhật ký phát hành & triển khai"
                          >
                            Lịch sử
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Modal: Create Edge Node */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Đăng Ký Trạm Thu Thập Edge Mới"
      >
        <form onSubmit={handleCreateEdge} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <Input
            label="Tên Trạm Edge"
            required
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Ví dụ: Edge-GW-XuongA"
            helperText="Đặt tên gợi nhớ vị trí lắp đặt thực tế tại phân xưởng"
          />

          <Select
            label="Khu Vực / Nhà Máy (Site)"
            required
            value={createSiteId}
            onChange={(e) => setCreateSiteId(e.target.value)}
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
            helperText="Gán trạm Edge vào không gian quản lý của nhà máy tương ứng"
          />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
            <Button variant="secondary" onClick={() => setIsCreateOpen(false)}>
              Hủy bỏ
            </Button>
            <Button type="submit" variant="primary" loading={createSubmitting}>
              Đăng ký trạm
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Enrollment Token Display */}
      <Modal
        isOpen={tokenModalOpen}
        onClose={() => setTokenModalOpen(false)}
        title={`Mã Ghi Danh: ${issuedToken?.edgeName || ""}`}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--fx-text-muted)", lineHeight: 1.5 }}>
            Sử dụng mã bí mật một lần này khi khởi động dịch vụ FactoriX Edge daemon trên gateway công nghiệp.
            Mã chỉ có hiệu lực trong vòng 15 phút.
          </p>

          <div
            style={{
              padding: "16px",
              borderRadius: "6px",
              backgroundColor: "var(--fx-bg-primary)",
              border: "1px solid var(--fx-border-default)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div style={{ fontSize: "12px", color: "var(--fx-text-secondary)" }}>
              Mã xác thực một lần (Enrollment Token):
            </div>
            <div
              style={{
                fontFamily: "var(--fx-font-mono)",
                fontSize: "14px",
                fontWeight: 600,
                color: "var(--fx-brand-red)",
                wordBreak: "break-all",
                backgroundColor: "var(--fx-bg-secondary)",
                padding: "8px 12px",
                borderRadius: "4px",
                border: "1px dashed var(--fx-border-subtle)",
              }}
            >
              {issuedToken?.token}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
            <Button
              variant="secondary"
              icon={<Icons.Copy size={15} />}
              onClick={() => {
                if (issuedToken?.token) {
                  navigator.clipboard.writeText(issuedToken.token);
                  addToast("success", "Đã sao chép mã Token vào bộ nhớ tạm.");
                }
              }}
            >
              Sao chép mã
            </Button>
            <Button variant="primary" onClick={() => setTokenModalOpen(false)}>
              Đã hiểu & Hoàn tất
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Publish Config Release */}
      <Modal
        isOpen={publishModalOpen}
        onClose={() => setPublishModalOpen(false)}
        title="Phát Hành Bản Cấu Hình (Publish Release)"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--fx-text-muted)", lineHeight: 1.5 }}>
            Hệ thống sẽ tổng hợp toàn bộ cấu hình kết nối OT, ánh xạ thông số và xuất thành snapshot
            để đồng bộ xuống thiết bị Edge.
          </p>

          <Select
            label="Chọn Thiết Bị Edge Đích"
            value={selectedEdgeForPublish}
            onChange={(e) => setSelectedEdgeForPublish(e.target.value)}
            options={edges.map((e) => ({
              value: e.id,
              label: `${e.name} (hiện tại: rev ${e.active_revision})`,
            }))}
          />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
            <Button variant="secondary" onClick={() => setPublishModalOpen(false)}>
              Hủy
            </Button>
            <Button
              variant="primary"
              loading={publishSubmitting}
              onClick={handlePublishRelease}
              icon={<Icons.Upload size={16} />}
            >
              Xác nhận phát hành
            </Button>
          </div>
        </div>
      </Modal>

      {/* Drawer: Deployment History */}
      <Drawer
        isOpen={!!historyEdge}
        onClose={() => setHistoryEdge(null)}
        title={`Lịch Sử Triển Khai: ${historyEdge?.name || ""}`}
        width="460px"
      >
        {deploymentsLoading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--fx-text-muted)" }}>
            Đang tải lịch sử triển khai...
          </div>
        ) : deployments.length === 0 ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--fx-text-muted)" }}>
            Chưa có sự kiện triển khai nào được ghi nhận cho trạm này.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {deployments.map((item) => (
              <Card key={item.id} style={{ padding: "14px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "8px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--fx-font-mono)",
                      fontWeight: 600,
                      fontSize: "13px",
                      color: "var(--fx-text-primary)",
                    }}
                  >
                    Bản sửa đổi rev {item.revision}
                  </span>
                  <Badge
                    variant={
                      item.state === "APPLIED" || item.state === "SUCCESS"
                        ? "success"
                        : item.state === "FAILED"
                        ? "error"
                        : "warning"
                    }
                  >
                    {item.state}
                  </Badge>
                </div>
                <div style={{ fontSize: "11px", color: "var(--fx-text-muted)", marginBottom: "4px" }}>
                  Thời gian: {new Date(item.at).toLocaleString("vi-VN")}
                </div>
                {item.diagnostic_redacted && (
                  <div
                    style={{
                      marginTop: "6px",
                      padding: "8px",
                      borderRadius: "4px",
                      backgroundColor: "var(--fx-bg-primary)",
                      fontFamily: "var(--fx-font-mono)",
                      fontSize: "11px",
                      color: "var(--fx-text-secondary)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {item.diagnostic_redacted}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  );
}
