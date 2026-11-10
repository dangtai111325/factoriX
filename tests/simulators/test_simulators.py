"""Smoke tests proving all 5 isolated OT simulators respond with valid telemetry and controllable faults."""

from __future__ import annotations

import asyncio
import pytest

from factorix.domain.modbus_decode import SourceSpan, plan_reads
from factorix.domain.network import parse_allowlist
from factorix_edge.connectors.http_pull import HttpPullConnector
from factorix_edge.connectors.modbus import ModbusConnector
from factorix_edge.connectors.mqtt import MqttConnector, capture as mqtt_capture
from factorix_edge.connectors.opcua import OpcUaConnector
from factorix_edge.connectors.ws import WebSocketConnector
from tests.simulators import SimulatorSuite


@pytest.mark.asyncio
async def test_all_five_simulators_and_fault_toggles() -> None:
    suite = SimulatorSuite(host="127.0.0.1", control_port=0, tick_interval_s=0.1)
    ep = await suite.start()
    allow = parse_allowlist([
        f"127.0.0.1:{ep.modbus_port}",
        ep.opcua_endpoint,
        f"mqtt://127.0.0.1:{ep.mqtt_port}",
        ep.http_base_url,
        ep.ws_url,
    ])
    try:
        # 1. Modbus TCP
        mb = ModbusConnector("127.0.0.1", ep.modbus_port, timeout_s=2.0)
        blk = plan_reads([
            SourceSpan("status", "holding", 100, 1, 1, "g1", native_type="uint16"),
            SourceSpan("mode", "holding", 101, 1, 1, "g1", native_type="uint16"),
        ])[0]
        rows = await mb.read_block(blk)
        await mb.close()
        assert len(rows) == 2 and rows[0]["value"] in {2, 3}

        # 2. OPC UA + fault status Bad -> Good
        opc = OpcUaConnector(ep.opcua_endpoint, allow, timeout_s=4.0)
        vals = await opc.read_values(["ns=2;s=MachineTemp1"])
        assert vals[0]["quality"] == "GOOD" and isinstance(vals[0]["value"], float)
        suite.apply_fault("opcua", "status_mode", "Bad")
        await suite.opcua.step_values()
        bad_vals = await opc.read_values(["ns=2;s=MachineTemp1"])
        assert bad_vals[0]["quality"] == "BAD"
        await opc.close()

        # 3. MQTT
        mq = MqttConnector("127.0.0.1", ep.mqtt_port, allow, "sim-test-client")
        msgs = await mqtt_capture(mq, "factory/sim/+/condition", seconds=1.0, max_messages=1)
        await mq.close()
        assert len(msgs) == 1 and "temperature" in msgs[0][1]

        # 4. HTTP + simulated 429
        hp = HttpPullConnector(ep.http_base_url, allow, timeout_s=2.0)
        doc = await hp.get_json("/api/v1/machines/SIM-01/telemetry")
        assert doc["machine_id"] == "SIM-01"
        suite.apply_fault("http", "status_override", 500)
        with pytest.raises(Exception):
            await hp.get_json("/api/v1/machines/SIM-01/telemetry")
        await hp.close()

        # 5. WebSocket
        ws = WebSocketConnector(ep.ws_url, allow, timeout_s=2.0)
        await ws.start()
        await ws.wait_connected(2.0)
        frame = await ws.next_frame(0, 2.0)
        await ws.close()
        assert frame is not None and "SIM-01" in frame.document["machines"]
    finally:
        await suite.stop()
