"""Repository test configuration; destructive suites require an explicit test DB."""

import os

import pytest
from test_support.database import validate_disposable_database_url


def pytest_configure(config):
    target = os.environ.get("FACTORIX_TEST_DATABASE_URL")
    if target:
        try:
            os.environ["FACTORIX_DATABASE_URL"] = validate_disposable_database_url(target)
        except ValueError as exc:
            raise pytest.UsageError(str(exc)) from exc
        os.environ["FACTORIX_ENVIRONMENT"] = "test"
        os.environ["FACTORIX_BOOTSTRAP_TOKEN"] = "integration-bootstrap-token"
        os.environ["FACTORIX_APPLIANCE"] = "false"
        os.environ["FACTORIX_DATA_DIR"] = ""
        os.environ["FACTORIX_SMTP_HOST"] = ""
        os.environ.setdefault("FACTORIX_DATA_KEY", "factorix-disposable-test-key-2026-0001")


def pytest_collection_modifyitems(config, items):
    for item in items:
        path = str(item.path).replace("\\", "/")
        if ("/tests/integration/" in path or path.endswith("test_edge_cycle.py")) and not os.environ.get("FACTORIX_TEST_DATABASE_URL"):
            item.add_marker(pytest.mark.skip(reason="Requires an explicit disposable FACTORIX_TEST_DATABASE_URL; live appliance DB is protected."))
        if "/tests/protocol/" in path and os.environ.get("FACTORIX_RUN_LAB_READS") != "1":
            item.add_marker(pytest.mark.skip(reason="External lab reads are opt-in via FACTORIX_RUN_LAB_READS=1."))
