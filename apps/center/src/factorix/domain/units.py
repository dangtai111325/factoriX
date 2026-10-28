"""Dimensional compatibility for formula units. Unknown stays unknown until confirmed."""

from __future__ import annotations

from dataclasses import dataclass

# Exponents: mass, length, time, current, temperature, amount
_BASE: dict[str, tuple[int, ...]] = {
    "1": (0, 0, 0, 0, 0, 0),
    "s": (0, 0, 1, 0, 0, 0),
    "m": (0, 1, 0, 0, 0, 0),
    "kg": (1, 0, 0, 0, 0, 0),
    "A": (0, 0, 0, 1, 0, 0),
    "K": (0, 0, 0, 0, 1, 0),
    "Cel": (0, 0, 0, 0, 1, 0),
    "V": (1, 2, -3, -1, 0, 0),
    "W": (1, 2, -3, 0, 0, 0),
    "kW": (1, 2, -3, 0, 0, 0),
    "kWh": (1, 2, -2, 0, 0, 0),
    "Hz": (0, 0, -1, 0, 0, 0),
    "rpm": (0, 0, -1, 0, 0, 0),
    "%": (0, 0, 0, 0, 0, 0),
    "%RH": (0, 0, 0, 0, 0, 0),
}


@dataclass(frozen=True, slots=True)
class UnitCheck:
    compatible: bool
    result_unit: str | None
    reason: str


def same_dimension(left: str | None, right: str | None) -> bool:
    if left is None or right is None:
        return False
    if left == right:
        return True
    return _BASE.get(left) is not None and _BASE.get(left) == _BASE.get(right)


def add_units(left: str | None, right: str | None) -> UnitCheck:
    if left is None or right is None:
        return UnitCheck(False, None, "Thiếu đơn vị.")
    if not same_dimension(left, right):
        return UnitCheck(False, None, "Không cộng được hai đại lượng khác chiều.")
    return UnitCheck(True, left, "ok")
