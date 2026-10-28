import React, { useEffect, useState } from "react";
import { Badge } from "../ui/Badge";

export interface QualityBadgeProps {
  quality?: "GOOD" | "BAD" | "UNCERTAIN" | null;
  origin?: string;
  className?: string;
}

export const QualityBadge: React.FC<QualityBadgeProps> = ({ quality, origin, className = "" }) => {
  if (!quality) {
    return <Badge variant="stale" dot className={className}>CHƯA RÕ</Badge>;
  }

  const q = quality.toUpperCase();
  if (q === "GOOD") {
    return (
      <Badge variant="good" dot pulse className={className}>
        CHUẨN {origin ? `(${origin})` : ""}
      </Badge>
    );
  }
  if (q === "UNCERTAIN") {
    return (
      <Badge variant="warning" dot className={className}>
        NGHI NGỜ
      </Badge>
    );
  }
  return (
    <Badge variant="bad" dot className={className}>
      LỖI DỮ LIỆU
    </Badge>
  );
};

export interface TelemetryPulseProps {
  value: any;
  unit?: string | null;
  quality?: "GOOD" | "BAD" | "UNCERTAIN" | null;
  label?: string;
  updatedAt?: number | null;
  size?: "sm" | "md" | "lg";
}

export const TelemetryPulse: React.FC<TelemetryPulseProps> = ({
  value,
  unit,
  quality,
  label,
  updatedAt,
  size = "md",
}) => {
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (updatedAt) {
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), 300);
      return () => clearTimeout(timer);
    }
  }, [updatedAt, value]);

  const formatValue = (val: any) => {
    if (val === null || val === undefined) return "--";
    if (typeof val === "number") {
      return Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2);
    }
    if (typeof val === "boolean") {
      return val ? "BẬT (ON)" : "TẮT (OFF)";
    }
    return String(val);
  };

  const getFontSize = () => {
    switch (size) {
      case "sm":
        return { val: "16px", unit: "11px" };
      case "lg":
        return { val: "28px", unit: "14px" };
      case "md":
      default:
        return { val: "20px", unit: "12px" };
    }
  };

  const font = getFontSize();

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: "2px",
        transition: "background-color 200ms ease",
        borderRadius: "var(--radius-xs)",
        padding: "2px 6px",
        backgroundColor: flashing ? "var(--brand-surface)" : "transparent",
      }}
    >
      {label && (
        <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--text-muted)", textTransform: "uppercase" }}>
          {label}
        </span>
      )}
      <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
        <span
          className="tabular"
          style={{
            fontSize: font.val,
            fontWeight: 700,
            color: quality === "BAD" ? "var(--status-bad)" : "var(--text-primary)",
            lineHeight: 1.1,
          }}
        >
          {formatValue(value)}
        </span>
        {unit && (
          <span style={{ fontSize: font.unit, fontWeight: 500, color: "var(--text-secondary)" }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
};

export interface MachineStatusPillProps {
  status: "RUNNING" | "STOPPED" | "WARNING" | "ERROR" | "IDLE" | string;
  className?: string;
}

export const MachineStatusPill: React.FC<MachineStatusPillProps> = ({ status, className = "" }) => {
  const s = (status || "").toUpperCase();

  if (s === "RUNNING" || s === "ACTIVE" || s === "ONLINE") {
    return (
      <Badge variant="good" dot pulse className={className}>
        ĐANG HOẠT ĐỘNG
      </Badge>
    );
  }
  if (s === "WARNING" || s === "DEGRADED") {
    return (
      <Badge variant="warning" dot className={className}>
        CẢNH BÁO
      </Badge>
    );
  }
  if (s === "ERROR" || s === "FAILED") {
    return (
      <Badge variant="bad" dot className={className}>
        SỰ CỐ
      </Badge>
    );
  }
  if (s === "IDLE" || s === "STANDBY") {
    return (
      <Badge variant="idle" dot className={className}>
        CHỜ LỆNH
      </Badge>
    );
  }
  return (
    <Badge variant="stale" dot className={className}>
      TẠM DỪNG
    </Badge>
  );
};

export interface TrendSparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}

export const TrendSparkline: React.FC<TrendSparklineProps> = ({
  data = [],
  color = "var(--brand-primary)",
  width = 90,
  height = 24,
}) => {
  if (data.length < 2) {
    return <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>--</span>;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data
    .map((val, idx) => {
      const x = (idx / (data.length - 1)) * (width - 4) + 2;
      const y = height - 3 - ((val - min) / range) * (height - 6);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
};
