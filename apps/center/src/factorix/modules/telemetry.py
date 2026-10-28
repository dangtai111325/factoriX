"""Historian ingest, queries, retention and dashboards."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.csv_safe import csv_row
from factorix.domain.formula import FormulaError, bind, evaluate, output_quality, parse_expression
from factorix.domain.observation import Observation, ObservationError, Quality, classify_clock
from factorix.domain.quality import Origin
from factorix.modules.common import as_uuid, audit, create_partitions_for, execute, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
from factorix.platform.after_commit import queue
from factorix.platform.errors import AppError

AGGREGATES = {"min", "max", "avg", "count", "sum"}
WIDGETS = {
    "kpi",
    "gauge",
    "timeseries",
    "machine_status",
    "energy",
    "latest_table",
    "resource_health",
    "condition",
}


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    site_id: str | None = None


class DashboardPatch(BaseModel):
    version: int
    name: str | None = None
    description: str | None = None
    draft: dict[str, Any] | None = None


class RetentionIn(BaseModel):
    scope_type: str = "TENANT"
    scope_id: str | None = None
    keep_days: int = Field(ge=1, le=3650)


def _value_json(value: Any) -> str | None:
    return jsonb({"v": value})


async def ingest_observations(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    edge_id: UUID,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    if len(items) > 1000:
        raise AppError(422, "BATCH", "Lô quan sát vượt quá 1000 bản ghi.")
    results: list[dict[str, str]] = []
    for item in items:
        event_uid = str(item.get("event_uid", ""))[:256]
        try:
            observation = _to_observation(item, tenant_id, edge_id)
            observation.validate()
        except (ObservationError, AppError, ValueError) as exc:
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
                    "reason": str(exc)[:300],
                    "now": utcnow(),
                    "payload": jsonb({"data_type": item.get("data_type"), "quality": item.get("quality")}),
                },
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
        owned = await _owned_binding(session, tenant_id, edge_id, observation, item)
        if owned is None:
            await _quarantine(session, tenant_id, edge_id, observation.event_uid, "Signal is not bound to this enrolled edge and revision.")
            await audit(
                session,
                tenant_id=tenant_id,
                event_type="INGEST_REJECTED",
                actor_id=None,
                entity_type="edge",
                entity_id=edge_id,
                before=None,
                after={"event_uid": observation.event_uid, "signal_id": str(observation.signal_id)},
                correlation_id="",
            )
            results.append({"event_uid": observation.event_uid, "status": "quarantined"})
            continue
        inserted = await fetch_one(
            session,
            """
            INSERT INTO ingest_dedup (tenant_id, edge_id, event_uid, first_seen_at)
            VALUES (:tenant_id, :edge_id, :event_uid, :now)
            ON CONFLICT DO NOTHING
            RETURNING event_uid
            """,
            {"tenant_id": tenant_id, "edge_id": edge_id, "event_uid": observation.event_uid, "now": utcnow()},
        )
        if inserted is None:
            results.append({"event_uid": observation.event_uid, "status": "duplicate"})
            continue
        await create_partitions_for(session, observation.event_time)
        observation_id = uuid4()
        clock = classify_clock(observation.event_time, observation.received_time)
        quality = clock.value if clock else observation.quality.value
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
        if quality == "GOOD":
            await execute(
                session,
                """
                UPDATE connections
                SET health = 'HEALTHY', last_success_at = :now, last_error = NULL, updated_at = :now
                WHERE id = :id AND tenant_id = :tenant_id AND edge_id = :edge_id
                """,
                {"now": utcnow(), "id": owned["connection_id"], "tenant_id": tenant_id, "edge_id": edge_id},
            )
        if replaced:
            queue(
                session,
                {
                    "kind": "latest",
                    "tenant_id": str(tenant_id),
                    "signal_id": str(observation.signal_id),
                    "payload": {"type": "latest", "signal_id": str(observation.signal_id), "value": observation.value, "quality": quality},
                },
            )
        await _run_formulas(session, tenant_id, observation.signal_id, observation.event_time, observation.received_time, depth=0)
        await _enqueue_outputs(session, tenant_id, observation.signal_id, observation.event_uid, observation.value, quality)
        results.append({"event_uid": observation.event_uid, "status": "committed"})
    return {"results": results}


async def _quarantine(session: AsyncSession, tenant_id: UUID, edge_id: UUID, event_uid: str, reason: str) -> None:
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
            "payload": jsonb({}),
        },
    )


async def _owned_binding(
    session: AsyncSession,
    tenant_id: UUID,
    edge_id: UUID,
    observation: Observation,
    item: dict[str, Any],
) -> dict[str, Any] | None:
    edge = await fetch_one(
        session,
        "SELECT enrollment_status FROM edge_nodes WHERE id = :id AND tenant_id = :tenant_id",
        {"id": edge_id, "tenant_id": tenant_id},
    )
    if edge is None or edge["enrollment_status"] != "ENROLLED":
        return None
    release = await fetch_one(
        session,
        """
        SELECT revision FROM configuration_releases
        WHERE tenant_id = :tenant_id AND edge_id = :edge_id AND revision = :revision AND status <> 'FAILED'
        """,
        {"tenant_id": tenant_id, "edge_id": edge_id, "revision": observation.config_revision},
    )
    if release is None:
        return None
    row = await fetch_one(
        session,
        """
        SELECT s.resource_id, r.site_id, c.id AS connection_id, f.id AS source_field_id
        FROM signal_bindings b
        JOIN signal_definitions s ON s.id = b.signal_id
        JOIN resources r ON r.id = s.resource_id
        JOIN source_fields f ON f.id = b.source_field_id
        JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        JOIN connections c ON c.id = j.connection_id
        WHERE s.tenant_id = :tenant_id AND c.tenant_id = :tenant_id
          AND s.id = :signal_id AND c.edge_id = :edge_id
          AND b.enabled = TRUE
          AND b.valid_from <= :event_time
          AND (b.valid_to IS NULL OR b.valid_to > :event_time)
        """,
        {
            "tenant_id": tenant_id,
            "signal_id": observation.signal_id,
            "edge_id": edge_id,
            "event_time": observation.event_time,
        },
    )
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
    if claimed_site and as_uuid(str(claimed_site)) != as_uuid(row["site_id"]):
        return None
    return row


def _to_observation(item: dict[str, Any], tenant_id: UUID, edge_id: UUID) -> Observation:
    def parse_time(value: str | None) -> datetime | None:
        if value is None:
            return None
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ObservationError("TIMEZONE", "timestamps must be timezone-aware")
        return parsed.astimezone(timezone.utc)

    event_time = parse_time(item.get("event_time") or item.get("source_timestamp"))
    received = parse_time(item.get("received_time") or item.get("received_timestamp")) or utcnow()
    if event_time is None:
        event_time = received
    return Observation(
        event_uid=str(item["event_uid"]),
        tenant_id=tenant_id,
        resource_id=as_uuid(str(item["resource_id"])),
        signal_id=as_uuid(str(item["signal_id"])),
        event_time=event_time,
        received_time=received,
        value=item.get("value", None),
        data_type=str(item.get("data_type") or "float64"),
        unit=item.get("unit"),
        quality=Quality(str(item.get("quality") or "GOOD")),
        origin=Origin(str(item.get("origin") or "LIVE")),
        config_revision=int(item.get("config_revision") or 1),
        site_id=as_uuid(str(item["site_id"])) if item.get("site_id") else None,
        edge_id=edge_id,
        connection_id=as_uuid(str(item["connection_id"])) if item.get("connection_id") else None,
        source_time=parse_time(item.get("source_timestamp") or item.get("source_time")),
        provenance=item.get("provenance") or item.get("source") or {},
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
    """Insert or replace latest only when the incoming ordering tuple is strictly newer."""
    good_value = _value_json(observation.value) if quality == "GOOD" else None
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
                WHEN EXCLUDED.quality = 'GOOD' THEN EXCLUDED.value_json
                ELSE latest_signal_state.last_good_value_json
            END,
            last_good_event_time = CASE
                WHEN EXCLUDED.quality = 'GOOD' THEN EXCLUDED.event_time
                ELSE latest_signal_state.last_good_event_time
            END,
            updated_at = EXCLUDED.updated_at
        WHERE (EXCLUDED.event_time, EXCLUDED.received_time, EXCLUDED.observation_id)
            > (latest_signal_state.event_time, latest_signal_state.received_time, latest_signal_state.observation_id)
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
            "good_time": observation.event_time if quality == "GOOD" else None,
            "now": utcnow(),
        },
    )
    return row is not None


async def latest_states(session: AsyncSession, tenant_id: UUID, signal_ids: list[UUID]) -> list[dict[str, Any]]:
    if not signal_ids:
        return []
    if len(signal_ids) > 200:
        raise AppError(422, "LIMIT", "Tối đa 200 tín hiệu mỗi lần đọc latest.")
    rows = await fetch_all(
        session,
        """
        SELECT l.*, s.key, s.display_name, s.expected_interval_ms
        FROM latest_signal_state l
        JOIN signal_definitions s ON s.id = l.signal_id
        WHERE l.tenant_id = :tenant_id AND l.signal_id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": signal_ids},
    )
    for row in rows:
        value_json = row.get("value_json")
        row["value"] = None if value_json is None else value_json.get("v")
        row["freshness"] = _freshness(row)
    return rows


def _freshness(row: dict[str, Any]) -> str:
    event_time = row.get("event_time")
    if not isinstance(event_time, datetime):
        return "UNKNOWN"
    interval = timedelta(milliseconds=int(row.get("expected_interval_ms") or 5000))
    if utcnow() - event_time > interval * 2:
        return "STALE"
    if row.get("quality") == "BAD":
        return "UNKNOWN"
    return "FRESH"


async def history(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    signal_id: UUID,
    start: datetime,
    end: datetime,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    if end <= start:
        raise AppError(422, "RANGE", "Khoảng thời gian không hợp lệ.")
    if end - start > timedelta(days=31):
        raise AppError(422, "RANGE", "Cửa sổ truy vấn tối đa 31 ngày. Hãy thu hẹp hoặc dùng aggregation.")
    limit = min(max(limit, 1), 2000)
    params: dict[str, Any] = {
        "tenant_id": tenant_id,
        "signal_id": signal_id,
        "start": start,
        "end": end,
        "limit": limit + 1,
    }
    cursor_sql = ""
    if cursor:
        moment_text, _, id_text = cursor.partition("|")
        params["cursor_time"] = datetime.fromisoformat(moment_text.replace("Z", "+00:00"))
        params["cursor_id"] = as_uuid(id_text)
        cursor_sql = "AND (event_time, id) > (:cursor_time, :cursor_id)"
    rows = await fetch_all(
        session,
        f"""
        SELECT id, event_uid, event_time, received_time, source_time, value_type, value_json, unit, quality, origin, config_revision
        FROM observations
        WHERE tenant_id = :tenant_id AND signal_id = :signal_id
          AND event_time >= :start AND event_time < :end
          {cursor_sql}
        ORDER BY event_time, id
        LIMIT :limit
        """,
        params,
    )
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = f"{last['event_time']}|{last['id']}"
        rows = rows[:limit]
    for row in rows:
        row["value"] = None if row["value_json"] is None else row["value_json"].get("v")
    return {"items": rows, "next_cursor": next_cursor, "downsampled": False}


async def aggregate(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    signal_ids: list[UUID],
    start: datetime,
    end: datetime,
    bucket_ms: int,
    fn: str,
) -> dict[str, Any]:
    if fn not in AGGREGATES:
        raise AppError(422, "AGGREGATE", "Hàm tổng hợp không được hỗ trợ.")
    if bucket_ms < 1000 or bucket_ms > 86_400_000:
        raise AppError(422, "BUCKET", "Bucket phải từ 1 giây đến 1 ngày.")
    if len(signal_ids) > 20:
        raise AppError(422, "LIMIT", "Tối đa 20 tín hiệu mỗi truy vấn tổng hợp.")
    sql_fn = {"min": "min", "max": "max", "avg": "avg", "sum": "sum", "count": "count"}[fn]
    value_expr = "count(*)" if fn == "count" else f"{sql_fn}((value_json->>'v')::double precision)"
    rows = await fetch_all(
        session,
        f"""
        SELECT signal_id,
               to_timestamp(floor(extract(epoch FROM event_time) * 1000 / :bucket) * :bucket / 1000.0) AS bucket,
               {value_expr} AS value,
               count(*) FILTER (WHERE quality = 'GOOD') AS good_count,
               count(*) AS sample_count
        FROM observations
        WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids)
          AND event_time >= :start AND event_time < :end
          AND value_type IN ('float64', 'int64')
          AND quality = 'GOOD'
          AND jsonb_typeof(value_json->'v') = 'number'
        GROUP BY signal_id, bucket
        ORDER BY signal_id, bucket
        """,
        {"tenant_id": tenant_id, "ids": signal_ids, "start": start, "end": end, "bucket": bucket_ms},
    )
    return {"fn": fn, "bucket_ms": bucket_ms, "buckets": rows, "empty_buckets": "omitted", "quality_policy": "GOOD_ONLY"}


async def storage_overview(session: AsyncSession, tenant_id: UUID) -> dict[str, Any]:
    totals = await fetch_one(
        session,
        """
        SELECT count(*) AS observations,
               min(event_time) AS oldest,
               max(event_time) AS newest
        FROM observations WHERE tenant_id = :tenant_id
        """,
        {"tenant_id": tenant_id},
    )
    recent = await fetch_one(
        session,
        """
        SELECT count(*) AS count FROM observations
        WHERE tenant_id = :tenant_id AND received_time >= :since
        """,
        {"tenant_id": tenant_id, "since": utcnow() - timedelta(minutes=1)},
    )
    quality = await fetch_all(
        session,
        """
        SELECT quality, count(*) AS count FROM latest_signal_state
        WHERE tenant_id = :tenant_id GROUP BY quality
        """,
        {"tenant_id": tenant_id},
    )
    quarantine = await fetch_one(
        session,
        "SELECT count(*) AS count FROM observation_quarantine WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    dedup = await fetch_one(
        session,
        "SELECT count(*) AS count FROM ingest_dedup WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    backlog = await fetch_one(
        session,
        "SELECT COALESCE(sum(outbox_pending), 0) AS pending FROM edge_nodes WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    return {
        "observations": int(totals["observations"]) if totals else 0,
        "oldest": totals["oldest"] if totals else None,
        "newest": totals["newest"] if totals else None,
        "ingest_per_minute": int(recent["count"]) if recent else 0,
        "quality": quality,
        "quarantine": int(quarantine["count"]) if quarantine else 0,
        "dedup_keys": int(dedup["count"]) if dedup else 0,
        "backlog": int(backlog["pending"]) if backlog else 0,
        "disk_bytes": None,
        "note": "Dung lượng đĩa chỉ hiển thị khi đo được từ máy chủ.",
    }


async def create_retention(session: AsyncSession, tenant_id: UUID, actor: UUID, body: RetentionIn, correlation_id: str) -> dict[str, Any]:
    policy_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO retention_policies (id, tenant_id, scope_type, scope_id, keep_days, enabled, legal_hold, created_at)
        VALUES (:id, :tenant_id, :scope_type, :scope_id, :keep_days, FALSE, FALSE, :now)
        """,
        {
            "id": policy_id,
            "tenant_id": tenant_id,
            "scope_type": body.scope_type,
            "scope_id": parse_uuid(body.scope_id) if body.scope_id else None,
            "keep_days": body.keep_days,
            "now": utcnow(),
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="RETENTION_CREATE", actor_id=actor, entity_type="retention", entity_id=policy_id, before=None, after={"keep_days": body.keep_days, "enabled": False}, correlation_id=correlation_id)
    row = await fetch_one(session, "SELECT * FROM retention_policies WHERE id = :id", {"id": policy_id})
    assert row is not None
    return row


async def preview_retention(session: AsyncSession, tenant_id: UUID, policy_id: UUID) -> dict[str, Any]:
    policy = await _policy(session, tenant_id, policy_id)
    cutoff = utcnow() - timedelta(days=int(policy["keep_days"]))
    clause, params = retention_scope(policy)
    count = await fetch_one(
        session,
        f"SELECT count(*) AS count, min(event_time) AS oldest FROM observations WHERE tenant_id = :tenant_id AND event_time < :cutoff{clause}",
        {"tenant_id": tenant_id, "cutoff": cutoff, **params},
    )
    return {"policy_id": str(policy_id), "cutoff": cutoff.isoformat().replace("+00:00", "Z"), "affected": int(count["count"]) if count else 0, "oldest": count["oldest"] if count else None, "deleted": False}


async def enable_retention(session: AsyncSession, tenant_id: UUID, actor: UUID, policy_id: UUID, correlation_id: str) -> dict[str, Any]:
    policy = await _policy(session, tenant_id, policy_id)
    if policy["legal_hold"]:
        raise AppError(409, "LEGAL_HOLD", "Legal hold đang bật, không thể xóa dữ liệu.")
    await execute(session, "UPDATE retention_policies SET enabled = TRUE, version = version + 1 WHERE id = :id", {"id": policy_id})
    await audit(session, tenant_id=tenant_id, event_type="RETENTION_ENABLE", actor_id=actor, entity_type="retention", entity_id=policy_id, before={"enabled": False}, after={"enabled": True}, correlation_id=correlation_id)
    updated = await _policy(session, tenant_id, policy_id)
    return updated


async def execute_retention(session: AsyncSession, tenant_id: UUID, actor: UUID, policy_id: UUID, correlation_id: str) -> dict[str, Any]:
    policy = await _policy(session, tenant_id, policy_id)
    if not policy["enabled"] or policy["legal_hold"] or await _scope_held(session, tenant_id, policy):
        raise AppError(409, "RETENTION_BLOCKED", "Chính sách chưa được bật hoặc đang legal hold.")
    preview = await preview_retention(session, tenant_id, policy_id)
    cutoff = utcnow() - timedelta(days=int(policy["keep_days"]))
    clause, params = retention_scope(policy)
    await execute(
        session,
        f"DELETE FROM observations WHERE tenant_id = :tenant_id AND event_time < :cutoff{clause}",
        {"tenant_id": tenant_id, "cutoff": cutoff, **params},
    )
    await execute(
        session,
        """
        INSERT INTO retention_jobs (id, policy_id, dry_run, affected_count, status, created_at, finished_at)
        VALUES (:id, :policy_id, FALSE, :affected, 'DONE', :now, :now)
        """,
        {"id": uuid4(), "policy_id": policy_id, "affected": preview["affected"], "now": utcnow()},
    )
    await audit(session, tenant_id=tenant_id, event_type="RETENTION_EXECUTE", actor_id=actor, entity_type="retention", entity_id=policy_id, before=None, after={"affected": preview["affected"]}, correlation_id=correlation_id)
    return {"deleted": preview["affected"], "cutoff": preview["cutoff"]}


def retention_scope(policy: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    scope = str(policy.get("scope_type") or "TENANT")
    scope_id = policy.get("scope_id")
    if scope == "SITE" and scope_id:
        return " AND site_id = :scope_id", {"scope_id": scope_id}
    if scope == "RESOURCE" and scope_id:
        return " AND resource_id = :scope_id", {"scope_id": scope_id}
    if scope == "SIGNAL" and scope_id:
        return " AND signal_id = :scope_id", {"scope_id": scope_id}
    if scope != "TENANT":
        return " AND FALSE", {}
    return "", {}


async def _scope_held(session: AsyncSession, tenant_id: UUID, policy: dict[str, Any]) -> bool:
    holds = await fetch_all(
        session,
        "SELECT scope_type, scope_id FROM retention_policies WHERE tenant_id = :tenant_id AND legal_hold = TRUE",
        {"tenant_id": tenant_id},
    )
    for hold in holds:
        if hold["scope_type"] == "TENANT":
            return True
        if hold["scope_type"] == policy["scope_type"] and hold["scope_id"] == policy["scope_id"]:
            return True
    return False


async def _run_formulas(
    session: AsyncSession,
    tenant_id: UUID,
    signal_id: UUID,
    event_time: datetime,
    received_time: datetime,
    *,
    depth: int,
) -> None:
    if depth > 4:
        return
    formulas = await fetch_all(
        session,
        """
        SELECT DISTINCT f.id, f.signal_id AS output_id, f.expression_source, f.revision,
               s.resource_id, s.data_type, s.unit, r.site_id
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
            queue(
                session,
                {
                    "kind": "latest",
                    "tenant_id": str(tenant_id),
                    "signal_id": str(formula["output_id"]),
                    "payload": {"type": "latest", "signal_id": str(formula["output_id"]), "value": value, "quality": quality},
                },
            )
        await _run_formulas(session, tenant_id, as_uuid(formula["output_id"]), event_time, received_time, depth=depth + 1)


async def _enqueue_outputs(
    session: AsyncSession,
    tenant_id: UUID,
    signal_id: UUID,
    event_uid: str,
    value: Any,
    quality: str,
) -> None:
    groups = await fetch_all(
        session,
        """
        SELECT g.id, g.topic_template, m.output_alias
        FROM output_groups g
        JOIN output_group_members m ON m.output_group_id = g.id
        WHERE g.tenant_id = :tenant_id AND g.status = 'PUBLISHED' AND m.signal_id = :signal_id
        """,
        {"tenant_id": tenant_id, "signal_id": signal_id},
    )
    for group in groups:
        await execute(
            session,
            """
            INSERT INTO output_deliveries (id, tenant_id, group_id, event_uid, payload_json, status, created_at)
            VALUES (:id, :tenant_id, :group_id, :event_uid, CAST(:payload AS jsonb), 'QUEUED', :now)
            """,
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "group_id": group["id"],
                "event_uid": event_uid[:256],
                "payload": jsonb({"topic": group["topic_template"], "alias": group["output_alias"], "value": value, "quality": quality}),
                "now": utcnow(),
            },
        )


async def _policy(session: AsyncSession, tenant_id: UUID, policy_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM retention_policies WHERE id = :id AND tenant_id = :tenant_id",
        {"id": policy_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy chính sách lưu trữ.")
    return row


async def export_csv(session: AsyncSession, tenant_id: UUID, actor: UUID, signal_id: UUID, start: datetime, end: datetime) -> dict[str, Any]:
    page = await history(session, tenant_id, signal_id=signal_id, start=start, end=end, limit=5000, cursor=None)
    lines = [csv_row(["event_time", "value", "unit", "quality", "origin", "event_uid"])]
    for item in page["items"]:
        lines.append(csv_row([item["event_time"], item["value"], item["unit"], item["quality"], item["origin"], item["event_uid"]]))
    text = "\n".join(lines) + "\n"
    job_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO export_jobs (id, tenant_id, requested_by, query_json, status, row_count, csv_text, created_at)
        VALUES (:id, :tenant_id, :actor, CAST(:query AS jsonb), 'READY', :rows, :csv, :now)
        """,
        {
            "id": job_id,
            "tenant_id": tenant_id,
            "actor": actor,
            "query": jsonb({"signal_id": str(signal_id)}),
            "rows": len(page["items"]),
            "csv": text,
            "now": utcnow(),
        },
    )
    return {"job_id": str(job_id), "row_count": len(page["items"]), "csv": text, "truncated": page["next_cursor"] is not None}


async def create_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, body: DashboardIn, correlation_id: str) -> dict[str, Any]:
    dashboard_id = uuid4()
    now = utcnow()
    await execute(
        session,
        """
        INSERT INTO dashboards (
            id, tenant_id, site_id, name, description, owner_admin_id, draft_revision, draft_json, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :site_id, :name, :description, :owner, 1, '{"widgets":[]}'::jsonb, 1, :now, :now
        )
        """,
        {
            "id": dashboard_id,
            "tenant_id": tenant_id,
            "site_id": parse_uuid(body.site_id) if body.site_id else None,
            "name": body.name.strip(),
            "description": body.description,
            "owner": actor,
            "now": now,
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="DASHBOARD_CREATE", actor_id=actor, entity_type="dashboard", entity_id=dashboard_id, before=None, after={"name": body.name.strip()}, correlation_id=correlation_id)
    row = await fetch_one(session, "SELECT * FROM dashboards WHERE id = :id", {"id": dashboard_id})
    assert row is not None
    return row


async def patch_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, body: DashboardPatch, correlation_id: str) -> dict[str, Any]:
    current = await _dashboard(session, tenant_id, dashboard_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "Dashboard đã được chỉnh sửa ở nơi khác.")
    if current["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Dashboard đã lưu trữ.")
    if body.draft is not None:
        await _validate_widgets(session, tenant_id, body.draft.get("widgets", []))
    await execute(
        session,
        """
        UPDATE dashboards
        SET name = :name, description = :description, draft_json = CAST(:draft AS jsonb),
            draft_revision = draft_revision + 1, version = version + 1, updated_at = :now
        WHERE id = :id
        """,
        {
            "name": body.name.strip() if body.name else current["name"],
            "description": body.description if body.description is not None else current["description"],
            "draft": jsonb(body.draft if body.draft is not None else current["draft_json"]),
            "now": utcnow(),
            "id": dashboard_id,
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="DASHBOARD_DRAFT", actor_id=actor, entity_type="dashboard", entity_id=dashboard_id, before={"version": current["version"]}, after={"version": int(current["version"]) + 1}, correlation_id=correlation_id)
    return await _dashboard(session, tenant_id, dashboard_id)


async def _validate_widgets(session: AsyncSession, tenant_id: UUID, widgets: list[dict[str, Any]]) -> None:
    if len(widgets) > 40:
        raise AppError(422, "LIMIT", "Tối đa 40 widget trên một dashboard.")
    for widget in widgets:
        if widget.get("type") not in WIDGETS:
            raise AppError(422, "WIDGET", "Loại widget không được hỗ trợ.")
        for binding in widget.get("bindings", []):
            signal = await fetch_one(
                session,
                "SELECT id FROM signal_definitions WHERE id = :id AND tenant_id = :tenant_id AND status = 'ACTIVE'",
                {"id": parse_uuid(str(binding["signal_id"])), "tenant_id": tenant_id},
            )
            if signal is None:
                raise AppError(422, "BINDING", "Widget tham chiếu tín hiệu ngoài phạm vi.")


async def publish_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await _dashboard(session, tenant_id, dashboard_id)
    widgets = (current["draft_json"] or {}).get("widgets", [])
    if not widgets:
        raise AppError(422, "EMPTY", "Dashboard chưa có widget.")
    await _validate_widgets(session, tenant_id, widgets)
    revision = int(current["published_revision"] or 0) + 1
    await execute(
        session,
        """
        INSERT INTO dashboard_revisions (id, dashboard_id, revision, breakpoints_json, widget_configs_json, created_at, published_at)
        VALUES (:id, :dashboard_id, :revision, CAST(:breakpoints AS jsonb), CAST(:widgets AS jsonb), :now, :now)
        """,
        {"id": uuid4(), "dashboard_id": dashboard_id, "revision": revision, "breakpoints": jsonb({"lg": 12, "md": 6, "sm": 1}), "widgets": jsonb(widgets), "now": utcnow()},
    )
    await execute(
        session,
        "UPDATE dashboards SET published_revision = :revision, version = version + 1, updated_at = :now WHERE id = :id",
        {"revision": revision, "now": utcnow(), "id": dashboard_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="DASHBOARD_PUBLISH", actor_id=actor, entity_type="dashboard", entity_id=dashboard_id, before=None, after={"revision": revision}, correlation_id=correlation_id)
    return await _dashboard(session, tenant_id, dashboard_id)


async def _dashboard(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM dashboards WHERE id = :id AND tenant_id = :tenant_id",
        {"id": dashboard_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy dashboard.")
    return row


def finite_or_none(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value
