"""Modbus decoders and the per-unit read path (fake device, no network)."""

from __future__ import annotations

import struct

import pytest

from factorix.domain.modbus_decode import (
    ModbusPlanError,
    SourceSpan,
    decode_ascii,
    decode_registers,
    plan_reads,
    register_count_for,
)
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.jobs import modbus_fields, read_modbus

# Registers 100..121 of one machine as the source returns them (status 5, "GNAC", uptime 4304, ts).
UNIT11 = [5, 0, 18254, 16707, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4304, 0, 0, 0, 417, 44777, 37416]
TS_MS = (417 << 32) | (44777 << 16) | 37416


def test_uint64_and_int64() -> None:
    assert decode_registers([0, 417, 44777, 37416], native_type="uint64") == TS_MS
    assert decode_registers([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFE], native_type="int64") == -2
    assert decode_registers([37416, 44777, 417, 0], native_type="uint64", word_order="little") == TS_MS


def test_ascii_high_byte_first_and_trailing_nul() -> None:
    assert decode_ascii([18254, 16707, 0, 0, 0, 0, 0, 0]) == "GNAC"
    assert decode_registers([0x5730, 0x3100, 0, 0], native_type="ascii") == "W01"


def test_ascii_all_zero_is_null() -> None:
    assert decode_ascii([0] * 8) is None
    assert decode_registers([0] * 8, native_type="ascii") is None


def test_ascii_non_ascii_is_decode_error() -> None:
    with pytest.raises(ModbusPlanError):
        decode_ascii([0xFF41])


def test_float32_speed() -> None:
    words = list(struct.unpack(">HH", struct.pack(">f", 1450.5)))
    assert decode_registers(words, native_type="float32") == pytest.approx(1450.5)


def test_register_count_derived_from_type() -> None:
    assert register_count_for("uint16") == 1
    assert register_count_for("uint32") == 2
    assert register_count_for("float32") == 2
    assert register_count_for("uint64") == 4
    assert register_count_for("ascii", 8) == 8
    with pytest.raises(ModbusPlanError):
        register_count_for("ascii")
    with pytest.raises(ModbusPlanError):
        register_count_for("uint32", 1)  # an explicit wrong count is an address error


def test_plan_merges_small_gaps_per_unit_only() -> None:
    spans = [
        SourceSpan("status", "holding", 710, 1, 12, "job"),
        SourceSpan("mode", "holding", 712, 1, 12, "job"),
        SourceSpan("ts", "holding", 738, 4, 12, "job"),
        SourceSpan("other_unit", "holding", 712, 1, 11, "job"),
    ]
    blocks = plan_reads(spans, allow_gap=16)
    by_unit = {(b.unit_id, b.start, b.count) for b in blocks}
    assert (12, 710, 3) in by_unit  # 710..712 merged across a one-register gap
    assert (12, 738, 4) in by_unit  # 25-register gap is not merged
    assert (11, 712, 1) in by_unit
    assert len(plan_reads(spans, allow_gap=0)) == 4


class FakeDevice:
    """Holding registers per unit; optionally rejects reads that touch unmapped registers."""

    def __init__(self, units: dict[int, dict[int, int]], strict: bool = False) -> None:
        self.units = units
        self.strict = strict
        self.requests: list[tuple[int, int, int]] = []

    async def read_raw(self, block):  # noqa: ANN001 - mimics ModbusConnector.read_raw
        self.requests.append((block.unit_id, block.start, block.count))
        registers = self.units.get(block.unit_id)
        if registers is None:
            raise ConnectorError("TIMEOUT", f"unit {block.unit_id} did not answer")
        addresses = range(block.start, block.start + block.count)
        if self.strict and any(a not in registers for a in addresses):
            raise ConnectorError("MODBUS_EXCEPTION", "exception 2 (ILLEGAL DATA ADDRESS)")
        return [registers.get(a, 0) for a in addresses]


def _fields(unit: int, base: int) -> list[dict]:
    def field(fid: str, offset: int, native: str, **extra: object) -> dict:
        return {"id": fid, "address_json": {"unit_id": unit, "offset": base + offset, "native_type": native, **extra}}

    return [
        field("status", 0, "uint16"),
        field("mode", 1, "uint16"),
        field("stop_error", 2, "ascii", register_count=8),
        field("speed_1", 10, "float32"),
        field("uptime_1", 14, "uint32"),
        field("source_timestamp", 18, "uint64", role="source_timestamp"),
    ]


@pytest.mark.asyncio
async def test_read_modbus_role_timestamp_applies_to_same_unit() -> None:
    device = FakeDevice({11: {100 + i: w for i, w in enumerate(UNIT11)}})
    items, bad = modbus_fields(_fields(11, 100), {"unit_id": 1}, key_by=lambda f: f["id"])
    assert bad == []
    samples = {s.field_id: s for s in await read_modbus(device, items, merge_gap=16)}
    assert device.requests == [(11, 100, 22)]
    assert samples["status"].value == 5
    assert samples["stop_error"].value == "GNAC"
    assert samples["uptime_1"].value == 4304
    expected_ts = samples["source_timestamp"].value
    assert expected_ts.endswith("Z") and len(expected_ts) == 24
    assert all(s.source_time == expected_ts for s in samples.values())


@pytest.mark.asyncio
async def test_decode_error_affects_only_its_field() -> None:
    registers = {100 + i: w for i, w in enumerate(UNIT11)}
    registers[102] = 0xFF41  # not ASCII
    device = FakeDevice({11: registers})
    items, _ = modbus_fields(_fields(11, 100), {}, key_by=lambda f: f["id"])
    samples = {s.field_id: s for s in await read_modbus(device, items, merge_gap=16)}
    assert samples["stop_error"].quality == "BAD" and samples["stop_error"].reason == "DECODE"
    assert samples["status"].quality == "GOOD" and samples["speed_1"].quality == "GOOD"


@pytest.mark.asyncio
async def test_invalid_address_is_a_bad_field_not_a_job_failure() -> None:
    fields = _fields(11, 100) + [{"id": "no_count", "address_json": {"offset": 5, "native_type": "ascii"}}]
    items, bad = modbus_fields(fields, {}, key_by=lambda f: f["id"])
    assert [b.field_id for b in bad] == ["no_count"] and bad[0].quality == "BAD"
    assert len(items) == 6


@pytest.mark.asyncio
async def test_rejected_merged_block_falls_back_to_configured_spans() -> None:
    mapped = {710: 5, 712: 0, 738: 0, 739: 417, 740: 44777, 741: 37416}
    device = FakeDevice({12: mapped}, strict=True)
    fields = [
        {"id": "status", "address_json": {"unit_id": 12, "offset": 710, "native_type": "uint16"}},
        {"id": "mode", "address_json": {"unit_id": 12, "offset": 712, "native_type": "uint16"}},
    ]
    items, _ = modbus_fields(fields, {}, key_by=lambda f: f["id"])
    cache: set = set()
    samples = {s.field_id: s for s in await read_modbus(device, items, merge_gap=16, split_cache=cache)}
    assert samples["status"].value == 5 and samples["mode"].value == 0
    assert device.requests == [(12, 710, 3), (12, 710, 1), (12, 712, 1)]
    device.requests.clear()
    await read_modbus(device, items, merge_gap=16, split_cache=cache)
    assert device.requests == [(12, 710, 1), (12, 712, 1)]  # remembered


@pytest.mark.asyncio
async def test_one_silent_unit_does_not_fail_other_units() -> None:
    device = FakeDevice({11: {100 + i: w for i, w in enumerate(UNIT11)}})
    items, _ = modbus_fields(_fields(11, 100) + _fields(13, 1321)[:1], {}, key_by=lambda f: f"{f['id']}@{f['address_json']['unit_id']}")
    samples = {s.field_id: s for s in await read_modbus(device, items, merge_gap=16)}
    assert samples["status@11"].quality == "GOOD"
    assert samples["status@13"].quality == "BAD" and samples["status@13"].reason == "TIMEOUT"


@pytest.mark.asyncio
async def test_all_units_silent_fails_the_read() -> None:
    device = FakeDevice({})
    items, _ = modbus_fields(_fields(11, 100), {}, key_by=lambda f: f["id"])
    with pytest.raises(ConnectorError) as raised:
        await read_modbus(device, items, merge_gap=16)
    assert raised.value.code == "TIMEOUT"
