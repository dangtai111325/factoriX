"""Collector configuration request models and protocol capability constants. Moved verbatim from ``factorix.modules.collect`` (R2-E B6, move-only)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


CAPABILITIES = {
    "modbus_tcp": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "opcua": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": True, "can_write": False},
    "mqtt": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
    "http": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "websocket": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
}
SUBSCRIBE_PROTOCOLS = {"mqtt", "websocket"}
_SECRET_AUTH = {"api_key", "basic", "bearer"}


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    site_id: str
    edge_id: str | None = None
    protocol: str
    config: dict[str, Any]
    secret_input: str | None = None


class ConnectionPatch(BaseModel):
    version: int
    name: str | None = None
    config: dict[str, Any] | None = None
    secret_input: str | None = None


class JobIn(BaseModel):
    connection_id: str
    mode: str
    interval_ms: int | None = 1000
    timeout_ms: int = 3000
    enabled: bool = True


class SignalBulkItem(BaseModel):
    key: str
    name: str
    data_type: str
    unit: str | None = None
    expected_interval_ms: int | None = None
    source_field: dict[str, Any] | None = None


class SignalBulkIn(BaseModel):
    resource_id: str
    items: list[SignalBulkItem]
    atomic: bool = True


class SignalPatch(BaseModel):
    version: int
    display_name: str | None = None
    description: str | None = None
    unit: str | None = None
    expected_interval_ms: int | None = None
    enabled: bool | None = None
    connection_id: str | None = None
    # Source address change of a bound signal (R2-SG-03): merged into the current address_json;
    # a key set to null is removed. Validated per protocol; the signal id stays the same.
    address_patch: dict[str, Any] | None = None


class SignalAddressItem(BaseModel):
    signal_id: str
    version: int
    address_patch: dict[str, Any]


class SignalBulkAddressIn(BaseModel):
    items: list[SignalAddressItem]


class SignalPropertyItem(BaseModel):
    signal_id: str
    version: int


class SignalBulkPropertiesIn(BaseModel):
    """Properties set on every listed signal in one change (R4-SG-02). A property that is not sent
    is left unchanged; ``round_digits: null`` removes rounding, ``unit: ""`` clears the unit."""

    items: list[SignalPropertyItem]
    unit: str | None = None
    expected_interval_ms: int | None = None
    round_digits: int | None = None


class SignalBulkActionIn(BaseModel):
    signal_ids: list[str]
    action: str  # "enable" | "disable" | "delete"


class CaptureIn(BaseModel):
    topics: list[str] = Field(default_factory=list)
    topic_filter: str | None = None
    duration_seconds: int = 10
    max_messages: int = 100
    browse_node: str | None = None


class FormulaIn(BaseModel):
    signal_id: str | None = None
    resource_id: str | None = None
    key: str | None = None
    display_name: str | None = None
    expression: str
    aliases: dict[str, str]
    unit: str | None = None
    temporal_policy: dict[str, Any] = Field(default_factory=lambda: {"mode": "LATEST_WITH_MAX_AGE", "max_age_ms": 10000})

    @field_validator("temporal_policy", mode="before")
    @classmethod
    def _temporal_policy(cls, value: Any) -> Any:
        if value == "LATEST":
            return {"mode": "LATEST_WITH_MAX_AGE", "max_age_ms": 10000}
        if isinstance(value, str) and value:
            return {"mode": value}
        return value


class PreviewIn(BaseModel):
    expression: str
    values: dict[str, Any] = Field(default_factory=dict)
    qualities: dict[str, str] = Field(default_factory=dict)
    aliases: dict[str, str] = Field(default_factory=dict)


class MappingPreviewIn(BaseModel):
    expression: str
    document: Any
    cardinality: str = "REJECT_MULTI"
    missing: str = "NULL"
    samples: list[Any] = Field(default_factory=list)
