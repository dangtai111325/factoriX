"""SQLite WAL outbox. At-least-once, no delete on restart."""

from __future__ import annotations

import sqlite3
from pathlib import Path


class Outbox:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.connection = sqlite3.connect(path)
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
        self.connection.execute("CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(state, seq)")
        self.connection.commit()

    def add(self, event_uid: str, observed_at: str, payload: bytes, config_revision: int, created_at: str) -> None:
        self.connection.execute(
            """
            INSERT INTO outbox (event_uid, observed_at, payload, config_revision, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (event_uid, observed_at, payload, config_revision, created_at),
        )
        self.connection.commit()

    def pending(self, limit: int) -> list[sqlite3.Row]:
        self.connection.row_factory = sqlite3.Row
        return list(
            self.connection.execute(
                "SELECT seq, event_uid, payload, attempts FROM outbox WHERE state = 'PENDING' ORDER BY seq LIMIT ?",
                (limit,),
            )
        )

    def mark_sent(self, event_uids: list[str]) -> None:
        self.mark_state(event_uids, "ACKED")

    def mark_state(self, event_uids: list[str], state: str) -> None:
        if state not in {"ACKED", "QUARANTINED"}:
            raise ValueError("state")
        self.connection.executemany("UPDATE outbox SET state = ? WHERE event_uid = ?", [(state, item) for item in event_uids])
        self.connection.commit()

    def note_attempt(self, event_uids: list[str]) -> None:
        self.connection.executemany(
            "UPDATE outbox SET attempts = attempts + 1 WHERE event_uid = ?",
            [(item,) for item in event_uids],
        )
        self.connection.commit()

    def pending_count(self) -> int:
        row = self.connection.execute("SELECT count(*) FROM outbox WHERE state = 'PENDING'").fetchone()
        return int(row[0])

    def close(self) -> None:
        self.connection.close()
