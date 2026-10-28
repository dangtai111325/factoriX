import React, { useEffect, useState } from "react";
import { useNavigate, useLocation, Outlet } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { Principal, Site } from "../../api/types";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";

export const Shell: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<Principal | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [currentSiteId, setCurrentSiteId] = useState<string | null>(() => {
    return localStorage.getItem("fx_active_site");
  });
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let mounted = true;

    async function initShell() {
      try {
        const principal = await api.get<Principal>("/api/v1/auth/me");
        if (!mounted) return;
        setUser(principal);

        const sitesRes = await api.get<{ items: Site[] }>("/api/v1/sites");
        if (!mounted) return;
        const siteList = sitesRes.items || [];
        setSites(siteList);

        if (siteList.length > 0) {
          const stored = localStorage.getItem("fx_active_site");
          const exists = siteList.some((s) => s.id === stored);
          if (exists && stored) {
            setCurrentSiteId(stored);
          } else {
            setCurrentSiteId(siteList[0].id);
            localStorage.setItem("fx_active_site", siteList[0].id);
          }
        }
      } catch (err) {
        if (!mounted) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate("/login", { replace: true, state: { from: location } });
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    initShell();

    return () => {
      mounted = false;
    };
  }, [navigate, location.pathname]);

  const handleSelectSite = (siteId: string) => {
    setCurrentSiteId(siteId);
    localStorage.setItem("fx_active_site", siteId);
  };

  const handleLogout = async () => {
    try {
      await api.post("/api/v1/auth/logout");
    } catch {
      // Ignore
    } finally {
      setUser(null);
      navigate("/login", { replace: true });
    }
  };

  if (loading) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "var(--bg-ground, #0a0e17)",
          gap: "16px",
        }}
      >
        <img
          src="/brand/avenue-logo.png"
          alt="Avenue Logo"
          style={{ height: "48px", objectFit: "contain" }}
          onError={(e) => {
            e.currentTarget.src = "/avenue-logo.png";
          }}
        />
        <div style={{ fontSize: "13px", color: "var(--text-secondary, #94a3b8)", fontWeight: 500 }}>
          Đang khởi tạo không gian điều hành công nghiệp...
        </div>
      </div>
    );
  }

  const isEdgeToEdge = location.pathname.startsWith("/topology");

  return (
    <div
      style={{
        display: "flex",
        width: "100vw",
        height: "100vh",
        backgroundColor: "var(--bg-ground, #0a0e17)",
        color: "var(--text-primary, #ffffff)",
        overflow: "hidden",
      }}
    >
      <Sidebar />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
        }}
      >
        <Header
          user={user}
          sites={sites}
          currentSiteId={currentSiteId}
          onSelectSite={handleSelectSite}
          onOpenSearch={() => setSearchOpen(true)}
          onLogout={handleLogout}
        />

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            position: "relative",
            backgroundColor: "var(--bg-ground, #0a0e17)",
            padding: isEdgeToEdge ? "0" : "24px 28px",
          }}
        >
          {children || <Outlet />}
        </main>
      </div>

      <CommandPalette isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
};
