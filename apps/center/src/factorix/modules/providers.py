"""Data-access contracts (Ports / Protocols) decoupling domain & HTTP from physical stores.

All live, historical, model-snapshot, and recording-policy storage implementations adhere to these
protocols so PostgreSQL-backed legacy paths, TDengine TSDB paths, and tests remain interchangeable
without changing REST contracts (§17.1 & §17.2).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal, Protocol
from uuid import UUID

from factorix.domain.canonical import CanonicalObservation


class RecordingMode(StrEnum):
    ON_CHANGE = "ON_CHANGE"
    EVERY_ACQUISITION = "EVERY_ACQUISITION"
    INTERVAL = "INTERVAL"


class SkipReason(StrEnum):
    NONE = "NONE"
    UNCHANGED_VALUE_AND_QUALITY = "UNCHANGED_VALUE_AND_QUALITY"
    WITHIN_DEADBAND = "WITHIN_DEADBAND"
    INTERVAL_NOT_ELAPSED = "INTERVAL_NOT_ELAPSED"
    POLICY_PAUSED = "POLICY_PAUSED"
    EPOCH_FENCED = "EPOCH_FENCED"


@dataclass(frozen=True, slots=True)
class LiveSignalRecord:
    """Latest authentic state for one signal within the active telemetry epoch."""

    tenant_id: UUID
    signal_id: UUID
    resource_id: UUID
    observation_id: UUID | None
    event_uid: str | None
    data_epoch: int
    value_type: str
    value: Any
    unit: str | None
    raw_quality: str
    reason_code: str | None
    event_time: datetime
    last_acquired_at: datetime
    last_value_changed_at: datetime | None
    source_time: datetime | None
    config_revision: int
    origin: str
    last_good_value: Any = None
    last_good_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class HistoricalPoint:
    """Single historical point returned by HistoryRepository."""

    id: str
    event_uid: str
    signal_id: UUID
    event_time: datetime
    received_time: datetime
    source_time: datetime | None
    value_type: str
    value: Any
    unit: str | None
    quality: str
    reason_code: str | None
    origin: str
    config_revision: int
    data_epoch: int = 1
    record_kind: Literal["RAW_OPERATIONAL", "MANAGED_RECORDED", "RECONSTRUCTED_STEP"] = "RAW_OPERATIONAL"
    virtual: bool = False
    dataset_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class HistoricalPage:
    items: list[HistoricalPoint]
    next_cursor: str | None
    downsampled: bool = False
    fidelity: Literal["operational_full", "managed_recorded", "reconstructed"] = "operational_full"
    coverage_notes: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class HistoricalBucket:
    signal_id: UUID
    bucket: datetime
    value: float | None
    good_count: int
    sample_count: int


@dataclass(frozen=True, slots=True)
class ModelSnapshotRecord:
    group_id: UUID
    sampled_at: datetime
    body: str
    errors: list[dict[str, Any]]
    error_count: int
    data_epoch: int = 1


@dataclass(frozen=True, slots=True)
class ManagedWriteDirective:
    dataset_id: UUID
    dataset_version_id: UUID | None
    subtable: str
    write_row: bool
    skip_reason: SkipReason
    keepalive_triggered: bool = False


@dataclass(frozen=True, slots=True)
class RecordingDecision:
    write_operational: bool
    update_live_activity: bool
    managed_directives: tuple[ManagedWriteDirective, ...] = ()


@dataclass(frozen=True, slots=True)
class StorageHealthSnapshot:
    broker_ok: bool
    tdengine_ok: bool
    postgres_ok: bool
    writer_running: bool
    broker_ready_count: int | None
    broker_unacked_count: int | None
    broker_dlq_count: int | None
    oldest_queued_age_s: float | None
    writer_lag_p95_ms: float | None
    tdengine_disk_bytes: int | None
    tdengine_free_bytes: int | None
    checked_at: datetime
    warnings: list[str] = field(default_factory=list)


class LiveStateProvider(Protocol):
    async def get_latest(self, tenant_id: UUID, signal_ids: list[UUID]) -> dict[UUID, LiveSignalRecord]: ...

    async def apply_observation(self, obs: CanonicalObservation, *, observation_id: UUID | None = None) -> tuple[bool, bool]:
        """Apply incoming active-epoch observation; returns (accepted_as_newest, value_or_quality_changed)."""
        ...

    async def invalidate_epoch(self, tenant_id: UUID, new_epoch: int) -> None: ...


class HistoricalValueProvider(Protocol):
    async def query_raw(
        self,
        tenant_id: UUID,
        *,
        signal_id: UUID,
        start: datetime,
        end: datetime,
        limit: int,
        cursor: str | None = None,
        mode: Literal["operational", "recorded", "reconstructed"] = "operational",
        dataset_id: UUID | None = None,
    ) -> HistoricalPage: ...

    async def aggregate(
        self,
        tenant_id: UUID,
        *,
        signal_ids: list[UUID],
        start: datetime,
        end: datetime,
        bucket_ms: int,
        fn: Literal["min", "max", "avg", "count", "sum"],
    ) -> list[HistoricalBucket]: ...

    async def value_at(
        self,
        tenant_id: UUID,
        *,
        signal_id: UUID,
        at: datetime,
        axis: Literal["source", "event"] = "event",
        lookback_ms: int = 86_400_000,
    ) -> tuple[Any, str | None, datetime | None] | None: ...


class ModelSnapshotProvider(Protocol):
    async def append_snapshot(self, tenant_id: UUID, record: ModelSnapshotRecord) -> None: ...

    async def list_snapshots(self, tenant_id: UUID, group_id: UUID, *, limit: int = 20) -> list[ModelSnapshotRecord]: ...

    async def clear_epoch(self, tenant_id: UUID, max_epoch: int) -> int: ...


class RecordingPolicyEvaluator(Protocol):
    def evaluate(
        self,
        obs: CanonicalObservation,
        *,
        previous_live: LiveSignalRecord | None,
        last_recorded_by_dataset: Mapping[UUID, tuple[Any, str, datetime]] | None = None,
    ) -> RecordingDecision: ...
