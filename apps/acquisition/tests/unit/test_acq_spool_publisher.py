"""AcquisitionSpool lanes, pruning, dead letters and ObservationPublisher batch/replay handling."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import pytest

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance, derive_event_uid
from factorix.domain.quality import Quality
from factorix.platform.broker import BrokerBackpressureError, BrokerError, BrokerUnavailableError
from factorix_acquisition.publisher import ObservationPublisher
from factorix_acquisition.spool import AcquisitionSpool

TENANT_ID = uuid4()


def _sig_uuid(label: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"sig:{label}")


def _obs(uid: str, signal: str, *, epoch: int = 1, value: float = 1.0) -> CanonicalObservation:
    sig_id = _sig_uuid(signal)
    conn_id = uuid5(NAMESPACE_URL, "conn:1")
    return CanonicalObservation(
        event_uid=uid,
        tenant_id=TENANT_ID,
        connection_id=conn_id,
        acquisition_job_id=uuid5(NAMESPACE_URL, "job:1"),
        source_field_id=uuid5(NAMESPACE_URL, f"field:{signal}"),
        signal_id=sig_id,
        resource_id=uuid5(NAMESPACE_URL, "res:1"),
        acquired_at=datetime.now(timezone.utc),
        value_type="float64",
        value=value,
        quality=Quality.GOOD,
        data_epoch=epoch,
        config_revision=1,
        provenance=CanonicalProvenance(protocol="modbus_tcp", connection_id=conn_id, address_summary="127.0.0.1:502"),
    )


def _row(uid: str, signal: str, at: str = "2026-11-06T00:00:00.000Z", *, epoch: int = 1, raw: bytes | None = None) -> tuple:
    payload = raw if raw is not None else _obs(uid, signal, epoch=epoch).to_json_bytes()
    return (uid, str(TENANT_ID), epoch, at, payload, 1, at, str(_sig_uuid(signal)))


@pytest.fixture()
def spool(tmp_path: Path) -> AcquisitionSpool:
    box = AcquisitionSpool(tmp_path / "spool.sqlite")
    yield box
    box.close()


class FakeBroker:
    def __init__(self, handler) -> None:  # noqa: ANN001
        self.handler = handler
        self.batches: list[list[str]] = []

    async def publish_observations_partial(
        self,
        observations: list[CanonicalObservation],
    ) -> tuple[list[str], list[tuple[CanonicalObservation, BrokerError]]]:
        self.batches.append([obs.event_uid for obs in observations])
        return self.handler(observations)


def test_add_many_and_latest_lane(spool: AcquisitionSpool) -> None:
    spool.add_many([_row("a1", "A"), _row("b1", "B"), _row("a2", "A"), _row("a3", "A"), _row("b2", "B")])
    assert spool.pending_count() == 5
    assert [r["event_uid"] for r in spool.latest_pending(500)] == ["a3", "b2"]
    assert [r["event_uid"] for r in spool.pending(2)] == ["a1", "b1"]


def test_prune_keeps_recent_and_pending(spool: AcquisitionSpool) -> None:
    spool.add_many([_row("old", "A", "2026-11-06T00:00:00.000Z"), _row("new", "A", "2026-11-06T01:00:00.000Z"), _row("pend", "B", "2026-11-06T00:00:00.000Z")])
    spool.mark_sent(["old", "new"])
    assert spool.prune("2026-11-06T00:30:00.000Z") == 1
    assert spool.count_by_state() == {"ACKED": 1, "PENDING": 1}


def test_dead_letter_after_max_attempts(spool: AcquisitionSpool) -> None:
    spool.add_many([_row("x", "A")])
    for _ in range(2):
        assert spool.note_attempt(["x"], max_attempts=3) == 0
    assert spool.note_attempt(["x"], max_attempts=3) == 1
    assert spool.count_by_state() == {"DEAD": 1}


def test_cap_drops_oldest_pending(spool: AcquisitionSpool) -> None:
    spool.add_many([_row(f"r{i}", "A") for i in range(10)])
    assert spool.enforce_cap(4) == 6
    assert [r["event_uid"] for r in spool.pending(10)] == ["r6", "r7", "r8", "r9"]


@pytest.mark.asyncio
async def test_flush_sends_latest_lane_first(spool: AcquisitionSpool) -> None:
    spool.add_many([_row("a1", "A"), _row("b1", "B"), _row("a2", "A"), _row("b2", "B"), _row("a3", "A")])
    broker = FakeBroker(lambda batch: ([o.event_uid for o in batch], []))
    pub = ObservationPublisher(broker, spool)
    acked, failed = await pub.flush_once(budget_s=5)
    assert not failed and acked == 5
    assert broker.batches[0] == ["b2", "a3"]
    assert broker.batches[1] == ["a1", "b1", "a2"]
    assert spool.pending_count() == 0
    assert pub.published_replay == 5


@pytest.mark.asyncio
async def test_corrupt_and_backpressure_rows_handled_cleanly(spool: AcquisitionSpool) -> None:
    spool.add_many([_row("good1", "A"), _row("bad", "B", raw=b"{not-json"), _row("bp", "C")])

    def handle(batch: list[CanonicalObservation]):
        ok = [o.event_uid for o in batch if o.event_uid != "bp"]
        fail = [(o, BrokerBackpressureError("queue full")) for o in batch if o.event_uid == "bp"]
        return ok, fail

    pub = ObservationPublisher(FakeBroker(handle), spool, max_attempts=2)
    acked, failed = await pub.flush_once(budget_s=5)
    assert acked == 1 and failed is True
    assert spool.count_by_state() == {"ACKED": 1, "QUARANTINED": 1, "PENDING": 1}

    acked2, failed2 = await pub.flush_once(budget_s=5)
    assert acked2 == 0 and failed2 is True
    assert spool.count_by_state() == {"ACKED": 1, "QUARANTINED": 1, "DEAD": 1}


@pytest.mark.asyncio
async def test_broker_down_does_not_count_attempts(spool: AcquisitionSpool) -> None:
    spool.add_many([_row("x", "A")])
    broker = FakeBroker(lambda batch: ([], [(o, BrokerUnavailableError("down")) for o in batch]))
    pub = ObservationPublisher(broker, spool, max_attempts=1)
    for _ in range(3):
        _, failed = await pub.flush_once(budget_s=1)
        assert failed
    assert spool.count_by_state() == {"PENDING": 1}


def test_pending_count_and_latest_index_stay_exact(tmp_path: Path) -> None:
    box = AcquisitionSpool(tmp_path / "o.sqlite")
    box.add_many([_row("a1", "A"), _row("b1", "B"), _row("a2", "A"), _row("c1", "C")])
    assert box.pending_count() == 4
    box.mark_sent(["a2"])
    box.mark_sent(["a2"])
    assert box.pending_count() == 3
    assert [r["event_uid"] for r in box.latest_pending(500)] == ["b1", "c1"]
    box.note_attempt(["c1"], max_attempts=1)
    assert box.pending_count() == 2
    assert box.enforce_cap(1) == 1
    assert box.pending_count() == 1 == box.count_by_state()["PENDING"]
    box.add_many([_row("b2", "B")])
    box.close()
    reopened = AcquisitionSpool(tmp_path / "o.sqlite")
    assert reopened.pending_count() == reopened.count_by_state()["PENDING"] == 2
    assert [r["event_uid"] for r in reopened.latest_pending(500)] == ["b2"]
    reopened.close()


def test_prune_in_bounded_chunks(spool: AcquisitionSpool) -> None:
    spool.add_many([_row(f"r{i}", "A", "2026-11-06T00:00:00.000Z") for i in range(5)])
    spool.mark_sent([f"r{i}" for i in range(5)])
    assert spool.prune("2026-11-06T01:00:00.000Z", chunk=2, max_chunks=1) == 2
    assert spool.prune("2026-11-06T01:00:00.000Z", chunk=2) == 3


@pytest.mark.asyncio
async def test_history_slice_is_one_batch_after_the_latest_lane(spool: AcquisitionSpool) -> None:
    spool.add_many([_row(f"h{i}", "A") for i in range(600)] + [_row("a2", "A"), _row("b1", "B")])
    broker = FakeBroker(lambda batch: ([o.event_uid for o in batch], []))
    pub = ObservationPublisher(broker, spool)
    await pub.flush_once(budget_s=0)
    assert broker.batches[0] == ["a2", "b1"]
    assert len(broker.batches) == 2 and broker.batches[1][:2] == ["h0", "h1"] and len(broker.batches[1]) == 500
    assert spool.pending_count() == 100
