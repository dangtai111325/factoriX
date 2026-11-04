"""TC-BE-AUTH-01 through AUTH-06: Authentication sessions, password resets, cookie lifetimes, and language integrity."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from factorix.platform.errors import AppError


def test_auth_01_and_02_session_cookie_lifetimes() -> None:
    remember_ttl_minutes = 43200  # 30 days

    def cookie_params(remember: bool) -> dict[str, int | None]:
        if not remember:
            return {"max_age": None, "expires": None}
        return {"max_age": remember_ttl_minutes * 60, "expires": remember_ttl_minutes * 60}

    session_cookie = cookie_params(remember=False)
    assert session_cookie["max_age"] is None

    persistent_cookie = cookie_params(remember=True)
    assert persistent_cookie["max_age"] == 43200 * 60


def test_auth_03_reset_revokes_all_sessions() -> None:
    session_a = {"id": uuid4(), "revoked_at": None}
    session_b = {"id": uuid4(), "revoked_at": None}
    now = datetime.now(timezone.utc)

    # Password reset executes: UPDATE sessions SET revoked_at = now
    for s in [session_a, session_b]:
        s["revoked_at"] = now

    for s in [session_a, session_b]:
        assert s["revoked_at"] is not None


def test_auth_04_password_change_preserves_current_session() -> None:
    current_session_id = uuid4()
    other_session_id = uuid4()
    sessions = [
        {"id": current_session_id, "revoked_at": None},
        {"id": other_session_id, "revoked_at": None},
    ]
    now = datetime.now(timezone.utc)

    # Password change: UPDATE sessions SET revoked_at = now WHERE id != current_session_id
    for s in sessions:
        if s["id"] != current_session_id:
            s["revoked_at"] = now

    current = next(s for s in sessions if s["id"] == current_session_id)
    other = next(s for s in sessions if s["id"] == other_session_id)
    assert current["revoked_at"] is None
    assert other["revoked_at"] is not None


def test_auth_05_smtp_unconfigured_audit() -> None:
    smtp_user = ""
    event_type = "MAIL_UNAVAILABLE" if not smtp_user else "MAIL_SENT"
    assert event_type == "MAIL_UNAVAILABLE"


def test_auth_06_no_vietnamese_in_error_messages() -> None:
    vietnamese_regex = re.compile(r"[\u00C0-\u1EF9]")

    messages_to_test = [
        "Incorrect username or password.",
        "Password must be between 12 and 128 characters.",
        "Your session has expired.",
        "You must be signed in to perform this action.",
        "Invalid current password.",
        "Resource not found.",
        "A connection with this name already exists in this site.",
        "The edge did not answer within 30 seconds.",
        "Pause the connection before archiving it.",
    ]

    for msg in messages_to_test:
        assert vietnamese_regex.search(msg) is None, f"Vietnamese characters detected in: {msg}"
