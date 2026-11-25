"""B-03 / OP-04 (R1-17a, R1-29, R2-D): the wizard's step-1 name check and the 1000-character description limit
are enforced by the backend for databases, supertables and subtables (create, validate-name and metadata PATCH)."""

from __future__ import annotations

from typing import Any

import pytest

from factorix.modules import storage_objects as SO
from factorix.modules import storage_revisions as SR

TENANT = "00000000-0000-0000-0000-000000000001"
DB = "fx_t_00000000000000000000000000000001"
LONG = "d" * (SO.MAX_DESCRIPTION_LEN + 1)


def _codes(result: SO.ValidationResult, field: str) -> list[str]:
    return [e["code"] for e in result.errors if e.get("field") == field]


def test_description_limit_applies_to_database_stable_and_subtable_specs() -> None:
    db = SO.validate_database_spec(SR._database_spec({"name": "plant_db", "description": LONG}))
    st = SO.validate_stable_spec(SR.stable_spec_from({"name": "st_x", "database": DB, "description": LONG}))
    sub = SO.validate_subtable_spec(
        SR.subtable_spec_from({"name": "sub_x", "database": DB, "stable": "st_x", "description": LONG}),
        [SO.TagSpec(name="machine_ref", td_type="VARCHAR", length=36)],
    )
    for result in (db, st, sub):
        assert "DESCRIPTION_TOO_LONG" in _codes(result, "description")
    ok = SO.validate_subtable_spec(
        SR.subtable_spec_from({"name": "sub_x", "database": DB, "stable": "st_x", "description": "d" * SO.MAX_DESCRIPTION_LEN,
                               "tag_values": {"machine_ref": "M1"}}),
        [SO.TagSpec(name="machine_ref", td_type="VARCHAR", length=36)],
    )
    assert _codes(ok, "description") == []


class _FakeTd:
    def __init__(self, existing: set[str] | None = None) -> None:
        self.existing = existing or set()

    async def run_read(self, sql: str) -> list[Any]:
        return [("x",)] if any(f"'{name}'" in sql for name in self.existing) else []

    async def run_write(self, _sql: str) -> None:
        return None


class _Session:
    def __init__(self, row: dict[str, Any] | None = None) -> None:
        self.row = row
        self.updates: list[str] = []

    async def execute(self, statement: Any, params: dict[str, Any] | None = None, *_a: Any, **_kw: Any) -> Any:
        sql = str(statement)
        if sql.lstrip().upper().startswith("UPDATE"):
            self.updates.append(sql)
        row = self.row if "FROM storage_objects" in sql else None

        class _Result:
            rowcount = 1

            def mappings(self) -> "_Result":
                return self

            def first(self) -> dict[str, Any] | None:
                return row

            def all(self) -> list[Any]:
                return [row] if row else []

        return _Result()

    async def commit(self) -> None:
        return None


async def _client(session: _Session, td: _FakeTd):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from factorix.platform.errors import AppError
    from factorix.platform.http import json_error
    from factorix.transport.storage_api import build_router

    async def fake_admin() -> dict[str, str]:
        return {"tenant_id": TENANT, "admin_id": "00000000-0000-0000-0000-000000000002", "role": "admin"}

    async def fake_db() -> Any:
        yield session

    app = FastAPI()

    @app.exception_handler(AppError)
    async def _on_app_err(_req: Any, exc: AppError) -> Any:
        return json_error(exc.status, exc.code, exc.message, correlation_id="t", extra=exc.extra)

    app.include_router(build_router(admin=fake_admin, db_session=fake_db, td_client=td))
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"kind": "database", "name": "log"}, "RESERVED_NAME"),
        ({"kind": "database", "name": "a" * 83}, "IDENTIFIER_TOO_LONG"),
        ({"kind": "stable", "name": "s" * 65, "database": DB}, "IDENTIFIER_TOO_LONG"),
        ({"kind": "subtable", "name": "op_x", "database": DB, "stable": "st_x"}, "RESERVED_PREFIX"),
        ({"kind": "database", "name": "plant_db", "description": LONG}, "DESCRIPTION_TOO_LONG"),
        ({"kind": "stable", "name": "st_ok", "database": DB, "description": LONG}, "DESCRIPTION_TOO_LONG"),
        ({"kind": "subtable", "name": "sub_ok", "database": DB, "stable": "st_x", "description": LONG}, "DESCRIPTION_TOO_LONG"),
        ({"kind": "stable", "name": "st_taken", "database": DB}, "NAME_CONFLICT"),
    ],
)
async def test_validate_name_reports_the_step_one_errors(body: dict[str, Any], code: str) -> None:
    async with await _client(_Session(), _FakeTd({"st_taken"})) as client:
        resp = await client.post("/api/v1/storage/td/validate-name", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["valid"] is False
    assert data["errors"][0]["code"] == code
    if code == "IDENTIFIER_TOO_LONG":
        # Length is reported before the character-set rule (R1-29), never as INVALID_IDENTIFIER.
        assert all(e["code"] != "INVALID_IDENTIFIER" for e in data["errors"])


async def test_validate_name_accepts_a_free_valid_name() -> None:
    async with await _client(_Session(), _FakeTd()) as client:
        resp = await client.post("/api/v1/storage/td/validate-name", json={"kind": "subtable", "name": "cond_aa10_01",
                                                                             "database": DB, "stable": "st_x"})
    assert resp.json() == {"valid": True, "errors": [], "exists": False}


async def test_metadata_patch_rejects_a_description_over_the_limit_without_writing() -> None:
    row = {"id": "00000000-0000-0000-0000-0000000000aa", "object_type": "stable", "physical_db": DB, "physical_name": "st_x",
           "display_name": "X", "description": "", "status": "ACTIVE", "schema_json": [], "tags_json": [], "revision": 1,
           "updated_at": None}
    session = _Session(row)
    async with await _client(session, _FakeTd()) as client:
        bad = await client.patch(f"/api/v1/storage/td/objects/stable:{DB}.st_x", json={"description": LONG})
        good = await client.patch(f"/api/v1/storage/td/objects/stable:{DB}.st_x", json={"description": "short"})
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "DESCRIPTION_TOO_LONG"
    assert good.status_code == 200, good.text
    assert len(session.updates) == 1  # only the valid PATCH wrote
