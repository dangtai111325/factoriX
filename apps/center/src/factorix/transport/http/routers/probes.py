"""Health probes ``/health/live`` and ``/health/ready``. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, Query
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.application.health import broker_depth
from factorix.domain.health import heartbeat_fresh
from factorix.modules.common import fetch_all, fetch_one, utcnow
from factorix.platform.errors import AppError

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _settings, db_session

router = RouteTable()


@router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "live"}


def _verbose_detail(rt_rows: list[dict[str, Any]], now: Any) -> dict[str, Any]:
    """``?verbose=1`` (CT-20, additive): heartbeat per process role + the last RabbitMQ depth/DLQ probe."""
    processes = [
        {
            "role": r.get("role"),
            "health": r.get("health"),
            "broker_ok": r.get("broker_ok"),
            "fresh": heartbeat_fresh(r.get("last_heartbeat"), now),
            "last_heartbeat": r["last_heartbeat"].isoformat().replace("+00:00", "Z")
            if hasattr(r.get("last_heartbeat"), "isoformat") else r.get("last_heartbeat"),
        }
        for r in rt_rows
    ]
    return {"processes": processes, "broker": broker_depth.latest(), "notify_bridge": _notify_bridge()}


def _notify_bridge() -> dict[str, Any]:
    """The API's PostgreSQL LISTEN bridge (live push): connected, reconnects, last error, age of the last event
    (ARCH-B B-04: ``notify_bridge_status`` had no caller)."""
    from factorix.transport.background.notify_bridge import notify_bridge_status

    st = notify_bridge_status()
    last = st.get("last_event_at")
    return {
        "connected": bool(st.get("connected")),
        "reconnects": int(st.get("reconnects") or 0),
        "last_error": st.get("last_error"),
        "last_event_age_s": round(max(0.0, time.monotonic() - float(last)), 1) if isinstance(last, (int, float)) else None,
    }


@router.get("/health/ready")
async def ready(
    session: AsyncSession = Depends(db_session), verbose: bool = Query(False)
) -> dict[str, Any]:
    await fetch_one(session, "SELECT 1 AS ok", {})
    cfg = _settings()
    verbose = verbose is True  # a direct call (no FastAPI) passes the Query() default object
    detail: dict[str, Any] | None = None
    if cfg.appliance:
        if cfg.collector_mode == "acquisition":
            now = utcnow()
            rt_rows: list[dict[str, Any]] = []
            try:
                async with session.begin_nested():
                    rt_rows = await fetch_all(
                        session,
                        "SELECT role, health, broker_ok, last_heartbeat FROM collector_runtime_status",
                        {},
                    )
            except SQLAlchemyError:
                rt_rows = []
            if verbose:
                detail = _verbose_detail(rt_rows, now)
            acq_ok = any(
                r.get("role") == "acquisition"
                and heartbeat_fresh(r.get("last_heartbeat"), now)
                and str(r.get("health") or "").upper() != "DOWN"
                for r in rt_rows
            )
            if not acq_ok:
                raise AppError(503, "ACQUISITION_DOWN", "The local acquisition worker is not healthy.", extra=detail)
            if cfg.tdengine_dsn:
                ing_ok = any(
                    r.get("role") == "ingestion"
                    and heartbeat_fresh(r.get("last_heartbeat"), now)
                    and str(r.get("health") or "").upper() != "DOWN"
                    for r in rt_rows
                )
                if not ing_ok:
                    raise AppError(503, "INGESTION_DOWN", "The ingestion worker is not healthy.", extra=detail)
        else:
            health_path = os.environ.get("FACTORIX_EDGE_HEALTH", "")
            if health_path:
                file = Path(health_path)
                if file.is_file():
                    try:
                        body = json.loads(file.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        body = {"ok": False}
                    age = time.time() - file.stat().st_mtime
                    if not body.get("ok") or age > 30:
                        raise AppError(503, "EDGE_DOWN", "The acquisition loop is not healthy.")
    if verbose:
        return {"status": "ready", **(detail or {"processes": [], "broker": broker_depth.latest()})}
    return {"status": "ready"}
