from __future__ import annotations

import pytest
from factorix.modules.resources import LayoutDraft, validate_layout_geometry
from factorix.platform.errors import AppError


def test_lay01_valid_schema():
    draft_dict = {
        "levels": {
            "ASSY": {
                "mode": "custom",
                "items": {
                    "L01": {"x": 0.0, "y": 0.0, "w": 0.33, "h": 0.5}
                }
            }
        }
    }
    validate_layout_geometry(draft_dict)
    draft_obj = LayoutDraft(version=2, draft=draft_dict)
    assert draft_obj.version == 2
    assert "levels" in draft_obj.draft


def test_lay02_coordinates_out_of_range():
    # x > 1.0
    with pytest.raises(AppError) as exc:
        validate_layout_geometry({"levels": {"L": {"items": {"A": {"x": 1.2, "y": 0.0, "w": 0.2, "h": 0.2}}}}})
    assert exc.value.code == "LAYOUT_GEOMETRY"

    # w <= 0
    with pytest.raises(AppError) as exc:
        validate_layout_geometry({"levels": {"L": {"items": {"A": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.2}}}}})
    assert exc.value.code == "LAYOUT_GEOMETRY"


def test_lay03_exceed_boundary():
    # x + w > 1.0 (0.8 + 0.3 = 1.1)
    with pytest.raises(AppError) as exc:
        validate_layout_geometry({"levels": {"L": {"items": {"A": {"x": 0.8, "y": 0.0, "w": 0.3, "h": 0.2}}}}})
    assert exc.value.code == "LAYOUT_GEOMETRY"


def test_lay07_forbidden_keys():
    # Attempting to manipulate topology keys inside layout
    with pytest.raises(AppError) as exc:
        validate_layout_geometry({"levels": {"L": {"items": {"A": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}}}, "parent_id": "root"})
    assert exc.value.code == "LAYOUT_SCOPE"
