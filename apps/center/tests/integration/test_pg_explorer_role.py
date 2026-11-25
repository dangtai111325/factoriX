"""B-14 / OP-19 against real PostgreSQL 17: the explorer's read-only role is enforced by PostgreSQL itself.

The database is at the Alembic head (migration ``0015_explorer_ro_role`` provisioned ``factorix_explorer_ro``); CI
connects as a superuser, so the role is available. Proven here:

* a sensitive table is refused by PostgreSQL (``42501``) even when the explorer's own 403 list check is bypassed,
  while the same statement under the application role succeeds (the table exists; the role is what refuses);
* writes are refused: by the read-only transaction, and by the role alone in a read-write transaction;
* a normal table is readable through the explorer, which runs as the role;
* a table created after the provisioning is not readable (no default privileges);
* a login that can not use the role falls back to the read-only transaction and the status says so, and a user
  without ``CREATEROLE`` provisions nothing and does not fail.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from factorix.modules import postgres_explorer as PE
from factorix.platform import pg_explorer_role as R
from factorix.platform.errors import AppError

ROLE = R.EXPLORER_ROLE


@pytest_asyncio.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(os.environ["FACTORIX_DATABASE_URL"], poolclass=NullPool)
    try:
        async with eng.begin() as conn:
            assert await conn.scalar(text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :r)"), {"r": ROLE}), (
                "migration 0015_explorer_ro_role did not create the role"
            )
            # Idempotent re-run: also grants the tables other integration tests created since the migration.
            result = await conn.run_sync(R.provision_explorer_role)
        assert result.available, result.reason
        yield eng
    finally:
        await eng.dispose()


async def _existing_sensitive_tables(eng: AsyncEngine) -> list[str]:
    async with eng.connect() as conn:
        names = [t for t in sorted(R.SENSITIVE_TABLES) if await conn.scalar(text("SELECT to_regclass(:t) IS NOT NULL"), {"t": f"public.{t}"})]
    assert "admin_accounts" in names and "secret_store" in names
    return names


def _sqlstate(exc: BaseException) -> str | None:
    return PE._sqlstate(exc)


@asynccontextmanager
async def tx(eng: AsyncEngine) -> AsyncIterator[AsyncSession]:
    """One request-like transaction, always rolled back (also after a statement PostgreSQL refused)."""
    async with AsyncSession(eng) as session:
        await session.begin()
        try:
            yield session
        finally:
            await session.rollback()


async def test_explorer_transaction_runs_as_the_read_only_role(engine: AsyncEngine) -> None:
    async with tx(engine) as session:
        status = await PE.PostgresExplorerService().status(session)
        assert status["privilege_isolation"] is True and status["role"] == ROLE
        assert await session.scalar(text("SELECT current_user")) == ROLE
        assert await session.scalar(text("SELECT current_setting('transaction_read_only')")) == "on"


async def test_sensitive_tables_are_refused_by_postgresql_even_without_the_403_check(
    engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    sensitive = await _existing_sensitive_tables(engine)
    for table in sensitive:
        sql = f'SELECT count(*) AS total FROM "public"."{table}"'
        # The application role reads it (the table exists) ...
        async with tx(engine) as session:
            assert (await session.execute(text(sql))).scalar() is not None
        # ... the explorer's role does not: PostgreSQL answers 42501, the explorer turns it into a 403.
        async with tx(engine) as session:
            assert await PE.enter_read_only(session) is True
            with pytest.raises(AppError) as exc:
                await PE._ro_fetch_one(session, sql, {})
            assert exc.value.status == 403 and exc.value.code == "EXPLORER_NOT_GRANTED", table
            assert _sqlstate(exc.value.__cause__) == "42501"

    # The service itself with its 403 list switched off: still no row of a sensitive table comes back.
    monkeypatch.setattr(PE, "_assert_not_sensitive", lambda *_a, **_k: None)
    monkeypatch.setattr(PE, "SENSITIVE_TABLES", frozenset())
    svc = PE.PostgresExplorerService()
    for table in sensitive:
        for call in (
            lambda s: svc.count_rows(s, table=table),
            lambda s: svc.preview_data(s, table=table),
        ):
            async with tx(engine) as session:
                with pytest.raises(AppError) as exc:
                    await call(session)
                # not visible in the role's catalog (404) or refused by PostgreSQL (403): never data
                assert exc.value.status in (403, 404), (table, exc.value.code)
        async with tx(engine) as session:
            assert await svc.get_table_details(session, table=table) is None
        async with tx(engine) as session:
            listed = {t["name"] for t in await svc.list_tables(session)}
            assert table not in listed


async def test_writes_are_refused_by_the_transaction_and_by_the_role(engine: AsyncEngine) -> None:
    tenant_id = uuid4()
    insert = text("INSERT INTO tenants (id, code, display_name, created_at) VALUES (:id, :code, 'probe', now())")
    params = {"id": tenant_id, "code": f"zz-ro-{tenant_id.hex[:8]}"}
    # Explorer transaction: read-only + role.
    async with tx(engine) as session:
        await PE.enter_read_only(session)
        with pytest.raises(DBAPIError) as exc:
            await session.execute(insert, params)
        assert _sqlstate(exc.value) in ("25006", "42501")
    # The role alone, in a read-WRITE transaction: PostgreSQL refuses every write privilege.
    for stmt, stmt_params in (
        (insert, params),
        (text("UPDATE tenants SET display_name = 'x'"), {}),
        (text("DELETE FROM tenants"), {}),
        (text(f"CREATE TABLE fx_explorer_ro_probe_{uuid4().hex[:8]} (id int)"), {}),
        (text("TRUNCATE tenants"), {}),
    ):
        async with tx(engine) as session:
            await session.execute(text(f"SET LOCAL ROLE {ROLE}"))
            assert await session.scalar(text("SELECT current_setting('transaction_read_only')")) == "off"
            with pytest.raises(DBAPIError) as exc:
                await session.execute(stmt, stmt_params)
            assert _sqlstate(exc.value) == "42501", str(stmt)
    async with engine.connect() as conn:
        assert await conn.scalar(text("SELECT count(*) FROM tenants WHERE id = :id"), {"id": tenant_id}) == 0


async def test_a_normal_table_is_readable_through_the_explorer(engine: AsyncEngine) -> None:
    svc = PE.PostgresExplorerService()
    async with tx(engine) as session:
        listed = {t["name"] for t in await svc.list_tables(session)}
        assert "tenants" in listed and "resources" in listed
        out = await svc.count_rows(session, table="tenants")
        assert out["exact_rows"] >= 0 and out["tenant_scoped"] is False
        assert await session.scalar(text("SELECT current_user")) == ROLE
    async with tx(engine) as session:
        details = await svc.get_table_details(session, table="tenants")
        assert details and "code" in {c["name"] for c in details["columns"]}
    async with tx(engine) as session:
        preview = await svc.preview_data(session, table="tenants", limit=5)
        assert preview["columns"] and isinstance(preview["rows"], list)


async def test_a_table_created_later_is_not_readable(engine: AsyncEngine) -> None:
    name = f"fx_explorer_new_{uuid4().hex[:8]}"
    async with engine.begin() as conn:
        await conn.execute(text(f'CREATE TABLE "{name}" (id int PRIMARY KEY, note text)'))
        await conn.execute(text(f'INSERT INTO "{name}" VALUES (1, \'not for the explorer\')'))
    try:
        async with tx(engine) as session:
            await PE.enter_read_only(session)
            with pytest.raises(AppError) as exc:
                await PE._ro_fetch_one(session, f'SELECT count(*) AS total FROM "public"."{name}"', {})
            assert exc.value.code == "EXPLORER_NOT_GRANTED"
        async with tx(engine) as session:
            listed = {t["name"] for t in await PE.PostgresExplorerService().list_tables(session)}
            assert name not in listed
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP TABLE IF EXISTS "{name}"'))


async def test_a_login_without_the_role_falls_back_and_reports_it(engine: AsyncEngine) -> None:
    probe = f"fx_explorer_probe_{uuid4().hex[:8]}"
    missing_role = f"fx_explorer_ro_missing_{uuid4().hex[:8]}"
    async with engine.begin() as conn:
        await conn.execute(text(f'CREATE ROLE "{probe}" NOLOGIN'))
    try:
        # Explorer under a session user that is not a member of the role: no SET ROLE, status says so.
        async with tx(engine) as session:
            await session.execute(text(f'SET LOCAL SESSION AUTHORIZATION "{probe}"'))
            status = await PE.PostgresExplorerService().status(session)
            assert status["privilege_isolation"] is False and status["read_only_transaction"] is True
            assert await session.scalar(text("SELECT current_user")) == probe
        # Provisioning as a user without SUPERUSER / CREATEROLE: warning, nothing created, no exception.
        async with engine.connect() as conn:
            await conn.execute(text(f'SET LOCAL SESSION AUTHORIZATION "{probe}"'))
            result = await conn.run_sync(lambda c: R.provision_explorer_role(c, role=missing_role))
            await conn.rollback()
        assert result.available is False and "CREATEROLE" in result.reason
        async with engine.connect() as conn:
            assert not await conn.scalar(text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :r)"), {"r": missing_role})
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP ROLE IF EXISTS "{probe}"'))
