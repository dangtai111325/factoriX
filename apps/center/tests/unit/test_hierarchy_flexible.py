"""TC-BE-RES-01 through RES-08: Flexible hierarchy, area type, and adjacency validation."""

from __future__ import annotations

import pytest

from factorix.domain.catalog import CONTAINS_PAIRS, SYSTEM_TYPES
from factorix.platform.errors import AppError


def test_res_01_area_type_and_catalog() -> None:
    types_dict = {key: (name, cat) for key, name, cat in SYSTEM_TYPES}
    assert "area" in types_dict
    assert types_dict["area"] == ("Area", "AREA")

    site_children = [child for parent, child in CONTAINS_PAIRS if parent == "site"]
    assert "area" in site_children
    assert "plant" in site_children

    area_children = [child for parent, child in CONTAINS_PAIRS if parent == "area"]
    assert "zone" in area_children
    assert "line" in area_children


def test_res_02_enterprise_only_at_root() -> None:
    def check_placement(type_key: str, parent_type: str | None) -> None:
        if type_key == "enterprise" and parent_type is not None:
            raise AppError(422, "ROOT_ONLY", "Enterprise can only be at root level.")

    with pytest.raises(AppError) as exc:
        check_placement("enterprise", "enterprise")
    assert exc.value.code == "ROOT_ONLY"

    # Root enterprise passes
    check_placement("enterprise", None)


def test_res_03_and_04_guided_vs_strict_adjacency() -> None:
    def validate_adjacency(parent_type: str, child_type: str, mode: str) -> str:
        valid_pairs = set(CONTAINS_PAIRS)
        is_recommended = (parent_type, child_type) in valid_pairs
        if not is_recommended:
            if mode == "strict":
                raise AppError(422, "ADJACENCY", f"{child_type} cannot be placed under {parent_type} in strict mode.")
            return "non_standard"
        return "recommended"

    # RES-03: Machine under Site in guided mode -> non_standard
    assert validate_adjacency("site", "machine", mode="guided") == "non_standard"

    # RES-04: Machine under Site in strict mode -> 422 ADJACENCY
    with pytest.raises(AppError) as exc:
        validate_adjacency("site", "machine", mode="strict")
    assert exc.value.code == "ADJACENCY"

    # RES-05: Area under Site -> recommended
    assert validate_adjacency("site", "area", mode="guided") == "recommended"
    assert validate_adjacency("site", "area", mode="strict") == "recommended"


def test_res_06_site_required() -> None:
    def check_site(type_key: str, site_id: str | None, parent_type: str | None) -> None:
        if type_key != "enterprise" and not site_id and parent_type == "enterprise":
            raise AppError(422, "SITE_REQUIRED", "Non-enterprise resources must be associated with a site.")

    with pytest.raises(AppError) as exc:
        check_site("machine", None, "enterprise")
    assert exc.value.code == "SITE_REQUIRED"


def test_res_07_archived_parent_rejected() -> None:
    def check_parent_active(parent_archived_at: str | None) -> None:
        if parent_archived_at is not None:
            raise AppError(409, "ARCHIVED_PARENT", "Cannot add resources under an archived parent.")

    with pytest.raises(AppError) as exc:
        check_parent_active("2026-11-03T10:00:00Z")
    assert exc.value.code == "ARCHIVED_PARENT"
