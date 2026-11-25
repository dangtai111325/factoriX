"""Unit tests for FactoriX Storage DSL AST, safety validator, SchemaCompiler & TDengine pure helpers (S05)."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from factorix.modules.storage_dsl import (
    CatalogModel,
    CatalogResource,
    CatalogSignal,
    StorageCatalogSnapshot,
    StorageDslError,
    compile_storage_plan,
    eval_safe_transform,
    parse_storage_dsl,
    resolve_and_validate_design,
    serialize_storage_dsl,
    validate_safe_transform,
)
from factorix.platform.tdengine import (
    TDEngineError,
    build_taosdump_commands,
    model_snapshot_subtable_name,
    op_stable_for_type,
    op_subtable_name,
    quote_ident,
    quote_str,
    sql_literal,
    tenant_database_name,
    to_td_timestamp_us,
    to_utc_datetime,
    validate_identifier,
)

SAMPLE_YAML = """
apiVersion: factorix.io/storage/v1
kind: StorageDesign
metadata:
  name: Line 1 Telemetry Archive
  description: Balanced storage for machine process telemetry
spec:
  scope:
    mode: subtree
    resource: $machine[AA10-01]
  destination:
    engine: tdengine
    dbStrategy: tenant_isolated
  datasets:
    - key: process_values
      displayName: Process Values
      semantics: state_series
      sourceKind: signals
      timeAxis: acquired_at
      tags:
        - key: plant
          value: Factory-1
      fields:
        - key: temp_c
          from: $machine[AA10-01].temp_1
          type: float64
          unit: "°C"
          transform: clamp(value * 1.0, -50, 500)
        - key: status_text
          from: $machine[AA10-01].`status.text`
          type: string
          maxLength: 256
      recording:
        mode: ON_CHANGE
        qualityTransitions: true
        deadband:
          kind: absolute
          value: 0.25
        maxCheckpointInterval: 60s
        lateTolerance: 5m
        missingPolicy: GAP_MARKER
      retention:
        days: 180
        legalHold: false
  uiMeta:
    nodes:
      ds-process:
        x: 120
        y: 80
"""


def test_dsl_lossless_yaml_and_json_round_trip() -> None:
    ast1 = parse_storage_dsl(SAMPLE_YAML)
    yaml_text = serialize_storage_dsl(ast1, output_format="yaml")
    ast2 = parse_storage_dsl(yaml_text, input_format="yaml")
    assert ast1 == ast2

    json_text = serialize_storage_dsl(ast2, output_format="json")
    ast3 = parse_storage_dsl(json_text, input_format="json")
    assert ast2 == ast3


def test_ui_meta_reposition_does_not_change_semantic_hash() -> None:
    ast1 = parse_storage_dsl(SAMPLE_YAML)
    moved_yaml = SAMPLE_YAML.replace("x: 120", "x: 480").replace("y: 80", "y: 260")
    ast2 = parse_storage_dsl(moved_yaml)

    assert ast1.semantic_hash() == ast2.semantic_hash()
    assert ast1.full_hash() != ast2.full_hash()


def test_dsl_rejects_rabbitmq_as_storage_destination() -> None:
    bad = SAMPLE_YAML.replace("engine: tdengine", "engine: rabbitmq")
    with pytest.raises(StorageDslError) as exc:
        parse_storage_dsl(bad)
    codes = {i.code for i in exc.value.issues}
    assert "INVALID_DESTINATION" in codes
    assert any("transport" in i.message.lower() for i in exc.value.issues)


def test_dsl_rejects_disabling_quality_transitions_and_bad_deadbands() -> None:
    bad_q = SAMPLE_YAML.replace("qualityTransitions: true", "qualityTransitions: false")
    with pytest.raises(StorageDslError) as exc_q:
        parse_storage_dsl(bad_q)
    assert any(i.code == "QUALITY_TRANSITIONS_MANDATORY" for i in exc_q.value.issues)

    # Deadband on string-only dataset must fail validation
    string_only = """
apiVersion: factorix.io/storage/v1
kind: StorageDesign
metadata:
  name: strings_only
spec:
  scope:
    mode: all_sites
  destination:
    engine: tdengine
  datasets:
    - key: states
      semantics: state_series
      fields:
        - key: label
          from: $machine[M1].label
          type: string
      recording:
        mode: ON_CHANGE
        qualityTransitions: true
        deadband:
          kind: absolute
          value: 0.5
      retention:
        days: 30
"""
    with pytest.raises(StorageDslError) as exc_db:
        parse_storage_dsl(string_only)
    assert any(i.code == "INVALID_DEADBAND_TYPE" for i in exc_db.value.issues)


def test_dsl_rejects_code_injection_sql_ddl_and_reserved_columns() -> None:
    for evil in (
        "__import__('os').system('id')",
        "value.__class__.__mro__",
        "[x for x in [1, 2]]",
        "DROP TABLE measurements",
    ):
        tree, issues = validate_safe_transform(evil)
        assert tree is None
        assert issues

    for dsl_payload in (
        "!!python/object/apply:os.system ['echo hi']",
        SAMPLE_YAML.replace("key: temp_c", "key: raw_quality"),
        SAMPLE_YAML.replace("clamp(value * 1.0, -50, 500)", "__import__('os').system('ls')"),
    ):
        with pytest.raises(StorageDslError):
            parse_storage_dsl(dsl_payload)

    with pytest.raises(StorageDslError) as syn:
        parse_storage_dsl("apiVersion: factorix.io/storage/v1\nmetadata:\n  name: [unclosed")
    assert syn.value.issues[0].code == "SYNTAX_ERROR"
    assert syn.value.issues[0].line is not None


def test_safe_transform_evaluation() -> None:
    tree, issues = validate_safe_transform("clamp((value - 32) * 5 / 9, -50, 300)")
    assert issues == [] and tree is not None
    assert eval_safe_transform(tree, 212) == pytest.approx(100.0)
    assert eval_safe_transform(tree, -500) == -50
    assert eval_safe_transform(tree, None) is None

    div0, _ = validate_safe_transform("10 / value")
    assert div0 is not None and eval_safe_transform(div0, 0) is None


def test_reference_resolution_and_schema_compiler_diff() -> None:
    tenant_id = uuid4()
    design_id = uuid4()
    res_id = str(uuid4())
    sig_temp = str(uuid4())
    sig_status = str(uuid4())
    mod_id = str(uuid4())

    catalog = StorageCatalogSnapshot(
        resources=[CatalogResource(id=res_id, type_key="machine", name="AA10-01", code="AA10-01")],
        signals=[
            CatalogSignal(
                id=sig_temp,
                resource_id=res_id,
                resource_name="AA10-01",
                type_key="machine",
                key="temp_1",
                data_type="float64",
                unit="°C",
                expected_interval_ms=1000,
            ),
            CatalogSignal(
                id=sig_status,
                resource_id=res_id,
                resource_name="AA10-01",
                type_key="machine",
                key="status.text",
                data_type="string",
                binding_enabled=False,
            ),
        ],
        models=[
            CatalogModel(
                id=mod_id,
                display_name="AA10-01 Energy",
                field_paths={"kwh": "float64", "batch.code": "string"},
            )
        ],
    )

    ast = parse_storage_dsl(SAMPLE_YAML)
    resolved, issues = resolve_and_validate_design(ast, catalog)
    errors = [i for i in issues if i.severity == "error"]
    assert errors == []
    # Warnings should include ON_CHANGE operational tier note + disabled binding note
    assert any(i.code == "EXACT_AGGREGATION_USES_OPERATIONAL_TIER" for i in issues)
    assert any(i.code == "SIGNAL_BINDING_DISABLED" for i in issues)
    assert resolved.spec.datasets[0].fields[0].signal_id == sig_temp
    assert resolved.spec.datasets[0].fields[1].signal_id == sig_status

    plan1 = compile_storage_plan(resolved, tenant_id=tenant_id, design_id=design_id, target_version=1)
    assert plan1.td_database == tenant_database_name(tenant_id)
    assert len(plan1.series) == 2
    assert any("CREATE STABLE IF NOT EXISTS" in ddl for ddl in plan1.ddl_statements)
    assert plan1.diff.is_breaking is False

    # Add a column mapped from a Data Model field -> non-breaking ADD COLUMN diff
    v2_yaml = SAMPLE_YAML.replace(
        "      recording:",
        "        - key: model_kwh\n"
        "          from: $model[AA10-01 Energy].kwh\n"
        "          type: float64\n"
        "      recording:",
    )
    ast_v2 = parse_storage_dsl(v2_yaml)
    res_v2, issues_v2 = resolve_and_validate_design(ast_v2, catalog)
    assert [i for i in issues_v2 if i.severity == "error"] == []
    assert res_v2.spec.datasets[0].fields[2].model_id == mod_id
    assert res_v2.spec.datasets[0].fields[2].model_field_path == "kwh"

    plan2 = compile_storage_plan(
        res_v2, tenant_id=tenant_id, design_id=design_id, target_version=2, previous_plan=plan1.to_dict()
    )
    assert plan2.diff.is_breaking is False
    assert any("ALTER STABLE" in s and "ADD COLUMN `model_kwh` DOUBLE" in s for s in plan2.diff.ddl_statements)

    # Reduce retention & mutate column type -> breaking diff
    v3_yaml = SAMPLE_YAML.replace("type: float64", "type: int64").replace("days: 180", "days: 30")
    ast_v3 = parse_storage_dsl(v3_yaml)
    plan3 = compile_storage_plan(
        ast_v3, tenant_id=tenant_id, design_id=design_id, target_version=3, previous_plan=plan1.to_dict()
    )
    assert plan3.diff.is_breaking is True
    assert len(plan3.diff.breaking_changes) >= 2


def test_tdengine_pure_safety_helpers() -> None:
    tid = uuid4()
    db = tenant_database_name(tid)
    assert db == f"fx_t_{tid.hex}"
    assert validate_identifier(db) == db
    assert quote_ident(db) == f"`{db}`"
    assert op_stable_for_type("enum") == "op_string"
    assert op_subtable_name(tid, "float64") == f"op_float64_{tid.hex}"
    assert model_snapshot_subtable_name(tid) == f"ms_{tid.hex}"

    for unsafe in ("bad name", "tbl; DROP DATABASE x", "", "123abc", "x" * 65):
        with pytest.raises(TDEngineError):
            validate_identifier(unsafe)

    # Escaping \ before ' keeps JSON unicode escape sequences intact
    q = quote_str(r'{"u":"\u00b0C","q":"it\'s"}')
    assert r"\\" in q and r"\'" in q
    with pytest.raises(TDEngineError):
        quote_str("abc\x00def")

    assert sql_literal(True, value_type="bool") == "true"
    assert sql_literal(False, value_type="bool") == "false"
    assert sql_literal(2**63 - 1, value_type="int64") == str(2**63 - 1)
    assert sql_literal(-0.0, value_type="float64") == "-0.0"

    for bad_num in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(TDEngineError) as e:
            sql_literal(bad_num, value_type="float64")
        assert e.value.code == "NON_FINITE_FLOAT"

    with pytest.raises(TDEngineError):
        sql_literal(2**63, value_type="int64")

    # Exact microsecond round-trip without float drift
    dt = datetime(2026, 11, 10, 12, 34, 56, 789123, tzinfo=timezone.utc)
    us = to_td_timestamp_us(dt)
    assert to_utc_datetime(us) == dt

    cmds = build_taosdump_commands(db, "/tmp/dump")
    assert cmds["backup"][:2] == ["taosdump", "-h"]
    assert db in cmds["backup"]
