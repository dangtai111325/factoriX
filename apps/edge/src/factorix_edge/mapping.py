"""Field projection shared by every protocol: JSONPath mapping, the sibling
``source_timestamp`` rule, and value coercion to the signal data type."""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from typing import Any

from factorix.domain.jsonpath import MappingError, apply_cardinality, compile_path, evaluate, evaluate_nodes
from factorix_edge.timeutil import normalize_time

logger = logging.getLogger(__name__)

SOURCE_TIMESTAMP_KEY = "source_timestamp"


@dataclass(slots=True)
class Sample:
    """One acquired field value before it is bound to a signal."""

    field_id: str
    value: Any
    quality: str = "GOOD"
    source_time: str | None = None
    reason: str | None = None
    received_time: str | None = None


def field_address(field: dict[str, Any]) -> dict[str, Any]:
    """Snapshot rows carry ``address_json``; commissioning commands carry ``address``."""
    address = field.get("address_json")
    if not isinstance(address, dict) or not address:
        address = field.get("address")
    return address if isinstance(address, dict) else {}


def field_key(field: dict[str, Any]) -> str:
    return str(field.get("key") or field.get("name") or field.get("id") or "")


def jsonpath_of(field: dict[str, Any]) -> str:
    address = field_address(field)
    return str(address.get("jsonpath") or field.get("jsonpath") or "$")


def source_time_for(address: dict[str, Any], decode: dict[str, Any], document: Any, parent: Any) -> tuple[str | None, str | None]:
    """Return ``(source_time, reason)`` for one JSON field.

    Rule: the ``source_timestamp`` key of the object that contains the field. An explicit
    ``address.timestamp_path`` overrides it; ``address.timestamp_path == ""`` disables it.
    """
    if "timestamp_path" in address:
        override = address.get("timestamp_path")
    else:
        override = decode.get("timestamp_path") if decode.get("timestamp_path") else None
    raw: Any = None
    if override is not None:
        path = str(override)
        if not path:
            return None, None
        try:
            matches = evaluate(path, document)
        except MappingError:
            return None, "SOURCE_TIME_INVALID"
        raw = matches[0] if matches else None
    elif isinstance(parent, dict):
        raw = parent.get(SOURCE_TIMESTAMP_KEY)
    elif parent is None and isinstance(document, dict):
        # The field is the document root itself.
        raw = document.get(SOURCE_TIMESTAMP_KEY)
    if raw is None:
        return None, None
    try:
        return normalize_time(raw), None
    except (TypeError, ValueError, OverflowError):
        return None, "SOURCE_TIME_INVALID"


def project_json(fields: list[dict[str, Any]], document: Any, received_time: str | None, *, missing: str = "SKIP") -> list[Sample]:
    """Map each field's JSONPath on one document.

    Missing paths follow ``address.missing`` (``SKIP`` emits nothing, ``BAD`` emits a BAD
    sample). Invalid paths and multi-matches are configuration errors and are BAD.
    """
    rows: list[Sample] = []
    for field in fields:
        sample = project_field(field, document, received_time, missing=missing)
        if sample is not None:
            rows.append(sample)
    return rows


def project_field(field: dict[str, Any], document: Any, received_time: str | None, *, missing: str = "SKIP") -> Sample | None:
    address = field_address(field)
    decode = field.get("decode_json") if isinstance(field.get("decode_json"), dict) else {}
    field_id = str(field.get("id") or field_key(field))
    expression = jsonpath_of(field)
    missing_strategy = str(address.get("missing") or missing).upper()
    try:
        nodes = evaluate_nodes(expression, document)
        mapped = apply_cardinality([value for value, _ in nodes], cardinality="REJECT_MULTI", missing="BAD")
    except MappingError as exc:
        return Sample(field_id, None, "BAD", None, exc.code, received_time)
    if mapped.quality_override == "BAD" or not mapped.present:
        if missing_strategy == "BAD":
            return Sample(field_id, None, "BAD", None, "FIELD_MISSING", received_time)
        return None
    parent = nodes[0][1]
    source_time, reason = source_time_for(address, decode or {}, document, parent)
    value = mapped.value
    tokens = compile_path(expression)
    if tokens and tokens[-1].kind == "key" and tokens[-1].key == SOURCE_TIMESTAMP_KEY:
        # A field bound to the group timestamp itself: emit the normalised string.
        try:
            value = normalize_time(value) if value is not None else None
        except (TypeError, ValueError, OverflowError):
            reason = "SOURCE_TIME_INVALID"
    return Sample(field_id, value, "GOOD", source_time, reason, received_time)


def _round(value: float, digits: Any) -> float:
    try:
        places = int(digits)
    except (TypeError, ValueError):
        return value
    if places < 0 or places > 15:
        return value
    return round(value, places)


def coerce(data_type: str, value: Any, quality: str, address: dict[str, Any] | None = None) -> tuple[Any, str, str | None]:
    """Coerce a raw value to the signal data type.

    Returns ``(value, quality, reason)``. A null from a successful read is GOOD when the
    field is ``nullable``; otherwise it is BAD ``NULL_VALUE``. ``round_digits`` rounds
    numeric values.
    """
    address = address or {}
    if quality not in {"GOOD", "UNCERTAIN"}:
        return None, "BAD", None
    if value is None:
        if bool(address.get("nullable")):
            return None, quality, None
        return None, "BAD", "NULL_VALUE"
    round_digits = address.get("round_digits")
    if data_type == "bool":
        if isinstance(value, bool):
            return value, quality, None
        if isinstance(value, (int, float)) and value in (0, 1):
            return bool(value), quality, None
        return None, "BAD", "TYPE_MISMATCH"
    if data_type == "int64":
        if isinstance(value, bool):
            return None, "BAD", "TYPE_MISMATCH"
        if isinstance(value, int):
            return value, quality, None
        if isinstance(value, float) and math.isfinite(value):
            if round_digits is not None:
                value = _round(value, 0)
            if value.is_integer():
                return int(value), quality, None
        return None, "BAD", "TYPE_MISMATCH"
    if data_type == "float64":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, "BAD", "TYPE_MISMATCH"
        number = float(value)
        if not math.isfinite(number):
            return None, "BAD", "NON_FINITE"
        if round_digits is not None:
            number = _round(number, round_digits)
        return number, quality, None
    if data_type in {"string", "enum"}:
        if isinstance(value, str):
            return value, quality, None
        if isinstance(value, (dict, list, bool)):
            return json.dumps(value, separators=(",", ":")), quality, None
        if isinstance(value, float) and round_digits is not None:
            value = _round(value, round_digits)
        return str(value), quality, None
    return value, quality, None
