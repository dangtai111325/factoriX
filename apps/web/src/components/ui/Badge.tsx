import React from "react";

export type BadgeVariant =
  | "good"
  | "success"
  | "warning"
  | "bad"
  | "error"
  | "idle"
  | "stale"
  | "brand"
  | "primary"
  | "neutral";

export interface BadgeProps {
  variant?: BadgeVariant;
  dot?: boolean;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = "neutral",
  dot = false,
  pulse = false,
  children,
  className = "",
  style,
}) => {
  const getColors = () => {
    switch (variant) {
      case "good":
      case "success":
        return {
          bg: "var(--status-good-bg, rgba(16, 185, 129, 0.12))",
          text: "var(--status-good, #10b981)",
          border: "var(--status-good-border, rgba(16, 185, 129, 0.3))",
          dotColor: "var(--status-good, #10b981)",
        };
      case "warning":
        return {
          bg: "var(--status-warning-bg, rgba(245, 158, 11, 0.12))",
          text: "var(--status-warning, #f59e0b)",
          border: "var(--status-warning-border, rgba(245, 158, 11, 0.3))",
          dotColor: "var(--status-warning, #f59e0b)",
        };
      case "bad":
      case "error":
        return {
          bg: "var(--status-bad-bg, rgba(239, 68, 68, 0.12))",
          text: "var(--status-bad, #ef4444)",
          border: "var(--status-bad-border, rgba(239, 68, 68, 0.3))",
          dotColor: "var(--status-bad, #ef4444)",
        };
      case "idle":
        return {
          bg: "var(--status-idle-bg, rgba(59, 130, 246, 0.12))",
          text: "var(--status-idle, #3b82f6)",
          border: "var(--status-idle-border, rgba(59, 130, 246, 0.3))",
          dotColor: "var(--status-idle, #3b82f6)",
        };
      case "brand":
      case "primary":
        return {
          bg: "var(--brand-surface, rgba(229, 57, 53, 0.12))",
          text: "var(--brand-primary, #E53935)",
          border: "rgba(229, 57, 53, 0.3)",
          dotColor: "var(--brand-primary, #E53935)",
        };
      case "stale":
      case "neutral":
      default:
        return {
          bg: "var(--status-stale-bg, rgba(148, 163, 184, 0.12))",
          text: "var(--status-stale, #94a3b8)",
          border: "var(--status-stale-border, rgba(148, 163, 184, 0.25))",
          dotColor: "var(--status-stale, #94a3b8)",
        };
    }
  };

  const colors = getColors();

  return (
    <span
      className={`fx-badge ${className}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 8px",
        fontSize: "11.5px",
        fontWeight: 600,
        lineHeight: "1",
        borderRadius: "var(--radius-sm, 4px)",
        backgroundColor: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
        whiteSpace: "nowrap",
        userSelect: "none",
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: colors.dotColor,
            flexShrink: 0,
            animation: pulse ? "pulseDot 1.5s infinite" : "none",
          }}
        />
      )}
      {children}
    </span>
  );
};
