"""Round-4 collector fixes: bulk signal properties (R4-SG-02), batched signal usage (R4-SG-01)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from factorix.modules import collect
from factorix.platform.errors import AppError


class _DB:
    """collect.fetch_all / fetch_one / execute for the bulk-properties path."""

    def __init__(self, signals: dict[Any, dict[str, Any]], sources: dict[Any, dict[str, Any]]) -> None:
        self.signals = signals
        self.sources = sources
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self.updates: list[dict[str, Any]] = []

    async def fetch_all(self, _session: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        if "FROM signal_definitions WHERE tenant_id" in sql:
            return [dict(row, id=sid) for sid, row in self.signals.items() if sid in params["ids"]]
        if "DISTINCT ON (b.signal_id)" in sql:
            return [dict(row, signal_id=sid) for sid, row in self.sources.items() if sid in params["ids"]]
        raise AssertionError(sql[:80])

    async def fetch_one(self, _session: Any, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        if " ".join(sql.split()).startswith("UPDATE signal_definitions SET unit"):
            row = self.signals[params["id"]]
            if int(row["version"]) != params["version"]:
                return None
            row["version"] = int(row["version"]) + 1
            row["unit"], row["expected_interval_ms"] = params["unit"], params["interval"]
            self.updates.append(params)
            return {"version": row["version"]}
        raise AssertionError(sql[:80])

    async def execute(self, _session: Any, sql: str, params: dict[str, Any]) -> None:
        self.executed.append((" ".join(sql.split()), params))


def _signal(version: int = 1, data_type: str = "float64", unit: str | None = "rpm", interval: int | None = 1000) -> dict[str, Any]:
    return {"version": version, "status": "ACTIVE", "data_type": data_type, "display_name": f"speed v{version}", "unit": unit, "expected_interval_ms": interval}


def _source(edge: Any, address: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "binding_id": uuid4(), "revision": 1, "enabled": True, "transform_chain_json": [],
        "source_field_id": uuid4(), "acquisition_job_id": uuid4(), "address_kind": "modbus",
        "address_json": address or {"unit_id": 11, "offset": 10, "native_type": "float32", "register_area": "holding"},
        "native_datatype": "float32", "decode_json": {}, "ordinal": 0, "connection_id": uuid4(), "protocol": "modbus_tcp",
        "edge_id": edge, "connection_status": "ACTIVE",
    }


def _patches(db: _DB, bump: AsyncMock, audit: AsyncMock):  # noqa: ANN202
    return (
        patch.object(collect, "fetch_all", db.fetch_all),
        patch.object(collect, "fetch_one", db.fetch_one),
        patch.object(collect, "execute", db.execute),
        patch.object(collect, "bump_edge_release", bump),
        patch.object(collect, "audit", audit),
    )


async def _run(db: _DB, body: collect.SignalBulkPropertiesIn) -> tuple[dict[str, Any], AsyncMock, AsyncMock]:
    bump, audit = AsyncMock(), AsyncMock()
    p1, p2, p3, p4, p5 = _patches(db, bump, audit)
    with p1, p2, p3, p4, p5:
        result = await collect.bulk_properties_signals(None, uuid4(), uuid4(), body, "corr")
    return result, bump, audit


@pytest.mark.asyncio
async def test_bulk_round_digits_readdresses_every_signal_in_one_release() -> None:
    edge = uuid4()
    a, b = uuid4(), uuid4()
    db = _DB({a: _signal(3), b: _signal(5)}, {a: _source(edge), b: _source(edge)})
    body = collect.SignalBulkPropertiesIn(items=[{"signal_id": str(a), "version": 3}, {"signal_id": str(b), "version": 5}], round_digits=1)
    result, bump, audit = await _run(db, body)
    assert result["count"] == 2 and result["unchanged"] == []
    assert {u["signal_id"]: u["version"] for u in result["updated"]} == {str(a): 4, str(b): 6}
    assert all(u["changed"] == ["round_digits"] for u in result["updated"])
    fields = [params for sql, params in db.executed if sql.startswith("INSERT INTO source_fields")]
    assert len(fields) == 2 and all('"round_digits": 1' in params["address"] or '"round_digits":1' in params["address"] for params in fields)
    assert bump.await_count == 1 and bump.await_args.kwargs["edge_id"] == edge  # one release per edge
    assert audit.await_count == 2
    assert audit.await_args.kwargs["after"]["bulk"] is True and audit.await_args.kwargs["event_type"] == "SIGNAL_UPDATE"


@pytest.mark.asyncio
async def test_bulk_unit_and_interval_without_address_change_publish_no_release() -> None:
    a, b = uuid4(), uuid4()
    db = _DB({a: _signal(1, unit="rpm", interval=1000), b: _signal(1, unit="", interval=500)}, {})
    body = collect.SignalBulkPropertiesIn(items=[{"signal_id": str(a), "version": 1}, {"signal_id": str(b), "version": 1}], unit=" rpm ", expected_interval_ms=1000)
    result, bump, _audit = await _run(db, body)
    assert result["unchanged"] == [str(a)]  # already rpm / 1000 ms
    assert result["updated"][0]["signal_id"] == str(b) and result["updated"][0]["changed"] == ["expected_interval_ms", "unit"]
    assert db.signals[b]["unit"] == "rpm" and db.signals[b]["expected_interval_ms"] == 1000
    assert db.executed == [] and bump.await_count == 0


@pytest.mark.asyncio
async def test_bulk_properties_is_all_or_nothing_with_per_item_errors() -> None:
    edge = uuid4()
    good, stale, text, missing = uuid4(), uuid4(), uuid4(), uuid4()
    db = _DB(
        {good: _signal(2), stale: _signal(7), text: _signal(1, data_type="string")},
        {good: _source(edge), stale: _source(edge), text: _source(edge)},
    )
    body = collect.SignalBulkPropertiesIn(
        items=[
            {"signal_id": str(good), "version": 2},
            {"signal_id": str(stale), "version": 6},
            {"signal_id": str(text), "version": 1},
            {"signal_id": str(missing), "version": 1},
            {"signal_id": str(good), "version": 2},
        ],
        round_digits=2,
    )
    bump, audit = AsyncMock(), AsyncMock()
    p1, p2, p3, p4, p5 = _patches(db, bump, audit)
    with p1, p2, p3, p4, p5:
        with pytest.raises(AppError) as exc:
            await collect.bulk_properties_signals(None, uuid4(), uuid4(), body, "corr")
    assert exc.value.status == 422 and exc.value.code == "BULK_PROPERTIES_REJECTED"
    codes = {(e["index"], e["code"]) for e in exc.value.extra["item_errors"]}
    assert codes == {(1, "RESOURCE_VERSION_CONFLICT"), (2, "TYPE"), (3, "NOT_FOUND"), (4, "DUPLICATE")}
    assert db.updates == [] and db.executed == [] and bump.await_count == 0 and audit.await_count == 0


@pytest.mark.asyncio
async def test_bulk_round_digits_null_removes_rounding() -> None:
    edge = uuid4()
    a = uuid4()
    db = _DB({a: _signal(1)}, {a: _source(edge, {"unit_id": 11, "offset": 10, "native_type": "float32", "register_area": "holding", "round_digits": 1})})
    body = collect.SignalBulkPropertiesIn(items=[{"signal_id": str(a), "version": 1}], round_digits=None)
    result, bump, _audit = await _run(db, body)
    assert result["count"] == 1
    field = next(params for sql, params in db.executed if sql.startswith("INSERT INTO source_fields"))
    assert "round_digits" not in field["address"]
    assert bump.await_count == 1


@pytest.mark.asyncio
async def test_bulk_properties_validates_the_request() -> None:
    a = uuid4()
    db = _DB({a: _signal(1)}, {})
    cases = [
        (collect.SignalBulkPropertiesIn(items=[{"signal_id": str(a), "version": 1}]), "REQUIRED"),
        (collect.SignalBulkPropertiesIn(items=[], unit="kW"), "LIMIT"),
        (collect.SignalBulkPropertiesIn(items=[{"signal_id": str(a), "version": 1}], expected_interval_ms=50), "INTERVAL"),
        (collect.SignalBulkPropertiesIn(items=[{"signal_id": str(a), "version": 1}], round_digits=11), "RANGE"),
        (collect.SignalBulkPropertiesIn(items=[{"signal_id": str(a), "version": 1}], unit="x" * 33), "UNIT"),
    ]
    for body, code in cases:
        bump, audit = AsyncMock(), AsyncMock()
        p1, p2, p3, p4, p5 = _patches(db, bump, audit)
        with p1, p2, p3, p4, p5:
            with pytest.raises(AppError) as exc:
                await collect.bulk_properties_signals(None, uuid4(), uuid4(), body, "corr")
        assert exc.value.code == code


def test_batched_usage_and_bulk_properties_routes_exist() -> None:
    from factorix.transport.app import app

    routes = {(route.path, method) for route in app.routes for method in getattr(route, "methods", set()) or set()}
    assert ("/api/v1/signals/usage", "POST") in routes
    assert ("/api/v1/signals/bulk-properties", "POST") in routes
    assert ("/api/v1/signals/{signal_id}/usage", "GET") in routes  # single lookup kept


@pytest.mark.asyncio
async def test_batched_usage_is_one_query_for_all_signals() -> None:
    from factorix.modules import data_models, usage

    ids = [uuid4() for _ in range(3)]
    calls: list[list[Any]] = []

    async def fake(_session: Any, _tenant: Any, signal_ids: Any) -> list[dict[str, Any]]:
        calls.append(list(signal_ids))
        return [{"id": "m2", "display_name": "b"}, {"id": "m1", "display_name": "A"}]

    with patch.object(data_models, "models_using_signals", fake):
        models = await usage.models_using_signals(None, uuid4(), ids)
    assert calls == [ids]
    assert [m["id"] for m in models] == ["m1", "m2"]  # sorted by name
