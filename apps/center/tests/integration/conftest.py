"""Shared integration test fixtures and structural production-safety guards (§16.3)."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import pytest

from factorix.domain.network import NetworkPolicyError

_REPO_ROOT = str(Path(__file__).resolve().parents[4])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tests.integration_guard import delete_test_topology, refuse_production_targets  # noqa: E402


def _load_test_env_defaults() -> None:
    repo_root = Path(__file__).resolve().parents[4]
    env_test = repo_root / ".env.test.example"
    if not env_test.is_file():
        return
    for raw_line in env_test.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


_load_test_env_defaults()


def assert_isolated_test_environment() -> None:
    """Structural refusal if any integration test points at a non-test database or production environment."""
    env_name = os.environ.get("FACTORIX_ENVIRONMENT", "").strip().lower()
    if env_name != "test":
        raise RuntimeError(f"Integration tests refused: FACTORIX_ENVIRONMENT={env_name!r} != 'test'.")
    if os.environ.get("FACTORIX_ENABLE_DESTRUCTIVE_TESTS") != "YES_I_USE_EPHEMERAL_DB":
        raise RuntimeError("Integration tests refused: FACTORIX_ENABLE_DESTRUCTIVE_TESTS guard missing.")
    db_url = os.environ.get("FACTORIX_DATABASE_URL", "")
    parsed = urlparse(db_url)
    db_name = parsed.path.lstrip("/").lower()
    if db_name not in {"factorix_test", "factorix_ci", "test_db"} and not db_name.endswith(("_test", "-test")):
        raise RuntimeError(f"Integration tests refused: database {db_name!r} is not an authorized test database.")
    db_host = (parsed.hostname or "").lower()
    if db_host and db_host not in {"127.0.0.1", "localhost", "postgres-test", "factorix-pg-test"}:
        raise RuntimeError(f"Integration tests refused: PostgreSQL host {db_host!r} is not the isolated test database.")
    rmq_url = os.environ.get("FACTORIX_RABBITMQ_URL", "")
    if rmq_url:
        rmq_host = (urlparse(rmq_url).hostname or "").lower()
        if rmq_host not in {"127.0.0.1", "localhost", "rabbitmq-test", "factorix-rmq-test"}:
            raise RuntimeError(f"Integration tests refused: RabbitMQ host {rmq_host!r} is not isolated test broker.")
    mgmt_url = os.environ.get("FACTORIX_RABBITMQ_MGMT_URL", "")
    if mgmt_url:
        mgmt_host = (urlparse(mgmt_url).hostname or "").lower()
        if mgmt_host not in {"127.0.0.1", "localhost", "rabbitmq-test", "factorix-rmq-test"}:
            raise RuntimeError(f"Integration tests refused: RabbitMQ management host {mgmt_host!r} is not the test broker.")
    td_dsn = os.environ.get("FACTORIX_TDENGINE_DSN", "")
    if td_dsn:
        td_host = (urlparse(td_dsn).hostname or "").lower()
        if td_host not in {"127.0.0.1", "localhost", "tdengine-test", "factorix-td-test"}:
            raise RuntimeError(f"Integration tests refused: TDengine host {td_host!r} is not isolated test DB.")


def pytest_configure(config: pytest.Config) -> None:
    """L-05: stop the whole run (``pytest.exit``) before collection if a target is the production appliance."""
    refuse_production_targets()


@pytest.fixture(scope="session", autouse=True)
def _verify_test_isolation():  # type: ignore[no-untyped-def]
    refuse_production_targets()
    assert_isolated_test_environment()
    yield
    # Leftover ``fxtest.*`` queues / exchanges (a test that crashed before its own cleanup) go with the session.
    delete_test_topology(
        os.environ.get("FACTORIX_RABBITMQ_URL", ""),
        os.environ.get("FACTORIX_RABBITMQ_MGMT_URL", "http://127.0.0.1:15672"),
    )


# Keep NetworkPolicyError imported cleanly for safety checks if needed
__all__ = ["NetworkPolicyError", "assert_isolated_test_environment"]


def pytest_collection_modifyitems(config, items):  # type: ignore[no-untyped-def]
    """R2-E B9: every test under this folder carries the ``integration`` marker (``pytest -m integration``)."""
    import pytest as _pytest

    here = Path(__file__).resolve().parent
    for item in items:
        if Path(str(item.fspath)).resolve().is_relative_to(here):
            item.add_marker(_pytest.mark.integration)
