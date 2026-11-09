"""Which data models use a signal: the impact shown before a signal is disabled or deleted, a
connection is paused, or a resource is archived (R3-DM-02, R3-HS-01, R3-CN-02).

Backed by the Data Model v2 reference index ``model_refs`` (maintained on every model save, see
:mod:`factorix.modules.data_models`).

Shapes (stable API contract):
* a model is ``{"id": str, "display_name": str, "status": str}`` (``status`` = RUNNING | PAUSED;
  ``name`` and ``state`` are included too);
* ``GET /api/v1/signals/{id}/usage`` returns ``{"models": [model, ...]}``.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

Model = dict[str, Any]


async def models_using_signal(session: AsyncSession, tenant_id: UUID, signal_id: UUID) -> list[Model]:
    """Active (not deleted) data models whose body references ``signal_id``."""
    from factorix.modules import data_models

    return await data_models.models_using_signals(session, tenant_id, [signal_id])


async def models_using_signals(session: AsyncSession, tenant_id: UUID, signal_ids: Iterable[UUID]) -> list[Model]:
    """Models referencing any of ``signal_ids``, one entry per model, sorted by name."""
    from factorix.modules import data_models

    models = await data_models.models_using_signals(session, tenant_id, signal_ids)
    return sorted(models, key=lambda m: (str(m.get("display_name") or "").lower(), str(m["id"])))


async def models_using_resource(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> list[Model]:
    """Models referencing the resource itself (``.@name`` attributes), a descendant or any of their signals."""
    from factorix.modules import data_models

    return await data_models.models_using_resource(session, tenant_id, resource_id)


async def archive_models(session: AsyncSession, tenant_id: UUID, actor: UUID, models: list[Model], correlation_id: str) -> list[Model]:
    """Archive (soft delete, as ``DELETE /data-models/{id}``) the given models together with the
    resource they depend on; returns them with ``status`` ``ARCHIVED``."""
    from factorix.modules import data_models

    return await data_models.archive_models(session, tenant_id, actor, models, correlation_id, reason="resource archived")
