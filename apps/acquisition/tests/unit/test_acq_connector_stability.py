"""WS-Q: connector stability — Modbus endpoint scheduler, OPC UA session reset policy, MQTT session."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from asyncua import ua

from factorix.domain.modbus_decode import plan_reads
from factorix_acquisition.connectors.errors import ConnectorError
from factorix_acquisition.connectors.modbus import EndpointScheduler, endpoint_scheduler
from factorix_acquisition.connectors.mqtt import MqttConnector
from factorix_acquisition.connectors.opcua import OpcUaConnector
from factorix_acquisition.jobs import build_specs, connection_fingerprint, modbus_fields, read_modbus
from factorix.domain.network import parse_allowlist


# --------------------------------------------------------------------------- Modbus


@pytest.mark.asyncio
async def test_scheduler_is_fifo_with_priority_lane_and_measures_wait() -> None:
    sched = EndpointScheduler()
    order: list[str] = []

    async def use(name: str, hold: float, priority: bool = False) -> float:
        async with sched.slot(priority=priority) as waited:
            order.append(name)
            await asyncio.sleep(hold)
            return waited

    first = asyncio.create_task(use("job-1", 0.1))
    await asyncio.sleep(0.01)
    second = asyncio.create_task(use("job-2", 0.0))
    await asyncio.sleep(0.01)
    test = asyncio.create_task(use("test-read", 0.0, priority=True))
    waits = await asyncio.gather(first, second, test)
    assert order == ["job-1", "test-read", "job-2"]
    assert waits[0] == pytest.approx(0.0, abs=0.02) and waits[2] > 0.05
    assert not sched.locked() and sched.queued == 0


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_wedge_the_endpoint() -> None:
    sched = endpoint_scheduler("10.0.0.9", 502)
    await sched.acquire()
    waiter = asyncio.create_task(sched.acquire())
    await asyncio.sleep(0.01)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    sched.release()
    assert not sched.locked()
    async with sched:
        assert sched.locked()


class _UnitDevice:
    """Unit 13 is dead (times out), the others answer."""

    def __init__(self) -> None:
        self.requests: list[int] = []

    async def read_raw(self, block):  # noqa: ANN001
        self.requests.append(block.unit_id)
        if block.unit_id == 13:
            raise ConnectorError("TIMEOUT", "Modbus unit 13 did not answer within 3 s.")
        return [1] * block.count


@pytest.mark.asyncio
async def test_dead_unit_costs_one_timeout_per_cycle_and_other_units_still_read() -> None:
    fields = []
    for unit in (11, 13):
        for offset in (0, 100, 200):  # three non-mergeable blocks per unit
            fields.append({"id": f"u{unit}-{offset}", "address_json": {"unit_id": unit, "offset": offset, "native_type": "uint16"}, "decode_json": {}})
    items, bad = modbus_fields(fields, {}, key_by=lambda f: str(f["id"]))
    assert not bad and len(plan_reads([i.span for i in items], allow_gap=16)) == 6
    device = _UnitDevice()
    samples = await read_modbus(device, items, merge_gap=16)  # type: ignore[arg-type]
    assert device.requests.count(13) == 1, "the dead unit must be asked once per cycle"
    good = {s.field_id for s in samples if s.quality == "GOOD"}
    assert good == {"u11-0", "u11-100", "u11-200"}
    assert all(s.reason == "TIMEOUT" for s in samples if s.field_id.startswith("u13"))


# --------------------------------------------------------------------------- OPC UA


class _UaClientState:
    def __init__(self, connected: bool) -> None:
        from asyncua.client.ua_client import UaClientState

        self.state = UaClientState.CONNECTED if connected else UaClientState.DISCONNECTED


class _FakeClient:
    def __init__(self, connected: bool = True) -> None:
        self.uaclient = _UaClientState(connected)


def test_opcua_single_timeout_or_service_fault_keeps_the_session() -> None:
    conn = OpcUaConnector("opc.tcp://127.0.0.1:4840", parse_allowlist(["127.0.0.1:4840"]))
    conn.client = _FakeClient()  # type: ignore[assignment]
    assert conn._session_broken(ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)) is False
    assert conn._session_broken(asyncio.TimeoutError()) is False
    assert conn._session_broken(asyncio.TimeoutError()) is True  # second timeout in a row
    conn._read_timeouts = 0
    assert conn._session_broken(ConnectionResetError()) is True
    conn.client = _FakeClient(connected=False)  # type: ignore[assignment]
    assert conn._session_broken(ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)) is True


# --------------------------------------------------------------------------- MQTT


def _mqtt_connection(config: dict[str, Any]) -> dict[str, Any]:
    return {"id": "c1", "protocol": "mqtt", "status": "ACTIVE", "config_json": config, "secret_ref": None}


def test_topic_edit_does_not_reconnect_mqtt_but_restarts_the_job() -> None:
    base = {"host": "192.168.2.108", "port": 1883, "topics": ["factory/a/+"], "qos": 1}
    edited = dict(base, topics=["factory/a/+", "factory/b/+"])
    assert connection_fingerprint(_mqtt_connection(base)) == connection_fingerprint(_mqtt_connection(edited))
    assert connection_fingerprint(_mqtt_connection(base)) != connection_fingerprint(_mqtt_connection(dict(base, port=1884)))

    def snap(config: dict[str, Any]) -> dict[str, Any]:
        return {
            "connections": [_mqtt_connection(config)],
            "jobs": [{"id": "j1", "connection_id": "c1", "enabled": True, "mode": "SUBSCRIBE", "interval_ms": 1000}],
            "source_fields": [{"id": "f1", "acquisition_job_id": "j1", "address_json": {"jsonpath": "$.v"}, "native_datatype": "float64", "decode_json": {}}],
            "signal_bindings": [{"source_field_id": "f1", "signal_id": "s1", "resource_id": "r1", "data_type": "float64"}],
        }

    assert build_specs(snap(base))["j1"].fingerprint != build_specs(snap(edited))["j1"].fingerprint


def test_mqtt_tracks_down_since_and_reconnect_counters() -> None:
    conn = MqttConnector("127.0.0.1", 1883, parse_allowlist(["127.0.0.1:1883"]), "fx-test", clean_session=False)
    assert conn.state == "DOWN" and conn.down_since is not None
    conn._connected(0, "Success", True)
    assert conn.state == "UP" and conn.down_since is None and conn.session_present is True and conn.connects == 1
    conn._set_down("NETWORK", "MQTT connection lost (Keep alive timeout).")
    assert conn.state == "DOWN" and conn.down_since is not None and conn.disconnects == 1
    assert conn.client._clean_session is False  # persistent session: broker queues QoS 1 while away
