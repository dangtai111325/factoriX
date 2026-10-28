import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { SearchResult } from "../../api/types";
import { SearchIcon, XIcon, TopologyIcon, ConnectionIcon, StudioIcon } from "../ui/Icons";

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult>({
    resources: [],
    connections: [],
    signals: [],
  });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (isOpen) onClose();
        else onClose(); // parent handles toggle
      }
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setResults({ resources: [], connections: [], signals: [] });
      return;
    }

    if (!query.trim()) {
      setResults({ resources: [], connections: [], signals: [] });
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.get<SearchResult>(`/api/v1/search?q=${encodeURIComponent(query.trim())}`);
        setResults(data);
      } catch {
        // Ignore
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query, isOpen]);

  if (!isOpen) return null;

  const totalResults =
    results.resources.length + results.connections.length + results.signals.length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "600px",
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-medium)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-modal)",
          overflow: "hidden",
          animation: "modalEnter 160ms var(--ease-out) forwards",
        }}
      >
        {/* Search Input Bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border-subtle)",
            gap: "12px",
          }}
        >
          <SearchIcon size={18} style={{ color: "var(--brand-primary)" }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm kiếm máy móc, tài sản, kết nối OT, hoặc tín hiệu..."
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              color: "var(--text-primary)",
              fontSize: "15px",
              outline: "none",
              fontFamily: "var(--font-sans)",
            }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer" }}
            >
              <XIcon size={16} />
            </button>
          )}
          <kbd
            style={{
              padding: "2px 6px",
              backgroundColor: "var(--bg-inset)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-xs)",
              fontSize: "11px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div style={{ maxHeight: "360px", overflowY: "auto", padding: "8px 0" }}>
          {loading && (
            <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
              Đang tìm kiếm dữ liệu...
            </div>
          )}

          {!loading && query && totalResults === 0 && (
            <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
              Không tìm thấy kết quả nào phù hợp với "{query}".
            </div>
          )}

          {!loading && !query && (
            <div style={{ padding: "16px 20px", color: "var(--text-muted)", fontSize: "12.5px" }}>
              Gõ mã máy (vd: AA10), tên tín hiệu (vd: temp), hoặc tên kết nối để tra cứu nhanh.
            </div>
          )}

          {/* Resources */}
          {results.resources.length > 0 && (
            <div>
              <div style={{ padding: "6px 16px", fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}>
                TÀI SẢN & MÁY MÓC ({results.resources.length})
              </div>
              {results.resources.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    onClose();
                    navigate(`/topology?resource=${item.id}`);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    padding: "10px 16px",
                    cursor: "pointer",
                    fontSize: "13.5px",
                    color: "var(--text-primary)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-card-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  <TopologyIcon size={16} style={{ color: "var(--brand-primary)" }} />
                  <span style={{ fontWeight: 600 }}>{item.code}</span>
                  <span style={{ color: "var(--text-secondary)" }}>— {item.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Connections */}
          {results.connections.length > 0 && (
            <div>
              <div style={{ padding: "6px 16px", fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}>
                KẾT NỐI OT ({results.connections.length})
              </div>
              {results.connections.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    onClose();
                    navigate(`/connectivity?conn=${item.id}`);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    padding: "10px 16px",
                    cursor: "pointer",
                    fontSize: "13.5px",
                    color: "var(--text-primary)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-card-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  <ConnectionIcon size={16} style={{ color: "var(--status-good)" }} />
                  <span style={{ fontWeight: 600 }}>{item.name}</span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>({item.protocol.toUpperCase()})</span>
                </div>
              ))}
            </div>
          )}

          {/* Signals */}
          {results.signals.length > 0 && (
            <div>
              <div style={{ padding: "6px 16px", fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}>
                TÍN HIỆU CÔNG NGHIỆP ({results.signals.length})
              </div>
              {results.signals.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    onClose();
                    navigate(`/studio?tab=signals&signal=${item.id}`);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    padding: "10px 16px",
                    cursor: "pointer",
                    fontSize: "13.5px",
                    color: "var(--text-primary)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-card-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  <StudioIcon size={16} style={{ color: "var(--status-warning)" }} />
                  <span className="tabular" style={{ fontWeight: 600 }}>{item.key}</span>
                  <span style={{ color: "var(--text-secondary)" }}>— {item.display_name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
