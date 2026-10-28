"""Typed resource graph invariants: codes, cycles, temporal installation."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

HIERARCHY_RELATIONS = frozenset({"CONTAINS", "PART_OF"})


class ResourceInvariantError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def validate_code(code: str) -> str:
    cleaned = code.strip()
    if not CODE_RE.fullmatch(cleaned):
        raise ResourceInvariantError("INVALID_CODE", "Mã tài nguyên không hợp lệ.")
    return cleaned


@dataclass(frozen=True, slots=True)
class RelationEdge:
    from_id: UUID
    to_id: UUID
    relation_code: str
    valid_from: datetime
    valid_to: datetime | None


def assert_no_cycle(edges: list[tuple[UUID, UUID]], start: UUID, proposed_parent: UUID) -> None:
    """Reject a CONTAINS edge that would make `proposed_parent` an ancestor loop.

    `edges` are existing child -> parent pairs. Adding child=start, parent=proposed_parent.
    """
    if start == proposed_parent:
        raise ResourceInvariantError("CYCLE", "Không thể gắn tài nguyên vào chính nó.")
    parent_of: dict[UUID, list[UUID]] = {}
    for child, parent in edges:
        parent_of.setdefault(child, []).append(parent)
    parent_of.setdefault(start, []).append(proposed_parent)
    seen: set[UUID] = set()
    stack = [start]

    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        for parent in parent_of.get(node, []):
            if parent == start:
                raise ResourceInvariantError("CYCLE", "Quan hệ tạo thành vòng.")
            stack.append(parent)


def overlaps(a_from: datetime, a_to: datetime | None, b_from: datetime, b_to: datetime | None) -> bool:
    a_end = a_to or datetime.max.replace(tzinfo=a_from.tzinfo)
    b_end = b_to or datetime.max.replace(tzinfo=b_from.tzinfo)
    return a_from < b_end and b_from < a_end


def assert_single_installation(
    existing: list[tuple[datetime, datetime | None]],
    valid_from: datetime,
    valid_to: datetime | None,
) -> None:
    for start, end in existing:
        if overlaps(start, end, valid_from, valid_to):
            raise ResourceInvariantError(
                "INSTALLATION_OVERLAP",
                "Đã có vị trí lắp đặt hiệu lực trong khoảng thời gian này.",
            )


def close_and_open(
    previous_open: datetime | None,
    at: datetime,
) -> tuple[datetime, datetime]:
    """Close the previous INSTALLED_AT at T and open the next from T."""
    if previous_open is not None and at < previous_open:
        raise ResourceInvariantError("TEMPORAL_ORDER", "Thời điểm thay thế phải sau thời điểm lắp hiện tại.")
    return at, at
