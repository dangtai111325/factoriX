"""PG NOTIFY bridge: stream/health/epoch channels -> live cache, pipeline evidence and the hub. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any
from uuid import UUID

import asyncpg

from factorix.modules import telemetry
from factorix.modules.live_state import get_live_state_provider, get_pipeline_evidence
from factorix.modules.providers import LiveSignalRecord
from factorix.modules.common import utcnow
from factorix.platform.db import to_asyncpg_dsn
from factorix.transport.hub import parse_pg_notify_events
from factorix.platform.db import session_factory

from factorix.transport.http.deps import _opt_time, _settings, hub, logger
from factorix.transport.ws.stream import _latest_message


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
                qual = str(p.get("quality") or "GOOD").upper()
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
        if str(payload.get("entity") or "") == "connection" and payload.get("last_success_at"):
            evidence.note_source(payload.get("id"), payload.get("last_success_at"))


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
            hub.dispatch(
                [{"kind": "latest", "tenant_id": str(tid), "signal_id": str(row["signal_id"]), "payload": _latest_message(row)} for row in rows]
            )


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


def _parse_latest_ids(payload: str) -> tuple[str, list[str]] | None:
    try:
        data = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("signal_ids"), list) or not data.get("tenant_id"):
        return None
    evidence = get_pipeline_evidence()
    max_acq = _opt_time(data.get("max_acquired_at"))
    if max_acq is not None:
        for cid in data.get("connection_ids") or []:
            evidence.note_delivery(None, max_acq, connection_id=cid)
    return str(data["tenant_id"]), [str(item) for item in data["signal_ids"]]


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
                    if channel == "factorix_epoch_changed":
                        provider = get_live_state_provider()
                        if provider is not None and payload:
                            try:
                                data = json.loads(payload)
                            except json.JSONDecodeError:
                                data = {}
                            if isinstance(data, dict) and (data.get("active_epoch") or data.get("new_epoch")):
                                try:
                                    tid_raw = data.get("tenant_id")
                                    tid_u = UUID(str(tid_raw)) if tid_raw else None
                                    new_epoch = int(data.get("active_epoch") or data.get("new_epoch"))
                                    provider.invalidate_epoch_sync(tid_u, new_epoch)
                                except (TypeError, ValueError):
                                    pass
                        return
                    if channel == "factorix_stream_events" and '"signal_ids"' in (payload or ""):
                        request = _parse_latest_ids(payload)
                        if request is not None:
                            try:
                                ids_queue.put_nowait(request)
                            except asyncio.QueueFull:
                                logger.warning("Live push queue full; dropping %d signal id(s)", len(request[1]))
                            return
                    events = _parse_pg_notify_events(channel, payload)
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
