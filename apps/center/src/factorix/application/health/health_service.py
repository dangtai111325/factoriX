"""HealthService: the single writer of ``connections.health / last_error / last_success_at`` (R2-E C2).

Every other component *submits evidence*; only this module turns evidence into a health write, the
matching audit event and the health push. Evidence kinds (contract collector-report.md):

* ``apply_collector_reports``  acquisition's windowed per-connection report (Q5, the owner of the
  connections it runs jobs for; asyncpg, called by ``factorix_acquisition.pg_control``);
* ``apply_edge_reports``       legacy Edge heartbeat reports (``modules.edge_sync``, Edge mode);
* ``note_samples_pg`` / ``note_samples``  a decoded GOOD/UNCERTAIN sample proves the connection works
  (ingestion in Edge mode; legacy PG ingest path);
* ``sweep_no_data``            Center's "no samples for N s" inference for bound connections nobody
  reports (``transport.background.health_loop``);
* ``set_operator_state``       pause / resume / archive (``application.collector.connections``);
* ``activate_edge_drafts``     an Edge activated a release: its DRAFT connections become ACTIVE/UNKNOWN.

The windowed semantics of WS-Q are unchanged: the state rules stay in ``domain.health``
(``apply_connection_report``, ``connection_no_data_due``) and the sweep keeps its atomic
``last_success_at < cutoff`` predicate. ``tests/unit/test_health_single_writer.py`` asserts that no other
module contains an ``UPDATE connections`` that sets ``health``.

The asyncpg functions import nothing from the Center HTTP stack (acquisition imports this module).
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from factorix.domain.health import (
    HEARTBEAT_PERIOD_S,
    NO_DATA_PREFIX,
    ConnectionUpdate,
    apply_connection_report,
    effective_connection_health,
    heartbeat_fresh,
)
from factorix_core.contracts.notify import HealthChanged
from factorix_core.time import iso_ms

__all__ = [
    "OPERATOR_HEALTH",
    "REPORT_LATE_S",
    "CollectorReportState",
    "ReportContinuity",
    "collector_report_state",
    "report_continuity",
    "activate_edge_drafts",
    "apply_collector_reports",
    "apply_edge_reports",
    "health_payload",
    "note_samples",
    "note_samples_pg",
    "set_operator_state",
    "sweep_no_data",
]

# ============================================================================ collector report evidence (P6)
#
# Missing evidence is not negative evidence: when the acquisition cannot write its own report (VM / CPU
# freeze, PG hiccup) ``last_success_at`` stops advancing although the sources may be fine. Center must
# then keep every connection at its last verdict instead of inferring "No samples received" for all of
# them, and the collector status says "not reporting".

# The acquisition flushes its connection report every heartbeat (5 s); later than this = report late.
REPORT_LATE_S = 4 * HEARTBEAT_PERIOD_S
# Center's own sweep runs every heartbeat period; a longer gap means Center itself did not watch.
OBSERVATION_GAP_S = 3 * HEARTBEAT_PERIOD_S


def _utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class CollectorReportState:
    """Whether the acquisition's connection evidence is current.

    ``state``: ``REPORTING`` | ``REPORT_LATE`` (heartbeat alive, report write failing) | ``NOT_REPORTING``
    (no fresh heartbeat, or no leader running jobs). ``reporting_since``: since when the evidence has been
    continuously current (set by ``ReportContinuity``; ``None`` from the stateless check)."""

    state: str
    report_age_s: float | None = None
    reporting_since: datetime | None = None

    @property
    def current(self) -> bool:
        return self.state == "REPORTING"

    def diagnostic(self) -> str | None:
        if self.state == "REPORT_LATE":
            age = f" (last report {int(self.report_age_s)} s ago)" if self.report_age_s is not None else ""
            return f"Collector not reporting connection status{age}. Connection states are kept until it reports again."
        if self.state == "NOT_REPORTING":
            return "Collector not reporting. Connection states are kept until it reports again."
        return None


def collector_report_state(last_heartbeat: Any, runtime_info: Mapping[str, Any] | None, now: datetime) -> CollectorReportState:
    """Stateless check of the latest acquisition heartbeat (``queues_json.runtime``).

    * no fresh heartbeat (15 s rule)                        -> NOT_REPORTING;
    * not leader (``leader_since`` empty) on a build that
      reports it                                             -> NOT_REPORTING (a standby runs no jobs);
    * ``last_report_at`` older than ``REPORT_LATE_S``        -> REPORT_LATE (older builds without the key
      fall back to the heartbeat alone).
    """
    if not heartbeat_fresh(last_heartbeat, now):
        return CollectorReportState("NOT_REPORTING")
    info = runtime_info or {}
    if "leader_since" in info and not info.get("leader_since"):
        return CollectorReportState("NOT_REPORTING")
    if "last_report_at" in info:
        last_report = _utc(info.get("last_report_at"))
        if last_report is None:
            # Leader, but no report flushed since this process started: late once the start is old.
            started = _utc(info.get("leader_since")) or _utc(info.get("started_at"))
            if started is not None and (now - started).total_seconds() > REPORT_LATE_S:
                return CollectorReportState("REPORT_LATE", None)
            return CollectorReportState("REPORTING")
        age = (now - last_report).total_seconds()
        if age > REPORT_LATE_S:
            return CollectorReportState("REPORT_LATE", age)
        return CollectorReportState("REPORTING", max(0.0, age))
    return CollectorReportState("REPORTING")


class ReportContinuity:
    """Since when the acquisition evidence has been *continuously* current, as observed by the Center sweep.

    A late report, a missing heartbeat or a gap in Center's own observation (the API process was frozen
    too) restarts the window: a no-data verdict needs a full window of current evidence without samples."""

    def __init__(self) -> None:
        self.reporting_since: datetime | None = None
        self.last_observed: datetime | None = None

    def observe(self, last_heartbeat: Any, runtime_info: Mapping[str, Any] | None, now: datetime) -> CollectorReportState:
        state = collector_report_state(last_heartbeat, runtime_info, now)
        gap = self.last_observed is not None and (now - self.last_observed) > timedelta(seconds=OBSERVATION_GAP_S)
        self.last_observed = now
        if not state.current:
            self.reporting_since = None
            return state
        if self.reporting_since is None or gap:
            self.reporting_since = now
        return CollectorReportState(state.state, state.report_age_s, self.reporting_since)


_CONTINUITY = ReportContinuity()


def report_continuity() -> ReportContinuity:
    """The Center process's continuity tracker (used by the health sweep)."""
    return _CONTINUITY


# Health written when the operator changes the connection status (no evidence yet after a resume).
OPERATOR_HEALTH = {"PAUSED": "PAUSED", "ACTIVE": "UNKNOWN", "ARCHIVED": "UNKNOWN"}


def health_payload(
    *, connection_id: Any, health: str, effective_health: str, last_error: str | None, last_success_at: Any
) -> dict[str, Any]:
    """The ``{type:"health", entity:"connection", ...}`` event every health producer emits."""
    return {
        "type": "health",
        "entity": "connection",
        "id": str(connection_id),
        "health": health,
        "effective_health": effective_health,
        "last_error": last_error,
        "last_success_at": iso_ms(last_success_at),
    }


# ============================================================================ asyncpg (acquisition, ingestion)

_SQL_REPORT_PG = "UPDATE connections SET health = $1, last_error = $2, last_success_at = $3 WHERE id = $4"
_SQL_AUDIT_PG = {
    event_type: f"""
    INSERT INTO audit_events (
        id, tenant_id, event_type, actor_id, entity_type, entity_id,
        before_json, after_json, correlation_id, occurred_at, severity
    ) VALUES ($1, $2, '{event_type}', NULL, 'connection', $3, $4::jsonb, $5::jsonb, $6, $7, $8)
"""
    for event_type in ("CONNECTION_DEGRADED", "CONNECTION_RECOVERED")
}


async def _audit_pg(conn: Any, tenant_id: Any, event_type: str, connection_id: Any, before: dict[str, Any],
                    after: dict[str, Any], correlation_id: str, now: datetime, severity: str) -> None:
    await conn.execute(
        _SQL_AUDIT_PG[event_type], uuid4(), tenant_id, connection_id, json.dumps(before), json.dumps(after),
        correlation_id, now, severity,
    )


async def apply_collector_reports(
    conn: Any,
    rows: Sequence[Mapping[str, Any]],
    reports: Mapping[UUID, Mapping[str, Any]],
    bindings: Mapping[str, int],
    now: datetime,
) -> int:
    """Acquisition evidence (Q5). ``rows`` are the locked ``connections`` rows (id, tenant_id, status,
    health, last_error, last_success_at); writes health, audits DEGRADED / RECOVERED transitions and
    pushes only real changes on ``factorix_health_changed``. Returns the number of rows written."""
    updated = 0
    for row in rows:
        cid = row["id"]
        tenant_id = row["tenant_id"]
        update: ConnectionUpdate | None = apply_connection_report(dict(row), reports[cid], now)
        if update is None:
            continue
        await conn.execute(_SQL_REPORT_PG, update.health, update.last_error, update.last_success_at, cid)
        updated += 1
        payload = health_payload(
            connection_id=cid,
            health=update.health,
            effective_health=effective_connection_health(
                status=str(row["status"] or "ACTIVE"),
                health=update.health,
                active_bindings=bindings.get(str(cid), 0),
                edge_health="ONLINE",
            ),
            last_error=update.last_error,
            last_success_at=update.last_success_at,
        )
        if update.health != row["health"]:
            if update.health == "DEGRADED":
                await _audit_pg(conn, tenant_id, "CONNECTION_DEGRADED", cid, {"health": row["health"]},
                                {"health": "DEGRADED", "last_error": update.last_error, "source": "acquisition"},
                                "acquisition", now, "WARN")
            elif row["health"] == "DEGRADED":
                await _audit_pg(conn, tenant_id, "CONNECTION_RECOVERED", cid, {"health": "DEGRADED"},
                                {"health": update.health}, "acquisition", now, "INFO")
        # Push only real changes. last_success_at advances every heartbeat; the API reads it from
        # PostgreSQL itself (source evidence for DELAYED vs STALE), so notifying every connection every
        # 5 s was pure NOTIFY/WebSocket noise.
        if update.health != row["health"] or (update.last_error or None) != (row["last_error"] or None):
            await conn.execute(
                "SELECT pg_notify('factorix_health_changed', $1)",
                HealthChanged(str(tenant_id), payload).to_payload(),
            )
    return updated


_SQL_SAMPLES_PG = """
    WITH prev AS (
        SELECT c.id, c.health AS old_health, sample.observed_at
        FROM connections c
        JOIN unnest($1::uuid[], $2::timestamptz[]) AS sample(id, observed_at) ON sample.id = c.id
        WHERE c.tenant_id = $3::uuid AND c.status = 'ACTIVE'
          AND (c.last_success_at IS NULL OR c.last_success_at < sample.observed_at)
        ORDER BY c.id
        FOR UPDATE OF c
    )
    UPDATE connections c
    SET last_success_at = prev.observed_at,
        health = CASE
            WHEN c.health = 'UNKNOWN' THEN 'HEALTHY'
            WHEN c.health = 'DEGRADED' AND c.last_error LIKE $4 THEN 'HEALTHY'
            ELSE c.health
        END,
        last_error = CASE WHEN c.last_error LIKE $4 THEN NULL ELSE c.last_error END
    FROM prev
    WHERE c.id = prev.id
    RETURNING c.id, c.health, c.last_error, c.last_success_at, prev.old_health
"""


async def note_samples_pg(
    conn: Any, tenant_id: UUID, connection_sample_times: Mapping[UUID, datetime], now: datetime
) -> list[dict[str, Any]]:
    """Sample evidence from ingestion (Edge mode): ``last_success_at`` only moves forward; UNKNOWN or a
    Center-inferred "no data" degradation becomes HEALTHY; an error reported by the collector stays.
    Returns the health events to push (the caller emits them with its batch NOTIFY)."""
    if not connection_sample_times:
        return []
    ordered = sorted(connection_sample_times, key=str)
    rows = await conn.fetch(
        _SQL_SAMPLES_PG, ordered, [connection_sample_times[cid] for cid in ordered], tenant_id, f"{NO_DATA_PREFIX}%"
    )
    events: list[dict[str, Any]] = []
    for cr in rows:
        if cr["health"] == cr["old_health"]:
            continue
        if cr["old_health"] == "DEGRADED":
            await _audit_pg(conn, tenant_id, "CONNECTION_RECOVERED", cr["id"], {"health": cr["old_health"]},
                            {"health": cr["health"]}, "ingestion", now, "INFO")
        events.append({"kind": "health", "tenant_id": str(tenant_id), "payload": health_payload(
            connection_id=cr["id"],
            health=cr["health"],
            effective_health=effective_connection_health(status="ACTIVE", health=cr["health"], active_bindings=1, edge_health="ONLINE"),
            last_error=cr.get("last_error"),
            last_success_at=cr.get("last_success_at"),
        )})
    return events


# ============================================================================ SQLAlchemy (Center)


async def apply_edge_reports(
    session: Any,
    tenant_id: UUID,
    rows: Sequence[Mapping[str, Any]],
    reports: Mapping[UUID, Mapping[str, Any]],
    bindings: Mapping[str, int],
    now: datetime,
) -> None:
    """Legacy Edge heartbeat reports (same rules as the acquisition report)."""
    from factorix.modules.common import as_uuid, audit, execute, queue_stream_event

    for row in rows:
        conn_id = as_uuid(row["id"])
        update = apply_connection_report(dict(row), reports[conn_id], now)
        if update is None:
            continue
        await execute(
            session,
            "UPDATE connections SET health = :health, last_error = :last_error, last_success_at = :last_success_at WHERE id = :id",
            {"health": update.health, "last_error": update.last_error, "last_success_at": update.last_success_at, "id": conn_id},
        )
        payload = health_payload(
            connection_id=conn_id,
            health=update.health,
            effective_health=effective_connection_health(
                status="ACTIVE", health=update.health, active_bindings=bindings.get(str(conn_id), 0), edge_health="ONLINE"
            ),
            last_error=update.last_error,
            last_success_at=update.last_success_at,
        )
        if update.health == row["health"]:
            if update.last_error != row.get("last_error"):
                queue_stream_event(session, "health", tenant_id, payload)
            continue
        if update.health == "DEGRADED":
            await audit(session, tenant_id=tenant_id, event_type="CONNECTION_DEGRADED", actor_id=None,
                        entity_type="connection", entity_id=conn_id, before={"health": row["health"]},
                        after={"health": "DEGRADED", "last_error": update.last_error, "source": "edge"},
                        correlation_id="heartbeat")
        elif row["health"] == "DEGRADED":
            await audit(session, tenant_id=tenant_id, event_type="CONNECTION_RECOVERED", actor_id=None,
                        entity_type="connection", entity_id=conn_id, before={"health": "DEGRADED"},
                        after={"health": update.health}, correlation_id="heartbeat")
        queue_stream_event(session, "health", tenant_id, payload)


async def note_samples(session: Any, tenant_id: UUID, edge_id: UUID | None, connection_ids: Iterable[UUID], now: datetime) -> None:
    """Sample evidence from the legacy PG ingest path (Edge mode)."""
    from factorix.modules.common import as_uuid, audit, fetch_all, queue_stream_event

    rows = await fetch_all(
        session,
        """
        WITH prev AS (
            SELECT id, health AS old_health
            FROM connections
            WHERE id = ANY(:ids)
              AND tenant_id = :tenant_id
              AND (CAST(:edge_id AS uuid) IS NULL OR edge_id = CAST(:edge_id AS uuid))
              AND status = 'ACTIVE'
            ORDER BY id
            FOR UPDATE
        )
        UPDATE connections c
        SET last_success_at = GREATEST(COALESCE(c.last_success_at, :now), :now),
            health = CASE
                WHEN c.health = 'UNKNOWN' THEN 'HEALTHY'
                WHEN c.health = 'DEGRADED' AND c.last_error LIKE :no_data THEN 'HEALTHY'
                ELSE c.health
            END,
            last_error = CASE WHEN c.last_error LIKE :no_data THEN NULL ELSE c.last_error END
        FROM prev
        WHERE c.id = prev.id
        RETURNING c.id, c.health, c.last_error, c.last_success_at, prev.old_health
        """,
        {"ids": list(connection_ids), "tenant_id": tenant_id, "edge_id": edge_id, "now": now, "no_data": f"{NO_DATA_PREFIX}%"},
    )
    for row in rows:
        if row["health"] == row["old_health"]:
            continue
        if row["old_health"] == "DEGRADED":
            await audit(session, tenant_id=tenant_id, event_type="CONNECTION_RECOVERED", actor_id=None,
                        entity_type="connection", entity_id=as_uuid(row["id"]), before={"health": row["old_health"]},
                        after={"health": row["health"]}, correlation_id="ingest")
        queue_stream_event(session, "health", tenant_id, health_payload(
            connection_id=row["id"],
            health=row["health"],
            effective_health=effective_connection_health(status="ACTIVE", health=row["health"], active_bindings=1, edge_health="ONLINE"),
            last_error=row.get("last_error"),
            last_success_at=row.get("last_success_at"),
        ))


async def sweep_no_data(session: Any, row: Mapping[str, Any], *, message: str, cutoff: datetime) -> bool:
    """Center inference: a bound connection nobody reports produced no sample since ``cutoff``.

    The predicate is re-checked atomically: if acquisition advanced ``last_success_at`` after the
    caller's SELECT (data arrived), this UPDATE matches nothing (no read-then-update race). Returns True
    when the connection was degraded (audit + health push done here)."""
    from factorix.modules.common import as_uuid, audit, execute_rowcount, queue_stream_event

    changed = await execute_rowcount(
        session,
        """
        UPDATE connections SET health = 'DEGRADED', last_error = :error
        WHERE id = :id AND status = 'ACTIVE' AND health <> 'DEGRADED'
          AND (last_success_at IS NULL OR last_success_at < :cutoff)
        """,
        {"id": row["id"], "error": message, "cutoff": cutoff},
    )
    if not changed:
        return False
    await audit(
        session,
        tenant_id=as_uuid(row["tenant_id"]),
        event_type="CONNECTION_DEGRADED",
        actor_id=None,
        entity_type="connection",
        entity_id=as_uuid(row["id"]),
        before={"health": row["health"]},
        after={"health": "DEGRADED", "last_error": message, "source": "center"},
        correlation_id=f"health-{uuid4().hex[:8]}",
        severity="WARN",
    )
    queue_stream_event(
        session,
        "health",
        row["tenant_id"],
        health_payload(
            connection_id=row["id"], health="DEGRADED", effective_health="DEGRADED", last_error=message,
            last_success_at=row.get("last_success_at"),
        ),
    )
    return True


async def set_operator_state(session: Any, connection_id: UUID, status: str) -> None:
    """Health that follows an operator status change: PAUSED -> PAUSED; resume (ACTIVE) -> UNKNOWN with the
    error cleared (no evidence yet); ARCHIVED -> UNKNOWN. Same transaction as the status update."""
    from factorix.modules.common import execute

    health = OPERATOR_HEALTH[status]
    clear_error = ", last_error = NULL" if status == "ACTIVE" else ""
    await execute(session, f"UPDATE connections SET health = :health{clear_error} WHERE id = :id", {"health": health, "id": connection_id})


async def activate_edge_drafts(session: Any, edge_id: UUID, tenant_id: UUID, now: datetime) -> None:
    """An Edge activated a release: its DRAFT connections become ACTIVE with UNKNOWN health."""
    from factorix.modules.common import execute

    await execute(
        session,
        """
        UPDATE connections
        SET status = 'ACTIVE', health = 'UNKNOWN', updated_at = :now
        WHERE edge_id = :id AND tenant_id = :tenant_id AND status = 'DRAFT'
        """,
        {"now": now, "id": edge_id, "tenant_id": tenant_id},
    )

