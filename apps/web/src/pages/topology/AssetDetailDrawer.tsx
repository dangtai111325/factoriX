import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { Resource, Signal, LatestSignalState } from "../../api/types";
import { Drawer } from "../../components/ui/Drawer";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { TelemetryPulse, QualityBadge } from "../../components/industrial";
import { useLiveSignal } from "../../api/stream";
import { HistorianIcon, PlusIcon } from "../../components/ui/Icons";

interface SignalLiveRowProps {
  signal: Signal;
}

const SignalLiveRow: React.FC<SignalLiveRowProps> = ({ signal }) => {
  const live = useLiveSignal(signal.id);
  const [initialState, setInitialState] = useState<LatestSignalState | null>(null);

  useEffect(() => {
    async function loadLatest() {
      try {
        const row = await api.get<LatestSignalState>(`/api/v1/signals/${signal.id}/latest`);
        setInitialState(row);
      } catch {
        // Ignore
      }
    }
    loadLatest();
  }, [signal.id]);

  const value = live.value !== undefined ? live.value : initialState?.value;
  const quality = live.quality || initialState?.quality;

  return (
    <div
      style={{
        padding: "10px 12px",
        backgroundColor: "var(--bg-inset)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span className="tabular" style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            {signal.key}
          </span>
          <QualityBadge quality={quality} />
        </div>
        <div style={{ fontSize: "11.5px", color: "var(--text-secondary)", marginTop: "2px" }}>
          {signal.display_name} · <span style={{ fontFamily: "var(--font-mono)" }}>{signal.data_type}</span>
        </div>
      </div>

      <div style={{ textAlign: "right" }}>
        <TelemetryPulse
          value={value}
          unit={signal.unit}
          quality={quality}
          updatedAt={live.updatedAt}
          size="sm"
        />
      </div>
    </div>
  );
};

export interface AssetDetailDrawerProps {
  resourceId: string | null;
  onClose: () => void;
  onRefresh?: () => void;
}

export const AssetDetailDrawer: React.FC<AssetDetailDrawerProps> = ({
  resourceId,
  onClose,
  onRefresh: _onRefresh,
}) => {
  const [resource, setResource] = useState<Resource | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!resourceId) {
      setResource(null);
      setSignals([]);
      return;
    }

    async function loadDetail() {
      setLoading(true);
      try {
        const res = await api.get<Resource>(`/api/v1/resources/${resourceId}`);
        setResource(res);

        const sigRes = await api.get<{ items: Signal[] }>(`/api/v1/signals?resource_id=${resourceId}`);
        setSignals(sigRes.items || []);
      } catch {
        // Ignore
      } finally {
        setLoading(false);
      }
    }

    loadDetail();
  }, [resourceId]);

  return (
    <Drawer
      isOpen={Boolean(resourceId)}
      onClose={onClose}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span className="tabular" style={{ fontWeight: 700 }}>
            {resource?.code || "TÀI SẢN"}
          </span>
          {resource?.type_key && <Badge variant="neutral">{resource.type_key.toUpperCase()}</Badge>}
        </div>
      }
      subtitle={resource?.name}
      footer={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Đóng
          </Button>
          <Link to={`/historian?resource=${resourceId}`}>
            <Button variant="primary" size="sm" icon={<HistorianIcon size={14} />}>
              Xem biểu đồ Historian
            </Button>
          </Link>
        </div>
      }
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: "13px" }}>
          Đang tải dữ liệu tài sản...
        </div>
      ) : resource ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Metadata Section */}
          <div
            style={{
              padding: "14px",
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "12px",
            }}
          >
            <div>
              <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase" }}>Mã định danh</span>
              <div className="tabular" style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>{resource.code}</div>
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase" }}>Phân loại</span>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>{resource.type_name || resource.type_key || "Máy"}</div>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase" }}>Tên thiết bị</span>
              <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{resource.name}</div>
            </div>
            {resource.description && (
              <div style={{ gridColumn: "span 2" }}>
                <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase" }}>Mô tả kỹ thuật</span>
                <div style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>{resource.description}</div>
              </div>
            )}
          </div>

          {/* Associated Signals Section */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
              <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                Tín hiệu Cảm biến Live ({signals.length})
              </span>
              <Link to={`/studio?tab=signals&resource=${resource.id}`}>
                <Button variant="ghost" size="sm" icon={<PlusIcon size={13} />}>
                  Khai báo thêm
                </Button>
              </Link>
            </div>

            {signals.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {signals.map((sig) => (
                  <SignalLiveRow key={sig.id} signal={sig} />
                ))}
              </div>
            ) : (
              <div
                style={{
                  padding: "24px",
                  textAlign: "center",
                  backgroundColor: "var(--bg-inset)",
                  border: "1px dashed var(--border-medium)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-muted)",
                  fontSize: "12.5px",
                }}
              >
                Chưa có tín hiệu hoặc cảm biến nào được gắn vào máy này.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
};
