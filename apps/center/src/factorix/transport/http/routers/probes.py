"""Health probes ``/health/live`` and ``/health/ready``. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import Depends
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.health import heartbeat_fresh
from factorix.modules.common import fetch_all, fetch_one, utcnow
from factorix.platform.errors import AppError

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _settings, db_session

router = RouteTable()


@router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "live"}


@router.get("/health/ready")
async def ready(session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    await fetch_one(session, "SELECT 1 AS ok", {})
    cfg = _settings()
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
            acq_ok = any(
                r.get("role") == "acquisition"
                and heartbeat_fresh(r.get("last_heartbeat"), now)
                and str(r.get("health") or "").upper() != "DOWN"
                for r in rt_rows
            )
            if not acq_ok:
                raise AppError(503, "ACQUISITION_DOWN", "The local acquisition worker is not healthy.")
            if cfg.tdengine_dsn:
                ing_ok = any(
                    r.get("role") == "ingestion"
                    and heartbeat_fresh(r.get("last_heartbeat"), now)
                    and str(r.get("health") or "").upper() != "DOWN"
                    for r in rt_rows
                )
                if not ing_ok:
                    raise AppError(503, "INGESTION_DOWN", "The ingestion worker is not healthy.")
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
    return {"status": "ready"}
