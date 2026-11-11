"""Unit tests for TDengineLiveStateProvider, health dimensions, and LiveState model sampling (S08)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance
from factorix.domain.quality import Origin, Quality
from factorix.modules import models_engine
from factorix.modules.live_state import (
    TDengineLiveStateProvider,
    compute_health_dimensions,
    extract_runtime_health,
)
from factorix.platform.tdengine import TDEngineConfig


TENANT = UUID("11111111-1111-1111-1111-111111111111")
RES_ID = UUID("22222222-2222-2222-2222-222222222222")
SIG_A = UUID("33333333-3333-3333-3333-333333333333")
SIG_B = UUID("44444444-4444-4444-4444-444444444444")


def _obs(
    *,
    signal_id: UUID = SIG_A,
    value: Any = 42.5,
    quality: Quality = Quality.GOOD,
    reason: str | None = None,
    acquired_at: datetime,
    source_time: datetime | None = None,
    data_epoch: int = 1,
    source_sequence: int | None = None,
    event_uid: str | None = None,
    origin: Origin = Origin.LIVE,
    value_type: str = "float64",
) -> CanonicalObservation:
    uid = event_uid or f"ev-{acquired_at.timestamp():.6f}-{source_sequence or 0}"
    return CanonicalObservation(
        schema_version=1,
        event_uid=uid,
        tenant_id=TENANT,
        site_id=None,
        resource_id=RES_ID,
        connection_id=None,
        source_field_id=None,
        signal_id=signal_id,
        data_epoch=data_epoch,
        config_revision=1,
        source_sequence=source_sequence,
        value_type=value_type,
        value=value,
        unit="C",
        quality=quality,
        quality_reason=reason,
        origin=origin,
        source_time=source_time,
        acquired_at=acquired_at,
        ingested_at=acquired_at,
        provenance=CanonicalProvenance(protocol="mqtt", config_revision=1),
    )


@pytest.mark.asyncio
async def test_epoch_fencing_and_monotonic_tiebreaker() -> None:
    provider = TDengineLiveStateProvider()
    t0 = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)

    accepted, changed = await provider.apply_observation(
        _obs(value=10.0, acquired_at=t0, source_sequence=1, event_uid="b"),
        expected_interval_ms=1000,
    )
    assert accepted and changed

    # Older acquired_at replay must be rejected even if its source_time looks newer
    accepted_old, _ = await provider.apply_observation(
        _obs(
            value=99.0,
            acquired_at=t0 - timedelta(seconds=5),
            source_time=t0 + timedelta(minutes=10),
            source_sequence=99,
            event_uid="zzz",
            origin=Origin.REPLAYED,
        )
    )
    assert not accepted_old

    # Same acquired_at + higher source_sequence advances state
    accepted_seq, changed_seq = await provider.apply_observation(
        _obs(value=11.0, acquired_at=t0, source_sequence=2, event_uid="a")
    )
    assert accepted_seq and changed_seq
    assert provider.get_entry(TENANT, SIG_A).record.value == 11.0  # type: ignore[union-attr]

    # Same acquired_at + same source_sequence uses event_uid tie-breaker
    accepted_uid_low, _ = await provider.apply_observation(
        _obs(value=12.0, acquired_at=t0, source_sequence=2, event_uid="0")
    )
    assert not accepted_uid_low
    accepted_uid_high, _ = await provider.apply_observation(
        _obs(value=13.0, acquired_at=t0, source_sequence=2, event_uid="z")
    )
    assert accepted_uid_high
    assert provider.get_entry(TENANT, SIG_A).record.value == 13.0  # type: ignore[union-attr]

    # Bump epoch -> invalidates old cache and rejects prior-epoch messages
    await provider.invalidate_epoch(TENANT, 2)
    assert provider.get_entry(TENANT, SIG_A) is None
    stale_epoch, _ = await provider.apply_observation(
        _obs(value=14.0, acquired_at=t0 + timedelta(seconds=10), data_epoch=1)
    )
    assert not stale_epoch

    # New epoch accepted even if its timestamp is before old epoch clock
    new_epoch, _ = await provider.apply_observation(
        _obs(value=20.0, acquired_at=t0 - timedelta(minutes=1), data_epoch=2)
    )
    assert new_epoch
    assert provider.get_entry(TENANT, SIG_A).record.value == 20.0  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_source_clock_skew_never_blocks_freshness_or_rewinds_live() -> None:
    provider = TDengineLiveStateProvider()
    t0 = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
    skewed_past = t0 - timedelta(days=3)

    await provider.apply_observation(
        _obs(value=50.0, acquired_at=t0, source_time=skewed_past, source_sequence=1, event_uid="e1"),
        expected_interval_ms=1000,
    )
    res = provider.evaluate_signal(TENANT, SIG_A, now=t0 + timedelta(seconds=2))
    assert res.evaluation.effective_status == "GOOD"
    assert res.record is not None and res.record.last_acquired_at == t0

    # Later acquired_at with even older source_time (PLC NTP jump backward) still updates live value cleanly
    await provider.apply_observation(
        _obs(
            value=51.0,
            acquired_at=t0 + timedelta(seconds=5),
            source_time=skewed_past - timedelta(hours=1),
            source_sequence=2,
            event_uid="e2",
        )
    )
    res2 = provider.evaluate_signal(TENANT, SIG_A, now=t0 + timedelta(seconds=7))
    assert res2.evaluation.effective_status == "GOOD"
    assert res2.record is not None and res2.record.value == 51.0


@pytest.mark.asyncio
async def test_identical_steady_value_updates_acquired_not_changed_and_clears_stale() -> None:
    provider = TDengineLiveStateProvider()
    t0 = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)

    accepted1, changed1 = await provider.apply_observation(
        _obs(value=100.0, acquired_at=t0, source_sequence=1, event_uid="e1"),
        expected_interval_ms=1000,
    )
    assert accepted1 and changed1

    # Silence for 15s (> 12s min stale window) -> STALE
    stale_eval = provider.evaluate_signal(TENANT, SIG_A, now=t0 + timedelta(seconds=15))
    assert stale_eval.evaluation.effective_status == "STALE"
    assert stale_eval.evaluation.reason_code == "NO_FRESH_ACQUISITION"

    # Replaying an OLD packet while STALE must NOT clear STALE
    replay_old, _ = await provider.apply_observation(
        _obs(value=100.0, acquired_at=t0 - timedelta(seconds=1), source_sequence=0, event_uid="e0", origin=Origin.REPLAYED)
    )
    assert not replay_old
    still_stale = provider.evaluate_signal(TENANT, SIG_A, now=t0 + timedelta(seconds=16))
    assert still_stale.evaluation.effective_status == "STALE"

    # Fresh current observation with IDENTICAL steady value 100.0 -> automatic GOOD without modifying changed timestamp
    t_rec = t0 + timedelta(seconds=17)
    accepted2, changed2 = await provider.apply_observation(
        _obs(value=100.0, acquired_at=t_rec, source_sequence=2, event_uid="e2")
    )
    assert accepted2 and not changed2
    rec = provider.get_entry(TENANT, SIG_A).record  # type: ignore[union-attr]
    assert rec.last_acquired_at == t_rec
    assert rec.last_value_changed_at == t0

    good_eval = provider.evaluate_signal(TENANT, SIG_A, now=t_rec + timedelta(seconds=1))
    assert good_eval.evaluation.effective_status == "GOOD"
    assert good_eval.health_dimensions["source_health"] == "GOOD"


@pytest.mark.asyncio
async def test_bad_preserves_last_good_and_recovers_to_good() -> None:
    provider = TDengineLiveStateProvider()
    t0 = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)

    await provider.apply_observation(_obs(value=77.7, acquired_at=t0, source_sequence=1, event_uid="g1"), expected_interval_ms=1000)
    await provider.apply_observation(
        _obs(value=None, quality=Quality.BAD, reason="NODE_BAD", acquired_at=t0 + timedelta(seconds=2), source_sequence=2, event_uid="b1")
    )
    bad_eval = provider.evaluate_signal(TENANT, SIG_A, now=t0 + timedelta(seconds=3))
    assert bad_eval.evaluation.effective_status == "BAD"
    assert bad_eval.evaluation.last_good is not None and bad_eval.evaluation.last_good["value"] == 77.7
    assert bad_eval.health_dimensions["source_health"] == "BAD"

    # Recover with same 77.7 -> quality changed from BAD to GOOD
    accepted_rec, changed_rec = await provider.apply_observation(
        _obs(value=77.7, quality=Quality.GOOD, acquired_at=t0 + timedelta(seconds=4), source_sequence=3, event_uid="g2")
    )
    assert accepted_rec and changed_rec
    rec_eval = provider.evaluate_signal(TENANT, SIG_A, now=t0 + timedelta(seconds=5))
    assert rec_eval.evaluation.effective_status == "GOOD"


@pytest.mark.asyncio
async def test_cold_restart_recovery_from_tdengine_stays_conservative_until_fresh_read() -> None:
    now = datetime.now(timezone.utc)
    recent_ts = now - timedelta(seconds=3)

    class _FakeTD:
        config = TDEngineConfig(dsn="ws://root:taosdata@127.0.0.1:16041")

        async def query_last_row(self, database: str, table: str) -> dict[str, Any] | None:
            del database, table
            return {
                "ts": recent_ts,
                "val": 55.25,
                "raw_quality": "GOOD",
                "reason_code": "OK",
                "acquired_at": recent_ts,
                "source_time": recent_ts - timedelta(seconds=1),
                "source_seq": 40,
                "data_epoch": 2,
                "config_rev": 3,
                "origin": "LIVE",
                "event_uid": "td-last-1",
                "unit": "C",
            }

        async def query_rows(self, sql: str) -> list[dict[str, Any]]:
            del sql
            return []

    provider = TDengineLiveStateProvider(_FakeTD())  # type: ignore[arg-type]
    recovered = await provider.warm_from_tdengine(
        TENANT,
        {SIG_A: {"data_type": "float64", "resource_id": RES_ID, "expected_interval_ms": 1000, "unit": "C"}},
        active_epoch=2,
        mark_unverified=True,
    )
    assert SIG_A in recovered

    # Restored before any fresh sample arrives -> must NEVER advertise GOOD; evaluates UNCERTAIN/UNVERIFIED_AFTER_RESTART
    ev_cold = provider.evaluate_signal(TENANT, SIG_A, now=now)
    assert ev_cold.restored_unverified is True
    assert ev_cold.evaluation.effective_status == "UNCERTAIN"
    assert ev_cold.evaluation.reason_code == "UNVERIFIED_AFTER_RESTART"
    assert ev_cold.health_dimensions["source_health"] == "UNKNOWN"

    # Once a fresh in-session acquisition arrives, it promotes to verified GOOD
    await provider.apply_observation(
        _obs(value=55.25, acquired_at=now + timedelta(milliseconds=200), data_epoch=2, source_sequence=41, event_uid="td-new-1")
    )
    ev_fresh = provider.evaluate_signal(TENANT, SIG_A, now=now + timedelta(milliseconds=300))
    assert ev_fresh.restored_unverified is False
    assert ev_fresh.evaluation.effective_status == "GOOD"
    assert ev_fresh.health_dimensions["source_health"] == "GOOD"


def test_four_independent_health_dimensions() -> None:
    now = datetime.now(timezone.utc)
    # Broker OK, acquisition heartbeat online, TDengine down -> storage_health DEGRADED while broker_health HEALTHY
    rt_rows = [
        {"role": "acquisition", "health": "HEALTHY", "broker_ok": True, "queues_json": {}, "last_heartbeat": now},
        {
            "role": "ingestion",
            "health": "DEGRADED",
            "broker_ok": True,
            "queues_json": {"tdengine_ok": False},
            "last_heartbeat": now,
        },
    ]
    col_ok, brk_ok, st_ok = extract_runtime_health(rt_rows, now=now, tdengine_configured=True)
    assert col_ok is True and brk_ok is True and st_ok is False

    # MQTT broker connected, publisher silent -> source STALE, connection HEALTHY, broker HEALTHY
    dims = compute_health_dimensions(
        signal_effective_status="STALE",
        reason_code="NO_FRESH_ACQUISITION",
        connection_health="HEALTHY",
        connection_status="ACTIVE",
        active_bindings=1,
        collector_online=True,
        broker_ok=brk_ok,
        storage_ok=st_ok,
    )
    assert dims == {
        "source_health": "STALE",
        "connection_health": "HEALTHY",
        "broker_health": "HEALTHY",
        "storage_health": "DEGRADED",
    }


@pytest.mark.asyncio
async def test_models_engine_load_samples_respects_live_provider_stale_and_bad_fallback() -> None:
    provider = TDengineLiveStateProvider()
    t0 = datetime.now(timezone.utc) - timedelta(seconds=30)

    # SIG_A: was GOOD 30s ago (now STALE)
    await provider.apply_observation(_obs(signal_id=SIG_A, value=12.0, acquired_at=t0, source_sequence=1, event_uid="a1"))
    # SIG_B: GOOD at t0 (with source_time), then fresh BAD at t0+25s -> last_good_value preserved as fallback, quality MUST be BAD (not GOOD)
    src_b = t0 - timedelta(seconds=1)
    await provider.apply_observation(_obs(signal_id=SIG_B, value=88.0, acquired_at=t0, source_time=src_b, source_sequence=1, event_uid="b1"))
    await provider.apply_observation(
        _obs(signal_id=SIG_B, value=None, quality=Quality.BAD, acquired_at=datetime.now(timezone.utc) - timedelta(seconds=2), source_sequence=2, event_uid="b2")
    )

    samples, qualities = await models_engine.load_samples(
        AsyncMock(),  # non-AsyncSession uses in-memory provider cleanly without PG queries
        TENANT,
        [SIG_A, SIG_B],
        live_provider=provider,
    )
    a_key = str(SIG_A).lower()
    b_key = str(SIG_B).lower()
    assert qualities[a_key] == "STALE"
    assert samples[a_key] is not None and samples[a_key].quality == "STALE" and samples[a_key].value == 12.0
    assert qualities[b_key] == "BAD"
    assert samples[b_key] is not None and samples[b_key].quality == "BAD" and samples[b_key].value == 88.0
    assert samples[b_key].source_time == src_b


@pytest.mark.asyncio
async def test_lru_cache_is_strictly_bounded() -> None:
    provider = TDengineLiveStateProvider(max_signals_per_tenant=64)
    t0 = datetime.now(timezone.utc)
    sids = [uuid4() for _ in range(80)]
    for idx, sid in enumerate(sids):
        await provider.apply_observation(_obs(signal_id=sid, value=float(idx), acquired_at=t0 + timedelta(milliseconds=idx), source_sequence=idx))
    assert len(provider._cache[TENANT]) == 64
    assert provider.get_entry(TENANT, sids[0]) is None
    assert provider.get_entry(TENANT, sids[-1]) is not None
