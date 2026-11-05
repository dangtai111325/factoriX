"""Unit tests for MQTT event fidelity and delivery policy (R4-10 / S2.1)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock
import pytest

from factorix_edge.runtime import EdgeRuntime


@pytest.mark.asyncio
async def test_mqtt_all_events_preserves_all_messages_in_arrival_order() -> None:
    """MQTT-03: Under ALL_EVENTS, every matching message in arrival order is emitted."""
    outbox = MagicMock()
    runtime = EdgeRuntime(MagicMock(), "cred", ["127.0.0.1:1883"], outbox)
    mock_mqtt = MagicMock()
    runtime._mqtt["c1"] = mock_mqtt

    connection = {"id": "c1", "protocol": "mqtt"}
    config = {"host": "127.0.0.1", "port": 1883, "topics": ["uns/#"]}

    # 3 messages arrived in order: counter=1, counter=2, counter=3
    mock_mqtt.drain.return_value = [
        ("uns/site1/m1/count", {"counter": 1, "source_timestamp": "2026-11-05T01:00:01Z"}),
        ("uns/site1/m1/count", {"counter": 2, "source_timestamp": "2026-11-05T01:00:02Z"}),
        ("uns/site1/m1/count", {"counter": 3, "source_timestamp": "2026-11-05T01:00:03Z"}),
    ]

    field = {
        "id": "f_counter",
        "delivery_policy": "ALL_EVENTS",
        "address_json": {"topic": "uns/site1/m1/count", "jsonpath": "$.counter"},
    }

    res = await runtime._read_mqtt(connection, config, [field])
    assert len(res) == 3
    assert res[0][1] == 1
    assert res[0][3] == "2026-11-05T01:00:01Z"
    assert res[1][1] == 2
    assert res[1][3] == "2026-11-05T01:00:02Z"
    assert res[2][1] == 3
    assert res[2][3] == "2026-11-05T01:00:03Z"


@pytest.mark.asyncio
async def test_mqtt_latest_only_coalesces_to_newest_message() -> None:
    """MQTT-04: Under LATEST_ONLY (default), messages coalesce to the newest sample."""
    outbox = MagicMock()
    runtime = EdgeRuntime(MagicMock(), "cred", ["127.0.0.1:1883"], outbox)
    mock_mqtt = MagicMock()
    runtime._mqtt["c1"] = mock_mqtt

    connection = {"id": "c1", "protocol": "mqtt"}
    config = {"host": "127.0.0.1", "port": 1883, "topics": ["uns/#"]}

    mock_mqtt.drain.return_value = [
        ("uns/site1/m1/temp", {"temperature": 25.1}),
        ("uns/site1/m1/temp", {"temperature": 25.4}),
        ("uns/site1/m1/temp", {"temperature": 25.8}),
    ]

    field = {
        "id": "f_temp",
        "delivery_policy": "LATEST_ONLY",
        "address_json": {"topic": "uns/site1/m1/temp", "jsonpath": "$.temperature"},
    }

    res = await runtime._read_mqtt(connection, config, [field])
    assert len(res) == 1
    assert res[0][0] == "f_temp"
    assert res[0][1] == 25.8
    assert res[0][2] == "GOOD"


@pytest.mark.asyncio
async def test_mqtt_wrong_topic_no_cross_machine_mixup() -> None:
    """MQTT-01: Messages for machine 2 are never mapped to machine 1 field."""
    outbox = MagicMock()
    runtime = EdgeRuntime(MagicMock(), "cred", ["127.0.0.1:1883"], outbox)
    mock_mqtt = MagicMock()
    runtime._mqtt["c1"] = mock_mqtt

    connection = {"id": "c1", "protocol": "mqtt"}
    config = {"host": "127.0.0.1", "port": 1883, "topics": ["uns/#"]}

    mock_mqtt.drain.return_value = [
        ("uns/site1/m2/temp", {"temperature": 99.9}),
    ]

    field_m1 = {
        "id": "f_m1_temp",
        "delivery_policy": "ALL_EVENTS",
        "address_json": {"topic": "uns/site1/m1/temp", "jsonpath": "$.temperature"},
    }

    res = await runtime._read_mqtt(connection, config, [field_m1])
    assert len(res) == 0


@pytest.mark.asyncio
async def test_mqtt_missing_strategy_skip_vs_bad() -> None:
    """MQTT-06: missing SKIP produces 0 observations; missing BAD produces FIELD_MISSING."""
    outbox = MagicMock()
    runtime = EdgeRuntime(MagicMock(), "cred", ["127.0.0.1:1883"], outbox)
    mock_mqtt = MagicMock()
    runtime._mqtt["c1"] = mock_mqtt

    connection = {"id": "c1", "protocol": "mqtt"}
    config = {"host": "127.0.0.1", "port": 1883, "topics": ["uns/#"]}

    mock_mqtt.drain.return_value = [
        ("uns/site1/m1/status", {"other_key": 123}),
    ]

    field_skip = {
        "id": "f_skip",
        "address_json": {"topic": "uns/site1/m1/status", "jsonpath": "$.status", "missing": "SKIP"},
    }
    res_skip = await runtime._read_mqtt(connection, config, [field_skip])
    assert len(res_skip) == 0

    field_bad = {
        "id": "f_bad",
        "address_json": {"topic": "uns/site1/m1/status", "jsonpath": "$.status", "missing": "BAD"},
    }
    res_bad = await runtime._read_mqtt(connection, config, [field_bad])
    assert len(res_bad) == 1
    assert res_bad[0][0] == "f_bad"
    assert res_bad[0][1] is None
    assert res_bad[0][2] == "BAD"
    assert res_bad[0][4] == "FIELD_MISSING"
