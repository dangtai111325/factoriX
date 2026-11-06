"""Data Model evaluation engine.

Telemetry calls :func:`on_signals_changed` once per ingest batch. The engine recomposes every
PUBLISHED STATE model that contains one of the changed signals (rebuild matrix of data_clean.md
for free: only bodies that hold a changed signal are touched), stores the ordered body in
``model_state`` when its content changed, and emits EVENT model rows when a trigger signal reports
a new instant. Outgoing bodies leave the process through the after-commit queue only:

* ``{"kind": "model_body", "tenant_id", "group_id", "body", "payload": {"type": "model_body", ...}}``
* ``{"kind": "model_event", "tenant_id", "group_id", "event_id", "body", "payload": {"type": "model_event", ...}}``

The background loop (:func:`run_maintenance`) re-publishes STATE bodies per ``emit_policy.republish_ms``
(new ``publish_timestamp``, same ``source_timestamp``), finalises PENDING events after
``snapshot_grace_ms`` and prunes each EVENT model to ``max_events``.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.body import (
    DEFAULT_EMIT_POLICY,
    Member,
    as_utc,
    compose_body,
    event_dedupe_key,
    new_trigger_times,
    publish_aliases_of,
    republish_body,
    resolve_context,
    row_at,
)
from factorix.modules.common import execute, fetch_all, fetch_one, utcnow
from factorix.platform.after_commit import queue

log = logging.getLogger(__name__)

_CONTEXT_TTL_S = 15.0
_context_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
_EVENT_BATCH = 50
_GROUP_COLUMNS = "g.id, g.tenant_id, g.resource_id, g.key, g.kind, g.status, g.projection_policy_json, g.emit_policy_json"


@dataclass(frozen=True)
class Composition:
    body_text: str
    body: dict[str, Any]
    source_ts: datetime | None
    ts_from_alias: str | None
    content_hash: str


# --------------------------------------------------------------------------------------------
# Loading helpers
# --------------------------------------------------------------------------------------------


def _uuid_list(values: Iterable[Any]) -> list[UUID]:
    out: list[UUID] = []
    for value in values:
        try:
            out.append(value if isinstance(value, UUID) else UUID(str(value)))
        except (TypeError, ValueError):
            log.warning("Ignoring invalid signal id %r", value)
    return sorted(set(out), key=str)


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _policy(group: dict[str, Any]) -> dict[str, Any]:
    raw = _json(group.get("emit_policy_json")) or {}
    policy = dict(DEFAULT_EMIT_POLICY)
    if isinstance(raw, dict):
        policy.update({key: raw[key] for key in DEFAULT_EMIT_POLICY if key in raw})
    return policy


def member_from_row(row: dict[str, Any]) -> Member:
    constant = _json(row.get("constant_json"))
    return Member(
        kind=str(row.get("member_kind") or "SIGNAL").lower(),
        alias=str(row["output_alias"]),
        signal_id=str(row["signal_id"]) if row.get("signal_id") else None,
        signal_key=row.get("signal_key"),
        context_ref=row.get("context_ref"),
        value=constant.get("v") if isinstance(constant, dict) else None,
        field=row.get("system_field"),
        contributes_ts=bool(row.get("contributes_ts")),
        is_trigger=bool(row.get("is_trigger")),
    )


async def load_members(session: AsyncSession, group_ids: list[UUID]) -> dict[str, list[Member]]:
    if not group_ids:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT output_group_id, member_kind, output_alias, signal_id, signal_key, context_ref,
               constant_json, system_field, contributes_ts, is_trigger, ordinal
        FROM output_group_members
        WHERE output_group_id = ANY(:ids)
        ORDER BY output_group_id, ordinal
        """,
        {"ids": group_ids},
    )
    members: dict[str, list[Member]] = {str(gid): [] for gid in group_ids}
    for row in rows:
        members.setdefault(str(row["output_group_id"]), []).append(member_from_row(row))
    return members


def _latest_row(row: dict[str, Any]) -> dict[str, Any]:
    value_json = _json(row.get("value_json"))
    return {
        "value": value_json.get("v") if isinstance(value_json, dict) else None,
        "quality": row.get("quality"),
        "unit": row.get("unit"),
        "source_time": row.get("source_time"),
        "received_time": row.get("received_time"),
        "event_time": row.get("event_time"),
    }


async def load_latest(session: AsyncSession, tenant_id: UUID, signal_ids: list[UUID]) -> dict[str, dict[str, Any]]:
    if not signal_ids:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT signal_id, value_json, quality, unit, source_time, received_time, event_time
        FROM latest_signal_state
        WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": signal_ids},
    )
    return {str(row["signal_id"]): _latest_row(row) for row in rows}


async def resource_chain(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> list[dict[str, Any]]:
    """The model's resource first, then its CONTAINS ancestors up to the root, with type keys."""
    return await fetch_all(
        session,
        """
        WITH RECURSIVE chain (id, depth) AS (
            SELECT CAST(:resource_id AS uuid), 0
            UNION ALL
            SELECT rr.from_id, chain.depth + 1
            FROM chain
            JOIN resource_relations rr
              ON rr.to_id = chain.id AND rr.tenant_id = :tenant_id AND rr.valid_to IS NULL
            JOIN relation_types rt ON rt.id = rr.relation_type_id AND rt.code = 'CONTAINS'
            WHERE chain.depth < 32
        )
        SELECT chain.depth, r.id, r.code, r.name, t.key AS type_key
        FROM chain
        JOIN resources r ON r.id = chain.id AND r.tenant_id = :tenant_id
        JOIN resource_types t ON t.id = r.type_id
        ORDER BY chain.depth
        """,
        {"tenant_id": tenant_id, "resource_id": resource_id},
    )


async def resource_context(session: AsyncSession, tenant_id: UUID, resource_id: UUID, *, use_cache: bool = True) -> dict[str, Any]:
    cache_key = (str(tenant_id), str(resource_id))
    now = time.monotonic()
    if use_cache:
        cached = _context_cache.get(cache_key)
        if cached and now - cached[0] < _CONTEXT_TTL_S:
            return cached[1]
    context = resolve_context(await resource_chain(session, tenant_id, resource_id))
    _context_cache[cache_key] = (now, context)
    return context


async def row_at_instant(session: AsyncSession, tenant_id: UUID, signal_id: UUID, at: datetime) -> dict[str, Any] | None:
    """Observation of ``signal_id`` active at ``at`` (source_time, else received/event time, at or before ``at``)."""
    rows = await fetch_all(
        session,
        """
        SELECT value_json, quality, unit, source_time, received_time, event_time
        FROM observations
        WHERE tenant_id = :tenant_id AND signal_id = :signal_id
          AND source_time IS NOT NULL AND source_time <= :at
        ORDER BY source_time DESC, received_time DESC
        LIMIT 1
        """,
        {"tenant_id": tenant_id, "signal_id": signal_id, "at": at},
    )
    if not rows:
        # Sources without a group timestamp: event_time equals received_time (indexed).
        rows = await fetch_all(
            session,
            """
            SELECT value_json, quality, unit, source_time, received_time, event_time
            FROM observations
            WHERE tenant_id = :tenant_id AND signal_id = :signal_id
              AND source_time IS NULL AND event_time <= :at
            ORDER BY event_time DESC, received_time DESC
            LIMIT 1
            """,
            {"tenant_id": tenant_id, "signal_id": signal_id, "at": at},
        )
    return row_at([_latest_row(row) for row in rows], at)


# --------------------------------------------------------------------------------------------
# Composition
# --------------------------------------------------------------------------------------------


def compose(
    group: dict[str, Any],
    members: list[Member],
    latest: dict[str, dict[str, Any]],
    context: dict[str, Any],
    now: datetime,
    snapshot: dict[str, Any] | None = None,
) -> Composition:
    projection = _json(group.get("projection_policy_json")) or None
    body_text, body, source_ts, ts_alias, digest = compose_body(
        members, latest, context, now, snapshot, projection=projection if isinstance(projection, dict) else None
    )
    return Composition(body_text, body, source_ts, ts_alias, digest)


async def snapshot_at(
    session: AsyncSession, tenant_id: UUID, members: list[Member], at: datetime
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Rows of every signal member and values of every snapshot member as they were at ``at``."""
    rows: dict[str, dict[str, Any]] = {}
    snapshot: dict[str, Any] = {}
    cache: dict[str, dict[str, Any] | None] = {}
    for member in members:
        if member.kind not in ("signal", "snapshot") or not member.signal_id:
            continue
        if member.signal_id not in cache:
            cache[member.signal_id] = await row_at_instant(session, tenant_id, UUID(member.signal_id), at)
        found = cache[member.signal_id]
        if member.kind == "signal" and found is not None:
            rows[member.signal_id] = found
        if member.kind == "snapshot":
            snapshot[member.signal_id] = None if found is None else found.get("value")
    return rows, snapshot


def _body_event(tenant_id: Any, group_id: Any, body_text: str) -> dict[str, Any]:
    return {
        "kind": "model_body",
        "tenant_id": str(tenant_id),
        "group_id": str(group_id),
        "body": body_text,
        "payload": {"type": "model_body", "group_id": str(group_id), "body": body_text},
    }


def _event_event(tenant_id: Any, group_id: Any, event_id: Any, body_text: str) -> dict[str, Any]:
    return {
        "kind": "model_event",
        "tenant_id": str(tenant_id),
        "group_id": str(group_id),
        "event_id": str(event_id),
        "body": body_text,
        "payload": {"type": "model_event", "group_id": str(group_id), "event_id": str(event_id), "body": body_text},
    }


async def _store_state(
    session: AsyncSession, group: dict[str, Any], result: Composition, existing_hash: str | None, now: datetime, *, force: bool
) -> list[dict[str, Any]]:
    if not force and existing_hash == result.content_hash:
        return []
    await execute(
        session,
        """
        INSERT INTO model_state (group_id, tenant_id, body_text, content_hash, source_ts, last_publish_ts, updated_at)
        VALUES (:group_id, :tenant_id, :body, :hash, :source_ts, :now, :now)
        ON CONFLICT (group_id) DO UPDATE SET
            body_text = EXCLUDED.body_text,
            content_hash = EXCLUDED.content_hash,
            source_ts = EXCLUDED.source_ts,
            last_publish_ts = EXCLUDED.last_publish_ts,
            updated_at = EXCLUDED.updated_at
        """,
        {
            "group_id": group["id"],
            "tenant_id": group["tenant_id"],
            "body": result.body_text,
            "hash": result.content_hash,
            "source_ts": result.source_ts,
            "now": now,
        },
    )
    return [_body_event(group["tenant_id"], group["id"], result.body_text)]


async def _evaluate_events(
    session: AsyncSession, group: dict[str, Any], members: list[Member], context: dict[str, Any], now: datetime
) -> list[dict[str, Any]]:
    tenant_id = group["tenant_id"]
    triggers = [m for m in members if m.is_trigger and m.signal_id]
    if not triggers:
        return []
    trigger_ids = _uuid_list(m.signal_id for m in triggers)
    last = await fetch_one(
        session,
        """
        SELECT source_ts, dedupe_key FROM model_events
        WHERE tenant_id = :tenant_id AND group_id = :group_id
        ORDER BY source_ts DESC, created_at DESC
        LIMIT 1
        """,
        {"tenant_id": tenant_id, "group_id": group["id"]},
    )
    last_ts = last["source_ts"] if last else None
    if last_ts is None:
        candidates = await fetch_all(
            session,
            """
            SELECT max(source_time) AS source_time FROM observations
            WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids) AND source_time IS NOT NULL
            """,
            {"tenant_id": tenant_id, "ids": trigger_ids},
        )
    else:
        candidates = await fetch_all(
            session,
            """
            SELECT DISTINCT source_time FROM observations
            WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids) AND source_time > :last_ts
            ORDER BY source_time ASC
            LIMIT :limit
            """,
            {"tenant_id": tenant_id, "ids": trigger_ids, "last_ts": last_ts, "limit": _EVENT_BATCH},
        )
    instants = new_trigger_times((row["source_time"] for row in candidates), last_ts, limit=_EVENT_BATCH)

    policy = _policy(group)
    status = "PENDING" if int(policy.get("snapshot_grace_ms") or 0) > 0 else "FINAL"
    emitted: list[dict[str, Any]] = []

    if not instants:
        # Fallback for triggers whose source reports no group timestamp: a change of the trigger
        # values is the event, stamped with the latest received time.
        latest = await load_latest(session, tenant_id, trigger_ids)
        rows = [latest.get(m.signal_id or "") for m in triggers]
        if not rows or any(r is None for r in rows) or any(as_utc(r.get("source_time")) is not None for r in rows if r):
            return []
        values = [r.get("value") for r in rows if r]
        dedupe = event_dedupe_key(None, values)
        if last and last.get("dedupe_key") == dedupe:
            return []
        received = [as_utc(r.get("received_time")) for r in rows if r]
        at = max((ts for ts in received if ts is not None), default=None)
        if at is None:
            return []
        pairs = [(at, dedupe)]
    else:
        pairs = [(at, event_dedupe_key(at)) for at in instants]

    for at, dedupe in pairs:
        rows_at, snapshot = await snapshot_at(session, tenant_id, members, at)
        result = compose(group, members, rows_at, context, now, snapshot)
        event_id = uuid4()
        inserted = await fetch_one(
            session,
            """
            INSERT INTO model_events (id, tenant_id, group_id, dedupe_key, source_ts, body_text, status, created_at)
            VALUES (:id, :tenant_id, :group_id, :dedupe, :source_ts, :body, :status, :now)
            ON CONFLICT (group_id, dedupe_key) DO NOTHING
            RETURNING id
            """,
            {
                "id": event_id,
                "tenant_id": tenant_id,
                "group_id": group["id"],
                "dedupe": dedupe,
                "source_ts": at,
                "body": result.body_text,
                "status": status,
                "now": now,
            },
        )
        if inserted is not None and status == "FINAL":
            emitted.append(_event_event(tenant_id, group["id"], event_id, result.body_text))
    return emitted


async def _process_groups(
    session: AsyncSession, tenant_id: UUID, groups: list[dict[str, Any]], now: datetime, *, force: bool, use_cache: bool
) -> list[dict[str, Any]]:
    if not groups:
        return []
    group_ids = _uuid_list(g["id"] for g in groups)
    members_by_group = await load_members(session, group_ids)
    state_groups = [g for g in groups if g["kind"] == "STATE"]
    signal_ids = _uuid_list(
        m.signal_id for g in state_groups for m in members_by_group.get(str(g["id"]), []) if m.signal_id
    )
    latest = await load_latest(session, tenant_id, signal_ids)
    hashes = {
        str(row["group_id"]): row["content_hash"]
        for row in await fetch_all(
            session,
            "SELECT group_id, content_hash FROM model_state WHERE group_id = ANY(:ids)",
            {"ids": _uuid_list(g["id"] for g in state_groups)},
        )
    } if state_groups else {}

    events: list[dict[str, Any]] = []
    for group in groups:
        members = members_by_group.get(str(group["id"]), [])
        if not members:
            continue
        context = await resource_context(session, tenant_id, UUID(str(group["resource_id"])), use_cache=use_cache)
        if group["kind"] == "STATE":
            result = compose(group, members, latest, context, now)
            events.extend(await _store_state(session, group, result, hashes.get(str(group["id"])), now, force=force))
        else:
            events.extend(await _evaluate_events(session, group, members, context, now))
    return events


# --------------------------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------------------------


async def on_signals_changed(session: AsyncSession, tenant_id: UUID, signal_ids: set[UUID | str]) -> None:
    """Recompose published models touched by one ingest batch.

    Runs in a savepoint: a model that cannot be composed is logged and skipped, it never rolls
    back the raw observations of the batch.
    """
    ids = _uuid_list(signal_ids)
    if not ids:
        return
    now = utcnow()
    try:
        async with session.begin_nested():
            groups = await fetch_all(
                session,
                f"""
                SELECT {_GROUP_COLUMNS}
                FROM output_groups g
                WHERE g.tenant_id = :tenant_id AND g.status = 'PUBLISHED'
                  AND EXISTS (
                      SELECT 1 FROM output_group_members m
                      WHERE m.output_group_id = g.id AND m.signal_id = ANY(:ids)
                        AND (
                            (g.kind = 'STATE' AND m.member_kind = 'SIGNAL')
                            OR (g.kind = 'EVENT' AND m.member_kind = 'SIGNAL' AND m.is_trigger)
                        )
                  )
                """,
                {"tenant_id": tenant_id, "ids": ids},
            )
            events = await _process_groups(session, tenant_id, groups, now, force=False, use_cache=True)
    except Exception:  # noqa: BLE001 - composition must not lose the raw batch; the error is logged
        log.exception("Data model composition failed for tenant %s (%d signals)", tenant_id, len(ids))
        return
    for event in events:
        queue(session, event)


async def refresh_groups(session: AsyncSession, tenant_id: UUID, group_ids: Iterable[UUID], *, force: bool = True) -> int:
    """Compose the given PUBLISHED models now (publish, patch). Returns the number of queued messages."""
    ids = _uuid_list(group_ids)
    if not ids:
        return 0
    groups = await fetch_all(
        session,
        f"SELECT {_GROUP_COLUMNS} FROM output_groups g WHERE g.tenant_id = :tenant_id AND g.id = ANY(:ids) AND g.status = 'PUBLISHED'",
        {"tenant_id": tenant_id, "ids": ids},
    )
    events = await _process_groups(session, tenant_id, groups, utcnow(), force=force, use_cache=False)
    for event in events:
        queue(session, event)
    return len(events)


async def republish_due(session: AsyncSession, now: datetime) -> list[dict[str, Any]]:
    rows = await fetch_all(
        session,
        """
        SELECT s.group_id, s.tenant_id, s.body_text
        FROM model_state s
        JOIN output_groups g ON g.id = s.group_id
        WHERE g.status = 'PUBLISHED' AND g.kind = 'STATE'
          AND jsonb_typeof(g.emit_policy_json -> 'republish_ms') = 'number'
          AND s.last_publish_ts <= CAST(:now AS timestamptz)
              - make_interval(secs => (g.emit_policy_json ->> 'republish_ms')::double precision / 1000.0)
        ORDER BY s.last_publish_ts
        LIMIT 500
        """,
        {"now": now},
    )
    if not rows:
        return []
    members = await load_members(session, _uuid_list(row["group_id"] for row in rows))
    events: list[dict[str, Any]] = []
    for row in rows:
        body_text = republish_body(row["body_text"], publish_aliases_of(members.get(str(row["group_id"]), [])), now)
        await execute(
            session,
            "UPDATE model_state SET body_text = :body, last_publish_ts = :now WHERE group_id = :group_id",
            {"body": body_text, "now": now, "group_id": row["group_id"]},
        )
        events.append(_body_event(row["tenant_id"], row["group_id"], body_text))
    return events


async def finalize_pending(session: AsyncSession, now: datetime) -> list[dict[str, Any]]:
    rows = await fetch_all(
        session,
        f"""
        SELECT e.id AS event_id, e.source_ts, {_GROUP_COLUMNS}
        FROM model_events e
        JOIN output_groups g ON g.id = e.group_id
        WHERE e.status = 'PENDING'
          AND e.created_at <= CAST(:now AS timestamptz) - make_interval(
              secs => COALESCE((g.emit_policy_json ->> 'snapshot_grace_ms')::double precision, 0) / 1000.0)
        ORDER BY e.created_at
        LIMIT 200
        """,
        {"now": now},
    )
    if not rows:
        return []
    members = await load_members(session, _uuid_list(row["id"] for row in rows))
    events: list[dict[str, Any]] = []
    for row in rows:
        group_members = members.get(str(row["id"]), [])
        tenant_id = UUID(str(row["tenant_id"]))
        context = await resource_context(session, tenant_id, UUID(str(row["resource_id"])))
        rows_at, snapshot = await snapshot_at(session, tenant_id, group_members, row["source_ts"])
        result = compose(row, group_members, rows_at, context, now, snapshot)
        await execute(
            session,
            "UPDATE model_events SET body_text = :body, status = 'FINAL' WHERE id = :id AND status = 'PENDING'",
            {"body": result.body_text, "id": row["event_id"]},
        )
        events.append(_event_event(tenant_id, row["id"], row["event_id"], result.body_text))
    return events


async def prune_events(session: AsyncSession) -> None:
    await execute(
        session,
        """
        DELETE FROM model_events e
        USING (
            SELECT ranked.id FROM (
                SELECT me.id,
                       row_number() OVER (PARTITION BY me.group_id ORDER BY me.source_ts DESC, me.created_at DESC) AS rn,
                       COALESCE((g.emit_policy_json ->> 'max_events')::integer, 1000) AS keep
                FROM model_events me
                JOIN output_groups g ON g.id = me.group_id
            ) ranked
            WHERE ranked.rn > ranked.keep
        ) doomed
        WHERE e.id = doomed.id
        """,
        {},
    )


async def run_maintenance(session: AsyncSession, *, prune: bool) -> int:
    """One background tick. Queues outgoing messages on ``session``; the caller commits and flushes."""
    now = utcnow()
    events = await republish_due(session, now)
    events.extend(await finalize_pending(session, now))
    if prune:
        await prune_events(session)
    for event in events:
        queue(session, event)
    return len(events)
