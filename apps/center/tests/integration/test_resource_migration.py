"""Exercise fresh and legacy upgrades using only the explicitly disposable DB."""

import asyncio
import os
import sys
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from test_support.center import wipe_database
from test_support.database import require_disposable_database

ROOT = Path(__file__).resolve().parents[4]
TENANT = UUID("10000000-0000-0000-0000-000000000001")
PARENT = UUID("10000000-0000-0000-0000-000000000006")
SITE = UUID("10000000-0000-0000-0000-000000000007")
MACHINE = UUID("10000000-0000-0000-0000-000000000008")


async def migrate(direction, revision, *, succeeds=True):
    require_disposable_database(os.environ["FACTORIX_DATABASE_URL"])
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "alembic", direction, revision, cwd=ROOT / "apps/center",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await process.communicate()
    message = output.decode(errors="replace")
    assert (process.returncode == 0) == succeeds, message
    return message


async def clean_pool():
    import factorix.platform.db as database

    await wipe_database()
    engine = database._engine
    database._engine = database._session_factory = None
    if engine is not None:
        await engine.dispose()


async def legacy_fixture(engine):
    # Deliberately uses the old schema: only temporal CONTAINS edges identify the parent.
    statements = [
        """INSERT INTO tenants (id, code, display_name, created_at)
           VALUES ('10000000-0000-0000-0000-000000000001', 'migration', 'Migration', '2020-01-01Z')""",
        """INSERT INTO resource_types (id, tenant_id, key, name, category) VALUES
           ('10000000-0000-0000-0000-000000000002', :tenant, 'enterprise', 'Enterprise', 'ENTERPRISE'),
           ('10000000-0000-0000-0000-000000000003', :tenant, 'site', 'Site', 'SITE'),
           ('10000000-0000-0000-0000-000000000004', :tenant, 'machine', 'Machine', 'ASSET')""",
        """INSERT INTO sites (id, tenant_id, code, name, timezone, created_at)
           VALUES ('10000000-0000-0000-0000-000000000005', :tenant, 'DN', 'Đồng Nai', 'Asia/Ho_Chi_Minh', '2020-01-01Z')""",
        """INSERT INTO resources (id, tenant_id, type_id, site_id, code, name, version, properties_json, created_at, updated_at) VALUES
           (:parent, :tenant, '10000000-0000-0000-0000-000000000002', NULL, 'E1', 'Enterprise', 2, '{}', '2020-01-01Z', '2020-01-01Z'),
           (:site, :tenant, '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000005', 'DN', 'Đồng Nai', 3, '{}', '2020-01-01Z', '2020-01-01Z'),
           (:machine, :tenant, '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000005', 'M01', 'Máy ép', 7, CAST(:properties AS jsonb), '2020-01-01Z', '2021-02-03Z')""",
        """INSERT INTO relation_types (id, tenant_id, code, inverse_label, from_categories, to_categories, acyclic, temporal)
           VALUES ('10000000-0000-0000-0000-000000000009', :tenant, 'CONTAINS', 'Part of', '[]', '[]', TRUE, FALSE)""",
        """INSERT INTO resource_relations (id, tenant_id, from_id, to_id, relation_type_id, valid_from, created_at) VALUES
           ('10000000-0000-0000-0000-000000000010', :tenant, :parent, :site, '10000000-0000-0000-0000-000000000009', '2020-01-01Z', '2020-01-01Z'),
           ('10000000-0000-0000-0000-000000000011', :tenant, :site, :machine, '10000000-0000-0000-0000-000000000009', '2020-01-01Z', '2020-01-01Z')""",
    ]
    async with engine.begin() as connection:
        for statement in statements:
            await connection.execute(text(statement), {"tenant": TENANT, "parent": PARENT, "site": SITE, "machine": MACHINE,
                                                       "properties": '{"serial":"0001","enabled":false}'})


@pytest.mark.asyncio
async def test_legacy_upgrade_backfills_parent_and_site_anchor_without_changing_asset_data():
    await clean_pool()
    await migrate("downgrade", "0006_merge_collector_review2")
    engine = create_async_engine(os.environ["FACTORIX_DATABASE_URL"])
    try:
        await legacy_fixture(engine)
        await engine.dispose()
        await migrate("upgrade", "head")
        async with engine.connect() as connection:
            row = (await connection.execute(text("SELECT * FROM resources WHERE id = :id"), {"id": MACHINE})).mappings().one()
            assert row["parent_id"] == SITE and row["version"] == 7 and row["name"] == "Máy ép"
            assert row["properties_json"] == {"serial": "0001", "enabled": False}
            assert row["updated_at"].isoformat() == "2021-02-03T00:00:00+00:00"
            anchor = await connection.scalar(text("SELECT resource_id FROM sites WHERE tenant_id = :id"), {"id": TENANT})
            assert anchor == SITE
            assert await connection.scalar(text("SELECT count(*) FROM resource_relations")) == 2
    finally:
        await engine.dispose()
        await migrate("upgrade", "head")


@pytest.mark.asyncio
async def test_ambiguous_legacy_parent_aborts_upgrade_without_partial_schema_changes():
    await clean_pool()
    await migrate("downgrade", "0006_merge_collector_review2")
    engine = create_async_engine(os.environ["FACTORIX_DATABASE_URL"])
    try:
        await legacy_fixture(engine)
        async with engine.begin() as connection:
            await connection.execute(text("""INSERT INTO resource_relations
                (id, tenant_id, from_id, to_id, relation_type_id, valid_from, created_at)
                VALUES ('10000000-0000-0000-0000-000000000012', :tenant, :parent, :machine,
                '10000000-0000-0000-0000-000000000009', now(), now())"""),
                {"tenant": TENANT, "parent": PARENT, "machine": MACHINE})
        await engine.dispose()
        message = await migrate("upgrade", "head", succeeds=False)
        assert "Resolve multiple current parents" in message
        async with engine.connect() as connection:
            assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "0006_merge_collector_review2"
            assert await connection.scalar(text("""SELECT count(*) FROM information_schema.columns
                WHERE table_name = 'resources' AND column_name = 'parent_id'""")) == 0
            assert await connection.scalar(text("SELECT version FROM resources WHERE id = :id"), {"id": MACHINE}) == 7
    finally:
        async with engine.begin() as connection:
            await connection.execute(text("DELETE FROM resource_relations WHERE id = '10000000-0000-0000-0000-000000000012'"))
        await engine.dispose()
        await migrate("upgrade", "head")


@pytest.mark.asyncio
async def test_fresh_install_enforces_root_and_sibling_uniqueness_in_postgres():
    await clean_pool()
    await migrate("downgrade", "base")
    await migrate("upgrade", "head")
    engine = create_async_engine(os.environ["FACTORIX_DATABASE_URL"])
    try:
        # The legacy fixture also fits the expanded schema before canonical parents are populated.
        await legacy_fixture(engine)
        for parent_id, code in ((None, "E1"), (SITE, "Child")):
            async with engine.begin() as connection:
                insert = text("""INSERT INTO resources (id, tenant_id, type_id, parent_id, code, name, created_at, updated_at)
                    VALUES (gen_random_uuid(), :tenant, '10000000-0000-0000-0000-000000000004', :parent, :code, 'Duplicate', now(), now())""")
                params = {"tenant": TENANT, "parent": parent_id, "code": code}
                if parent_id is not None:
                    await connection.execute(insert, params)
                with pytest.raises(IntegrityError):
                    async with connection.begin_nested():
                        await connection.execute(insert, params)
    finally:
        await engine.dispose()
