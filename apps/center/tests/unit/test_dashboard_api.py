"""Dashboard Studio HTTP layer through the ASGI app (fakes instead of PostgreSQL): routing, auth dependency, shapes."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from _dashboard_fakes import ACTOR, SIG_OLD, SIG_SPEED_1, TENANT, CatalogDB, DashboardStore, install_catalog, install_store

DETAIL_KEYS = {"id", "name", "description", "status", "version", "draft_revision", "published_revision", "published_at", "archived_at",
               "has_unpublished_changes", "site_id", "created_at", "updated_at", "document", "upgrade_notes"}
LIST_KEYS = {"id", "name", "description", "status", "draft_revision", "published_revision", "published_at", "has_unpublished_changes",
             "widget_count", "theme_preset", "version", "created_at", "updated_at", "archived_at"}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    from factorix.transport import app as A

    async def no_db():
        yield SimpleNamespace()

    async def principal():
        return {"tenant_id": str(TENANT), "admin_id": str(ACTOR), "role": "admin"}

    monkeypatch.setitem(A.app.dependency_overrides, A.db_session, no_db)
    monkeypatch.setitem(A.app.dependency_overrides, A.admin, principal)
    install_store(monkeypatch, DashboardStore())
    install_catalog(monkeypatch, CatalogDB())
    return AsyncClient(transport=ASGITransport(app=A.app), base_url="http://test")


def test_static_paths_are_registered_before_the_dashboard_id_path() -> None:
    from factorix.transport.app import app

    paths = [getattr(r, "path", "") for r in app.routes]
    dynamic = paths.index("/api/v1/dashboards/{dashboard_id}")
    for static in ("widget-types", "themes", "templates", "sources", "resolve", "import"):
        assert paths.index(f"/api/v1/dashboards/{static}") < dynamic, static


def test_every_dashboard_route_requires_the_admin_principal() -> None:
    from factorix.transport.app import app
    from factorix.transport.http.deps import admin

    routes = [r for r in app.routes if getattr(r, "path", "").startswith("/api/v1/dashboards")]
    assert len(routes) == 23
    for route in routes:
        deps = [d.call for d in route.dependant.dependencies]
        assert admin in deps, route.path


async def test_registry_endpoints(client: AsyncClient) -> None:
    async with client:
        types = (await client.get("/api/v1/dashboards/widget-types")).json()
        assert types["schema_version"] == 1 and {"widget_types", "limits", "enums"} <= set(types)
        themes = (await client.get("/api/v1/dashboards/themes")).json()["items"]
        assert [t["id"] for t in themes] == ["factorix_light", "control_room_dark", "industrial_neutral"]
        templates = (await client.get("/api/v1/dashboards/templates")).json()["items"]
        assert set(templates[0]) == {"id", "label", "description", "category", "builtin", "roles", "widget_count", "variables", "created_at"}
        assert (await client.delete("/api/v1/dashboards/templates/machine_overview")).json()["error"]["code"] == "TEMPLATE_BUILTIN"


async def test_flow_and_shapes(client: AsyncClient) -> None:
    async with client:
        assert (await client.post("/api/v1/dashboards", json={"name": "X", "tenant_id": "00000000-0000-0000-0000-0000000000a2"})).status_code == 422
        created = await client.post("/api/v1/dashboards", json={"name": "Line"})
        assert created.status_code == 201 and set(created.json()) == DETAIL_KEYS | {"warnings"}
        d = created.json()
        listed = (await client.get("/api/v1/dashboards")).json()["items"]
        assert set(listed[0]) == LIST_KEYS
        bad = await client.patch(f"/api/v1/dashboards/{d['id']}", json={"version": 1, "document": {"schema_version": 1, "widgets": [
            {"id": "w_x", "type": "kpi", "layout": {"lg": {"x": 0, "y": 0, "w": 3, "h": 3}},
             "bindings": [{"id": "b_1", "source": {"kind": "url", "url": "http://example.com"}}]}]}})
        assert bad.status_code == 422
        error = bad.json()["error"]
        assert error["code"] == "VALIDATION" and error["details"]["issues"][0]["code"] == "INVALID_SOURCE_KIND"
        assert error["details"]["issues"][0]["widget_id"] == "w_x" and error["details"]["issues"][0]["binding_id"] == "b_1"
        doc = {"schema_version": 1, "widgets": [{"id": "w_x", "type": "kpi", "layout": {"lg": {"x": 0, "y": 0, "w": 3, "h": 3}},
                                                 "bindings": [{"id": "b_1", "source": {"kind": "signal", "signal_id": SIG_OLD}}]}]}
        saved = await client.patch(f"/api/v1/dashboards/{d['id']}", json={"version": 1, "document": doc})
        assert saved.status_code == 200 and saved.json()["version"] == 2
        conflict = await client.patch(f"/api/v1/dashboards/{d['id']}", json={"version": 1, "name": "Y"})
        assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "RESOURCE_VERSION_CONFLICT"
        validated = (await client.post(f"/api/v1/dashboards/{d['id']}/validate")).json()
        assert validated["ok"] is False and validated["issues"][0]["code"] == "ARCHIVED"
        blocked = await client.post(f"/api/v1/dashboards/{d['id']}/publish", json={"version": 2})
        assert blocked.status_code == 422 and blocked.json()["error"]["code"] == "PUBLISH_BLOCKED"
        doc["widgets"][0]["bindings"][0]["source"]["signal_id"] = SIG_SPEED_1
        saved = (await client.patch(f"/api/v1/dashboards/{d['id']}", json={"version": 2, "document": doc})).json()
        published = await client.post(f"/api/v1/dashboards/{d['id']}/publish", json={"version": saved["version"], "note": "go"})
        assert published.status_code == 200 and published.json()["status"] == "PUBLISHED"
        view = (await client.get(f"/api/v1/dashboards/{d['id']}/published")).json()
        assert set(view) == {"id", "name", "description", "revision", "published_at", "archived_at", "document"}
        revisions = (await client.get(f"/api/v1/dashboards/{d['id']}/revisions")).json()["items"]
        assert set(revisions[0]) == {"revision", "published_at", "published_by", "published_by_name", "note", "widget_count"}
        assert (await client.get(f"/api/v1/dashboards/{d['id']}/revisions/1")).json()["note"] == "go"
        exported = (await client.get(f"/api/v1/dashboards/{d['id']}/export")).json()
        imported = await client.post("/api/v1/dashboards/import", json={"payload": exported})
        assert imported.status_code == 201 and imported.json()["warnings"] == []
        dup = await client.post(f"/api/v1/dashboards/{d['id']}/duplicate", json={"name": "Copy"})
        assert dup.status_code == 201
        refused = await client.delete(f"/api/v1/dashboards/{dup.json()['id']}")
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "NOT_ARCHIVED"
        await client.post(f"/api/v1/dashboards/{dup.json()['id']}/archive", json={"version": dup.json()["version"]})
        deleted = await client.delete(f"/api/v1/dashboards/{dup.json()['id']}")
        assert deleted.status_code == 204 and deleted.content == b""
        assert (await client.get(f"/api/v1/dashboards/{dup.json()['id']}")).status_code == 404
        resolved = (await client.post("/api/v1/dashboards/resolve", json={"variables": {}, "sources": [
            {"kind": "signal", "signal_id": SIG_SPEED_1}]})).json()["items"]
        assert resolved[0]["token"] == SIG_SPEED_1
        assert (await client.get("/api/v1/dashboards/not-a-uuid")).status_code == 422
