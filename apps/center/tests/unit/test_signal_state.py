"""Unit tests for domain signal state evaluation according to Review 4 specifications."""

from datetime import datetime, timedelta, timezone
import pytest

from factorix.domain.signal_state import (
    EffectiveStatus,
    Freshness,
    ReasonCode,
    SourceQuality,
    evaluate_signal_state,
)


def test_q01_signal_becomes_stale_when_elapsed_exceeds_threshold():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    event_time = now - timedelta(seconds=15)
    res = evaluate_signal_state(
        has_observation=True,
        raw_quality="GOOD",
        raw_value=42.5,
        event_time=event_time,
        expected_interval_ms=1000,  # 1000ms -> min_stale_ms = 5000ms (5s)
        now=now,
    )
    assert res.effective_status == "STALE"
    assert res.freshness == "STALE"
    assert res.reason_code == "NO_FRESH_ACQUISITION"


def test_q05_expected_interval_60s_not_stale_at_5s():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    event_time = now - timedelta(seconds=10)
    res = evaluate_signal_state(
        has_observation=True,
        raw_quality="GOOD",
        raw_value=42.5,
        event_time=event_time,
        expected_interval_ms=60000,  # 60s -> stale_after = 120s
        now=now,
    )
    assert res.effective_status == "GOOD"
    assert res.freshness == "FRESH"
    assert res.stale_after_ms == 120000


def test_q07_source_quality_bad_produces_bad_status():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    res = evaluate_signal_state(
        has_observation=True,
        raw_quality="BAD",
        raw_value=12.0,
        event_time=now,
        raw_reason_code="DEVICE_FAILURE",
        last_good_value=50.0,
        last_good_time=now - timedelta(minutes=5),
        now=now,
    )
    assert res.effective_status == "BAD"
    assert res.source_quality == "BAD"
    assert res.reason_code == "DEVICE_FAILURE"
    assert res.last_good is not None
    assert res.last_good["value"] == 50.0


def test_q08_source_quality_uncertain_produces_uncertain_status():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    res = evaluate_signal_state(
        has_observation=True,
        raw_quality="UNCERTAIN",
        raw_value=12.0,
        event_time=now,
        now=now,
    )
    assert res.effective_status == "UNCERTAIN"
    assert res.source_quality == "UNCERTAIN"


def test_q09_null_scalar_value_with_good_quality_is_rejected():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    res = evaluate_signal_state(
        has_observation=True,
        raw_quality="GOOD",
        raw_value=None,
        event_time=now,
        now=now,
    )
    assert res.effective_status == "BAD"
    assert res.reason_code == "NULL_VALUE"


def test_q11_boolean_false_and_integer_zero_are_valid_good_values():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    res_bool = evaluate_signal_state(
        has_observation=True,
        raw_quality="GOOD",
        raw_value=False,
        event_time=now,
        now=now,
    )
    assert res_bool.effective_status == "GOOD"

    res_zero = evaluate_signal_state(
        has_observation=True,
        raw_quality="GOOD",
        raw_value=0,
        event_time=now,
        now=now,
    )
    assert res_zero.effective_status == "GOOD"


def test_disabled_signal_evaluates_to_disabled():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    res = evaluate_signal_state(
        has_observation=True,
        raw_quality="GOOD",
        raw_value=100.0,
        event_time=now,
        binding_enabled=False,
        now=now,
    )
    assert res.effective_status == "DISABLED"
    assert res.reason_code == "DISABLED"


def test_no_observation_evaluates_to_no_data():
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    res = evaluate_signal_state(
        has_observation=False,
        raw_quality=None,
        raw_value=None,
        event_time=None,
        now=now,
    )
    assert res.effective_status == "NO_DATA"
    assert res.freshness == "NO_DATA"
    assert res.reason_code == "NO_OBSERVATIONS"
