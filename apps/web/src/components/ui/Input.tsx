import React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  icon?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  helperText,
  icon,
  className = "",
  style,
  id,
  ...props
}) => {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontSize: "12.5px",
            fontWeight: 500,
            color: error ? "var(--status-bad)" : "var(--text-secondary)",
          }}
        >
          {label}
        </label>
      )}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          width: "100%",
        }}
      >
        {icon && (
          <span
            style={{
              position: "absolute",
              left: "12px",
              display: "flex",
              alignItems: "center",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          >
            {icon}
          </span>
        )}
        <input
          id={inputId}
          className={`fx-input ${className}`}
          style={{
            width: "100%",
            height: "36px",
            padding: icon ? "0 12px 0 38px" : "0 12px",
            backgroundColor: "var(--bg-inset)",
            color: "var(--text-primary)",
            fontSize: "13.5px",
            fontFamily: "var(--font-sans)",
            border: `1px solid ${error ? "var(--status-bad)" : "var(--border-medium)"}`,
            borderRadius: "var(--radius-sm)",
            outline: "none",
            transition: "border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out)",
            ...style,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = error ? "var(--status-bad)" : "var(--brand-primary)";
            e.currentTarget.style.boxShadow = error
              ? "0 0 0 2px var(--status-bad-bg)"
              : "0 0 0 2px var(--brand-ring)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = error ? "var(--status-bad)" : "var(--border-medium)";
            e.currentTarget.style.boxShadow = "none";
          }}
          {...props}
        />
      </div>
      {error ? (
        <span style={{ fontSize: "12px", color: "var(--status-bad)" }}>{error}</span>
      ) : helperText ? (
        <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{helperText}</span>
      ) : null}
    </div>
  );
};

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  helperText?: string;
  options?: Array<{ label: string; value: string | number }>;
}

export const Select: React.FC<SelectProps> = ({
  label,
  error,
  helperText,
  options = [],
  children,
  className = "",
  style,
  id,
  ...props
}) => {
  const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
      {label && (
        <label
          htmlFor={selectId}
          style={{
            fontSize: "12.5px",
            fontWeight: 500,
            color: error ? "var(--status-bad)" : "var(--text-secondary)",
          }}
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`fx-select ${className}`}
        style={{
          width: "100%",
          height: "36px",
          padding: "0 12px",
          backgroundColor: "var(--bg-inset)",
          color: "var(--text-primary)",
          fontSize: "13.5px",
          fontFamily: "var(--font-sans)",
          border: `1px solid ${error ? "var(--status-bad)" : "var(--border-medium)"}`,
          borderRadius: "var(--radius-sm)",
          outline: "none",
          cursor: "pointer",
          ...style,
        }}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} style={{ background: "var(--bg-card)", color: "var(--text-primary)" }}>
            {opt.label}
          </option>
        ))}
        {children}
      </select>
      {error && <span style={{ fontSize: "12px", color: "var(--status-bad)" }}>{error}</span>}
      {!error && helperText && <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{helperText}</span>}
    </div>
  );
};
