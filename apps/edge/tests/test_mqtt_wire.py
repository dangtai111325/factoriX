"""Check stored MQTT settings against actual CONNECT/SUBSCRIBE packets."""

import asyncio

import httpx
import pytest

from factorix.modules.protocols import accept_connection, parse_config
from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


@pytest.mark.asyncio
@pytest.mark.parametrize("version,clean,qos", [("3.1.1", True, 0), ("3.1.1", False, 2), ("5.0", True, 0), ("5.0", False, 2)])
async def test_console_mqtt_parameters_reach_the_broker(mqtt_broker, tmp_path, version, clean, qos):
    with mqtt_broker() as broker:
        protocol, raw, _ = accept_connection("mqtt_client", {
            "host": "127.0.0.1", "port": broker["port"], "anonymous": True,
            "topics": ["factory/#"], "protocol_version": version,
            "qos": qos, "keepalive": 17, "clean_session": clean,
            "session_expiry": 120 if version == "5.0" else 0, "client_id": "wire-reader",
        })
        config = parse_config(protocol, raw)
        async with httpx.AsyncClient() as client:
            outbox = Outbox(tmp_path / "outbox.sqlite")
            runtime = EdgeRuntime(client, "test-only", [f"127.0.0.1:{broker['port']}"], outbox)
            fields = [{"id": "employee", "address_json": {"topic": "factory/#", "jsonpath": "$.employee"}}]
            rows = []
            try:
                for _ in range(100):
                    rows += await runtime._read_mqtt({"id": "wire-connection"}, config, fields)
                    if rows:
                        break
                    await asyncio.sleep(0.01)
            finally:
                for connector in runtime._mqtt.values():
                    connector.close()
                outbox.close()
        assert [(row[1], row[2]) for row in rows] == [("0021113185", "GOOD")]
        connect = broker["connect"]
        assert connect[6] == (5 if version == "5.0" else 4)
        assert bool(connect[7] & 2) is clean
        assert int.from_bytes(connect[8:10], "big") == 17
        assert broker["subscribe"][-1] == qos
        if version == "5.0":
            assert b"\x11\x00\x00\x00\x78" in connect[10:]  # Session Expiry Interval = 120 seconds.
