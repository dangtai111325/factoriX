"""ObservationPublisher unit tests: fast-path bypasses SQLite, monotonic sequence, partial spill ordering, epoch fence."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import threading
from typing import Any
from uuid import uuid4

import pytest

from factorix.domain.canonical import CanonicalObservation
from factorix.platform.broker import BrokerError, BrokerUnavailableError
from factorix_acquisition.jobs import build_specs
from factorix_acquisition.mapping import Sample
from factorix_acquisition.publisher import ObservationPublisher
from factorix_acquisition.spool import AcquisitionSpool


def _spec() -> tuple[Any, str, str]:
    tenant_id = str(uuid4())
    conn_id = str(uuid4())
    job_id = str(uuid4())
    field_id = str(uuid4())
    sig_id = str(uuid4())
    res_id = str(uuid4())
    snap = {
        "revision": 3,
        "connections": [
            {
                "id": conn_id,
                "tenant_id": tenant_id,
                "protocol": "mqtt",
                "status": "ACTIVE",
                "endpoint_redacted": "mqtt://user:secret_pass@broker.local:1883",
                "config_json": {"host": "broker.local", "port": 1883},
            }
        ],
        "jobs": [{"id": job_id, "connection_id": conn_id, "mode": "SUBSCRIBE", "interval_ms": 200, "enabled": True, "config_revision": 3}],
        "source_fields": [{"id": field_id, "acquisition_job_id": job_id, "address_json": {"topic": "m/1/temp", "jsonpath": "$.t"}}],
        "signal_bindings": [{"source_field_id": field_id, "signal_id": sig_id, "resource_id": res_id, "tenant_id": tenant_id, "key": "temp", "data_type": "float64", "unit": "C"}],
    }
    return build_specs(snap)[job_id], tenant_id, sig_id


class RecordingBroker:
    def __init__(self) -> None:
        self.published: list[CanonicalObservation] = []
        self.fail_after: int | None = None
        self.down = False

    async def publish_observations_partial(
        self, observations: list[CanonicalObservation]
    ) -> tuple[list[str], list[tuple[CanonicalObservation, BrokerError]]]:
        if self.down:
            return [], [(o, BrokerUnavailableError("down")) for o in observations]
        if self.fail_after is not None:
            ok = observations[: self.fail_after]
            bad = observations[self.fail_after :]
            self.published.extend(ok)
            return [o.event_uid for o in ok], [(o, BrokerUnavailableError("mid-batch outage")) for o in bad]
        self.published.extend(observations)
        return [o.event_uid for o in observations], []


@pytest.mark.asyncio
async def test_fast_path_publishes_directly_without_writing_sqlite_and_redacts_provenance(tmp_path: Path) -> None:
    spec, tenant_id, sig_id = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    broker = RecordingBroker()
    pub = ObservationPublisher(broker, spool)
    await pub.set_tenant_epochs({tenant_id: 2})

    field_id = spec.fields[0]["id"]
    await pub.emit(spec, [Sample(field_id, 21.5, "GOOD"), Sample(field_id, 22.0, "GOOD")])
    sent, failed = await pub.flush_once()

    assert sent == 2 and failed is False
    assert pub.published_fast == 2 and pub.spilled == 0
    assert spool.count_by_state() == {}  # SQLite untouched on fast path!
    assert len(broker.published) == 2
    assert [o.source_sequence for o in broker.published] == [1, 2]
    assert all(o.data_epoch == 2 for o in broker.published)
    assert all(str(o.signal_id) == sig_id for o in broker.published)
    assert "secret_pass" not in broker.published[0].to_json_bytes().decode("utf-8")
    spool.close()


@pytest.mark.asyncio
async def test_partial_failure_spills_remaining_fast_queue_to_preserve_ordering(tmp_path: Path) -> None:
    spec, _, _ = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    broker = RecordingBroker()
    broker.fail_after = 2
    pub = ObservationPublisher(broker, spool)
    field_id = spec.fields[0]["id"]

    # Emit 600 samples (> BATCH_ROWS=500) so second batch of 100 remains in RAM when first batch partially fails
    for i in range(600):
        await pub.emit(spec, [Sample(field_id, float(i), "GOOD")])
    sent, failed = await pub.flush_once()

    assert sent == 2 and failed is True
    assert pub.fast_buffered == 0  # Remainder flushed cleanly to spool to keep ordering!
    assert spool.pending_count() == 598

    # Recover broker -> latest sample (#600) published first via latest lane, then remaining 597 chronologically
    broker.down = False
    broker.fail_after = None
    sent2, failed2 = await pub.flush_once(budget_s=5.0)
    assert failed2 is False
    assert sent2 == 598
    assert spool.pending_count() == 0
    # Wait: seq=1,2 published initially, seq=600 published on latest_pending lane, then 3..599
    seqs = [o.source_sequence for o in broker.published]
    assert seqs[:3] == [1, 2, 600]
    assert seqs[3:] == list(range(3, 600))
    spool.close()


@pytest.mark.asyncio
async def test_set_tenant_epochs_purges_old_epoch_in_ram_and_spool(tmp_path: Path) -> None:
    spec, tenant_id, _ = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    broker = RecordingBroker()
    pub = ObservationPublisher(broker, spool)
    field_id = spec.fields[0]["id"]

    await pub.emit(spec, [Sample(field_id, 10.0, "GOOD")])  # stays in _fast_queue epoch=1
    broker.down = True
    pub._broker_down = True
    await pub.emit(spec, [Sample(field_id, 11.0, "GOOD")])  # spills to SQLite epoch=1
    assert pub.fast_buffered == 1 and spool.pending_count() == 1

    purged = await pub.set_tenant_epochs({tenant_id: 2})
    assert purged == 1
    assert pub.fast_buffered == 0
    assert spool.pending_count() == 0

    broker.down = False
    pub._broker_down = False
    await pub.emit(spec, [Sample(field_id, 12.0, "GOOD")])  # epoch=2
    sent, failed = await pub.flush_once()
    assert sent == 1 and failed is False
    assert [o.value for o in broker.published] == [12.0]
    assert broker.published[0].data_epoch == 2
    spool.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_has_pending_stays_true_while_flush_awaiting_broker_confirm(tmp_path: Path, cancel: bool) -> None:
    spec, _, _ = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    entered = asyncio.Event()
    release = asyncio.Event()

    class SlowBroker:
        async def publish_observations_partial(
            self, observations: list[CanonicalObservation]
        ) -> tuple[list[str], list[tuple[CanonicalObservation, BrokerError]]]:
            entered.set()
            await release.wait()
            return [o.event_uid for o in observations], []

    pub = ObservationPublisher(SlowBroker(), spool)
    field_id = spec.fields[0]["id"]
    await pub.emit(spec, [Sample(field_id, 1.0, "GOOD")])
    task = asyncio.create_task(pub.flush_once())
    await entered.wait()
    # _fast_queue is already empty, yet publish is still in-flight awaiting confirm!
    assert pub.fast_buffered == 0
    assert pub.has_pending() is True
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert spool.pending_count() == 1
    else:
        release.set()
        sent, failed = await task
        assert sent == 1 and failed is False
        assert pub.has_pending() is False
    spool.close()


@pytest.mark.asyncio
async def test_cancelled_emit_waits_for_spool_write_without_blocking_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    spec, _, _ = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    publisher = ObservationPublisher(None, spool)
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    add_many = spool.add_many

    def wait_then_write(rows):
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(timeout=5)
        return add_many(rows)

    monkeypatch.setattr(spool, "add_many", wait_then_write)
    emission = asyncio.create_task(publisher.emit(spec, [Sample(spec.fields[0]["id"], 20.0, "GOOD")]))
    try:
        await asyncio.wait_for(entered.wait(), timeout=3)
        emission.cancel()
        await asyncio.sleep(0)
        assert not emission.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await emission
        assert spool.pending_count() == 1
        assert publisher.spilled == 1
    finally:
        release.set()
        await asyncio.gather(emission, return_exceptions=True)
        spool.close()


def test_set_broker_triggers_wake_and_recovery_callbacks(tmp_path: Path) -> None:
    wakes = 0
    restores = 0

    def _wake() -> None:
        nonlocal wakes
        wakes += 1

    def _restored() -> None:
        nonlocal restores
        restores += 1

    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    pub = ObservationPublisher(None, spool, on_wake=_wake)
    pub.set_broker(RecordingBroker())
    assert wakes == 1
    assert pub.broker_ok is True

    pub2 = ObservationPublisher(None, spool, on_wake=_wake, on_broker_restored=_restored)
    pub2.set_broker(RecordingBroker())
    assert restores == 1
    assert wakes == 1  # on_broker_restored handled wake cleanly
    spool.close()


@pytest.mark.asyncio
async def test_set_broker_generation_prevents_inflight_flush_from_clobbering_outage_or_restore(tmp_path: Path) -> None:
    import asyncio

    spec, _, _ = _spec()
    field_id = spec.fields[0]["id"]
    spool = AcquisitionSpool(tmp_path / "gen.sqlite")
    entered = asyncio.Event()
    release = asyncio.Event()

    class HangingOkBroker:
        async def publish_observations_partial(self, observations: list[CanonicalObservation]):
            entered.set()
            await release.wait()
            return [o.event_uid for o in observations], []

    pub = ObservationPublisher(HangingOkBroker(), spool)
    await pub.emit(spec, [Sample(field_id, 1.0, "GOOD")])
    task = asyncio.create_task(pub.flush_once())
    await entered.wait()

    # Outage triggered mid-await -> stale in-flight success MUST NOT clear _broker_down or set broker_ok=True
    pub.set_broker(None)
    release.set()
    sent, failed = await task
    assert sent == 1 and failed is True
    assert pub._broker_down is True
    assert pub.broker_ok is False

    # Reverse race: failing publish mid-await when broker is restored via set_broker(healthy) -> keep broker_ok=True
    entered2 = asyncio.Event()
    release2 = asyncio.Event()

    class FailingLateBroker:
        async def publish_observations_partial(self, observations: list[CanonicalObservation]):
            entered2.set()
            await release2.wait()
            return [], [(o, BrokerUnavailableError("late fail")) for o in observations]

    pub2 = ObservationPublisher(FailingLateBroker(), spool)
    await pub2.emit(spec, [Sample(field_id, 2.0, "GOOD")])
    task2 = asyncio.create_task(pub2.flush_once())
    await entered2.wait()
    pub2.set_broker(RecordingBroker())
    release2.set()
    sent2, failed2 = await task2
    assert sent2 == 0 and failed2 is True
    assert pub2.broker_ok is True
    assert pub2._broker_down is False
    assert spool.pending_count() == 1
    spool.close()


@pytest.mark.asyncio
async def test_fresh_sample_routes_to_live_lane(tmp_path: Path) -> None:
    spec, tenant_id, sig_id = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    pub = ObservationPublisher(RecordingBroker(), spool)
    field_id = spec.fields[0]["id"]
    obs_list = pub.build_observations(spec, [Sample(field_id, 25.0, "GOOD")])
    obs = obs_list[0]
    rkey = pub.route_for_observation(obs)
    assert "telemetry.live.v1." in rkey
    assert tenant_id.replace("-", "") in rkey
    spool.close()


@pytest.mark.asyncio
async def test_stale_sample_routes_to_legacy_lane(tmp_path: Path) -> None:
    spec, tenant_id, sig_id = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    pub = ObservationPublisher(RecordingBroker(), spool)
    field_id = spec.fields[0]["id"]
    stale_time = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    obs_list = pub.build_observations(spec, [Sample(field_id, 25.0, "GOOD", received_time=stale_time)])
    obs = obs_list[0]
    rkey = pub.route_for_observation(obs)
    assert rkey.startswith("telemetry.v1.")
    assert "live" not in rkey
    assert tenant_id.replace("-", "") in rkey
    spool.close()


@pytest.mark.asyncio
async def test_ram_backlog_gives_fresh_samples_slots_and_preserves_older_observations(tmp_path: Path) -> None:
    spec, _, _ = _spec()
    field = spec.fields[0]["id"]
    old = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    publisher = ObservationPublisher(RecordingBroker(), spool)
    try:
        await publisher.emit(spec, [Sample(field, float(i), "GOOD", received_time=old) for i in range(6)])
        await publisher.emit(spec, [Sample(field, 10.0, "GOOD"), Sample(field, 11.0, "GOOD")])
        await publisher.emit(spec, [Sample(field, 6.0, "GOOD", received_time=old)])
        assert [obs.value for obs in publisher._pop_fast_batch(4)] == [10.0, 11.0, 0.0, 1.0]
        assert [obs.value for obs in publisher._pop_fast_batch(4)] == [2.0, 3.0, 4.0, 5.0]
        assert [obs.value for obs in publisher._pop_fast_batch(4)] == [6.0]
    finally:
        spool.close()


@pytest.mark.asyncio
async def test_fair_flushing_interleaves_ram_and_spool(tmp_path: Path) -> None:
    spec, tenant_id, _ = _spec()
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    broker = RecordingBroker()
    pub = ObservationPublisher(broker, spool)
    field_id = spec.fields[0]["id"]

    # Fill spool with 50 items
    broker.down = True
    pub._broker_down = True
    for i in range(50):
        await pub.emit(spec, [Sample(field_id, float(i), "GOOD")])
    assert spool.pending_count() == 50
    assert pub.fast_buffered == 0

    # Broker restores and RAM gets 20 items
    broker.down = False
    pub.set_broker(broker)
    for i in range(20):
        await pub.emit(spec, [Sample(field_id, 1000.0 + i, "GOOD")])
    assert pub.fast_buffered == 20
    assert spool.pending_count() == 50

    # Flush once: should process RAM (20) and Spool (50)
    sent, failed = await pub.flush_once(budget_s=5.0)
    assert failed is False
    assert sent == 70
    assert pub.fast_buffered == 0
    assert spool.pending_count() == 0
    metrics = pub.publish_metrics()
    assert metrics["emitted_by_protocol"] == {"mqtt": 70}
    assert {"fast_publish", "replay_publish", "spool_read", "spool_mark_sent"} <= metrics["stage_calls"].keys()
    assert all(elapsed >= 0 for elapsed in metrics["stage_seconds"].values())
    spool.close()


@pytest.mark.asyncio
async def test_replay_uses_a_smaller_slice_while_ram_stays_busy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("factorix_acquisition.publisher.BATCH_ROWS", 4)
    monkeypatch.setattr("factorix_acquisition.publisher.CONTENDED_REPLAY_ROWS", 1)
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    broker = RecordingBroker()
    publisher = ObservationPublisher(None, spool)
    try:
        for i in range(3):
            spec, _, _ = _spec()
            await publisher.emit(spec, [Sample(spec.fields[0]["id"], float(i), "GOOD")])
        publisher.set_broker(broker)
        spec, _, _ = _spec()
        await publisher.emit(spec, [Sample(spec.fields[0]["id"], float(i + 10), "GOOD") for i in range(9)])

        assert await publisher.flush_once(budget_s=0) == (9, False)
        assert publisher.fast_buffered == 1
        assert spool.pending_count() == 2
        assert await publisher.flush_once(budget_s=0) == (3, False)
        assert spool.pending_count() == 0
    finally:
        spool.close()
