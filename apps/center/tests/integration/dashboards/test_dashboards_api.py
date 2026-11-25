"""Dashboard Studio API against the migrated PostgreSQL database (migration 0013, SQL of ``application.dashboards.store``,
``sources`` and the routes), tenant isolation and the legacy data path. Runs in CI job ``storage-integration``."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parents[5]
for candidate in (ROOT / ".env", ROOT / ".env.test.example"):
    if candidate.is_file():
        for line in candidate.read_text(encoding="utf-8").splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
os.environ["FACTORIX_BOOTSTRAP_TOKEN"] = "integration-bootstrap-token"
os.environ["FACTORIX_ENVIRONMENT"] = "test"
os.environ["FACTORIX_COOKIE_SECURE"] = "false"

from factorix.platform.settings import get_settings  # noqa: E402

get_settings.cache_clear()
import factorix.platform.db as db_module  # noqa: E402

db_module._engine = None
db_module._session_factory = None

from sqlalchemy import text  # noqa: E402

from factorix.application.dashboards import sources as dashboard_sources  # noqa: E402
from factorix.platform.db import session_factory  # noqa: E402
from factorix.transport.app import app  # noqa: E402
from tests.safety.test_destructive_guard import check_destructive_test_db_guard  # noqa: E402

BASE = "/api/v1/dashboards"


@pytest.fixture(autouse=True)
async def _close_pool_between_tests():
    yield
    try:
        await _wipe()
    except Exception:
        pass
    engine = db_module._engine
    db_module._engine = None
    db_module._session_factory = None
    if engine is not None:
        await engine.dispose()


async def _wipe() -> None:
    settings = get_settings()
    check_destructive_test_db_guard(settings.database_url, os.environ.get("FACTORIX_ENABLE_DESTRUCTIVE_TESTS"))
    async with session_factory()() as session:
        await session.execute(text(
            """
            TRUNCATE TABLE
              tenants, sites, admin_accounts, sessions, login_throttle, password_reset_codes,
              resource_types, resources, relation_types, resource_relations, type_adjacency,
              hierarchy_templates, hierarchy_views,
              signal_definitions, signal_bindings, output_groups, output_group_members, model_refs, model_snapshots, model_state,
              dashboards, dashboard_revisions, dashboard_templates, audit_events, telemetry_generations
            RESTART IDENTITY CASCADE
            """
        ))
        await session.commit()


async def _sql(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    async with session_factory()() as session:
        result = await session.execute(text(sql), params or {})
        rows = [dict(r) for r in result.mappings().all()] if result.returns_rows else []
        await session.commit()
        return rows


async def _signal(tenant_id: str, resource_id: str, key: str, data_type: str, *, status: str = "ACTIVE") -> str:
    sid = str(uuid4())
    now = datetime.now(timezone.utc)
    await _sql(
        """
        INSERT INTO signal_definitions (id, tenant_id, resource_id, key, display_name, description, data_type, unit, category,
                                        status, version, created_at, updated_at)
        VALUES (:id, :tenant_id, :resource_id, :key, :name, '', :data_type, :unit, 'COLLECTED', :status, 1, :now, :now)
        """,
        {"id": sid, "tenant_id": tenant_id, "resource_id": resource_id, "key": key, "name": key.replace("_", " ").title(),
         "data_type": data_type, "unit": "rpm" if data_type == "float64" else None, "status": status, "now": now},
    )
    return sid


async def _other_tenant() -> dict[str, str]:
    """A second tenant (SQL only: bootstrap creates one tenant) with a resource, a signal, a dashboard and a template."""
    ids = {k: str(uuid4()) for k in ("tenant", "admin", "type", "resource", "dashboard", "template")}
    now = datetime.now(timezone.utc)
    await _sql("INSERT INTO tenants (id, code, display_name, created_at) VALUES (:tenant, 'other', 'Other', :now)", {**ids, "now": now})
    await _sql(
        "INSERT INTO admin_accounts (id, tenant_id, login, email, password_hash, created_at, disabled_at) "
        "VALUES (:admin, :tenant, 'other', 'other@example.com', 'x', :now, :now)", {**ids, "now": now})
    await _sql("INSERT INTO resource_types (id, tenant_id, key, name, category) VALUES (:type, :tenant, 'machine', 'Machine', 'ASSET')", ids)
    await _sql("INSERT INTO resources (id, tenant_id, type_id, code, name, created_at, updated_at) "
               "VALUES (:resource, :tenant, :type, 'FOREIGN', 'Foreign', :now, :now)", {**ids, "now": now})
    ids["signal"] = await _signal(ids["tenant"], ids["resource"], "speed_1", "float64")
    await _sql(
        "INSERT INTO dashboards (id, tenant_id, name, description, owner_admin_id, draft_revision, draft_json, version, created_at, updated_at) "
        "VALUES (:dashboard, :tenant, 'Foreign board', '', :admin, 1, '{\"widgets\": []}'::jsonb, 1, :now, :now)", {**ids, "now": now})
    await _sql(
        "INSERT INTO dashboard_templates (id, tenant_id, name, document_json, created_at, updated_at) "
        "VALUES (:template, :tenant, 'Foreign template', '{\"schema_version\": 1}'::jsonb, :now, :now)", {**ids, "now": now})
    return ids


async def _login(client: AsyncClient) -> dict[str, str]:
    created = await client.post(
        "/api/v1/auth/bootstrap", headers={"X-Bootstrap-Token": "integration-bootstrap-token"},
        json={"login": "fxadmin", "email": "fxadmin@example.com", "password": "Correct-Horse-9", "display_name": "FactoriX",
              "tenant_code": "primary"},
    )
    assert created.status_code == 201, created.text
    login = await client.post("/api/v1/auth/login", json={"login": "fxadmin", "password": "Correct-Horse-9"})
    assert login.status_code == 200, login.text
    return {"X-CSRF-Token": client.cookies.get("fx_csrf") or ""}


async def _factory(client: AsyncClient, headers: dict[str, str]) -> dict[str, str]:
    site = await client.post("/api/v1/sites", headers=headers, json={"code": "S1", "name": "Site 1", "timezone": "UTC"})
    assert site.status_code == 201, site.text
    site_id = site.json()["id"]
    parent = None
    out: dict[str, str] = {"site_row": site_id}
    for type_key, code in (("enterprise", "ENT"), ("site", "S1-SITE"), ("plant", "PLANT-1"), ("machine", "MA"), ("machine", "MB")):
        body: dict[str, Any] = {"type_key": type_key, "code": code, "name": code}
        if type_key != "enterprise":
            body["site_id"] = site_id
            body["parent_id"] = out["plant"] if type_key == "machine" else parent
        res = await client.post("/api/v1/resources", headers=headers, json=body)
        assert res.status_code == 201, res.text
        parent = res.json()["id"]
        out[code if type_key == "machine" else type_key] = parent
    return out


@pytest.mark.asyncio
async def test_migration_0013_columns_exist() -> None:
    cols = await _sql(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN "
        "('dashboards', 'dashboard_revisions', 'dashboard_templates')")
    have = {(c["table_name"], c["column_name"]) for c in cols}
    assert {("dashboard_revisions", "document_json"), ("dashboard_revisions", "published_by"), ("dashboard_revisions", "note"),
            ("dashboards", "published_at"), ("dashboards", "updated_by"), ("dashboard_templates", "roles_json"),
            ("dashboard_templates", "tenant_id")} <= have
    version = await _sql("SELECT version_num FROM alembic_version")
    assert version == [{"version_num": "0013_dashboard_studio"}]


@pytest.mark.asyncio
async def test_dashboard_studio_end_to_end() -> None:
    await _wipe()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as client:
        headers = await _login(client)
        tenant_id = str((await _sql("SELECT tenant_id FROM admin_accounts WHERE login = 'fxadmin'"))[0]["tenant_id"])
        res = await _factory(client, headers)
        speed_a = await _signal(tenant_id, res["MA"], "speed_1", "float64")
        state_a = await _signal(tenant_id, res["MA"], "state", "string")
        speed_b = await _signal(tenant_id, res["MB"], "speed_1", "float64")
        old_a = await _signal(tenant_id, res["MA"], "old", "float64", status="ARCHIVED")
        model = await client.post("/api/v1/data-models", headers=headers, json={"name": "Spindle", "spec": {"version": 2, "root": {
            "type": "object", "children": [{"key": "speed", "type": "field", "mode": "mapping", "ref": {"signal_id": speed_a}}]}}})
        assert model.status_code == 201, model.text
        model_id = model.json()["id"]
        other = await _other_tenant()

        # ---- registry, themes, templates, sources
        types = (await client.get(f"{BASE}/widget-types")).json()
        assert len(types["widget_types"]) == 17 and types["limits"]["max_widgets"] == 40
        assert len((await client.get(f"{BASE}/themes")).json()["items"]) == 3
        templates = (await client.get(f"{BASE}/templates")).json()["items"]
        assert all(t["builtin"] for t in templates)  # the other tenant's template is not visible
        catalog = (await client.get(f"{BASE}/sources")).json()
        tokens = {s["token"] for g in catalog["items"] for s in g["signals"]}
        assert {speed_a, state_a, speed_b} <= tokens and old_a not in tokens and other["signal"] not in tokens
        fields = [f for g in catalog["items"] for m in g["models"] for f in m["fields"]]
        assert [f["source"] for f in fields] == [{"kind": "model_field", "model_id": model_id, "field_path": "speed"}]
        assert {r["id"] for r in catalog["resources"]} >= {res["MA"], res["MB"]} and other["resource"] not in {r["id"] for r in catalog["resources"]}
        assert all("subtables" not in g for g in catalog["items"])

        # ---- resolve
        resolved = (await client.post(f"{BASE}/resolve", headers=headers, json={"variables": {"machine": res["MB"]}, "sources": [
            {"kind": "signal", "signal_id": speed_a}, {"kind": "signal_key", "variable": "machine", "key": "speed_1"},
            {"kind": "model_field", "model_id": model_id, "field_path": "/speed"}, {"kind": "signal", "signal_id": other["signal"]},
            {"kind": "signal", "signal_id": old_a}, {"kind": "model_field", "model_id": model_id, "field_path": "nope"},
            {"kind": "signal_key", "variable": "machine", "key": "state"},
        ]})).json()["items"]
        assert resolved[0]["token"] == speed_a and resolved[0]["resource"]["id"] == res["MA"] and resolved[0]["value_kind"] == "number"
        assert resolved[1]["signal_id"] == speed_b
        assert resolved[2]["token"] == f"mod:{model_id}:speed" and resolved[2]["value_kind"] == "number"
        assert [r.get("error", {}).get("code") for r in resolved[3:]] == ["NOT_FOUND", "ARCHIVED", "FIELD_NOT_FOUND", "KEY_NOT_ON_RESOURCE"]
        caps = resolved[0]["capabilities"]
        assert caps == dashboard_sources.signal_capabilities(recorded=False, state=dashboard_sources.history_state())

        # ---- create from a template, edit, validate, publish
        created = await client.post(BASE, headers=headers, json={"name": "Machine", "template_id": "machine_overview", "role_map": {
            "main_value": {"kind": "signal_key", "variable": "machine", "key": "speed_1"},
            "machine_state": {"kind": "signal", "signal_id": state_a}}})
        assert created.status_code == 201, created.text
        d = created.json()
        assert {w["code"] for w in d["warnings"]} >= {"VARIABLE_UNSET"}
        doc = d["document"]
        doc["variables"][0]["default"] = res["MA"]
        # Keep only widgets that need no history, so publishing does not depend on the history configuration of the run.
        doc["widgets"] = [w for w in doc["widgets"] if w["type"] in ("equipment", "latest_table")] + [{
            "id": "w_speed", "type": "kpi", "title": "Speed", "layout": {"lg": {"x": 3, "y": 0, "w": 3, "h": 3}},
            "bindings": [{"id": "b_1", "source": {"kind": "signal", "signal_id": speed_a}}],
            "options": {"thresholds": [{"value": 100, "color": "#FF0000"}]}}]
        saved = await client.patch(f"{BASE}/{d['id']}", headers=headers, json={"version": d["version"], "document": doc})
        assert saved.status_code == 200, saved.text
        d = saved.json()
        assert d["draft_revision"] == 2 and d["has_unpublished_changes"] is True
        stale = await client.patch(f"{BASE}/{d['id']}", headers=headers, json={"version": 1, "name": "x"})
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "RESOURCE_VERSION_CONFLICT"
        invalid = await client.patch(f"{BASE}/{d['id']}", headers=headers, json={"version": d["version"], "document": {
            "schema_version": 1, "widgets": [{"id": "w_bad", "type": "kpi", "layout": {"lg": {"x": 11, "y": 0, "w": 3, "h": 3}}}]}})
        assert invalid.status_code == 422 and invalid.json()["error"]["details"]["issues"][0]["code"] == "LAYOUT"
        validated = (await client.post(f"{BASE}/{d['id']}/validate", headers=headers, json={})).json()
        assert validated["ok"] is True, validated
        published = await client.post(f"{BASE}/{d['id']}/publish", headers=headers, json={"version": d["version"], "note": "first"})
        assert published.status_code == 200, published.text
        p1 = published.json()
        assert p1["published_revision"] == 1 and p1["status"] == "PUBLISHED" and p1["has_unpublished_changes"] is False
        row = (await _sql("SELECT published_by, note, document_json, widget_configs_json, breakpoints_json FROM dashboard_revisions"))[0]
        assert str(row["published_by"]) == str((await _sql("SELECT id FROM admin_accounts WHERE login = 'fxadmin'"))[0]["id"])
        assert row["note"] == "first" and row["breakpoints_json"] == {"lg": 12, "md": 6, "sm": 1}
        assert row["widget_configs_json"] == p1["document"]["widgets"] and row["document_json"] == p1["document"]

        listed = (await client.get(BASE)).json()["items"]
        assert [(i["name"], i["status"], i["has_unpublished_changes"], i["widget_count"]) for i in listed] == [("Machine", "PUBLISHED", False, 3)]
        doc2 = json.loads(json.dumps(p1["document"]))
        doc2["settings"]["theme"]["preset"] = "control_room_dark"
        edited = (await client.patch(f"{BASE}/{d['id']}", headers=headers, json={"version": p1["version"], "document": doc2})).json()
        listed = (await client.get(BASE)).json()["items"]
        assert listed[0]["has_unpublished_changes"] is True and listed[0]["theme_preset"] == "control_room_dark"
        view = (await client.get(f"{BASE}/{d['id']}/published")).json()
        assert view["revision"] == 1 and view["document"]["settings"]["theme"]["preset"] == "factorix_light"
        p2 = (await client.post(f"{BASE}/{d['id']}/publish", headers=headers, json={"version": edited["version"]})).json()
        assert p2["published_revision"] == 2
        revisions = (await client.get(f"{BASE}/{d['id']}/revisions")).json()["items"]
        assert [(r["revision"], r["widget_count"], r["note"]) for r in revisions] == [(2, 3, ""), (1, 3, "first")]
        assert all(r["published_by_name"] for r in revisions)
        restored = await client.post(f"{BASE}/{d['id']}/restore", headers=headers, json={"revision": 1, "version": p2["version"]})
        assert restored.status_code == 200 and restored.json()["document"]["settings"]["theme"]["preset"] == "factorix_light"
        assert len((await client.get(f"{BASE}/{d['id']}/revisions")).json()["items"]) == 2

        # ---- duplicate, archive, export/import, templates
        dup = await client.post(f"{BASE}/{d['id']}/duplicate", headers=headers, json={"name": "Machine copy"})
        assert dup.status_code == 201 and dup.json()["published_revision"] is None
        current = restored.json()
        archived = await client.post(f"{BASE}/{d['id']}/archive", headers=headers, json={"version": current["version"]})
        assert archived.status_code == 200 and archived.json()["archived_at"]
        assert [i["name"] for i in (await client.get(BASE)).json()["items"]] == ["Machine copy"]
        assert len((await client.get(BASE, params={"include_archived": "true"})).json()["items"]) == 2
        assert (await client.patch(f"{BASE}/{d['id']}", headers=headers, json={"version": archived.json()["version"], "name": "x"})).status_code == 409
        back = await client.post(f"{BASE}/{d['id']}/unarchive", headers=headers, json={"version": archived.json()["version"]})
        assert back.status_code == 200 and back.json()["archived_at"] is None
        exported = (await client.get(f"{BASE}/{d['id']}/export")).json()
        imported = await client.post(f"{BASE}/import", headers=headers, json={"name": "Imported", "payload": exported})
        assert imported.status_code == 201 and imported.json()["document"] == exported["document"]
        foreign_payload = json.loads(json.dumps(exported))
        foreign_payload["document"]["widgets"][-1]["bindings"][0]["source"]["signal_id"] = other["signal"]
        warned = (await client.post(f"{BASE}/import", headers=headers, json={"payload": foreign_payload})).json()
        assert [w["code"] for w in warned["warnings"]] == ["NOT_FOUND"]
        template = await client.post(f"{BASE}/templates", headers=headers, json={"dashboard_id": d["id"], "name": "Mine"})
        assert template.status_code == 201, template.text
        tpl = template.json()
        assert tpl["builtin"] is False and tpl["roles"] and tpl["variables"][0]["default"] is None
        assert tpl["id"] in {t["id"] for t in (await client.get(f"{BASE}/templates")).json()["items"]}
        from_tpl = await client.post(BASE, headers=headers, json={"name": "From mine", "template_id": tpl["id"]})
        assert from_tpl.status_code == 201 and {w["code"] for w in from_tpl.json()["warnings"]} == {"UNBOUND"}
        assert (await client.delete(f"{BASE}/templates/{other['template']}", headers=headers)).status_code == 404
        assert (await client.delete(f"{BASE}/templates/{tpl['id']}", headers=headers)).status_code == 204

        # ---- tenant isolation
        assert (await client.get(f"{BASE}/{other['dashboard']}")).status_code == 404
        assert (await client.patch(f"{BASE}/{other['dashboard']}", headers=headers, json={"version": 1, "name": "hijack"})).status_code == 404
        assert other["dashboard"] not in {i["id"] for i in (await client.get(BASE, params={"include_archived": "true"})).json()["items"]}
        assert (await _sql("SELECT name FROM dashboards WHERE id = :id", {"id": other["dashboard"]}))[0]["name"] == "Foreign board"

        # ---- audit trail
        events = [r["event_type"] for r in await _sql("SELECT event_type FROM audit_events WHERE entity_type IN ('dashboard', 'dashboard_template')")]
        for event in ("DASHBOARD_CREATE", "DASHBOARD_UPDATE", "DASHBOARD_PUBLISH", "DASHBOARD_RESTORE", "DASHBOARD_DUPLICATE",
                      "DASHBOARD_ARCHIVE", "DASHBOARD_UNARCHIVE", "DASHBOARD_IMPORT", "DASHBOARD_TEMPLATE_CREATE", "DASHBOARD_TEMPLATE_DELETE"):
            assert event in events, event


@pytest.mark.asyncio
async def test_legacy_rows_keep_working() -> None:
    """Rows written before migration 0013: a ``{"widgets": [...]}`` draft and a revision without ``document_json``."""
    await _wipe()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as client:
        headers = await _login(client)
        admin = (await _sql("SELECT id, tenant_id FROM admin_accounts WHERE login = 'fxadmin'"))[0]
        res = await _factory(client, headers)
        speed = await _signal(str(admin["tenant_id"]), res["MA"], "speed_1", "float64")
        dashboard_id = str(uuid4())
        legacy = json.dumps({"widgets": [{"id": "w1", "type": "kpi", "bindings": [{"signal_id": speed}]}]})
        now = datetime.now(timezone.utc)
        await _sql(
            "INSERT INTO dashboards (id, tenant_id, name, description, owner_admin_id, draft_revision, published_revision, draft_json, "
            "version, created_at, updated_at) VALUES (:id, :tenant, 'Legacy', '', :admin, 2, 1, CAST(:draft AS jsonb), 3, :now, :now)",
            {"id": dashboard_id, "tenant": admin["tenant_id"], "admin": admin["id"], "draft": legacy, "now": now})
        await _sql(
            "INSERT INTO dashboard_revisions (id, dashboard_id, revision, breakpoints_json, widget_configs_json, created_at, published_at) "
            "VALUES (:id, :dashboard, 1, '{\"lg\": 12, \"md\": 6, \"sm\": 1}'::jsonb, CAST(:widgets AS jsonb), :now, :now)",
            {"id": str(uuid4()), "dashboard": dashboard_id, "widgets": json.dumps(json.loads(legacy)["widgets"]), "now": now})
        detail = (await client.get(f"{BASE}/{dashboard_id}")).json()
        assert detail["document"]["schema_version"] == 1 and detail["document"]["widgets"][0]["id"] == "w_legacy_1"
        assert detail["upgrade_notes"] and detail["has_unpublished_changes"] is True and detail["status"] == "PUBLISHED"
        listed = (await client.get(BASE)).json()["items"]
        assert listed[0]["widget_count"] == 1 and listed[0]["theme_preset"] == "factorix_light"
        view = (await client.get(f"{BASE}/{dashboard_id}/published")).json()
        assert view["revision"] == 1 and view["document"]["widgets"][0]["bindings"][0]["source"] == {"kind": "signal", "signal_id": speed}
        assert (await client.get(f"{BASE}/{dashboard_id}/revisions")).json()["items"][0]["note"] == ""
        published = await client.post(f"{BASE}/{dashboard_id}/publish", headers=headers, json={"version": 3})
        assert published.status_code == 200, published.text
        assert published.json()["published_revision"] == 2 and published.json()["upgrade_notes"] == []
