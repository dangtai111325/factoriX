"""Scale & parity integration test across 36 Data Models & 336 ACTIVE Signals (S09)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[5]
_ENV_FILE = ROOT / ".env"
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value)
os.environ["FACTORIX_ENVIRONMENT"] = "test"

from factorix.platform.settings import get_settings

get_settings.cache_clear()
import factorix.platform.db as db_module

db_module._engine = None
db_module._session_factory = None

from factorix.domain import body as B
from factorix.domain.canonical import CanonicalObservation, Origin, Quality
from factorix.modules import data_models, models_engine
from factorix.modules.history_repository import (
    TDengineHistoryRepository,
    TDengineModelSnapshotProvider,
    configure_history_provider,
    configure_model_snapshot_provider,
)
from factorix.modules.live_state import TDengineLiveStateProvider, configure_live_state_provider
from factorix.platform.db import session_factory
from factorix.platform.tdengine import TDEngineClient, TDEngineConfig
from tests.safety.test_destructive_guard import check_destructive_test_db_guard


@pytest.fixture(autouse=True)
async def _cleanup():
    yield
    configure_live_state_provider(None)
    configure_history_provider(None)
    configure_model_snapshot_provider(None)
    models_engine.ENGINE.live_provider = None
    engine = db_module._engine
    db_module._engine = None
    db_module._session_factory = None
    if engine is not None:
        await engine.dispose()


@pytest.mark.asyncio
async def test_36_models_across_336_signals_tdengine_parity_and_snapshot_ring() -> None:
    settings = get_settings()
    check_destructive_test_db_guard(
        settings.database_url,
        os.environ.get("FACTORIX_ENABLE_DESTRUCTIVE_TESTS"),
    )
    factory = session_factory()
    async with factory() as s:
        await s.execute(
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
        await s.commit()

    td = TDEngineClient(TDEngineConfig(dsn=settings.tdengine_dsn, db_prefix=settings.tdengine_db_prefix))
    for r in await td.query_rows(
        f"SELECT name FROM information_schema.ins_databases WHERE name LIKE '{settings.tdengine_db_prefix}%'"
    ):
        await td.drop_database(str(r["name"]), confirm=True)

    live_provider = TDengineLiveStateProvider(td)
    hist_repo = TDengineHistoryRepository(td)
    snap_repo = TDengineModelSnapshotProvider(td)
    configure_live_state_provider(live_provider)
    configure_history_provider(hist_repo)
    configure_model_snapshot_provider(snap_repo)

    tenant_id = uuid4()
    site_id = uuid4()
    edge_id = uuid4()
    conn_id = uuid4()
    job_id = uuid4()
    machine_type_id = uuid4()
    now = datetime.now(timezone.utc).replace(microsecond=0)

    try:
        await td.ensure_operational_schema(tenant_id)
        async with factory() as s:
            await s.execute(
                text("INSERT INTO tenants (id, code, display_name, created_at) VALUES (:id, 'p36', 'Parity 36', :now)"),
                {"id": tenant_id, "now": now},
            )
            await s.execute(
                text("INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at) VALUES (:id, 1, 'ACTIVE', :now)"),
                {"id": tenant_id, "now": now},
            )
            await s.execute(
                text("INSERT INTO sites (id, tenant_id, code, name, timezone, created_at) VALUES (:id, :tid, 'S1', 'Site 1', 'UTC', :now)"),
                {"id": site_id, "tid": tenant_id, "now": now},
            )
            await s.execute(
                text(
                    """
                    INSERT INTO resource_types (id, tenant_id, key, name, category)
                    VALUES (:id, :tid, 'machine', 'Machine', 'ASSET')
                    """
                ),
                {"id": machine_type_id, "tid": tenant_id},
            )
            await s.execute(
                text(
                    """
                    INSERT INTO connections (id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted, config_json, status, health, version, created_at, updated_at)
                    VALUES (:id, :tid, :sid, NULL, 'modbus_tcp', 'Sim5', '127.0.0.1:15020', '{}'::jsonb, 'ACTIVE', 'HEALTHY', 1, :now, :now)
                    """
                ),
                {"id": conn_id, "tid": tenant_id, "sid": site_id, "now": now},
            )
            await s.execute(
                text(
                    """
                    INSERT INTO acquisition_jobs (id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version)
                    VALUES (:id, :cid, 'POLL', 1000, 3000, TRUE, 1, 1, 1)
                    """
                ),
                {"id": job_id, "cid": conn_id},
            )

            # Seed 36 machines and 336 ACTIVE signals (9 or 10 signals per machine: 12 * 10 + 24 * 9 = 336)
            machines: list[UUID] = []
            sig_specs: list[tuple[UUID, UUID, str, str]] = []  # (sig_id, mach_id, key, data_type)
            for m_idx in range(36):
                mid = uuid4()
                machines.append(mid)
                await s.execute(
                    text(
                        """
                        INSERT INTO resources (id, tenant_id, site_id, type_id, code, name, status, version, created_at, updated_at)
                        VALUES (:id, :tid, :sid, :typid, :code, :name, 'ACTIVE', 1, :now, :now)
                        """
                    ),
                    {"id": mid, "tid": tenant_id, "sid": site_id, "typid": machine_type_id, "code": f"M-{m_idx:02d}", "name": f"Machine {m_idx:02d}", "now": now},
                )
                n_sigs = 10 if m_idx < 12 else 9
                for k_idx in range(n_sigs):
                    sid = uuid4()
                    vtype = "string" if k_idx == 1 else "float64"
                    key = f"s{k_idx}"
                    sig_specs.append((sid, mid, key, vtype))
                    sf_id = uuid4()
                    await s.execute(
                        text(
                            """
                            INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
                            VALUES (:sfid, :jid, 'modbus_register', CAST(:ajson AS jsonb), :vtype, '{}'::jsonb, :ord)
                            """
                        ),
                        {"sfid": sf_id, "jid": job_id, "ajson": '{"nullable": false}', "vtype": vtype, "ord": k_idx},
                    )
                    await s.execute(
                        text(
                            """
                            INSERT INTO signal_definitions (id, tenant_id, resource_id, key, display_name, data_type, category, unit, expected_interval_ms, status, version, created_at, updated_at)
                            VALUES (:sid, :tid, :rid, :key, :key, :vtype, 'COLLECTED', 'u', 1000, 'ACTIVE', 1, :now, :now)
                            """
                        ),
                        {"sid": sid, "tid": tenant_id, "rid": mid, "key": key, "vtype": vtype, "now": now},
                    )
                    await s.execute(
                        text(
                            """
                            INSERT INTO signal_bindings (id, signal_id, source_field_id, enabled, revision, valid_from)
                            VALUES (:bid, :sid, :sfid, TRUE, 1, :vf)
                            """
                        ),
                        {"bid": uuid4(), "sid": sid, "sfid": sf_id, "vf": now - timedelta(days=5)},
                    )
            assert len(sig_specs) == 336

            # Seed TDengine operational history + LiveStateProvider (plus a past value_at row for machine 0)
            td_records: list[dict[str, Any]] = []
            past_at = now - timedelta(hours=2)
            for idx, (sid, mid, key, vtype) in enumerate(sig_specs):
                val: Any = f"LOT-{idx}" if vtype == "string" else float(idx + 1)
                td_records.append(
                    {
                        "signal_id": sid,
                        "resource_id": mid,
                        "connection_id": conn_id,
                        "value_type": vtype,
                        "event_time": now - timedelta(seconds=1),
                        "acquired_at": now - timedelta(seconds=1),
                        "source_time": now - timedelta(seconds=1),
                        "value": val,
                        "raw_quality": "GOOD",
                        "event_uid": f"live-{idx}",
                        "data_epoch": 1,
                    }
                )
                await live_provider.apply_observation(
                    CanonicalObservation(
                        event_uid=f"live-{idx}",
                        tenant_id=tenant_id,
                        resource_id=mid,
                        signal_id=sid,
                        acquired_at=now - timedelta(seconds=1),
                        source_time=now - timedelta(seconds=1),
                        value=val,
                        value_type=vtype,
                        quality=Quality.GOOD,
                        origin=Origin.LIVE,
                        config_revision=1,
                        data_epoch=1,
                    )
                )
                if idx == 1:  # string signal on machine 0 also gets a historical value_at target
                    td_records.append(
                        {
                            "signal_id": sid,
                            "resource_id": mid,
                            "connection_id": conn_id,
                            "value_type": vtype,
                            "event_time": past_at - timedelta(minutes=5),
                            "acquired_at": past_at - timedelta(minutes=5),
                            "source_time": past_at - timedelta(minutes=5),
                            "value": "LOT-PAST",
                            "raw_quality": "GOOD",
                            "event_uid": "past-so",
                            "data_epoch": 1,
                        }
                    )
            await td.write_operational_observations(tenant_id, td_records)

            # Create 36 Data Models referencing all 336 signals (one per machine)
            sigs_by_m: dict[UUID, list[tuple[UUID, str, str]]] = {}
            for sid, mid, key, vtype in sig_specs:
                sigs_by_m.setdefault(mid, []).append((sid, key, vtype))

            model_defs: list[models_engine.ModelDef] = []
            for m_idx, mid in enumerate(machines):
                msigs = sigs_by_m[mid]
                children: list[dict[str, Any]] = [
                    {"key": key, "type": "field", "mode": "mapping", "ref": {"signal_id": str(sid)}}
                    for sid, key, _vt in msigs
                ]
                children.append(
                    {
                        "key": "sum_num",
                        "type": "field",
                        "mode": "calculated",
                        "expr": " + ".join(f"{{{{sig:{sid}}}}}" for sid, _k, vt in msigs if vt == "float64"),
                    }
                )
                if m_idx == 0:
                    children.append(
                        {
                            "key": "lot_2h_ago",
                            "type": "field",
                            "mode": "calculated",
                            "expr": f"value_at({{{{sig:{msigs[1][0]}}}}}, ts({{{{sig:{msigs[0][0]}}}}}) - 7200)",
                        }
                    )
                model_id = uuid4()
                spec = {"version": 2, "root": {"type": "object", "children": children}}
                await s.execute(
                    text(
                        """
                        INSERT INTO output_groups (id, tenant_id, key, display_name, topic_template, projection_policy_json, version, status, kind, emit_policy_json, spec_json, sample_ms, state, created_at, updated_at)
                        VALUES (:id, :tid, :key, :name, '', '{}'::jsonb, 1, 'ACTIVE', 'STATE', '{}'::jsonb, CAST(:spec AS jsonb), 1000, 'RUNNING', :now, :now)
                        """
                    ),
                    {"id": model_id, "tid": tenant_id, "key": f"m-{m_idx}", "name": f"Model {m_idx:02d}", "spec": json.dumps(spec), "now": now},
                )
                model_defs.append(
                    models_engine.ModelDef(
                        id=str(model_id),
                        tenant_id=str(tenant_id),
                        name=f"Model {m_idx:02d}",
                        version=1,
                        sample_ms=1000,
                        state="RUNNING",
                        compiled=B.compile_spec(spec),
                    )
                )
            await s.commit()

        # Run ModelsEngine.process against all 36 models & 336 signals, plus snapshot pruning
        engine = models_engine.ModelEngine(session_factory=factory, live_provider=live_provider)
        async with factory() as s:
            processed = await engine.process(s, model_defs, now)
            await s.commit()
        assert processed == 36

        async with factory() as s:
            m0 = model_defs[0]
            snaps = await data_models.snapshots(s, tenant_id, UUID(m0.id), limit=20)
            assert len(snaps) == 1
            body0 = json.loads(snaps[0]["body"])
            assert body0["lot_2h_ago"] == "LOT-PAST"
            # Verify all 36 model_state rows populated cleanly with 0 errors
            err_cnt = (
                await s.execute(
                    text("SELECT COUNT(*) FROM model_state WHERE tenant_id = :tid AND error_count = 0"),
                    {"tid": tenant_id},
                )
            ).scalar()
            assert int(err_cnt or 0) == 36

            # Ring pruning via TDengineModelSnapshotProvider
            extra = [
                {
                    "group_id": UUID(m0.id),
                    "tenant_id": tenant_id,
                    "body": f'{{"seq":{k}}}',
                    "sampled_at": now + timedelta(seconds=k + 1),
                    "errors_json": "[]",
                    "error_count": 0,
                }
                for k in range(5)
            ]
            await models_engine.write_samples(s, extra)
            await models_engine.prune_snapshots(s, [m0.id], keep=3)
            pruned_snaps = await data_models.snapshots(s, tenant_id, UUID(m0.id), limit=20)
            assert len(pruned_snaps) == 3
            assert [json.loads(x["body"])["seq"] for x in pruned_snaps] == [4, 3, 2]
            await s.commit()
    finally:
        for r in await td.query_rows(
            f"SELECT name FROM information_schema.ins_databases WHERE name LIKE '{settings.tdengine_db_prefix}%'"
        ):
            await td.drop_database(str(r["name"]), confirm=True)
        await td.close()
        async with factory() as s:
            await s.execute(
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
                      collector_runtime_status, telemetry_generations
                    RESTART IDENTITY CASCADE
                    """
                )
            )
            await s.commit()
