"""Resource import requests retain typed values and bound planning work."""

import pytest
from pydantic import ValidationError

from factorix.modules.resources import ImportIn


def test_import_keeps_legacy_csv_rows_and_preview_default():
    request = ImportIn(rows=[{"code": "0001", "name": "Machine", "type_key": "machine", "parent_code": "L1"}])
    assert request.dry_run is True
    assert request.rows[0]["code"] == "0001"


def test_import_accepts_typed_metadata_and_unambiguous_parent_options():
    request = ImportIn.model_validate({
        "rows": [{"path": "E/DN/L/M", "name": "M", "type_key": "machine",
                  "properties": {"count": 0, "enabled": False, "serial": "0007", "unset": None},
                  "tags": ["production"], "source_row": 42}],
        "default_parent_id": "c773ccda-26a1-47aa-8b76-dd9a917b2781",
        "hierarchy_mode": "strict", "plan_hash": "a" * 64,
    })
    assert request.rows[0]["properties"] == {"count": 0, "enabled": False, "serial": "0007", "unset": None}
    assert request.rows[0]["source_row"] == 42
    assert request.default_parent_id == "c773ccda-26a1-47aa-8b76-dd9a917b2781"
    assert request.hierarchy_mode == "strict" and request.plan_hash == "a" * 64


@pytest.mark.parametrize("rows", [[], [{}] * 2001, [{"name": "x" * 2_000_001}], [{"properties": {"value": float("nan")}}]])
def test_import_rejects_empty_excessive_or_nonfinite_requests(rows):
    with pytest.raises(ValidationError):
        ImportIn(rows=rows)


@pytest.mark.parametrize("field,value", [("plan_hash", "bogus"), ("hierarchy_mode", "anything")])
def test_import_rejects_unusable_preview_options(field, value):
    with pytest.raises(ValidationError):
        ImportIn.model_validate({"rows": [{"code": "E", "name": "E", "type_key": "enterprise"}], field: value})
