import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Card } from "../../components/ui/Card";
import { AlertTriangleIcon, CheckIcon } from "../../components/ui/Icons";

export const ForgotPassword: React.FC = () => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await api.post("/api/v1/auth/forgot", { email: email.trim() });
      setSubmitted(true);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message || "Yêu cầu không thành công.");
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
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--bg-ground)",
        padding: "20px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "420px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
          <img
            src="/brand/avenue-logo.png"
            alt="Avenue Logo"
            style={{ height: "42px", objectFit: "contain" }}
            onError={(e) => {
              e.currentTarget.src = "/avenue-logo.png";
            }}
          />
          <h1 style={{ fontSize: "18px", fontWeight: 700, color: "var(--text-primary)" }}>
            KHÔI PHỤC MẬT KHẨU
          </h1>
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
            Nhập email đăng ký tài khoản kỹ thuật để nhận mã xác nhận
          </p>
        </div>

        <Card style={{ padding: "24px" }}>
          {submitted ? (
            <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: "14px" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "50%",
                  backgroundColor: "var(--status-good-bg)",
                  color: "var(--status-good)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto",
                }}
              >
                <CheckIcon size={24} />
              </div>
              <p style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: 1.5 }}>
                Nếu tài khoản tồn tại trong hệ thống, mã xác nhận 6 số đã được gửi tới hòm thư của bạn.
              </p>
              <Button
                variant="primary"
                onClick={() => navigate("/reset", { state: { email } })}
                style={{ width: "100%", marginTop: "8px" }}
              >
                Tiếp tục nhập Mã xác nhận
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {error && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px",
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
                label="Địa chỉ Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="kythuat@factory.com"
                required
              />

              <Button type="submit" variant="primary" size="lg" loading={loading} style={{ width: "100%" }}>
                Gửi mã xác minh
              </Button>
            </form>
          )}
        </Card>

        <div style={{ textAlign: "center" }}>
          <Link to="/login" style={{ fontSize: "12.5px", color: "var(--text-secondary)", textDecoration: "none" }}>
            Quay lại trang Đăng nhập
          </Link>
        </div>
      </div>
    </div>
  );
};

export const ResetPassword: React.FC = () => {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !code.trim() || !newPassword) return;

    setLoading(true);
    setError(null);

    try {
      await api.post("/api/v1/auth/reset", {
        email: email.trim(),
        code: code.trim(),
        new_password: newPassword,
      });

      setSuccess(true);
      setTimeout(() => {
        navigate("/login");
      }, 1500);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.message || "Mã xác nhận không đúng hoặc đã hết hạn.");
      } else {
        setError("Lỗi kết nối máy chủ.");
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
        padding: "20px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "420px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
          <img
            src="/brand/avenue-logo.png"
            alt="Avenue Logo"
            style={{ height: "42px", objectFit: "contain" }}
            onError={(e) => {
              e.currentTarget.src = "/avenue-logo.png";
            }}
          />
          <h1 style={{ fontSize: "18px", fontWeight: 700, color: "var(--text-primary)" }}>
            ĐẶT LẠI MẬT KHẨU
          </h1>
        </div>

        <Card style={{ padding: "24px" }}>
          {success ? (
            <div style={{ textAlign: "center", padding: "16px 0" }}>
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "50%",
                  backgroundColor: "var(--status-good-bg)",
                  color: "var(--status-good)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 12px",
                }}
              >
                <CheckIcon size={24} />
              </div>
              <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>
                Mật khẩu đã được cập nhật!
              </h3>
              <p style={{ fontSize: "12.5px", color: "var(--text-secondary)", marginTop: "4px" }}>
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
                    padding: "10px",
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
                label="Địa chỉ Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="kythuat@factory.com"
                required
              />

              <Input
                label="Mã xác nhận (6 số)"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                required
              />

              <Input
                label="Mật khẩu mới"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Tối thiểu 10 ký tự"
                required
              />

              <Button type="submit" variant="primary" size="lg" loading={loading} style={{ width: "100%" }}>
                Xác nhận đổi mật khẩu
              </Button>
            </form>
          )}
        </Card>

        <div style={{ textAlign: "center" }}>
          <Link to="/login" style={{ fontSize: "12.5px", color: "var(--text-secondary)", textDecoration: "none" }}>
            Quay lại trang Đăng nhập
          </Link>
        </div>
      </div>
    </div>
  );
};

export const ForgotPasswordPage = ForgotPassword;
