"""PostgreSQL control-plane & secret-store resilience in factorix_acquisition:

* connection secret fetch retries transient failures with backoff;
* a cached secret survives a config revision and is used when re-read fails;
* CENTER failure is reported on the connection only after grace;
* OPC UA watchdog and poll budget tolerate one slow probe / reconnect.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any

import pytest

from factorix.domain.network import parse_allowlist
from factorix.platform.security import encrypt_secret
from factorix_acquisition import config_provider as cp_mod
from factorix_acquisition.config_provider import PgSecretStore
from factorix_acquisition.connectors.errors import ConnectorError
from factorix_acquisition.connectors.opcua import OpcUaConnector
from factorix_acquisition.jobs import CENTER_FAILURE_GRACE, JobRunner, build_specs, read_budget_s

DATA_KEY = os.environ["FACTORIX_DATA_KEY"]


class SecretBackend:
    def __init__(self, outcomes: list[Any], *, secret_text: str = "value-1") -> None:
        self.outcomes = list(outcomes)
        self.secret_text = secret_text
        self.calls = 0

    async def fetch(self, ref: str) -> tuple[bytes, str] | None:
        self.calls += 1
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(outcome, BaseException):
            raise outcome
        if outcome == "MISSING":
            return None
        cipher = encrypt_secret(DATA_KEY, self.secret_text)
        return cipher, hashlib.sha256(cipher).hexdigest()


@pytest.mark.asyncio
async def test_secret_retries_until_pg_answers() -> None:
    backend = SecretBackend([ConnectionError("transient"), TimeoutError("slow")])
    store = PgSecretStore(DATA_KEY, fetcher=backend.fetch, retry_delays_s=(0.0, 0.0, 0.0))
    assert await store.get("ref-1") == "value-1"
    assert await store.get("ref-1") == "value-1"  # cached
    assert backend.calls == 3


@pytest.mark.asyncio
async def test_secret_gives_up_with_center_error_when_nothing_is_cached() -> None:
    backend = SecretBackend([ConnectionError("down")] * 10)
    store = PgSecretStore(DATA_KEY, fetcher=backend.fetch, retry_delays_s=(0.0, 0.0, 0.0))
    with pytest.raises(ConnectorError) as info:
        await store.get("ref-1")
    assert info.value.code == "CENTER"
    assert backend.calls == 1 + 3


@pytest.mark.asyncio
async def test_secret_not_found_is_auth_without_retry() -> None:
    backend = SecretBackend(["MISSING"])
    store = PgSecretStore(DATA_KEY, fetcher=backend.fetch, retry_delays_s=(0.0, 0.0, 0.0))
    with pytest.raises(ConnectorError) as info:
        await store.get("ref-1")
    assert info.value.code == "AUTH"
    assert backend.calls == 1


@pytest.mark.asyncio
async def test_cached_secret_survives_new_revision_when_pg_is_unavailable() -> None:
    backend = SecretBackend([])
    store = PgSecretStore(DATA_KEY, fetcher=backend.fetch, retry_delays_s=(0.0, 0.0, 0.0))
    assert await store.get("ref-1") == "value-1"
    assert await store.get("gone") == "value-1"

    store.reconcile({"ref-1"})
    assert store.cached_value("gone") is None
    backend.outcomes = [TimeoutError("slow")] * 10
    assert await store.get("ref-1") == "value-1"
    calls = backend.calls
    assert await store.get("ref-1") == "value-1"
    assert backend.calls == calls


class _Host:
    def __init__(self) -> None:
        self.failures: list[ConnectorError] = []
        self.emitted: list[Any] = []

    async def connector(self, spec):  # noqa: ANN001
        raise AssertionError

    async def secret(self, secret_ref: str) -> str:
        return ""

    def emit(self, spec, samples) -> int:  # noqa: ANN001
        self.emitted.extend(samples)
        return len(samples)

    def record_ok(self, connection_id, read_ms, samples, at=None) -> None:  # noqa: ANN001
        return None

    def record_failure(self, connection_id, error) -> None:  # noqa: ANN001
        self.failures.append(error)


def _spec(protocol: str = "http", config: dict[str, Any] | None = None):  # noqa: ANN202
    snapshot = {
        "connections": [{"id": "c1", "protocol": protocol, "status": "ACTIVE", "config_json": config or {}, "secret_ref": None}],
        "jobs": [{"id": "j1", "connection_id": "c1", "enabled": True, "mode": "POLL", "interval_ms": 1000}],
        "source_fields": [{"id": "f1", "acquisition_job_id": "j1", "address_json": {"path": "/x"}, "native_datatype": "float64", "decode_json": {}}],
        "signal_bindings": [{"source_field_id": "f1", "signal_id": "s1", "resource_id": "r1", "data_type": "float64"}],
    }
    return build_specs(snapshot)["j1"]


@pytest.mark.asyncio
async def test_center_failure_is_reported_only_after_the_grace() -> None:
    host = _Host()
    runner = JobRunner(_spec(), host)
    error = ConnectorError("CENTER", "Cannot fetch the connection secret from PostgreSQL.")
    for _ in range(CENTER_FAILURE_GRACE - 1):
        await runner._failed(error)
    assert host.failures == [] and host.emitted == []
    await runner._failed(error)
    assert [e.code for e in host.failures] == ["CENTER"]
    assert len(host.emitted) == 1 and host.emitted[0].quality == "BAD"


@pytest.mark.asyncio
async def test_device_failure_is_reported_at_once() -> None:
    host = _Host()
    runner = JobRunner(_spec(), host)
    await runner._failed(ConnectorError("TIMEOUT", "late"))
    assert [e.code for e in host.failures] == ["TIMEOUT"] and len(host.emitted) == 1
    await runner._failed(ConnectorError("TIMEOUT", "late"))
    assert len(host.emitted) == 1


def test_opcua_watchdog_tolerates_a_slow_probe() -> None:
    allow = parse_allowlist(["10.0.0.5:4840"])
    endpoint = "opc.tcp://10.0.0.5:4840/sim/"
    assert OpcUaConnector(endpoint, allow, timeout_s=4.0).watchdog_s == 5.0
    assert OpcUaConnector(endpoint, allow, timeout_s=8.0).watchdog_s == 8.0
    assert OpcUaConnector(endpoint, allow, timeout_s=4.0, watchdog_s=1.0).watchdog_s == 1.0


def test_opcua_poll_budget_covers_a_reconnect() -> None:
    budget = read_budget_s(_spec("opcua", {"endpoint": "opc.tcp://10.0.0.5:4840/sim/", "timeout_ms": 4000}))
    assert budget >= 4.0 * 3 + 4.0
    assert budget <= 45.0
    assert cp_mod.SECRET_RETRY_DELAYS_S == (0.25, 0.5, 1.0)
