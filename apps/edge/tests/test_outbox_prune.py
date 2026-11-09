"""Outbox prune by primary-key ranges (R3 P1: the former prune sorted every terminal row per chunk
and blocked the event loop for 1-5 s, stalling every source read and Center call)."""

from __future__ import annotations

from pathlib import Path

from factorix_edge.store.outbox import Outbox


def _at(minute: int) -> str:
    return f"2026-11-09T03:{minute:02d}:00.000Z"


def _rows(start: int, count: int, minute: int) -> list[tuple]:
    return [(f"u{start + i}", _at(minute), b"{}", 1, _at(minute), "S") for i in range(count)]


def test_prune_steps_delete_old_terminal_rows_only(tmp_path: Path) -> None:
    box = Outbox(tmp_path / "o.sqlite")
    box.add_many(_rows(0, 10, 0))   # seq 1..10, old
    box.add_many(_rows(10, 10, 5))  # seq 11..20, old
    box.add_many(_rows(20, 10, 30))  # seq 21..30, recent
    box.mark_sent([f"u{i}" for i in range(30) if i not in (3, 15)])  # u3, u15 still PENDING
    box.mark_state(["u15"], "DEAD")
    steps = []
    while True:
        removed, more = box.prune_step(_at(20), chunk=4)
        steps.append(removed)
        if not more:
            break
    assert all(r <= 4 for r in steps) and len(steps) >= 5  # bounded steps
    remaining = {row["event_uid"] for row in box.connection.execute("SELECT event_uid FROM outbox")}
    assert "u3" in remaining  # an old PENDING row is never pruned
    assert "u15" not in remaining  # old DEAD row pruned
    assert {f"u{i}" for i in range(20, 30)} <= remaining  # recent rows kept
    assert len(remaining) == 11
    assert box.pending_count() == 1
    assert box.prune_step(_at(20), chunk=4) == (0, False)
    box.close()


def test_prune_on_empty_or_all_recent_outbox(tmp_path: Path) -> None:
    box = Outbox(tmp_path / "o.sqlite")
    assert box.prune_step(_at(20)) == (0, False)
    box.add_many(_rows(0, 3, 30))
    box.mark_sent(["u0", "u1", "u2"])
    assert box.prune_step(_at(20)) == (0, False)
    assert box.prune(_at(40)) == 3
    box.close()


def test_large_outbox_prune_does_not_block_event_loop(tmp_path: Path) -> None:
    """R5-ENV-01: pruning a large backlog of ACKED rows off-thread uses partial index and never stalls the loop."""
    import asyncio
    import time

    box = Outbox(tmp_path / "large.sqlite")
    # Insert 50,000 old rows and 5,000 recent rows across 50 signals
    old_rows = [(f"old-{i}", _at(0), b'{"v":1}', 1, _at(0), f"sig-{i % 50}") for i in range(50_000)]
    recent_rows = [(f"new-{i}", _at(30), b'{"v":2}', 1, _at(30), f"sig-{i % 50}") for i in range(5_000)]
    box.add_many(old_rows)
    box.add_many(recent_rows)
    box.mark_sent([f"old-{i}" for i in range(50_000)])
    box.mark_sent([f"new-{i}" for i in range(4_000)])  # 1,000 recent remain PENDING

    plan = box.connection.execute(
        """
        EXPLAIN QUERY PLAN
        SELECT seq FROM outbox
        WHERE state IN ('ACKED', 'QUARANTINED', 'DEAD') AND created_at < ?
        ORDER BY created_at ASC, seq ASC
        LIMIT ?
        """,
        (_at(20), 501),
    ).fetchall()
    assert any("outbox_terminal_created_idx" in " ".join(str(c) for c in row) for row in plan)

    async def run_prune_with_watchdog() -> tuple[int, float]:
        max_lag = 0.0
        stop = False

        async def watchdog() -> None:
            nonlocal max_lag
            last = time.monotonic()
            while not stop:
                await asyncio.sleep(0.01)
                now = time.monotonic()
                max_lag = max(max_lag, now - last - 0.01)
                last = now

        wd = asyncio.create_task(watchdog())
        total = 0
        try:
            while True:
                removed, more = await asyncio.to_thread(box.prune_step, _at(20), 500)
                total += removed
                if not more:
                    break
                await asyncio.sleep(0.005)
        finally:
            stop = True
            await wd
        return total, max_lag

    removed_total, max_loop_lag = asyncio.run(run_prune_with_watchdog())
    assert removed_total == 50_000
    assert max_loop_lag < 0.25
    assert box.pending_count() == 1_000
    assert box.count_by_state() == {"ACKED": 4_000, "PENDING": 1_000}
    box.close()
