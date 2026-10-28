import React, { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Signal, Resource } from "../../api/types";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Input, Select } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Tabs";
import { PlusIcon, RefreshIcon } from "../../components/ui/Icons";

export const SignalCatalog: React.FC = () => {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);

  // Bulk add modal
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [selectedResourceId, setSelectedResourceId] = useState<string>("");
  const [bulkRows, setBulkRows] = useState<Array<{ key: string; name: string; data_type: string; unit: string }>>([
    { key: "temp_c", name: "Nhiệt độ buồng máy", data_type: "float64", unit: "Cel" },
    { key: "speed_rpm", name: "Tốc độ trục chính", data_type: "float64", unit: "rpm" },
  ]);

  const { success, error } = useToast();

  const loadData = async () => {
    setLoading(true);
    try {
      const [sigRes, resData] = await Promise.all([
        api.get<{ items: Signal[] }>("/api/v1/signals?limit=250"),
        api.get<{ items: Resource[] }>("/api/v1/resources?view=all&limit=200"),
      ]);
      setSignals(sigRes.items || []);
      const rList = resData.items || [];
      setResources(rList);
      if (rList.length > 0 && !selectedResourceId) {
        setSelectedResourceId(rList[0].id);
      }
    } catch (err: any) {
      error("Lỗi khi tải danh mục tín hiệu: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddBulkRow = () => {
    setBulkRows([
      ...bulkRows,
      { key: `signal_${bulkRows.length + 1}`, name: "Tín hiệu mới", data_type: "float64", unit: "" },
    ]);
  };

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedResourceId) {
      error("Vui lòng chọn thiết bị gắn tín hiệu.");
      return;
    }

    try {
      const payload = {
        resource_id: selectedResourceId,
        atomic: true,
        items: bulkRows.map((row) => ({
          key: row.key.trim(),
          name: row.name.trim(),
          data_type: row.data_type,
          unit: row.unit.trim() || undefined,
        })),
      };

      await api.post("/api/v1/signals/bulk", payload);
      success(`Đã khai báo thành công ${bulkRows.length} tín hiệu.`);
      setIsBulkOpen(false);
      loadData();
    } catch (err: any) {
      error("Lưu tín hiệu thất bại: " + (err.message || ""));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Action Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)" }}>
            DANH MỤC TÍN HIỆU CÔNG NGHIỆP ({signals.length})
          </h2>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
            Quản lý các điểm đo, biến trạng thái, kiểu dữ liệu và đơn vị chuẩn hóa
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Button variant="outline" size="sm" icon={<RefreshIcon size={14} />} loading={loading} onClick={loadData}>
            Tải lại
          </Button>
          <Button variant="primary" size="sm" icon={<PlusIcon size={14} />} onClick={() => setIsBulkOpen(true)}>
            Khai báo tín hiệu mới
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)", fontSize: "11.5px" }}>
                <th style={{ padding: "12px 16px" }}>MÃ TÍN HIỆU (KEY)</th>
                <th style={{ padding: "12px 16px" }}>TÊN HIỂN THỊ</th>
                <th style={{ padding: "12px 16px" }}>THIẾT BỊ SỞ HỮU</th>
                <th style={{ padding: "12px 16px" }}>KIỂU DỮ LIỆU</th>
                <th style={{ padding: "12px 16px" }}>ĐƠN VỊ ĐO</th>
                <th style={{ padding: "12px 16px" }}>NGUỒN DỮ LIỆU (MAPPING)</th>
              </tr>
            </thead>
            <tbody>
              {signals.length > 0 ? (
                signals.map((sig) => {
                  const res = resources.find((r) => r.id === sig.resource_id);
                  return (
                    <tr
                      key={sig.id}
                      style={{ borderBottom: "1px solid var(--border-subtle)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-card-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <td style={{ padding: "12px 16px" }}>
                        <span className="tabular" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                          {sig.key}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", color: "var(--text-primary)" }}>
                        {sig.display_name}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span className="tabular" style={{ fontWeight: 600, color: "var(--brand-primary)" }}>
                          {res?.code || sig.resource_id.slice(0, 8)}
                        </span>
                        {res && (
                          <span style={{ fontSize: "11.5px", color: "var(--text-secondary)", marginLeft: "6px" }}>
                            ({res.name})
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <Badge variant="neutral" style={{ fontFamily: "var(--font-mono)" }}>
                          {sig.data_type}
                        </Badge>
                      </td>
                      <td style={{ padding: "12px 16px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                        {sig.unit || "--"}
                      </td>
                      <td style={{ padding: "12px 16px", color: "var(--text-muted)", fontSize: "11.5px", fontFamily: "var(--font-mono)" }}>
                        {sig.source_field ? JSON.stringify(sig.source_field.address || sig.source_field.address_kind) : "Tính toán (Formula)"}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "48px", color: "var(--text-muted)" }}>
                    Chưa có tín hiệu nào được khai báo. Hãy bấm "Khai báo tín hiệu mới".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Bulk Add Modal */}
      <Modal
        isOpen={isBulkOpen}
        onClose={() => setIsBulkOpen(false)}
        title="Khai Báo Tín Hiệu Hàng Loạt"
        subtitle="Gán các thông số đo cảm biến vào thiết bị tương ứng"
        width="660px"
      >
        <form onSubmit={handleBulkSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <Select
            label="Thiết bị đích sở hữu các tín hiệu này"
            value={selectedResourceId}
            onChange={(e) => setSelectedResourceId(e.target.value)}
          >
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} - {r.name}
              </option>
            ))}
          </Select>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>
              DANH SÁCH TÍN HIỆU
            </span>
            {bulkRows.map((row, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1.2fr 1.5fr 1fr 0.8fr 30px", gap: "8px", alignItems: "center" }}>
                <Input
                  value={row.key}
                  onChange={(e) => {
                    const next = [...bulkRows];
                    next[idx].key = e.target.value;
                    setBulkRows(next);
                  }}
                  placeholder="Mã key"
                  required
                />
                <Input
                  value={row.name}
                  onChange={(e) => {
                    const next = [...bulkRows];
                    next[idx].name = e.target.value;
                    setBulkRows(next);
                  }}
                  placeholder="Tên hiển thị"
                  required
                />
                <Select
                  value={row.data_type}
                  onChange={(e) => {
                    const next = [...bulkRows];
                    next[idx].data_type = e.target.value;
                    setBulkRows(next);
                  }}
                  options={[
                    { label: "float64", value: "float64" },
                    { label: "int64", value: "int64" },
                    { label: "boolean", value: "boolean" },
                    { label: "string", value: "string" },
                  ]}
                />
                <Input
                  value={row.unit}
                  onChange={(e) => {
                    const next = [...bulkRows];
                    next[idx].unit = e.target.value;
                    setBulkRows(next);
                  }}
                  placeholder="Đơn vị"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (bulkRows.length > 1) {
                      setBulkRows(bulkRows.filter((_, i) => i !== idx));
                    }
                  }}
                  style={{ background: "transparent", border: "none", color: "var(--status-bad)", cursor: "pointer" }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <Button type="button" variant="outline" size="sm" icon={<PlusIcon size={14} />} onClick={handleAddBulkRow}>
            Thêm dòng tín hiệu
          </Button>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
            <Button variant="ghost" onClick={() => setIsBulkOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" variant="primary">
              Xác Nhận Lưu Tín Hiệu
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
