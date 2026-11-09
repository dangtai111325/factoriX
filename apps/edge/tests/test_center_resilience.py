"""R4-ENV-01: a Center that starts later or answers slowly must not fail healthy acquisition.

* the connection secret fetch retries transient failures (not reachable, 5xx) with backoff;
* a cached secret survives a new configuration revision and is used when the re-read fails;
* a CENTER failure is reported on the connection only after a short grace;
* the OPC UA watchdog and the poll budget tolerate one slow probe / a slow reconnect.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from factorix.domain.network import parse_allowlist
from factorix_edge import runtime as runtime_mod
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.connectors.opcua import OpcUaConnector
from factorix_edge.jobs import CENTER_FAILURE_GRACE, JobRunner, build_specs, read_budget_s
from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


@pytest.fixture(autouse=True)
def _fast_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_mod, "SECRET_RETRY_DELAYS_S", (0.0, 0.0, 0.0))


class SecretCenter:
    def __init__(self, failures: list[Any]) -> None:
        self.failures = list(failures)  # per call: an exception, an HTTP status, or nothing (= answer)
        self.calls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert "/edge-sync/secrets/" in request.url.path
        self.calls += 1
        outcome = self.failures.pop(0) if self.failures else None
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, int):
            return httpx.Response(outcome, json={"code": "X"})
        return httpx.Response(200, json={"secret": "value-1"})


def _runtime(center: SecretCenter, tmp_path: Path) -> tuple[EdgeRuntime, httpx.AsyncClient]:
    client = httpx.AsyncClient(transport=httpx.MockTransport(center.handler), base_url="http://center")
    return EdgeRuntime(client, "cred", [], Outbox(tmp_path / "outbox.sqlite")), client


async def test_secret_retries_until_center_answers(tmp_path: Path) -> None:
    center = SecretCenter([httpx.ConnectError("All connection attempts failed"), 503])
    runtime, client = _runtime(center, tmp_path)
    async with client:
        assert await runtime.secret("ref-1") == "value-1"
        assert await runtime.secret("ref-1") == "value-1"  # cached: no further call
    runtime.outbox.close()
    assert center.calls == 3


async def test_secret_gives_up_with_center_error_when_nothing_is_cached(tmp_path: Path) -> None:
    center = SecretCenter([httpx.ConnectError("down")] * 10)
    runtime, client = _runtime(center, tmp_path)
    async with client:
        with pytest.raises(ConnectorError) as info:
            await runtime.secret("ref-1")
    runtime.outbox.close()
    assert info.value.code == "CENTER"
    assert center.calls == 1 + len(runtime_mod.SECRET_RETRY_DELAYS_S)


async def test_secret_not_found_is_auth_without_retry(tmp_path: Path) -> None:
    center = SecretCenter([404])
    runtime, client = _runtime(center, tmp_path)
    async with client:
        with pytest.raises(ConnectorError) as info:
            await runtime.secret("ref-1")
    runtime.outbox.close()
    assert info.value.code == "AUTH" and center.calls == 1


async def test_cached_secret_survives_a_new_revision_when_center_is_busy(tmp_path: Path) -> None:
    center = SecretCenter([])
    runtime, client = _runtime(center, tmp_path)
    snapshot = {
        "connections": [{"id": "c1", "protocol": "http", "status": "ACTIVE", "config_json": {}, "secret_ref": "ref-1"}],
        "jobs": [],
        "source_fields": [],
        "signal_bindings": [],
    }
    async with client:
        assert await runtime.secret("ref-1") == "value-1"
        assert await runtime.secret("gone") == "value-1"
        await runtime.apply_snapshot(snapshot, 2, "x", start_jobs=False)
        assert "gone" not in runtime._secrets  # no longer referenced: forgotten
        assert runtime._stale_secrets == {"ref-1"}  # re-read before the next use
        center.failures = [httpx.ReadTimeout("slow")] * 10
        assert await runtime.secret("ref-1") == "value-1"  # re-read failed: cached value used
        calls = center.calls
        assert await runtime.secret("ref-1") == "value-1"
        assert center.calls == calls  # and not retried on every poll
    runtime.outbox.close()


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


async def test_center_failure_is_reported_only_after_the_grace() -> None:
    host = _Host()
    runner = JobRunner(_spec(), host)
    error = ConnectorError("CENTER", "Cannot fetch the connection secret from Center.")
    for _ in range(CENTER_FAILURE_GRACE - 1):
        await runner._failed(error)
    assert host.failures == [] and host.emitted == []  # healthy source not marked down yet
    await runner._failed(error)
    assert [e.code for e in host.failures] == ["CENTER"]
    assert len(host.emitted) == 1 and host.emitted[0].quality == "BAD"  # one BAD on the transition


async def test_device_failure_is_reported_at_once() -> None:
    host = _Host()
    runner = JobRunner(_spec(), host)
    await runner._failed(ConnectorError("TIMEOUT", "late"))
    assert [e.code for e in host.failures] == ["TIMEOUT"] and len(host.emitted) == 1
    await runner._failed(ConnectorError("TIMEOUT", "late"))
    assert len(host.emitted) == 1  # not a flood


def test_opcua_watchdog_tolerates_a_slow_probe() -> None:
    allow = parse_allowlist(["10.0.0.5:4840"])
    endpoint = "opc.tcp://10.0.0.5:4840/sim/"
    assert OpcUaConnector(endpoint, allow, timeout_s=4.0).watchdog_s == 5.0
    assert OpcUaConnector(endpoint, allow, timeout_s=8.0).watchdog_s == 8.0
    assert OpcUaConnector(endpoint, allow, timeout_s=4.0, watchdog_s=1.0).watchdog_s == 1.0


def test_opcua_poll_budget_covers_a_reconnect() -> None:
    budget = read_budget_s(_spec("opcua", {"endpoint": "opc.tcp://10.0.0.5:4840/sim/", "timeout_ms": 4000}))
    assert budget >= 4.0 * 3 + 4.0  # connect (3 timeouts) plus one read
    assert budget <= 45.0
