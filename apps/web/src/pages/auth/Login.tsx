import React, { useEffect, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { AuthStatus } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Card } from "../../components/ui/Card";
import { LockIcon, UserIcon, AlertTriangleIcon } from "../../components/ui/Icons";

export const Login: React.FC = () => {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    async function checkStatus() {
      try {
        const status = await api.get<AuthStatus>("/api/v1/auth/status");
        setAuthStatus(status);
        if (!status.admin_exists && status.bootstrap_enabled) {
          navigate("/bootstrap", { replace: true });
        }
      } catch {
        // Ignore
      }
    }
    checkStatus();
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!login.trim() || !password) {
      setError("Vui lòng nhập tên đăng nhập và mật khẩu.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await api.post("/api/v1/auth/login", {
        login: login.trim(),
        password,
      });

      const destination = (location.state as any)?.from?.pathname || "/overview";
      navigate(destination, { replace: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError("Tên đăng nhập hoặc mật khẩu không chính xác.");
        } else if (err.status === 429) {
          setError(`Quá nhiều lần thử thất bại. Vui lòng thử lại sau ${err.retryAfterSeconds || 60} giây.`);
        } else {
          setError(err.message || "Đăng nhập không thành công.");
        }
      } else {
        setError("Không thể kết nối đến máy chủ điều hành.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--bg-ground)",
        backgroundImage: "radial-gradient(ellipse at 50% 20%, rgba(229, 57, 53, 0.08) 0%, transparent 60%)",
        padding: "20px",
        overflow: "auto",
      }}
    >
      <div style={{ width: "100%", maxWidth: "420px", display: "flex", flexDirection: "column", gap: "24px" }}>
        {/* Brand & Title */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "10px" }}>
          <img
            src="/brand/avenue-logo.png"
            alt="Avenue Logo"
            style={{ height: "46px", objectFit: "contain" }}
            onError={(e) => {
              e.currentTarget.src = "/avenue-logo.png";
            }}
          />
          <h1 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)", letterSpacing: "0.02em" }}>
            HỆ THỐNG FACTORIX IIOT
          </h1>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Nền tảng Giám sát & Thu thập Dữ liệu Công nghiệp Toàn diện
          </p>
        </div>

        {/* Login Box */}
        <Card style={{ padding: "28px 24px" }}>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
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

            <Input
              label="Tên đăng nhập hoặc Email"
              type="text"
              name="login"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="Nhập tài khoản kỹ thuật"
              autoFocus
              icon={<UserIcon size={16} />}
              required
            />

            <Input
              label="Mật khẩu"
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              icon={<LockIcon size={16} />}
              required
            />

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Link
                to="/forgot"
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--brand-primary)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
              >
                Quên mật khẩu?
              </Link>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              style={{ width: "100%", marginTop: "4px" }}
            >
              Đăng nhập Trung tâm Điều hành
            </Button>
          </form>
        </Card>

        {/* System Notice / First Run Link */}
        {authStatus?.bootstrap_enabled && !authStatus.admin_exists && (
          <div style={{ textAlign: "center", fontSize: "12.5px", color: "var(--text-secondary)" }}>
            Chưa có tài khoản quản trị?{" "}
            <Link to="/bootstrap" style={{ color: "var(--brand-primary)", fontWeight: 600 }}>
              Khởi tạo hệ thống lần đầu
            </Link>
          </div>
        )}

        <div style={{ textAlign: "center", fontSize: "11.5px", color: "var(--text-muted)" }}>
          Được bảo mật theo tiêu chuẩn vận hành công nghiệp Avenue BMS / OT
        </div>
      </div>
    </div>
  );
};

export const LoginPage = Login;
