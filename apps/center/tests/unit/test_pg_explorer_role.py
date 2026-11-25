"""B-14 / OP-19: provisioning of the explorer's read-only role (``factorix.platform.pg_explorer_role``) and its
migration ``0015_explorer_ro_role``. The real grants are proven against PostgreSQL 17 in
``tests/integration/test_pg_explorer_role.py``; these tests pin the decisions and the fallback."""

from __future__ import annotations

import ast
import contextlib
import importlib.util
import logging
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.exc import ProgrammingError

from factorix.platform import pg_explorer_role as R

VERSIONS = Path(__file__).resolve().parents[2] / "migrations" / "versions"


class _Result:
    def __init__(self, value: Any = None, rows: list[tuple[Any, ...]] | None = None) -> None:
        self.value = value
        self.rows = rows or []

    def scalar(self) -> Any:
        return self.value

    def mappings(self) -> "_Result":
        return self

    def first(self) -> Any:
        return self.value

    def all(self) -> list[tuple[Any, ...]]:
        return self.rows

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter(self.rows)


class _Conn:
    """Sync connection double: answers the catalog queries, records the rest, optionally fails a statement."""

    def __init__(self, *, superuser: bool = False, createrole: bool = False, exists: bool = False,
                 usable_after_grant: bool = True, fail_on: str | None = None) -> None:
        self.superuser, self.createrole, self.exists = superuser, createrole, exists
        self.usable = False
        self.usable_after_grant = usable_after_grant
        self.fail_on = fail_on
        self.sql: list[str] = []
        self.savepoints = 0

    @contextlib.contextmanager
    def begin_nested(self):  # type: ignore[no-untyped-def]
        self.savepoints += 1
        yield

    def execute(self, clause: Any, params: dict[str, Any] | None = None) -> _Result:
        sql = str(clause)
        if "rolsuper, rolcreaterole" in sql:
            return _Result({"rolsuper": self.superuser, "rolcreaterole": self.createrole})
        if "EXISTS (SELECT 1 FROM pg_roles" in sql and "CASE" not in sql:
            return _Result(self.exists)
        if sql == R.ROLE_USABLE_SQL:
            return _Result(self.usable)
        if sql == R.APP_SCHEMAS_SQL:
            return _Result(rows=[("public",)])
        if sql == R.READABLE_RELATIONS_SQL:
            return _Result(rows=[("public", "resources"), ("public", "tenants")])
        self.sql.append(sql)
        if self.fail_on and sql.startswith(self.fail_on):
            raise ProgrammingError(sql, {}, Exception("permission denied to create role"))
        if sql.startswith("CREATE ROLE"):
            self.exists = True
        if sql.startswith(f'GRANT "{R.EXPLORER_ROLE}" TO CURRENT_USER') and self.usable_after_grant:
            self.usable = True
        return _Result()


def test_superuser_creates_the_role_grants_select_on_non_sensitive_tables_and_membership() -> None:
    conn = _Conn(superuser=True)
    res = R.provision_explorer_role(conn)  # type: ignore[arg-type]
    role = f'"{R.EXPLORER_ROLE}"'
    assert res.available and res.created and res.granted == ["public.resources", "public.tenants"]
    assert conn.sql == [
        f"CREATE ROLE {role} NOLOGIN",
        f'REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM {role}',
        f'GRANT USAGE ON SCHEMA "public" TO {role}',
        f'GRANT SELECT ON "public"."resources" TO {role}',
        f'GRANT SELECT ON "public"."tenants" TO {role}',
        f"GRANT {role} TO CURRENT_USER",
    ]
    assert not any("DEFAULT PRIVILEGES" in q for q in conn.sql)  # later tables are not granted by accident
    assert not any(q.startswith(("GRANT INSERT", "GRANT UPDATE", "GRANT DELETE", "GRANT ALL")) for q in conn.sql)


def test_user_without_createrole_changes_nothing_and_warns(caplog: pytest.LogCaptureFixture) -> None:
    conn = _Conn()
    with caplog.at_level(logging.WARNING, logger=R.logger.name):
        res = R.provision_explorer_role(conn)  # type: ignore[arg-type]
    assert not res.available and "CREATEROLE" in res.reason
    assert conn.sql == []
    assert "without privilege isolation" in caplog.text


def test_a_refused_grant_does_not_fail_the_migration(caplog: pytest.LogCaptureFixture) -> None:
    conn = _Conn(createrole=True, fail_on="CREATE ROLE")
    with caplog.at_level(logging.WARNING, logger=R.logger.name):
        res = R.provision_explorer_role(conn)  # type: ignore[arg-type]
    assert not res.available and "permission denied" in res.reason
    assert conn.savepoints == 1  # the statements ran in a savepoint, rolled back with it
    assert "without privilege isolation" in caplog.text


def test_existing_role_that_the_login_can_not_use_is_reported() -> None:
    conn = _Conn(exists=True, usable_after_grant=False, fail_on=f'GRANT "{R.EXPLORER_ROLE}" TO CURRENT_USER')
    res = R.provision_explorer_role(conn)  # type: ignore[arg-type]
    assert not res.available and not res.created
    assert "can not be granted" in res.reason


def test_rerun_with_a_usable_role_only_refreshes_the_grants() -> None:
    conn = _Conn(superuser=True, exists=True)
    conn.usable = True
    res = R.provision_explorer_role(conn)  # type: ignore[arg-type]
    assert res.available and not res.created
    assert not any(q.startswith(("CREATE ROLE", f'GRANT "{R.EXPLORER_ROLE}"')) for q in conn.sql)


def test_drop_revokes_then_drops_and_keeps_a_role_still_used_elsewhere(caplog: pytest.LogCaptureFixture) -> None:
    conn = _Conn(superuser=True, exists=True)
    assert R.drop_explorer_role(conn) is True  # type: ignore[arg-type]
    role = f'"{R.EXPLORER_ROLE}"'
    assert conn.sql == [
        f'REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM {role}',
        f'REVOKE ALL ON SCHEMA "public" FROM {role}',
        f"REVOKE {role} FROM CURRENT_USER",
        f"DROP ROLE {role}",
    ]
    conn = _Conn(superuser=True, exists=True, fail_on="DROP ROLE")
    with caplog.at_level(logging.WARNING, logger=R.logger.name):
        assert R.drop_explorer_role(conn) is False  # type: ignore[arg-type]
    assert "kept" in caplog.text
    assert R.drop_explorer_role(_Conn()) is True  # type: ignore[arg-type]  # no role: nothing to do


def test_role_names_are_validated() -> None:
    with pytest.raises(ValueError):
        R.provision_explorer_role(_Conn(superuser=True), role='x"; DROP ROLE postgres; --')  # type: ignore[arg-type]


def test_every_sensitive_table_is_excluded_from_the_grants_and_from_readable_views() -> None:
    sql = R.READABLE_RELATIONS_SQL
    for table in R.SENSITIVE_TABLES:
        assert sql.count(f"'{table}'") == 2  # the relation itself, and any view whose rules read it
    assert "pg_has_role(c.relowner, 'USAGE')" in sql  # only what the migrating user can grant


def _migrations() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in VERSIONS.glob("0*.py"):
        values: dict[str, Any] = {}
        for node in ast.parse(path.read_text(encoding="utf-8")).body:
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ("revision", "down_revision"):
                values[node.targets[0].id] = ast.literal_eval(node.value)
        out[values["revision"]] = values
    return out


def test_migration_0015_is_the_single_head_with_short_revision_ids() -> None:
    migrations = _migrations()
    assert all(len(rev) <= 32 for rev in migrations)  # alembic_version.version_num is varchar(32)
    parents = {m["down_revision"] for m in migrations.values()}
    heads = [rev for rev in migrations if rev not in parents]
    assert heads == ["0015_explorer_ro_role"]
    assert migrations["0015_explorer_ro_role"]["down_revision"] == "0014_bulk_jobs_failed_idx"


def test_migration_0015_calls_the_shared_provisioning() -> None:
    spec = importlib.util.spec_from_file_location("m0015", VERSIONS / "0015_explorer_ro_role.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.provision_explorer_role is R.provision_explorer_role
    assert mod.drop_explorer_role is R.drop_explorer_role
