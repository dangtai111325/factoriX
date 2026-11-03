"""Preview, reuse and atomic import through HTTP against disposable Postgres."""

import asyncio
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text

from test_support.center import authenticated_center


@pytest_asyncio.fixture
async def client():
    async with authenticated_center() as authenticated:
        yield authenticated


ROWS = [
    {"path": "E/DN/L/M", "name": "Machine", "type_key": "machine", "properties": {"serial": "0007", "zero": 0}},
    {"path": "E/DN/L", "name": "Line", "type_key": "line"},
    {"path": "E/DN", "name": "Site", "type_key": "site"},
    {"path": "E", "name": "Enterprise", "type_key": "enterprise"},
]


async def preview(client, rows=ROWS, **options):
    response = await client.post("/api/v1/resources/import", json={"rows": rows, **options})
    assert response.status_code == 200, response.text
    return response.json()


async def commit(client, plan, rows=ROWS, **options):
    return await client.post("/api/v1/resources/import", json={
        "rows": rows, "dry_run": False, "plan_hash": plan["plan_hash"], **options,
    })


async def resources(client):
    return (await client.get("/api/v1/resources?view=all")).json()["items"]


@pytest.mark.asyncio
async def test_preview_is_read_only_and_commit_resolves_reverse_order_with_atomic_site(client):
    plan = await preview(client)
    assert plan["dry_run"] is True and plan["accepted"] == 4
    assert [item["path"] for item in plan["items"]] == ["E", "E/DN", "E/DN/L", "E/DN/L/M"]
    assert {item["action"] for item in plan["items"]} == {"CREATE"}
    assert len(plan["plan_hash"]) == 64
    assert await resources(client) == []
    assert (await client.get("/api/v1/sites")).json()["items"] == []
    assert (await client.get("/api/v1/edges")).json()["items"] == []
    response = await commit(client, plan)
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 4 and response.json()["reused"] == 0
    nodes = {node["code"]: node for node in await resources(client)}
    assert nodes["DN"]["parent_id"] == nodes["E"]["id"]
    assert nodes["L"]["parent_id"] == nodes["DN"]["id"]
    assert nodes["M"]["parent_id"] == nodes["L"]["id"]
    assert nodes["DN"]["site_id"] == nodes["L"]["site_id"] == nodes["M"]["site_id"]
    machine = (await client.get(f"/api/v1/resources/{nodes['M']['id']}")).json()
    assert machine["properties_json"] == {"serial": "0007", "zero": 0}
    scopes = (await client.get("/api/v1/sites")).json()["items"]
    assert len(scopes) == 1 and scopes[0]["resource_id"] == nodes["DN"]["id"]
    assert (await client.get("/api/v1/edges")).json()["items"] == []


@pytest.mark.asyncio
async def test_existing_identity_is_reused_without_updating_any_metadata_or_version(client):
    response = await client.post("/api/v1/resources", json={
        "type_key": "enterprise", "code": "E", "name": "Keep", "description": "Original",
        "properties": {"serial": "0001", "flag": False}, "tags": ["original"],
    })
    assert response.status_code == 201, response.text
    original = response.json()
    rows = [{"path": "E", "name": "Incoming", "type_key": "enterprise", "description": "",
             "properties": {"serial": "9999", "flag": 0}, "tags": ["incoming"]}]
    plan = await preview(client, rows)
    item = plan["items"][0]
    assert item["action"] == "REUSE" and item["existing_id"] == original["id"]
    assert set(item["differences"]) == {"name", "description", "properties", "tags"}
    response = await commit(client, plan, rows)
    assert response.status_code == 200 and response.json()["reused"] == 1, response.text
    stored = (await client.get(f"/api/v1/resources/{original['id']}")).json()
    for key in ("name", "description", "properties_json", "tags_json", "version", "updated_at"):
        assert stored[key] == original[key]


@pytest.mark.asyncio
async def test_retry_and_concurrent_same_preview_never_create_duplicate_resources(client):
    plan = await preview(client)
    responses = await asyncio.gather(commit(client, plan), commit(client, plan))
    assert [response.status_code for response in responses] == [200, 200], [response.text for response in responses]
    assert sorted(response.json()["created"] for response in responses) == [0, 4]
    assert sorted(response.json()["reused"] for response in responses) == [0, 4]
    assert len(await resources(client)) == 4
    retry = await commit(client, plan)
    assert retry.status_code == 200 and retry.json()["created"] == 0, retry.text


@pytest.mark.asyncio
async def test_stale_preview_with_new_rows_requires_review_again_and_unrelated_changes_do_not(client):
    root = await client.post("/api/v1/resources", json={"type_key": "enterprise", "code": "E", "name": "Enterprise"})
    assert root.status_code == 201, root.text
    rows = [{"path": "E", "name": "Enterprise", "type_key": "enterprise"},
            {"path": "E/DN", "name": "Site", "type_key": "site"}]
    plan = await preview(client, rows)
    changed = await client.patch(f"/api/v1/resources/{root.json()['id']}", json={"version": 1, "name": "Edited"})
    assert changed.status_code == 200, changed.text
    stale = await commit(client, plan, rows)
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "IMPORT_STALE", stale.text
    assert len(await resources(client)) == 1
    fresh = await preview(client, rows)
    other = await client.post("/api/v1/resources", json={"type_key": "enterprise", "code": "Other", "name": "Other"})
    assert other.status_code == 201, other.text
    accepted = await commit(client, fresh, rows)
    assert accepted.status_code == 200 and accepted.json()["created"] == 1, accepted.text


@pytest.mark.asyncio
async def test_invalid_preview_and_commit_without_preview_leave_no_partial_model(client):
    rows = [*ROWS, {"path": "E/Missing/Child", "name": "Child", "type_key": "machine", "source_row": 42}]
    invalid = await client.post("/api/v1/resources/import", json={"rows": rows})
    assert invalid.status_code == 422, invalid.text
    assert any(error["row"] == 42 and error["code"] == "MISSING_PARENT" for error in invalid.json()["error"]["row_errors"])
    missing = await client.post("/api/v1/resources/import", json={"rows": ROWS, "dry_run": False})
    assert missing.status_code == 409 and missing.json()["error"]["code"] == "PREVIEW_REQUIRED", missing.text
    assert await resources(client) == []
    assert (await client.get("/api/v1/sites")).json()["items"] == []


@pytest.mark.asyncio
async def test_mid_commit_failure_rolls_back_resources_site_and_audit(client, monkeypatch):
    from factorix.modules import resources as owner
    from factorix.platform.errors import AppError

    plan = await preview(client)
    create = owner.create_resource

    async def fail_line(*args, **kwargs):
        body = args[3]
        if body.code == "L":
            raise AppError(503, "IMPORT_TEST_FAILURE", "Controlled failure after creating the Site.")
        return await create(*args, **kwargs)

    monkeypatch.setattr(owner, "create_resource", fail_line)
    response = await commit(client, plan)
    assert response.status_code == 503, response.text
    assert await resources(client) == []
    assert (await client.get("/api/v1/sites")).json()["items"] == []
    from factorix.platform.db import session_factory

    async with session_factory()() as session:
        count = await session.execute(text("SELECT count(*) FROM audit_events WHERE event_type IN ('RESOURCE_CREATE', 'SITE_CREATE', 'RESOURCE_IMPORT')"))
        assert count.scalar_one() == 0


@pytest.mark.asyncio
async def test_parent_ids_are_tenant_scoped_and_foreign_names_are_not_exposed(client):
    from factorix.platform.db import session_factory

    tenant_id, resource_id, type_id = uuid4(), uuid4(), uuid4()
    async with session_factory()() as session:
        await session.execute(text("INSERT INTO tenants (id, code, display_name, created_at) VALUES (:id, 'foreign', 'Private tenant', now())"), {"id": tenant_id})
        await session.execute(text("INSERT INTO resource_types (id, tenant_id, key, name, category) VALUES (:id, :tenant, 'enterprise', 'Enterprise', 'ENTERPRISE')"), {"id": type_id, "tenant": tenant_id})
        await session.execute(text("INSERT INTO resources (id, tenant_id, type_id, code, name, status, version, created_at, updated_at) VALUES (:id, :tenant, :type, 'Private', 'Private enterprise', 'ACTIVE', 1, now(), now())"), {"id": resource_id, "tenant": tenant_id, "type": type_id})
        await session.commit()
    response = await client.post("/api/v1/resources/import", json={
        "rows": [{"code": "S", "name": "Site", "type_key": "site", "parent_id": str(resource_id)}],
    })
    assert response.status_code == 422, response.text
    assert "Private enterprise" not in response.text and "Private tenant" not in response.text
    assert any(error["code"] == "MISSING_PARENT" for error in response.json()["error"]["row_errors"])
    assert await resources(client) == []


@pytest.mark.asyncio
async def test_repeated_site_and_machine_codes_use_full_paths_and_separate_site_scopes(client):
    rows = [
        {"path": f"{enterprise}{suffix}", "name": name, "type_key": kind}
        for enterprise in ("E1", "E2")
        for suffix, name, kind in (("", "Enterprise", "enterprise"), ("/DongNai", "Dong Nai", "site"),
                                    ("/DongNai/M", "Machine", "machine"))
    ]
    plan = await preview(client, rows)
    response = await commit(client, plan, rows)
    assert response.status_code == 200 and response.json()["created"] == 6, response.text
    scopes = (await client.get("/api/v1/sites")).json()["items"]
    assert len(scopes) == 2 and scopes[0]["id"] != scopes[1]["id"]
    machines = [node for node in await resources(client) if node["type_key"] == "machine"]
    assert len(machines) == 2 and machines[0]["parent_id"] != machines[1]["parent_id"]
    assert machines[0]["site_id"] != machines[1]["site_id"]
    ambiguous = await client.post("/api/v1/resources/import", json={"rows": [
        {"code": "Child", "name": "Child", "type_key": "sensor", "parent_code": "M"},
    ]})
    assert ambiguous.status_code == 422, ambiguous.text
    assert any(error["code"] == "AMBIGUOUS_PARENT" for error in ambiguous.json()["error"]["row_errors"])


@pytest.mark.asyncio
async def test_archived_identity_stays_reserved_and_import_does_not_restore_it(client):
    plan = await preview(client)
    response = await commit(client, plan)
    assert response.status_code == 200, response.text
    machine = next(node for node in await resources(client) if node["code"] == "M")
    archived = await client.post(f"/api/v1/resources/{machine['id']}/archive", json={"version": 1})
    assert archived.status_code == 200, archived.text
    rejected = await client.post("/api/v1/resources/import", json={"rows": ROWS})
    assert rejected.status_code == 422, rejected.text
    assert any(error["code"] == "ARCHIVED" for error in rejected.json()["error"]["row_errors"])
    stored = (await client.get(f"/api/v1/resources/{machine['id']}")).json()
    assert stored["status"] == "ARCHIVED" and stored["version"] == 2
    assert stored["properties_json"] == {"serial": "0007", "zero": 0}


@pytest.mark.asyncio
async def test_strict_import_uses_actual_custom_type_recommendations(client):
    response = await client.post("/api/v1/resource-types", json={
        "key": "pump", "name": "Process pump", "parent_type_keys": ["area"],
    })
    assert response.status_code == 201, response.text
    rows = [
        {"path": "E", "name": "Enterprise", "type_key": "enterprise"},
        {"path": "E/S", "name": "Site", "type_key": "site"},
        {"path": "E/S/A", "name": "Area", "type_key": "area"},
        {"path": "E/S/A/P", "name": "Pump", "type_key": "pump"},
    ]
    plan = await preview(client, rows, hierarchy_mode="strict")
    assert plan["warnings"] == []
    result = await commit(client, plan, rows, hierarchy_mode="strict")
    assert result.status_code == 200 and result.json()["created"] == 4, result.text
    invalid = await client.post("/api/v1/resources/import", json={
        "rows": [{"path": "E/S/Direct", "name": "Direct pump", "type_key": "pump"}], "hierarchy_mode": "strict",
    })
    assert invalid.status_code == 422, invalid.text
    assert any(error["code"] == "ADJACENCY" for error in invalid.json()["error"]["row_errors"])
