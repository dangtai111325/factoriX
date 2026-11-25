"""Shared state of the storage/historian routers: the services ``build_router`` creates once per router
(R2-E B3, moved verbatim from ``factorix.transport.storage_api``).

The prologue of the original ``build_router`` closure (dependency defaults, TDengine client, the four
services and ``ids``) is :func:`build_context`; every route module reads the same objects from
:class:`StorageRouterContext`, so all routes of one router still share one instance of each service."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import postgres_explorer as PE
from factorix.modules import storage_bindings as SB
from factorix.modules import storage_revisions as SR
from factorix.modules import storage_topology as ST
from factorix.modules.common import as_uuid
from factorix.platform.settings import Settings
from factorix.platform.tdengine import TDEngineClient, TDEngineConfig

_td_singleton: TDEngineClient | None = None


def _get_td_client() -> TDEngineClient | None:
    global _td_singleton
    if _td_singleton is None:
        try:
            cfg = Settings()
            if cfg.tdengine_dsn:
                _td_singleton = TDEngineClient(
                    TDEngineConfig(dsn=cfg.tdengine_dsn, db_prefix=cfg.tdengine_db_prefix)
                )
        except Exception:
            pass
    return _td_singleton


async def _default_admin() -> dict[str, Any]:
    return {
        "tenant_id": "00000000-0000-0000-0000-000000000001",
        "admin_id": "00000000-0000-0000-0000-000000000001",
        "role": "admin",
    }


async def _default_db_session() -> AsyncSession:  # pragma: no cover
    raise RuntimeError("Database session dependency not configured.")


@dataclass(frozen=True)
class StorageRouterContext:
    """What the route closures of one ``build_router`` call share (same objects as before the split)."""

    admin_dep: Callable[..., Any]
    db_dep: Callable[..., Any]
    td: Any
    topology_inspector: ST.StorageTopologyInspector
    revision_service: SR.StorageRevisionService
    binding_service: SB.StorageBindingService
    pg_explorer: PE.PostgresExplorerService
    ids: Callable[[dict[str, Any]], tuple[UUID, UUID | None]]


def build_context(
    admin: Callable[..., Any] | None = None,
    db_session: Callable[..., Any] | None = None,
    td_client: Any | None = None,
) -> StorageRouterContext:
    admin_dep = admin or _default_admin
    db_dep = db_session or _default_db_session

    td = td_client or _get_td_client()
    topology_inspector = ST.StorageTopologyInspector(td)
    revision_service = SR.StorageRevisionService(td)
    binding_service = SB.StorageBindingService()
    pg_explorer = PE.PostgresExplorerService()

    def ids(principal: dict[str, Any]) -> tuple[UUID, UUID | None]:
        tenant_id = as_uuid(principal["tenant_id"])
        actor_raw = (
            principal.get("admin_id")
            or principal.get("actor_id")
            or principal.get("user_id")
        )
        actor_id = as_uuid(actor_raw) if actor_raw else None
        return tenant_id, actor_id

    return StorageRouterContext(
        admin_dep=admin_dep,
        db_dep=db_dep,
        td=td,
        topology_inspector=topology_inspector,
        revision_service=revision_service,
        binding_service=binding_service,
        pg_explorer=pg_explorer,
        ids=ids,
    )
