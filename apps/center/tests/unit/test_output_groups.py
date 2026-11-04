from __future__ import annotations

import pytest
from factorix.modules.collect import _validate_group_spec
from factorix.platform.errors import AppError


def test_mod04_alias_duplicate():
    # 2 members with duplicate alias 'status'
    with pytest.raises(AppError) as exc:
        _validate_group_spec(
            "uns/data",
            [
                {"signal_id": "00000000-0000-0000-0000-000000000001", "alias": "status"},
                {"signal_id": "00000000-0000-0000-0000-000000000002", "alias": "status"},
            ],
        )
    assert exc.value.code == "ALIAS_DUPLICATE"


def test_mod05_alias_invalid():
    # Alias starting with digit '1x'
    with pytest.raises(AppError) as exc:
        _validate_group_spec(
            "uns/data",
            [
                {"signal_id": "00000000-0000-0000-0000-000000000001", "alias": "1x"},
            ],
        )
    assert exc.value.code == "ALIAS_INVALID"


def test_mod06_template_validation():
    # Leading slash
    with pytest.raises(AppError) as exc:
        _validate_group_spec(
            "/a/b",
            [],
        )
    assert exc.value.code == "TEMPLATE"

    # Unknown template placeholder {foo}
    with pytest.raises(AppError) as exc:
        _validate_group_spec(
            "uns/{foo}/data",
            [],
        )
    assert exc.value.code == "TEMPLATE"
    assert "foo" in exc.value.message
