"""Application errors. Raising rolls the request transaction back."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        field_errors: list[dict[str, str]] | None = None,
        retryable: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field_errors = field_errors or []
        self.retryable = retryable
        self.extra = extra or {}
