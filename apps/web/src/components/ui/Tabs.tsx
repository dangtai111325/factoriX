import React from "react";
export { ToastProvider, useToast } from "./Toast";
export type { ToastType, ToastMessage, ToastContextValue } from "./Toast";

export interface TabItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  items,
  activeId,
  onChange,
  className = "",
}) => {
  return (
    <div
      className={`fx-tabs ${className}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        borderBottom: "1px solid var(--border-subtle)",
        paddingBottom: "2px",
      }}
    >
      {items.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 16px",
              fontSize: "13.5px",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--brand-primary)" : "var(--text-secondary)",
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${isActive ? "var(--brand-primary)" : "transparent"}`,
              marginBottom: "-3px",
              cursor: "pointer",
              transition: "color var(--duration-fast), border-color var(--duration-fast)",
              outline: "none",
              userSelect: "none",
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            {tab.icon}
            {tab.label}
            {tab.badge && <span>{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
};
