"""R1-25 / R1-45: one-request boot (/auth/status carries the session user) and compressed static assets."""

from __future__ import annotations

import asyncio
import gzip
from typing import Any

from starlette.requests import Request

from factorix.platform.errors import AppError
from factorix.transport import app as app_mod


def _request(cookie: str | None) -> Request:
    headers = [(b"cookie", f"{app_mod.SESSION_COOKIE}={cookie}".encode())] if cookie else []
    return Request({"type": "http", "method": "GET", "path": "/api/v1/auth/status", "headers": headers, "query_string": b""})


def _patch(monkeypatch: Any, principal: Any) -> None:
    async def fake_fetch_one(_session: Any, _sql: str, _params: dict[str, Any]) -> dict[str, Any]:
        return {"id": "a1"}

    async def fake_principal(_session: Any, token: str | None) -> dict[str, Any]:
        if isinstance(principal, Exception):
            raise principal
        assert token == "tok"
        return principal

    monkeypatch.setattr(app_mod, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(app_mod, "principal_from_token", fake_principal)


def test_auth_status_without_cookie_has_no_user_and_no_401(monkeypatch: Any) -> None:
    _patch(monkeypatch, AppError(401, "UNAUTHENTICATED", "x"))
    body = asyncio.run(app_mod.auth_status(_request(None), session=None))  # type: ignore[arg-type]
    assert body["user"] is None
    assert body["admin_exists"] is True


def test_auth_status_with_invalid_cookie_is_guest(monkeypatch: Any) -> None:
    _patch(monkeypatch, AppError(401, "SESSION_EXPIRED", "x"))
    body = asyncio.run(app_mod.auth_status(_request("tok"), session=None))  # type: ignore[arg-type]
    assert body["user"] is None


def test_auth_status_with_session_returns_me_body(monkeypatch: Any) -> None:
    row = {"admin_id": "u1", "tenant_id": "t1", "login": "op", "email": "", "full_name": None, "locale": "en", "timezone": "UTC"}
    _patch(monkeypatch, row)
    body = asyncio.run(app_mod.auth_status(_request("tok"), session=None))  # type: ignore[arg-type]
    assert body["user"] == asyncio.run(app_mod.touch_me(row))
    assert body["user"]["login"] == "op"


def test_gzipped_assets_round_trip_and_skip_tiny(tmp_path: Any) -> None:
    big = tmp_path / "index-abc.js"
    big.write_text("console.log('x');\n" * 500, encoding="utf-8")
    tiny = tmp_path / "t.css"
    tiny.write_text("a{}", encoding="utf-8")
    packed = app_mod._gzipped(str(big), big.stat().st_mtime_ns)
    assert packed is not None and len(packed) < big.stat().st_size
    assert gzip.decompress(packed) == big.read_bytes()
    assert app_mod._gzipped(str(tiny), tiny.stat().st_mtime_ns) is None
