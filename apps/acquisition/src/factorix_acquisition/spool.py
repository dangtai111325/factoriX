"""Bounded SQLite WAL outage spool for Acquisition.

Normal operation publishes directly to RabbitMQ without hitting SQLite. Only when RabbitMQ is
genuinely unreachable (connection/confirm failure, not slowness or queue-full backpressure) do
unconfirmed observations spill here for at-least-once replay with latest-per-signal
prioritization and data_epoch fencing so reset-fenced old data never replays into a new epoch.

Budgets (count and bytes) are enforced by *refusing new spills* (the publisher records an
explicit acquisition gap); pending rows are never evicted to make room. The optional TTL
(``FACTORIX_SPOOL_TTL_HOURS``; default 0 = disabled since v6 R2, so an outage backlog is
never aged out) is an explicit, counted and logged retention policy, not a silent drop.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)

TERMINAL_STATES = frozenset({"ACKED", "QUARANTINED", "DEAD"})
# Full VACUUM copies every live page while holding the spool lock; only allow it when cheap.
VACUUM_MAX_LIVE_BYTES = 64 * 1024 * 1024
# Approximate per-row overhead (columns + 5 indexes) on top of the payload for the occupancy estimate.
ROW_OVERHEAD_BYTES = 320

# (event_uid, tenant_id, data_epoch, observed_at, payload, config_revision, created_at, signal_id)
SpoolRow = tuple[str, str, int, str, bytes, int, str, str | None]


class AcquisitionSpool:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute("PRAGMA cache_size=-32768")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS spool (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_uid TEXT NOT NULL UNIQUE,
                tenant_id TEXT NOT NULL,
                data_epoch INTEGER NOT NULL DEFAULT 1,
                observed_at TEXT NOT NULL,
                payload BLOB NOT NULL,
                config_revision INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'PENDING',
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                signal_id TEXT
            )
            """
        )
        self.connection.execute("CREATE INDEX IF NOT EXISTS spool_pending_seq_idx ON spool(seq) WHERE state = 'PENDING'")
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS spool_pending_created_idx ON spool(created_at) WHERE state = 'PENDING'"
        )
        self.connection.execute("CREATE INDEX IF NOT EXISTS spool_pending_signal_idx ON spool(signal_id, seq) WHERE state = 'PENDING'")
        self.connection.execute("CREATE INDEX IF NOT EXISTS spool_epoch_idx ON spool(tenant_id, data_epoch, seq) WHERE state = 'PENDING'")
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS spool_terminal_created_idx ON spool(created_at, seq) WHERE state IN ('ACKED', 'QUARANTINED', 'DEAD')"
        )
        self.connection.commit()
        self._pending = 0
        self.overflow_dropped_count = 0  # kept for metrics compatibility; pending rows are never evicted
        self.expired_count = 0
        self._count_alarm = False
        self._bytes_alarm = False
        self._occupied_estimate = 0
        self._newest: dict[str, int] = {}
        self._rebuild_counters()
        self.refresh_occupancy()
        self.expire_stale()
        self._compact_if_bloated()

    def expire_stale(self, max_age_hours: float | None = None) -> int:
        """Mark pending observations older than max_age_hours as DEAD to prevent backlog from starving live data."""
        if os.environ.get("FACTORIX_ENVIRONMENT") == "test":
            return 0
        if max_age_hours is None:
            raw_env = os.environ.get("FACTORIX_SPOOL_TTL_HOURS", "0")
            try:
                max_age_hours = float(raw_env)
            except ValueError:
                max_age_hours = 0.0
        if max_age_hours <= 0:
            return 0
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=max_age_hours)).isoformat()
        with self._lock:
            with self.connection:
                cur = self.connection.execute(
                    "UPDATE spool SET state = 'DEAD' WHERE state = 'PENDING' AND created_at < ?",
                    (cutoff,),
                )
                expired = max(0, cur.rowcount)
            if expired:
                self._rebuild_counters()
                self.expired_count += expired
                logger.warning(
                    "Spool retention policy: %d pending rows spilled before %s (TTL %.1f h) marked DEAD; "
                    "this is an acquisition gap for the replay history (total expired: %d)",
                    expired,
                    cutoff,
                    max_age_hours,
                    self.expired_count,
                )
            return expired

    def _rebuild_counters(self) -> None:
        with self._lock:
            self._pending = int(self.connection.execute("SELECT count(*) FROM spool WHERE state = 'PENDING'").fetchone()[0])
            self._newest = {
                str(row[0]): int(row[1])
                for row in self.connection.execute(
                    "SELECT signal_id, max(seq) FROM spool WHERE state = 'PENDING' AND signal_id IS NOT NULL GROUP BY signal_id"
                )
            }

    def _compact_if_bloated(self) -> None:
        with self._lock:
            try:
                page_count = int(self.connection.execute("PRAGMA page_count").fetchone()[0])
                freelist_count = int(self.connection.execute("PRAGMA freelist_count").fetchone()[0])
                page_size = int(self.connection.execute("PRAGMA page_size").fetchone()[0])
                live_bytes = (page_count - freelist_count) * page_size
                if page_count > 10_000 and freelist_count > page_count // 2 and live_bytes <= VACUUM_MAX_LIVE_BYTES:
                    self.connection.execute("VACUUM")
                    self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error as exc:
                logger.warning("Spool compaction skipped: %r", exc)

    def add(
        self,
        event_uid: str,
        tenant_id: str,
        data_epoch: int,
        observed_at: str,
        payload: bytes,
        config_revision: int,
        created_at: str,
        signal_id: str | None = None,
    ) -> int:
        return self.add_many([(event_uid, tenant_id, data_epoch, observed_at, payload, config_revision, created_at, signal_id)])

    def add_many(self, rows: Iterable[SpoolRow]) -> int:
        """Insert failed/spilled observations in one SQLite transaction (idempotent on event_uid)."""
        items = list(rows)
        if not items:
            return 0
        with self._lock:
            inserted_signals: dict[str, int] = {}
            added = 0
            with self.connection:
                for event_uid, tenant_id, data_epoch, observed_at, payload, config_revision, created_at, signal_id in items:
                    cur = self.connection.execute(
                        """
                        INSERT INTO spool (event_uid, tenant_id, data_epoch, observed_at, payload, config_revision, created_at, signal_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(event_uid) DO NOTHING
                        """,
                        (event_uid, tenant_id, int(data_epoch), observed_at, payload, int(config_revision), created_at, signal_id),
                    )
                    if cur.rowcount > 0:
                        added += 1
                        if signal_id is not None and cur.lastrowid is not None:
                            inserted_signals[str(signal_id)] = int(cur.lastrowid)
            for sig_id, seq in inserted_signals.items():
                prev = self._newest.get(sig_id, 0)
                if seq > prev:
                    self._newest[sig_id] = seq
            self._pending += added
            if added:
                self._occupied_estimate += sum(len(row[4]) for row in items) + ROW_OVERHEAD_BYTES * added
            return added

    def pending(self, limit: int, exclude: set[int] | None = None) -> list[sqlite3.Row]:
        with self._lock:
            rows = list(
                self.connection.execute(
                    "SELECT seq, event_uid, tenant_id, data_epoch, payload, attempts, signal_id FROM spool WHERE state = 'PENDING' ORDER BY seq LIMIT ?",
                    (limit + len(exclude or ()),),
                )
            )
            if exclude:
                rows = [row for row in rows if row["seq"] not in exclude]
            return rows[:limit]

    def latest_pending(self, limit: int) -> list[sqlite3.Row]:
        with self._lock:
            if not self._newest:
                return []
            seqs = sorted(self._newest.values())
            rows: list[sqlite3.Row] = []
            for start in range(0, len(seqs), 500):
                chunk = seqs[start : start + 500]
                placeholders = ",".join("?" for _ in chunk)
                rows.extend(
                    self.connection.execute(
                        f"SELECT seq, event_uid, tenant_id, data_epoch, payload, attempts, signal_id, state FROM spool WHERE seq IN ({placeholders}) ORDER BY seq",
                        chunk,
                    )
                )
            live = [row for row in rows if row["state"] == "PENDING"]
            found = {int(row["seq"]) for row in live}
            for signal_id, seq in list(self._newest.items()):
                if seq not in found:
                    del self._newest[signal_id]
            return live[:limit]

    def mark_sent(self, event_uids: list[str]) -> None:
        self.mark_state(event_uids, "ACKED")

    def mark_state(self, event_uids: list[str], state: str) -> None:
        if state not in TERMINAL_STATES:
            raise ValueError(f"Invalid terminal spool state: {state!r}")
        if not event_uids:
            return
        with self._lock:
            changed = 0
            with self.connection:
                for start in range(0, len(event_uids), 500):
                    chunk = event_uids[start : start + 500]
                    placeholders = ",".join("?" for _ in chunk)
                    cursor = self.connection.execute(
                        f"UPDATE spool SET state = ? WHERE state = 'PENDING' AND event_uid IN ({placeholders})",
                        (state, *chunk),
                    )
                    changed += max(0, cursor.rowcount)
            self._pending = max(0, self._pending - changed)

    def note_attempt(self, event_uids: list[str], max_attempts: int | None = None) -> int:
        if not event_uids:
            return 0
        killed = 0
        with self._lock:
            with self.connection:
                self.connection.executemany(
                    "UPDATE spool SET attempts = attempts + 1 WHERE event_uid = ?",
                    [(item,) for item in event_uids],
                )
                if max_attempts is not None:
                    for start in range(0, len(event_uids), 500):
                        chunk = event_uids[start : start + 500]
                        placeholders = ",".join("?" for _ in chunk)
                        cursor = self.connection.execute(
                            f"UPDATE spool SET state = 'DEAD' WHERE state = 'PENDING' AND attempts >= ? AND event_uid IN ({placeholders})",
                            (max_attempts, *chunk),
                        )
                        killed += max(0, cursor.rowcount)
            self._pending = max(0, self._pending - killed)
            return killed

    def purge_old_epochs(self, active_epochs: dict[str, int]) -> int:
        """Delete or fence spooled rows belonging to epochs strictly older than active_epoch."""
        if not active_epochs:
            return 0
        if max((int(v) for v in active_epochs.values()), default=1) <= 1:
            return 0
        removed = 0
        with self._lock:
            has_old = False
            for tenant_id, active_epoch in active_epochs.items():
                ep = int(active_epoch)
                if ep <= 1:
                    continue
                if self.connection.execute(
                    "SELECT 1 FROM spool WHERE tenant_id = ? AND data_epoch < ? LIMIT 1",
                    (str(tenant_id), ep),
                ).fetchone():
                    has_old = True
                    break
            if not has_old:
                return 0
            with self.connection:
                for tenant_id, active_epoch in active_epochs.items():
                    ep = int(active_epoch)
                    if ep <= 1:
                        continue
                    cur = self.connection.execute(
                        "DELETE FROM spool WHERE tenant_id = ? AND data_epoch < ?",
                        (str(tenant_id), ep),
                    )
                    removed += max(0, cur.rowcount)
            if removed:
                self._rebuild_counters()
        return removed

    def purge_tenant(self, tenant_id: str | None = None) -> int:
        """Remove all rows for one tenant (or entire spool if tenant_id is None)."""
        with self._lock:
            with self.connection:
                if tenant_id is None:
                    cur = self.connection.execute("DELETE FROM spool")
                else:
                    cur = self.connection.execute("DELETE FROM spool WHERE tenant_id = ?", (str(tenant_id),))
                removed = max(0, cur.rowcount)
            if removed:
                self._rebuild_counters()
        return removed

    def prune(self, acked_before: str, chunk: int = 5000, max_chunks: int | None = None) -> int:
        removed = 0
        chunks = 0
        while True:
            count, more = self.prune_step(acked_before, chunk)
            removed += count
            chunks += 1
            if not more or (max_chunks is not None and chunks >= max_chunks):
                return removed

    def prune_step(self, acked_before: str, chunk: int = 5000) -> tuple[int, bool]:
        step = max(1, chunk)
        with self._lock:
            rows = self.connection.execute(
                """
                SELECT seq FROM spool
                WHERE state IN ('ACKED', 'QUARANTINED', 'DEAD') AND created_at < ?
                ORDER BY created_at ASC, seq ASC
                LIMIT ?
                """,
                (acked_before, step + 1),
            ).fetchall()
            if not rows:
                return 0, False
            more = len(rows) > step
            seqs = [int(row[0]) for row in rows[:step]]
            placeholders = ",".join("?" for _ in seqs)
            with self.connection:
                cursor = self.connection.execute(f"DELETE FROM spool WHERE seq IN ({placeholders})", seqs)
            return max(0, cursor.rowcount), more

    def enforce_cap(self, max_pending: int) -> int:
        """Report (never evict) pending rows above the count budget.

        Pending rows are unconfirmed source data: they are never marked DEAD or deleted to make
        room. The publisher consults :meth:`is_full` and rejects *new* spills with an explicit,
        counted acquisition gap instead (plan §4.1(6) "reject and alert, never silently drop").
        Returns the number of pending rows dropped, which is always 0.
        """
        with self._lock:
            count = self.pending_count()
            over = count > max_pending
            if over and not self._count_alarm:
                logger.error(
                    "Spool holds %d pending rows (> budget %d); new outage spills are rejected until it drains",
                    count,
                    max_pending,
                )
            self._count_alarm = over
            return 0

    def db_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
        return total

    def enforce_byte_cap(self, max_bytes: int) -> int:
        """Reclaim space from terminal rows; never evict pending observations.

        Terminal rows (ACKED/QUARANTINED/DEAD) are deleted in bounded chunks and the WAL is
        checkpointed. The file is only VACUUMed when the live data is small, so the spool lock
        is never held for a long full-database copy while emit/flush wait on it. Freed pages are
        reused by SQLite, so an un-vacuumed file does not grow further. Returns the number of
        (terminal) rows removed.
        """
        if max_bytes <= 0:
            return 0
        with self._lock:
            if self.db_bytes() <= max_bytes:
                self.refresh_occupancy()
                return 0
            self._checkpoint()
            terminal_removed = 0
            for _ in range(10):
                if self._occupied_bytes() <= max_bytes and self.path.stat().st_size <= max_bytes:
                    break
                with self.connection:
                    cur = self.connection.execute(
                        """
                        DELETE FROM spool WHERE seq IN (
                            SELECT seq FROM spool WHERE state IN ('ACKED', 'QUARANTINED', 'DEAD')
                            ORDER BY created_at, seq LIMIT 5000
                        )
                        """
                    )
                terminal_removed += max(0, cur.rowcount)
                if cur.rowcount == 0:
                    break
            occupied = self._occupied_bytes()
            if self.path.stat().st_size > max_bytes and occupied <= VACUUM_MAX_LIVE_BYTES:
                try:
                    self.connection.execute("VACUUM")
                except sqlite3.Error:
                    logger.warning("Spool VACUUM skipped during byte cap maintenance", exc_info=True)
            self._checkpoint()
            self.refresh_occupancy()
            over = self._occupied_estimate > max_bytes
            if over and not self._bytes_alarm:
                logger.error(
                    "Spool pending data occupies %d bytes (> budget %d); new outage spills are rejected until it drains",
                    self._occupied_estimate,
                    max_bytes,
                )
            self._bytes_alarm = over
            if terminal_removed:
                logger.info("Spool byte cap maintenance removed %d terminal rows", terminal_removed)
            return terminal_removed

    def _checkpoint(self) -> bool:
        try:
            busy = self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
        except sqlite3.Error:
            logger.warning("Spool WAL checkpoint failed", exc_info=True)
            return False
        return not busy

    def _occupied_bytes(self) -> int:
        page_size = int(self.connection.execute("PRAGMA page_size").fetchone()[0])
        page_count = int(self.connection.execute("PRAGMA page_count").fetchone()[0])
        free_pages = int(self.connection.execute("PRAGMA freelist_count").fetchone()[0])
        return page_size * (page_count - free_pages)

    def refresh_occupancy(self) -> int:
        """Re-measure bytes used by live pages (pending + not yet pruned terminal rows)."""
        with self._lock:
            try:
                self._occupied_estimate = self._occupied_bytes()
            except sqlite3.Error:
                pass
            return self._occupied_estimate

    def occupied_bytes(self) -> int:
        return self._occupied_estimate

    def is_full(self, max_pending: int, max_bytes: int) -> bool:
        """True when a new spill would exceed the count or byte budget (cheap; uses cached occupancy)."""
        if max_pending > 0 and self._pending >= max_pending:
            return True
        return max_bytes > 0 and self._occupied_estimate >= max_bytes

    def pending_count(self) -> int:
        return self._pending
    def count_by_state(self) -> dict[str, int]:
        with self._lock:
            return {row[0]: int(row[1]) for row in self.connection.execute("SELECT state, count(*) FROM spool GROUP BY state")}

    def close(self) -> None:
        with self._lock:
            self.connection.close()
