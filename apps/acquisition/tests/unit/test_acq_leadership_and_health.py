"""WS-Q: leadership loss/regain restarts jobs (P0) and connection health is windowed, per job."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import pytest

import factorix_acquisition.config_provider as cp
from factorix_acquisition.connectors.errors import ConnectorError

from test_acq_runtime import FakeLeaderLock, GoodDevice, _runtime, _snapshot, _uid


async def _wait(predicate, timeout: float = 3.0) -> bool:  # noqa: ANN001
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return predicate()


async def _stop(task: asyncio.Task[Any]) -> None:
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# --------------------------------------------------------------------------- P0 leadership


@pytest.mark.asyncio
async def test_leadership_regain_restarts_jobs_with_unchanged_config(tmp_path: Path) -> None:
    """Demote (PG blip) -> re-promote with the SAME config revision: jobs must run again."""
    snap = _snapshot([{"name": "a"}, {"name": "b"}])
    lock = FakeLeaderLock(leader=True)
    runtime, broker, control = _runtime(
        {"snap": snap}, tmp_path, {_uid("conn", "a"): GoodDevice(), _uid("conn", "b"): GoodDevice()}, leader_lock=lock
    )
    task = asyncio.create_task(runtime.run())
    try:
        assert await _wait(lambda: len(runtime.job_tasks) == 2 and len(broker.observations) >= 2)
        lock.should_lead = False
        assert await _wait(lambda: not runtime._is_leader and runtime.job_tasks == {})
        assert runtime.conn_states == {} and runtime.job_health == {}
        before = len(broker.observations)

        lock.should_lead = True  # lock regained; config revision did not change
        assert await _wait(lambda: runtime._is_leader and len(runtime.job_tasks) == 2)
        assert all(not t.done() for t in runtime.job_tasks.values())
        assert await _wait(lambda: len(broker.observations) >= before + 4), "jobs must acquire again after re-promotion"
        assert runtime.leader_since is not None
        # The fresh evidence is reported as UP again (not a frozen pre-demotion state).
        assert await _wait(lambda: any(rep.get(_uid("conn", "a"), {}).get("state") == "UP" for rep in control.reports[-3:]))
        info = control.heartbeats[-1]["queues"]["runtime"]
        assert info["jobs_expected"] == 2 and info["jobs_running"] == 2
    finally:
        await _stop(task)


@pytest.mark.asyncio
async def test_lost_job_task_is_restarted_by_reconcile(tmp_path: Path) -> None:
    snap = _snapshot([{"name": "a"}])
    runtime, broker, _ = _runtime({"snap": snap}, tmp_path, {_uid("conn", "a"): GoodDevice()})
    await runtime.sync_config()
    job_id = _uid("job", "a")
    runtime.job_tasks[job_id].cancel()
    await asyncio.sleep(0.05)
    assert runtime.job_tasks[job_id].done()
    assert runtime.ensure_jobs_running() == 1
    assert not runtime.job_tasks[job_id].done()
    await runtime.close()


class _FakePgConn:
    def __init__(self, behaviour: dict[str, Any]) -> None:
        self.behaviour = behaviour
        self.closed = False

    def is_closed(self) -> bool:
        return self.closed

    async def fetchval(self, sql: str, *args: Any, timeout: float | None = None) -> Any:
        if self.behaviour.get("fail") or self.behaviour.pop("fail_once", False):
            self.closed = True
            raise ConnectionResetError("pg went away")
        if "pg_try_advisory_lock" in sql:
            return self.behaviour.get("grant", True)
        return True

    async def execute(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def close(self, timeout: float | None = None) -> None:
        self.closed = True

    def terminate(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_leader_lock_keeps_leadership_through_a_short_pg_blip(monkeypatch: pytest.MonkeyPatch) -> None:
    behaviour: dict[str, Any] = {"fail": False, "grant": True, "connect_fail": False}

    async def fake_connect(*args: Any, **kwargs: Any) -> _FakePgConn:
        if behaviour["connect_fail"]:
            raise OSError("connection refused")
        return _FakePgConn(behaviour)

    monkeypatch.setattr(cp.asyncpg, "connect", fake_connect)
    lock = cp.PgLeaderLock("postgresql://x/y", grace_probes=2)
    assert await lock.probe() is True and lock.is_leader

    # One broken session: re-opened and re-locked within the same probe -> no demotion at all.
    behaviour["fail_once"] = True
    assert await lock.probe() is True
    assert lock._failed_probes == 0

    # PostgreSQL unreachable: leadership kept for the grace probes, then demoted.
    behaviour.update(fail=True, connect_fail=True)
    assert await lock.probe() is True
    assert await lock.probe() is True
    assert await lock.probe() is False and not lock.is_leader

    # Back, but another instance holds the lock -> stays standby.
    behaviour.update(fail=False, connect_fail=False, grant=False)
    assert await lock.probe() is False


# --------------------------------------------------------------------------- windowed connection health


class FlakyDevice:
    """Every other read times out, the rest succeed: data keeps arriving."""

    def __init__(self) -> None:
        self.calls = 0

    async def read_raw(self, block):  # noqa: ANN001
        self.calls += 1
        if self.calls % 2 == 0:
            raise ConnectorError("TIMEOUT", "Modbus unit 1 did not answer within 3 s.")
        return [5] * block.count

    async def close(self) -> None:
        return None


class DeadDevice:
    async def read_raw(self, block):  # noqa: ANN001
        raise ConnectorError("NETWORK", "Cannot connect to Modbus TCP 127.0.0.1:502.")

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_intermittent_failures_while_data_arrives_never_report_down(tmp_path: Path) -> None:
    """Owner bug: the source keeps delivering but the system recorded 'lost connection'."""
    snap = _snapshot([{"name": "flaky", "interval_ms": 200}])
    cid = _uid("conn", "flaky")
    runtime, broker, control = _runtime({"snap": snap}, tmp_path, {cid: FlakyDevice()})
    runtime.min_degrade_s = 1.0
    task = asyncio.create_task(runtime.run())
    try:
        await asyncio.sleep(3.0)
    finally:
        await _stop(task)
    states = [rep[cid]["state"] for rep in control.reports if cid in rep]
    assert states and set(states) == {"UP"}, states
    good = [o for o in broker.observations if o.quality.value == "GOOD"]
    bad = [o for o in broker.observations if o.quality.value == "BAD"]
    assert good and not bad, "a transient failure must not emit BAD rows while reads keep succeeding"
    assert any(rep[cid].get("reads_failed", 0) > 0 for rep in control.reports if cid in rep)
    assert any("Intermittent" in (rep[cid].get("warning") or "") for rep in control.reports if cid in rep)


@pytest.mark.asyncio
async def test_sustained_failure_reports_down_after_the_window_only(tmp_path: Path) -> None:
    snap = _snapshot([{"name": "dead", "interval_ms": 200}])
    cid = _uid("conn", "dead")
    runtime, broker, control = _runtime({"snap": snap}, tmp_path, {cid: DeadDevice()})
    runtime.min_degrade_s = 1.5
    task = asyncio.create_task(runtime.run())
    started = time.monotonic()
    try:
        assert await _wait(lambda: any(rep.get(cid, {}).get("state") == "DOWN" for rep in control.reports), timeout=5.0)
        elapsed = time.monotonic() - started
        assert await _wait(lambda: any(o.quality.value == "BAD" for o in broker.observations), timeout=3.0)
        await asyncio.sleep(0.5)
    finally:
        await _stop(task)
    assert elapsed >= 1.4, "DOWN must not be reported before the degrade window"
    down = next(rep[cid] for rep in control.reports if rep.get(cid, {}).get("state") == "DOWN")
    assert down["last_error_code"] == "NETWORK"
    assert len([o for o in broker.observations if o.quality.value == "BAD"]) == 1


def _two_job_snapshot() -> dict[str, Any]:
    snap = _snapshot([{"name": "m1"}, {"name": "m2"}])
    # put job m2 on connection m1 (one gateway, two units)
    shared = _uid("conn", "m1")
    snap["jobs"][1]["connection_id"] = shared
    snap["connections"] = [c for c in snap["connections"] if c["id"] == shared]
    return snap


def test_connection_state_is_aggregated_per_job_not_last_writer_wins(tmp_path: Path) -> None:
    async def scenario() -> None:
        snap = _two_job_snapshot()
        runtime, _, _ = _runtime({"snap": snap}, tmp_path, {_uid("conn", "m1"): GoodDevice()})
        runtime.min_degrade_s = 1.0
        await runtime.apply_snapshot(snap, 1, "x", start_jobs=False)
        cid = _uid("conn", "m1")
        j1, j2 = _uid("job", "m1"), _uid("job", "m2")
        runtime.record_ok(cid, 5, 1, job_id=j1)
        runtime.record_ok(cid, 5, 1, job_id=j2)
        # job 2 fails last: old code reported the whole connection DOWN at this instant
        runtime.record_failure(cid, ConnectorError("TIMEOUT", "late"), job_id=j2)
        assert runtime.connection_report()[cid]["state"] == "UP"
        # job 2 keeps failing for longer than the window while job 1 keeps reading
        runtime.job_health[j2].last_ok_mono = time.monotonic() - 5.0
        runtime.record_failure(cid, ConnectorError("TIMEOUT", "late"), job_id=j2)
        runtime.record_ok(cid, 5, 1, job_id=j1)
        report = runtime.connection_report()[cid]
        assert report["state"] == "DOWN" and report["jobs_failing"] == 1 and report["jobs_total"] == 2
        assert report["last_error"].startswith("1 of 2 jobs failing")
        await runtime.close()

    asyncio.run(scenario())


class _Transport:
    def __init__(self) -> None:
        self.state = "UP"
        self.down_since: float | None = None
        self.last_error_code: str | None = None
        self.last_error: str | None = None
        self.last_message_at: str | None = None

    async def close(self) -> None:
        return None


def test_push_transport_blip_shorter_than_window_is_not_reported(tmp_path: Path) -> None:
    async def scenario() -> None:
        snap = _snapshot([{"name": "mq", "protocol": "mqtt", "config": {"host": "127.0.0.1", "port": 1883}, "address": {"topic": "t", "jsonpath": "$.v"}}])
        runtime, _, _ = _runtime({"snap": snap}, tmp_path, {})
        runtime.min_degrade_s = 2.0
        await runtime.apply_snapshot(snap, 1, "x", start_jobs=False)
        cid, jid = _uid("conn", "mq"), _uid("job", "mq")
        transport = _Transport()
        runtime.connectors[cid] = ("fp", transport)
        runtime.record_ok(cid, None, 3, job_id=jid)
        transport.state, transport.down_since = "DOWN", time.monotonic()
        transport.last_error_code, transport.last_error = "NETWORK", "MQTT connection lost (keepalive)."
        assert runtime.connection_report()[cid]["state"] == "UP"  # 1 s reconnect window: not an outage
        transport.down_since = time.monotonic() - 3.0
        assert runtime.connection_report()[cid]["state"] == "DOWN"
        # connected but silent publisher -> SILENT (distinct from a connector error)
        transport.state, transport.down_since = "UP", None
        runtime.job_health[jid].last_ok_mono = time.monotonic() - 10.0
        report = runtime.connection_report()[cid]
        assert report["state"] == "SILENT" and report["last_error_code"] == "NO_DATA"
        runtime.connectors.clear()
        await runtime.close()

    asyncio.run(scenario())


def test_runtime_info_lists_running_connections(tmp_path: Path) -> None:
    async def scenario() -> None:
        snap = _snapshot([{"name": "a"}])
        runtime, _, _ = _runtime({"snap": snap}, tmp_path, {_uid("conn", "a"): GoodDevice()})
        await runtime.sync_config()
        info = runtime.runtime_info()
        assert info["connections_running"] == [_uid("conn", "a")]
        assert info["started_at"] and info["leader_since"] is None  # no leader lock in this fixture: run() sets it
        await runtime.close()

    asyncio.run(scenario())
