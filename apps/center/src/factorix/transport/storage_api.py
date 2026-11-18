"""HTTP routes for Storage Designer (S10), Storage Catalog & Lifecycle (S11), and Historian Explorer (S12).

Exposes routes under:
  - ``/api/v1/storage/*``
  - ``/api/v1/historian/*``

Built by :func:`build_router` with application auth and session dependencies. Also exports
a module-level :data:`router` configured with default dependencies.

R2-E B3: compatibility shim. The routes live in ``factorix.transport.http.routers.storage`` (one module per
sub-domain: ``designs_legacy``, ``historian``, ``td_objects``, ``drafts_operations``, ``bindings_recording``,
``pg_explorer``; shared services in ``context``, shared guards in ``common``). This module keeps the old import
path, the original imports and every original module-level name; patches set on it reach the moved code
(``factorix._shims.forward_patches``).
"""

from __future__ import annotations

import json  # noqa: F401
import logging
from collections.abc import Callable, Sequence  # noqa: F401
from typing import Any, Literal  # noqa: F401
from uuid import UUID, uuid4  # noqa: F401

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response  # noqa: F401
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: F401

from factorix.modules import historian_catalog as HC  # noqa: F401
from factorix.modules import historian_service as HS  # noqa: F401
from factorix.modules import historian_views as HV  # noqa: F401
from factorix.modules import postgres_explorer as PE  # noqa: F401
from factorix.modules import storage_bindings as SB  # noqa: F401
from factorix.modules import storage_designs as SD  # noqa: F401
from factorix.modules import storage_model_recorder as SMR  # noqa: F401
from factorix.modules import storage_objects as SO  # noqa: F401
from factorix.modules import storage_revisions as SR  # noqa: F401
from factorix.modules import storage_topology as ST  # noqa: F401
from factorix.modules.storage_objects import StorageObjectError, is_system_stable, is_system_subtable  # noqa: F401
from factorix.modules.common import as_uuid, execute, fetch_all, fetch_one, iso_ms, parse_uuid, utcnow  # noqa: F401
from factorix.platform.errors import AppError  # noqa: F401
from factorix.platform.http import correlation_id  # noqa: F401
from factorix.platform.settings import Settings  # noqa: F401
from factorix.platform.tdengine import TDEngineClient, TDEngineConfig  # noqa: F401

from factorix.transport.http.routers.storage.context import (  # noqa: F401
    StorageRouterContext,
    _default_admin,
    _default_db_session,
    _get_td_client,
    _td_singleton,
    build_context,
)
from factorix.transport.http.routers.storage.historian import _json_response, _parse_signals_param  # noqa: F401
from factorix.transport.http.routers.storage.router import build_router
from factorix.transport.http.routers.storage.td_objects import _is_missing_td_error  # noqa: F401

logger = logging.getLogger(__name__)

from factorix import _shims  # noqa: E402

_shims.forward_patches(
    __name__,
    "factorix.transport.http.routers.storage.context",
    "factorix.transport.http.routers.storage.common",
    "factorix.transport.http.routers.storage.designs_legacy",
    "factorix.transport.http.routers.storage.historian",
    "factorix.transport.http.routers.storage.td_objects",
    "factorix.transport.http.routers.storage.drafts_operations",
    "factorix.transport.http.routers.storage.bindings_recording",
    "factorix.transport.http.routers.storage.pg_explorer",
    "factorix.transport.http.routers.storage.router",
)

# Default router instance
router = build_router()
