"""Adaptive replay (factorix_acquisition.replay) and slow-broker handling of the live lane (R2)."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from factorix.domain.canonical import CanonicalObservation
from factorix.platform.broker import BrokerError, BrokerTimeoutError
from factorix_acquisition.jobs import build_specs
from factorix_acquisition.mapping import Sample
from factorix_acquisition.publisher import ObservationPublisher
from factorix_acquisition.replay import ReplayController, ReplayLimits
from factorix_acquisition.spool import AcquisitionSpool


def _spec() -> Any:
    tenant_id, conn_id, job_id, field_id = (str(uuid4()) for _ in range(4))
    snap = {
        "revision": 1,
        "connections": [{"id": conn_id, "tenant_id": tenant_id, "protocol": "mqtt", "status": "ACTIVE", "config_json": {}}],
        "jobs": [{"id": job_id, "connection_id": conn_id, "mode": "SUBSCRIBE", "interval_ms": 1000, "enabled": True}],
        "source_fields": [{"id": field_id, "acquisition_job_id": job_id, "address_json": {"topic": "t", "jsonpath": "$.v"}}],
        "signal_bindings": [
            {"source_field_id": field_id, "signal_id": str(uuid4()), "resource_id": str(uuid4()), "tenant_id": tenant_id, "data_type": "float64"}
        ],
    }
    return build_specs(snap)[job_id]


class ScriptedBroker:
    """Confirms everything unless told to time out; records live vs replay batches."""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []
        self.timeout_next = 0
        self.depths: dict[str, int] | None = {"live": 0, "legacy": 0}
        self.delay_s = 0.0

    async def publish_observations_partial(
        self, observations: list[CanonicalObservation]
    ) -> tuple[list[str], list[tuple[CanonicalObservation, BrokerError]]]:
        self.batches.append([o.event_uid for o in observations])
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        if self.timeout_next > 0:
            self.timeout_next -= 1
            error = BrokerTimeoutError("no confirm")
            error.__cause__ = TimeoutError()
            return [], [(o, error) for o in observations]
        return [o.event_uid for o in observations], []

    async def queue_depths(self) -> dict[str, int] | None:
        return self.depths


class _FakeOwner:
    def __init__(self) -> None:
        self.fast_buffered = 0
        self.ingest_backpressure = False
        self.broker_slow = False
        self.head_age: float | None = None

    def fast_head_age_s(self) -> float | None:
        return self.head_age


def test_controller_is_aimd_on_live_health_only() -> None:
    controller = ReplayController(ReplayLimits(max_rate=2000, initial_rate=500, additive_step=250))
    owner = _FakeOwner()
    controller.last_tick = time.monotonic() - 1.0
    assert controller.allowance(owner, 500) == 500  # healthy: bucket allows a slice
    assert controller.rate == pytest.approx(750, abs=5)  # additive increase per healthy second

    owner.head_age = 5.0  # live data waits in RAM -> replay backs off immediately
    assert controller.allowance(owner, 500) == 0
    assert controller.rate == pytest.approx(375, abs=5) and controller.paused_until > time.monotonic()
    assert "live head age" in controller.reason

    owner.head_age = None
    controller.paused_until = 0.0
    controller.queue_depths = {"live": 0, "legacy": 50}  # Center has not consumed earlier replay yet
    assert controller.allowance(owner, 500) == 0 and "Center behind on replay" in controller.reason

    controller.queue_depths = {"live": 0, "legacy": 0}
    controller.paused_until = 0.0
    controller.note_live_failure("TimeoutError")  # any live failure pauses replay for a cooldown
    assert controller.allowance(owner, 500) == 0
    assert controller.paused_until - time.monotonic() > 10 and controller.snapshot()["pauses"] == 1


@pytest.mark.asyncio
async def test_live_confirm_timeout_keeps_data_in_ram_and_does_not_spool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spec = _spec()
    field = spec.fields[0]["id"]
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    broker = ScriptedBroker()
    pub = ObservationPublisher(broker, spool)
    try:
        await pub.emit(spec, [Sample(field, float(i), "GOOD") for i in range(10)])
        broker.timeout_next = 1
        assert await pub.flush_once(budget_s=0) == (0, True)
        # Slow, not lost: nothing spooled (no spill -> replay feedback loop), broker still "ok".
        assert spool.pending_count() == 0 and pub.fast_buffered == 10
        assert pub.broker_ok is True and pub.broker_slow is True
        assert pub.publish_metrics()["publish_failed_by_lane"] == {"live": 10}
        pub._backpressure_until = 0.0
        sent, failed = await pub.flush_once(budget_s=0)
        assert (sent, failed) == (10, False) and pub.broker_slow is False
        # Same event_uids retried (idempotent downstream), in the original order.
        assert broker.batches[0] == broker.batches[1]

        # Silent for longer than SLOW_TO_DOWN_S while "connected": now it is an outage -> spool.
        monkeypatch.setattr("factorix_acquisition.publisher.SLOW_TO_DOWN_S", 0.0)
        await pub.emit(spec, [Sample(field, 99.0, "GOOD")])
        broker.timeout_next = 1
        pub._backpressure_until = 0.0
        assert await pub.flush_once(budget_s=0) == (0, True)
        assert spool.pending_count() == 1 and pub._broker_down is True
    finally:
        spool.close()


@pytest.mark.asyncio
async def test_background_replay_never_delays_the_live_lane(tmp_path: Path) -> None:
    spec = _spec()
    field = spec.fields[0]["id"]
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    broker = ScriptedBroker()
    # Seed a backlog through an outage.
    pub = ObservationPublisher(None, spool, background_replay=True)
    for i in range(300):
        await pub.emit(spec, [Sample(field, float(i), "GOOD")])
    assert spool.pending_count() == 300
    pub.set_broker(broker)
    try:
        # Every publish (live or replay) takes 500 ms to confirm. A live publish that queued behind the replay
        # slice in flight would need >= 1.0 s; on its own it needs one confirm. The 0.9 s bound separates the two
        # cases with room for a slow CI runner (a 0.3 s / 0.55 s pair flaked at 0.568 s on a 1.5-CPU container).
        broker.delay_s = 0.5
        pub.replay.controller.tokens = 1000.0
        await pub.flush_once(budget_s=0.01)  # starts the replay task
        await asyncio.sleep(0.05)  # replay slice now in flight, waiting for its confirm
        await pub.emit(spec, [Sample(field, 1000.0, "GOOD")])
        started = time.monotonic()
        sent, failed = await pub.flush_once(budget_s=0.01)
        # Live publish costs one confirm, it never waits behind the replay slice in flight.
        assert (sent, failed) == (1, False) and time.monotonic() - started < 0.9
        for _ in range(100):
            if spool.pending_count() == 0:
                break
            pub.replay.controller.tokens = 1000.0
            await asyncio.sleep(0.05)
        assert spool.pending_count() == 0 and pub.published_replay == 300
    finally:
        await pub.replay.stop()
        spool.close()
