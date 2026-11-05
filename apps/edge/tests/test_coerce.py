from __future__ import annotations

from factorix_edge.runtime import _coerce


def test_rt09_string():
    val, q, reason = _coerce("string", "21113185", "GOOD")
    assert val == "21113185"
    assert q == "GOOD"
    assert reason is None

    # Number coerced to string
    val2, q2, _ = _coerce("string", 12345, "GOOD")
    assert val2 == "12345"
    assert q2 == "GOOD"


def test_rt10_int_from_rounded_float():
    val, q, reason = _coerce("int64", 105.0, "GOOD")
    assert val == 105
    assert isinstance(val, int)
    assert q == "GOOD"
    assert reason is None

    # Non-integer float fails with TYPE_MISMATCH
    val_bad, q_bad, reason_bad = _coerce("int64", 105.5, "GOOD")
    assert val_bad is None
    assert q_bad == "BAD"
    assert reason_bad == "TYPE_MISMATCH"


def test_rt11_null():
    val, q, reason = _coerce("string", None, "GOOD")
    assert val is None
    assert q == "BAD"
    assert reason == "NULL_VALUE"


def test_rt_bool_coercion():
    val0, q0, _ = _coerce("bool", 0, "GOOD")
    assert val0 is False
    assert q0 == "GOOD"

    val1, q1, _ = _coerce("bool", 1, "GOOD")
    assert val1 is True
    assert q1 == "GOOD"
