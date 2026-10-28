import React from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { MachineStatusPill, TelemetryPulse } from "../../components/industrial";
import { TopologyIcon } from "../../components/ui/Icons";

export interface MachineNodeData {
  resourceId: string;
  code: string;
  name: string;
  status?: string;
  primarySignalValue?: any;
  primarySignalUnit?: string;
  primarySignalQuality?: any;
  updatedAt?: number | null;
  onSelect?: (resourceId: string) => void;
}

export const MachineNode: React.FC<NodeProps<any>> = ({ data, selected }) => {
  return (
    <div
      onClick={() => data.onSelect?.(data.resourceId)}
      style={{
        minWidth: "220px",
        backgroundColor: "var(--bg-card)",
        border: `1.5px solid ${selected ? "var(--brand-primary)" : "var(--border-medium)"}`,
        borderRadius: "var(--radius-md)",
        boxShadow: selected ? "var(--brand-glow)" : "var(--shadow-md)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        cursor: "pointer",
        transition: "border-color var(--duration-fast), box-shadow var(--duration-fast)",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: "var(--brand-primary)" }} />

      {/* Header: Code & Status */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div
            style={{
              width: "22px",
              height: "22px",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "var(--brand-surface)",
              color: "var(--brand-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <TopologyIcon size={13} />
          </div>
          <span className="tabular" style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
            {data.code || "MACHINE"}
          </span>
        </div>
        <MachineStatusPill status={data.status || "RUNNING"} />
      </div>

      {/* Machine Name */}
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {data.name || "Máy sản xuất"}
      </div>

      {/* Primary Telemetry Stream Widget */}
      {data.primarySignalValue !== undefined && (
        <div
          style={{
            padding: "6px 8px",
            backgroundColor: "var(--bg-inset)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-xs)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 500 }}>
            Tín hiệu chính
          </span>
          <TelemetryPulse
            value={data.primarySignalValue}
            unit={data.primarySignalUnit}
            quality={data.primarySignalQuality}
            updatedAt={data.updatedAt}
            size="sm"
          />
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: "var(--brand-primary)" }} />
    </div>
  );
};
