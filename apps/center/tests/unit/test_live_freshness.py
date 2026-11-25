"""WS-Q: source freshness (STALE) is separated from pipeline delivery lag (DELAYED); live push liveness."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pytest

from factorix.domain.signal_state import classify_freshness, evaluate_signal_state
from factorix.modules.live_state import PipelineEvidence, refresh_live_message
from factorix.transport.hub import Channel, Hub

NOW = datetime(2026, 11, 18, 2, 30, 0, tzinfo=timezone.utc)
T = 12_000


def _ago(seconds: float) -> datetime:
    return NOW - timedelta(seconds=seconds)


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------- domain rule


def test_fresh_value_is_fresh() -> None:
    v = classify_freshness(last_acquired_at=_ago(3), now=NOW, stale_after_ms=T)
    assert v.freshness == "FRESH" and v.reason_code is None


def test_pipeline_lag_with_source_alive_is_delayed_not_stale() -> None:
    """Measured incident: lag 33-36 s on all protocols while PC03 delivered at 1 Hz -> 336/336 STALE."""
    v = classify_freshness(
        last_acquired_at=_ago(35), now=NOW, stale_after_ms=T,
        source_ok_at=_ago(4), source_reported_at=_ago(3), delivered_at=_ago(34),
    )
    assert v.freshness == "DELAYED" and v.reason_code == "DELIVERY_DELAYED"
    assert 34_000 <= (v.delivery_lag_ms or 0) <= 36_000


def test_silent_source_is_stale_even_when_pipeline_is_late() -> None:
    # acquisition's last successful read is 40 s old at report time
    v = classify_freshness(
        last_acquired_at=_ago(41), now=NOW, stale_after_ms=T,
        source_ok_at=_ago(40), source_reported_at=_ago(2), delivered_at=_ago(41),
    )
    assert v.freshness == "STALE" and v.reason_code == "NO_FRESH_ACQUISITION"


def test_silent_topic_while_same_connection_delivers_is_stale() -> None:
    v = classify_freshness(
        last_acquired_at=_ago(30), now=NOW, stale_after_ms=T,
        source_ok_at=_ago(1), source_reported_at=_ago(1), delivered_at=_ago(1),
    )
    assert v.freshness == "STALE"


def test_without_source_evidence_old_values_are_stale() -> None:
    assert classify_freshness(last_acquired_at=_ago(30), now=NOW, stale_after_ms=T).freshness == "STALE"


def test_acquisition_heartbeat_missing_is_stale() -> None:
    v = classify_freshness(last_acquired_at=_ago(30), now=NOW, stale_after_ms=T, source_ok_at=_ago(40), source_reported_at=_ago(40))
    assert v.freshness == "STALE"


def test_delay_is_capped() -> None:
    v = classify_freshness(
        last_acquired_at=_ago(400), now=NOW, stale_after_ms=T,
        source_ok_at=_ago(2), source_reported_at=_ago(1), delivered_at=_ago(399),
    )
    assert v.freshness == "STALE" and v.reason_code == "DELIVERY_STALLED"


def test_evaluate_signal_state_keeps_good_and_value_when_delayed() -> None:
    result = evaluate_signal_state(
        has_observation=True, raw_quality="GOOD", raw_value=368.1, event_time=_ago(30), last_acquired_at=_ago(30),
        now=NOW, source_ok_at=_ago(3), source_reported_at=_ago(2), delivered_at=_ago(29),
    )
    assert result.effective_status == "GOOD" and result.freshness == "DELAYED"
    assert result.reason_code == "DELIVERY_DELAYED" and result.delivery_lag_ms and result.delivery_lag_ms >= 29_000


def test_evaluate_signal_state_without_evidence_is_unchanged_stale() -> None:
    result = evaluate_signal_state(has_observation=True, raw_quality="GOOD", raw_value=1, event_time=_ago(30), last_acquired_at=_ago(30), now=NOW)
    assert result.effective_status == "STALE" and result.freshness == "STALE"


def test_bad_sample_keeps_bad_status_and_is_annotated_delayed() -> None:
    result = evaluate_signal_state(
        has_observation=True, raw_quality="BAD", raw_value=None, event_time=_ago(30), last_acquired_at=_ago(30), now=NOW,
        source_ok_at=_ago(3), source_reported_at=_ago(2), delivered_at=_ago(29),
    )
    assert result.effective_status == "BAD" and result.freshness == "DELAYED"


# --------------------------------------------------------------------------- dispatch-time refresh


def _evidence(sid: str, cid: str, *, source_age: float, delivered_age: float | None) -> PipelineEvidence:
    ev = PipelineEvidence()
    ev.set_mapping([{"signal_id": sid, "connection_id": cid, "expected_interval_ms": None, "interval_ms": 1000}], now=NOW)
    ev.set_source([{"id": cid, "last_success_at": _ago(source_age)}], _ago(1))
    if delivered_age is not None:
        ev.note_delivery(sid, _ago(delivered_age))
    return ev


def _msg(sid: str, age: float, status: str = "STALE", reason: str = "NO_FRESH_ACQUISITION") -> dict[str, Any]:
    return {
        "type": "latest", "signal_id": sid, "value": 12.5, "quality": "GOOD", "effective_status": status,
        "reason_code": reason, "last_acquired_at": _iso(_ago(age)), "received_time": _iso(_ago(age)), "stale_after_ms": T,
    }


def test_refresh_turns_ingestion_stale_into_delayed_and_keeps_value() -> None:
    sid, cid = str(uuid4()), str(uuid4())
    ev = _evidence(sid, cid, source_age=2, delivered_age=20)
    out = refresh_live_message(_msg(sid, 20), now=NOW, evidence=ev)
    assert out["effective_status"] == "GOOD" and out["freshness"] == "DELAYED" and out["value"] == 12.5
    assert out["reason_code"] == "DELIVERY_DELAYED" and out["connection_id"] == cid
    assert out["delivery_lag_ms"] >= 20_000


def test_refresh_job_interval_fallback_for_slow_poll() -> None:
    """A 30 s HTTP poll without signal expected_interval_ms must not be STALE after 12 s."""
    sid, cid = str(uuid4()), str(uuid4())
    ev = PipelineEvidence()
    ev.set_mapping([{"signal_id": sid, "connection_id": cid, "expected_interval_ms": None, "interval_ms": 30_000}], now=NOW)
    out = refresh_live_message(_msg(sid, 25, status="GOOD", reason="OK"), now=NOW, evidence=ev)
    assert out["stale_after_ms"] == 60_000 and out["freshness"] == "FRESH" and out["effective_status"] == "GOOD"


def test_refresh_never_touches_bad_paused_or_unverified() -> None:
    sid, cid = str(uuid4()), str(uuid4())
    ev = _evidence(sid, cid, source_age=2, delivered_age=20)
    bad = dict(_msg(sid, 20), quality="BAD", effective_status="BAD", reason_code="TIMEOUT")
    assert refresh_live_message(bad, now=NOW, evidence=ev)["effective_status"] == "BAD"
    paused = dict(_msg(sid, 20), effective_status="PAUSED")
    assert refresh_live_message(paused, now=NOW, evidence=ev) is paused
    unverified = dict(_msg(sid, 3), effective_status="UNCERTAIN", reason_code="UNVERIFIED_AFTER_RESTART")
    assert refresh_live_message(unverified, now=NOW, evidence=ev)["effective_status"] == "UNCERTAIN"


# --------------------------------------------------------------------------- hub: sweep, heartbeat, zombie sockets


def _hub(ev: PipelineEvidence, now: list[datetime]) -> Hub:
    hub = Hub()
    hub.refresher = lambda m: refresh_live_message(m, now=now[0], evidence=ev)
    hub.observer = lambda e, m: ev.note_delivery(m.get("signal_id"), m.get("last_acquired_at"))
    hub.summary = lambda: ev.pipeline_summary(now[0])
    hub.connection_of = ev.connection_of
    return hub


def test_sweep_pushes_only_transitions_and_heartbeat_reports_pipeline() -> None:
    sid, cid = str(uuid4()), str(uuid4())
    ev = _evidence(sid, cid, source_age=1, delivered_age=None)
    clock = [NOW]
    hub = _hub(ev, clock)

    async def noop(_frame: dict[str, Any]) -> None:
        return None

    channel = Channel(noop, "t1")
    channel.signals.add(sid)
    hub.register(channel)
    hub.dispatch([{"kind": "latest", "tenant_id": "t1", "signal_id": sid, "payload": _msg(sid, 1, status="GOOD", reason="OK")}])
    first = channel.drain()
    assert first[0]["effective_status"] == "GOOD" and first[0]["freshness"] == "FRESH"

    hub.sweep(channel)
    assert channel.drain() == []  # nothing changed -> nothing sent

    # 20 s later no new sample, acquisition still reads the source -> DELAYED (value kept)
    clock[0] = NOW + timedelta(seconds=20)
    ev.set_source([{"id": cid, "last_success_at": clock[0] - timedelta(seconds=1)}], clock[0] - timedelta(seconds=1))
    hub.tick(_iso(clock[0]))
    out = channel.drain()
    delayed = [m for m in out if m.get("type") == "latest"]
    beats = [m for m in out if m.get("type") == "heartbeat"]
    assert delayed and delayed[0]["freshness"] == "DELAYED" and delayed[0]["value"] == 12.5
    assert beats and beats[0]["seq"] == 1 and cid in beats[0]["pipeline"]

    # source goes silent (acquisition's last OK stops advancing) -> STALE
    clock[0] = NOW + timedelta(seconds=60)
    ev.source_reported_at = clock[0] - timedelta(seconds=2)
    hub.tick(_iso(clock[0]))
    stale = [m for m in channel.drain() if m.get("type") == "latest"]
    assert stale and stale[0]["effective_status"] == "STALE"


@pytest.mark.asyncio
async def test_failed_send_closes_the_socket_no_zombie() -> None:
    closed: list[bool] = []

    async def broken_send(_frame: dict[str, Any]) -> None:
        raise ConnectionResetError("gone")

    async def close() -> None:
        closed.append(True)

    channel = Channel(broken_send, "t1", on_close=close)
    task = asyncio.create_task(channel.run())
    channel.offer({"type": "heartbeat", "seq": 1})
    await asyncio.wait_for(task, timeout=2.0)
    assert channel.closed and closed == [True]


def test_bridge_parses_v2_latest_ids_payload() -> None:
    from factorix.transport import app as app_mod

    cid = str(uuid4())
    parsed = app_mod._parse_latest_ids(
        '{"v":2,"kind":"latest_ids","tenant_id":"t","signal_ids":["a","b"],"connection_ids":["%s"],"max_acquired_at":"2026-11-18T02:29:59Z"}' % cid
    )
    assert parsed == ("t", ["a", "b"])
    assert app_mod.get_pipeline_evidence().delivered[cid.lower()] == datetime(2026, 11, 18, 2, 29, 59, tzinfo=timezone.utc)
    assert app_mod._parse_latest_ids('{"events": []}') is None
