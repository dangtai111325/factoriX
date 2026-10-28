import React, { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Formula, Signal, Resource } from "../../api/types";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Tabs";
import { PlayIcon, CheckIcon } from "../../components/ui/Icons";

export const FormulaWorkbench: React.FC = () => {
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [, setLoading] = useState(true);

  // New formula form
  const [key, setKey] = useState("availability_rate");
  const [displayName, setDisplayName] = useState("Tỷ lệ sẵn sàng vận hành");
  const [expression, setExpression] = useState("uptime / (uptime + downtime) if (uptime + downtime) > 0 else 0");
  const [unit, setUnit] = useState("%");
  const [selectedResourceId, setSelectedResourceId] = useState<string>("");

  // Aliases: variable alias -> signal_id
  const [aliases, setAliases] = useState<Array<{ alias: string; signalId: string; testValue: number }>>([
    { alias: "uptime", signalId: "", testValue: 450 },
    { alias: "downtime", signalId: "", testValue: 30 },
  ]);

  const [previewResult, setPreviewResult] = useState<any>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [saving, setSaving] = useState(false);

  const { success, error } = useToast();

  const loadData = async () => {
    setLoading(true);
    try {
      const [fRes, sRes, rRes] = await Promise.all([
        api.get<{ items: Formula[] }>("/api/v1/formulas"),
        api.get<{ items: Signal[] }>("/api/v1/signals?limit=250"),
        api.get<{ items: Resource[] }>("/api/v1/resources?view=all&limit=200"),
      ]);
      setFormulas(fRes.items || []);
      const sigList = sRes.items || [];
      setSignals(sigList);
      const resList = rRes.items || [];
      setResources(resList);

      if (resList.length > 0 && !selectedResourceId) {
        setSelectedResourceId(resList[0].id);
      }
    } catch (err: any) {
      error("Lỗi khi tải danh sách công thức: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleTestEvaluate = async () => {
    if (!expression.trim()) return;

    setEvaluating(true);
    try {
      const testValues: Record<string, any> = {};
      const testQualities: Record<string, string> = {};
      const aliasMap: Record<string, string> = {};

      for (const item of aliases) {
        if (item.alias) {
          testValues[item.alias] = item.testValue;
          testQualities[item.alias] = "GOOD";
          aliasMap[item.alias] = item.signalId || "dummy-signal-id";
        }
      }

      const res = await api.post("/api/v1/formulas/evaluate-preview", {
        expression: expression.trim(),
        values: testValues,
        qualities: testQualities,
        aliases: aliasMap,
      });

      setPreviewResult(res);
      success("Kiểm thử tính toán công thức thành công!");
    } catch (err: any) {
      error("Lỗi đánh giá công thức: " + (err.message || ""));
      setPreviewResult({ error: err.message || "Lỗi cú pháp" });
    } finally {
      setEvaluating(false);
    }
  };

  const handleSaveFormula = async () => {
    if (!key.trim() || !displayName.trim() || !expression.trim()) {
      error("Vui lòng điền đủ mã, tên và biểu thức công thức.");
      return;
    }

    if (!selectedResourceId) {
      error("Vui lòng chọn thiết bị sở hữu công thức này.");
      return;
    }

    setSaving(true);
    try {
      const aliasMap: Record<string, string> = {};
      for (const item of aliases) {
        if (item.alias && item.signalId) {
          aliasMap[item.alias] = item.signalId;
        }
      }

      const created = await api.post<Formula>("/api/v1/formulas", {
        resource_id: selectedResourceId,
        key: key.trim(),
        display_name: displayName.trim(),
        expression: expression.trim(),
        aliases: aliasMap,
        unit: unit.trim() || null,
        temporal_policy: "LATEST",
      });

      // Auto publish
      if (created.id) {
        await api.post(`/api/v1/formulas/${created.id}/publish`);
      }

      success(`Đã lưu và phát hành công thức [${key}] thành công.`);
      loadData();
    } catch (err: any) {
      error("Lưu công thức thất bại: " + (err.message || ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)" }}>
          XƯỞNG CÔNG THỨC TOÁN HỌC CÔNG NGHIỆP (CALCULATED SIGNALS)
        </h2>
        <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
          Tính toán các chỉ số OEE, năng suất, điện năng dựa trên biến đo thời gian thực với cơ chế phòng chống lỗi chia 0
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1.4fr", gap: "20px" }}>
        {/* Left: Formula Editor & Test Harness */}
        <Card title="Trình Soạn Thảo Biểu Thức An Toàn (Restricted Python AST)">
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "10px" }}>
              <Input
                label="Mã định danh tín hiệu tính (Key)"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="availability_rate"
                required
              />
              <Input
                label="Tên hiển thị"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Tỷ lệ hoạt động"
                required
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px" }}>
              <Select
                label="Thiết bị áp dụng công thức"
                value={selectedResourceId}
                onChange={(e) => setSelectedResourceId(e.target.value)}
              >
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} - {r.name}
                  </option>
                ))}
              </Select>
              <Input
                label="Đơn vị kết quả"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="%"
              />
            </div>

            <div>
              <label style={{ fontSize: "12.5px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "6px", display: "block" }}>
                Biểu thức toán học
              </label>
              <textarea
                rows={3}
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                style={{
                  width: "100%",
                  backgroundColor: "var(--bg-inset)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-medium)",
                  borderRadius: "var(--radius-sm)",
                  padding: "10px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "13px",
                  outline: "none",
                }}
              />
            </div>

            {/* Referenced Variables */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>
                BIẾN THAM CHIẾU & GIÁ TRỊ KIỂM THỬ THỜI GIAN THỰC
              </span>
              {aliases.map((item, idx) => (
                <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr 0.8fr", gap: "8px", alignItems: "center" }}>
                  <Input
                    value={item.alias}
                    onChange={(e) => {
                      const next = [...aliases];
                      next[idx].alias = e.target.value;
                      setAliases(next);
                    }}
                    placeholder="Tên biến"
                  />
                  <Select
                    value={item.signalId}
                    onChange={(e) => {
                      const next = [...aliases];
                      next[idx].signalId = e.target.value;
                      setAliases(next);
                    }}
                  >
                    <option value="">(Chọn tín hiệu gốc)</option>
                    {signals.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.key} ({s.display_name})
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    value={item.testValue}
                    onChange={(e) => {
                      const next = [...aliases];
                      next[idx].testValue = Number(e.target.value);
                      setAliases(next);
                    }}
                    placeholder="Test val"
                  />
                </div>
              ))}
            </div>

            {/* Test & Save buttons */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "10px" }}>
              <Button variant="outline" size="sm" icon={<PlayIcon size={14} />} loading={evaluating} onClick={handleTestEvaluate}>
                Chạy thử nghiệm (Evaluate Preview)
              </Button>

              <Button variant="primary" size="sm" icon={<CheckIcon size={14} />} loading={saving} onClick={handleSaveFormula}>
                Lưu & Phát hành Công thức
              </Button>
            </div>

            {/* Preview result */}
            {previewResult && (
              <div
                style={{
                  padding: "12px 14px",
                  backgroundColor: previewResult.error ? "var(--status-bad-bg)" : "var(--status-good-bg)",
                  border: `1px solid ${previewResult.error ? "var(--status-bad-border)" : "var(--status-good-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase" }}>
                    Kết quả tính toán
                  </span>
                  <div className="tabular" style={{ fontSize: "18px", fontWeight: 700, color: previewResult.error ? "var(--status-bad)" : "var(--status-good)" }}>
                    {previewResult.error ? previewResult.error : `${previewResult.value} ${unit}`}
                  </div>
                </div>
                <Badge variant={previewResult.error ? "bad" : "good"} dot>
                  {previewResult.error ? "LỖI BIỂU THỨC" : "THÀNH CÔNG (VALID)"}
                </Badge>
              </div>
            )}
          </div>
        </Card>

        {/* Right: Existing Formulas Table */}
        <Card title={`Công Thức Đang Vận Hành (${formulas.length})`}>
          <div style={{ overflowY: "auto", maxHeight: "480px", display: "flex", flexDirection: "column", gap: "10px" }}>
            {formulas.length > 0 ? (
              formulas.map((f) => (
                <div
                  key={f.id}
                  style={{
                    padding: "12px 14px",
                    backgroundColor: "var(--bg-inset)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span className="tabular" style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--text-primary)" }}>
                      {f.key}
                    </span>
                    <Badge variant={f.status === "PUBLISHED" ? "good" : "warning"}>
                      {f.status} (v{f.revision})
                    </Badge>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{f.display_name}</div>
                  <div
                    style={{
                      padding: "6px 8px",
                      backgroundColor: "var(--bg-elevated)",
                      borderRadius: "var(--radius-xs)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--brand-primary)",
                      overflowX: "auto",
                    }}
                  >
                    {f.expression_source}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: "13px" }}>
                Chưa có công thức tính toán nào được tạo.
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
