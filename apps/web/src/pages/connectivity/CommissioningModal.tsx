import React, { useEffect, useState } from "react";
import { api } from "../../api/client";
import { CommissioningJob } from "../../api/types";
import { Modal } from "../../components/ui/Modal";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { CheckIcon, AlertTriangleIcon } from "../../components/ui/Icons";

export interface CommissioningModalProps {
  jobId: string | null;
  onClose: () => void;
}

export const CommissioningModal: React.FC<CommissioningModalProps> = ({ jobId, onClose }) => {
  const [job, setJob] = useState<CommissioningJob | null>(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }

    let intervalId: any = null;

    async function pollJob() {
      try {
        const data = await api.get<CommissioningJob>(`/api/v1/commissioning/${jobId}`);
        setJob(data);

        if (data.status === "COMPLETED" || data.status === "FAILED") {
          clearInterval(intervalId);
        }
      } catch {
        // Ignore
      }
    }

    pollJob();
    intervalId = setInterval(pollJob, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [jobId]);

  if (!jobId) return null;

  const defaultStages = [
    {
      stage: "transport",
      name: "Giai đoạn 1: Bắt tay Mạng & Cổng (Network Transport)",
      desc: "Kiểm tra kết nối TCP socket, phân giải DNS, và cổng truyền thông công nghiệp",
    },
    {
      stage: "read_sample",
      name: "Giai đoạn 2: Đọc Dữ liệu Thô (Raw Read & Protocol Sample)",
      desc: "Gửi lệnh đọc thanh ghi Modbus, browse OPC UA NodeIds hoặc bắt gói tin MQTT mẫu",
    },
    {
      stage: "decode_quality",
      name: "Giai đoạn 3: Giải mã & Kiểm tra Chất lượng (Decode & Quality Check)",
      desc: "Áp dụng cấu hình Byte Order, tỉ lệ nhân Scale/Offset và xác thực nhãn chất lượng GOOD",
    },
  ];

  const getStageStatus = (stageKey: string) => {
    if (!job) return "PENDING";
    const match = job.stages_json?.find((s) => s.stage === stageKey);
    return match ? match.status : job.status === "COMPLETED" ? "PASSED" : "PENDING";
  };

  return (
    <Modal
      isOpen={Boolean(jobId)}
      onClose={onClose}
      title="Nghiệm Thu Kỹ Thuật Kết Nối OT (Live Commissioning Inspector)"
      subtitle={`Mã phiên kiểm thử: ${jobId}`}
      width="640px"
      footer={
        <Button variant="primary" onClick={onClose}>
          Hoàn tất Kiểm tra
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        {/* Status Header */}
        <div
          style={{
            padding: "16px",
            backgroundColor: "var(--bg-inset)",
            border: "1px solid var(--border-medium)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <span style={{ fontSize: "11.5px", color: "var(--text-muted)", textTransform: "uppercase" }}>
              Trạng thái nghiệm thu
            </span>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)", marginTop: "2px" }}>
              {job?.status === "COMPLETED"
                ? "Nghiệm thu thành công — Sẵn sàng sản xuất"
                : job?.status === "FAILED"
                ? "Nghiệm thu thất bại — Phát hiện bất thường"
                : "Đang tiến hành đo kiểm thời gian thực..."}
            </div>
          </div>
          <Badge
            variant={
              job?.status === "COMPLETED"
                ? "good"
                : job?.status === "FAILED"
                ? "bad"
                : "warning"
            }
            dot
            pulse={job?.status === "RUNNING"}
          >
            {job?.status || "ĐANG KHỞI TẠO"}
          </Badge>
        </div>

        {/* 3 Verification Stages */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {defaultStages.map((stage, idx) => {
            const status = getStageStatus(stage.stage);
            const isPassed = status === "PASSED";
            const isFailed = status === "FAILED";

            return (
              <div
                key={stage.stage}
                style={{
                  padding: "14px 16px",
                  backgroundColor: "var(--bg-card)",
                  border: `1px solid ${
                    isPassed
                      ? "var(--status-good-border)"
                      : isFailed
                      ? "var(--status-bad-border)"
                      : "var(--border-subtle)"
                  }`,
                  borderRadius: "var(--radius-sm)",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "14px",
                }}
              >
                <div
                  style={{
                    width: "28px",
                    height: "28px",
                    borderRadius: "50%",
                    backgroundColor: isPassed
                      ? "var(--status-good-bg)"
                      : isFailed
                      ? "var(--status-bad-bg)"
                      : "var(--bg-inset)",
                    color: isPassed
                      ? "var(--status-good)"
                      : isFailed
                      ? "var(--status-bad)"
                      : "var(--text-muted)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: "2px",
                    flexShrink: 0,
                  }}
                >
                  {isPassed ? (
                    <CheckIcon size={16} />
                  ) : isFailed ? (
                    <AlertTriangleIcon size={16} />
                  ) : (
                    <span className="tabular" style={{ fontSize: "12px", fontWeight: 700 }}>
                      {idx + 1}
                    </span>
                  )}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "13.5px", fontWeight: 600, color: "var(--text-primary)" }}>
                      {stage.name}
                    </span>
                    <Badge variant={isPassed ? "good" : isFailed ? "bad" : "neutral"}>
                      {isPassed ? "ĐẠT (PASSED)" : isFailed ? "KHÔNG ĐẠT" : "ĐANG CHỜ"}
                    </Badge>
                  </div>
                  <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
                    {stage.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Diagnostics & Error Redaction */}
        {job?.diagnostic && (
          <div
            style={{
              padding: "12px 14px",
              backgroundColor: "var(--bg-inset)",
              border: "1px solid var(--border-medium)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              color: job.status === "FAILED" ? "var(--status-bad)" : "var(--text-secondary)",
              whiteSpace: "pre-wrap",
            }}
          >
            {job.diagnostic}
          </div>
        )}
      </div>
    </Modal>
  );
};
