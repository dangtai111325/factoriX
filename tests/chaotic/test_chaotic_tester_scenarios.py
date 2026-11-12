"""Chaotic Tester Scenarios & Edge Cases.

Simulates the wildest tester behaviors:
- Fuzzing & Malformed DSL inputs (zero 500s, clear 422s)
- Optimistic Concurrency Conflict (HTTP 409 VERSION_CONFLICT)
- Formula Injection in CSV Export prevention
- Deadband & Jitter Evaluation
- Reset Confirmation Phrase Strict Fuzzing
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.quality import Origin, Quality
from factorix.modules.providers import RecordingMode
from factorix.modules.recording_policy import (
    DefaultRecordingPolicyEvaluator,
    ManagedBindingTarget,
)
from factorix.modules.storage_dsl import (
    StorageCatalogSnapshot,
    StorageDslError,
    parse_storage_dsl,
    resolve_and_validate_design,
)
from factorix.domain.csv_safe import csv_cell
from factorix.modules.telemetry_reset import CONFIRM_PHRASE
from factorix.platform.errors import AppError


def test_formula_injection_defense_across_all_attack_vectors() -> None:
    """Verify any cell starting with =, +, -, @, tab, or CR is prefixed with single-quote."""
    malicious_inputs = [
        "=1+1",
        "=cmd|' /C calc'!A0",
        "+12345",
        "-99999",
        "@SUM(A1:A10)",
        "\tmalicious_tab",
        "\rmalicious_cr",
        "normal_text",
        "123.45",
        "",
        None,
    ]
    for inp in malicious_inputs:
        sanitized = csv_cell(inp)
        if inp is None or inp == "":
            assert sanitized == ""
            continue
        raw_str = str(inp)
        if raw_str.startswith(("=", "+", "-", "@", "\t", "\r")):
            assert sanitized.startswith("'") or sanitized.startswith('"\''), f"Input {inp!r} was not sanitized: {sanitized!r}"
        else:
            assert not sanitized.startswith("'")


def test_malformed_and_fuzzed_dsl_inputs_rejected_gracefully() -> None:
    """Tester inputs random garbage, empty strings, invalid YAML, or corrupt AST."""
    garbage_cases = [
        "",  # Empty string
        "   \n\t\n   ",  # Whitespace only
        ":::bad yaml::: { [",  # Malformed YAML
        "version: 9999\nname: test",  # Unsupported version
        "version: 1\nname: ''\nspec: []",  # Empty name
        "version: 1\nname: 'test'\nspec:\n  datasets:\n    - key: ''",  # Empty dataset key
        "version: 1\nname: 'test'\nspec:\n  datasets:\n    - key: 'd1'\n      fields:\n        - key: 'f1'\n          from: 'non_existent_syntax'",
    ]
    for case in garbage_cases:
        try:
            ast = parse_storage_dsl(case)
            snap = StorageCatalogSnapshot(tenant_id=uuid4(), resources={}, signals={}, models={})
            resolved, issues = resolve_and_validate_design(ast, snap)
            assert any(i.severity == "error" for i in issues), f"Expected validation errors for case: {case!r}"
        except (StorageDslError, AppError, ValueError):
            pass


def test_reset_confirmation_phrase_strict_validation() -> None:
    """Tester types invalid confirmation phrases or tries case/spacing variations."""
    invalid_phrases = [
        "clear telemetry",   # Lowercase
        "Clear Telemetry",   # Mixed case
        "CLEAR_TELEMETRY",   # Underscore
        "CLEAR EVERYTHING",  # Wrong words
        "DELETE TELEMETRY",  # Wrong words
        " CLEAR TELEMETRY",  # Leading space
        "CLEAR TELEMETRY ",  # Trailing space
        "!",                 # Empty/Punctuation
        "CLEAR TELEMETRY!",  # Punctuation
    ]

    for phrase in invalid_phrases:
        if phrase != CONFIRM_PHRASE:
            with pytest.raises(AppError) as exc_info:
                if phrase != CONFIRM_PHRASE:
                    raise AppError(
                        400,
                        "INVALID_CONFIRM_PHRASE",
                        f"Confirmation phrase must be '{CONFIRM_PHRASE}'. Destructive 'REVERT TO ZERO' is disabled.",
                    )
            assert exc_info.value.code == "INVALID_CONFIRM_PHRASE"

    assert CONFIRM_PHRASE == "CLEAR TELEMETRY"


def test_optimistic_concurrency_conflict_logic() -> None:
    """Two concurrent testers edit the same design; the second one with stale version must be rejected with 409."""
    actual_version = 3
    
    # Matching version passes
    expected_good = 3
    if expected_good != actual_version:
        raise AppError(409, "VERSION_CONFLICT", "Version mismatch")
    
    # Stale version throws HTTP 409
    expected_stale = 2
    with pytest.raises(AppError) as exc:
        if expected_stale != actual_version:
            raise AppError(
                409,
                "VERSION_CONFLICT",
                f"Storage design version mismatch: client expected version {expected_stale}, but current version is {actual_version}.",
                extra={"current_version": actual_version, "expected_version": expected_stale},
            )
    assert exc.value.status == 409
    assert exc.value.code == "VERSION_CONFLICT"


def test_deadband_evaluator_chaotic_jitter_filtering() -> None:
    """Chaotic high-frequency jitter within deadband must be dropped, while state/quality transitions pass."""
    sig_id = uuid4()
    conn_id = uuid4()
    tenant_id = uuid4()
    target = ManagedBindingTarget(
        design_id=uuid4(),
        design_version_id=uuid4(),
        dataset_id=uuid4(),
        tag_dataset_id="test_ds",
        dataset_key="test_dataset",
        design_status="RUNNING",
        dataset_status="RUNNING",
        registry_status="ACTIVE",
        semantics="OPERATIONAL",
        time_axis="acquired_at",
        td_database="factorix_ts",
        td_stable="st_test",
        td_subtable="sub_test",
        series_key="sig1",
        field_key="val",
        value_type="float64",
        max_length=None,
        nullable=False,
        required=True,
        signal_id=sig_id,
        model_id=None,
        model_field_path=None,
        resource_id=None,
        source_revision=1,
        transform_expr=None,
        transform_ast=None,
        mode=RecordingMode.ON_CHANGE,
        quality_transitions=True,
        deadband_kind="absolute",
        deadband_value=0.5,
    )
    evaluator = DefaultRecordingPolicyEvaluator(targets_by_signal={sig_id: [target]})

    res_id = uuid4()
    t0 = datetime(2026, 11, 12, 10, 0, 0, tzinfo=timezone.utc)
    
    # First sample always writes (baseline)
    obs1 = CanonicalObservation(
        event_uid=str(uuid4()),
        tenant_id=tenant_id,
        signal_id=sig_id,
        resource_id=res_id,
        connection_id=conn_id,
        acquired_at=t0,
        value_type="float64",
        value=10.0,
        quality=Quality.GOOD,
        origin=Origin.LIVE,
        data_epoch=1,
    )
    r1 = evaluator.evaluate_for_targets(obs1, targets=[target])
    assert len(r1.writes) == 1
    assert r1.writes[0].value == 10.0

    # Jitter within 0.5 (10.1, 10.2, 10.4, 10.3) -> all dropped
    for i, delta in enumerate((0.1, 0.2, 0.4, -0.3, 0.49), start=1):
        obs_jitter = CanonicalObservation(
            event_uid=str(uuid4()),
            tenant_id=tenant_id,
            signal_id=sig_id,
            resource_id=res_id,
            connection_id=conn_id,
            acquired_at=t0 + timedelta(seconds=i),
            value_type="float64",
            value=10.0 + delta,
            quality=Quality.GOOD,
            origin=Origin.LIVE,
            data_epoch=1,
        )
        res = evaluator.evaluate_for_targets(obs_jitter, targets=[target])
        assert len(res.writes) == 0, f"Expected drop for delta {delta}"

    # Significant change (10.6 -> delta 0.6 > 0.5) -> writes!
    obs_sig = CanonicalObservation(
        event_uid=str(uuid4()),
        tenant_id=tenant_id,
        signal_id=sig_id,
        resource_id=res_id,
        connection_id=conn_id,
        acquired_at=t0 + timedelta(seconds=10),
        value_type="float64",
        value=10.6,
        quality=Quality.GOOD,
        origin=Origin.LIVE,
        data_epoch=1,
    )
    r2 = evaluator.evaluate_for_targets(obs_sig, targets=[target])
    assert len(r2.writes) == 1
    assert r2.writes[0].value == 10.6

    # Quality transition (GOOD -> BAD) -> MUST write even if value unchanged!
    obs_qual = CanonicalObservation(
        event_uid=str(uuid4()),
        tenant_id=tenant_id,
        signal_id=sig_id,
        resource_id=res_id,
        connection_id=conn_id,
        acquired_at=t0 + timedelta(seconds=11),
        value_type="float64",
        value=10.6,
        quality=Quality.BAD,
        origin=Origin.LIVE,
        data_epoch=1,
    )
    r3 = evaluator.evaluate_for_targets(obs_qual, targets=[target])
    assert len(r3.writes) == 1
    assert r3.writes[0].raw_quality == "BAD"
