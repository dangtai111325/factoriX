import { useState, useEffect } from "react";
import { api, ApiError } from "../../api/client";
import type { CurrentUser } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { Tabs } from "../../components/ui/Tabs";
import { Icons } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/Toast";

interface AuditEvent {
  id: string;
  event_type: string;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  before_json?: any;
  after_json?: any;
  correlation_id?: string;
  occurred_at: string;
}

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<string>("account");
  const [user, setUser] = useState<CurrentUser | null>(null);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);

  // Audit events state
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [searchAudit, setSearchAudit] = useState("");

  const { addToast } = useToast();

  useEffect(() => {
    async function loadUser() {
      try {
        const u = await api.get<CurrentUser>("/api/v1/auth/me");
        setUser(u);
      } catch (err) {
        console.error(err);
      }
    }
    loadUser();
  }, []);

  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const res = await api.get<{ items: AuditEvent[] }>("/api/v1/audit-events?limit=150");
      setAuditEvents(res.items || []);
    } catch (err) {
      addToast("error", "Không thể tải nhật ký kiểm toán hệ thống.");
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "audit") {
      loadAudit();
    }
  }, [activeTab]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      addToast("error", "Mật khẩu mới phải có ít nhất 8 ký tự.");
      return;
    }
    if (newPassword !== confirmPassword) {
      addToast("error", "Xác nhận mật khẩu mới không trùng khớp.");
      return;
    }

    setPasswordLoading(true);
    try {
      await api.post("/api/v1/auth/password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      addToast("success", "Đã cập nhật mật khẩu mới thành công.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      addToast("error", err instanceof ApiError ? err.message : "Lỗi khi thay đổi mật khẩu.");
    } finally {
      setPasswordLoading(false);
    }
  };

  const filteredAudit = auditEvents.filter(
    (ev) =>
      ev.event_type.toLowerCase().includes(searchAudit.toLowerCase()) ||
      ev.entity_type.toLowerCase().includes(searchAudit.toLowerCase()) ||
      (ev.correlation_id && ev.correlation_id.toLowerCase().includes(searchAudit.toLowerCase()))
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header */}
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
              <Icons.Shield size={20} />
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
              Thiết Lập Hệ Thống & Nhật Ký Kiểm Toán
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
            Quản lý tài khoản điều hành, bảo mật phiên làm việc và tra cứu nhật ký kiểm toán (Audit Trail)
            tuân thủ tiêu chuẩn an ninh thông tin công nghiệp.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div>
        <Tabs
          items={[
            { id: "account", label: "Tài khoản & Bảo mật", icon: <Icons.User size={16} /> },
            { id: "audit", label: "Nhật ký kiểm toán (Audit Trail)", icon: <Icons.Shield size={16} /> },
          ]}
          activeId={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* Account & Security Tab */}
      {activeTab === "account" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
          {/* User Profile Card */}
          <Card style={{ padding: "24px" }}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "15px", fontWeight: 600, color: "var(--fx-text-primary)" }}>
              Thông Tin Phiên Đăng Nhập
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px", fontSize: "13px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--fx-border-subtle)", paddingBottom: "10px" }}>
                <span style={{ color: "var(--fx-text-muted)" }}>Tài khoản định danh:</span>
                <span style={{ fontWeight: 600, color: "var(--fx-text-primary)", fontFamily: "var(--fx-font-mono)" }}>
                  {user?.login || "—"}
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--fx-border-subtle)", paddingBottom: "10px" }}>
                <span style={{ color: "var(--fx-text-muted)" }}>Hộp thư (Email):</span>
                <span style={{ color: "var(--fx-text-primary)" }}>
                  {user?.email || "—"}
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--fx-border-subtle)", paddingBottom: "10px" }}>
                <span style={{ color: "var(--fx-text-muted)" }}>Vai trò phân quyền:</span>
                <Badge variant="primary">{user?.role || "Quản trị viên (Admin)"}</Badge>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--fx-text-muted)" }}>Mã đơn vị vận hành (Tenant):</span>
                <span style={{ fontFamily: "var(--fx-font-mono)", fontSize: "12px", color: "var(--fx-text-secondary)" }}>
                  {user?.tenant_id ? user.tenant_id.slice(0, 18) + "..." : "—"}
                </span>
              </div>
            </div>
          </Card>

          {/* Change Password Card */}
          <Card style={{ padding: "24px" }}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "15px", fontWeight: 600, color: "var(--fx-text-primary)" }}>
              Đổi Mật Khẩu Đăng Nhập
            </h3>

            <form onSubmit={handleChangePassword} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <Input
                label="Mật khẩu hiện tại"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Nhập mật khẩu đang dùng..."
              />

              <Input
                label="Mật khẩu mới"
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Tối thiểu 8 ký tự..."
                helperText="Nên kết hợp chữ cái, số và ký tự đặc biệt"
              />

              <Input
                label="Xác nhận mật khẩu mới"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Nhập lại mật khẩu mới..."
              />

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
                <Button type="submit" variant="primary" loading={passwordLoading}>
                  Lưu mật khẩu mới
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Audit Events Tab */}
      {activeTab === "audit" && (
        <Card style={{ overflow: "hidden" }}>
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--fx-border-subtle)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "16px",
            }}
          >
            <div style={{ width: "320px" }}>
              <Input
                placeholder="Lọc sự kiện hoặc mã tương quan..."
                value={searchAudit}
                onChange={(e) => setSearchAudit(e.target.value)}
              />
            </div>

            <Button
              variant="ghost"
              size="sm"
              icon={<Icons.RefreshCw size={14} />}
              onClick={loadAudit}
              loading={auditLoading}
            >
              Làm mới nhật ký
            </Button>
          </div>

          {auditLoading ? (
            <div style={{ padding: "36px", textAlign: "center", color: "var(--fx-text-muted)" }}>
              Đang tải nhật ký kiểm toán...
            </div>
          ) : filteredAudit.length === 0 ? (
            <div style={{ padding: "36px", textAlign: "center", color: "var(--fx-text-muted)" }}>
              Không có sự kiện kiểm toán nào phù hợp.
            </div>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: "560px" }}>
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
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                    }}
                  >
                    <th style={{ padding: "10px 16px" }}>Thời gian</th>
                    <th style={{ padding: "10px 16px" }}>Hành vi (Action)</th>
                    <th style={{ padding: "10px 16px" }}>Thực thể (Entity)</th>
                    <th style={{ padding: "10px 16px" }}>Tài khoản thực hiện</th>
                    <th style={{ padding: "10px 16px" }}>Mã tương quan (Trace)</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAudit.map((ev) => (
                    <tr
                      key={ev.id}
                      style={{
                        borderBottom: "1px solid var(--fx-border-subtle)",
                        transition: "background-color 0.15s ease",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--fx-bg-tertiary)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <td
                        style={{
                          padding: "10px 16px",
                          fontFamily: "var(--fx-font-mono)",
                          fontSize: "12px",
                          color: "var(--fx-text-secondary)",
                        }}
                      >
                        {new Date(ev.occurred_at).toLocaleString("vi-VN")}
                      </td>
                      <td style={{ padding: "10px 16px" }}>
                        <Badge
                          variant={
                            ev.event_type.includes("DELETE") || ev.event_type.includes("FAIL")
                              ? "error"
                              : ev.event_type.includes("UPDATE") || ev.event_type.includes("PATCH")
                              ? "warning"
                              : "neutral"
                          }
                        >
                          {ev.event_type}
                        </Badge>
                      </td>
                      <td style={{ padding: "10px 16px" }}>
                        <span style={{ fontWeight: 600, color: "var(--fx-text-primary)" }}>
                          {ev.entity_type}
                        </span>
                        {ev.entity_id && (
                          <span
                            style={{
                              marginLeft: "6px",
                              fontFamily: "var(--fx-font-mono)",
                              fontSize: "11px",
                              color: "var(--fx-text-muted)",
                            }}
                          >
                            ({ev.entity_id.slice(0, 8)}...)
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "10px 16px",
                          fontFamily: "var(--fx-font-mono)",
                          fontSize: "12px",
                          color: "var(--fx-text-secondary)",
                        }}
                      >
                        {ev.actor_id ? ev.actor_id.slice(0, 8) + "..." : "SYSTEM"}
                      </td>
                      <td
                        style={{
                          padding: "10px 16px",
                          fontFamily: "var(--fx-font-mono)",
                          fontSize: "11px",
                          color: "var(--fx-text-muted)",
                        }}
                      >
                        {ev.correlation_id || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
