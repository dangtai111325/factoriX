"""Historian ingest, queries, retention and dashboards."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.csv_safe import csv_row
from factorix.domain.observation import Observation, ObservationError, Quality, classify_clock, should_replace_latest
from factorix.domain.quality import Origin
from factorix.modules.common import as_uuid, audit, create_partitions_for, execute, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
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
                "site_id": observation.site_id,
                "resource_id": observation.resource_id,
                "signal_id": observation.signal_id,
                "edge_id": edge_id,
                "connection_id": observation.connection_id,
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
        await _upsert_latest(
            session,
            tenant_id=tenant_id,
            observation_id=observation_id,
            observation=observation,
            quality=quality,
        )
        if observation.connection_id is not None and quality == "GOOD":
            await execute(
                session,
                """
                UPDATE connections
                SET health = 'HEALTHY', last_success_at = :now, last_error = NULL, updated_at = :now
                WHERE id = :id AND tenant_id = :tenant_id
                """,
                {"now": utcnow(), "id": observation.connection_id, "tenant_id": tenant_id},
            )
        results.append({"event_uid": observation.event_uid, "status": "committed"})
    return {"results": results}


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
) -> None:
    current = await fetch_one(
        session,
        "SELECT event_time, received_time FROM latest_signal_state WHERE tenant_id = :tenant_id AND signal_id = :signal_id",
        {"tenant_id": tenant_id, "signal_id": observation.signal_id},
    )
    replace = True
    if current is not None:
        replace = should_replace_latest(
            current_event_time=current["event_time"],
            current_received_time=current["received_time"],
            current_uid=observation.event_uid,
            incoming_event_time=observation.event_time,
            incoming_received_time=observation.received_time,
            incoming_uid=observation.event_uid,
        )
    if not replace:
        return
    good_value = _value_json(observation.value) if quality == "GOOD" else None
    await execute(
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
            last_good_value_json = COALESCE(EXCLUDED.last_good_value_json, latest_signal_state.last_good_value_json),
            last_good_event_time = COALESCE(EXCLUDED.last_good_event_time, latest_signal_state.last_good_event_time),
            updated_at = EXCLUDED.updated_at
        """,
        {
            "tenant_id": tenant_id,
            "signal_id": observation.signal_id,
            "resource_id": observation.resource_id,
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
    return {
        "observations": int(totals["observations"]) if totals else 0,
        "oldest": totals["oldest"] if totals else None,
        "newest": totals["newest"] if totals else None,
        "ingest_per_minute": int(recent["count"]) if recent else 0,
        "quality": quality,
        "quarantine": int(quarantine["count"]) if quarantine else 0,
        "dedup_keys": int(dedup["count"]) if dedup else 0,
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
    count = await fetch_one(
        session,
        "SELECT count(*) AS count, min(event_time) AS oldest FROM observations WHERE tenant_id = :tenant_id AND event_time < :cutoff",
        {"tenant_id": tenant_id, "cutoff": cutoff},
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
    if not policy["enabled"] or policy["legal_hold"]:
        raise AppError(409, "RETENTION_BLOCKED", "Chính sách chưa được bật hoặc đang legal hold.")
    preview = await preview_retention(session, tenant_id, policy_id)
    cutoff = utcnow() - timedelta(days=int(policy["keep_days"]))
    await execute(
        session,
        "DELETE FROM observations WHERE tenant_id = :tenant_id AND event_time < :cutoff",
        {"tenant_id": tenant_id, "cutoff": cutoff},
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
