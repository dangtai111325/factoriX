"""Protocol configuration schemas. Center stores them; only Edge opens sockets."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from factorix.platform.errors import AppError


class ModbusConfig(BaseModel):
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=502, ge=1, le=65535)
    unit_id: int = Field(default=1, ge=0, le=247)
    timeout_ms: int = Field(default=3000, ge=200, le=30000)
    retries: int = Field(default=1, ge=0, le=5)


class OpcUaConfig(BaseModel):
    endpoint: str = Field(min_length=8, max_length=500)
    security_mode: Literal["None", "Sign", "SignAndEncrypt"] = "SignAndEncrypt"
    security_policy: str = "Basic256Sha256"
    anonymous: bool = False
    username: str | None = None
    allow_insecure: bool = False


class MqttConfig(BaseModel):
    host: str
    port: int = Field(default=1883, ge=1, le=65535)
    protocol_version: Literal["3.1.1", "5"] = "3.1.1"
    tls: bool = False
    anonymous: bool = False
    username: str | None = None
    client_id: str | None = None
    topics: list[str] = Field(default_factory=list, max_length=64)
    qos: Literal[0, 1, 2] = 1


class HttpConfig(BaseModel):
    base_url: str
    path: str = "/"
    auth: Literal["none", "api_key", "basic", "bearer"] = "none"
    header_name: str | None = None
    timeout_ms: int = Field(default=5000, ge=200, le=30000)
    query: dict[str, str] = Field(default_factory=dict)


_MODELS = {
    "modbus_tcp": ModbusConfig,
    "opcua": OpcUaConfig,
    "mqtt": MqttConfig,
    "http": HttpConfig,
}


def parse_config(protocol: str, payload: dict[str, Any]) -> dict[str, Any]:
    model = _MODELS.get(protocol)
    if model is None:
        raise AppError(422, "PROTOCOL", "Giao thức không được hỗ trợ.")
    try:
        parsed = model.model_validate(payload)
    except ValidationError as exc:
        raise AppError(
            422,
            "CONFIG",
            "Cấu hình kết nối không hợp lệ.",
            field_errors=[{"path": ".".join(str(part) for part in error["loc"]), "code": "INVALID"} for error in exc.errors()],
        ) from exc
    data = parsed.model_dump()
    if protocol == "opcua":
        if not str(data["endpoint"]).startswith("opc.tcp://"):
            raise AppError(422, "CONFIG", "Endpoint OPC UA phải bắt đầu bằng opc.tcp://")
        if data["security_mode"] == "None" and not data["allow_insecure"]:
            raise AppError(422, "INSECURE_PROFILE", "Security None cần xác nhận allow_insecure.")
        if data["anonymous"] and data["security_mode"] == "SignAndEncrypt":
            pass
    if protocol == "mqtt":
        for topic in data["topics"]:
            if topic.startswith("$") or "#" in topic[:-1] or any(part == "" for part in topic.split("/")):
                raise AppError(422, "TOPIC", "Topic filter không hợp lệ.")
        if data["anonymous"] is False and not data["username"]:
            raise AppError(422, "AUTH", "MQTT cần username hoặc bật anonymous rõ ràng.")
    if protocol == "http":
        if not str(data["base_url"]).startswith(("http://", "https://")):
            raise AppError(422, "CONFIG", "HTTP base URL không hợp lệ.")
        if data["auth"] == "none" and str(data["base_url"]).startswith("https://") is False:
            # Cleartext without auth is allowed only when the operator explicitly set auth none.
            pass
        if any(char in data["path"] for char in (" ", "\n")):
            raise AppError(422, "CONFIG", "Đường dẫn HTTP không hợp lệ.")
    return data


def redacted_endpoint(protocol: str, config: dict[str, Any]) -> str:
    if protocol == "modbus_tcp":
        return f"{config['host']}:{config['port']}"
    if protocol == "opcua":
        return str(config["endpoint"])
    if protocol == "mqtt":
        scheme = "mqtts" if config.get("tls") else "mqtt"
        return f"{scheme}://{config['host']}:{config['port']}"
    return f"{config['base_url']}{config['path']}"
