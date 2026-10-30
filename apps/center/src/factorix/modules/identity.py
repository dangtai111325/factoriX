"""Single-admin session authentication."""

from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.catalog import CONTAINS_PAIRS, RELATION_TYPES, SYSTEM_TYPES
from factorix.domain.passwords import PasswordPolicyError, validate_email, validate_login, validate_password
from factorix.platform.mail import ResetMailer
from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, utcnow
from factorix.platform.errors import AppError
from factorix.platform.security import hash_password, hash_token, new_token, tokens_equal, verify_password
from factorix.platform.settings import Settings

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

SESSION_COOKIE = "fx_session"
CSRF_COOKIE = "fx_csrf"
LOCK_AFTER = 5
LOCK_MINUTES = 15
WINDOW_MINUTES = 15
RESET_MINUTES = 10
RESET_ATTEMPTS = 5


class BootstrapIn(BaseModel):
    login: str
    email: str
    password: str
    full_name: str = Field(default="", max_length=120)
    display_name: str = Field(default="My Workspace", max_length=120)
    tenant_code: str | None = Field(default=None, max_length=64)
    locale: str = "en"
    timezone: str = "Asia/Ho_Chi_Minh"


class ForgotIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    email: str
    code: str
    new_password: str


class LoginIn(BaseModel):
    login: str
    password: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


def _cookies(response: Response, settings: Settings, session_token: str, csrf_token: str) -> None:
    max_age = settings.session_ttl_minutes * 60
    response.set_cookie(
        SESSION_COOKIE,
        session_token,
        max_age=max_age,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE,
        csrf_token,
        max_age=max_age,
        httponly=False,
        secure=settings.secure_cookies,
        samesite="lax",
        path="/",
    )


def clear_cookies(response: Response, settings: Settings) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", secure=settings.secure_cookies, samesite="lax")
    response.delete_cookie(CSRF_COOKIE, path="/", secure=settings.secure_cookies, samesite="lax")


async def bootstrap_admin(session: AsyncSession, body: BootstrapIn, *, actor_ip_note: str) -> dict[str, Any]:
    del actor_ip_note
    existing = await fetch_one(session, "SELECT id FROM admin_accounts WHERE disabled_at IS NULL LIMIT 1", {})
    if existing:
        raise AppError(409, "ADMIN_EXISTS", "Đã có quản trị viên. Không khởi tạo lại.")
    login = validate_login(body.login)
    email = validate_email(body.email)
    validate_password(body.password, login)
    if body.locale not in {"vi", "en"}:
        raise AppError(422, "INVALID_LOCALE", "Locale chỉ hỗ trợ vi hoặc en.")
    full_name = (body.full_name or "").strip() or login
    if len(full_name) > 120:
        raise AppError(422, "INVALID_NAME", "Full name must be at most 120 characters.")
    workspace_name = (body.display_name or "My Workspace").strip() or "My Workspace"
    raw_code = (body.tenant_code or "").strip().lower()
    if raw_code:
        if len(raw_code) < 2 or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,63}", raw_code):
            raise AppError(422, "INVALID_TENANT", "Tenant code is invalid.")
        tenant_code = raw_code
    else:
        tenant_code = f"ws-{secrets.token_hex(4)}"
    tenant_id = uuid4()
    admin_id = uuid4()
    now = utcnow()
    await execute(
        session,
        """
        INSERT INTO tenants (id, code, display_name, status, created_at)
        VALUES (:id, :code, :name, 'ACTIVE', :now)
        """,
        {"id": tenant_id, "code": tenant_code, "name": workspace_name, "now": now},
    )
    await execute(
        session,
        """
        INSERT INTO admin_accounts (
            id, tenant_id, login, email, password_hash, locale, timezone, full_name, created_at
        )
        VALUES (
            :id, :tenant_id, :login, :email, :password_hash, :locale, :timezone, :full_name, :now
        )
        """,
        {
            "id": admin_id,
            "tenant_id": tenant_id,
            "login": login,
            "email": email,
            "password_hash": hash_password(body.password),
            "locale": body.locale,
            "timezone": body.timezone,
            "full_name": full_name,
            "now": now,
        },
    )
    for key, name, category in SYSTEM_TYPES:
        await execute(
            session,
            """
            INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision)
            VALUES (:id, :tenant_id, :key, :name, :category, '{}'::jsonb, TRUE, 1)
            """,
            {"id": uuid4(), "tenant_id": tenant_id, "key": key, "name": name, "category": category},
        )
    for code, inverse, acyclic, temporal in RELATION_TYPES:
        await execute(
            session,
            """
            INSERT INTO relation_types (
                id, tenant_id, code, inverse_label, from_categories, to_categories, acyclic, temporal
            ) VALUES (
                :id, :tenant_id, :code, :inverse, '[]'::jsonb, '[]'::jsonb, :acyclic, :temporal
            )
            """,
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "code": code,
                "inverse": inverse,
                "acyclic": acyclic,
                "temporal": temporal,
            },
        )
    for parent, child in CONTAINS_PAIRS:
        await execute(
            session,
            """
            INSERT INTO type_adjacency (tenant_id, relation_code, parent_type_key, child_type_key)
            VALUES (:tenant_id, 'CONTAINS', :parent, :child)
            """,
            {"tenant_id": tenant_id, "parent": parent, "child": child},
        )
    await audit(
        session,
        tenant_id=tenant_id,
        event_type="ADMIN_BOOTSTRAP",
        actor_id=admin_id,
        entity_type="admin",
        entity_id=admin_id,
        before=None,
        after={"login": login},
        correlation_id=uuid4().hex,
    )
    return {"tenant_id": str(tenant_id), "admin_id": str(admin_id), "login": login, "email": email}


async def _lock_status(session: AsyncSession, login: str) -> dict[str, Any] | None:
    return await fetch_one(session, "SELECT * FROM login_throttle WHERE login = :login", {"login": login})


def _as_datetime(value: Any) -> datetime:
    if isinstance(value, str):
        return datetime.fromisoformat(value)
    return value


async def login_admin(session: AsyncSession, settings: Settings, body: LoginIn) -> dict[str, str]:
    identifier = body.login.strip()
    by_email = "@" in identifier
    lookup = identifier.lower() if by_email else identifier
    now = utcnow()
    throttle = await _lock_status(session, lookup)
    if throttle and throttle["locked_until"] is not None:
        locked = throttle["locked_until"]
        locked = _as_datetime(locked)
        if locked > now:
            seconds = int((locked - now).total_seconds())
            raise AppError(
                429,
                "LOCKED",
                "Đăng nhập đang bị tạm khóa.",
                retryable=True,
                extra={"retry_after_seconds": max(seconds, 1)},
            )
    if by_email:
        account = await fetch_one(
            session,
            """
            SELECT id, tenant_id, login, email, password_hash, disabled_at
            FROM admin_accounts WHERE lower(email) = :email
            """,
            {"email": lookup},
        )
    else:
        account = await fetch_one(
            session,
            """
            SELECT id, tenant_id, login, email, password_hash, disabled_at
            FROM admin_accounts WHERE login = :login
            """,
            {"login": lookup},
        )
    ok = bool(account and account["disabled_at"] is None and verify_password(account["password_hash"], body.password))
    if not ok:
        await _record_failure(session, lookup, now)
        raise AppError(401, "INVALID_CREDENTIALS", "Đăng nhập không thành công.")
    await execute(session, "DELETE FROM login_throttle WHERE login = :login", {"login": lookup})
    session_token = new_token()
    csrf_token = new_token()
    session_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO sessions (id, admin_id, token_hash, csrf_hash, expires_at, created_at)
        VALUES (:id, :admin_id, :token_hash, :csrf_hash, :expires_at, :now)
        """,
        {
            "id": session_id,
            "admin_id": as_uuid(account["id"]),
            "token_hash": hash_token(session_token),
            "csrf_hash": hash_token(csrf_token),
            "expires_at": now + timedelta(minutes=settings.session_ttl_minutes),
            "now": now,
        },
    )
    await audit(
        session,
        tenant_id=as_uuid(account["tenant_id"]),
        event_type="AUTH_LOGIN",
        actor_id=as_uuid(account["id"]),
        entity_type="session",
        entity_id=session_id,
        before=None,
        after={"login": account["login"]},
        correlation_id=uuid4().hex,
    )
    return {"session_token": session_token, "csrf_token": csrf_token}


async def _record_failure(session: AsyncSession, login: str, now: Any) -> None:
    """Commit lockout state outside the request transaction, which rolls back on 401."""
    del session
    from factorix.platform.db import session_factory

    factory = session_factory()
    async with factory() as extra:
        current = await _lock_status(extra, login)
        window_started = current["window_started"] if current else None
        if isinstance(window_started, str):
            from datetime import datetime

            window_started = datetime.fromisoformat(window_started)
        if current is None or window_started is None or (now - window_started) > timedelta(minutes=WINDOW_MINUTES):
            await execute(
                extra,
                """
                INSERT INTO login_throttle (login, failed_count, window_started, locked_until)
                VALUES (:login, 1, :now, NULL)
                ON CONFLICT (login) DO UPDATE
                SET failed_count = 1, window_started = :now, locked_until = NULL
                """,
                {"login": login, "now": now},
            )
        else:
            failed = int(current["failed_count"]) + 1
            locked_until = now + timedelta(minutes=LOCK_MINUTES) if failed >= LOCK_AFTER else None
            await execute(
                extra,
                """
                UPDATE login_throttle
                SET failed_count = :failed, locked_until = :locked_until
                WHERE login = :login
                """,
                {"login": login, "failed": failed, "locked_until": locked_until},
            )
        await extra.commit()


async def principal_from_token(session: AsyncSession, token: str | None) -> dict[str, Any]:
    if not token:
        raise AppError(401, "UNAUTHENTICATED", "Cần đăng nhập.")
    row = await fetch_one(
        session,
        """
        SELECT s.id AS session_id, s.csrf_hash, s.expires_at, s.revoked_at,
               a.id AS admin_id, a.tenant_id, a.login, a.email, a.locale, a.timezone,
               a.full_name, a.disabled_at
        FROM sessions s
        JOIN admin_accounts a ON a.id = s.admin_id
        WHERE s.token_hash = :token_hash
        """,
        {"token_hash": hash_token(token)},
    )
    if row is None or row["revoked_at"] is not None or row["disabled_at"] is not None:
        raise AppError(401, "UNAUTHENTICATED", "Phiên không hợp lệ.")
    expires = row["expires_at"]
    if isinstance(expires, str):
        from datetime import datetime

        expires = datetime.fromisoformat(expires)
    if expires <= utcnow():
        raise AppError(401, "SESSION_EXPIRED", "Phiên đã hết hạn.")
    return row


def assert_csrf(header_token: str | None, csrf_hash: str) -> None:
    if not header_token or not tokens_equal(csrf_hash, header_token):
        raise AppError(403, "CSRF", "Thiếu hoặc sai mã CSRF.")


async def execute_logout(session: AsyncSession, session_id: UUID) -> None:
    await execute(
        session,
        "UPDATE sessions SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL",
        {"now": utcnow(), "id": session_id},
    )


async def touch_me(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "admin_id": row["admin_id"],
        "tenant_id": row["tenant_id"],
        "login": row["login"],
        "email": row.get("email") or "",
        "full_name": row.get("full_name") or row["login"],
        "locale": row["locale"],
        "timezone": row["timezone"],
        "role": "admin",
    }


_ACCEPTED = {"status": "accepted"}


async def request_password_reset(session: AsyncSession, body: ForgotIn, mailer: ResetMailer) -> dict[str, str]:
    """Always the same response. The code is never returned and unknown emails are not disclosed."""
    try:
        email = validate_email(body.email)
    except PasswordPolicyError:
        return dict(_ACCEPTED)
    account = await fetch_one(
        session,
        """
        SELECT id, tenant_id, disabled_at FROM admin_accounts WHERE lower(email) = :email
        """,
        {"email": email},
    )
    if account is None or account["disabled_at"] is not None:
        return dict(_ACCEPTED)
    now = utcnow()
    recent = await fetch_one(
        session,
        """
        SELECT COUNT(*) AS sent, MAX(created_at) AS latest
        FROM password_reset_codes
        WHERE admin_id = :admin_id AND created_at > :since
        """,
        {"admin_id": as_uuid(account["id"]), "since": now - timedelta(minutes=WINDOW_MINUTES)},
    )
    if recent and int(recent["sent"] or 0) >= RESET_ATTEMPTS:
        return dict(_ACCEPTED)
    latest = recent["latest"] if recent else None
    if latest is not None and (now - _as_datetime(latest)) < timedelta(seconds=60):
        return dict(_ACCEPTED)
    code = f"{secrets.randbelow(1_000_000):06d}"
    code_id = uuid4()
    await execute(
        session,
        """
        UPDATE password_reset_codes
        SET consumed_at = :now
        WHERE admin_id = :admin_id AND consumed_at IS NULL
        """,
        {"now": now, "admin_id": as_uuid(account["id"])},
    )
    await execute(
        session,
        """
        INSERT INTO password_reset_codes (id, admin_id, code_hash, expires_at, attempts, created_at)
        VALUES (:id, :admin_id, :code_hash, :expires_at, 0, :now)
        """,
        {
            "id": code_id,
            "admin_id": as_uuid(account["id"]),
            "code_hash": hash_token(code),
            "expires_at": now + timedelta(minutes=RESET_MINUTES),
            "now": now,
        },
    )
    await audit(
        session,
        tenant_id=as_uuid(account["tenant_id"]),
        event_type="AUTH_RESET_REQUESTED",
        actor_id=as_uuid(account["id"]),
        entity_type="admin",
        entity_id=as_uuid(account["id"]),
        before=None,
        after={"channel": "email"},
        correlation_id=uuid4().hex,
    )
    try:
        mailer.send_code(email, code)
    except AppError:
        await execute(session, "DELETE FROM password_reset_codes WHERE id = :id", {"id": code_id})
        return dict(_ACCEPTED)
    return dict(_ACCEPTED)


async def confirm_password_reset(session: AsyncSession, body: ResetIn) -> dict[str, str]:
    try:
        email = validate_email(body.email)
    except PasswordPolicyError as exc:
        raise AppError(401, "INVALID_CODE", "Mã không đúng hoặc đã hết hạn.") from exc
    account = await fetch_one(
        session,
        """
        SELECT id, tenant_id, login, password_hash, disabled_at
        FROM admin_accounts WHERE lower(email) = :email
        """,
        {"email": email},
    )
    if account is None or account["disabled_at"] is not None:
        raise AppError(401, "INVALID_CODE", "Mã không đúng hoặc đã hết hạn.")
    now = utcnow()
    row = await fetch_one(
        session,
        """
        SELECT id, code_hash, expires_at, attempts
        FROM password_reset_codes
        WHERE admin_id = :admin_id AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        """,
        {"admin_id": as_uuid(account["id"])},
    )
    code = body.code.strip()
    expired = row is None or _as_datetime(row["expires_at"]) <= now
    exhausted = row is not None and int(row["attempts"]) >= RESET_ATTEMPTS
    matched = bool(row) and (not expired) and (not exhausted) and len(code) == 6 and code.isdigit() and tokens_equal(str(row["code_hash"]), code)
    if not matched:
        if row is not None and not expired and not exhausted and code.isdigit() and len(code) == 6:
            await _note_reset_failure(as_uuid(row["id"]))
        raise AppError(401, "INVALID_CODE", "Mã không đúng hoặc đã hết hạn.")
    try:
        validate_password(body.new_password, str(account["login"]))
    except PasswordPolicyError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    await execute(
        session,
        "UPDATE admin_accounts SET password_hash = :password_hash WHERE id = :id",
        {"password_hash": hash_password(body.new_password), "id": as_uuid(account["id"])},
    )
    await execute(
        session,
        """
        UPDATE password_reset_codes
        SET consumed_at = :now
        WHERE admin_id = :admin_id AND consumed_at IS NULL
        """,
        {"now": now, "admin_id": as_uuid(account["id"])},
    )
    await audit(
        session,
        tenant_id=as_uuid(account["tenant_id"]),
        event_type="AUTH_RESET_COMPLETED",
        actor_id=as_uuid(account["id"]),
        entity_type="admin",
        entity_id=as_uuid(account["id"]),
        before=None,
        after={"login": account["login"]},
        correlation_id=uuid4().hex,
    )
    return {"status": "updated"}


async def _note_reset_failure(code_id: UUID) -> None:
    from factorix.platform.db import session_factory

    factory = session_factory()
    async with factory() as extra:
        await execute(
            extra,
            "UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = :id AND consumed_at IS NULL",
            {"id": code_id},
        )
        await extra.commit()


def require_bootstrap_token(settings: Settings, presented: str | None) -> None:
    expected = settings.bootstrap_token
    if settings.environment == "development" and not expected:
        return
    if not expected or not presented:
        raise AppError(403, "BOOTSTRAP_DISABLED", "Khởi tạo quản trị viên chưa được mở.")
    import hmac

    if not hmac.compare_digest(expected, presented):
        raise AppError(403, "BOOTSTRAP_DENIED", "Mã khởi tạo không đúng.")


def safe_settings_view() -> dict[str, Any]:
    return {"users_roles_editor": False, "ot_writes": False, "demo_seed": False}


async def revert_to_zero(session: AsyncSession) -> int:
    """Delete every tenant row, including the administrator. Schema and migrations stay."""
    names = await fetch_all(
        session,
        """
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> 'alembic_version'
        ORDER BY tablename
        """,
        {},
    )
    if not names:
        return 0
    quoted = ", ".join(f'"{row["tablename"]}"' for row in names)
    await execute(session, f"TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE", {})
    return len(names)
