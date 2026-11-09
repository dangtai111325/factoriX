"""Data Model v2 service layer (factorix.modules.data_models) against an in-memory fake of its SQL."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.domain import rules as R
from factorix.modules import data_models as DM
from factorix.modules import models_engine as E
from factorix.platform.errors import AppError

TENANT, ACTOR = uuid4(), uuid4()
LINE = "00000000-0000-0000-0000-00000000b001"
M1 = "00000000-0000-0000-0000-00000000c001"
M2 = "00000000-0000-0000-0000-00000000c002"
M3 = "00000000-0000-0000-0000-00000000c003"
S1 = {"status": "00000000-0000-0000-0000-00000000d101", "temp": "00000000-0000-0000-0000-00000000d102"}
S2 = {"status": "00000000-0000-0000-0000-00000000d201", "temp": "00000000-0000-0000-0000-00000000d202"}
S3 = {"status": "00000000-0000-0000-0000-00000000d301"}
CAT = R.Catalog(
    [
        {"id": LINE, "type_key": "line", "name": "L1", "code": "L1", "parent_id": None},
        {"id": M1, "type_key": "machine", "name": "AA10-01", "code": "AA10-01", "parent_id": LINE},
        {"id": M2, "type_key": "machine", "name": "AA10-02", "code": "AA10-02", "parent_id": LINE},
        {"id": M3, "type_key": "machine", "name": "AA10-03", "code": "AA10-03", "parent_id": LINE},
    ],
    [{"id": sid, "resource_id": rid, "key": key, "data_type": "int64"} for rid, sigs in ((M1, S1), (M2, S2), (M3, S3)) for key, sid in sigs.items()],
    types=["line", "machine"],
)


class Store:
    def __init__(self) -> None:
        self.models: dict[str, dict[str, Any]] = {}
        self.refs: dict[str, list[tuple[str, str]]] = {}
        self.audits: list[str] = []
        self.statements: list[str] = []


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> Store:
    db = Store()
    now = datetime(2026, 11, 9, tzinfo=timezone.utc)

    async def fetch_one(_s: Any, sql: str, p: dict[str, Any]) -> dict[str, Any] | None:
        if "lower(display_name) = lower(:name)" in sql:
            for row in db.models.values():
                if row["status"] != "ARCHIVED" and row["display_name"].lower() == p["name"].lower() and (p["exclude"] is None or row["id"] != p["exclude"]):
                    return {"id": row["id"]}
            return None
        if "FROM model_state" in sql:
            return None
        if "FROM output_groups" in sql:
            row = db.models.get(str(p["id"]))
            if row is None or ("status <> 'ARCHIVED'" in sql and row["status"] == "ARCHIVED"):
                return None
            return dict(row)
        raise AssertionError(sql[:80])

    async def fetch_all(_s: Any, sql: str, p: dict[str, Any]) -> list[dict[str, Any]]:
        if "FROM signal_bindings" in sql:
            return []
        if "FROM model_refs r JOIN output_groups" in sql:
            ids = {str(i) for i in p["ids"]}
            hits = [db.models[m] for m, refs in db.refs.items() if any(k == "signal" and r in ids for k, r in refs) and db.models[m]["status"] == "ACTIVE"]
            return [{"id": h["id"], "display_name": h["display_name"], "state": h["state"]} for h in sorted(hits, key=lambda h: h["display_name"])]
        if "FROM output_groups g" in sql and "LEFT JOIN model_state" in sql:
            return [dict(r) for r in db.models.values() if r["status"] != "ARCHIVED"]
        raise AssertionError(sql[:80])

    async def execute(_s: Any, sql: str, p: dict[str, Any]) -> None:
        db.statements.append(sql)
        if "INSERT INTO output_groups" in sql:
            db.models[str(p["id"])] = {
                "id": p["id"], "tenant_id": p["tenant_id"], "display_name": p["name"], "description": p["description"], "sample_ms": p["sample_ms"],
                "state": p["state"], "status": "ACTIVE", "version": 1, "spec_json": json.loads(p["spec"]), "created_at": now, "updated_at": now,
            }
        elif "DELETE FROM model_refs" in sql:
            db.refs[str(p["id"])] = []
        elif "INSERT INTO model_refs" in sql:
            db.refs[str(p["model_id"])] = [(k, str(r)) for k, r in zip(p["kinds"], p["refs"])]
        elif "SET status = 'ARCHIVED'" in sql:
            db.models[str(p["id"])]["status"] = "ARCHIVED"
        elif "SET state = :state" in sql:
            row = db.models[str(p["id"])]
            row["state"], row["version"] = p["state"], row["version"] + 1

    async def execute_rowcount(_s: Any, sql: str, p: dict[str, Any]) -> int:
        row = db.models.get(str(p["id"]))
        if row is None or row["version"] != p["version"]:
            return 0
        row.update(display_name=p["name"], description=p["description"], sample_ms=p["sample_ms"], spec_json=json.loads(p["spec"]), version=row["version"] + 1)
        return 1

    async def audit(_s: Any, **kw: Any) -> None:
        db.audits.append(kw["event_type"])

    async def load_catalog(_s: Any, _t: Any, _ids: Any = None) -> R.Catalog:
        return CAT

    async def load_samples(_s: Any, _t: Any, ids: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        return {i: R.Sample(5) for i in ids}, {}

    for name, fn in (("fetch_one", fetch_one), ("fetch_all", fetch_all), ("execute", execute), ("execute_rowcount", execute_rowcount), ("audit", audit)):
        monkeypatch.setattr(DM, name, fn)
    monkeypatch.setattr(E, "load_catalog", load_catalog)
    monkeypatch.setattr(E, "load_samples", load_samples)
    return db


class Session:
    def __init__(self) -> None:
        self.info: dict[str, Any] = {}


def spec(*children: dict[str, Any]) -> dict[str, Any]:
    return {"version": 2, "root": {"type": "object", "children": list(children)}}


STATE_SPEC = spec(
    {"key": "machine_name", "type": "field", "mode": "calculated", "expr": "$machine[AA10-01].@name", "value_type": "string"},
    {"key": "status", "type": "field", "mode": "mapping", "ref": {"text": "$machine[AA10-01].status"}},
    {"key": "temp", "type": "field", "mode": "mapping", "ref": {"text": "$machine[AA10-01].temp"}},
)


async def create(store: Store, name: str = "AA10-01 state", raw: dict[str, Any] | None = None) -> dict[str, Any]:
    return await DM.create_model(Session(), TENANT, ACTOR, DM.DataModelIn(name=name, spec=raw or STATE_SPEC), "c")  # type: ignore[arg-type]


async def test_create_resolves_refs_writes_index_audits_and_notifies(store: Store) -> None:
    session = Session()
    detail = await DM.create_model(session, TENANT, ACTOR, DM.DataModelIn(name=" AA10-01 state ", spec=STATE_SPEC), "c")  # type: ignore[arg-type]
    assert detail["name"] == "AA10-01 state" and detail["state"] == "RUNNING" and detail["sample_ms"] == 1000 and detail["version"] == 1
    assert detail["field_count"] == 3 and detail["ref_count"] == 3 and detail["machines"] == ["AA10-01"] and detail["machine_ids"] == [M1]
    nodes = detail["spec"]["root"]["children"]
    assert nodes[0]["expr"] == f"{{{{res:{M1}}}}}.@name" and nodes[0]["expr_display"] == "$machine[AA10-01].@name"
    assert nodes[1]["ref"] == {"signal_id": S1["status"]} and nodes[1]["ref_display"] == "$machine[AA10-01].status" and nodes[1]["value_type"] == "int"
    assert detail["latest"] == {"body": None, "sampled_at": None, "errors": []}
    assert sorted(store.refs[detail["id"]]) == sorted([("signal", S1["status"]), ("signal", S1["temp"]), ("resource", M1)])
    assert store.audits == ["DATA_MODEL_CREATED"]
    assert session.info["fx_events"] == [{"kind": E.CHANGE_EVENT, "tenant_id": str(TENANT), "model_id": detail["id"]}]


async def test_create_validation_errors(store: Store) -> None:
    with pytest.raises(AppError) as info:
        await create(store, raw=spec({"key": "x", "type": "field", "mode": "calculated", "expr": "$machine[AA10-09].status"}))
    assert info.value.status == 422 and info.value.code == "INVALID_SPEC"
    assert info.value.field_errors[0]["path"] == "/x" and info.value.field_errors[0]["code"] == "UNKNOWN_RESOURCE"
    for kwargs, code in (({"name": " "}, "NAME_REQUIRED"), ({"name": "n", "sample_ms": 100}, "INVALID_SAMPLE_MS"), ({"name": "n", "state": "ON"}, "INVALID_STATE")):
        with pytest.raises(AppError) as info:
            await DM.create_model(Session(), TENANT, ACTOR, DM.DataModelIn(spec=STATE_SPEC, **kwargs), "c")  # type: ignore[arg-type]
        assert info.value.code == code
    await create(store)
    with pytest.raises(AppError) as info:
        await create(store, name="aa10-01 STATE")
    assert info.value.status == 409 and info.value.code == "DUPLICATE_NAME"


async def test_patch_version_check_pause_resume_delete(store: Store) -> None:
    model = await create(store)
    model_id = UUID(model["id"])
    with pytest.raises(AppError) as info:
        await DM.patch_model(Session(), TENANT, ACTOR, model_id, DM.DataModelPatch(version=7, name="x"), "c")  # type: ignore[arg-type]
    assert info.value.status == 409 and info.value.code == "VERSION_CONFLICT" and info.value.extra == {"current_version": 1}
    patched = await DM.patch_model(Session(), TENANT, ACTOR, model_id, DM.DataModelPatch(version=1, name="Renamed", sample_ms=5000), "c")  # type: ignore[arg-type]
    assert patched["name"] == "Renamed" and patched["sample_ms"] == 5000 and patched["version"] == 2
    paused = await DM.set_state(Session(), TENANT, ACTOR, model_id, "PAUSED", None, "c")  # type: ignore[arg-type]
    again = await DM.set_state(Session(), TENANT, ACTOR, model_id, "PAUSED", None, "c")  # type: ignore[arg-type]
    assert paused["state"] == again["state"] == "PAUSED" and again["version"] == paused["version"]  # idempotent
    resumed = await DM.set_state(Session(), TENANT, ACTOR, model_id, "RUNNING", DM.StateChangeIn(version=paused["version"]), "c")  # type: ignore[arg-type]
    assert resumed["state"] == "RUNNING"
    assert await DM.delete_model(Session(), TENANT, ACTOR, model_id, "c") == {"id": str(model_id), "deleted": True}  # type: ignore[arg-type]
    with pytest.raises(AppError) as info:
        await DM.get_model(Session(), TENANT, model_id)  # type: ignore[arg-type]
    assert info.value.status == 404
    assert store.audits == ["DATA_MODEL_CREATED", "DATA_MODEL_UPDATED", "DATA_MODEL_PAUSED", "DATA_MODEL_RESUMED", "DATA_MODEL_DELETED"]
    assert any("DELETE FROM model_snapshots" in s for s in store.statements)


async def test_duplicate_to_machines_retargets_and_reports_unmatched(store: Store) -> None:
    model = await create(store)
    body = DM.DuplicateIn(targets=[M2, M3], dry_run=True)
    dry = await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), body, "c")  # type: ignore[arg-type]
    assert [c["name"] for c in dry["created"]] == ["AA10-02 state", "AA10-03 state"] and all(c["id"] is None for c in dry["created"])
    assert dry["created"][0]["unmatched"] == [] and dry["created"][0]["replaced"] == 3
    assert [u["ref"] for u in dry["created"][1]["unmatched"]] == ["$machine[AA10-01].temp"]  # AA10-03 has no temp
    assert len(store.models) == 1
    real = await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), DM.DuplicateIn(targets=[M2]), "c")  # type: ignore[arg-type]
    copy = store.models[real["created"][0]["id"]]
    assert copy["display_name"] == "AA10-02 state" and copy["state"] == "RUNNING"
    assert {r for _k, r in store.refs[str(copy["id"])]} == {S2["status"], S2["temp"], M2}
    again = await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), DM.DuplicateIn(targets=[M2]), "c")  # type: ignore[arg-type]
    assert again["created"][0]["name"] == "AA10-02 state (2)"
    single = await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), DM.DuplicateIn(), "c")  # type: ignore[arg-type]
    assert single["created"][0]["name"] == "AA10-01 state (copy)" and single["created"][0]["replaced"] == 0
    with pytest.raises(AppError) as info:
        await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), DM.DuplicateIn(name="AA10-02 STATE"), "c")  # type: ignore[arg-type]
    assert info.value.code == "DUPLICATE_NAME"
    assert store.audits.count("DATA_MODEL_DUPLICATED") == 3


async def test_duplicate_needs_a_source_when_several_machines(store: Store) -> None:
    raw = spec(
        {"key": "a", "type": "field", "mode": "mapping", "ref": {"text": "$machine[AA10-01].status"}},
        {"key": "b", "type": "field", "mode": "mapping", "ref": {"text": "$machine[AA10-02].status"}},
    )
    model = await create(store, raw=raw)
    with pytest.raises(AppError) as info:
        await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), DM.DuplicateIn(targets=[M3]), "c")  # type: ignore[arg-type]
    assert info.value.code == "SOURCE_REQUIRED"
    out = await DM.duplicate(Session(), TENANT, ACTOR, UUID(model["id"]), DM.DuplicateIn(targets=[M3], source_resource_id=M2, dry_run=True), "c")  # type: ignore[arg-type]
    assert out["created"][0]["replaced"] == 1 and out["created"][0]["name"] == "AA10-01 state - AA10-03"


async def test_validate_and_preview_unsaved_spec(store: Store) -> None:
    raw = spec(
        {"key": "ok", "type": "field", "mode": "calculated", "expr": "$machine[AA10-01].status * 2"},
        {"key": "typo", "type": "field", "mode": "calculated", "expr": "$machine[AA10-01].stauts", "id": "r2"},
        {"key": "n", "type": "field", "mode": "calculated", "expr": "count_changes($machine[AA10-01].status)"},
    )
    result = await DM.validate(Session(), TENANT, DM.SpecIn(spec=raw))  # type: ignore[arg-type]
    assert result["valid"] is False and result["field_count"] == 3
    issue = result["errors"][0]
    assert issue["path"] == "/typo" and issue["node_id"] == "r2" and issue["code"] == "UNKNOWN_SIGNAL" and issue["suggestions"] == ["$machine[AA10-01].status"]
    assert result["spec"]["root"]["children"][0]["expr_display"] == "$machine[AA10-01].status * 2"
    preview = await DM.preview(Session(), TENANT, DM.SpecIn(spec=raw, session_id="s1"))  # type: ignore[arg-type]
    assert json.loads(preview["body"]) == {"ok": 10, "typo": None, "n": 0}
    assert [e["code"] for e in preview["errors"]] == ["UNKNOWN_SIGNAL"]
    assert preview["fields"][1] == {"path": "/typo", "value": None, "error": issue["message"], "node_id": "r2"}
    broken = await DM.preview(Session(), TENANT, DM.SpecIn(spec={"version": 2, "root": []}))  # type: ignore[arg-type]
    assert broken["body"] is None and broken["errors"][0]["code"] == "INVALID_SPEC"


async def test_signal_usage_and_archive_with_resource(store: Store) -> None:
    model = await create(store)
    used = await DM.models_using_signals(Session(), TENANT, [UUID(S1["temp"])])  # type: ignore[arg-type]
    assert used == [{"id": model["id"], "name": "AA10-01 state", "display_name": "AA10-01 state", "status": "RUNNING", "state": "RUNNING"}]
    assert await DM.models_using_signals(Session(), TENANT, [UUID(S2["temp"])]) == []  # type: ignore[arg-type]
    archived = await DM.archive_models(Session(), TENANT, ACTOR, used, "c", reason="resource archived")  # type: ignore[arg-type]
    assert archived[0]["status"] == "ARCHIVED" and store.models[model["id"]]["status"] == "ARCHIVED"
    assert await DM.models_using_signals(Session(), TENANT, [UUID(S1["temp"])]) == []  # type: ignore[arg-type]


async def test_list_filters(store: Store) -> None:
    await create(store)
    await create(store, name="Other", raw=spec({"key": "s", "type": "field", "mode": "mapping", "ref": {"text": "$machine[AA10-02].status"}}))
    assert [m["name"] for m in await DM.list_models(Session(), TENANT)] == ["AA10-01 state", "Other"]  # type: ignore[arg-type]
    assert [m["name"] for m in await DM.list_models(Session(), TENANT, machine="AA10-02")] == ["Other"]  # type: ignore[arg-type]
    assert [m["name"] for m in await DM.list_models(Session(), TENANT, machine=M1)] == ["AA10-01 state"]  # type: ignore[arg-type]
    assert [m["name"] for m in await DM.list_models(Session(), TENANT, q="oth", state="RUNNING")] == ["Other"]  # type: ignore[arg-type]
    assert await DM.list_models(Session(), TENANT, state="PAUSED") == []  # type: ignore[arg-type]
    item = (await DM.list_models(Session(), TENANT))[0]  # type: ignore[arg-type]
    assert set(item) >= {"id", "name", "description", "sample_ms", "state", "field_count", "ref_count", "machines", "updated_at", "last_sampled_at", "error_count", "body"}


def test_functions_endpoint_payload() -> None:
    out = DM.functions()
    assert {f["name"] for f in out["functions"]} >= {"latest_ts", "value_at", "debounce"} and out["examples"]
