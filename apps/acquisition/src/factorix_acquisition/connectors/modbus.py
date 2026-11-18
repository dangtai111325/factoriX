"""Modbus TCP read-only client. Writes are not implemented."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from pymodbus.client import AsyncModbusTcpClient
from pymodbus.exceptions import ConnectionException, ModbusException, ModbusIOException

from factorix.domain.modbus_decode import REGISTER_AREAS, ModbusPlanError, ReadBlock, decode_bits, decode_registers
from factorix_acquisition.aio import bounded
from factorix_acquisition.connectors.errors import ConnectorError

logger = logging.getLogger(__name__)

_EXCEPTION_NAMES = {
    1: "ILLEGAL FUNCTION",
    2: "ILLEGAL DATA ADDRESS",
    3: "ILLEGAL DATA VALUE",
    4: "SERVER DEVICE FAILURE",
    5: "ACKNOWLEDGE",
    6: "SERVER DEVICE BUSY",
    10: "GATEWAY PATH UNAVAILABLE",
    11: "GATEWAY TARGET FAILED TO RESPOND",
}


class EndpointScheduler:
    """The single request scheduler of one Modbus TCP endpoint (host:port) in this process.

    Modbus TCP devices and gateways answer one request at a time, so every job, connection and
    commissioning probe that targets the endpoint is queued here, FIFO, with a priority lane for
    interactive commissioning ("Test read") so an operator never waits behind a full poll cycle.
    The time spent queued is measured separately and is NOT part of any request's timeout: a request's
    budget starts when it gets the endpoint (``request_budget_s``), so a busy endpoint slows the poll
    rate instead of producing false timeouts.
    """

    def __init__(self) -> None:
        self._busy = False
        self._normal: deque[asyncio.Future[None]] = deque()
        self._priority: deque[asyncio.Future[None]] = deque()
        self.requests = 0
        self.total_wait_s = 0.0
        self.max_wait_s = 0.0

    @property
    def queued(self) -> int:
        return sum(1 for fut in (*self._normal, *self._priority) if not fut.done())

    def locked(self) -> bool:
        return self._busy

    async def acquire(self, *, priority: bool = False) -> float:
        started = time.monotonic()
        if not self._busy and not self.queued:
            self._busy = True
        else:
            fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            (self._priority if priority else self._normal).append(fut)
            try:
                await fut
            except asyncio.CancelledError:
                if fut.done() and not fut.cancelled():
                    self.release()  # granted just as we were cancelled: hand the endpoint on
                raise
        waited = time.monotonic() - started
        self.requests += 1
        self.total_wait_s += waited
        self.max_wait_s = max(self.max_wait_s, waited)
        return waited

    def release(self) -> None:
        for lane in (self._priority, self._normal):
            while lane:
                fut = lane.popleft()
                if not fut.done():
                    fut.set_result(None)  # ownership passes directly; _busy stays True
                    return
        self._busy = False

    @asynccontextmanager
    async def slot(self, *, priority: bool = False) -> AsyncIterator[float]:
        waited = await self.acquire(priority=priority)
        try:
            yield waited
        finally:
            self.release()

    async def __aenter__(self) -> "EndpointScheduler":
        await self.acquire()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.release()


_endpoint_schedulers: dict[tuple[int, str, int], EndpointScheduler] = {}


def endpoint_scheduler(host: str, port: int) -> EndpointScheduler:
    """One scheduler per Modbus device endpoint, shared by every connector of this event loop."""
    key = (id(asyncio.get_running_loop()), host.lower(), int(port))
    scheduler = _endpoint_schedulers.get(key)
    if scheduler is None:
        scheduler = _endpoint_schedulers[key] = EndpointScheduler()
    return scheduler


def endpoint_lock(host: str, port: int) -> EndpointScheduler:
    """Backward-compatible name: ``async with endpoint_lock(host, port):`` takes one normal slot."""
    return endpoint_scheduler(host, port)


def request_budget_s(timeout_s: float, retries: int) -> float:
    """Worst case of one request: pymodbus waits ``timeout_s`` per try and tries ``retries + 1`` times."""
    return float(timeout_s) * (max(0, int(retries)) + 1)


class ModbusConnector:
    """One persistent TCP session. Requests are serialised per device endpoint.

    A request that is abandoned while in flight (its job was cancelled or ran out of budget)
    closes the TCP session so late replies cannot corrupt the next transaction.
    """

    can_write = False

    def __init__(self, host: str, port: int, timeout_s: float = 3.0, retries: int = 0, *, priority: bool = False) -> None:
        self.host = host
        self.port = port
        self.timeout_s = timeout_s
        self.retries = max(0, int(retries))
        self.priority = bool(priority)
        self.last_wait_s = 0.0
        self.client = AsyncModbusTcpClient(host, port=port, timeout=timeout_s, retries=self.retries, reconnect_delay=0)

    @property
    def request_budget_s(self) -> float:
        return request_budget_s(self.timeout_s, self.retries)

    @property
    def connected(self) -> bool:
        return bool(self.client.connected)

    async def connect(self) -> None:
        try:
            await bounded(self.client.connect(), timeout=self.timeout_s + 1)
        except (OSError, ModbusException, asyncio.TimeoutError) as exc:
            raise ConnectorError("NETWORK", f"Cannot connect to Modbus TCP {self.host}:{self.port}.") from exc
        if not self.client.connected:
            raise ConnectorError("NETWORK", f"Cannot connect to Modbus TCP {self.host}:{self.port}.")

    async def ensure_connected(self) -> None:
        if not self.client.connected:
            await self.connect()

    async def read_raw(self, block: ReadBlock) -> list[int] | list[bool]:
        """Execute one read request. Library and device errors become ConnectorError."""
        async with endpoint_scheduler(self.host, self.port).slot(priority=self.priority) as waited:
            # The request budget starts here, after the queue: waiting for the endpoint is not a timeout.
            self.last_wait_s = waited
            await self.ensure_connected()
            try:
                if block.area == "holding":
                    request = self.client.read_holding_registers(block.start, count=block.count, device_id=block.unit_id)
                elif block.area == "input":
                    request = self.client.read_input_registers(block.start, count=block.count, device_id=block.unit_id)
                elif block.area == "coil":
                    request = self.client.read_coils(block.start, count=block.count, device_id=block.unit_id)
                else:
                    request = self.client.read_discrete_inputs(block.start, count=block.count, device_id=block.unit_id)
                response = await bounded(request, timeout=self.request_budget_s + 1.0)
            except ConnectionException as exc:
                self.client.close()
                raise ConnectorError("NETWORK", f"Modbus TCP {self.host}:{self.port} is not connected.") from exc
            except ModbusIOException as exc:
                self.client.close()
                raise ConnectorError("TIMEOUT", f"Modbus unit {block.unit_id} did not answer within {self.timeout_s:g} s.") from exc
            except asyncio.TimeoutError as exc:
                self.client.close()
                raise ConnectorError("TIMEOUT", f"Modbus unit {block.unit_id} did not answer within {self.timeout_s:g} s.") from exc
            except ModbusException as exc:
                raise ConnectorError("PROTOCOL", f"Modbus request failed: {exc}") from exc
            except OSError as exc:
                self.client.close()
                raise ConnectorError("NETWORK", f"Modbus TCP {self.host}:{self.port} connection failed.") from exc
            except asyncio.CancelledError:
                logger.info("Modbus request to unit %s on %s:%s abandoned; closing the session", block.unit_id, self.host, self.port)
                self.client.close()
                raise
        if response.isError():
            code = int(getattr(response, "exception_code", 0) or 0)
            name = _EXCEPTION_NAMES.get(code, "UNKNOWN")
            raise ConnectorError(
                "MODBUS_EXCEPTION",
                f"Unit {block.unit_id} rejected FC{block.function_code:02d} start {block.start} count {block.count}: exception {code} ({name}).",
            )
        if block.area in REGISTER_AREAS:
            words = list(response.registers)
            if len(words) < block.count:
                raise ConnectorError("PROTOCOL", f"Modbus returned {len(words)} registers, expected {block.count}.")
            return words
        return list(response.bits)[: block.count]

    async def read_block(self, block: ReadBlock) -> list[dict[str, Any]]:
        """Read a block and decode every field. A decode error affects only its field."""
        data = await self.read_raw(block)
        return decode_block(block, data)

    async def close(self) -> None:
        self.client.close()


def decode_block(block: ReadBlock, data: list[int] | list[bool]) -> list[dict[str, Any]]:
    decoded: list[dict[str, Any]] = []
    for field in block.fields:
        item: dict[str, Any] = {"field_id": field.field_id, "value": None, "error_code": None, "error": None}
        index = field.offset - block.start
        try:
            if block.area in REGISTER_AREAS:
                chunk = [int(word) for word in data[index : index + field.count]]
                item["raw"] = chunk
                item["value"] = decode_registers(
                    chunk,
                    native_type=field.native_type,
                    word_order=field.word_order,
                    scale=field.scale,
                    offset=field.value_offset,
                )
            else:
                item["value"] = decode_bits([bool(bit) for bit in data], index)
        except ModbusPlanError as exc:
            item["error_code"] = exc.code
            item["error"] = str(exc)
        decoded.append(item)
    return decoded
