"""Modbus TCP read-only client. Writes are not implemented."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pymodbus.client import AsyncModbusTcpClient
from pymodbus.exceptions import ConnectionException, ModbusException, ModbusIOException

from factorix.domain.modbus_decode import REGISTER_AREAS, ModbusPlanError, ReadBlock, decode_bits, decode_registers
from factorix_edge.aio import bounded
from factorix_edge.connectors.errors import ConnectorError

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


_endpoint_locks: dict[tuple[int, str, int], asyncio.Lock] = {}


def endpoint_lock(host: str, port: int) -> asyncio.Lock:
    """One request at a time per Modbus device endpoint, across every connector of this process
    (the acquisition job and commissioning tests open separate TCP sessions to the same gateway).
    Keyed by event loop too, because an asyncio.Lock belongs to one loop."""
    key = (id(asyncio.get_running_loop()), host.lower(), int(port))
    lock = _endpoint_locks.get(key)
    if lock is None:
        lock = _endpoint_locks[key] = asyncio.Lock()
    return lock


def request_budget_s(timeout_s: float, retries: int) -> float:
    """Worst case of one request: pymodbus waits ``timeout_s`` per try and tries ``retries + 1`` times."""
    return float(timeout_s) * (max(0, int(retries)) + 1)


class ModbusConnector:
    """One persistent TCP session. Requests are serialised per device endpoint.

    A request that is abandoned while in flight (its job was cancelled or ran out of budget)
    closes the TCP session: otherwise its reply arrives later on the same session, pymodbus
    discards it as "request ask for id=13 but got id=15" / "received pdu without a corresponding
    request", and the next request waits for an answer that already went by (R3 Modbus P1).
    """

    can_write = False

    def __init__(self, host: str, port: int, timeout_s: float = 3.0, retries: int = 0) -> None:
        self.host = host
        self.port = port
        self.timeout_s = timeout_s
        self.retries = max(0, int(retries))
        # reconnect_delay=0: no background reconnect; the job loop reconnects with backoff.
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
        async with endpoint_lock(self.host, self.port):
            await self.ensure_connected()
            try:
                if block.area == "holding":
                    response = await self.client.read_holding_registers(block.start, count=block.count, device_id=block.unit_id)
                elif block.area == "input":
                    response = await self.client.read_input_registers(block.start, count=block.count, device_id=block.unit_id)
                elif block.area == "coil":
                    response = await self.client.read_coils(block.start, count=block.count, device_id=block.unit_id)
                else:
                    response = await self.client.read_discrete_inputs(block.start, count=block.count, device_id=block.unit_id)
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
                # Abandoned mid-request: drop the session so the late reply cannot reach the next request.
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
