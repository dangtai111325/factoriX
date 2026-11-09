"""R4-DM-01: a FLOAT32 source value is reported as the decimal the device meant.

321.4 stored as an IEEE-754 single reads back as 321.3999938964844 when widened to a double.
The decoders report the shortest decimal that packs to the same 32 bits (321.4).
"""

from __future__ import annotations

import math
import random
import struct
from types import SimpleNamespace

from asyncua import ua

from factorix.domain.modbus_decode import clean_scaled, decode_registers, shortest_float32
from factorix_edge.connectors.opcua import data_value_row


def _f32(value: float) -> float:
    return struct.unpack(">f", struct.pack(">f", value))[0]


def _words(value: float, order: str = "big") -> list[int]:
    words = list(struct.unpack(">HH", struct.pack(">f", value)))
    return list(reversed(words)) if order == "little" else words


def test_widened_float32_noise_is_removed() -> None:
    assert _f32(321.4) == 321.3999938964844  # the value the tester saw
    assert shortest_float32(_f32(321.4)) == 321.4
    assert shortest_float32(_f32(312.9)) == 312.9
    assert shortest_float32(_f32(0.1)) == 0.1
    assert shortest_float32(_f32(-17.25)) == -17.25
    assert shortest_float32(1450.5) == 1450.5
    assert shortest_float32(0.0) == 0.0


def test_shortest_float32_keeps_the_same_bits() -> None:
    rng = random.Random(42)
    for _ in range(5000):
        bits = rng.getrandbits(32)
        value = struct.unpack(">f", struct.pack(">I", bits))[0]
        if not math.isfinite(value):
            continue
        shortest = shortest_float32(value)
        assert struct.pack(">f", shortest) == struct.pack(">f", value)
        assert len(repr(shortest)) <= len(repr(value))


def test_non_finite_and_out_of_range_unchanged() -> None:
    assert math.isnan(shortest_float32(float("nan")))
    assert shortest_float32(float("inf")) == float("inf")
    assert shortest_float32(1e300) == 1e300  # not a float32 at all: left alone


def test_modbus_float32_decodes_to_device_decimal() -> None:
    assert decode_registers(_words(321.4), native_type="float32") == 321.4
    assert decode_registers(_words(312.9, "little"), native_type="float32", word_order="little") == 312.9


def test_modbus_float64_is_not_shortened() -> None:
    words = list(struct.unpack(">HHHH", struct.pack(">d", 321.3999938964844)))
    assert decode_registers(words, native_type="float64") == 321.3999938964844


def test_scaled_values_have_no_binary_noise() -> None:
    assert decode_registers([3], native_type="uint16", scale=0.1) == 0.3  # 3 * 0.1 = 0.30000000000000004
    assert decode_registers(_words(321.4), native_type="float32", scale=10.0) == 3214.0
    assert clean_scaled(0.1 + 0.2) == 0.3
    assert decode_registers([7], native_type="uint16") == 7  # unscaled integers stay int


def _data_value(value: object, variant_type: ua.VariantType) -> SimpleNamespace:
    return SimpleNamespace(StatusCode=None, Value=SimpleNamespace(Value=value, VariantType=variant_type), SourceTimestamp=None)


def test_opcua_float_variant_is_shortened() -> None:
    assert data_value_row(_data_value(_f32(321.4), ua.VariantType.Float))["value"] == 321.4
    assert data_value_row(_data_value([_f32(0.1), _f32(2.7)], ua.VariantType.Float))["value"] == [0.1, 2.7]


def test_opcua_double_variant_is_untouched() -> None:
    assert data_value_row(_data_value(321.3999938964844, ua.VariantType.Double))["value"] == 321.3999938964844
