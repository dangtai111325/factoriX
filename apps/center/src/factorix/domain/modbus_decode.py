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
BIT_AREAS = frozenset({"coil", "discrete"})
MAX_REGISTERS = 125
MAX_BITS = 2000

# Registers needed per native type. ``ascii`` has no fixed size: the address must
# carry ``register_count`` (two characters per register).
REGISTER_COUNTS: dict[str, int] = {
    "bool": 1,
    "bit": 1,
    "uint16": 1,
    "int16": 1,
    "uint32": 2,
    "int32": 2,
    "float32": 2,
    "uint64": 4,
    "int64": 4,
    "float64": 4,
}
VARIABLE_LENGTH_TYPES = frozenset({"ascii", "string"})
NATIVE_TYPES = frozenset(REGISTER_COUNTS) | VARIABLE_LENGTH_TYPES


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


def register_count_for(native_type: str, register_count: int | None = None) -> int:
    """Number of registers a field occupies. Fixed-size types derive it from the type."""
    kind = native_type.lower()
    if kind in VARIABLE_LENGTH_TYPES:
        if register_count is None or int(register_count) < 1:
            raise ModbusPlanError("ADDRESS", "ASCII fields need register_count (2 characters per register).")
        return int(register_count)
    if kind not in REGISTER_COUNTS:
        raise ModbusPlanError("DECODE", f"Native type '{native_type}' is not supported.")
    expected = REGISTER_COUNTS[kind]
    if register_count is not None and int(register_count) != expected:
        raise ModbusPlanError(
            "ADDRESS",
            f"Native type {kind} needs {expected} register(s), not {int(register_count)}.",
        )
    return expected


def validate_span(span: SourceSpan, *, max_registers: int = MAX_REGISTERS, max_bits: int = MAX_BITS) -> None:
    if span.area not in FUNCTION_BY_AREA:
        raise ModbusPlanError("ADDRESS", "Register area must be holding, input, coil or discrete.")
    if span.offset < 0 or span.offset > 65535 or span.count < 1:
        raise ModbusPlanError("ADDRESS", "Invalid register address or length.")
    if span.unit_id < 0 or span.unit_id > 247:
        raise ModbusPlanError("UNIT", "Unit ID must be between 0 and 247.")
    limit = max_bits if span.area in BIT_AREAS else max_registers
    if span.count > limit:
        raise ModbusPlanError("ADDRESS", "Span exceeds single read limit.")


def plan_reads(
    spans: list[SourceSpan],
    *,
    max_registers: int = MAX_REGISTERS,
    max_bits: int = MAX_BITS,
    allow_gap: int = 0,
) -> list[ReadBlock]:
    """Group spans into read requests per (unit, area, poll group).

    Spans merge when the unused registers between them are at most ``allow_gap``
    and the merged request stays within the protocol limit. Overlapping spans (two
    fields reading the same register) share a block. Word order is decoded per field,
    so it does not split blocks.
    """
    if max_registers < 1 or max_registers > MAX_REGISTERS:
        raise ModbusPlanError("LIMIT", "Invalid register block limit.")
    if allow_gap < 0:
        raise ModbusPlanError("LIMIT", "Gap must not be negative.")
    groups: dict[tuple[int, str, str], list[SourceSpan]] = {}
    for span in spans:
        validate_span(span, max_registers=max_registers, max_bits=max_bits)
        groups.setdefault((span.unit_id, span.area, span.poll_group), []).append(span)

    blocks: list[ReadBlock] = []
    for (unit_id, area, poll_group), items in groups.items():
        ordered = sorted(items, key=lambda item: (item.offset, item.field_id))
        limit = max_bits if area in BIT_AREAS else max_registers
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
            merged_count = max(end, span_end) - start
            if gap <= allow_gap and merged_count <= limit:
                current.append(span)
                end = max(end, span_end)
                continue
            blocks.append(_block(unit_id, area, poll_group, start, end, current))  # type: ignore[arg-type]
            current = [span]
            start = span.offset
            end = span_end
        if current:
            blocks.append(_block(unit_id, area, poll_group, start, end, current))  # type: ignore[arg-type]
    return blocks


def split_contiguous(block: ReadBlock) -> list[ReadBlock]:
    """Split a block into requests that cover only configured registers (no gaps)."""
    return plan_reads(list(block.fields), allow_gap=0)


def _block(
    unit_id: int,
    area: Area,
    poll_group: str,
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
        word_order=fields[0].word_order,
        fields=tuple(fields),
    )


def decode_ascii(words: list[int]) -> str | None:
    """Two characters per register, high byte first. All-zero means no value (None).

    Trailing NUL bytes are padding and are removed.
    """
    if any(word < 0 or word > 0xFFFF for word in words):
        raise ModbusPlanError("DECODE", "Register value exceeds 16 bits.")
    raw = b"".join(struct.pack(">H", word) for word in words)
    if not any(raw):
        return None
    text = raw.rstrip(b"\x00")
    try:
        return text.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ModbusPlanError("DECODE", "Register bytes are not ASCII text.") from exc


def shortest_float32(value: float) -> float:
    """The shortest decimal that is the same IEEE-754 single as ``value``.

    A float32 widened to a Python float carries the binary error of the single format:
    321.4 stored as float32 reads back as 321.3999938964844. The device meant 321.4, and
    321.4 packs to exactly the same 32 bits, so that is the value to report (R4-DM-01).
    Non-finite values and values outside the float32 range are returned unchanged.
    """
    if not math.isfinite(value):
        return value
    try:
        bits = struct.pack(">f", value)
    except (OverflowError, struct.error):
        return value
    for digits in range(1, 10):  # 9 significant digits always round-trip a float32
        candidate = float(f"{value:.{digits}g}")
        try:
            if struct.pack(">f", candidate) == bits:
                return candidate
        except (OverflowError, struct.error):
            continue
    return value


def clean_scaled(value: float) -> float:
    """Drop the binary noise of ``raw * scale + offset`` (0.1 * 3 = 0.30000000000000004):
    15 significant digits are exact for every double, so nothing measurable is lost."""
    if not math.isfinite(value):
        return value
    return float(f"{value:.15g}")


def decode_registers(
    words: list[int],
    *,
    native_type: str,
    word_order: WordOrder = "big",
    byte_order: Literal["big", "little"] = "big",
    scale: float = 1.0,
    offset: float = 0.0,
) -> bool | int | float | str | None:
    if any(word < 0 or word > 0xFFFF for word in words):
        raise ModbusPlanError("DECODE", "Register value exceeds 16 bits.")
    kind = native_type.lower()
    if kind in VARIABLE_LENGTH_TYPES:
        return decode_ascii(words)
    ordered = list(words)
    if word_order == "little" and len(ordered) > 1:
        ordered = list(reversed(ordered))
    endian = ">" if byte_order == "big" else "<"
    raw = b"".join(struct.pack(">H", word) for word in ordered)
    if byte_order == "little":
        raw = b"".join(raw[i : i + 2][::-1] for i in range(0, len(raw), 2))
    if kind in {"bool", "bit"}:
        if len(words) != 1:
            raise ModbusPlanError("DECODE", "Bit requires exactly 1 register or coil.")
        return bool(words[0] & 1)
    formats = {
        "uint16": ("H", 2),
        "int16": ("h", 2),
        "uint32": ("I", 4),
        "int32": ("i", 4),
        "uint64": ("Q", 8),
        "int64": ("q", 8),
        "float32": ("f", 4),
        "float64": ("d", 8),
    }
    if kind not in formats:
        raise ModbusPlanError("DECODE", f"Native type '{native_type}' is not supported.")
    code, size = formats[kind]
    _expect(raw, size)
    value: int | float = struct.unpack(endian + code, raw)[0]
    if kind.startswith("float") and not math.isfinite(value):
        raise ModbusPlanError("NON_FINITE", f"{kind.capitalize()} value is not finite.")
    if not math.isfinite(scale) or not math.isfinite(offset):
        raise ModbusPlanError("SCALE", "Scale or offset is not finite.")
    if kind == "float32":
        value = shortest_float32(float(value))
    if scale != 1.0 or offset != 0.0:
        return clean_scaled(float(value) * scale + offset)
    if kind.startswith("float"):
        return float(value)
    return int(value)


def decode_bits(bits: list[bool], index: int) -> bool:
    if index < 0 or index >= len(bits):
        raise ModbusPlanError("ADDRESS", "Bit is outside read block.")
    return bool(bits[index])


def _expect(raw: bytes, size: int) -> None:
    if len(raw) != size:
        raise ModbusPlanError("DECODE", "Register count does not match data type.")
