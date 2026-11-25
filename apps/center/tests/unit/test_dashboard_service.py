"""Dashboard Studio service: CRUD, validate, publish, revisions, restore, duplicate, archive, import/export, templates."""

from __future__ import annotations

import copy
from typing import Any
from uuid import UUID

import pytest

from _dashboard_fakes import (
    ACTOR,
    M1,
    MODEL,
    OTHER_TENANT,
    SIG_OLD,
    SIG_SPEED_1,
    SIG_STATE_1,
    TENANT,
    CatalogDB,
    DashboardStore,
    install_catalog,
    install_store,
)
from factorix.application.dashboards import registry as R
from factorix.application.dashboards import service as svc
from factorix.application.dashboards import templates as T
from factorix.application.dashboards.requests import (
    DashboardIn,
    DashboardPatch,
    DuplicateIn,
    ImportIn,
    PublishIn,
    ResolveIn,
    RestoreIn,
    TemplateIn,
    ValidateIn,
    VersionIn,
)
from factorix.platform.errors import AppError

SESSION = object()
CID = "cid-test"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> tuple[DashboardStore, CatalogDB]:
    store, db = DashboardStore(), CatalogDB()
    install_store(monkeypatch, store)
    install_catalog(monkeypatch, db)
    return store, db


def kpi(wid: str = "w_speed", signal_id: str = SIG_SPEED_1, **options: Any) -> dict[str, Any]:
    return {"id": wid, "type": "kpi", "title": "Speed", "layout": {"lg": {"x": 0, "y": 0, "w": 3, "h": 3}},
            "bindings": [{"id": "b_1", "source": {"kind": "signal", "signal_id": signal_id}}], "options": options}


def document(*widgets: dict[str, Any], **top: Any) -> dict[str, Any]:
    return {"schema_version": 1, "widgets": list(widgets), **top}


async def create(name: str = "Line A", **kw: Any) -> dict[str, Any]:
    return await svc.create_dashboard(SESSION, TENANT, ACTOR, DashboardIn(name=name, **kw), CID)


async def patch(d: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return await svc.patch_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), DashboardPatch(version=d["version"], **kw), CID)


async def publish(d: dict[str, Any], note: str = "") -> dict[str, Any]:
    return await svc.publish_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), PublishIn(version=d["version"], note=note), CID)


def events(store: DashboardStore) -> list[str]:
    return [a["event_type"] for a in store.audits]


async def raises(coro: Any) -> AppError:
    with pytest.raises(AppError) as exc:
        await coro
    return exc.value


# ---- create / read / update -------------------------------------------------------------------------------


async def test_create_list_detail(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await create(description="Assembly")
    assert d["status"] == "DRAFT" and d["version"] == 1 and d["draft_revision"] == 1 and d["published_revision"] is None
    assert d["document"]["schema_version"] == 1 and d["document"]["widgets"] == []
    assert d["has_unpublished_changes"] is True and d["warnings"] == [] and d["upgrade_notes"] == []
    listed = (await svc.list_dashboards(SESSION, TENANT))["items"]
    assert [(i["id"], i["status"], i["widget_count"], i["theme_preset"]) for i in listed] == [(d["id"], "DRAFT", 0, "factorix_light")]
    assert (await svc.list_dashboards(SESSION, OTHER_TENANT))["items"] == []
    assert (await svc.list_dashboards(SESSION, TENANT, q="nothing"))["items"] == []
    assert events(store) == ["DASHBOARD_CREATE"]
    assert store.audits[0]["tenant_id"] == TENANT and store.audits[0]["actor_id"] == ACTOR
    assert (await raises(svc.get_dashboard(SESSION, OTHER_TENANT, UUID(d["id"])))).status == 404
    assert (await raises(create(name="   "))).code == "VALIDATION"


async def test_patch_validates_and_uses_optimistic_concurrency(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await create()
    updated = await patch(d, name="Line B", document=document(kpi()))
    assert updated["version"] == 2 and updated["draft_revision"] == 2 and updated["name"] == "Line B"
    assert updated["document"]["widgets"][0]["options"]["value_mode"] == "latest"  # stored normalized
    stale = await raises(patch(d, name="Lost update"))
    assert stale.status == 409 and stale.code == "RESOURCE_VERSION_CONFLICT" and stale.extra["current_version"] == 2
    bad = await raises(patch(updated, document=document(kpi(), kpi())))
    assert bad.status == 422 and bad.code == "VALIDATION"
    assert [i["code"] for i in bad.extra["details"]["issues"]] == ["DUPLICATE_ID"]
    unknown = await raises(patch(updated, document=document({**kpi(), "options": {"sql": "SELECT 1"}})))
    assert unknown.extra["details"]["issues"][0]["code"] == "OPTION_UNKNOWN"
    # An incomplete draft (no binding yet) is saved; only publish refuses it.
    empty_kpi = {**kpi(), "bindings": []}
    assert (await patch(updated, document=document(empty_kpi)))["version"] == 3
    assert events(store) == ["DASHBOARD_CREATE", "DASHBOARD_UPDATE", "DASHBOARD_UPDATE"]


async def test_legacy_draft_is_upgraded_on_read(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await create()
    store.dashboards[d["id"]]["draft_json"] = {"widgets": [{"id": "w1", "type": "kpi", "bindings": [{"signal_id": SIG_SPEED_1}]}]}
    got = await svc.get_dashboard(SESSION, TENANT, UUID(d["id"]))
    assert got["document"]["widgets"][0]["id"] == "w_legacy_1" and got["upgrade_notes"]
    assert got == await svc.get_dashboard(SESSION, TENANT, UUID(d["id"]))  # stable across reads
    # Publishing a legacy draft works (upgrade + validation) and stores the v1 document.
    published = await publish(got)
    assert published["status"] == "PUBLISHED" and published["upgrade_notes"] == []


# ---- validate / publish / revisions / restore --------------------------------------------------------------


async def test_validate_reports_resolution_and_fit(env: tuple[DashboardStore, CatalogDB]) -> None:
    d = await create()
    doc = document(
        kpi(),
        kpi("w_state", SIG_STATE_1),  # string into a KPI is fine (latest), …
        {**kpi("w_avg", SIG_STATE_1), "options": {"value_mode": "avg"}},  # … but not for a reduction
        {**kpi("w_old", SIG_OLD)},
        {"id": "w_trend", "type": "timeseries", "layout": {"lg": {"x": 0, "y": 3, "w": 6, "h": 6}},
         "bindings": [{"id": "b_1", "source": {"kind": "model_field", "model_id": MODEL, "field_path": "nope"}}],
         "options": {"history_mode": "recorded"}},
    )
    out = await svc.validate(SESSION, TENANT, UUID(d["id"]), ValidateIn(document=doc))
    assert out["ok"] is False
    by_widget = {(i.get("widget_id"), i["code"]) for i in out["issues"] if i["severity"] == "error"}
    assert by_widget == {("w_avg", "VALUE_KIND_MISMATCH"), ("w_old", "ARCHIVED"), ("w_trend", "FIELD_NOT_FOUND")}
    good = await svc.validate(SESSION, TENANT, UUID(d["id"]), ValidateIn(document=document(kpi())))
    assert good == {"ok": True, "issues": []}
    # Default: the stored draft (empty) -> not publishable.
    empty = await svc.validate(SESSION, TENANT, UUID(d["id"]), ValidateIn())
    assert [i["code"] for i in empty["issues"]] == ["EMPTY_DASHBOARD"]
    structural = await svc.validate(SESSION, TENANT, UUID(d["id"]), ValidateIn(document={"schema_version": 1, "widgets": "x"}))
    assert structural["ok"] is False and structural["issues"][0]["code"] == "INVALID_TYPE"


async def test_history_capability_checks(env: tuple[DashboardStore, CatalogDB], monkeypatch: pytest.MonkeyPatch) -> None:
    _store, db = env
    install_catalog(monkeypatch, db, history=False, pg_fallback=False)
    d = await create()
    trend = {"id": "w_trend", "type": "timeseries", "layout": {"lg": {"x": 0, "y": 0, "w": 6, "h": 6}},
             "bindings": [{"id": "b_1", "source": {"kind": "signal", "signal_id": SIG_SPEED_1}}]}
    out = await svc.validate(SESSION, TENANT, UUID(d["id"]), ValidateIn(document=document(trend, {**kpi(), "options": {"sparkline": True}})))
    assert sorted(i["code"] for i in out["issues"]) == ["HISTORY_UNAVAILABLE", "HISTORY_UNAVAILABLE"]
    install_catalog(monkeypatch, db, history=True)
    field_trend = {**trend, "bindings": [{"id": "b_1", "source": {"kind": "model_field", "model_id": MODEL, "field_path": "status"}}]}
    out = await svc.validate(SESSION, TENANT, UUID(d["id"]), ValidateIn(document=document(field_trend)))
    assert [(i["severity"], i["code"]) for i in out["issues"]] == [("error", "VALUE_KIND_MISMATCH"), ("warning", "HISTORY_LIMITED")]


async def test_variables_and_references(env: tuple[DashboardStore, CatalogDB]) -> None:
    d = await create()
    other = await create("Other")
    keyed = {**kpi(), "bindings": [{"id": "b_1", "source": {"kind": "signal_key", "variable": "machine", "key": "speed_1"}}]}
    link = {"id": "w_link", "type": "link", "layout": {"lg": {"x": 3, "y": 0, "w": 2, "h": 1}}, "options": {"dashboard_id": other["id"]}}
    broken = {**link, "id": "w_broken", "options": {"dashboard_id": "00000000-0000-0000-0000-00000000dead"}}
    equip = {"id": "w_eq", "type": "equipment", "layout": {"lg": {"x": 6, "y": 0, "w": 3, "h": 4}},
             "options": {"resource_id": "00000000-0000-0000-0000-00000000beef"}}

    async def issues(variables: list[dict[str, Any]], *widgets: dict[str, Any]) -> list[tuple[str, str]]:
        out = await svc.validate(SESSION, TENANT, UUID(d["id"]), ValidateIn(document=document(*widgets, variables=variables)))
        return sorted((i["severity"], i["code"]) for i in out["issues"])

    var = {"id": "machine", "label": "Machine", "resource_type": "machine"}
    assert await issues([var], keyed) == [("warning", "VARIABLE_UNSET")]
    assert await issues([{**var, "default": M1}], keyed) == []
    assert await issues([{**var, "default": "00000000-0000-0000-0000-000000000101"}], keyed) == [
        ("error", "KEY_NOT_ON_RESOURCE"), ("error", "VARIABLE_TYPE_MISMATCH")]
    assert await issues([{**var, "default": "00000000-0000-0000-0000-00000000cafe"}], keyed) == [
        ("error", "NOT_FOUND"), ("error", "VARIABLE_DEFAULT_NOT_FOUND")]
    assert await issues([], link, broken, equip) == [("error", "LINK_TARGET_NOT_FOUND"), ("error", "RESOURCE_NOT_FOUND")]


async def test_publish_revisions_restore(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await create()
    empty = await raises(publish(d))
    assert empty.code == "PUBLISH_BLOCKED" and [i["code"] for i in empty.extra["details"]["issues"]] == ["EMPTY_DASHBOARD"]
    d = await patch(d, document=document(kpi()))
    stale = await raises(svc.publish_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), PublishIn(version=1), CID))
    assert stale.code == "RESOURCE_VERSION_CONFLICT"
    p1 = await publish(d, note="first")
    assert p1["status"] == "PUBLISHED" and p1["published_revision"] == 1 and p1["published_at"] and p1["has_unpublished_changes"] is False
    assert p1["version"] == d["version"] + 1
    rev = store.revisions[d["id"]][0]
    assert rev["document_json"] == p1["document"] and rev["widget_configs_json"] == p1["document"]["widgets"]
    assert rev["breakpoints_json"] == {"lg": 12, "md": 6, "sm": 1} and rev["published_by"] == ACTOR and rev["note"] == "first"
    p1_doc = copy.deepcopy(p1["document"])

    d2 = await patch(p1, document=document(kpi(title_align="center")))
    assert d2["has_unpublished_changes"] is True
    listed = (await svc.list_dashboards(SESSION, TENANT))["items"][0]
    assert listed["status"] == "PUBLISHED" and listed["has_unpublished_changes"] is True
    published = await svc.get_published(SESSION, TENANT, UUID(d["id"]))
    assert published["revision"] == 1 and published["document"] == p1_doc  # the draft edit does not leak
    p2 = await publish(d2)
    assert p2["published_revision"] == 2

    revisions = (await svc.list_revisions(SESSION, TENANT, UUID(d["id"])))["items"]
    assert [(r["revision"], r["widget_count"], r["published_by"]) for r in revisions] == [(2, 1, str(ACTOR)), (1, 1, str(ACTOR))]
    assert (await svc.get_revision(SESSION, TENANT, UUID(d["id"]), 1))["document"] == p1_doc
    assert (await raises(svc.get_revision(SESSION, TENANT, UUID(d["id"]), 9))).code == "REVISION_NOT_FOUND"

    restored = await svc.restore_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), RestoreIn(revision=1, version=p2["version"]), CID)
    assert restored["document"] == p1_doc and restored["published_revision"] == 2 and restored["has_unpublished_changes"] is True
    assert restored["draft_revision"] == p2["draft_revision"] + 1
    assert len(store.revisions[d["id"]]) == 2  # restore never deletes or edits revisions
    p3 = await publish(restored)
    assert p3["published_revision"] == 3
    assert (await raises(svc.restore_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), RestoreIn(revision=1, version=1), CID))).status == 409
    assert events(store).count("DASHBOARD_PUBLISH") == 3 and "DASHBOARD_RESTORE" in events(store)


async def test_published_of_a_draft_and_legacy_revision(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await create()
    assert (await raises(svc.get_published(SESSION, TENANT, UUID(d["id"])))).code == "NOT_PUBLISHED"
    # A revision published before schema v1 has no document_json: it is rebuilt from widget_configs_json.
    store.revisions[d["id"]] = [{"revision": 1, "document_json": None, "widget_configs_json": [
        {"id": "w1", "type": "kpi", "bindings": [{"signal_id": SIG_SPEED_1}]}], "published_at": None, "created_at": store.clock,
        "published_by": None, "published_by_name": None, "note": ""}]
    store.dashboards[d["id"]]["published_revision"] = 1
    got = await svc.get_published(SESSION, TENANT, UUID(d["id"]))
    assert got["document"]["schema_version"] == 1 and got["document"]["widgets"][0]["type"] == "kpi"
    assert (await svc.get_dashboard(SESSION, TENANT, UUID(d["id"])))["has_unpublished_changes"] is True


async def test_publish_blocks_on_errors_but_not_warnings(env: tuple[DashboardStore, CatalogDB]) -> None:
    d = await create()
    d = await patch(d, document=document(kpi(signal_id=SIG_OLD)))
    blocked = await raises(publish(d))
    assert blocked.code == "PUBLISH_BLOCKED" and blocked.extra["details"]["issues"][0]["code"] == "ARCHIVED"
    image = {"id": "w_img", "type": "image", "layout": {"lg": {"x": 3, "y": 0, "w": 3, "h": 3}}}
    d = await patch(d, document=document(kpi(), image))
    assert (await publish(d))["status"] == "PUBLISHED"  # IMAGE_EMPTY is only a warning


# ---- duplicate / archive / export / import -------------------------------------------------------------------


async def test_duplicate_archive_unarchive(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await patch(await create(), document=document(kpi()))
    d = await publish(d)
    copy_ = await svc.duplicate_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), DuplicateIn(name="Copy"), CID)
    assert copy_["id"] != d["id"] and copy_["status"] == "DRAFT" and copy_["document"] == d["document"] and copy_["version"] == 1
    archived = await svc.set_archived(SESSION, TENANT, ACTOR, UUID(d["id"]), VersionIn(version=d["version"]), CID, archived=True)
    assert archived["archived_at"] is not None
    assert [i["id"] for i in (await svc.list_dashboards(SESSION, TENANT))["items"]] == [copy_["id"]]
    assert len((await svc.list_dashboards(SESSION, TENANT, include_archived=True))["items"]) == 2
    locked = await raises(patch(archived, name="x"))
    assert locked.code == "ARCHIVED"
    again = await raises(svc.set_archived(SESSION, TENANT, ACTOR, UUID(d["id"]), VersionIn(version=archived["version"]), CID, archived=True))
    assert again.code == "ARCHIVED"
    back = await svc.set_archived(SESSION, TENANT, ACTOR, UUID(d["id"]), VersionIn(version=archived["version"]), CID, archived=False)
    assert back["archived_at"] is None and back["status"] == "PUBLISHED"
    assert (await raises(svc.set_archived(SESSION, TENANT, ACTOR, UUID(d["id"]), VersionIn(version=back["version"]), CID,
                                          archived=False))).code == "NOT_ARCHIVED"
    assert {"DASHBOARD_DUPLICATE", "DASHBOARD_ARCHIVE", "DASHBOARD_UNARCHIVE"} <= set(events(store))


async def test_delete_permanently_only_archived_dashboards(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await publish(await patch(await create(), document=document(kpi())))
    d = await publish(await patch(d, name="Line A v2"))
    assert len(store.revisions[d["id"]]) == 2
    # an active dashboard cannot be deleted
    active = await raises(svc.delete_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), CID))
    assert active.status == 409 and active.code == "NOT_ARCHIVED" and d["id"] in store.dashboards
    archived = await svc.set_archived(SESSION, TENANT, ACTOR, UUID(d["id"]), VersionIn(version=d["version"]), CID, archived=True)
    # tenant-scoped: another tenant sees 404 and nothing is deleted
    foreign = await raises(svc.delete_dashboard(SESSION, OTHER_TENANT, ACTOR, UUID(d["id"]), CID))
    assert foreign.status == 404 and d["id"] in store.dashboards
    await svc.delete_dashboard(SESSION, TENANT, ACTOR, UUID(archived["id"]), CID)
    assert d["id"] not in store.dashboards and d["id"] not in store.revisions
    assert (await svc.list_dashboards(SESSION, TENANT, include_archived=True))["items"] == []
    gone = await raises(svc.get_dashboard(SESSION, TENANT, UUID(d["id"])))
    assert gone.status == 404
    deleted = [a for a in store.audits if a["event_type"] == "DASHBOARD_DELETE"]
    assert len(deleted) == 1 and deleted[0]["entity_id"] == UUID(d["id"]) and deleted[0]["actor_id"] == ACTOR
    assert deleted[0]["before"]["name"] == "Line A v2" and deleted[0]["after"] == {"deleted": True, "revisions_deleted": 2}
    again = await raises(svc.delete_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), CID))
    assert again.status == 404


async def test_delete_loses_a_race_with_unarchive(env: tuple[DashboardStore, CatalogDB], monkeypatch: pytest.MonkeyPatch) -> None:
    store, _ = env
    d = await create()
    await svc.set_archived(SESSION, TENANT, ACTOR, UUID(d["id"]), VersionIn(version=d["version"]), CID, archived=True)
    real = store.delete_archived_dashboard

    async def unarchived_meanwhile(s: Any, tenant_id: UUID, dashboard_id: UUID) -> int | None:
        store.dashboards[str(dashboard_id)]["archived_at"] = None
        return await real(s, tenant_id, dashboard_id)

    from factorix.application.dashboards import store as real_store
    monkeypatch.setattr(real_store, "delete_archived_dashboard", unarchived_meanwhile)
    assert (await raises(svc.delete_dashboard(SESSION, TENANT, ACTOR, UUID(d["id"]), CID))).code == "NOT_ARCHIVED"
    assert d["id"] in store.dashboards and "DASHBOARD_DELETE" not in events(store)


async def test_export_import_round_trip(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    d = await patch(await create(description="desc"), document=document(kpi(), kpi("w_gone", "00000000-0000-0000-0000-00000000aaaa")))
    exported = await svc.export_dashboard(SESSION, TENANT, UUID(d["id"]))
    assert exported["format"] == "factorix.dashboard" and exported["format_version"] == 1 and exported["document"] == d["document"]
    imported = await svc.import_dashboard(SESSION, TENANT, ACTOR, ImportIn(payload=exported), CID)
    assert imported["name"] == "Line A" and imported["description"] == "desc" and imported["document"] == d["document"]
    assert [(w["widget_id"], w["code"]) for w in imported["warnings"]] == [("w_gone", "NOT_FOUND")]
    named = await svc.import_dashboard(SESSION, TENANT, ACTOR, ImportIn(name="Named", payload=exported), CID)
    assert named["name"] == "Named"
    for bad, code in (({**exported, "format": "grafana"}, "IMPORT_FORMAT"), ({**exported, "format_version": 2}, "IMPORT_FORMAT"),
                      ({**exported, "datasource": {"url": "http://x"}}, "VALIDATION"),
                      ({**exported, "document": {**exported["document"], "widgets": [{"id": "w_x", "type": "iframe"}]}}, "VALIDATION")):
        assert (await raises(svc.import_dashboard(SESSION, TENANT, ACTOR, ImportIn(payload=bad), CID))).code == code
    assert events(store).count("DASHBOARD_IMPORT") == 2


# ---- templates -------------------------------------------------------------------------------------------------


def test_builtin_templates_are_valid_and_generic() -> None:
    assert T.check_builtin_templates() == []
    ids = [t["id"] for t in T.BUILTIN]
    assert {"machine_overview", "process_trends", "line_status_board", "energy_monitoring"} <= set(ids)
    for t in T.BUILTIN:
        text = str(t["document"])
        assert "signal_id" not in text and "model_id" not in text and "signal_key" not in text
        role_ids = {r["id"] for r in t["roles"]}
        used = {b["source"]["role"] for w in t["document"]["widgets"] for b in w["bindings"]}
        assert used == role_ids, t["id"]
        assert any(r["required"] for r in t["roles"])
    machine = T.BUILTIN_BY_ID["machine_overview"]["document"]
    assert machine["variables"] == [{"id": "machine", "label": "Machine", "type": "resource", "resource_type": "machine", "default": None}]


async def test_instantiate_builtin_template(env: tuple[DashboardStore, CatalogDB]) -> None:
    unmapped = await create(template_id="energy_monitoring")
    # Only the required role stays (as an UNBOUND placeholder); optional-only widgets are removed.
    assert [w["id"] for w in unmapped["document"]["widgets"]] == ["w_power", "w_trend", "w_values"]
    assert {w["code"] for w in unmapped["warnings"]} == {"UNBOUND"}
    mapped = await create(template_id="machine_overview", role_map={
        "main_value": {"kind": "signal_key", "variable": "machine", "key": "speed_1"},
        "machine_state": {"kind": "signal", "signal_id": SIG_STATE_1},
    })
    widgets = {w["id"]: w for w in mapped["document"]["widgets"]}
    assert set(widgets) == {"w_machine", "w_main", "w_trend", "w_states", "w_values"}  # second_value / power not mapped
    assert widgets["w_main"]["bindings"][0]["source"] == {"kind": "signal_key", "variable": "machine", "key": "speed_1"}
    assert [b["role"] for b in widgets["w_machine"]["bindings"]] == ["status", "value"]
    assert [w["code"] for w in mapped["warnings"]] == ["VARIABLE_UNSET"] * 4
    for bad in ({"nope": {"kind": "signal", "signal_id": SIG_STATE_1}}, {"main_value": {"kind": "url", "url": "http://x"}},
                {"main_value": {"kind": "signal_key", "variable": "line", "key": "k"}}, {"main_value": {"kind": "role", "role": "x"}}):
        assert (await raises(create(template_id="machine_overview", role_map=bad))).code == "VALIDATION", bad
    assert (await raises(create(template_id="nope"))).code == "TEMPLATE_NOT_FOUND"
    assert (await raises(create(role_map={"a": {}}))).code == "VALIDATION"


async def test_tenant_templates(env: tuple[DashboardStore, CatalogDB]) -> None:
    store, _ = env
    def at(widget: dict[str, Any], x: int) -> dict[str, Any]:
        return {**widget, "layout": {"lg": {"x": x, "y": 0, "w": 3, "h": 3}}}

    d = await patch(await create(), document=document(kpi(), at(kpi("w_two"), 3), at(kpi("w_three", SIG_STATE_1), 6),
                                                       variables=[{"id": "machine", "default": M1}]))
    tpl = await svc.create_template(SESSION, TENANT, ACTOR, TemplateIn(dashboard_id=d["id"], name="Mine"), CID)
    assert tpl["builtin"] is False and tpl["category"] == "custom" and tpl["widget_count"] == 3
    assert [(r["id"], r["required"]) for r in tpl["roles"]] == [("r_1", True), ("r_2", True)]  # two distinct sources
    assert tpl["variables"][0]["default"] is None
    stored = store.templates[tpl["id"]]["document_json"]
    assert "signal_id" not in str(stored)
    items = (await svc.list_templates(SESSION, TENANT))["items"]
    assert [i["id"] for i in items][-1] == tpl["id"] and items[0]["builtin"] is True
    assert (await svc.list_templates(SESSION, OTHER_TENANT))["items"][-1]["builtin"] is True  # tenant templates are private
    made = await create(template_id=tpl["id"], role_map={"r_1": {"kind": "signal", "signal_id": SIG_SPEED_1}})
    assert [w["code"] for w in made["warnings"]] == ["UNBOUND"]  # r_2 is required and unmapped
    assert (await raises(svc.delete_template(SESSION, TENANT, ACTOR, "machine_overview", CID))).code == "TEMPLATE_BUILTIN"
    assert (await raises(svc.delete_template(SESSION, OTHER_TENANT, ACTOR, tpl["id"], CID))).code == "TEMPLATE_NOT_FOUND"
    await svc.delete_template(SESSION, TENANT, ACTOR, tpl["id"], CID)
    assert tpl["id"] not in store.templates
    assert {"DASHBOARD_TEMPLATE_CREATE", "DASHBOARD_TEMPLATE_DELETE"} <= set(events(store))


async def test_resolve_endpoint_and_registry_payloads(env: tuple[DashboardStore, CatalogDB]) -> None:
    out = await svc.resolve(SESSION, TENANT, ResolveIn(variables={"machine": M1}, sources=[
        {"kind": "signal_key", "variable": "machine", "key": "speed_1"}, {"kind": "signal", "signal_id": SIG_OLD}]))
    assert [i["ok"] for i in out["items"]] == [True, False]
    assert len(R.widget_types_payload()["widget_types"]) == len(R.WIDGET_TYPES)
