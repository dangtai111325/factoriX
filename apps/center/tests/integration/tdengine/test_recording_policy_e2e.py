"""Live S07 E2E tests: Operational History + Managed Recording Policies + Restart Hydration."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import aio_pika
import asyncpg
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance, derive_event_uid
from factorix.domain.quality import Origin, Quality
from factorix.modules.ingestion_worker import IngestionWorker, PgIngestionStore
from factorix.modules.storage_compiler import apply_compiled_plan, load_catalog_snapshot
from factorix.modules.storage_dsl import (
    compile_storage_plan,
    parse_storage_dsl,
    resolve_and_validate_design,
)
from factorix.platform.broker import BrokerConfig, RabbitMQPublisher
from factorix.platform.tdengine import TDEngineClient, op_subtable_name, tenant_database_name


def _pg_dsn() -> str:
    return os.environ["FACTORIX_DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")


def _pg_sa_dsn() -> str:
    url = os.environ["FACTORIX_DATABASE_URL"]
    return url if "asyncpg" in url else url.replace("postgresql://", "postgresql+asyncpg://")


def _td_dsn() -> str:
    return os.environ["FACTORIX_TDENGINE_DSN"]


def _broker_cfg(suffix: str) -> BrokerConfig:
    return BrokerConfig(
        amqp_url=os.environ["FACTORIX_RABBITMQ_URL"],
        mgmt_url=os.environ.get("FACTORIX_RABBITMQ_MGMT_URL", "http://127.0.0.1:15672"),
        exchange_name=f"factorix.s07.ingress.{suffix}",
        queue_name=f"factorix.s07.ingest.q.{suffix}",
        dlx_name=f"factorix.s07.dlx.{suffix}",
        dlq_name=f"factorix.s07.dlq.{suffix}",
        delivery_limit=2,
        prefetch_count=64,
        consumer_concurrency=16,
        confirm_timeout_s=5.0,
    )


async def _cleanup_broker(cfg: BrokerConfig) -> None:
    conn = await aio_pika.connect(cfg.amqp_url, timeout=5.0)
    try:
        ch = await conn.channel()
        for qname in (cfg.queue_name, cfg.dlq_name):
            try:
                await ch.queue_delete(qname, if_unused=False, if_empty=False)
            except Exception:
                pass
        for xname in (cfg.exchange_name, cfg.dlx_name):
            try:
                await ch.exchange_delete(xname, if_unused=False)
            except Exception:
                pass
    finally:
        await conn.close()


async def _cleanup_tenant(pg_pool: asyncpg.Pool, td: TDEngineClient, tenant_id: UUID) -> None:
    try:
        await td.drop_database(tenant_database_name(tenant_id), confirm=True)
    except Exception:
        pass
    async with pg_pool.acquire() as conn:
        await conn.execute("DELETE FROM storage_physical_registry WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM storage_recording_policies WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM storage_field_bindings WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM storage_datasets WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM storage_design_versions WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM storage_designs WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM audit_events WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM observation_quarantine WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM latest_signal_state WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM ingest_dedup WHERE tenant_id = $1", tenant_id)
        await conn.execute(
            "DELETE FROM formula_dependencies WHERE formula_id IN (SELECT f.id FROM formula_definitions f JOIN signal_definitions s ON s.id = f.signal_id WHERE s.tenant_id = $1)",
            tenant_id,
        )
        await conn.execute(
            "DELETE FROM formula_definitions WHERE signal_id IN (SELECT id FROM signal_definitions WHERE tenant_id = $1)",
            tenant_id,
        )
        await conn.execute(
            "DELETE FROM signal_bindings WHERE signal_id IN (SELECT id FROM signal_definitions WHERE tenant_id = $1)",
            tenant_id,
        )
        await conn.execute("DELETE FROM signal_definitions WHERE tenant_id = $1", tenant_id)
        await conn.execute(
            "DELETE FROM source_fields WHERE acquisition_job_id IN (SELECT j.id FROM acquisition_jobs j JOIN connections c ON c.id = j.connection_id WHERE c.tenant_id = $1)",
            tenant_id,
        )
        await conn.execute(
            "DELETE FROM acquisition_jobs WHERE connection_id IN (SELECT id FROM connections WHERE tenant_id = $1)",
            tenant_id,
        )
        await conn.execute("DELETE FROM connections WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM resources WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM resource_types WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM sites WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM telemetry_generations WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM collector_runtime_status WHERE instance_id LIKE 'test-s07-%'")
        await conn.execute("DELETE FROM tenants WHERE id = $1", tenant_id)


@pytest.mark.asyncio
async def test_managed_recording_policies_operational_isolation_and_restart_hydration() -> None:
    suffix = uuid4().hex[:8]
    cfg = _broker_cfg(suffix)
    pg_pool = await asyncpg.create_pool(_pg_dsn(), min_size=1, max_size=4)
    sa_engine = create_async_engine(_pg_sa_dsn())
    sa_maker = async_sessionmaker(sa_engine, expire_on_commit=False, class_=AsyncSession)
    td = TDEngineClient(_td_dsn())

    tenant_id = uuid4()
    site_id = uuid4()
    rtype_id = uuid4()
    res_id = uuid4()
    conn_id = uuid4()
    job_id = uuid4()
    sig_chg = uuid4()
    fid_chg = uuid4()
    sig_evt = uuid4()
    fid_evt = uuid4()
    sig_int = uuid4()
    fid_int = uuid4()
    sig_paused = uuid4()
    fid_paused = uuid4()
    sig_calc = uuid4()
    formula_id = uuid4()
    now = datetime.now(timezone.utc)
    t_base = datetime.fromtimestamp((int(now.timestamp()) // 2 * 2) - 4, tz=timezone.utc)
    valid_from = t_base - timedelta(hours=1)

    try:
        async with pg_pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO tenants (id, code, display_name, created_at) VALUES ($1, $2, 'S07 Policy Test', $3)",
                    tenant_id,
                    f"t-{tenant_id.hex[:8]}",
                    now,
                )
                await conn.execute(
                    "INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at) VALUES ($1, 1, 'ACTIVE', $2)",
                    tenant_id,
                    now,
                )
                await conn.execute(
                    "INSERT INTO sites (id, tenant_id, code, name, timezone, created_at) VALUES ($1, $2, 'S1', 'Site 1', 'UTC', $3)",
                    site_id,
                    tenant_id,
                    now,
                )
                await conn.execute(
                    "INSERT INTO resource_types (id, tenant_id, key, name, category) VALUES ($1, $2, 'machine', 'Machine', 'ASSET')",
                    rtype_id,
                    tenant_id,
                )
                await conn.execute(
                    "INSERT INTO resources (id, tenant_id, site_id, type_id, code, name, status, version, created_at, updated_at) VALUES ($1, $2, $3, $4, 'M01', 'Press-01', 'ACTIVE', 1, $5, $5)",
                    res_id,
                    tenant_id,
                    site_id,
                    rtype_id,
                    now,
                )
                await conn.execute(
                    "INSERT INTO connections (id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted, config_json, status, health, version, created_at, updated_at) VALUES ($1, $2, $3, NULL, 'modbus_tcp', 'Modbus-1', '127.0.0.1:15020', '{}'::jsonb, 'ACTIVE', 'UNKNOWN', 1, $4, $4)",
                    conn_id,
                    tenant_id,
                    site_id,
                    now,
                )
                await conn.execute(
                    "INSERT INTO acquisition_jobs (id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version) VALUES ($1, $2, 'POLL', 1000, 3000, TRUE, 1, 1, 1)",
                    job_id,
                    conn_id,
                )
                for idx, (sid, fid, key, dtype) in enumerate(
                    [
                        (sig_chg, fid_chg, "chg_val", "float64"),
                        (sig_evt, fid_evt, "evt_val", "int64"),
                        (sig_int, fid_int, "int_val", "float64"),
                        (sig_paused, fid_paused, "paused_val", "float64"),
                    ]
                ):
                    await conn.execute(
                        "INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal) VALUES ($1, $2, 'modbus_register', $3::jsonb, $4, '{}'::jsonb, $5)",
                        fid,
                        job_id,
                        json.dumps({"offset": idx + 1}),
                        dtype,
                        idx,
                    )
                    await conn.execute(
                        "INSERT INTO signal_definitions (id, tenant_id, resource_id, key, display_name, data_type, category, expected_interval_ms, status, version, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, $5, 'COLLECTED', 1000, 'ACTIVE', 1, $6, $6)",
                        sid,
                        tenant_id,
                        res_id,
                        key,
                        dtype,
                        now,
                    )
                    await conn.execute(
                        "INSERT INTO signal_bindings (id, signal_id, source_field_id, enabled, revision, valid_from) VALUES ($1, $2, $3, TRUE, 1, $4)",
                        uuid4(),
                        sid,
                        fid,
                        valid_from,
                    )

                await conn.execute(
                    "INSERT INTO signal_definitions (id, tenant_id, resource_id, key, display_name, data_type, category, expected_interval_ms, status, version, created_at, updated_at) VALUES ($1, $2, $3, 'chg_scaled', 'chg_scaled', 'float64', 'CALCULATED', 1000, 'ACTIVE', 1, $4, $4)",
                    sig_calc,
                    tenant_id,
                    res_id,
                    now,
                )
                await conn.execute(
                    "INSERT INTO formula_definitions (id, signal_id, expression_source, ast_json, temporal_policy_json, revision, status) VALUES ($1, $2, 'x * 2', '{}'::jsonb, '{\"mode\":\"LATEST\"}'::jsonb, 1, 'PUBLISHED')",
                    formula_id,
                    sig_calc,
                )
                await conn.execute(
                    "INSERT INTO formula_dependencies (formula_id, variable_alias, dependency_signal_id) VALUES ($1, 'x', $2)",
                    formula_id,
                    sig_chg,
                )

        # Build & compile StorageDesign covering ON_CHANGE (raw + calculated multi-field STable), EVERY_ACQUISITION, INTERVAL, and PAUSED!
        design_id = uuid4()
        ver_id = uuid4()
        yaml_text = f"""
apiVersion: factorix.io/storage/v1
kind: StorageDesign
metadata:
  name: s07_policy_verification
spec:
  scope:
    mode: resources
    resourceIds:
      - "{res_id}"
  destination:
    engine: tdengine
  datasets:
    - key: on_change_ds
      semantics: state_series
      fields:
        - key: raw_f
          from: "{{{{sig:{sig_chg}}}}}"
          type: float64
        - key: calc_f
          from: "{{{{sig:{sig_calc}}}}}"
          type: float64
      recording:
        mode: ON_CHANGE
        qualityTransitions: true
        deadband:
          kind: absolute
          value: 1.0
        maxCheckpointInterval: 2s
        lateTolerance: 30s
      retention:
        days: 90
    - key: event_ds
      semantics: event_stream
      fields:
        - key: evt_code
          from: "{{{{sig:{sig_evt}}}}}"
          type: int64
      recording:
        mode: EVERY_ACQUISITION
        qualityTransitions: true
    - key: interval_ds
      semantics: state_series
      fields:
        - key: sampled_f
          from: "{{{{sig:{sig_int}}}}}"
          type: float64
      recording:
        mode: INTERVAL
        interval: 2s
        lateTolerance: 1s
        missingPolicy: GAP_MARKER
    - key: paused_ds
      semantics: state_series
      fields:
        - key: paused_f
          from: "{{{{sig:{sig_paused}}}}}"
          type: float64
      recording:
        mode: EVERY_ACQUISITION
"""
        parsed_ast = parse_storage_dsl(yaml_text)
        async with sa_maker() as session:
            snapshot = await load_catalog_snapshot(session, tenant_id)
            resolved_ast, issues = resolve_and_validate_design(parsed_ast, snapshot)
            assert not [i for i in issues if i.severity == "error"], issues
            plan = compile_storage_plan(resolved_ast, tenant_id=tenant_id, design_id=design_id, target_version=1)

            dataset_ids_by_key = {d["dataset_key"]: UUID(str(d["dataset_id"])) for d in plan.datasets}

            async with pg_pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        """
                        INSERT INTO storage_designs (
                            id, tenant_id, name, description, scope_json, draft_ast_json,
                            status, current_version, published_version_id, created_at, updated_at
                        ) VALUES ($1, $2, 's07_policy_verification', 'S07', '{}'::jsonb, $3::jsonb, 'RUNNING', 1, $4, $5, $5)
                        """,
                        design_id,
                        tenant_id,
                        json.dumps(resolved_ast.to_dict()),
                        ver_id,
                        now,
                    )
                    await conn.execute(
                        """
                        INSERT INTO storage_design_versions (
                            id, tenant_id, design_id, version, ast_json, ast_hash, semantic_hash,
                            compiler_version, ddl_plan_json, plan_hash, publish_state, effective_from_epoch,
                            effective_at, created_at, applied_at
                        ) VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, $7, $8::jsonb, $9, 'APPLIED', 1, $10, $10, $10)
                        """,
                        ver_id,
                        tenant_id,
                        design_id,
                        json.dumps(resolved_ast.to_dict()),
                        plan.ast_hash,
                        plan.semantic_hash,
                        plan.compiler_version,
                        json.dumps(plan.to_dict()),
                        plan.plan_hash,
                        now,
                    )
                    for d_Ast, d_plan in zip(resolved_ast.spec.datasets, plan.datasets, strict=True):
                        ds_uuid = UUID(str(d_plan["dataset_id"]))
                        ds_status = "PAUSED" if d_Ast.key == "paused_ds" else "RUNNING"
                        await conn.execute(
                            """
                            INSERT INTO storage_datasets (
                                id, tenant_id, design_id, dataset_key, display_name, semantics, source_kind,
                                time_axis, tags_json, status, current_schema_version, created_at, updated_at
                            ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, '[]'::jsonb, $8, 1, $9, $9)
                            """,
                            ds_uuid,
                            tenant_id,
                            design_id,
                            d_Ast.key,
                            d_Ast.semantics,
                            d_Ast.source_kind,
                            d_Ast.time_axis,
                            ds_status,
                            now,
                        )
                        for f_idx, fld in enumerate(d_Ast.fields):
                            await conn.execute(
                                """
                                INSERT INTO storage_field_bindings (
                                    id, tenant_id, dataset_id, field_key, display_name, value_type, source_kind,
                                    signal_id, resource_id, source_ref, source_revision, transform_json, nullable, required, ordinal
                                ) VALUES ($1, $2, $3, $4, $4, $5, 'signal', $6, $7, $8, 1, '{}'::jsonb, TRUE, FALSE, $9)
                                """,
                                uuid4(),
                                tenant_id,
                                ds_uuid,
                                fld.key,
                                fld.type,
                                UUID(str(fld.signal_id)),
                                res_id,
                                fld.from_ref,
                                f_idx,
                            )
                        pol_payload: dict[str, Any] = {
                            "mode": d_Ast.recording.mode,
                            "qualityTransitions": True,
                        }
                        if d_Ast.recording.deadband is not None:
                            pol_payload["deadband"] = {"kind": d_Ast.recording.deadband.kind, "value": d_Ast.recording.deadband.value}
                        if d_Ast.recording.max_checkpoint_interval:
                            pol_payload["maxCheckpointInterval"] = d_Ast.recording.max_checkpoint_interval
                        if d_Ast.recording.interval:
                            pol_payload["interval"] = d_Ast.recording.interval
                        if d_Ast.recording.late_tolerance:
                            pol_payload["lateTolerance"] = d_Ast.recording.late_tolerance
                        pol_payload["missingPolicy"] = d_Ast.recording.missing_policy
                        await conn.execute(
                            """
                            INSERT INTO storage_recording_policies (
                                id, tenant_id, dataset_id, mode, policy_json, retention_json, version, enabled, legal_hold, updated_at
                            ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 1, TRUE, FALSE, $7)
                            """,
                            uuid4(),
                            tenant_id,
                            ds_uuid,
                            d_Ast.recording.mode,
                            json.dumps(pol_payload),
                            json.dumps({"days": d_Ast.retention.days}),
                            now,
                        )

            await apply_compiled_plan(
                td,
                session,
                tenant_id=tenant_id,
                design_id=design_id,
                design_version_id=ver_id,
                dataset_ids_by_key=dataset_ids_by_key,
                plan=plan,
                generation=1,
            )
            await session.commit()

        sub_by_series = {(s.dataset_key, s.field_key): s.td_subtable for s in plan.series}
        db_name = tenant_database_name(tenant_id)

        def _make(sig_id: UUID, fid: UUID, val: Any, dtype: str, *, sec: float, seq: int, quality: Quality = Quality.GOOD, reason: str | None = None) -> CanonicalObservation:
            dt = t_base + timedelta(seconds=sec)
            return CanonicalObservation(
                event_uid=derive_event_uid(
                    tenant_id=tenant_id,
                    connection_id=conn_id,
                    source_field_id=fid,
                    signal_id=sig_id,
                    acquired_at=dt,
                    sequence_or_key=f"{dtype}-{seq}",
                    data_epoch=1,
                ),
                tenant_id=tenant_id,
                site_id=site_id,
                connection_id=conn_id,
                acquisition_job_id=job_id,
                source_field_id=fid,
                signal_id=sig_id,
                resource_id=res_id,
                source_time=dt,
                acquired_at=dt,
                value_type=dtype,
                value=val,
                quality=quality,
                quality_reason=reason,
                origin=Origin.LIVE,
                data_epoch=1,
                config_revision=1,
                source_sequence=seq,
                provenance=CanonicalProvenance(protocol="modbus_tcp", connection_id=conn_id, source_field_id=fid),
            )

        # Phase 1: Start worker 1 and publish test sequence across all 4 policies
        pg_store1 = PgIngestionStore(_pg_dsn(), min_pool=1, max_pool=4)
        w1 = IngestionWorker(
            pg_store=pg_store1,
            tdengine=td,
            broker_cfg=cfg,
            instance_id=f"test-s07-{suffix}-1",
            batch_size=50,
            flush_ms=15,
        )
        await w1.start()
        try:
            msgs = [
                # sig_chg -> baseline (10.0), within deadband (10.5 -> skipped), checkpoint (10.4 at +3s >= 2s checkpoint),
                #           jump >1.0 (12.0), unchanged BAD quality transition (12.0 BAD)
                _make(sig_chg, fid_chg, 10.0, "float64", sec=0.0, seq=1),
                _make(sig_chg, fid_chg, 10.5, "float64", sec=0.5, seq=2),
                _make(sig_chg, fid_chg, 10.4, "float64", sec=3.0, seq=3),
                _make(sig_chg, fid_chg, 12.0, "float64", sec=3.5, seq=4),
                _make(sig_chg, fid_chg, 12.0, "float64", sec=4.0, seq=5, quality=Quality.BAD, reason="SENSOR_FAULT"),
                # sig_evt -> 2 identical events (both must persist!)
                _make(sig_evt, fid_evt, 777, "int64", sec=1.0, seq=10),
                _make(sig_evt, fid_evt, 777, "int64", sec=2.0, seq=11),
                # sig_int -> bucket 0 (sec=0.2), intra-bucket suppress (sec=1.2), bucket 3 (sec=6.2 -> gaps at bucket 1 & 2!)
                _make(sig_int, fid_int, 1.0, "float64", sec=0.2, seq=20),
                _make(sig_int, fid_int, 2.0, "float64", sec=1.2, seq=21),
                _make(sig_int, fid_int, 3.0, "float64", sec=6.2, seq=22),
                # sig_paused -> Operational receives it, Managed paused_ds ignores it
                _make(sig_paused, fid_paused, 99.0, "float64", sec=0.0, seq=30),
                _make(sig_paused, fid_paused, 100.0, "float64", sec=1.0, seq=31),
            ]
            async with RabbitMQPublisher(cfg) as pub:
                for m in msgs:
                    await pub.publish_observation(m)
                deadline = asyncio.get_running_loop().time() + 25.0
                while asyncio.get_running_loop().time() < deadline:
                    if w1.metrics.acked_total >= len(msgs):
                        break
                    await asyncio.sleep(0.05)
                assert w1.metrics.acked_total == len(msgs)
        finally:
            await w1.stop(drain_timeout_s=5.0)

        # Verify Operational History kept 100% of ALL signals (including suppressed, paused, and calculated!)
        op_chg = await td.query_range(db_name, op_subtable_name(sig_chg, "float64"), start=t_base - timedelta(seconds=5), end=t_base + timedelta(seconds=20))
        op_paused = await td.query_range(db_name, op_subtable_name(sig_paused, "float64"), start=t_base - timedelta(seconds=5), end=t_base + timedelta(seconds=20))
        assert len(op_chg) == 5
        assert len(op_paused) == 2

        # Verify Managed ON_CHANGE multi-field STable: raw_f has baseline(10.0) + checkpoint(10.0) + jump(12.0) + BAD(12.0) = 4 rows (10.5 suppressed!)
        md_raw = await td.query_range(
            db_name,
            sub_by_series[("on_change_ds", "raw_f")],
            start=t_base - timedelta(seconds=5),
            end=t_base + timedelta(seconds=20),
            columns=("ts", "raw_quality", "reason_code", "record_kind", "raw_f", "calc_f"),
        )
        assert len(md_raw) == 4
        assert [r["record_kind"] for r in md_raw] == ["MANAGED_RECORDED", "checkpoint", "MANAGED_RECORDED", "MANAGED_RECORDED"]
        assert [r["raw_f"] for r in md_raw] == [10.0, 10.0, 12.0, 12.0]
        assert all(r["calc_f"] is None for r in md_raw)  # sibling column auto-NULL!
        assert md_raw[3]["raw_quality"] == "BAD" and md_raw[3]["reason_code"] == "SENSOR_FAULT"

        # Calculated formula x*2 mapped into calc_f on SAME STable cleanly!
        md_calc = await td.query_range(
            db_name,
            sub_by_series[("on_change_ds", "calc_f")],
            start=t_base - timedelta(seconds=5),
            end=t_base + timedelta(seconds=20),
            columns=("ts", "raw_quality", "record_kind", "raw_f", "calc_f"),
        )
        assert [r["calc_f"] for r in md_calc] == [20.0, 20.0, 24.0, 24.0]
        assert all(r["raw_f"] is None for r in md_calc)

        # Managed EVERY_ACQUISITION kept both identical 777 events
        md_evt = await td.query_range(
            db_name,
            sub_by_series[("event_ds", "evt_code")],
            start=t_base - timedelta(seconds=5),
            end=t_base + timedelta(seconds=20),
            columns=("ts", "evt_code"),
        )
        assert [r["evt_code"] for r in md_evt] == [777, 777]

        # Managed INTERVAL materialized bucket 0, gap_marker (b1), gap_marker (b2), bucket 3 (sec=6.2 -> b3)
        md_int = await td.query_range(
            db_name,
            sub_by_series[("interval_ds", "sampled_f")],
            start=t_base - timedelta(seconds=5),
            end=t_base + timedelta(seconds=20),
            columns=("ts", "raw_quality", "reason_code", "record_kind", "sampled_f"),
        )
        assert [r["record_kind"] for r in md_int] == ["MANAGED_RECORDED", "gap_marker", "gap_marker", "MANAGED_RECORDED"]
        assert md_int[1]["raw_quality"] == "BAD" and md_int[1]["sampled_f"] is None
        assert md_int[0]["sampled_f"] == 1.0 and md_int[3]["sampled_f"] == 3.0

        # Managed PAUSED dataset has ZERO rows
        md_paused = await td.query_range(
            db_name,
            sub_by_series[("paused_ds", "paused_f")],
            start=t_base - timedelta(seconds=5),
            end=t_base + timedelta(seconds=20),
            columns=("ts", "paused_f"),
        )
        assert md_paused == []

        # Phase 2: Cold restart a BRAND-NEW worker instance -> must hydrate LAST_ROW from TDengine!
        # Send unchanged (12.0, BAD, SENSOR_FAULT) right away (+0.2s < 2s checkpoint) -> must NOT write duplicate baseline!
        # Then send 15.0 GOOD (+0.4s) -> writes 1 new row cleanly!
        pg_store2 = PgIngestionStore(_pg_dsn(), min_pool=1, max_pool=4)
        w2 = IngestionWorker(
            pg_store=pg_store2,
            tdengine=td,
            broker_cfg=cfg,
            instance_id=f"test-s07-{suffix}-2",
            batch_size=50,
            flush_ms=15,
        )
        await w2.start()
        try:
            m_same = _make(sig_chg, fid_chg, 12.0, "float64", sec=4.2, seq=6, quality=Quality.BAD, reason="SENSOR_FAULT")
            m_changed = _make(sig_chg, fid_chg, 15.0, "float64", sec=4.4, seq=7, quality=Quality.GOOD)
            async with RabbitMQPublisher(cfg) as pub:
                await pub.publish_observation(m_same)
                deadline = asyncio.get_running_loop().time() + 15.0
                while asyncio.get_running_loop().time() < deadline:
                    if w2.metrics.acked_total >= 1:
                        break
                    await asyncio.sleep(0.05)
                assert w2.metrics.acked_total == 1
                md_after_same = await td.query_range(
                    db_name,
                    sub_by_series[("on_change_ds", "raw_f")],
                    start=t_base - timedelta(seconds=5),
                    end=t_base + timedelta(seconds=20),
                    columns=("ts", "raw_f"),
                )
                assert len(md_after_same) == 4  # Cold recovery suppressed identical baseline!

                await pub.publish_observation(m_changed)
                deadline = asyncio.get_running_loop().time() + 15.0
                while asyncio.get_running_loop().time() < deadline:
                    if w2.metrics.acked_total >= 2:
                        break
                    await asyncio.sleep(0.05)
                assert w2.metrics.acked_total == 2
        finally:
            await w2.stop(drain_timeout_s=5.0)

        md_final = await td.query_range(
            db_name,
            sub_by_series[("on_change_ds", "raw_f")],
            start=t_base - timedelta(seconds=5),
            end=t_base + timedelta(seconds=20),
            columns=("ts", "raw_quality", "raw_f"),
        )
        assert len(md_final) == 5 and md_final[-1]["raw_f"] == 15.0 and md_final[-1]["raw_quality"] == "GOOD"
    finally:
        await _cleanup_tenant(pg_pool, td, tenant_id)
        await _cleanup_broker(cfg)
        await td.close()
        await sa_engine.dispose()
        await pg_pool.close()
