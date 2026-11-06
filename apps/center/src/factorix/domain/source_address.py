"""Validation of a source-field address change (signal edit, R2-SG-03). Pure: no I/O.

An address patch is merged into the stored ``address_json`` of a bound signal. Keys set to
``None`` are removed (back to the default); every other key is validated for the connection's
protocol with the same rules the Add Data wizard and the edge apply. The merged address must
still be readable: a Modbus span must plan as one read, JSONPath expressions must compile and
NodeIds must be well formed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from factorix.domain.jsonpath import MappingError, compile_path
from factorix.domain.modbus_decode import NATIVE_TYPES, ModbusPlanError, SourceSpan, plan_reads, register_count_for

COMMON_KEYS = frozenset({"nullable", "round_digits"})
PROTOCOL_KEYS: dict[str, frozenset[str]] = {
    "modbus_tcp": frozenset({"unit_id", "register_area", "offset", "native_type", "register_count", "word_order", "role"}),
    "opcua": frozenset({"node_id", "timestamp_node_id"}),
    "mqtt": frozenset({"topic", "jsonpath", "timestamp_path", "qos"}),
    "http": frozenset({"method", "path", "jsonpath", "timestamp_path"}),
    "websocket": frozenset({"jsonpath", "timestamp_path"}),
}
REGISTER_AREAS = ("holding", "input", "coil", "discrete")
# Same rule as the wizard (bulk signal create): a numeric register type cannot feed a string signal.
NUMERIC_REGISTER_TYPES = frozenset({"uint16", "int16", "uint32", "int32", "float32", "float64"})
_NODE_ID = re.compile(r"^(?:(?:ns=\d+|nsu=[^;]+);)?[isgb]=.+$", re.S)
_MAX_TEXT = 1024


@dataclass
class AddressCheck:
    address: dict[str, Any]
    errors: list[dict[str, str]] = field(default_factory=list)
    native_type: str | None = None

    @property
    def ok(self) -> bool:
        return not self.errors

    def error(self, path: str, code: str, message: str) -> None:
        self.errors.append({"path": path, "code": code, "message": message})


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


def _jsonpath(check: AddressCheck, key: str, value: Any, *, allow_empty: bool) -> None:
    if not isinstance(value, str):
        check.error(key, "TYPE", f"{key} must be a JSONPath string.")
        return
    text = value.strip()
    if text == "" and allow_empty:
        check.address[key] = ""
        return
    if not text.startswith("$"):
        check.error(key, "INVALID_JSONPATH", f"{key} must start with $.")
        return
    try:
        compile_path(text)
    except MappingError as exc:
        check.error(key, "INVALID_JSONPATH", str(exc))
        return
    check.address[key] = text


def _node_id(check: AddressCheck, key: str, value: Any, *, optional: bool) -> None:
    if not isinstance(value, str) or not value.strip():
        if optional:
            check.address.pop(key, None)
            return
        check.error(key, "REQUIRED", "Enter the NodeId, for example ns=2;s=Device.Tag.")
        return
    text = value.strip()
    if len(text) > _MAX_TEXT or not _NODE_ID.fullmatch(text):
        check.error(key, "INVALID_NODE_ID", "NodeId must look like ns=2;s=Device.Tag or i=2258.")
        return
    check.address[key] = text


def validate_address_patch(
    protocol: str,
    current: dict[str, Any] | None,
    patch: dict[str, Any],
    *,
    data_type: str,
    topic_error: Any = None,
) -> AddressCheck:
    """Merge ``patch`` into ``current`` and validate the result for ``protocol``.

    ``topic_error`` is the MQTT topic validator (``protocols.validate_mqtt_topic``), passed in to
    keep this module free of the module layer.
    """
    check = AddressCheck(address=dict(current or {}))
    allowed = COMMON_KEYS | PROTOCOL_KEYS.get(protocol, frozenset())
    if protocol not in PROTOCOL_KEYS:
        check.error("protocol", "PROTOCOL", f"Protocol '{protocol}' has no editable source address.")
        return check
    if not isinstance(patch, dict) or not patch:
        check.error("address_patch", "REQUIRED", "Send at least one address field to change.")
        return check
    for key in patch:
        if key not in allowed:
            check.error(key, "UNKNOWN_FIELD", f"'{key}' is not an address field of {protocol}. Allowed: {', '.join(sorted(allowed))}.")
    if check.errors:
        return check

    for key, value in patch.items():
        if value is None:
            if key in {"node_id", "jsonpath", "topic", "path"}:
                check.error(key, "REQUIRED", f"{key} cannot be removed.")
            else:
                check.address.pop(key, None)
            continue
        if key == "nullable":
            if not isinstance(value, bool):
                check.error(key, "TYPE", "nullable must be true or false.")
            else:
                check.address[key] = value
        elif key == "round_digits":
            digits = _int(value)
            if digits is None or not 0 <= digits <= 10:
                check.error(key, "RANGE", "round_digits must be a whole number from 0 to 10.")
            else:
                check.address[key] = digits
        elif key == "unit_id":
            unit = _int(value)
            if unit is None or not 0 <= unit <= 247:
                check.error(key, "RANGE", "Unit ID must be between 0 and 247.")
            else:
                check.address[key] = unit
        elif key == "offset":
            offset = _int(value)
            if offset is None or not 0 <= offset <= 65535:
                check.error(key, "RANGE", "Offset must be a 0-based register number from 0 to 65535.")
            else:
                check.address[key] = offset
        elif key == "register_count":
            count = _int(value)
            if count is None or not 1 <= count <= 125:
                check.error(key, "RANGE", "register_count must be between 1 and 125.")
            else:
                check.address[key] = count
        elif key == "register_area":
            if str(value).lower() not in REGISTER_AREAS:
                check.error(key, "INVALID", "Register area must be holding, input, coil or discrete.")
            else:
                check.address[key] = str(value).lower()
        elif key == "word_order":
            if str(value).lower() not in {"big", "little"}:
                check.error(key, "INVALID", "Word order must be big or little.")
            else:
                check.address[key] = str(value).lower()
        elif key == "native_type":
            native = str(value).lower()
            if native not in NATIVE_TYPES:
                check.error(key, "INVALID", f"Native type must be one of {', '.join(sorted(NATIVE_TYPES))}.")
            else:
                check.address[key] = native
        elif key == "role":
            if value == "":
                check.address.pop(key, None)
            elif value != "source_timestamp":
                check.error(key, "INVALID", "role can only be source_timestamp.")
            else:
                check.address[key] = value
        elif key == "node_id":
            _node_id(check, key, value, optional=False)
        elif key == "timestamp_node_id":
            _node_id(check, key, value, optional=True)
        elif key == "jsonpath":
            _jsonpath(check, key, value, allow_empty=False)
        elif key == "timestamp_path":
            _jsonpath(check, key, value, allow_empty=True)  # "" disables the sibling source_timestamp rule
        elif key == "topic":
            text = str(value).strip()
            problem = topic_error(text) if topic_error is not None else (None if text else "Enter a topic.")
            if problem:
                check.error(key, "TOPIC", str(problem))
            else:
                check.address[key] = text
        elif key == "qos":
            qos = _int(value)
            if qos is None or not 0 <= qos <= 2:
                check.error(key, "RANGE", "QoS must be 0, 1 or 2.")
            else:
                check.address[key] = qos
        elif key == "method":
            method = str(value).upper()
            if method not in {"GET", "POST"}:
                check.error(key, "INVALID", "HTTP method must be GET or POST.")
            else:
                check.address[key] = method
        elif key == "path":
            text = str(value).strip()
            if not text or "://" in text or text.startswith("//") or len(text) > _MAX_TEXT:
                check.error(key, "INVALID", "Path must be relative to the base URL, for example /api/v1/status.")
            else:
                check.address[key] = text
    if check.errors:
        return check
    if protocol == "modbus_tcp":
        _check_modbus(check, data_type)
    return check


def _check_modbus(check: AddressCheck, data_type: str) -> None:
    address = check.address
    native = str(address.get("native_type") or "uint16").lower()
    area = str(address.get("register_area") or "holding").lower()
    try:
        count = 1 if area in {"coil", "discrete"} else register_count_for(native, address.get("register_count"))
        span = SourceSpan(
            field_id="check",
            area=area,  # type: ignore[arg-type]
            offset=int(address.get("offset") or 0),
            count=count,
            unit_id=int(address["unit_id"]) if address.get("unit_id") is not None else 1,
            poll_group="check",
            word_order=str(address.get("word_order") or "big").lower(),  # type: ignore[arg-type]
            native_type=native,
        )
        plan_reads([span])
    except ModbusPlanError as exc:
        check.error("address", exc.code, str(exc))
        return
    kind = data_type.lower()
    if kind == "string" and native in NUMERIC_REGISTER_TYPES:
        check.error("native_type", "TYPE", f"A {native} register cannot feed a text signal.")
    elif kind in {"int64", "float64", "bool", "boolean"} and native in {"ascii", "string"}:
        check.error("native_type", "TYPE", "An ASCII register cannot feed a numeric signal.")
    check.native_type = native
