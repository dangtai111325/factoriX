"""Modbus requests are serialised per device endpoint and an abandoned request drops the session
(R3 Modbus P1: "request ask for id=13 but got id=15", "received pdu without a corresponding
request", "No response received after 1 retries")."""

from __future__ import annotations

import asyncio

from factorix.domain.modbus_decode import ReadBlock
from factorix_edge.connectors.modbus import ModbusConnector, request_budget_s
from factorix_edge.jobs import JobSpec, modbus_cycle_budget_s, read_budget_s


class FakeResponse:
    def __init__(self, count: int) -> None:
        self.registers = [0] * count

    def isError(self) -> bool:  # noqa: N802 - pymodbus API
        return False


class FakeClient:
    """Records how many requests are in flight on the device at once (shared across sessions)."""

    in_flight = 0
    max_in_flight = 0

    def __init__(self, delay: float = 0.02) -> None:
        self.delay = delay
        self.connected = True
        self.closed = 0

    async def connect(self) -> bool:
        self.connected = True
        return True

    def close(self) -> None:
        self.closed += 1
        self.connected = False

    async def read_holding_registers(self, start: int, *, count: int, device_id: int) -> FakeResponse:
        FakeClient.in_flight += 1
        FakeClient.max_in_flight = max(FakeClient.max_in_flight, FakeClient.in_flight)
        try:
            await asyncio.sleep(self.delay)
        finally:
            FakeClient.in_flight -= 1
        return FakeResponse(count)


def _block(unit: int, start: int, count: int = 4) -> ReadBlock:
    return ReadBlock(unit_id=unit, area="holding", function_code=3, start=start, count=count, poll_group="", word_order="big", fields=())


def _connector(client: FakeClient, host: str = "10.0.0.5", port: int = 502) -> ModbusConnector:
    connector = ModbusConnector(host, port, timeout_s=3.0, retries=1)
    connector.client = client  # type: ignore[assignment]
    return connector


async def test_job_and_test_sessions_never_overlap_on_one_device() -> None:
    FakeClient.in_flight = FakeClient.max_in_flight = 0
    job, probe = _connector(FakeClient()), _connector(FakeClient())
    other_device = _connector(FakeClient(), host="10.0.0.6")
    reads = [job.read_raw(_block(unit, 100 * unit)) for unit in range(11, 17)]
    reads += [probe.read_raw(_block(unit, 100 * unit)) for unit in range(11, 17)]
    await asyncio.gather(*reads)
    assert FakeClient.max_in_flight == 1
    # a different device has its own lock
    FakeClient.in_flight = FakeClient.max_in_flight = 0
    await asyncio.gather(job.read_raw(_block(11, 100)), other_device.read_raw(_block(11, 100)))
    assert FakeClient.max_in_flight == 2


async def test_abandoned_request_closes_the_session() -> None:
    client = FakeClient(delay=1.0)
    connector = _connector(client)
    task = asyncio.create_task(connector.read_raw(_block(15, 2542)))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert client.closed == 1 and not client.connected  # the late reply has no session to land on


def _spec(fields: list[dict], config: dict) -> JobSpec:
    return JobSpec(
        job_id="j", connection_id="c", protocol="modbus_tcp", mode="POLL", interval_ms=1000, timeout_ms=0,
        connection={"config_json": config}, fields=fields, bindings={}, coerce_address={}, fingerprint="", connection_fingerprint="",
    )


def _unit_fields(unit: int, start: int) -> list[dict]:
    return [
        {"id": f"{unit}-status", "address_json": {"unit_id": unit, "offset": start, "native_type": "uint16"}},
        {"id": f"{unit}-ts", "address_json": {"unit_id": unit, "offset": start + 16, "native_type": "uint64", "role": "source_timestamp"}},
    ]


def test_cycle_budget_covers_every_unit_block_with_retries() -> None:
    config = {"host": "10.0.0.5", "port": 502, "unit_id": 11, "timeout_ms": 3000, "retries": 1}
    fields = [f for unit, start in zip(range(11, 17), (100, 710, 1321, 1930, 2542, 3151)) for f in _unit_fields(unit, start)]
    assert request_budget_s(3.0, 1) == 6.0
    # 6 unit blocks x (3 s x 2 tries) + 1 s, instead of the former flat 7 s
    assert modbus_cycle_budget_s(fields, config, 3.0) == 37.0
    assert read_budget_s(_spec(fields, config)) == 37.0
    single = modbus_cycle_budget_s(_unit_fields(11, 100), {**config, "retries": 0}, 3.0)
    assert single == 4.0
