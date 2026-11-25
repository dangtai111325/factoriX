"""Managed recording of Data Model fields into user-created TDengine subtables (guide C1/C4, G-05/G-06).

Path::

    ModelEngine.process (one PG transaction)
      -> model_state upsert
      -> capture_model_results(): per bound field, compare with the DURABLE last committed state
         (storage_field_state) -> on change: storage_record_outbox row + state update   [same tx]
    RecordingDispatcher (background)
      -> PENDING outbox rows -> INSERT INTO db.sub (existing columns only) VALUES ...
      -> CONFIRMED only after TDengine accepted the insert; retry with backoff; FAILED after the
         retry budget or on a non-retryable error (visible in the Storage UI, never silent)

Semantics (guide D3/D4, plan §5.3):

* ON_CHANGE (per-field subtables, row assembly INDEPENDENT_EVENTS): the first observation of a field
  in an epoch is the baseline; afterwards a row is written only when the typed value, the null-state
  or (when ``quality_transitions``) the quality changes. A body that is only re-published (same value,
  new ``publish_timestamp``) writes nothing. A field missing from the body (not sampled) writes
  nothing and does not reset the state. ``40`` and ``40.0`` are equal for a DOUBLE column; ``false``
  and ``0`` are never equal; ``None`` != ``0`` != ``""``. A->B->A writes two changes.
* ON_NEW_EVENT (row assembly ATOMIC_EVENT, e.g. order_progress): one row holding all bound fields is
  written when the event identity (``identity_paths``, default: the bound fields plus the body
  ``source_timestamp``) differs from the last recorded identity; a re-delivered identical event is
  deduplicated. Limitation (guide D4/G-07): the source is the sampled model body, so two completions
  between two samples cannot be told apart; the UI states this.
* EVERY_ACQUISITION: every model sample writes a row.
* ``ts`` (guide D2): a ``mapping`` field's own source time (its signal sample's source time, else
  received time; ``field_source_timestamp`` = the same, ``time_basis=FIELD_SOURCE``); otherwise the
  body ``source_timestamp`` (``time_basis=MODEL_BODY``). The body ``source_timestamp`` is
  ``latest_ts()`` over ALL the model's signals, so a field whose signal lags the others changes
  value without the body time moving (R2-20: two values at one body time); the field time fixes that.
* ``event_key`` = hex(epoch) + hex(sequence) + sha256(tenant | binding key | epoch | sequence) ->
  stable across replays (idempotent upsert on the ``(ts, event_key)`` composite key) and, since rows
  of one ``ts`` sort by the key, in write order when two rows still share a timestamp.
* Only columns that exist in the target STABLE are written: the guide's E1 audit columns are filled
  when present, no system column is ever added (an op-style schema is not assumed).
* Old-epoch outbox rows are fenced (FAILED ``EPOCH_FENCED``) and never written after a reset.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import partial
import hashlib
import json
import logging
import math
import time
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix_core.tdengine.sql import parse_aware_ts, quote_str, ts_int_literal, typed_literal

from factorix.modules import storage_bindings as SB
from factorix.modules.common import execute, execute_rowcount, fetch_all, fetch_one, iso_ms, utcnow

log = logging.getLogger(__name__)

BINDING_TTL_S = 10.0
SCHEMA_TTL_S = 60.0
DISPATCH_BATCH = 500
DISPATCH_IDLE_S = 1.0
#: A claimed batch is invisible to other dispatchers for this long; a dispatcher that dies after claiming
#: lets the rows come back after the lease (replayed idempotently by the composite key).
CLAIM_LEASE_S = 60
#: Prune of CONFIRMED rows: at most PRUNE_BATCHES x PRUNE_BATCH rows per round, one short transaction each.
PRUNE_BATCH = 5000
PRUNE_BATCHES = 20
MAX_ATTEMPTS = 8
CONFIRMED_KEEP = timedelta(hours=1)
QUALITY_ORDER = ("BAD", "NO_DATA", "DISABLED", "MISSING", "STALE", "PAUSED", "UNCERTAIN", "DELAYED", "GOOD")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


# ============================================================================================
# Targets (bindings) cache
# ============================================================================================


@dataclass(frozen=True, slots=True)
class FieldBinding:
    binding_id: str
    model_id: str
    path: str
    column: str
    source_data_type: str


@dataclass(slots=True)
class RecordingTarget:
    database: str
    subtable: str
    stable: str
    mode: str
    row_assembly: str
    identity_paths: tuple[str, ...]
    quality_transitions: bool
    bindings: list[FieldBinding] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.database}.{self.subtable}"


_targets: dict[str, tuple[float, dict[str, list[RecordingTarget]]]] = {}


def invalidate_bindings(tenant_id: Any = None) -> None:
    if tenant_id is None:
        _targets.clear()
    else:
        _targets.pop(str(tenant_id), None)


def _json(raw: Any) -> Any:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return {}
    return raw


def targets_from_rows(rows: Iterable[Mapping[str, Any]]) -> dict[str, list[RecordingTarget]]:
    """Group active model-field bindings into one recording target per subtable, keyed by model id."""
    by_sub: dict[str, RecordingTarget] = {}
    for r in rows:
        cfg = _json(r.get("policy_config_json")) or {}
        rec = _json(r.get("recording_json")) or {}
        key = f"{r['physical_db']}.{r['physical_subtable']}"
        tgt = by_sub.get(key)
        if tgt is None:
            mode = str(cfg.get("mode") or rec.get("mode") or "ON_CHANGE").upper()
            tgt = by_sub[key] = RecordingTarget(
                database=str(r["physical_db"]),
                subtable=str(r["physical_subtable"]),
                stable=str(r.get("parent_name") or ""),
                mode=mode,
                row_assembly=str(r.get("row_assembly_policy") or "INDEPENDENT_EVENTS").upper(),
                identity_paths=tuple(cfg.get("identity_paths") or rec.get("identity_paths") or ()),
                quality_transitions=bool(cfg.get("quality_transitions", True)),
            )
        tgt.bindings.append(FieldBinding(
            binding_id=str(r["id"]),
            model_id=str(r["model_id"]),
            path=SB.normalize_field_path(r.get("model_field_path")),
            column=str(r["target_column"]),
            source_data_type=str(r.get("source_data_type") or "auto"),
        ))
    by_model: dict[str, list[RecordingTarget]] = {}
    for tgt in by_sub.values():
        for mid in {b.model_id for b in tgt.bindings}:
            by_model.setdefault(mid, []).append(tgt)
    return by_model


def has_targets(tenant_id: Any, model_id: Any) -> bool:
    """Cheap sync check used by the engine before building a :class:`ModelResult`."""
    cached = _targets.get(str(tenant_id))
    return bool(cached and cached[1].get(str(model_id)))


async def ensure_targets(session: Any, tenant_id: UUID) -> None:
    """Refresh the binding cache of a tenant when stale (never breaks the caller's transaction)."""
    if not isinstance(session, AsyncSession):
        return
    cached = _targets.get(str(tenant_id))
    if cached is not None and time.monotonic() - cached[0] < BINDING_TTL_S:
        return
    try:
        async with session.begin_nested():
            await load_targets(session, tenant_id)
    except Exception as exc:  # noqa: BLE001 - e.g. migration 0010 not applied yet
        _targets[str(tenant_id)] = (time.monotonic(), {})
        _capture_stats["last_error"] = f"binding load failed: {exc}"[:500]
        log.warning("Recording bindings could not be loaded for %s: %s", tenant_id, exc)


async def load_targets(session: AsyncSession, tenant_id: UUID) -> dict[str, list[RecordingTarget]]:
    cached = _targets.get(str(tenant_id))
    if cached is not None and time.monotonic() - cached[0] < BINDING_TTL_S:
        return cached[1]
    rows = await fetch_all(
        session,
        """
        SELECT sb.id, sb.physical_db, sb.physical_subtable, sb.target_column, sb.model_id,
               sb.model_field_path, sb.row_assembly_policy, sb.policy_config_json, sb.source_data_type,
               so.parent_name, so.recording_json
        FROM storage_bindings sb
        JOIN storage_objects so
          ON so.tenant_id = sb.tenant_id AND so.object_type = 'subtable'
         AND so.physical_db = sb.physical_db AND so.physical_name = sb.physical_subtable
        WHERE sb.tenant_id = :tenant_id AND sb.status = 'ACTIVE' AND sb.source_kind = 'model_field'
          AND sb.model_id IS NOT NULL AND so.status = 'ACTIVE'
        ORDER BY sb.physical_db, sb.physical_subtable, sb.target_column
        """,
        {"tenant_id": tenant_id},
    )
    targets = targets_from_rows(rows)
    _targets[str(tenant_id)] = (time.monotonic(), targets)
    return targets


# ============================================================================================
# Pure change detection
# ============================================================================================


@dataclass(slots=True)
class FieldState:
    data_epoch: int
    last_value_json: str | None
    last_quality: str | None
    last_is_null: bool
    last_identity: str | None
    sequence: int


@dataclass(slots=True)
class ModelResult:
    """One evaluated model sample handed over by the engine."""

    model_id: str
    model_revision: int
    sampled_at: datetime
    body: Any
    field_quality: Mapping[str, tuple[str, str | None]]  # path -> (quality, reason)
    # path -> the field's OWN source time (guide D2 provenance), see :func:`field_source_times`.
    # Empty (engine did not pass it) -> every field falls back to the body time (MODEL_BODY).
    field_source_ts: Mapping[str, datetime] = field(default_factory=dict)


@dataclass(slots=True)
class PlannedRecord:
    tenant_id: str
    database: str
    subtable: str
    event_key: str
    ts: datetime
    data_epoch: int
    columns: dict[str, Any]
    error: str | None = None


def canonical(value: Any) -> str:
    """Type-aware canonical text: 40 == 40.0, False != 0, None != 0 != ''."""
    if isinstance(value, bool):
        return "b:" + ("1" if value else "0")
    if isinstance(value, (int, float)):
        num = float(value)
        if math.isnan(num):
            return "n:nan"
        return "n:" + repr(num + 0.0)
    if value is None:
        return "null"
    if isinstance(value, str):
        return "s:" + value
    return "j:" + json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def event_key_for(tenant_id: str, binding_key: str, epoch: int, sequence: int) -> str:
    """32 hex chars = epoch (6) + sequence (10) + sha256(tenant|binding|epoch|sequence) (16).

    Deterministic (a replay upserts the same ``(ts, event_key)``, OC-013) and, because TDengine orders
    rows of one ``ts`` by the composite key, rows that share a timestamp keep their WRITE order
    (R2-20: two changes inside one body timestamp — ``last()`` and the Historian must see the later
    one last; a bare hash ordered them at random). Same length as before (fits ``VARCHAR(32+)``)."""
    raw = f"{tenant_id}|{binding_key}|{epoch}|{sequence}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return f"{int(epoch) % 0x1000000:06x}{int(sequence) % 0x10000000000:010x}{digest}"


def field_source_times(compiled: Any, samples: Mapping[str, Any]) -> dict[str, datetime]:
    """Real per-field provenance (guide D2) for the recorder: a ``mapping`` field's value IS the
    latest sample of its signal, so its own time is that sample's ``ts`` (source time, else received
    time — the same time ``latest_ts()`` takes the maximum of for the body ``source_timestamp``).
    Calculated fields get none (their value is derived; the body time is kept, ``MODEL_BODY``)."""
    out: dict[str, datetime] = {}
    for item in getattr(compiled, "fields", []) or []:
        if getattr(item, "mode", None) != "mapping" or not getattr(item, "signal_id", None):
            continue
        sid = str(item.signal_id)
        sample = samples.get(sid) or samples.get(sid.lower())
        ts = _parse_ts(getattr(sample, "ts", None)) if sample is not None else None
        if ts is not None:
            out[SB.normalize_field_path(item.path)] = ts
    return out


# R2-E B7: datetime (naive = UTC) or ISO text -> aware datetime, else None (shared kernel, same behaviour).
_parse_ts = parse_aware_ts


def worst_quality(values: Iterable[str]) -> str:
    rank = {q: i for i, q in enumerate(QUALITY_ORDER)}
    vals = [str(v or "NO_DATA").upper() for v in values]
    return min(vals, key=lambda q: rank.get(q, 0)) if vals else "GOOD"


def _audit_columns(
    tenant_id: str, target: RecordingTarget, result: ModelResult, epoch: int, ts: datetime, event_key: str,
    quality: str, reason: str | None, is_null: bool | None, path: str | None,
    field_ts: datetime | None = None,
) -> dict[str, Any]:
    src_ts = _parse_ts(SB.extract_field(result.body, "source_timestamp")[1]) if isinstance(result.body, dict) else None
    pub_ts = _parse_ts(SB.extract_field(result.body, "publish_timestamp")[1]) if isinstance(result.body, dict) else None
    cols: dict[str, Any] = {
        "ts": ts,
        "event_key": event_key,
        "source_timestamp": src_ts,  # the body's, unchanged (guide D2: immutable body timestamp)
        "publish_timestamp": pub_ts or result.sampled_at,
        "field_source_timestamp": field_ts,
        "quality": quality[:16],
        "quality_reason": (reason or None) and str(reason)[:128],
        "model_ref": result.model_id,
        "model_revision": int(result.model_revision),
        "data_epoch": int(epoch),
        "source_event_uid": f"{result.model_id}:{iso_ms(result.sampled_at)}",
        "time_basis": "FIELD_SOURCE" if field_ts is not None else "MODEL_BODY",
    }
    if is_null is not None:
        cols["is_null"] = bool(is_null)
    if path is not None:
        cols["model_field_path"] = path[:128]
    return cols


def plan_records(
    tenant_id: str,
    epoch: int,
    results: Sequence[ModelResult],
    targets_by_model: Mapping[str, list[RecordingTarget]],
    states: Mapping[str, FieldState],
) -> tuple[list[PlannedRecord], dict[str, FieldState]]:
    """Decide which rows to record. Returns ``(records, new_states)`` keyed by binding key."""
    records: list[PlannedRecord] = []
    new_states: dict[str, FieldState] = {}
    by_model = {r.model_id: r for r in results}
    seen_targets: set[str] = set()

    def state_of(key: str) -> FieldState | None:
        return new_states.get(key) or states.get(key)

    for result in results:
        for target in targets_by_model.get(result.model_id, []):
            if target.row_assembly == "ATOMIC_EVENT":
                if target.key in seen_targets:
                    continue
                seen_targets.add(target.key)
                src = by_model.get(target.bindings[0].model_id)
                if src is None:
                    continue
                values: dict[str, Any] = {}
                found_any = False
                for b in target.bindings:
                    found, val = SB.extract_field(src.body, b.path)
                    if found:
                        found_any = True
                    values[b.column] = val if found else None
                if not found_any or all(v is None for v in values.values()):
                    continue  # no event in this sample (or nothing sampled yet)
                id_paths = list(target.identity_paths) or [b.path for b in target.bindings] + ["source_timestamp"]
                identity = json.dumps([canonical(SB.extract_field(src.body, p)[1]) for p in id_paths], separators=(",", ":"))
                bkey = f"{target.key}:event"
                st = state_of(bkey)
                if st is not None and st.data_epoch == epoch and st.last_identity == identity:
                    continue  # same event re-delivered: dedup
                seq = (st.sequence + 1) if st is not None and st.data_epoch == epoch else 1
                ekey = event_key_for(tenant_id, bkey, epoch, seq)
                ts = _parse_ts(SB.extract_field(src.body, "source_timestamp")[1]) or src.sampled_at
                qual = worst_quality([src.field_quality.get(b.path, ("GOOD", None))[0] for b in target.bindings])
                cols = _audit_columns(tenant_id, target, src, epoch, ts, ekey, qual, None, None, None)
                cols.update(values)
                records.append(PlannedRecord(tenant_id, target.database, target.subtable, ekey, ts, epoch, cols))
                new_states[bkey] = FieldState(epoch, None, qual, False, identity, seq)
                continue
            for b in target.bindings:
                if b.model_id != result.model_id:
                    continue
                found, value = SB.extract_field(result.body, b.path)
                if not found:
                    continue  # NOT_SAMPLED: missing field is not a transition to null
                quality, reason = result.field_quality.get(b.path, ("GOOD", None))
                quality = str(quality or "GOOD").upper()
                is_null = value is None
                canon = canonical(value)
                bkey = f"{target.key}:{b.column}"
                st = state_of(bkey)
                same_epoch = st is not None and st.data_epoch == epoch
                if target.mode != "EVERY_ACQUISITION" and same_epoch:
                    assert st is not None
                    unchanged = (
                        st.last_value_json == canon
                        and st.last_is_null == is_null
                        and (not target.quality_transitions or (st.last_quality or "") == quality)
                    )
                    if unchanged:
                        continue
                seq = (st.sequence + 1) if same_epoch and st is not None else 1
                ekey = event_key_for(tenant_id, bkey, epoch, seq)
                # Guide D2: ts = the field's own source time when provenance gives it (FIELD_SOURCE);
                # else the body source_timestamp (MODEL_BODY); never now() as a source time.
                field_ts = (result.field_source_ts or {}).get(b.path)
                src_ts = _parse_ts(SB.extract_field(result.body, "source_timestamp")[1])
                ts = field_ts or src_ts or result.sampled_at
                cols = _audit_columns(tenant_id, target, result, epoch, ts, ekey, quality, reason, is_null, b.path,
                                      field_ts)
                cols[b.column] = value
                records.append(PlannedRecord(tenant_id, target.database, target.subtable, ekey, ts, epoch, cols))
                new_states[bkey] = FieldState(epoch, canon, quality, is_null, None, seq)
    return records, new_states


# ============================================================================================
# Capture (inside the model engine transaction)
# ============================================================================================

_capture_stats: dict[str, Any] = {"captured": 0, "errors": 0, "last_error": None, "last_error_at": None}


def field_quality_map(compiled: Any, result: Any, qualities: Mapping[str, str | None]) -> dict[str, tuple[str, str | None]]:
    """Per-field quality from the evaluated body: mapping = its signal's effective status; rule = the
    worst status of the signals it reads (GOOD when it reads none); an evaluation error = BAD."""
    errors = {str(e.get("path") or ""): str(e.get("message") or "") for e in getattr(result, "errors", []) or []}
    out: dict[str, tuple[str, str | None]] = {}
    for item in getattr(compiled, "fields", []) or []:
        path = SB.normalize_field_path(item.path)
        if item.path in errors:
            out[path] = ("BAD", errors[item.path])
            continue
        if item.mode == "mapping":
            sids = [item.signal_id] if item.signal_id else []
        elif item.program is not None:
            sids = sorted(item.program.signal_ids)
        else:
            sids = []
        if not sids:
            out[path] = ("GOOD", None)
            continue
        q = worst_quality(qualities.get(str(s).lower()) or "NO_DATA" for s in sids)
        out[path] = (q, None if q == "GOOD" else f"source {q.lower()}")
    return out


async def capture_model_results(
    session: AsyncSession,
    tenant_id: UUID,
    results: Sequence[ModelResult] | Any,
    *,
    epoch: int | None = None,
) -> int:
    """Record changed bound fields of ``results`` (same transaction as model_state). Returns rows queued."""
    targets = await load_targets(session, tenant_id)
    if not targets:
        return 0
    results = [r for r in results if r.model_id in targets]
    if not results:
        return 0
    if epoch is None:
        from factorix.modules.history_repository import _active_epoch_for

        epoch = await _active_epoch_for(session, tenant_id)
    keys: list[str] = []
    for r in results:
        for tgt in targets[r.model_id]:
            if tgt.row_assembly == "ATOMIC_EVENT":
                keys.append(f"{tgt.key}:event")
            else:
                keys.extend(f"{tgt.key}:{b.column}" for b in tgt.bindings if b.model_id == r.model_id)
    rows = await fetch_all(
        session,
        """
        SELECT binding_key, data_epoch, last_value_canon, last_quality, last_is_null, last_identity, sequence
        FROM storage_field_state WHERE tenant_id = :tenant_id AND binding_key = ANY(:keys)
        """,
        {"tenant_id": tenant_id, "keys": sorted(set(keys))},
    )
    states = {
        str(r["binding_key"]): FieldState(
            int(r.get("data_epoch") or 1),
            r.get("last_value_canon"),
            r.get("last_quality"), bool(r.get("last_is_null")), r.get("last_identity"), int(r.get("sequence") or 0),
        )
        for r in rows
    }
    records, new_states = plan_records(str(tenant_id), int(epoch), results, targets, states)
    if not records:
        return 0
    await execute(
        session,
        """
        INSERT INTO storage_record_outbox (tenant_id, physical_db, physical_subtable, event_key, ts, data_epoch, payload_json)
        SELECT :tenant_id, t.db, t.sub, t.ekey, t.ts, t.epoch, CAST(t.payload AS jsonb)
        FROM unnest(CAST(:dbs AS text[]), CAST(:subs AS text[]), CAST(:ekeys AS text[]),
                    CAST(:tss AS timestamptz[]), CAST(:epochs AS bigint[]), CAST(:payloads AS text[]))
             AS t(db, sub, ekey, ts, epoch, payload)
        ON CONFLICT (tenant_id, physical_db, physical_subtable, event_key) DO NOTHING
        """,
        {
            "tenant_id": tenant_id,
            "dbs": [r.database for r in records],
            "subs": [r.subtable for r in records],
            "ekeys": [r.event_key for r in records],
            "tss": [r.ts for r in records],
            "epochs": [r.data_epoch for r in records],
            "payloads": [json.dumps(encode_columns(r.columns), separators=(",", ":"), ensure_ascii=False) for r in records],
        },
    )
    skeys = sorted(new_states)
    await execute(
        session,
        """
        INSERT INTO storage_field_state (binding_key, tenant_id, physical_db, physical_subtable, data_epoch,
                                         last_value_canon, last_quality, last_is_null, last_identity, sequence, updated_at)
        SELECT t.k, :tenant_id, split_part(t.k, '.', 1), split_part(split_part(t.k, ':', 1), '.', 2), t.epoch,
               t.val, t.q, t.is_null_v, t.ident, t.seq, now()
        FROM unnest(CAST(:keys AS text[]), CAST(:epochs AS bigint[]), CAST(:vals AS text[]), CAST(:qs AS text[]),
                    CAST(:nulls AS boolean[]), CAST(:idents AS text[]), CAST(:seqs AS bigint[]))
             AS t(k, epoch, val, q, is_null_v, ident, seq)
        ON CONFLICT (tenant_id, binding_key) DO UPDATE SET
            data_epoch = EXCLUDED.data_epoch, last_value_canon = EXCLUDED.last_value_canon,
            last_quality = EXCLUDED.last_quality, last_is_null = EXCLUDED.last_is_null,
            last_identity = EXCLUDED.last_identity, sequence = EXCLUDED.sequence, updated_at = now()
        """,
        {
            "tenant_id": tenant_id,
            "keys": skeys,
            "epochs": [new_states[k].data_epoch for k in skeys],
            "vals": [new_states[k].last_value_json for k in skeys],
            "qs": [new_states[k].last_quality for k in skeys],
            "nulls": [new_states[k].last_is_null for k in skeys],
            "idents": [new_states[k].last_identity for k in skeys],
            "seqs": [new_states[k].sequence for k in skeys],
        },
    )
    _capture_stats["captured"] += len(records)
    return len(records)


def encode_columns(cols: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in cols.items():
        out[k] = {"$ts": v.astimezone(timezone.utc).isoformat()} if isinstance(v, datetime) else v
    return out


def decode_columns(raw: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in raw.items():
        if isinstance(v, dict) and set(v) == {"$ts"}:
            out[k] = _parse_ts(v["$ts"])
        else:
            out[k] = v
    return out


async def capture_safely(session: AsyncSession, tenant_id: UUID, results: Sequence[ModelResult]) -> int:
    """Engine entry point: a recorder problem never stops the model engine; it is logged and counted
    (visible through :func:`recording_status`) and the savepoint keeps model_state committable."""
    if not results or not isinstance(session, AsyncSession):
        return 0
    try:
        async with session.begin_nested():
            return await capture_model_results(session, tenant_id, results)
    except Exception as exc:  # noqa: BLE001 - surfaced in recording_status + log
        _capture_stats["errors"] += 1
        _capture_stats["last_error"] = str(exc)[:500]
        _capture_stats["last_error_at"] = iso_ms(utcnow())
        log.exception("Recording capture failed for tenant %s", tenant_id)
        return 0


# ============================================================================================
# TDengine writer
# ============================================================================================


# R2-E B7: the literal helpers are the shared kernel's (same output): epoch integer at the database precision,
# and a quoted string that keeps NUL bytes (``reject_nul=False``, as this writer always did).
_ts_literal = ts_int_literal
_str_literal = partial(quote_str, reject_nul=False)


class ValueRejected(ValueError):
    pass


#: Typed literal for a column; raises :class:`ValueRejected` instead of truncating or guessing
#: (R2-E B7: ``factorix_core.tdengine.sql.typed_literal``, same output and messages).
value_literal = partial(typed_literal, reject=ValueRejected)


def build_row_sql(
    database: str, subtable: str, columns: Mapping[str, Any], schema: Sequence[tuple[str, str, int | None]], precision: str
) -> str:
    """``db.sub (c1, c2) VALUES (v1, v2)`` with ONLY the columns the subtable really has."""
    names: list[str] = []
    values: list[str] = []
    for name, td_type, length in schema:
        if name in columns:
            names.append(f"`{name}`")
            values.append(value_literal(columns[name], td_type, length, precision))
    if not names or names[0] != f"`{schema[0][0]}`":
        raise ValueRejected("the row has no timestamp column")
    return f"`{database}`.`{subtable}` ({', '.join(names)}) VALUES ({', '.join(values)})"


_retryable_tokens = ("timeout", "timed out", "connection", "unavailable", "refused", "reset by peer", "broken pipe",
                     "not ready", "leader", "0x000b", "0x0200")


def _retryable(exc: BaseException) -> bool:
    if getattr(exc, "retryable", False):
        return True
    msg = str(exc).lower()
    return any(t in msg for t in _retryable_tokens)


class RecordingDispatcher:
    """Background writer: outbox -> TDengine (at-least-once, idempotent by composite key)."""

    def __init__(self, td_client: Any = None, session_factory: Any = None) -> None:
        self.td = td_client
        self._session_factory = session_factory
        self._task: asyncio.Task[Any] | None = None
        self._schemas: dict[str, tuple[float, list[tuple[str, str, int | None]]]] = {}
        self._precision: dict[str, tuple[float, str]] = {}
        self.stats: dict[str, Any] = {"written": 0, "failed": 0, "retries": 0, "last_write_at": None, "last_error": None}
        self._last_prune: float | None = None

    def start(self, td_client: Any) -> None:
        self.td = td_client
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop(), name="storage-recording-dispatcher")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("Recording dispatcher failed during shutdown")

    def _session(self) -> Any:
        if self._session_factory is None:
            from factorix.platform.db import session_factory

            self._session_factory = session_factory()
        return self._session_factory()

    async def _loop(self) -> None:
        while True:
            try:
                n = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one failing round must not stop the writer
                self.stats["last_error"] = str(exc)[:500]
                log.exception("Recording dispatcher round failed")
                n = 0
            await asyncio.sleep(0.05 if n >= DISPATCH_BATCH else DISPATCH_IDLE_S)

    async def _schema(self, database: str, subtable: str) -> list[tuple[str, str, int | None]]:
        key = f"{database}.{subtable}"
        hit = self._schemas.get(key)
        if hit and time.monotonic() - hit[0] < SCHEMA_TTL_S:
            return hit[1]
        rows = await self.td.query_rows(f"DESCRIBE `{database}`.`{subtable}`")
        schema: list[tuple[str, str, int | None]] = []
        for r in rows or []:
            note = str(r.get("note") or r.get("Note") or "").upper()
            if "TAG" in note:
                continue
            ln = r.get("length") or r.get("Length")
            schema.append((str(r.get("field") or r.get("Field")), str(r.get("type") or r.get("Type")), int(ln) if ln else None))
        self._schemas[key] = (time.monotonic(), schema)
        return schema

    async def _db_precision(self, database: str) -> str:
        hit = self._precision.get(database)
        if hit and time.monotonic() - hit[0] < SCHEMA_TTL_S * 10:
            return hit[1]
        rows = await self.td.query_rows(
            f"SELECT `precision` FROM information_schema.ins_databases WHERE name = {_str_literal(database)}"
        )
        prec = str((rows[0].get("precision") if rows else None) or "us").lower()
        self._precision[database] = (time.monotonic(), prec)
        return prec

    async def run_once(self) -> int:
        """One round in three steps so no PostgreSQL transaction is open while TDengine is written
        (WS-P P6: an ``idle in transaction`` of 9-22 s held the vacuum horizon of the whole cluster):

        1. claim: ``FOR UPDATE SKIP LOCKED`` + lease (``next_attempt_at = now() + CLAIM_LEASE_S``), COMMIT;
        2. write the batch to TDengine with no session open;
        3. one short transaction: CONFIRMED / reschedule / FAILED.

        A crash between 2 and 3 replays the batch after the lease; ``(ts, event_key)`` makes it idempotent.
        """
        if self.td is None:
            return 0
        rows = await self._claim()
        if not rows:
            await self._prune()
            return 0
        fenced = [r["id"] for r in rows if int(r["data_epoch"] or 1) < int(r["active_epoch"] or 1)]
        fenced_set = set(fenced)
        live = [r for r in rows if r["id"] not in fenced_set]
        ok_ids, retry, failed = await self._write(live) if live else ([], [], [])
        async with self._session() as session:
            if fenced:
                await self._mark(session, fenced, "FAILED", "EPOCH_FENCED: written before a telemetry reset")
            if ok_ids:
                await execute(
                    session,
                    "UPDATE storage_record_outbox SET status = 'CONFIRMED', confirmed_at = now(), last_error = NULL WHERE id = ANY(:ids)",
                    {"ids": ok_ids},
                )
            for rid, attempts, msg in retry:
                if attempts + 1 >= MAX_ATTEMPTS:
                    failed.append((rid, msg))
                    continue
                await execute(
                    session,
                    """
                    UPDATE storage_record_outbox
                    SET attempts = attempts + 1, last_error = :err,
                        next_attempt_at = now() + make_interval(secs => :delay)
                    WHERE id = :id
                    """,
                    {"id": rid, "err": msg[:1000], "delay": float(min(60, 2 ** attempts))},
                )
                self.stats["retries"] += 1
            for rid, msg in failed:
                await self._mark(session, [rid], "FAILED", msg)
            await session.commit()
        if ok_ids:
            self.stats["written"] += len(ok_ids)
            self.stats["last_write_at"] = iso_ms(utcnow())
        return len(rows)

    async def _claim(self) -> list[dict[str, Any]]:
        """Step 1: take a batch of due PENDING rows for ``CLAIM_LEASE_S`` and commit at once."""
        async with self._session() as session:
            rows = await fetch_all(
                session,
                """
                WITH due AS (
                    SELECT id FROM storage_record_outbox
                    WHERE status = 'PENDING' AND next_attempt_at <= now()
                    ORDER BY id
                    LIMIT :limit
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE storage_record_outbox o
                SET next_attempt_at = now() + make_interval(secs => :lease)
                FROM due
                WHERE o.id = due.id
                RETURNING o.id, o.tenant_id, o.physical_db, o.physical_subtable, o.event_key, o.data_epoch,
                          o.payload_json, o.attempts,
                          COALESCE((SELECT g.active_epoch FROM telemetry_generations g WHERE g.tenant_id = o.tenant_id), 1)
                              AS active_epoch
                """,
                {"limit": DISPATCH_BATCH, "lease": float(CLAIM_LEASE_S)},
            )
            await session.commit()
        return sorted((dict(r) for r in rows), key=lambda r: int(r["id"]))

    async def _mark(self, session: AsyncSession, ids: list[Any], status: str, msg: str) -> None:
        await execute(
            session,
            "UPDATE storage_record_outbox SET status = :st, last_error = :err, attempts = attempts + 1 WHERE id = ANY(:ids)",
            {"ids": ids, "st": status, "err": msg[:1000]},
        )
        if status == "FAILED":
            self.stats["failed"] += len(ids)
            self.stats["last_error"] = msg[:500]

    async def _write(self, rows: list[Mapping[str, Any]]) -> tuple[list[Any], list[tuple[Any, int, str]], list[tuple[Any, str]]]:
        ok: list[Any] = []
        retry: list[tuple[Any, int, str]] = []
        failed: list[tuple[Any, str]] = []
        prepared: list[tuple[Mapping[str, Any], str]] = []
        for r in rows:
            payload = _json(r["payload_json"]) or {}
            try:
                schema = await self._schema(r["physical_db"], r["physical_subtable"])
                prec = await self._db_precision(r["physical_db"])
                prepared.append((r, build_row_sql(r["physical_db"], r["physical_subtable"], decode_columns(payload), schema, prec)))
            except ValueRejected as exc:
                failed.append((r["id"], f"TYPE_MISMATCH: {exc}"))
            except Exception as exc:  # noqa: BLE001
                (retry.append((r["id"], int(r["attempts"] or 0), str(exc))) if _retryable(exc)
                 else failed.append((r["id"], f"TARGET_UNAVAILABLE: {exc}")))
        chunk: list[tuple[Mapping[str, Any], str]] = []

        async def flush(items: list[tuple[Mapping[str, Any], str]]) -> None:
            if not items:
                return
            try:
                await self.td.execute_sql("INSERT INTO " + " ".join(sql for _r, sql in items))
                ok.extend(r["id"] for r, _sql in items)
                return
            except Exception as exc:  # noqa: BLE001
                if len(items) == 1:
                    r = items[0][0]
                    if _retryable(exc):
                        retry.append((r["id"], int(r["attempts"] or 0), str(exc)))
                    else:
                        failed.append((r["id"], f"TDENGINE_REJECTED: {exc}"))
                    return
            for item in items:  # isolate the offending row(s)
                await flush([item])

        size = 0
        for item in prepared:
            chunk.append(item)
            size += len(item[1])
            if len(chunk) >= 200 or size > 200_000:
                await flush(chunk)
                chunk, size = [], 0
        await flush(chunk)
        return ok, retry, failed

    async def _prune(self) -> int:
        """Delete CONFIRMED rows older than ``CONFIRMED_KEEP`` in bounded batches (WS-P P6: the single
        DELETE was a full scan of the table every 5 min). Uses the partial index of migration 0012; each
        batch is its own short transaction."""
        if self._last_prune is not None and time.monotonic() - self._last_prune < 300:
            return 0
        self._last_prune = time.monotonic()
        cutoff = utcnow() - CONFIRMED_KEEP
        total = 0
        for _ in range(PRUNE_BATCHES):
            async with self._session() as session:
                n = await execute_rowcount(
                    session,
                    """
                    DELETE FROM storage_record_outbox WHERE id IN (
                        SELECT id FROM storage_record_outbox
                        WHERE status = 'CONFIRMED' AND confirmed_at < :cutoff
                        ORDER BY confirmed_at
                        LIMIT :batch
                    )
                    """,
                    {"cutoff": cutoff, "batch": PRUNE_BATCH},
                )
                await session.commit()
            total += int(n or 0)
            if not n or n < PRUNE_BATCH:
                break
        return total


DISPATCHER = RecordingDispatcher()


async def recording_status(session: AsyncSession, tenant_id: UUID) -> dict[str, Any]:
    """Writer health for the Storage UI (guide H12.3): pending / failed / confirmed, last write, errors."""
    row = await fetch_one(
        session,
        """
        SELECT COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
               COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
               COUNT(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed_recent,
               MAX(confirmed_at) AS last_write_at,
               MIN(created_at) FILTER (WHERE status = 'PENDING') AS oldest_pending_at
        FROM storage_record_outbox WHERE tenant_id = :tenant_id
        """,
        {"tenant_id": tenant_id},
    ) or {}
    errors = await fetch_all(
        session,
        """
        SELECT physical_db, physical_subtable, last_error, COUNT(*) AS n
        FROM storage_record_outbox WHERE tenant_id = :tenant_id AND status = 'FAILED'
        GROUP BY physical_db, physical_subtable, last_error ORDER BY n DESC LIMIT 20
        """,
        {"tenant_id": tenant_id},
    )
    return {
        "pending": int(row.get("pending") or 0),
        "failed": int(row.get("failed") or 0),
        "confirmed_last_hour": int(row.get("confirmed_recent") or 0),
        "last_write_at": iso_ms(row.get("last_write_at")) if row.get("last_write_at") else None,
        "oldest_pending_at": iso_ms(row.get("oldest_pending_at")) if row.get("oldest_pending_at") else None,
        "dispatcher_running": DISPATCHER._task is not None and not DISPATCHER._task.done(),
        "writer": {k: v for k, v in DISPATCHER.stats.items()},
        "capture": dict(_capture_stats),
        "failed_by_target": [
            {"database": e["physical_db"], "subtable": e["physical_subtable"], "error": e["last_error"], "count": int(e["n"])}
            for e in errors
        ],
    }
