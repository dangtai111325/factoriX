"""AcquisitionSpool epoch fencing, multi-tenant purge, and byte-cap bounds."""

from __future__ import annotations

from pathlib import Path

from factorix_acquisition.spool import AcquisitionSpool


def _row(uid: str, tenant: str, epoch: int, signal: str, payload_size: int = 256) -> tuple:
    payload = (b'{"p":"' + (b"x" * payload_size) + b'"}')
    return (uid, tenant, epoch, "2026-11-10T00:00:00.000Z", payload, 1, "2026-11-10T00:00:00.000Z", signal)


def test_purge_old_epochs_isolates_tenants_and_rebuilds_counters(tmp_path: Path) -> None:
    spool = AcquisitionSpool(tmp_path / "spool.sqlite")
    spool.add_many(
        [
            _row("t1-e1-a", "t1", 1, "s1"),
            _row("t1-e1-b", "t1", 1, "s2"),
            _row("t1-e2-c", "t1", 2, "s1"),
            _row("t2-e1-a", "t2", 1, "s3"),
        ]
    )
    assert spool.pending_count() == 4
    removed = spool.purge_old_epochs({"t1": 2, "t2": 1})
    assert removed == 2
    assert spool.pending_count() == 2
    remaining = {r["event_uid"] for r in spool.pending(10)}
    assert remaining == {"t1-e2-c", "t2-e1-a"}
    assert [r["event_uid"] for r in spool.latest_pending(10)] == ["t1-e2-c", "t2-e1-a"]

    assert spool.purge_tenant("t2") == 1
    assert spool.pending_count() == 1
    assert [r["event_uid"] for r in spool.pending(10)] == ["t1-e2-c"]
    spool.close()


def test_enforce_byte_cap_prunes_terminal_then_oldest_pending(tmp_path: Path) -> None:
    spool = AcquisitionSpool(tmp_path / "cap.sqlite")
    # Write ~150 KB of spooled messages
    spool.add_many([_row(f"u-{i}", "t1", 1, f"s-{i % 5}", payload_size=1500) for i in range(100)])
    assert spool.db_bytes() > 50_000
    # Mark first 20 ACKED so terminal rows are purged first
    spool.mark_sent([f"u-{i}" for i in range(20)])
    dropped = spool.enforce_byte_cap(40_000)
    assert dropped >= 20
    assert spool.pending_count() < 80
    assert spool.pending_count() == spool.count_by_state().get("PENDING", 0)
    spool.close()
