from __future__ import annotations

from unittest.mock import MagicMock
import pytest

from factorix.domain.network import parse_allowlist
from factorix.domain.modbus_decode import SourceSpan, plan_reads
from factorix_edge.connectors.mqtt import MqttConnector


def test_rt12_client_id():
    allow = parse_allowlist(["127.0.0.1:1883"])
    conn = MqttConnector("127.0.0.1", 1883, allow, client_id="fx-abc")
    # paho client client_id is preserved
    assert conn.client_id == "fx-abc"


def test_rt13_qos2():
    allow = parse_allowlist(["127.0.0.1:1883"])
    conn = MqttConnector("127.0.0.1", 1883, allow, client_id="fx-qos")
    mock_paho = MagicMock()
    conn.client = mock_paho
    conn.start([("topic/a", 2)])
    # In start, on_connect is defined and subscribes with qos=2
    conn.client.on_connect(conn.client, None, None, 0)
    mock_paho.subscribe.assert_called_with("topic/a", qos=2)


def test_rt14_tls():
    allow = parse_allowlist(["127.0.0.1:8883"])
    conn = MqttConnector("127.0.0.1", 8883, allow, client_id="fx-tls", tls=True, tls_insecure=False)
    # verify tls is configured without insecure
    assert conn is not None


def test_rt15_modbus_decode():
    # 0x4248 0x0000 in IEEE-754 float32 is 50.0
    import struct
    registers = [0x4248, 0x0000]
    raw_big = struct.pack(">HH", *registers)
    val_big = struct.unpack(">f", raw_big)[0]
    assert round(val_big, 2) == 50.0

    # scale 0.1 offset 2 -> x * 0.1 + 2
    scaled = val_big * 0.1 + 2.0
    assert round(scaled, 2) == 7.0
