"""B-11 / OP-13 (CT-20): RabbitMQ queue depth + DLQ reach /health/ready?verbose=1 and /api/v1/edges (additive)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from factorix.application.health import broker_depth as BD
from factorix.platform.broker import BrokerHealthSnapshot

NOW = datetime(2026, 11, 25, 8, 0, 0, tzinfo=timezone.utc)


def _settings(**kw: Any) -> Any:
    from factorix.platform.settings import Settings

    return Settings(**{"rabbitmq_url": "amqp://u:p@broker:5672/", **kw})


def _snap(**kw: Any) -> BrokerHealthSnapshot:
    base = dict(broker_ok=True, ready_count=7, unacked_count=1, dlq_count=2, oldest_queued_age_s=3.5, checked_at=NOW,
                live_ready_count=5, live_unacked_count=1, legacy_ready_count=2, legacy_unacked_count=0)
    base.update(kw)
    return BrokerHealthSnapshot(**base)


@pytest.fixture(autouse=True)
def _clean() -> Any:
    BD.reset_for_tests()
    yield
    BD.reset_for_tests()


def test_snapshot_view_names_each_queue_and_never_invents_zero() -> None:
    view = BD.snapshot_to_dict(_snap(dlq_count=None))
    assert view["schema_version"] == 1
    assert (view["live_q_depth"], view["ingest_q_depth"], view["dlq_depth"], view["oldest_age_s"]) == (5, 2, None, 3.5)
    assert view["checked_at"] == "2026-11-25T08:00:00Z"


async def test_refresh_keeps_last_value_on_failure_and_skips_without_broker() -> None:
    calls: list[Any] = []

    async def ok_probe(cfg: Any) -> BrokerHealthSnapshot:
        calls.append(cfg)
        return _snap()

    async def bad_probe(_cfg: Any) -> BrokerHealthSnapshot:
        raise RuntimeError("broker gone")

    assert await BD.refresh(_settings(rabbitmq_url=""), probe=ok_probe) is None and calls == []
    assert BD.due()
    first = await BD.refresh(_settings(), probe=ok_probe)
    assert first is not None and first["dlq_depth"] == 2 and calls[0].dlq_name == "factorix.telemetry.dlq"
    assert not BD.due()
    again = await BD.refresh(_settings(), probe=bad_probe)
    assert again is not None and again["dlq_depth"] == 2  # previous measurement kept, error swallowed


async def test_refresh_is_bounded_in_time(monkeypatch: pytest.MonkeyPatch) -> None:
    async def hang(_cfg: Any) -> BrokerHealthSnapshot:
        await asyncio.sleep(60)
        return _snap()

    monkeypatch.setattr(BD, "PROBE_TIMEOUT_S", 0.05)
    assert await BD.refresh(_settings(), probe=hang) is None


@pytest.fixture()
def api(monkeypatch: pytest.MonkeyPatch) -> Any:
    from factorix.transport import app as A

    async def no_db() -> Any:
        yield SimpleNamespace()

    monkeypatch.setitem(A.app.dependency_overrides, A.db_session, no_db)
    return A


async def _ready(A: Any, path: str) -> Any:
    async with AsyncClient(transport=ASGITransport(app=A.app), base_url="http://test") as client:
        return await client.get(path)


async def test_ready_verbose_adds_processes_and_broker_depth(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from factorix.transport.http.routers import probes as P

    now = datetime.now(timezone.utc)
    rows = [{"role": "acquisition", "health": "HEALTHY", "broker_ok": True, "last_heartbeat": now},
            {"role": "ingestion", "health": "HEALTHY", "broker_ok": True, "last_heartbeat": now}]

    async def fake_fetch_all(_s: Any, _sql: str, _p: Any) -> list[dict[str, Any]]:
        return rows

    async def fake_fetch_one(_s: Any, _sql: str, _p: Any) -> dict[str, Any]:
        return {"ok": 1}

    class _Nested:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *_a: Any) -> None:
            return None

    async def db() -> Any:
        yield SimpleNamespace(begin_nested=lambda: _Nested())

    monkeypatch.setitem(api.app.dependency_overrides, api.db_session, db)
    monkeypatch.setattr(P, "fetch_all", fake_fetch_all)
    monkeypatch.setattr(P, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(P, "_settings", lambda: SimpleNamespace(appliance=True, collector_mode="acquisition", tdengine_dsn="ws://td"))

    async def ok_probe(_cfg: Any) -> BrokerHealthSnapshot:
        return _snap()

    await BD.refresh(_settings(), probe=ok_probe)
    plain = await _ready(api, "/health/ready")
    assert plain.status_code == 200 and plain.json() == {"status": "ready"}  # unchanged without verbose
    verbose = (await _ready(api, "/health/ready?verbose=1")).json()
    assert verbose["status"] == "ready"
    assert [p["role"] for p in verbose["processes"]] == ["acquisition", "ingestion"] and all(p["fresh"] for p in verbose["processes"])
    assert (verbose["broker"]["live_q_depth"], verbose["broker"]["ingest_q_depth"], verbose["broker"]["dlq_depth"]) == (5, 2, 2)
    assert set(verbose["notify_bridge"]) == {"connected", "reconnects", "last_error", "last_event_age_s"}

    rows[1]["last_heartbeat"] = datetime(2020, 1, 1, tzinfo=timezone.utc)
    down = await _ready(api, "/health/ready?verbose=1")
    assert down.status_code == 503 and down.json()["error"]["code"] == "INGESTION_DOWN"
    assert down.json()["error"]["broker"]["dlq_depth"] == 2  # the detail explains the 503
