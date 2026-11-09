"""Data Model v2 engine (factorix.modules.models_engine): scheduling, latest-valid loading, value_at, writes, push."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.domain import body as B
from factorix.domain import rules as R
from factorix.modules import models_engine as E
from factorix.transport.hub import Channel, Hub

T0 = datetime(2026, 11, 9, 10, 0, 0, tzinfo=timezone.utc)
TENANT = uuid4()
M1 = str(uuid4())
SIG = str(uuid4())
SO = str(uuid4())
CAT = R.Catalog(
    [{"id": M1, "type_key": "machine", "name": "M1", "code": "M1", "parent_id": None}],
    [{"id": SIG, "resource_id": M1, "key": "temp", "data_type": "float64"}, {"id": SO, "resource_id": M1, "key": "so", "data_type": "string"}],
    types=["machine"],
)


def stored(*children: dict[str, Any]) -> dict[str, Any]:
    spec, issues = B.resolve_spec({"version": 2, "root": {"type": "object", "children": list(children)}}, CAT)
    assert not B.has_errors(issues), issues
    return spec


def rule(key: str, expr: str, value_type: str = "auto") -> dict[str, Any]:
    return {"key": key, "type": "field", "mode": "calculated", "expr": expr, "value_type": value_type}


class FakeSession:
    def __init__(self, log: list[str]) -> None:
        self.info: dict[str, Any] = {}
        self.log = log

    async def __aenter__(self) -> "FakeSession":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def commit(self) -> None:
        self.log.append("commit")


class World:
    """Monkeypatched data access of the engine."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.now = T0
        self.models: list[dict[str, Any]] = []
        self.latest: dict[str, R.Sample | None] = {}
        self.writes: list[list[dict[str, Any]]] = []
        self.pruned: list[list[Any]] = []
        self.flushed: list[dict[str, Any]] = []
        self.log: list[str] = []
        self.latest_queries = 0
        self.value_at_queries: list[list[tuple[str, datetime, str]]] = []
        self.history: dict[str, list[tuple[datetime, Any]]] = {}

        async def load_model_rows(_s: Any) -> list[dict[str, Any]]:
            return [dict(r) for r in self.models]

        async def load_catalog(_s: Any, _t: Any, _ids: Any = None) -> R.Catalog:
            return CAT

        async def load_samples(_s: Any, _t: Any, ids: Any) -> tuple[dict[str, Any], dict[str, Any]]:
            self.latest_queries += 1
            return {i: self.latest.get(i) for i in ids}, {}

        async def write_samples(_s: Any, rows: list[dict[str, Any]]) -> None:
            self.writes.append(rows)

        async def prune(_s: Any, ids: list[Any], keep: int = E.SNAPSHOT_KEEP) -> None:
            self.pruned.append(ids)

        async def fetch_value_at(_s: Any, _t: Any, requests: list[tuple[str, datetime, str]]) -> dict[Any, Any]:
            self.value_at_queries.append(requests)
            out = {}
            for sid, at, _mode in requests:
                rows = [(t, v) for t, v in self.history.get(sid, []) if t <= at]
                out[(sid, at)] = R.Sample(rows[-1][1], source_time=rows[-1][0]) if rows else None
            return out

        async def flush(session: FakeSession) -> None:
            self.flushed.extend(session.info.pop("fx_events", []))

        monkeypatch.setattr(E, "load_model_rows", load_model_rows)
        monkeypatch.setattr(E, "load_catalog", load_catalog)
        monkeypatch.setattr(E, "load_samples", load_samples)
        monkeypatch.setattr(E, "write_samples", write_samples)
        monkeypatch.setattr(E, "prune_snapshots", prune)
        monkeypatch.setattr(E, "fetch_value_at", fetch_value_at)
        monkeypatch.setattr(E, "utcnow", lambda: self.now)
        monkeypatch.setattr(E.after_commit, "flush", flush)
        E._value_at_cache.clear()
        self.engine = E.ModelEngine(session_factory=lambda: FakeSession(self.log))

    def add(self, spec: dict[str, Any], *, sample_ms: int = 1000, state: str = "RUNNING", version: int = 1, model_id: str | None = None) -> str:
        model_id = model_id or str(uuid4())
        self.models.append({"id": model_id, "tenant_id": TENANT, "display_name": "m", "version": version, "sample_ms": sample_ms, "state": state, "spec_json": json.dumps(spec)})
        return model_id


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> World:
    return World(monkeypatch)


async def test_samples_every_period_even_when_nothing_changes(world: World) -> None:
    model = world.add(stored(rule("t", "$machine[M1].temp"), rule("p", "now()", "timestamp")), sample_ms=1000)
    world.latest = {SIG: R.Sample(21.5)}
    delay = await world.engine.cycle()
    assert len(world.writes) == 1 and world.writes[0][0]["body"] == '{"t":21.5,"p":"2026-11-09T10:00:00.000Z"}'
    assert 0.05 <= delay <= 1.0
    await world.engine.cycle()  # not due yet
    assert len(world.writes) == 1
    world.now = T0 + timedelta(milliseconds=1000)
    await world.engine.cycle()  # due again: a heartbeat body with a new publish time, same data
    assert [rows[0]["body"] for rows in world.writes][-1] == '{"t":21.5,"p":"2026-11-09T10:00:01.000Z"}'
    message = world.flushed[-1]
    assert message["kind"] == "model_body" and message["group_id"] == model
    assert message["payload"] == {"type": "model_body", "group_id": model, "body": '{"t":21.5,"p":"2026-11-09T10:00:01.000Z"}', "sampled_at": "2026-11-09T10:00:01.000Z", "errors": []}
    assert world.log.count("commit") == 2 and world.latest_queries == 2  # one latest query per tick


async def test_paused_models_are_not_sampled_and_resume_immediately(world: World) -> None:
    model = world.add(stored(rule("a", "1")), state="PAUSED")
    await world.engine.cycle()
    assert world.writes == []
    world.models[0]["state"] = "RUNNING"
    world.engine.invalidate()
    await world.engine.cycle()
    assert len(world.writes) == 1 and str(world.writes[0][0]["group_id"]) == model


async def test_one_latest_query_for_all_due_models_and_errors_are_stored(world: World) -> None:
    for _ in range(5):
        world.add(stored(rule("t", "$machine[M1].temp * 2"), rule("bad", "1 / 0")))
    world.latest = {SIG: R.Sample(2.0)}
    await world.engine.cycle()
    assert world.latest_queries == 1 and len(world.writes) == 1 and len(world.writes[0]) == 5
    row = world.writes[0][0]
    assert row["body"] == '{"t":4.0,"bad":null}' and row["error_count"] == 1
    assert json.loads(row["errors_json"]) == [{"path": "/bad", "code": "DIV0", "message": "Division by zero."}]


async def test_batches_per_transaction(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(E, "MODELS_PER_TX", 2)
    for _ in range(5):
        world.add(stored(rule("a", "1")))
    await world.engine.cycle()
    assert [len(rows) for rows in world.writes] == [2, 2, 1] and world.log.count("commit") == 3


async def test_snapshot_ring_is_pruned_continuously(world: World) -> None:
    model = world.add(stored(rule("a", "1")), sample_ms=200)
    for i in range(E.PRUNE_EVERY * 2):
        world.now = T0 + timedelta(milliseconds=200 * i)
        await world.engine.cycle()
    assert len(world.writes) == E.PRUNE_EVERY * 2
    assert world.pruned == [[model], [model]]


async def test_filter_state_survives_ticks_and_resets_on_edit(world: World) -> None:
    model = world.add(stored(rule("n", "count_changes($machine[M1].temp)")))
    for i, value in enumerate([1, 2, 3]):
        world.latest = {SIG: R.Sample(float(value))}
        world.now = T0 + timedelta(seconds=i)
        await world.engine.cycle()
    assert [rows[0]["body"] for rows in world.writes] == ['{"n":0}', '{"n":1}', '{"n":2}']
    world.models[0]["version"] = 2  # edited
    world.engine.invalidate()
    world.now = T0 + timedelta(seconds=3)
    await world.engine.cycle()
    assert world.writes[-1][0]["body"] == '{"n":0}' and str(world.writes[-1][0]["group_id"]) == model


async def test_value_at_lookups_are_fetched_once_and_cached(world: World) -> None:
    completion = T0 - timedelta(minutes=10)
    world.history = {SO: [(T0 - timedelta(hours=1), "SO-1"), (T0 - timedelta(minutes=1), "SO-2")]}
    world.latest = {SIG: R.Sample(1.0, source_time=completion), SO: R.Sample("SO-2", source_time=T0 - timedelta(minutes=1))}
    world.add(stored(rule("so", "value_at($machine[M1].so, ts($machine[M1].temp))"), rule("cur", "$machine[M1].so")))
    await world.engine.cycle()
    assert world.writes[0][0]["body"] == '{"so":"SO-1","cur":"SO-2"}'
    assert world.value_at_queries == [[(SO, completion, "s")]]
    world.now = T0 + timedelta(seconds=1)
    await world.engine.cycle()
    assert world.writes[1][0]["body"] == '{"so":"SO-1","cur":"SO-2"}' and len(world.value_at_queries) == 1


async def test_change_event_after_commit_reloads(world: World) -> None:
    world.add(stored(rule("a", "1")))
    await world.engine.cycle()
    world.add(stored(rule("b", "2")))
    await world.engine.cycle()  # reload not due yet (5 s): the new model is unknown
    assert sum(len(rows) for rows in world.writes) == 1
    await world.engine._on_events([{"kind": E.CHANGE_EVENT, "tenant_id": str(TENANT), "model_id": "x"}])
    await world.engine.cycle()
    assert world.writes[-1][0]["body"] == '{"b":2}'


async def test_a_failing_model_does_not_stop_the_others(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    good = world.add(stored(rule("a", "1")))
    bad = world.add(stored(rule("b", "2")))
    real = E.evaluate_once

    async def flaky(session: Any, tenant: Any, compiled: Any, *args: Any) -> Any:
        if compiled is world.engine.models[bad].compiled:
            raise RuntimeError("boom")
        return await real(session, tenant, compiled, *args)

    monkeypatch.setattr(E, "evaluate_once", flaky)
    await world.engine.cycle()
    assert [str(r["group_id"]) for r in world.writes[0]] == [good]


def test_sample_from_latest_uses_the_last_valid_value() -> None:
    at = T0 - timedelta(seconds=3)
    good, wait = E.sample_from_latest({"quality": "GOOD", "value_json": {"v": 5}, "source_time": at, "received_time": T0})
    assert good == R.Sample(5, "GOOD", at, T0) and wait is None
    uncertain, _ = E.sample_from_latest({"quality": "UNCERTAIN", "value_json": '{"v": null}', "source_time": None, "received_time": T0})
    assert uncertain == R.Sample(None, "UNCERTAIN", None, T0)
    fallback, wait = E.sample_from_latest({"quality": "BAD", "value_json": None, "last_good_value_json": {"v": 4}, "last_good_event_time": at})
    assert fallback == R.Sample(4, "GOOD", None, at) and wait == at
    assert E.sample_from_latest({"quality": "BAD", "value_json": None, "last_good_value_json": None}) == (None, None)


async def test_load_samples_one_query_plus_cached_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    good_at = T0 - timedelta(minutes=2)
    source = T0 - timedelta(minutes=3)
    a, b = str(uuid4()), str(uuid4())
    queries: list[str] = []

    async def fetch_all(_s: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        queries.append(sql)
        if "FROM latest_signal_state" in sql:
            return [
                {"signal_id": UUID(a), "quality": "GOOD", "value_json": {"v": 1}, "source_time": T0, "received_time": T0},
                {"signal_id": UUID(b), "quality": "BAD", "value_json": None, "last_good_value_json": {"v": 7}, "last_good_event_time": good_at},
            ]
        assert "FROM observations" in sql and "o.event_time = q.at" in sql
        return [{"signal_id": UUID(b), "source_time": source}]

    monkeypatch.setattr(E, "fetch_all", fetch_all)
    E._fallback_source_cache.clear()
    samples, qualities = await E.load_samples(object(), TENANT, [a, b])  # type: ignore[arg-type]
    assert samples[a] == R.Sample(1, "GOOD", T0, T0)
    assert samples[b] == R.Sample(7, "GOOD", source, good_at) and qualities[b] == "BAD"
    assert len(queries) == 2
    await E.load_samples(object(), TENANT, [a, b])  # type: ignore[arg-type]
    assert len(queries) == 3  # the fallback source time is cached


async def test_value_at_query_uses_the_source_time_index(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fetch_all(_s: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        captured.update(sql=sql, params=params)
        return [{"idx": 0, "value_json": {"v": "SO-1"}, "quality": "GOOD", "source_time": T0, "received_time": T0}, {"idx": 1, "value_json": None, "quality": None}]

    monkeypatch.setattr(E, "fetch_all", fetch_all)
    out = await E.fetch_value_at(object(), TENANT, [(SO, T0, "s"), (SIG, T0, "e")])  # type: ignore[arg-type]
    assert out[(SO, T0)] == R.Sample("SO-1", "GOOD", T0, T0) and out[(SIG, T0)] is None
    sql = captured["sql"]
    assert "o.source_time <= q.at" in sql and "ORDER BY o.source_time DESC" in sql and "o.event_time <= q.at" in sql
    assert "quality IN ('GOOD', 'UNCERTAIN')" in sql and captured["params"]["modes"] == ["s", "e"]


async def test_write_samples_sql_is_batched(monkeypatch: pytest.MonkeyPatch) -> None:
    statements: list[str] = []

    async def execute(_s: Any, sql: str, params: dict[str, Any]) -> None:
        statements.append(sql)

    monkeypatch.setattr(E, "execute", execute)
    rows = [{"group_id": uuid4(), "tenant_id": TENANT, "body": "{}", "sampled_at": T0, "errors_json": "[]", "error_count": 0} for _ in range(3)]
    await E.write_samples(object(), rows)  # type: ignore[arg-type]
    await E.prune_snapshots(object(), [r["group_id"] for r in rows])  # type: ignore[arg-type]
    assert len(statements) == 3
    assert "ON CONFLICT (group_id) DO UPDATE" in statements[0] and "INSERT INTO model_snapshots" in statements[1]
    assert "DELETE FROM model_snapshots" in statements[2] and "OFFSET :keep" in statements[2]


def test_hub_coalesces_model_bodies_per_group() -> None:
    hub = Hub()
    received: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        received.append(message)

    channel = Channel(send, str(TENANT))
    channel.groups.add("g1")
    hub.register(channel)
    for i in range(3):
        hub.dispatch([{"kind": "model_body", "tenant_id": str(TENANT), "group_id": "g1", "payload": E.body_message("g1", f'{{"i":{i}}}', T0, [])}])
    hub.dispatch([{"kind": E.CHANGE_EVENT, "tenant_id": str(TENANT), "model_id": "g1"}])  # internal: never sent to browsers
    drained = channel.drain()
    assert [m["body"] for m in drained] == ['{"i":2}'] and drained[0]["sampled_at"] == "2026-11-09T10:00:00.000Z"


def test_due_and_next_delay() -> None:
    engine = E.ModelEngine(session_factory=lambda: None)
    engine.apply_rows([{"id": "a", "tenant_id": TENANT, "version": 1, "sample_ms": 5000, "state": "RUNNING", "spec_json": {}}])
    assert [m.id for m in engine.due(T0)] == ["a"] and engine.next_delay(T0) == E.MIN_SLEEP_S
    engine.models["a"].last_sample = T0
    assert engine.due(T0 + timedelta(seconds=4)) == [] and engine.next_delay(T0) == E.MAX_SLEEP_S
    assert engine.next_delay(T0 + timedelta(milliseconds=4700)) == pytest.approx(0.3)
    assert E.clamp_sample_ms(10) == E.MIN_SAMPLE_MS and E.clamp_sample_ms(10**9) == E.MAX_SAMPLE_MS and E.clamp_sample_ms("x") == 1000
