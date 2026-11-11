"""PostgreSQL direct commissioning claim/report and connection/runtime health reporter."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from factorix.domain.health import ConnectionUpdate, apply_connection_report, effective_connection_health
from factorix_acquisition.config_provider import _table_exists, json_val
from factorix_acquisition.timeutil import iso_ms

logger = logging.getLogger(__name__)


def _command_result(body: dict[str, Any]) -> dict[str, Any]:
    samples = body.get("samples")
    result: dict[str, Any] = dict(samples) if isinstance(samples, dict) else {"samples": samples or []}
    if body.get("browse") is not None:
        result["browse"] = body.get("browse")
    return result


class PgControlPlane:
    """Direct PostgreSQL handler for commissioning jobs, connection health, and worker heartbeats."""

    def __init__(self, pool: asyncpg.Pool | None, instance_id: str = "local-acquisition-1") -> None:
        self.pool = pool
        self.instance_id = instance_id
        self._has_runtime_table: bool | None = None
        self._has_edge_table: bool | None = None

    def set_pool(self, pool: asyncpg.Pool | None) -> None:
        self.pool = pool
        self._has_runtime_table = None
        self._has_edge_table = None

    async def claim_commissioning_jobs(self, *, limit: int = 4) -> list[dict[str, Any]]:
        if self.pool is None or limit <= 0:
            return []
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                WITH picked AS (
                    SELECT j.id
                    FROM commissioning_jobs j
                    WHERE j.status = 'PENDING'
                    ORDER BY j.started_at NULLS LAST, j.id
                    LIMIT $1
                    FOR NO KEY UPDATE OF j SKIP LOCKED
                )
                UPDATE commissioning_jobs j
                SET status = 'RUNNING', started_at = now()
                FROM picked, connections c
                WHERE j.id = picked.id AND c.id = j.connection_id
                RETURNING j.id, j.connection_id, j.stages_json, j.samples_json,
                          c.protocol, c.config_json, c.endpoint_redacted, c.secret_ref
                """,
                int(limit),
            )
        jobs: list[dict[str, Any]] = []
        for row in rows:
            samples_json = json_val(row["samples_json"]) or {}
            meta = samples_json.get("meta") if isinstance(samples_json, dict) else {}
            if not isinstance(meta, dict):
                meta = {}
            override = meta.get("config_override")
            config = override if isinstance(override, dict) and override else (json_val(row["config_json"]) or {})
            protocol = str(row["protocol"])
            jobs.append(
                {
                    "id": str(row["id"]),
                    "connection_id": str(row["connection_id"]),
                    "stages_json": json_val(row["stages_json"]) or [],
                    "protocol": protocol,
                    "config_json": config,
                    "endpoint_redacted": row["endpoint_redacted"],
                    "secret_ref": str(row["secret_ref"]) if row["secret_ref"] else None,
                    "command_type": meta.get("command_type") or "COMMISSION",
                    "mode": meta.get("mode") or "FULL",
                    "fields": meta.get("fields") or [],
                    "test_path": meta.get("test_path"),
                    "topic_filter": meta.get("topic_filter"),
                    "topics": meta.get("topics") or [],
                    "path": meta.get("path") or (meta.get("topic_filter") if protocol == "http" else None),
                    "seconds": meta.get("seconds"),
                    "max_messages": meta.get("max_messages"),
                    "browse_node": meta.get("browse_node"),
                }
            )
        return jobs

    async def finish_commissioning(self, job_id: str, body: dict[str, Any]) -> None:
        if self.pool is None:
            raise RuntimeError("PostgreSQL pool is not available to report commissioning result.")
        status = str(body.get("status") or "FAILED").upper()
        if status not in {"PASSED", "FAILED", "CANCELLED"}:
            status = "FAILED"
        stages_json = json.dumps(body.get("stages") or [], default=str)
        samples_json = json.dumps(_command_result(body), default=str)
        error_code = body.get("error_code")
        diagnostic = str(body.get("diagnostic") or "")[:1000]
        uid = UUID(str(job_id))
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE commissioning_jobs
                SET status = $1,
                    stages_json = $2::jsonb,
                    completed_at = now(),
                    error_code = $3,
                    diagnostic = $4,
                    samples_json = $5::jsonb
                WHERE id = $6
                """,
                status,
                stages_json,
                error_code,
                diagnostic,
                samples_json,
                uid,
            )

    async def flush_connection_reports(self, reports: dict[str, dict[str, Any]], *, now: datetime | None = None) -> int:
        if self.pool is None or not reports:
            return 0
        by_id: dict[UUID, dict[str, Any]] = {}
        for key, report in list(reports.items())[:500]:
            if not isinstance(report, dict):
                continue
            try:
                by_id[UUID(str(key))] = report
            except ValueError:
                continue
        if not by_id:
            return 0
        current_now = now or datetime.now(timezone.utc)
        ids = sorted(by_id.keys(), key=str)
        updated = 0
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                rows = await conn.fetch(
                    """
                    SELECT id, tenant_id, status, health, last_error, last_success_at
                    FROM connections
                    WHERE id = ANY($1::uuid[])
                    ORDER BY id
                    FOR NO KEY UPDATE
                    """,
                    ids,
                )
                if not rows:
                    return 0
                counts = await conn.fetch(
                    """
                    SELECT j.connection_id, count(DISTINCT b.signal_id) AS active_bindings
                    FROM acquisition_jobs j
                    JOIN source_fields f ON f.acquisition_job_id = j.id
                    JOIN signal_bindings b ON b.source_field_id = f.id
                    JOIN signal_definitions s ON s.id = b.signal_id
                    WHERE j.connection_id = ANY($1::uuid[]) AND b.enabled = TRUE AND b.valid_to IS NULL AND s.status = 'ACTIVE'
                    GROUP BY j.connection_id
                    """,
                    [r["id"] for r in rows],
                )
                bindings = {str(r["connection_id"]): int(r["active_bindings"] or 0) for r in counts}
                for row in rows:
                    cid = row["id"]
                    tenant_id = row["tenant_id"]
                    update: ConnectionUpdate | None = apply_connection_report(dict(row), by_id[cid], current_now)
                    if update is None:
                        continue
                    await conn.execute(
                        "UPDATE connections SET health = $1, last_error = $2, last_success_at = $3 WHERE id = $4",
                        update.health,
                        update.last_error,
                        update.last_success_at,
                        cid,
                    )
                    updated += 1
                    payload = {
                        "type": "health",
                        "entity": "connection",
                        "id": str(cid),
                        "health": update.health,
                        "effective_health": effective_connection_health(
                            status=str(row["status"] or "ACTIVE"),
                            health=update.health,
                            active_bindings=bindings.get(str(cid), 0),
                            edge_health="ONLINE",
                        ),
                        "last_error": update.last_error,
                        "last_success_at": iso_ms(update.last_success_at),
                    }
                    if update.health != row["health"]:
                        if update.health == "DEGRADED":
                            await conn.execute(
                                """
                                INSERT INTO audit_events (
                                    id, tenant_id, event_type, actor_id, entity_type, entity_id,
                                    before_json, after_json, correlation_id, occurred_at, severity
                                ) VALUES ($1, $2, 'CONNECTION_DEGRADED', NULL, 'connection', $3, $4::jsonb, $5::jsonb, 'acquisition', $6, 'WARNING')
                                """,
                                uuid4(),
                                tenant_id,
                                cid,
                                json.dumps({"health": row["health"]}),
                                json.dumps({"health": "DEGRADED", "last_error": update.last_error, "source": "acquisition"}),
                                current_now,
                            )
                        elif row["health"] == "DEGRADED":
                            await conn.execute(
                                """
                                INSERT INTO audit_events (
                                    id, tenant_id, event_type, actor_id, entity_type, entity_id,
                                    before_json, after_json, correlation_id, occurred_at, severity
                                ) VALUES ($1, $2, 'CONNECTION_RECOVERED', NULL, 'connection', $3, $4::jsonb, $5::jsonb, 'acquisition', $6, 'INFO')
                                """,
                                uuid4(),
                                tenant_id,
                                cid,
                                json.dumps({"health": "DEGRADED"}),
                                json.dumps({"health": update.health}),
                                current_now,
                            )
                    await conn.execute(
                        "SELECT pg_notify('factorix_health_changed', $1)",
                        json.dumps({"tenant_id": str(tenant_id), "event": payload}),
                    )
        return updated

    async def record_heartbeat(
        self,
        *,
        health: str,
        software_version: str,
        spool_pending: int,
        fast_buffered: int,
        queues: dict[str, Any],
        revision: int,
        broker_ok: bool,
        config_in_sync: bool = True,
        diagnostic: str | None = None,
        now: datetime | None = None,
    ) -> None:
        if self.pool is None:
            return
        current_now = now or datetime.now(timezone.utc)
        norm_health = health.upper() if health.upper() in {"HEALTHY", "DEGRADED", "ACTIVE"} else "DEGRADED"
        async with self.pool.acquire() as conn:
            if self._has_runtime_table is None:
                self._has_runtime_table = await _table_exists(conn, "public.collector_runtime_status")
            if self._has_runtime_table:
                await conn.execute(
                    """
                    INSERT INTO collector_runtime_status (
                        instance_id, role, health, software_version, config_revision,
                        spool_pending, fast_buffered, broker_ok, queues_json, diagnostic,
                        last_heartbeat, updated_at
                    ) VALUES ($1, 'acquisition', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $10)
                    ON CONFLICT (instance_id) DO UPDATE SET
                        health = EXCLUDED.health,
                        software_version = EXCLUDED.software_version,
                        config_revision = EXCLUDED.config_revision,
                        spool_pending = EXCLUDED.spool_pending,
                        fast_buffered = EXCLUDED.fast_buffered,
                        broker_ok = EXCLUDED.broker_ok,
                        queues_json = EXCLUDED.queues_json,
                        diagnostic = EXCLUDED.diagnostic,
                        last_heartbeat = EXCLUDED.last_heartbeat,
                        updated_at = EXCLUDED.updated_at
                    """,
                    self.instance_id,
                    norm_health,
                    software_version[:40],
                    int(revision),
                    max(0, int(spool_pending)),
                    max(0, int(fast_buffered)),
                    bool(broker_ok),
                    json.dumps(queues, default=str),
                    (diagnostic or "")[:500] or None,
                    current_now,
                )

            if self._has_edge_table is None:
                self._has_edge_table = await _table_exists(conn, "public.edge_nodes")
            if self._has_edge_table:
                # Transitional compatibility until S17 removes edge_nodes:
                # keep legacy /overview and /edges status ONLINE + IN_SYNC when Acquisition runs cleanly.
                await conn.execute(
                    """
                    UPDATE edge_nodes
                    SET last_heartbeat = $1,
                        health = CASE WHEN $2 = 'DEGRADED' THEN 'DEGRADED' ELSE 'CONFIG_VALIDATED' END,
                        software_version = $3,
                        outbox_pending = $4,
                        queues_json = $5::jsonb,
                        active_revision = CASE WHEN $6 > 0 AND $7 THEN GREATEST(active_revision, desired_revision) ELSE active_revision END,
                        enrollment_status = CASE WHEN enrollment_status = 'UNENROLLED' THEN 'ENROLLED' ELSE enrollment_status END
                    WHERE enrollment_status <> 'REVOKED'
                    """,
                    current_now,
                    norm_health,
                    software_version[:40],
                    max(0, int(spool_pending)),
                    json.dumps(queues, default=str),
                    int(revision),
                    bool(config_in_sync),
                )
