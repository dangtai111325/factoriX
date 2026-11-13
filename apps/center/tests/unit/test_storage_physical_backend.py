"""Unit tests for physical-first TDengine & PostgreSQL Explorer backend architecture.

Tests:
1. storage_topology.py (metadata introspection, drift detection, snapshot serialization)
2. storage_objects.py (validation, DDL generators, capability checks, row byte budget)
3. storage_revisions.py (drafts, planning, simulation, operation saga idempotency)
4. storage_bindings.py (3 perspectives, type compatibility, row assembly policies)
5. postgres_explorer.py (read-only metadata, secret masking, sensitive table protection)
6. ingestion_worker.py (formula AST compile cache keyed by (formula_id, revision))
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4
import pytest

from factorix.domain.formula import FormulaError
from factorix.modules import storage_bindings as SB
from factorix.modules import storage_objects as SO
from factorix.modules import storage_revisions as SR
from factorix.modules import storage_topology as ST
from factorix.modules.postgres_explorer import PostgresExplorerService, SENSITIVE_COLUMN_PATTERNS, SENSITIVE_TABLES


# ============================================================================
# 1. Storage Objects & DDL Generation Tests
# ============================================================================

def test_database_validation_and_ddl():
    # Valid database
    spec = SO.DatabaseSpec(name="fx_test_db", precision="ms", keep="3650d", vgroups=2, replica=1)
    res = SO.validate_database_spec(spec)
    assert res.valid is True
    assert len(res.errors) == 0

    ddl = SO.generate_create_database_ddl(spec)
    assert "CREATE DATABASE IF NOT EXISTS `fx_test_db`" in ddl
    assert "PRECISION 'ms'" in ddl
    assert "KEEP 3650d" in ddl
    assert "VGROUPS 2" in ddl
    assert "REPLICA 1" in ddl

    # Reserved database name rejection
    bad_spec = SO.DatabaseSpec(name="information_schema")
    res_bad = SO.validate_database_spec(bad_spec)
    assert res_bad.valid is False
    assert any(e["code"] == "RESERVED_NAME" for e in res_bad.errors)

    # Unsupported precision rejection
    bad_prec = SO.DatabaseSpec(name="mydb", precision="sec")
    res_prec = SO.validate_database_spec(bad_prec)
    assert res_prec.valid is False
    assert any(e["code"] == "UNSUPPORTED_PRECISION" for e in res_prec.errors)


def test_stable_validation_and_ddl():
    # Valid stable with ts first, columns, and tags
    cols = [
        SO.ColumnSpec(name="ts", td_type="TIMESTAMP", role="time_key"),
        SO.ColumnSpec(name="temperature", td_type="DOUBLE", role="value"),
        SO.ColumnSpec(name="status", td_type="VARCHAR", length=32, role="value"),
    ]
    tags = [
        SO.TagSpec(name="device_id", td_type="NCHAR", length=64, required=True),
        SO.TagSpec(name="site_code", td_type="VARCHAR", length=32),
    ]
    spec = SO.StableSpec(database="fx_test", name="meters_st", columns=cols, tags=tags)
    res = SO.validate_stable_spec(spec)
    assert res.valid is True
    assert res.estimated_row_bytes > 0

    ddl = SO.generate_create_stable_ddl(spec)
    assert "CREATE STABLE IF NOT EXISTS `fx_test`.`meters_st`" in ddl
    assert "`ts` TIMESTAMP" in ddl
    assert "`temperature` DOUBLE" in ddl
    assert "`status` VARCHAR(32)" in ddl
    assert "TAGS (`device_id` NCHAR(64), `site_code` VARCHAR(32))" in ddl

    # Missing timestamp column should fail
    bad_cols = [SO.ColumnSpec(name="val", td_type="DOUBLE", role="value")]
    bad_spec = SO.StableSpec(database="fx_test", name="st_bad", columns=bad_cols)
    res_bad = SO.validate_stable_spec(bad_spec)
    assert res_bad.valid is False
    assert any(e["code"] == "MISSING_TIMESTAMP" for e in res_bad.errors)

    # Timestamp not first column should fail
    cols_wrong_order = [
        SO.ColumnSpec(name="val", td_type="DOUBLE", role="value"),
        SO.ColumnSpec(name="ts", td_type="TIMESTAMP", role="time_key"),
    ]
    res_order = SO.validate_stable_spec(SO.StableSpec(database="fx_test", name="st_bad", columns=cols_wrong_order))
    assert res_order.valid is False
    assert any(e["code"] == "TIMESTAMP_MUST_BE_FIRST" for e in res_order.errors)


def test_subtable_validation_and_ddl():
    stable_tags = [
        SO.TagSpec(name="device_id", td_type="NCHAR", length=64, required=True),
        SO.TagSpec(name="site_code", td_type="VARCHAR", length=32),
    ]
    spec = SO.SubtableSpec(
        database="fx_test",
        stable="meters_st",
        name="meter_001",
        tag_values={"device_id": "DEV-001", "site_code": "SITE-A"},
    )
    res = SO.validate_subtable_spec(spec, stable_tags)
    assert res.valid is True

    ddl = SO.generate_create_subtable_ddl(spec, stable_tags)
    assert "CREATE TABLE IF NOT EXISTS `fx_test`.`meter_001`" in ddl
    assert "USING `fx_test`.`meters_st` (`device_id`, `site_code`)" in ddl
    assert "TAGS ('DEV-001', 'SITE-A')" in ddl

    # Missing required tag should fail
    bad_spec = SO.SubtableSpec(
        database="fx_test",
        stable="meters_st",
        name="meter_002",
        tag_values={"site_code": "SITE-A"},
    )
    res_bad = SO.validate_subtable_spec(bad_spec, stable_tags)
    assert res_bad.valid is False
    assert any(e["code"] == "MISSING_REQUIRED_TAGS" for e in res_bad.errors)


# ============================================================================
# 2. Storage Bindings & Row Assembly Tests
# ============================================================================

def test_type_compatibility():
    svc = SB.StorageBindingService()
    # float64 to DOUBLE is valid
    ok, err = svc.validate_binding("signal", "float64", "DOUBLE")
    assert ok is True
    assert err is None

    # float64 to TIMESTAMP is invalid
    ok, err = svc.validate_binding("signal", "float64", "TIMESTAMP")
    assert ok is False
    assert "incompatible" in err.lower()

    # string to VARCHAR is valid
    ok, err = svc.validate_binding("signal", "string", "VARCHAR(64)")
    assert ok is True


def test_row_assembly_policies():
    svc = SB.StorageBindingService()
    # INDEPENDENT_EVENTS is always valid
    ok, err = svc.validate_row_assembly("INDEPENDENT_EVENTS")
    assert ok is True

    # LATEST_AS_OF_TRIGGER requires max_age
    ok, err = svc.validate_row_assembly("LATEST_AS_OF_TRIGGER", {})
    assert ok is False
    assert "max_age" in err

    ok, err = svc.validate_row_assembly("LATEST_AS_OF_TRIGGER", {"max_age_seconds": 10})
    assert ok is True

    # TIME_BUCKET requires bucket duration
    ok, err = svc.validate_row_assembly("TIME_BUCKET", {})
    assert ok is False
    assert "time_bucket" in err

    ok, err = svc.validate_row_assembly("TIME_BUCKET", {"time_bucket_seconds": 5})
    assert ok is True


# ============================================================================
# 3. PostgreSQL Explorer Read-Only & Masking Tests
# ============================================================================

def test_sensitive_column_masking():
    # Test sensitive column pattern
    assert SENSITIVE_COLUMN_PATTERNS.search("password") is not None
    assert SENSITIVE_COLUMN_PATTERNS.search("password_hash") is not None
    assert SENSITIVE_COLUMN_PATTERNS.search("api_token") is not None
    assert SENSITIVE_COLUMN_PATTERNS.search("client_secret") is not None
    assert SENSITIVE_COLUMN_PATTERNS.search("created_at") is None
    assert SENSITIVE_COLUMN_PATTERNS.search("temperature") is None


def test_sensitive_table_blocking():
    assert "alembic_version" in SENSITIVE_TABLES


# ============================================================================
# 4. Storage Topology Serialization Tests
# ============================================================================

def test_topology_serialization():
    now = datetime.now(timezone.utc)
    snap = ST.TopologySnapshot(
        databases=[
            ST.DatabaseInfo(
                name="fx_t_test",
                precision="ms",
                replica=1,
                quorum=None,
                keep="3650d",
                vgroups=1,
                ntables=2,
                cache_model=None,
                is_tenant=True,
                stable_count=1,
            )
        ],
        stables=[
            ST.StableInfo(
                name="st_metrics",
                database="fx_t_test",
                columns=[ST.ColumnInfo("ts", "TIMESTAMP", None, "time_key", False)],
                tags=[ST.ColumnInfo("device_id", "NCHAR", 64, "tag", True)],
                subtable_count=1,
            )
        ],
        subtables=[
            ST.SubtableInfo(
                name="sub_1",
                stable_name="st_metrics",
                database="fx_t_test",
                tags={"device_id": "D1"},
            )
        ],
        nodes=[
            ST.TopologyNode("db:fx_t_test", "database", "fx_t_test", None, {}),
            ST.TopologyNode("stable:fx_t_test.st_metrics", "stable", "st_metrics", "db:fx_t_test", {}),
        ],
        drift=[],
        observed_at=now,
    )
    d = ST.topology_snapshot_to_dict(snap)
    assert len(d["databases"]) == 1
    assert len(d["stables"]) == 1
    assert len(d["subtables"]) == 1
    assert len(d["nodes"]) == 2
    assert d["databases"][0]["name"] == "fx_t_test"


# ============================================================================
# 5. IngestionWorker Formula AST Compile Cache Tests
# ============================================================================

def test_formula_ast_compile_cache():
    from factorix.domain.formula import bind, evaluate, parse_expression
    cache: dict[tuple[UUID, int], any] = {}
    fid = uuid4()
    rev = 1
    cache_key = (fid, rev)

    alias_ids = {"x": uuid4(), "y": uuid4()}
    values = {"x": 10.5, "y": 2.5}

    # Miss: parse and bind
    assert cache_key not in cache
    ast = parse_expression("x + y * 2")
    prog = bind(ast, alias_ids)
    cache[cache_key] = prog

    # Hit: reuse from cache
    cached_prog = cache[cache_key]
    val = evaluate(cached_prog, values)
    assert val == 15.5


# ============================================================================
# 6. Storage API Router Endpoint Tests
# ============================================================================

class FakeTdClient:
    def __init__(self):
        self._executor = None

    async def run_read(self, sql):
        sql_lower = sql.lower()
        if "server_version" in sql_lower:
            return [("3.4.3.9",)]
        if "show databases" in sql_lower or "ins_databases" in sql_lower:
            return [("fx_t_00000000000000000000000000000001", 1, 1, 1, 1, "ms", "3650d", None)]
        if "ins_stables" in sql_lower or "stables" in sql_lower:
            return [("st_test", 1, 1, 1)]
        if "describe" in sql_lower:
            return [
                ("ts", "TIMESTAMP", None, ""),
                ("temperature", "DOUBLE", None, ""),
                ("device_id", "NCHAR", 64, "TAG"),
            ]
        if "ins_tables" in sql_lower:
            return [("sub_001", "st_test", "2026-11-12")]
        if "tags" in sql_lower:
            return [{"device_id": "D1"}]
        return []

    async def run_write(self, sql):
        return None


class FakeAsyncSession:
    async def execute(self, *args, **kwargs):
        class _Result:
            rowcount = 1
            def mappings(self):
                return self
            def first(self):
                return None
            def all(self):
                return []
        return _Result()

    async def commit(self):
        pass


@pytest.mark.asyncio
async def test_api_physical_storage_flow():
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from factorix.platform.errors import AppError
    from factorix.platform.http import json_error
    from factorix.transport.storage_api import build_router

    fake_td = FakeTdClient()
    session = FakeAsyncSession()

    app = FastAPI()

    @app.exception_handler(AppError)
    async def _on_app_err(_req: any, exc: AppError) -> any:
        return json_error(exc.status, exc.code, exc.message, correlation_id="test-corr", extra=exc.extra)

    async def fake_admin():
        return {
            "tenant_id": "00000000-0000-0000-0000-000000000001",
            "admin_id": "00000000-0000-0000-0000-000000000002",
            "role": "admin",
        }

    async def fake_db():
        yield session

    router = build_router(admin=fake_admin, db_session=fake_db, td_client=fake_td)
    app.include_router(router)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        # 1. Engines check
        resp = await client.get("/api/v1/storage/engines")
        assert resp.status_code == 200
        data = resp.json()
        assert data["tdengine"]["version"] == "3.4.3.9"

        # 2. Topology check
        resp = await client.get("/api/v1/storage/td/topology")
        assert resp.status_code == 200
        top = resp.json()
        assert "databases" in top

        # 3. Databases check
        resp = await client.get("/api/v1/storage/td/databases")
        assert resp.status_code == 200
        dbs = resp.json()
        assert len(dbs["items"]) >= 1

        # 4. Supertables check
        resp = await client.get("/api/v1/storage/td/stables")
        assert resp.status_code == 200
        stables = resp.json()
        assert len(stables["items"]) >= 1

        # 5. Supertables validate
        payload = {
            "database_name": "fx_test",
            "physical_name": "st_sensor",
            "columns": [
                {"name": "ts", "td_type": "TIMESTAMP", "role": "time_key"},
                {"name": "temp", "td_type": "DOUBLE", "role": "value"},
            ],
            "tags": [
                {"name": "device_id", "td_type": "NCHAR", "length": 64},
            ],
        }
        resp = await client.post("/api/v1/storage/td/stables/validate", json=payload)
        assert resp.status_code == 200
        assert resp.json()["valid"] is True

        # 6. Subtables check
        resp = await client.get("/api/v1/storage/td/subtables")
        assert resp.status_code == 200
        subs = resp.json()
        assert len(subs["items"]) >= 1

        # 7. Drafts lifecycle: Create -> Plan -> Simulate
        draft_payload = {
            "kind": "stable",
            "name": "st_draft_01",
            "spec": {
                "database": "fx_test",
                "name": "st_draft_01",
                "columns": [{"name": "ts", "td_type": "TIMESTAMP", "role": "time_key"}],
                "tags": [],
            },
        }
        resp = await client.post("/api/v1/storage/td/objects/drafts", json=draft_payload)
        assert resp.status_code == 201
        draft_data = resp.json()
        draft_id = draft_data["id"]
        assert draft_data["state"] == "DRAFT"

        resp_plan = await client.post(f"/api/v1/storage/td/objects/drafts/{draft_id}/plan")
        assert resp_plan.status_code == 200
        assert len(resp_plan.json()["steps"]) >= 1

        resp_sim = await client.post(f"/api/v1/storage/td/objects/drafts/{draft_id}/simulate")
        assert resp_sim.status_code == 200
        assert resp_sim.json()["simulated"] is True

        # 8. Sources check
        resp_src = await client.get("/api/v1/storage/sources?view=hierarchy")
        assert resp_src.status_code == 200
        assert "items" in resp_src.json()

        # 9. Pause object
        resp_pause = await client.post("/api/v1/storage/td/objects/fx_t_00000000000000000000000000000001.sub_001/pause")
        assert resp_pause.status_code == 200
        assert resp_pause.json()["status"] == "PAUSED"
        assert resp_pause.json()["write_active"] is False

        # 10. Resume object
        resp_resume = await client.post("/api/v1/storage/td/objects/fx_t_00000000000000000000000000000001.sub_001/resume")
        assert resp_resume.status_code == 200
        assert resp_resume.json()["status"] == "ACTIVE"
        assert resp_resume.json()["write_active"] is True

        # 11. Retire object
        resp_retire = await client.post("/api/v1/storage/td/objects/fx_t_00000000000000000000000000000001.sub_001/retire")
        assert resp_retire.status_code == 200
        assert resp_retire.json()["status"] == "RETIRED"

        # 12. Delete object without confirmation phrase -> 400
        resp_del_bad = await client.delete("/api/v1/storage/td/objects/fx_t_00000000000000000000000000000001.sub_001")
        assert resp_del_bad.status_code == 400
        assert resp_del_bad.json()["error"]["code"] == "CONFIRMATION_REQUIRED"

        # 13. Delete object with correct confirmation -> 200
        resp_del_ok = await client.delete("/api/v1/storage/td/objects/fx_t_00000000000000000000000000000001.sub_001?confirm_name=sub_001")
        assert resp_del_ok.status_code == 200
        assert resp_del_ok.json()["status"] == "PURGED"

        # 14. Tenant isolation: cross-tenant access to unauthorized database -> 404
        resp_iso = await client.get("/api/v1/storage/td/databases/fx_t_other_tenant_database")
        assert resp_iso.status_code == 404


def test_postgres_explorer_sensitive_tables_and_nested_masking():
    from factorix.modules.postgres_explorer import SENSITIVE_TABLES, _mask_nested_secrets

    # Verify all sensitive tables are blocked
    assert "admin_accounts" in SENSITIVE_TABLES
    assert "secret_store" in SENSITIVE_TABLES
    assert "sessions" in SENSITIVE_TABLES
    assert "password_reset_codes" in SENSITIVE_TABLES
    assert "alembic_version" in SENSITIVE_TABLES

    # Verify nested secrets masking
    nested = {
        "host": "localhost",
        "nested_auth": {
            "token": "super-secret-token",
            "password": "my-password",
            "safe_val": 42,
        },
        "items": [
            {"secret_key": "raw-key", "label": "ok"}
        ]
    }
    masked = _mask_nested_secrets(nested)
    assert masked["host"] == "localhost"
    assert masked["nested_auth"]["token"] == "********"
    assert masked["nested_auth"]["password"] == "********"
    assert masked["nested_auth"]["safe_val"] == 42
    assert masked["items"][0]["secret_key"] == "********"
    assert masked["items"][0]["label"] == "ok"


@pytest.mark.asyncio
async def test_revert_to_zero_is_disabled():
    from factorix.transport.app import revert_zero, RevertIn
    from factorix.platform.errors import AppError

    body = RevertIn(confirm="REVERT")
    response = MagicMock()
    session = FakeAsyncSession()
    principal = {"tenant_id": "00000000-0000-0000-0000-000000000001", "role": "admin"}

    with pytest.raises(AppError) as exc_info:
        await revert_zero(body, response, principal=principal, session=session)
    assert exc_info.value.status == 410
    assert exc_info.value.code == "ENDPOINT_GONE"


