"""A sample must not change value just because its clock is uncertain."""

import pytest

from factorix_edge.runtime import _coerce


@pytest.mark.parametrize("data_type,value,quality,expected", [
    ("float64", 42.5, "UNCERTAIN", (42.5, "UNCERTAIN")),
    ("string", 2111, "GOOD", (None, "BAD")),
    ("int64", 2**63, "GOOD", (None, "BAD")),
    ("int64", -(2**63), "GOOD", (-(2**63), "GOOD")),
    ("float64", float("nan"), "GOOD", (None, "BAD")),
    ("float64", float("inf"), "GOOD", (None, "BAD")),
    ("json", {"value": float("nan")}, "GOOD", (None, "BAD")),
    ("string", "0021113185", "GOOD", ("0021113185", "GOOD")),
    ("bool", False, "GOOD", (False, "GOOD")),
    ("int64", 0, "GOOD", (0, "GOOD")),
    ("string", None, "GOOD", (None, "GOOD")),
])
def test_sample_validation_preserves_valid_values_and_rejects_invalid_ones(data_type, value, quality, expected):
    assert _coerce(data_type, value, quality) == expected
