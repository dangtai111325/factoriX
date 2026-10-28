import React, { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { AuthStatus } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Card } from "../../components/ui/Card";
import { AlertTriangleIcon, CheckIcon } from "../../components/ui/Icons";

export const Bootstrap: React.FC = () => {
  const [formData, setFormData] = useState({
    login: "fxadmin",
    email: "admin@avenue-net.com",
    password: "",
    confirmPassword: "",
    bootstrap_token: "",
  });
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    async function loadStatus() {
      try {
        const res = await api.get<AuthStatus>("/api/v1/auth/status");
        setStatus(res);
        if (res.admin_exists) {
          navigate("/login", { replace: true });
        }
      } catch {
        // Ignore
      }
    }
    loadStatus();
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.login || !formData.email || !formData.password || !formData.confirmPassword) {
      setError("Vui lòng điền đầy đủ các thông tin bắt buộc.");
      return;
    }

    if (formData.password.length < 12) {
      setError("Mật khẩu phải có độ dài tối thiểu 12 ký tự.");
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError("Mật khẩu xác nhận không trùng khớp.");
      return;
    }

    setLoading(true);
    setError(null);

    const headers: Record<string, string> = {};
    if (formData.bootstrap_token) {
      headers["X-Bootstrap-Token"] = formData.bootstrap_token.trim();
    }

    try {
      await api.post(
        "/api/v1/auth/bootstrap",
        {
          login: formData.login.trim(),
          email: formData.email.trim(),
          password: formData.password,
          display_name: formData.login.trim() || "Quản trị viên",
          tenant_code: "primary",
          locale: "vi",
          timezone: "Asia/Ho_Chi_Minh",
        },
        headers
      );

      setSuccess(true);
      setTimeout(() => {
        navigate("/login");
      }, 1500);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message || "Khởi tạo hệ thống không thành công.");
      } else {
        setError("Lỗi kết nối máy chủ điều hành.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        width: "100vw",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--bg-ground)",
        padding: "32px 16px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "460px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
          <img
            src="/brand/avenue-logo.png"
            alt="Avenue Logo"
            style={{ height: "42px", objectFit: "contain" }}
            onError={(e) => {
              e.currentTarget.src = "/avenue-logo.png";
            }}
          />
          <h1 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>
            KHỞI TẠO HỆ THỐNG FACTORIX
          </h1>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Thiết lập tài khoản Quản trị viên cấp cao
          </p>
        </div>

        <Card style={{ padding: "28px" }}>
          {success ? (
            <div style={{ textAlign: "center", padding: "20px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "50%",
                  backgroundColor: "var(--status-good-bg)",
                  color: "var(--status-good)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CheckIcon size={28} />
              </div>
              <h3 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)" }}>
                Khởi tạo thành công!
              </h3>
              <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                Đang chuyển hướng về trang đăng nhập...
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {error && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px 14px",
                    backgroundColor: "var(--status-bad-bg)",
                    border: "1px solid var(--status-bad-border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--status-bad)",
                    fontSize: "12.5px",
                  }}
                >
                  <AlertTriangleIcon size={16} />
                  <span>{error}</span>
                </div>
              )}

              {status?.setup_code_required && (
                <Input
                  label="Mã kích hoạt khởi tạo (Bootstrap Token)"
                  name="bootstrap_token"
                  value={formData.bootstrap_token}
                  onChange={(e) => setFormData({ ...formData, bootstrap_token: e.target.value })}
                  placeholder="Nhập mã bí mật từ tệp cấu hình"
                  required
                />
              )}

              <Input
                label="Tên đăng nhập quản trị"
                name="login"
                value={formData.login}
                onChange={(e) => setFormData({ ...formData, login: e.target.value })}
                placeholder="fxadmin"
                required
              />

              <Input
                label="Email quản trị viên"
                name="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="admin@avenue-net.com"
                required
              />

              <Input
                label="Mật khẩu quản trị"
                name="password"
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="Tối thiểu 12 ký tự, gồm hoa, thường, số, ký tự đặc biệt"
                helperText="Mật khẩu tối thiểu 12 ký tự, kết hợp chữ hoa, chữ thường, số hoặc ký tự đặc biệt"
                required
              />

              <Input
                label="Xác nhận mật khẩu"
                name="confirmPassword"
                type="password"
                value={formData.confirmPassword}
                onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                placeholder="Nhập lại mật khẩu để xác nhận"
                required
              />

              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={loading}
                style={{ width: "100%", marginTop: "8px" }}
              >
                Kích hoạt Hệ thống & Tài khoản Quản trị
              </Button>
            </form>
          )}
        </Card>

        <div style={{ textAlign: "center" }}>
          <Link to="/login" style={{ fontSize: "12.5px", color: "var(--text-secondary)", textDecoration: "none" }}>
            Quay lại đăng nhập
          </Link>
        </div>
      </div>
    </div>
  );
};

export const BootstrapPage = Bootstrap;
