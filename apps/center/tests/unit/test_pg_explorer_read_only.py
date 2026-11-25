"""B-14 / OP-19 (R1-35, R1-C P1-14): the PostgreSQL explorer runs every statement in a READ ONLY transaction
behind a SELECT-only allowlist, refuses sensitive tables (403) and offers an exact, bounded row count."""

from __future__ import annotations

from typing import Any

import pytest

from factorix.modules import postgres_explorer as PE
from factorix.platform.errors import AppError

TENANT = "00000000-0000-0000-0000-000000000001"


class _Session:
    """Records statements in order; answers the catalog queries the explorer issues."""

    def __init__(self, *, columns: list[str] | None = None, count: int = 42, fail_count: Exception | None = None) -> None:
        self.info: dict[str, Any] = {}
        self.sql: list[str] = []
        self.columns = columns if columns is not None else ["id", "name"]
        self.count = count
        self.fail_count = fail_count


@pytest.fixture()
def wired(monkeypatch: pytest.MonkeyPatch):
    def install(session: _Session) -> _Session:
        async def execute(s: _Session, sql: str, _p: dict[str, Any]) -> None:
            s.sql.append(sql)

        async def fetch_all(s: _Session, sql: str, _p: dict[str, Any]) -> list[dict[str, Any]]:
            s.sql.append(sql)
            if "reltuples" in sql:
                return [{"table_name": "resources", "table_type": "BASE TABLE", "estimated_rows": -1, "column_count": 3},
                        {"table_name": "secret_store", "table_type": "BASE TABLE", "estimated_rows": 2, "column_count": 3}]
            if "information_schema.columns" in sql:
                return [{"table_name": "resources", "column_name": c, "data_type": "text", "is_nullable": "YES", "column_default": None,
                         "character_maximum_length": None, "ordinal_position": i} for i, c in enumerate(s.columns)]
            return []

        async def fetch_one(s: _Session, sql: str, _p: dict[str, Any]) -> dict[str, Any] | None:
            s.sql.append(sql)
            if s.fail_count is not None and "count(*)" in sql:
                raise s.fail_count
            return {"total": s.count}

        monkeypatch.setattr(PE, "execute", execute)
        monkeypatch.setattr(PE, "fetch_all", fetch_all)
        monkeypatch.setattr(PE, "fetch_one", fetch_one)
        return session

    return install


async def test_every_explorer_call_starts_with_set_transaction_read_only(wired: Any) -> None:
    svc = PE.PostgresExplorerService()
    for call in (
        lambda s: svc.list_schemas(s),
        lambda s: svc.list_tables(s),
        lambda s: svc.get_table_details(s, table="resources"),
        lambda s: svc.list_relationships(s),
        lambda s: svc.preview_data(s, table="resources", tenant_id=TENANT),
        lambda s: svc.count_rows(s, table="resources", tenant_id=TENANT),
    ):
        session = wired(_Session())
        await call(session)
        assert session.sql[0] == "SET TRANSACTION READ ONLY", session.sql[:2]
        assert session.sql.count("SET TRANSACTION READ ONLY") == 1  # once per request transaction
        assert all(PE._READ_STATEMENT.match(q) or q.startswith("SET ") for q in session.sql)


def test_statement_allowlist_refuses_anything_but_one_select() -> None:
    PE.assert_read_statement("SELECT 1")
    PE.assert_read_statement("  with x as (select 1) select * from x")
    for bad in ("DELETE FROM resources", "UPDATE t SET a = 1", "SELECT 1; DROP TABLE resources", "CREATE TABLE x (a int)", ""):
        with pytest.raises(AppError) as exc:
            PE.assert_read_statement(bad)
        assert exc.value.code == "EXPLORER_STATEMENT_REFUSED"


@pytest.mark.parametrize("table", sorted(PE.SENSITIVE_TABLES))
async def test_sensitive_tables_answer_403_everywhere(wired: Any, table: str) -> None:
    svc = PE.PostgresExplorerService()
    for call in (
        lambda s: svc.preview_data(s, table=table, tenant_id=TENANT),
        lambda s: svc.get_table_details(s, table=table),
        lambda s: svc.count_rows(s, table=table, tenant_id=TENANT),
    ):
        session = wired(_Session())
        with pytest.raises(AppError) as exc:
            await call(session)
        assert exc.value.status == 403 and exc.value.code == "ACCESS_DENIED"
        assert not any("count(*)" in q or "LIMIT" in q for q in session.sql)  # refused before any data read


async def test_list_hides_sensitive_tables_and_reports_unknown_estimates(wired: Any) -> None:
    rows = await PE.PostgresExplorerService().list_tables(wired(_Session()))
    assert [r["name"] for r in rows] == ["resources"]
    assert rows[0]["estimated_rows"] is None  # reltuples = -1: "unknown, never analyzed", never 0


async def test_count_exactly_is_bounded_and_tenant_scoped(wired: Any) -> None:
    session = wired(_Session(columns=["id", "tenant_id", "name"], count=1234))
    out = await PE.PostgresExplorerService().count_rows(session, table="resources", tenant_id=TENANT)
    assert out == {"schema": "public", "table": "resources", "exact_rows": 1234, "tenant_scoped": True,
                   "timeout_ms": PE.COUNT_TIMEOUT_MS}
    assert f"SET LOCAL statement_timeout = {PE.COUNT_TIMEOUT_MS}" in session.sql
    count_sql = next(q for q in session.sql if "count(*)" in q)
    assert count_sql == 'SELECT count(*) AS total FROM "public"."resources" WHERE "tenant_id" = CAST(:tenant_id AS uuid)'
    with pytest.raises(AppError) as exc:
        await PE.PostgresExplorerService().count_rows(wired(_Session(columns=["id", "tenant_id"])), table="resources")
    assert exc.value.code == "TENANT_REQUIRED"


async def test_count_timeout_and_unknown_table(wired: Any) -> None:
    svc = PE.PostgresExplorerService()
    with pytest.raises(AppError) as exc:
        await svc.count_rows(wired(_Session(fail_count=RuntimeError("canceling statement due to statement timeout"))), table="resources")
    assert exc.value.status == 504 and exc.value.code == "COUNT_TIMEOUT" and exc.value.retryable
    with pytest.raises(AppError) as exc:
        await svc.count_rows(wired(_Session(columns=[])), table="nope")
    assert exc.value.status == 404
    with pytest.raises(AppError):
        await svc.count_rows(wired(_Session()), table='x"; DROP TABLE y; --')
