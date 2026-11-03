"""Asset identity, guided hierarchy and atomic Site creation against real Postgres."""

import asyncio

import pytest
import pytest_asyncio

from test_support.center import authenticated_center


@pytest_asyncio.fixture
async def model():
    async with authenticated_center() as client:
        yield client


async def create(model, type_key, code, *, parent_id=None, site_id=None, **extra):
    response = await model.post("/api/v1/resources", json={
        "type_key": type_key, "code": code, "name": code, "parent_id": parent_id, "site_id": site_id, **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()


async def legacy_hierarchy(model):
    scope = await model.post("/api/v1/sites", json={"code": "DN", "name": "Dong Nai", "timezone": "Asia/Ho_Chi_Minh"})
    assert scope.status_code == 201, scope.text
    enterprise = await create(model, "enterprise", "E1")
    site = await create(model, "site", "DN", parent_id=enterprise["id"], site_id=scope.json()["id"])
    plant = await create(model, "plant", "P1", parent_id=site["id"], site_id=scope.json()["id"])
    a = await create(model, "line", "L1", parent_id=plant["id"], site_id=scope.json()["id"])
    b = await create(model, "line", "L2", parent_id=plant["id"], site_id=scope.json()["id"])
    return {"scope": scope.json(), "enterprise": enterprise, "site": site, "plant": plant, "a": a, "b": b}


@pytest.mark.asyncio
async def test_sibling_codes_allow_same_machine_code_under_different_lines(model):
    h = await legacy_hierarchy(model)
    one = await create(model, "machine", "M01", parent_id=h["a"]["id"], site_id=h["scope"]["id"])
    two = await create(model, "machine", "M01", parent_id=h["b"]["id"], site_id=h["scope"]["id"])
    assert one["id"] != two["id"]
    assert one["parent_id"] == h["a"]["id"] and two["parent_id"] == h["b"]["id"]
    duplicate = await model.post("/api/v1/resources", json={
        "type_key": "machine", "code": "M01", "name": "Duplicate", "parent_id": h["a"]["id"], "site_id": h["scope"]["id"],
    })
    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["error"]["code"] == "DUPLICATE"


@pytest.mark.asyncio
async def test_atomic_site_creation_allows_site_code_under_each_enterprise(model):
    a = await create(model, "enterprise", "E1")
    b = await create(model, "enterprise", "E2")
    one = await create(model, "site", "DN", parent_id=a["id"], name="Đồng Nai", timezone="Asia/Ho_Chi_Minh", create_edge=True)
    two = await create(model, "site", "DN", parent_id=b["id"], name="Đồng Nai", timezone="Asia/Ho_Chi_Minh", create_edge=True)
    assert one["site_id"] != two["site_id"]
    sites = (await model.get("/api/v1/sites")).json()["items"]
    assert len(sites) == 2
    assert {site["code"] for site in sites} == {"DN"}
    assert {site["resource_id"] for site in sites} == {one["id"], two["id"]}
    assert len((await model.get("/api/v1/edges")).json()["items"]) == 2
    duplicate = await model.post("/api/v1/resources", json={"type_key": "site", "code": "DN", "name": "Duplicate", "parent_id": a["id"], "create_edge": True})
    assert duplicate.status_code == 409
    assert len((await model.get("/api/v1/sites")).json()["items"]) == 2
    assert len((await model.get("/api/v1/edges")).json()["items"]) == 2


@pytest.mark.asyncio
async def test_guided_hierarchy_warns_and_strict_hierarchy_enforces_recommendations(model):
    h = await legacy_hierarchy(model)
    guided = await create(model, "machine", "Direct", parent_id=h["site"]["id"], site_id=h["scope"]["id"])
    assert any(item["code"] == "NOT_RECOMMENDED" for item in guided["warnings"])
    strict = await model.post("/api/v1/resources", json={"type_key": "machine", "code": "Strict", "name": "Strict",
        "parent_id": h["site"]["id"], "site_id": h["scope"]["id"], "hierarchy_mode": "strict"})
    assert strict.status_code == 422, strict.text
    assert strict.json()["error"]["code"] == "ADJACENCY"
    types = (await model.get("/api/v1/resource-types")).json()["items"]
    assert any(item["key"] == "area" for item in types)


@pytest.mark.asyncio
async def test_move_updates_canonical_parent_version_and_temporal_history(model):
    h = await legacy_hierarchy(model)
    machine = await create(model, "machine", "M1", parent_id=h["a"]["id"], site_id=h["scope"]["id"])
    moved = await model.post(f"/api/v1/resources/{machine['id']}/move", json={"version": 1, "parent_id": h["b"]["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["parent_id"] == h["b"]["id"]
    assert moved.json()["version"] == 2
    stale = await model.post(f"/api/v1/resources/{machine['id']}/move", json={"version": 1, "parent_id": h["a"]["id"]})
    assert stale.status_code == 409
    cyclic = await model.post(f"/api/v1/resources/{h['enterprise']['id']}/move", json={"version": 1, "parent_id": machine["id"]})
    assert cyclic.status_code == 422 and cyclic.json()["error"]["code"] == "CYCLE", cyclic.text
    graph = (await model.get(f"/api/v1/graph/neighbors?resource_id={machine['id']}&depth=1")).json()
    current = [edge for edge in graph["edges"] if edge["relation_code"] == "CONTAINS" and edge["to_id"] == machine["id"]]
    assert len(current) == 1 and current[0]["from_id"] == h["b"]["id"]


@pytest.mark.asyncio
async def test_invalid_site_request_leaves_no_partial_site_or_edge(model):
    enterprise = await create(model, "enterprise", "E1")
    response = await model.post("/api/v1/resources", json={"type_key": "site", "code": "DN", "name": "Dong Nai",
        "parent_id": enterprise["id"], "timezone": "Not/A_Timezone", "create_edge": True})
    assert response.status_code == 422
    assert not (await model.get("/api/v1/sites")).json()["items"]
    assert not (await model.get("/api/v1/edges")).json()["items"]


@pytest.mark.asyncio
async def test_patch_validates_names_and_rejects_duplicate_sibling_codes(model):
    h = await legacy_hierarchy(model)
    one = await create(model, "machine", "M1", parent_id=h["a"]["id"], site_id=h["scope"]["id"])
    two = await create(model, "machine", "M2", parent_id=h["a"]["id"], site_id=h["scope"]["id"])
    blank = await model.patch(f"/api/v1/resources/{one['id']}", json={"version": 1, "name": "   "})
    assert blank.status_code == 422, blank.text
    duplicate = await model.patch(f"/api/v1/resources/{two['id']}", json={"version": 1, "code": "M1"})
    assert duplicate.status_code == 409, duplicate.text
    renamed = await model.patch(f"/api/v1/resources/{one['id']}", json={"version": 1, "name": "Máy ép số 1", "description": "Đã đổi tên"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Máy ép số 1" and renamed.json()["code"] == "M1"


async def mqtt_connection(model, site):
    response = await model.post("/api/v1/connections", json={
        "name": "Shared source", "site_id": site["site_id"], "edge_id": site["edge"]["id"],
        "protocol": "mqtt_client", "config": {"host": "127.0.0.1", "anonymous": True, "topics": ["factory/#"]},
    })
    assert response.status_code == 201, response.text
    return response.json()


async def mapped_signal(model, resource, connection):
    return await model.post("/api/v1/signals/bulk", json={"resource_id": resource["id"], "items": [{
        "key": "speed", "name": "Speed", "data_type": "float64", "source_field": {
            "acquisition_job_id": connection["jobs"][0]["id"], "address_kind": "mqtt_jsonpath",
            "address": {"topic": "factory/m1/process", "jsonpath": "$.speed"},
        },
    }]})


@pytest.mark.asyncio
async def test_cross_site_move_blocks_subtree_with_paused_source_and_keeps_shared_connection(model):
    enterprise = await create(model, "enterprise", "E1")
    a = await create(model, "site", "A", parent_id=enterprise["id"], create_edge=True)
    b = await create(model, "site", "B", parent_id=enterprise["id"])
    line = await create(model, "line", "L1", parent_id=a["id"])
    machine = await create(model, "machine", "M1", parent_id=line["id"])
    other = await create(model, "machine", "M2", parent_id=a["id"])
    connection = await mqtt_connection(model, a)
    assert (await mapped_signal(model, machine, connection)).status_code == 201
    assert (await mapped_signal(model, other, connection)).status_code == 201
    assert (await model.post(f"/api/v1/connections/{connection['id']}/pause")).status_code == 200
    moved = await model.post(f"/api/v1/resources/{line['id']}/move", json={"version": 1, "parent_id": b["id"]})
    assert moved.status_code == 409, moved.text
    assert moved.json()["error"]["code"] == "SOURCE_REASSIGNMENT_REQUIRED"
    current = (await model.get(f"/api/v1/resources/{line['id']}")).json()
    assert current["parent_id"] == a["id"] and current["version"] == 1
    still = (await model.get(f"/api/v1/connections/{connection['id']}")).json()
    assert still["site_id"] == a["site_id"] and still["config"]["topics"] == ["factory/#"]


@pytest.mark.asyncio
async def test_mapping_free_subtree_move_changes_site_for_all_descendants(model):
    enterprise = await create(model, "enterprise", "E1")
    a = await create(model, "site", "A", parent_id=enterprise["id"])
    b = await create(model, "site", "B", parent_id=enterprise["id"])
    line = await create(model, "line", "L1", parent_id=a["id"])
    machine = await create(model, "machine", "M1", parent_id=line["id"])
    moved = await model.post(f"/api/v1/resources/{line['id']}/move", json={"version": 1, "parent_id": b["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["site_id"] == b["site_id"]
    child = (await model.get(f"/api/v1/resources/{machine['id']}")).json()
    assert child["site_id"] == b["site_id"] and child["version"] == 2
    assert [part["code"] for part in child["breadcrumb"]] == ["E1", "B", "L1", "M1"]


@pytest.mark.asyncio
async def test_mapping_cannot_attach_connection_from_another_site(model):
    a = await create(model, "site", "A", create_edge=True)
    b = await create(model, "site", "B")
    machine = await create(model, "machine", "M1", parent_id=b["id"])
    connection = await mqtt_connection(model, a)
    response = await mapped_signal(model, machine, connection)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "SITE_SCOPE"
    assert not (await model.get(f"/api/v1/signals?resource_id={machine['id']}")).json()["items"]


@pytest.mark.asyncio
async def test_concurrent_duplicate_creates_and_patches_have_one_winner(model):
    site = await create(model, "site", "S")
    payload = {"type_key": "machine", "code": "M1", "name": "Machine", "parent_id": site["id"]}
    responses = await asyncio.gather(*(model.post("/api/v1/resources", json=payload) for _ in range(2)))
    assert sorted(r.status_code for r in responses) == [201, 409]
    machine = next(r.json() for r in responses if r.status_code == 201)
    responses = await asyncio.gather(*(model.patch(f"/api/v1/resources/{machine['id']}", json={"version": 1, "name": name})
                                       for name in ("First", "Second")))
    assert sorted(r.status_code for r in responses) == [200, 409]


@pytest.mark.asyncio
async def test_resource_pagination_does_not_skip_same_codes_under_other_parents(model):
    a = await create(model, "site", "A")
    b = await create(model, "site", "B")
    one = await create(model, "machine", "M1", parent_id=a["id"])
    two = await create(model, "machine", "M1", parent_id=b["id"])
    seen = []
    cursor = None
    for _ in range(6):
        params = {"view": "all", "limit": 1}
        if cursor:
            params["cursor"] = cursor
        page = (await model.get("/api/v1/resources", params=params)).json()
        seen.extend(row["id"] for row in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(seen) == 4 and len(set(seen)) == 4
    assert one["id"] in seen and two["id"] in seen


@pytest.mark.asyncio
async def test_generic_relation_endpoint_cannot_bypass_versioned_hierarchy_move(model):
    h = await legacy_hierarchy(model)
    machine = await create(model, "machine", "M1", parent_id=h["a"]["id"])
    response = await model.post("/api/v1/resource-relations", json={"from_id": h["b"]["id"], "to_id": machine["id"], "relation_code": "CONTAINS"})
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "USE_RESOURCE_MOVE"
    assert (await model.get(f"/api/v1/resources/{machine['id']}")).json()["parent_id"] == h["a"]["id"]


@pytest.mark.asyncio
async def test_breadcrumb_keeps_every_level_beyond_32(model):
    current = await create(model, "site", "S")
    expected = ["S"]
    for level in range(35):
        code = f"A{level:02d}"
        current = await create(model, "area", code, parent_id=current["id"])
        expected.append(code)
    assert [part["code"] for part in current["breadcrumb"]] == expected


@pytest.mark.asyncio
async def test_concurrent_inverse_moves_cannot_create_a_cycle(model):
    site = await create(model, "site", "S")
    a = await create(model, "area", "A", parent_id=site["id"])
    b = await create(model, "area", "B", parent_id=site["id"])
    responses = await asyncio.gather(
        model.post(f"/api/v1/resources/{a['id']}/move", json={"version": 1, "parent_id": b["id"]}),
        model.post(f"/api/v1/resources/{b['id']}/move", json={"version": 1, "parent_id": a["id"]}),
    )
    assert sorted(r.status_code for r in responses) == [200, 422]
    assert next(r.json() for r in responses if r.status_code == 422)["error"]["code"] == "CYCLE"


@pytest.mark.asyncio
async def test_site_rename_keeps_uuid_and_edge_scope_and_site_move_keeps_mappings(model):
    enterprise = await create(model, "enterprise", "E1")
    second = await create(model, "enterprise", "E2")
    site = await create(model, "site", "DN", parent_id=enterprise["id"], create_edge=True)
    machine = await create(model, "machine", "M1", parent_id=site["id"])
    connection = await mqtt_connection(model, site)
    assert (await mapped_signal(model, machine, connection)).status_code == 201
    renamed = await model.patch(f"/api/v1/resources/{site['id']}", json={"version": 1, "name": "Đồng Nai mới", "code": "DN2"})
    assert renamed.status_code == 200, renamed.text
    scope = next(s for s in (await model.get("/api/v1/sites")).json()["items"] if s["id"] == site["site_id"])
    assert scope["name"] == "Đồng Nai mới" and scope["code"] == "DN2" and scope["resource_id"] == site["id"]
    moved = await model.post(f"/api/v1/resources/{site['id']}/move", json={"version": 2, "parent_id": second["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["site_id"] == site["site_id"]
    still = (await model.get(f"/api/v1/connections/{connection['id']}")).json()
    assert still["site_id"] == site["site_id"] and still["config"]["topics"] == ["factory/#"]


@pytest.mark.asyncio
async def test_physical_site_anchor_cannot_be_nested_in_another_site(model):
    a = await create(model, "site", "A")
    b = await create(model, "site", "B")
    moved = await model.post(f"/api/v1/resources/{a['id']}/move", json={"version": 1, "parent_id": b["id"]})
    assert moved.status_code == 422 and moved.json()["error"]["code"] == "SITE_SCOPE"
    assert (await model.get(f"/api/v1/resources/{a['id']}")).json()["parent_id"] is None


@pytest.mark.asyncio
async def test_custom_type_returns_recommendations_and_can_be_used_in_strict_mode(model):
    response = await model.post("/api/v1/resource-types", json={"key": "pump", "name": "Bơm", "category": "ASSET",
        "parent_type_keys": ["line"], "child_type_keys": ["sensor"]})
    assert response.status_code == 201, response.text
    catalog = (await model.get("/api/v1/resource-types")).json()["items"]
    pump = next(t for t in catalog if t["key"] == "pump")
    assert pump["name"] == "Bơm" and pump["is_system"] is False
    assert pump["parent_type_keys"] == ["line"] and pump["child_type_keys"] == ["sensor"]
    site = await create(model, "site", "S")
    line = await create(model, "line", "L", parent_id=site["id"])
    resource = await create(model, "pump", "Pump1", parent_id=line["id"], hierarchy_mode="strict")
    assert resource["type_key"] == "pump" and resource["warnings"] == []


@pytest.mark.asyncio
async def test_custom_type_with_unknown_recommended_parent_does_not_partially_save(model):
    response = await model.post("/api/v1/resource-types", json={"key": "pump", "name": "Pump", "parent_type_keys": ["typo"]})
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "UNKNOWN_TYPE"
    assert not any(t["key"] == "pump" for t in (await model.get("/api/v1/resource-types")).json()["items"])


@pytest.mark.asyncio
async def test_custom_type_rejects_blank_name_and_duplicate_key(model):
    blank = await model.post("/api/v1/resource-types", json={"key": "pump", "name": "  "})
    assert blank.status_code == 422, blank.text
    payload = {"key": "pump", "name": "Pump", "category": "ASSET"}
    assert (await model.post("/api/v1/resource-types", json=payload)).status_code == 201
    duplicate = await model.post("/api/v1/resource-types", json=payload)
    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["error"]["code"] == "DUPLICATE"


@pytest.mark.asyncio
async def test_model_listing_keeps_properties_description_and_dates_for_inspector(model):
    resource = await create(model, "site", "DN", description="Đồng Nai", properties={"serial": "0001", "enabled": False, "capacity": 0})
    page = (await model.get("/api/v1/resources", params={"view": "all"})).json()
    row = next(item for item in page["items"] if item["id"] == resource["id"])
    assert row["description"] == "Đồng Nai"
    assert row["properties_json"] == {"serial": "0001", "enabled": False, "capacity": 0}
    assert row["created_at"] == resource["created_at"] and row["updated_at"] == resource["updated_at"]


@pytest.mark.asyncio
async def test_archive_and_restore_are_versioned_and_require_an_active_parent(model):
    site = await create(model, "site", "S")
    machine = await create(model, "machine", "M", parent_id=site["id"])
    stale = await model.post(f"/api/v1/resources/{machine['id']}/archive", json={"version": 99})
    assert stale.status_code == 409, stale.text
    archived = await model.post(f"/api/v1/resources/{machine['id']}/archive", json={"version": 1})
    assert archived.status_code == 200 and archived.json()["status"] == "ARCHIVED"
    assert (await model.post(f"/api/v1/resources/{site['id']}/archive", json={"version": 1})).status_code == 200
    blocked = await model.post(f"/api/v1/resources/{machine['id']}/restore", json={"version": 2})
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "ARCHIVED_PARENT", blocked.text
    assert (await model.post(f"/api/v1/resources/{site['id']}/restore", json={"version": 2})).status_code == 200
    restored = await model.post(f"/api/v1/resources/{machine['id']}/restore", json={"version": 2})
    assert restored.status_code == 200 and restored.json()["version"] == 3
    assert restored.json()["parent_id"] == site["id"] and restored.json()["archived_at"] is None


async def enroll_edge(model, site):
    token = await model.post(f"/api/v1/edges/{site['edge']['id']}/enrollment-token")
    enrolled = await model.post("/api/v1/edge-sync/enroll", json={"enrollment_token": token.json()["enrollment_token"]})
    assert enrolled.status_code == 200, enrolled.text
    return {"Authorization": f"Bearer {enrolled.json()['credential']}"}


@pytest.mark.asyncio
async def test_archive_stops_only_one_assets_mappings_and_restore_keeps_latest_and_shared_source(model):
    from datetime import datetime, timezone

    site = await create(model, "site", "S", create_edge=True)
    one = await create(model, "machine", "M1", parent_id=site["id"])
    two = await create(model, "machine", "M2", parent_id=site["id"])
    connection = await mqtt_connection(model, site)
    s1 = (await mapped_signal(model, one, connection)).json()["created"][0]
    s2 = (await mapped_signal(model, two, connection)).json()["created"][0]
    headers = await enroll_edge(model, site)
    released = await model.post("/api/v1/config-releases/publish", json={"edge_id": site["edge"]["id"]})
    revision = released.json()["revision"]
    await model.post("/api/v1/edge-sync/ack", headers=headers, json={"revision": revision, "state": "ACTIVE", "diagnostic": ""})

    async def sample(signal, resource, value, uid):
        now = datetime.now(timezone.utc).isoformat()
        response = await model.post("/api/v1/edge-sync/observations", headers=headers, json={"observations": [{
            "event_uid": uid, "signal_id": signal, "resource_id": resource["id"], "connection_id": connection["id"],
            "event_time": now, "received_time": now, "data_type": "float64", "value": value,
            "quality": "GOOD", "origin": "LIVE", "config_revision": revision,
        }]})
        assert response.status_code == 200, response.text
        return response.json()["results"][0]["status"]

    assert await sample(s1, one, 0, "before-one") == "committed"
    formula = await model.post("/api/v1/formulas", json={"resource_id": one["id"], "key": "derived", "display_name": "Derived",
        "expression": "input + 1", "aliases": {"input": s2}})
    assert formula.status_code == 201, formula.text
    assert (await model.post(f"/api/v1/formulas/{formula.json()['id']}/publish")).status_code == 200
    derived = formula.json()["signal_id"]
    assert await sample(s2, two, 2, "before-two") == "committed"
    assert (await model.get(f"/api/v1/signals/{derived}/latest")).json()["value"] == 3
    archived = await model.post(f"/api/v1/resources/{one['id']}/archive", json={"version": 1})
    assert archived.status_code == 200, archived.text
    desired = (await model.get("/api/v1/edge-sync/config", headers=headers)).json()
    assert desired["revision"] > revision
    assert {binding["signal_id"] for binding in desired["snapshot"]["signal_bindings"]} == {s2}
    assert await sample(s1, one, 99, "late-one") == "quarantined"
    assert await sample(s2, two, 3, "during-two") == "committed"
    assert (await model.get(f"/api/v1/signals/{derived}/latest")).json()["value"] == 3
    assert (await model.get(f"/api/v1/signals/{s1}/latest")).json()["value"] == 0
    restored = await model.post(f"/api/v1/resources/{one['id']}/restore", json={"version": 2})
    assert restored.status_code == 200, restored.text
    desired = (await model.get("/api/v1/edge-sync/config", headers=headers)).json()
    assert {binding["signal_id"] for binding in desired["snapshot"]["signal_bindings"]} == {s1, s2}
    assert (await model.get(f"/api/v1/signals/{s1}/latest")).json()["value"] == 0
    still = (await model.get(f"/api/v1/connections/{connection['id']}")).json()
    assert still["config"]["topics"] == ["factory/#"] and still["status"] == "ACTIVE"


@pytest.mark.asyncio
async def test_edge_release_does_not_include_other_edges_bindings(model):
    a = await create(model, "site", "A", create_edge=True)
    b = await create(model, "site", "B", create_edge=True)
    one = await create(model, "machine", "M1", parent_id=a["id"])
    two = await create(model, "machine", "M2", parent_id=b["id"])
    c1 = await mqtt_connection(model, a)
    c2 = await mqtt_connection(model, b)
    s1 = (await mapped_signal(model, one, c1)).json()["created"][0]
    await mapped_signal(model, two, c2)
    headers = await enroll_edge(model, a)
    assert (await model.post("/api/v1/config-releases/publish", json={"edge_id": a["edge"]["id"]})).status_code == 201
    snapshot = (await model.get("/api/v1/edge-sync/config", headers=headers)).json()["snapshot"]
    assert {binding["signal_id"] for binding in snapshot["signal_bindings"]} == {s1}


@pytest.mark.asyncio
async def test_move_to_root_supports_undo_and_keeps_site_scope_identity(model):
    enterprise = await create(model, "enterprise", "E")
    site = await create(model, "site", "S", parent_id=enterprise["id"])
    moved = await model.post(f"/api/v1/resources/{site['id']}/move", json={"version": 1, "parent_id": None})
    assert moved.status_code == 200, moved.text
    assert moved.json()["parent_id"] is None and moved.json()["site_id"] == site["site_id"]
    assert [part["code"] for part in moved.json()["breadcrumb"]] == ["S"]
    undone = await model.post(f"/api/v1/resources/{site['id']}/move", json={"version": 2, "parent_id": enterprise["id"]})
    assert undone.status_code == 200, undone.text
    assert undone.json()["parent_id"] == enterprise["id"] and undone.json()["version"] == 3


@pytest.mark.asyncio
async def test_root_move_with_mapped_asset_requires_explicit_source_reassignment(model):
    site = await create(model, "site", "S", create_edge=True)
    machine = await create(model, "machine", "M", parent_id=site["id"])
    connection = await mqtt_connection(model, site)
    await mapped_signal(model, machine, connection)
    response = await model.post(f"/api/v1/resources/{machine['id']}/move", json={"version": 1, "parent_id": None})
    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "SOURCE_REASSIGNMENT_REQUIRED"


@pytest.mark.asyncio
async def test_strict_mode_applies_the_same_root_recommendation_as_the_ui(model):
    response = await model.post("/api/v1/resources", json={"type_key": "site", "code": "S", "name": "S", "hierarchy_mode": "strict"})
    assert response.status_code == 422 and response.json()["error"]["code"] == "ADJACENCY", response.text
    enterprise = await create(model, "enterprise", "E", hierarchy_mode="strict")
    site = await create(model, "site", "S", parent_id=enterprise["id"], hierarchy_mode="strict")
    moved = await model.post(f"/api/v1/resources/{site['id']}/move", json={"version": 1, "parent_id": None, "hierarchy_mode": "strict"})
    assert moved.status_code == 422 and moved.json()["error"]["code"] == "ADJACENCY", moved.text
