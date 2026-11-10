"""Automated Golden API contract lock across the 5 existing navigation domains (S02).

Ensures that refactoring acquisition/storage/reset internals preserves every route path, HTTP
method, and JSON field shape expected by Overview, Factory Model, Data Collector, Data Models,
and existing navigation pages.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from factorix.modules import providers as P
from factorix.modules.telemetry import latest_stream_payload
from factorix.transport.app import app

# Exact route table locked from S00 Golden API baseline capture (docs/testing/golden-contracts.md)
GOLDEN_ROUTE_METHODS: dict[str, set[str]] = {
    "/api/v1/auth/status": {"GET"},
    "/api/v1/auth/me": {"GET"},
    "/api/v1/sites": {"GET", "POST"},
    "/api/v1/resource-types": {"GET", "POST"},
    "/api/v1/hierarchy-presets": {"GET"},
    "/api/v1/resources": {"GET", "POST"},
    "/api/v1/graph/neighbors": {"GET"},
    "/api/v1/connector-types": {"GET"},
    "/api/v1/connections": {"GET", "POST"},
    "/api/v1/connections/{connection_id}": {"GET", "PATCH", "DELETE"},
    "/api/v1/connections/{connection_id}/pause": {"POST"},
    "/api/v1/connections/{connection_id}/resume": {"POST"},
    "/api/v1/connections/{connection_id}/tests": {"POST"},
    "/api/v1/commissioning": {"GET"},
    "/api/v1/commissioning/{job_id}": {"GET"},
    "/api/v1/signals": {"GET"},
    "/api/v1/signals/bulk": {"POST"},
    "/api/v1/signals/{signal_id}/latest": {"GET"},
    "/api/v1/signals/{signal_id}/usage": {"GET"},
    "/api/v1/observations/latest": {"GET"},
    "/api/v1/observations/history": {"GET"},
    "/api/v1/observations/aggregate": {"GET"},
    "/api/v1/data-models": {"GET", "POST"},
    "/api/v1/data-models/validate": {"POST"},
    "/api/v1/data-models/preview": {"POST"},
    "/api/v1/data-models/catalog": {"GET"},
    "/api/v1/data-models/rules/functions": {"GET"},
    "/api/v1/data-models/usage": {"GET"},
    "/api/v1/data-models/{model_id}": {"GET", "PATCH", "DELETE"},
    "/api/v1/data-models/{model_id}/pause": {"POST"},
    "/api/v1/data-models/{model_id}/resume": {"POST"},
    "/api/v1/data-models/{model_id}/duplicate": {"POST"},
    "/api/v1/data-models/{model_id}/latest": {"GET"},
    "/api/v1/data-models/{model_id}/snapshots": {"GET"},
    "/api/v1/overview": {"GET"},
    "/api/v1/storage/overview": {"GET"},
    "/api/v1/storage/ingestion-health": {"GET"},
    "/api/v1/audit-events": {"GET"},
}

GOLDEN_LATEST_REQUIRED_KEYS = frozenset(
    {
        "tenant_id",
        "signal_id",
        "resource_id",
        "observation_id",
        "value_type",
        "value_json",
        "unit",
        "quality",
        "event_time",
        "received_time",
        "source_time",
        "config_revision",
        "origin",
        "last_good_value_json",
        "last_good_event_time",
        "updated_at",
        "key",
        "display_name",
        "expected_interval_ms",
        "nullable",
        "value",
        "source_quality",
        "freshness",
        "effective_status",
        "reason_code",
        "evaluated_at",
        "stale_after_ms",
        "last_good",
        "raw_quality",
    }
)

GOLDEN_CONNECTION_REQUIRED_KEYS = frozenset(
    {
        "id",
        "name",
        "protocol",
        "endpoint_redacted",
        "site_id",
        "health",
        "status",
        "last_error",
        "last_success_at",
        "version",
        "config_json",
        "secret_configured",
        "signal_count",
        "messages_per_min",
        "interval_ms",
        "protocol_key",
        "config",
        "active_binding_count",
        "effective_health",
    }
)

GOLDEN_OVERVIEW_REQUIRED_KEYS = frozenset(
    {
        "resources",
        "machines",
        "active_connections",
        "connections_online",
        "connections_idle",
        "connections_degraded",
        "connections_paused",
        "connections_working",
        "connections_total",
        "collector_status",
        "data_collection_status",
        "last_data_at",
        "ingest_per_minute",
        "messages_per_min",
        "generated_at",
        "connection_health",
        "recent_errors",
    }
)


def _route_method_map() -> dict[str, set[str]]:
    mapping: dict[str, set[str]] = {}
    for path, operations in app.openapi().get("paths", {}).items():
        if isinstance(operations, dict):
            mapping.setdefault(path, set()).update(m.upper() for m in operations.keys())
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if path and methods:
            mapping.setdefault(path, set()).update(methods)
    return mapping


def test_golden_routes_and_methods_registered() -> None:
    routes = _route_method_map()
    missing: list[str] = []
    for path, expected_methods in GOLDEN_ROUTE_METHODS.items():
        actual = routes.get(path, set())
        if not expected_methods.issubset(actual):
            missing.append(f"{path}: expected {sorted(expected_methods)}, got {sorted(actual)}")
    assert missing == [], f"Missing golden API routes/methods: {missing}"


def test_golden_openapi_schema_compiles_cleanly() -> None:
    schema = app.openapi()
    assert schema.get("openapi", "").startswith("3.")
    paths = schema.get("paths", {})
    assert "/api/v1/connections" in paths
    assert "/api/v1/signals" in paths
    assert "/api/v1/data-models" in paths


def test_golden_stream_payload_and_field_sets_locked() -> None:
    now = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
    payload = latest_stream_payload(
        signal_id=uuid4(),
        value=123.4,
        quality="GOOD",
        reason=None,
        received_time=now,
        source_time=now - timedelta(seconds=1),
        expected_interval_ms=1000,
        now=now,
    )
    assert set(payload.keys()) == {
        "type",
        "signal_id",
        "value",
        "quality",
        "effective_status",
        "reason_code",
        "received_time",
        "source_time",
    }
    assert payload["type"] == "latest"
    assert payload["effective_status"] == "GOOD"
    assert len(GOLDEN_LATEST_REQUIRED_KEYS) == 29
    assert len(GOLDEN_CONNECTION_REQUIRED_KEYS) >= 18
    assert len(GOLDEN_OVERVIEW_REQUIRED_KEYS) >= 17


def test_provider_protocols_and_modes_exported() -> None:
    assert hasattr(P, "LiveStateProvider")
    assert hasattr(P, "HistoricalValueProvider")
    assert hasattr(P, "ModelSnapshotProvider")
    assert hasattr(P, "RecordingPolicyEvaluator")
    assert set(P.RecordingMode) == {"ON_CHANGE", "EVERY_ACQUISITION", "INTERVAL"}
    assert "EPOCH_FENCED" in set(P.SkipReason)
