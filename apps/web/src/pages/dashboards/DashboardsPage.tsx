import { useState, useEffect, useCallback } from "react";
import { api, ApiError } from "../../api/client";
import type { Dashboard, Signal } from "../../api/types";
import { useLiveSignal } from "../../api/stream";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import { Input, Select } from "../../components/ui/Input";
import { Icons } from "../../components/ui/Icons";
import { QualityBadge, TrendSparkline } from "../../components/industrial";
import { useToast } from "../../components/ui/Toast";

interface WidgetConfig {
  id: string;
  title: string;
  type: "kpi" | "gauge" | "chart";
  signal_id: string;
  unit?: string;
  min?: number;
  max?: number;
  warn_threshold?: number;
  danger_threshold?: number;
}

// Widget renderer component with live stream hook
function LiveWidgetCard({
  widget,
  signal,
  onDelete,
}: {
  widget: WidgetConfig;
  signal?: Signal;
  onDelete: () => void;
}) {
  const live = useLiveSignal(widget.signal_id);
  const rawVal = live.value !== undefined ? live.value : null;
  const numVal = typeof rawVal === "number" ? rawVal : Number(rawVal) || 0;

  const [history, setHistory] = useState<number[]>([numVal]);

  useEffect(() => {
    if (live.value !== undefined && live.value !== null) {
      const v = typeof live.value === "number" ? live.value : Number(live.value) || 0;
      setHistory((prev) => {
        const next = [...prev, v];
        return next.length > 20 ? next.slice(next.length - 20) : next;
      });
    }
  }, [live.value]);

  // Determine status color based on thresholds
  let statusColor = "var(--fx-status-good, #10b981)";
  if (widget.danger_threshold !== undefined && numVal >= widget.danger_threshold) {
    statusColor = "var(--fx-brand-red, #E53935)";
  } else if (widget.warn_threshold !== undefined && numVal >= widget.warn_threshold) {
    statusColor = "var(--fx-status-warning, #f59e0b)";
  }

  // Calculate percentage for gauge
  const min = widget.min ?? 0;
  const max = widget.max ?? 100;
  const pct = Math.min(100, Math.max(0, ((numVal - min) / (max - min || 1)) * 100));

  return (
    <Card elevation="elevated" style={{ padding: "18px", position: "relative" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "12px",
        }}
      >
        <div>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--fx-text-primary, #ffffff)" }}>
            {widget.title}
          </div>
          <div style={{ fontSize: "11px", color: "var(--fx-text-muted, #64748b)" }}>
            {signal?.display_name || signal?.key || "Thông số chưa liên kết"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <QualityBadge quality={live.quality || "GOOD"} />
          <button
            onClick={onDelete}
            style={{
              background: "none",
              border: "none",
              color: "var(--fx-text-muted, #64748b)",
              cursor: "pointer",
              padding: "4px",
              borderRadius: "4px",
            }}
            title="Xóa widget khỏi bảng điều khiển"
          >
            <Icons.Trash size={13} />
          </button>
        </div>
      </div>

      {widget.type === "gauge" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span
              style={{
                fontSize: "26px",
                fontWeight: 700,
                color: statusColor,
                fontFamily: "var(--fx-font-mono)",
              }}
            >
              {rawVal !== null ? rawVal : "—"}
            </span>
            <span style={{ fontSize: "13px", color: "var(--fx-text-muted, #64748b)", fontWeight: 500 }}>
              {widget.unit || signal?.unit || ""}
            </span>
          </div>

          {/* Progress Bar Gauge */}
          <div
            style={{
              height: "10px",
              width: "100%",
              backgroundColor: "var(--fx-bg-primary, #0a0e17)",
              borderRadius: "5px",
              overflow: "hidden",
              border: "1px solid var(--fx-border-subtle, #1e293b)",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                backgroundColor: statusColor,
                transition: "width 0.3s ease-out, background-color 0.3s ease",
              }}
            />
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "10px",
              color: "var(--fx-text-muted, #64748b)",
              fontFamily: "var(--fx-font-mono)",
            }}
          >
            <span>{min}</span>
            <span>Ngưỡng cảnh báo: {widget.warn_threshold ?? "—"}</span>
            <span>{max}</span>
          </div>
        </div>
      ) : widget.type === "chart" ? (
        <div style={{ marginTop: "4px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
            <span
              style={{
                fontSize: "24px",
                fontWeight: 700,
                color: "var(--fx-text-primary, #ffffff)",
                fontFamily: "var(--fx-font-mono)",
              }}
            >
              {rawVal !== null ? rawVal : "—"}{" "}
              <span style={{ fontSize: "13px", fontWeight: 400, color: "var(--fx-text-muted, #64748b)" }}>
                {widget.unit || signal?.unit || ""}
              </span>
            </span>
          </div>
          <TrendSparkline
            data={history.length > 1 ? history : [numVal, numVal]}
            color="#E53935"
            width={240}
            height={50}
          />
        </div>
      ) : (
        // Standard KPI Card
        <div style={{ marginTop: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span
              style={{
                fontSize: "32px",
                fontWeight: 700,
                color: statusColor,
                fontFamily: "var(--fx-font-mono)",
                letterSpacing: "-0.02em",
              }}
            >
              {rawVal !== null ? rawVal : "—"}
            </span>
            <span style={{ fontSize: "14px", fontWeight: 500, color: "var(--fx-text-muted, #64748b)" }}>
              {widget.unit || signal?.unit || ""}
            </span>
          </div>
          <div style={{ marginTop: "8px", display: "flex", justifyContent: "flex-end" }}>
            <TrendSparkline
              data={history.length > 1 ? history : [numVal, numVal]}
              color={statusColor}
              width={160}
              height={36}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

export function DashboardsPage() {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [selectedDashboard, setSelectedDashboard] = useState<Dashboard | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // New Dashboard Modal
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");

  // Add Widget Modal
  const [isAddWidgetOpen, setIsAddWidgetOpen] = useState(false);
  const [widgetTitle, setWidgetTitle] = useState("");
  const [widgetType, setWidgetType] = useState<"kpi" | "gauge" | "chart">("kpi");
  const [widgetSignalId, setWidgetSignalId] = useState("");
  const [widgetWarn, setWidgetWarn] = useState("");
  const [widgetDanger, setWidgetDanger] = useState("");
  const [widgetMin, setWidgetMin] = useState("0");
  const [widgetMax, setWidgetMax] = useState("100");

  const { addToast } = useToast();

  const fetchDashboards = useCallback(async () => {
    setLoading(true);
    try {
      const [dashRes, sigRes] = await Promise.all([
        api.get<{ items: Dashboard[] }>("/api/v1/dashboards"),
        api.get<{ items: Signal[] }>("/api/v1/signals"),
      ]);
      const dashList = dashRes.items || [];
      const sigList = sigRes.items || [];
      setDashboards(dashList);
      setSignals(sigList);

      if (dashList.length > 0) {
        const detail = await api.get<Dashboard>(`/api/v1/dashboards/${dashList[0].id}`);
        setSelectedDashboard(detail);
      }
      if (sigList.length > 0 && !widgetSignalId) {
        setWidgetSignalId(sigList[0].id);
      }
    } catch (err) {
      console.error(err);
      addToast("error", "Không thể tải danh sách bảng điều khiển.");
    } finally {
      setLoading(false);
    }
  }, [widgetSignalId, addToast]);

  useEffect(() => {
    fetchDashboards();
  }, [fetchDashboards]);

  // Select another dashboard
  const handleSelectDashboard = async (id: string) => {
    try {
      const detail = await api.get<Dashboard>(`/api/v1/dashboards/${id}`);
      setSelectedDashboard(detail);
    } catch {
      addToast("error", "Không thể tải chi tiết bảng điều khiển.");
    }
  };

  // Create Dashboard
  const handleCreateDashboard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    try {
      await api.post<Dashboard>("/api/v1/dashboards", {
        name: newTitle.trim(),
        description: newDesc.trim(),
      });
      addToast("success", "Đã tạo bảng điều khiển mới thành công.");
      setIsCreateOpen(false);
      setNewTitle("");
      setNewDesc("");
      fetchDashboards();
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi tạo bảng điều khiển.");
    }
  };

  // Get current widgets array from draft
  const currentWidgets: WidgetConfig[] = (
    ((selectedDashboard?.draft as any)?.widgets || []) as any[]
  ).map((w: any) => ({
    id: w.id,
    title: w.title || "",
    type: w.type === "gauge" ? "gauge" : w.type === "chart" ? "chart" : "kpi",
    signal_id: w.signal_id || (w.bindings?.[0]?.signal_id) || "",
    unit: w.config?.unit,
    min: w.config?.min,
    max: w.config?.max,
    warn_threshold: w.config?.warn_threshold,
    danger_threshold: w.config?.danger_threshold,
  }));

  // Save updated widgets
  const saveWidgets = async (widgets: WidgetConfig[]) => {
    if (!selectedDashboard) return;
    setSaving(true);
    try {
      const draftPayload = {
        ...selectedDashboard.draft,
        widgets: widgets.map((w) => ({
          id: w.id,
          title: w.title,
          type: w.type,
          bindings: [{ signal_id: w.signal_id, label: w.title }],
          config: {
            unit: w.unit,
            min: w.min,
            max: w.max,
            warn_threshold: w.warn_threshold,
            danger_threshold: w.danger_threshold,
          },
        })),
      };

      const updated = await api.patch<Dashboard>(`/api/v1/dashboards/${selectedDashboard.id}`, {
        version: selectedDashboard.version,
        draft: draftPayload,
      });
      setSelectedDashboard(updated);
      addToast("success", "Đã lưu bản nháp bảng điều khiển.");
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi lưu bảng điều khiển.");
    } finally {
      setSaving(false);
    }
  };

  // Add Widget submit
  const handleAddWidget = (e: React.FormEvent) => {
    e.preventDefault();
    if (!widgetTitle.trim() || !widgetSignalId) return;

    const newWidget: WidgetConfig = {
      id: "w_" + Math.random().toString(36).substring(2, 9),
      title: widgetTitle.trim(),
      type: widgetType,
      signal_id: widgetSignalId,
      warn_threshold: widgetWarn ? Number(widgetWarn) : undefined,
      danger_threshold: widgetDanger ? Number(widgetDanger) : undefined,
      min: Number(widgetMin) || 0,
      max: Number(widgetMax) || 100,
    };

    const nextWidgets = [...currentWidgets, newWidget];
    saveWidgets(nextWidgets);
    setIsAddWidgetOpen(false);
    setWidgetTitle("");
    setWidgetWarn("");
    setWidgetDanger("");
  };

  // Delete Widget
  const handleDeleteWidget = (id: string) => {
    const nextWidgets = currentWidgets.filter((w) => w.id !== id);
    saveWidgets(nextWidgets);
  };

  // Publish Dashboard
  const handlePublish = async () => {
    if (!selectedDashboard) return;
    setPublishing(true);
    try {
      const res = await api.post<Dashboard>(`/api/v1/dashboards/${selectedDashboard.id}/publish`);
      setSelectedDashboard(res);
      addToast("success", "Đã phát hành bảng điều khiển chính thức.");
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi phát hành bảng điều khiển.");
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          borderBottom: "1px solid var(--fx-border-subtle, #1e293b)",
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
                color: "var(--fx-brand-red, #E53935)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icons.LayoutGrid size={20} />
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: "20px",
                fontWeight: 700,
                color: "var(--fx-text-primary, #ffffff)",
                letterSpacing: "-0.01em",
              }}
            >
              Bảng Giám Sát Thời Gian Thực (Industrial Dashboards)
            </h1>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              color: "var(--fx-text-muted, #64748b)",
              lineHeight: 1.5,
            }}
          >
            Trực quan hóa tức thời chỉ số vận hành phân xưởng, giám sát đồng hồ áp suất / nhiệt độ / công suất
            và nhận cảnh báo vượt ngưỡng qua kết nối WebSocket trực tiếp.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px" }}>
          <Button
            variant="secondary"
            icon={<Icons.Plus size={16} />}
            onClick={() => setIsCreateOpen(true)}
          >
            Tạo Dashboard mới
          </Button>
          {selectedDashboard && (
            <>
              <Button
                variant="secondary"
                icon={<Icons.Grid size={16} />}
                onClick={() => setIsAddWidgetOpen(true)}
              >
                + Thêm thẻ chỉ số
              </Button>
              <Button
                variant="primary"
                icon={<Icons.Check size={16} />}
                onClick={handlePublish}
                loading={publishing}
              >
                Phát hành bảng này
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Dashboard Selection Bar */}
      {dashboards.length > 0 && (
        <Card style={{ padding: "14px 18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--fx-text-secondary, #94a3b8)" }}>
                Bảng điều khiển:
              </span>
              <div style={{ width: "240px" }}>
                <Select
                  value={selectedDashboard?.id || ""}
                  onChange={(e) => handleSelectDashboard(e.target.value)}
                  options={dashboards.map((d) => ({ value: d.id, label: d.name }))}
                />
              </div>
            </div>

            {selectedDashboard && (
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "12px", color: "var(--fx-text-muted, #64748b)" }}>
                  Bản nháp: <strong style={{ color: "var(--fx-text-primary, #ffffff)" }}>rev {selectedDashboard.draft_revision}</strong>
                </span>
                <span style={{ fontSize: "12px", color: "var(--fx-text-muted, #64748b)" }}>
                  Bản phát hành: <strong style={{ color: "var(--fx-status-good, #10b981)" }}>rev {selectedDashboard.published_revision || 0}</strong>
                </span>
                {saving && (
                  <span style={{ fontSize: "11px", color: "var(--fx-status-warning, #f59e0b)" }}>
                    Đang lưu...
                  </span>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Main Widgets Grid */}
      {loading ? (
        <div style={{ padding: "48px", textAlign: "center", color: "var(--fx-text-muted, #64748b)" }}>
          Đang tải dữ liệu bảng điều khiển...
        </div>
      ) : !selectedDashboard ? (
        <Card style={{ padding: "48px 24px", textAlign: "center" }}>
          <Icons.LayoutGrid size={40} style={{ color: "var(--fx-text-muted, #64748b)", marginBottom: "16px" }} />
          <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", color: "var(--fx-text-primary, #ffffff)" }}>
            Chưa có bảng điều khiển nào
          </h3>
          <p style={{ margin: "0 0 20px 0", fontSize: "13px", color: "var(--fx-text-muted, #64748b)" }}>
            Bắt đầu tạo bảng điều khiển đầu tiên để gắn các thẻ đo thời gian thực.
          </p>
          <Button variant="primary" icon={<Icons.Plus size={16} />} onClick={() => setIsCreateOpen(true)}>
            Tạo Dashboard mới
          </Button>
        </Card>
      ) : currentWidgets.length === 0 ? (
        <Card style={{ padding: "48px 24px", textAlign: "center" }}>
          <Icons.Grid size={36} style={{ color: "var(--fx-text-muted, #64748b)", marginBottom: "12px" }} />
          <h3 style={{ margin: "0 0 6px 0", fontSize: "15px", color: "var(--fx-text-primary, #ffffff)" }}>
            Bảng điều khiển đang trống
          </h3>
          <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "var(--fx-text-muted, #64748b)" }}>
            Gắn các thẻ chỉ số (KPI Metric, Thanh đo Gauge, hoặc Biểu đồ xu hướng) để bắt đầu theo dõi.
          </p>
          <Button variant="primary" icon={<Icons.Plus size={16} />} onClick={() => setIsAddWidgetOpen(true)}>
            + Thêm thẻ chỉ số đầu tiên
          </Button>
        </Card>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {currentWidgets.map((widget) => {
            const sig = signals.find((s) => s.id === widget.signal_id);
            return (
              <LiveWidgetCard
                key={widget.id}
                widget={widget}
                signal={sig}
                onDelete={() => handleDeleteWidget(widget.id)}
              />
            );
          })}
        </div>
      )}

      {/* Modal: Create Dashboard */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Tạo Bảng Điều Khiển Giám Sát Mới"
      >
        <form onSubmit={handleCreateDashboard} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <Input
            label="Tên Bảng Điều Khiển"
            required
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Ví dụ: Giám Sát Lò Nhiệt Phân Xưởng 1"
          />

          <Input
            label="Mô Tả Mục Đích"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Mô tả phạm vi thiết bị hoặc ca làm việc áp dụng..."
          />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
            <Button variant="secondary" onClick={() => setIsCreateOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" variant="primary">
              Tạo bảng điều khiển
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Add Widget */}
      <Modal
        isOpen={isAddWidgetOpen}
        onClose={() => setIsAddWidgetOpen(false)}
        title="Thêm Thẻ Chỉ Số Đo Lường"
      >
        <form onSubmit={handleAddWidget} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <Input
            label="Tiêu Đề Thẻ Chỉ Số"
            required
            value={widgetTitle}
            onChange={(e) => setWidgetTitle(e.target.value)}
            placeholder="Ví dụ: Nhiệt độ đầu trục chính"
          />

          <Select
            label="Định Dạng Trực Quan (Widget Type)"
            value={widgetType}
            onChange={(e) => setWidgetType(e.target.value as any)}
            options={[
              { value: "kpi", label: "Chỉ số số học nổi bật (KPI Metric)" },
              { value: "gauge", label: "Đồng hồ đo phần trăm / giới hạn (Gauge)" },
              { value: "chart", label: "Đường đồ thị xu hướng thời gian thực (Sparkline)" },
            ]}
          />

          <Select
            label="Liên Kết Thông Số Đo (Signal)"
            required
            value={widgetSignalId}
            onChange={(e) => setWidgetSignalId(e.target.value)}
            options={signals.map((s) => ({
              value: s.id,
              label: `${s.display_name || s.key} ${s.unit ? `[${s.unit}]` : ""}`,
            }))}
          />

          {widgetType === "gauge" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <Input
                label="Giá trị Nhỏ Nhất (Min)"
                type="number"
                value={widgetMin}
                onChange={(e) => setWidgetMin(e.target.value)}
              />
              <Input
                label="Giá trị Lớn Nhất (Max)"
                type="number"
                value={widgetMax}
                onChange={(e) => setWidgetMax(e.target.value)}
              />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Input
              label="Ngưỡng Cảnh Báo Vàng (Warning)"
              type="number"
              value={widgetWarn}
              onChange={(e) => setWidgetWarn(e.target.value)}
              placeholder="VD: 75"
            />
            <Input
              label="Ngưỡng Nguy Hiểm Đỏ (Danger)"
              type="number"
              value={widgetDanger}
              onChange={(e) => setWidgetDanger(e.target.value)}
              placeholder="VD: 90"
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
            <Button variant="secondary" onClick={() => setIsAddWidgetOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" variant="primary">
              Gắn vào bảng điều khiển
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
