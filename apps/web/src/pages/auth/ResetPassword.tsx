import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Card } from "../../components/ui/Card";
import { Icons } from "../../components/ui/Icons";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError("Mã xác thực không hợp lệ hoặc đã hết hạn.");
      return;
    }
    if (password.length < 8) {
      setError("Mật khẩu mới phải có tối thiểu 8 ký tự.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Xác nhận mật khẩu mới không trùng khớp.");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/v1/auth/reset-password", {
        token,
        new_password: password,
      });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Không thể đặt lại mật khẩu. Vui lòng kiểm tra lại đường dẫn xác nhận.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--fx-bg-primary)",
        padding: "24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "420px" }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <img
            src="/brand/avenue-logo.png"
            alt="Avenue Logo"
            style={{ height: "48px", objectFit: "contain", marginBottom: "16px" }}
          />
          <h1
            style={{
              fontSize: "22px",
              fontWeight: 700,
              color: "var(--fx-text-primary)",
              letterSpacing: "-0.02em",
              margin: "0 0 6px 0",
            }}
          >
            Đặt Lại Mật Khẩu
          </h1>
          <p style={{ margin: 0, fontSize: "14px", color: "var(--fx-text-muted)" }}>
            Hệ thống Quản lý Vận hành FactoriX Industrial IoT
          </p>
        </div>

        <Card elevation="elevated" style={{ padding: "32px" }}>
          {success ? (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: "52px",
                  height: "52px",
                  borderRadius: "50%",
                  backgroundColor: "rgba(16, 185, 129, 0.12)",
                  color: "var(--fx-status-good)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 16px auto",
                }}
              >
                <Icons.Check size={28} />
              </div>
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "16px",
                  fontWeight: 600,
                  color: "var(--fx-text-primary)",
                }}
              >
                Cập nhật mật khẩu thành công
              </h3>
              <p
                style={{
                  margin: "0 0 24px 0",
                  fontSize: "13px",
                  color: "var(--fx-text-muted)",
                  lineHeight: 1.5,
                }}
              >
                Mật khẩu tài khoản của bạn đã được thay đổi an toàn. Bạn có thể đăng nhập ngay bằng mật khẩu mới.
              </p>
              <Link to="/login" style={{ textDecoration: "none" }}>
                <Button variant="primary" style={{ width: "100%" }}>
                  Đăng nhập hệ thống
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              {error && (
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(229, 57, 53, 0.1)",
                    border: "1px solid rgba(229, 57, 53, 0.25)",
                    color: "var(--fx-brand-red)",
                    fontSize: "13px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <Icons.AlertTriangle size={16} />
                  <span>{error}</span>
                </div>
              )}

              <Input
                label="Mật khẩu mới"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Tối thiểu 8 ký tự..."
                autoComplete="new-password"
                helperText="Bao gồm chữ số, chữ hoa và ký tự đặc biệt"
              />

              <Input
                label="Xác nhận mật khẩu mới"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Nhập lại mật khẩu..."
                autoComplete="new-password"
              />

              <Button
                type="submit"
                variant="primary"
                loading={loading}
                style={{ width: "100%", marginTop: "8px" }}
              >
                Lưu mật khẩu mới
              </Button>

              <div style={{ textAlign: "center", marginTop: "12px" }}>
                <Link
                  to="/login"
                  style={{
                    fontSize: "13px",
                    color: "var(--fx-text-secondary)",
                    textDecoration: "none",
                  }}
                >
                  Quay lại trang Đăng nhập
                </Link>
              </div>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
