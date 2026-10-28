"""Modbus TCP read-only client. Writes are not implemented."""

from __future__ import annotations

from typing import Any

from pymodbus.client import AsyncModbusTcpClient

from factorix.domain.modbus_decode import ReadBlock, decode_bits, decode_registers


class ModbusConnector:
    can_write = False

    def __init__(self, host: str, port: int, timeout_s: float = 3.0) -> None:
        self.host = host
        self.port = port
        self.client = AsyncModbusTcpClient(host, port=port, timeout=timeout_s)

    async def connect(self) -> None:
        await self.client.connect()
        if not self.client.connected:
            raise ConnectionError(f"Modbus TCP không kết nối được {self.host}:{self.port}")

    async def read_block(self, block: ReadBlock) -> list[dict[str, Any]]:
        if block.area == "holding":
            response = await self.client.read_holding_registers(block.start, count=block.count, device_id=block.unit_id)
        elif block.area == "input":
            response = await self.client.read_input_registers(block.start, count=block.count, device_id=block.unit_id)
        elif block.area == "coil":
            response = await self.client.read_coils(block.start, count=block.count, device_id=block.unit_id)
        else:
            response = await self.client.read_discrete_inputs(block.start, count=block.count, device_id=block.unit_id)
        if response.isError():
            raise ConnectionError("Modbus trả về lỗi.")
        if block.area in {"holding", "input"}:
            return self._decode_registers(block, list(response.registers))
        return self._decode_bits(block, list(response.bits))

    def _decode_registers(self, block: ReadBlock, words: list[int]) -> list[dict[str, Any]]:
        if getattr(words, "isError", None):
            raise ConnectionError("Modbus trả về lỗi.")
        decoded: list[dict[str, Any]] = []
        for field in block.fields:
            offset = field.offset - block.start
            chunk = words[offset : offset + field.count]
            decoded.append(
                {
                    "field_id": field.field_id,
                    "raw": chunk,
                    "value": decode_registers(
                        chunk,
                        native_type=field.native_type,
                        word_order=block.word_order,
                        scale=field.scale,
                        offset=field.value_offset,
                    ),
                }
            )
        return decoded

    def _decode_bits(self, block: ReadBlock, bits: list[bool]) -> list[dict[str, Any]]:
        decoded = []
        for field in block.fields:
            decoded.append({"field_id": field.field_id, "value": decode_bits(bits, field.offset - block.start)})
        return decoded

    async def close(self) -> None:
        self.client.close()
