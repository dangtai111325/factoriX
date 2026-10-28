"""Shared query helpers."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_PARTITION = re.compile(r"observations_\d{4}_\d{2}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def dump(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    output: dict[str, Any] = {}
    for key, value in dict(row).items():
        if isinstance(value, memoryview):
            output[key] = bytes(value)
        else:
            output[key] = value
    return output


def rows(result: Any) -> list[dict[str, Any]]:
    return [item for item in (dump(row) for row in result) if item is not None]


async def fetch_one(session: AsyncSession, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
    result = await session.execute(text(sql), params)
    return dump(result.mappings().first())


async def fetch_all(session: AsyncSession, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    result = await session.execute(text(sql), params)
    return rows(result.mappings().all())


async def execute(session: AsyncSession, sql: str, params: dict[str, Any]) -> None:
    await session.execute(text(sql), params)


def jsonb(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)


def as_uuid(value: Any) -> UUID:
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (TypeError, ValueError) as exc:
        from factorix.platform.errors import AppError

        raise AppError(422, "INVALID_ID", "Định danh không hợp lệ.") from exc


def parse_uuid(value: str, code: str = "INVALID_ID") -> UUID:
    del code
    return as_uuid(value)


async def audit(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    event_type: str,
    actor_id: UUID | None,
    entity_type: str,
    entity_id: UUID | None,
    before: Any,
    after: Any,
    correlation_id: str,
) -> None:
    await execute(
        session,
        """
        INSERT INTO audit_events (
            id, tenant_id, event_type, actor_id, entity_type, entity_id,
            before_json, after_json, correlation_id, occurred_at
        ) VALUES (
            gen_random_uuid(), :tenant_id, :event_type, :actor_id, :entity_type, :entity_id,
            CAST(:before_json AS jsonb), CAST(:after_json AS jsonb), :correlation_id, :occurred_at
        )
        """,
        {
            "tenant_id": tenant_id,
            "event_type": event_type,
            "actor_id": actor_id,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "before_json": None if before is None else jsonb(before),
            "after_json": None if after is None else jsonb(after),
            "correlation_id": correlation_id,
            "occurred_at": utcnow(),
        },
    )


async def create_partitions_for(session: AsyncSession, moment: datetime) -> None:
    from factorix.platform.db import _month_start, _shift_month

    months = [_shift_month(moment.date(), -1), _month_start(moment.date()), _shift_month(moment.date(), 1)]
    for start in months:
        end = _shift_month(start, 1)
        name = f"observations_{start.year}_{start.month:02d}"
        if not _PARTITION.fullmatch(name):
            raise RuntimeError("partition")
        start_s, end_s = start.isoformat(), end.isoformat()
        if not _DAY.fullmatch(start_s) or not _DAY.fullmatch(end_s):
            raise RuntimeError("partition bound")
        exists = await session.execute(text("SELECT to_regclass(:name)"), {"name": f"public.{name}"})
        if exists.scalar() is not None:
            continue
        await session.execute(
            text(
                f"CREATE TABLE {name} PARTITION OF observations "
                f"FOR VALUES FROM ('{start_s}') TO ('{end_s}')"
            )
        )
