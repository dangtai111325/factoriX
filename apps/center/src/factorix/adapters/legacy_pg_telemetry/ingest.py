"""Legacy (Edge-era) PostgreSQL ingest: ``ingest_observations``, ``_store_*``, latest upsert, connection liveness, PG formulas. Moved verbatim from ``factorix.modules.telemetry`` (R2-E B5, move-only)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.formula import FormulaError, bind, evaluate, output_quality, parse_expression
from factorix.domain.health import NO_DATA_PREFIX, effective_connection_health
from factorix.domain.observation import EDGE_CLOCK_FUTURE, Observation, ObservationError, Quality, resolve_times
from factorix.domain.quality import Origin
from factorix.modules.common import (
    as_uuid,
    audit,
    create_partitions_for,
    execute,
    fetch_all,
    fetch_one,
    jsonb,
    queue_stream_event,
    utcnow,
)
from factorix.platform.errors import AppError

from factorix.application.live.latest_api import (
    RejectionThrottle,
    connection_health_payload,
    latest_stream_payload,
    logger,
    select_binding,
)
from factorix.application.history.legacy_api import _INGEST_RATE


def _value_json(value: Any) -> str | None:
    return jsonb({"v": value})


_rejections = RejectionThrottle()


def _truncate_events(session: AsyncSession, mark: int) -> None:
    events = session.info.get("fx_events")
    if events is not None and len(events) > mark:
        del events[mark:]


class _BatchContext:
    """Per-batch lookups so ingest does not repeat the same queries for every sample."""

    def __init__(self) -> None:
        self.edge_enrolled = False
        self.releases: set[int] = set()
        self.bindings: dict[UUID, list[dict[str, Any]]] = {}
        self.formula_inputs: set[UUID] = set()


def _item_signal_ids(items: list[dict[str, Any]]) -> list[UUID]:
    ids: set[UUID] = set()
    for item in items:
        try:
            ids.add(UUID(str(item.get("signal_id"))))
        except (TypeError, ValueError):
            continue
    return list(ids)


def _item_revisions(items: list[dict[str, Any]]) -> list[int]:
    revisions: set[int] = set()
    for item in items:
        try:
            revisions.add(int(item.get("config_revision") or 1))
        except (TypeError, ValueError):
            continue
    return list(revisions)


async def _batch_context(session: AsyncSession, tenant_id: UUID, edge_id: UUID, items: list[dict[str, Any]]) -> _BatchContext:
    context = _BatchContext()
    edge = await fetch_one(
        session,
        "SELECT enrollment_status FROM edge_nodes WHERE id = :id AND tenant_id = :tenant_id",
        {"id": edge_id, "tenant_id": tenant_id},
    )
    context.edge_enrolled = edge is not None and edge["enrollment_status"] == "ENROLLED"
    if not context.edge_enrolled:
        return context
    revisions = _item_revisions(items)
    if revisions:
        rows = await fetch_all(
            session,
            """
            SELECT revision FROM configuration_releases
            WHERE tenant_id = :tenant_id AND edge_id = :edge_id AND revision = ANY(:revisions) AND status <> 'FAILED'
            """,
            {"tenant_id": tenant_id, "edge_id": edge_id, "revisions": revisions},
        )
        context.releases = {int(row["revision"]) for row in rows}
    signal_ids = _item_signal_ids(items)
    if not signal_ids:
        return context
    rows = await fetch_all(
        session,
        """
        SELECT b.signal_id, b.valid_from, b.valid_to, s.resource_id, s.expected_interval_ms, r.site_id,
               c.id AS connection_id, f.id AS source_field_id,
               COALESCE((f.address_json->>'nullable') = 'true', FALSE) AS nullable
        FROM signal_bindings b
        JOIN signal_definitions s ON s.id = b.signal_id
        JOIN resources r ON r.id = s.resource_id
        JOIN source_fields f ON f.id = b.source_field_id
        JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        JOIN connections c ON c.id = j.connection_id
        WHERE s.tenant_id = :tenant_id AND c.tenant_id = :tenant_id
          AND c.edge_id = :edge_id AND b.enabled = TRUE
          AND s.id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "edge_id": edge_id, "ids": signal_ids},
    )
    for row in rows:
        context.bindings.setdefault(as_uuid(row["signal_id"]), []).append(row)
    deps = await fetch_all(
        session,
        """
        SELECT DISTINCT d.dependency_signal_id
        FROM formula_dependencies d
        JOIN formula_definitions f ON f.id = d.formula_id
        JOIN signal_definitions s ON s.id = f.signal_id
        WHERE f.status = 'PUBLISHED' AND s.tenant_id = :tenant_id AND d.dependency_signal_id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": signal_ids},
    )
    context.formula_inputs = {as_uuid(row["dependency_signal_id"]) for row in deps}
    return context


def _owned_binding(context: _BatchContext, observation: Observation, item: dict[str, Any]) -> dict[str, Any] | None:
    """Ownership: enrolled edge, a released revision, and a binding valid at the acquisition time.

    Validity is checked against received_time. The source clock (source_time) is metadata and
    never decides whether a sample is accepted.
    """
    if not context.edge_enrolled or observation.config_revision not in context.releases:
        return None
    row = select_binding(context.bindings.get(observation.signal_id, []), observation.received_time)
    if row is None:
        return None
    if observation.resource_id != as_uuid(row["resource_id"]):
        return None
    claimed_connection = item.get("connection_id")
    if claimed_connection and as_uuid(str(claimed_connection)) != as_uuid(row["connection_id"]):
        return None
    claimed_field = (item.get("provenance") or {}).get("field_id") if isinstance(item.get("provenance"), dict) else None
    if claimed_field and as_uuid(str(claimed_field)) != as_uuid(row["source_field_id"]):
        return None
    claimed_site = item.get("site_id")
    if claimed_site and row.get("site_id") and as_uuid(str(claimed_site)) != as_uuid(row["site_id"]):
        return None
    return row


async def ingest_observations(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    edge_id: UUID,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """Validate, authorise and store one edge batch.

    Accepted samples are written with one statement per table for the whole batch (dedup keys,
    observations, newest-per-signal latest upsert). Per-row statements cost about 5 round trips
    and several milliseconds of Python per sample, which capped ingest at ~135 samples/s while a
    6-machine site produces ~320/s (R2-SG-01): the edge backlog grew without bound and every
    latest value arrived 2-5 s late. If the batch statement fails, the batch is stored row by row
    so one bad sample is quarantined alone (same isolation as before).
    """
    if len(items) > 1000:
        raise AppError(422, "BATCH", "Observation batch exceeds 1000 records.")
    now = utcnow()
    results: list[dict[str, str] | None] = []
    context = await _batch_context(session, tenant_id, edge_id, items)
    checked_partitions: set[str] = set()
    live_connections: set[UUID] = set()
    accepted: list[tuple[int, Observation, dict[str, Any]]] = []
    for item in items:
        event_uid = str(item.get("event_uid", ""))[:256]
        try:
            observation = _to_observation(item, tenant_id, edge_id, now=now)
            observation.validate()
        except (ObservationError, AppError, ValueError, TypeError, KeyError) as exc:
            await _quarantine(
                session,
                tenant_id,
                edge_id,
                event_uid,
                str(exc) or type(exc).__name__,
                payload={"data_type": item.get("data_type"), "quality": item.get("quality")},
            )
            results.append({"event_uid": event_uid, "status": "quarantined"})
            continue
        if observation.origin == Origin.TEST:
            results.append({"event_uid": observation.event_uid, "status": "rejected_test"})
            continue
        if observation.origin == Origin.CALCULATED:
            await _quarantine(session, tenant_id, edge_id, event_uid, "CALCULATED observations are produced by Center.")
            results.append({"event_uid": event_uid, "status": "quarantined"})
            continue
        owned = _owned_binding(context, observation, item)
        if owned is None:
            await _quarantine(session, tenant_id, edge_id, observation.event_uid, "Signal is not bound to this enrolled edge and revision.")
            if _rejections.should_audit((str(tenant_id), str(edge_id), str(observation.signal_id)), now):
                await audit(
                    session,
                    tenant_id=tenant_id,
                    event_type="INGEST_REJECTED",
                    actor_id=None,
                    entity_type="edge",
                    entity_id=edge_id,
                    before=None,
                    after={
                        "event_uid": observation.event_uid,
                        "signal_id": str(observation.signal_id),
                        "config_revision": observation.config_revision,
                        "note": "First rejection for this signal in the last hour; later ones are only quarantined.",
                    },
                    correlation_id="",
                )
            results.append({"event_uid": observation.event_uid, "status": "quarantined"})
            continue
        month_key = f"{observation.event_time.year}_{observation.event_time.month:02d}"
        if month_key not in checked_partitions:
            await create_partitions_for(session, observation.event_time)
            checked_partitions.add(month_key)
        accepted.append((len(results), observation, owned))
        results.append(None)

    if accepted:
        events_mark = len(session.info.get("fx_events", []))
        try:
            async with session.begin_nested():
                outcome = await _store_batch(session, tenant_id, edge_id, accepted, context, now)
        except (SQLAlchemyError, ValueError, TypeError) as exc:
            _truncate_events(session, events_mark)
            logger.warning("Batch store of %d observations failed; storing them one by one.", len(accepted), exc_info=exc)
            outcome = await _store_rows(session, tenant_id, edge_id, accepted, context, now)
        uid_at = {index: observation.event_uid for index, observation, _owned in accepted}
        for index, status in outcome.statuses.items():
            results[index] = {"event_uid": uid_at[index], "status": status}
        live_connections |= outcome.live_connections

    # Data models are sampled by their own scheduler (models_engine), not per ingest batch, so
    # ingest never waits for model composition. Connection liveness stays at the end of the
    # transaction: its row locks on `connections` are shared with the heartbeat.
    if live_connections:
        await _mark_connections_live(session, tenant_id, edge_id, live_connections, now)
    stored = [row for row in results if row is not None]
    committed = sum(1 for row in stored if row.get("status") == "committed")
    if committed:
        # Display metric only (Overview "ingestion rate"); the edge-sync handler commits right after.
        _INGEST_RATE.add(str(tenant_id), committed)
    return {"results": stored}


class _StoreOutcome:
    def __init__(self) -> None:
        self.statuses: dict[int, str] = {}
        self.live_connections: set[UUID] = set()
        self.touched: set[UUID] = set()

    def committed(self, index: int, observation: Observation, owned: dict[str, Any]) -> None:
        self.statuses[index] = "committed"
        if observation.quality in {Quality.GOOD, Quality.UNCERTAIN}:
            self.live_connections.add(as_uuid(owned["connection_id"]))


def newest_per_signal(rows: list[tuple[UUID, Observation, dict[str, Any]]]) -> dict[UUID, tuple[UUID, Observation, dict[str, Any]]]:
    """The row that may replace latest for each signal: highest (received_time, observation_id).

    Same ordering as the latest upsert (and ``domain.observation.should_replace_latest``); one row
    per signal is required because ON CONFLICT DO UPDATE cannot touch a row twice in a statement.
    """
    newest: dict[UUID, tuple[UUID, Observation, dict[str, Any]]] = {}
    for row in rows:
        observation_id, observation, _owned = row
        current = newest.get(observation.signal_id)
        if current is None or (observation.received_time, str(observation_id)) > (current[1].received_time, str(current[0])):
            newest[observation.signal_id] = row
    return newest


_BULK_DEDUP = """
INSERT INTO ingest_dedup (tenant_id, edge_id, event_uid, first_seen_at)
SELECT CAST(:tenant_id AS uuid), CAST(:edge_id AS uuid), u.event_uid, CAST(:now AS timestamptz)
FROM unnest(CAST(:uids AS text[])) AS u(event_uid)
ON CONFLICT DO NOTHING
RETURNING event_uid
"""

_BULK_OBSERVATIONS = """
INSERT INTO observations (
    id, tenant_id, site_id, resource_id, signal_id, edge_id, connection_id, event_uid,
    event_time, received_time, source_time, value_type, value_json, unit, quality, origin,
    config_revision, provenance_json
)
SELECT t.id, CAST(:tenant_id AS uuid), t.site_id, t.resource_id, t.signal_id, CAST(:edge_id AS uuid),
       t.connection_id, t.event_uid, t.event_time, t.received_time, t.source_time, t.value_type,
       CAST(t.value_json AS jsonb), t.unit, t.quality, t.origin, t.config_revision, CAST(t.provenance AS jsonb)
FROM unnest(
    CAST(:ids AS uuid[]), CAST(:site_ids AS uuid[]), CAST(:resource_ids AS uuid[]), CAST(:signal_ids AS uuid[]),
    CAST(:connection_ids AS uuid[]), CAST(:event_uids AS text[]), CAST(:event_times AS timestamptz[]),
    CAST(:received_times AS timestamptz[]), CAST(:source_times AS timestamptz[]), CAST(:value_types AS text[]),
    CAST(:value_jsons AS text[]), CAST(:units AS text[]), CAST(:qualities AS text[]), CAST(:origins AS text[]),
    CAST(:revisions AS bigint[]), CAST(:provenances AS text[])
) AS t(id, site_id, resource_id, signal_id, connection_id, event_uid, event_time, received_time, source_time,
       value_type, value_json, unit, quality, origin, config_revision, provenance)
"""

_BULK_LATEST = """
INSERT INTO latest_signal_state (
    tenant_id, signal_id, resource_id, observation_id, value_type, value_json, unit, quality,
    event_time, received_time, source_time, config_revision, origin, last_good_value_json,
    last_good_event_time, updated_at
)
SELECT CAST(:tenant_id AS uuid), t.signal_id, t.resource_id, t.observation_id, t.value_type, CAST(t.value_json AS jsonb),
       t.unit, t.quality, t.event_time, t.received_time, t.source_time, t.config_revision, t.origin,
       CAST(t.good AS jsonb), t.good_time, CAST(:now AS timestamptz)
FROM unnest(
    CAST(:signal_ids AS uuid[]), CAST(:resource_ids AS uuid[]), CAST(:observation_ids AS uuid[]), CAST(:value_types AS text[]),
    CAST(:value_jsons AS text[]), CAST(:units AS text[]), CAST(:qualities AS text[]), CAST(:event_times AS timestamptz[]),
    CAST(:received_times AS timestamptz[]), CAST(:source_times AS timestamptz[]), CAST(:revisions AS bigint[]),
    CAST(:origins AS text[]), CAST(:goods AS text[]), CAST(:good_times AS timestamptz[])
) AS t(signal_id, resource_id, observation_id, value_type, value_json, unit, quality, event_time, received_time,
       source_time, config_revision, origin, good, good_time)
ON CONFLICT (tenant_id, signal_id) DO UPDATE SET
    resource_id = EXCLUDED.resource_id,
    observation_id = EXCLUDED.observation_id,
    value_type = EXCLUDED.value_type,
    value_json = EXCLUDED.value_json,
    unit = EXCLUDED.unit,
    quality = EXCLUDED.quality,
    event_time = EXCLUDED.event_time,
    received_time = EXCLUDED.received_time,
    source_time = EXCLUDED.source_time,
    config_revision = EXCLUDED.config_revision,
    origin = EXCLUDED.origin,
    last_good_value_json = CASE
        WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.value_json
        ELSE latest_signal_state.last_good_value_json
    END,
    last_good_event_time = CASE
        WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.event_time
        ELSE latest_signal_state.last_good_event_time
    END,
    updated_at = EXCLUDED.updated_at
WHERE (EXCLUDED.received_time, EXCLUDED.observation_id)
    > (latest_signal_state.received_time, latest_signal_state.observation_id)
RETURNING signal_id
"""


async def _store_batch(
    session: AsyncSession,
    tenant_id: UUID,
    edge_id: UUID,
    accepted: list[tuple[int, Observation, dict[str, Any]]],
    context: _BatchContext,
    now: datetime,
) -> _StoreOutcome:
    """Store every accepted sample of the batch with one statement per table."""
    outcome = _StoreOutcome()
    first_of_uid: dict[str, int] = {}
    for index, observation, _owned in accepted:
        first_of_uid.setdefault(observation.event_uid, index)
    inserted_rows = await fetch_all(
        session,
        _BULK_DEDUP,
        {"tenant_id": tenant_id, "edge_id": edge_id, "now": now, "uids": list(first_of_uid)},
    )
    fresh = {str(row["event_uid"]) for row in inserted_rows}
    new_rows: list[tuple[UUID, Observation, dict[str, Any]]] = []
    for index, observation, owned in accepted:
        if observation.event_uid in fresh and first_of_uid[observation.event_uid] == index:
            new_rows.append((uuid4(), observation, owned))
            outcome.committed(index, observation, owned)
        else:
            outcome.statuses[index] = "duplicate"
    if not new_rows:
        return outcome

    await execute(
        session,
        _BULK_OBSERVATIONS,
        {
            "tenant_id": tenant_id,
            "edge_id": edge_id,
            "ids": [oid for oid, _o, _w in new_rows],
            "site_ids": [as_uuid(w["site_id"]) if w.get("site_id") else None for _oid, _o, w in new_rows],
            "resource_ids": [as_uuid(w["resource_id"]) for _oid, _o, w in new_rows],
            "signal_ids": [o.signal_id for _oid, o, _w in new_rows],
            "connection_ids": [as_uuid(w["connection_id"]) for _oid, _o, w in new_rows],
            "event_uids": [o.event_uid for _oid, o, _w in new_rows],
            "event_times": [o.event_time for _oid, o, _w in new_rows],
            "received_times": [o.received_time for _oid, o, _w in new_rows],
            "source_times": [o.source_time for _oid, o, _w in new_rows],
            "value_types": [o.data_type for _oid, o, _w in new_rows],
            "value_jsons": [_value_json(o.value) for _oid, o, _w in new_rows],
            "units": [o.unit for _oid, o, _w in new_rows],
            "qualities": [o.quality.value for _oid, o, _w in new_rows],
            "origins": [o.origin.value for _oid, o, _w in new_rows],
            "revisions": [int(o.config_revision) for _oid, o, _w in new_rows],
            "provenances": [jsonb(o.provenance or {}) for _oid, o, _w in new_rows],
        },
    )

    # Sorted by signal id: every writer of latest_signal_state locks its rows in the same order, so
    # two concurrent ingest transactions cannot deadlock on it (seen 2026-11-06 07:26).
    candidates = sorted(newest_per_signal(new_rows).values(), key=lambda row: str(row[1].signal_id))
    goods = [(o.quality.value == "GOOD" and o.value is not None) for _oid, o, _w in candidates]
    replaced_rows = await fetch_all(
        session,
        _BULK_LATEST,
        {
            "tenant_id": tenant_id,
            "now": now,
            "signal_ids": [o.signal_id for _oid, o, _w in candidates],
            "resource_ids": [as_uuid(w["resource_id"]) for _oid, _o, w in candidates],
            "observation_ids": [oid for oid, _o, _w in candidates],
            "value_types": [o.data_type for _oid, o, _w in candidates],
            "value_jsons": [_value_json(o.value) for _oid, o, _w in candidates],
            "units": [o.unit for _oid, o, _w in candidates],
            "qualities": [o.quality.value for _oid, o, _w in candidates],
            "event_times": [o.event_time for _oid, o, _w in candidates],
            "received_times": [o.received_time for _oid, o, _w in candidates],
            "source_times": [o.source_time for _oid, o, _w in candidates],
            "revisions": [int(o.config_revision) for _oid, o, _w in candidates],
            "origins": [o.origin.value for _oid, o, _w in candidates],
            "goods": [_value_json(o.value) if good else None for (_oid, o, _w), good in zip(candidates, goods)],
            "good_times": [o.event_time if good else None for (_oid, o, _w), good in zip(candidates, goods)],
        },
    )
    replaced = {as_uuid(row["signal_id"]) for row in replaced_rows}
    for _oid, observation, owned in candidates:
        if observation.signal_id not in replaced:
            continue
        outcome.touched.add(observation.signal_id)
        reason = (observation.provenance or {}).get("reason")
        queue_stream_event(
            session,
            "latest",
            tenant_id,
            latest_stream_payload(
                signal_id=observation.signal_id,
                value=observation.value,
                quality=observation.quality.value,
                reason=str(reason) if reason else None,
                received_time=observation.received_time,
                source_time=observation.source_time,
                expected_interval_ms=owned.get("expected_interval_ms"),
                null_allowed=bool(owned.get("nullable")),
                now=now,
            ),
            signal_id=observation.signal_id,
        )
    for _oid, observation, _owned in new_rows:
        if observation.signal_id in context.formula_inputs:
            outputs: set[UUID] = set()
            await _run_formulas(session, tenant_id, observation.signal_id, observation.event_time, observation.received_time, depth=0, outputs=outputs)
            outcome.touched |= outputs
    return outcome


async def _store_rows(
    session: AsyncSession,
    tenant_id: UUID,
    edge_id: UUID,
    accepted: list[tuple[int, Observation, dict[str, Any]]],
    context: _BatchContext,
    now: datetime,
) -> _StoreOutcome:
    """Row-by-row fallback: each sample in its own savepoint, a failing one is quarantined alone."""
    outcome = _StoreOutcome()
    for index, observation, owned in accepted:
        events_mark = len(session.info.get("fx_events", []))
        try:
            async with session.begin_nested():
                status, replaced, formula_outputs = await _store_observation(session, tenant_id, edge_id, observation, owned, context, now)
        except (SQLAlchemyError, ValueError, TypeError) as exc:
            _truncate_events(session, events_mark)
            logger.warning(
                "Observation %s for signal %s could not be stored; it is quarantined.",
                observation.event_uid,
                observation.signal_id,
                exc_info=exc,
            )
            await _quarantine(session, tenant_id, edge_id, observation.event_uid, f"STORE_FAILED: {type(exc).__name__}")
            outcome.statuses[index] = "quarantined"
            continue
        if status != "committed":
            outcome.statuses[index] = status
            continue
        outcome.committed(index, observation, owned)
        if replaced:
            outcome.touched.add(observation.signal_id)
        outcome.touched |= formula_outputs
    return outcome


async def _store_observation(
    session: AsyncSession,
    tenant_id: UUID,
    edge_id: UUID,
    observation: Observation,
    owned: dict[str, Any],
    context: _BatchContext,
    now: datetime,
) -> tuple[str, bool, set[UUID]]:
    inserted = await fetch_one(
        session,
        """
        INSERT INTO ingest_dedup (tenant_id, edge_id, event_uid, first_seen_at)
        VALUES (:tenant_id, :edge_id, :event_uid, :now)
        ON CONFLICT DO NOTHING
        RETURNING event_uid
        """,
        {"tenant_id": tenant_id, "edge_id": edge_id, "event_uid": observation.event_uid, "now": now},
    )
    if inserted is None:
        return "duplicate", False, set()
    observation_id = uuid4()
    quality = observation.quality.value
    await execute(
        session,
        """
        INSERT INTO observations (
            id, tenant_id, site_id, resource_id, signal_id, edge_id, connection_id, event_uid,
            event_time, received_time, source_time, value_type, value_json, unit, quality, origin,
            config_revision, provenance_json
        ) VALUES (
            :id, :tenant_id, :site_id, :resource_id, :signal_id, :edge_id, :connection_id, :event_uid,
            :event_time, :received_time, :source_time, :value_type, CAST(:value_json AS jsonb), :unit,
            :quality, :origin, :config_revision, CAST(:provenance AS jsonb)
        )
        """,
        {
            "id": observation_id,
            "tenant_id": tenant_id,
            "site_id": owned["site_id"],
            "resource_id": owned["resource_id"],
            "signal_id": observation.signal_id,
            "edge_id": edge_id,
            "connection_id": owned["connection_id"],
            "event_uid": observation.event_uid,
            "event_time": observation.event_time,
            "received_time": observation.received_time,
            "source_time": observation.source_time,
            "value_type": observation.data_type,
            "value_json": _value_json(observation.value),
            "unit": observation.unit,
            "quality": quality,
            "origin": observation.origin.value,
            "config_revision": observation.config_revision,
            "provenance": jsonb(observation.provenance or {}),
        },
    )
    replaced = await _upsert_latest(
        session,
        tenant_id=tenant_id,
        observation_id=observation_id,
        observation=observation,
        quality=quality,
        resource_id=as_uuid(owned["resource_id"]),
    )
    if replaced:
        reason = (observation.provenance or {}).get("reason")
        queue_stream_event(
            session,
            "latest",
            tenant_id,
            latest_stream_payload(
                signal_id=observation.signal_id,
                value=observation.value,
                quality=quality,
                reason=str(reason) if reason else None,
                received_time=observation.received_time,
                source_time=observation.source_time,
                expected_interval_ms=owned.get("expected_interval_ms"),
                null_allowed=bool(owned.get("nullable")),
                now=now,
            ),
            signal_id=observation.signal_id,
        )
    outputs: set[UUID] = set()
    if observation.signal_id in context.formula_inputs:
        await _run_formulas(session, tenant_id, observation.signal_id, observation.event_time, observation.received_time, depth=0, outputs=outputs)
    return "committed", replaced, outputs


async def _mark_connections_live(
    session: AsyncSession,
    tenant_id: UUID,
    edge_id: UUID | None,
    connection_ids: set[UUID],
    now: datetime,
) -> None:
    """A decoded sample (GOOD or UNCERTAIN) is evidence that the connection works.

    last_success_at always moves forward. Health becomes HEALTHY only from a neutral state or from
    a Center-inferred "no samples" degradation; an edge-reported error stays until the edge
    reports the connection UP again (no flapping between data and heartbeat).
    """
    rows = await fetch_all(
        session,
        """
        WITH prev AS (
            SELECT id, health AS old_health
            FROM connections
            WHERE id = ANY(:ids)
              AND tenant_id = :tenant_id
              AND (CAST(:edge_id AS uuid) IS NULL OR edge_id = CAST(:edge_id AS uuid))
              AND status = 'ACTIVE'
            ORDER BY id
            FOR UPDATE
        )
        UPDATE connections c
        SET last_success_at = GREATEST(COALESCE(c.last_success_at, :now), :now),
            health = CASE
                WHEN c.health = 'UNKNOWN' THEN 'HEALTHY'
                WHEN c.health = 'DEGRADED' AND c.last_error LIKE :no_data THEN 'HEALTHY'
                ELSE c.health
            END,
            last_error = CASE WHEN c.last_error LIKE :no_data THEN NULL ELSE c.last_error END
        FROM prev
        WHERE c.id = prev.id
        RETURNING c.id, c.health, c.last_error, c.last_success_at, prev.old_health
        """,
        {"ids": list(connection_ids), "tenant_id": tenant_id, "edge_id": edge_id, "now": now, "no_data": f"{NO_DATA_PREFIX}%"},
    )
    for row in rows:
        if row["health"] == row["old_health"]:
            continue
        if row["old_health"] == "DEGRADED":
            await audit(
                session,
                tenant_id=tenant_id,
                event_type="CONNECTION_RECOVERED",
                actor_id=None,
                entity_type="connection",
                entity_id=as_uuid(row["id"]),
                before={"health": row["old_health"]},
                after={"health": row["health"]},
                correlation_id="ingest",
            )
        queue_stream_event(
            session,
            "health",
            tenant_id,
            connection_health_payload(
                connection_id=row["id"],
                health=row["health"],
                effective_health=effective_connection_health(status="ACTIVE", health=row["health"], active_bindings=1, edge_health="ONLINE"),
                last_error=row.get("last_error"),
                last_success_at=row.get("last_success_at"),
            ),
        )


async def _quarantine(
    session: AsyncSession,
    tenant_id: UUID,
    edge_id: UUID,
    event_uid: str,
    reason: str,
    *,
    payload: dict[str, Any] | None = None,
) -> None:
    await execute(
        session,
        """
        INSERT INTO observation_quarantine (id, tenant_id, edge_id, event_uid, reason, received_time, payload_redacted)
        VALUES (:id, :tenant_id, :edge_id, :event_uid, :reason, :now, CAST(:payload AS jsonb))
        """,
        {
            "id": uuid4(),
            "tenant_id": tenant_id,
            "edge_id": edge_id,
            "event_uid": event_uid or "invalid",
            "reason": reason[:300],
            "now": utcnow(),
            "payload": jsonb(payload or {}),
        },
    )


def _to_observation(item: dict[str, Any], tenant_id: UUID, edge_id: UUID, *, now: datetime | None = None) -> Observation:
    def parse_time(value: Any) -> datetime | None:
        if value is None or value == "":
            return None
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ObservationError("TIMEZONE", "timestamps must be timezone-aware")
        return parsed.astimezone(timezone.utc)

    provenance = dict(item.get("provenance") or item.get("source") or {})
    item_reason = item.get("reason") or provenance.get("reason")
    source_time = None
    source_raw = item.get("source_time") or item.get("source_timestamp")
    if source_raw is not None:
        try:
            source_time = parse_time(source_raw)
        except (ValueError, ObservationError):
            source_time = None
            item_reason = item_reason or "SOURCE_TIME_INVALID"

    quality_in = str(item.get("quality") or "GOOD").upper()
    decision = resolve_times(
        received_time=parse_time(item.get("received_time") or item.get("received_timestamp")),
        source_time=source_time,
        quality=quality_in,
        now=now,
    )
    if decision.reason == EDGE_CLOCK_FUTURE:
        provenance["edge_received_time"] = str(item.get("received_time") or item.get("received_timestamp"))
    if decision.reason and decision.quality != quality_in:
        provenance["reason"] = decision.reason
    elif item_reason:
        provenance["reason"] = str(item_reason)[:64]
    elif decision.reason:
        provenance["reason"] = decision.reason

    return Observation(
        event_uid=str(item["event_uid"]),
        tenant_id=tenant_id,
        resource_id=as_uuid(str(item["resource_id"])),
        signal_id=as_uuid(str(item["signal_id"])),
        event_time=decision.event_time,
        received_time=decision.received_time,
        value=item.get("value", None),
        data_type=str(item.get("data_type") or "float64"),
        unit=item.get("unit"),
        quality=Quality(decision.quality),
        origin=Origin(str(item.get("origin") or "LIVE")),
        config_revision=int(item.get("config_revision") or 1),
        site_id=as_uuid(str(item["site_id"])) if item.get("site_id") else None,
        edge_id=edge_id,
        connection_id=as_uuid(str(item["connection_id"])) if item.get("connection_id") else None,
        source_time=decision.source_time,
        provenance=provenance,
    )


async def _upsert_latest(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    observation_id: UUID,
    observation: Observation,
    quality: str,
    resource_id: UUID,
) -> bool:
    """Insert or replace latest only when (received_time, observation_id) is strictly newer.

    Same ordering as ``factorix.domain.observation.should_replace_latest``. The source clock is
    never part of the ordering, so a frozen or skewed source_timestamp cannot freeze latest.
    """
    good_value = _value_json(observation.value) if (quality == "GOOD" and observation.value is not None) else None
    row = await fetch_one(
        session,
        """
        INSERT INTO latest_signal_state (
            tenant_id, signal_id, resource_id, observation_id, value_type, value_json, unit, quality,
            event_time, received_time, source_time, config_revision, origin, last_good_value_json,
            last_good_event_time, updated_at
        ) VALUES (
            :tenant_id, :signal_id, :resource_id, :observation_id, :value_type, CAST(:value_json AS jsonb),
            :unit, :quality, :event_time, :received_time, :source_time, :config_revision, :origin,
            CAST(:good AS jsonb), CAST(:good_time AS timestamptz), :now
        )
        ON CONFLICT (tenant_id, signal_id) DO UPDATE SET
            resource_id = EXCLUDED.resource_id,
            observation_id = EXCLUDED.observation_id,
            value_type = EXCLUDED.value_type,
            value_json = EXCLUDED.value_json,
            unit = EXCLUDED.unit,
            quality = EXCLUDED.quality,
            event_time = EXCLUDED.event_time,
            received_time = EXCLUDED.received_time,
            source_time = EXCLUDED.source_time,
            config_revision = EXCLUDED.config_revision,
            origin = EXCLUDED.origin,
            last_good_value_json = CASE
                WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.value_json
                ELSE latest_signal_state.last_good_value_json
            END,
            last_good_event_time = CASE
                WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.event_time
                ELSE latest_signal_state.last_good_event_time
            END,
            updated_at = EXCLUDED.updated_at
        WHERE (EXCLUDED.received_time, EXCLUDED.observation_id)
            > (latest_signal_state.received_time, latest_signal_state.observation_id)
        RETURNING signal_id
        """,
        {
            "tenant_id": tenant_id,
            "signal_id": observation.signal_id,
            "resource_id": resource_id,
            "observation_id": observation_id,
            "value_type": observation.data_type,
            "value_json": _value_json(observation.value),
            "unit": observation.unit,
            "quality": quality,
            "event_time": observation.event_time,
            "received_time": observation.received_time,
            "source_time": observation.source_time,
            "config_revision": observation.config_revision,
            "origin": observation.origin.value,
            "good": good_value,
            "good_time": observation.event_time if (quality == "GOOD" and observation.value is not None) else None,
            "now": utcnow(),
        },
    )
    return row is not None


async def _run_formulas(
    session: AsyncSession,
    tenant_id: UUID,
    signal_id: UUID,
    event_time: datetime,
    received_time: datetime,
    *,
    depth: int,
    outputs: set[UUID] | None = None,
) -> None:
    """Recompute published formulas that depend on ``signal_id``; changed outputs are added to ``outputs``."""
    if depth > 4:
        return
    formulas = await fetch_all(
        session,
        """
        SELECT DISTINCT f.id, f.signal_id AS output_id, f.expression_source, f.revision,
               s.resource_id, s.data_type, s.unit, s.expected_interval_ms, r.site_id
        FROM formula_dependencies d
        JOIN formula_definitions f ON f.id = d.formula_id
        JOIN signal_definitions s ON s.id = f.signal_id
        JOIN resources r ON r.id = s.resource_id
        WHERE d.dependency_signal_id = :signal_id AND f.status = 'PUBLISHED' AND s.tenant_id = :tenant_id
        """,
        {"signal_id": signal_id, "tenant_id": tenant_id},
    )
    for formula in formulas:
        aliases = await fetch_all(
            session,
            "SELECT variable_alias, dependency_signal_id FROM formula_dependencies WHERE formula_id = :id",
            {"id": formula["id"]},
        )
        values: dict[str, Any] = {}
        qualities: list[str] = []
        alias_ids: dict[str, UUID] = {}
        ready = True
        for alias in aliases:
            latest = await fetch_one(
                session,
                "SELECT value_json, quality FROM latest_signal_state WHERE tenant_id = :tenant_id AND signal_id = :signal_id",
                {"tenant_id": tenant_id, "signal_id": alias["dependency_signal_id"]},
            )
            if latest is None:
                ready = False
                break
            payload = latest["value_json"] or {}
            values[str(alias["variable_alias"])] = payload.get("v")
            qualities.append(str(latest["quality"]))
            alias_ids[str(alias["variable_alias"])] = as_uuid(alias["dependency_signal_id"])
        if not ready:
            continue
        try:
            program = bind(parse_expression(str(formula["expression_source"])), alias_ids)
            value = evaluate(program, values)
        except (FormulaError, ZeroDivisionError, OverflowError, ValueError):
            continue
        quality = output_quality(qualities, value)
        observation_id = uuid4()
        event_uid = f"calc:{formula['id']}:{formula['revision']}:{signal_id}"
        await create_partitions_for(session, event_time)
        await execute(
            session,
            """
            INSERT INTO observations (
                id, tenant_id, site_id, resource_id, signal_id, edge_id, connection_id, event_uid,
                event_time, received_time, source_time, value_type, value_json, unit, quality, origin,
                config_revision, provenance_json
            ) VALUES (
                :id, :tenant_id, :site_id, :resource_id, :signal_id, NULL, NULL, :event_uid,
                :event_time, :received_time, NULL, :value_type, CAST(:value_json AS jsonb), :unit,
                :quality, 'CALCULATED', :revision, CAST(:provenance AS jsonb)
            )
            """,
            {
                "id": observation_id,
                "tenant_id": tenant_id,
                "site_id": formula["site_id"],
                "resource_id": formula["resource_id"],
                "signal_id": formula["output_id"],
                "event_uid": event_uid[:256],
                "event_time": event_time,
                "received_time": received_time,
                "value_type": formula["data_type"],
                "value_json": _value_json(value),
                "unit": formula["unit"],
                "quality": quality,
                "revision": int(formula["revision"]),
                "provenance": jsonb({"formula_id": str(formula["id"]), "formula_revision": int(formula["revision"])}),
            },
        )
        synthetic = Observation(
            event_uid=event_uid[:256],
            tenant_id=tenant_id,
            resource_id=as_uuid(formula["resource_id"]),
            signal_id=as_uuid(formula["output_id"]),
            event_time=event_time,
            received_time=received_time,
            value=value,
            data_type=str(formula["data_type"]),
            unit=formula["unit"],
            quality=Quality(quality if quality in {"GOOD", "BAD", "UNCERTAIN"} else "UNCERTAIN"),
            origin=Origin.CALCULATED,
            config_revision=int(formula["revision"]),
            site_id=as_uuid(formula["site_id"]) if formula["site_id"] else None,
        )
        replaced = await _upsert_latest(
            session,
            tenant_id=tenant_id,
            observation_id=observation_id,
            observation=synthetic,
            quality=quality,
            resource_id=as_uuid(formula["resource_id"]),
        )
        if replaced:
            if outputs is not None:
                outputs.add(as_uuid(formula["output_id"]))
            queue_stream_event(
                session,
                "latest",
                tenant_id,
                latest_stream_payload(
                    signal_id=formula["output_id"],
                    value=value,
                    quality=quality,
                    reason=None,
                    received_time=received_time,
                    source_time=None,
                    expected_interval_ms=formula.get("expected_interval_ms"),
                ),
                signal_id=formula["output_id"],
            )
        await _run_formulas(session, tenant_id, as_uuid(formula["output_id"]), event_time, received_time, depth=depth + 1, outputs=outputs)
