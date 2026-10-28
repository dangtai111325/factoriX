import React, { createContext, useContext, useState, useCallback } from "react";
import { CheckIcon, AlertTriangleIcon, XIcon } from "./Icons";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
}

export interface ToastContextValue {
  toast: (title: string, options?: { type?: ToastType; description?: string; duration?: number }) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  addToast: (type: ToastType, title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
  success: () => {},
  error: () => {},
  warning: () => {},
  addToast: () => {},
});

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (title: string, options: { type?: ToastType; description?: string; duration?: number } = {}) => {
      const id = "toast_" + Math.random().toString(36).substring(2, 9);
      const newToast: ToastMessage = {
        id,
        title,
        type: options.type || "info",
        description: options.description,
      };

      setToasts((prev) => [...prev, newToast]);

      setTimeout(() => {
        removeToast(id);
      }, options.duration || 4500);
    },
    [removeToast]
  );

  const value: ToastContextValue = {
    toast: showToast,
    success: (title, description) => showToast(title, { type: "success", description }),
    error: (title, description) => showToast(title, { type: "error", description }),
    warning: (title, description) => showToast(title, { type: "warning", description }),
    addToast: (type, title, description) => showToast(title, { type, description }),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              pointerEvents: "auto",
              minWidth: "300px",
              maxWidth: "420px",
              backgroundColor: "var(--bg-elevated, #161e2e)",
              border: "1px solid var(--border-medium, #2a364f)",
              borderLeft: `4px solid ${
                t.type === "success"
                  ? "var(--status-good, #10b981)"
                  : t.type === "error"
                  ? "var(--status-bad, #ef4444)"
                  : t.type === "warning"
                  ? "var(--status-warning, #f59e0b)"
                  : "var(--brand-primary, #E53935)"
              }`,
              borderRadius: "var(--radius-sm, 6px)",
              padding: "12px 16px",
              boxShadow: "var(--shadow-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.4))",
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
              animation: "toastSlide 200ms cubic-bezier(0.16, 1, 0.3, 1) forwards",
            }}
          >
            <style>{`
              @keyframes toastSlide {
                from { opacity: 0; transform: translateY(12px) scale(0.97); }
                to { opacity: 1; transform: translateY(0) scale(1); }
              }
            `}</style>
            <div style={{ marginTop: "1px" }}>
              {t.type === "success" && <CheckIcon size={18} style={{ color: "var(--status-good, #10b981)" }} />}
              {t.type === "error" && <AlertTriangleIcon size={18} style={{ color: "var(--status-bad, #ef4444)" }} />}
              {t.type === "warning" && <AlertTriangleIcon size={18} style={{ color: "var(--status-warning, #f59e0b)" }} />}
              {t.type === "info" && <CheckIcon size={18} style={{ color: "var(--brand-primary, #E53935)" }} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "13.5px", fontWeight: 600, color: "var(--text-primary, #ffffff)" }}>
                {t.title}
              </div>
              {t.description && (
                <div style={{ fontSize: "12px", color: "var(--text-secondary, #94a3b8)", marginTop: "2px" }}>
                  {t.description}
                </div>
              )}
            </div>
            <button
              onClick={() => removeToast(t.id)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-muted, #64748b)",
                cursor: "pointer",
                padding: "2px",
              }}
            >
              <XIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
