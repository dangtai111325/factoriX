"""Versioned canonical telemetry event contract and SLI helpers.

Pure domain module — no framework, RabbitMQ, SQLAlchemy, or TDengine imports.
Every cross-service telemetry message emitted by Acquisition and consumed by Center/Ingestion
uses :class:`CanonicalObservation` (``schema_version = 1``).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping
from uuid import UUID

from factorix.domain.observation import (
    EDGE_CLOCK_FUTURE,
    MAX_EVENT_UID,
    MAX_JSON_DEPTH,
    MAX_STRING,
    Observation,
    ObservationError,
    resolve_times,
)
from factorix.domain.quality import Origin, Quality, ensure_utc

CANONICAL_SCHEMA_VERSION = 1
VALID_VALUE_TYPES = frozenset({"bool", "int64", "float64", "string", "enum", "json"})

_SENSITIVE_KEY_TOKENS = (
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "credential",
    "private_key",
    "ciphertext",
    "auth_header",
    "authorization",
    "dsn",
    "connection_string",
)
_URL_USERINFO_RE = re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://)([^/@\s]+):([^/@\s]+)@")
_FORBIDDEN_UID_CHARS = ("\n", "\r", "\x00")


def _redact_url_userinfo(text: str) -> str:
    return _URL_USERINFO_RE.sub(r"\1***:***@", text)


def redact_provenance_value(key: str, val: Any, *, depth: int = 0) -> Any:
    """Recursively scrub credentials, tokens, and URL userinfo from provenance metadata."""
    if depth > 8:
        return "[REDACTED_DEPTH]"
    lowered = key.lower()
    if any(tok in lowered for tok in _SENSITIVE_KEY_TOKENS):
        return "***REDACTED***"
    if isinstance(val, str):
        return _redact_url_userinfo(val)[:512]
    if isinstance(val, Mapping):
        return {str(k): redact_provenance_value(str(k), v, depth=depth + 1) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return [redact_provenance_value(key, item, depth=depth + 1) for item in val[:64]]
    return val


def redact_provenance(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    if not raw:
        return {}
    return {str(k): redact_provenance_value(str(k), v, depth=0) for k, v in raw.items()}


def normalize_value_type(raw: str | None) -> str:
    val = str(raw or "float64").strip().lower()
    if val in {"boolean", "bool"}:
        return "bool"
    if val in {"int", "int32", "int64", "integer", "uint16", "uint32", "int16"}:
        return "int64"
    if val in {"float", "float32", "float64", "double", "analog", "number"}:
        return "float64"
    if val in {"str", "string", "text"}:
        return "string"
    if val == "enum":
        return "enum"
    if val in {"json", "object", "array", "structured"}:
        return "json"
    return val


def _parse_utc(value: Any, *, field_name: str, allow_none: bool = False) -> datetime | None:
    if value is None or value == "":
        if allow_none:
            return None
        raise ObservationError("MISSING_TIMESTAMP", f"{field_name} is required.")
    if isinstance(value, datetime):
        return ensure_utc(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            if allow_none:
                return None
            raise ObservationError("MISSING_TIMESTAMP", f"{field_name} is empty.")
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00").replace("z", "+00:00"))
        except ValueError as exc:
            raise ObservationError("INVALID_TIMESTAMP", f"{field_name} must be ISO-8601 UTC: {text}") from exc
        return ensure_utc(parsed)
    raise ObservationError("INVALID_TIMESTAMP", f"{field_name} must be datetime or ISO-8601 string.")


def _fmt_utc_us(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    moment = ensure_utc(dt)
    return moment.isoformat().replace("+00:00", "Z")


def _parse_uuid(value: Any, *, field_name: str, allow_none: bool = False) -> UUID | None:
    if value is None or value == "":
        if allow_none:
            return None
        raise ObservationError("MISSING_ID", f"{field_name} is required.")
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise ObservationError("INVALID_ID", f"{field_name} must be a valid UUID.") from exc


def _validate_typed_value(value_type: str, value: Any) -> Any:
    if value_type not in VALID_VALUE_TYPES:
        raise ObservationError("INVALID_TYPE", f"Unsupported value_type '{value_type}'.")
    if value is None:
        return None
    if value_type == "bool":
        if not isinstance(value, bool):
            raise ObservationError("INVALID_VALUE", "bool signal requires bool value.")
        return value
    if value_type == "int64":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ObservationError("INVALID_VALUE", "int64 signal requires integer value.")
        if value < -(2**63) or value > (2**63 - 1):
            raise ObservationError("INVALID_VALUE", "int64 out of range.")
        return value
    if value_type == "float64":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ObservationError("INVALID_VALUE", "float64 signal requires numeric value.")
        flt = float(value)
        if not math.isfinite(flt):
            raise ObservationError("NON_FINITE", "float64 cannot be NaN or Infinity.")
        return flt
    if value_type in {"string", "enum"}:
        if not isinstance(value, str):
            raise ObservationError("INVALID_VALUE", f"{value_type} signal requires string value.")
        if len(value) > MAX_STRING:
            raise ObservationError("VALUE_TOO_LARGE", f"{value_type} exceeds {MAX_STRING} characters.")
        return value
    if value_type == "json":
        _check_json_bounds(value, 0)
        return value
    return value


def _check_json_bounds(value: Any, depth: int) -> None:
    if depth > MAX_JSON_DEPTH:
        raise ObservationError("JSON_TOO_DEEP", "JSON payload exceeds maximum nesting depth.")
    if isinstance(value, float) and not math.isfinite(value):
        raise ObservationError("NON_FINITE", "JSON payload contains non-finite float.")
    if isinstance(value, dict):
        if len(value) > 256:
            raise ObservationError("JSON_TOO_WIDE", "JSON object exceeds 256 keys.")
        for k, v in value.items():
            if not isinstance(k, str):
                raise ObservationError("INVALID_JSON", "JSON object keys must be strings.")
            _check_json_bounds(v, depth + 1)
    elif isinstance(value, list):
        if len(value) > 512:
            raise ObservationError("JSON_TOO_WIDE", "JSON array exceeds 512 elements.")
        for item in value:
            _check_json_bounds(item, depth + 1)


def derive_event_uid(
    *,
    tenant_id: UUID,
    connection_id: UUID | None,
    source_field_id: UUID | None,
    signal_id: UUID,
    acquired_at: datetime,
    sequence_or_key: str | int = 0,
    data_epoch: int = 1,
) -> str:
    """Create a deterministic, collision-resistant event UID suitable for idempotency."""
    ts_us = int(ensure_utc(acquired_at).timestamp() * 1_000_000)
    raw = (
        f"{CANONICAL_SCHEMA_VERSION}|{data_epoch}|{tenant_id}|{connection_id or '-'}|"
        f"{source_field_id or '-'}|{signal_id}|{ts_us}|{sequence_or_key}"
    )
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f"fx-{data_epoch}-{digest}"


@dataclass(frozen=True, slots=True)
class CanonicalProvenance:
    """Safe, credential-free source attribution attached to canonical events."""

    protocol: str = "unknown"
    connection_id: UUID | None = None
    job_id: UUID | None = None
    source_field_id: UUID | None = None
    config_revision: int = 1
    address_kind: str | None = None
    address_summary: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.config_revision < 1:
            raise ObservationError("INVALID_REVISION", "provenance.config_revision must be >= 1.")
        object.__setattr__(self, "protocol", str(self.protocol or "unknown")[:32])
        if self.address_summary is not None:
            object.__setattr__(self, "address_summary", _redact_url_userinfo(str(self.address_summary))[:256])
        object.__setattr__(self, "extra", redact_provenance(self.extra))

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "protocol": self.protocol,
            "connection_id": str(self.connection_id) if self.connection_id else None,
            "job_id": str(self.job_id) if self.job_id else None,
            "source_field_id": str(self.source_field_id) if self.source_field_id else None,
            "config_revision": int(self.config_revision),
        }
        if self.address_kind is not None:
            out["address_kind"] = self.address_kind
        if self.address_summary is not None:
            out["address_summary"] = self.address_summary
        if self.extra:
            out["extra"] = dict(self.extra)
        return out

    @classmethod
    def from_dict(cls, data: Mapping[str, Any] | None) -> "CanonicalProvenance | None":
        if not data:
            return None
        known = {"protocol", "connection_id", "job_id", "source_field_id", "config_revision", "address_kind", "address_summary", "extra"}
        merged_extra = dict(data.get("extra") or {}) if isinstance(data.get("extra"), Mapping) else {}
        for k, v in data.items():
            if k not in known:
                merged_extra[str(k)] = v
        return cls(
            protocol=str(data.get("protocol") or "unknown"),
            connection_id=_parse_uuid(data.get("connection_id"), field_name="provenance.connection_id", allow_none=True),
            job_id=_parse_uuid(data.get("job_id"), field_name="provenance.job_id", allow_none=True),
            source_field_id=_parse_uuid(data.get("source_field_id"), field_name="provenance.source_field_id", allow_none=True),
            config_revision=int(data.get("config_revision") or 1),
            address_kind=str(data["address_kind"])[:64] if data.get("address_kind") is not None else None,
            address_summary=str(data["address_summary"])[:256] if data.get("address_summary") is not None else None,
            extra=merged_extra,
        )


@dataclass(frozen=True, slots=True)
class LatencySLIs:
    """Measured end-to-end latency indicators for telemetry ingestion observability (§15.2)."""

    acquisition_to_ingest_ms: float | None
    ingest_to_commit_ms: float | None
    acquisition_to_commit_ms: float | None
    clock_skew_ms: float = 0.0


def measure_latency_slis(
    *,
    acquired_at: datetime,
    ingested_at: datetime | None = None,
    committed_at: datetime | None = None,
) -> LatencySLIs:
    acq = ensure_utc(acquired_at)
    acq_ing: float | None = None
    ing_com: float | None = None
    acq_com: float | None = None
    skew = 0.0
    if ingested_at is not None:
        ing = ensure_utc(ingested_at)
        raw = (ing - acq).total_seconds() * 1000.0
        if raw < 0:
            skew = raw
            raw = 0.0
        acq_ing = round(raw, 3)
    if ingested_at is not None and committed_at is not None:
        ing = ensure_utc(ingested_at)
        com = ensure_utc(committed_at)
        raw2 = max(0.0, (com - ing).total_seconds() * 1000.0)
        ing_com = round(raw2, 3)
    if committed_at is not None:
        com = ensure_utc(committed_at)
        raw3 = (com - acq).total_seconds() * 1000.0
        if raw3 < 0 and skew == 0.0:
            skew = raw3
        acq_com = round(max(0.0, raw3), 3)
    return LatencySLIs(
        acquisition_to_ingest_ms=acq_ing,
        ingest_to_commit_ms=ing_com,
        acquisition_to_commit_ms=acq_com,
        clock_skew_ms=round(skew, 3),
    )


@dataclass(frozen=True, slots=True)
class CanonicalObservation:
    """Authoritative v1 telemetry observation exchanged between Acquisition, RabbitMQ, Center, and TDengine."""

    event_uid: str
    tenant_id: UUID
    signal_id: UUID
    resource_id: UUID
    acquired_at: datetime
    value_type: str
    value: Any
    quality: Quality
    data_epoch: int = 1
    config_revision: int = 1
    schema_version: int = CANONICAL_SCHEMA_VERSION
    site_id: UUID | None = None
    connection_id: UUID | None = None
    acquisition_job_id: UUID | None = None
    source_field_id: UUID | None = None
    source_time: datetime | None = None
    ingested_at: datetime | None = None
    unit: str | None = None
    quality_reason: str | None = None
    origin: Origin = Origin.LIVE
    provenance: CanonicalProvenance | None = None
    correlation_id: str | None = None
    source_sequence: int | None = None
    keepalive: bool = False

    def __post_init__(self) -> None:
        if int(self.schema_version) != CANONICAL_SCHEMA_VERSION:
            raise ObservationError("UNSUPPORTED_SCHEMA_VERSION", f"Unsupported canonical schema_version={self.schema_version}.")
        if not self.event_uid or len(self.event_uid) > MAX_EVENT_UID:
            raise ObservationError("INVALID_EVENT_UID", "event_uid must be 1..256 chars.")
        if any(ch in self.event_uid for ch in _FORBIDDEN_UID_CHARS):
            raise ObservationError("INVALID_EVENT_UID", "event_uid contains invalid control characters.")
        if int(self.data_epoch) < 1:
            raise ObservationError("INVALID_EPOCH", "data_epoch must be >= 1.")
        if int(self.config_revision) < 1:
            raise ObservationError("INVALID_REVISION", "config_revision must be >= 1.")
        if self.source_sequence is not None and int(self.source_sequence) < 0:
            raise ObservationError("INVALID_SEQUENCE", "source_sequence must be >= 0.")

        object.__setattr__(self, "acquired_at", ensure_utc(self.acquired_at))
        if self.source_time is not None:
            object.__setattr__(self, "source_time", ensure_utc(self.source_time))
        if self.ingested_at is not None:
            object.__setattr__(self, "ingested_at", ensure_utc(self.ingested_at))

        norm_type = normalize_value_type(self.value_type)
        validated_value = _validate_typed_value(norm_type, self.value)
        object.__setattr__(self, "value_type", norm_type)
        object.__setattr__(self, "value", validated_value)

        if self.unit is not None and (len(self.unit) > 32 or ("/" in self.unit and self.unit.count("/") > 3)):
            raise ObservationError("INVALID_UNIT", "unit must be <= 32 chars.")
        if not isinstance(self.quality, Quality):
            object.__setattr__(self, "quality", Quality(str(self.quality).upper()))
        if not isinstance(self.origin, Origin):
            object.__setattr__(self, "origin", Origin(str(self.origin).upper()))
        if self.quality_reason is not None:
            object.__setattr__(self, "quality_reason", str(self.quality_reason)[:128])
        if self.correlation_id is not None:
            object.__setattr__(self, "correlation_id", str(self.correlation_id)[:128])

    def validate(self) -> None:
        # __post_init__ already enforces all invariants; keep explicit method for interface symmetry.
        _validate_typed_value(self.value_type, self.value)

    def to_value_json(self) -> dict[str, Any]:
        return {"v": self.value}

    def to_legacy_observation(self, *, edge_id: UUID | None = None, now: datetime | None = None) -> Observation:
        """Convert safely to legacy domain.Observation for compatibility paths."""
        dec = resolve_times(
            received_time=self.acquired_at,
            source_time=self.source_time,
            quality=self.quality.value,
            now=now,
        )
        prov_dict = self.provenance.to_dict() if self.provenance else {}
        if dec.reason == EDGE_CLOCK_FUTURE:
            prov_dict["edge_received_time"] = _fmt_utc_us(self.acquired_at)
        reason = dec.reason or self.quality_reason
        if reason:
            prov_dict["reason"] = reason
        return Observation(
            event_uid=self.event_uid,
            tenant_id=self.tenant_id,
            resource_id=self.resource_id,
            signal_id=self.signal_id,
            event_time=dec.event_time,
            received_time=dec.received_time,
            value=self.value,
            data_type=self.value_type,
            unit=self.unit,
            quality=Quality(dec.quality),
            origin=self.origin,
            config_revision=self.config_revision,
            site_id=self.site_id,
            edge_id=edge_id,
            connection_id=self.connection_id,
            source_time=dec.source_time,
            provenance=prov_dict or None,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "data_epoch": self.data_epoch,
            "config_revision": self.config_revision,
            "event_uid": self.event_uid,
            "tenant_id": str(self.tenant_id),
            "site_id": str(self.site_id) if self.site_id else None,
            "connection_id": str(self.connection_id) if self.connection_id else None,
            "acquisition_job_id": str(self.acquisition_job_id) if self.acquisition_job_id else None,
            "source_field_id": str(self.source_field_id) if self.source_field_id else None,
            "signal_id": str(self.signal_id),
            "resource_id": str(self.resource_id),
            "source_time": _fmt_utc_us(self.source_time),
            "acquired_at": _fmt_utc_us(self.acquired_at),
            "ingested_at": _fmt_utc_us(self.ingested_at),
            "value_type": self.value_type,
            "value": self.value,
            "unit": self.unit,
            "quality": self.quality.value,
            "quality_reason": self.quality_reason,
            "origin": self.origin.value,
            "provenance": self.provenance.to_dict() if self.provenance else None,
            "correlation_id": self.correlation_id,
            "source_sequence": int(self.source_sequence) if self.source_sequence is not None else None,
            "keepalive": self.keepalive,
        }

    def to_json_bytes(self) -> bytes:
        return json.dumps(self.to_dict(), separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "CanonicalObservation":
        version = int(data.get("schema_version") or 0)
        if version != CANONICAL_SCHEMA_VERSION:
            raise ObservationError("UNSUPPORTED_SCHEMA_VERSION", f"Unsupported schema_version={version!r}.")
        return cls(
            schema_version=version,
            data_epoch=int(data.get("data_epoch") or 1),
            config_revision=int(data.get("config_revision") or 1),
            event_uid=str(data.get("event_uid") or ""),
            tenant_id=_parse_uuid(data.get("tenant_id"), field_name="tenant_id"),  # type: ignore[arg-type]
            site_id=_parse_uuid(data.get("site_id"), field_name="site_id", allow_none=True),
            connection_id=_parse_uuid(data.get("connection_id"), field_name="connection_id", allow_none=True),
            acquisition_job_id=_parse_uuid(data.get("acquisition_job_id"), field_name="acquisition_job_id", allow_none=True),
            source_field_id=_parse_uuid(data.get("source_field_id"), field_name="source_field_id", allow_none=True),
            signal_id=_parse_uuid(data.get("signal_id"), field_name="signal_id"),  # type: ignore[arg-type]
            resource_id=_parse_uuid(data.get("resource_id"), field_name="resource_id"),  # type: ignore[arg-type]
            source_time=_parse_utc(data.get("source_time"), field_name="source_time", allow_none=True),
            acquired_at=_parse_utc(data.get("acquired_at"), field_name="acquired_at"),  # type: ignore[arg-type]
            ingested_at=_parse_utc(data.get("ingested_at"), field_name="ingested_at", allow_none=True),
            value_type=str(data.get("value_type") or ""),
            value=data.get("value"),
            unit=str(data["unit"]) if data.get("unit") is not None else None,
            quality=Quality(str(data.get("quality") or "GOOD").upper()),
            quality_reason=str(data["quality_reason"]) if data.get("quality_reason") is not None else None,
            origin=Origin(str(data.get("origin") or "LIVE").upper()),
            provenance=CanonicalProvenance.from_dict(data.get("provenance")) if data.get("provenance") else None,
            correlation_id=str(data["correlation_id"]) if data.get("correlation_id") is not None else None,
            source_sequence=int(data["source_sequence"]) if data.get("source_sequence") is not None else None,
            keepalive=bool(data.get("keepalive", False)),
        )

    @classmethod
    def from_json_bytes(cls, raw: bytes | str) -> "CanonicalObservation":
        try:
            text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
            payload = json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ObservationError("INVALID_JSON", f"Malformed canonical observation JSON: {exc}") from exc
        if not isinstance(payload, Mapping):
            raise ObservationError("INVALID_JSON", "Canonical observation payload must be a JSON object.")
        return cls.from_dict(payload)
