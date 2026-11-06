"""Batched telemetry ingest (R2-SG-01): one statement per table per edge batch, same semantics."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from sqlalchemy.exc import DBAPIError

from factorix.modules import telemetry


class _Result:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows
        self.rowcount = len(rows)

    def mappings(self) -> "_Result":
        return self

    def first(self) -> dict | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[dict]:
        return self._rows

    def scalar(self) -> object:
        return "exists"


class _Nested:
    """Savepoint: dedup keys written inside it disappear when it rolls back, as in Postgres."""

    def __init__(self, session: "_IngestSession") -> None:
        self.session = session

    async def __aenter__(self) -> "_Nested":
        self.saved = set(self.session.seen_uids)
        return self

    async def __aexit__(self, exc_type: object, *exc: object) -> bool:
        if exc_type is not None:
            self.session.seen_uids = self.saved
        return False


class _IngestSession:
    """Answers ingest statements like Postgres would for an empty dedup table."""

    def __init__(self, binding_rows: list[dict], *, fail_bulk: bool = False) -> None:
        self.binding_rows = binding_rows
        self.fail_bulk = fail_bulk
        self.calls: list[tuple[str, dict]] = []
        self.info: dict = {}
        self.seen_uids: set[str] = set()

    def begin_nested(self) -> _Nested:
        return _Nested(self)

    async def execute(self, statement: object, params: dict | None = None) -> _Result:
        sql = str(statement)
        params = params or {}
        self.calls.append((sql, params))
        if "to_regclass" in sql:
            return _Result([])
        if "FROM edge_nodes WHERE id" in sql:
            return _Result([{"enrollment_status": "ENROLLED"}])
        if "FROM configuration_releases" in sql:
            return _Result([{"revision": 4}])
        if "FROM signal_bindings b" in sql:
            return _Result(self.binding_rows)
        if "INSERT INTO ingest_dedup" in sql:
            uids = params.get("uids") or [params.get("event_uid")]
            fresh = [u for u in uids if u not in self.seen_uids]
            self.seen_uids.update(fresh)
            return _Result([{"event_uid": u} for u in fresh])
        if "unnest(" in sql and "INSERT INTO observations" in sql and self.fail_bulk:
            raise DBAPIError("INSERT", {}, Exception("simulated batch failure"))
        if "INSERT INTO latest_signal_state" in sql:
            ids = params.get("signal_ids") or [params.get("signal_id")]
            return _Result([{"signal_id": item} for item in ids])
        return _Result([])

    def statements(self, fragment: str) -> list[tuple[str, dict]]:
        return [(sql, params) for sql, params in self.calls if fragment in sql]


def _binding(signal, resource, connection, field) -> dict:  # noqa: ANN001
    return {
        "signal_id": signal,
        "valid_from": datetime.now(timezone.utc) - timedelta(minutes=5),
        "valid_to": None,
        "resource_id": resource,
        "expected_interval_ms": 1000,
        "site_id": None,
        "connection_id": connection,
        "source_field_id": field,
        "nullable": False,
    }


def _item(uid: str, signal, resource, connection, received: datetime, value: object) -> dict:  # noqa: ANN001
    return {
        "event_uid": uid,
        "resource_id": str(resource),
        "signal_id": str(signal),
        "connection_id": str(connection),
        "received_time": received.isoformat(),
        "source_time": None,
        "value": value,
        "data_type": "float64",
        "quality": "GOOD",
        "config_revision": 4,
    }


def _run(session: _IngestSession, items: list[dict]) -> dict:
    with patch.object(telemetry.models_engine, "on_signals_changed", AsyncMock()):
        return asyncio.run(telemetry.ingest_observations(session, tenant_id=uuid4(), edge_id=uuid4(), items=items))


def test_batch_uses_one_statement_per_table_and_newest_latest_per_signal() -> None:
    resource, connection = uuid4(), uuid4()
    a, b = uuid4(), uuid4()
    session = _IngestSession([_binding(a, resource, connection, uuid4()), _binding(b, resource, connection, uuid4())])
    t0 = datetime.now(timezone.utc) - timedelta(seconds=3)
    items = [
        _item("a-1", a, resource, connection, t0, 1.0),
        _item("b-1", b, resource, connection, t0 + timedelta(milliseconds=10), 10.0),
        _item("a-1", a, resource, connection, t0, 1.0),  # retried inside the same batch
        _item("a-2", a, resource, connection, t0 + timedelta(seconds=1), 2.0),
    ]
    result = _run(session, items)

    assert [r["status"] for r in result["results"]] == ["committed", "committed", "duplicate", "committed"]
    assert len(session.statements("INSERT INTO ingest_dedup")) == 1
    assert len(session.statements("INSERT INTO observations")) == 1
    assert len(session.statements("INSERT INTO latest_signal_state")) == 1
    observations = session.statements("INSERT INTO observations")[0][1]
    assert observations["event_uids"] == ["a-1", "b-1", "a-2"]
    latest = session.statements("INSERT INTO latest_signal_state")[0][1]
    by_signal = dict(zip(latest["signal_ids"], latest["value_jsons"]))
    assert by_signal == {a: '{"v":2.0}', b: '{"v":10.0}'}  # one row per signal, the newest received_time
    kinds = [event["kind"] for event in session.info["fx_events"]]
    assert kinds.count("latest") == 2


def test_newest_per_signal_orders_by_received_time_then_id() -> None:
    from factorix.domain.observation import Observation, Quality
    from factorix.domain.quality import Origin

    signal = uuid4()
    moment = datetime(2026, 11, 6, 8, 0, tzinfo=timezone.utc)

    def obs(at: datetime) -> Observation:
        return Observation(
            event_uid=str(uuid4()), tenant_id=uuid4(), resource_id=uuid4(), signal_id=signal, event_time=at, received_time=at,
            value=1, data_type="int64", unit=None, quality=Quality.GOOD, origin=Origin.LIVE, config_revision=1,
        )

    older, newer = obs(moment), obs(moment + timedelta(milliseconds=1))
    low, high = sorted([uuid4(), uuid4()], key=str)
    rows = [(high, older, {}), (low, newer, {})]
    assert telemetry.newest_per_signal(rows)[signal][1] is newer
    same = [(low, older, {}), (high, older, {})]
    assert telemetry.newest_per_signal(same)[signal][0] == high


def test_batch_failure_falls_back_to_row_by_row() -> None:
    resource, connection, signal = uuid4(), uuid4(), uuid4()
    session = _IngestSession([_binding(signal, resource, connection, uuid4())], fail_bulk=True)
    t0 = datetime.now(timezone.utc) - timedelta(seconds=2)
    items = [_item("r-1", signal, resource, connection, t0, 1.0), _item("r-2", signal, resource, connection, t0 + timedelta(seconds=1), 2.0)]
    result = _run(session, items)
    # The batch dedup keys were rolled back with the savepoint; the per-row path stores both samples.
    per_row = [params for sql, params in session.statements("INSERT INTO observations") if "unnest(" not in sql]
    assert [params["event_uid"] for params in per_row] == ["r-1", "r-2"]
    assert [r["status"] for r in result["results"]] == ["committed", "committed"]
