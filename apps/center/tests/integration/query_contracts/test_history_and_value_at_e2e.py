"""E2E integration tests for TDengine History, Value-At, Aggregate & Recorded/Reconstructed modes (S09)."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[5]
_ENV_FILE = ROOT / ".env"
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value)
os.environ["FACTORIX_BOOTSTRAP_TOKEN"] = "integration-bootstrap-token"
os.environ["FACTORIX_ENVIRONMENT"] = "test"
os.environ["FACTORIX_COOKIE_SECURE"] = "false"

from factorix.platform.settings import get_settings

get_settings.cache_clear()
import factorix.platform.db as db_module

db_module._engine = None
db_module._session_factory = None

from factorix.domain.canonical import CanonicalObservation, Origin, Quality
from factorix.modules.history_repository import (
    TDengineHistoryRepository,
    TDengineModelSnapshotProvider,
    configure_history_provider,
    configure_model_snapshot_provider,
)
from factorix.modules.providers import ModelSnapshotRecord
from factorix.modules.recording_policy import (
    DefaultRecordingPolicyEvaluator,
    ManagedBindingTarget,
)
from factorix.modules.providers import RecordingMode
from factorix.modules import data_models, models_engine
from factorix.platform.db import session_factory
from factorix.platform.tdengine import TDEngineClient, TDEngineConfig
from factorix.transport.app import app
from tests.safety.test_destructive_guard import check_destructive_test_db_guard


@pytest.fixture(autouse=True)
async def _cleanup_env():
    yield
    configure_history_provider(None)
    configure_model_snapshot_provider(None)
    engine = db_module._engine
    db_module._engine = None
    db_module._session_factory = None
    if engine is not None:
        await engine.dispose()


async def _wipe_pg_and_td() -> TDEngineClient:
    settings = get_settings()
    check_destructive_test_db_guard(
        settings.database_url,
        os.environ.get("FACTORIX_ENABLE_DESTRUCTIVE_TESTS"),
    )
    factory = session_factory()
    async with factory() as session:
        await session.execute(
            text(
                """
                TRUNCATE TABLE
                  tenants, sites, admin_accounts, sessions, login_throttle, password_reset_codes,
                  resource_types, resources, relation_types, resource_relations, type_adjacency,
                  hierarchy_templates, hierarchy_views,
                  edge_nodes, edge_enrollment_tokens, secret_store, connections, acquisition_jobs,
                  source_fields, signal_definitions, signal_bindings, mapping_definitions,
                  formula_definitions, formula_dependencies, output_groups, output_group_members, model_refs, model_snapshots, model_state,
                  configuration_drafts, configuration_releases, deployment_events, commissioning_jobs,
                  observations, ingest_dedup, latest_signal_state, observation_quarantine,
                  dashboards, dashboard_revisions, retention_policies, retention_jobs,
                  saved_queries, audit_events, export_jobs,
                  collector_runtime_status, telemetry_generations,
                  storage_designs, storage_design_versions, storage_datasets,
                  storage_field_bindings, storage_recording_policies,
                  storage_dependencies, storage_operations, storage_physical_registry
                RESTART IDENTITY CASCADE
                """
            )
        )
        await session.commit()

    td = TDEngineClient(TDEngineConfig(dsn=settings.tdengine_dsn, db_prefix=settings.tdengine_db_prefix))
    for r in await td.query_rows(
        f"SELECT name FROM information_schema.ins_databases WHERE name LIKE '{settings.tdengine_db_prefix}%'"
    ):
        await td.drop_database(str(r["name"]), confirm=True)
    return td


@pytest.mark.asyncio
async def test_tdengine_history_aggregate_value_at_and_reconstructed_http_e2e() -> None:
    td = await _wipe_pg_and_td()
    repo = TDengineHistoryRepository(td)
    snap_repo = TDengineModelSnapshotProvider(td)
    configure_history_provider(repo)
    configure_model_snapshot_provider(snap_repo)

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://localhost") as client:
            created = await client.post(
                "/api/v1/auth/bootstrap",
                headers={"X-Bootstrap-Token": "integration-bootstrap-token"},
                json={
                    "login": "fxadmin",
                    "email": "fxadmin@example.com",
                    "password": "Correct-Horse-9",
                    "display_name": "FactoriX",
                    "tenant_code": "primary",
                },
            )
            assert created.status_code == 201, created.text
            tenant_id = UUID(created.json()["tenant_id"])

            login = await client.post("/api/v1/auth/login", json={"login": "fxadmin", "password": "Correct-Horse-9"})
            assert login.status_code == 200
            csrf = client.cookies.get("fx_csrf")
            assert csrf
            headers = {"X-CSRF-Token": csrf}

            site = await client.post(
                "/api/v1/sites",
                headers=headers,
                json={"code": "S1", "name": "Site 1", "timezone": "UTC"},
            )
            site_id = site.json()["id"]
            machine = await client.post(
                "/api/v1/resources",
                headers=headers,
                json={"type_key": "machine", "code": "M1", "name": "Machine 1", "site_id": site_id},
            )
            machine_id = UUID(machine.json()["id"])
            edge = await client.post("/api/v1/edges", headers=headers, json={"name": "edge-01", "site_id": site_id})
            conn = await client.post(
                "/api/v1/connections",
                headers=headers,
                json={
                    "name": "PLC 1",
                    "site_id": site_id,
                    "edge_id": edge.json()["id"],
                    "protocol": "modbus_tcp",
                    "config": {"host": "127.0.0.1", "port": 1502, "unit_id": 1, "timeout_ms": 3000, "retries": 1},
                },
            )
            job_id = conn.json()["jobs"][0]["id"]
            bulk = await client.post(
                "/api/v1/signals/bulk",
                headers=headers,
                json={
                    "resource_id": str(machine_id),
                    "atomic": True,
                    "items": [
                        {
                            "key": "temp",
                            "name": "Temp",
                            "data_type": "float64",
                            "unit": "Cel",
                            "expected_interval_ms": 1000,
                            "source_field": {
                                "acquisition_job_id": job_id,
                                "address_kind": "modbus_register",
                                "address": {"offset": 100, "native_type": "float32"},
                            },
                        },
                        {
                            "key": "so_id",
                            "name": "Sales Order",
                            "data_type": "string",
                            "source_field": {
                                "acquisition_job_id": job_id,
                                "address_kind": "modbus_register",
                                "address": {"offset": 200, "native_type": "string"},
                            },
                        },
                    ],
                },
            )
            assert bulk.status_code == 201, bulk.text
            sig_temp = UUID(bulk.json()["created"][0])
            sig_so = UUID(bulk.json()["created"][1])

            model = await client.post(
                "/api/v1/data-models",
                headers=headers,
                json={
                    "name": "Machine State",
                    "spec": {
                        "version": 2,
                        "root": {
                            "type": "object",
                            "children": [
                                {"key": "temp", "type": "field", "mode": "mapping", "ref": {"signal_id": str(sig_temp)}},
                                {
                                    "key": "so_72h",
                                    "type": "field",
                                    "mode": "calculated",
                                    "expr": f"value_at({{{{sig:{sig_so}}}}}, ts({{{{sig:{sig_temp}}}}}) - 259200)",
                                },
                            ],
                        },
                    },
                },
            )
            assert model.status_code == 201, model.text
            model_id = UUID(model.json()["id"])

            await td.ensure_operational_schema(tenant_id)
            now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
            t_old_73h = now - timedelta(hours=73)
            t0 = now - timedelta(minutes=2)
            t1 = now - timedelta(minutes=1)
            t2 = t1 + timedelta(seconds=20)
            t3 = t1 + timedelta(seconds=40)

            await td.write_operational_observations(
                tenant_id,
                [
                    {
                        "signal_id": sig_so,
                        "resource_id": machine_id,
                        "value_type": "string",
                        "event_time": t_old_73h,
                        "source_time": t_old_73h,
                        "value": "SO-73H",
                        "raw_quality": "GOOD",
                        "event_uid": "so-73h",
                        "data_epoch": 1,
                    },
                    {
                        "signal_id": sig_temp,
                        "resource_id": machine_id,
                        "value_type": "float64",
                        "event_time": t0,
                        "source_time": t0,
                        "value": 0.0,
                        "raw_quality": "GOOD",
                        "event_uid": "temp-0",
                        "data_epoch": 1,
                    },
                    {
                        "signal_id": sig_temp,
                        "resource_id": machine_id,
                        "value_type": "float64",
                        "event_time": t1,
                        "source_time": t1,
                        "value": 20.0,
                        "raw_quality": "GOOD",
                        "event_uid": "temp-1",
                        "data_epoch": 1,
                    },
                    {
                        "signal_id": sig_temp,
                        "resource_id": machine_id,
                        "value_type": "float64",
                        "event_time": t2,
                        "source_time": t2,
                        "value": 40.0,
                        "raw_quality": "GOOD",
                        "event_uid": "temp-2",
                        "data_epoch": 1,
                    },
                    {
                        "signal_id": sig_temp,
                        "resource_id": machine_id,
                        "value_type": "float64",
                        "event_time": t3,
                        "source_time": t3,
                        "value": 999.0,
                        "raw_quality": "BAD",
                        "event_uid": "temp-3-bad",
                        "data_epoch": 1,
                    },
                ],
            )

            # 1. HTTP /observations/history (operational + cursor + value == 0.0)
            p1 = await client.get(
                "/api/v1/observations/history",
                params={
                    "signal_id": str(sig_temp),
                    "start": (t0 - timedelta(seconds=1)).isoformat(),
                    "end": (now + timedelta(seconds=1)).isoformat(),
                    "limit": 2,
                },
            )
            assert p1.status_code == 200, p1.text
            j1 = p1.json()
            assert [it["value"] for it in j1["items"]] == [0.0, 20.0]
            assert j1["next_cursor"] is not None
            p2 = await client.get(
                "/api/v1/observations/history",
                params={
                    "signal_id": str(sig_temp),
                    "start": (t0 - timedelta(seconds=1)).isoformat(),
                    "end": (now + timedelta(seconds=1)).isoformat(),
                    "limit": 5,
                    "cursor": j1["next_cursor"],
                },
            )
            assert p2.status_code == 200
            assert [it["value"] for it in p2.json()["items"]] == [40.0, 999.0]

            # 2. HTTP /observations/aggregate excludes string sig_so and BAD sample (999.0)
            agg = await client.get(
                "/api/v1/observations/aggregate",
                params={
                    "signal_ids": f"{sig_temp},{sig_so}",
                    "start": (t1 - timedelta(seconds=5)).isoformat(),
                    "end": (t3 + timedelta(seconds=10)).isoformat(),
                    "bucket_ms": 60_000,
                    "fn": "avg",
                },
            )
            assert agg.status_code == 200, agg.text
            buckets = agg.json()["buckets"]
            assert len(buckets) == 1
            assert buckets[0]["signal_id"] == str(sig_temp)
            assert buckets[0]["value"] == pytest.approx(30.0)
            assert buckets[0]["good_count"] == 2

            # 3. value_at arbitrary 72h lookback via async session
            factory = session_factory()
            async with factory() as s:
                vat = await models_engine.fetch_value_at(s, tenant_id, [(str(sig_so), t2 - timedelta(hours=72), "s")])
                assert vat[(str(sig_so), t2 - timedelta(hours=72))].value == "SO-73H"

            # 4. Managed recorded + reconstructed with pre-window seed and gap truncation
            design_id = uuid4()
            ver_id = uuid4()
            dataset_id = uuid4()
            stable_name = f"ds_{design_id.hex[:8]}_temp_v1"
            sub_name = f"md_{dataset_id.hex[:8]}_temp"
            db_name = f"fx_t_{tenant_id.hex}"
            await td.execute_sql(
                f"CREATE STABLE IF NOT EXISTS `{db_name}`.`{stable_name}` ("
                "`ts` TIMESTAMP, `acquired_at` TIMESTAMP, `source_time` TIMESTAMP, "
                "`raw_quality` NCHAR(16), `reason_code` NCHAR(64), `event_uid` NCHAR(64), "
                "`data_epoch` BIGINT, `record_kind` NCHAR(24), `temp` DOUBLE"
                ") TAGS (`dataset_id` NCHAR(36), `series_key` NCHAR(96), `resource_id` NCHAR(36))"
            )
            await td.execute_sql(
                f"CREATE TABLE IF NOT EXISTS `{db_name}`.`{sub_name}` USING `{db_name}`.`{stable_name}` "
                f"TAGS ('{dataset_id}', 'sig:{sig_temp}', '{machine_id}')"
            )
            async with factory() as s:
                await s.execute(
                    text(
                        """
                        INSERT INTO storage_designs (
                            id, tenant_id, name, description, scope_json, draft_ast_json,
                            status, current_version, published_version_id, created_at, updated_at
                        )
                        VALUES (:did, :tid, 'Mfg Temp', 'S09', '{}'::jsonb, '{}'::jsonb, 'RUNNING', 1, :vid, :now, :now)
                        """
                    ),
                    {"did": design_id, "tid": tenant_id, "vid": ver_id, "now": now},
                )
                await s.execute(
                    text(
                        """
                        INSERT INTO storage_design_versions (
                            id, tenant_id, design_id, version, ast_json, ast_hash, semantic_hash,
                            compiler_version, ddl_plan_json, plan_hash, publish_state, effective_from_epoch,
                            effective_at, created_at, applied_at
                        )
                        VALUES (:vid, :tid, :did, 1, '{}'::jsonb, 'ah1', 'sh1', 's09', '{}'::jsonb, 'ph1', 'APPLIED', 1, :now, :now, :now)
                        """
                    ),
                    {"vid": ver_id, "tid": tenant_id, "did": design_id, "now": now},
                )
                await s.execute(
                    text(
                        """
                        INSERT INTO storage_datasets (
                            id, tenant_id, design_id, dataset_key, display_name, semantics, source_kind,
                            time_axis, tags_json, status, current_schema_version, created_at, updated_at
                        )
                        VALUES (:dsid, :tid, :did, 'temp', 'Temp', 'state_series', 'signals', 'acquired_at', '[]'::jsonb, 'RUNNING', 1, :now, :now)
                        """
                    ),
                    {"dsid": dataset_id, "tid": tenant_id, "did": design_id, "now": now},
                )
                await s.execute(
                    text(
                        """
                        INSERT INTO storage_field_bindings (
                            id, tenant_id, dataset_id, field_key, display_name, value_type, source_kind,
                            signal_id, resource_id, source_ref, source_revision, transform_json, nullable, required, ordinal
                        )
                        VALUES (:fid, :tid, :dsid, 'temp', 'Temp', 'float64', 'signal', :sid, :rid, :sref, 1, '{}'::jsonb, FALSE, TRUE, 0)
                        """
                    ),
                    {
                        "fid": uuid4(),
                        "tid": tenant_id,
                        "dsid": dataset_id,
                        "sid": sig_temp,
                        "rid": machine_id,
                        "sref": f"{{{{sig:{sig_temp}}}}}",
                    },
                )
                await s.execute(
                    text(
                        """
                        INSERT INTO storage_recording_policies (
                            id, tenant_id, dataset_id, mode, policy_json, retention_json, version, enabled, legal_hold, updated_at
                        )
                        VALUES (:pid, :tid, :dsid, 'ON_CHANGE', CAST(:pjson AS jsonb), CAST(:rjson AS jsonb), 1, TRUE, FALSE, :now)
                        """
                    ),
                    {
                        "pid": uuid4(),
                        "tid": tenant_id,
                        "dsid": dataset_id,
                        "pjson": '{"mode":"ON_CHANGE","qualityTransitions":true}',
                        "rjson": '{"days":90}',
                        "now": now,
                    },
                )
                await s.execute(
                    text(
                        """
                        INSERT INTO storage_physical_registry (id, tenant_id, tier, design_id, design_version_id, dataset_id, signal_id, series_key, value_type, td_database, td_stable, td_subtable, physical_schema_hash, generation, status, created_at, updated_at)
                        VALUES (:id, :tid, 'MANAGED', :did, :vid, :dsid, :sid, :skey, 'float64', :db, :st, :sub, 'h1', 1, 'ACTIVE', :now, :now)
                        """
                    ),
                    {
                        "id": uuid4(),
                        "tid": tenant_id,
                        "did": design_id,
                        "vid": ver_id,
                        "dsid": dataset_id,
                        "sid": sig_temp,
                        "skey": f"{dataset_id}:sig:{sig_temp}",
                        "db": db_name,
                        "st": stable_name,
                        "sub": sub_name,
                        "now": now,
                    },
                )
                await s.commit()

            evaluator = DefaultRecordingPolicyEvaluator()
            target = ManagedBindingTarget(
                design_id=design_id,
                design_version_id=ver_id,
                dataset_id=dataset_id,
                tag_dataset_id=str(dataset_id),
                dataset_key="temp",
                design_status="RUNNING",
                dataset_status="RUNNING",
                registry_status="ACTIVE",
                semantics="state_series",
                time_axis="acquired_at",
                td_database=db_name,
                td_stable=stable_name,
                td_subtable=sub_name,
                series_key=f"sig:{sig_temp}",
                field_key="temp",
                value_type="float64",
                max_length=None,
                nullable=False,
                required=True,
                signal_id=sig_temp,
                model_id=None,
                model_field_path=None,
                resource_id=machine_id,
                source_revision=1,
                transform_expr=None,
                transform_ast=None,
                mode=RecordingMode.ON_CHANGE,
            )
            win_start = t1 + timedelta(seconds=5)
            win_end = t1 + timedelta(seconds=60)
            managed_obs = [
                # Pre-window seed 3s before win_start (within 12s hold!)
                (t1 + timedelta(seconds=2), 20.0, Quality.GOOD, "mg-0"),
                # Suppressed steady value inside window
                (t1 + timedelta(seconds=4), 20.0, Quality.GOOD, "mg-dup"),
                # After 30s (> 12s stale_after_ms!), a changed value arrives
                (t1 + timedelta(seconds=32), 25.0, Quality.GOOD, "mg-2"),
            ]
            items = []
            for ts_ev, val, qual, uid in managed_obs:
                obs = CanonicalObservation(
                    event_uid=uid,
                    tenant_id=tenant_id,
                    resource_id=machine_id,
                    signal_id=sig_temp,
                    acquired_at=ts_ev,
                    source_time=ts_ev,
                    value=val,
                    value_type="float64",
                    quality=qual,
                    origin=Origin.LIVE,
                    config_revision=1,
                    data_epoch=1,
                )
                det = evaluator.evaluate_for_targets(obs, targets=[target], previous_live=None, active_epoch=1)
                for w in det.writes:
                    items.append(w.to_subtable_item())
            await td.write_batch(db_name, items)

            rec_resp = await client.get(
                "/api/v1/observations/history",
                params={
                    "signal_id": str(sig_temp),
                    "start": win_start.isoformat(),
                    "end": win_end.isoformat(),
                    "mode": "recorded",
                },
            )
            assert rec_resp.status_code == 200, rec_resp.text
            assert rec_resp.json()["fidelity"] == "managed_recorded"
            assert [it["value"] for it in rec_resp.json()["items"]] == [25.0]

            recon_resp = await client.get(
                "/api/v1/observations/history",
                params={
                    "signal_id": str(sig_temp),
                    "start": win_start.isoformat(),
                    "end": win_end.isoformat(),
                    "mode": "reconstructed",
                },
            )
            assert recon_resp.status_code == 200, recon_resp.text
            rj = recon_resp.json()
            assert rj["fidelity"] == "reconstructed"
            # Pre-window seed carried in (20.0), truncated to STALE at pre_ts+12s (= t1+14s), then 25.0, then STALE at +44s
            assert rj["items"][0]["virtual"] is True and rj["items"][0]["value"] == 20.0
            assert rj["items"][1]["quality"] == "STALE" and rj["items"][1]["value"] is None
            assert rj["items"][2]["value"] == 25.0 and rj["items"][2]["virtual"] is False
            assert rj["items"][3]["quality"] == "STALE" and rj["items"][3]["value"] is None

            # 5. Model snapshots stored/read/pruned/archived in TDengine
            async with factory() as s:
                snap_rows = [
                    {
                        "group_id": model_id,
                        "tenant_id": tenant_id,
                        "body": f'{{"temp":{i}}}',
                        "sampled_at": t1 + timedelta(seconds=i),
                        "errors_json": "[]",
                        "error_count": 0,
                    }
                    for i in range(5)
                ]
                await models_engine.write_samples(s, snap_rows)
                await s.commit()

            snaps = await client.get(f"/api/v1/data-models/{model_id}/snapshots?limit=10")
            assert snaps.status_code == 200, snaps.text
            assert [s["body"] for s in snaps.json()] == [f'{{"temp":{i}}}' for i in reversed(range(5))]

            # 6. Storage overview shows TDengine observation count & non-null disk_bytes
            ov = await client.get("/api/v1/storage/overview")
            assert ov.status_code == 200, ov.text
            ovj = ov.json()
            assert ovj["observations"] == 5
            assert ovj["disk_bytes"] is not None and ovj["disk_bytes"] >= 0

            # 7. Epoch bump immediately isolates pre-reset TDengine history & snapshots
            async with factory() as s:
                await s.execute(
                    text(
                        """
                        INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at)
                        VALUES (:tid, 2, 'ACTIVE', :now)
                        ON CONFLICT (tenant_id) DO UPDATE SET active_epoch = 2, updated_at = EXCLUDED.updated_at
                        """
                    ),
                    {"tid": tenant_id, "now": now},
                )
                await s.commit()

            after_bump = await client.get(
                "/api/v1/observations/history",
                params={"signal_id": str(sig_temp), "start": (t0 - timedelta(seconds=1)).isoformat(), "end": (now + timedelta(seconds=1)).isoformat()},
            )
            assert after_bump.json()["items"] == []
            assert (await client.get(f"/api/v1/data-models/{model_id}/snapshots")).json() == []
            assert (await client.get("/api/v1/storage/overview")).json()["observations"] == 0
    finally:
        await td.close()
        await _wipe_pg_and_td()
