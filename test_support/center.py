"""Authenticated API fixtures that are guarded from ever resetting a live DB."""

from contextlib import asynccontextmanager

from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from test_support.database import require_disposable_database


async def wipe_database():
    from factorix.platform.db import session_factory
    from factorix.platform.settings import get_settings

    require_disposable_database(get_settings().database_url)
    async with session_factory()() as session:
        await session.execute(text("""
            TRUNCATE tenants, sites, admin_accounts, sessions, login_throttle, password_reset_codes,
              resource_types, resources, relation_types, resource_relations, type_adjacency,
              hierarchy_templates, hierarchy_views, layout_definitions, layout_revisions,
              edge_nodes, edge_enrollment_tokens, appliance_bindings, secret_store, connections, acquisition_jobs,
              source_fields, signal_definitions, signal_bindings, mapping_definitions,
              formula_definitions, formula_dependencies, output_groups, output_group_members,
              configuration_drafts, configuration_releases, deployment_events, commissioning_jobs,
              observations, ingest_dedup, latest_signal_state, observation_quarantine,
              dashboards, dashboard_revisions, retention_policies, retention_jobs,
              saved_queries, audit_events, export_jobs RESTART IDENTITY CASCADE
        """))
        await session.commit()


@asynccontextmanager
async def authenticated_center():
    import factorix.platform.db as database
    from factorix.transport.app import app

    await wipe_database()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as client:
            response = await client.post("/api/v1/auth/bootstrap", headers={"X-Bootstrap-Token": "integration-bootstrap-token"}, json={
                "login": "model-tester", "email": "model-tester@example.com", "password": "Model-Tests-2026!",
                "display_name": "Factory model tests", "tenant_code": "model-tests",
            })
            assert response.status_code == 201, response.text
            response = await client.post("/api/v1/auth/login", json={"login": "model-tester", "password": "Model-Tests-2026!"})
            assert response.status_code == 200, response.text
            client.headers["X-CSRF-Token"] = client.cookies["fx_csrf"]
            yield client
    finally:
        engine = database._engine
        database._engine = database._session_factory = None
        if engine is not None:
            await engine.dispose()
