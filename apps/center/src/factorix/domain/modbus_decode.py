"""Modbus block planning and typed decoding. Read-only."""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Literal

Area = Literal["coil", "discrete", "input", "holding"]
WordOrder = Literal["big", "little"]

FUNCTION_BY_AREA: dict[Area, int] = {
    "coil": 1,
    "discrete": 2,
    "holding": 3,
    "input": 4,
}

REGISTER_AREAS = frozenset({"input", "holding"})
MAX_REGISTERS = 125
MAX_BITS = 2000


class ModbusPlanError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SourceSpan:
    field_id: str
    area: Area
    offset: int
    count: int
    unit_id: int
    poll_group: str
    word_order: WordOrder = "big"
    native_type: str = "uint16"
    scale: float = 1.0
    value_offset: float = 0.0


@dataclass(frozen=True, slots=True)
class ReadBlock:
    unit_id: int
    area: Area
    function_code: int
    start: int
    count: int
    poll_group: str
    word_order: WordOrder
    fields: tuple[SourceSpan, ...]


def plan_reads(
    spans: list[SourceSpan],
    *,
    max_registers: int = MAX_REGISTERS,
    max_bits: int = MAX_BITS,
    allow_gap: int = 0,
) -> list[ReadBlock]:
    if max_registers < 1 or max_registers > MAX_REGISTERS:
        raise ModbusPlanError("LIMIT", "Giới hạn block register không hợp lệ.")
    groups: dict[tuple, list[SourceSpan]] = {}
    for span in spans:
        if span.offset < 0 or span.count < 1:
            raise ModbusPlanError("ADDRESS", "Địa chỉ hoặc độ dài register không hợp lệ.")
        if span.unit_id < 0 or span.unit_id > 247:
            raise ModbusPlanError("UNIT", "Unit ID phải trong khoảng 0–247.")
        limit = max_bits if span.area in {"coil", "discrete"} else max_registers
        if span.count > limit:
            raise ModbusPlanError("ADDRESS", "Span vượt quá kích thước một lần đọc.")
        key = (span.unit_id, span.area, span.poll_group, span.word_order)
        groups.setdefault(key, []).append(span)

    blocks: list[ReadBlock] = []
    for (unit_id, area, poll_group, word_order), items in groups.items():
        ordered = sorted(items, key=lambda item: (item.offset, item.field_id))
        limit = max_bits if area in {"coil", "discrete"} else max_registers
        current: list[SourceSpan] = []
        start = 0
        end = 0
        for span in ordered:
            span_end = span.offset + span.count
            if not current:
                current = [span]
                start = span.offset
                end = span_end
                continue
            gap = span.offset - end
            merged_count = span_end - start
            if gap < 0:
                raise ModbusPlanError("OVERLAP", "Các field chồng địa chỉ trong cùng poll group.")
            if gap <= allow_gap and merged_count <= limit:
                current.append(span)
                end = max(end, span_end)
                continue
            blocks.append(_block(unit_id, area, poll_group, word_order, start, end, current))
            current = [span]
            start = span.offset
            end = span_end
        if current:
            blocks.append(_block(unit_id, area, poll_group, word_order, start, end, current))
    return blocks


def _block(
    unit_id: int,
    area: Area,
    poll_group: str,
    word_order: WordOrder,
    start: int,
    end: int,
    fields: list[SourceSpan],
) -> ReadBlock:
    return ReadBlock(
        unit_id=unit_id,
        area=area,
        function_code=FUNCTION_BY_AREA[area],
        start=start,
        count=end - start,
        poll_group=poll_group,
        word_order=word_order,
        fields=tuple(fields),
    )


def decode_registers(
    words: list[int],
    *,
    native_type: str,
    word_order: WordOrder = "big",
    byte_order: Literal["big", "little"] = "big",
    scale: float = 1.0,
    offset: float = 0.0,
) -> bool | int | float:
    if any(word < 0 or word > 0xFFFF for word in words):
        raise ModbusPlanError("DECODE", "Register nằm ngoài 16 bit.")
    ordered = list(words)
    if word_order == "little" and len(ordered) > 1:
        ordered = list(reversed(ordered))
    endian = ">" if byte_order == "big" else "<"
    raw = b"".join(struct.pack(">H", word) for word in ordered)
    if byte_order == "little":
        raw = b"".join(raw[i : i + 2][::-1] for i in range(0, len(raw), 2))
    kind = native_type.lower()
    if kind in {"bool", "bit"}:
        if len(words) != 1:
            raise ModbusPlanError("DECODE", "Bit cần đúng 1 register hoặc coil.")
        return bool(words[0] & 1)
    if kind == "uint16":
        _expect(raw, 2)
        value: int | float = struct.unpack(endian + "H", raw)[0]
    elif kind == "int16":
        _expect(raw, 2)
        value = struct.unpack(endian + "h", raw)[0]
    elif kind == "uint32":
        _expect(raw, 4)
        value = struct.unpack(endian + "I", raw)[0]
    elif kind == "int32":
        _expect(raw, 4)
        value = struct.unpack(endian + "i", raw)[0]
    elif kind == "float32":
        _expect(raw, 4)
        value = struct.unpack(endian + "f", raw)[0]
        if not math.isfinite(value):
            raise ModbusPlanError("NON_FINITE", "Float32 không hữu hạn.")
    elif kind == "float64":
        _expect(raw, 8)
        value = struct.unpack(endian + "d", raw)[0]
        if not math.isfinite(value):
            raise ModbusPlanError("NON_FINITE", "Float64 không hữu hạn.")
    else:
        raise ModbusPlanError("DECODE", "Kiểu native không hỗ trợ.")
    if not math.isfinite(scale) or not math.isfinite(offset):
        raise ModbusPlanError("SCALE", "Scale/offset không hữu hạn.")
    if kind.startswith("float") or scale != 1.0 or offset != 0.0:
        return float(value) * scale + offset
    return int(value)


def decode_bits(bits: list[bool], index: int) -> bool:
    if index < 0 or index >= len(bits):
        raise ModbusPlanError("ADDRESS", "Bit nằm ngoài block đã đọc.")
    return bool(bits[index])


def _expect(raw: bytes, size: int) -> None:
    if len(raw) != size:
        raise ModbusPlanError("DECODE", "Số register không khớp kiểu dữ liệu.")
