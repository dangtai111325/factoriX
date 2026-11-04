from __future__ import annotations

import json
from unittest.mock import MagicMock
import pytest
from paho.mqtt.client import MQTTMessage

from factorix.domain.network import parse_allowlist
from factorix_edge.connectors.mqtt import MqttConnector
from factorix_edge.runtime import EdgeRuntime


def test_rt01_save_topic():
    conn = MqttConnector("127.0.0.1", 1883, parse_allowlist(["127.0.0.1:1883"]), "test-c1")
    conn._started = True  # bypass network connect for unit test

    # Simulate 4 messages on 4 topics
    for i in range(4):
        msg = MQTTMessage(topic=f"topic/{i}".encode())
        msg.payload = json.dumps({"val": i}).encode()
        conn.client.on_message(conn.client, None, msg)

    drained = conn.drain(timeout_s=0.1)
    assert len(drained) == 4
    for i, (topic, payload) in enumerate(drained):
        assert topic == f"topic/{i}"
        assert payload == {"val": i}


def test_rt02_drain_all():
    conn = MqttConnector("127.0.0.1", 1883, parse_allowlist(["127.0.0.1:1883"]), "test-c2")
    conn._started = True

    for cycle in range(10):
        for i in range(4):
            msg = MQTTMessage(topic=f"topic/{i}".encode())
            msg.payload = json.dumps({"c": cycle, "i": i}).encode()
            conn.client.on_message(conn.client, None, msg)
        batch = conn.drain(timeout_s=0.05)
        assert len(batch) == 4
        assert conn.queue_length == 0


def test_rt03_queue_limit():
    conn = MqttConnector("127.0.0.1", 1883, parse_allowlist(["127.0.0.1:1883"]), "test-c3")
    conn._started = True
    conn._inbox = type(conn._inbox)(maxlen=10)

    for i in range(15):
        msg = MQTTMessage(topic=f"topic/{i}".encode())
        msg.payload = json.dumps({"idx": i}).encode()
        conn.client.on_message(conn.client, None, msg)

    assert conn.dropped == 5
    drained = conn.drain(timeout_s=0.05)
    assert len(drained) == 10
    assert drained[0][0] == "topic/5"
    assert drained[-1][0] == "topic/14"


@pytest.mark.asyncio
async def test_rt04_rt05_rt06_rt07_rt08():
    outbox = MagicMock()
    runtime = EdgeRuntime(MagicMock(), "cred", ["127.0.0.1:1883"], outbox)
    
    mock_mqtt = MagicMock()
    runtime._mqtt["c1"] = mock_mqtt

    connection = {"id": "c1", "protocol": "mqtt"}
    config = {"host": "127.0.0.1", "port": 1883, "topics": ["uns/#"]}

    # RT-04: field power on .../energy; message .../state (no power) + .../energy (power=1.33)
    # Expect: 1 observation power=1.33 GOOD; NO BAD observation
    mock_mqtt.drain.return_value = [
        ("uns/plant1/state", {"status": "RUNNING"}),
        ("uns/plant1/energy", {"power": 1.33}),
    ]

    field_power = {
        "id": "f_power",
        "address_json": {"topic": "uns/plant1/energy", "jsonpath": "$.power", "missing": "SKIP"},
    }
    field_state = {
        "id": "f_state",
        "address_json": {"topic": "uns/plant1/state", "jsonpath": "$.status", "missing": "SKIP"},
    }

    res = await runtime._read_mqtt(connection, config, [field_power])
    assert len(res) == 1
    assert res[0][0] == "f_power"
    assert res[0][1] == 1.33
    assert res[0][2] == "GOOD"

    # RT-05: only message .../state -> no observation for power
    mock_mqtt.drain.return_value = [("uns/plant1/state", {"status": "RUNNING"})]
    res_absent = await runtime._read_mqtt(connection, config, [field_power])
    assert len(res_absent) == 0

    # RT-06: missing: "BAD", message on correct topic but field missing
    mock_mqtt.drain.return_value = [("uns/plant1/energy", {"voltage": 220})]
    field_power_bad = {
        "id": "f_power",
        "address_json": {"topic": "uns/plant1/energy", "jsonpath": "$.power", "missing": "BAD"},
    }
    res_bad = await runtime._read_mqtt(connection, config, [field_power_bad])
    assert len(res_bad) == 1
    assert res_bad[0][2] == "BAD"
    assert res_bad[0][4] == "FIELD_MISSING"

    # RT-07: Wildcard match
    mock_mqtt.drain.return_value = [
        ("uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/energy", {"power": 42.0})
    ]
    field_wildcard = {
        "id": "f_wild",
        "address_json": {"topic": "uns/+/+/+/+/+/AA10-02/energy", "jsonpath": "$.power", "missing": "SKIP"},
    }
    res_wild = await runtime._read_mqtt(connection, config, [field_wildcard])
    assert len(res_wild) == 1
    assert res_wild[0][1] == 42.0

    # RT-08: Pick newest
    mock_mqtt.drain.return_value = [
        ("uns/plant1/energy", {"power": 1.0}),
        ("uns/plant1/energy", {"power": 2.0}),
        ("uns/plant1/energy", {"power": 3.0}),
    ]
    res_newest = await runtime._read_mqtt(connection, config, [field_power])
    assert len(res_newest) == 1
    assert res_newest[0][1] == 3.0
