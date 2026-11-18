"""Background health loop: connection/edge health sweep, commissioning reaper, pruning, pipeline evidence. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import edge_sync, telemetry
from factorix.application.health.health_service import report_continuity, sweep_no_data
from factorix.application.live.freshness_service import FreshnessService
from factorix.modules.live_state import get_pipeline_evidence, refresh_live_message  # noqa: F401
from factorix.domain.health import (
    EDGE_OFFLINE_AFTER_S,
    HEARTBEAT_PERIOD_S,
    connection_no_data_due,
    edge_config_state,
    effective_edge_health,
    heartbeat_fresh,
    no_data_message,
    no_data_threshold_s,
)
from factorix.modules.common import (
    as_uuid,
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    iso_ms,
    queue_stream_event,
    utcnow,
)

from factorix.transport.http.deps import _opt_time, _run_step, _settings, hub, logger
from factorix.transport.background.appliance_enroll import _ensure_appliance_enrollment


HEALTH_LOOP_PERIOD_S = HEARTBEAT_PERIOD_S
PRUNE_EVERY_TICKS = 60  # every 5 minutes
COMMISSION_TIMEOUT_S = 30
PRUNE_BATCH = 5000
PRUNE_MAX_BATCHES = 20
DEDUP_KEEP = timedelta(hours=2)
QUARANTINE_KEEP = timedelta(days=30)
AUDIT_NOISE_KEEP = timedelta(days=30)
AUDIT_NOISE_TYPES = ["INGEST_REJECTED", "CONNECTION_DEGRADED", "CONNECTION_RECOVERED", "EDGE_OFFLINE", "EDGE_ONLINE"]


async def _evaluate_edges(session: AsyncSession) -> None:
    """Edge OFFLINE comes only from heartbeat age (> 3 heartbeat periods)."""
    cfg = _settings()
    if cfg.collector_mode == "acquisition":
        return
    now = utcnow()
    stale = await fetch_all(
        session,
        """
        SELECT id, tenant_id, name, health, enrollment_status, last_heartbeat, desired_revision, active_revision
        FROM edge_nodes
        WHERE enrollment_status = 'ENROLLED'
          AND health <> 'OFFLINE'
          AND (last_heartbeat IS NULL OR last_heartbeat < :cutoff)
        FOR UPDATE SKIP LOCKED
        """,
        {"cutoff": now - timedelta(seconds=EDGE_OFFLINE_AFTER_S)},
    )
    for edge in stale:
        await execute(session, "UPDATE edge_nodes SET health = 'OFFLINE' WHERE id = :id", {"id": edge["id"]})
        await audit(
            session,
            tenant_id=as_uuid(edge["tenant_id"]),
            event_type="EDGE_OFFLINE",
            actor_id=None,
            entity_type="edge",
            entity_id=as_uuid(edge["id"]),
            before={"health": edge["health"]},
            after={"health": "OFFLINE", "last_heartbeat": iso_ms(edge.get("last_heartbeat"))},
            correlation_id=f"health-{uuid4().hex[:8]}",
            severity="WARN",
        )
        edge["health"] = "OFFLINE"
        queue_stream_event(session, "health", edge["tenant_id"], edge_sync.edge_health_payload(edge, now))


async def _evaluate_connections(session: AsyncSession) -> None:
    """Center-side fallback: DEGRADED only when an online collector delivers no samples.

    A connection without active bindings is never degraded (its effective health is IDLE). The
    reference time is the latest of the last sample, the binding change, the connection change
    and the collector's last configuration activation, so new work is not degraded prematurely.
    """
    now = utcnow()
    acq_runtime: dict[str, Any] | None = None
    try:
        async with session.begin_nested():
            acq_runtime = await fetch_one(
                session,
                """
                SELECT health, last_heartbeat, queues_json
                FROM collector_runtime_status
                WHERE role = 'acquisition'
                ORDER BY last_heartbeat DESC
                LIMIT 1
                """,
                {},
            )
    except SQLAlchemyError:
        acq_runtime = None
    acq_info = _acquisition_runtime_info(acq_runtime)
    # Connections whose jobs acquisition runs are judged by acquisition's own windowed evidence
    # (single owner). This sweep only covers bound connections acquisition runs nothing for.
    running = set(acq_info.get("connections_running") or []) if isinstance(acq_info.get("connections_running"), list) else set()
    acq_since = [moment for moment in (_opt_time(acq_info.get("leader_since")), _opt_time(acq_info.get("started_at"))) if moment]
    # P6: missing evidence is not negative evidence. While the collector's own report is late (or Center did
    # not watch continuously), no connection it covers is inferred "No samples"; the window restarts.
    report = report_continuity().observe((acq_runtime or {}).get("last_heartbeat"), acq_info, now)

    rows = await fetch_all(
        session,
        """
        SELECT c.id, c.tenant_id, c.edge_id, c.health, c.last_error, c.last_success_at, c.created_at, c.updated_at,
               e.enrollment_status, e.health AS edge_health, e.last_heartbeat, e.desired_revision, e.active_revision,
               (SELECT max(d.at) FROM deployment_events d WHERE d.edge_id = e.id AND d.state = 'ACTIVE') AS activated_at,
               bnd.active_bindings, bnd.bindings_since,
               (SELECT min(j.interval_ms) FROM acquisition_jobs j WHERE j.connection_id = c.id AND j.enabled = TRUE) AS interval_ms
        FROM connections c
        LEFT JOIN edge_nodes e ON e.id = c.edge_id
        JOIN LATERAL (
            SELECT count(DISTINCT b.signal_id) AS active_bindings, max(b.valid_from) AS bindings_since
            FROM acquisition_jobs j
            JOIN source_fields f ON f.acquisition_job_id = j.id
            JOIN signal_bindings b ON b.source_field_id = f.id
            JOIN signal_definitions s ON s.id = b.signal_id
            WHERE j.connection_id = c.id AND j.enabled = TRUE AND b.enabled = TRUE AND b.valid_to IS NULL AND s.status = 'ACTIVE'
        ) bnd ON TRUE
        WHERE c.status = 'ACTIVE' AND c.health <> 'DEGRADED'
        ORDER BY c.id
        """,
        {},
    )
    for row in rows:
        if int(row.get("active_bindings") or 0) <= 0:
            continue
        if row.get("edge_id") is not None:
            edge = {
                "enrollment_status": row["enrollment_status"],
                "health": row["edge_health"],
                "last_heartbeat": row["last_heartbeat"],
                "desired_revision": row["desired_revision"],
                "active_revision": row["active_revision"],
            }
            if effective_edge_health(edge, now) != "ONLINE" or edge_config_state(edge) == "PENDING":
                continue
        else:
            if acq_runtime is None or not heartbeat_fresh(acq_runtime.get("last_heartbeat"), now):
                continue
            if str(acq_runtime.get("health") or "").upper() in {"OFFLINE", "DOWN"}:
                continue
            if not report.current:
                continue  # keep the last verdict; the collector status says "not reporting"
            if str(row["id"]) in running:
                continue
        since_candidates = [row.get(key) for key in ("bindings_since", "created_at", "updated_at", "activated_at") if row.get(key)]
        if row.get("edge_id") is None:
            # Acquisition (re)start / promotion: evidence from before it is not "no samples".
            since_candidates.extend(acq_since)
            if report.reporting_since is not None:
                since_candidates.append(report.reporting_since)
        since = max(since_candidates) if since_candidates else None
        if not connection_no_data_due(last_success_at=row.get("last_success_at"), since=since, interval_ms=row.get("interval_ms"), now=now):
            continue
        message = no_data_message(row.get("interval_ms"))
        cutoff = now - timedelta(seconds=no_data_threshold_s(row.get("interval_ms")))
        # HealthService (single writer, R2-E C2) re-checks the predicate atomically and audits/pushes.
        await sweep_no_data(session, row, message=message, cutoff=cutoff)

def _acquisition_runtime_info(acq_runtime: dict[str, Any] | None) -> dict[str, Any]:
    """``queues_json.runtime`` of the acquisition heartbeat (started_at, leader_since, connections_running)."""
    if not acq_runtime:
        return {}
    queues = acq_runtime.get("queues_json")
    if isinstance(queues, str):
        try:
            queues = json.loads(queues)
        except json.JSONDecodeError:
            return {}
    info = queues.get("runtime") if isinstance(queues, dict) else None
    return info if isinstance(info, dict) else {}


def commissioning_timeout(status: str, timeout_s: int) -> tuple[str, str]:
    """Reaper verdict. PENDING = no collector ever picked the command up (not running, or still not
    enrolled); RUNNING = the collector started it but never reported a result."""
    if status == "PENDING":
        return (
            "EDGE_NOT_STARTED",
            f"Collector did not start: no collector picked up this test within {timeout_s} seconds. "
            "Check that the collector is running and enrolled, then test again.",
        )
    return "TIMEOUT", f"The collector started the test but did not report a result within {timeout_s} seconds."


async def _reap_commissioning(session: AsyncSession) -> None:
    now = utcnow()
    stale_jobs = await fetch_all(
        session,
        """
        SELECT id, tenant_id, connection_id, status
        FROM commissioning_jobs
        WHERE status IN ('PENDING', 'RUNNING') AND started_at < :cutoff
        FOR UPDATE SKIP LOCKED
        """,
        {"cutoff": now - timedelta(seconds=COMMISSION_TIMEOUT_S)},
    )
    for job in stale_jobs:
        error_code, diagnostic = commissioning_timeout(job["status"], COMMISSION_TIMEOUT_S)
        await execute(
            session,
            """
            UPDATE commissioning_jobs
            SET status = 'FAILED', error_code = :error_code, diagnostic = :diagnostic, completed_at = :now
            WHERE id = :id
            """,
            {"id": job["id"], "now": now, "error_code": error_code, "diagnostic": diagnostic},
        )
        await audit(
            session,
            tenant_id=as_uuid(job["tenant_id"]),
            event_type="COMMISSION_FAILED",
            actor_id=None,
            entity_type="commissioning",
            entity_id=as_uuid(job["id"]),
            before={"status": job["status"]},
            after={"status": "FAILED", "error_code": error_code},
            correlation_id=f"reaper-{uuid4().hex[:8]}",
            severity="WARN",
        )


async def _delete_in_batches(session: AsyncSession, sql: str, params: dict[str, Any]) -> int:
    total = 0
    for _ in range(PRUNE_MAX_BATCHES):
        deleted = await execute_rowcount(session, sql, {**params, "batch": PRUNE_BATCH})
        await session.commit()
        total += deleted
        if deleted < PRUNE_BATCH:
            break
    return total


async def _prune(session: AsyncSession) -> None:
    """Bounded housekeeping: dedup keys > 7 days, quarantine > 30 days, health audit noise > 30 days,
    and observations past enabled retention policies."""
    now = utcnow()
    dedup = await _delete_in_batches(
        session,
        "DELETE FROM ingest_dedup WHERE ctid IN (SELECT ctid FROM ingest_dedup WHERE first_seen_at < :cutoff LIMIT :batch)",
        {"cutoff": now - DEDUP_KEEP},
    )
    quarantine = await _delete_in_batches(
        session,
        "DELETE FROM observation_quarantine WHERE id IN (SELECT id FROM observation_quarantine WHERE received_time < :cutoff LIMIT :batch)",
        {"cutoff": now - QUARANTINE_KEEP},
    )
    noise = await _delete_in_batches(
        session,
        "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE event_type = ANY(:types) AND occurred_at < :cutoff LIMIT :batch)",
        {"cutoff": now - AUDIT_NOISE_KEEP, "types": AUDIT_NOISE_TYPES},
    )
    observations = await telemetry.apply_retention_policies(session, now, batch=PRUNE_BATCH, max_batches=PRUNE_MAX_BATCHES)
    if dedup or quarantine or noise or observations:
        logger.info(
            "Pruned %d dedup keys, %d quarantined samples, %d health audit events, %d observations",
            dedup,
            quarantine,
            noise,
            observations,
        )


EVIDENCE_MAPPING_EVERY_TICKS = 6  # signal -> connection map every 30 s


async def _refresh_pipeline_evidence(session: AsyncSession, *, with_mapping: bool = False) -> None:
    """Source evidence for DELAYED vs STALE: acquisition's last successful read per connection and
    its heartbeat time, read straight from PostgreSQL (never through the broker)."""
    evidence = get_pipeline_evidence()
    if with_mapping or evidence.mapping_loaded_at is None:
        rows = await fetch_all(
            session,
            """
            SELECT b.signal_id, j.connection_id, s.expected_interval_ms, j.interval_ms
            FROM signal_bindings b
            JOIN source_fields f ON f.id = b.source_field_id
            JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
            JOIN signal_definitions s ON s.id = b.signal_id
            WHERE b.enabled = TRUE AND b.valid_to IS NULL
            """,
            {},
        )
        evidence.set_mapping(rows, now=utcnow())
    sources = await fetch_all(session, "SELECT id, last_success_at, health FROM connections WHERE status = 'ACTIVE'", {})
    beat = None
    try:
        async with session.begin_nested():
            beat_row = await fetch_one(
                session, "SELECT max(last_heartbeat) AS beat FROM collector_runtime_status WHERE role = 'acquisition'", {}
            )
            beat = (beat_row or {}).get("beat")
    except SQLAlchemyError:
        beat = None
    evidence.set_source(sources, beat)


def _wire_hub_freshness() -> None:
    """The API is the single evaluator of live freshness (v6_contracts.md Q2)."""
    evidence = get_pipeline_evidence()

    def _observe(event: dict[str, Any], message: dict[str, Any]) -> None:
        evidence.note_delivery(
            message.get("signal_id"),
            message.get("last_acquired_at") or message.get("received_time"),
            event.get("connection_id") or message.get("connection_id"),
        )

    service = FreshnessService(evidence)
    hub.observer = _observe
    hub.refresher = lambda message: service.refresh_message(message)
    hub.summary = evidence.pipeline_summary
    hub.connection_of = evidence.connection_of


async def _background_health_loop() -> None:
    tick = 0
    while True:
        try:
            await asyncio.sleep(HEALTH_LOOP_PERIOD_S)
        except asyncio.CancelledError:
            break
        tick += 1
        try:
            mapping = tick % EVIDENCE_MAPPING_EVERY_TICKS == 1
            await _run_step(
                "pipeline_evidence", lambda session, mapping=mapping: _refresh_pipeline_evidence(session, with_mapping=mapping)
            )
            await _run_step("edge_health", _evaluate_edges)
            await _run_step("connection_health", _evaluate_connections)
            await _run_step("commissioning_reaper", _reap_commissioning)
            cfg = _settings()
            if cfg.appliance and cfg.collector_mode != "acquisition":
                await _run_step("appliance_enrollment", _ensure_appliance_enrollment)
            if tick % PRUNE_EVERY_TICKS == 0:
                await _run_step("prune", _prune)
        except asyncio.CancelledError:
            break
