"""SQLite WAL outbox. At-least-once delivery with bounded growth.

States: PENDING (to send), ACKED (Center committed it; pruned after a retention
window), QUARANTINED (Center gave a final non-retryable answer), DEAD (the edge gave up
after ``max_attempts`` failed sends, or the row was dropped by the pending cap).

The outbox is used from the event loop, so no hot-path call scans the pending rows: the
newest pending row per signal (the latest lane) and the pending count are kept in memory
and maintained on every write. This process is the only writer, so both stay exact. With a
backlog of ~850k rows the former ``GROUP BY signal_id`` lookup took ~250 ms and ``count(*)``
~65 ms per call, blocking acquisition, heartbeat and flushing (R2-SG-01).
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)

TERMINAL_STATES = frozenset({"ACKED", "QUARANTINED", "DEAD"})

OutboxRow = tuple[str, str, bytes, int, str, str | None]  # event_uid, observed_at, payload, revision, created_at, signal_id


class Outbox:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS outbox (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_uid TEXT NOT NULL UNIQUE,
                observed_at TEXT NOT NULL,
                payload BLOB NOT NULL,
                config_revision INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'PENDING',
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(outbox)")}
        if "signal_id" not in columns:
            self.connection.execute("ALTER TABLE outbox ADD COLUMN signal_id TEXT")
        self.connection.execute("CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(state, seq)")
        self.connection.execute("CREATE INDEX IF NOT EXISTS outbox_signal_idx ON outbox(state, signal_id, seq)")
        self.connection.commit()
        # One scan at open (restart with a backlog); afterwards maintained incrementally.
        self._pending = int(self.connection.execute("SELECT count(*) FROM outbox WHERE state = 'PENDING'").fetchone()[0])
        self._newest: dict[str, int] = {
            str(row[0]): int(row[1])
            for row in self.connection.execute(
                "SELECT signal_id, max(seq) FROM outbox WHERE state = 'PENDING' AND signal_id IS NOT NULL GROUP BY signal_id"
            )
        }

    def add(self, event_uid: str, observed_at: str, payload: bytes, config_revision: int, created_at: str, signal_id: str | None = None) -> None:
        self.add_many([(event_uid, observed_at, payload, config_revision, created_at, signal_id)])

    def add_many(self, rows: Iterable[OutboxRow]) -> int:
        """Insert all rows of one read in one transaction."""
        items = list(rows)
        if not items:
            return 0
        with self.connection:
            self.connection.executemany(
                """
                INSERT INTO outbox (event_uid, observed_at, payload, config_revision, created_at, signal_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                items,
            )
            # AUTOINCREMENT seqs of one executemany by the only writer are consecutive.
            last = int(self.connection.execute("SELECT max(seq) FROM outbox").fetchone()[0])
        first = last - len(items) + 1
        for offset, item in enumerate(items):
            if item[5] is not None:
                self._newest[str(item[5])] = first + offset
        self._pending += len(items)
        return len(items)

    def pending(self, limit: int, exclude: set[int] | None = None) -> list[sqlite3.Row]:
        """Oldest pending rows first (history lane)."""
        rows = list(
            self.connection.execute(
                "SELECT seq, event_uid, payload, attempts, signal_id FROM outbox WHERE state = 'PENDING' ORDER BY seq LIMIT ?",
                (limit + len(exclude or ()),),
            )
        )
        if exclude:
            rows = [row for row in rows if row["seq"] not in exclude]
        return rows[:limit]

    def latest_pending(self, limit: int) -> list[sqlite3.Row]:
        """The newest pending row of each signal (latest lane), oldest of those first.

        Primary-key lookups of the in-memory index; a row that left PENDING drops out of it.
        """
        if not self._newest:
            return []
        seqs = sorted(self._newest.values())
        rows: list[sqlite3.Row] = []
        for start in range(0, len(seqs), 500):
            chunk = seqs[start : start + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows.extend(
                self.connection.execute(
                    f"SELECT seq, event_uid, payload, attempts, signal_id, state FROM outbox WHERE seq IN ({placeholders}) ORDER BY seq",
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
            raise ValueError("state")
        if not event_uids:
            return
        with self.connection:
            cursor = self.connection.executemany(
                "UPDATE outbox SET state = ? WHERE event_uid = ? AND state = 'PENDING'", [(state, item) for item in event_uids]
            )
        self._pending = max(0, self._pending - max(0, cursor.rowcount))

    def note_attempt(self, event_uids: list[str], max_attempts: int | None = None) -> int:
        """Count a failed send. Rows reaching ``max_attempts`` become DEAD. Returns rows killed."""
        if not event_uids:
            return 0
        with self.connection:
            self.connection.executemany(
                "UPDATE outbox SET attempts = attempts + 1 WHERE event_uid = ?",
                [(item,) for item in event_uids],
            )
            if max_attempts is None:
                return 0
            placeholders = ",".join("?" for _ in event_uids)
            cursor = self.connection.execute(
                f"UPDATE outbox SET state = 'DEAD' WHERE state = 'PENDING' AND attempts >= ? AND event_uid IN ({placeholders})",
                (max_attempts, *event_uids),
            )
        self._pending = max(0, self._pending - max(0, cursor.rowcount))
        return cursor.rowcount

    def prune(self, acked_before: str, chunk: int = 5000, max_chunks: int | None = None) -> int:
        """Delete terminal rows created before ``acked_before`` (ISO text, same format as created_at).

        ``max_chunks`` bounds one call so the caller can yield to the event loop between calls.
        """
        removed = 0
        chunks = 0
        while True:
            with self.connection:
                cursor = self.connection.execute(
                    """
                    DELETE FROM outbox WHERE seq IN (
                        SELECT seq FROM outbox WHERE state IN ('ACKED', 'QUARANTINED', 'DEAD') AND created_at < ? ORDER BY seq LIMIT ?
                    )
                    """,
                    (acked_before, chunk),
                )
            removed += cursor.rowcount
            chunks += 1
            if cursor.rowcount < chunk or (max_chunks is not None and chunks >= max_chunks):
                return removed

    def enforce_cap(self, max_pending: int) -> int:
        """Keep at most ``max_pending`` pending rows; the oldest beyond the cap become DEAD."""
        count = self.pending_count()
        if count <= max_pending:
            return 0
        excess = count - max_pending
        with self.connection:
            cursor = self.connection.execute(
                """
                UPDATE outbox SET state = 'DEAD' WHERE seq IN (
                    SELECT seq FROM outbox WHERE state = 'PENDING' ORDER BY seq LIMIT ?
                )
                """,
                (excess,),
            )
        self._pending = max(0, self._pending - max(0, cursor.rowcount))
        return cursor.rowcount

    def pending_count(self) -> int:
        """Rows waiting to be sent (maintained counter; no table scan)."""
        return self._pending

    def count_by_state(self) -> dict[str, int]:
        return {row[0]: int(row[1]) for row in self.connection.execute("SELECT state, count(*) FROM outbox GROUP BY state")}

    def close(self) -> None:
        self.connection.close()
