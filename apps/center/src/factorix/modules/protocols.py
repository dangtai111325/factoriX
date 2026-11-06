"""Protocol configuration schemas. Center stores them; only Edge opens sockets."""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import parse_qsl, urlparse, urlunparse

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


HTTP_MIN_INTERVAL_MS = 1000
HTTP_DEFAULT_RATE_LIMIT_PER_MIN = 60
WEBSOCKET_DEFAULT_INTERVAL_MS = 1000

# Header names that carry credentials. They must go through the encrypted secret (secret_input),
# never through plaintext config headers, and they are masked whenever a config is returned.
SENSITIVE_HEADERS = {"authorization", "proxy-authorization", "x-api-key", "api-key", "apikey", "x-auth-token", "cookie"}
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$")


def _check_headers(headers: dict[str, str], *, extra_sensitive: set[str] | None = None) -> None:
    sensitive = SENSITIVE_HEADERS | {name.lower() for name in (extra_sensitive or set())}
    for name, value in headers.items():
        if not _HEADER_NAME.match(name):
            raise AppError(422, "CONFIG", f'Invalid header name "{name}".', field_errors=[{"path": "headers", "code": "INVALID"}])
        if any(char in str(value) for char in ("\r", "\n")):
            raise AppError(422, "CONFIG", f'Header "{name}" contains a line break.', field_errors=[{"path": "headers", "code": "INVALID"}])
        if name.lower() in sensitive:
            raise AppError(
                422,
                "SECRET_IN_HEADERS",
                f'Header "{name}" carries a credential. Choose an authentication type and enter the credential as the secret; it is stored encrypted.',
                field_errors=[{"path": "headers", "code": "SECRET_IN_HEADERS"}],
            )


class HttpConfig(BaseModel):
    base_url: str
    path: str = "/"
    method: Literal["GET", "POST"] = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None
    auth: Literal["none", "api_key", "basic", "bearer"] = "none"
    header_name: str = Field(default="X-API-Key", min_length=1, max_length=128)
    username: str | None = Field(default=None, max_length=200)
    timeout_ms: int = Field(default=5000, ge=200, le=30000)
    rate_limit_per_min: int = Field(default=HTTP_DEFAULT_RATE_LIMIT_PER_MIN, ge=1, le=6000)
    query: dict[str, str] = Field(default_factory=dict)


class WebSocketConfig(BaseModel):
    url: str = Field(min_length=6, max_length=500)
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_ms: int = Field(default=5000, ge=200, le=30000)


_MODELS = {
    "modbus_tcp": ModbusConfig,
    "opcua": OpcUaConfig,
    "mqtt": MqttConfig,
    "http": HttpConfig,
    "websocket": WebSocketConfig,
}

_FROM_PUBLIC = {
    "modbus_tcp": "modbus_tcp",
    "opcua": "opcua",
    "opc_ua": "opcua",
    "mqtt": "mqtt",
    "mqtt_client": "mqtt",
    "http": "http",
    "http_pull": "http",
    "websocket": "websocket",
    "ws": "websocket",
}


def stored_protocol(protocol: str) -> str:
    """Stored protocol key for a public or stored protocol name."""
    return _FROM_PUBLIC.get(protocol, protocol)


def http_rate_warnings(*, interval_ms: int | None, path_count: int, rate_limit_per_min: int | None) -> list[str]:
    """Warn when the planned polling exceeds the source's request budget (requests per minute)."""
    interval = max(int(interval_ms or HTTP_MIN_INTERVAL_MS), 1)
    paths = max(int(path_count or 1), 1)
    limit = int(rate_limit_per_min or HTTP_DEFAULT_RATE_LIMIT_PER_MIN)
    planned = paths * 60_000 / interval
    if planned <= limit:
        return []
    needed = int(-(-paths * 60_000 // limit))
    return [
        f"{paths} request path(s) every {interval} ms is about {planned:.0f} requests per minute, above the limit of {limit}. "
        f"The edge will slow requests down to the limit; use an interval of at least {needed} ms to read every path on time."
    ]


def validate_interval(protocol: str, interval_ms: int | None) -> int | None:
    stored = stored_protocol(protocol)
    if interval_ms is None:
        return None
    interval = int(interval_ms)
    if stored == "http" and interval < HTTP_MIN_INTERVAL_MS:
        raise AppError(
            422,
            "INTERVAL",
            f"HTTP polling interval must be at least {HTTP_MIN_INTERVAL_MS} ms.",
            field_errors=[{"path": "interval_ms", "code": "MIN"}],
        )
    if interval < 200:
        raise AppError(422, "INTERVAL", "Interval must be at least 200 ms.", field_errors=[{"path": "interval_ms", "code": "MIN"}])
    if interval > 86_400_000:
        raise AppError(422, "INTERVAL", "Interval must be at most one day.", field_errors=[{"path": "interval_ms", "code": "MAX"}])
    return interval

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
        data.setdefault("auth", "none")
        if not data.get("header_name"):
            data.pop("header_name", None)
    elif stored == "websocket":
        if not data.get("url") and data.get("endpoint"):
            data["url"] = data.pop("endpoint")
        else:
            data.pop("endpoint", None)
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
    if protocol == "mqtt":
        for topic in data["topics"]:
            err = validate_mqtt_topic(topic)
            if err:
                raise AppError(422, "TOPIC", err)
        if data["anonymous"] is False and not data["username"]:
            raise AppError(422, "AUTH", "MQTT requires username or explicit anonymous.")
    if protocol == "http":
        base = urlparse(str(data["base_url"]))
        if base.scheme not in {"http", "https"} or not base.hostname:
            raise AppError(422, "CONFIG", "Enter a base URL that starts with http:// or https://.", field_errors=[{"path": "base_url", "code": "INVALID"}])
        if base.username or base.password:
            raise AppError(422, "CONFIG", "Do not put credentials in the URL; use the authentication fields.", field_errors=[{"path": "base_url", "code": "INVALID"}])
        data["base_url"] = str(data["base_url"]).rstrip("/")
        if any(char in data["path"] for char in (" ", "\n", "\r")):
            raise AppError(422, "CONFIG", "Invalid HTTP path.")
        _check_headers(data["headers"], extra_sensitive={data["header_name"]} if data["auth"] == "api_key" else None)
        if data["auth"] == "basic" and not data.get("username"):
            raise AppError(422, "AUTH", "Basic authentication needs a username.", field_errors=[{"path": "username", "code": "REQUIRED"}])
    if protocol == "websocket":
        ws_url = urlparse(str(data["url"]))
        if ws_url.scheme not in {"ws", "wss"} or not ws_url.hostname:
            raise AppError(422, "CONFIG", "Enter a WebSocket URL that starts with ws:// or wss://.", field_errors=[{"path": "url", "code": "INVALID"}])
        if ws_url.username or ws_url.password:
            raise AppError(422, "CONFIG", "Do not put credentials in the URL.", field_errors=[{"path": "url", "code": "INVALID"}])
        _check_headers(data["headers"])
    return data


MASK = "******"
_SECRET_KEYS = {"password", "secret", "token", "api_key", "secret_input", "client_secret"}


def mask_config(config: Any) -> Any:
    """Copy of a stored connection config that is safe to return to the console."""
    if not isinstance(config, dict):
        return config
    masked = dict(config)
    for key in _SECRET_KEYS:
        if masked.get(key):
            masked[key] = MASK
    headers = masked.get("headers")
    if isinstance(headers, dict):
        masked["headers"] = {
            name: (MASK if (name.lower() in SENSITIVE_HEADERS and value) else value) for name, value in headers.items()
        }
    return masked


def unmask_config(incoming: dict[str, Any], current: dict[str, Any] | None) -> dict[str, Any]:
    """Restore masked values the console sent back unchanged, so an edit never stores ``******``."""
    if not current:
        return dict(incoming)
    merged = dict(incoming)
    for key in _SECRET_KEYS:
        if merged.get(key) == MASK:
            if key in current:
                merged[key] = current[key]
            else:
                merged.pop(key)
    headers = merged.get("headers")
    old_headers = current.get("headers") if isinstance(current.get("headers"), dict) else {}
    if isinstance(headers, dict):
        merged["headers"] = {
            name: (old_headers.get(name, "") if value == MASK else value) for name, value in headers.items()
        }
    return merged


def redacted_endpoint(protocol: str, config: dict[str, Any]) -> str:
    if protocol == "modbus_tcp":
        return f"{config['host']}:{config['port']}"
    if protocol == "opcua":
        return str(config["endpoint"])
    if protocol == "mqtt":
        scheme = "mqtts" if config.get("tls") else "mqtt"
        return f"{scheme}://{config['host']}:{config['port']}"
    if protocol == "websocket":
        parsed = urlparse(str(config["url"]))
        netloc = parsed.hostname or ""
        if parsed.port:
            netloc = f"{netloc}:{parsed.port}"
        return urlunparse((parsed.scheme, netloc, parsed.path, "", "", ""))
    return f"{config['base_url']}{config['path']}"
