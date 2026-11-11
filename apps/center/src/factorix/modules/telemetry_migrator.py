"""PostgreSQL -> TDengine Historical Telemetry & Model Snapshot Migrator (S14).

Implements §12 (S14) and §14 of the Master Implementation Plan:
- Migrates historical PostgreSQL ``observations`` and ``model_snapshots`` into TDengine
  in deterministic keyset-paginated chunks (``chunk_size = 1000`` by default).
- Derives a deterministic, collision-resistant ``event_uid`` when missing or empty so
  repeated/resumed migration runs remain idempotent.
- Preserves ``source_time``, ``event_time``, ``received_time`` (``acquired_at``),
  ``quality``, ``reason_code``, ``origin``, ``unit``, ``config_revision``, and ``data_epoch``.
- Checkpoints chunk cursors, counts, and SHA-256 chunk digests in ``storage_operations``
  (``operation_type = 'PG_TO_TDENGINE_MIGRATION'``, ``kind = 'PG_TO_TDENGINE_MIGRATION'``)
  for restartable execution.
- Verifies per-signal and per-data-model row-count + sample parity between PostgreSQL
  and TDengine without deleting source PostgreSQL history.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import logging
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.canonical import derive_event_uid, normalize_value_type
from factorix.modules.common import (
    as_uuid,
    execute,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    utcnow,
)
from factorix.modules.history_repository import TDengineModelSnapshotProvider
from factorix.modules.live_state import _canonical_equal, _decode_td_value
from factorix.modules.providers import ModelSnapshotRecord
from factorix.platform.tdengine import (
    TDEngineClient,
    TDEngineError,
    model_snapshot_subtable_name,
    op_subtable_name,
    quote_fq_table,
    tenant_database_name,
    to_td_timestamp_us,
    to_utc_datetime,
)

logger = logging.getLogger(__name__)

MIGRATION_KIND = "PG_TO_TDENGINE_MIGRATION"
DEFAULT_CHUNK_SIZE = 1000


def _utc(dt: Any) -> datetime | None:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    if isinstance(dt, str):
        stripped = dt.strip()
        if not stripped:
            return None
        parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return to_utc_datetime(dt)


def _extract_pg_value(raw_vj: Any) -> Any:
    if raw_vj is None:
        return None
    if isinstance(raw_vj, str):
        stripped = raw_vj.strip()
        if not stripped:
            return None
        try:
            raw_vj = json.loads(stripped)
        except json.JSONDecodeError:
            return raw_vj
    if isinstance(raw_vj, Mapping) and "v" in raw_vj:
        return raw_vj["v"]
    return raw_vj


def _parse_json_dict(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, Mapping):
        return dict(raw)
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return {}
        try:
            loaded = json.loads(stripped)
            return dict(loaded) if isinstance(loaded, Mapping) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def ensure_deterministic_event_uid(
    row: Mapping[str, Any],
    *,
    tenant_id: UUID | None = None,
    data_epoch: int = 1,
) -> str:
    """Return existing ``event_uid`` if non-empty, or derive a deterministic UID from row identity."""
    raw_uid = str(row.get("event_uid") or "").strip()
    if raw_uid:
        return raw_uid[:64]

    tid = tenant_id or as_uuid(row["tenant_id"])
    sig_id = as_uuid(row["signal_id"])
    conn_raw = row.get("connection_id")
    conn_id = as_uuid(conn_raw) if conn_raw else None
    prov = _parse_json_dict(row.get("provenance_json"))
    sf_raw = row.get("source_field_id") or prov.get("source_field_id")
    sf_id = as_uuid(sf_raw) if sf_raw else None
    ev_time = _utc(row.get("event_time") or row.get("received_time")) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    row_id = str(row.get("id") or "")
    eff_epoch = max(1, int(row.get("data_epoch") or prov.get("data_epoch") or data_epoch))

    return derive_event_uid(
        tenant_id=tid,
        connection_id=conn_id,
        source_field_id=sf_id,
        signal_id=sig_id,
        acquired_at=ev_time,
        sequence_or_key=row_id or 0,
        data_epoch=eff_epoch,
    )


def _chunk_digest(ids: Sequence[Any]) -> str:
    payload = "|".join(str(x) for x in ids)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


@dataclass(frozen=True, slots=True)
class SignalParityReport:
    signal_id: UUID
    value_type: str
    pg_count: int
    td_count: int
    counts_match: bool
    samples_checked: int
    sample_mismatches: list[dict[str, Any]] = field(default_factory=list)

    @property
    def parity_ok(self) -> bool:
        return self.counts_match and not self.sample_mismatches

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal_id": str(self.signal_id),
            "value_type": self.value_type,
            "pg_count": self.pg_count,
            "td_count": self.td_count,
            "counts_match": self.counts_match,
            "samples_checked": self.samples_checked,
            "sample_mismatches": list(self.sample_mismatches),
            "parity_ok": self.parity_ok,
        }


@dataclass(frozen=True, slots=True)
class ModelParityReport:
    group_id: UUID
    pg_count: int
    td_count: int
    counts_match: bool
    samples_checked: int
    sample_mismatches: list[dict[str, Any]] = field(default_factory=list)

    @property
    def parity_ok(self) -> bool:
        return self.counts_match and not self.sample_mismatches

    def to_dict(self) -> dict[str, Any]:
        return {
            "group_id": str(self.group_id),
            "pg_count": self.pg_count,
            "td_count": self.td_count,
            "counts_match": self.counts_match,
            "samples_checked": self.samples_checked,
            "sample_mismatches": list(self.sample_mismatches),
            "parity_ok": self.parity_ok,
        }


@dataclass(frozen=True, slots=True)
class MigrationParityResult:
    tenant_id: UUID
    parity_ok: bool
    signals_checked: int
    models_checked: int
    signal_reports: list[SignalParityReport]
    model_reports: list[ModelParityReport]
    mismatches: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": str(self.tenant_id),
            "parity_ok": self.parity_ok,
            "signals_checked": self.signals_checked,
            "models_checked": self.models_checked,
            "signal_reports": [r.to_dict() for r in self.signal_reports],
            "model_reports": [r.to_dict() for r in self.model_reports],
            "mismatches": list(self.mismatches),
        }


@dataclass(frozen=True, slots=True)
class MigrationResult:
    operation_id: UUID
    tenant_id: UUID
    kind: str
    status: str
    chunk_size: int
    observations_migrated: int
    observations_chunks: int
    model_snapshots_migrated: int
    model_snapshots_chunks: int
    last_observation_cursor: dict[str, Any] | None
    last_snapshot_cursor: dict[str, Any] | None
    parity: MigrationParityResult | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": str(self.operation_id),
            "tenant_id": str(self.tenant_id),
            "kind": self.kind,
            "status": self.status,
            "chunk_size": self.chunk_size,
            "observations_migrated": self.observations_migrated,
            "observations_chunks": self.observations_chunks,
            "model_snapshots_migrated": self.model_snapshots_migrated,
            "model_snapshots_chunks": self.model_snapshots_chunks,
            "last_observation_cursor": self.last_observation_cursor,
            "last_snapshot_cursor": self.last_snapshot_cursor,
            "parity": self.parity.to_dict() if self.parity else None,
        }


class TelemetryMigrator:
    """Keyset-paginated PG -> TDengine historical telemetry and model snapshot migrator."""

    def __init__(self, tdengine: TDEngineClient, *, chunk_size: int = DEFAULT_CHUNK_SIZE) -> None:
        if chunk_size < 1:
            raise ValueError("chunk_size must be >= 1")
        self._td = tdengine
        self._chunk_size = min(int(chunk_size), 10_000)
        self._snapshot_provider = TDengineModelSnapshotProvider(tdengine)

    @property
    def chunk_size(self) -> int:
        return self._chunk_size

    @property
    def tdengine(self) -> TDEngineClient:
        return self._td

    def transform_observation_row(
        self,
        row: Mapping[str, Any],
        *,
        tenant_id: UUID,
        default_epoch: int = 1,
    ) -> dict[str, Any]:
        """Convert a PG ``observations`` row into a canonical TDengine operational record."""
        prov = _parse_json_dict(row.get("provenance_json"))
        ev_time = _utc(row["event_time"])
        assert ev_time is not None
        rx_time = _utc(row.get("received_time")) or ev_time
        src_time = _utc(row.get("source_time"))
        val_type = normalize_value_type(str(row.get("value_type") or "float64"))
        val = _extract_pg_value(row.get("value_json") if "value_json" in row else row.get("value"))
        raw_quality = str(row.get("quality") or row.get("raw_quality") or "GOOD").upper()
        reason_code = row.get("reason_code") or prov.get("reason") or prov.get("quality_reason")
        data_epoch = max(1, int(row.get("data_epoch") or prov.get("data_epoch") or default_epoch))
        source_seq_raw = row.get("source_sequence") if row.get("source_sequence") is not None else prov.get("source_sequence")
        source_seq = int(source_seq_raw) if source_seq_raw is not None else None
        ev_uid = ensure_deterministic_event_uid(row, tenant_id=tenant_id, data_epoch=data_epoch)

        return {
            "signal_id": as_uuid(row["signal_id"]),
            "resource_id": as_uuid(row["resource_id"]),
            "connection_id": as_uuid(row["connection_id"]) if row.get("connection_id") else None,
            "event_uid": ev_uid,
            "event_time": ev_time,
            "acquired_at": rx_time,
            "received_time": rx_time,
            "source_time": src_time,
            "value_type": val_type,
            "value": val,
            "unit": row.get("unit"),
            "raw_quality": raw_quality,
            "quality": raw_quality,
            "reason_code": str(reason_code)[:64] if reason_code else None,
            "origin": str(row.get("origin") or "LIVE").upper(),
            "config_revision": max(1, int(row.get("config_revision") or 1)),
            "data_epoch": data_epoch,
            "source_seq": source_seq,
        }

    def transform_snapshot_row(
        self,
        row: Mapping[str, Any],
        *,
        default_epoch: int = 1,
    ) -> ModelSnapshotRecord:
        """Convert a PG ``model_snapshots`` row into a ``ModelSnapshotRecord``."""
        sampled_at = _utc(row["sampled_at"])
        assert sampled_at is not None
        raw_errs = row.get("errors_json")
        if isinstance(raw_errs, str):
            try:
                parsed = json.loads(raw_errs) if raw_errs.strip() else []
                errs = list(parsed) if isinstance(parsed, list) else []
            except json.JSONDecodeError:
                errs = []
        elif isinstance(raw_errs, Sequence) and not isinstance(raw_errs, (bytes, bytearray, str)):
            errs = list(raw_errs)
        else:
            errs = []
        data_epoch = max(1, int(row.get("data_epoch") or default_epoch))
        return ModelSnapshotRecord(
            group_id=as_uuid(row["group_id"]),
            sampled_at=sampled_at,
            body=str(row.get("body_text") or ""),
            errors=errs,
            error_count=int(row.get("error_count") if row.get("error_count") is not None else len(errs)),
            data_epoch=data_epoch,
        )

    async def _fetch_observation_chunk(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        *,
        cursor_event_time: datetime | None,
        cursor_id: UUID | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        if cursor_event_time is None or cursor_id is None:
            return await fetch_all(
                session,
                """
                SELECT id, tenant_id, site_id, resource_id, signal_id, edge_id, connection_id,
                       event_uid, event_time, received_time, source_time, value_type, value_json,
                       unit, quality, origin, config_revision, provenance_json
                FROM observations
                WHERE tenant_id = CAST(:tenant_id AS uuid)
                ORDER BY event_time ASC, id ASC
                LIMIT CAST(:limit AS integer)
                """,
                {"tenant_id": tenant_id, "limit": limit},
            )
        return await fetch_all(
            session,
            """
            SELECT id, tenant_id, site_id, resource_id, signal_id, edge_id, connection_id,
                   event_uid, event_time, received_time, source_time, value_type, value_json,
                   unit, quality, origin, config_revision, provenance_json
            FROM observations
            WHERE tenant_id = CAST(:tenant_id AS uuid)
              AND (
                  event_time > CAST(:cursor_event_time AS timestamptz)
                  OR (event_time = CAST(:cursor_event_time AS timestamptz) AND id > CAST(:cursor_id AS uuid))
              )
            ORDER BY event_time ASC, id ASC
            LIMIT CAST(:limit AS integer)
            """,
            {
                "tenant_id": tenant_id,
                "cursor_event_time": cursor_event_time,
                "cursor_id": cursor_id,
                "limit": limit,
            },
        )

    async def _fetch_snapshot_chunk(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        *,
        cursor_sampled_at: datetime | None,
        cursor_id: int | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        if cursor_sampled_at is None or cursor_id is None:
            return await fetch_all(
                session,
                """
                SELECT id, group_id, tenant_id, sampled_at, body_text, errors_json, error_count
                FROM model_snapshots
                WHERE tenant_id = CAST(:tenant_id AS uuid)
                ORDER BY sampled_at ASC, id ASC
                LIMIT CAST(:limit AS integer)
                """,
                {"tenant_id": tenant_id, "limit": limit},
            )
        return await fetch_all(
            session,
            """
            SELECT id, group_id, tenant_id, sampled_at, body_text, errors_json, error_count
            FROM model_snapshots
            WHERE tenant_id = CAST(:tenant_id AS uuid)
              AND (
                  sampled_at > CAST(:cursor_sampled_at AS timestamptz)
                  OR (sampled_at = CAST(:cursor_sampled_at AS timestamptz) AND id > CAST(:cursor_id AS bigint))
              )
            ORDER BY sampled_at ASC, id ASC
            LIMIT CAST(:limit AS integer)
            """,
            {
                "tenant_id": tenant_id,
                "cursor_sampled_at": cursor_sampled_at,
                "cursor_id": int(cursor_id),
                "limit": limit,
            },
        )

    async def _update_checkpoint(
        self,
        session: AsyncSession,
        operation_id: UUID,
        tenant_id: UUID,
        *,
        status: str,
        step_state: Mapping[str, Any],
        completed_at: datetime | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        await execute(
            session,
            """
            UPDATE storage_operations
            SET status = CAST(:status AS text),
                completed_at = CAST(:completed_at AS timestamptz),
                error_code = CAST(:error_code AS text),
                error_message = CAST(:error_message AS text),
                step_state_json = CAST(:step_state AS jsonb)
            WHERE id = CAST(:id AS uuid) AND tenant_id = CAST(:tenant_id AS uuid)
            """,
            {
                "status": status,
                "completed_at": completed_at,
                "error_code": error_code,
                "error_message": error_message,
                "step_state": jsonb(step_state),
                "id": operation_id,
                "tenant_id": tenant_id,
            },
        )

    async def migrate_tenant(
        self,
        session: AsyncSession,
        tenant_id: UUID | str,
        *,
        actor_id: UUID | str | None = None,
        idempotency_key: str | None = None,
        resume_operation_id: UUID | str | None = None,
        verify: bool = True,
    ) -> MigrationResult:
        """Migrate tenant PG ``observations`` and ``model_snapshots`` into TDengine with checkpoints."""
        tid = as_uuid(tenant_id)
        aid = as_uuid(actor_id) if actor_id else None

        gen_row = await fetch_one(
            session,
            "SELECT active_epoch FROM telemetry_generations WHERE tenant_id = CAST(:tenant_id AS uuid)",
            {"tenant_id": tid},
        )
        default_epoch = max(1, int((gen_row or {}).get("active_epoch") or 1))

        await self._td.ensure_operational_schema(tid)

        obs_cursor_time: datetime | None = None
        obs_cursor_id: UUID | None = None
        snap_cursor_time: datetime | None = None
        snap_cursor_id: int | None = None
        obs_migrated = 0
        obs_chunks = 0
        snap_migrated = 0
        snap_chunks = 0
        chunk_checksums: list[str] = []

        now = utcnow()
        existing_op: dict[str, Any] | None = None
        if resume_operation_id is not None:
            existing_op = await fetch_one(
                session,
                """
                SELECT id, step_state_json
                FROM storage_operations
                WHERE id = CAST(:id AS uuid) AND tenant_id = CAST(:tenant_id AS uuid)
                """,
                {"id": as_uuid(resume_operation_id), "tenant_id": tid},
            )
        elif idempotency_key:
            existing_op = await fetch_one(
                session,
                """
                SELECT id, step_state_json
                FROM storage_operations
                WHERE tenant_id = CAST(:tenant_id AS uuid)
                  AND operation_type = CAST(:op_type AS text)
                  AND idempotency_key = CAST(:idemp_key AS text)
                """,
                {"tenant_id": tid, "op_type": MIGRATION_KIND, "idemp_key": idempotency_key},
            )

        if existing_op is not None:
            operation_id = as_uuid(existing_op["id"])
            saved_state = _parse_json_dict(existing_op.get("step_state_json"))
            obs_migrated = int(saved_state.get("observations_migrated") or 0)
            obs_chunks = int(saved_state.get("observations_chunks") or 0)
            snap_migrated = int(saved_state.get("model_snapshots_migrated") or 0)
            snap_chunks = int(saved_state.get("model_snapshots_chunks") or 0)
            last_obs = saved_state.get("last_observation_cursor")
            if isinstance(last_obs, Mapping) and last_obs.get("event_time") and last_obs.get("id"):
                obs_cursor_time = _utc(last_obs["event_time"])
                obs_cursor_id = as_uuid(last_obs["id"])
            last_snap = saved_state.get("last_snapshot_cursor")
            if isinstance(last_snap, Mapping) and last_snap.get("sampled_at") and last_snap.get("id") is not None:
                snap_cursor_time = _utc(last_snap["sampled_at"])
                snap_cursor_id = int(last_snap["id"])
            if isinstance(saved_state.get("chunk_checksums"), list):
                chunk_checksums = [str(c) for c in saved_state["chunk_checksums"]]
        else:
            operation_id = uuid4()
            initial_state = {
                "kind": MIGRATION_KIND,
                "chunk_size": self._chunk_size,
                "observations_migrated": 0,
                "observations_chunks": 0,
                "model_snapshots_migrated": 0,
                "model_snapshots_chunks": 0,
                "last_observation_cursor": None,
                "last_snapshot_cursor": None,
                "chunk_checksums": [],
                "started_at": iso_ms(now),
            }
            await execute(
                session,
                """
                INSERT INTO storage_operations (
                    id, tenant_id, operation_type, target_type, target_id, actor_id,
                    idempotency_key, status, requested_at, approved_at, started_at,
                    step_state_json, trace_id
                ) VALUES (
                    CAST(:id AS uuid), CAST(:tenant_id AS uuid), CAST(:op_type AS text), 'tenant', CAST(:tenant_id AS uuid),
                    CAST(:actor_id AS uuid), CAST(:idemp_key AS text), 'RUNNING', CAST(:now AS timestamptz), CAST(:now AS timestamptz), CAST(:now AS timestamptz),
                    CAST(:step_state AS jsonb), CAST(:trace_id AS text)
                )
                """,
                {
                    "id": operation_id,
                    "tenant_id": tid,
                    "op_type": MIGRATION_KIND,
                    "actor_id": aid,
                    "idemp_key": idempotency_key,
                    "now": now,
                    "step_state": jsonb(initial_state),
                    "trace_id": f"mig-{operation_id.hex[:12]}",
                },
            )

        try:
            # 1. Keyset-paginated migration of `observations`
            while True:
                rows = await self._fetch_observation_chunk(
                    session,
                    tid,
                    cursor_event_time=obs_cursor_time,
                    cursor_id=obs_cursor_id,
                    limit=self._chunk_size,
                )
                if not rows:
                    break

                records = [
                    self.transform_observation_row(r, tenant_id=tid, default_epoch=default_epoch)
                    for r in rows
                ]
                write_res = await self._td.write_operational_observations(
                    tid, records, record_kind="RAW_OPERATIONAL"
                )
                if write_res.failures:
                    first = write_res.failures[0]
                    raise TDEngineError(first.code, first.message, retryable=first.retryable)

                last_row = rows[-1]
                obs_cursor_time = _utc(last_row["event_time"])
                obs_cursor_id = as_uuid(last_row["id"])
                obs_migrated += len(rows)
                obs_chunks += 1
                chunk_checksums.append(_chunk_digest([r["event_uid"] for r in records]))

                step_state = {
                    "kind": MIGRATION_KIND,
                    "phase": "OBSERVATIONS",
                    "chunk_size": self._chunk_size,
                    "observations_migrated": obs_migrated,
                    "observations_chunks": obs_chunks,
                    "model_snapshots_migrated": snap_migrated,
                    "model_snapshots_chunks": snap_chunks,
                    "last_observation_cursor": {
                        "event_time": iso_ms(obs_cursor_time),
                        "id": str(obs_cursor_id),
                    },
                    "last_snapshot_cursor": (
                        {"sampled_at": iso_ms(snap_cursor_time), "id": snap_cursor_id}
                        if snap_cursor_time is not None and snap_cursor_id is not None
                        else None
                    ),
                    "chunk_checksums": chunk_checksums[-64:],
                    "updated_at": iso_ms(utcnow()),
                }
                await self._update_checkpoint(
                    session,
                    operation_id,
                    tid,
                    status="RUNNING",
                    step_state=step_state,
                )

                if len(rows) < self._chunk_size:
                    break

            # 2. Keyset-paginated migration of `model_snapshots`
            while True:
                snap_rows = await self._fetch_snapshot_chunk(
                    session,
                    tid,
                    cursor_sampled_at=snap_cursor_time,
                    cursor_id=snap_cursor_id,
                    limit=self._chunk_size,
                )
                if not snap_rows:
                    break

                snap_records = [
                    self.transform_snapshot_row(r, default_epoch=default_epoch)
                    for r in snap_rows
                ]
                await self._snapshot_provider.append_snapshots_batch(tid, snap_records)

                last_snap_row = snap_rows[-1]
                snap_cursor_time = _utc(last_snap_row["sampled_at"])
                snap_cursor_id = int(last_snap_row["id"])
                snap_migrated += len(snap_rows)
                snap_chunks += 1
                chunk_checksums.append(_chunk_digest([f"{r.group_id}:{iso_ms(r.sampled_at)}" for r in snap_records]))

                step_state = {
                    "kind": MIGRATION_KIND,
                    "phase": "MODEL_SNAPSHOTS",
                    "chunk_size": self._chunk_size,
                    "observations_migrated": obs_migrated,
                    "observations_chunks": obs_chunks,
                    "model_snapshots_migrated": snap_migrated,
                    "model_snapshots_chunks": snap_chunks,
                    "last_observation_cursor": (
                        {"event_time": iso_ms(obs_cursor_time), "id": str(obs_cursor_id)}
                        if obs_cursor_time is not None and obs_cursor_id is not None
                        else None
                    ),
                    "last_snapshot_cursor": {
                        "sampled_at": iso_ms(snap_cursor_time),
                        "id": snap_cursor_id,
                    },
                    "chunk_checksums": chunk_checksums[-64:],
                    "updated_at": iso_ms(utcnow()),
                }
                await self._update_checkpoint(
                    session,
                    operation_id,
                    tid,
                    status="RUNNING",
                    step_state=step_state,
                )

                if len(snap_rows) < self._chunk_size:
                    break

            # 3. Optional Parity Verification
            parity_res: MigrationParityResult | None = None
            if verify:
                parity_res = await self.verify_parity(session, tid)

            completed_at = utcnow()
            final_obs_cursor = (
                {"event_time": iso_ms(obs_cursor_time), "id": str(obs_cursor_id)}
                if obs_cursor_time is not None and obs_cursor_id is not None
                else None
            )
            final_snap_cursor = (
                {"sampled_at": iso_ms(snap_cursor_time), "id": snap_cursor_id}
                if snap_cursor_time is not None and snap_cursor_id is not None
                else None
            )
            final_state = {
                "kind": MIGRATION_KIND,
                "phase": "COMPLETED",
                "result_status": "SUCCEEDED" if (parity_res is None or parity_res.parity_ok) else "PARITY_MISMATCH",
                "chunk_size": self._chunk_size,
                "observations_migrated": obs_migrated,
                "observations_chunks": obs_chunks,
                "model_snapshots_migrated": snap_migrated,
                "model_snapshots_chunks": snap_chunks,
                "last_observation_cursor": final_obs_cursor,
                "last_snapshot_cursor": final_snap_cursor,
                "chunk_checksums": chunk_checksums[-64:],
                "parity": parity_res.to_dict() if parity_res else None,
                "completed_at": iso_ms(completed_at),
            }
            await self._update_checkpoint(
                session,
                operation_id,
                tid,
                status="COMPLETED",
                step_state=final_state,
                completed_at=completed_at,
            )

            return MigrationResult(
                operation_id=operation_id,
                tenant_id=tid,
                kind=MIGRATION_KIND,
                status="SUCCEEDED",
                chunk_size=self._chunk_size,
                observations_migrated=obs_migrated,
                observations_chunks=obs_chunks,
                model_snapshots_migrated=snap_migrated,
                model_snapshots_chunks=snap_chunks,
                last_observation_cursor=final_obs_cursor,
                last_snapshot_cursor=final_snap_cursor,
                parity=parity_res,
            )

        except Exception as exc:
            fail_at = utcnow()
            fail_state = {
                "kind": MIGRATION_KIND,
                "phase": "PAUSED_RETRYABLE",
                "chunk_size": self._chunk_size,
                "observations_migrated": obs_migrated,
                "observations_chunks": obs_chunks,
                "model_snapshots_migrated": snap_migrated,
                "model_snapshots_chunks": snap_chunks,
                "last_observation_cursor": (
                    {"event_time": iso_ms(obs_cursor_time), "id": str(obs_cursor_id)}
                    if obs_cursor_time is not None and obs_cursor_id is not None
                    else None
                ),
                "last_snapshot_cursor": (
                    {"sampled_at": iso_ms(snap_cursor_time), "id": snap_cursor_id}
                    if snap_cursor_time is not None and snap_cursor_id is not None
                    else None
                ),
                "chunk_checksums": chunk_checksums[-64:],
                "failed_at": iso_ms(fail_at),
            }
            await self._update_checkpoint(
                session,
                operation_id,
                tid,
                status="PAUSED_RETRYABLE",
                step_state=fail_state,
                error_code=getattr(exc, "code", "MIGRATION_CHUNK_FAILED"),
                error_message=str(exc)[:500],
            )
            raise

    async def verify_parity(
        self,
        session: AsyncSession,
        tenant_id: UUID | str,
        *,
        sample_limit_per_entity: int = 5,
    ) -> MigrationParityResult:
        """Verify row-count and sample value/timestamp/quality parity per signal and per data model."""
        tid = as_uuid(tenant_id)
        prefix = getattr(getattr(self._td, "config", None), "db_prefix", "fx_t_") or "fx_t_"
        db = tenant_database_name(tid, prefix=prefix)
        sample_cap = max(1, min(int(sample_limit_per_entity), 50))

        signal_summary_rows = await fetch_all(
            session,
            """
            SELECT signal_id, value_type, COUNT(*) AS cnt
            FROM observations
            WHERE tenant_id = CAST(:tenant_id AS uuid)
            GROUP BY signal_id, value_type
            ORDER BY signal_id ASC
            """,
            {"tenant_id": tid},
        )

        signal_reports: list[SignalParityReport] = []
        mismatches: list[dict[str, Any]] = []

        for srow in signal_summary_rows:
            sig_id = as_uuid(srow["signal_id"])
            vtype = normalize_value_type(str(srow.get("value_type") or "float64"))
            pg_cnt = int(srow.get("cnt") or 0)
            subtable = op_subtable_name(sig_id, vtype)
            fq = quote_fq_table(db, subtable)

            try:
                cnt_rows = await self._td.query_rows(f"SELECT COUNT(*) AS cnt FROM {fq}")
                td_cnt = int((cnt_rows[0] if cnt_rows else {}).get("cnt") or 0)
            except TDEngineError:
                td_cnt = 0

            counts_match = pg_cnt == td_cnt

            pg_samples = await fetch_all(
                session,
                """
                SELECT id, tenant_id, signal_id, resource_id, connection_id, event_uid,
                       event_time, received_time, source_time, value_type, value_json,
                       unit, quality, origin, config_revision, provenance_json
                FROM observations
                WHERE tenant_id = CAST(:tenant_id AS uuid) AND signal_id = CAST(:signal_id AS uuid)
                ORDER BY event_time DESC, id DESC
                LIMIT CAST(:limit AS integer)
                """,
                {"tenant_id": tid, "signal_id": sig_id, "limit": sample_cap},
            )
            try:
                td_samples = await self._td.query_rows(
                    f"SELECT `ts`, `val`, `acquired_at`, `source_time`, `raw_quality`, `event_uid`, `data_epoch` "
                    f"FROM {fq} ORDER BY `ts` DESC LIMIT {sample_cap}"
                )
            except TDEngineError:
                td_samples = []

            sig_mismatches: list[dict[str, Any]] = []
            if not counts_match:
                mismatch = {
                    "entity_type": "signal",
                    "signal_id": str(sig_id),
                    "reason": "ROW_COUNT_MISMATCH",
                    "pg_count": pg_cnt,
                    "td_count": td_cnt,
                }
                sig_mismatches.append(mismatch)
                mismatches.append(mismatch)

            td_by_uid = {str(r.get("event_uid") or ""): r for r in td_samples if r.get("event_uid")}
            td_by_ts = {to_td_timestamp_us(_utc(r["ts"])): r for r in td_samples if _utc(r.get("ts")) is not None}

            for ps in pg_samples:
                expected = self.transform_observation_row(ps, tenant_id=tid)
                exp_uid = expected["event_uid"]
                exp_ts_us = to_td_timestamp_us(expected["event_time"])
                matched_td = td_by_uid.get(exp_uid) or td_by_ts.get(exp_ts_us)
                if matched_td is None:
                    mm = {
                        "entity_type": "signal",
                        "signal_id": str(sig_id),
                        "event_uid": exp_uid,
                        "reason": "MISSING_SAMPLE_IN_TDENGINE",
                    }
                    sig_mismatches.append(mm)
                    mismatches.append(mm)
                    continue

                td_val = _decode_td_value(matched_td.get("val"), vtype)
                td_qual = str(matched_td.get("raw_quality") or "GOOD").upper()
                if not _canonical_equal(expected["value"], td_val) or expected["raw_quality"] != td_qual:
                    mm = {
                        "entity_type": "signal",
                        "signal_id": str(sig_id),
                        "event_uid": exp_uid,
                        "reason": "SAMPLE_VALUE_OR_QUALITY_MISMATCH",
                        "pg_value": expected["value"],
                        "td_value": td_val,
                        "pg_quality": expected["raw_quality"],
                        "td_quality": td_qual,
                    }
                    sig_mismatches.append(mm)
                    mismatches.append(mm)

            signal_reports.append(
                SignalParityReport(
                    signal_id=sig_id,
                    value_type=vtype,
                    pg_count=pg_cnt,
                    td_count=td_cnt,
                    counts_match=counts_match,
                    samples_checked=len(pg_samples),
                    sample_mismatches=sig_mismatches,
                )
            )

        model_summary_rows = await fetch_all(
            session,
            """
            SELECT group_id, COUNT(*) AS cnt
            FROM model_snapshots
            WHERE tenant_id = CAST(:tenant_id AS uuid)
            GROUP BY group_id
            ORDER BY group_id ASC
            """,
            {"tenant_id": tid},
        )

        model_reports: list[ModelParityReport] = []
        for mrow in model_summary_rows:
            gid = as_uuid(mrow["group_id"])
            pg_cnt = int(mrow.get("cnt") or 0)
            subtable = model_snapshot_subtable_name(gid)
            fq = quote_fq_table(db, subtable)

            try:
                cnt_rows = await self._td.query_rows(f"SELECT COUNT(*) AS cnt FROM {fq}")
                td_cnt = int((cnt_rows[0] if cnt_rows else {}).get("cnt") or 0)
            except TDEngineError:
                td_cnt = 0

            counts_match = pg_cnt == td_cnt
            pg_snaps = await fetch_all(
                session,
                """
                SELECT id, group_id, sampled_at, body_text, errors_json, error_count
                FROM model_snapshots
                WHERE tenant_id = CAST(:tenant_id AS uuid) AND group_id = CAST(:group_id AS uuid)
                ORDER BY sampled_at DESC, id DESC
                LIMIT CAST(:limit AS integer)
                """,
                {"tenant_id": tid, "group_id": gid, "limit": sample_cap},
            )
            try:
                td_snaps = await self._td.query_rows(
                    f"SELECT `ts`, `body_text`, `error_count`, `data_epoch` "
                    f"FROM {fq} ORDER BY `ts` DESC LIMIT {sample_cap}"
                )
            except TDEngineError:
                td_snaps = []

            mod_mismatches: list[dict[str, Any]] = []
            if not counts_match:
                mm = {
                    "entity_type": "data_model",
                    "group_id": str(gid),
                    "reason": "ROW_COUNT_MISMATCH",
                    "pg_count": pg_cnt,
                    "td_count": td_cnt,
                }
                mod_mismatches.append(mm)
                mismatches.append(mm)

            td_snap_by_ts = {to_td_timestamp_us(_utc(r["ts"])): r for r in td_snaps if _utc(r.get("ts")) is not None}
            for ps in pg_snaps:
                exp_ts = _utc(ps["sampled_at"])
                assert exp_ts is not None
                matched_td = td_snap_by_ts.get(to_td_timestamp_us(exp_ts))
                if matched_td is None:
                    mm = {
                        "entity_type": "data_model",
                        "group_id": str(gid),
                        "sampled_at": iso_ms(exp_ts),
                        "reason": "MISSING_SNAPSHOT_IN_TDENGINE",
                    }
                    mod_mismatches.append(mm)
                    mismatches.append(mm)
                    continue
                if str(matched_td.get("body_text") or "") != str(ps.get("body_text") or ""):
                    mm = {
                        "entity_type": "data_model",
                        "group_id": str(gid),
                        "sampled_at": iso_ms(exp_ts),
                        "reason": "SNAPSHOT_BODY_MISMATCH",
                    }
                    mod_mismatches.append(mm)
                    mismatches.append(mm)

            model_reports.append(
                ModelParityReport(
                    group_id=gid,
                    pg_count=pg_cnt,
                    td_count=td_cnt,
                    counts_match=counts_match,
                    samples_checked=len(pg_snaps),
                    sample_mismatches=mod_mismatches,
                )
            )

        return MigrationParityResult(
            tenant_id=tid,
            parity_ok=len(mismatches) == 0,
            signals_checked=len(signal_reports),
            models_checked=len(model_reports),
            signal_reports=signal_reports,
            model_reports=model_reports,
            mismatches=mismatches,
        )
