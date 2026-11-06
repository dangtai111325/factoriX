"""MQTT asyncio bridge, subscription diffing and message-to-field mapping."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from paho.mqtt.client import MQTTMessage

from factorix.domain.network import parse_allowlist
from factorix_edge.connectors.mqtt import MqttConnector
from factorix_edge.jobs import map_mqtt_messages

ALLOW = parse_allowlist(["127.0.0.1:1883"])
CONFIG = {"host": "127.0.0.1", "port": 1883, "topics": ["uns/#"]}


def _message(topic: str, payload: dict) -> MQTTMessage:
    msg = MQTTMessage(topic=topic.encode())
    msg.payload = json.dumps(payload).encode()
    return msg


def _field(fid: str, topic: str, path: str, **extra: object) -> dict:
    policy = extra.pop("delivery_policy", None)
    item = {"id": fid, "address_json": {"topic": topic, "jsonpath": path, **extra}}
    if policy:
        item["delivery_policy"] = policy
    return item


@pytest.mark.asyncio
async def test_on_message_reaches_listener_with_arrival_time() -> None:
    connector = MqttConnector("127.0.0.1", 1883, ALLOW, "test-bridge")
    connector._loop = asyncio.get_running_loop()
    listener = connector.add_listener(topics=["factory/+/condition"])
    other = connector.add_listener(topics=["other/#"])
    for i in range(3):
        connector.on_message(None, None, _message(f"factory/m{i}/condition", {"v": i}))
    connector.on_message(None, None, MQTTMessage(topic=b"factory/x/condition"))  # empty payload: not JSON
    await asyncio.sleep(0.01)
    items = listener.drain_nowait()
    assert [item[1]["v"] for item in items] == [0, 1, 2]
    assert [item[3] for item in items] == [json.dumps({"v": i}) for i in range(3)]  # text as received
    assert all(item[2].endswith("Z") and len(item[2]) == 24 for item in items)
    assert other.drain_nowait() == []
    assert connector.decode_errors == 1
    assert connector.last_message_at == items[-1][2]


@pytest.mark.asyncio
async def test_listener_drops_oldest_when_full() -> None:
    connector = MqttConnector("127.0.0.1", 1883, ALLOW, "test-cap")
    connector._loop = asyncio.get_running_loop()
    listener = connector.add_listener(maxsize=10)
    for i in range(15):
        connector.on_message(None, None, _message(f"t/{i}", {"i": i}))
    await asyncio.sleep(0.01)
    assert listener.dropped == 5
    assert [item[1]["i"] for item in listener.drain_nowait()] == list(range(5, 15))


@pytest.mark.asyncio
async def test_topic_set_changes_without_rebuilding_client() -> None:
    connector = MqttConnector("127.0.0.1", 1883, ALLOW, "fx-qos")
    connector.client = MagicMock()
    connector._loop = asyncio.get_running_loop()
    connector._connected_event = asyncio.Event()
    connector.set_topics("job1", [("a/1", 2)])
    connector.client.subscribe.assert_not_called()  # not connected yet
    connector._connected(0, "Success")  # CONNACK: subscribe the current set
    connector.client.subscribe.assert_called_with([("a/1", 2)])
    connector.set_topics("job2", [("a/2", 1)])
    connector.client.subscribe.assert_called_with([("a/2", 1)])
    connector.set_topics("job1", [])
    connector.client.unsubscribe.assert_called_with(["a/1"])
    assert connector.wanted_topics() == {"a/2": 1}


@pytest.mark.asyncio
async def test_auth_failure_is_reported() -> None:
    connector = MqttConnector("127.0.0.1", 1883, ALLOW, "fx-auth")
    connector._loop = asyncio.get_running_loop()
    connector._connected_event = asyncio.Event()
    connector._connected(135, "Not authorized")
    assert connector.state == "AUTH_FAILED" and connector.last_error_code == "AUTH"
    connector._set_down("NETWORK", "lost")
    assert connector.state == "AUTH_FAILED"


def test_all_events_keeps_every_message_in_order() -> None:
    messages = [("uns/s/m1/count", {"counter": i, "source_timestamp": f"2026-11-05T01:00:0{i}Z"}, f"2026-11-06T00:00:0{i}.000Z") for i in (1, 2, 3)]
    events, latest = map_mqtt_messages([_field("f", "uns/s/m1/count", "$.counter", delivery_policy="ALL_EVENTS")], CONFIG, messages)
    assert latest == {}
    assert [s.value for s in events] == [1, 2, 3]
    assert [s.source_time for s in events] == ["2026-11-05T01:00:01.000Z", "2026-11-05T01:00:02.000Z", "2026-11-05T01:00:03.000Z"]
    assert [s.received_time for s in events] == [m[2] for m in messages]  # arrival time, not processing time


def test_latest_only_coalesces_to_newest() -> None:
    messages = [("uns/s/m1/temp", {"temperature": t}, "r") for t in (25.1, 25.4, 25.8)]
    events, latest = map_mqtt_messages([_field("f", "uns/s/m1/temp", "$.temperature")], CONFIG, messages)
    assert events == [] and latest["f"].value == 25.8 and latest["f"].quality == "GOOD"


def test_routing_by_topic_and_wildcards() -> None:
    fields = [
        _field("m1", "factory/assy/M1/condition", "$.noise"),
        _field("m2", "factory/assy/+/condition", "$.noise"),
    ]
    events, latest = map_mqtt_messages(fields, CONFIG, [("factory/assy/M2/condition", {"noise": 60.3}, "r")])
    assert "m1" not in latest
    assert latest["m2"].value == 60.3


def test_missing_skip_vs_bad() -> None:
    messages = [("uns/m1/status", {"other": 1}, "r")]
    _, skip = map_mqtt_messages([_field("s", "uns/m1/status", "$.status", missing="SKIP")], CONFIG, messages)
    assert skip == {}
    _, bad = map_mqtt_messages([_field("b", "uns/m1/status", "$.status", missing="BAD")], CONFIG, messages)
    assert bad["b"].quality == "BAD" and bad["b"].reason == "FIELD_MISSING"


def test_latest_only_throttle_is_per_field_not_per_job() -> None:
    """R2-SG-01: a second machine's message is not held back by the first machine's emit slot."""
    from factorix_edge.jobs import FieldThrottle
    from factorix_edge.mapping import Sample

    def sample(fid: str, value: int) -> Sample:
        return Sample(fid, value, "GOOD", None, None, "2026-11-06T08:00:00.000Z")

    throttle = FieldThrottle(1.0)
    throttle.offer({"m1.temp": sample("m1.temp", 1)})
    assert [s.value for s in throttle.due(0.0)] == [1]
    throttle.offer({"m2.temp": sample("m2.temp", 2)})  # other machine, 0.3 s later
    assert [s.field_id for s in throttle.due(0.3)] == ["m2.temp"]
    throttle.offer({"m1.temp": sample("m1.temp", 3)})  # same field again within its interval: held
    assert throttle.due(0.5) == [] and throttle.wait(0.5) == pytest.approx(0.5)
    throttle.offer({"m1.temp": sample("m1.temp", 4)})  # newest wins while held
    assert [s.value for s in throttle.due(1.0)] == [4]
    assert throttle.wait(1.0) is None
