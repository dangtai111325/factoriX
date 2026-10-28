import { useState, useEffect, useRef, useCallback } from "react";
import * as echarts from "echarts";
import { api, ApiError } from "../../api/client";
import type { Signal } from "../../api/types";
import { useTheme } from "../../theme/ThemeContext";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Select, Input } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { QualityBadge } from "../../components/industrial";
import { Icons } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/Toast";

interface ObservationItem {
  id: string;
  signal_id: string;
  event_time: string;
  value: number | string | boolean | null;
  unit?: string;
  quality: string;
  origin?: string;
  event_uid?: string;
}

interface IngestionHealth {
  ingest_per_minute: number;
  quarantine: number;
  dedup_keys: number;
  newest?: string | null;
}

export function HistorianPage() {
  const { theme } = useTheme();
  const { addToast } = useToast();

  const [signals, setSignals] = useState<Signal[]>([]);
  const [selectedSignalId, setSelectedSignalId] = useState<string>("");
  const [observations, setObservations] = useState<ObservationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Time Window presets
  const [timePreset, setTimePreset] = useState<string>("1h");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  // Ingestion Health
  const [health, setHealth] = useState<IngestionHealth | null>(null);

  // Active view tab
  const [viewTab, setViewTab] = useState<"chart" | "table" | "health">("chart");

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);

  // Load signals & health on mount
  useEffect(() => {
    async function init() {
      try {
        const [sigRes, healthRes] = await Promise.all([
          api.get<{ items: Signal[] }>("/api/v1/signals"),
          api.get<IngestionHealth>("/api/v1/storage/ingestion-health"),
        ]);
        const sigItems = sigRes.items || [];
        setSignals(sigItems);
        if (sigItems.length > 0) {
          setSelectedSignalId(sigItems[0].id);
        }
        setHealth(healthRes);
      } catch (err) {
        console.error("Failed to fetch initial historian data", err);
      }
    }
    init();
  }, []);

  // Compute start/end ISO strings based on preset
  const getTimeRange = useCallback(() => {
    const end = new Date();
    let start = new Date();

    if (timePreset === "1h") {
      start = new Date(end.getTime() - 60 * 60 * 1000);
    } else if (timePreset === "6h") {
      start = new Date(end.getTime() - 6 * 60 * 60 * 1000);
    } else if (timePreset === "24h") {
      start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    } else if (timePreset === "7d") {
      start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (timePreset === "custom" && customStart && customEnd) {
      return {
        start: new Date(customStart).toISOString(),
        end: new Date(customEnd).toISOString(),
      };
    }
    return {
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }, [timePreset, customStart, customEnd]);

  // Fetch observations
  const fetchObservations = useCallback(async () => {
    if (!selectedSignalId) return;
    setLoading(true);
    const { start, end } = getTimeRange();
    try {
      const res = await api.get<{ items: ObservationItem[]; next_cursor: string | null }>(
        `/api/v1/observations/history?signal_id=${selectedSignalId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=500`
      );
      setObservations(res.items || []);
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi truy xuất dữ liệu chuỗi thời gian.");
      setObservations([]);
    } finally {
      setLoading(false);
    }
  }, [selectedSignalId, getTimeRange, addToast]);

  useEffect(() => {
    if (selectedSignalId) {
      fetchObservations();
    }
  }, [selectedSignalId, timePreset, fetchObservations]);

  // Render or update ECharts
  useEffect(() => {
    if (!chartContainerRef.current) return;

    if (!chartInstanceRef.current) {
      chartInstanceRef.current = echarts.init(chartContainerRef.current, theme === "dark" ? "dark" : undefined);
    }

    const isDark = theme === "dark";
    const currentSignal = signals.find((s) => s.id === selectedSignalId);
    const sigLabel = currentSignal ? currentSignal.display_name || currentSignal.key : "Tín hiệu";
    const unitLabel = currentSignal?.unit ? ` (${currentSignal.unit})` : "";

    // Sort observations ascending by time
    const sorted = [...observations].sort(
      (a, b) => new Date(a.event_time).getTime() - new Date(b.event_time).getTime()
    );

    const seriesData = sorted.map((obs) => [
      new Date(obs.event_time).getTime(),
      typeof obs.value === "number" ? obs.value : Number(obs.value) || 0,
    ]);

    const option: echarts.EChartsOption = {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: isDark ? "#121824" : "#ffffff",
        borderColor: isDark ? "#2a364f" : "#e2e8f0",
        textStyle: {
          color: isDark ? "#f1f5f9" : "#0f172a",
          fontSize: 12,
        },
        formatter: (params: any) => {
          if (!Array.isArray(params) || params.length === 0) return "";
          const item = params[0];
          const dateStr = new Date(item.value[0]).toLocaleString("vi-VN");
          return `
            <div style="font-size: 11px; color: ${isDark ? "#94a3b8" : "#64748b"}; margin-bottom: 4px;">
              ${dateStr}
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background-color:#E53935;"></span>
              <span style="font-weight:600;">${sigLabel}:</span>
              <span style="font-family:var(--fx-font-mono);font-weight:700;color:#E53935;">
                ${item.value[1]} ${currentSignal?.unit || ""}
              </span>
            </div>
          `;
        },
      },
      grid: {
        left: "50px",
        right: "24px",
        top: "24px",
        bottom: "60px",
      },
      xAxis: {
        type: "time",
        boundaryGap: [0, 0],
        axisLine: { lineStyle: { color: isDark ? "#2a364f" : "#cbd5e1" } },
        axisLabel: {
          color: isDark ? "#94a3b8" : "#64748b",
          fontSize: 11,
          fontFamily: "var(--fx-font-mono)",
        },
        splitLine: {
          show: true,
          lineStyle: { color: isDark ? "#1e293b" : "#f1f5f9", type: "dashed" },
        },
      },
      yAxis: {
        type: "value",
        name: unitLabel,
        nameTextStyle: { color: isDark ? "#94a3b8" : "#64748b", fontSize: 11 },
        axisLine: { lineStyle: { color: isDark ? "#2a364f" : "#cbd5e1" } },
        axisLabel: {
          color: isDark ? "#94a3b8" : "#64748b",
          fontSize: 11,
          fontFamily: "var(--fx-font-mono)",
        },
        splitLine: {
          show: true,
          lineStyle: { color: isDark ? "#1e293b" : "#f1f5f9", type: "dashed" },
        },
      },
      dataZoom: [
        {
          type: "inside",
          start: 0,
          end: 100,
        },
        {
          type: "slider",
          bottom: "10px",
          height: 20,
          borderColor: isDark ? "#2a364f" : "#e2e8f0",
          backgroundColor: isDark ? "#0a0e17" : "#f8fafc",
          fillerColor: "rgba(229, 57, 53, 0.2)",
          handleStyle: {
            color: "#E53935",
            borderColor: "#ffffff",
          },
          textStyle: {
            color: isDark ? "#94a3b8" : "#64748b",
            fontSize: 10,
          },
        },
      ],
      series: [
        {
          name: sigLabel,
          type: "line",
          smooth: true,
          showSymbol: sorted.length < 50,
          symbolSize: 6,
          lineStyle: {
            color: "#E53935",
            width: 2.2,
          },
          itemStyle: {
            color: "#E53935",
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(229, 57, 53, 0.35)" },
              { offset: 1, color: "rgba(229, 57, 53, 0.02)" },
            ]),
          },
          data: seriesData,
        },
      ],
    };

    chartInstanceRef.current.setOption(option, true);

    const handleResize = () => {
      chartInstanceRef.current?.resize();
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [observations, theme, signals, selectedSignalId]);

  // Clean up chart on unmount or theme change
  useEffect(() => {
    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.dispose();
        chartInstanceRef.current = null;
      }
    };
  }, [theme]);

  // Dedicated export function matching FastAPI route definition
  const triggerCsvDownload = async () => {
    if (!selectedSignalId) return;
    setExporting(true);
    const { start, end } = getTimeRange();
    try {
      const res = await api.post<{ job_id: string; row_count: number; csv: string }>(
        `/api/v1/storage/exports?signal_id=${selectedSignalId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      );
      if (res.csv) {
        const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const sig = signals.find((s) => s.id === selectedSignalId);
        const sigName = sig?.display_name || sig?.key || "telemetry";
        link.href = url;
        link.setAttribute("download", `FactoriX_${sigName}_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        addToast("success", `Đã trích xuất ${res.row_count} bản ghi dữ liệu sang định dạng CSV.`);
      }
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi trích xuất tệp CSV.");
    } finally {
      setExporting(false);
    }
  };

  const selectedSignal = signals.find((s) => s.id === selectedSignalId);

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
              <Icons.TrendingUp size={20} />
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
              Kho Lưu Trữ & Phân Tích Chuỗi Thời Gian (Historian)
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
            Truy vấn dữ liệu lịch sử đo đạc cảm biến thời gian thực, đối chiếu xu hướng vận hành,
            và xuất báo cáo dữ liệu sạch chuẩn CSV phục vụ phân tích chuyên sâu.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {health && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                borderRadius: "6px",
                backgroundColor: "var(--fx-bg-tertiary, #161e2e)",
                border: "1px solid var(--fx-border-subtle, #1e293b)",
                fontSize: "12px",
              }}
            >
              <span style={{ color: "var(--fx-text-muted, #64748b)" }}>Tốc độ nạp:</span>
              <span style={{ fontWeight: 600, color: "var(--fx-status-good, #10b981)", fontFamily: "var(--fx-font-mono)" }}>
                {health.ingest_per_minute} obs/phút
              </span>
            </div>
          )}

          <Button
            variant="secondary"
            icon={<Icons.Download size={15} />}
            onClick={triggerCsvDownload}
            loading={exporting}
            disabled={observations.length === 0}
            title="Tải toàn bộ điểm đo thời gian thực về máy dưới dạng bảng tính CSV"
          >
            Xuất CSV
          </Button>

          <Button
            variant="ghost"
            icon={<Icons.RefreshCw size={15} />}
            onClick={fetchObservations}
            loading={loading}
          >
            Làm mới
          </Button>
        </div>
      </div>

      {/* Control / Filter Bar */}
      <Card style={{ padding: "16px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "16px",
            alignItems: "flex-end",
          }}
        >
          {/* Signal Selector */}
          <div>
            <Select
              label="Chọn Thông Số Đo (Signal)"
              value={selectedSignalId}
              onChange={(e) => setSelectedSignalId(e.target.value)}
              options={signals.map((s) => ({
                value: s.id,
                label: `${s.display_name || s.key} ${s.unit ? `[${s.unit}]` : ""}`,
              }))}
            />
          </div>

          {/* Time Preset */}
          <div>
            <Select
              label="Khoảng Thời Gian Phân Tích"
              value={timePreset}
              onChange={(e) => setTimePreset(e.target.value)}
              options={[
                { value: "1h", label: "1 giờ vừa qua" },
                { value: "6h", label: "6 giờ vừa qua" },
                { value: "24h", label: "24 giờ vừa qua" },
                { value: "7d", label: "7 ngày vừa qua" },
                { value: "custom", label: "Khoảng tùy chỉnh..." },
              ]}
            />
          </div>

          {/* Custom Date Pickers */}
          {timePreset === "custom" && (
            <>
              <div>
                <Input
                  label="Thời gian bắt đầu"
                  type="datetime-local"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
              </div>
              <div>
                <Input
                  label="Thời gian kết thúc"
                  type="datetime-local"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </div>
            </>
          )}

          {/* View mode switcher */}
          <div style={{ display: "flex", gap: "6px" }}>
            <Button
              variant={viewTab === "chart" ? "primary" : "secondary"}
              size="sm"
              icon={<Icons.TrendingUp size={14} />}
              onClick={() => setViewTab("chart")}
            >
              Đồ thị
            </Button>
            <Button
              variant={viewTab === "table" ? "primary" : "secondary"}
              size="sm"
              icon={<Icons.Grid size={14} />}
              onClick={() => setViewTab("table")}
            >
              Bảng điểm đo
            </Button>
            <Button
              variant={viewTab === "health" ? "primary" : "secondary"}
              size="sm"
              icon={<Icons.Database size={14} />}
              onClick={() => setViewTab("health")}
            >
              Kho lưu trữ
            </Button>
          </div>
        </div>
      </Card>

      {/* Main View Area */}
      {viewTab === "chart" && (
        <Card style={{ padding: "20px", minHeight: "480px", position: "relative" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--fx-text-primary, #ffffff)" }}>
                {selectedSignal ? selectedSignal.display_name || selectedSignal.key : "Biểu đồ biến thiên"}
              </span>
              {selectedSignal?.data_type && (
                <Badge variant="neutral">{selectedSignal.data_type}</Badge>
              )}
            </div>

            <div style={{ fontSize: "12px", color: "var(--fx-text-muted, #64748b)" }}>
              Tổng số điểm nạp:{" "}
              <strong style={{ color: "var(--fx-text-primary, #ffffff)", fontFamily: "var(--fx-font-mono)" }}>
                {observations.length}
              </strong>
            </div>
          </div>

          {loading ? (
            <div
              style={{
                height: "380px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--fx-text-muted, #64748b)",
              }}
            >
              Đang tải dữ liệu chuỗi thời gian...
            </div>
          ) : observations.length === 0 ? (
            <div
              style={{
                height: "380px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                color: "var(--fx-text-muted, #64748b)",
              }}
            >
              <Icons.TrendingUp size={36} style={{ opacity: 0.4 }} />
              <div>Không tìm thấy điểm đo nào trong khoảng thời gian đã chọn</div>
              <div style={{ fontSize: "12px" }}>
                Hãy thử chọn khoảng thời gian rộng hơn hoặc kiểm tra kết nối trạm Edge.
              </div>
            </div>
          ) : (
            <div ref={chartContainerRef} style={{ width: "100%", height: "380px" }} />
          )}
        </Card>
      )}

      {viewTab === "table" && (
        <Card style={{ overflow: "hidden" }}>
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--fx-border-subtle, #1e293b)",
              fontWeight: 600,
              fontSize: "14px",
              color: "var(--fx-text-primary, #ffffff)",
            }}
          >
            Chi tiết các điểm đo ghi nhận ({observations.length} bản ghi)
          </div>

          {observations.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--fx-text-muted, #64748b)" }}>
              Không có dữ liệu để hiển thị trong bảng.
            </div>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: "500px" }}>
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
                      borderBottom: "1px solid var(--fx-border-subtle, #1e293b)",
                      backgroundColor: "var(--fx-bg-tertiary, #161e2e)",
                      color: "var(--fx-text-secondary, #94a3b8)",
                      fontWeight: 600,
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                    }}
                  >
                    <th style={{ padding: "10px 16px" }}>Mốc thời gian (Event Time)</th>
                    <th style={{ padding: "10px 16px" }}>Giá trị đo</th>
                    <th style={{ padding: "10px 16px" }}>Đơn vị</th>
                    <th style={{ padding: "10px 16px" }}>Chất lượng (Quality)</th>
                    <th style={{ padding: "10px 16px" }}>Nguồn gốc (Origin)</th>
                  </tr>
                </thead>
                <tbody>
                  {observations.map((obs, idx) => (
                    <tr
                      key={obs.id || idx}
                      style={{
                        borderBottom: "1px solid var(--fx-border-subtle, #1e293b)",
                        transition: "background-color 0.15s ease",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--fx-bg-tertiary, #161e2e)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <td
                        style={{
                          padding: "10px 16px",
                          fontFamily: "var(--fx-font-mono)",
                          fontSize: "12px",
                          color: "var(--fx-text-secondary, #94a3b8)",
                        }}
                      >
                        {new Date(obs.event_time).toLocaleString("vi-VN")}
                      </td>
                      <td
                        style={{
                          padding: "10px 16px",
                          fontFamily: "var(--fx-font-mono)",
                          fontSize: "13px",
                          fontWeight: 600,
                          color: "var(--fx-text-primary, #ffffff)",
                        }}
                      >
                        {String(obs.value)}
                      </td>
                      <td style={{ padding: "10px 16px", color: "var(--fx-text-muted, #64748b)" }}>
                        {obs.unit || selectedSignal?.unit || "—"}
                      </td>
                      <td style={{ padding: "10px 16px" }}>
                        <QualityBadge quality={obs.quality as any} />
                      </td>
                      <td
                        style={{
                          padding: "10px 16px",
                          fontSize: "11px",
                          color: "var(--fx-text-muted, #64748b)",
                          fontFamily: "var(--fx-font-mono)",
                        }}
                      >
                        {obs.origin || "EDGE"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {viewTab === "health" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <Card style={{ padding: "20px" }}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "15px", fontWeight: 600, color: "var(--fx-text-primary, #ffffff)" }}>
              Trạng thái Lưu Trữ & Nạp Dữ Liệu
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", fontSize: "13px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--fx-border-subtle, #1e293b)", paddingBottom: "8px" }}>
                <span style={{ color: "var(--fx-text-muted, #64748b)" }}>Tốc độ nạp trung bình:</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--fx-font-mono)" }}>
                  {health?.ingest_per_minute || 0} obs / phút
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--fx-border-subtle, #1e293b)", paddingBottom: "8px" }}>
                <span style={{ color: "var(--fx-text-muted, #64748b)" }}>Bản ghi cách ly (Quarantine):</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--fx-font-mono)", color: (health?.quarantine || 0) > 0 ? "var(--fx-status-warning, #f59e0b)" : "var(--fx-text-primary, #ffffff)" }}>
                  {health?.quarantine || 0}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--fx-border-subtle, #1e293b)", paddingBottom: "8px" }}>
                <span style={{ color: "var(--fx-text-muted, #64748b)" }}>Khóa chống trùng lặp (Dedup keys):</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--fx-font-mono)" }}>
                  {health?.dedup_keys || 0}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--fx-text-muted, #64748b)" }}>Bản ghi mới nhất nạp lúc:</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--fx-font-mono)", fontSize: "12px" }}>
                  {health?.newest ? new Date(health.newest).toLocaleString("vi-VN") : "Chưa có"}
                </span>
              </div>
            </div>
          </Card>

          <Card style={{ padding: "20px" }}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "15px", fontWeight: 600, color: "var(--fx-text-primary, #ffffff)" }}>
              Chính Sách Lưu Giữ Dữ Liệu (Retention)
            </h3>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "var(--fx-text-muted, #64748b)", lineHeight: 1.5 }}>
              Dữ liệu chuỗi thời gian tự động được lưu trữ tối ưu theo các tầng nóng/lạnh, tuân thủ chính sách
              bảo lưu định kỳ của nhà máy.
            </p>
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "6px",
                backgroundColor: "var(--fx-bg-tertiary, #161e2e)",
                border: "1px solid var(--fx-border-subtle, #1e293b)",
                fontSize: "12px",
                color: "var(--fx-text-secondary, #94a3b8)",
              }}
            >
              Chính sách mặc định toàn hệ thống: Lưu trữ tối đa <strong>365 ngày</strong>. Bản ghi quá hạn tự động được nén và chuyển sang kho lưu trữ thứ cấp.
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
