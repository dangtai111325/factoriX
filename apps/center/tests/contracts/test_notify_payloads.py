"""Characterization: PostgreSQL LISTEN/NOTIFY channels and payloads (contract contracts/notify.md).

Every payload form that a producer emits today must still be accepted by every consumer of the channel.
"""

from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.modules import ingestion_worker as IW
from factorix.modules.live_state import TDengineLiveStateProvider, configure_live_state_provider, get_live_state_provider
from factorix.modules.telemetry import connection_health_payload, latest_stream_payload
from factorix.transport.hub import parse_pg_notify_events

SRC = Path(__file__).resolve().parents[2] / "src" / "factorix"
ACQ_SRC = Path(__file__).resolve().parents[3] / "acquisition" / "src" / "factorix_acquisition"
TENANT = "00000000-0000-0000-0000-0000000000a1"
NOW = datetime(2026, 11, 18, 5, 0, 0, tzinfo=timezone.utc)

# Channel -> (producers, consumers) as documented in notify.md (module stems).
# R2-E Phase B moved the code, not the channels or payloads: ``collect`` -> application/legacy_edge/fleet +
# application/collector/commissioning; ``app`` -> transport/http/routers/connections + transport/background/notify_bridge;
# ``ingestion_worker`` -> application/ingestion/{notify,catalog}.
CHANNELS = {
    "factorix_config_changed": ({"fleet", "storage_designs", "telemetry_reset", "connections"}, {"config_provider", "catalog"}),
    "factorix_epoch_changed": ({"telemetry_reset"}, {"config_provider", "catalog", "notify_bridge"}),
    "factorix_stream_events": ({"notify"}, {"notify_bridge"}),
    # R2-E C2: acquisition's health push is written by HealthService (single writer of connections.health).
    "factorix_health_changed": ({"health_service", "notify"}, {"notify_bridge"}),
    "factorix_commissioning": ({"commissioning"}, {"config_provider"}),
}

_LISTEN_RE = re.compile(r"add_listener\(\s*\"(factorix_[a-z_]+)\"")
_NOTIFY_LITERAL_RE = re.compile(r"pg_notify\('(factorix_[a-z_]+)'")
_CHANNEL_PARAM_RE = re.compile(r"\"channel\":\s*\"(factorix_[a-z_]+)\"")
_CONST_RE = re.compile(r"^NOTIFY_CHANNEL_[A-Z]+\s*=\s*\"(factorix_[a-z_]+)\"", re.M)


def _scan() -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    produced: dict[str, set[str]] = {}
    listened: dict[str, set[str]] = {}
    for path in list(SRC.rglob("*.py")) + list(ACQ_SRC.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for rx, target in ((_NOTIFY_LITERAL_RE, produced), (_CHANNEL_PARAM_RE, produced), (_CONST_RE, produced), (_LISTEN_RE, listened)):
            for name in rx.findall(text):
                target.setdefault(name, set()).add(path.stem)
    return produced, listened


def test_channel_registry_matches_code() -> None:
    produced, listened = _scan()
    assert set(produced) == set(CHANNELS), f"NOTIFY producers changed: {produced}"
    for channel, (producers, consumers) in CHANNELS.items():
        assert produced[channel] == producers, channel
        assert listened.get(channel, set()) == consumers, channel
    # ADR-006 used to list a fence channel that never existed (CT-17).
    assert "factorix_reset_fence" not in produced and "factorix_reset_fence" not in listened


# ---------------------------------------------------------------------------- stream events v1


class _CaptureConn:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, list[str]]] = []

    async def execute(self, sql: str, channel: str, payloads: list[str]) -> None:
        self.calls.append((sql, channel, list(payloads)))


def _latest_event(i: int, value: Any = 1.0) -> dict[str, Any]:
    sid = uuid4()
    return {
        "kind": "latest", "tenant_id": TENANT, "signal_id": str(sid), "resource_id": str(uuid4()), "value_type": "float64",
        "unit": "bar", "event_uid": f"fx-1-{i:032x}", "source_sequence": i, "config_revision": 3, "origin": "LIVE",
        "payload": latest_stream_payload(signal_id=sid, value=value, quality="GOOD", reason=None, received_time=NOW, source_time=NOW,
                                         expected_interval_ms=1000, now=NOW, include_meta=True, data_epoch=1, last_acquired_at=NOW,
                                         last_value_changed_at=NOW),
    }


async def test_v1_events_are_chunked_and_round_trip_through_the_bridge_parser() -> None:
    events = [_latest_event(i) for i in range(150)]
    conn = _CaptureConn()
    await IW._emit_chunked_notify(conn, IW.NOTIFY_CHANNEL_STREAM, events)
    ((_sql, channel, payloads),) = conn.calls
    assert channel == "factorix_stream_events"
    assert all(len(p.encode("utf-8")) <= IW.NOTIFY_CHUNK_MAX_BYTES for p in payloads)
    parsed = [ev for p in payloads for ev in parse_pg_notify_events(channel, p)]
    assert all(len(parse_pg_notify_events(channel, p)) <= IW.NOTIFY_CHUNK_MAX_EVENTS for p in payloads)
    assert [ev["signal_id"] for ev in parsed] == [ev["signal_id"] for ev in events]
    assert set(parsed[0]["payload"]) >= {"type", "signal_id", "value", "quality", "effective_status", "reason_code", "received_time",
                                         "source_time", "evaluated_at", "stale_after_ms", "data_epoch", "last_acquired_at"}


async def test_v1_oversized_value_is_dropped_not_the_event() -> None:
    conn = _CaptureConn()
    await IW._emit_chunked_notify(conn, IW.NOTIFY_CHANNEL_STREAM, [_latest_event(1, value="x" * 9000)])
    ((_sql, _ch, payloads),) = conn.calls
    (event,) = parse_pg_notify_events("factorix_stream_events", payloads[0])
    assert "value" not in event["payload"] and event["payload"]["signal_id"]
    assert len(payloads[0]) < 8000  # PostgreSQL hard limit for a NOTIFY payload


# ---------------------------------------------------------------------------- stream events v2


def test_v2_latest_ids_payload_shape_and_chunking() -> None:
    ids = [str(uuid4()) for _ in range(500)]
    conns = [str(uuid4()) for _ in range(40)]
    payloads = IW._latest_ids_payloads(UUID(TENANT), ids, conns, NOW)
    bodies = [json.loads(p) for p in payloads]
    assert all(len(p) < IW.NOTIFY_CHUNK_MAX_BYTES for p in payloads)
    assert [i for b in bodies for i in b["signal_ids"]] == ids
    for b in bodies:
        assert set(b) == {"v", "kind", "tenant_id", "signal_ids", "max_acquired_at", "connection_ids"}
        assert b["v"] == 2 and b["kind"] == "latest_ids" and b["tenant_id"] == TENANT
        assert b["max_acquired_at"] == "2026-11-18T05:00:00.000Z"
        assert len(b["connection_ids"]) == 32  # capped (documented in notify.md)
    assert IW._latest_ids_payloads(UUID(TENANT), [], conns, NOW) == []


def test_v2_payload_is_routed_by_the_bridge_and_not_by_the_v1_parser() -> None:
    from factorix.transport import app as A
    from factorix_core.contracts.notify import LatestIdsV2, StreamEventsV1, parse_stream_events

    payload = IW._latest_ids_payloads(UUID(TENANT), [str(uuid4())], [str(uuid4())], NOW)[0]
    # CT-04 fixed: classified by its v / kind markers, not by a substring.
    assert isinstance(parse_stream_events(payload), LatestIdsV2)
    assert isinstance(parse_stream_events(json.dumps({"events": [_latest_event(1)]})), StreamEventsV1)
    assert parse_stream_events(json.dumps({"v": 3, "kind": "latest_ids", "tenant_id": TENANT, "signal_ids": []})) is None
    assert parse_stream_events(json.dumps({"events": [], "note": '"signal_ids"'})) == StreamEventsV1(())
    tenant, ids = A._parse_latest_ids(payload)
    assert tenant == TENANT and len(ids) == 1
    assert parse_pg_notify_events("factorix_stream_events", payload) == []


# ---------------------------------------------------------------------------- health


def test_health_payload_shapes_are_identical_for_all_producers() -> None:
    cid = uuid4()
    center = connection_health_payload(connection_id=cid, health="DEGRADED", effective_health="DEGRADED", last_error="x", last_success_at=NOW)
    # R2-E C2: every producer (acquisition report, sweep, Edge, sample evidence) builds it with
    # HealthService.health_payload.
    from factorix.application.health.health_service import health_payload

    assert health_payload(connection_id=cid, health="DEGRADED", effective_health="DEGRADED", last_error="x", last_success_at=NOW) == center
    wire = json.dumps({"tenant_id": TENANT, "event": center})
    (event,) = parse_pg_notify_events("factorix_health_changed", wire)
    assert event == {"kind": "health", "tenant_id": TENANT, "payload": center}


@pytest.mark.parametrize("payload", ["", "not json", "[]", '{"x":1}', '{"events":[{"kind":"latest"}]}'])
def test_parser_ignores_malformed_payloads(payload: str) -> None:
    assert parse_pg_notify_events("factorix_stream_events", payload) == []


# ---------------------------------------------------------------------------- config / epoch


@pytest.mark.parametrize(
    ("channel", "payload", "expect_tid", "expect_epoch"),
    [
        ("factorix_config_changed", json.dumps({"tenant_id": TENANT}), TENANT, False),  # collect._notify_config_changed
        ("factorix_config_changed", f'{{"tenant_id":"{TENANT}"}}', TENANT, False),  # app.py POST /api/v1/jobs (f-string)
        ("factorix_config_changed", json.dumps({"tenant_id": TENANT, "kind": "storage_design_published", "design_id": "d", "version": 2}), TENANT, False),
        ("factorix_epoch_changed", json.dumps({"tenant_id": TENANT, "previous_epoch": 1, "active_epoch": 2, "new_epoch": 2,
                                               "lifecycle_state": "RESETTING", "operation_id": "o", "kind": "x"}), TENANT, True),
        ("factorix_config_changed", "garbage", None, False),  # unknown tenant -> invalidate every tenant
    ],
)
def test_ingestion_accepts_every_config_and_epoch_payload(channel: str, payload: str, expect_tid: str | None, expect_epoch: bool) -> None:
    calls: list[tuple[Any, bool]] = []
    cleared: list[Any] = []
    epochs: list[Any] = []

    def _invalidate(tid: Any, epoch_changed: bool = False, new_epoch: Any = None) -> None:
        calls.append((tid, epoch_changed))
        epochs.append(new_epoch)

    stub = SimpleNamespace(invalidate_tenant_cache=_invalidate, recent_uids=SimpleNamespace(clear_tenant=cleared.append))
    IW.IngestionWorker._on_pg_notify(stub, None, 0, channel, payload)  # type: ignore[arg-type]
    assert calls == [(UUID(expect_tid) if expect_tid else None, expect_epoch)]
    assert cleared == ([UUID(expect_tid)] if expect_epoch and expect_tid else [])
    # CT-06 fixed: the ingestion live provider is fenced at the payload's epoch (was cached + 1).
    assert epochs == [2 if expect_epoch else None]


async def test_collect_config_changed_payload() -> None:
    from factorix.modules import collect

    captured: list[dict[str, Any]] = []

    async def fake_execute(_session: Any, sql: str, params: dict[str, Any]) -> None:
        captured.append(params)

    orig = collect.execute
    collect.execute = fake_execute  # type: ignore[assignment]
    try:
        await collect._notify_config_changed(None, UUID(TENANT))  # type: ignore[arg-type]
    finally:
        collect.execute = orig  # type: ignore[assignment]
    assert captured == [{"channel": "factorix_config_changed", "payload": json.dumps({"tenant_id": TENANT})}]


# ---------------------------------------------------------------------------- bridge -> API live cache


@pytest.fixture()
def live_provider():
    previous = get_live_state_provider()
    provider = TDengineLiveStateProvider(None)
    configure_live_state_provider(provider)
    try:
        yield provider
    finally:
        configure_live_state_provider(previous)


def test_seed_live_cache_missing_quality_is_not_good(live_provider: TDengineLiveStateProvider) -> None:
    from factorix.transport import app as A

    ev = _latest_event(1)
    del ev["payload"]["quality"]
    A._seed_live_cache([ev])
    entry = live_provider.get_entry(UUID(TENANT), UUID(ev["signal_id"]))
    assert entry is not None
    assert entry.record.raw_quality != "GOOD"
    assert entry.record.last_good_value is None  # CT-02 fixed: not recorded as last good either


def test_seed_live_cache_from_v1_event(live_provider: TDengineLiveStateProvider) -> None:
    from factorix.transport import app as A

    ev = _latest_event(2)
    A._seed_live_cache([ev])
    entry = live_provider.get_entry(UUID(TENANT), UUID(ev["signal_id"]))
    assert entry is not None and entry.record.value == 1.0 and entry.record.last_acquired_at == NOW


async def test_v2_latest_ids_seeds_live_cache(live_provider: TDengineLiveStateProvider, monkeypatch: pytest.MonkeyPatch) -> None:
    from factorix.transport import app as A

    sid = uuid4()
    row = {"signal_id": sid, "resource_id": uuid4(), "value": 2.0, "raw_quality": "GOOD", "effective_status": "GOOD", "reason_code": "OK",
           "received_time": "2026-11-18T05:00:00.000Z", "source_time": None, "last_acquired_at": "2026-11-18T05:00:00.000Z", "data_epoch": 1}

    @asynccontextmanager
    async def fake_session():
        yield None

    async def fake_latest_states(_session: Any, _tid: Any, _ids: Any) -> list[dict[str, Any]]:
        return [row]

    monkeypatch.setattr(A, "session_factory", lambda: fake_session)
    monkeypatch.setattr(A.telemetry, "latest_states", fake_latest_states)
    dispatched: list[Any] = []
    monkeypatch.setattr(A.hub, "dispatch", dispatched.append)
    await A._dispatch_latest_ids(TENANT, [str(sid)])
    assert dispatched, "push path itself must work"
    assert live_provider.get_entry(UUID(TENANT), sid) is not None


# ---------------------------------------------------------------------------- v2 is the default (R2-E C6)


def test_v2_is_the_default_notify_format(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FACTORIX_NOTIFY_FORMAT", raising=False)
    assert IW.PgIngestionStore("postgresql://x:y@localhost:1/db").notify_format == "v2"
    monkeypatch.setenv("FACTORIX_NOTIFY_FORMAT", "v1")  # kill switch
    assert IW.PgIngestionStore("postgresql://x:y@localhost:1/db").notify_format == "v1"


def test_every_channel_literal_is_in_the_registry() -> None:
    """The typed registry (``factorix_core.contracts.notify.Channel``) is the documented channel set."""
    from factorix_core.contracts.notify import CHANNELS as REGISTRY

    produced, listened = _scan()
    assert set(produced) | set(listened) <= REGISTRY
    assert REGISTRY == set(CHANNELS)


async def test_v2_bridge_feeds_every_v1_consumer(live_provider: TDengineLiveStateProvider, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every consumer of ``factorix_stream_events`` gets from v2 what it got from v1: the API live cache
    (model engine / Data Models), the delivery evidence (DELAYED vs STALE) and the socket push."""
    from factorix.modules.live_state import PipelineEvidence
    from factorix.transport import app as A
    from factorix.transport.background import notify_bridge as NB

    sid, conn_id = uuid4(), str(uuid4())
    row = {"signal_id": sid, "resource_id": uuid4(), "value": 3.0, "value_json": {"v": 3.0}, "raw_quality": "GOOD",
           "quality": "GOOD", "effective_status": "GOOD", "reason_code": "OK", "received_time": "2026-11-18T05:00:00.000Z",
           "source_time": None, "last_acquired_at": "2026-11-18T05:00:00.000Z", "data_epoch": 1, "connection_id": conn_id,
           "freshness": "FRESH", "stale_after_ms": 12000}

    @asynccontextmanager
    async def fake_session():
        yield None

    async def fake_latest_states(_session: Any, _tid: Any, _ids: Any) -> list[dict[str, Any]]:
        return [row]

    evidence = PipelineEvidence()
    monkeypatch.setattr(NB, "get_pipeline_evidence", lambda: evidence)
    monkeypatch.setattr(A, "session_factory", lambda: fake_session)
    monkeypatch.setattr(A.telemetry, "latest_states", fake_latest_states)
    dispatched: list[Any] = []
    monkeypatch.setattr(A.hub, "dispatch", dispatched.append)

    payload = IW._latest_ids_payloads(UUID(TENANT), [str(sid)], [conn_id], NOW)[0]
    request = A._parse_latest_ids(payload)
    assert request is not None
    assert evidence.delivered[conn_id] == NOW  # delivery evidence from the v2 head
    await A._dispatch_latest_ids(*request)
    (events,) = dispatched
    (event,) = events
    assert event["kind"] == "latest" and event["payload"]["value"] == 3.0 and event["payload"]["signal_id"] == str(sid)
    entry = live_provider.get_entry(UUID(TENANT), sid)
    assert entry is not None and entry.record.value == 3.0 and not entry.restored_unverified  # model engine input
