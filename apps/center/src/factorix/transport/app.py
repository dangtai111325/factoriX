"""FactoriX Center HTTP application."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect, edge_sync, identity, resources, telemetry
from factorix.modules import models_engine
from factorix.transport import data_models_api
from factorix.modules import usage
from factorix.modules.collect import (
    CaptureIn,
    ConnectionIn,
    ConnectionPatch,
    EdgeIn,
    EdgePatch,
    FormulaIn,
    MappingPreviewIn,
    PreviewIn,
    ReleaseIn,
    SignalBulkActionIn,
    SignalBulkIn,
    SignalPatch,
    TestIn,
)
from factorix.domain.health import (
    EDGE_OFFLINE_AFTER_S,
    HEARTBEAT_PERIOD_S,
    appliance_needs_enrollment,
    collector_status,
    connection_no_data_due,
    data_collection_status,
    edge_config_state,
    effective_edge_health,
    no_data_message,
)
from factorix.modules.common import as_uuid, audit, execute, execute_rowcount, fetch_all, fetch_one, iso_ms, parse_uuid, queue_stream_event, utcnow
from factorix.platform.after_commit import flush, listen
from factorix.transport.hub import Channel, Hub, origin_allowed
from factorix.modules.identity import (
    SESSION_COOKIE,
    BootstrapIn,
    ForgotIn,
    LoginIn,
    PasswordIn,
    ResetIn,
    assert_csrf,
    bootstrap_admin,
    clear_cookies,
    confirm_password_reset,
    login_admin,
    principal_from_token,
    request_password_reset,
    require_bootstrap_token,
    touch_me,
)
from factorix.modules.protocols import public_protocol
from factorix.platform.mail import SmtpMailer
from factorix.platform.security import hash_token
from factorix.modules.resources import (
    HierarchyIn,
    ImportIn,
    MoveIn,
    RelationIn,
    ResourceIn,
    ResourcePatch,
    SiteIn,
    TopicImportIn,
    TypeIn,
)
from factorix.modules.telemetry import DashboardIn, DashboardPatch, RetentionIn
from factorix.platform.db import get_engine, session_factory
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id, json_error
from factorix.platform.security import hash_password, verify_password
from factorix.platform.settings import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)


async def _flush_events(session: AsyncSession) -> None:
    try:
        await flush(session)
    except Exception:  # noqa: BLE001 - push delivery must never turn a committed request into an error
        logger.exception("After-commit event delivery failed")


async def db_session() -> AsyncIterator[AsyncSession]:
    factory = session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            session.info.pop("fx_events", None)
            raise
        else:
            await _flush_events(session)


async def _commit_now(session: AsyncSession) -> None:
    """Commit before the response is sent (FastAPI runs yield-dependency exit after the response).

    Used where the caller acts on the response: the edge marks outbox rows ACKED, so the rows must
    be durable first. After-commit events are delivered right after the commit.
    """
    await session.commit()
    await _flush_events(session)


async def admin(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    row = await principal_from_token(session, request.cookies.get(SESSION_COOKIE))
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        assert_csrf(request.headers.get("x-csrf-token"), row["csrf_hash"])
    return row


def _ids(row: dict[str, Any]) -> tuple[Any, Any]:
    return as_uuid(row["tenant_id"]), as_uuid(row["admin_id"])


hub = Hub()


async def _publish_committed(events: list[dict[str, Any]]) -> None:
    hub.dispatch(events)


listen(_publish_committed)

HEALTH_LOOP_PERIOD_S = HEARTBEAT_PERIOD_S
PRUNE_EVERY_TICKS = 60  # every 5 minutes
COMMISSION_TIMEOUT_S = 30
PRUNE_BATCH = 5000
PRUNE_MAX_BATCHES = 20
DEDUP_KEEP = timedelta(hours=2)
QUARANTINE_KEEP = timedelta(days=30)
AUDIT_NOISE_KEEP = timedelta(days=30)
AUDIT_NOISE_TYPES = ["INGEST_REJECTED", "CONNECTION_DEGRADED", "CONNECTION_RECOVERED", "EDGE_OFFLINE", "EDGE_ONLINE"]


async def _run_step(name: str, step: Any) -> None:
    """Run one background step in its own session; failures are logged and never stop the loop."""
    started = time.monotonic()
    try:
        async with session_factory()() as session:
            await step(session)
            await session.commit()
            await _flush_events(session)
        elapsed = time.monotonic() - started
        if elapsed > SLOW_REQUEST_S:
            logger.warning("Background step %s took %.2f s", name, elapsed)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - one failing step must not stop the others
        logger.exception("Background step %s failed", name)


async def _evaluate_edges(session: AsyncSession) -> None:
    """Edge OFFLINE comes only from heartbeat age (> 3 heartbeat periods)."""
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
    """Center-side fallback: DEGRADED only when an online, in-sync edge delivers no samples.

    A connection without active bindings is never degraded (its effective health is IDLE). The
    reference time is the latest of the last sample, the binding change, the connection change
    and the edge's last configuration activation, so new work is not degraded prematurely.
    """
    now = utcnow()
    rows = await fetch_all(
        session,
        """
        SELECT c.id, c.tenant_id, c.health, c.last_error, c.last_success_at, c.created_at, c.updated_at,
               e.enrollment_status, e.health AS edge_health, e.last_heartbeat, e.desired_revision, e.active_revision,
               (SELECT max(d.at) FROM deployment_events d WHERE d.edge_id = e.id AND d.state = 'ACTIVE') AS activated_at,
               bnd.active_bindings, bnd.bindings_since,
               (SELECT min(j.interval_ms) FROM acquisition_jobs j WHERE j.connection_id = c.id AND j.enabled = TRUE) AS interval_ms
        FROM connections c
        JOIN edge_nodes e ON e.id = c.edge_id
        JOIN LATERAL (
            SELECT count(DISTINCT b.signal_id) AS active_bindings, max(b.valid_from) AS bindings_since
            FROM acquisition_jobs j
            JOIN source_fields f ON f.acquisition_job_id = j.id
            JOIN signal_bindings b ON b.source_field_id = f.id
            JOIN signal_definitions s ON s.id = b.signal_id
            WHERE j.connection_id = c.id AND b.enabled = TRUE AND b.valid_to IS NULL AND s.status = 'ACTIVE'
        ) bnd ON TRUE
        WHERE c.status = 'ACTIVE' AND c.health <> 'DEGRADED'
        ORDER BY c.id
        """,
        {},
    )
    for row in rows:
        if int(row.get("active_bindings") or 0) <= 0:
            continue
        edge = {
            "enrollment_status": row["enrollment_status"],
            "health": row["edge_health"],
            "last_heartbeat": row["last_heartbeat"],
            "desired_revision": row["desired_revision"],
            "active_revision": row["active_revision"],
        }
        if effective_edge_health(edge, now) != "ONLINE" or edge_config_state(edge) == "PENDING":
            continue
        since_candidates = [row.get(key) for key in ("bindings_since", "created_at", "updated_at", "activated_at") if row.get(key)]
        since = max(since_candidates) if since_candidates else None
        if not connection_no_data_due(last_success_at=row.get("last_success_at"), since=since, interval_ms=row.get("interval_ms"), now=now):
            continue
        message = no_data_message(row.get("interval_ms"))
        changed = await execute_rowcount(
            session,
            "UPDATE connections SET health = 'DEGRADED', last_error = :error WHERE id = :id AND status = 'ACTIVE' AND health <> 'DEGRADED'",
            {"id": row["id"], "error": message},
        )
        if not changed:
            continue
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
            telemetry.connection_health_payload(
                connection_id=row["id"],
                health="DEGRADED",
                effective_health="DEGRADED",
                last_error=message,
                last_success_at=row.get("last_success_at"),
            ),
        )


def commissioning_timeout(status: str, timeout_s: int) -> tuple[str, str]:
    """Reaper verdict. PENDING = no collector ever picked the command up (not running, or still not
    enrolled); RUNNING = the collector started it but never reported a result."""
    if status == "PENDING":
        return (
            "EDGE_NOT_STARTED",
            f"Collector did not start: no Edge collector picked up this test within {timeout_s} seconds. "
            "Check that the collector is running and enrolled, then test again.",
        )
    return "TIMEOUT", f"The Edge collector started the test but did not report a result within {timeout_s} seconds."


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


def _appliance_paths() -> tuple[Path, Path]:
    data_dir = Path(settings.data_dir)
    token_path = Path(os.environ.get("FACTORIX_ENROLLMENT_FILE") or (data_dir / "enrollment"))
    credential_path = Path(os.environ.get("FACTORIX_CREDENTIAL_PATH") or (data_dir / "edge-credential"))
    return token_path, credential_path


def _file_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip() if path.is_file() else ""
    except OSError:
        logger.warning("Cannot read %s", path, exc_info=True)
        return ""


def _write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid4().hex[:8]}.tmp")
    temp.write_text(content, encoding="utf-8")
    try:
        temp.chmod(0o600)
    except OSError:
        logger.debug("chmod not supported for %s", temp)
    os.replace(temp, path)


async def _ensure_appliance_enrollment(session: AsyncSession) -> None:
    """Appliance mode: keep an unused enrollment token in the shared data directory while the local
    edge is not genuinely enrolled (for example right after Revert-To-Zero, or after the edge
    discarded a credential that Center rejected)."""
    if not settings.appliance or not settings.data_dir:
        return
    edge = await fetch_one(
        session,
        """
        SELECT id, tenant_id, enrollment_status, credential_hash IS NOT NULL AS has_credential, last_heartbeat
        FROM edge_nodes WHERE enrollment_status <> 'REVOKED'
        ORDER BY created_at ASC LIMIT 1
        """,
        {},
    )
    if edge is None:
        return
    token_path, credential_path = _appliance_paths()
    token = _file_text(token_path)
    token_state = "MISSING"
    if token:
        valid = await fetch_one(
            session,
            """
            SELECT 1 AS ok FROM edge_enrollment_tokens
            WHERE token_hash = :hash AND edge_id = :edge_id AND used_at IS NULL AND expires_at > :soon
            """,
            {"hash": hash_token(token), "edge_id": edge["id"], "soon": utcnow() + timedelta(seconds=60)},
        )
        token_state = "VALID" if valid else "INVALID"
    if not appliance_needs_enrollment(
        edge=edge,
        credential_file_present=bool(_file_text(credential_path)),
        token_file_state=token_state,
        now=utcnow(),
    ):
        return
    tenant_id = as_uuid(edge["tenant_id"])
    admin_row = await fetch_one(session, "SELECT id FROM admin_accounts WHERE tenant_id = :tenant_id ORDER BY created_at ASC LIMIT 1", {"tenant_id": tenant_id})
    actor = as_uuid(admin_row["id"]) if admin_row else None
    issued = await collect.issue_enrollment(session, tenant_id, as_uuid(edge["id"]), actor, "appliance-enrollment")  # type: ignore[arg-type]
    await session.commit()  # the token must exist before the edge can read the file
    _write_private(token_path, str(issued["enrollment_token"]))
    logger.info("Wrote a new enrollment token for the local edge %s (previous token file: %s)", edge["id"], token_state)


async def _ensure_initial_release(session: AsyncSession) -> None:
    """Appliance boot: an edge with active connections but no published release gets one."""
    if not settings.appliance:
        return
    edge = await fetch_one(session, "SELECT id, tenant_id FROM edge_nodes WHERE enrollment_status <> 'REVOKED' ORDER BY created_at ASC LIMIT 1", {})
    if edge is None:
        return
    edge_id = as_uuid(edge["id"])
    tenant_id = as_uuid(edge["tenant_id"])
    active_conns = await fetch_one(session, "SELECT count(*) AS cnt FROM connections WHERE edge_id = :edge_id AND status = 'ACTIVE'", {"edge_id": edge_id})
    has_release = await fetch_one(session, "SELECT count(*) AS cnt FROM configuration_releases WHERE edge_id = :edge_id AND status = 'PUBLISHED'", {"edge_id": edge_id})
    if int((active_conns or {}).get("cnt") or 0) > 0 and int((has_release or {}).get("cnt") or 0) == 0:
        admin_row = await fetch_one(session, "SELECT id FROM admin_accounts WHERE tenant_id = :tenant_id ORDER BY created_at ASC LIMIT 1", {"tenant_id": tenant_id})
        actor = as_uuid(admin_row["id"]) if admin_row else None
        await collect.publish_release(session, tenant_id, actor, collect.ReleaseIn(edge_id=str(edge_id)), "appliance-boot-release")  # type: ignore[arg-type]


async def _appliance_auto_enroll() -> None:
    if not settings.appliance or not settings.data_dir:
        return
    await _run_step("appliance_initial_release", _ensure_initial_release)
    await _run_step("appliance_enrollment", _ensure_appliance_enrollment)


async def _background_health_loop() -> None:
    tick = 0
    while True:
        try:
            await asyncio.sleep(HEALTH_LOOP_PERIOD_S)
        except asyncio.CancelledError:
            break
        tick += 1
        try:
            await _run_step("edge_health", _evaluate_edges)
            await _run_step("connection_health", _evaluate_connections)
            await _run_step("commissioning_reaper", _reap_commissioning)
            if settings.appliance:
                await _run_step("appliance_enrollment", _ensure_appliance_enrollment)
            if tick % PRUNE_EVERY_TICKS == 0:
                await _run_step("prune", _prune)
        except asyncio.CancelledError:
            break


async def _stop(task: asyncio.Task[Any]) -> None:
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:  # noqa: BLE001 - shutdown must continue; the error is logged
        logger.exception("Background task %s failed during shutdown", task.get_name())


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    task = asyncio.create_task(_background_health_loop(), name="health-loop")
    enroll_task = asyncio.create_task(_appliance_auto_enroll(), name="appliance-enroll")
    # Data Model v2: one sampling scheduler, the only writer of model_state / model_snapshots.
    models_engine.ENGINE.start()
    app.state.background_tasks = (task, enroll_task)
    try:
        yield
    finally:
        await _stop(enroll_task)
        await models_engine.ENGINE.stop()
        await _stop(task)


app = FastAPI(title="FactoriX IIoT Center", version="1.0.0", openapi_url="/api/openapi.json", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["content-type", "x-csrf-token", "x-bootstrap-token"],
)


SLOW_REQUEST_S = 1.0


@app.middleware("http")
async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
    request.state.correlation_id = request.headers.get("x-correlation-id") or uuid.uuid4().hex
    started = time.monotonic()
    response = await call_next(request)
    elapsed = time.monotonic() - started
    if elapsed > SLOW_REQUEST_S:
        # Responsiveness evidence (R3 P1): edge sync calls share this single event loop with the UI.
        logger.warning("Slow request %s %s: %.2f s (status %s)", request.method, request.url.path, elapsed, response.status_code)
    response.headers["X-Correlation-Id"] = request.state.correlation_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'"
    return response


@app.exception_handler(AppError)
async def app_error(request: Request, exc: AppError) -> JSONResponse:
    headers = {}
    if exc.extra.get("retry_after_seconds"):
        headers["Retry-After"] = str(exc.extra["retry_after_seconds"])
    return json_error(
        exc.status,
        exc.code,
        exc.message,
        correlation_id=correlation_id(request),
        field_errors=exc.field_errors,
        retryable=exc.retryable,
        headers=headers,
        extra={key: value for key, value in exc.extra.items() if key != "secret"},
    )


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "live"}


@app.get("/health/ready")
async def ready(session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    await fetch_one(session, "SELECT 1 AS ok", {})
    health_path = os.environ.get("FACTORIX_EDGE_HEALTH", "")
    if settings.appliance and health_path:
        file = Path(health_path)
        if file.is_file():
            import json
            import time

            try:
                body = json.loads(file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                body = {"ok": False}
            age = time.time() - file.stat().st_mtime
            if not body.get("ok") or age > 30:
                raise AppError(503, "EDGE_DOWN", "The acquisition loop is not healthy.")
    return {"status": "ready"}


@app.post("/api/v1/auth/bootstrap", status_code=201)
async def bootstrap(request: Request, body: BootstrapIn, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    require_bootstrap_token(settings, request.headers.get("x-bootstrap-token"))
    return await bootstrap_admin(session, body, actor_ip_note="")


@app.post("/api/v1/auth/login")
async def login(body: LoginIn, response: Response, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    tokens = await login_admin(session, settings, body)
    identity._cookies(response, settings, tokens["session_token"], tokens["csrf_token"])
    return {"status": "authenticated"}


@app.post("/api/v1/auth/forgot")
async def forgot(body: ForgotIn, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    mailer = getattr(app.state, "mailer", None) or SmtpMailer(settings)
    return await request_password_reset(session, body, mailer)


@app.post("/api/v1/auth/reset")
async def reset_password(body: ResetIn, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    return await confirm_password_reset(session, body)


class ResetLinkIn(BaseModel):
    token: str
    new_password: str


@app.post("/api/v1/auth/reset-password")
async def reset_password_link(body: ResetLinkIn, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    row = await fetch_one(
        session,
        """
        SELECT a.email
        FROM password_reset_codes c
        JOIN admin_accounts a ON a.id = c.admin_id
        WHERE c.code_hash = :code_hash AND c.consumed_at IS NULL
        ORDER BY c.created_at DESC
        LIMIT 1
        """,
        {"code_hash": hash_token(body.token.strip())},
    )
    if row is None or not row.get("email"):
        raise AppError(401, "INVALID_CODE", "Code is incorrect or has expired.")
    return await confirm_password_reset(session, ResetIn(email=str(row["email"]), code=body.token.strip(), new_password=body.new_password))


@app.post("/api/v1/auth/logout")
async def logout(response: Response, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    await identity.execute_logout(session, as_uuid(principal["session_id"]))
    clear_cookies(response, settings)
    return {"status": "signed_out"}


class RevertIn(BaseModel):
    confirm: str


@app.post("/api/v1/admin/revert-to-zero")
async def revert_zero(body: RevertIn, response: Response, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    del principal
    if body.confirm != "REVERT":
        raise AppError(422, "CONFIRM", "Type REVERT exactly to wipe this installation.")
    await identity.revert_to_zero(session)
    await _commit_now(session)
    if settings.data_dir:
        root = Path(settings.data_dir)
        for name in (
            "enrollment",
            "edge-credential",
            "outbox.sqlite",
            "outbox.sqlite-wal",
            "outbox.sqlite-shm",
            "active-config.json",
            "edge-health.json",
        ):
            target = root / name
            try:
                if target.is_file():
                    target.unlink()
            except OSError:
                logger.warning("Revert-To-Zero could not remove %s", target, exc_info=True)
    # The running edge now gets 401, discards its credential and waits for a token file. A token
    # is written as soon as an edge exists again (first connection) by the appliance enrollment
    # step, which also runs here for completeness.
    await _run_step("appliance_enrollment", _ensure_appliance_enrollment)
    clear_cookies(response, settings)
    return {"status": "empty"}


@app.get("/api/v1/auth/status")
async def auth_status(session: AsyncSession = Depends(db_session)) -> dict[str, bool]:
    existing = await fetch_one(session, "SELECT id FROM admin_accounts WHERE disabled_at IS NULL LIMIT 1", {})
    open_first_run = settings.environment == "development" and not settings.bootstrap_token
    return {
        "admin_exists": existing is not None,
        "bootstrap_enabled": bool(settings.bootstrap_token) or open_first_run,
        "setup_code_required": bool(settings.bootstrap_token),
        "appliance": settings.appliance,
    }


@app.get("/api/v1/auth/me")
async def me(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    return await identity.touch_me(principal)


@app.post("/api/v1/auth/password")
async def change_password(body: PasswordIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    from factorix.domain.passwords import validate_password

    account = await fetch_one(session, "SELECT password_hash, login FROM admin_accounts WHERE id = :id", {"id": as_uuid(principal["admin_id"])})
    if account is None or not verify_password(account["password_hash"], body.current_password):
        raise AppError(401, "INVALID_CREDENTIALS", "Current password is incorrect.")
    validate_password(body.new_password, account["login"])
    from factorix.modules.common import execute

    await execute(session, "UPDATE admin_accounts SET password_hash = :password_hash WHERE id = :id", {"password_hash": hash_password(body.new_password), "id": as_uuid(principal["admin_id"])})
    return {"status": "updated"}


class _Sites:
    pass


@app.get("/api/v1/sites")
async def sites(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await resources.list_sites(session, tenant_id)}


@app.post("/api/v1/sites", status_code=201)
async def create_site(body: SiteIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_site(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/sites/{site_id}")
async def site_detail(site_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.get_site(session, tenant_id, parse_uuid(site_id))


@app.get("/api/v1/resource-types")
async def resource_types(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await resources.list_types(session, tenant_id)}


@app.post("/api/v1/resource-types", status_code=201)
async def create_type(body: TypeIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_type(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/resources")
async def list_resources(
    parent_id: str | None = None,
    type_key: str | None = None,
    q: str | None = None,
    include_archived: bool = False,
    limit: int = 100,
    cursor: str | None = None,
    view: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.list_resources(session, tenant_id, parent_id=parent_id, type_key=type_key, query=q, include_archived=include_archived, limit=limit, cursor=cursor, view=view)


@app.post("/api/v1/resources", status_code=201)
async def create_resource(body: ResourceIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_resource(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/resources/{resource_id}")
async def resource_detail(resource_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.get_resource(session, tenant_id, parse_uuid(resource_id))


@app.patch("/api/v1/resources/{resource_id}")
async def patch_resource(resource_id: str, body: ResourcePatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.patch_resource(session, tenant_id, actor, parse_uuid(resource_id), body, correlation_id(request))


@app.get("/api/v1/resources/{resource_id}/archive-impact")
async def resource_archive_impact(resource_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await resources.archive_impact(session, tenant_id, parse_uuid(resource_id))


@app.post("/api/v1/resources/{resource_id}/archive")
async def archive_resource(resource_id: str, request: Request, body: resources.ArchiveIn | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.archive_resource(
        session, tenant_id, actor, parse_uuid(resource_id), correlation_id(request), archive_models=bool(body and body.archive_models)
    )


@app.post("/api/v1/resources/{resource_id}/restore")
async def restore_resource(resource_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.restore_resource(session, tenant_id, actor, parse_uuid(resource_id), correlation_id(request))


@app.post("/api/v1/resources/{resource_id}/move")
async def move_resource(resource_id: str, body: MoveIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.move_resource(session, tenant_id, actor, parse_uuid(resource_id), body, correlation_id(request))


@app.post("/api/v1/resources/import")
async def import_resources(body: ImportIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.import_resources(session, tenant_id, actor, body, correlation_id(request))


@app.post("/api/v1/resources/import/from-topics")
async def import_resources_from_topics(body: TopicImportIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.import_from_topics(session, tenant_id, actor, body, correlation_id(request))


@app.post("/api/v1/resource-relations", status_code=201)
async def create_relation(body: RelationIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    from factorix.modules.resources import _aware, _link, _resource

    source = await _resource(session, tenant_id, parse_uuid(body.from_id))
    target = await _resource(session, tenant_id, parse_uuid(body.to_id))
    if body.relation_code == "CONTAINS":
        await resources._assert_contains(session, tenant_id, source["type_key"], target["type_key"], source, "CONTAINS")
    await _link(session, tenant_id, as_uuid(source["id"]), as_uuid(target["id"]), body.relation_code, _aware(body.valid_from))
    return {"status": "created", "from_id": source["id"], "to_id": target["id"], "relation_code": body.relation_code}


@app.get("/api/v1/hierarchy-presets")
async def presets(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return resources.hierarchy_presets()


@app.post("/api/v1/hierarchy-views", status_code=201)
async def create_hierarchy(body: HierarchyIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_hierarchy(session, tenant_id, actor, body, correlation_id(request))


@app.post("/api/v1/hierarchy-views/{view_id}/validate")
async def validate_hierarchy(view_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    row = await fetch_one(session, "SELECT level_rules_json FROM hierarchy_views WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(view_id), "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Hierarchy template not found.")
    errors = resources.validate_levels(row["level_rules_json"] or [])
    return {"valid": not errors, "errors": errors}


@app.get("/api/v1/graph/neighbors")
@app.get("/api/v1/resources/neighbors")
async def graph(
    resource_id: str,
    depth: int = 1,
    relation_types: str = "",
    include_data: bool = False,
    as_of: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    moment = datetime.fromisoformat(as_of.replace("Z", "+00:00")) if as_of else None
    codes = [item for item in relation_types.split(",") if item]
    return await resources.neighbors(
        session,
        tenant_id,
        parse_uuid(resource_id),
        depth=depth,
        relation_codes=codes,
        as_of=moment,
        include_data=include_data,
    )


@app.get("/api/v1/connector-types")
async def connector_types(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return {"items": [{"protocol": key, "capabilities": value} for key, value in collect.CAPABILITIES.items()]}


@app.get("/api/v1/connector-types/{protocol}/schema")
async def connector_schema(protocol: str, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    if protocol not in collect.CAPABILITIES:
        raise AppError(404, "NOT_FOUND", "Protocol not found.")
    return {"protocol": protocol, "capabilities": collect.CAPABILITIES[protocol], "can_write": False}


@app.get("/api/v1/connections")
async def connections(protocol: str | None = None, site_id: str | None = None, status: str | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await collect.list_connections(session, tenant_id, protocol=protocol, site_id=site_id, status=status)}


@app.post("/api/v1/connections", status_code=201)
async def create_connection(body: ConnectionIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    created = await collect.create_connection(session, tenant_id, actor, body, data_key=settings.data_key, correlation_id=correlation_id(request))
    if settings.appliance:
        # A first connection may have created the local edge: hand it an enrollment token now.
        await _commit_now(session)
        await _run_step("appliance_enrollment", _ensure_appliance_enrollment)
    return created


@app.get("/api/v1/connections/{connection_id}")
async def connection_detail(connection_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await collect.get_connection(session, tenant_id, parse_uuid(connection_id))


@app.patch("/api/v1/connections/{connection_id}")
async def patch_connection(connection_id: str, body: ConnectionPatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.patch_connection(session, tenant_id, actor, parse_uuid(connection_id), body, data_key=settings.data_key, correlation_id=correlation_id(request))


@app.post("/api/v1/connections/{connection_id}/pause")
async def pause_connection(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.pause_connection(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@app.post("/api/v1/connections/{connection_id}/resume")
async def resume_connection(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.resume_connection(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@app.delete("/api/v1/connections/{connection_id}")
async def delete_connection(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.archive_connection(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@app.post("/api/v1/connections/{connection_id}/capture", status_code=202)
async def capture_connection(connection_id: str, body: CaptureIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.capture_connection(session, tenant_id, actor, parse_uuid(connection_id), body, correlation_id(request))


@app.post("/api/v1/connections/{connection_id}/tests", status_code=202)
async def commission(connection_id: str, request: Request, body: TestIn | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    mode = body.mode if body and body.mode else "FULL"
    fields = body.fields if body else None
    config = body.config if body else None
    return await collect.request_commission(
        session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request), mode=mode, fields=fields, config=config, test_path=body.test_path if body else None
    )


@app.get("/api/v1/commissioning/{job_id}")
async def commission_job(job_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    row = await fetch_one(session, "SELECT id, connection_id, stages_json, status, error_code, diagnostic, samples_json, started_at, completed_at FROM commissioning_jobs WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(job_id), "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Commissioning job not found.")

    # 30-second reaper
    if row["status"] in {"PENDING", "RUNNING"}:
        started = row.get("started_at")
        if started:
            from factorix.modules.common import utcnow
            elapsed = (utcnow() - started).total_seconds()
            if elapsed > 30:
                await execute(
                    session,
                    """
                    UPDATE commissioning_jobs
                    SET status = 'FAILED', error_code = 'TIMEOUT', diagnostic = 'Commissioning job timed out after 30 seconds.', completed_at = :now
                    WHERE id = :id
                    """,
                    {"now": utcnow(), "id": row["id"]},
                )
                row["status"] = "FAILED"
                row["error_code"] = "TIMEOUT"
                row["diagnostic"] = "Commissioning job timed out after 30 seconds."

    status = "COMPLETED" if row["status"] == "PASSED" else row["status"]
    stages = list(row.get("stages_json") or [])
    return {
        "id": row["id"],
        "connection_id": row["connection_id"],
        "status": status,
        "error_code": row.get("error_code"),
        "diagnostic": row.get("diagnostic") or "",
        "stages_json": stages,
        "samples_json": row.get("samples_json") or {},
        "started_at": row.get("started_at"),
        "completed_at": row.get("completed_at"),
    }


class JobIn(BaseModel):
    connection_id: str
    mode: str = "POLL"
    interval_ms: int = 1000


@app.post("/api/v1/jobs")
async def create_or_get_job(body: JobIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    conn_id = parse_uuid(body.connection_id)
    conn = await fetch_one(session, "SELECT id FROM connections WHERE id = :id AND tenant_id = :tenant_id", {"id": conn_id, "tenant_id": tenant_id})
    if conn is None:
        raise AppError(404, "NOT_FOUND", "Connection not found.")
    job = await fetch_one(session, "SELECT id FROM acquisition_jobs WHERE connection_id = :id", {"id": conn_id})
    if job:
        await execute(session, "UPDATE acquisition_jobs SET mode = :mode, interval_ms = :interval_ms WHERE id = :id", {"id": job["id"], "mode": body.mode, "interval_ms": body.interval_ms})
        await execute(
            session,
            "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
            {"channel": "factorix_config_changed", "payload": f'{{"tenant_id":"{tenant_id}"}}'},
        )
        return {"id": str(job["id"])}
    job_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO acquisition_jobs (id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version)
        VALUES (:id, :connection_id, :mode, :interval_ms, 3000, TRUE, 1, 1, 1)
        """,
        {"id": job_id, "connection_id": conn_id, "mode": body.mode, "interval_ms": body.interval_ms},
    )
    await execute(
        session,
        "SELECT pg_notify(CAST(:channel AS text), CAST(:payload AS text))",
        {"channel": "factorix_config_changed", "payload": f'{{"tenant_id":"{tenant_id}"}}'},
    )
    return {"id": str(job_id)}



@app.get("/api/v1/signals")
async def signals(resource_id: str | None = None, q: str | None = None, limit: int = 200, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await collect.list_signals(session, tenant_id, resource_id=resource_id, query=q, limit=limit)}


@app.post("/api/v1/signals/bulk", status_code=201)
async def signal_bulk(body: SignalBulkIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.bulk_signals(session, tenant_id, actor, body, correlation_id(request))


@app.patch("/api/v1/signals/{signal_id}")
async def patch_signal(signal_id: str, body: SignalPatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.patch_signal(session, tenant_id, actor, parse_uuid(signal_id), body, correlation_id(request))


@app.delete("/api/v1/signals/{signal_id}")
async def delete_signal(signal_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.delete_signal(session, tenant_id, actor, parse_uuid(signal_id), correlation_id(request))


@app.get("/api/v1/signals/{signal_id}/usage")
async def signal_usage(signal_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    """Data models that read the signal; asked before disable, delete or pause (R3-DM-02)."""
    tenant_id, _actor = _ids(principal)
    signal = parse_uuid(signal_id)
    if await fetch_one(session, "SELECT id FROM signal_definitions WHERE id = :id AND tenant_id = :tenant_id", {"id": signal, "tenant_id": tenant_id}) is None:
        raise AppError(404, "NOT_FOUND", "Signal not found.")
    return {"signal_id": str(signal), "models": await usage.models_using_signal(session, tenant_id, signal)}


class SignalUsageIn(BaseModel):
    signal_ids: list[str]


@app.post("/api/v1/signals/usage")
async def signals_usage(body: SignalUsageIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    """Data models that read any of the signals, in one query (R4-SG-01: the bulk Disable / Delete
    dialog asked once per selected signal and waited behind the page's other requests)."""
    tenant_id, _actor = _ids(principal)
    if len(body.signal_ids) > 5000:
        raise AppError(422, "LIMIT", "At most 5000 signals per usage lookup.")
    ids = list(dict.fromkeys(parse_uuid(item) for item in body.signal_ids))
    return {"signal_ids": [str(item) for item in ids], "models": await usage.models_using_signals(session, tenant_id, ids) if ids else []}


@app.post("/api/v1/signals/bulk-properties")
async def signal_bulk_properties(body: collect.SignalBulkPropertiesIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    """Set unit, expected interval and/or round digits on many signals, all or nothing (R4-SG-02)."""
    tenant_id, actor = _ids(principal)
    return await collect.bulk_properties_signals(session, tenant_id, actor, body, correlation_id(request))


@app.post("/api/v1/signals/bulk-address")
async def signal_bulk_address(body: collect.SignalBulkAddressIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.bulk_address_signals(session, tenant_id, actor, body, correlation_id(request))


@app.post("/api/v1/signals/bulk-action")
async def signal_bulk_action(body: SignalBulkActionIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.bulk_action_signals(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/signals/{signal_id}/latest")
async def signal_latest(signal_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    rows = await telemetry.latest_states(session, tenant_id, [parse_uuid(signal_id)])
    if not rows:
        return {"signal_id": signal_id, "value": None, "quality": None, "freshness": "UNKNOWN"}
    return rows[0]


@app.post("/api/v1/mappings/validate")
async def mapping_validate(body: MappingPreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    result = collect.validate_mapping(body)
    return {"valid": True, **result}


@app.post("/api/v1/mappings/preview")
async def mapping_preview(body: MappingPreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return collect.validate_mapping(body)


@app.post("/api/v1/formulas", status_code=201)
async def create_formula(body: FormulaIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.save_formula(session, tenant_id, actor, body, correlation_id(request))


@app.post("/api/v1/formulas/validate")
async def validate_formula(body: PreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return collect.preview_formula(body)


@app.post("/api/v1/formulas/evaluate-preview")
async def evaluate_formula(body: PreviewIn, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return collect.preview_formula(body)


@app.post("/api/v1/formulas/{formula_id}/publish")
async def publish_formula(formula_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.publish_formula(session, tenant_id, actor, parse_uuid(formula_id), correlation_id(request))


@app.post("/api/v1/edges", status_code=201)
async def create_edge(body: EdgeIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.create_edge(session, tenant_id, actor, body, correlation_id(request))


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


@app.get("/api/v1/edges")
async def edges(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(session, "SELECT id, name, site_id, enrollment_status, desired_revision, active_revision, last_heartbeat, health, software_version, outbox_pending, queues_json FROM edge_nodes WHERE tenant_id = :tenant_id ORDER BY name", {"tenant_id": tenant_id})
    return {"items": [_normalize_edge(item) for item in items]}


@app.get("/api/v1/edges/{edge_id}")
async def edge_detail(edge_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    raw = await collect._owned_edge(session, tenant_id, parse_uuid(edge_id))
    return _normalize_edge(raw)


@app.get("/api/v1/edges/{edge_id}/health")
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


@app.patch("/api/v1/edges/{edge_id}")
async def patch_edge(edge_id: str, body: EdgePatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.patch_edge(session, tenant_id, actor, parse_uuid(edge_id), body, correlation_id(request))


@app.delete("/api/v1/edges/{edge_id}")
async def delete_edge(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.delete_edge(session, tenant_id, actor, parse_uuid(edge_id), correlation_id(request))


@app.post("/api/v1/edges/{edge_id}/enrollment-token", status_code=201)
async def enrollment(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.issue_enrollment(session, tenant_id, parse_uuid(edge_id), actor, correlation_id(request))


@app.post("/api/v1/edges/{edge_id}/appliance", status_code=201)
async def appliance_enrollment(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    if not settings.appliance or not settings.data_dir:
        raise AppError(404, "NOT_FOUND", "Appliance enrollment is not enabled.")
    tenant_id, actor = _ids(principal)
    issued = await collect.issue_enrollment(session, tenant_id, parse_uuid(edge_id), actor, correlation_id(request))
    await _commit_now(session)
    token_path, _credential_path = _appliance_paths()
    _write_private(token_path, str(issued["enrollment_token"]))
    return {"status": "queued"}


@app.get("/api/v1/edges/{edge_id}/deployments")
async def deployments(edge_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    await collect._owned_edge(session, tenant_id, parse_uuid(edge_id))
    items = await fetch_all(session, "SELECT id, revision, state, diagnostic_redacted, at FROM deployment_events WHERE edge_id = :id ORDER BY at DESC LIMIT 100", {"id": parse_uuid(edge_id)})
    return {"items": items}


@app.post("/api/v1/config-releases/publish", status_code=201)
async def publish_release(body: ReleaseIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.publish_release(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/observations/latest")
async def latest(signal_ids: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    ids = [parse_uuid(item) for item in signal_ids.split(",") if item]
    return {"items": await telemetry.latest_states(session, tenant_id, ids)}


@app.get("/api/v1/observations/history")
async def history(
    signal_id: str,
    start: str | None = None,
    end: str | None = None,
    from_time: str | None = Query(None, alias="from"),
    limit: int = 500,
    cursor: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    now = utcnow()
    raw_start = start or from_time
    if raw_start:
        if raw_start.startswith("now-"):
            offset_str = raw_start[4:]
            if offset_str.endswith("m"):
                start_dt = now - timedelta(minutes=int(offset_str[:-1]))
            elif offset_str.endswith("h"):
                start_dt = now - timedelta(hours=int(offset_str[:-1]))
            elif offset_str.endswith("d"):
                start_dt = now - timedelta(days=int(offset_str[:-1]))
            else:
                start_dt = now - timedelta(minutes=15)
        else:
            start_dt = _time(raw_start)
    else:
        start_dt = now - timedelta(minutes=15)

    if end:
        end_dt = _time(end)
    else:
        end_dt = now

    return await telemetry.history(session, tenant_id, signal_id=parse_uuid(signal_id), start=start_dt, end=end_dt, limit=limit, cursor=cursor)


@app.get("/api/v1/observations/aggregate")
async def aggregate(signal_ids: str, start: str, end: str, bucket_ms: int = 60000, fn: str = "avg", principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    ids = [parse_uuid(item) for item in signal_ids.split(",") if item]
    return await telemetry.aggregate(session, tenant_id, signal_ids=ids, start=_time(start), end=_time(end), bucket_ms=bucket_ms, fn=fn)


@app.get("/api/v1/storage/overview")
async def storage_overview(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await telemetry.storage_overview(session, tenant_id)


@app.get("/api/v1/storage/ingestion-health")
async def ingestion_health(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    overview = await telemetry.storage_overview(session, tenant_id)
    return {"ingest_per_minute": overview["ingest_per_minute"], "quarantine": overview["quarantine"], "dedup_keys": overview["dedup_keys"], "newest": overview["newest"]}


@app.post("/api/v1/storage/exports", status_code=202)
async def export_csv(signal_id: str, start: str, end: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.export_csv(session, tenant_id, actor, parse_uuid(signal_id), _time(start), _time(end))


@app.post("/api/v1/retention-policies", status_code=201)
async def create_retention(body: RetentionIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.create_retention(session, tenant_id, actor, body, correlation_id(request))


@app.post("/api/v1/retention-policies/{policy_id}/preview")
async def retention_preview(policy_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await telemetry.preview_retention(session, tenant_id, parse_uuid(policy_id))


@app.post("/api/v1/retention-policies/{policy_id}/enable")
async def retention_enable(policy_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.enable_retention(session, tenant_id, actor, parse_uuid(policy_id), correlation_id(request))


@app.post("/api/v1/retention-policies/{policy_id}/execute")
async def retention_execute(policy_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.execute_retention(session, tenant_id, actor, parse_uuid(policy_id), correlation_id(request))


@app.get("/api/v1/formulas")
async def formulas(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(
        session,
        """
        SELECT f.id, f.signal_id, f.expression_source, f.unit, f.revision, f.status, s.key, s.display_name, s.resource_id
        FROM formula_definitions f
        JOIN signal_definitions s ON s.id = f.signal_id
        WHERE s.tenant_id = :tenant_id AND f.status <> 'ARCHIVED'
        ORDER BY s.key
        """,
        {"tenant_id": tenant_id},
    )
    return {"items": items}


@app.get("/api/v1/commissioning")
async def commissioning(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(
        session,
        """
        SELECT j.id, j.connection_id, j.status, j.error_code, j.diagnostic, j.started_at, j.completed_at, j.stages_json,
               c.name AS connection_name, c.protocol
        FROM commissioning_jobs j
        JOIN connections c ON c.id = j.connection_id
        WHERE j.tenant_id = :tenant_id
        ORDER BY j.started_at DESC NULLS LAST
        LIMIT 100
        """,
        {"tenant_id": tenant_id},
    )
    return {"items": items}


@app.get("/api/v1/config-releases")
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


@app.get("/api/v1/dashboards")
async def dashboards(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await fetch_all(session, "SELECT id, name, description, draft_revision, published_revision, archived_at, version, updated_at FROM dashboards WHERE tenant_id = :tenant_id AND archived_at IS NULL ORDER BY name", {"tenant_id": tenant_id})}


@app.post("/api/v1/dashboards", status_code=201)
async def create_dashboard(body: DashboardIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.create_dashboard(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/dashboards/{dashboard_id}")
async def dashboard_detail(dashboard_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await telemetry._dashboard(session, tenant_id, parse_uuid(dashboard_id))


@app.patch("/api/v1/dashboards/{dashboard_id}")
async def patch_dashboard(dashboard_id: str, body: DashboardPatch, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.patch_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), body, correlation_id(request))


@app.post("/api/v1/dashboards/{dashboard_id}/publish")
async def publish_dashboard(dashboard_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await telemetry.publish_dashboard(session, tenant_id, actor, parse_uuid(dashboard_id), correlation_id(request))


@app.get("/api/v1/audit-events")
async def audit_events(
    limit: int = 50,
    severity: str | None = None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    cursor: str | None = None,
    principal: dict[str, Any] = Depends(admin),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    limit = min(max(limit, 1), 500)
    clauses = ["tenant_id = :tenant_id"]
    params: dict[str, Any] = {"tenant_id": tenant_id, "limit": limit + 1}
    if severity:
        clauses.append("severity = :severity")
        params["severity"] = severity.upper()
    if entity_type:
        clauses.append("entity_type = :entity_type")
        params["entity_type"] = entity_type
    if entity_id:
        clauses.append("entity_id = :entity_id")
        params["entity_id"] = parse_uuid(entity_id)
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AppError(422, "CURSOR", "Invalid cursor.") from exc
        clauses.append("occurred_at < :cursor_dt")
        params["cursor_dt"] = cursor_dt

    where_sql = " AND ".join(clauses)
    rows = await fetch_all(
        session,
        f"""
        SELECT id, event_type, actor_id, entity_type, entity_id,
               before_json, after_json, correlation_id, occurred_at, severity
        FROM audit_events
        WHERE {where_sql}
        ORDER BY occurred_at DESC
        LIMIT :limit
        """,
        params,
    )
    has_more = len(rows) > limit
    items = rows[:limit]
    next_cursor = None
    if has_more and items:
        last = items[-1]
        next_cursor = last["occurred_at"].isoformat() if hasattr(last["occurred_at"], "isoformat") else str(last["occurred_at"])
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}


@app.get("/api/v1/overview")
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
        "collector_status": collector_status([edge["effective_health"] for edge in edges]),
        "data_collection_status": data_collection_status(connection_states),
        "last_data_at": iso_ms(last_obs["last_at"]) if last_obs else None,
        "ingest_per_minute": storage["ingest_per_minute"],
        "messages_per_min": storage["ingest_per_minute"],
        "generated_at": iso_ms(now),
        "edges": edges,
        "connection_health": [{"health": state, "count": count} for state, count in sorted(health_counts.items())],
        "recent_errors": recent_errors,
    }


@app.get("/api/v1/search")
async def search(q: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    pattern = f"%{q.strip()}%"
    return {
        "resources": await fetch_all(session, "SELECT id, code, name FROM resources WHERE tenant_id = :tenant_id AND (name ILIKE :q OR code ILIKE :q) ORDER BY code LIMIT 8", {"tenant_id": tenant_id, "q": pattern}),
        "connections": [
            {**row, "protocol": public_protocol(str(row["protocol"]))}
            for row in await fetch_all(session, "SELECT id, name, protocol FROM connections WHERE tenant_id = :tenant_id AND name ILIKE :q ORDER BY name LIMIT 8", {"tenant_id": tenant_id, "q": pattern})
        ],
        "signals": await fetch_all(session, "SELECT id, key, display_name FROM signal_definitions WHERE tenant_id = :tenant_id AND (key ILIKE :q OR display_name ILIKE :q) ORDER BY key LIMIT 8", {"tenant_id": tenant_id, "q": pattern}),
    }


class EdgeEnrollIn(BaseModel):
    enrollment_token: str


class EdgeAckIn(BaseModel):
    revision: int
    state: str
    diagnostic: str = ""


class EdgeBatchIn(BaseModel):
    observations: list[dict[str, Any]]


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


@app.post("/api/v1/edge-sync/enroll")
async def edge_enroll(body: EdgeEnrollIn, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    result = await edge_sync.enroll(session, body.enrollment_token)
    await _commit_now(session)
    return result


@app.post("/api/v1/edge-sync/heartbeat")
async def edge_heartbeat(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    body = await request.json()
    if not isinstance(body, dict):
        raise AppError(422, "BODY", "Heartbeat body must be a JSON object.")
    result = await edge_sync.heartbeat(session, edge, body)
    await _commit_now(session)
    return result


@app.get("/api/v1/edge-sync/config")
async def edge_config(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.desired_config(session, edge)


@app.post("/api/v1/edge-sync/ack")
async def edge_ack(body: EdgeAckIn, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    result = await edge_sync.acknowledge(session, edge, body.revision, body.state, body.diagnostic)
    await _commit_now(session)
    return result


@app.get("/api/v1/edge-sync/secrets/{secret_id}")
async def edge_secret(secret_id: str, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.read_secret(session, edge, parse_uuid(secret_id), settings.data_key)


@app.post("/api/v1/edge-sync/observations")
async def edge_observations(body: EdgeBatchIn, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    result = await edge_sync.accept_observations(session, edge, body.observations)
    # The edge marks rows ACKED as soon as it reads this response: commit first (at-least-once).
    await _commit_now(session)
    return result


@app.get("/api/v1/edge-sync/commands")
async def edge_commands(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    result = await edge_sync.pull_commands(session, edge)
    await _commit_now(session)
    return result


@app.post("/api/v1/edge-sync/commands/{job_id}")
async def edge_command_result(job_id: str, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    body = await request.json()
    if not isinstance(body, dict):
        raise AppError(422, "BODY", "Command result must be a JSON object.")
    result = await edge_sync.finish_command(session, edge, parse_uuid(job_id), body)
    await _commit_now(session)
    return result


STREAM_MAX_SIGNALS = 5000
STREAM_MAX_GROUPS = 500


def _stream_ids(values: Any, limit: int) -> list[UUID]:
    if not isinstance(values, list):
        return []
    ids: list[UUID] = []
    for item in values[:limit]:
        try:
            ids.append(UUID(str(item)))
        except ValueError:
            continue
    return ids


def _latest_message(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "latest",
        "signal_id": str(row["signal_id"]),
        "value": row.get("value"),
        "quality": row.get("raw_quality"),
        "effective_status": row.get("effective_status"),
        "reason_code": row.get("reason_code"),
        "received_time": row.get("received_time"),
        "source_time": row.get("source_time"),
    }


async def _stream_subscribe_signals(channel: Channel, tenant_id: UUID, message: dict[str, Any]) -> int:
    requested = _stream_ids(message.get("signal_ids"), STREAM_MAX_SIGNALS)
    valid: list[UUID] = []
    async with session_factory()() as session:
        if requested:
            rows = await fetch_all(
                session,
                "SELECT id FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
                {"tenant_id": tenant_id, "ids": requested},
            )
            valid = [as_uuid(row["id"]) for row in rows]
        if message.get("mode") != "add":
            channel.signals.clear()
        channel.signals.update(str(item) for item in valid)
        # Initial snapshot so the page shows current values immediately, then pushes follow.
        for start in range(0, len(valid), 200):
            for row in await telemetry.latest_states(session, tenant_id, valid[start : start + 200]):
                channel.offer(_latest_message(row))
    return len(channel.signals)


async def _stream_subscribe_models(channel: Channel, tenant_id: UUID, message: dict[str, Any]) -> int:
    requested = _stream_ids(message.get("group_ids"), STREAM_MAX_GROUPS)
    valid: list[str] = []
    if requested:
        async with session_factory()() as session:
            rows = await fetch_all(
                session,
                "SELECT id FROM output_groups WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
                {"tenant_id": tenant_id, "ids": requested},
            )
            valid = [str(row["id"]) for row in rows]
    if message.get("mode") != "add":
        channel.groups.clear()
    channel.groups.update(valid)
    return len(channel.groups)


@app.websocket("/stream")
async def stream(socket: WebSocket) -> None:
    allowed = [settings.web_origin] if settings.web_origin else []
    if not origin_allowed(socket.headers.get("origin"), socket.headers.get("host"), allowed):
        await socket.close(code=4403)
        return
    await socket.accept()
    async with session_factory()() as session:
        try:
            principal = await principal_from_token(session, socket.cookies.get(SESSION_COOKIE))
        except AppError:
            await socket.close(code=4401)
            return
    tenant_id = as_uuid(principal["tenant_id"])
    channel = Channel(socket.send_json, str(tenant_id))
    hub.register(channel)
    sender = asyncio.create_task(channel.run(), name="stream-sender")
    try:
        while not channel.closed:
            try:
                message = await socket.receive_json()
            except (ValueError, KeyError):
                channel.offer({"type": "error", "code": "BAD_MESSAGE", "message": "Messages must be JSON objects."})
                continue
            if not isinstance(message, dict):
                continue
            op = message.get("op")
            if op == "subscribe":
                count = await _stream_subscribe_signals(channel, tenant_id, message)
                channel.offer({"type": "subscribed", "count": count})
            elif op == "subscribe_models":
                count = await _stream_subscribe_models(channel, tenant_id, message)
                channel.offer({"type": "subscribed_models", "count": count})
            elif op == "subscribe_health":
                # Health events are delivered to every socket of the tenant; acknowledged for clients.
                channel.offer({"type": "subscribed_health"})
            elif op == "ping":
                channel.offer({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(channel)
        sender.cancel()
        try:
            await sender
        except asyncio.CancelledError:
            pass


def _mount_spa() -> None:
    if not settings.web_dist:
        return
    root = Path(settings.web_dist).resolve()
    index = root / "index.html"
    if not index.is_file():
        return

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        candidate = (root / full_path).resolve()
        if candidate.is_file() and candidate.is_relative_to(root):
            if candidate.name == "index.html" or candidate.suffix in {".html", ".htm"}:
                return FileResponse(candidate, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


app.include_router(data_models_api.build_router(admin, db_session))
_mount_spa()


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise AppError(422, "TIMEZONE", "Timestamps must include a timezone.")
    return parsed.astimezone(timezone.utc)
