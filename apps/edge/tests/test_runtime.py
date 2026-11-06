"""Supervisor behaviour: job isolation, independent heartbeat, config diff, revocation, HTTP 429."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.runtime import CredentialRevoked, EdgeRuntime, checksum
from factorix_edge.store.outbox import Outbox


def _snapshot(jobs: list[dict[str, Any]], revision: int = 1) -> dict[str, Any]:
    connections, fields, bindings, job_rows = [], [], [], []
    for job in jobs:
        cid = f"c-{job['name']}"
        connections.append({"id": cid, "protocol": job.get("protocol", "modbus_tcp"), "status": "ACTIVE", "config_json": job.get("config", {"host": "127.0.0.1", "port": 502}), "secret_ref": None})
        job_rows.append({"id": f"j-{job['name']}", "connection_id": cid, "enabled": True, "mode": "POLL", "interval_ms": job.get("interval_ms", 200)})
        fields.append({"id": f"f-{job['name']}", "acquisition_job_id": f"j-{job['name']}", "address_json": job.get("address", {"offset": 0, "native_type": "uint16"}), "native_datatype": "uint16", "decode_json": {}})
        bindings.append({"source_field_id": f"f-{job['name']}", "signal_id": f"s-{job['name']}", "resource_id": "r-1", "data_type": job.get("data_type", "int64")})
    snapshot = {"revision": revision, "connections": connections, "jobs": job_rows, "source_fields": fields, "signal_bindings": bindings}
    snapshot["checksum_sha256"] = checksum(snapshot)
    return snapshot


class Center:
    """A fake Center behind httpx.MockTransport."""

    def __init__(self, snapshot: dict[str, Any] | None, revision: int = 1) -> None:
        self.snapshot = snapshot
        self.revision = revision
        self.active = 0
        self.heartbeats: list[dict[str, Any]] = []
        self.observations: list[dict[str, Any]] = []
        self.acks: list[dict[str, Any]] = []
        self.unauthorized = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.unauthorized:
            return httpx.Response(401, json={"code": "UNAUTHENTICATED"})
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        if path.endswith("/config"):
            return httpx.Response(200, json={"revision": self.revision, "active_revision": self.active, "checksum_sha256": (self.snapshot or {}).get("checksum_sha256"), "snapshot": self.snapshot})
        if path.endswith("/ack"):
            self.acks.append(body)
            if body["state"] == "ACTIVE":
                self.active = body["revision"]
            return httpx.Response(200, json={})
        if path.endswith("/heartbeat"):
            self.heartbeats.append(body)
            return httpx.Response(200, json={})
        if path.endswith("/observations"):
            self.observations.extend(body["observations"])
            return httpx.Response(200, json={"results": [{"event_uid": o["event_uid"], "status": "committed"} for o in body["observations"]]})
        if path.endswith("/commands"):
            return httpx.Response(200, json={"job": None})
        return httpx.Response(404)


class GoodDevice:
    async def read_raw(self, block):  # noqa: ANN001
        return [7] * block.count

    async def close(self) -> None:
        return None


class BrokenDevice:
    def __init__(self) -> None:
        self.calls = 0

    async def read_raw(self, block):  # noqa: ANN001
        self.calls += 1
        raise ZeroDivisionError("library bug")

    async def close(self) -> None:
        return None


class HangingDevice:
    async def read_raw(self, block):  # noqa: ANN001
        await asyncio.sleep(3600)

    async def close(self) -> None:
        return None


def _runtime(center: Center, tmp_path: Path, devices: dict[str, Any]) -> tuple[EdgeRuntime, httpx.AsyncClient]:
    client = httpx.AsyncClient(transport=httpx.MockTransport(center.handler), base_url="http://center")
    runtime = EdgeRuntime(client, "cred", [], Outbox(tmp_path / "outbox.sqlite"), snapshot_path=tmp_path / "active.json", heartbeat_s=0.2, config_s=0.2, commands_s=0.2)

    async def create(spec):  # noqa: ANN001
        return devices[spec.connection_id]

    runtime._create_connector = create  # type: ignore[method-assign]
    return runtime, client


async def _run_for(runtime: EdgeRuntime, seconds: float) -> None:
    task = asyncio.create_task(runtime.run())
    await asyncio.sleep(seconds)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_failing_and_hanging_jobs_do_not_stop_other_jobs_or_heartbeat(tmp_path: Path) -> None:
    snapshot = _snapshot([{"name": "good"}, {"name": "broken"}, {"name": "hang", "config": {"host": "127.0.0.1", "port": 502, "timeout_ms": 200}}])
    center = Center(snapshot)
    broken = BrokenDevice()
    runtime, client = _runtime(center, tmp_path, {"c-good": GoodDevice(), "c-broken": broken, "c-hang": HangingDevice()})
    async with client:
        await _run_for(runtime, 2.7)  # the hanging read hits its 2 s budget
    runtime.outbox.close()

    assert center.acks and center.acks[0]["state"] == "ACTIVE"
    good = [o for o in center.observations if o["signal_id"] == "s-good" and o["quality"] == "GOOD"]
    assert len(good) >= 4  # 200 ms interval kept running
    assert good[0]["event_time"] == good[0]["received_time"] and good[0]["value"] == 7
    assert "source_time" in good[0]
    assert len(center.heartbeats) >= 8  # fixed cadence regardless of the broken sources
    last = center.heartbeats[-1]["connections"]
    assert last["c-good"]["state"] == "UP"
    assert last["c-broken"]["state"] == "DOWN" and last["c-broken"]["last_error_code"] == "INTERNAL"
    assert last["c-hang"]["state"] == "DOWN" and last["c-hang"]["last_error_code"] == "TIMEOUT"
    bad = [o for o in center.observations if o["signal_id"] == "s-broken"]
    assert len(bad) == 1 and bad[0]["quality"] == "BAD"  # one BAD on the transition, not a flood
    assert broken.calls >= 1


@pytest.mark.asyncio
async def test_config_change_restarts_only_the_changed_job(tmp_path: Path) -> None:
    center = Center(_snapshot([{"name": "a"}, {"name": "b"}]))
    runtime, client = _runtime(center, tmp_path, {"c-a": GoodDevice(), "c-b": GoodDevice()})
    async with client:
        await runtime.sync_config()
        task_a = runtime.job_tasks["j-a"]
        task_b = runtime.job_tasks["j-b"]
        mtime = (tmp_path / "active.json").stat().st_mtime_ns
        assert await runtime.sync_config() is False  # unchanged: nothing saved, nothing restarted
        assert (tmp_path / "active.json").stat().st_mtime_ns == mtime
        center.snapshot = _snapshot([{"name": "a"}, {"name": "b", "interval_ms": 500}], revision=2)
        center.revision = 2
        assert await runtime.sync_config() is True
        assert runtime.job_tasks["j-a"] is task_a
        assert runtime.job_tasks["j-b"] is not task_b and task_b.cancelled()
        assert runtime.revision == 2
        await runtime.close()
    runtime.outbox.close()


@pytest.mark.asyncio
async def test_401_raises_credential_revoked(tmp_path: Path) -> None:
    center = Center(None)
    center.unauthorized = True
    runtime, client = _runtime(center, tmp_path, {})
    async with client:
        with pytest.raises(CredentialRevoked):
            await asyncio.wait_for(runtime.run(), timeout=5)
    runtime.outbox.close()


@pytest.mark.asyncio
async def test_http_429_emits_no_bad_sample_and_reports_rate_limited(tmp_path: Path) -> None:
    snapshot = _snapshot([{"name": "h", "protocol": "http", "config": {"base_url": "http://127.0.0.1:9", "auth": "none"}, "address": {"path": "/x", "jsonpath": "$.v"}, "interval_ms": 1000}])
    center = Center(snapshot)

    class Limited:
        async def request_json(self, *args: Any, **kwargs: Any) -> Any:
            raise ConnectorError("RATE_LIMITED", "HTTP source rate limit reached; retry after 30 s.", retry_after=30)

        async def close(self) -> None:
            return None

    runtime, client = _runtime(center, tmp_path, {"c-h": Limited()})
    async with client:
        await _run_for(runtime, 0.8)
    runtime.outbox.close()
    assert [o for o in center.observations if o["signal_id"] == "s-h"] == []
    states = [hb["connections"].get("c-h", {}).get("state") for hb in center.heartbeats]
    assert "RATE_LIMITED" in states


@pytest.mark.asyncio
async def test_unbound_connection_is_idle(tmp_path: Path) -> None:
    snapshot = _snapshot([{"name": "a"}])
    snapshot["connections"].append({"id": "c-idle", "protocol": "mqtt", "status": "ACTIVE", "config_json": {"host": "127.0.0.1"}})
    snapshot["checksum_sha256"] = checksum(snapshot)
    center = Center(snapshot)
    runtime, client = _runtime(center, tmp_path, {"c-a": GoodDevice()})
    async with client:
        await runtime.sync_config()
        await asyncio.sleep(0.3)
        report = runtime.connection_report()
        await runtime.close()
    runtime.outbox.close()
    assert report["c-idle"]["state"] == "IDLE"
    assert report["c-a"]["state"] == "UP"
