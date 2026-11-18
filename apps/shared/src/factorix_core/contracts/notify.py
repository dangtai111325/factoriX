"""PostgreSQL LISTEN/NOTIFY contract: channel registry + versioned payload types (R2-E C6, contract notify.md).

Pure (stdlib only). Producers build payloads with the ``to_payload()`` of a payload type; consumers
decode with ``parse_<channel>()``. Decoding never sniffs substrings: a payload is recognised by its
``v`` / ``kind`` markers, falling back to the legacy (unversioned) shapes, which are version 1
(ADR-018: a consumer accepts N and N-1).

Byte compatibility: every ``to_payload()`` produces exactly the bytes today's producers send, so a
consumer of the previous release reads them unchanged.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

__all__ = [
    "CHANNELS",
    "NOTIFY_MAX_BYTES",
    "Channel",
    "CommissioningRequested",
    "ConfigChanged",
    "EpochChanged",
    "HealthChanged",
    "LatestIdsV2",
    "StreamEventsV1",
    "parse_commissioning",
    "parse_config_changed",
    "parse_epoch_changed",
    "parse_health_changed",
    "parse_stream_events",
]

# PostgreSQL rejects NOTIFY payloads of 8000 bytes or more; producers keep a margin.
NOTIFY_MAX_BYTES = 7900


class Channel(StrEnum):
    """Every NOTIFY channel FactoriX uses (PostgreSQL channel names are part of the contract)."""

    CONFIG_CHANGED = "factorix_config_changed"
    EPOCH_CHANGED = "factorix_epoch_changed"
    STREAM_EVENTS = "factorix_stream_events"
    HEALTH_CHANGED = "factorix_health_changed"
    COMMISSIONING = "factorix_commissioning"


CHANNELS: frozenset[str] = frozenset(c.value for c in Channel)


def _loads(payload: str | bytes | None) -> dict[str, Any] | None:
    if not payload:
        return None
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _version(data: Mapping[str, Any]) -> int:
    try:
        return int(data.get("v") or 1)
    except (TypeError, ValueError):
        return 1


# ---------------------------------------------------------------------------- factorix_config_changed


@dataclass(frozen=True)
class ConfigChanged:
    """``{"tenant_id": "<uuid>"}`` (v1). ``tenant_id=None`` = every tenant."""

    tenant_id: str | None
    version: int = 1

    def to_payload(self) -> str:
        return json.dumps({"tenant_id": self.tenant_id})


def parse_config_changed(payload: str | bytes | None) -> ConfigChanged:
    data = _loads(payload) or {}
    tid = data.get("tenant_id")
    return ConfigChanged(str(tid) if tid else None, _version(data))


# ---------------------------------------------------------------------------- factorix_epoch_changed


@dataclass(frozen=True)
class EpochChanged:
    """``{"tenant_id", "active_epoch"}``. Producers historically used ``new_epoch`` too: both are read."""

    tenant_id: str | None
    active_epoch: int | None
    version: int = 1

    def to_payload(self) -> str:
        return json.dumps({"tenant_id": self.tenant_id, "active_epoch": self.active_epoch})


def parse_epoch_changed(payload: str | bytes | None) -> EpochChanged:
    data = _loads(payload) or {}
    tid = data.get("tenant_id")
    raw = data.get("active_epoch") if data.get("active_epoch") is not None else data.get("new_epoch")
    try:
        epoch = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        epoch = None
    return EpochChanged(str(tid) if tid else None, epoch, _version(data))


# ---------------------------------------------------------------------------- factorix_commissioning


@dataclass(frozen=True)
class CommissioningRequested:
    job_id: str
    connection_id: str
    version: int = 1

    def to_payload(self) -> str:
        return json.dumps({"job_id": self.job_id, "connection_id": self.connection_id})


def parse_commissioning(payload: str | bytes | None) -> CommissioningRequested | None:
    data = _loads(payload)
    if not data or not data.get("job_id"):
        return None
    return CommissioningRequested(str(data["job_id"]), str(data.get("connection_id") or ""), _version(data))


# ---------------------------------------------------------------------------- factorix_health_changed


@dataclass(frozen=True)
class HealthChanged:
    """``{"tenant_id", "event": {type: "health", entity, id, health, effective_health, last_error, last_success_at}}``."""

    tenant_id: str
    event: Mapping[str, Any]
    version: int = 1

    def to_payload(self) -> str:
        return json.dumps({"tenant_id": self.tenant_id, "event": dict(self.event)})


def parse_health_changed(payload: str | bytes | None) -> HealthChanged | StreamEventsV1 | None:
    """The health channel carries the single-event shape; ingestion (edge mode) sends ``{"events":[...]}``."""
    data = _loads(payload)
    if not data:
        return None
    if isinstance(data.get("events"), list):
        return StreamEventsV1.from_dict(data)
    if isinstance(data.get("event"), dict) and data.get("tenant_id"):
        return HealthChanged(str(data["tenant_id"]), data["event"], _version(data))
    return None


# ---------------------------------------------------------------------------- factorix_stream_events


@dataclass(frozen=True)
class StreamEventsV1:
    """``{"events": [{kind, tenant_id, signal_id, ..., payload:{type:"latest", ...}}, ...]}`` (no ``v``)."""

    events: tuple[dict[str, Any], ...]
    version: int = 1

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "StreamEventsV1":
        events = data.get("events")
        items = tuple(ev for ev in (events or ()) if isinstance(ev, dict) and ev.get("kind") and ev.get("tenant_id"))
        return cls(items, _version(data))


@dataclass(frozen=True)
class LatestIdsV2:
    """``{"v":2,"kind":"latest_ids","tenant_id",["max_acquired_at"],["connection_ids"],"signal_ids":[...]}``.

    The consumer reads the committed rows itself; ``connection_ids`` / ``max_acquired_at`` are delivery
    evidence. ``to_payloads()`` packs ids into payloads below ``max_bytes``.
    """

    tenant_id: str
    signal_ids: tuple[str, ...]
    connection_ids: tuple[str, ...] = ()
    max_acquired_at: str | None = None
    version: int = 2
    kind: str = field(default="latest_ids")

    MAX_CONNECTION_IDS = 32

    def _head(self) -> dict[str, Any]:
        head: dict[str, Any] = {"v": 2, "kind": "latest_ids", "tenant_id": self.tenant_id}
        if self.max_acquired_at is not None:
            head["max_acquired_at"] = self.max_acquired_at
        if self.connection_ids:
            head["connection_ids"] = list(self.connection_ids)[: self.MAX_CONNECTION_IDS]
        return head

    def to_payloads(self, max_bytes: int = 7800) -> list[str]:
        if not self.signal_ids:
            return []
        head = self._head()
        base = len(json.dumps({**head, "signal_ids": []}, separators=(",", ":")))
        per_id = 39  # '"<36-char uuid>",'
        per_payload = max(1, (max_bytes - base) // per_id)
        ids = list(self.signal_ids)
        return [
            json.dumps({**head, "signal_ids": ids[i : i + per_payload]}, separators=(",", ":"))
            for i in range(0, len(ids), per_payload)
        ]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "LatestIdsV2 | None":
        ids = data.get("signal_ids")
        if not isinstance(ids, list) or not data.get("tenant_id"):
            return None
        conns = data.get("connection_ids")
        return cls(
            tenant_id=str(data["tenant_id"]),
            signal_ids=tuple(str(item) for item in ids),
            connection_ids=tuple(str(c) for c in conns) if isinstance(conns, list) else (),
            max_acquired_at=str(data["max_acquired_at"]) if data.get("max_acquired_at") else None,
        )


def parse_stream_events(payload: str | bytes | None) -> StreamEventsV1 | LatestIdsV2 | HealthChanged | None:
    """Decode a ``factorix_stream_events`` payload by its version markers (CT-04: no substring sniffing).

    * ``v == 2`` and ``kind == "latest_ids"`` -> ``LatestIdsV2``;
    * ``{"events": [...]}`` -> ``StreamEventsV1``;
    * ``{"tenant_id", "event": {...}}`` -> ``HealthChanged`` (single health event).
    Unknown versions / kinds return ``None`` (ignored, never mis-parsed as another shape).
    """
    data = _loads(payload)
    if not data:
        return None
    version = _version(data)
    if version >= 2:
        if version == 2 and data.get("kind") == "latest_ids":
            return LatestIdsV2.from_dict(data)
        return None
    if isinstance(data.get("events"), list):
        return StreamEventsV1.from_dict(data)
    if isinstance(data.get("event"), dict) and data.get("tenant_id"):
        return HealthChanged(str(data["tenant_id"]), data["event"], version)
    return None
