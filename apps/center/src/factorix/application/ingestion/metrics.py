"""Ingestion pipeline: dedup LRU, latency histogram and worker counters. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime
import math
import time
from typing import Any
from uuid import UUID

from factorix.domain.canonical import LatencySLIs


class RecentUidLru:
    """Bounded FIFO/LRU cache preventing duplicate processing of identical event_uids within a window."""

    def __init__(self, max_size: int = 100_000) -> None:
        self.max_size = max(16, int(max_size))
        self._items: OrderedDict[tuple[UUID, str], float] = OrderedDict()

    def __contains__(self, key: tuple[UUID, str]) -> bool:
        hit = key in self._items
        if hit:
            self._items.move_to_end(key)
        return hit

    def mark(self, key: tuple[UUID, str]) -> None:
        self._items[key] = time.monotonic()
        self._items.move_to_end(key)
        while len(self._items) > self.max_size:
            self._items.popitem(last=False)

    def clear_tenant(self, tenant_id: UUID) -> None:
        drop_keys = [k for k in self._items if k[0] == tenant_id]
        for k in drop_keys:
            self._items.pop(k, None)

    def __len__(self) -> int:
        return len(self._items)


class LatencyHistogram:
    """Bounded sliding sample tracker for p50/p95/max ingest & commit SLI reporting.

    SLIs are kept per lane. ``sli_acq_to_commit_*`` / ``sli_ingest_to_commit_*`` describe the
    LIVE lane only (what operators read as "how fresh is the UI"); replayed history (spool
    backlog, hours old by design) is reported separately as ``sli_replay_*`` so it cannot
    pollute the live numbers.
    """

    def __init__(self, max_samples: int = 2048) -> None:
        self.max_samples = max(64, int(max_samples))
        self._acq_to_commit_ms: deque[float] = deque(maxlen=self.max_samples)
        self._ingest_to_commit_ms: deque[float] = deque(maxlen=self.max_samples)
        self._replay_acq_to_commit_ms: deque[float] = deque(maxlen=self.max_samples)
        self._replay_ingest_to_commit_ms: deque[float] = deque(maxlen=self.max_samples)
        self._events: dict[UUID, list[float]] = {}
        self._conn_events: dict[UUID, list[float]] = {}
        self._batch_stages: dict[str, deque[float]] = {}

    def record_batch_stage(self, stage: str, started_at: float) -> None:
        samples = self._batch_stages.get(stage)
        if samples is None:
            samples = self._batch_stages[stage] = deque(maxlen=256)
        samples.append((time.monotonic() - started_at) * 1000)

    def record(
        self,
        tenant_id: UUID,
        sli: LatencySLIs,
        *,
        connection_id: UUID | None = None,
        lane: str = "live",
    ) -> None:
        now = time.monotonic()
        bucket = self._events.setdefault(tenant_id, [])
        bucket.append(now)
        if connection_id is not None:
            self._conn_events.setdefault(connection_id, []).append(now)
        replay = lane != "live"
        if sli.acquisition_to_commit_ms is not None:
            (self._replay_acq_to_commit_ms if replay else self._acq_to_commit_ms).append(sli.acquisition_to_commit_ms)
        if sli.ingest_to_commit_ms is not None:
            (self._replay_ingest_to_commit_ms if replay else self._ingest_to_commit_ms).append(sli.ingest_to_commit_ms)

    def tenant_rates_per_min(self) -> dict[str, int]:
        cutoff = time.monotonic() - 60.0
        out: dict[str, int] = {}
        for tid in list(self._events):
            recent = [t for t in self._events[tid] if t >= cutoff]
            if recent:
                self._events[tid] = recent
                out[str(tid)] = len(recent)
            else:
                self._events.pop(tid, None)
        return out

    def connection_rates_per_min(self) -> dict[str, int]:
        cutoff = time.monotonic() - 60.0
        out: dict[str, int] = {}
        for cid in list(self._conn_events):
            recent = [t for t in self._conn_events[cid] if t >= cutoff]
            if recent:
                self._conn_events[cid] = recent
                out[str(cid)] = len(recent)
            else:
                self._conn_events.pop(cid, None)
        return out

    @staticmethod
    def _pct(values: list[float] | deque[float], pct: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        idx = min(len(ordered) - 1, max(0, int(math.ceil(pct * len(ordered))) - 1))
        return round(ordered[idx], 3)

    def snapshot(self) -> dict[str, Any]:
        return {
            "sli_acq_to_commit_p50_ms": self._pct(self._acq_to_commit_ms, 0.50),
            "sli_acq_to_commit_p95_ms": self._pct(self._acq_to_commit_ms, 0.95),
            "sli_acq_to_commit_max_ms": round(max(self._acq_to_commit_ms), 3) if self._acq_to_commit_ms else None,
            "sli_ingest_to_commit_p50_ms": self._pct(self._ingest_to_commit_ms, 0.50),
            "sli_ingest_to_commit_p95_ms": self._pct(self._ingest_to_commit_ms, 0.95),
            "sli_replay_acq_to_commit_p50_ms": self._pct(self._replay_acq_to_commit_ms, 0.50),
            "sli_replay_acq_to_commit_max_ms": (
                round(max(self._replay_acq_to_commit_ms), 3) if self._replay_acq_to_commit_ms else None
            ),
            "sli_replay_ingest_to_commit_p50_ms": self._pct(self._replay_ingest_to_commit_ms, 0.50),
            "sli_replay_ingest_to_commit_p95_ms": self._pct(self._replay_ingest_to_commit_ms, 0.95),
            "batch_stage_timings_ms": {
                stage: {"samples": len(values), "p50": self._pct(values, 0.50), "p95": self._pct(values, 0.95)}
                for stage, values in self._batch_stages.items()
            },
        }


@dataclass(slots=True)
class WorkerMetrics:
    received_total: int = 0
    acked_total: int = 0
    dlq_total: int = 0
    retried_total: int = 0
    dedup_hits: int = 0
    test_dropped: int = 0
    epoch_fenced_dropped: int = 0
    tdengine_writes: int = 0
    tdengine_retryable_errors: int = 0
    tdengine_permanent_errors: int = 0
    pg_retryable_errors: int = 0
    formula_writes: int = 0
    managed_writes: int = 0
    managed_checkpoints: int = 0
    managed_gap_markers: int = 0
    managed_write_errors: int = 0
    managed_skips_by_reason: dict[str, int] = field(default_factory=dict)
    batches_committed: int = 0
    last_commit_at: datetime | None = None
    last_error: str | None = None
