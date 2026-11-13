"""AcquisitionRuntime supervisor: job isolation, heartbeat cadence, selective config diff, leader demotion."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import os
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

import pytest

from factorix.domain.canonical import CanonicalObservation
from factorix_acquisition.config_provider import ConfigProvider, LkgSnapshotStore, PgSecretStore, checksum, structure_digest
from factorix_acquisition.connectors.errors import ConnectorError
from factorix_acquisition.jobs import build_specs
from factorix_acquisition.mapping import Sample
from factorix_acquisition.publisher import ObservationPublisher
from factorix_acquisition.runtime import AcquisitionRuntime
from factorix_acquisition.spool import AcquisitionSpool

DATA_KEY = os.environ["FACTORIX_DATA_KEY"]
TENANT_ID = str(uuid5(NAMESPACE_URL, "tenant:1"))
RES_ID = str(uuid5(NAMESPACE_URL, "res:1"))


def _uid(prefix: str, name: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"{prefix}:{name}"))


def _snapshot(jobs: list[dict[str, Any]], revision: int = 1) -> dict[str, Any]:
    connections, fields, bindings, job_rows = [], [], [], []
    for job in jobs:
        name = job["name"]
        cid = _uid("conn", name)
        jid = _uid("job", name)
        fid = _uid("field", name)
        sid = _uid("signal", name)
        connections.append(
            {
                "id": cid,
                "tenant_id": TENANT_ID,
                "site_id": None,
                "protocol": job.get("protocol", "modbus_tcp"),
                "status": "ACTIVE",
                "config_json": job.get("config", {"host": "127.0.0.1", "port": 502}),
                "secret_ref": None,
            }
        )
        job_rows.append(
            {
                "id": jid,
                "connection_id": cid,
                "enabled": True,
                "mode": "POLL",
                "interval_ms": job.get("interval_ms", 200),
                "config_revision": revision,
            }
        )
        fields.append(
            {
                "id": fid,
                "acquisition_job_id": jid,
                "address_json": job.get("address", {"offset": 0, "native_type": "uint16"}),
                "native_datatype": "uint16",
                "decode_json": {},
            }
        )
        bindings.append(
            {
                "source_field_id": fid,
                "signal_id": sid,
                "resource_id": RES_ID,
                "tenant_id": TENANT_ID,
                "key": name,
                "data_type": job.get("data_type", "int64"),
            }
        )
    snap: dict[str, Any] = {
        "schema_version": "fx.acquisition.config.v1",
        "revision": revision,
        "connections": connections,
        "jobs": job_rows,
        "source_fields": fields,
        "signal_bindings": bindings,
        "formulas": [],
        "tenant_epochs": {TENANT_ID: 1},
    }
    snap["structure_sha256"] = structure_digest(snap)
    snap["checksum_sha256"] = checksum(snap)
    return snap


class FakeBroker:
    def __init__(self) -> None:
        self.observations: list[CanonicalObservation] = []

    async def publish_observations_partial(self, observations: list[CanonicalObservation]):
        self.observations.extend(observations)
        return [obs.event_uid for obs in observations], []


class FakeControlPlane:
    def __init__(self) -> None:
        self.heartbeats: list[dict[str, Any]] = []
        self.reports: list[dict[str, dict[str, Any]]] = []
        self.claim_calls = 0

    async def claim_commissioning_jobs(self, *, limit: int = 4) -> list[dict[str, Any]]:
        self.claim_calls += 1
        return []

    async def finish_commissioning(self, job_id: str, body: dict[str, Any]) -> None:
        return None

    async def flush_connection_reports(self, reports: dict[str, dict[str, Any]]) -> int:
        self.reports.append(reports)
        return len(reports)

    async def record_heartbeat(self, **kwargs: Any) -> None:
        self.heartbeats.append(kwargs)


class FakeLeaderLock:
    def __init__(self, leader: bool = True) -> None:
        self.should_lead = leader
        self._is_leader = False

    @property
    def is_leader(self) -> bool:
        return self._is_leader

    async def probe(self) -> bool:
        self._is_leader = self.should_lead
        return self._is_leader

    async def release(self) -> None:
        self._is_leader = False


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


def _runtime(
    snapshot_box: dict[str, dict[str, Any]],
    tmp_path: Path,
    devices: dict[str, Any],
    *,
    leader_lock: FakeLeaderLock | None = None,
) -> tuple[AcquisitionRuntime, FakeBroker, FakeControlPlane]:
    async def load(_conn: Any, _prev_rev: int, _prev_digest: str) -> dict[str, Any]:
        return snapshot_box["snap"]

    secrets = PgSecretStore(DATA_KEY)
    lkg = LkgSnapshotStore(tmp_path / "lkg.json")
    cfg = ConfigProvider(None, secrets, lkg, loader=load)
    control = FakeControlPlane()
    broker = FakeBroker()
    pub = ObservationPublisher(broker, AcquisitionSpool(tmp_path / "spool.sqlite"))
    runtime = AcquisitionRuntime(
        config_provider=cfg,
        control_plane=control,  # type: ignore[arg-type]
        publisher=pub,
        allowlist=[],
        leader_lock=leader_lock,
        heartbeat_s=0.2,
        config_s=0.2,
        commands_s=0.2,
        leader_probe_s=0.1,
    )

    async def create(spec):  # noqa: ANN001
        return devices[spec.connection_id]

    runtime._create_connector = create  # type: ignore[method-assign]
    return runtime, broker, control


async def _run_for(
    runtime: AcquisitionRuntime,
    seconds: float,
    *,
    until: Callable[[], bool] | None = None,
) -> None:
    task = asyncio.create_task(runtime.run())
    if until is not None:
        deadline = asyncio.get_running_loop().time() + seconds
        while asyncio.get_running_loop().time() < deadline:
            if until():
                break
            await asyncio.sleep(0.05)
    else:
        await asyncio.sleep(seconds)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_failing_and_hanging_jobs_do_not_stop_other_jobs_or_heartbeat(tmp_path: Path) -> None:
    snap = _snapshot(
        [
            {"name": "good"},
            {"name": "broken"},
            {"name": "hang", "config": {"host": "127.0.0.1", "port": 502, "timeout_ms": 200}},
        ]
    )
    runtime, broker, control = _runtime(
        {"snap": snap},
        tmp_path,
        {
            _uid("conn", "good"): GoodDevice(),
            _uid("conn", "broken"): BrokenDevice(),
            _uid("conn", "hang"): HangingDevice(),
        },
    )
    hang_cid = _uid("conn", "hang")
    await _run_for(
        runtime,
        4.0,
        until=lambda: any(hang_cid in rep for rep in control.reports) and len(control.heartbeats) >= 8,
    )

    good = [o for o in broker.observations if o.signal_id == uuid5(NAMESPACE_URL, "signal:good") and o.quality.value == "GOOD"]
    assert len(good) >= 4
    assert good[0].value == 7 and good[0].source_sequence is not None
    assert len(control.heartbeats) >= 8
    merged: dict[str, dict[str, Any]] = {}
    for rep in control.reports:
        merged.update(rep)
    assert merged[_uid("conn", "good")]["state"] == "UP"
    assert merged[_uid("conn", "broken")]["state"] == "DOWN"
    assert merged[_uid("conn", "broken")]["last_error_code"] == "INTERNAL"
    assert merged[_uid("conn", "hang")]["state"] == "DOWN"
    assert merged[_uid("conn", "hang")]["last_error_code"] == "TIMEOUT"
    bad = [o for o in broker.observations if o.signal_id == uuid5(NAMESPACE_URL, "signal:broken")]
    assert len(bad) == 1 and bad[0].quality.value == "BAD"


@pytest.mark.asyncio
async def test_config_change_restarts_only_the_changed_job(tmp_path: Path) -> None:
    box = {"snap": _snapshot([{"name": "a"}, {"name": "b"}])}
    runtime, _, _ = _runtime(
        box,
        tmp_path,
        {_uid("conn", "a"): GoodDevice(), _uid("conn", "b"): GoodDevice()},
    )
    await runtime.sync_config()
    task_a = runtime.job_tasks[_uid("job", "a")]
    task_b = runtime.job_tasks[_uid("job", "b")]
    mtime = (tmp_path / "lkg.json").stat().st_mtime_ns
    assert await runtime.sync_config() is False
    assert (tmp_path / "lkg.json").stat().st_mtime_ns == mtime

    box["snap"] = _snapshot([{"name": "a"}, {"name": "b", "interval_ms": 500}], revision=2)
    assert await runtime.sync_config() is True
    assert runtime.job_tasks[_uid("job", "a")] is task_a
    assert runtime.job_tasks[_uid("job", "b")] is not task_b and task_b.cancelled()
    assert runtime.revision == 2
    await runtime.close()


@pytest.mark.asyncio
async def test_http_429_emits_no_bad_sample_and_reports_rate_limited(tmp_path: Path) -> None:
    snap = _snapshot(
        [
            {
                "name": "h",
                "protocol": "http",
                "config": {"base_url": "http://127.0.0.1:9", "auth": "none"},
                "address": {"path": "/x", "jsonpath": "$.v"},
                "interval_ms": 1000,
            }
        ]
    )

    class Limited:
        async def request_json(self, *args: Any, **kwargs: Any) -> Any:
            raise ConnectorError("RATE_LIMITED", "HTTP source rate limit reached; retry after 30 s.", retry_after=30)

        async def close(self) -> None:
            return None

    h_cid = _uid("conn", "h")
    runtime, broker, control = _runtime({"snap": snap}, tmp_path, {h_cid: Limited()})
    await _run_for(runtime, 2.0, until=lambda: any(h_cid in rep for rep in control.reports))
    assert [o for o in broker.observations if o.signal_id == uuid5(NAMESPACE_URL, "signal:h")] == []
    states = [rep.get(h_cid, {}).get("state") for rep in control.reports]
    assert "RATE_LIMITED" in states


@pytest.mark.asyncio
async def test_unbound_connection_is_idle(tmp_path: Path) -> None:
    snap = _snapshot([{"name": "a"}])
    idle_cid = _uid("conn", "idle")
    snap["connections"].append(
        {"id": idle_cid, "tenant_id": TENANT_ID, "protocol": "mqtt", "status": "ACTIVE", "config_json": {"host": "127.0.0.1"}}
    )
    snap["structure_sha256"] = structure_digest(snap)
    snap["checksum_sha256"] = checksum(snap)
    runtime, _, _ = _runtime({"snap": snap}, tmp_path, {_uid("conn", "a"): GoodDevice()})
    await runtime.sync_config()
    await asyncio.sleep(0.3)
    report = runtime.connection_report()
    await runtime.close()
    assert report[idle_cid]["state"] == "IDLE"
    assert report[_uid("conn", "a")]["state"] == "UP"


@pytest.mark.asyncio
async def test_leader_lock_demotion_stops_all_jobs_and_prevents_standby_polling(tmp_path: Path) -> None:
    snap = _snapshot([{"name": "a"}])
    lock = FakeLeaderLock(leader=True)
    dev = GoodDevice()
    runtime, broker, _ = _runtime({"snap": snap}, tmp_path, {_uid("conn", "a"): dev}, leader_lock=lock)

    task = asyncio.create_task(runtime.run())
    await asyncio.sleep(0.5)
    assert runtime._is_leader is True
    assert len(runtime.job_tasks) == 1
    assert len(broker.observations) >= 1

    # Demote to standby (F-26 failover simulation)
    lock.should_lead = False
    deadline = asyncio.get_running_loop().time() + 2.0
    while asyncio.get_running_loop().time() < deadline and runtime._is_leader:
        await asyncio.sleep(0.05)
    assert runtime._is_leader is False
    assert runtime.job_tasks == {}
    assert runtime.connectors == {}

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_publisher_loop_interrupts_outage_backoff_immediately_on_broker_restore(tmp_path: Path) -> None:
    snap = _snapshot([{"name": "a"}])
    runtime, broker, _control = _runtime({"snap": snap}, tmp_path, {_uid("conn", "a"): GoodDevice()})
    pub = runtime.publisher
    spec = next(iter(build_specs(snap).values()))

    # Force long backoff scenario: broker starts as None, samples spill -> _publisher_loop enters backoff sleep
    pub.set_broker(None)
    pub.emit(spec, [Sample(spec.fields[0]["id"], 42, "GOOD")])
    loop_task = asyncio.create_task(runtime._publisher_loop())
    await asyncio.sleep(0.25)  # Allow loop to attempt flush, fail, and enter >= 1.0s backoff wait
    assert pub.spool.pending_count() == 1
    assert len(broker.observations) == 0

    t_restore = asyncio.get_running_loop().time()
    pub.set_broker(broker)
    deadline = t_restore + 0.5  # Must flush well under 1.0s backoff without waiting out sleep!
    while asyncio.get_running_loop().time() < deadline and pub.spool.pending_count() > 0:
        await asyncio.sleep(0.02)
    assert pub.spool.pending_count() == 0
    assert len(broker.observations) == 1
    await runtime.close()
    await asyncio.wait_for(loop_task, timeout=1.0)


@pytest.mark.asyncio
async def test_http_job_prewarms_ssl_before_first_read_budget(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import factorix_acquisition.jobs as jobs_mod

    events: list[str] = []

    async def fake_prewarm() -> None:
        events.append("prewarm")

    monkeypatch.setattr(jobs_mod, "prewarm_http_ssl", fake_prewarm)

    class OkHttp:
        async def request_json(self, *args: Any, **kwargs: Any) -> Any:
            events.append("read")
            return {"v": 99}

        async def close(self) -> None:
            return None

    snap = _snapshot(
        [
            {
                "name": "http_tls",
                "protocol": "http",
                "config": {"base_url": "https://127.0.0.1:18443", "auth": "none"},
                "address": {"path": "/telemetry", "jsonpath": "$.v"},
                "interval_ms": 1000,
            }
        ]
    )
    runtime, broker, _ = _runtime({"snap": snap}, tmp_path, {_uid("conn", "http_tls"): OkHttp()})
    await _run_for(runtime, 2.0, until=lambda: len(events) >= 2)
    assert events and events[0] == "prewarm"
    assert "read" in events
    assert [o for o in broker.observations if o.value == 99]


@pytest.mark.asyncio
async def test_plain_http_ensure_does_not_load_ssl_context(monkeypatch: pytest.MonkeyPatch) -> None:
    from factorix.domain.network import parse_allowlist
    import factorix_acquisition.connectors.http_pull as http_pull_mod
    from factorix_acquisition.connectors.http_pull import HttpPullConnector

    called = False

    async def fail_if_called() -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(http_pull_mod, "prewarm_http_ssl", fail_if_called)
    conn = HttpPullConnector("http://127.0.0.1:18080", parse_allowlist(["127.0.0.1:18080"]), timeout_s=2.0)
    await conn.prewarm(ssl_always=False)
    assert called is False
    await conn.close()

