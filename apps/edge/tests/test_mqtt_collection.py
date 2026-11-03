"""Regressions for wildcard collection, latest sampling and source provenance."""

import json
from datetime import datetime, timezone

import httpx
import paho.mqtt.client as mqtt
import pytest

from factorix.domain.network import AllowedEndpoint
from factorix_edge.connectors.mqtt import MqttConnector
from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


@pytest.fixture
def subscriber(monkeypatch):
    connector = MqttConnector("127.0.0.1", 1883, [AllowedEndpoint("127.0.0.1", 1883)], "test-reader")
    # Only the external socket/thread boundary is replaced. Real callbacks decode and queue messages.
    monkeypatch.setattr(connector.client, "connect", lambda *args, **kwargs: 0)
    monkeypatch.setattr(connector.client, "loop_start", lambda: None)
    monkeypatch.setattr(connector.client, "loop_stop", lambda: None)
    monkeypatch.setattr(connector.client, "disconnect", lambda: None)
    connector.start([("factory/#", 1)])
    yield connector
    connector.close()


def deliver(connector, topic, payload):
    message = mqtt.MQTTMessage(topic=topic.encode())
    message.payload = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    connector.client.on_message(connector.client, None, message)


def field(key, topic, path):
    return {"id": key, "acquisition_job_id": "job-1", "address_json": {"topic": topic, "jsonpath": path}}


@pytest.fixture
def runtime(subscriber, tmp_path):
    outbox = Outbox(tmp_path / "outbox.sqlite")
    client = httpx.AsyncClient()
    instance = EdgeRuntime(client, "test-only", [], outbox)
    instance._mqtt["connection-1"] = subscriber
    yield instance
    outbox.close()


@pytest.mark.asyncio
async def test_wildcard_messages_only_update_fields_of_their_topic(subscriber, runtime):
    deliver(subscriber, "factory/m1/state", {"status": 2})
    deliver(subscriber, "factory/m1/process", {"speed": 1042.37})
    deliver(subscriber, "factory/m1/energy", {"power": 3.842})
    rows = await runtime._read_mqtt({"id": "connection-1"}, {"topics": ["factory/#"]}, [
        field("status", "factory/+/state", "$.status"),
        field("speed", "factory/m1/process", "$.speed"),
        field("power", "factory/m1/energy", "$.power"),
    ])
    assert {row[0]: (row[1], row[2]) for row in rows} == {
        "status": (2, "GOOD"), "speed": (1042.37, "GOOD"), "power": (3.842, "GOOD"),
    }


@pytest.mark.asyncio
async def test_latest_topic_value_replaces_intermediate_samples(subscriber, runtime):
    for speed in [100, 200, 300]:
        deliver(subscriber, "factory/m1/process", {"speed": speed})
    rows = await runtime._read_mqtt({"id": "connection-1"}, {"topics": ["factory/#"]}, [field("speed", "factory/m1/process", "$.speed")])
    assert [(row[0], row[1], row[2]) for row in rows] == [("speed", 300, "GOOD")]


@pytest.mark.asyncio
@pytest.mark.parametrize("times", [
    ["2026-11-02T01:45:12Z", "2026-11-02T01:45:12.100Z"],
    ["2026-11-02T01:45:12.100Z", "2026-11-02T01:45:12Z"],
])
async def test_source_time_order_is_chronological_across_fractional_seconds(subscriber, runtime, times):
    for stamp in times:
        deliver(subscriber, "factory/m1/process", {"speed": 101 if ".100" in stamp else 100, "source_timestamp": stamp})
    rows = await runtime._read_mqtt({"id": "connection-1"}, {"topics": ["factory/#"]}, [field("speed", "factory/m1/process", "$.speed")])
    assert rows[0].value == 101


@pytest.mark.asyncio
async def test_decode_failure_does_not_poison_later_valid_topic_data(subscriber, runtime):
    deliver(subscriber, "factory/m1/state", b"not-json")
    deliver(subscriber, "factory/m1/process", {"speed": 42})
    rows = await runtime._read_mqtt({"id": "connection-1"}, {"topics": ["factory/#"]}, [field("speed", "factory/m1/process", "$.speed")])
    assert [(row[0], row[1], row[2]) for row in rows] == [("speed", 42, "GOOD")]


@pytest.mark.asyncio
async def test_missing_field_is_not_a_bad_sample_but_explicit_null_is_a_sample(subscriber, runtime):
    deliver(subscriber, "factory/m1/state", {"stop_error": None, "employee": "0021113185", "running": False, "qty": 0})
    rows = await runtime._read_mqtt({"id": "connection-1"}, {"topics": ["factory/#"]}, [
        field("missing", "factory/m1/state", "$.absent"),
        field("stop_error", "factory/m1/state", "$.stop_error"),
        field("employee", "factory/m1/state", "$.employee"),
        field("running", "factory/m1/state", "$.running"),
        field("qty", "factory/m1/state", "$.qty"),
    ])
    assert {row[0]: (row[1], row[2]) for row in rows} == {
        "stop_error": (None, "GOOD"), "employee": ("0021113185", "GOOD"),
        "running": (False, "GOOD"), "qty": (0, "GOOD"),
    }


@pytest.mark.asyncio
async def test_source_timestamp_survives_collection_into_outbox(subscriber, runtime):
    deliver(subscriber, "factory/m1/process", {"speed": 42, "source_timestamp": "2026-11-02T01:45:12Z"})
    snapshot = {
        "connections": [{"id": "connection-1", "protocol": "mqtt", "status": "ACTIVE", "config_json": {"topics": ["factory/#"]}}],
        "jobs": [{"id": "job-1", "connection_id": "connection-1", "enabled": True, "mode": "SUBSCRIBE", "interval_ms": 1000}],
        "source_fields": [field("speed", "factory/m1/process", "$.speed")],
        "signal_bindings": [{"source_field_id": "speed", "resource_id": "machine-1", "signal_id": "signal-1", "data_type": "float64"}],
    }
    assert await runtime._collect(snapshot, 1) == 1
    observation = json.loads(runtime.outbox.pending(1)[0]["payload"])
    assert observation["source_time"] == "2026-11-02T01:45:12Z"
    assert observation["event_time"] == "2026-11-02T01:45:12Z"
    assert observation["provenance"]["topic"] == "factory/m1/process"
    assert datetime.fromisoformat(observation["received_time"].replace("Z", "+00:00")).tzinfo == timezone.utc
