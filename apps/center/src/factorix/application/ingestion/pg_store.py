"""Ingestion pipeline: asyncpg adapter (pool, quarantine, audit, heartbeat); composes the catalog and latest-state mixins. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import json
import os
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from factorix.domain.canonical import redact_provenance

from factorix.platform.db import to_asyncpg_dsn
from factorix.application.ingestion.common import _utcnow, logger
from factorix.application.ingestion.catalog import _CatalogStore
from factorix.application.ingestion.latest_state import _LatestStateStore


# CT-19: the real worker version (was the constant 's06-worker'). config_revision stays 1: ingestion has no
# configuration revision of its own (it follows the catalog per tenant); readers must not use it.
INGESTION_SOFTWARE_VERSION = os.environ.get("FACTORIX_INGESTION_VERSION", "ingestion-v1")


class PgIngestionStore(_CatalogStore, _LatestStateStore):
    """Direct asyncpg adapter for catalog lookup, fencing, latest state, formulas, liveness & quarantine."""

    def __init__(self, dsn: str, *, min_pool: int = 2, max_pool: int = 16) -> None:
        self._dsn = to_asyncpg_dsn(dsn)
        self._min_pool = max(1, int(min_pool))
        self._max_pool = max(self._min_pool, int(max_pool))
        self._pool: asyncpg.Pool | None = None
        # latest_signal_state.ingested_at (migration 0011) is written only once it exists, so a
        # worker deployed before the migration ran keeps working.
        self.has_ingested_at = False
        # latest_signal_state is a derived read model (rebuildable from TDengine history); its
        # commits do not need to wait for the WAL flush. FACTORIX_INGESTION_SYNC_COMMIT=on opts out.
        # Stream NOTIFY wire format (R2-E C6): "v2" = compact latest_ids (default; the API bridge reads the
        # committed rows, pushes them and refreshes its live cache), "v1" = full {"events":[...]} kill switch.
        self.notify_format = "v1" if os.environ.get("FACTORIX_NOTIFY_FORMAT", "v2").strip().lower() == "v1" else "v2"
        self.async_latest_commit = os.environ.get("FACTORIX_INGESTION_SYNC_COMMIT", "off").strip().lower() not in {
            "on",
            "true",
            "1",
            "yes",
        }

    @property
    def pool(self) -> asyncpg.Pool | None:
        return self._pool

    async def start(self) -> None:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(
                self._dsn,
                min_size=self._min_pool,
                max_size=self._max_pool,
                command_timeout=15.0,
            )
            try:
                async with self._pool.acquire() as conn:
                    self.has_ingested_at = bool(
                        await conn.fetchval(
                            "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                            "WHERE table_name = $1 AND column_name = $2)",
                            "latest_signal_state",
                            "ingested_at",
                        )
                    )
            except Exception as exc:  # noqa: BLE001 - optional column probe; keep the legacy write path
                logger.warning(
                    "Could not probe latest_signal_state.ingested_at (%s); ingested_at is not stored",
                    type(exc).__name__,
                )
                self.has_ingested_at = False

    async def close(self) -> None:
        pool = self._pool
        self._pool = None
        if pool is not None:
            await pool.close()

    @staticmethod
    def is_retryable_pg_error(exc: BaseException) -> bool:
        return isinstance(
            exc,
            (
                asyncpg.PostgresConnectionError,
                asyncpg.CannotConnectNowError,
                asyncpg.ConnectionDoesNotExistError,
                asyncpg.InterfaceError,
                asyncpg.TooManyConnectionsError,
                asyncpg.DeadlockDetectedError,
                asyncpg.SerializationError,
                OSError,
                TimeoutError,
            ),
        )

    async def write_quarantine(
        self,
        *,
        tenant_id: UUID,
        edge_id: UUID | None,
        event_uid: str,
        reason: str,
        payload: dict[str, Any],
    ) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO observation_quarantine (id, tenant_id, edge_id, event_uid, reason, received_time, payload_redacted)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                """,
                uuid4(),
                tenant_id,
                edge_id,
                (event_uid or "invalid")[:256],
                reason[:300],
                _utcnow(),
                json.dumps(redact_provenance(payload), default=str),
            )

    async def write_audit(
        self,
        *,
        tenant_id: UUID,
        event_type: str,
        entity_type: str,
        entity_id: UUID,
        after: dict[str, Any],
        before: dict[str, Any] | None = None,
        severity: str = "WARN",
        correlation_id: str = "ingestion",
    ) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO audit_events (
                    id, tenant_id, event_type, actor_id, entity_type, entity_id,
                    before_json, after_json, correlation_id, occurred_at, severity
                ) VALUES ($1, $2, $3, NULL, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
                """,
                uuid4(),
                tenant_id,
                event_type,
                entity_type,
                entity_id,
                json.dumps(before, default=str) if before is not None else None,
                json.dumps(after, default=str),
                correlation_id[:128],
                _utcnow(),
                severity,
            )

    async def write_heartbeat(
        self,
        *,
        instance_id: str,
        health: str,
        queues_json: dict[str, Any],
        broker_ok: bool,
        diagnostic: str | None = None,
    ) -> None:
        if self._pool is None:
            return
        now = _utcnow()
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO collector_runtime_status (
                    instance_id, role, health, software_version, config_revision,
                    spool_pending, fast_buffered, broker_ok, queues_json, diagnostic,
                    last_heartbeat, updated_at
                ) VALUES ($1, 'ingestion', $2, $7, 1, 0, 0, $3, $4::jsonb, $5, $6, $6)
                ON CONFLICT (instance_id) DO UPDATE SET
                    health = EXCLUDED.health,
                    software_version = EXCLUDED.software_version,
                    broker_ok = EXCLUDED.broker_ok,
                    queues_json = EXCLUDED.queues_json,
                    diagnostic = EXCLUDED.diagnostic,
                    last_heartbeat = EXCLUDED.last_heartbeat,
                    updated_at = EXCLUDED.updated_at
                """,
                instance_id,
                health,
                bool(broker_ok),
                json.dumps(queues_json, default=str),
                (diagnostic or "")[:500] or None,
                now,
                INGESTION_SOFTWARE_VERSION,
            )
