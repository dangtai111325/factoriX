"""Safety tests ensuring destructive operations are strictly guarded against non-test databases."""

import pytest
from urllib.parse import urlparse


def check_destructive_test_db_guard(database_url: str, enable_flag: str | None) -> None:
    """Validate that destructive actions can only run on disposable test databases."""
    if enable_flag != "YES_I_USE_EPHEMERAL_DB":
        pytest.fail(
            "Destructive test execution refused: FACTORIX_ENABLE_DESTRUCTIVE_TESTS != 'YES_I_USE_EPHEMERAL_DB'"
        )
    parsed = urlparse(database_url)
    db_name = parsed.path.lstrip("/").lower()
    allowed_suffixes = ("_test", "-test", "_ephemeral", "-ephemeral")
    allowed_names = ("factorix_test", "factorix_ci", "test_db", "ephemeral")
    if not (any(db_name.endswith(suffix) for suffix in allowed_suffixes) or db_name in allowed_names):
        pytest.fail(
            f"Destructive test execution refused: database '{db_name}' is not an authorized test database."
        )


def test_destructive_guard_rejects_missing_flag():
    with pytest.raises(pytest.fail.Exception, match="FACTORIX_ENABLE_DESTRUCTIVE_TESTS"):
        check_destructive_test_db_guard("postgresql+asyncpg://user:pass@localhost:5432/factorix_test", None)


def test_destructive_guard_rejects_production_db_name():
    with pytest.raises(pytest.fail.Exception, match="not an authorized test database"):
        check_destructive_test_db_guard(
            "postgresql+asyncpg://user:pass@localhost:5432/factorix",
            "YES_I_USE_EPHEMERAL_DB",
        )


def test_destructive_guard_accepts_test_db_name_and_flag():
    # Should not raise
    check_destructive_test_db_guard(
        "postgresql+asyncpg://user:pass@localhost:5432/factorix_test",
        "YES_I_USE_EPHEMERAL_DB",
    )
