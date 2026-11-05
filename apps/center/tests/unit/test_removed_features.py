"""Unit and contract tests verifying permanent removal of Layout, Edge Collectors management, and Diagnostics product features (REMOVE-01..40).

Infrastructure (edge-sync M2M, outbox, telemetry, logs, scoped health) must be preserved.
"""

from __future__ import annotations

from pathlib import Path
from factorix.transport.app import app


def test_remove_layouts_api_not_registered() -> None:
    """REMOVE-06, REMOVE-07: Assert absence of /api/v1/layouts product endpoints in FastAPI router."""
    routes = [route.path for route in app.routes if hasattr(route, "path")]
    layout_routes = [r for r in routes if r.startswith("/api/v1/layouts")]
    assert layout_routes == [], f"Expected zero layout routes, but found: {layout_routes}"


def test_remove_diagnostics_product_api_not_registered() -> None:
    """REMOVE-31: Assert absence of /api/v1/diagnostics dedicated product endpoints."""
    routes = [route.path for route in app.routes if hasattr(route, "path")]
    diag_routes = [r for r in routes if r.startswith("/api/v1/diagnostics")]
    assert diag_routes == [], f"Expected zero standalone diagnostics routes, but found: {diag_routes}"


def test_preserve_edge_sync_infrastructure_api_registered() -> None:
    """REMOVE-22: Assert that internal M2M /api/v1/edge-sync endpoints remain fully registered."""
    routes = [route.path for route in app.routes if hasattr(route, "path")]
    edge_sync_routes = [r for r in routes if r.startswith("/api/v1/edge-sync")]
    assert len(edge_sync_routes) >= 5, f"Expected active edge-sync routes, found: {edge_sync_routes}"
    assert "/api/v1/edge-sync/heartbeat" in edge_sync_routes
    assert "/api/v1/edge-sync/observations" in edge_sync_routes
    assert "/api/v1/edge-sync/commands" in edge_sync_routes


def test_web_source_absence_of_deleted_pages() -> None:
    """REMOVE-04, REMOVE-27: Assert absence of deleted page directories and imports in web app."""
    repo_root = Path(__file__).resolve().parents[4]
    web_src = repo_root / "apps" / "web" / "src"
    assert not (web_src / "pages" / "03_FactoryLayout").exists(), "03_FactoryLayout must be deleted"
    assert not (web_src / "pages" / "16_Edges").exists(), "16_Edges must be deleted"
    assert not (web_src / "pages" / "11_Diagnostics").exists(), "11_Diagnostics must be deleted"

    app_tsx = (web_src / "App.tsx").read_text(encoding="utf-8")
    assert "FactoryLayoutPage" not in app_tsx
    assert "EdgesPage" not in app_tsx
    assert "DiagnosticsPage" not in app_tsx


def test_sidebar_navigation_matches_strict_spec() -> None:
    """REMOVE-01, REMOVE-19, REMOVE-29: Assert sidebar matches strict navigation §0.1."""
    repo_root = Path(__file__).resolve().parents[4]
    sidebar_file = repo_root / "apps" / "web" / "src" / "components" / "shell" / "Sidebar.tsx"
    sidebar_text = sidebar_file.read_text(encoding="utf-8")

    # Forbidden items
    assert "Layout Designer" not in sidebar_text
    assert "Factory Layout" not in sidebar_text
    assert "Edge Collectors" not in sidebar_text
    assert "Diagnostics" not in sidebar_text
    assert "Activity Log" not in sidebar_text

    # Required items per §0.1
    assert "Overview" in sidebar_text
    assert "Hierarchy Structure" in sidebar_text
    assert "Knowledge Graph" in sidebar_text
    assert "Connections" in sidebar_text
    assert "Signals" in sidebar_text
    assert "Model Catalog" in sidebar_text
