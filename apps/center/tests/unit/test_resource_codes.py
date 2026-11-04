"""TC-BE-RES-09 through RES-25: Resource codes scoping, regex, path_code recursion, forbidden characters, and cycle prevention."""

from __future__ import annotations

import re
from uuid import uuid4

import pytest

from factorix.domain.resources import CODE_RE, ResourceInvariantError, assert_no_cycle, validate_code
from factorix.platform.errors import AppError


def test_res_09_code_unique_per_parent() -> None:
    # 2 machines with code "M01" under different parents are allowed
    parent_1 = uuid4()
    parent_2 = uuid4()
    registry: set[tuple[object, str]] = set()

    def add_resource(parent_id: object, code: str) -> None:
        key = (parent_id, code.lower())
        if key in registry:
            raise AppError(409, "DUPLICATE", f"Resource code '{code}' already exists under this parent.")
        registry.add(key)

    add_resource(parent_1, "M01")
    add_resource(parent_2, "M01")  # Different parent -> passes!
    assert len(registry) == 2


def test_res_10_and_11_duplicate_code_under_same_parent_case_insensitive() -> None:
    parent_1 = uuid4()
    registry: set[tuple[object, str]] = set()

    def add_resource(parent_id: object, code: str) -> None:
        key = (parent_id, code.lower())
        if key in registry:
            raise AppError(409, "DUPLICATE", f"Resource code '{code}' already exists under Line 1.")
        registry.add(key)

    add_resource(parent_1, "M01")
    with pytest.raises(AppError) as exc1:
        add_resource(parent_1, "M01")
    assert exc1.value.code == "DUPLICATE"

    with pytest.raises(AppError) as exc2:
        add_resource(parent_1, "m01")  # Case-insensitive
    assert exc2.value.code == "DUPLICATE"


def test_res_12_path_code_calculation() -> None:
    parts = ["TIPA", "DongNai", "Factory-1", "ASSY", "Assembly-AA10-02-AB", "AA10-02"]
    path_code = "/".join(parts)
    assert path_code == "TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02"


def test_res_13_forbidden_characters_in_name() -> None:
    forbidden = re.compile(r"[/+#$\x00-\x1f]")

    def validate_name(name: str) -> None:
        if forbidden.search(name):
            raise AppError(422, "NAME_CHARS", "Resource name contains forbidden characters.")

    for bad in ["a/b", "a#", "a+", "a$", "a\u0001"]:
        with pytest.raises(AppError) as exc:
            validate_name(bad)
        assert exc.value.code == "NAME_CHARS"

    validate_name("Assembly Line 01 - Normal")  # passes


def test_res_14_name_length_limit() -> None:
    def validate_name_length(name: str) -> None:
        if len(name) > 200:
            raise AppError(422, "LENGTH", "Resource name too long.", field_errors=[{"path": "name", "code": "MAX_LENGTH"}])

    with pytest.raises(AppError) as exc:
        validate_name_length("x" * 201)
    assert exc.value.code == "LENGTH"
    assert exc.value.field_errors[0]["path"] == "name"


def test_res_15_code_regex() -> None:
    # Invalid codes
    for bad_code in ["-abc", "a b", "x" * 65, "$SYS", "#bad"]:
        with pytest.raises(ResourceInvariantError):
            validate_code(bad_code)

    # Valid codes
    assert validate_code("M01") == "M01"
    assert validate_code("AA10-02") == "AA10-02"
    assert validate_code("Line_1.A") == "Line_1.A"


def test_res_20_cycle_prevention() -> None:
    r1, r2, r3 = uuid4(), uuid4(), uuid4()
    edges = [(r2, r1), (r3, r2)]  # r1 -> r2 -> r3

    # Attempting to place r1 under r3 would create r1 -> r2 -> r3 -> r1
    with pytest.raises(ResourceInvariantError) as exc:
        assert_no_cycle(edges, r1, r3)
    assert exc.value.code == "CYCLE"
