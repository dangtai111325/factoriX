import React, { useState } from "react";
import { useTheme } from "../../theme/ThemeContext";
import { useStreamStatus } from "../../api/stream";
import { Principal, Site } from "../../api/types";
import { SunIcon, MoonIcon, SearchIcon, UserIcon, LogOutIcon, ChevronDownIcon } from "../ui/Icons";
import { Badge } from "../ui/Badge";

export interface HeaderProps {
  user: Principal | null;
  sites: Site[];
  currentSiteId: string | null;
  onSelectSite: (siteId: string) => void;
  onOpenSearch: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  sites,
  currentSiteId,
  onSelectSite,
  onOpenSearch,
  onLogout,
}) => {
  const { theme, toggleTheme } = useTheme();
  const streamStatus = useStreamStatus();
  const [profileOpen, setProfileOpen] = useState(false);

  const currentSite = sites.find((s) => s.id === currentSiteId) || sites[0];

  return (
    <header
      style={{
        height: "56px",
        backgroundColor: "var(--bg-header)",
        borderBottom: "1px solid var(--border-subtle)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        gap: "16px",
        userSelect: "none",
        zIndex: 50,
      }}
    >
      {/* Left: Site Switcher & Status */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        {sites.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 500 }}>
              KHU VỰC:
            </span>
            <select
              value={currentSite?.id || ""}
              onChange={(e) => onSelectSite(e.target.value)}
              style={{
                backgroundColor: "var(--bg-inset)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-medium)",
                borderRadius: "var(--radius-sm)",
                padding: "4px 10px",
                fontSize: "13px",
                fontWeight: 600,
                outline: "none",
                cursor: "pointer",
              }}
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Real-time Stream Status */}
        <Badge
          variant={
            streamStatus === "connected"
              ? "good"
              : streamStatus === "connecting"
              ? "warning"
              : "bad"
          }
          dot
          pulse={streamStatus === "connected"}
        >
          {streamStatus === "connected"
            ? "OT STREAM: TRỰC TUYẾN"
            : streamStatus === "connecting"
            ? "ĐANG ĐỒNG BỘ..."
            : "STREAM: MẤT KẾT NỐI"}
        </Badge>
      </div>

      {/* Right: Quick Search, Theme Toggle, User Profile */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {/* Quick Search Shortcut */}
        <button
          onClick={onOpenSearch}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            backgroundColor: "var(--bg-inset)",
            border: "1px solid var(--border-medium)",
            borderRadius: "var(--radius-sm)",
            padding: "6px 12px",
            color: "var(--text-secondary)",
            fontSize: "12.5px",
            cursor: "pointer",
            transition: "border-color var(--duration-fast)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-medium)")}
        >
          <SearchIcon size={14} />
          <span>Tìm máy, tín hiệu...</span>
          <kbd
            style={{
              padding: "2px 6px",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-xs)",
              fontSize: "10.5px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Ctrl+K
          </kbd>
        </button>

        {/* Theme Switcher */}
        <button
          onClick={toggleTheme}
          title={`Chuyển sang ${theme === "dark" ? "Light Mode" : "Dark Mode"}`}
          aria-label="Đổi giao diện"
          style={{
            width: "36px",
            height: "36px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "var(--bg-elevated)",
            border: "1px solid var(--border-medium)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            transition: "transform var(--duration-fast), color var(--duration-fast)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
        >
          {theme === "dark" ? <SunIcon size={17} /> : <MoonIcon size={17} />}
        </button>

        {/* User Profile Dropdown */}
        {user && (
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setProfileOpen(!profileOpen)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                backgroundColor: "var(--bg-elevated)",
                border: "1px solid var(--border-medium)",
                borderRadius: "var(--radius-sm)",
                padding: "6px 12px",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: "22px",
                  height: "22px",
                  borderRadius: "50%",
                  backgroundColor: "var(--brand-surface)",
                  color: "var(--brand-primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <UserIcon size={13} />
              </div>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>{user.login}</span>
              <ChevronDownIcon size={14} style={{ color: "var(--text-muted)" }} />
            </button>

            {profileOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 100 }}
                  onClick={() => setProfileOpen(false)}
                />
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "42px",
                    width: "220px",
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border-medium)",
                    borderRadius: "var(--radius-sm)",
                    boxShadow: "var(--shadow-lg)",
                    zIndex: 101,
                    padding: "8px 0",
                    animation: "fadeIn 140ms var(--ease-out)",
                  }}
                >
                  <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                      {user.login}
                    </div>
                    <div style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
                      {user.email}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--brand-primary)", marginTop: "2px", fontWeight: 500 }}>
                      Quyền: {user.role.toUpperCase()}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      onLogout();
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "10px 16px",
                      background: "transparent",
                      border: "none",
                      color: "var(--status-bad)",
                      fontSize: "13px",
                      fontWeight: 500,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--status-bad-bg)")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <LogOutIcon size={16} />
                    <span>Đăng xuất hệ thống</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </header>
  );
};
