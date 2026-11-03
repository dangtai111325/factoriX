"""Commissioning lifecycle shared by console polling and Edge command delivery."""

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import execute


async def expire_jobs(session: AsyncSession, *, tenant_id: UUID | None = None, edge_id: UUID | None = None) -> None:
    if tenant_id is None and edge_id is None:
        raise ValueError("Commissioning expiry requires an owner scope.")
    scope, params = ("j.tenant_id = :tenant_id", {"tenant_id": tenant_id}) if tenant_id else ("c.edge_id = :edge_id", {"edge_id": edge_id})
    await execute(session, f"""
        UPDATE commissioning_jobs j
        SET status = 'FAILED', completed_at = now(),
            error_code = CASE WHEN j.connection_version <> c.version THEN 'CONFIG_CHANGED' ELSE 'TIMEOUT' END,
            diagnostic = CASE WHEN j.connection_version <> c.version
                THEN 'Connection changed. Run the test again.' ELSE 'Commissioning timed out. Run the test again.' END
        FROM connections c
        WHERE j.connection_id = c.id AND {scope}
          AND ((j.status IN ('PENDING', 'RUNNING', 'PASSED') AND j.connection_version <> c.version)
               OR (j.status IN ('PENDING', 'RUNNING') AND j.expires_at <= now()))
    """, params)
