import React from "react";
export { Badge } from "./Badge";
export type { BadgeProps, BadgeVariant } from "./Badge";

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  hoverable?: boolean;
  elevation?: "flat" | "elevated" | "ground";
}

export const Card: React.FC<CardProps> = ({
  title,
  subtitle,
  action,
  hoverable = false,
  elevation = "ground",
  children,
  className = "",
  style,
  ...props
}) => {
  const getElevationStyle = () => {
    switch (elevation) {
      case "elevated":
        return {
          backgroundColor: "var(--bg-elevated, #161e2e)",
          boxShadow: "var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.3))",
          borderColor: "var(--border-medium, #2a364f)",
        };
      case "flat":
        return {
          backgroundColor: "var(--bg-card, #121824)",
          boxShadow: "none",
          borderColor: "var(--border-subtle, #1e293b)",
        };
      case "ground":
      default:
        return {
          backgroundColor: "var(--bg-card, #121824)",
          boxShadow: "var(--shadow-sm, 0 1px 2px 0 rgba(0, 0, 0, 0.2))",
          borderColor: "var(--border-subtle, #1e293b)",
        };
    }
  };

  const elev = getElevationStyle();

  return (
    <div
      className={`fx-card ${className}`}
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: elev.backgroundColor,
        border: `1px solid ${elev.borderColor}`,
        borderRadius: "var(--radius-md, 8px)",
        boxShadow: elev.boxShadow,
        overflow: "hidden",
        transition: hoverable
          ? "transform var(--duration-fast, 150ms) cubic-bezier(0.16, 1, 0.3, 1), border-color var(--duration-fast, 150ms) cubic-bezier(0.16, 1, 0.3, 1), box-shadow var(--duration-fast, 150ms) cubic-bezier(0.16, 1, 0.3, 1)"
          : undefined,
        ...style,
      }}
      onMouseEnter={(e) => {
        if (hoverable) {
          e.currentTarget.style.borderColor = "var(--border-medium, #2a364f)";
          e.currentTarget.style.transform = "translateY(-1px)";
          e.currentTarget.style.boxShadow = "var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.3))";
        }
      }}
      onMouseLeave={(e) => {
        if (hoverable) {
          e.currentTarget.style.borderColor = elev.borderColor;
          e.currentTarget.style.transform = "none";
          e.currentTarget.style.boxShadow = elev.boxShadow;
        }
      }}
      {...props}
    >
      {(title || action) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-subtle, #1e293b)",
          }}
        >
          <div>
            {typeof title === "string" ? (
              <h3
                style={{
                  margin: 0,
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "var(--text-primary, #ffffff)",
                  letterSpacing: "-0.01em",
                }}
              >
                {title}
              </h3>
            ) : (
              title
            )}
            {subtitle && (
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary, #94a3b8)",
                  marginTop: "2px",
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}

      {children}
    </div>
  );
};
