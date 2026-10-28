import React, { useState } from "react";
import { api } from "../../api/client";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Tabs";
import { PlayIcon } from "../../components/ui/Icons";

const DEFAULT_SAMPLE_JSON = JSON.stringify(
  {
    factory: {
      zone: "ASSY-ZONE-1",
      machine: {
        code: "AA10-01",
        name: "May Lap Rap Truc Chinh",
        telemetry: {
          temperature_c: 49.5,
          vibration_mms: 1.82,
          running: true,
          cycle_count: 12560,
        },
      },
    },
    timestamp: "2026-10-28T09:30:00Z",
  },
  null,
  2
);

interface JsonTreeNodeProps {
  keyName: string;
  value: any;
  currentPath: string;
  onSelectPath: (path: string) => void;
  selectedPath: string;
}

const JsonTreeNode: React.FC<JsonTreeNodeProps> = ({
  keyName,
  value,
  currentPath,
  onSelectPath,
  selectedPath,
}) => {
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const [collapsed, setCollapsed] = useState(false);

  const isSelected = selectedPath === currentPath;

  if (isObject) {
    return (
      <div style={{ paddingLeft: "14px", borderLeft: "1px dashed var(--border-medium)" }}>
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{
            cursor: "pointer",
            fontSize: "12.5px",
            color: "var(--brand-primary)",
            fontWeight: 600,
            padding: "2px 0",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span>{collapsed ? "▶" : "▼"}</span>
          <span>{keyName}</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{`{...}`}</span>
        </div>
        {!collapsed &&
          Object.entries(value).map(([childKey, childVal]) => (
            <JsonTreeNode
              key={childKey}
              keyName={childKey}
              value={childVal}
              currentPath={`${currentPath}.${childKey}`}
              onSelectPath={onSelectPath}
              selectedPath={selectedPath}
            />
          ))}
      </div>
    );
  }

  if (isArray) {
    return (
      <div style={{ paddingLeft: "14px", borderLeft: "1px dashed var(--border-medium)" }}>
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{
            cursor: "pointer",
            fontSize: "12.5px",
            color: "var(--status-warning)",
            fontWeight: 600,
            padding: "2px 0",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span>{collapsed ? "▶" : "▼"}</span>
          <span>{keyName}</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{`[${value.length}]`}</span>
        </div>
        {!collapsed &&
          value.map((childVal, idx) => (
            <JsonTreeNode
              key={idx}
              keyName={`[${idx}]`}
              value={childVal}
              currentPath={`${currentPath}[${idx}]`}
              onSelectPath={onSelectPath}
              selectedPath={selectedPath}
            />
          ))}
      </div>
    );
  }

  // Primitive value
  return (
    <div
      onClick={() => onSelectPath(currentPath)}
      style={{
        paddingLeft: "14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 8px",
        backgroundColor: isSelected ? "var(--brand-surface)" : "transparent",
        borderRadius: "var(--radius-xs)",
        cursor: "pointer",
        transition: "background-color var(--duration-fast)",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = "var(--bg-card-hover)";
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-primary)" }}>
          {keyName}:
        </span>
        <span
          className="tabular"
          style={{
            fontSize: "12.5px",
            color: typeof value === "number" ? "var(--status-good)" : typeof value === "boolean" ? "var(--status-idle)" : "var(--text-secondary)",
          }}
        >
          {JSON.stringify(value)}
        </span>
      </div>
      <button
        type="button"
        style={{
          background: "transparent",
          border: "none",
          color: isSelected ? "var(--brand-primary)" : "var(--text-muted)",
          fontSize: "11px",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {isSelected ? "ĐÃ CHỌN" : "CHỌN FIELD"}
      </button>
    </div>
  );
};

export const JsonMapper: React.FC = () => {
  const [jsonText, setJsonText] = useState(DEFAULT_SAMPLE_JSON);
  const [jsonPath, setJsonPath] = useState("$.factory.machine.telemetry.temperature_c");
  const [parsedDoc, setParsedDoc] = useState<any>(() => {
    try {
      return JSON.parse(DEFAULT_SAMPLE_JSON);
    } catch {
      return {};
    }
  });

  const [previewResult, setPreviewResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const { success, error } = useToast();

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      setParsedDoc(parsed);
    } catch {
      // Invalid JSON syntax
    }
  };

  const handleTestMapping = async () => {
    if (!jsonPath.trim()) {
      error("Vui lòng nhập đường dẫn JSONPath.");
      return;
    }

    setTesting(true);
    try {
      const doc = JSON.parse(jsonText);
      const res = await api.post("/api/v1/mappings/preview", {
        expression: jsonPath.trim(),
        document: doc,
        cardinality: "REJECT_MULTI",
        missing: "NULL",
        samples: [],
      });

      setPreviewResult(res);
      success("Kiểm thử trích xuất dữ liệu thành công!");
    } catch (err: any) {
      error("Lỗi trích xuất JSONPath: " + (err.message || ""));
      setPreviewResult({ error: err.message || "Lỗi cú pháp" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)" }}>
          TRÌNH ÁNH XẠ DỮ LIỆU JSON (RFC 9535 JSONPATH MAPPER)
        </h2>
        <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
          Tự động phân giải cấu trúc payload MQTT/API, sinh biểu thức JSONPath chuẩn hóa và kiểm thử thời gian thực
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.8fr", gap: "20px" }}>
        {/* Left: Raw JSON Sample Input */}
        <Card title="Gói Tin Mẫu (Sample Payload)">
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <textarea
              rows={16}
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              style={{
                width: "100%",
                backgroundColor: "var(--bg-inset)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-medium)",
                borderRadius: "var(--radius-sm)",
                padding: "12px",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                lineHeight: 1.4,
                outline: "none",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: "8px" }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleJsonChange(DEFAULT_SAMPLE_JSON)}
              >
                Tải mẫu Nhà máy
              </Button>
            </div>
          </div>
        </Card>

        {/* Right: Interactive JSON Tree & Generator */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* JSONPath Expression Control */}
          <Card title="Biểu Thức JSONPath Sinh Tự Động">
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", gap: "10px" }}>
                <Input
                  value={jsonPath}
                  onChange={(e) => setJsonPath(e.target.value)}
                  placeholder="$.path.to.field"
                  style={{ fontFamily: "var(--font-mono)", fontSize: "13.5px" }}
                />
                <Button
                  variant="primary"
                  icon={<PlayIcon size={14} />}
                  loading={testing}
                  onClick={handleTestMapping}
                >
                  Trích xuất thử
                </Button>
              </div>

              {/* Extraction Preview Result Box */}
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
                      Kết quả trích xuất
                    </span>
                    <div
                      className="tabular"
                      style={{
                        fontSize: "16px",
                        fontWeight: 700,
                        color: previewResult.error ? "var(--status-bad)" : "var(--status-good)",
                        marginTop: "2px",
                      }}
                    >
                      {previewResult.error ? previewResult.error : JSON.stringify(previewResult.value ?? previewResult)}
                    </div>
                  </div>
                  <Badge variant={previewResult.error ? "bad" : "good"} dot>
                    {previewResult.error ? "LỖI TRÍCH XUẤT" : "HỢP LỆ (GOOD)"}
                  </Badge>
                </div>
              )}
            </div>
          </Card>

          {/* Interactive Visual Tree */}
          <Card title="Cây Cấu Trúc Payload (Click vào trường để chọn)">
            <div style={{ maxHeight: "280px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" }}>
              {parsedDoc && typeof parsedDoc === "object" ? (
                Object.entries(parsedDoc).map(([key, val]) => (
                  <JsonTreeNode
                    key={key}
                    keyName={key}
                    value={val}
                    currentPath={`$.${key}`}
                    onSelectPath={(path) => {
                      setJsonPath(path);
                      setPreviewResult(null);
                    }}
                    selectedPath={jsonPath}
                  />
                ))
              ) : (
                <div style={{ padding: "20px", color: "var(--text-muted)", fontSize: "12.5px" }}>
                  Dữ liệu JSON không hợp lệ để duyệt cây.
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
