"""Live TDengine 3.3.6.13 + PG Control Plane S05 integration POC & SchemaCompiler verification."""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from factorix.modules.storage_compiler import apply_compiled_plan, load_catalog_snapshot, reconcile_operational_registry
from factorix.modules.storage_dsl import compile_storage_plan, parse_storage_dsl, resolve_and_validate_design
from factorix.platform.tdengine import (
    SubtableWriteItem,
    TDEngineClient,
    TDEngineConfig,
    op_subtable_name,
    tenant_database_name,
)


def _td_dsn() -> str:
    return os.environ["FACTORIX_TDENGINE_DSN"]


def _pg_dsn_asyncpg() -> str:
    return os.environ["FACTORIX_DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")


@pytest.mark.asyncio
async def test_tdengine_health_probe_and_typed_round_trip() -> None:
    tenant_id = uuid4()
    db = tenant_database_name(tenant_id)
    sig_f = uuid4()
    sig_i = uuid4()
    sig_b = uuid4()
    sig_s = uuid4()
    sig_j = uuid4()
    res_id = uuid4()
    conn_id = uuid4()
    t0 = datetime(2026, 11, 10, 10, 0, 0, 123456, tzinfo=timezone.utc)

    async with TDEngineClient(_td_dsn()) as td:
        try:
            health = await td.health_probe()
            assert health.reachable is True
            assert health.server_version == "3.3.6.13"
            assert health.edition == "community"
            assert health.dnode_status == "ready"
            assert health.disk_used_bytes is not None and health.disk_used_bytes >= 0

            created_db = await td.ensure_operational_schema(tenant_id, keep_days=30, cache_mb=16)
            assert created_db == db

            json_payload = {"temp": 42.5, "unit": "\\u00b0C", "nested": {"ok": True}}
            records = [
                {
                    "signal_id": sig_f,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "float64",
                    "value": -0.0,
                    "unit": "°C",
                    "raw_quality": "GOOD",
                    "reason_code": "OK",
                    "origin": "LIVE",
                    "event_time": t0,
                    "acquired_at": t0,
                    "source_time": t0 - timedelta(milliseconds=5),
                    "event_uid": "ev-f-1",
                    "config_revision": 2,
                    "data_epoch": 1,
                    "source_seq": 10,
                },
                {
                    "signal_id": sig_i,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "int64",
                    "value": 2**63 - 1,
                    "unit": None,
                    "raw_quality": "GOOD",
                    "reason_code": "OK",
                    "origin": "LIVE",
                    "event_time": t0,
                    "acquired_at": t0,
                    "source_time": None,
                    "event_uid": "ev-i-1",
                    "config_revision": 2,
                    "data_epoch": 1,
                    "source_seq": 11,
                },
                {
                    "signal_id": sig_b,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "bool",
                    "value": True,
                    "unit": None,
                    "raw_quality": "GOOD",
                    "reason_code": "OK",
                    "origin": "LIVE",
                    "event_time": t0,
                    "acquired_at": t0,
                    "source_time": None,
                    "event_uid": "ev-b-1",
                    "config_revision": 2,
                    "data_epoch": 1,
                    "source_seq": None,
                },
                {
                    "signal_id": sig_s,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "string",
                    "value": "Nhiệt độ lò nung °C — 'quoted'",
                    "unit": None,
                    "raw_quality": "UNCERTAIN",
                    "reason_code": "RAW_SOURCE_UNCERTAIN",
                    "origin": "LIVE",
                    "event_time": t0,
                    "acquired_at": t0,
                    "source_time": None,
                    "event_uid": "ev-s-1",
                    "config_revision": 2,
                    "data_epoch": 1,
                    "source_seq": None,
                },
                {
                    "signal_id": sig_j,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "json",
                    "value": json_payload,
                    "unit": None,
                    "raw_quality": "GOOD",
                    "reason_code": "OK",
                    "origin": "LIVE",
                    "event_time": t0,
                    "acquired_at": t0,
                    "source_time": None,
                    "event_uid": "ev-j-1",
                    "config_revision": 2,
                    "data_epoch": 1,
                    "source_seq": None,
                },
            ]
            res = await td.write_operational_observations(tenant_id, records)
            assert len(res.succeeded_ids) == 5
            assert res.failures == ()

            rf = await td.query_last_row(db, op_subtable_name(sig_f, "float64"))
            assert rf is not None
            assert math.copysign(1.0, rf["val"]) == -1.0
            assert rf["ts"] == t0
            assert rf["unit"] == "°C"

            ri = await td.query_last_row(db, op_subtable_name(sig_i, "int64"))
            assert ri is not None and ri["val"] == 2**63 - 1

            rb = await td.query_last_row(db, op_subtable_name(sig_b, "bool"))
            assert rb is not None and rb["val"] is True

            rs = await td.query_last_row(db, op_subtable_name(sig_s, "string"))
            assert rs is not None and rs["val"] == "Nhiệt độ lò nung °C — 'quoted'"

            rj = await td.query_last_row(db, op_subtable_name(sig_j, "json"))
            assert rj is not None
            import json

            assert json.loads(rj["val"]) == json_payload
        finally:
            await td.drop_database(db, confirm=True)


@pytest.mark.asyncio
async def test_tdengine_partial_batch_isolation_out_of_order_queries_and_reconnect() -> None:
    tenant_id = uuid4()
    db = tenant_database_name(tenant_id)
    sig_id = uuid4()
    res_id = uuid4()
    conn_id = uuid4()
    sub = op_subtable_name(sig_id, "float64")
    base = datetime(2026, 11, 10, 11, 0, 0, tzinfo=timezone.utc)

    async with TDEngineClient(_td_dsn()) as td:
        try:
            await td.ensure_operational_schema(tenant_id)

            # Mix 3 valid floats + 1 NaN -> partial failure isolates ONLY the NaN item
            mixed = [
                {
                    "signal_id": sig_id,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "float64",
                    "value": 10.0,
                    "raw_quality": "GOOD",
                    "event_time": base,
                    "acquired_at": base,
                    "source_time": base - timedelta(seconds=2),
                    "event_uid": "uid-1",
                },
                {
                    "signal_id": sig_id,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "float64",
                    "value": float("nan"),
                    "raw_quality": "BAD",
                    "event_time": base + timedelta(seconds=10),
                    "acquired_at": base + timedelta(seconds=10),
                    "event_uid": "uid-bad-nan",
                },
                {
                    "signal_id": sig_id,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "float64",
                    "value": 30.0,
                    "raw_quality": "GOOD",
                    "event_time": base + timedelta(seconds=60),
                    "acquired_at": base + timedelta(seconds=60),
                    "source_time": base + timedelta(seconds=55),
                    "event_uid": "uid-3",
                },
                # Out-of-order insert between uid-1 and uid-3
                {
                    "signal_id": sig_id,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "float64",
                    "value": 20.0,
                    "raw_quality": "GOOD",
                    "event_time": base + timedelta(seconds=30),
                    "acquired_at": base + timedelta(seconds=30),
                    "source_time": base + timedelta(seconds=28),
                    "event_uid": "uid-2",
                },
            ]
            result = await td.write_operational_observations(tenant_id, mixed)
            assert set(result.succeeded_ids) == {"uid-1", "uid-2", "uid-3"}
            assert len(result.failures) == 1
            assert result.failures[0].item_id == "uid-bad-nan"
            assert result.failures[0].code == "NON_FINITE_FLOAT"

            # Duplicate replay of uid-2 at same ts is idempotent (row count remains 3)
            dup = await td.write_operational_observations(tenant_id, [mixed[3]])
            assert dup.succeeded_ids == ("uid-2",)
            rows = await td.query_range(db, sub, start=base - timedelta(seconds=1), end=base + timedelta(minutes=2))
            assert [r["val"] for r in rows] == [10.0, 20.0, 30.0]

            # ASOF value_at on both event and source axes
            ev_asof = await td.query_value_at(db, sub, at=base + timedelta(seconds=45), axis="event")
            assert ev_asof is not None and ev_asof["val"] == 20.0
            src_asof = await td.query_value_at(db, sub, at=base + timedelta(seconds=25), axis="source")
            assert src_asof is not None and src_asof["val"] == 10.0

            # Bucketed 60s aggregate check (bucket1 has 10 & 20 -> avg 15.0, bucket2 has 30 -> avg 30.0)
            aggs = await td.query_aggregate(db, sub, start=base, end=base + timedelta(seconds=120), bucket_ms=60_000, fn="avg")
            assert [a["agg_val"] for a in aggs] == [pytest.approx(15.0), pytest.approx(30.0)]
            assert [a["sample_count"] for a in aggs] == [2, 1]

            # Simulate underlying WS drop & force reconnect cleanly
            with td._conns_lock:
                for c in list(td._conns):
                    c.close()
            last = await td.query_last_row(db, sub)
            assert last is not None and last["val"] == 30.0

            # Intra-batch collision across two DIFFERENT event_uids at exact same ts offsets physical ts +1us cleanly
            t_col = base + timedelta(seconds=150)
            col_batch = [
                {
                    "signal_id": sig_id,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "float64",
                    "value": 41.0,
                    "raw_quality": "GOOD",
                    "event_time": t_col,
                    "acquired_at": t_col,
                    "event_uid": "uid-col-1",
                },
                {
                    "signal_id": sig_id,
                    "resource_id": res_id,
                    "connection_id": conn_id,
                    "value_type": "float64",
                    "value": 42.0,
                    "raw_quality": "GOOD",
                    "event_time": t_col,
                    "acquired_at": t_col,
                    "event_uid": "uid-col-2",
                },
            ]
            col_res = await td.write_operational_observations(tenant_id, col_batch)
            assert set(col_res.succeeded_ids) == {"uid-col-1", "uid-col-2"}
            rows2 = await td.query_range(db, sub, start=base - timedelta(seconds=1), end=base + timedelta(minutes=3))
            assert [r["val"] for r in rows2] == [10.0, 20.0, 30.0, 41.0, 42.0]
            assert rows2[-1]["acquired_at"] == t_col and rows2[-1]["ts"] == t_col + timedelta(microseconds=1)
        finally:
            await td.drop_database(db, confirm=True)


@pytest.mark.asyncio
async def test_tenant_isolation_and_explicit_subtable_clear() -> None:
    tenant_a = uuid4()
    tenant_b = uuid4()
    db_a = tenant_database_name(tenant_a)
    db_b = tenant_database_name(tenant_b)
    sig_a = uuid4()
    sig_b = uuid4()
    res_id = uuid4()
    t1 = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
    t2 = t1 + timedelta(seconds=10)

    async with TDEngineClient(_td_dsn()) as td:
        try:
            await td.ensure_operational_schema(tenant_a)
            await td.ensure_operational_schema(tenant_b)

            await td.write_operational_observations(
                tenant_a,
                [
                    {
                        "signal_id": sig_a,
                        "resource_id": res_id,
                        "value_type": "float64",
                        "value": 1.1,
                        "event_time": t1,
                        "acquired_at": t1,
                        "event_uid": "a-1",
                    },
                    {
                        "signal_id": sig_a,
                        "resource_id": res_id,
                        "value_type": "float64",
                        "value": 2.2,
                        "event_time": t2,
                        "acquired_at": t2,
                        "event_uid": "a-2",
                    },
                ],
            )
            await td.write_operational_observations(
                tenant_b,
                [
                    {
                        "signal_id": sig_b,
                        "resource_id": res_id,
                        "value_type": "float64",
                        "value": 99.9,
                        "event_time": t1,
                        "acquired_at": t1,
                        "event_uid": "b-1",
                    },
                ],
            )

            sub_a = op_subtable_name(sig_a, "float64")
            sub_b = op_subtable_name(sig_b, "float64")
            report = await td.clear_subtables_up_to(db_a, [sub_a], up_to_ts=t1)
            assert report["verified_zero"] is True
            assert report["deleted_rows"] == 1

            rem_a = await td.query_range(db_a, sub_a, start=t1 - timedelta(seconds=1), end=t2 + timedelta(seconds=1))
            assert [r["val"] for r in rem_a] == [2.2]

            # Tenant B completely untouched
            rem_b = await td.query_range(db_b, sub_b, start=t1 - timedelta(seconds=1), end=t2 + timedelta(seconds=1))
            assert [r["val"] for r in rem_b] == [99.9]
        finally:
            await td.drop_database(db_a, confirm=True)
            await td.drop_database(db_b, confirm=True)


@pytest.mark.asyncio
async def test_pg_control_plane_and_tdengine_compiler_reconcile() -> None:
    tenant_id = uuid4()
    site_id = uuid4()
    rtype_id = uuid4()
    res_id = uuid4()
    sig_id = uuid4()
    design_id = uuid4()
    ver_id = uuid4()
    ds_id = uuid4()
    db_name = tenant_database_name(tenant_id)

    pg = await asyncpg.connect(_pg_dsn_asyncpg())
    engine = create_async_engine(os.environ["FACTORIX_DATABASE_URL"], pool_pre_ping=True)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    try:
        # Ensure Alembic 0008 schema is present
        ver = await pg.fetchval("SELECT version_num FROM alembic_version LIMIT 1")
        assert ver == "0008_storage_and_historian"

        now = datetime.now(timezone.utc)
        await pg.execute(
            "INSERT INTO tenants (id, code, display_name, status, created_at) VALUES ($1, $2, 'S05 Test Tenant', 'ACTIVE', $3)",
            tenant_id,
            f"s05_{tenant_id.hex[:8]}",
            now,
        )
        await pg.execute(
            "INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at) VALUES ($1, 1, 'ACTIVE', $2)",
            tenant_id,
            now,
        )
        await pg.execute(
            "INSERT INTO sites (id, tenant_id, code, name, timezone, created_at) VALUES ($1, $2, 'S1', 'Site 1', 'UTC', $3)",
            site_id,
            tenant_id,
            now,
        )
        await pg.execute(
            "INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision) VALUES ($1, $2, 'machine', 'Machine', 'ASSET', '{}'::jsonb, false, 1)",
            rtype_id,
            tenant_id,
        )
        await pg.execute(
            "INSERT INTO resources (id, tenant_id, site_id, type_id, code, name, description, properties_json, tags_json, status, version, created_at, updated_at) VALUES ($1, $2, $3, $4, 'M01', 'M-S05-01', '', '{}'::jsonb, '[]'::jsonb, 'ACTIVE', 1, $5, $5)",
            res_id,
            tenant_id,
            site_id,
            rtype_id,
            now,
        )
        await pg.execute(
            "INSERT INTO signal_definitions (id, tenant_id, resource_id, key, display_name, description, data_type, unit, category, expected_interval_ms, status, version, created_at, updated_at) VALUES ($1, $2, $3, 'temp_1', 'Temp 1', '', 'float64', '°C', 'COLLECTED', 1000, 'ACTIVE', 1, $4, $4)",
            sig_id,
            tenant_id,
            res_id,
            now,
        )
        sig_id_2 = uuid4()
        await pg.execute(
            "INSERT INTO signal_definitions (id, tenant_id, resource_id, key, display_name, description, data_type, unit, category, expected_interval_ms, status, version, created_at, updated_at) VALUES ($1, $2, $3, 'temp_2', 'Temp 2', '', 'float64', '°C', 'COLLECTED', 1000, 'ACTIVE', 1, $4, $4)",
            sig_id_2,
            tenant_id,
            res_id,
            now,
        )

        dsl_yaml = """
apiVersion: factorix.io/storage/v1
kind: StorageDesign
metadata:
  name: S05 Compiled Test
spec:
  scope:
    mode: subtree
    resource: $machine[M-S05-01]
  destination:
    engine: tdengine
  datasets:
    - key: thermal
      semantics: state_series
      fields:
        - key: temp_c
          from: $machine[M-S05-01].temp_1
          type: float64
      recording:
        mode: ON_CHANGE
        qualityTransitions: true
      retention:
        days: 90
"""
        ast = parse_storage_dsl(dsl_yaml)

        async with TDEngineClient(_td_dsn()) as td:
            async with Session() as session:
                snap = await load_catalog_snapshot(session, tenant_id)
                resolved, issues = resolve_and_validate_design(ast, snap)
                assert [i for i in issues if i.severity == "error"] == []
                plan = compile_storage_plan(resolved, tenant_id=tenant_id, design_id=design_id, target_version=1)

                import json

                await pg.execute(
                    """
                    INSERT INTO storage_designs (id, tenant_id, name, scope_json, draft_ast_json, status, current_version, created_at, updated_at)
                    VALUES ($1, $2, 'S05 Compiled Test', $3::jsonb, $4::jsonb, 'RUNNING', 1, $5, $5)
                    """,
                    design_id,
                    tenant_id,
                    json.dumps(resolved.to_dict()["spec"]["scope"]),
                    json.dumps(resolved.to_dict()),
                    now,
                )
                await pg.execute(
                    """
                    INSERT INTO storage_design_versions (id, tenant_id, design_id, version, ast_json, ast_hash, semantic_hash, compiler_version, ddl_plan_json, plan_hash, publish_state, created_at, applied_at)
                    VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, $7, $8::jsonb, $9, 'APPLIED', $10, $10)
                    """,
                    ver_id,
                    tenant_id,
                    design_id,
                    json.dumps(resolved.to_dict()),
                    plan.ast_hash,
                    plan.semantic_hash,
                    plan.compiler_version,
                    json.dumps(plan.to_dict()),
                    plan.plan_hash,
                    now,
                )
                ds_key = plan.datasets[0]["dataset_key"]
                await pg.execute(
                    "INSERT INTO storage_datasets (id, tenant_id, design_id, dataset_key, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'RUNNING', $5, $5)",
                    ds_id,
                    tenant_id,
                    design_id,
                    ds_key,
                    now,
                )

                apply_res = await apply_compiled_plan(
                    td,
                    session,
                    tenant_id=tenant_id,
                    design_id=design_id,
                    design_version_id=ver_id,
                    dataset_ids_by_key={ds_key: ds_id},
                    plan=plan,
                    generation=1,
                )
                op_sub = await reconcile_operational_registry(
                    td,
                    session,
                    tenant_id=tenant_id,
                    signal_id=sig_id,
                    value_type="float64",
                    generation=1,
                )
                # Non-breaking v2 upgrade (ADD COLUMN on existing supertable in TDengine)
                dsl_v2 = dsl_yaml.replace(
                    "      recording:",
                    "        - key: temp_2_c\n"
                    "          from: $machine[M-S05-01].temp_2\n"
                    "          type: float64\n"
                    "      recording:",
                )
                ast_v2 = parse_storage_dsl(dsl_v2)
                resolved_v2, issues_v2 = resolve_and_validate_design(ast_v2, snap)
                assert [i for i in issues_v2 if i.severity == "error"] == []
                plan_v2 = compile_storage_plan(
                    resolved_v2, tenant_id=tenant_id, design_id=design_id, target_version=2, previous_plan=plan.to_dict()
                )
                assert plan_v2.diff.is_breaking is False
                assert plan_v2.datasets[0]["td_stable"] == plan.datasets[0]["td_stable"]
                apply_v2 = await apply_compiled_plan(
                    td,
                    session,
                    tenant_id=tenant_id,
                    design_id=design_id,
                    design_version_id=ver_id,
                    dataset_ids_by_key={ds_key: ds_id},
                    plan=plan_v2,
                    generation=1,
                )
                assert apply_v2["verified_subtables"] == 2
                desc_rows = await td.query_rows(f"DESCRIBE `{db_name}`.`{plan.datasets[0]['td_stable']}`")
                assert any(r.get("field") == "temp_2_c" for r in desc_rows)
                await session.commit()

                assert apply_res["verified_subtables"] == 1
                assert op_sub == op_subtable_name(sig_id, "float64")

            reg_rows = await pg.fetch(
                "SELECT tier, td_database, td_stable, td_subtable FROM storage_physical_registry WHERE tenant_id = $1 ORDER BY tier, td_subtable",
                tenant_id,
            )
            assert len(reg_rows) == 3
            assert [r["tier"] for r in reg_rows] == ["MANAGED", "MANAGED", "OPERATIONAL"]
            assert all(r["td_database"] == db_name for r in reg_rows)

            await td.drop_database(db_name, confirm=True)
    finally:
        await pg.execute("DELETE FROM storage_physical_registry WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM storage_datasets WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM storage_design_versions WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM storage_designs WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM signal_definitions WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM resources WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM resource_types WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM sites WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM telemetry_generations WHERE tenant_id = $1", tenant_id)
        await pg.execute("DELETE FROM tenants WHERE id = $1", tenant_id)
        await pg.close()
        await engine.dispose()


@pytest.mark.asyncio
async def test_tdengine_x1_and_x10_batched_benchmark() -> None:
    """Measure x1 (300 series x 1 row) and x10 (300 series x 10 rows = 3,000 rows) ingest throughput."""
    tenant_id = uuid4()
    db = tenant_database_name(tenant_id)
    res_id = uuid4()
    sigs = [uuid4() for _ in range(300)]
    base = datetime(2026, 11, 10, 14, 0, 0, tzinfo=timezone.utc)

    async with TDEngineClient(TDEngineConfig(dsn=_td_dsn(), batch_chunk_rows=300)) as td:
        try:
            await td.ensure_operational_schema(tenant_id)

            # Warmup DDL + 1x 300-row batch across 300 subtables
            batch_x1 = [
                {
                    "signal_id": sig,
                    "resource_id": res_id,
                    "value_type": "float64",
                    "value": float(idx),
                    "raw_quality": "GOOD",
                    "event_time": base,
                    "acquired_at": base,
                    "event_uid": f"x1-{idx}",
                }
                for idx, sig in enumerate(sigs)
            ]
            t_start_1 = time.perf_counter()
            r1 = await td.write_operational_observations(tenant_id, batch_x1)
            dt_1 = time.perf_counter() - t_start_1
            assert len(r1.succeeded_ids) == 300 and r1.failures == ()

            # x10 burst: 3,000 rows across 300 subtables
            batch_x10 = [
                {
                    "signal_id": sig,
                    "resource_id": res_id,
                    "value_type": "float64",
                    "value": float(idx + step),
                    "raw_quality": "GOOD",
                    "event_time": base + timedelta(seconds=step),
                    "acquired_at": base + timedelta(seconds=step),
                    "event_uid": f"x10-{step}-{idx}",
                }
                for step in range(1, 11)
                for idx, sig in enumerate(sigs)
            ]
            t_start_10 = time.perf_counter()
            r10 = await td.write_operational_observations(tenant_id, batch_x10)
            dt_10 = time.perf_counter() - t_start_10
            assert len(r10.succeeded_ids) == 3000 and r10.failures == ()
            rate_10 = 3000.0 / max(dt_10, 0.001)
            print(f"\n[S05 TDengine Benchmark] x1 (300 rows): {dt_1:.3f}s ({300/dt_1:.0f} obs/s) | x10 (3000 rows): {dt_10:.3f}s ({rate_10:.0f} obs/s)")
            assert rate_10 > 500.0
        finally:
            await td.drop_database(db, confirm=True)


@pytest.mark.asyncio
async def test_tdengine_container_taosdump_backup_and_restore() -> None:
    """Verify full taosdump backup -> database drop -> restore inside the isolated TDengine container."""
    docker_bin = shutil.which("docker")
    if not docker_bin:
        pytest.skip("docker CLI unavailable")

    ps = subprocess.run(
        [docker_bin, "ps", "--filter", "name=factorix-storage-e2e-tdengine-test-1", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    container = ps.stdout.strip()
    if not container:
        pytest.skip("Isolated test TDengine container not running")

    tenant_id = uuid4()
    db = tenant_database_name(tenant_id)
    sig_id = uuid4()
    res_id = uuid4()
    sub = op_subtable_name(sig_id, "float64")
    t0 = datetime(2026, 11, 10, 15, 0, 0, tzinfo=timezone.utc)
    dump_dir = f"/tmp/fx_dump_{tenant_id.hex[:8]}"

    async with TDEngineClient(_td_dsn()) as td:
        try:
            await td.ensure_operational_schema(tenant_id)
            await td.write_operational_observations(
                tenant_id,
                [
                    {
                        "signal_id": sig_id,
                        "resource_id": res_id,
                        "value_type": "float64",
                        "value": 314.159,
                        "raw_quality": "GOOD",
                        "event_time": t0,
                        "acquired_at": t0,
                        "event_uid": "backup-ev-1",
                    }
                ],
            )
            b_cmd = subprocess.run(
                [docker_bin, "exec", container, "sh", "-c", f"mkdir -p {dump_dir} && taosdump -D {db} -o {dump_dir}"],
                capture_output=True,
                text=True,
            )
            assert b_cmd.returncode == 0, b_cmd.stderr

            await td.drop_database(db, confirm=True)
            # Small brief settle before taosdump restore recreates DB
            r_cmd = subprocess.run(
                [docker_bin, "exec", container, "sh", "-c", f"taosdump -i {dump_dir} && rm -rf {dump_dir}"],
                capture_output=True,
                text=True,
            )
            assert r_cmd.returncode == 0, r_cmd.stderr

            restored = await td.query_last_row(db, sub)
            assert restored is not None
            assert restored["val"] == pytest.approx(314.159)
            assert restored["event_uid"] == "backup-ev-1"
        finally:
            try:
                await td.drop_database(db, confirm=True)
            except Exception:
                pass
            subprocess.run([docker_bin, "exec", container, "rm", "-rf", dump_dir], capture_output=True)
