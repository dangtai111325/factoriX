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
