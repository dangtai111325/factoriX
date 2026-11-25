"""L-05: the integration conftests refuse production targets (``tests/integration_guard.py``)."""

from __future__ import annotations

from pathlib import Path

import pytest

from factorix.platform.broker import BrokerConfig
from tests import integration_guard as G

# What .github/workflows/ci.yml (storage-integration) and the CI replica on the private network use.
CI_ENV = {
    "FACTORIX_ENVIRONMENT": "test",
    "FACTORIX_DATABASE_URL": "postgresql+asyncpg://test:test@127.0.0.1:5432/factorix_test",
    "FACTORIX_RABBITMQ_URL": "amqp://factorix_mq:factorix-mq-pw@127.0.0.1:5672/",
    "FACTORIX_RABBITMQ_MGMT_URL": "http://127.0.0.1:15672",
    "FACTORIX_TDENGINE_DSN": "ws://root:taosdata@127.0.0.1:6041",
}
REPLICA_ENV = {
    "FACTORIX_DATABASE_URL": "postgresql+asyncpg://test:test@postgres-test:5432/factorix_test",
    "FACTORIX_RABBITMQ_URL": "amqp://factorix_mq:factorix-mq-pw@rabbitmq-test:5672/",
    "FACTORIX_RABBITMQ_MGMT_URL": "http://rabbitmq-test:15672",
    "FACTORIX_TDENGINE_DSN": "ws://root:taosdata@tdengine-test:6041",
}
# docker-compose.test.yml through .env.test.example
COMPOSE_TEST_ENV = {
    "FACTORIX_DATABASE_URL": "postgresql+asyncpg://factorix_test:pw@127.0.0.1:15432/factorix_test",
    "FACTORIX_RABBITMQ_URL": "amqp://factorix_mq_test:pw@127.0.0.1:15673/",
    "FACTORIX_TDENGINE_DSN": "ws://root:taosdata@127.0.0.1:16041",
    "FACTORIX_TDENGINE_DB": "factorix_test_ts",
}


@pytest.fixture()
def no_dotenv(tmp_path: Path) -> Path:
    return tmp_path / "absent.env"


@pytest.mark.parametrize("env", [CI_ENV, REPLICA_ENV, COMPOSE_TEST_ENV], ids=["ci", "replica", "compose-test"])
def test_test_stacks_pass_the_static_checks(env: dict[str, str], no_dotenv: Path) -> None:
    assert G.production_target_problems(G.effective_targets(env, no_dotenv)) == []


@pytest.mark.parametrize(
    ("var", "value", "needle"),
    [
        ("FACTORIX_DATABASE_URL", "postgresql+asyncpg://factorix:x@factorix-postgres:5432/factorix_test", "factorix-postgres"),
        ("FACTORIX_DATABASE_URL", "postgresql+asyncpg://factorix:x@127.0.0.1:5432/factorix", "production database 'factorix'"),
        ("FACTORIX_RABBITMQ_URL", "amqp://factorix_mq:x@factorix-rabbitmq:5672/", "factorix-rabbitmq"),
        ("FACTORIX_RABBITMQ_MGMT_URL", "http://factorix-rabbitmq:15672", "factorix-rabbitmq"),
        ("FACTORIX_TDENGINE_DSN", "ws://root:x@factorix-tdengine:6041", "factorix-tdengine"),
        ("FACTORIX_TDENGINE_DB", "factorix_ts", "production database 'factorix_ts'"),
    ],
)
def test_production_defaults_are_refused(var: str, value: str, needle: str, no_dotenv: Path) -> None:
    problems = G.production_target_problems(G.effective_targets({**CI_ENV, var: value}, no_dotenv))
    assert len(problems) == 1 and needle in problems[0], problems


def test_dotenv_of_the_working_directory_counts_when_the_variable_is_unset(tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("# appliance\nFACTORIX_RABBITMQ_MGMT_URL=http://factorix-rabbitmq:15672\n", encoding="utf-8")
    env = {k: v for k, v in CI_ENV.items() if k != "FACTORIX_RABBITMQ_MGMT_URL"}
    assert G.production_target_problems(G.effective_targets(env, dotenv)) != []
    # the environment wins over the file, as in pydantic-settings
    assert G.production_target_problems(G.effective_targets(CI_ENV, dotenv)) == []


def test_live_broker_with_production_consumers_is_refused(monkeypatch: pytest.MonkeyPatch, no_dotenv: Path) -> None:
    seen: list[str] = []

    async def consumed(url: str, _timeout: float) -> list[str]:
        seen.append(url)
        return ["factorix.telemetry.ingest.q has 2 consumer(s)"]

    monkeypatch.setattr(G, "_consumed_production_queues", consumed)
    reasons = G.refusal_reasons(CI_ENV, dotenv=no_dotenv)
    assert seen == [CI_ENV["FACTORIX_RABBITMQ_URL"]]
    assert reasons and "running FactoriX" in reasons[0]


def test_opt_in_skips_every_check(monkeypatch: pytest.MonkeyPatch, no_dotenv: Path) -> None:
    async def boom(_url: str, _timeout: float) -> list[str]:
        raise AssertionError("no probe with the opt-in")

    monkeypatch.setattr(G, "_consumed_production_queues", boom)
    env = {**CI_ENV, "FACTORIX_DATABASE_URL": "postgresql+asyncpg://f:x@factorix-postgres:5432/factorix", G.OPT_IN_ENV: G.OPT_IN_VALUE}
    assert G.refusal_reasons(env, dotenv=no_dotenv) == []
    env[G.OPT_IN_ENV] = "1"  # anything but the exact value is not an opt-in
    assert G.refusal_reasons(env, probe=False, dotenv=no_dotenv) != []


def test_static_refusal_does_not_probe(monkeypatch: pytest.MonkeyPatch, no_dotenv: Path) -> None:
    async def boom(_url: str, _timeout: float) -> list[str]:
        raise AssertionError("refused before any network call")

    monkeypatch.setattr(G, "_consumed_production_queues", boom)
    assert G.refusal_reasons({**CI_ENV, "FACTORIX_RABBITMQ_URL": "amqp://u:p@factorix-rabbitmq/"}, dotenv=no_dotenv)


def test_refuse_production_targets_exits_pytest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(G, "_VERDICT", ["FACTORIX_DATABASE_URL points at the production host 'factorix-postgres'"])
    with pytest.raises(pytest.exit.Exception) as exc:
        G.refuse_production_targets()
    assert "refused" in str(exc.value) and G.OPT_IN_ENV in str(exc.value)
    monkeypatch.setattr(G, "_VERDICT", [])
    G.refuse_production_targets()  # allowed: no exit


def test_unreachable_broker_is_not_a_refusal() -> None:
    assert G.broker_problems("amqp://u:p@127.0.0.1:1/", timeout_s=0.5) == []


def test_test_topology_cannot_collide_with_production_names() -> None:
    names = G.isolated_topology_names("broker", "abc123")
    cfg = BrokerConfig(amqp_url="amqp://localhost/", **names)
    production = BrokerConfig(amqp_url="amqp://localhost/")
    every = [*names.values(), cfg.live_queue_name]
    assert all(n.startswith(G.TEST_TOPOLOGY_PREFIX) for n in every), every
    assert cfg.live_queue_name == "fxtest.broker.live.q.abc123"
    prod_names = {production.queue_name, production.live_queue_name, production.dlq_name, production.exchange_name, production.dlx_name}
    assert not any(p.startswith(G.TEST_TOPOLOGY_PREFIX) for p in prod_names)
    assert set(G.PRODUCTION_QUEUES) == {production.queue_name, production.live_queue_name}


def test_cleanup_only_deletes_the_test_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    calls: list[tuple[str, str]] = []
    listing = {
        "queues": [{"name": "factorix.telemetry.ingest.q"}, {"name": "fxtest.s06.ingest.q.1"}, {"name": "fxtest.s06.live.q.1"}],
        "exchanges": [{"name": ""}, {"name": "factorix.telemetry.ingress"}, {"name": "fxtest.s06.ingress.1"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        raw = request.url.raw_path.decode().split("?")[0]
        calls.append((request.method, raw))
        parts = raw.split("/")  # /api/<kind>/<vhost>[/<name>]
        if request.method == "GET":
            return httpx.Response(200, json=listing[parts[2]])
        return httpx.Response(204)

    real_client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    deleted = G.delete_test_topology("amqp://u:p@rabbitmq-test:5672/", "http://rabbitmq-test:15672")
    assert deleted == ["fxtest.s06.ingest.q.1", "fxtest.s06.live.q.1", "fxtest.s06.ingress.1"]
    assert all("factorix." not in path for method, path in calls if method == "DELETE")
    assert ("DELETE", "/api/queues/%2F/fxtest.s06.ingest.q.1") in calls  # vhost "/" of the amqp URL
