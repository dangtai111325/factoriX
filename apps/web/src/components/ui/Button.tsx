import React from "react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  style,
  ...props
}) => {
  const getStyles = (): React.CSSProperties => {
    let bg = "var(--bg-elevated)";
    let color = "var(--text-primary)";
    let border = "1px solid var(--border-medium)";
    let shadow = "var(--shadow-sm)";

    if (variant === "primary") {
      bg = "var(--brand-primary)";
      color = "#FFFFFF";
      border = "1px solid rgba(255, 255, 255, 0.2)";
      shadow = "0 2px 8px rgba(229, 57, 53, 0.35)";
    } else if (variant === "outline") {
      bg = "transparent";
      border = "1px solid var(--border-strong)";
    } else if (variant === "ghost") {
      bg = "transparent";
      border = "1px solid transparent";
      shadow = "none";
    } else if (variant === "danger") {
      bg = "var(--status-bad)";
      color = "#FFFFFF";
      border = "1px solid rgba(255, 255, 255, 0.2)";
      shadow = "0 2px 8px rgba(239, 68, 68, 0.35)";
    }

    const padding =
      size === "sm" ? "6px 12px" : size === "lg" ? "10px 20px" : "8px 16px";
    const height = size === "sm" ? "32px" : size === "lg" ? "42px" : "36px";
    const fontSize = size === "sm" ? "12px" : size === "lg" ? "15px" : "13.5px";

    return {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
      height,
      padding,
      fontSize,
      fontWeight: 500,
      fontFamily: "var(--font-sans)",
      borderRadius: "var(--radius-sm)",
      backgroundColor: bg,
      color,
      border,
      boxShadow: shadow,
      cursor: disabled || loading ? "not-allowed" : "pointer",
      opacity: disabled || loading ? 0.6 : 1,
      transition: "transform var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out)",
      userSelect: "none",
      textDecoration: "none",
      outline: "none",
      ...style,
    };
  };

  return (
    <button
      className={`fx-button ${className}`}
      disabled={disabled || loading}
      style={getStyles()}
      onMouseDown={(e) => {
        if (!disabled && !loading) {
          e.currentTarget.style.transform = "scale(0.97)";
        }
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = "none";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
      }}
      {...props}
    >
      {loading ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          style={{ animation: "spin 0.7s linear infinite" }}
        >
          <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
          <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
        </svg>
      ) : (
        icon
      )}
      {children}
    </button>
  );
};
