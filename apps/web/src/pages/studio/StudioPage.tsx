import { useState } from "react";
import { SignalCatalog } from "./SignalCatalog";
import { JsonMapper } from "./JsonMapper";
import { FormulaWorkbench } from "./FormulaWorkbench";
import { UnsOutputGroups } from "./UnsOutputGroups";
import { Tabs } from "../../components/ui/Tabs";
import { Icons } from "../../components/ui/Icons";

export function StudioPage() {
  const [activeTab, setActiveTab] = useState<string>("catalog");

  const tabItems = [
    {
      id: "catalog",
      label: "Danh mục tín hiệu",
      icon: <Icons.Activity size={16} />,
    },
    {
      id: "mapper",
      label: "Bộ trích xuất JSON (RFC 9535)",
      icon: <Icons.Braces size={16} />,
    },
    {
      id: "formula",
      label: "Tín hiệu tính toán (Formula)",
      icon: <Icons.Cpu size={16} />,
    },
    {
      id: "uns",
      label: "Nhóm phát hành UNS (ISA-95)",
      icon: <Icons.Network size={16} />,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
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
              <Icons.Sliders size={20} />
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
              Xưởng Kỹ Thuật Dữ Liệu (Data Studio)
            </h1>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              color: "var(--fx-text-muted)",
              maxWidth: "680px",
              lineHeight: 1.5,
            }}
          >
            Quản trị toàn bộ danh mục thông số OT, cấu hình bộ bóc tách JSONPath theo chuẩn RFC 9535,
            thiết lập công thức tính toán thời gian thực và đồng bộ không gian tên hợp nhất (UNS ISA-95).
          </p>
        </div>
      </div>

      {/* Tabs navigation */}
      <div>
        <Tabs items={tabItems} activeId={activeTab} onChange={setActiveTab} />
      </div>

      {/* Tab Panels */}
      <div style={{ minHeight: "600px" }}>
        {activeTab === "catalog" && <SignalCatalog />}
        {activeTab === "mapper" && <JsonMapper />}
        {activeTab === "formula" && <FormulaWorkbench />}
        {activeTab === "uns" && <UnsOutputGroups />}
      </div>
    </div>
  );
}
