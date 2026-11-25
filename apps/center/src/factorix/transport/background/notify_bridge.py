"""PG NOTIFY bridge: stream/health/epoch channels -> live cache, pipeline evidence and the hub.

Moved from ``factorix.transport.app`` (R2-E B2). R2-E C6: payloads are decoded with the typed contract
``factorix_core.contracts.notify`` (by ``v`` / ``kind``, no substring sniffing, CT-04); the v2
``latest_ids`` path refreshes the API live cache like v1 does (CT-03); a v1 event without ``quality``
is not seeded as GOOD (CT-02).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from uuid import UUID

import asyncpg

from factorix.modules import telemetry
from factorix.modules.live_state import get_live_state_provider, get_pipeline_evidence, record_from_pg_row
from factorix.modules.providers import LiveSignalRecord
from factorix.modules.common import utcnow
from factorix.platform.db import to_asyncpg_dsn
from factorix.transport.hub import parse_pg_notify_events
from factorix.platform.db import session_factory

from factorix.transport.http.deps import _opt_time, _settings, hub, logger
from factorix.transport.ws.stream import _latest_message
from factorix_core.contracts.notify import (
    Channel,
    HealthChanged,
    LatestIdsV2,
    StreamEventsV1,
    parse_epoch_changed,
    parse_health_changed,
    parse_stream_events,
)


_parse_pg_notify_events = parse_pg_notify_events


def _seed_live_cache(events: list[dict[str, Any]]) -> None:
    """Advance the API live cache from pushed ``latest`` events (ordering guards in the provider)."""
    provider = get_live_state_provider()
    if provider is not None:
        for ev in events:
            if ev.get("kind") != "latest":
                continue
            p = ev.get("payload")
            if not isinstance(p, dict) or not p.get("signal_id"):
                continue
            try:
                tid_u = UUID(str(ev["tenant_id"]))
                sid_u = UUID(str(p["signal_id"]))
                prev_entry = provider.get_entry(tid_u, sid_u)
                res_raw = ev.get("resource_id") or (prev_entry.record.resource_id if prev_entry else sid_u)
                res_u = res_raw if isinstance(res_raw, UUID) else UUID(str(res_raw))
                acq_dt = _opt_time(p.get("last_acquired_at") or p.get("received_time")) or utcnow()
                ev_dt = _opt_time(p.get("received_time")) or acq_dt
                chg_dt = _opt_time(p.get("last_value_changed_at")) or (
                    prev_entry.record.last_value_changed_at if prev_entry else ev_dt
                )
                src_dt = _opt_time(p.get("source_time"))
                # CT-02: a missing quality is not evidence of a good read (it used to seed GOOD and
                # become the last good value). UNCERTAIN keeps the value visible without vouching for it.
                qual = str(p.get("quality") or "UNCERTAIN").upper()
                epoch_val = max(
                    1,
                    int(
                        p.get("data_epoch")
                        or (prev_entry.record.data_epoch if prev_entry else 1)
                    ),
                )
                seq_raw = ev.get("source_sequence")
                seq_val = int(seq_raw) if seq_raw is not None else None
                vtype = str(ev.get("value_type") or (prev_entry.record.value_type if prev_entry else "float64"))
                rec = LiveSignalRecord(
                    tenant_id=tid_u,
                    signal_id=sid_u,
                    resource_id=res_u,
                    observation_id=None,
                    event_uid=str(ev.get("event_uid") or "") or None,
                    data_epoch=epoch_val,
                    value_type=vtype,
                    value=p.get("value"),
                    unit=(
                        ev.get("unit")
                        if ev.get("unit") is not None
                        else (prev_entry.record.unit if prev_entry else None)
                    ),
                    raw_quality=qual,
                    reason_code=str(p["reason_code"]) if p.get("reason_code") else None,
                    event_time=ev_dt,
                    last_acquired_at=acq_dt,
                    last_value_changed_at=chg_dt,
                    source_time=src_dt,
                    config_revision=max(
                        1,
                        int(
                            ev.get("config_revision")
                            or (prev_entry.record.config_revision if prev_entry else 1)
                        ),
                    ),
                    origin=str(ev.get("origin") or "LIVE"),
                    last_good_value=p.get("value") if (qual == "GOOD" and p.get("value") is not None) else None,
                    last_good_at=acq_dt if (qual == "GOOD" and p.get("value") is not None) else None,
                    updated_at=utcnow(),
                )
                provider.seed_from_record(rec, source_sequence=seq_val, restored_unverified=False)
            except Exception:  # noqa: BLE001
                logger.debug("Live cache notify seed skipped", exc_info=True)


_NOTIFY_FETCH_CHUNK = 200
_bridge_state: dict[str, Any] = {"connected": False, "last_event_at": None, "reconnects": 0, "last_error": None}


def notify_bridge_status() -> dict[str, Any]:
    return dict(_bridge_state)


def _note_health_evidence(events: list[dict[str, Any]]) -> None:
    evidence = get_pipeline_evidence()
    for ev in events:
        if ev.get("kind") != "health":
            continue
        payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else ev
        if str(payload.get("entity") or "") == "connection" and (payload.get("last_success_at") or payload.get("health")):
            evidence.note_source(payload.get("id"), payload.get("last_success_at"), payload.get("health"))


async def _dispatch_latest_ids(tenant_id: str, signal_ids: list[str]) -> None:
    """NOTIFY v2 (``{"v":2,"kind":"latest_ids",...}``): read the committed rows and push them."""
    try:
        tid = UUID(str(tenant_id))
    except ValueError:
        return
    ids: list[UUID] = []
    for raw in signal_ids:
        try:
            ids.append(UUID(str(raw)))
        except ValueError:
            continue
    if not ids:
        return
    async with session_factory()() as session:
        for start in range(0, len(ids), _NOTIFY_FETCH_CHUNK):
            rows = await telemetry.latest_states(session, tid, ids[start : start + _NOTIFY_FETCH_CHUNK])
            _seed_live_cache_from_rows(tid, rows)
            hub.dispatch(
                [{"kind": "latest", "tenant_id": str(tid), "signal_id": str(row["signal_id"]), "payload": _latest_message(row)} for row in rows]
            )


def _seed_live_cache_from_rows(tenant_id: UUID, rows: list[dict[str, Any]]) -> None:
    """CT-03: the v2 path refreshes the API live cache (read by the model engine and Data Models) from the
    committed rows it read, exactly like the v1 path does from the event payloads. Ordering/epoch guards
    of the provider apply; a row the cache already holds is a no-op."""
    provider = get_live_state_provider()
    if provider is None:
        return
    for row in rows:
        try:
            rec, seq, _upd = record_from_pg_row(row, tenant_id=tenant_id)
            provider.seed_from_record(
                rec,
                source_sequence=seq,
                restored_unverified=False,
                expected_interval_ms=row.get("expected_interval_ms"),
                null_allowed=bool(row.get("nullable")),
            )
        except Exception:  # noqa: BLE001 - the push must not fail because of one row
            logger.debug("Live cache v2 seed skipped", exc_info=True)


async def _latest_ids_worker(queue: "asyncio.Queue[tuple[str, list[str]]]") -> None:
    while True:
        tenant_id, ids = await queue.get()
        merged: dict[str, set[str]] = {tenant_id: set(ids)}
        while not queue.empty():  # coalesce a burst of NOTIFYs into one read per tenant
            more_tenant, more_ids = queue.get_nowait()
            merged.setdefault(more_tenant, set()).update(more_ids)
        for tid, tid_ids in merged.items():
            try:
                await _dispatch_latest_ids(tid, sorted(tid_ids))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.warning("Live push of %d committed signal(s) failed", len(tid_ids), exc_info=True)


def _latest_ids_request(msg: LatestIdsV2) -> tuple[str, list[str]]:
    """Record the v2 delivery evidence and return the (tenant, signal ids) read request."""
    evidence = get_pipeline_evidence()
    max_acq = _opt_time(msg.max_acquired_at)
    if max_acq is not None:
        for cid in msg.connection_ids:
            evidence.note_delivery(None, max_acq, connection_id=cid)
    return msg.tenant_id, list(msg.signal_ids)


def _parse_latest_ids(payload: str) -> tuple[str, list[str]] | None:
    msg = parse_stream_events(payload)
    if not isinstance(msg, LatestIdsV2):
        return None
    return _latest_ids_request(msg)


def _hub_events(channel: str, msg: StreamEventsV1 | HealthChanged | LatestIdsV2 | None) -> list[dict[str, Any]]:
    """Typed payload -> hub events (the shapes ``hub.parse_pg_notify_events`` produces)."""
    if isinstance(msg, StreamEventsV1):
        return list(msg.events)
    if isinstance(msg, HealthChanged):
        event_type = str(msg.event.get("type") or "health")
        kind = "health" if channel == Channel.HEALTH_CHANGED or event_type == "health" else event_type
        return [{"kind": kind, "tenant_id": msg.tenant_id, "payload": msg.event}]
    return []


async def _pg_notify_bridge_loop() -> None:
    """Subscribe to PG LISTEN/NOTIFY channels so out-of-process IngestionWorker pushes /stream live.

    Accepts the v1 ``{"events": [...]}`` payload, health payloads, and the v2 ``latest_ids`` payload
    (see v6_contracts.md Q1). Liveness: bounded keep-alive, WARN on loss, and a ``resync`` frame to
    every socket after a reconnect so browsers refetch what was missed while the bridge was down.
    """
    dsn = to_asyncpg_dsn(_settings().database_url)
    if not dsn.startswith("postgresql://"):
        logger.warning("PG NOTIFY bridge disabled: database URL is not PostgreSQL; live push will not work")
        return
    backoff = 0.5
    ids_queue: asyncio.Queue[tuple[str, list[str]]] = asyncio.Queue(maxsize=10_000)
    worker = asyncio.create_task(_latest_ids_worker(ids_queue), name="pg-notify-latest-ids")
    had_connection = False
    try:
        while True:
            conn: asyncpg.Connection | None = None
            try:
                conn = await asyncpg.connect(dsn, timeout=5.0)
                stop_ev = asyncio.Event()

                def _on_notify(_c: Any, _pid: int, channel: str, payload: str) -> None:
                    _bridge_state["last_event_at"] = time.monotonic()
                    if channel == Channel.EPOCH_CHANGED:
                        provider = get_live_state_provider()
                        epoch_msg = parse_epoch_changed(payload)
                        if provider is not None and epoch_msg.active_epoch:
                            try:
                                tid_u = UUID(epoch_msg.tenant_id) if epoch_msg.tenant_id else None
                                provider.invalidate_epoch_sync(tid_u, epoch_msg.active_epoch)
                            except (TypeError, ValueError):
                                pass
                        return
                    msg = parse_stream_events(payload) if channel == Channel.STREAM_EVENTS else parse_health_changed(payload)
                    if isinstance(msg, LatestIdsV2):
                        request = _latest_ids_request(msg)
                        try:
                            ids_queue.put_nowait(request)
                        except asyncio.QueueFull:
                            logger.warning("Live push queue full; dropping %d signal id(s)", len(request[1]))
                        return
                    events = _hub_events(channel, msg)
                    if events:
                        _seed_live_cache(events)
                        _note_health_evidence(events)
                        hub.dispatch(events)

                def _on_close(_c: Any) -> None:
                    stop_ev.set()

                conn.add_termination_listener(_on_close)
                await conn.add_listener("factorix_stream_events", _on_notify)
                await conn.add_listener("factorix_health_changed", _on_notify)
                await conn.add_listener("factorix_epoch_changed", _on_notify)
                backoff = 0.5
                _bridge_state["connected"] = True
                _bridge_state["last_error"] = None
                if had_connection:
                    _bridge_state["reconnects"] += 1
                    logger.info("PG NOTIFY bridge reconnected; asking browsers to resync")
                    for channel in list(hub.channels):
                        channel.offer({"type": "resync", "reason": "notify_bridge_reconnected"})
                had_connection = True
                while not stop_ev.is_set() and not conn.is_closed():
                    try:
                        await asyncio.wait_for(stop_ev.wait(), timeout=15.0)
                    except asyncio.TimeoutError:
                        # Bounded keep-alive: a half-open socket must not hang the bridge forever.
                        await conn.execute("SELECT 1", timeout=5.0)
                raise ConnectionError("LISTEN connection closed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                _bridge_state["connected"] = False
                _bridge_state["last_error"] = type(exc).__name__
                log = logger.warning if backoff <= 0.5 else logger.info
                log("PG NOTIFY bridge unavailable (%s); live push paused, reconnecting in %.1fs", type(exc).__name__, backoff)
                await asyncio.sleep(backoff)
                backoff = min(10.0, backoff * 2.0)
            finally:
                if conn is not None and not conn.is_closed():
                    try:
                        await conn.close(timeout=2.0)
                    except Exception:  # noqa: BLE001
                        conn.terminate()
    finally:
        worker.cancel()
        try:
            await worker
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
