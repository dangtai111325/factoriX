"""A test invocation must never authorize truncating a normal appliance DB."""

import pytest

from test_support.database import validate_disposable_database_url


@pytest.mark.parametrize("url", [
    "postgresql+asyncpg://tester:password@127.0.0.1/factorix",
    "postgresql+asyncpg://tester:password@127.0.0.1/postgres",
    "postgresql+asyncpg://tester:password@127.0.0.1/not_test_but_live",
    "sqlite:///factorix_test",
])
def test_refuses_non_disposable_database(url):
    with pytest.raises(ValueError, match="disposable"):
        validate_disposable_database_url(url)


def test_accepts_explicitly_named_test_database():
    url = "postgresql+asyncpg://tester:password@127.0.0.1/factorix_test"
    assert validate_disposable_database_url(url) == url
