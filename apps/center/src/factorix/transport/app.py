"""FactoriX Center HTTP application.

Composition root (R2-E Phase B, B2). The routes, background loops and helpers that used to live here
moved, unchanged, to ``factorix.transport.http.deps``, ``factorix.transport.http.routers.*``,
``factorix.transport.ws.stream``, ``factorix.transport.background.*`` and ``factorix.transport.spa``.
This module creates the FastAPI app (lifespan, middleware, error handlers), includes the routers in
the original registration order and mounts the SPA. Every name that was importable from here still is
(re-exported through ``factorix.transport._app_compat``), and attribute patches on this module are forwarded
to the new modules (``factorix._shims``).
"""

from __future__ import annotations

# Every name importable from this module before the split (original imports + moved code), see _app_compat.
from factorix.transport._app_compat import *  # noqa: F401,F403
from factorix.transport.http.routers import (
    probes as _probes_routes,
    auth as _auth_routes,
    sites_resources as _sites_resources_routes,
    graph as _graph_routes,
    connections as _connections_routes,
    signals as _signals_routes,
    formulas_mappings as _formulas_mappings_routes,
    collector_status as _collector_status_routes,
    observations as _observations_routes,
    storage_legacy as _storage_legacy_routes,
    retention as _retention_routes,
    dashboards as _dashboards_routes,
    audit as _audit_routes,
    overview as _overview_routes,
    search as _search_routes,
    edge_legacy as _edge_legacy_routes,
)
from factorix.transport.ws import stream as _stream_routes


async def _stop(task: asyncio.Task[Any]) -> None:
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:  # noqa: BLE001 - shutdown must continue; the error is logged
        logger.exception("Background task %s failed during shutdown", task.get_name())


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from factorix.modules.history_repository import (
        TDengineHistoryRepository,
        TDengineModelSnapshotProvider,
        configure_history_provider,
        configure_model_snapshot_provider,
    )
    from factorix.platform.tdengine import TDEngineClient, TDEngineConfig

    cfg = _settings()
    td_client: TDEngineClient | None = None
    if cfg.tdengine_dsn:
        td_client = TDEngineClient(TDEngineConfig(dsn=cfg.tdengine_dsn, db_prefix=cfg.tdengine_db_prefix))
        live_provider = TDengineLiveStateProvider(td_client)
        history_provider = TDengineHistoryRepository(td_client)
        snapshot_provider = TDengineModelSnapshotProvider(td_client)
        configure_live_state_provider(live_provider)
        configure_history_provider(history_provider)
        configure_model_snapshot_provider(snapshot_provider)
        models_engine.ENGINE.live_provider = live_provider
        app.state.td_client = td_client
        app.state.live_state_provider = live_provider
        app.state.history_provider = history_provider
        app.state.model_snapshot_provider = snapshot_provider

    task = asyncio.create_task(_background_health_loop(), name="health-loop")
    enroll_task = asyncio.create_task(_appliance_auto_enroll(), name="appliance-enroll")
    notify_task = asyncio.create_task(_pg_notify_bridge_loop(), name="pg-notify-bridge")
    _wire_hub_freshness()
    stream_heartbeat_task = asyncio.create_task(hub.heartbeat_loop(lambda: iso_ms(utcnow())), name="stream-heartbeat")
    # Data Model v2: one sampling scheduler, the only writer of model_state / model_snapshots.
    models_engine.ENGINE.start()
    # Managed recording of Data Model fields into user subtables (outbox -> TDengine), WS-H.
    from factorix.modules import storage_model_recorder

    if td_client is not None:
        storage_model_recorder.DISPATCHER.start(td_client)
    app.state.background_tasks = (task, enroll_task, notify_task, stream_heartbeat_task)
    try:
        yield
    finally:
        await _stop(stream_heartbeat_task)
        await _stop(notify_task)
        await _stop(enroll_task)
        await models_engine.ENGINE.stop()
        await storage_model_recorder.DISPATCHER.stop()
        await _stop(task)
        configure_live_state_provider(None)
        configure_history_provider(None)
        configure_model_snapshot_provider(None)
        models_engine.ENGINE.live_provider = None
        if td_client is not None:
            await td_client.close()


app = FastAPI(title="FactoriX IIoT Center", version="1.0.0", openapi_url="/api/openapi.json", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["content-type", "x-csrf-token", "x-bootstrap-token"],
)

# ``forgot`` (auth router) reads ``app.state.mailer``; hand it this app (B2 wiring, no behaviour change).
_auth_routes.app = app


@app.middleware("http")
async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
    request.state.correlation_id = request.headers.get("x-correlation-id") or uuid.uuid4().hex
    started = time.monotonic()
    response = await call_next(request)
    elapsed = time.monotonic() - started
    if elapsed > SLOW_REQUEST_S:
        # Responsiveness evidence (R3 P1): edge sync calls share this single event loop with the UI.
        logger.warning("Slow request %s %s: %.2f s (status %s)", request.method, request.url.path, elapsed, response.status_code)
    response.headers["X-Correlation-Id"] = request.state.correlation_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    # img-src data: — Dashboard image widgets embed their (validated PNG/JPEG/WebP/GIF) image as a data URL
    # and the grid's resize handle is an inline SVG; without it the browser blocks every such image.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'"
    )
    return response


@app.exception_handler(AppError)
async def app_error(request: Request, exc: AppError) -> JSONResponse:
    headers = {}
    if exc.extra.get("retry_after_seconds"):
        headers["Retry-After"] = str(exc.extra["retry_after_seconds"])
    return json_error(
        exc.status,
        exc.code,
        exc.message,
        correlation_id=correlation_id(request),
        field_errors=exc.field_errors,
        retryable=exc.retryable,
        headers=headers,
        extra={key: value for key, value in exc.extra.items() if key != "secret"},
    )


@app.exception_handler(StorageObjectError)
async def storage_object_error(request: Request, exc: StorageObjectError) -> JSONResponse:
    """Storage validation / saga errors are client-visible errors with a code, never a bare 500 (R1-04)."""
    return json_error(
        int(getattr(exc, "http_status", 422)),
        exc.code or "STORAGE_OPERATION_FAILED",
        str(exc),
        correlation_id=correlation_id(request),
        field_errors=getattr(exc, "field_errors", None) or [],
        retryable=exc.code in ("STORAGE_ENGINE_UNAVAILABLE", "PUBLISH_FAILED"),
    )


def _mount_spa() -> None:
    cfg = _settings()
    if not cfg.web_dist:
        return
    root = Path(cfg.web_dist).resolve()
    index = root / "index.html"
    if not index.is_file():
        return

    assets_dir = (root / "assets").resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str, request: Request) -> Response:
        candidate = (root / full_path).resolve()
        if candidate.is_file() and candidate.is_relative_to(root):
            if candidate.name == "index.html" or candidate.suffix in {".html", ".htm"}:
                return FileResponse(candidate, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
            # R1-25: Vite assets carry a content hash in their name, so they never change: cache them
            # for a year and send text assets gzip-compressed (the main bundle is ~2.8 MB raw).
            headers: dict[str, str] = {}
            if candidate.is_relative_to(assets_dir):
                headers["Cache-Control"] = "public, max-age=31536000, immutable"
            if candidate.suffix in _GZIP_SUFFIXES and "gzip" in request.headers.get("accept-encoding", "").lower():
                body = _gzipped(str(candidate), candidate.stat().st_mtime_ns)
                if body is not None:
                    media_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
                    if media_type.startswith("text/") or media_type.endswith("javascript"):
                        media_type += "; charset=utf-8"
                    headers.update({"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
                    return Response(content=body, media_type=media_type, headers=headers)
            return FileResponse(candidate, headers=headers or None)
        return FileResponse(index, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


# Route tables replayed onto the app in the original registration order (B2; routes stay on app.router).
_probes_routes.router.register(app)
_auth_routes.router.register(app)
_sites_resources_routes.router.register(app)
_graph_routes.router.register(app)
_connections_routes.router.register(app)
_signals_routes.router.register(app)
_formulas_mappings_routes.router.register(app)
_collector_status_routes.router.register(app)
_observations_routes.router.register(app)
_storage_legacy_routes.router.register(app)
_retention_routes.router.register(app)
_dashboards_routes.router.register(app)
_audit_routes.router.register(app)
_overview_routes.router.register(app)
_search_routes.router.register(app)
_edge_legacy_routes.router.register(app)
_stream_routes.router.register(app)
app.include_router(data_models_api.build_router(admin, db_session))
app.include_router(storage_api.build_router(admin, db_session))
app.include_router(telemetry_reset.build_router(admin, db_session))
_mount_spa()


from factorix import _shims  # noqa: E402

_shims.forward_patches(
    __name__,
    "factorix.transport.http.deps",
    "factorix.transport.ws.stream",
    "factorix.transport.background.notify_bridge",
    "factorix.transport.background.appliance_enroll",
    "factorix.transport.background.health_loop",
    "factorix.transport.http.routers.probes",
    "factorix.transport.http.routers.auth",
    "factorix.transport.http.routers.sites_resources",
    "factorix.transport.http.routers.graph",
    "factorix.transport.http.routers.connections",
    "factorix.transport.http.routers.signals",
    "factorix.transport.http.routers.formulas_mappings",
    "factorix.transport.http.routers.collector_status",
    "factorix.transport.http.routers.observations",
    "factorix.transport.http.routers.storage_legacy",
    "factorix.transport.http.routers.retention",
    "factorix.transport.http.routers.dashboards",
    "factorix.transport.http.routers.audit",
    "factorix.transport.http.routers.overview",
    "factorix.transport.http.routers.search",
    "factorix.transport.http.routers.edge_legacy",
    "factorix.transport.spa",
)
