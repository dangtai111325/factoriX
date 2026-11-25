"""Collector status (``/api/v1/edges``, the UI's collector health API), edge fleet and configuration releases. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from datetime import datetime
import json
from typing import Any

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect
from factorix.application.health import broker_depth
from factorix.application.health.health_service import collector_report_state
from factorix.application.live.freshness_service import FreshnessService
from factorix.modules.live_state import get_pipeline_evidence
from factorix.modules.collect import EdgeIn, EdgePatch, ReleaseIn
from factorix.domain.health import edge_config_state, effective_edge_health, heartbeat_fresh
from factorix.modules.common import fetch_all, fetch_one, iso_ms, parse_uuid, utcnow
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _commit_now, _ids, _settings, admin, db_session
from factorix.transport.background.appliance_enroll import _appliance_paths, _write_private

router = RouteTable()


@router.post("/api/v1/edges", status_code=201)
async def create_edge(body: EdgeIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.create_edge(session, tenant_id, actor, body, correlation_id(request))


def _runtime_info(queues: Any) -> dict[str, Any]:
    if isinstance(queues, str):
        try:
            queues = json.loads(queues)
        except ValueError:
            return {}
    info = queues.get("runtime") if isinstance(queues, dict) else None
    return info if isinstance(info, dict) else {}


def _normalize_edge(row: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """Edge view with the single server-side health rule (domain.health.effective_edge_health).

    ``health`` and ``effective_health`` are NOT_ENROLLED | OFFLINE | DEGRADED | ONLINE; a release
    being applied is ONLINE with ``config_state`` PENDING. ``health_raw`` keeps the stored value.
    """
    item = dict(row)
    item.pop("credential_hash", None)
    effective = effective_edge_health(item, now or utcnow())
    item["health_raw"] = item.get("health")
    item["health"] = effective
    item["effective_health"] = effective
    item["config_state"] = edge_config_state(item)
    item["last_heartbeat"] = iso_ms(item.get("last_heartbeat"))
    return item


@router.get("/api/v1/edges")
async def edges(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    cfg = _settings()
    if cfg.collector_mode == "acquisition":
        run_status = await fetch_all(
            session,
            """
            SELECT instance_id, role, health, software_version, config_revision,
                   spool_pending, fast_buffered, broker_ok, last_heartbeat, diagnostic, queues_json
            FROM collector_runtime_status
            WHERE role = 'acquisition'
            ORDER BY last_heartbeat DESC NULLS LAST
            """,
            {},
        )
        if run_status:
            items = []
            now = utcnow()
            pipeline = get_pipeline_evidence().pipeline_summary(now)
            lags = [int(v["delivery_lag_ms"]) for v in pipeline.values() if v.get("delivery_lag_ms") is not None]
            max_lag_ms = max(lags) if lags else None
            # R2-02: a delivery stall (source read normally, values late in the pipeline) degrades the
            # collector status honestly instead of "online" while every signal is DELAYED.
            delayed = FreshnessService(get_pipeline_evidence()).delayed_connections(now)
            delayed_note = (
                f"Data delayed {max(delayed.values()) // 1000} s: {len(delayed)} "
                f"{'connection is' if len(delayed) == 1 else 'connections are'} read normally, but values reach the appliance late."
                if delayed
                else None
            )
            for r in run_status:
                last_hb = r.get("last_heartbeat")
                # One liveness rule for every surface (domain.health.heartbeat_fresh, 15 s); was 30 s here.
                is_fresh = heartbeat_fresh(last_hb, now)
                raw = str(r.get("health") or "HEALTHY").upper()
                # R1-03: a collector that reports itself DEGRADED (jobs not running, broker down, ...)
                # is not shown as a green "online".
                report = collector_report_state(last_hb, _runtime_info(r.get("queues_json")), now)
                effective = (
                    "OFFLINE"
                    if not is_fresh
                    else ("DEGRADED" if raw == "DEGRADED" or delayed or report.state == "REPORT_LATE" else "ONLINE")
                )
                items.append({
                    "id": str(r["instance_id"]),
                    "name": "Data Collector (Acquisition Runtime)",
                    "site_id": None,
                    "enrollment_status": "ENROLLED",
                    "desired_revision": int(r.get("config_revision") or 1),
                    "active_revision": int(r.get("config_revision") or 1),
                    "last_heartbeat": iso_ms(last_hb),
                    "health": "ONLINE" if is_fresh else "OFFLINE",
                    "effective_health": effective,
                    "health_raw": str(r.get("health") or "HEALTHY"),
                    "diagnostic": (report.diagnostic() if is_fresh and report.state == "REPORT_LATE" else None)
                    or r.get("diagnostic")
                    or (delayed_note if is_fresh else None),
                    # P6: REPORTING | REPORT_LATE | NOT_REPORTING (additive; the UI shows "not reporting").
                    "report_state": report.state,
                    "delayed_connections": len(delayed),
                    # Age of the newest data Center received, worst connection (DELAYED vs fresh).
                    "delivery_lag_ms": max_lag_ms,
                    "software_version": str(r.get("software_version") or "1.0.0"),
                    "outbox_pending": int(r.get("spool_pending") or 0),
                    "queues": {},
                    "config_state": "IN_SYNC",
                    # CT-20 (additive): last RabbitMQ live/ingest queue depth + DLQ probed by the API health loop.
                    "broker": broker_depth.latest(),
                })
            return {"items": items}
    items = await fetch_all(session, "SELECT id, name, site_id, enrollment_status, desired_revision, active_revision, last_heartbeat, health, software_version, outbox_pending, queues_json FROM edge_nodes WHERE tenant_id = :tenant_id ORDER BY name", {"tenant_id": tenant_id})
    return {"items": [_normalize_edge(item) for item in items]}


@router.get("/api/v1/edges/{edge_id}")
async def edge_detail(edge_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    raw = await collect._owned_edge(session, tenant_id, parse_uuid(edge_id))
    return _normalize_edge(raw)


@router.get("/api/v1/edges/{edge_id}/health")
async def edge_health(edge_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    row = await fetch_one(
        session,
        """
        SELECT id, name, enrollment_status, desired_revision, active_revision, last_heartbeat, health, software_version, queues_json
        FROM edge_nodes
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"id": parse_uuid(edge_id), "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Edge not found.")
    norm = _normalize_edge(row)
    norm["queues"] = row.get("queues_json") or {}
    return norm


@router.patch("/api/v1/edges/{edge_id}")
async def patch_edge(edge_id: str, body: EdgePatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.patch_edge(session, tenant_id, actor, parse_uuid(edge_id), body, correlation_id(request))


@router.delete("/api/v1/edges/{edge_id}")
async def delete_edge(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.delete_edge(session, tenant_id, actor, parse_uuid(edge_id), correlation_id(request))


@router.post("/api/v1/edges/{edge_id}/enrollment-token", status_code=201)
async def enrollment(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.issue_enrollment(session, tenant_id, parse_uuid(edge_id), actor, correlation_id(request))


@router.post("/api/v1/edges/{edge_id}/appliance", status_code=201)
async def appliance_enrollment(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    cfg = _settings()
    if not cfg.appliance or not cfg.data_dir:
        raise AppError(404, "NOT_FOUND", "Appliance enrollment is not enabled.")
    tenant_id, actor = _ids(principal)
    issued = await collect.issue_enrollment(session, tenant_id, parse_uuid(edge_id), actor, correlation_id(request))
    await _commit_now(session)
    token_path, _credential_path = _appliance_paths()
    _write_private(token_path, str(issued["enrollment_token"]))
    return {"status": "queued"}


@router.get("/api/v1/edges/{edge_id}/deployments")
async def deployments(edge_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    await collect._owned_edge(session, tenant_id, parse_uuid(edge_id))
    items = await fetch_all(session, "SELECT id, revision, state, diagnostic_redacted, at FROM deployment_events WHERE edge_id = :id ORDER BY at DESC LIMIT 100", {"id": parse_uuid(edge_id)})
    return {"items": items}


@router.post("/api/v1/config-releases/publish", status_code=201)
async def publish_release(body: ReleaseIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.publish_release(session, tenant_id, actor, body, correlation_id(request))


@router.get("/api/v1/config-releases")
async def config_releases(edge_id: str | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    params: dict[str, Any] = {"tenant_id": tenant_id}
    where = "r.tenant_id = :tenant_id"
    if edge_id:
        where += " AND r.edge_id = :edge_id"
        params["edge_id"] = parse_uuid(edge_id)
    items = await fetch_all(
        session,
        f"""
        SELECT r.id, e.name AS edge_name, r.revision, r.published_at, r.status
        FROM configuration_releases r
        JOIN edge_nodes e ON e.id = r.edge_id
        WHERE {where}
        ORDER BY r.published_at DESC
        LIMIT 100
        """,
        params,
    )
    return {"items": items}
