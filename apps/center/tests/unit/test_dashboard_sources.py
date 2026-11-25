"""Dashboard source resolution, capabilities and catalog (contract §5 ``/resolve``, ``/sources``, §6)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest

from _dashboard_fakes import (
    M1,
    M2,
    M_ARCHIVED,
    M_OTHER,
    MODEL,
    MODEL_ARCHIVED,
    MODEL_OTHER,
    OTHER_TENANT,
    SIG_JSON,
    SIG_OLD,
    SIG_OTHER,
    SIG_RUN_1,
    SIG_SPEED_1,
    SIG_SPEED_2,
    SIG_STATE_1,
    TENANT,
    CatalogDB,
    install_catalog,
)
from factorix.application.dashboards import registry as R
from factorix.application.dashboards import sources as S
from factorix.platform.errors import AppError


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> CatalogDB:
    fake = CatalogDB()
    install_catalog(monkeypatch, fake)
    return fake


def sig(signal_id: str) -> dict[str, Any]:
    return {"kind": "signal", "signal_id": signal_id}


def field(path: str, model_id: str = MODEL) -> dict[str, Any]:
    return {"kind": "model_field", "model_id": model_id, "field_path": path}


def key(k: str, variable: str = "machine") -> dict[str, Any]:
    return {"kind": "signal_key", "variable": variable, "key": k}


async def resolve(sources: list[Any], variables: dict[str, Any] | None = None, tenant: UUID = TENANT) -> list[dict[str, Any]]:
    return await S.resolve_sources(object(), tenant, variables or {}, sources)


def err(result: dict[str, Any]) -> str | None:
    return None if result["ok"] else result["error"]["code"]


async def test_signal_by_id_exact_and_tenant_scoped(db: CatalogDB) -> None:
    ok, archived, foreign, missing = await resolve([sig(SIG_SPEED_1), sig(SIG_OLD), sig(SIG_OTHER), sig("00000000-0000-0000-0000-00000000ffff")])
    assert ok["ok"] and ok["token"] == SIG_SPEED_1 and ok["kind"] == "signal" and ok["signal_id"] == SIG_SPEED_1
    assert ok["label"] == "Speed" and ok["key"] == "speed_1" and ok["unit"] == "rpm"
    assert ok["value_type"] == "float64" and ok["value_kind"] == "number"
    assert ok["resource"] == {"id": M1, "name": "Machine A", "code": "MA", "type_key": "machine", "parent_id": "00000000-0000-0000-0000-000000000101",
                              "path": ["Line 1"]}
    assert ok["source"] == sig(SIG_SPEED_1)
    assert [err(r) for r in (archived, foreign, missing)] == ["ARCHIVED", "NOT_FOUND", "NOT_FOUND"]
    # Another tenant sees its own signal and not ours.
    mine, theirs = await resolve([sig(SIG_SPEED_1), sig(SIG_OTHER)], tenant=OTHER_TENANT)
    assert err(mine) == "NOT_FOUND" and theirs["ok"]


async def test_value_kinds_of_signals(db: CatalogDB) -> None:
    results = await resolve([sig(SIG_STATE_1), sig(SIG_RUN_1), sig(SIG_JSON)])
    assert [r["value_kind"] for r in results] == ["string", "boolean", "json"]
    assert results[1]["label"] == "running"  # empty display name -> key


async def test_model_fields_exact_path_and_normalization(db: CatalogDB) -> None:
    results = await resolve([
        field("spindle/load"), field("/spindle/load"), field("spindle/speed"), field("status"), field("a~1b"),
        field("spindle"), field("Spindle/Load"), field("spindle//load"), field("spindle/load/x"), field("../status"),
        field("a/b"), field("status", MODEL_ARCHIVED), field("status", MODEL_OTHER),
    ])
    load, load2, speed, status, escaped = results[:5]
    assert load["ok"] and load["token"] == f"mod:{MODEL}:spindle/load" and load["field_path"] == "spindle/load"
    assert load2["token"] == load["token"]  # leading "/" ignored
    assert load["value_kind"] == "number" and load["label"] == "Spindle · spindle/load"
    # An "auto" field takes the type of the signal it maps; the model's machine comes from that signal.
    assert speed["value_type"] == "float" and speed["value_kind"] == "number" and speed["resource"]["id"] == M1
    assert status["value_kind"] == "string"
    assert escaped["ok"] and escaped["field_path"] == "a~1b" and escaped["value_kind"] == "number"
    assert [err(r) for r in results[5:11]] == ["FIELD_NOT_FOUND"] * 6  # container, case, empty segment, below leaf, traversal, unescaped
    assert [err(r) for r in results[11:]] == ["ARCHIVED", "NOT_FOUND"]


async def test_signal_key_through_variables(db: CatalogDB) -> None:
    sources = [key("speed_1"), key("Speed_1"), key("old"), key("speed_1", "line"), key("speed_1", "other")]
    on_m1 = await resolve(sources, {"machine": M1, "line": None})
    assert on_m1[0]["ok"] and on_m1[0]["signal_id"] == SIG_SPEED_1 and on_m1[0]["kind"] == "signal"
    assert [err(r) for r in on_m1[1:]] == ["KEY_NOT_ON_RESOURCE", "KEY_NOT_ON_RESOURCE", "VARIABLE_UNSET", "VARIABLE_UNKNOWN"]
    on_m2 = await resolve([key("speed_1")], {"machine": M2})
    assert on_m2[0]["signal_id"] == SIG_SPEED_2  # same key, other machine: exact (resource, key)
    for value, code in ((M_ARCHIVED, "ARCHIVED"), (M_OTHER, "NOT_FOUND"), ("not-a-uuid", "INVALID_REF"), ("", "VARIABLE_UNSET")):
        assert err((await resolve([key("speed_1")], {"machine": value}))[0]) == code, value


async def test_invalid_references(db: CatalogDB) -> None:
    results = await resolve([{"kind": "url", "url": "http://x"}, {"kind": "sql", "query": "SELECT 1"}, "token", {"kind": "signal"},
                             {"kind": "signal", "signal_id": "x"}, {"kind": "role", "role": "main"}])
    assert [err(r) for r in results] == ["INVALID_REF"] * 5 + ["UNBOUND"]


async def test_order_dedupe_and_batching(db: CatalogDB) -> None:
    sources = [sig(SIG_SPEED_1), field("status"), sig(SIG_SPEED_1.upper()), key("speed_1"), field("/status")] * 40  # 200 refs
    results = await resolve(sources, {"machine": M1})
    assert len(results) == 200
    assert [r["source"] for r in results] == sources
    assert all(r["ok"] for r in results)
    # A fixed number of statements, independent of the number of references.
    assert len(db.statements) <= 8


async def test_reference_cap(db: CatalogDB) -> None:
    assert len(await resolve([sig(SIG_SPEED_1)] * R.MAX_RESOLVE_REFS)) == R.MAX_RESOLVE_REFS
    with pytest.raises(AppError) as exc:
        await resolve([sig(SIG_SPEED_1)] * (R.MAX_RESOLVE_REFS + 1))
    assert exc.value.status == 422 and exc.value.code == "LIMIT"


async def test_capabilities(monkeypatch: pytest.MonkeyPatch) -> None:
    db = CatalogDB()
    db.recorded_signals = {SIG_SPEED_1}
    db.bound_fields = [(MODEL, "spindle/load")]
    install_catalog(monkeypatch, db, history=True, snapshots=True)
    speed, state, load, status = await resolve([sig(SIG_SPEED_1), sig(SIG_STATE_1), field("spindle/load"), field("status")])
    assert speed["capabilities"] == {"latest": True, "live": True, "historical": True, "history_modes": ["operational", "recorded"],
                                     "fidelity": "operational_full", "notes": []}
    assert state["capabilities"]["history_modes"] == ["operational"]
    assert load["capabilities"]["fidelity"] == "managed_recorded" and "recorded" in load["capabilities"]["history_modes"]
    assert status["capabilities"]["fidelity"] == "model_snapshots" and status["capabilities"]["notes"]

    install_catalog(monkeypatch, db, history=False, pg_fallback=True)
    speed, load = await resolve([sig(SIG_SPEED_1), field("spindle/load")])
    assert speed["capabilities"]["fidelity"] == "postgres_fallback" and speed["capabilities"]["history_modes"] == ["operational"]
    assert load["capabilities"] == {**load["capabilities"], "historical": False, "fidelity": "unavailable", "history_modes": []}

    install_catalog(monkeypatch, db, history=False, pg_fallback=False)
    speed, = await resolve([sig(SIG_SPEED_1)])
    assert speed["capabilities"]["historical"] is False and speed["capabilities"]["fidelity"] == "unavailable"
    assert speed["capabilities"]["live"] is True and speed["capabilities"]["latest"] is True

    install_catalog(monkeypatch, db, history=True, snapshots=False)
    status, = await resolve([field("status")])
    assert status["capabilities"]["historical"] is False


def test_history_state_follows_the_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(S, "get_history_provider", lambda: None)
    monkeypatch.setattr(S, "get_model_snapshot_provider", lambda: object())
    monkeypatch.setattr(S, "pg_fallback_enabled", lambda: False)
    assert S.history_state() == {"history": False, "snapshots": True, "pg_fallback": False}


async def test_catalog_is_restricted_and_decorated(db: CatalogDB, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    async def picker(_session: Any, tenant_id: UUID, *, search: str | None = None, kinds: set[str] | None = None) -> dict[str, Any]:
        seen.update(tenant=tenant_id, search=search, kinds=kinds)
        return {"items": [{
            "resource": {"id": M1, "name": "Machine A", "code": "MA", "type_key": "machine"}, "path": ["Line 1"], "ancestors": [],
            "signals": [{"kind": "signal", "token": SIG_SPEED_1, "key": "speed_1", "label": "Speed", "value_type": "float64"}],
            "models": [{"model_id": MODEL, "name": "Spindle", "fields": [
                {"kind": "model_field", "token": f"mod:{MODEL}:status", "key": "status", "field_path": "status", "value_type": "string"}]}],
            "subtables": [],
        }], "total_groups": 1, "total_series": 9, "observed_at": "2026-11-25T08:00:00.000Z"}

    monkeypatch.setattr(S.historian_catalog, "sources_by_machine", picker)
    out = await S.catalog(object(), TENANT, q="speed")
    assert seen == {"tenant": TENANT, "search": "speed", "kinds": {"signal", "model_field"}}
    group = out["items"][0]
    assert "subtables" not in group
    s = group["signals"][0]
    assert s["source"] == {"kind": "signal", "signal_id": SIG_SPEED_1} and s["value_kind"] == "number" and s["capabilities"]["live"]
    f = group["models"][0]["fields"][0]
    assert f["source"] == {"kind": "model_field", "model_id": MODEL, "field_path": "status"} and f["value_kind"] == "string"
    assert f["capabilities"]["fidelity"] == "model_snapshots"
    assert out["total_series"] == 2
    ids = [r["id"] for r in out["resources"]]
    assert M_ARCHIVED not in ids and M_OTHER not in ids and set(ids) == {"00000000-0000-0000-0000-000000000101", M1, M2}
    assert next(r for r in out["resources"] if r["id"] == M2)["path"] == ["Line 1"]
