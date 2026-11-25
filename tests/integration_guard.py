"""L-05: integration tests refuse to run against a production PostgreSQL / RabbitMQ / TDengine.

Used by ``apps/center/tests/integration/conftest.py`` and ``apps/acquisition/tests/integration/conftest.py``
(``pytest_configure``): before any test is collected the run stops with ``pytest.exit`` when a target looks like
the production appliance:

* a host that is a production service name (``factorix-postgres``, ``factorix-rabbitmq``, ``factorix-tdengine``,
  ``factorix-appliance`` - the docker-compose.yml hostnames);
* the production database names (PostgreSQL ``factorix``, TDengine ``factorix_ts``);
* a broker on which something already consumes the production queues (``factorix.telemetry.ingest.q`` /
  ``factorix.telemetry.live.q``): a running FactoriX is attached to it. URL checks alone cannot tell the CI broker
  (``127.0.0.1:5672``, vhost ``/``, user ``factorix_mq``) from the appliance's, which uses the same values, so the
  broker is asked. An unreachable broker is not refused here (the tests then fail on their own).

The values checked are the ones the tests use: the environment first, then ``.env`` in the working directory
(pydantic-settings reads that file too). ``FACTORIX_TEST_ALLOW_PRODUCTION_TARGETS=YES_THIS_IS_NOT_PRODUCTION`` opts
out (e.g. an isolated copy of the appliance compose that reuses its hostnames).

Test topology: every queue / exchange the integration tests declare is named ``fxtest.<suite>.<kind>.<hex>``
(``TEST_TOPOLOGY_PREFIX``), which cannot collide with the production ``factorix.*`` names or with a policy
pattern written for them; ``delete_test_topology`` removes leftovers at the end of the session.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

OPT_IN_ENV = "FACTORIX_TEST_ALLOW_PRODUCTION_TARGETS"
OPT_IN_VALUE = "YES_THIS_IS_NOT_PRODUCTION"

PRODUCTION_HOSTS = frozenset({"factorix-postgres", "factorix-rabbitmq", "factorix-tdengine", "factorix-appliance", "factorix"})
PRODUCTION_PG_DATABASES = frozenset({"factorix"})
PRODUCTION_TD_DATABASES = frozenset({"factorix_ts"})
PRODUCTION_QUEUES = ("factorix.telemetry.ingest.q", "factorix.telemetry.live.q")
TEST_TOPOLOGY_PREFIX = "fxtest."

TARGET_VARS = (
    "FACTORIX_DATABASE_URL",
    "FACTORIX_RABBITMQ_URL",
    "FACTORIX_RABBITMQ_MGMT_URL",
    "FACTORIX_TDENGINE_DSN",
    "FACTORIX_TDENGINE_DB",
)


def isolated_topology_names(suite: str, suffix: str) -> dict[str, str]:
    """Exchange / queue names of one isolated test topology (``BrokerConfig`` keyword arguments).

    The live queue is derived by ``BrokerConfig`` (``.ingest.q`` -> ``.live.q``), so it carries the prefix too.
    """
    base = f"{TEST_TOPOLOGY_PREFIX}{suite}"
    return {
        "exchange_name": f"{base}.ingress.{suffix}",
        "queue_name": f"{base}.ingest.q.{suffix}",
        "dlx_name": f"{base}.dlx.{suffix}",
        "dlq_name": f"{base}.dlq.{suffix}",
    }


def _read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        out[key] = value.strip().strip("'\"")
    return out


def effective_targets(environ: Mapping[str, str] | None = None, dotenv: Path | None = None) -> dict[str, str]:
    """The target URLs the tests will use: environment first, then ``.env`` of the working directory."""
    env = os.environ if environ is None else environ
    file_values = _read_dotenv(dotenv if dotenv is not None else Path.cwd() / ".env")
    out: dict[str, str] = {}
    for name in TARGET_VARS:
        value = env.get(name)
        if value is None:
            value = file_values.get(name)
        if value:
            out[name] = value.strip()
    return out


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def production_target_problems(targets: Mapping[str, str]) -> list[str]:
    """Static checks (no network): production hostnames and database names."""
    problems: list[str] = []
    for name in ("FACTORIX_DATABASE_URL", "FACTORIX_RABBITMQ_URL", "FACTORIX_RABBITMQ_MGMT_URL", "FACTORIX_TDENGINE_DSN"):
        url = targets.get(name, "")
        if url and _host(url) in PRODUCTION_HOSTS:
            problems.append(f"{name} points at the production host {_host(url)!r}")
    db_url = targets.get("FACTORIX_DATABASE_URL", "")
    if db_url:
        db_name = unquote(urlparse(db_url).path.lstrip("/")).lower()
        if db_name in PRODUCTION_PG_DATABASES:
            problems.append(f"FACTORIX_DATABASE_URL uses the production database {db_name!r}")
    td_db = targets.get("FACTORIX_TDENGINE_DB", "").lower()
    if td_db in PRODUCTION_TD_DATABASES:
        problems.append(f"FACTORIX_TDENGINE_DB is the production database {td_db!r}")
    return problems


async def _consumed_production_queues(amqp_url: str, timeout_s: float) -> list[str]:
    import aio_pika  # local: the unit tests of the static checks do not need a broker client

    try:
        conn = await aio_pika.connect(amqp_url, timeout=timeout_s)
    except Exception:  # noqa: BLE001 - unreachable broker: the tests report that themselves
        return []
    found: list[str] = []
    try:
        for queue in PRODUCTION_QUEUES:
            channel = await conn.channel()
            try:
                declared = await asyncio.wait_for(channel.declare_queue(queue, passive=True), timeout_s)
                consumers = int(getattr(declared.declaration_result, "consumer_count", 0) or 0)
                if consumers > 0:
                    found.append(f"{queue} has {consumers} consumer(s)")
            except Exception:  # noqa: BLE001 - absent queue (passive declare closes the channel): not production
                pass
            finally:
                if not channel.is_closed:
                    await channel.close()
    finally:
        await conn.close()
    return found


def _run(coro):  # type: ignore[no-untyped-def]
    """Run a coroutine on a private loop in a worker thread (never touches the loop pytest-asyncio manages)."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def broker_problems(amqp_url: str, timeout_s: float = 5.0) -> list[str]:
    """Live check: production queues with consumers = a running FactoriX uses this broker."""
    if not amqp_url:
        return []
    return [f"FACTORIX_RABBITMQ_URL: {p} (a running FactoriX is attached to this broker)"
            for p in _run(_consumed_production_queues(amqp_url, timeout_s))]


_VERDICT: list[str] | None = None


def refusal_reasons(environ: Mapping[str, str] | None = None, *, probe: bool = True, dotenv: Path | None = None) -> list[str]:
    """Why this run must not start (empty = allowed). The opt-in variable short-circuits every check."""
    env = os.environ if environ is None else environ
    if env.get(OPT_IN_ENV, "") == OPT_IN_VALUE:
        return []
    targets = effective_targets(env, dotenv)
    problems = production_target_problems(targets)
    if probe and not problems:
        problems += broker_problems(targets.get("FACTORIX_RABBITMQ_URL", ""))
    return problems


def refuse_production_targets() -> None:
    """``pytest.exit`` (before collection) when a target is production; the verdict is computed once per run."""
    import pytest

    global _VERDICT
    if _VERDICT is None:
        _VERDICT = refusal_reasons()
    if _VERDICT:
        pytest.exit(
            "Integration tests refused: they would run against production.\n  - "
            + "\n  - ".join(_VERDICT)
            + "\nPoint FACTORIX_DATABASE_URL / FACTORIX_RABBITMQ_URL / FACTORIX_TDENGINE_DSN at the isolated test stack "
            f"(docker-compose.test.yml, .env.test.example). Only if these really are disposable services, set "
            f"{OPT_IN_ENV}={OPT_IN_VALUE}.",
            returncode=4,
        )


def delete_test_topology(amqp_url: str, mgmt_url: str, timeout_s: float = 10.0) -> list[str]:
    """Delete every ``fxtest.*`` queue and exchange left on the test broker (management API); returns the names.

    Only names with ``TEST_TOPOLOGY_PREFIX`` are touched, so even a misdirected call cannot remove production
    topology. Best effort: an unreachable management API deletes nothing.
    """
    if not amqp_url or not mgmt_url:
        return []
    import httpx

    parsed = urlparse(amqp_url)
    vhost = unquote(parsed.path[1:]) if parsed.path and parsed.path != "/" else "/"
    auth = (unquote(parsed.username or "guest"), unquote(parsed.password or "guest"))
    base = mgmt_url.rstrip("/")
    vh = quote(vhost, safe="")
    deleted: list[str] = []
    try:
        with httpx.Client(auth=auth, timeout=timeout_s) as client:
            for kind in ("queues", "exchanges"):
                resp = client.get(f"{base}/api/{kind}/{vh}", params={"columns": "name"})
                if resp.status_code != 200:
                    continue
                for item in resp.json():
                    name = str(item.get("name") or "")
                    if not name.startswith(TEST_TOPOLOGY_PREFIX):
                        continue
                    if client.delete(f"{base}/api/{kind}/{vh}/{quote(name, safe='')}").status_code in (200, 204, 404):
                        deleted.append(name)
    except httpx.HTTPError:
        return deleted
    return deleted
