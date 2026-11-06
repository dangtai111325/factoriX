"""Outbox lanes, pruning, dead letters and the flusher's batch handling."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


def _row(uid: str, signal: str, at: str = "2026-11-06T00:00:00.000Z") -> tuple:
    payload = json.dumps({"event_uid": uid, "signal_id": signal}).encode()
    return (uid, at, payload, 1, at, signal)


@pytest.fixture()
def outbox(tmp_path: Path) -> Outbox:
    box = Outbox(tmp_path / "outbox.sqlite")
    yield box
    box.close()


def test_add_many_and_latest_lane(outbox: Outbox) -> None:
    outbox.add_many([_row("a1", "A"), _row("b1", "B"), _row("a2", "A"), _row("a3", "A"), _row("b2", "B")])
    assert outbox.pending_count() == 5
    assert [r["event_uid"] for r in outbox.latest_pending(500)] == ["a3", "b2"]
    assert [r["event_uid"] for r in outbox.pending(2)] == ["a1", "b1"]


def test_prune_keeps_recent_and_pending(outbox: Outbox) -> None:
    outbox.add_many([_row("old", "A", "2026-11-06T00:00:00.000Z"), _row("new", "A", "2026-11-06T01:00:00.000Z"), _row("pend", "B", "2026-11-06T00:00:00.000Z")])
    outbox.mark_sent(["old", "new"])
    assert outbox.prune("2026-11-06T00:30:00.000Z") == 1
    assert outbox.count_by_state() == {"ACKED": 1, "PENDING": 1}


def test_dead_letter_after_max_attempts(outbox: Outbox) -> None:
    outbox.add_many([_row("x", "A")])
    for _ in range(2):
        assert outbox.note_attempt(["x"], max_attempts=3) == 0
    assert outbox.note_attempt(["x"], max_attempts=3) == 1
    assert outbox.count_by_state() == {"DEAD": 1}


def test_cap_drops_oldest_pending(outbox: Outbox) -> None:
    outbox.add_many([_row(f"r{i}", "A") for i in range(10)])
    assert outbox.enforce_cap(4) == 6
    assert [r["event_uid"] for r in outbox.pending(10)] == ["r6", "r7", "r8", "r9"]


def _runtime(outbox: Outbox, handler) -> tuple[EdgeRuntime, httpx.AsyncClient]:  # noqa: ANN001
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://center")
    return EdgeRuntime(client, "cred", [], outbox), client


@pytest.mark.asyncio
async def test_flush_sends_latest_lane_first(outbox: Outbox) -> None:
    outbox.add_many([_row("a1", "A"), _row("b1", "B"), _row("a2", "A"), _row("b2", "B"), _row("a3", "A")])
    batches: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        uids = [item["event_uid"] for item in json.loads(request.content)["observations"]]
        batches.append(uids)
        return httpx.Response(200, json={"results": [{"event_uid": u, "status": "committed"} for u in uids]})

    runtime, client = _runtime(outbox, handler)
    async with client:
        acked, failed = await runtime.flush_once(budget_s=5)
    assert not failed and acked == 5
    assert batches[0] == ["b2", "a3"]  # newest per signal first
    assert batches[1] == ["a1", "b1", "a2"]  # then history, oldest first
    assert outbox.pending_count() == 0


@pytest.mark.asyncio
async def test_poison_row_is_bisected_and_dead_lettered(outbox: Outbox) -> None:
    outbox.add_many([_row(f"r{i}", f"S{i}") for i in range(4)])

    def handler(request: httpx.Request) -> httpx.Response:
        uids = [item["event_uid"] for item in json.loads(request.content)["observations"]]
        if "r2" in uids:
            return httpx.Response(422, json={"detail": "bad row"})
        return httpx.Response(200, json={"results": [{"event_uid": u, "status": "committed"} for u in uids]})

    runtime, client = _runtime(outbox, handler)
    async with client:
        acked, failed = await runtime.flush_once(budget_s=5)
    assert acked == 3 and not failed
    assert outbox.count_by_state() == {"ACKED": 3, "DEAD": 1}


@pytest.mark.asyncio
async def test_non_retryable_status_is_terminal_and_5xx_is_retried(outbox: Outbox) -> None:
    outbox.add_many([_row("q", "A"), _row("t", "B")])
    answers = iter([httpx.Response(503), None])

    def handler(request: httpx.Request) -> httpx.Response:
        answer = next(answers)
        if answer is not None:
            return answer
        return httpx.Response(200, json={"results": [{"event_uid": "q", "status": "quarantined"}, {"event_uid": "t", "status": "rejected_test"}]})

    runtime, client = _runtime(outbox, handler)
    async with client:
        _, failed = await runtime.flush_once(budget_s=5)
        assert failed and outbox.pending_count() == 2  # 503: kept, attempt counted
        _, failed = await runtime.flush_once(budget_s=5)
    assert not failed
    assert outbox.count_by_state() == {"QUARANTINED": 2}


@pytest.mark.asyncio
async def test_center_down_does_not_count_attempts(outbox: Outbox) -> None:
    outbox.add_many([_row("x", "A")])

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    runtime, client = _runtime(outbox, handler)
    runtime.max_attempts = 1
    async with client:
        for _ in range(3):
            _, failed = await runtime.flush_once(budget_s=1)
            assert failed
    assert outbox.count_by_state() == {"PENDING": 1}


def test_pending_count_and_latest_index_stay_exact(tmp_path: Path) -> None:
    """R2-SG-01: counters and the latest-lane index are maintained, never rescanned on the hot path."""
    box = Outbox(tmp_path / "o.sqlite")
    box.add_many([_row("a1", "A"), _row("b1", "B"), _row("a2", "A"), _row("c1", "C")])
    assert box.pending_count() == 4
    box.mark_sent(["a2"])  # newest A delivered: A has no latest-lane row any more
    box.mark_sent(["a2"])  # repeated ack does not count twice
    assert box.pending_count() == 3
    assert [r["event_uid"] for r in box.latest_pending(500)] == ["b1", "c1"]
    box.note_attempt(["c1"], max_attempts=1)  # dead-lettered
    assert box.pending_count() == 2
    assert box.enforce_cap(1) == 1
    assert box.pending_count() == 1 == box.count_by_state()["PENDING"]
    box.add_many([_row("b2", "B")])
    box.close()
    reopened = Outbox(tmp_path / "o.sqlite")  # restart with a backlog rebuilds both from the table
    assert reopened.pending_count() == reopened.count_by_state()["PENDING"] == 2
    assert [r["event_uid"] for r in reopened.latest_pending(500)] == ["b2"]
    reopened.close()


def test_prune_in_bounded_chunks(outbox: Outbox) -> None:
    outbox.add_many([_row(f"r{i}", "A", "2026-11-06T00:00:00.000Z") for i in range(5)])
    outbox.mark_sent([f"r{i}" for i in range(5)])
    assert outbox.prune("2026-11-06T01:00:00.000Z", chunk=2, max_chunks=1) == 2
    assert outbox.prune("2026-11-06T01:00:00.000Z", chunk=2) == 3


@pytest.mark.asyncio
async def test_history_slice_is_one_batch_after_the_latest_lane(outbox: Outbox) -> None:
    outbox.add_many([_row(f"h{i}", "A") for i in range(600)] + [_row("a2", "A"), _row("b1", "B")])
    batches: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        uids = [item["event_uid"] for item in json.loads(request.content)["observations"]]
        batches.append(uids)
        return httpx.Response(200, json={"results": [{"event_uid": u, "status": "committed"} for u in uids]})

    runtime, client = _runtime(outbox, handler)
    async with client:
        await runtime.flush_once(budget_s=0)
    # latest lane first, then exactly one history batch (never starved, never more than a slice)
    assert batches[0] == ["a2", "b1"]
    assert len(batches) == 2 and batches[1][:2] == ["h0", "h1"] and len(batches[1]) == 500
    assert outbox.pending_count() == 100
