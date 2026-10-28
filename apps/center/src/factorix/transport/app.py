"""FactoriX Center HTTP application."""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect, edge_sync, identity, resources, telemetry
from factorix.modules.collect import (
    ConnectionIn,
    EdgeIn,
    FormulaIn,
    MappingPreviewIn,
    OutputGroupIn,
    PreviewIn,
    ReleaseIn,
    SignalBulkIn,
    SignalPatch,
)
from factorix.modules.common import as_uuid, fetch_all, fetch_one, parse_uuid
from factorix.platform.after_commit import listen
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
from factorix.platform.mail import SmtpMailer
from factorix.modules.resources import (
    HierarchyIn,
    ImportIn,
    LayoutDraft,
    LayoutIn,
    MoveIn,
    RelationIn,
    ResourceIn,
    ResourcePatch,
    SiteIn,
    TypeIn,
)
from factorix.modules.telemetry import DashboardIn, DashboardPatch, RetentionIn
from factorix.platform.db import get_engine, session_factory
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id, json_error
from factorix.platform.security import hash_password, verify_password
from factorix.platform.settings import get_settings

settings = get_settings()


async def db_session() -> AsyncIterator[AsyncSession]:
    factory = session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def admin(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    row = await principal_from_token(session, request.cookies.get(SESSION_COOKIE))
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        assert_csrf(request.headers.get("x-csrf-token"), row["csrf_hash"])
    return row


def _ids(row: dict[str, Any]) -> tuple[Any, Any]:
    return as_uuid(row["tenant_id"]), as_uuid(row["admin_id"])


class Hub:
    def __init__(self) -> None:
        self.sockets: list[tuple[WebSocket, set[str], str]] = []

    async def publish(self, tenant_id: str, signal_id: str, payload: dict[str, Any]) -> None:
        dead: list[tuple[WebSocket, set[str], str]] = []
        for socket, signals, owner in self.sockets:
            if owner != tenant_id:
                continue
            if signal_id not in signals:
                continue
            try:
                await socket.send_json(payload)
            except Exception:
                dead.append((socket, signals, owner))
        for item in dead:
            if item in self.sockets:
                self.sockets.remove(item)


hub = Hub()


async def _publish_committed(events: list[dict[str, Any]]) -> None:
    for event in events:
        if event.get("kind") != "latest":
            continue
        await hub.publish(str(event["tenant_id"]), str(event["signal_id"]), event["payload"])


listen(_publish_committed)

app = FastAPI(title="FactoriX IIoT Center", version="1.0.0", openapi_url="/api/openapi.json")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["content-type", "x-csrf-token", "x-bootstrap-token"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
    request.state.correlation_id = request.headers.get("x-correlation-id") or uuid.uuid4().hex
    response = await call_next(request)
    response.headers["X-Correlation-Id"] = request.state.correlation_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; base-uri 'self'"
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


@app.post("/api/v1/auth/logout")
async def logout(response: Response, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    await identity.execute_logout(session, as_uuid(principal["session_id"]))
    clear_cookies(response, settings)
    return {"status": "signed_out"}


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
        raise AppError(401, "INVALID_CREDENTIALS", "Mật khẩu hiện tại không đúng.")
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


@app.post("/api/v1/resources/{resource_id}/archive")
async def archive_resource(resource_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.archive_resource(session, tenant_id, actor, parse_uuid(resource_id), correlation_id(request))


@app.post("/api/v1/resources/{resource_id}/move")
async def move_resource(resource_id: str, body: MoveIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.move_resource(session, tenant_id, actor, parse_uuid(resource_id), body, correlation_id(request))


@app.post("/api/v1/resources/import")
async def import_resources(body: ImportIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.import_resources(session, tenant_id, actor, body, correlation_id(request))


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
        raise AppError(404, "NOT_FOUND", "Không tìm thấy mẫu phân cấp.")
    errors = resources.validate_levels(row["level_rules_json"] or [])
    return {"valid": not errors, "errors": errors}


@app.get("/api/v1/graph/neighbors")
async def graph(resource_id: str, depth: int = 1, relation_types: str = "", as_of: str | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    moment = datetime.fromisoformat(as_of.replace("Z", "+00:00")) if as_of else None
    codes = [item for item in relation_types.split(",") if item]
    return await resources.neighbors(session, tenant_id, parse_uuid(resource_id), depth=depth, relation_codes=codes, as_of=moment)


@app.get("/api/v1/layouts")
async def layouts(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await fetch_all(session, "SELECT id, name, scope_resource_id, draft_json, version, published_revision, updated_at FROM layout_definitions WHERE tenant_id = :tenant_id ORDER BY name", {"tenant_id": tenant_id})}


@app.post("/api/v1/layouts", status_code=201)
async def create_layout(body: LayoutIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.create_layout(session, tenant_id, actor, body, correlation_id(request))


@app.patch("/api/v1/layouts/{layout_id}/draft")
async def layout_draft(layout_id: str, body: LayoutDraft, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.save_layout_draft(session, tenant_id, actor, parse_uuid(layout_id), body, correlation_id(request))


@app.post("/api/v1/layouts/{layout_id}/publish")
async def layout_publish(layout_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await resources.publish_layout(session, tenant_id, actor, parse_uuid(layout_id), correlation_id(request))


@app.get("/api/v1/connector-types")
async def connector_types(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    return {"items": [{"protocol": key, "capabilities": value} for key, value in collect.CAPABILITIES.items()]}


@app.get("/api/v1/connector-types/{protocol}/schema")
async def connector_schema(protocol: str, principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    del principal
    if protocol not in collect.CAPABILITIES:
        raise AppError(404, "NOT_FOUND", "Không có giao thức này.")
    return {"protocol": protocol, "capabilities": collect.CAPABILITIES[protocol], "can_write": False}


@app.get("/api/v1/connections")
async def connections(protocol: str | None = None, site_id: str | None = None, status: str | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return {"items": await collect.list_connections(session, tenant_id, protocol=protocol, site_id=site_id, status=status)}


@app.post("/api/v1/connections", status_code=201)
async def create_connection(body: ConnectionIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.create_connection(session, tenant_id, actor, body, data_key=settings.data_key, correlation_id=correlation_id(request))


@app.get("/api/v1/connections/{connection_id}")
async def connection_detail(connection_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await collect.get_connection(session, tenant_id, parse_uuid(connection_id))


@app.post("/api/v1/connections/{connection_id}/pause")
async def pause_connection(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.pause_connection(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@app.post("/api/v1/connections/{connection_id}/tests", status_code=202)
async def commission(connection_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.request_commission(session, tenant_id, actor, parse_uuid(connection_id), correlation_id(request))


@app.get("/api/v1/commissioning/{job_id}")
async def commission_job(job_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    row = await fetch_one(session, "SELECT id, connection_id, stages_json, status, error_code, diagnostic, started_at, completed_at FROM commissioning_jobs WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(job_id), "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy phiên kiểm thử.")
    return row


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


@app.post("/api/v1/output-groups", status_code=201)
async def create_group(body: OutputGroupIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.create_output_group(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/output-groups/{group_id}/preview")
async def group_preview(group_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await collect.preview_output_group(session, tenant_id, parse_uuid(group_id))


@app.post("/api/v1/output-groups/{group_id}/publish")
async def publish_group(group_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    from factorix.modules.common import execute

    row = await fetch_one(session, "SELECT id FROM output_groups WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(group_id), "tenant_id": tenant_id})
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy nhóm đầu ra.")
    await execute(session, "UPDATE output_groups SET status = 'PUBLISHED', version = version + 1 WHERE id = :id", {"id": parse_uuid(group_id)})
    return {"id": group_id, "status": "PUBLISHED"}


@app.post("/api/v1/edges", status_code=201)
async def create_edge(body: EdgeIn, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.create_edge(session, tenant_id, actor, body, correlation_id(request))


@app.get("/api/v1/edges")
async def edges(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(session, "SELECT id, name, site_id, enrollment_status, desired_revision, active_revision, last_heartbeat, health, software_version, outbox_pending FROM edge_nodes WHERE tenant_id = :tenant_id ORDER BY name", {"tenant_id": tenant_id})
    return {"items": items}


@app.get("/api/v1/edges/{edge_id}")
async def edge_detail(edge_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await collect._owned_edge(session, tenant_id, parse_uuid(edge_id))


@app.post("/api/v1/edges/{edge_id}/enrollment-token", status_code=201)
async def enrollment(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, actor = _ids(principal)
    return await collect.issue_enrollment(session, tenant_id, parse_uuid(edge_id), actor, correlation_id(request))


@app.post("/api/v1/edges/{edge_id}/appliance", status_code=201)
async def appliance_enrollment(edge_id: str, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    if not settings.appliance or not settings.data_dir:
        raise AppError(404, "NOT_FOUND", "Ghi danh trong appliance chưa được bật.")
    tenant_id, actor = _ids(principal)
    issued = await collect.issue_enrollment(session, tenant_id, parse_uuid(edge_id), actor, correlation_id(request))
    directory = Path(settings.data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "enrollment"
    target.write_text(str(issued["enrollment_token"]), encoding="utf-8")
    try:
        target.chmod(0o600)
    except OSError:
        pass
    return {"status": "queued"}


@app.get("/api/v1/edges/{edge_id}/health")
async def edge_health(edge_id: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    edge = await collect._owned_edge(session, tenant_id, parse_uuid(edge_id))
    return {"id": edge["id"], "health": edge["health"], "desired_revision": edge["desired_revision"], "active_revision": edge["active_revision"], "last_heartbeat": edge["last_heartbeat"], "outbox_pending": edge["outbox_pending"]}


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
async def history(signal_id: str, start: str, end: str, limit: int = 500, cursor: str | None = None, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    return await telemetry.history(session, tenant_id, signal_id=parse_uuid(signal_id), start=_time(start), end=_time(end), limit=limit, cursor=cursor)


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


@app.get("/api/v1/output-groups")
async def output_groups(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(
        session,
        """
        SELECT g.id, g.resource_id, g.key, g.display_name, g.topic_template, g.status, g.version, r.code AS resource_code,
               (SELECT count(*) FROM output_group_members m WHERE m.output_group_id = g.id) AS member_count
        FROM output_groups g
        JOIN resources r ON r.id = g.resource_id
        WHERE g.tenant_id = :tenant_id AND g.status <> 'ARCHIVED'
        ORDER BY r.code, g.key
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
async def audit_events(limit: int = 100, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    items = await fetch_all(session, "SELECT id, event_type, actor_id, entity_type, entity_id, before_json, after_json, correlation_id, occurred_at FROM audit_events WHERE tenant_id = :tenant_id ORDER BY occurred_at DESC LIMIT :limit", {"tenant_id": tenant_id, "limit": min(limit, 500)})
    return {"items": items}


@app.get("/api/v1/overview")
async def overview(principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    resources_count = await fetch_one(session, "SELECT count(*) AS count FROM resources WHERE tenant_id = :tenant_id AND archived_at IS NULL", {"tenant_id": tenant_id})
    machines = await fetch_one(session, "SELECT count(*) AS count FROM resources r JOIN resource_types t ON t.id = r.type_id WHERE r.tenant_id = :tenant_id AND t.key = 'machine' AND r.archived_at IS NULL", {"tenant_id": tenant_id})
    connections = await fetch_one(session, "SELECT count(*) AS count FROM connections WHERE tenant_id = :tenant_id AND status = 'ACTIVE'", {"tenant_id": tenant_id})
    edges = await fetch_all(session, "SELECT id, name, health, active_revision, desired_revision, last_heartbeat, outbox_pending FROM edge_nodes WHERE tenant_id = :tenant_id", {"tenant_id": tenant_id})
    healthy = sum(1 for edge in edges if edge["health"] in {"HEALTHY", "ACTIVE"})
    storage = await telemetry.storage_overview(session, tenant_id)
    return {
        "resources": int(resources_count["count"]) if resources_count else 0,
        "machines": int(machines["count"]) if machines else 0,
        "active_connections": int(connections["count"]) if connections else 0,
        "healthy_edges": healthy,
        "ingest_per_minute": storage["ingest_per_minute"],
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "edges": edges,
        "connection_health": await fetch_all(session, "SELECT health, count(*) AS count FROM connections WHERE tenant_id = :tenant_id GROUP BY health", {"tenant_id": tenant_id}),
        "recent_errors": await fetch_all(session, "SELECT id, name, last_error, health FROM connections WHERE tenant_id = :tenant_id AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 8", {"tenant_id": tenant_id}),
    }


@app.get("/api/v1/search")
async def search(q: str, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    tenant_id, _actor = _ids(principal)
    pattern = f"%{q.strip()}%"
    return {
        "resources": await fetch_all(session, "SELECT id, code, name FROM resources WHERE tenant_id = :tenant_id AND (name ILIKE :q OR code ILIKE :q) ORDER BY code LIMIT 8", {"tenant_id": tenant_id, "q": pattern}),
        "connections": await fetch_all(session, "SELECT id, name, protocol FROM connections WHERE tenant_id = :tenant_id AND name ILIKE :q ORDER BY name LIMIT 8", {"tenant_id": tenant_id, "q": pattern}),
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
    return await edge_sync.enroll(session, body.enrollment_token)


@app.post("/api/v1/edge-sync/heartbeat")
async def edge_heartbeat(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    body = await request.json()
    return await edge_sync.heartbeat(session, edge, body)


@app.get("/api/v1/edge-sync/config")
async def edge_config(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.desired_config(session, edge)


@app.post("/api/v1/edge-sync/ack")
async def edge_ack(body: EdgeAckIn, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.acknowledge(session, edge, body.revision, body.state, body.diagnostic)


@app.get("/api/v1/edge-sync/secrets/{secret_id}")
async def edge_secret(secret_id: str, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.read_secret(session, edge, parse_uuid(secret_id), settings.data_key)


@app.post("/api/v1/edge-sync/observations")
async def edge_observations(body: EdgeBatchIn, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    result = await edge_sync.accept_observations(session, edge, body.observations)
    return result


@app.get("/api/v1/edge-sync/commands")
async def edge_commands(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    return await edge_sync.pull_commands(session, edge)


@app.post("/api/v1/edge-sync/commands/{job_id}")
async def edge_command_result(job_id: str, request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    edge = await edge_sync.edge_principal(session, _bearer(request))
    body = await request.json()
    return await edge_sync.finish_command(session, edge, parse_uuid(job_id), body)


@app.websocket("/stream")
async def stream(socket: WebSocket) -> None:
    await socket.accept()
    factory = session_factory()
    async with factory() as session:
        cookie = socket.cookies.get(SESSION_COOKIE)
        try:
            principal = await principal_from_token(session, cookie)
        except AppError:
            await socket.close(code=4401)
            return
        tenant_id = str(principal["tenant_id"])
    subscribed: set[str] = set()
    hub.sockets.append((socket, subscribed, tenant_id))
    try:
        while True:
            message = await socket.receive_json()
            if message.get("op") == "subscribe":
                try:
                    requested = [parse_uuid(str(item)) for item in message.get("signal_ids", [])[:200]]
                except AppError:
                    await socket.send_json({"type": "subscribed", "count": 0})
                    continue
                factory = session_factory()
                async with factory() as session:
                    rows = await fetch_all(
                        session,
                        "SELECT id FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
                        {"tenant_id": principal["tenant_id"], "ids": requested},
                    ) if requested else []
                subscribed.clear()
                subscribed.update(str(row["id"]) for row in rows)
                await socket.send_json({"type": "subscribed", "count": len(subscribed)})
            elif message.get("op") == "ping":
                await socket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        if (socket, subscribed, tenant_id) in hub.sockets:
            hub.sockets.remove((socket, subscribed, tenant_id))


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
            return FileResponse(candidate)
        return FileResponse(index)


_mount_spa()


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise AppError(422, "TIMEZONE", "Thời điểm phải có múi giờ.")
    return parsed.astimezone(timezone.utc)
