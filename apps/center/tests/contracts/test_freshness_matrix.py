"""Characterization: the same signal record pushed through every freshness evaluator (contract freshness.md).

Reference = the canonical rule (``domain.signal_state.evaluate_signal_state``) given full evidence, as agreed in
v6_contracts Q2: ``stale_after_ms = max(2 x interval, 12 s)`` with interval = signal ``expected_interval_ms``
falling back to the job ``interval_ms``, and DELAYED when acquisition still reads the source.

Every evaluator that disagrees with the reference today is an ``xfail(strict=True)`` cell whose reason names
the discrepancy id (docs/architecture/contracts/README.md). Fixing an evaluator turns its cell XPASS ->
FAIL: remove the entry from ``KNOWN_MISMATCHES`` in the same change and update the contract doc.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import UUID, uuid4

import pytest

from factorix.domain import quality as Q
from factorix.domain.signal_state import evaluate_signal_state
from factorix.modules import models_engine
from factorix.modules.live_state import PipelineEvidence, TDengineLiveStateProvider, refresh_live_message
from factorix.modules.providers import LiveSignalRecord
from factorix.modules.telemetry import latest_stream_payload

NOW = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
TENANT = UUID("00000000-0000-0000-0000-0000000000a1")
CONNECTION = "00000000-0000-0000-0000-0000000000c1"


@dataclass(frozen=True)
class Scenario:
    """One signal as Center sees it at ``NOW``."""

    name: str
    age_s: float  # NOW - last_acquired_at
    signal_interval_ms: int | None  # signal_definitions.expected_interval_ms
    job_interval_ms: int  # acquisition_jobs.interval_ms of the signal's connection
    source_ok_age_s: float | None  # NOW - connections.last_success_at (acquisition evidence)
    delivered_age_s: float | None  # NOW - newest acquired_at Center received from the same connection
    expected_status: str  # effective_status
    expected_freshness: str


SCENARIOS = [
    Scenario("fresh_fast_poll", 3, 1000, 1000, 1, 3, "GOOD", "FRESH"),
    # 30 s poll, no per-signal interval: threshold must come from the job interval (60 s), not 1000 ms (12 s).
    Scenario("slow_poll_job_interval_only", 20, None, 30_000, 2, 20, "GOOD", "FRESH"),
    # Acquisition still reads the source (evidence 2 s old) but Center's newest value is 30 s old: in transit.
    Scenario("delayed_in_transit", 30, 1000, 1000, 2, 30, "GOOD", "DELAYED"),
    # Newer data of the same connection arrives (2 s old) but none for this signal: the source is silent.
    Scenario("silent_source", 30, 1000, 1000, 2, 2, "STALE", "STALE"),
    # Delivery stuck far beyond the cap max(10 x 12 s, 300 s).
    Scenario("stalled_delivery", 400, 1000, 1000, 2, 400, "STALE", "STALE"),
    # Boundary: 5 s interval -> threshold max(10 s, 12 s) = 12 s; an 11 s old value is still FRESH.
    Scenario("boundary_interval_5s_age_11s", 11, 5000, 5000, 1, 11, "GOOD", "FRESH"),
]


def _t(age_s: float | None) -> datetime | None:
    return None if age_s is None else NOW - timedelta(seconds=age_s)


def _evidence(sc: Scenario, signal_id: UUID) -> PipelineEvidence:
    ev = PipelineEvidence()
    ev.set_mapping(
        [{"signal_id": signal_id, "connection_id": CONNECTION, "expected_interval_ms": sc.signal_interval_ms, "interval_ms": sc.job_interval_ms}],
        now=NOW,
    )
    if sc.source_ok_age_s is not None:
        ev.set_source([{"id": CONNECTION, "last_success_at": _t(sc.source_ok_age_s)}], reported_at=NOW - timedelta(seconds=1))
    if sc.delivered_age_s is not None:
        ev.note_delivery(signal_id, _t(sc.delivered_age_s), connection_id=CONNECTION)
    return ev


# ---------------------------------------------------------------------------- evaluators
# Each returns (effective_status, freshness | None). None = the evaluator does not expose freshness.


def ev_reference(sc: Scenario, sid: UUID) -> tuple[str, str | None]:
    r = evaluate_signal_state(
        has_observation=True,
        raw_quality="GOOD",
        raw_value=1.0,
        event_time=_t(sc.age_s),
        last_acquired_at=_t(sc.age_s),
        expected_interval_ms=sc.signal_interval_ms or sc.job_interval_ms,
        now=NOW,
        source_ok_at=_t(sc.source_ok_age_s),
        source_reported_at=NOW - timedelta(seconds=1),
        delivered_at=_t(sc.delivered_age_s),
    )
    return r.effective_status, r.freshness


def _record(sc: Scenario, sid: UUID) -> LiveSignalRecord:
    at = _t(sc.age_s)
    assert at is not None
    return LiveSignalRecord(
        tenant_id=TENANT, signal_id=sid, resource_id=uuid4(), observation_id=None, event_uid="fx-1-test",
        data_epoch=1, value_type="float64", value=1.0, unit=None, raw_quality="GOOD", reason_code=None,
        event_time=at, last_acquired_at=at, last_value_changed_at=at, source_time=at, config_revision=1,
        origin="LIVE", last_good_value=1.0, last_good_at=at, updated_at=at,
    )


def ev_live_provider(sc: Scenario, sid: UUID) -> tuple[str, str | None]:
    """API live cache (REST latest with provider, Data Models with provider, models engine live path)."""
    provider = TDengineLiveStateProvider(None)
    provider.seed_from_record(_record(sc, sid), expected_interval_ms=sc.signal_interval_ms)
    r = provider.evaluate_signal(
        TENANT, sid, expected_interval_ms=sc.signal_interval_ms, now=NOW, require_session_verification=False,
        connection_id=CONNECTION, evidence=_evidence(sc, sid),
    ).evaluation
    return r.effective_status, r.freshness


def ev_push_refresh(sc: Scenario, sid: UUID) -> tuple[str, str | None]:
    """Hub dispatch / 5 s sweep re-evaluation of a pushed ``latest`` message."""
    message = {
        "type": "latest", "signal_id": str(sid), "value": 1.0, "quality": "GOOD", "effective_status": "GOOD",
        "reason_code": "OK", "last_acquired_at": _t(sc.age_s).isoformat(),  # type: ignore[union-attr]
    }
    out = refresh_live_message(message, now=NOW, evidence=_evidence(sc, sid))
    return str(out.get("effective_status")), out.get("freshness")


def ev_ingestion_commit(sc: Scenario, sid: UUID) -> tuple[str, str | None]:
    """What ingestion puts into the v1 NOTIFY payload at commit time (no evidence, signal interval only)."""
    at = _t(sc.age_s)
    p = latest_stream_payload(
        signal_id=sid, value=1.0, quality="GOOD", reason=None, received_time=at, source_time=at,  # type: ignore[arg-type]
        expected_interval_ms=sc.signal_interval_ms, now=NOW, include_meta=True, last_acquired_at=at,
    )
    return str(p["effective_status"]), p.get("freshness")


def ev_models_engine_pg_fallback(sc: Scenario, sid: UUID) -> tuple[str, str | None]:
    """``models_engine.sample_from_latest``: PG fallback of the model engine (same call shape as
    ``data_models.signal_states`` without a provider and ``telemetry.latest_states`` without a provider)."""
    at = _t(sc.age_s)
    row = {"value_json": {"v": 1.0}, "quality": "GOOD", "received_time": at, "last_acquired_at": at,
           "expected_interval_ms": sc.signal_interval_ms, "source_time": at}
    _sample, quality = models_engine.sample_from_latest(row, now=NOW)
    return quality, None


def ev_historian_catalog(sc: Scenario, sid: UUID) -> tuple[str, str | None]:
    """Historian source catalog freshness badge (``historian_catalog._freshness``, signal interval only)."""
    mod = importlib.import_module("factorix.modules.historian_catalog")
    fresh = mod._freshness(_t(sc.age_s), sc.signal_interval_ms, NOW)
    return ("GOOD" if fresh == "FRESH" else "STALE"), fresh


def ev_quality_freshness_status(sc: Scenario, sid: UUID) -> tuple[str, str | None]:
    """``domain.quality.freshness_status`` (no caller; kept for archival decision D3)."""
    at = _t(sc.age_s)
    f = Q.freshness_status(event_time=at, received_time=at, expected_interval_ms=sc.signal_interval_ms, now=NOW, quality=Q.Quality.GOOD)
    return ("GOOD" if f == Q.Freshness.FRESH else "STALE"), str(f)


EVALUATORS: dict[str, Callable[[Scenario, UUID], tuple[str, str | None]]] = {
    "live_provider": ev_live_provider,
    "push_refresh": ev_push_refresh,
    "ingestion_commit": ev_ingestion_commit,
    "models_engine_pg_fallback": ev_models_engine_pg_fallback,
    "historian_catalog": ev_historian_catalog,
    "quality_freshness_status": ev_quality_freshness_status,
}

_NO_EVIDENCE = "CT-10: evaluator gets no pipeline evidence (source_ok/delivered) -> cannot tell DELAYED from STALE"
_NO_JOB_INTERVAL = "CT-10: evaluator falls back to 1000 ms instead of the job interval_ms -> 12 s threshold for a 30 s poll"
_DEAD_RULE = "CT-11: quality.freshness_status uses a 5 s fallback and no 12 s floor (dead code, not the canonical rule)"

# (evaluator, scenario) -> reason. Everything else must agree with the reference.
KNOWN_MISMATCHES: dict[tuple[str, str], str] = {
    ("ingestion_commit", "slow_poll_job_interval_only"): _NO_JOB_INTERVAL,
    ("ingestion_commit", "delayed_in_transit"): _NO_EVIDENCE,
    ("models_engine_pg_fallback", "slow_poll_job_interval_only"): _NO_JOB_INTERVAL,
    ("models_engine_pg_fallback", "delayed_in_transit"): _NO_EVIDENCE,
    ("historian_catalog", "slow_poll_job_interval_only"): _NO_JOB_INTERVAL,
    ("historian_catalog", "delayed_in_transit"): _NO_EVIDENCE + " (and the badge has no DELAYED state)",
    ("quality_freshness_status", "fresh_fast_poll"): _DEAD_RULE + " (1 s interval -> 2 s threshold)",
    ("quality_freshness_status", "slow_poll_job_interval_only"): _DEAD_RULE,
    ("quality_freshness_status", "delayed_in_transit"): _DEAD_RULE,
    ("quality_freshness_status", "boundary_interval_5s_age_11s"): _DEAD_RULE,
}


def _cells() -> list[Any]:
    cells = []
    for ev_name in EVALUATORS:
        for sc in SCENARIOS:
            marks = []
            reason = KNOWN_MISMATCHES.get((ev_name, sc.name))
            if reason:
                marks.append(pytest.mark.xfail(strict=True, raises=AssertionError, reason=reason))
            cells.append(pytest.param(ev_name, sc, id=f"{ev_name}-{sc.name}", marks=marks))
    return cells


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s.name for s in SCENARIOS])
def test_reference_rule_matches_contract(scenario: Scenario) -> None:
    """The canonical rule itself produces the verdicts written in freshness.md."""
    status, freshness = ev_reference(scenario, uuid4())
    assert (status, freshness) == (scenario.expected_status, scenario.expected_freshness)


@pytest.mark.parametrize(("evaluator", "scenario"), _cells())
def test_evaluator_agrees_with_reference(evaluator: str, scenario: Scenario) -> None:
    sid = uuid4()
    status, freshness = EVALUATORS[evaluator](scenario, sid)
    assert status == scenario.expected_status, f"{evaluator}: effective_status {status} != {scenario.expected_status}"
    if freshness is not None:
        assert freshness == scenario.expected_freshness, f"{evaluator}: freshness {freshness} != {scenario.expected_freshness}"


def test_two_freshness_enums_still_differ() -> None:
    """CT-11: two ``Freshness`` enums exist; only ``signal_state.Freshness`` is canonical."""
    from factorix.domain.signal_state import Freshness as Canonical

    assert {f.value for f in Canonical} == {"FRESH", "DELAYED", "STALE", "UNKNOWN", "NO_DATA"}
    assert {f.value for f in Q.Freshness} == {"FRESH", "STALE", "UNKNOWN"}
