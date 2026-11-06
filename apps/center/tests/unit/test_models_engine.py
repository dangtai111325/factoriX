"""Engine and member resolution with the SQL layer replaced by an in-memory fake."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from factorix.domain.body import normalize_members
from factorix.modules import collect, models_engine
from factorix.platform.errors import AppError

T0 = datetime(2026, 6, 20, 8, 0, tzinfo=timezone.utc)
TENANT = uuid4()
MACHINE = uuid4()
OTHER = uuid4()


class FakeSession:
    def __init__(self) -> None:
        self.info: dict = {}

    @asynccontextmanager
    async def begin_nested(self):
        yield self


def _head(machine=True):
    head = [
        {"kind": "context", "alias": "zone_name", "context_ref": "zone.name"},
        {"kind": "context", "alias": "line_name", "context_ref": "line.name"},
    ]
    if machine:
        head.append({"kind": "context", "alias": "machine_name", "context_ref": "machine.name"})
    return head + [
        {"kind": "system", "alias": "source_timestamp", "field": "source_timestamp"},
        {"kind": "system", "alias": "publish_timestamp", "field": "publish_timestamp"},
    ]


def _member_rows(group_id, members):
    rows = []
    for ordinal, m in enumerate(members):
        rows.append(
            {
                "output_group_id": group_id,
                "member_kind": m.kind.upper(),
                "output_alias": m.alias,
                "signal_id": m.signal_id,
                "signal_key": m.signal_key,
                "context_ref": m.context_ref,
                "constant_json": {"v": m.value} if m.kind == "constant" else None,
                "system_field": m.field,
                "contributes_ts": m.contributes_ts,
                "is_trigger": m.is_trigger,
                "ordinal": ordinal,
            }
        )
    return rows


CHAIN = [
    {"depth": 0, "id": MACHINE, "code": "M01", "name": "M-01", "type_key": "machine"},
    {"depth": 1, "id": uuid4(), "code": "L1", "name": "Assembly - L1 (A1)", "type_key": "line"},
    {"depth": 2, "id": uuid4(), "code": "ASSY", "name": "ASSY", "type_key": "zone"},
]


class FakeDB:
    """Answers the engine's queries by recognisable SQL fragments."""

    def __init__(self, groups, members_rows, latest, observations=()):
        self.groups = groups
        self.members_rows = members_rows
        self.latest = latest
        self.observations = list(observations)
        self.state: dict[str, dict] = {}
        self.events: dict[tuple[str, str], dict] = {}

    async def fetch_all(self, _session, sql, params):
        if "FROM output_groups g" in sql:
            return [dict(g) for g in self.groups]
        if "FROM output_group_members" in sql:
            ids = {str(i) for i in params["ids"]}
            return [r for r in self.members_rows if str(r["output_group_id"]) in ids]
        if "FROM latest_signal_state" in sql:
            ids = {str(i) for i in params["ids"]}
            return [dict(v, signal_id=k) for k, v in self.latest.items() if k in ids]
        if "FROM model_state WHERE group_id = ANY" in sql:
            return [{"group_id": k, "content_hash": v["content_hash"]} for k, v in self.state.items()]
        if "WITH RECURSIVE chain" in sql:
            return CHAIN
        if "SELECT max(source_time)" in sql:
            ids = {str(i) for i in params["ids"]}
            times = [o["source_time"] for o in self.observations if o["signal_id"] in ids and o["source_time"]]
            return [{"source_time": max(times) if times else None}]
        if "SELECT DISTINCT source_time FROM observations" in sql:
            ids = {str(i) for i in params["ids"]}
            times = sorted({o["source_time"] for o in self.observations if o["signal_id"] in ids and o["source_time"] and o["source_time"] > params["last_ts"]})
            return [{"source_time": t} for t in times[: params["limit"]]]
        if "FROM observations" in sql and "source_time <= :at" in sql:
            rows = [o for o in self.observations if o["signal_id"] == str(params["signal_id"]) and o["source_time"] and o["source_time"] <= params["at"]]
            rows.sort(key=lambda o: (o["source_time"], o["received_time"]), reverse=True)
            return rows[:1]
        if "FROM observations" in sql and "source_time IS NULL" in sql:
            return []
        raise AssertionError(f"unexpected fetch_all: {sql[:80]}")

    async def fetch_one(self, _session, sql, params):
        if "FROM model_events" in sql and "dedupe_key" in sql and "INSERT" not in sql:
            rows = [e for (g, _k), e in self.events.items() if g == str(params["group_id"])]
            rows.sort(key=lambda e: e["source_ts"], reverse=True)
            return rows[0] if rows else None
        if "INSERT INTO model_events" in sql:
            key = (str(params["group_id"]), params["dedupe"])
            if key in self.events:
                return None
            self.events[key] = {"id": params["id"], "source_ts": params["source_ts"], "dedupe_key": params["dedupe"], "body_text": params["body"], "status": params["status"]}
            return {"id": params["id"]}
        raise AssertionError(f"unexpected fetch_one: {sql[:80]}")

    async def execute(self, _session, sql, params):
        if "INSERT INTO model_state" in sql:
            self.state[str(params["group_id"])] = {"body_text": params["body"], "content_hash": params["hash"], "source_ts": params["source_ts"]}
            return
        raise AssertionError(f"unexpected execute: {sql[:80]}")


@pytest.fixture
def patch_db(monkeypatch):
    def install(db: FakeDB):
        monkeypatch.setattr(models_engine, "fetch_all", db.fetch_all)
        monkeypatch.setattr(models_engine, "fetch_one", db.fetch_one)
        monkeypatch.setattr(models_engine, "execute", db.execute)
        models_engine._context_cache.clear()
        return db

    return install


def _group(kind="STATE", **extra):
    return {
        "id": uuid4(),
        "tenant_id": TENANT,
        "resource_id": MACHINE,
        "key": "state",
        "kind": kind,
        "status": "PUBLISHED",
        "projection_policy_json": {"mode": "compact", "missing": "null"},
        "emit_policy_json": {"republish_ms": None, "max_events": 1000, "snapshot_grace_ms": 0},
        **extra,
    }


async def test_state_model_composed_once_per_change(patch_db):
    status_id, emp_id = str(uuid4()), str(uuid4())
    group = _group()
    members = normalize_members(
        "STATE",
        _head() + [{"kind": "signal", "alias": "status", "signal_id": status_id}, {"kind": "signal", "alias": "employee", "signal_id": emp_id}],
    )
    t2 = T0 + timedelta(minutes=3)
    latest = {
        status_id: {"value_json": {"v": 1}, "quality": "GOOD", "unit": None, "source_time": T0, "received_time": T0, "event_time": T0},
        emp_id: {"value_json": {"v": "E-7"}, "quality": "GOOD", "unit": None, "source_time": t2, "received_time": t2, "event_time": t2},
    }
    db = patch_db(FakeDB([group], _member_rows(group["id"], members), latest))
    session = FakeSession()

    await models_engine.on_signals_changed(session, TENANT, {status_id})
    events = session.info.get("fx_events", [])
    assert [e["kind"] for e in events] == ["model_body"]
    body = json.loads(events[0]["body"])
    assert list(body) == ["zone_name", "line_name", "machine_name", "source_timestamp", "publish_timestamp", "status", "employee"]
    assert body["zone_name"] == "ASSY" and body["machine_name"] == "M-01"
    assert body["source_timestamp"] == "2026-06-20T08:03:00.000Z"
    assert events[0]["payload"] == {"type": "model_body", "group_id": str(group["id"]), "body": events[0]["body"]}

    # same values again (only publish time differs): no new state, no new message
    session2 = FakeSession()
    await models_engine.on_signals_changed(session2, TENANT, {status_id})
    assert session2.info.get("fx_events", []) == []
    assert db.state[str(group["id"])]["source_ts"] == t2


async def test_composition_error_is_logged_not_raised(monkeypatch, caplog):
    async def boom(*_args, **_kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(models_engine, "fetch_all", boom)
    session = FakeSession()
    await models_engine.on_signals_changed(session, TENANT, {str(uuid4())})
    assert session.info.get("fx_events", []) == []
    assert "Data model composition failed" in caplog.text


async def test_event_model_snapshots_order_at_completion_and_dedupes(patch_db):
    so, wo, qty, lot = (str(uuid4()) for _ in range(4))
    group = _group("EVENT", key="order_progress")
    members = normalize_members(
        "EVENT",
        _head(False)
        + [
            {"kind": "snapshot", "alias": "so", "signal_id": so},
            {"kind": "snapshot", "alias": "wo", "signal_id": wo},
            {"kind": "signal", "alias": "qty", "signal_id": qty, "is_trigger": True},
            {"kind": "signal", "alias": "lot_serial", "signal_id": lot, "is_trigger": True},
        ],
    )
    c1 = T0 + timedelta(minutes=10)
    order_change = c1 + timedelta(seconds=30)  # new order starts after the completion

    def obs(sid, value, ts):
        return {"signal_id": sid, "value_json": {"v": value}, "quality": "GOOD", "unit": None, "source_time": ts, "received_time": ts + timedelta(seconds=1), "event_time": ts + timedelta(seconds=1)}

    observations = [
        obs(so, "SO-1", T0), obs(wo, "WO-1", T0),
        obs(qty, 5, c1), obs(lot, "LOT-1", c1),
        obs(so, "SO-2", order_change), obs(wo, "WO-2", order_change),
    ]
    db = patch_db(FakeDB([group], _member_rows(group["id"], members), {}, observations))

    session = FakeSession()
    await models_engine.on_signals_changed(session, TENANT, {qty, lot})
    events = session.info.get("fx_events", [])
    assert [e["kind"] for e in events] == ["model_event"]
    body = json.loads(events[0]["body"])
    assert list(body) == ["zone_name", "line_name", "source_timestamp", "publish_timestamp", "so", "wo", "qty", "lot_serial"]
    assert body["so"] == "SO-1" and body["wo"] == "WO-1"
    assert body["source_timestamp"] == "2026-06-20T08:10:00.000Z"

    # the same completion polled again: idempotent
    session2 = FakeSession()
    await models_engine.on_signals_changed(session2, TENANT, {qty})
    assert session2.info.get("fx_events", []) == []

    # a second completion under the new order
    c2 = order_change + timedelta(minutes=1)
    db.observations += [obs(qty, 7, c2), obs(lot, "LOT-2", c2)]
    session3 = FakeSession()
    await models_engine.on_signals_changed(session3, TENANT, {qty, lot})
    events3 = session3.info.get("fx_events", [])
    assert len(events3) == 1
    body3 = json.loads(events3[0]["body"])
    assert body3["wo"] == "WO-2" and body3["qty"] == 7
    assert len(db.events) == 2


# ---- member resolution (collect) -----------------------------------------------------------


class FakeSignals:
    def __init__(self, signals):
        self.signals = signals  # id -> {key, resource_id, status}

    async def fetch_all(self, _session, sql, params):
        if "id = ANY(:ids)" in sql:
            ids = {str(i) for i in params["ids"]}
            return [dict(v, id=k) for k, v in self.signals.items() if k in ids]
        if "resource_id = :resource_id AND status = 'ACTIVE'" in sql:
            return [
                {"id": k, "key": v["key"]}
                for k, v in self.signals.items()
                if str(v["resource_id"]) == str(params["resource_id"]) and v["status"] == "ACTIVE"
            ]
        raise AssertionError(sql[:80])


async def test_resolve_members_strict_and_rekey(monkeypatch):
    own, foreign, other_status = str(uuid4()), str(uuid4()), str(uuid4())
    fake = FakeSignals(
        {
            own: {"key": "status", "resource_id": MACHINE, "status": "ACTIVE"},
            foreign: {"key": "status", "resource_id": OTHER, "status": "ACTIVE"},
            other_status: {"key": "mode", "resource_id": OTHER, "status": "ACTIVE"},
        }
    )
    monkeypatch.setattr(collect, "fetch_all", fake.fetch_all)
    session = FakeSession()

    members = normalize_members("STATE", _head() + [{"kind": "signal", "alias": "status", "signal_id": foreign}])
    with pytest.raises(AppError) as exc:
        await collect._resolve_members(session, TENANT, MACHINE, members, rekey=False)
    assert exc.value.code == "MEMBER_SIGNAL_OTHER_RESOURCE"

    resolved, missing = await collect._resolve_members(session, TENANT, MACHINE, members, rekey=True)
    assert missing == []
    assert resolved[-1].signal_id == own and resolved[-1].signal_key == "status"

    members = normalize_members("STATE", _head() + [{"kind": "signal", "alias": "mode", "signal_id": other_status}])
    _resolved, missing = await collect._resolve_members(session, TENANT, MACHINE, members, rekey=True)
    assert missing == ["mode"]


def test_topic_template_accepts_machine_variable():
    members = collect._validate_group_spec("{enterprise}/{site}/{area}/{zone}/{line}/{machine}/state", _head())
    assert len(members) == 5
    ctx = collect._topic_context([{"type_key": "machine", "code": "M01"}, {"type_key": "line", "code": "L1"}], "state")
    assert ctx["machine"] == "M01" and ctx["line"] == "L1" and ctx["resource"] == "M01" and ctx["group"] == "state"
