"""Authentication, password reset, revert-to-zero (410) and the signed-in admin. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import identity
from factorix.modules.common import as_uuid, fetch_one
from factorix.modules.identity import (
    SESSION_COOKIE,
    BootstrapIn,
    ForgotIn,
    LoginIn,
    PasswordIn,
    ResetIn,
    bootstrap_admin,
    clear_cookies,
    confirm_password_reset,
    login_admin,
    principal_from_token,
    request_password_reset,
    require_bootstrap_token,
)
from factorix.platform.mail import SmtpMailer
from factorix.platform.security import hash_token
from factorix.platform.errors import AppError
from factorix.platform.security import hash_password, verify_password

from factorix.transport.http.routing import RouteTable

from factorix.transport.http.deps import _settings, admin, db_session

router = RouteTable()

# Set by ``factorix.transport.app`` (composition root) right after the FastAPI app is created:
# ``forgot`` reads an optional mailer from ``app.state`` (used by the integration tests).
app: Any = None


@router.post("/api/v1/auth/bootstrap", status_code=201)
async def bootstrap(request: Request, body: BootstrapIn, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    require_bootstrap_token(_settings(), request.headers.get("x-bootstrap-token"))
    return await bootstrap_admin(session, body, actor_ip_note="")


@router.post("/api/v1/auth/login")
async def login(body: LoginIn, response: Response, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    cfg = _settings()
    tokens = await login_admin(session, cfg, body)
    identity._cookies(response, cfg, tokens["session_token"], tokens["csrf_token"])
    return {"status": "authenticated"}


@router.post("/api/v1/auth/forgot")
async def forgot(body: ForgotIn, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    mailer = getattr(app.state, "mailer", None) or SmtpMailer(_settings())
    return await request_password_reset(session, body, mailer)


@router.post("/api/v1/auth/reset")
async def reset_password(body: ResetIn, session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    return await confirm_password_reset(session, body)


class ResetLinkIn(BaseModel):
    token: str
    new_password: str


@router.post("/api/v1/auth/reset-password")
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


@router.post("/api/v1/auth/logout")
async def logout(response: Response, request: Request, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    await identity.execute_logout(session, as_uuid(principal["session_id"]))
    clear_cookies(response, _settings())
    return {"status": "signed_out"}


class RevertIn(BaseModel):
    confirm: str


@router.post("/api/v1/admin/revert-to-zero")
async def revert_zero(body: RevertIn, response: Response, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    del body, response, principal, session
    raise AppError(
        410,
        "ENDPOINT_GONE",
        "Destructive revert-to-zero is permanently disabled to prevent loss of configuration, accounts, and physical schemas. Use selective Clear Telemetry (/api/v1/admin/telemetry-reset) instead.",
    )


@router.get("/api/v1/auth/status")
async def auth_status(request: Request, session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    cfg = _settings()
    existing = await fetch_one(session, "SELECT id FROM admin_accounts WHERE disabled_at IS NULL LIMIT 1", {})
    open_first_run = cfg.environment == "development" and not cfg.bootstrap_token
    # R1-25 / R1-45: the app boots with one request. A valid session cookie also returns the signed-in
    # user (same body as /auth/me); without one, ``user`` is null instead of a 401 on the login page.
    user: dict[str, Any] | None = None
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        try:
            user = await identity.touch_me(await principal_from_token(session, token))
        except AppError:
            user = None
    return {
        "admin_exists": existing is not None,
        "bootstrap_enabled": bool(cfg.bootstrap_token) or open_first_run,
        "setup_code_required": bool(cfg.bootstrap_token),
        "appliance": cfg.appliance,
        "user": user,
    }


@router.get("/api/v1/auth/me")
async def me(principal: dict[str, Any] = Depends(admin)) -> dict[str, Any]:
    return await identity.touch_me(principal)


@router.post("/api/v1/auth/password")
async def change_password(body: PasswordIn, principal: dict[str, Any] = Depends(admin), session: AsyncSession = Depends(db_session)) -> dict[str, str]:
    from factorix.domain.passwords import validate_password

    account = await fetch_one(session, "SELECT password_hash, login FROM admin_accounts WHERE id = :id", {"id": as_uuid(principal["admin_id"])})
    if account is None or not verify_password(account["password_hash"], body.current_password):
        raise AppError(401, "INVALID_CREDENTIALS", "Current password is incorrect.")
    validate_password(body.new_password, account["login"])
    from factorix.modules.common import execute

    await execute(session, "UPDATE admin_accounts SET password_hash = :password_hash WHERE id = :id", {"password_hash": hash_password(body.new_password), "id": as_uuid(principal["admin_id"])})
    return {"status": "updated"}
