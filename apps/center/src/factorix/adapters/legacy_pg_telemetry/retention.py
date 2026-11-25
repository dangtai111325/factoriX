"""Legacy PG retention policies over ``observations``. Moved verbatim from ``factorix.modules.telemetry`` (R2-E B5, move-only)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, parse_uuid, utcnow
from factorix.platform.errors import AppError


class RetentionIn(BaseModel):
    scope_type: str = "TENANT"
    scope_id: str | None = None
    keep_days: int = Field(ge=1, le=3650)


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
        raise AppError(409, "LEGAL_HOLD", "Legal hold is active, cannot purge data.")
    await execute(session, "UPDATE retention_policies SET enabled = TRUE, version = version + 1 WHERE id = :id", {"id": policy_id})
    await audit(session, tenant_id=tenant_id, event_type="RETENTION_ENABLE", actor_id=actor, entity_type="retention", entity_id=policy_id, before={"enabled": False}, after={"enabled": True}, correlation_id=correlation_id)
    updated = await _policy(session, tenant_id, policy_id)
    return updated


async def execute_retention(session: AsyncSession, tenant_id: UUID, actor: UUID, policy_id: UUID, correlation_id: str) -> dict[str, Any]:
    policy = await _policy(session, tenant_id, policy_id)
    if not policy["enabled"] or policy["legal_hold"] or await _scope_held(session, tenant_id, policy):
        raise AppError(409, "RETENTION_BLOCKED", "Policy is disabled or legal hold is active.")
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


async def apply_retention_policies(session: AsyncSession, now: datetime, *, batch: int = 5000, max_batches: int = 20) -> int:
    """Background retention: delete observations older than each ENABLED policy, in bounded batches.

    Policies under legal hold (directly or through a tenant-wide hold) are skipped. Each batch is
    committed so the delete never holds a long transaction. A retention_jobs row records the run.
    """
    policies = await fetch_all(
        session,
        "SELECT * FROM retention_policies WHERE enabled = TRUE AND legal_hold = FALSE ORDER BY tenant_id, created_at",
        {},
    )
    total = 0
    for policy in policies:
        tenant_id = as_uuid(policy["tenant_id"])
        if await _scope_held(session, tenant_id, policy):
            continue
        cutoff = now - timedelta(days=int(policy["keep_days"]))
        clause, params = retention_scope(policy)
        deleted_for_policy = 0
        for _ in range(max_batches):
            result = await session.execute(
                text(
                    f"""
                    DELETE FROM observations WHERE (event_time, id) IN (
                        SELECT event_time, id FROM observations
                        WHERE tenant_id = :tenant_id AND event_time < :cutoff{clause}
                        LIMIT :batch
                    )
                    """
                ),
                {"tenant_id": tenant_id, "cutoff": cutoff, "batch": batch, **params},
            )
            deleted = int(result.rowcount or 0)
            await session.commit()
            deleted_for_policy += deleted
            if deleted < batch:
                break
        if deleted_for_policy:
            await execute(
                session,
                """
                INSERT INTO retention_jobs (id, policy_id, dry_run, affected_count, status, created_at, finished_at)
                VALUES (:id, :policy_id, FALSE, :affected, 'DONE', :now, :now)
                """,
                {"id": uuid4(), "policy_id": as_uuid(policy["id"]), "affected": deleted_for_policy, "now": utcnow()},
            )
            await session.commit()
        total += deleted_for_policy
    return total


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


async def _policy(session: AsyncSession, tenant_id: UUID, policy_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM retention_policies WHERE id = :id AND tenant_id = :tenant_id",
        {"id": policy_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Retention policy not found.")
    return row
