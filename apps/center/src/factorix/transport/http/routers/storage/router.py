"""``build_router`` for the storage/historian HTTP surface (R2-E B3): one ``APIRouter`` with the routes of the
per-domain modules, registered in this order:

1. :mod:`.designs_legacy`  2. :mod:`.historian`  3. ``drafts_operations.register_before_objects`` (B-09)
4. :mod:`.td_objects`  5. :mod:`.drafts_operations`  6. :mod:`.bindings_recording`  7. :mod:`.pg_explorer`

Within a module the original order is kept. Compared with the single closure before the split, only routes
that cannot match the same URL changed relative order (checked for every pair; see fix_log ARCH-B)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter

from factorix.transport.http.routers.storage import bindings_recording, designs_legacy, drafts_operations, historian, pg_explorer, td_objects
from factorix.transport.http.routers.storage.context import build_context


def build_router(
    admin: Callable[..., Any] | None = None,
    db_session: Callable[..., Any] | None = None,
    td_client: Any | None = None,
) -> APIRouter:
    ctx = build_context(admin, db_session, td_client)
    router = APIRouter()
    designs_legacy.register(router, ctx)
    historian.register(router, ctx)
    drafts_operations.register_before_objects(router, ctx)
    td_objects.register(router, ctx)
    drafts_operations.register(router, ctx)
    bindings_recording.register(router, ctx)
    pg_explorer.register(router, ctx)
    return router
