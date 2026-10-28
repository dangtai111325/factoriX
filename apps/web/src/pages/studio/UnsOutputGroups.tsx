import React, { useEffect, useState } from "react";
import { api } from "../../api/client";
import { OutputGroup, Signal, Resource } from "../../api/types";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Input, Select } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Tabs";
import { PlusIcon, CheckIcon, PlayIcon, RefreshIcon } from "../../components/ui/Icons";

export const UnsOutputGroups: React.FC = () => {
  const [groups, setGroups] = useState<OutputGroup[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal create
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedResourceId, setSelectedResourceId] = useState("");
  const [key, setKey] = useState("operational");
  const [displayName, setDisplayName] = useState("Nhóm Thông Số Vận Hành");
  const [topicTemplate, setTopicTemplate] = useState("fx/v1/{enterprise}/{site}/{plant}/{resource}/operational");
  const [selectedSignals, setSelectedSignals] = useState<string[]>([]);

  // Preview modal
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewGroupId, setPreviewGroupId] = useState<string | null>(null);

  const { success, error } = useToast();

  const loadData = async () => {
    setLoading(true);
    try {
      const [gRes, sRes, rRes] = await Promise.all([
        api.get<{ items: OutputGroup[] }>("/api/v1/output-groups"),
        api.get<{ items: Signal[] }>("/api/v1/signals?limit=250"),
        api.get<{ items: Resource[] }>("/api/v1/resources?view=all&limit=200"),
      ]);
      setGroups(gRes.items || []);
      setSignals(sRes.items || []);
      const rList = rRes.items || [];
      setResources(rList);
      if (rList.length > 0 && !selectedResourceId) {
        setSelectedResourceId(rList[0].id);
      }
    } catch (err: any) {
      error("Lỗi khi tải nhóm đầu ra UNS: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim() || !displayName.trim() || !selectedResourceId) {
      error("Vui lòng điền đầy đủ các thông tin bắt buộc.");
      return;
    }

    try {
      const members = selectedSignals.map((id) => {
        const sig = signals.find((s) => s.id === id);
        return { signal_id: id, alias: sig?.key || "value" };
      });

      await api.post("/api/v1/output-groups", {
        resource_id: selectedResourceId,
        key: key.trim(),
        display_name: displayName.trim(),
        topic_template: topicTemplate.trim(),
        members,
      });

      success(`Đã tạo nhóm UNS [${key}] thành công.`);
      setIsCreateOpen(false);
      loadData();
    } catch (err: any) {
      error("Tạo nhóm thất bại: " + (err.message || ""));
    }
  };

  const handlePreview = async (group: OutputGroup) => {
    try {
      const res = await api.get(`/api/v1/output-groups/${group.id}/preview`);
      setPreviewData(res);
      setPreviewGroupId(group.id);
    } catch (err: any) {
      error("Xem trước dữ liệu thất bại: " + (err.message || ""));
    }
  };

  const handlePublish = async (group: OutputGroup) => {
    try {
      await api.post(`/api/v1/output-groups/${group.id}/publish`);
      success(`Đã phát hành nhóm UNS [${group.key}] lên broker!`);
      loadData();
    } catch (err: any) {
      error("Phát hành thất bại: " + (err.message || ""));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)" }}>
            KHÔNG GIAN TÊN THỐNG NHẤT (UNIFIED NAMESPACE - UNS OUTPUT GROUPS)
          </h2>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
            Tổ chức các nhóm chiếu dữ liệu quan trắc canonical thành topic MQTT theo chuẩn ISA-95
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Button variant="outline" size="sm" icon={<RefreshIcon size={14} />} loading={loading} onClick={loadData}>
            Tải lại
          </Button>
          <Button variant="primary" size="sm" icon={<PlusIcon size={14} />} onClick={() => setIsCreateOpen(true)}>
            Tạo nhóm đầu ra UNS
          </Button>
        </div>
      </div>

      <Card>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)", fontSize: "11.5px" }}>
                <th style={{ padding: "12px 16px" }}>MÃ NHÓM (KEY)</th>
                <th style={{ padding: "12px 16px" }}>TÊN HIỂN THỊ</th>
                <th style={{ padding: "12px 16px" }}>THIẾT BỊ</th>
                <th style={{ padding: "12px 16px" }}>MẪU CHỦ ĐỀ (TOPIC TEMPLATE)</th>
                <th style={{ padding: "12px 16px" }}>TRẠNG THÁI</th>
                <th style={{ padding: "12px 16px", textAlign: "right" }}>THAO TÁC</th>
              </tr>
            </thead>
            <tbody>
              {groups.length > 0 ? (
                groups.map((g) => (
                  <tr
                    key={g.id}
                    style={{ borderBottom: "1px solid var(--border-subtle)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-card-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <td style={{ padding: "14px 16px" }}>
                      <span className="tabular" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                        {g.key}
                      </span>
                    </td>
                    <td style={{ padding: "14px 16px", color: "var(--text-primary)" }}>{g.display_name}</td>
                    <td style={{ padding: "14px 16px" }}>
                      <span className="tabular" style={{ fontWeight: 600, color: "var(--brand-primary)" }}>
                        {g.resource_code || g.resource_id.slice(0, 8)}
                      </span>
                    </td>
                    <td style={{ padding: "14px 16px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-secondary)" }}>
                      {g.topic_template}
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      <Badge variant={g.status === "PUBLISHED" ? "good" : "warning"} dot>
                        {g.status} (v{g.version})
                      </Badge>
                    </td>
                    <td style={{ padding: "14px 16px", textAlign: "right" }}>
                      <div style={{ display: "inline-flex", gap: "8px" }}>
                        <Button variant="outline" size="sm" icon={<PlayIcon size={12} />} onClick={() => handlePreview(g)}>
                          Xem JSON
                        </Button>
                        <Button variant="primary" size="sm" icon={<CheckIcon size={12} />} onClick={() => handlePublish(g)}>
                          Phát hành
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "48px", color: "var(--text-muted)" }}>
                    Chưa có nhóm đầu ra UNS nào được định nghĩa.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Modal: Create Output Group */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Tạo Nhóm Đầu Ra UNS (Unified Namespace Projection)"
        subtitle="Chiếu các tín hiệu quan trắc thành gói JSON theo chủ đề MQTT"
        width="560px"
      >
        <form onSubmit={handleCreateGroup} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <Select
            label="Thiết bị sở hữu nhóm này"
            value={selectedResourceId}
            onChange={(e) => setSelectedResourceId(e.target.value)}
          >
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} - {r.name}
              </option>
            ))}
          </Select>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <Input
              label="Mã nhóm (Key)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="operational"
              required
            />
            <Input
              label="Tên nhóm"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Thông số vận hành"
              required
            />
          </div>

          <Input
            label="Mẫu chủ đề MQTT (Topic Template)"
            value={topicTemplate}
            onChange={(e) => setTopicTemplate(e.target.value)}
            helperText="Các biến có sẵn: {enterprise}, {site}, {plant}, {resource}"
            required
          />

          <div>
            <label style={{ fontSize: "12.5px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "6px", display: "block" }}>
              Chọn các tín hiệu đưa vào nhóm ({selectedSignals.length} đã chọn)
            </label>
            <div
              style={{
                maxHeight: "180px",
                overflowY: "auto",
                backgroundColor: "var(--bg-inset)",
                border: "1px solid var(--border-medium)",
                borderRadius: "var(--radius-sm)",
                padding: "8px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              {signals.map((sig) => {
                const checked = selectedSignals.includes(sig.id);
                return (
                  <label
                    key={sig.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "13px",
                      cursor: "pointer",
                      padding: "4px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedSignals([...selectedSignals, sig.id]);
                        else setSelectedSignals(selectedSignals.filter((id) => id !== sig.id));
                      }}
                    />
                    <span className="tabular" style={{ fontWeight: 600 }}>{sig.key}</span>
                    <span style={{ color: "var(--text-secondary)" }}>— {sig.display_name}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
            <Button variant="ghost" onClick={() => setIsCreateOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" variant="primary">
              Tạo Nhóm
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Preview Output JSON */}
      <Modal
        isOpen={Boolean(previewGroupId)}
        onClose={() => setPreviewGroupId(null)}
        title="Xem Trước Gói Dữ Liệu Chiếu (UNS Payload Preview)"
        subtitle="Mô phỏng dữ liệu phát hành lên topic MQTT"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <pre
            style={{
              padding: "16px",
              backgroundColor: "var(--bg-inset)",
              border: "1px solid var(--border-medium)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono)",
              fontSize: "12.5px",
              color: "var(--text-primary)",
              overflowX: "auto",
            }}
          >
            {JSON.stringify(previewData, null, 2)}
          </pre>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="primary" onClick={() => setPreviewGroupId(null)}>
              Đóng
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
