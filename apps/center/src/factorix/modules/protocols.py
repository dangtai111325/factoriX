"""Protocol configuration schemas. Center stores them; only Edge opens sockets."""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import parse_qsl, urlparse

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
    keepalive: int = Field(default=60, ge=5, le=3600)
    clean_session: bool = True
    tls: bool = False
    tls_verify: bool = True
    ca_secret_ref: str | None = None
    anonymous: bool = True
    username: str | None = None
    client_id: str | None = None
    topics: list[str] = Field(default_factory=list, max_length=64)
    qos: Literal[0, 1, 2] = 1


class HttpConfig(BaseModel):
    base_url: str
    path: str = "/"
    method: Literal["GET", "POST"] = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None
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

_FROM_PUBLIC = {
    "modbus_tcp": "modbus_tcp",
    "opcua": "opcua",
    "opc_ua": "opcua",
    "mqtt": "mqtt",
    "mqtt_client": "mqtt",
    "http": "http",
    "http_pull": "http",
}

_TO_PUBLIC = {"opcua": "opc_ua", "mqtt": "mqtt_client", "http": "http_pull"}


def public_protocol(protocol: str) -> str:
    return _TO_PUBLIC.get(protocol, protocol)


def validate_mqtt_topic(topic: str) -> str | None:
    if not topic:
        return "Enter a topic filter."
    if topic.startswith("/"):
        return 'Topics should not start with "/".'
    if topic.startswith("$"):
        return 'Topics starting with "$" are reserved by the broker.'
    parts = topic.split("/")
    if any(p == "" for p in parts):
        return "Topic levels cannot be empty."
    for i, p in enumerate(parts):
        if "#" in p and (p != "#" or i != len(parts) - 1):
            return '"#" must be the last level on its own.'
        if "+" in p and p != "+":
            return '"+" must take a whole level.'
    if len(topic.encode("utf-8")) > 65535:
        return "Topic is too long."
    return None


def assert_valid_topic(topic: str) -> None:
    err = validate_mqtt_topic(topic)
    if err:
        raise AppError(422, "TOPIC", err)


def accept_connection(protocol: str, payload: dict[str, Any]) -> tuple[str, dict[str, Any], int | None]:
    """Translate the console's protocol names and field names into the stored contract."""
    stored = _FROM_PUBLIC.get(protocol, protocol)
    data = dict(payload)
    interval: int | None = None
    if data.get("interval_ms") is not None:
        interval = int(data.pop("interval_ms"))
    if stored == "opcua":
        if not data.get("endpoint") and data.get("endpoint_url"):
            data["endpoint"] = data.pop("endpoint_url")
        else:
            data.pop("endpoint_url", None)
        if data.get("security_mode") == "None":
            data["allow_insecure"] = True
        if not data.get("username"):
            data["anonymous"] = True
    elif stored == "mqtt":
        if data.get("protocol_version") == "5.0":
            data["protocol_version"] = "5"
        topic = data.pop("topic_filter", None)
        if topic and not data.get("topics"):
            data["topics"] = [str(topic)]
        if not data.get("username"):
            data["anonymous"] = True
    elif stored == "http":
        url = str(data.pop("url", "") or "")
        if url and not data.get("base_url"):
            parsed = urlparse(url)
            data["base_url"] = f"{parsed.scheme}://{parsed.netloc}"
            data["path"] = parsed.path or "/"
            if parsed.query:
                data["query"] = dict(parse_qsl(parsed.query))
        if data.get("interval_ms") is not None:
            interval = int(data.pop("interval_ms"))
        data.setdefault("auth", "none")
    return stored, data, interval


def parse_config(protocol: str, payload: dict[str, Any]) -> dict[str, Any]:
    model = _MODELS.get(protocol)
    if model is None:
        raise AppError(422, "PROTOCOL", "Unsupported protocol.")
    try:
        parsed = model.model_validate(payload)
    except ValidationError as exc:
        raise AppError(
            422,
            "CONFIG",
            "Invalid connection configuration.",
            field_errors=[{"path": ".".join(str(part) for part in error["loc"]), "code": "INVALID"} for error in exc.errors()],
        ) from exc
    data = parsed.model_dump()
    if protocol == "opcua":
        if not str(data["endpoint"]).startswith("opc.tcp://"):
            raise AppError(422, "CONFIG", "The endpoint must start with opc.tcp://")
        if data["security_mode"] == "None" and not data["allow_insecure"]:
            raise AppError(422, "INSECURE_PROFILE", "Security None requires explicit allow_insecure.")
        if data["anonymous"] and data["security_mode"] == "SignAndEncrypt":
            pass
    if protocol == "mqtt":
        for topic in data["topics"]:
            err = validate_mqtt_topic(topic)
            if err:
                raise AppError(422, "TOPIC", err)
        if data["anonymous"] is False and not data["username"]:
            raise AppError(422, "AUTH", "MQTT requires username or explicit anonymous.")
    if protocol == "http":
        if not str(data["base_url"]).startswith(("http://", "https://")):
            raise AppError(422, "CONFIG", "Invalid HTTP base URL.")
        if any(char in data["path"] for char in (" ", "\n")):
            raise AppError(422, "CONFIG", "Invalid HTTP path.")
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
