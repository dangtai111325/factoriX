"""``collector_runtime_status.queues_json`` contract helpers (contract runtime-status.md, CT-18 / CT-19, ADR-018).

Pure (stdlib only). Producers stamp ``schema_version``; readers accept the current shape and the previous,
unversioned one (version 1 readers must keep working with version-less rows written before the upgrade).

* v1 (``schema_version: 1``): acquisition puts its per-MQTT-connection counters under ``"connectors"``.
* unversioned (before B-11): the same counters were top-level keys named by the connection UUID.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import UUID

__all__ = ["QUEUES_SCHEMA_VERSION", "connector_counters", "parse_queues", "queues_schema_version"]

QUEUES_SCHEMA_VERSION = 1


def parse_queues(raw: Any) -> dict[str, Any]:
    """``queues_json`` as a dict (a JSON string is decoded; anything else is ``{}``)."""
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return dict(raw) if isinstance(raw, Mapping) else {}


def queues_schema_version(raw: Any) -> int:
    """0 for rows written before the version stamp existed."""
    try:
        return int(parse_queues(raw).get("schema_version") or 0)
    except (TypeError, ValueError):
        return 0


def _is_uuid(key: str) -> bool:
    try:
        UUID(str(key))
    except ValueError:
        return False
    return True


def connector_counters(raw: Any) -> dict[str, dict[str, Any]]:
    """MQTT counters per connection id, from ``connectors`` (v1) or the legacy top-level UUID keys."""
    queues = parse_queues(raw)
    nested = queues.get("connectors")
    if isinstance(nested, Mapping):
        return {str(k): dict(v) for k, v in nested.items() if isinstance(v, Mapping)}
    return {str(k): dict(v) for k, v in queues.items() if isinstance(v, Mapping) and _is_uuid(str(k))}
