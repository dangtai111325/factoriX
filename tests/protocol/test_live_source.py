"""Read-only checks against the approved datasource guide. No writes, no secrets in assertions output."""

from __future__ import annotations

import json
import threading
from pathlib import Path

import httpx
import pytest

GUIDE = Path(r"C:\Users\Ave-T14-001\Desktop\FactoriX\datasource_guide.md")
HOST = "192.168.2.108"


def _api_key() -> str:
    import re

    text = GUIDE.read_text(encoding="utf-8")
    match = re.search(r"X-API-Key:\s*`?([A-Za-z0-9-]+)`?", text)
    assert match is not None
    return match.group(1)


@pytest.mark.asyncio
async def test_ext_http_ready_and_state() -> None:
    async with httpx.AsyncClient(timeout=5) as client:
        ready = await client.get(f"http://{HOST}:8088/ready")
        assert ready.status_code == 200
        body = ready.json()
        assert body["status"] == "ready"
        assert isinstance(body["revision"], int)
        state = await client.get(
            f"http://{HOST}:8088/api/v1/machines/AA10-01/state",
            headers={"X-API-Key": _api_key()},
        )
        assert state.status_code == 200, state.text
        payload = state.json()
        assert payload["machine_name"] == "AA10-01"
        assert isinstance(payload["status"], int)
        assert "source_timestamp" in payload


@pytest.mark.asyncio
async def test_ext_modbus_status_and_temperature() -> None:
    from factorix.domain.modbus_decode import SourceSpan, plan_reads
    from factorix_edge.connectors.modbus import ModbusConnector

    connector = ModbusConnector(HOST, 1502, timeout_s=5)
    await connector.connect()
    try:
        status_blocks = plan_reads([SourceSpan("status", "holding", 0, 1, 1, "live", native_type="uint16")])
        status = await connector.read_block(status_blocks[0])
        assert isinstance(status[0]["value"], int)
        assert 0 <= int(status[0]["value"]) <= 6
        temp_blocks = plan_reads([SourceSpan("temp", "holding", 100, 2, 1, "live", native_type="float32")])
        temp = await connector.read_block(temp_blocks[0])
        assert isinstance(temp[0]["value"], float)
        assert 0 <= temp[0]["value"] <= 200
    finally:
        await connector.close()


@pytest.mark.asyncio
async def test_ext_opcua_browse_temperature() -> None:
    from asyncua import Client

    client = Client(url=f"opc.tcp://{HOST}:14840/factorix/factory/", timeout=8)
    await client.connect()
    try:
        node = client.nodes.objects
        for name in ["TIPA", "DongNai", "Factory-1", "ASSY", "Assembly-AA10-01-A1", "AA10-01", "Condition", "Temperature"]:
            found = None
            for child in await node.get_children():
                browse_name = await child.read_browse_name()
                if browse_name.Name == name:
                    found = child
                    break
            assert found is not None, name
            node = found
        value = await node.read_value()
        assert isinstance(value, (int, float))
    finally:
        await client.disconnect()


def test_ext_mqtt_state_message() -> None:
    import paho.mqtt.client as mqtt

    received: list[tuple[str, dict]] = []
    done = threading.Event()

    errors: list[str] = []

    def on_connect(client, userdata, flags, reason_code, properties=None):  # type: ignore[no-untyped-def]
        del userdata, flags, properties
        code = getattr(reason_code, "value", reason_code)
        if int(code) != 0:
            errors.append(f"connect {code}")
            done.set()
            return
        client.subscribe("uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-A1/AA10-01/state", qos=1)

    def on_message(client, userdata, message):  # type: ignore[no-untyped-def]
        del client, userdata
        received.append((message.topic, json.loads(message.payload.decode("utf-8"))))
        done.set()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="factorix-ext-read")
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(HOST, 18883, 10)
    client.loop_start()
    try:
        assert done.wait(12), "Không nhận được bản tin MQTT trong cửa sổ cho phép"
        assert not errors
    finally:
        client.loop_stop()
        client.disconnect()
    topic, payload = received[0]
    assert topic.endswith("/state")
    assert isinstance(payload["status"], int)
    assert "source_timestamp" in payload
    assert payload.get("machine_name") == "AA10-01"
