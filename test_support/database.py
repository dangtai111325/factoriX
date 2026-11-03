"""Guard destructive suites even when nested pytest conftest modules are loaded."""

import os
import re
from urllib.parse import unquote, urlsplit


def validate_disposable_database_url(url: str) -> str:
    parsed = urlsplit(url)
    name = unquote(parsed.path.lstrip("/"))
    if parsed.scheme != "postgresql+asyncpg" or not re.fullmatch(r"[A-Za-z0-9_]+_test", name):
        raise ValueError("Provide an explicitly disposable PostgreSQL database ending in _test.")
    return url


def require_disposable_database(actual_url: str) -> None:
    target = os.environ.get("FACTORIX_TEST_DATABASE_URL", "")
    if not target or validate_disposable_database_url(target) != actual_url:
        raise RuntimeError("Destructive tests require FACTORIX_TEST_DATABASE_URL matching the active disposable database.")
