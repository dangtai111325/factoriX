import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { Resource, ResourceType, LayoutDefinition, Site } from "../../api/types";
import { AssetTree } from "./AssetTree";
import { FactoryCanvas } from "./FactoryCanvas";
import { AssetDetailDrawer } from "./AssetDetailDrawer";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Input, Select } from "../../components/ui/Input";
import { useToast } from "../../components/ui/Tabs";
import {
  PlusIcon,
  UploadIcon,
  RefreshIcon,
} from "../../components/ui/Icons";

export const TopologyPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [resources, setResources] = useState<Resource[]>([]);
  const [types, setTypes] = useState<ResourceType[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [, setLayouts] = useState<LayoutDefinition[]>([]);
  const [activeLayout, setActiveLayout] = useState<LayoutDefinition | null>(null);

  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(() => {
    return searchParams.get("resource") || null;
  });

  const [viewMode, setViewMode] = useState<"split" | "tree" | "canvas">("split");
  const [loading, setLoading] = useState(true);

  // Modals state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);

  const [addForm, setAddForm] = useState({
    code: "",
    name: "",
    type_key: "machine",
    site_id: "",
    parent_id: "",
    description: "",
  });

  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);

  const { success, error } = useToast();

  const loadData = async () => {
    setLoading(true);
    try {
      const [resData, typeData, siteData, layoutData] = await Promise.all([
        api.get<{ items: Resource[] }>("/api/v1/resources?view=all&limit=250"),
        api.get<{ items: ResourceType[] }>("/api/v1/resource-types"),
        api.get<{ items: Site[] }>("/api/v1/sites"),
        api.get<{ items: LayoutDefinition[] }>("/api/v1/layouts"),
      ]);

      setResources(resData.items || []);
      setTypes(typeData.items || []);
      setSites(siteData.items || []);

      const layoutList = layoutData.items || [];
      setLayouts(layoutList);
      if (layoutList.length > 0) {
        setActiveLayout(layoutList[0]);
      } else {
        // Create initial default layout if none exists
        try {
          const created = await api.post<LayoutDefinition>("/api/v1/layouts", {
            name: "Mặt bằng Nhà máy Tổng thể",
            scope_resource_id: null,
          });
          setLayouts([created]);
          setActiveLayout(created);
        } catch {
          // Ignore
        }
      }
    } catch (err: any) {
      error("Lỗi khi tải cấu trúc nhà máy: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const resId = searchParams.get("resource");
    if (resId) setSelectedResourceId(resId);
  }, [searchParams]);

  const handleOpenAdd = (parentId?: string) => {
    setSelectedParentId(parentId || null);
    setAddForm({
      code: "",
      name: "",
      type_key: parentId ? "machine" : types[0]?.key || "plant",
      site_id: sites[0]?.id || "",
      parent_id: parentId || "",
      description: "",
    });
    setIsAddOpen(true);
  };

  const handleCreateResource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.code.trim() || !addForm.name.trim()) {
      error("Vui lòng điền mã và tên thiết bị.");
      return;
    }

    try {
      await api.post("/api/v1/resources", {
        code: addForm.code.trim(),
        name: addForm.name.trim(),
        type_key: addForm.type_key,
        site_id: addForm.site_id || null,
        parent_id: addForm.parent_id || selectedParentId || null,
        description: addForm.description.trim() || undefined,
      });

      success(`Đã tạo tài sản [${addForm.code}] thành công.`);
      setIsAddOpen(false);
      loadData();
    } catch (err: any) {
      error("Tạo tài sản thất bại: " + (err.message || ""));
    }
  };

  const handleImportCsv = async () => {
    if (!importText.trim()) return;
    setImporting(true);

    try {
      const lines = importText.trim().split("\n");
      const rows = lines.map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        return {
          code: parts[0] || "",
          name: parts[1] || parts[0] || "",
          type_key: parts[2] || "machine",
          parent_code: parts[3] || undefined,
        };
      });

      await api.post("/api/v1/resources/import", {
        site_id: sites[0]?.id || null,
        dry_run: false,
        rows,
      });

      success(`Đã nạp thành công ${rows.length} thiết bị vào hệ thống.`);
      setIsImportOpen(false);
      setImportText("");
      loadData();
    } catch (err: any) {
      error("Nạp CSV thất bại: " + (err.message || ""));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Top Action Header */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "var(--bg-card)",
          zIndex: 20,
        }}
      >
        <div>
          <h1 style={{ fontSize: "18px", fontWeight: 700, color: "var(--text-primary)" }}>
            KHÔNG GIAN TÀI SẢN & MẶT BẰNG NHÀ MÁY
          </h1>
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)", marginTop: "2px" }}>
            Quản trị phân cấp tài sản PIM và mô phỏng trực quan 2D theo thời gian thực
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {/* View Mode Switcher */}
          <div
            style={{
              display: "flex",
              backgroundColor: "var(--bg-inset)",
              border: "1px solid var(--border-medium)",
              borderRadius: "var(--radius-sm)",
              padding: "2px",
            }}
          >
            <button
              onClick={() => setViewMode("split")}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 600,
                border: "none",
                borderRadius: "var(--radius-xs)",
                backgroundColor: viewMode === "split" ? "var(--bg-elevated)" : "transparent",
                color: viewMode === "split" ? "var(--brand-primary)" : "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              Kết hợp
            </button>
            <button
              onClick={() => setViewMode("canvas")}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 600,
                border: "none",
                borderRadius: "var(--radius-xs)",
                backgroundColor: viewMode === "canvas" ? "var(--bg-elevated)" : "transparent",
                color: viewMode === "canvas" ? "var(--brand-primary)" : "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              Mặt bằng 2D
            </button>
            <button
              onClick={() => setViewMode("tree")}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 600,
                border: "none",
                borderRadius: "var(--radius-xs)",
                backgroundColor: viewMode === "tree" ? "var(--bg-elevated)" : "transparent",
                color: viewMode === "tree" ? "var(--brand-primary)" : "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              Cây phân cấp
            </button>
          </div>

          <Button variant="outline" size="sm" icon={<UploadIcon size={14} />} onClick={() => setIsImportOpen(true)}>
            Nạp CSV
          </Button>

          <Button variant="primary" size="sm" icon={<PlusIcon size={14} />} onClick={() => handleOpenAdd()}>
            Thêm thiết bị mới
          </Button>
        </div>
      </div>

      {/* Main Dual Workspace Content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {/* Left: Tree Navigator */}
        {(viewMode === "split" || viewMode === "tree") && (
          <div
            style={{
              width: viewMode === "split" ? "340px" : "100%",
              height: "100%",
              backgroundColor: "var(--bg-card)",
              borderRight: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              overflowY: "auto",
              padding: "16px",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>
                CẤU TRÚC PHÂN CẤP ({resources.length})
              </span>
              <button
                onClick={loadData}
                disabled={loading}
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", opacity: loading ? 0.5 : 1 }}
                title="Tải lại"
              >
                <RefreshIcon size={14} />
              </button>
            </div>

            <AssetTree
              resources={resources}
              selectedId={selectedResourceId}
              onSelect={(id) => setSelectedResourceId(id)}
              onAddChild={(parentId) => handleOpenAdd(parentId)}
            />
          </div>
        )}

        {/* Right: 2D Interactive Floor Canvas */}
        {(viewMode === "split" || viewMode === "canvas") && (
          <div style={{ flex: 1, height: "100%", position: "relative" }}>
            <FactoryCanvas
              resources={resources}
              activeLayout={activeLayout}
              onSelectResource={(id) => setSelectedResourceId(id)}
              onRefreshLayouts={loadData}
            />
          </div>
        )}
      </div>

      {/* Slide-over Asset Details Drawer */}
      <AssetDetailDrawer
        resourceId={selectedResourceId}
        onClose={() => setSelectedResourceId(null)}
        onRefresh={loadData}
      />

      {/* Modal: Add Resource */}
      <Modal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        title="Khai báo Thiết bị / Tài sản Mới"
        subtitle="Đăng ký mã định danh và vị trí chức năng theo chuẩn PIM"
      >
        <form onSubmit={handleCreateResource} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Input
              label="Mã định danh (Code)"
              value={addForm.code}
              onChange={(e) => setAddForm({ ...addForm, code: e.target.value })}
              placeholder="VD: CNC-01 hoặc LINE-A"
              required
            />
            <Select
              label="Phân loại thiết bị"
              value={addForm.type_key}
              onChange={(e) => setAddForm({ ...addForm, type_key: e.target.value })}
              options={types.map((t) => ({ label: t.name || t.key, value: t.key }))}
            />
          </div>

          <Input
            label="Tên mô tả thiết bị"
            value={addForm.name}
            onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            placeholder="Máy phay CNC trục chính 1"
            required
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Select
              label="Trực thuộc khu vực (Site)"
              value={addForm.site_id}
              onChange={(e) => setAddForm({ ...addForm, site_id: e.target.value })}
              options={sites.map((s) => ({ label: `${s.name} (${s.code})`, value: s.id }))}
            />
            <Select
              label="Cấp cha (Parent)"
              value={addForm.parent_id || selectedParentId || ""}
              onChange={(e) => setAddForm({ ...addForm, parent_id: e.target.value })}
            >
              <option value="">(Cấp cao nhất)</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} - {r.name}
                </option>
              ))}
            </Select>
          </div>

          <Input
            label="Mô tả kỹ thuật bổ sung"
            value={addForm.description}
            onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
            placeholder="Thông số công suất, vị trí lắp đặt..."
          />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
            <Button variant="ghost" onClick={() => setIsAddOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" variant="primary">
              Xác nhận Lưu
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Import CSV */}
      <Modal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        title="Nạp Hàng Loạt Thiết Bị (CSV Import)"
        subtitle="Mỗi dòng gồm: Mã thiết bị, Tên thiết bị, Phân loại, Mã cấp cha"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
            Ví dụ mẫu:
            <br />
            <code>AA10-01, Máy Lắp Ráp 1, machine, Factory-1</code>
            <br />
            <code>AA10-02, Máy Lắp Ráp 2, machine, Factory-1</code>
          </p>
          <textarea
            rows={8}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Dán nội dung CSV vào đây..."
            style={{
              width: "100%",
              backgroundColor: "var(--bg-inset)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-medium)",
              borderRadius: "var(--radius-sm)",
              padding: "10px",
              fontFamily: "var(--font-mono)",
              fontSize: "12.5px",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
            <Button variant="ghost" onClick={() => setIsImportOpen(false)}>
              Hủy
            </Button>
            <Button variant="primary" loading={importing} onClick={handleImportCsv}>
              Tiến hành Nạp Dữ Liệu
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
