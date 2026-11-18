"""Installation overview. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect, telemetry
from factorix.modules.live_state import extract_runtime_health
from factorix.domain.health import collector_status, data_collection_status, heartbeat_fresh
from factorix.modules.common import fetch_all, fetch_one, iso_ms, utcnow

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _ids, _settings, admin, db_session
from factorix.transport.http.routers.collector_status import _normalize_edge

router = RouteTable()


@router.get("/api/v1/overview")
async def overview(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    now = utcnow()
    resources_count = await fetch_one(session, "SELECT count(*) AS count FROM resources WHERE tenant_id = :tenant_id AND archived_at IS NULL", {"tenant_id": tenant_id})
    machines = await fetch_one(session, "SELECT count(*) AS count FROM resources r JOIN resource_types t ON t.id = r.type_id WHERE r.tenant_id = :tenant_id AND t.key = 'machine' AND r.archived_at IS NULL", {"tenant_id": tenant_id})
    edge_rows = await fetch_all(
        session,
        "SELECT id, name, health, enrollment_status, active_revision, desired_revision, last_heartbeat, outbox_pending FROM edge_nodes WHERE tenant_id = :tenant_id ORDER BY name",
        {"tenant_id": tenant_id},
    )
    edges = [_normalize_edge(edge, now) for edge in edge_rows]
    connection_items = await collect.list_connections(session, tenant_id, protocol=None, site_id=None, status=None)
    connection_states = [str(item["effective_health"]) for item in connection_items]
    health_counts: dict[str, int] = {}
    for state in connection_states:
        health_counts[state] = health_counts.get(state, 0) + 1
    online_edges = sum(1 for edge in edges if edge["effective_health"] == "ONLINE")
    edge_states = [edge["effective_health"] for edge in edges]
    overall_collector_status = collector_status(edge_states)
    runtime_rows: list[dict[str, Any]] = []
    try:
        async with session.begin_nested():
            runtime_rows = await fetch_all(
                session,
                """
                SELECT instance_id, role, health, broker_ok, queues_json, last_heartbeat
                FROM collector_runtime_status
                ORDER BY last_heartbeat DESC
                """,
                {},
            )
    except SQLAlchemyError:
        runtime_rows = []
    cfg = _settings()
    _col_on, ov_broker_ok, ov_storage_ok = extract_runtime_health(
        runtime_rows, now=now, tdengine_configured=bool(cfg.tdengine_dsn)
    )
    if cfg.collector_mode == "acquisition" or (not edges and runtime_rows):
        acq_rows = [row for row in runtime_rows if row.get("role") == "acquisition"]
        if acq_rows:
            acq_states: list[str] = []
            for row in acq_rows:
                health_raw = str(row.get("health") or "").upper()
                if not heartbeat_fresh(row.get("last_heartbeat"), now) or health_raw in {"OFFLINE", "DOWN"}:
                    acq_states.append("OFFLINE")
                elif health_raw == "DEGRADED" or not bool(row.get("broker_ok", True)):
                    acq_states.append("DEGRADED")
                else:
                    acq_states.append("ONLINE")
            computed = collector_status(acq_states)
            ing_rows = [row for row in runtime_rows if row.get("role") == "ingestion"]
            if computed == "ONLINE" and (ing_rows or cfg.tdengine_dsn):
                ing_healthy = any(
                    heartbeat_fresh(row.get("last_heartbeat"), now)
                    and str(row.get("health") or "").upper() not in {"OFFLINE", "DOWN"}
                    and bool(row.get("broker_ok", True))
                    for row in ing_rows
                )
                if not ing_healthy:
                    computed = "DEGRADED"
            overall_collector_status = computed
        elif cfg.collector_mode == "acquisition" and not edges:
            overall_collector_status = "OFFLINE" if connection_items else "NONE"
    storage = await telemetry.storage_overview(session, tenant_id)
    last_obs = await fetch_one(session, "SELECT max(received_time) AS last_at FROM latest_signal_state WHERE tenant_id = :tenant_id", {"tenant_id": tenant_id})
    recent_errors = [
        {"id": item["id"], "name": item["name"], "last_error": item["last_error"], "health": item["health"], "effective_health": item["effective_health"]}
        for item in connection_items
        if item.get("last_error") and item["effective_health"] in {"DEGRADED", "HEALTHY"}
    ][:8]

    return {
        "resources": int(resources_count["count"]) if resources_count else 0,
        "machines": int(machines["count"]) if machines else 0,
        "active_connections": sum(1 for item in connection_items if item.get("status") == "ACTIVE"),
        "connections_online": health_counts.get("HEALTHY", 0),
        "connections_idle": health_counts.get("IDLE", 0),
        "connections_degraded": health_counts.get("DEGRADED", 0),
        "connections_paused": health_counts.get("PAUSED", 0),
        # Connections expected to deliver data: idle (no signals) and paused ones never make the
        # overview "Attention needed" (R3-CN-03); data_collection_status applies the same rule.
        "connections_working": sum(count for state, count in health_counts.items() if state not in {"IDLE", "PAUSED", "ARCHIVED"}),
        "connections_total": len(connection_items),
        "healthy_edges": online_edges,
        "edges_online": online_edges,
        "edges_total": len(edges),
        "collector_status": overall_collector_status,
        "broker_health": "HEALTHY" if ov_broker_ok is True else ("DEGRADED" if ov_broker_ok is False else "UNKNOWN"),
        "storage_health": "HEALTHY" if ov_storage_ok is True else ("DEGRADED" if ov_storage_ok is False else "UNKNOWN"),
        "data_collection_status": data_collection_status(connection_states),
        "last_data_at": iso_ms(last_obs["last_at"]) if last_obs else None,
        "ingest_per_minute": storage["ingest_per_minute"],
        "messages_per_min": storage["ingest_per_minute"],
        "generated_at": iso_ms(now),
        "edges": edges,
        "connection_health": [{"health": state, "count": count} for state, count in sorted(health_counts.items())],
        "recent_errors": recent_errors,
    }
