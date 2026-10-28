import React from "react";
import { Link, useLocation } from "react-router-dom";
import {
  DashboardIcon,
  TopologyIcon,
  ConnectionIcon,
  StudioIcon,
  HistorianIcon,
  EdgeIcon,
  SettingsIcon,
  ActivityIcon,
  LayersIcon,
} from "../ui/Icons";

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const Sidebar: React.FC = () => {
  const location = useLocation();

  const groups: NavGroup[] = [
    {
      title: "VẬN HÀNH & GIÁM SÁT",
      items: [
        { id: "overview", label: "Tổng quan Nhà máy", path: "/overview", icon: <DashboardIcon size={17} /> },
        { id: "dashboards", label: "Bảng điều khiển", path: "/dashboards", icon: <ActivityIcon size={17} /> },
      ],
    },
    {
      title: "TÀI SẢN & MẶT BẰNG",
      items: [
        { id: "topology", label: "Tài sản & Mặt bằng 2D", path: "/topology", icon: <TopologyIcon size={17} /> },
        { id: "graph", label: "Đồ thị Quan hệ", path: "/graph", icon: <LayersIcon size={17} /> },
      ],
    },
    {
      title: "KẾT NỐI OT & EDGE",
      items: [
        { id: "connectivity", label: "Kết nối & Nghiệm thu", path: "/connectivity", icon: <ConnectionIcon size={17} /> },
        { id: "edge", label: "Cụm Edge Gateway", path: "/edge", icon: <EdgeIcon size={17} /> },
      ],
    },
    {
      title: "STUDIO DỮ LIỆU & LOGIC",
      items: [
        { id: "studio", label: "Studio Tín hiệu & UNS", path: "/studio", icon: <StudioIcon size={17} /> },
      ],
    },
    {
      title: "LƯU TRỮ & HỆ THỐNG",
      items: [
        { id: "historian", label: "Dữ liệu Lịch sử & CSV", path: "/historian", icon: <HistorianIcon size={17} /> },
        { id: "settings", label: "Thiết lập & Kiểm toán", path: "/settings", icon: <SettingsIcon size={17} /> },
      ],
    },
  ];

  return (
    <aside
      style={{
        width: "250px",
        height: "100%",
        backgroundColor: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        userSelect: "none",
        zIndex: 60,
      }}
    >
      {/* Brand Header */}
      <div
        style={{
          height: "64px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 20px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <img
          src="/brand/avenue-logo.png"
          alt="Avenue Logo"
          style={{ height: "30px", width: "auto", objectFit: "contain" }}
          onError={(e) => {
            e.currentTarget.src = "/avenue-logo.png";
          }}
        />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span
            style={{
              fontSize: "13.5px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: "var(--text-primary)",
              lineHeight: 1.1,
            }}
          >
            FACTORIX
          </span>
          <span
            style={{
              fontSize: "10.5px",
              fontWeight: 600,
              color: "var(--brand-primary)",
              letterSpacing: "0.08em",
            }}
          >
            INDUSTRIAL IOT
          </span>
        </div>
      </div>

      {/* Navigation Menu */}
      <nav
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
        }}
      >
        {groups.map((group) => (
          <div key={group.title} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span
              style={{
                fontSize: "10.5px",
                fontWeight: 600,
                color: "var(--text-muted)",
                letterSpacing: "0.06em",
                padding: "0 8px 4px 8px",
              }}
            >
              {group.title}
            </span>
            {group.items.map((item) => {
              const isActive = location.pathname.startsWith(item.path);
              return (
                <Link
                  key={item.id}
                  to={item.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px 12px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "13px",
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                    backgroundColor: isActive ? "var(--brand-surface)" : "transparent",
                    borderLeft: isActive ? "3px solid var(--brand-primary)" : "3px solid transparent",
                    textDecoration: "none",
                    transition: "all var(--duration-fast) var(--ease-out)",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "var(--bg-card-hover)";
                      e.currentTarget.style.color = "var(--text-primary)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "var(--text-secondary)";
                    }
                  }}
                >
                  <span style={{ color: isActive ? "var(--brand-primary)" : "var(--text-muted)" }}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer Info */}
      <div
        style={{
          padding: "12px 16px",
          borderTop: "1px solid var(--border-subtle)",
          fontSize: "11px",
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>Avenue Smart Suite</span>
        <span className="tabular">v1.0.0</span>
      </div>
    </aside>
  );
};
