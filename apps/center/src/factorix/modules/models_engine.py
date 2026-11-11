"""Data Model v2 engine: one background scheduler, the only writer of model state.

Every RUNNING model is sampled every ``sample_ms`` (independent of the collectors). A sample:

1. reads the latest **valid** value (GOOD/UNCERTAIN) of every referenced signal with one query
   per tenant and tick; a signal whose latest row is BAD falls back to its last good value (the
   source time of that value is looked up once in ``observations`` and cached);
2. evaluates the body (:func:`factorix.domain.body.evaluate_detailed`); ``value_at`` lookups use
   the ``observations (tenant_id, signal_id, source_time DESC)`` index and are cached;
3. stores the ordered JSON text in ``model_state`` and appends it to the ``model_snapshots`` ring
   (last :data:`SNAPSHOT_KEEP` per model, pruned continuously);
4. pushes ``{"type": "model_body", group_id, body, sampled_at, errors}`` to ``/stream``
   subscribers through the after-commit queue.

A body is produced every period even when nothing changed (live heartbeat). The engine yields to
the event loop between models and caps the work per cycle (:data:`CYCLE_BUDGET_S`); models that
did not fit are sampled in the next cycle. Stateful filter state is kept in memory per model and
field; it resets when the server restarts or the model is edited.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import OrderedDict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain import rules as R
from factorix.domain.body import BodyContext, CompiledSpec, EvalResult, compile_spec, evaluate_detailed
from factorix.modules.common import execute, fetch_all, queue_stream_event, utcnow
from factorix.platform import after_commit

log = logging.getLogger(__name__)

SNAPSHOT_KEEP = 100
PRUNE_EVERY = 10
CYCLE_BUDGET_S = 0.25
MODELS_PER_TX = 64
RELOAD_EVERY_S = 5.0
CATALOG_TTL_S = 5.0
MIN_SLEEP_S = 0.05
MAX_SLEEP_S = 1.0
LOOKUP_ROUNDS = 2
VALID_QUALITIES = ("GOOD", "UNCERTAIN")
CHANGE_EVENT = "data_model_changed"
MIN_SAMPLE_MS = 200
MAX_SAMPLE_MS = 3_600_000
DEFAULT_SAMPLE_MS = 1000


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _uuids(values: Iterable[Any]) -> list[UUID]:
    out: set[UUID] = set()
    for value in values:
        try:
            out.add(value if isinstance(value, UUID) else UUID(str(value)))
        except (TypeError, ValueError):
            log.warning("Ignoring invalid id %r", value)
    return sorted(out, key=str)


# ============================================================================================
# Caches
# ============================================================================================


class _Lru:
    """Small LRU with optional per-entry expiry (monotonic seconds)."""

    MISS = object()

    def __init__(self, size: int) -> None:
        self.size = size
        self._data: OrderedDict[Any, tuple[float | None, Any]] = OrderedDict()

    def get(self, key: Any) -> Any:
        item = self._data.get(key)
        if item is None:
            return self.MISS
        expires, value = item
        if expires is not None and time.monotonic() >= expires:
            self._data.pop(key, None)
            return self.MISS
        self._data.move_to_end(key)
        return value

    def put(self, key: Any, value: Any, ttl_s: float | None = None) -> None:
        self._data[key] = (None if ttl_s is None else time.monotonic() + ttl_s, value)
        self._data.move_to_end(key)
        while len(self._data) > self.size:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()


_value_at_cache = _Lru(4096)
_fallback_source_cache = _Lru(8192)


def _value_at_ttl(at: datetime, now: datetime, found: bool) -> float | None:
    """Past values are immutable except very recent ones (late samples) and misses."""
    if now - at < timedelta(minutes=2):
        return 2.0
    return None if found else 30.0


# ============================================================================================
# Data access (module-level so tests can replace them)
# ============================================================================================


async def load_catalog(session: AsyncSession, tenant_id: UUID, signal_ids: Iterable[Any] | None = None) -> R.Catalog:
    """Resources (all, with type keys) and signals (all, or only ``signal_ids``) of a tenant."""
    resources = await fetch_all(
        session,
        """
        SELECT r.id, r.parent_id, r.name, r.code, r.status, r.archived_at, t.key AS type_key
        FROM resources r JOIN resource_types t ON t.id = r.type_id
        WHERE r.tenant_id = :tenant_id
        """,
        {"tenant_id": tenant_id},
    )
    types = await fetch_all(session, "SELECT key FROM resource_types WHERE tenant_id = :tenant_id", {"tenant_id": tenant_id})
    if signal_ids is None:
        signals = await fetch_all(
            session,
            "SELECT id, resource_id, key, display_name, data_type, unit, status FROM signal_definitions WHERE tenant_id = :tenant_id",
            {"tenant_id": tenant_id},
        )
    else:
        ids = _uuids(signal_ids)
        signals = await fetch_all(
            session,
            """
            SELECT id, resource_id, key, display_name, data_type, unit, status FROM signal_definitions
            WHERE tenant_id = :tenant_id AND id = ANY(:ids)
            """,
            {"tenant_id": tenant_id, "ids": ids},
        ) if ids else []
    return R.Catalog(
        [
            {
                "id": row["id"],
                "parent_id": row.get("parent_id"),
                "name": row.get("name"),
                "code": row.get("code"),
                "type_key": row.get("type_key"),
                "active": row.get("status") == "ACTIVE" and row.get("archived_at") is None,
            }
            for row in resources
        ],
        [
            {
                "id": row["id"],
                "resource_id": row["resource_id"],
                "key": row.get("key"),
                "name": row.get("display_name"),
                "data_type": row.get("data_type"),
                "unit": row.get("unit"),
                "active": row.get("status") == "ACTIVE",
            }
            for row in signals
        ],
        types=[str(row["key"]) for row in types],
    )


def sample_from_latest(row: Mapping[str, Any]) -> tuple[R.Sample | None, datetime | None]:
    """Latest valid sample of a ``latest_signal_state`` row (pure).

    Returns ``(sample, fallback_at)``. When the latest row is not valid (BAD) the last good value
    is used and ``fallback_at`` is its event time (its source time must be looked up).
    """
    quality = str(row.get("quality") or "")
    if quality in VALID_QUALITIES:
        value_json = _json(row.get("value_json"))
        return (
            R.Sample(
                value=value_json.get("v") if isinstance(value_json, dict) else None,
                quality=quality,
                source_time=R.as_utc(row.get("source_time")),
                received_time=R.as_utc(row.get("received_time")),
            ),
            None,
        )
    good = _json(row.get("last_good_value_json"))
    good_at = R.as_utc(row.get("last_good_event_time"))
    if isinstance(good, dict) and good.get("v") is not None and good_at is not None:
        # event_time == received_time (time model); source_time is filled from observations.
        return R.Sample(value=good.get("v"), quality="GOOD", source_time=None, received_time=good_at), good_at
    return None, None


async def load_samples(
    session: AsyncSession,
    tenant_id: UUID,
    signal_ids: Iterable[Any],
    *,
    live_provider: Any = None,
) -> tuple[dict[str, R.Sample | None], dict[str, str | None]]:
    """Latest valid sample and effective quality of each signal via LiveStateProvider (when enabled) or PG."""
    ids = _uuids(signal_ids)
    if not ids:
        return {}, {}

    from factorix.modules.live_state import get_live_state_provider, record_from_pg_row

    provider = live_provider or (get_live_state_provider() if isinstance(session, AsyncSession) else None)
    if provider is not None:
        from sqlalchemy import text as _sa_text
        from sqlalchemy.exc import SQLAlchemyError as _SQLAlchemyError

        active_epoch = 1
        meta_by_id: dict[UUID, dict[str, Any]] = {}
        pg_by_id: dict[UUID, dict[str, Any]] = {}
        now = utcnow()
        if isinstance(session, AsyncSession):
            try:
                async with session.begin_nested():
                    gen_row = (
                        await session.execute(
                            _sa_text("SELECT active_epoch FROM telemetry_generations WHERE tenant_id = :tenant_id"),
                            {"tenant_id": tenant_id},
                        )
                    ).mappings().first()
                    if gen_row and gen_row.get("active_epoch") is not None:
                        active_epoch = max(1, int(gen_row["active_epoch"]))
            except _SQLAlchemyError:
                active_epoch = 1

            try:
                async with session.begin_nested():
                    meta_res = await session.execute(
                        _sa_text(
                            """
                            SELECT s.id, s.resource_id, s.data_type, s.unit, s.expected_interval_ms, s.status AS signal_status,
                                   COALESCE(nb.nullable, FALSE) AS nullable,
                                   COALESCE(nb.enabled, TRUE) AS binding_enabled,
                                   nb.connection_status, nb.connection_health
                            FROM signal_definitions s
                            LEFT JOIN LATERAL (
                                SELECT COALESCE((f.address_json->>'nullable') = 'true', FALSE) AS nullable, b.enabled,
                                       c.status AS connection_status, c.health AS connection_health
                                FROM signal_bindings b
                                JOIN source_fields f ON f.id = b.source_field_id
                                LEFT JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
                                LEFT JOIN connections c ON c.id = j.connection_id
                                WHERE b.signal_id = s.id AND b.valid_to IS NULL
                                ORDER BY b.enabled DESC, b.valid_from DESC
                                LIMIT 1
                            ) nb ON TRUE
                            WHERE s.tenant_id = :tenant_id AND s.id = ANY(:ids)
                            """
                        ),
                        {"tenant_id": tenant_id, "ids": ids},
                    )
                    for mr in meta_res.mappings().all():
                        meta_by_id[UUID(str(mr["id"]))] = dict(mr)
            except _SQLAlchemyError:
                meta_by_id = {}

            try:
                async with session.begin_nested():
                    pg_res = await session.execute(
                        _sa_text(
                            """
                            SELECT signal_id, resource_id, observation_id, event_uid, value_type, value_json,
                                   unit, quality, reason_code, event_time, received_time, last_acquired_at,
                                   last_value_changed_at, source_time, data_epoch, source_sequence,
                                   config_revision, origin, last_good_value_json, last_good_event_time, updated_at
                            FROM latest_signal_state
                            WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids)
                            """
                        ),
                        {"tenant_id": tenant_id, "ids": ids},
                    )
                    for pr in pg_res.mappings().all():
                        pg_by_id[UUID(str(pr["signal_id"]))] = dict(pr)
            except _SQLAlchemyError:
                pg_by_id = {}

        if hasattr(provider, "set_active_epoch"):
            provider.set_active_epoch(tenant_id, active_epoch)
        if hasattr(provider, "warm_from_tdengine") and meta_by_id:
            missing_specs = {
                sid_u: meta
                for sid_u, meta in meta_by_id.items()
                if provider.get_entry(tenant_id, sid_u) is None
            }
            if missing_specs:
                await provider.warm_from_tdengine(
                    tenant_id, missing_specs, active_epoch=active_epoch, mark_unverified=True
                )
        elif hasattr(provider, "get_latest"):
            try:
                await provider.get_latest(tenant_id, ids)
            except TypeError:
                pass

        for sid_u, pr in pg_by_id.items():
            if int(pr.get("data_epoch") or 1) < active_epoch:
                continue
            pg_rec, pg_seq, pg_upd = record_from_pg_row(pr, tenant_id=tenant_id)
            post_boot = (
                hasattr(provider, "is_verified_in_session") and provider.is_verified_in_session(tenant_id, sid_u)
            ) or (
                hasattr(provider, "started_at")
                and pg_upd is not None
                and pg_upd > provider.started_at
                and pg_rec.last_acquired_at > provider.started_at
            )
            meta = meta_by_id.get(sid_u, {})
            if hasattr(provider, "seed_from_record"):
                provider.seed_from_record(
                    pg_rec,
                    source_sequence=pg_seq,
                    restored_unverified=not post_boot,
                    expected_interval_ms=meta.get("expected_interval_ms"),
                    null_allowed=bool(meta.get("nullable")),
                )

        samples_p: dict[str, R.Sample | None] = {}
        qualities_p: dict[str, str | None] = {}
        fallbacks_p: dict[str, datetime] = {}
        for sid_u in ids:
            sid_key = str(sid_u).lower()
            meta = meta_by_id.get(sid_u, {})
            binding_enabled = bool(meta.get("binding_enabled", True)) and str(meta.get("signal_status") or "ACTIVE") == "ACTIVE"
            conn_paused = str(meta.get("connection_status") or "") == "PAUSED"
            evaluated = provider.evaluate_signal(
                tenant_id,
                sid_u,
                binding_enabled=binding_enabled,
                expected_interval_ms=meta.get("expected_interval_ms"),
                null_allowed=bool(meta.get("nullable")),
                connection_paused=conn_paused,
                connection_health=meta.get("connection_health"),
                connection_status=meta.get("connection_status"),
                active_bindings=1 if binding_enabled else 0,
                now=now,
            )
            rec = evaluated.record
            ev = evaluated.evaluation
            if rec is None or ev.effective_status == "NO_DATA":
                continue
            qualities_p[sid_key] = ev.effective_status
            if ev.effective_status in VALID_QUALITIES:
                samples_p[sid_key] = R.Sample(rec.value, ev.effective_status, rec.source_time, rec.last_acquired_at)
            elif ev.effective_status in {"STALE", "PAUSED", "DISABLED"} and rec.raw_quality in VALID_QUALITIES:
                # Preserve value for fallback while strictly NOT labeling stale/paused samples GOOD (§6.3)
                samples_p[sid_key] = R.Sample(rec.value, ev.effective_status, rec.source_time, rec.last_acquired_at)
            elif rec.last_good_value is not None and rec.last_good_at is not None:
                good_src = evaluated.last_good_source_time
                samples_p[sid_key] = R.Sample(rec.last_good_value, ev.effective_status, good_src, rec.last_good_at)
                if good_src is None:
                    fallbacks_p[sid_key] = rec.last_good_at
            else:
                samples_p[sid_key] = None

        missing_fb = []
        for sid_key, at in fallbacks_p.items():
            cached = _fallback_source_cache.get((str(tenant_id), active_epoch, sid_key, at))
            if cached is _Lru.MISS:
                missing_fb.append((sid_key, at))
            elif cached is not None:
                samples_p[sid_key] = _with_source(samples_p[sid_key], cached)
        if missing_fb and isinstance(session, AsyncSession):
            from factorix.modules.history_repository import get_history_provider

            hist_provider = get_history_provider()
            remaining_fb = list(missing_fb)
            if hist_provider is not None:
                try:
                    td_fb = await hist_provider.fallback_source_times(
                        tenant_id,
                        remaining_fb,
                        session=session,
                        active_epoch=active_epoch,
                    )
                    still_missing: list[tuple[str, datetime]] = []
                    for sid_key, at in remaining_fb:
                        src = td_fb.get((sid_key, at))
                        if src is not None:
                            _fallback_source_cache.put((str(tenant_id), active_epoch, sid_key, at), src)
                            samples_p[sid_key] = _with_source(samples_p[sid_key], src)
                        elif active_epoch > 1:
                            _fallback_source_cache.put((str(tenant_id), active_epoch, sid_key, at), None)
                        else:
                            still_missing.append((sid_key, at))
                    remaining_fb = still_missing
                except Exception:  # noqa: BLE001 - fall back to PG when epoch == 1
                    pass

            if remaining_fb and active_epoch == 1:
                try:
                    async with session.begin_nested():
                        found = await fetch_all(
                            session,
                            """
                            SELECT q.signal_id, o.source_time
                            FROM unnest(CAST(:ids AS uuid[]), CAST(:ats AS timestamptz[])) AS q(signal_id, at)
                            LEFT JOIN LATERAL (
                                SELECT source_time FROM observations o
                                WHERE o.tenant_id = :tenant_id AND o.signal_id = q.signal_id AND o.event_time = q.at
                                ORDER BY o.received_time DESC
                                LIMIT 1
                            ) o ON TRUE
                            """,
                            {
                                "tenant_id": tenant_id,
                                "ids": [UUID(sid_k) for sid_k, _ in remaining_fb],
                                "ats": [at for _, at in remaining_fb],
                            },
                        )
                        by_id = {str(row["signal_id"]).lower(): R.as_utc(row.get("source_time")) for row in found}
                        for sid_key, at in remaining_fb:
                            source = by_id.get(sid_key)
                            _fallback_source_cache.put((str(tenant_id), active_epoch, sid_key, at), source)
                            if source is not None:
                                samples_p[sid_key] = _with_source(samples_p[sid_key], source)
                except _SQLAlchemyError:
                    pass
        return samples_p, qualities_p

    rows = await fetch_all(
        session,
        """
        SELECT signal_id, value_json, quality, source_time, received_time, last_good_value_json, last_good_event_time
        FROM latest_signal_state
        WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": ids},
    )
    samples: dict[str, R.Sample | None] = {}
    qualities: dict[str, str | None] = {}
    fallbacks: dict[str, datetime] = {}
    for row in rows:
        sid = str(row["signal_id"]).lower()
        sample, fallback_at = sample_from_latest(row)
        samples[sid] = sample
        qualities[sid] = row.get("quality")
        if fallback_at is not None:
            fallbacks[sid] = fallback_at
    missing = []
    for sid, at in fallbacks.items():
        cached = _fallback_source_cache.get((str(tenant_id), sid, at))
        if cached is _Lru.MISS:
            missing.append((sid, at))
        elif cached is not None:
            samples[sid] = _with_source(samples[sid], cached)
    if missing:
        found = await fetch_all(
            session,
            """
            SELECT q.signal_id, o.source_time
            FROM unnest(CAST(:ids AS uuid[]), CAST(:ats AS timestamptz[])) AS q(signal_id, at)
            LEFT JOIN LATERAL (
                SELECT source_time FROM observations o
                WHERE o.tenant_id = :tenant_id AND o.signal_id = q.signal_id AND o.event_time = q.at
                ORDER BY o.received_time DESC
                LIMIT 1
            ) o ON TRUE
            """,
            {"tenant_id": tenant_id, "ids": [UUID(sid) for sid, _ in missing], "ats": [at for _, at in missing]},
        )
        by_id = {str(row["signal_id"]).lower(): R.as_utc(row.get("source_time")) for row in found}
        for sid, at in missing:
            source = by_id.get(sid)
            _fallback_source_cache.put((str(tenant_id), sid, at), source)
            if source is not None:
                samples[sid] = _with_source(samples[sid], source)
    return samples, qualities


def _with_source(sample: R.Sample | None, source: datetime) -> R.Sample | None:
    if sample is None:
        return None
    return R.Sample(sample.value, sample.quality, source, sample.received_time)


async def fetch_value_at(
    session: AsyncSession, tenant_id: UUID, requests: list[tuple[str, datetime, str]]
) -> dict[tuple[str, datetime], R.Sample | None]:
    """Value of each signal as of an instant: ``requests`` = ``[(signal_id, at, mode)]``.

    ``mode`` ``"s"`` searches by source_time; ``"e"`` by event_time. Uses TDengine
    ``TDengineHistoryRepository`` when active, with ``active_epoch == 1`` PG fallback bridge.
    """
    if not requests:
        return {}

    from factorix.modules.history_repository import _active_epoch_for, get_history_provider

    hist_provider = get_history_provider() if isinstance(session, AsyncSession) else None
    remaining = requests
    out: dict[tuple[str, datetime], R.Sample | None] = {(sid, at): None for sid, at, _mode in requests}
    if hist_provider is not None:
        active_epoch = await _active_epoch_for(session, tenant_id)
        td_res = await hist_provider.value_at_batch(
            tenant_id,
            requests=requests,
            session=session,
            active_epoch=active_epoch,
        )
        missing_pg: list[tuple[str, datetime, str]] = []
        for sid, at, mode in requests:
            hit = td_res.get((sid, at))
            if hit is not None:
                val, qual, src_ts, rcv_ts = hit
                out[(sid, at)] = R.Sample(value=val, quality=qual, source_time=src_ts, received_time=rcv_ts)
            elif active_epoch == 1:
                missing_pg.append((sid, at, mode))
        if active_epoch > 1 or not missing_pg:
            return out
        remaining = missing_pg

    rows = await fetch_all(
        session,
        """
        SELECT q.idx, o.value_json, o.quality, o.source_time, o.received_time
        FROM unnest(CAST(:ids AS uuid[]), CAST(:ats AS timestamptz[]), CAST(:modes AS text[]), CAST(:idx AS integer[]))
             AS q(signal_id, at, mode, idx)
        LEFT JOIN LATERAL (
            SELECT * FROM (
                (SELECT o.value_json, o.quality, o.source_time, o.received_time
                 FROM observations o
                 WHERE q.mode = 's' AND o.tenant_id = :tenant_id AND o.signal_id = q.signal_id
                   AND o.source_time <= q.at AND o.quality IN ('GOOD', 'UNCERTAIN')
                 ORDER BY o.source_time DESC, o.received_time DESC
                 LIMIT 1)
                UNION ALL
                (SELECT o.value_json, o.quality, o.source_time, o.received_time
                 FROM observations o
                 WHERE q.mode = 'e' AND o.tenant_id = :tenant_id AND o.signal_id = q.signal_id
                   AND o.event_time <= q.at AND o.quality IN ('GOOD', 'UNCERTAIN')
                 ORDER BY o.event_time DESC
                 LIMIT 1)
            ) found
            LIMIT 1
        ) o ON TRUE
        """,
        {
            "tenant_id": tenant_id,
            "ids": [UUID(sid) for sid, _at, _mode in remaining],
            "ats": [at for _sid, at, _mode in remaining],
            "modes": [mode for _sid, _at, mode in remaining],
            "idx": list(range(len(remaining))),
        },
    )
    for row in rows:
        sid, at, _mode = remaining[int(row["idx"])]
        if row.get("quality") is None:
            continue
        value_json = _json(row.get("value_json"))
        out[(sid, at)] = R.Sample(
            value=value_json.get("v") if isinstance(value_json, dict) else None,
            quality=row.get("quality"),
            source_time=R.as_utc(row.get("source_time")),
            received_time=R.as_utc(row.get("received_time")),
        )
    return out


async def evaluate_once(
    session: AsyncSession,
    tenant_id: UUID,
    compiled: CompiledSpec,
    catalog: R.Catalog,
    now: datetime,
    state: R.FilterState,
    samples: Mapping[str, R.Sample | None] | None = None,
    qualities: Mapping[str, str | None] | None = None,
) -> EvalResult:
    """Evaluate a compiled body against current data, resolving ``value_at`` lookups in rounds."""
    if samples is None:
        samples, qualities = await load_samples(session, tenant_id, compiled.signal_ids)
    qualities = qualities or {}
    tenant_key = str(tenant_id)
    from factorix.modules.history_repository import _active_epoch_for

    active_epoch = await _active_epoch_for(session, tenant_id) if isinstance(session, AsyncSession) else 1

    def lookup(signal_id: str, at: datetime) -> R.Sample | None:
        hit = _value_at_cache.get((tenant_key, active_epoch, signal_id, at))
        if hit is _Lru.MISS:
            raise R.LookupPending(signal_id, at)
        return hit

    def lookup_final(signal_id: str, at: datetime) -> R.Sample | None:
        hit = _value_at_cache.get((tenant_key, active_epoch, signal_id, at))
        return None if hit is _Lru.MISS else hit

    result: EvalResult | None = None
    for round_no in range(LOOKUP_ROUNDS + 1):
        final = round_no == LOOKUP_ROUNDS
        context = BodyContext(catalog=catalog, lookup=lookup_final if final else lookup, qualities=qualities)
        result = evaluate_detailed(compiled, samples, context, now, state)
        if not result.pending:
            return result
        requests: list[tuple[str, datetime, str]] = []
        for signal_id, at in dict.fromkeys(result.pending):
            current = samples.get(signal_id)
            mode = "s" if current is None or current.source_time is not None else "e"
            requests.append((signal_id, at, mode))
        fetched = await fetch_value_at(session, tenant_id, requests)
        for (signal_id, at), sample in fetched.items():
            _value_at_cache.put((tenant_key, active_epoch, signal_id, at), sample, _value_at_ttl(at, now, sample is not None))
    assert result is not None
    return result


async def write_samples(session: AsyncSession, rows: list[dict[str, Any]]) -> None:
    """Upsert ``model_state`` (PG control plane) and append ``model_snapshots`` (TDengine or PG fallback)."""
    if not rows:
        return
    rows = sorted(rows, key=lambda row: (str(row["group_id"]), row["sampled_at"]))
    latest_by_group: dict[str, dict[str, Any]] = {}
    for row in rows:
        latest_by_group[str(row["group_id"])] = row
    state_rows = [latest_by_group[k] for k in sorted(latest_by_group)]
    state_params = {
        "ids": [row["group_id"] for row in state_rows],
        "tenants": [row["tenant_id"] for row in state_rows],
        "bodies": [row["body"] for row in state_rows],
        "ats": [row["sampled_at"] for row in state_rows],
        "errors": [row["errors_json"] for row in state_rows],
        "counts": [row["error_count"] for row in state_rows],
    }
    params = {
        "ids": [row["group_id"] for row in rows],
        "tenants": [row["tenant_id"] for row in rows],
        "bodies": [row["body"] for row in rows],
        "ats": [row["sampled_at"] for row in rows],
        "errors": [row["errors_json"] for row in rows],
        "counts": [row["error_count"] for row in rows],
    }
    await execute(
        session,
        """
        INSERT INTO model_state (group_id, tenant_id, body_text, sampled_at, errors_json, error_count, updated_at)
        SELECT t.group_id, t.tenant_id, t.body, t.at, CAST(t.errors AS jsonb), t.n, t.at
        FROM unnest(CAST(:ids AS uuid[]), CAST(:tenants AS uuid[]), CAST(:bodies AS text[]),
                    CAST(:ats AS timestamptz[]), CAST(:errors AS text[]), CAST(:counts AS integer[]))
             AS t(group_id, tenant_id, body, at, errors, n)
        JOIN output_groups og ON og.id = t.group_id
        ON CONFLICT (group_id) DO UPDATE SET
            body_text = EXCLUDED.body_text,
            sampled_at = EXCLUDED.sampled_at,
            errors_json = EXCLUDED.errors_json,
            error_count = EXCLUDED.error_count,
            updated_at = EXCLUDED.updated_at
        """,
        state_params,
    )

    from factorix.modules.history_repository import _active_epoch_for, get_model_snapshot_provider
    from factorix.modules.providers import ModelSnapshotRecord

    snap_provider = get_model_snapshot_provider() if isinstance(session, AsyncSession) else None
    if snap_provider is not None:
        by_tenant: dict[UUID, list[dict[str, Any]]] = {}
        for row in rows:
            tid = row["tenant_id"] if isinstance(row["tenant_id"], UUID) else UUID(str(row["tenant_id"]))
            by_tenant.setdefault(tid, []).append(row)
        for tid, t_rows in by_tenant.items():
            epoch = await _active_epoch_for(session, tid)
            records = []
            for r in t_rows:
                raw_errs = _json(r.get("errors_json"))
                errs_list = raw_errs if isinstance(raw_errs, list) else []
                records.append(
                    ModelSnapshotRecord(
                        group_id=r["group_id"] if isinstance(r["group_id"], UUID) else UUID(str(r["group_id"])),
                        sampled_at=r["sampled_at"],
                        body=str(r.get("body") or ""),
                        errors=errs_list,
                        error_count=int(r.get("error_count") or len(errs_list)),
                        data_epoch=epoch,
                    )
                )
            await snap_provider.append_snapshots_batch(tid, records)
        return

    await execute(
        session,
        """
        INSERT INTO model_snapshots (group_id, tenant_id, sampled_at, body_text, errors_json, error_count)
        SELECT t.group_id, t.tenant_id, t.at, t.body, CAST(t.errors AS jsonb), t.n
        FROM unnest(CAST(:ids AS uuid[]), CAST(:tenants AS uuid[]), CAST(:bodies AS text[]),
                    CAST(:ats AS timestamptz[]), CAST(:errors AS text[]), CAST(:counts AS integer[]))
             AS t(group_id, tenant_id, body, at, errors, n)
        JOIN output_groups og ON og.id = t.group_id
        """,
        params,
    )


async def prune_snapshots(session: AsyncSession, group_ids: list[Any], keep: int = SNAPSHOT_KEEP) -> None:
    ids = _uuids(group_ids)
    if not ids:
        return
    from factorix.modules.history_repository import get_model_snapshot_provider

    snap_provider = get_model_snapshot_provider() if isinstance(session, AsyncSession) else None
    if snap_provider is not None:
        owner_rows = await fetch_all(
            session,
            "SELECT id, tenant_id FROM output_groups WHERE id = ANY(:ids)",
            {"ids": ids},
        )
        by_tenant: dict[UUID, list[UUID]] = {}
        for orow in owner_rows:
            tid = orow["tenant_id"] if isinstance(orow["tenant_id"], UUID) else UUID(str(orow["tenant_id"]))
            gid = orow["id"] if isinstance(orow["id"], UUID) else UUID(str(orow["id"]))
            by_tenant.setdefault(tid, []).append(gid)
        for tid, gids in by_tenant.items():
            await snap_provider.prune_snapshots(tid, gids, keep=keep)
        return

    await execute(
        session,
        """
        DELETE FROM model_snapshots s
        USING (
            SELECT g.id AS group_id,
                   (SELECT x.id FROM model_snapshots x WHERE x.group_id = g.id ORDER BY x.id DESC OFFSET :keep LIMIT 1) AS cutoff
            FROM unnest(CAST(:ids AS uuid[])) AS g(id)
        ) c
        WHERE s.group_id = c.group_id AND c.cutoff IS NOT NULL AND s.id <= c.cutoff
        """,
        {"ids": ids, "keep": keep - 1},
    )


async def load_model_rows(session: AsyncSession) -> list[dict[str, Any]]:
    return await fetch_all(
        session,
        """
        SELECT id, tenant_id, display_name, version, sample_ms, state, spec_json
        FROM output_groups
        WHERE status = 'ACTIVE' AND spec_json IS NOT NULL
        ORDER BY id
        """,
        {},
    )


# ============================================================================================
# Scheduler
# ============================================================================================


def clamp_sample_ms(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return DEFAULT_SAMPLE_MS
    return min(max(number, MIN_SAMPLE_MS), MAX_SAMPLE_MS)


@dataclass
class ModelDef:
    id: str
    tenant_id: str
    name: str
    version: int
    sample_ms: int
    state: str
    compiled: CompiledSpec
    filter_state: R.FilterState = field(default_factory=R.FilterState)
    last_sample: datetime | None = None
    samples_since_prune: int = 0


def body_message(model_id: Any, body: str, sampled_at: datetime, errors: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "model_body", "group_id": str(model_id), "body": body, "sampled_at": R.fmt_ts(sampled_at), "errors": errors}


class ModelEngine:
    """Single-writer scheduler. ``session_factory`` returns an async session context manager."""

    def __init__(self, session_factory: Any = None, live_provider: Any = None) -> None:
        self._session_factory = session_factory
        self.live_provider = live_provider
        self.models: dict[str, ModelDef] = {}
        self._catalogs: dict[str, tuple[float, R.Catalog]] = {}
        self._reload_at = 0.0
        self._task: asyncio.Task[Any] | None = None

    # ---- lifecycle -----------------------------------------------------------------------------

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop(), name="data-model-engine")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 - shutdown continues; the error is logged
            log.exception("Data model engine failed during shutdown")

    def invalidate(self) -> None:
        """Reload model definitions (and catalogs) at the next cycle."""
        self._reload_at = 0.0
        self._catalogs.clear()

    async def _on_events(self, events: list[dict[str, Any]]) -> None:
        if any(event.get("kind") == CHANGE_EVENT for event in events):
            self.invalidate()

    def _session(self) -> Any:
        if self._session_factory is None:
            from factorix.platform.db import session_factory

            self._session_factory = session_factory()
        return self._session_factory()

    async def _loop(self) -> None:
        while True:
            try:
                delay = await self.cycle()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one failing cycle must not stop the engine
                log.exception("Data model engine cycle failed")
                self.invalidate()
                delay = MAX_SLEEP_S
            await asyncio.sleep(delay)

    # ---- one cycle -----------------------------------------------------------------------------

    def apply_rows(self, rows: list[dict[str, Any]]) -> None:
        """Replace the model set; unchanged models keep their filter state and schedule."""
        fresh: dict[str, ModelDef] = {}
        for row in rows:
            model_id = str(row["id"])
            version = int(row.get("version") or 1)
            current = self.models.get(model_id)
            state = str(row.get("state") or "RUNNING")
            sample_ms = clamp_sample_ms(row.get("sample_ms"))
            if current is not None and current.version == version:
                current.state, current.sample_ms, current.name = state, sample_ms, str(row.get("display_name") or "")
                if state != "RUNNING":
                    current.last_sample = None
                fresh[model_id] = current
                continue
            spec = _json(row.get("spec_json")) or {}
            fresh[model_id] = ModelDef(
                id=model_id,
                tenant_id=str(row["tenant_id"]),
                name=str(row.get("display_name") or ""),
                version=version,
                sample_ms=sample_ms,
                state=state,
                compiled=compile_spec(spec if isinstance(spec, dict) else {}),
            )
        self.models = fresh

    def due(self, now: datetime) -> list[ModelDef]:
        due = [
            m
            for m in self.models.values()
            if m.state == "RUNNING" and (m.last_sample is None or now >= m.last_sample + timedelta(milliseconds=m.sample_ms))
        ]
        return sorted(due, key=lambda m: (m.last_sample or datetime.min.replace(tzinfo=now.tzinfo), m.id))

    def next_delay(self, now: datetime) -> float:
        waits = [
            (m.last_sample + timedelta(milliseconds=m.sample_ms) - now).total_seconds()
            for m in self.models.values()
            if m.state == "RUNNING" and m.last_sample is not None
        ]
        if any(m.state == "RUNNING" and m.last_sample is None for m in self.models.values()):
            waits.append(0.0)
        if not waits:
            return MAX_SLEEP_S
        return min(max(min(waits), MIN_SLEEP_S), MAX_SLEEP_S)

    async def cycle(self) -> float:
        if time.monotonic() >= self._reload_at:
            async with self._session() as session:
                self.apply_rows(await load_model_rows(session))
            self._reload_at = time.monotonic() + RELOAD_EVERY_S
        started = time.monotonic()
        due = self.due(utcnow())
        while due and time.monotonic() - started < CYCLE_BUDGET_S:
            batch, due = due[:MODELS_PER_TX], due[MODELS_PER_TX:]
            async with self._session() as session:
                await self.process(session, batch, utcnow())
                await session.commit()
                await after_commit.flush(session)
        return self.next_delay(utcnow())

    async def _catalog(
        self,
        session: AsyncSession,
        tenant_id: str,
        extra_signal_ids: Iterable[str] | None = None,
    ) -> R.Catalog:
        cached = self._catalogs.get(tenant_id)
        if cached is not None and time.monotonic() - cached[0] < CATALOG_TTL_S:
            return cached[1]
        signal_ids: set[str] = set(extra_signal_ids or ())
        for model in self.models.values():
            if model.tenant_id == tenant_id:
                signal_ids |= model.compiled.signal_ids
        catalog = await load_catalog(session, UUID(tenant_id), signal_ids or None)
        self._catalogs[tenant_id] = (time.monotonic(), catalog)
        return catalog

    async def process(self, session: AsyncSession, models: list[ModelDef], now: datetime) -> int:
        """Sample ``models`` now: one latest query per tenant, one write batch. Returns the count."""
        by_tenant: dict[str, list[ModelDef]] = {}
        for model in models:
            model.last_sample = now  # also on failure: a broken model must not spin the loop
            by_tenant.setdefault(model.tenant_id, []).append(model)
        rows: list[dict[str, Any]] = []
        prune: list[str] = []
        for tenant_id, group in by_tenant.items():
            tenant = UUID(tenant_id)
            signal_ids: set[str] = set()
            for model in group:
                signal_ids |= model.compiled.signal_ids
            catalog = await self._catalog(session, tenant_id, signal_ids)
            samples, qualities = (
                await load_samples(session, tenant, signal_ids, live_provider=self.live_provider)
                if self.live_provider is not None
                else await load_samples(session, tenant, signal_ids)
            )
            for model in group:
                try:
                    result = await evaluate_once(session, tenant, model.compiled, catalog, now, model.filter_state, samples, qualities)
                except Exception:  # noqa: BLE001 - one model never stops the others; logged
                    log.exception("Data model %s (%s) could not be evaluated", model.name, model.id)
                    continue
                errors = result.errors
                rows.append(
                    {
                        "group_id": UUID(model.id),
                        "tenant_id": tenant,
                        "body": result.text,
                        "sampled_at": now,
                        "errors_json": json.dumps(errors, ensure_ascii=False),
                        "error_count": len(errors),
                    }
                )
                queue_stream_event(session, "model_body", tenant_id, body_message(model.id, result.text, now, errors), group_id=model.id)
                model.samples_since_prune += 1
                if model.samples_since_prune >= PRUNE_EVERY:
                    model.samples_since_prune = 0
                    prune.append(model.id)
                await asyncio.sleep(0)  # yield between models
        await write_samples(session, rows)
        if prune:
            await prune_snapshots(session, prune)
        return len(rows)


ENGINE = ModelEngine()
after_commit.listen(ENGINE._on_events)  # model edits (after commit) reload the definitions


def notify_changed(session: AsyncSession, tenant_id: Any, model_id: Any) -> None:
    """Tell the engine (after commit) that a model definition or state changed."""
    from factorix.platform.after_commit import queue

    queue(session, {"kind": CHANGE_EVENT, "tenant_id": str(tenant_id), "model_id": str(model_id)})
