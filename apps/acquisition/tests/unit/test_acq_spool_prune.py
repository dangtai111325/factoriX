"""AcquisitionSpool prune by primary-key / partial index ranges without stalling the event loop."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from factorix_acquisition.spool import AcquisitionSpool


def _at(minute: int) -> str:
    return f"2026-11-09T03:{minute:02d}:00.000Z"


def _rows(start: int, count: int, minute: int) -> list[tuple]:
    return [(f"u{start + i}", "tenant-1", 1, _at(minute), b"{}", 1, _at(minute), "S") for i in range(count)]


def test_prune_steps_delete_old_terminal_rows_only(tmp_path: Path) -> None:
    box = AcquisitionSpool(tmp_path / "o.sqlite")
    box.add_many(_rows(0, 10, 0))
    box.add_many(_rows(10, 10, 5))
    box.add_many(_rows(20, 10, 30))
    box.mark_sent([f"u{i}" for i in range(30) if i not in (3, 15)])
    box.mark_state(["u15"], "DEAD")
    steps = []
    while True:
        removed, more = box.prune_step(_at(20), chunk=4)
        steps.append(removed)
        if not more:
            break
    assert all(r <= 4 for r in steps) and len(steps) >= 5
    remaining = {row["event_uid"] for row in box.connection.execute("SELECT event_uid FROM spool")}
    assert "u3" in remaining
    assert "u15" not in remaining
    assert {f"u{i}" for i in range(20, 30)} <= remaining
    assert len(remaining) == 11
    assert box.pending_count() == 1
    assert box.prune_step(_at(20), chunk=4) == (0, False)
    box.close()


def test_prune_on_empty_or_all_recent_spool(tmp_path: Path) -> None:
    box = AcquisitionSpool(tmp_path / "o.sqlite")
    assert box.prune_step(_at(20)) == (0, False)
    box.add_many(_rows(0, 3, 30))
    box.mark_sent(["u0", "u1", "u2"])
    assert box.prune_step(_at(20)) == (0, False)
    assert box.prune(_at(40)) == 3
    box.close()


def test_large_spool_prune_does_not_block_event_loop(tmp_path: Path) -> None:
    box = AcquisitionSpool(tmp_path / "large.sqlite")
    old_rows = [(f"old-{i}", "tenant-1", 1, _at(0), b'{"v":1}', 1, _at(0), f"sig-{i % 50}") for i in range(50_000)]
    recent_rows = [(f"new-{i}", "tenant-1", 1, _at(30), b'{"v":2}', 1, _at(30), f"sig-{i % 50}") for i in range(5_000)]
    box.add_many(old_rows)
    box.add_many(recent_rows)
    box.mark_sent([f"old-{i}" for i in range(50_000)])
    box.mark_sent([f"new-{i}" for i in range(4_000)])

    plan = box.connection.execute(
        """
        EXPLAIN QUERY PLAN
        SELECT seq FROM spool
        WHERE state IN ('ACKED', 'QUARANTINED', 'DEAD') AND created_at < ?
        ORDER BY created_at ASC, seq ASC
        LIMIT ?
        """,
        (_at(20), 501),
    ).fetchall()
    assert any("spool_terminal_created_idx" in " ".join(str(c) for c in row) for row in plan)

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
