"""Deterministic import planning, without a database or side effects."""

from factorix.domain.resource_import import ModelNode, plan_resources


TYPES = {
    "enterprise": set(), "site": {"enterprise"}, "plant": {"site"}, "line": {"plant"},
    "machine": {"line"}, "sensor": {"machine"}, "area": {"site", "area"},
}


def model():
    return [
        ModelNode("e", "E", "Enterprise", "enterprise"),
        ModelNode("s", "DN", "Đồng Nai", "site", parent_id="e", site_id="scope-a"),
        ModelNode("p", "P", "Plant", "plant", parent_id="s", site_id="scope-a"),
        ModelNode("l", "L", "Line", "line", parent_id="p", site_id="scope-a"),
    ]


def test_children_before_parents_and_duplicate_codes_in_different_branches():
    rows = [
        {"path": "E/S/P/A/M01", "type_key": "machine", "name": "One"},
        {"path": "E/S/P/B/M01", "type_key": "machine", "name": "Two"},
        {"path": "E/S/P/B", "type_key": "line", "name": "B"},
        {"path": "E/S/P/A", "type_key": "line", "name": "A"},
        {"path": "E/S/P", "type_key": "plant", "name": "Plant"},
        {"path": "E/S", "type_key": "site", "name": "Site"},
        {"path": "E", "type_key": "enterprise", "name": "Enterprise"},
    ]
    plan = plan_resources(rows, [], TYPES)
    assert not plan.errors
    assert len(plan.items) == 7 and all(item.action == "CREATE" for item in plan.items)
    ordered = {item.index: at for at, item in enumerate(plan.items)}
    for item in plan.items:
        if item.parent_index is not None:
            assert ordered[item.parent_index] < ordered[item.index]
        if item.type_key != "enterprise":
            assert item.site_index == 5
    assert {item.path for item in plan.items if item.code == "M01"} == {"E/S/P/A/M01", "E/S/P/B/M01"}


def test_reuse_keeps_existing_name_metadata_version_and_identity():
    existing = model() + [ModelNode("m", "M01", "Máy hiện tại", "machine", parent_id="l", site_id="scope-a",
        version=7, description="Keep", properties={"serial": "0001", "enabled": False}, tags=["critical"])]
    plan = plan_resources([{"path": "E/DN/P/L/M01", "type_key": "machine", "name": "Different",
        "description": "Replace", "properties": '{"serial":"9999"}', "tags": "other"}], existing, TYPES)
    assert not plan.errors
    item = plan.items[0]
    assert item.action == "REUSE" and item.existing_id == "m" and item.existing_version == 7
    assert item.name == "Máy hiện tại" and item.description == "Keep"
    assert item.properties == {"serial": "0001", "enabled": False} and item.tags == ["critical"]
    assert {warning.code for warning in plan.warnings} == {"EXISTING_VALUES_KEPT"}
    assert set(item.differences) == {"name", "description", "properties", "tags"}


def test_parent_code_is_rejected_when_ambiguous_but_path_or_id_disambiguates():
    existing = model() + [ModelNode("p2", "P2", "Plant 2", "plant", parent_id="s", site_id="scope-a"),
                          ModelNode("l2", "L", "Line 2", "line", parent_id="p2", site_id="scope-a")]
    ambiguous = plan_resources([{"code": "M", "name": "Machine", "type_key": "machine", "parent_code": "L"}], existing, TYPES)
    assert any(error.code == "AMBIGUOUS_PARENT" for error in ambiguous.errors)
    for ref in ({"parent_path": "E/DN/P2/L"}, {"parent_id": "l2"}):
        plan = plan_resources([{"code": "M", "name": "Machine", "type_key": "machine", "parent_code": "L", **ref}], existing, TYPES)
        assert not plan.errors
        assert plan.items[0].path == "E/DN/P2/L/M" and plan.items[0].parent_id == "l2"


def test_missing_parent_cycles_duplicate_paths_and_contradictory_references_are_reported():
    cases = [
        ([{"code": "M", "name": "M", "type_key": "machine", "parent_code": "Missing"}], "MISSING_PARENT"),
        ([{"code": "A", "name": "A", "type_key": "area", "parent_code": "B"},
          {"code": "B", "name": "B", "type_key": "area", "parent_code": "A"}], "CYCLE"),
        ([{"path": "E/DN/P/L/M", "name": "One", "type_key": "machine"},
          {"path": "E/DN/P/L/M", "name": "Two", "type_key": "machine"}], "DUPLICATE"),
        ([{"path": "E/DN/P/L/M", "parent_id": "s", "name": "M", "type_key": "machine"}], "PARENT_CONFLICT"),
    ]
    for rows, expected in cases:
        plan = plan_resources(rows, model(), TYPES)
        assert any(error.code == expected for error in plan.errors), plan.errors
        assert plan.plan_hash is None


def test_reuse_does_not_retype_or_restore_archived_resources():
    existing = model() + [ModelNode("m", "M", "Machine", "machine", parent_id="l", site_id="scope-a", archived=True)]
    archived = plan_resources([{"path": "E/DN/P/L/M", "name": "M", "type_key": "machine"}], existing, TYPES)
    assert any(error.code == "ARCHIVED" for error in archived.errors)
    conflict = plan_resources([{"path": "E/DN/P/L", "name": "L", "type_key": "sensor"}], existing, TYPES)
    assert any(error.code == "TYPE_CONFLICT" for error in conflict.errors)
    child = plan_resources([{"path": "E/DN/P/L/M/Child", "name": "Child", "type_key": "sensor"}], existing, TYPES)
    assert any(error.code == "ARCHIVED_PARENT" for error in child.errors)


def test_site_boundaries_and_repeated_site_codes_under_different_enterprises():
    bad = plan_resources([{"path": "E/DN/Nested", "name": "Nested", "type_key": "site"},
                          {"path": "E/DN/P/L/M", "name": "M", "type_key": "machine", "site_id": "scope-b"}],
                         model(), TYPES, sites={"scope-a": "s", "scope-b": None})
    assert sum(error.code == "SITE_SCOPE" for error in bad.errors) == 2
    repeated = plan_resources([{"path": "One", "name": "One", "type_key": "enterprise"},
                               {"path": "One/DN", "name": "DN", "type_key": "site"},
                               {"path": "Two", "name": "Two", "type_key": "enterprise"},
                               {"path": "Two/DN", "name": "DN", "type_key": "site"}], [], TYPES)
    assert not repeated.errors
    sites = [item for item in repeated.items if item.type_key == "site"]
    assert len(sites) == 2 and sites[0].site_index != sites[1].site_index


def test_row_validation_includes_real_source_row_and_typed_metadata():
    invalid = plan_resources([{"path": "M", "name": "M", "type_key": "machine", "properties": "[1]", "source_row": "42"},
                              {"path": "S", "name": "Site", "type_key": "site", "timezone": "Not/AZone"},
                              {"path": "P", "code": "Wrong", "name": "P", "type_key": "unknown"}], [], TYPES)
    assert any(error.row == 42 and error.code == "PROPERTIES" for error in invalid.errors)
    assert any(error.code == "TIMEZONE" for error in invalid.errors)
    valid = plan_resources([{"path": "M", "name": "M", "type_key": "machine",
                              "properties": '{"serial":"0001","value":0,"ok":false,"empty":null}', "tags": "one;two"}], [], TYPES)
    assert not valid.errors
    assert valid.items[0].properties == {"serial": "0001", "value": 0, "ok": False, "empty": None}
    assert valid.items[0].tags == ["one", "two"]


def test_guided_and_strict_placements_apply_to_new_rows_without_modifying_reused_rows():
    row = {"path": "E/DN/M", "name": "M", "type_key": "machine"}
    guided = plan_resources([row], model(), TYPES)
    assert not guided.errors and any(warning.code == "NOT_RECOMMENDED" for warning in guided.warnings)
    strict = plan_resources([row], model(), TYPES, hierarchy_mode="strict")
    assert any(error.code == "ADJACENCY" for error in strict.errors)
    legacy_site = ModelNode("root-site", "S", "S", "site", site_id="scope-a")
    reused = plan_resources([{"path": "S", "name": "S", "type_key": "site"}], [legacy_site], TYPES, hierarchy_mode="strict")
    assert not reused.errors and reused.items[0].action == "REUSE"


def test_plan_hash_is_deterministic_and_tracks_only_material_dependencies():
    rows = [{"path": "E/DN/P/L/M", "name": "M", "type_key": "machine"}]
    first = plan_resources(rows, model(), TYPES)
    same = plan_resources(rows, model() + [ModelNode("other", "Other", "Other", "enterprise")], TYPES)
    assert first.plan_hash and first.plan_hash == same.plan_hash
    changed = plan_resources([{**rows[0], "name": "Changed"}], model(), TYPES)
    assert changed.plan_hash != first.plan_hash


def test_reverse_parent_code_chain_has_no_python_recursion_limit():
    rows = [{"code": f"A{index}", "name": f"A{index}", "type_key": "area",
             "parent_code": f"A{index-1}" if index else ""} for index in range(1100)]
    plan = plan_resources(list(reversed(rows)), [], TYPES)
    assert not plan.errors and len(plan.items) == 1100
    assert plan.items[-1].path.endswith("/A1098/A1099")


def test_reuse_preview_distinguishes_false_from_zero_and_reports_empty_description_difference():
    existing = model() + [ModelNode("m", "M", "Machine", "machine", parent_id="l", site_id="scope-a",
                                    description="Keep", properties={"value": False})]
    plan = plan_resources([{"path": "E/DN/P/L/M", "name": "Machine", "type_key": "machine",
                            "description": "", "properties": '{"value":0}'}], existing, TYPES)
    assert not plan.errors
    assert set(plan.items[0].differences) == {"description", "properties"}
    assert plan.items[0].properties == {"value": False} and plan.items[0].description == "Keep"


def test_legacy_parent_codes_merge_imported_reuse_rows_with_the_same_existing_identity():
    rows = [{"code": "M", "type_key": "machine", "name": "M", "parent_code": "L"},
            {"code": "L", "type_key": "line", "name": "Line", "parent_code": "P"},
            {"code": "P", "type_key": "plant", "name": "Plant", "parent_code": "DN"},
            {"code": "DN", "type_key": "site", "name": "Đồng Nai", "parent_code": "E"},
            {"code": "E", "type_key": "enterprise", "name": "Enterprise"}]
    plan = plan_resources(rows, model(), TYPES)
    assert not plan.errors
    assert [item.action for item in plan.items] == ["REUSE", "REUSE", "REUSE", "REUSE", "CREATE"]
    assert plan.items[-1].path == "E/DN/P/L/M" and plan.items[-1].site_id == "scope-a"


def test_explicit_null_or_nonfinite_metadata_is_not_silently_discarded():
    for field, value in (("properties", None), ("tags", None), ("properties", '{"value":NaN}')):
        plan = plan_resources([{"code": "M", "name": "M", "type_key": "machine", field: value}], [], TYPES)
        assert plan.errors and plan.plan_hash is None
