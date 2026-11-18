"""Characterization: key response / frame shapes the web client depends on (contracts live-stream.md,
internal-http.md). Shapes are locked as key sets; values are covered by the feature tests.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from factorix.modules.live_state import PipelineEvidence, refresh_live_message
from factorix.transport.hub import Channel, Hub, browser_payload

NOW = datetime(2026, 11, 18, 7, 0, 0, tzinfo=timezone.utc)
TENANT = "00000000-0000-0000-0000-0000000000a1"
LATEST_BASE_KEYS = {"type", "signal_id", "value", "quality", "effective_status", "reason_code", "received_time", "source_time"}
LATEST_OPTIONAL_KEYS = {"evaluated_at", "stale_after_ms", "freshness", "delivery_lag_ms", "connection_id", "data_epoch", "last_acquired_at",
                        "last_value_changed_at", "source_health", "connection_health", "broker_health", "storage_health"}
ERROR_KEYS = {"code", "message", "field_errors", "correlation_id", "retryable"}


def test_latest_frame_keys() -> None:
    from factorix.transport.app import _latest_message

    sid = uuid4()
    minimal = _latest_message({"signal_id": sid})
    assert set(minimal) == LATEST_BASE_KEYS and minimal["type"] == "latest"
    full = _latest_message({"signal_id": sid, **{k: 1 for k in LATEST_OPTIONAL_KEYS}})
    assert set(full) == LATEST_BASE_KEYS | LATEST_OPTIONAL_KEYS


def test_dispatch_time_refresh_annotates_freshness() -> None:
    sid = str(uuid4())
    ev = PipelineEvidence()
    ev.set_mapping([{"signal_id": sid, "connection_id": "c1", "interval_ms": 1000}], now=NOW)
    ev.set_source([{"id": "c1", "last_success_at": NOW - timedelta(seconds=1)}], reported_at=NOW)
    msg = {"type": "latest", "signal_id": sid, "quality": "GOOD", "effective_status": "GOOD", "reason_code": "OK",
           "last_acquired_at": (NOW - timedelta(seconds=30)).isoformat()}
    out = refresh_live_message(msg, now=NOW, evidence=ev)
    assert set(out) - set(msg) == {"stale_after_ms", "freshness", "age_ms", "evaluated_at", "connection_id", "delivery_lag_ms"}
    assert (out["freshness"], out["effective_status"], out["reason_code"]) == ("DELAYED", "GOOD", "DELIVERY_DELAYED")


def test_browser_payload_and_heartbeat_frames() -> None:
    assert browser_payload({"kind": "health", "tenant_id": TENANT, "payload": {"type": "health", "id": "x"}}) == {"type": "health", "id": "x"}
    assert browser_payload({"kind": "model_event", "tenant_id": TENANT, "group_id": "g", "n": 1}) == {"group_id": "g", "n": 1, "type": "model_event"}

    async def send(_m: dict[str, Any]) -> None:
        return None

    hub = Hub()
    frame = hub.heartbeat_frame(Channel(send, TENANT), "2026-11-18T07:00:00.000Z")
    assert frame["type"] == "heartbeat" and frame["seq"] == 1 and frame["server_time"] == "2026-11-18T07:00:00.000Z"
    assert set(frame) <= {"type", "seq", "server_time", "pipeline"}


# ---------------------------------------------------------------------------- REST through the ASGI app


@pytest.fixture()
def api(monkeypatch: pytest.MonkeyPatch):
    from factorix.transport import app as A

    async def no_db():
        yield SimpleNamespace()

    async def principal():
        return {"tenant_id": TENANT, "admin_id": "00000000-0000-0000-0000-0000000000b1", "role": "admin"}

    monkeypatch.setitem(A.app.dependency_overrides, A.db_session, no_db)
    monkeypatch.setitem(A.app.dependency_overrides, A.admin, principal)
    return A


async def _get(A: Any, path: str) -> Any:
    async with AsyncClient(transport=ASGITransport(app=A.app), base_url="http://test") as client:
        return await client.get(path)


async def test_health_live_shape(api: Any) -> None:
    response = await _get(api, "/health/live")
    assert response.status_code == 200 and response.json() == {"status": "live"}


async def test_error_body_shape(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api, "settings", SimpleNamespace(collector_mode="acquisition"))
    response = await _get(api, "/api/v1/edge-sync/config")
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == ERROR_KEYS


async def test_collector_status_shape_in_acquisition_mode(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """``GET /api/v1/edges`` is the collector status API the UI uses (Q6)."""
    monkeypatch.setattr(api, "settings", SimpleNamespace(collector_mode="acquisition"))

    async def fake_fetch_all(_session: Any, _sql: str, _params: Any) -> list[dict[str, Any]]:
        return [{"instance_id": "local-acquisition-1", "role": "acquisition", "health": "HEALTHY", "software_version": "acq-v1",
                 "config_revision": 7, "spool_pending": 0, "fast_buffered": 0, "broker_ok": True,
                 "last_heartbeat": datetime.now(timezone.utc), "diagnostic": None}]

    monkeypatch.setattr(api, "fetch_all", fake_fetch_all)
    response = await _get(api, "/api/v1/edges")
    (item,) = response.json()["items"]
    assert set(item) == {"id", "name", "site_id", "enrollment_status", "desired_revision", "active_revision", "last_heartbeat", "health",
                         "effective_health", "health_raw", "diagnostic", "delivery_lag_ms", "delayed_connections", "software_version",
                         "outbox_pending", "queues", "config_state", "report_state"}  # additive: delayed_connections (R2-02), report_state (P6)
    assert (item["health"], item["effective_health"], item["desired_revision"]) == ("ONLINE", "ONLINE", 7)


async def test_collector_status_degrades_during_a_delivery_stall(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """R2-02: acquisition reads the source but the newest delivered value is 40 s old -> DEGRADED + diagnostic."""
    from factorix.application.live.freshness_service import PipelineEvidence
    from factorix.transport.http.routers import collector_status as CS

    now = datetime.now(timezone.utc)
    ev = PipelineEvidence()
    ev.set_source([{"id": "c1", "last_success_at": now - timedelta(seconds=1)}], reported_at=now - timedelta(seconds=1))
    ev.note_delivery(None, now - timedelta(seconds=40), connection_id="c1")
    monkeypatch.setattr(CS, "get_pipeline_evidence", lambda: ev)
    monkeypatch.setattr(api, "settings", SimpleNamespace(collector_mode="acquisition"))

    async def fake_fetch_all(_session: Any, _sql: str, _params: Any) -> list[dict[str, Any]]:
        return [{"instance_id": "local-acquisition-1", "role": "acquisition", "health": "HEALTHY", "software_version": "acq-v1",
                 "config_revision": 7, "spool_pending": 0, "fast_buffered": 0, "broker_ok": True,
                 "last_heartbeat": now, "diagnostic": None}]

    monkeypatch.setattr(api, "fetch_all", fake_fetch_all)
    (item,) = (await _get(api, "/api/v1/edges")).json()["items"]
    assert item["effective_health"] == "DEGRADED" and item["health"] == "ONLINE"
    assert item["delayed_connections"] == 1 and item["diagnostic"].startswith("Data delayed")


async def test_storage_design_operations_moved_to_their_own_path(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """CT-01 fixed: the logical designs journal (bare list) lives at /storage/designs/operations."""
    from factorix.modules import storage_designs as SD

    async def fake_list(*_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(SD, "list_storage_operations", fake_list)
    response = await _get(api, "/api/v1/storage/designs/operations")
    assert response.status_code == 200 and response.json() == []


async def test_storage_operations_list_matches_the_physical_ui(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from factorix.modules import storage_designs as SD
    from factorix.transport import storage_api

    async def fake_list(*_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        return []

    async def fake_fetch_all(*_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(SD, "list_storage_operations", fake_list)
    monkeypatch.setattr(storage_api, "fetch_all", fake_fetch_all, raising=False)
    response = await _get(api, "/api/v1/storage/operations")
    body = response.json()
    assert isinstance(body, dict) and {"items", "total"} <= set(body)


async def test_collector_status_says_not_reporting_when_the_report_is_late(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """P6: heartbeat alive but the connection report flush failing -> DEGRADED "Collector not reporting ..."."""
    monkeypatch.setattr(api, "settings", SimpleNamespace(collector_mode="acquisition"))
    now = datetime.now(timezone.utc)
    runtime = {"leader_since": (now - timedelta(hours=1)).isoformat(), "last_report_at": (now - timedelta(seconds=45)).isoformat()}

    async def fake_fetch_all(_session: Any, _sql: str, _params: Any) -> list[dict[str, Any]]:
        return [{"instance_id": "local-acquisition-1", "role": "acquisition", "health": "HEALTHY", "software_version": "acq-v1",
                 "config_revision": 7, "spool_pending": 0, "fast_buffered": 0, "broker_ok": True, "last_heartbeat": now,
                 "diagnostic": None, "queues_json": json.dumps({"runtime": runtime})}]

    monkeypatch.setattr(api, "fetch_all", fake_fetch_all)
    (item,) = (await _get(api, "/api/v1/edges")).json()["items"]
    assert (item["effective_health"], item["report_state"]) == ("DEGRADED", "REPORT_LATE")
    assert item["diagnostic"].startswith("Collector not reporting connection status")
