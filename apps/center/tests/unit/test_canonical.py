"""Unit tests for canonical v1 telemetry contracts, validation, redaction, and SLIs (S02)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from factorix.domain.canonical import (
    CANONICAL_SCHEMA_VERSION,
    CanonicalObservation,
    CanonicalProvenance,
    derive_event_uid,
    measure_latency_slis,
    normalize_value_type,
    redact_provenance,
)
from factorix.domain.observation import EDGE_CLOCK_FUTURE, ObservationError, SOURCE_TIME_FUTURE
from factorix.domain.quality import Origin, Quality

NOW = datetime(2026, 11, 10, 11, 30, 0, 123456, tzinfo=timezone.utc)
TENANT_ID = uuid4()
SITE_ID = uuid4()
CONN_ID = uuid4()
JOB_ID = uuid4()
FIELD_ID = uuid4()
SIGNAL_ID = uuid4()
RESOURCE_ID = uuid4()


def _sample(value_type: str, value: object, **overrides: object) -> CanonicalObservation:
    kwargs: dict[str, object] = {
        "event_uid": derive_event_uid(
            tenant_id=TENANT_ID,
            connection_id=CONN_ID,
            source_field_id=FIELD_ID,
            signal_id=SIGNAL_ID,
            acquired_at=NOW,
            sequence_or_key="seq-1",
            data_epoch=1,
        ),
        "tenant_id": TENANT_ID,
        "site_id": SITE_ID,
        "connection_id": CONN_ID,
        "acquisition_job_id": JOB_ID,
        "source_field_id": FIELD_ID,
        "signal_id": SIGNAL_ID,
        "resource_id": RESOURCE_ID,
        "source_time": NOW - timedelta(milliseconds=50),
        "acquired_at": NOW,
        "ingested_at": NOW + timedelta(milliseconds=12),
        "value_type": value_type,
        "value": value,
        "unit": "°C",
        "quality": Quality.GOOD,
        "quality_reason": "OK",
        "origin": Origin.LIVE,
        "data_epoch": 1,
        "config_revision": 4,
        "provenance": CanonicalProvenance(
            protocol="opcua",
            connection_id=CONN_ID,
            job_id=JOB_ID,
            source_field_id=FIELD_ID,
            config_revision=4,
            address_kind="opcua",
            address_summary="ns=2;s=Machine.Temp",
        ),
        "correlation_id": "corr-123",
    }
    kwargs.update(overrides)
    return CanonicalObservation(**kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("value_type", "value"),
    [
        ("bool", True),
        ("bool", False),
        ("int64", 0),
        ("int64", 2**63 - 1),
        ("int64", -(2**63)),
        ("float64", 42.125),
        ("float64", -0.0),
        ("string", "Tiếng Việt · Nhiệt độ ổn định 42.5 °C"),
        ("enum", "RUNNING_AUTO"),
        ("json", {"nested": [1, True, "ok", {"k": None}]}),
        ("float64", None),
    ],
)
def test_canonical_round_trip_all_types(value_type: str, value: object) -> None:
    obs = _sample(value_type, value)
    raw = obs.to_json_bytes()
    restored = CanonicalObservation.from_json_bytes(raw)
    assert restored.schema_version == CANONICAL_SCHEMA_VERSION
    assert restored.value_type == value_type
    assert restored.value == value
    if value is not None and value_type == "bool":
        assert isinstance(restored.value, bool)
    if value is not None and value_type == "int64":
        assert type(restored.value) is int
    assert restored.tenant_id == TENANT_ID
    assert restored.signal_id == SIGNAL_ID
    assert restored.acquired_at == NOW
    assert restored.source_time == NOW - timedelta(milliseconds=50)
    assert restored.provenance is not None
    assert restored.provenance.protocol == "opcua"
    assert restored.provenance.config_revision == 4
    assert restored.to_value_json() == {"v": value}


def test_canonical_rejects_type_confusion_and_non_finite() -> None:
    with pytest.raises(ObservationError, match="bool"):
        _sample("bool", 1)
    with pytest.raises(ObservationError, match="integer"):
        _sample("int64", True)
    with pytest.raises(ObservationError, match="out of range"):
        _sample("int64", 2**63)
    with pytest.raises(ObservationError, match="NaN or Infinity"):
        _sample("float64", float("nan"))
    with pytest.raises(ObservationError, match="NaN or Infinity"):
        _sample("float64", float("inf"))
    with pytest.raises(ObservationError, match="non-finite"):
        _sample("json", {"bad": float("inf")})
    with pytest.raises(ObservationError, match="nesting depth"):
        nested: dict[str, object] = {}
        cur = nested
        for _ in range(18):
            nxt: dict[str, object] = {}
            cur["a"] = nxt
            cur = nxt
        _sample("json", nested)
    with pytest.raises(ObservationError, match="8192"):
        _sample("string", "x" * 8193)


def test_canonical_validates_timestamps_epochs_and_uid() -> None:
    naive = datetime(2026, 11, 10, 12, 0, 0)
    with pytest.raises(ValueError, match="timezone-aware"):
        _sample("float64", 1.0, acquired_at=naive)
    with pytest.raises(ObservationError, match="epoch"):
        _sample("float64", 1.0, data_epoch=0)
    with pytest.raises(ObservationError, match="revision"):
        _sample("float64", 1.0, config_revision=0)
    with pytest.raises(ObservationError, match="event_uid"):
        _sample("float64", 1.0, event_uid="bad\nuid")
    bad_payload = json.loads(_sample("float64", 1.0).to_json_bytes().decode("utf-8"))
    bad_payload["schema_version"] = 99
    with pytest.raises(ObservationError, match="UNSUPPORTED|Unsupported|schema_version"):
        CanonicalObservation.from_dict(bad_payload)


def test_provenance_redacts_secrets_and_url_userinfo() -> None:
    cleaned = redact_provenance(
        {
            "password": "my-secret-password",
            "api_token": "tok-12345",
            "endpoint": "mqtt://plcuser:plcpw@10.0.0.5:1883",
            "nested": {"secret_key": "abc", "topic": "factory/line1/temp"},
        }
    )
    assert cleaned["password"] == "***REDACTED***"
    assert cleaned["api_token"] == "***REDACTED***"
    assert "plcpw" not in cleaned["endpoint"]
    assert cleaned["endpoint"] == "mqtt://***:***@10.0.0.5:1883"
    assert cleaned["nested"]["secret_key"] == "***REDACTED***"
    assert cleaned["nested"]["topic"] == "factory/line1/temp"

    prov = CanonicalProvenance(
        protocol="http",
        connection_id=CONN_ID,
        job_id=JOB_ID,
        source_field_id=FIELD_ID,
        config_revision=2,
        address_summary="https://admin:hunter2@192.168.1.50/api",
        extra={"auth_header": "Bearer abc"},
    )
    as_dict = prov.to_dict()
    assert "hunter2" not in str(as_dict)
    assert "Bearer abc" not in str(as_dict)


def test_legacy_conversion_applies_factorix_time_model() -> None:
    center_now = NOW
    # Future source_time downgrades GOOD -> UNCERTAIN with SOURCE_TIME_FUTURE
    obs = _sample("float64", 10.5, acquired_at=center_now, source_time=center_now + timedelta(minutes=10))
    legacy = obs.to_legacy_observation(now=center_now)
    assert legacy.quality == Quality.UNCERTAIN
    assert legacy.provenance is not None
    assert legacy.provenance["reason"] == SOURCE_TIME_FUTURE
    assert legacy.event_time == center_now

    # Implausible future acquired_at is clamped to center_now
    future_obs = _sample("float64", 10.5, acquired_at=center_now + timedelta(minutes=15), source_time=None)
    legacy2 = future_obs.to_legacy_observation(now=center_now)
    assert legacy2.event_time == center_now
    assert legacy2.quality == Quality.UNCERTAIN
    assert legacy2.provenance is not None
    assert legacy2.provenance["reason"] == EDGE_CLOCK_FUTURE


def test_uid_determinism_type_aliases_and_sli_measurements() -> None:
    u1 = derive_event_uid(
        tenant_id=TENANT_ID,
        connection_id=CONN_ID,
        source_field_id=FIELD_ID,
        signal_id=SIGNAL_ID,
        acquired_at=NOW,
        sequence_or_key=1,
        data_epoch=1,
    )
    u2 = derive_event_uid(
        tenant_id=TENANT_ID,
        connection_id=CONN_ID,
        source_field_id=FIELD_ID,
        signal_id=SIGNAL_ID,
        acquired_at=NOW,
        sequence_or_key=1,
        data_epoch=2,
    )
    assert u1 != u2
    assert normalize_value_type("boolean") == "bool"
    assert normalize_value_type("analog") == "float64"
    assert normalize_value_type("uint16") == "int64"

    slis = measure_latency_slis(
        acquired_at=NOW,
        ingested_at=NOW + timedelta(milliseconds=25),
        committed_at=NOW + timedelta(milliseconds=40),
    )
    assert slis.acquisition_to_ingest_ms == 25.0
    assert slis.ingest_to_commit_ms == 15.0
    assert slis.acquisition_to_commit_ms == 40.0
    assert slis.clock_skew_ms == 0.0
