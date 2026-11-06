"""Center pipeline: time model, latest ordering, health rules, push hub, protocol validation."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from factorix.domain.health import (
    apply_connection_report,
    appliance_needs_enrollment,
    collector_status,
    connection_no_data_due,
    data_collection_status,
    edge_config_state,
    effective_connection_health,
    effective_edge_health,
    is_no_data_message,
    no_data_message,
)
from factorix.domain.observation import EDGE_CLOCK_FUTURE, SOURCE_TIME_FUTURE, resolve_times, should_replace_latest
from factorix.domain.signal_state import evaluate_signal_state
from factorix.modules.common import iso_ms
from factorix.modules.protocols import (
    MASK,
    accept_connection,
    http_rate_warnings,
    mask_config,
    parse_config,
    redacted_endpoint,
    unmask_config,
    validate_interval,
)
from factorix.modules.telemetry import RejectionThrottle, latest_stream_payload, select_binding
from factorix.platform.errors import AppError
from factorix.transport.hub import Channel, Hub, coalesce_key, origin_allowed

NOW = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)


# --- time model -------------------------------------------------------------------------------


def test_event_time_is_received_time_and_old_source_time_is_metadata() -> None:
    received = NOW - timedelta(seconds=1)
    frozen_source = NOW - timedelta(days=3)  # stopped machine: last change 3 days ago
    decision = resolve_times(received_time=received, source_time=frozen_source, quality="GOOD", now=NOW)
    assert decision.event_time == received
    assert decision.received_time == received
    assert decision.source_time == frozen_source
    assert decision.quality == "GOOD"
    assert decision.reason is None


def test_future_source_time_is_uncertain_but_accepted() -> None:
    decision = resolve_times(received_time=NOW, source_time=NOW + timedelta(minutes=6), quality="GOOD", now=NOW)
    assert decision.quality == "UNCERTAIN"
    assert decision.reason == SOURCE_TIME_FUTURE
    assert decision.event_time == NOW


def test_small_future_source_skew_is_good() -> None:
    decision = resolve_times(received_time=NOW, source_time=NOW + timedelta(minutes=4), quality="GOOD", now=NOW)
    assert decision.quality == "GOOD"


def test_bad_quality_is_not_upgraded_by_time_model() -> None:
    decision = resolve_times(received_time=NOW, source_time=NOW + timedelta(hours=1), quality="BAD", now=NOW)
    assert decision.quality == "BAD"
    assert decision.reason == SOURCE_TIME_FUTURE


def test_edge_clock_in_future_is_clamped() -> None:
    decision = resolve_times(received_time=NOW + timedelta(hours=2), source_time=None, quality="GOOD", now=NOW)
    assert decision.event_time == NOW
    assert decision.quality == "UNCERTAIN"
    assert decision.reason == EDGE_CLOCK_FUTURE


def test_missing_received_time_uses_center_clock() -> None:
    decision = resolve_times(received_time=None, source_time=None, quality="GOOD", now=NOW)
    assert decision.received_time == NOW


def test_latest_ordering_uses_received_time_not_source_time() -> None:
    # A frozen source_timestamp (older) must still replace latest when acquired later.
    assert should_replace_latest(
        current_received_time=NOW,
        current_uid="b",
        current_event_time=NOW + timedelta(minutes=10),
        incoming_received_time=NOW + timedelta(seconds=1),
        incoming_uid="a",
        incoming_event_time=NOW - timedelta(days=1),
    )
    assert not should_replace_latest(
        current_received_time=NOW,
        current_uid="b",
        incoming_received_time=NOW - timedelta(seconds=1),
        incoming_uid="z",
    )
    # Same acquisition time: observation id breaks the tie deterministically.
    assert should_replace_latest(current_received_time=NOW, current_uid="a", incoming_received_time=NOW, incoming_uid="b")
    assert should_replace_latest(current_received_time=None, current_uid=None, incoming_received_time=NOW, incoming_uid="a")


def test_binding_validity_is_checked_against_received_time() -> None:
    old = {"id": "old", "valid_from": NOW - timedelta(days=2), "valid_to": NOW - timedelta(hours=1)}
    new = {"id": "new", "valid_from": NOW - timedelta(hours=1), "valid_to": None}
    assert select_binding([old, new], NOW)["id"] == "new"
    assert select_binding([old, new], NOW - timedelta(hours=5))["id"] == "old"
    assert select_binding([new], NOW - timedelta(hours=2)) is None


def test_rejection_audit_throttled_per_signal_per_hour() -> None:
    throttle = RejectionThrottle(window=timedelta(hours=1), max_keys=3)
    key = ("t", "e", "s1")
    assert throttle.should_audit(key, NOW)
    assert not throttle.should_audit(key, NOW + timedelta(minutes=59))
    assert throttle.should_audit(key, NOW + timedelta(minutes=61))
    for index in range(10):
        throttle.should_audit(("t", "e", f"x{index}"), NOW)
    assert len(throttle._seen) <= 3


def test_nullable_null_is_good_and_plain_null_is_bad() -> None:
    allowed = evaluate_signal_state(has_observation=True, raw_quality="GOOD", raw_value=None, event_time=NOW, now=NOW, null_allowed=True)
    assert allowed.effective_status == "GOOD"
    default = evaluate_signal_state(has_observation=True, raw_quality="GOOD", raw_value=None, event_time=NOW, now=NOW)
    assert default.effective_status == "BAD"


def test_latest_stream_payload_shape() -> None:
    payload = latest_stream_payload(
        signal_id="sig",
        value=1.5,
        quality="UNCERTAIN",
        reason=SOURCE_TIME_FUTURE,
        received_time=NOW,
        source_time=NOW + timedelta(minutes=10),
        expected_interval_ms=1000,
        now=NOW,
    )
    assert payload == {
        "type": "latest",
        "signal_id": "sig",
        "value": 1.5,
        "quality": "UNCERTAIN",
        "effective_status": "UNCERTAIN",
        "reason_code": SOURCE_TIME_FUTURE,
        "received_time": "2026-11-06T12:00:00.000Z",
        "source_time": "2026-11-06T12:10:00.000Z",
    }


def test_iso_ms_format() -> None:
    assert iso_ms(datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=timezone.utc)) == "2026-01-02T03:04:05.123Z"
    assert iso_ms(datetime(2026, 1, 2, 10, 4, 5, tzinfo=timezone(timedelta(hours=7)))) == "2026-01-02T03:04:05.000Z"
    assert iso_ms("2026-01-02T03:04:05Z") == "2026-01-02T03:04:05.000Z"
    assert iso_ms(None) is None


# --- edge and connection health ----------------------------------------------------------------


def _edge(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {"enrollment_status": "ENROLLED", "health": "ACTIVE", "last_heartbeat": NOW - timedelta(seconds=4), "desired_revision": 3, "active_revision": 3}
    row.update(overrides)
    return row


def test_effective_edge_health_from_heartbeat_age_only() -> None:
    assert effective_edge_health(_edge(), NOW) == "ONLINE"
    assert effective_edge_health(_edge(last_heartbeat=NOW - timedelta(seconds=16)), NOW) == "OFFLINE"
    assert effective_edge_health(_edge(last_heartbeat=None), NOW) == "OFFLINE"
    assert effective_edge_health(_edge(enrollment_status="UNENROLLED"), NOW) == "NOT_ENROLLED"
    assert effective_edge_health(_edge(health="DEGRADED"), NOW) == "DEGRADED"


@pytest.mark.parametrize("raw", ["CONFIG_PENDING", "CONFIG_VALIDATED", "UNKNOWN", "OFFLINE", "HEALTHY"])
def test_config_states_are_online_substates(raw: str) -> None:
    assert effective_edge_health(_edge(health=raw), NOW) == "ONLINE"


def test_edge_config_state() -> None:
    assert edge_config_state(_edge()) == "IN_SYNC"
    assert edge_config_state(_edge(desired_revision=4)) == "PENDING"
    assert edge_config_state(_edge(desired_revision=0, active_revision=0)) == "NONE"


def test_connection_without_bindings_is_idle_never_degraded() -> None:
    for health in ("DEGRADED", "UNKNOWN", "HEALTHY"):
        assert effective_connection_health(status="ACTIVE", health=health, active_bindings=0, edge_health="ONLINE") == "IDLE"


def test_effective_connection_health_rules() -> None:
    assert effective_connection_health(status="ACTIVE", health="HEALTHY", active_bindings=3, edge_health="ONLINE") == "HEALTHY"
    assert effective_connection_health(status="ACTIVE", health="DEGRADED", active_bindings=3, edge_health="ONLINE") == "DEGRADED"
    assert effective_connection_health(status="ACTIVE", health="UNKNOWN", active_bindings=3, edge_health="ONLINE") == "UNKNOWN"
    assert effective_connection_health(status="ACTIVE", health="HEALTHY", active_bindings=3, edge_health="OFFLINE") == "UNKNOWN"
    assert effective_connection_health(status="PAUSED", health="PAUSED", active_bindings=3, edge_health="ONLINE") == "PAUSED"
    assert effective_connection_health(status="ARCHIVED", health="UNKNOWN", active_bindings=0, edge_health=None) == "ARCHIVED"


def test_no_data_threshold() -> None:
    since = NOW - timedelta(seconds=29)
    assert not connection_no_data_due(last_success_at=None, since=since, interval_ms=1000, now=NOW)
    assert connection_no_data_due(last_success_at=None, since=NOW - timedelta(seconds=31), interval_ms=1000, now=NOW)
    # 3 x interval wins over the 30 s floor for slow polls
    assert not connection_no_data_due(last_success_at=NOW - timedelta(seconds=50), since=None, interval_ms=20000, now=NOW)
    assert connection_no_data_due(last_success_at=NOW - timedelta(seconds=61), since=None, interval_ms=20000, now=NOW)
    # A recent configuration change resets the reference
    assert not connection_no_data_due(last_success_at=NOW - timedelta(hours=1), since=NOW - timedelta(seconds=5), interval_ms=1000, now=NOW)
    assert not connection_no_data_due(last_success_at=None, since=None, interval_ms=1000, now=NOW)
    assert is_no_data_message(no_data_message(1000))


def test_edge_report_up_down_rate_limited_idle() -> None:
    current = {"status": "ACTIVE", "health": "UNKNOWN", "last_error": None, "last_success_at": None}
    up = apply_connection_report(current, {"state": "UP", "last_ok_at": "2026-11-06T11:59:59.000Z"}, NOW)
    assert up is not None and up.health == "HEALTHY" and up.last_error is None
    assert up.last_success_at == NOW - timedelta(seconds=1)

    down = apply_connection_report(current, {"state": "DOWN", "last_error_code": "TIMEOUT", "last_error": "No response within 3000 ms"}, NOW)
    assert down is not None and down.health == "DEGRADED" and down.last_error == "TIMEOUT: No response within 3000 ms"

    auth = apply_connection_report(current, {"state": "AUTH_FAILED"}, NOW)
    assert auth is not None and auth.health == "DEGRADED" and auth.last_error

    limited = apply_connection_report(current, {"state": "RATE_LIMITED", "last_error": "HTTP 429, retry after 30 s"}, NOW)
    assert limited is not None and limited.health == "HEALTHY" and limited.last_error == "HTTP 429, retry after 30 s"

    idle = apply_connection_report({**current, "health": "HEALTHY"}, {"state": "IDLE"}, NOW)
    assert idle is not None and idle.health == "UNKNOWN"


def test_edge_report_never_moves_last_success_back_or_into_future() -> None:
    current = {"status": "ACTIVE", "health": "HEALTHY", "last_error": None, "last_success_at": NOW}
    assert apply_connection_report(current, {"state": "UP", "last_ok_at": (NOW - timedelta(minutes=1)).isoformat()}, NOW) is None
    future = apply_connection_report({**current, "last_success_at": NOW - timedelta(seconds=5)}, {"state": "UP", "last_ok_at": (NOW + timedelta(hours=1)).isoformat()}, NOW)
    assert future is not None and future.last_success_at == NOW


def test_edge_report_ignored_for_paused_or_unknown_state() -> None:
    assert apply_connection_report({"status": "PAUSED", "health": "PAUSED"}, {"state": "DOWN"}, NOW) is None
    assert apply_connection_report({"status": "ACTIVE", "health": "UNKNOWN"}, {"state": "WEIRD"}, NOW) is None


def test_appliance_enrollment_decision() -> None:
    fresh = NOW - timedelta(seconds=3)
    stale = NOW - timedelta(minutes=5)
    unenrolled = {"enrollment_status": "UNENROLLED", "has_credential": False, "last_heartbeat": None}
    enrolled = {"enrollment_status": "ENROLLED", "has_credential": True, "last_heartbeat": fresh}
    assert not appliance_needs_enrollment(edge=None, credential_file_present=False, token_file_state="MISSING", now=NOW)
    assert appliance_needs_enrollment(edge=unenrolled, credential_file_present=False, token_file_state="MISSING", now=NOW)
    assert appliance_needs_enrollment(edge=unenrolled, credential_file_present=False, token_file_state="INVALID", now=NOW)
    assert not appliance_needs_enrollment(edge=unenrolled, credential_file_present=False, token_file_state="VALID", now=NOW)
    assert not appliance_needs_enrollment(edge=enrolled, credential_file_present=True, token_file_state="MISSING", now=NOW)
    # Edge discarded a rejected credential and stopped heartbeating
    assert appliance_needs_enrollment(edge={**enrolled, "last_heartbeat": stale}, credential_file_present=False, token_file_state="MISSING", now=NOW)
    # Edge still running on an in-memory credential: no new token
    assert not appliance_needs_enrollment(edge=enrolled, credential_file_present=False, token_file_state="MISSING", now=NOW)
    assert not appliance_needs_enrollment(edge={**unenrolled, "enrollment_status": "REVOKED"}, credential_file_present=False, token_file_state="MISSING", now=NOW)


def test_overview_summaries() -> None:
    assert collector_status([]) == "NONE"
    assert collector_status(["OFFLINE", "ONLINE"]) == "ONLINE"
    assert collector_status(["NOT_ENROLLED"]) == "NOT_ENROLLED"
    assert collector_status(["OFFLINE"]) == "OFFLINE"
    assert data_collection_status([]) == "NOT_CONFIGURED"
    assert data_collection_status(["IDLE", "IDLE"]) == "IDLE"
    assert data_collection_status(["PAUSED"]) == "PAUSED"
    assert data_collection_status(["HEALTHY", "IDLE"]) == "HEALTHY"
    assert data_collection_status(["HEALTHY", "UNKNOWN"]) == "PENDING"
    assert data_collection_status(["HEALTHY", "DEGRADED"]) == "DEGRADED"


# --- hub ----------------------------------------------------------------------------------------


def test_hub_coalesces_latest_per_signal_and_keeps_order() -> None:
    channel = Channel(lambda message: asyncio.sleep(0), "t1")
    channel.signals.update({"a", "b"})
    hub = Hub()
    hub.register(channel)
    events = [
        {"kind": "latest", "tenant_id": "t1", "signal_id": "a", "payload": {"type": "latest", "signal_id": "a", "value": 1}},
        {"kind": "latest", "tenant_id": "t1", "signal_id": "b", "payload": {"type": "latest", "signal_id": "b", "value": 10}},
        {"kind": "latest", "tenant_id": "t1", "signal_id": "a", "payload": {"type": "latest", "signal_id": "a", "value": 2}},
        {"kind": "latest", "tenant_id": "t1", "signal_id": "c", "payload": {"type": "latest", "signal_id": "c", "value": 0}},
        {"kind": "latest", "tenant_id": "t2", "signal_id": "a", "payload": {"type": "latest", "signal_id": "a", "value": 99}},
    ]
    hub.dispatch(events)
    assert channel.drain() == [
        {"type": "latest", "signal_id": "a", "value": 2},
        {"type": "latest", "signal_id": "b", "value": 10},
    ]


def test_hub_routes_models_health_and_tenants() -> None:
    mine = Channel(lambda message: asyncio.sleep(0), "t1")
    mine.groups.add("g1")
    other = Channel(lambda message: asyncio.sleep(0), "t2")
    other.groups.add("g1")
    hub = Hub()
    hub.register(mine)
    hub.register(other)
    hub.dispatch(
        [
            {"kind": "model_body", "tenant_id": "t1", "group_id": "g1", "body": "{}", "payload": {"type": "model_body", "group_id": "g1", "body": "{\"a\":1}"}},
            {"kind": "model_body", "tenant_id": "t1", "group_id": "g1", "body": "{}", "payload": {"type": "model_body", "group_id": "g1", "body": "{\"a\":2}"}},
            {"kind": "model_event", "tenant_id": "t1", "group_id": "g1", "event_id": "e1", "payload": {"type": "model_event", "group_id": "g1", "event_id": "e1", "body": "1"}},
            {"kind": "model_event", "tenant_id": "t1", "group_id": "g1", "event_id": "e2", "payload": {"type": "model_event", "group_id": "g1", "event_id": "e2", "body": "2"}},
            {"kind": "model_body", "tenant_id": "t1", "group_id": "g2", "payload": {"type": "model_body", "group_id": "g2", "body": "x"}},
            {"kind": "health", "tenant_id": "t1", "payload": {"type": "health", "entity": "edge", "id": "e", "health": "ONLINE"}},
            {"kind": "health", "tenant_id": "t1", "payload": {"type": "health", "entity": "edge", "id": "e", "health": "OFFLINE"}},
        ]
    )
    received = mine.drain()
    assert [m["type"] for m in received] == ["model_body", "model_event", "model_event", "health"]
    assert received[0]["body"] == "{\"a\":2}"
    assert received[-1]["health"] == "OFFLINE"
    assert other.drain() == []


def test_hub_payload_fallback_and_bounded_buffer() -> None:
    channel = Channel(lambda message: asyncio.sleep(0), "t1", max_pending=2)
    channel.groups.add("g")
    hub = Hub()
    hub.register(channel)
    for index in range(3):
        hub.dispatch([{"kind": "model_event", "tenant_id": "t1", "group_id": "g", "event_id": str(index), "body": "b"}])
    drained = channel.drain()
    assert len(drained) == 2 and channel.dropped == 1
    assert drained[-1] == {"group_id": "g", "event_id": "2", "body": "b", "type": "model_event"}
    assert coalesce_key({"type": "model_event", "group_id": "g"}) is None


def test_channel_sender_is_independent_and_stops_on_failure() -> None:
    sent: list[dict] = []

    async def scenario() -> None:
        async def send(message: dict) -> None:
            if message.get("boom"):
                raise RuntimeError("socket closed")
            sent.append(message)

        channel = Channel(send, "t1")
        task = asyncio.create_task(channel.run())
        channel.offer({"type": "pong"})
        await asyncio.sleep(0.01)
        channel.offer({"type": "x", "boom": True})
        await asyncio.wait_for(task, timeout=1)
        assert channel.closed

    asyncio.run(scenario())
    assert sent == [{"type": "pong"}]


def test_origin_check() -> None:
    assert origin_allowed(None, "appliance:8080", [])
    assert origin_allowed("http://appliance:8080", "appliance:8080", [])
    assert origin_allowed("https://console.local", "appliance:8080", ["https://console.local"])
    assert not origin_allowed("http://evil.example", "appliance:8080", ["https://console.local"])
    assert not origin_allowed("http://appliance:9999", "appliance:8080", [])
    assert not origin_allowed("null", "appliance:8080", [])


# --- protocols ------------------------------------------------------------------------------------


def test_websocket_protocol_config() -> None:
    stored, raw, interval = accept_connection("websocket", {"url": "ws://source.local/ws/live", "interval_ms": 1000})
    assert stored == "websocket" and interval == 1000
    config = parse_config("websocket", raw)
    assert config == {"url": "ws://source.local/ws/live", "headers": {}, "timeout_ms": 5000}
    assert redacted_endpoint("websocket", {"url": "wss://u:p@source.local:8443/live?token=x"}) == "wss://source.local:8443/live"
    with pytest.raises(AppError):
        parse_config("websocket", {"url": "http://source.local/ws"})


def test_http_config_auth_and_limits() -> None:
    _, raw, _ = accept_connection("http_pull", {"url": "http://source.local:443/api/v1/machines/m/state", "auth": "api_key"})
    config = parse_config("http", raw)
    assert config["base_url"] == "http://source.local:443"
    assert config["header_name"] == "X-API-Key"
    assert config["rate_limit_per_min"] == 60
    with pytest.raises(AppError) as plaintext:
        parse_config("http", {"base_url": "http://source.local", "headers": {"X-API-Key": "secret"}})
    assert plaintext.value.code == "SECRET_IN_HEADERS"
    with pytest.raises(AppError):
        parse_config("http", {"base_url": "http://source.local", "auth": "basic"})
    with pytest.raises(AppError) as fast:
        validate_interval("http", 500)
    assert fast.value.code == "INTERVAL"
    assert validate_interval("http", 5000) == 5000
    assert validate_interval("mqtt_client", None) is None


def test_http_rate_warning() -> None:
    assert http_rate_warnings(interval_ms=5000, path_count=6, rate_limit_per_min=120) == []
    warnings = http_rate_warnings(interval_ms=1000, path_count=6, rate_limit_per_min=120)
    assert warnings and "3000 ms" in warnings[0]


def test_config_masking_round_trip() -> None:
    stored = {"base_url": "http://s", "password": "p4ss", "headers": {"Authorization": "Bearer abc", "X-Trace": "1"}}
    masked = mask_config(stored)
    assert masked["password"] == MASK and masked["headers"]["Authorization"] == MASK and masked["headers"]["X-Trace"] == "1"
    assert stored["password"] == "p4ss"
    edited = {**masked, "base_url": "http://t"}
    restored = unmask_config(edited, stored)
    assert restored["password"] == "p4ss" and restored["headers"]["Authorization"] == "Bearer abc" and restored["base_url"] == "http://t"


def test_to_observation_applies_time_model() -> None:
    from uuid import uuid4

    from factorix.modules.telemetry import _to_observation

    item = {
        "event_uid": "u1",
        "resource_id": str(uuid4()),
        "signal_id": str(uuid4()),
        "event_time": "2026-11-01T00:00:00Z",
        "received_time": "2026-11-06T11:59:59.500Z",
        "source_time": "2026-11-01T00:00:00Z",
        "value": 3.2,
        "data_type": "float64",
        "quality": "GOOD",
        "config_revision": 4,
    }
    observation = _to_observation(item, uuid4(), uuid4(), now=NOW)
    assert observation.event_time == datetime(2026, 11, 6, 11, 59, 59, 500000, tzinfo=timezone.utc)
    assert observation.source_time == datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert observation.quality.value == "GOOD"
    future = _to_observation({**item, "source_time": "2026-11-06T13:00:00Z"}, uuid4(), uuid4(), now=NOW)
    assert future.quality.value == "UNCERTAIN" and future.provenance["reason"] == SOURCE_TIME_FUTURE
    invalid = _to_observation({**item, "source_time": "not-a-time"}, uuid4(), uuid4(), now=NOW)
    assert invalid.source_time is None and invalid.provenance["reason"] == "SOURCE_TIME_INVALID"


class _Result:
    def __init__(self, rows: list[dict], rowcount: int = 0, scalar: object = None) -> None:
        self._rows = rows
        self.rowcount = rowcount
        self._scalar = scalar

    def mappings(self) -> "_Result":
        return self

    def first(self) -> dict | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[dict]:
        return self._rows

    def scalar(self) -> object:
        return self._scalar


class _Nested:
    async def __aenter__(self) -> "_Nested":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _FakeSession:
    """Answers the ingest queries by SQL fragment; records every statement."""

    def __init__(self, responses: list[tuple[str, list[dict]]]) -> None:
        self.responses = responses
        self.statements: list[str] = []
        self.info: dict = {}

    def begin_nested(self) -> _Nested:
        return _Nested()

    async def execute(self, statement: object, params: dict | None = None) -> _Result:
        sql = str(statement)
        self.statements.append(sql)
        if "to_regclass" in sql:
            return _Result([], scalar="exists")
        for fragment, rows in self.responses:
            if fragment in sql:
                return _Result(rows, rowcount=len(rows))
        return _Result([])


def test_ingest_batch_flow_with_frozen_source_time() -> None:
    from unittest.mock import AsyncMock, patch
    from uuid import uuid4

    from factorix.modules import telemetry

    tenant, edge, signal, resource, connection, field = (uuid4() for _ in range(6))
    binding = {
        "signal_id": signal,
        "valid_from": datetime.now(timezone.utc) - timedelta(minutes=1),
        "valid_to": None,
        "resource_id": resource,
        "expected_interval_ms": 1000,
        "site_id": None,
        "connection_id": connection,
        "source_field_id": field,
        "nullable": False,
    }
    session = _FakeSession(
        [
            ("FROM edge_nodes WHERE id", [{"enrollment_status": "ENROLLED"}]),
            ("FROM configuration_releases", [{"revision": 4}]),
            ("FROM signal_bindings b", [binding]),
            ("FROM formula_dependencies d", []),
            ("INSERT INTO ingest_dedup", [{"event_uid": "x"}]),
            ("INSERT INTO latest_signal_state", [{"signal_id": signal}]),
            ("WITH prev AS", [{"id": connection, "health": "HEALTHY", "old_health": "UNKNOWN", "last_error": None, "last_success_at": None}]),
        ]
    )
    received = datetime.now(timezone.utc).isoformat()
    item = {
        "event_uid": "u-1",
        "resource_id": str(resource),
        "signal_id": str(signal),
        "connection_id": str(connection),
        "received_time": received,
        "source_time": "2026-01-01T00:00:00.000Z",  # value frozen for months: still accepted, GOOD
        "value": 5,
        "data_type": "int64",
        "quality": "GOOD",
        "config_revision": 4,
    }
    hook = AsyncMock()
    with patch.object(telemetry.models_engine, "on_signals_changed", hook):
        result = asyncio.run(telemetry.ingest_observations(session, tenant_id=tenant, edge_id=edge, items=[item, {**item, "event_uid": ""}]))
    assert [r["status"] for r in result["results"]] == ["committed", "quarantined"]
    hook.assert_awaited_once()
    assert hook.await_args.args[2] == {signal}
    kinds = [event["kind"] for event in session.info["fx_events"]]
    assert kinds == ["latest", "health"]
    latest = session.info["fx_events"][0]["payload"]
    assert latest["effective_status"] == "GOOD" and latest["source_time"] == "2026-01-01T00:00:00.000Z"
    assert not any("output_deliveries" in sql for sql in session.statements)
    assert any("SAVEPOINT fx_models" in sql for sql in session.statements)


def test_heartbeat_applies_connection_states_and_emits_health() -> None:
    from uuid import uuid4

    from factorix.modules import edge_sync

    tenant, edge, conn = uuid4(), uuid4(), uuid4()
    now = datetime.now(timezone.utc)
    edge_row = {"id": edge, "enrollment_status": "ENROLLED", "health": "OFFLINE", "last_heartbeat": now - timedelta(minutes=5), "desired_revision": 2, "active_revision": 2}
    fresh_row = {**edge_row, "health": "ACTIVE", "last_heartbeat": now, "queues_json": {}}
    session = _FakeSession([])

    async def execute(statement: object, params: dict | None = None) -> _Result:
        sql = str(statement)
        session.statements.append(sql)
        if "FROM edge_nodes WHERE id = :id FOR UPDATE" in sql:
            return _Result([edge_row])
        if "FROM edge_nodes WHERE id" in sql:
            return _Result([fresh_row])
        if "FROM connections" in sql:
            return _Result([{"id": conn, "status": "ACTIVE", "health": "HEALTHY", "last_error": None, "last_success_at": now - timedelta(seconds=10)}])
        if "count(DISTINCT b.signal_id)" in sql:
            return _Result([{"connection_id": conn, "active_bindings": 8}])
        return _Result([], rowcount=1)

    session.execute = execute  # type: ignore[method-assign]
    body = {"health": "ACTIVE", "connections": {str(conn): {"state": "DOWN", "last_error_code": "ECONNREFUSED", "last_error": "Connection refused"}, "bad-key": {"state": "UP"}}}
    result = asyncio.run(edge_sync.heartbeat(session, {"id": edge, "tenant_id": tenant}, body))
    assert result["effective_health"] == "ONLINE"
    events = session.info["fx_events"]
    assert [(e["payload"]["entity"], e["payload"]["effective_health"]) for e in events] == [("edge", "ONLINE"), ("connection", "DEGRADED")]
    assert events[1]["payload"]["last_error"] == "ECONNREFUSED: Connection refused"
    assert any("CONNECTION_DEGRADED" in str(sql) or "INSERT INTO audit_events" in sql for sql in session.statements)


def test_connected_but_silent_source_does_not_flap() -> None:
    degraded = {"status": "ACTIVE", "health": "DEGRADED", "last_error": no_data_message(1000), "last_success_at": NOW - timedelta(minutes=2)}
    assert apply_connection_report(degraded, {"state": "UP", "last_ok_at": (NOW - timedelta(minutes=2)).isoformat()}, NOW) is None
    recovered = apply_connection_report(degraded, {"state": "UP", "last_ok_at": (NOW - timedelta(seconds=1)).isoformat()}, NOW)
    assert recovered is not None and recovered.health == "HEALTHY" and recovered.last_error is None
