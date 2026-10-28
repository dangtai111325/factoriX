"""HTTP error contract and request context."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


def error_body(
    code: str,
    message: str,
    *,
    correlation_id: str,
    field_errors: list[dict[str, str]] | None = None,
    retryable: bool = False,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "error": {
            "code": code,
            "message": message,
            "field_errors": field_errors or [],
            "correlation_id": correlation_id,
            "retryable": retryable,
        }
    }
    if extra:
        payload["error"].update(extra)
    return payload


def json_error(
    status: int,
    code: str,
    message: str,
    *,
    correlation_id: str | None = None,
    field_errors: list[dict[str, str]] | None = None,
    retryable: bool = False,
    headers: dict[str, str] | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    cid = correlation_id or uuid.uuid4().hex
    return JSONResponse(
        status_code=status,
        content=error_body(
            code,
            message,
            correlation_id=cid,
            field_errors=field_errors,
            retryable=retryable,
            extra=extra,
        ),
        headers=headers,
    )


def correlation_id(request: Request) -> str:
    return getattr(request.state, "correlation_id", uuid.uuid4().hex)
