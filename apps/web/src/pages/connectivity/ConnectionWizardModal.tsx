import React, { useState } from "react";
import { api } from "../../api/client";
import { Site, EdgeNode } from "../../api/types";
import { Modal } from "../../components/ui/Modal";
import { Input, Select } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Tabs";

export interface ConnectionWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  sites: Site[];
  edges: EdgeNode[];
  onCreated: () => void;
}

export const ConnectionWizardModal: React.FC<ConnectionWizardModalProps> = ({
  isOpen,
  onClose,
  sites,
  edges,
  onCreated,
}) => {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<string>("modbus_tcp");
  const [siteId, setSiteId] = useState<string>("");
  const [edgeId, setEdgeId] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Protocol specific configs
  const [modbusConfig, setModbusConfig] = useState({
    host: "192.168.1.100",
    port: 502,
    unit_id: 1,
    timeout_ms: 3000,
    retries: 1,
  });

  const [opcuaConfig, setOpcuaConfig] = useState({
    endpoint_url: "opc.tcp://192.168.1.100:4840",
    security_policy: "None",
    security_mode: "None",
  });

  const [mqttConfig, setMqttConfig] = useState({
    host: "192.168.1.100",
    port: 1883,
    client_id: "factorix-client-01",
    topic_filter: "factory/+/telemetry",
    qos: 1,
  });

  const [httpConfig, setHttpConfig] = useState({
    url: "http://192.168.1.100:8080/api/telemetry",
    method: "GET",
    interval_ms: 10000,
  });

  const { success, error } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      error("Vui lòng nhập tên kết nối.");
      return;
    }

    setLoading(true);

    let config: any = {};
    if (protocol === "modbus_tcp") config = modbusConfig;
    else if (protocol === "opc_ua") config = opcuaConfig;
    else if (protocol === "mqtt_client") config = mqttConfig;
    else if (protocol === "http_pull") config = httpConfig;

    try {
      await api.post("/api/v1/connections", {
        name: name.trim(),
        site_id: siteId || sites[0]?.id || null,
        edge_id: edgeId || edges[0]?.id || null,
        protocol,
        config,
        secret_input: null,
      });

      success(`Đã khởi tạo kết nối [${name}] thành công.`);
      onClose();
      onCreated();
    } catch (err: any) {
      error("Tạo kết nối thất bại: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Thiết Lập Kết Nối Nguồn Dữ Liệu OT Mới"
      subtitle="Khai báo thông số kết nối công nghiệp Modbus, OPC UA, MQTT hoặc HTTP"
      width="580px"
    >
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <Input
          label="Tên kết nối nguồn dữ liệu"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="VD: PLC Dây Chuyền Lắp Ráp 1"
          required
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <Select
            label="Giao thức công nghiệp"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
            options={[
              { label: "Modbus TCP (PLC / RTU)", value: "modbus_tcp" },
              { label: "OPC UA (SCADA / Server)", value: "opc_ua" },
              { label: "MQTT Client (Broker ngoài)", value: "mqtt_client" },
              { label: "HTTP Polling (REST API)", value: "http_pull" },
            ]}
          />

          <Select
            label="Khu vực Nhà máy (Site)"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
          >
            <option value="">(Mặc định khu vực đầu tiên)</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>

          <Select
            label="Trạm Edge thu thập"
            value={edgeId}
            onChange={(e) => setEdgeId(e.target.value)}
          >
            <option value="">(Chọn trạm Edge)</option>
            {edges.map((edge) => (
              <option key={edge.id} value={edge.id}>
                {edge.name} ({edge.health})
              </option>
            ))}
          </Select>
        </div>

        {/* Dynamic Protocol Fields */}
        <div
          style={{
            padding: "16px",
            backgroundColor: "var(--bg-inset)",
            border: "1px solid var(--border-medium)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>
            THÔNG SỐ CẤU HÌNH GIAO THỨC ({protocol.toUpperCase()})
          </span>

          {protocol === "modbus_tcp" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px" }}>
                <Input
                  label="Địa chỉ IP Máy chủ Modbus"
                  value={modbusConfig.host}
                  onChange={(e) => setModbusConfig({ ...modbusConfig, host: e.target.value })}
                  placeholder="192.168.1.100"
                  required
                />
                <Input
                  label="Cổng TCP"
                  type="number"
                  value={modbusConfig.port}
                  onChange={(e) => setModbusConfig({ ...modbusConfig, port: Number(e.target.value) })}
                  placeholder="502"
                  required
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <Input
                  label="Unit ID / Slave ID"
                  type="number"
                  value={modbusConfig.unit_id}
                  onChange={(e) => setModbusConfig({ ...modbusConfig, unit_id: Number(e.target.value) })}
                />
                <Input
                  label="Thời gian chờ (Timeout ms)"
                  type="number"
                  value={modbusConfig.timeout_ms}
                  onChange={(e) => setModbusConfig({ ...modbusConfig, timeout_ms: Number(e.target.value) })}
                />
              </div>
            </>
          )}

          {protocol === "opc_ua" && (
            <>
              <Input
                label="Đường dẫn OPC UA Endpoint"
                value={opcuaConfig.endpoint_url}
                onChange={(e) => setOpcuaConfig({ ...opcuaConfig, endpoint_url: e.target.value })}
                placeholder="opc.tcp://192.168.1.100:4840"
                required
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <Select
                  label="Chính sách bảo mật"
                  value={opcuaConfig.security_policy}
                  onChange={(e) => setOpcuaConfig({ ...opcuaConfig, security_policy: e.target.value })}
                  options={[
                    { label: "Không bảo mật (None)", value: "None" },
                    { label: "Basic256Sha256", value: "Basic256Sha256" },
                  ]}
                />
                <Select
                  label="Chế độ bảo mật"
                  value={opcuaConfig.security_mode}
                  onChange={(e) => setOpcuaConfig({ ...opcuaConfig, security_mode: e.target.value })}
                  options={[
                    { label: "None", value: "None" },
                    { label: "Sign & Encrypt", value: "SignAndEncrypt" },
                  ]}
                />
              </div>
            </>
          )}

          {protocol === "mqtt_client" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px" }}>
                <Input
                  label="Địa chỉ Broker MQTT"
                  value={mqttConfig.host}
                  onChange={(e) => setMqttConfig({ ...mqttConfig, host: e.target.value })}
                  placeholder="broker.hivemq.com"
                  required
                />
                <Input
                  label="Cổng TCP"
                  type="number"
                  value={mqttConfig.port}
                  onChange={(e) => setMqttConfig({ ...mqttConfig, port: Number(e.target.value) })}
                  placeholder="1883"
                  required
                />
              </div>
              <Input
                label="Topic Filter (Mẫu chủ đề cần subscribe)"
                value={mqttConfig.topic_filter}
                onChange={(e) => setMqttConfig({ ...mqttConfig, topic_filter: e.target.value })}
                placeholder="factory/+/sensors"
                required
              />
            </>
          )}

          {protocol === "http_pull" && (
            <>
              <Input
                label="Địa chỉ REST API"
                value={httpConfig.url}
                onChange={(e) => setHttpConfig({ ...httpConfig, url: e.target.value })}
                placeholder="http://192.168.1.100:8080/data"
                required
              />
              <Input
                label="Chu kỳ đọc định kỳ (ms)"
                type="number"
                value={httpConfig.interval_ms}
                onChange={(e) => setHttpConfig({ ...httpConfig, interval_ms: Number(e.target.value) })}
              />
            </>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
          <Button variant="ghost" onClick={onClose}>
            Hủy
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Tạo Kết Nối
          </Button>
        </div>
      </form>
    </Modal>
  );
};
