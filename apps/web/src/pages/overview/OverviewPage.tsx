import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { OverviewData } from "../../api/types";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import {
  TopologyIcon,
  ConnectionIcon,
  EdgeIcon,
  ActivityIcon,
  RefreshIcon,
  ArrowRightIcon,
} from "../../components/ui/Icons";

export const OverviewPage: React.FC = () => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOverview = async () => {
    setLoading(true);
    try {
      const res = await api.get<OverviewData>("/api/v1/overview");
      setData(res);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, []);

  return (
    <div style={{ padding: "28px", display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Top Banner & Refresh */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--text-primary)" }}>
            TRUNG TÂM CHỈ HUY VẬN HÀNH NHÀ MÁY
          </h1>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Giám sát thời gian thực toàn bộ mạng lưới thiết bị, cảm biến OT và luồng dữ liệu Edge
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<RefreshIcon size={14} />}
          loading={loading}
          onClick={fetchOverview}
        >
          Cập nhật số liệu
        </Button>
      </div>

      {/* KPI Cards Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: "16px",
        }}
      >
        {/* KPI: Machines */}
        <Card hoverable style={{ padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>
              MÁY MÓC & THIẾT BỊ
            </span>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--brand-surface)",
                color: "var(--brand-primary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <TopologyIcon size={18} />
            </div>
          </div>
          <div style={{ marginTop: "12px", display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="tabular" style={{ fontSize: "32px", fontWeight: 700, color: "var(--text-primary)" }}>
              {data?.machines ?? "--"}
            </span>
            <span style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
              / {data?.resources ?? "--"} tài sản
            </span>
          </div>
          <Link
            to="/topology"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "12px",
              color: "var(--brand-primary)",
              fontWeight: 600,
              textDecoration: "none",
              marginTop: "12px",
            }}
          >
            <span>Mặt bằng nhà máy</span>
            <ArrowRightIcon size={12} />
          </Link>
        </Card>

        {/* KPI: Active Connections */}
        <Card hoverable style={{ padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>
              KẾT NỐI OT HOẠT ĐỘNG
            </span>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--status-good-bg)",
                color: "var(--status-good)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ConnectionIcon size={18} />
            </div>
          </div>
          <div style={{ marginTop: "12px", display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="tabular" style={{ fontSize: "32px", fontWeight: 700, color: "var(--text-primary)" }}>
              {data?.active_connections ?? "--"}
            </span>
            <Badge variant="good" dot pulse>
              ĐANG THU THẬP
            </Badge>
          </div>
          <Link
            to="/connectivity"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "12px",
              color: "var(--brand-primary)",
              fontWeight: 600,
              textDecoration: "none",
              marginTop: "12px",
            }}
          >
            <span>Quản lý cổng kết nối</span>
            <ArrowRightIcon size={12} />
          </Link>
        </Card>

        {/* KPI: Healthy Edges */}
        <Card hoverable style={{ padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>
              CỤM EDGE GATEWAY
            </span>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--status-idle-bg)",
                color: "var(--status-idle)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <EdgeIcon size={18} />
            </div>
          </div>
          <div style={{ marginTop: "12px", display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="tabular" style={{ fontSize: "32px", fontWeight: 700, color: "var(--text-primary)" }}>
              {data?.healthy_edges ?? "--"}
            </span>
            <span style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
              / {data?.edges?.length ?? "--"} trạm online
            </span>
          </div>
          <Link
            to="/edge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "12px",
              color: "var(--brand-primary)",
              fontWeight: 600,
              textDecoration: "none",
              marginTop: "12px",
            }}
          >
            <span>Trạng thái Edge Nodes</span>
            <ArrowRightIcon size={12} />
          </Link>
        </Card>

        {/* KPI: Ingestion Rate */}
        <Card hoverable style={{ padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>
              TỐC ĐỘ NẠP TELEMETRY
            </span>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--status-warning-bg)",
                color: "var(--status-warning)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ActivityIcon size={18} />
            </div>
          </div>
          <div style={{ marginTop: "12px", display: "flex", alignItems: "baseline", gap: "6px" }}>
            <span className="tabular" style={{ fontSize: "32px", fontWeight: 700, color: "var(--text-primary)" }}>
              {data?.ingest_per_minute?.toLocaleString() ?? "--"}
            </span>
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>gói/phút</span>
          </div>
          <Link
            to="/historian"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "12px",
              color: "var(--brand-primary)",
              fontWeight: 600,
              textDecoration: "none",
              marginTop: "12px",
            }}
          >
            <span>Lịch sử & Lưu trữ</span>
            <ArrowRightIcon size={12} />
          </Link>
        </Card>
      </div>

      {/* Main Grid: Edge Fleet & Recent Diagnostics */}
      <div style={{ display: "grid", gridTemplateColumns: "1.8fr 1.2fr", gap: "20px" }}>
        {/* Edge Fleet Monitor */}
        <Card
          title="Tình trạng Trạm Biên Edge Fleet"
          subtitle="Giám sát phiên bản cấu hình và bộ đệm outbox tại hiện trường"
          action={
            <Link to="/edge" style={{ fontSize: "12px", color: "var(--brand-primary)", textDecoration: "none", fontWeight: 600 }}>
              Xem tất cả
            </Link>
          }
        >
          {data?.edges && data.edges.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {data.edges.map((edge) => (
                <div
                  key={edge.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 14px",
                    backgroundColor: "var(--bg-inset)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <div
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        backgroundColor:
                          edge.health === "HEALTHY" || edge.health === "ACTIVE"
                            ? "var(--status-good)"
                            : "var(--status-warning)",
                      }}
                    />
                    <div>
                      <div style={{ fontSize: "13.5px", fontWeight: 600, color: "var(--text-primary)" }}>
                        {edge.name}
                      </div>
                      <div style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
                        Bản mong muốn: v{edge.desired_revision} · Đang chạy: v{edge.active_revision}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                    <div style={{ textAlign: "right" }}>
                      <div className="tabular" style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-primary)" }}>
                        {edge.outbox_pending ?? 0}
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>gói đệm</div>
                    </div>
                    <Badge
                      variant={
                        edge.health === "HEALTHY" || edge.health === "ACTIVE"
                          ? "good"
                          : "warning"
                      }
                      dot
                    >
                      {edge.health}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)", fontSize: "13px" }}>
              Chưa có trạm Edge nào được ghi danh vào hệ thống.
            </div>
          )}
        </Card>

        {/* Recent Error Diagnostics */}
        <Card
          title="Nhật Ký Cảnh Báo & Chẩn Đoán"
          subtitle="Các sự cố kết nối hoặc lỗi thu thập tín hiệu gần nhất"
          action={
            <Link to="/settings" style={{ fontSize: "12px", color: "var(--brand-primary)", textDecoration: "none", fontWeight: 600 }}>
              Kiểm toán
            </Link>
          }
        >
          {data?.recent_errors && data.recent_errors.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {data.recent_errors.map((err, i) => (
                <div
                  key={err.id || i}
                  style={{
                    padding: "10px 12px",
                    backgroundColor: "var(--status-bad-bg)",
                    border: "1px solid var(--status-bad-border)",
                    borderRadius: "var(--radius-sm)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--status-bad)" }}>
                      {err.name}
                    </span>
                    <Badge variant="bad">LỖI</Badge>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                    {err.last_error}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "48px 16px",
                gap: "10px",
                color: "var(--text-muted)",
              }}
            >
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "50%",
                  backgroundColor: "var(--status-good-bg)",
                  color: "var(--status-good)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <ActivityIcon size={20} />
              </div>
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--status-good)" }}>
                Mạng lưới OT vận hành ổn định
              </span>
              <span style={{ fontSize: "12px" }}>Không ghi nhận lỗi kết nối nào trong 24 giờ qua</span>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};
