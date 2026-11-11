"""Live S08 5-protocol E2E verification: LiveStateProvider, staleness/bad recovery, 4 health dimensions, replay guard & cold TDengine recovery."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_REPO_ROOT = Path(__file__).resolve().parents[5]
_ACQ_SRC_DIR = _REPO_ROOT / "apps" / "acquisition" / "src"
_ACQ_INT_DIR = _REPO_ROOT / "apps" / "acquisition" / "tests" / "integration"
for _p in (str(_REPO_ROOT), str(_ACQ_SRC_DIR), str(_ACQ_INT_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from acq_int_helpers import (  # noqa: E402
    assert_isolated_test_env,
    cleanup_broker_topology,
    isolated_broker_cfg,
    make_runtime,
    seed_5_protocols,
    start_runtime,
    stop_runtime,
)
from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance, derive_event_uid  # noqa: E402
from factorix.domain.quality import Origin, Quality  # noqa: E402
from factorix.modules import models_engine, telemetry  # noqa: E402
from factorix.modules.ingestion_worker import IngestionWorker, PgIngestionStore  # noqa: E402
from factorix.modules.live_state import TDengineLiveStateProvider, configure_live_state_provider  # noqa: E402
from factorix.platform.broker import RabbitMQPublisher  # noqa: E402
from factorix.platform.tdengine import TDEngineClient, tenant_database_name  # noqa: E402
from tests.simulators.ot_simulators import SimulatorSuite  # noqa: E402


def _pg_sa_dsn() -> str:
    url = os.environ["FACTORIX_DATABASE_URL"]
    return url if "asyncpg" in url else url.replace("postgresql://", "postgresql+asyncpg://")


def _td_dsn() -> str:
    return os.environ["FACTORIX_TDENGINE_DSN"]


async def _cleanup_seeded_tenant(
    pool: asyncpg.Pool,
    td: TDEngineClient,
    tenant_id: UUID,
    *,
    instance_prefix: str,
) -> None:
    try:
        await td.drop_database(tenant_database_name(tenant_id), confirm=True)
    except Exception:
        pass
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM audit_events WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM observation_quarantine WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM latest_signal_state WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM observations WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM ingest_dedup WHERE tenant_id = $1", tenant_id)
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
        await conn.execute("DELETE FROM edge_nodes WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM secret_store WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM resources WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM resource_types WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM admin_accounts WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM sites WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM telemetry_generations WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM collector_runtime_status WHERE instance_id LIKE $1", f"{instance_prefix}%")
        await conn.execute("DELETE FROM tenants WHERE id = $1", tenant_id)


@pytest.mark.asyncio
async def test_live_state_5_protocols_quality_stale_recovery_and_cold_tdengine_restart(tmp_path: Path) -> None:
    asyncpg_dsn, amqp_url, mgmt_url, data_key = assert_isolated_test_env()
    suffix = uuid4().hex[:8]
    broker_cfg = isolated_broker_cfg(amqp_url, mgmt_url)
    pg_pool = await asyncpg.create_pool(asyncpg_dsn, min_size=2, max_size=8)
    sa_engine = create_async_engine(_pg_sa_dsn())
    sa_maker = async_sessionmaker(sa_engine, expire_on_commit=False, class_=AsyncSession)
    td = TDEngineClient(_td_dsn())
    pg_store = PgIngestionStore(asyncpg_dsn, min_pool=1, max_pool=4)

    suite = SimulatorSuite(tick_interval_s=0.15)
    endpoints = await suite.start()
    tid: UUID | None = None
    broker_pub = RabbitMQPublisher(broker_cfg)
    worker: IngestionWorker | None = None
    runtime = None
    rt_task: asyncio.Task[None] | None = None

    try:
        suite.http.expected_api_key = "sim-bearer-secret-01"
        opcua_ns = await suite.opcua.server.get_namespace_index("urn:factorix:sim:opcua")

        seeded = await seed_5_protocols(pg_pool, endpoints, data_key=data_key, opcua_ns=opcua_ns)
        tid = seeded["tenant_id"]
        async with pg_pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at) "
                "VALUES ($1, 1, 'ACTIVE', NOW()) ON CONFLICT (tenant_id) DO NOTHING",
                tid,
            )

        worker_provider = TDengineLiveStateProvider(td)
        api_provider = TDengineLiveStateProvider(td)
        configure_live_state_provider(api_provider)

        worker = IngestionWorker(
            pg_store=pg_store,
            tdengine=td,
            broker_cfg=broker_cfg,
            instance_id=f"test-s08-ing-{suffix}",
            batch_size=32,
            flush_ms=20,
            shadow_pg=False,
            live_provider=worker_provider,
        )
        runtime, _lkg, _spool, _acq_pub = make_runtime(
            pg_pool,
            asyncpg_dsn,
            broker_pub,
            tmp_path,
            data_key=data_key,
            instance_id=f"test-s08-acq-{suffix}",
            use_leader_lock=False,
            heartbeat_s=0.5,
            config_s=3.0,
        )

        all_sids = [sid for sids in seeded["signals_by_protocol"].values() for sid in sids]
        sids_by_key = {str(meta["key"]): sid for sid, meta in seeded["signal_meta"].items()}
        sig_mq_temp = sids_by_key["mq_temp"]
        sig_mq_run = sids_by_key["mq_run"]
        sig_opc_temp = sids_by_key["opc_temp"]
        sig_http_status = sids_by_key["http_status"]

        async def _fetch_latest_map(sids: list[UUID] | None = None) -> dict[UUID, dict[str, Any]]:
            async with sa_maker() as session:
                rows = await telemetry.latest_states(session, tid, sids or all_sids)  # type: ignore[arg-type]
            return {UUID(str(r["signal_id"])): r for r in rows}
        await broker_pub.start()
        await worker.start()
        rt_task = await start_runtime(runtime)

        # 1. All 10 signals across all 5 protocols reach GOOD + HEALTHY across all 4 health dimensions
        deadline = asyncio.get_running_loop().time() + 25.0
        latest: dict[UUID, dict[str, Any]] = {}
        while asyncio.get_running_loop().time() < deadline:
            latest = await _fetch_latest_map()
            if (
                len(latest) == 10
                and all(
                    r["effective_status"] == "GOOD"
                    and r["source_health"] == "GOOD"
                    and r["connection_health"] == "HEALTHY"
                    and r["broker_health"] == "HEALTHY"
                    and r["storage_health"] == "HEALTHY"
                    for r in latest.values()
                )
            ):
                break
            await asyncio.sleep(0.25)

        assert len(latest) == 10, f"Expected all 10 signals, got {len(latest)}: {latest}"
        for sid, row in latest.items():
            assert row["effective_status"] == "GOOD", f"Signal {sid} not GOOD: {row}"
            assert row["last_acquired_at"] is not None
            assert row["last_value_changed_at"] is not None
            assert row["source_health"] == "GOOD"
            assert row["connection_health"] == "HEALTHY"
            assert row["broker_health"] == "HEALTHY"
            assert row["storage_health"] == "HEALTHY"

        # 2. Steady unchanging signal (`http_status` == "RUNNING", `mq_run` == True) keeps GOOD
        #    while `last_acquired_at` advances beyond `last_value_changed_at`.
        deadline = asyncio.get_running_loop().time() + 6.0
        steady_ok = False
        while asyncio.get_running_loop().time() < deadline:
            latest = await _fetch_latest_map([sig_http_status, sig_mq_run])
            hr = latest.get(sig_http_status)
            mr = latest.get(sig_mq_run)
            if (
                hr
                and mr
                and hr["last_acquired_at"] > hr["last_value_changed_at"]
                and mr["last_acquired_at"] > mr["last_value_changed_at"]
            ):
                steady_ok = True
                break
            await asyncio.sleep(0.25)
        assert steady_ok, f"Expected steady acquisition timestamps > changed timestamps, got: {latest}"

        mq_steady_changed_before = latest[sig_mq_run]["last_value_changed_at"]

        # 3. Inject OPC UA BAD source fault + pause MQTT publisher until STALE (>12s min_stale_ms)
        suite.apply_fault("opcua", "status_mode", "Bad")
        suite.apply_fault("mqtt", "pause_publisher", True)

        # Wait for OPC UA BAD promptly first
        deadline = asyncio.get_running_loop().time() + 10.0
        opc_bad = False
        while asyncio.get_running_loop().time() < deadline:
            latest = await _fetch_latest_map([sig_opc_temp])
            row = latest.get(sig_opc_temp)
            if row and row["effective_status"] == "BAD" and row["last_good"] is not None:
                opc_bad = True
                assert row["source_health"] == "BAD"
                assert row["broker_health"] == "HEALTHY"
                assert row["storage_health"] == "HEALTHY"
                break
            await asyncio.sleep(0.2)
        assert opc_bad, f"OPC UA signal never transitioned to BAD with last_good: {latest}"

        # Wait for MQTT publisher silence to cross MIN_STALE_MS=12s (other 3 healthy protocols remain GOOD!)
        deadline = asyncio.get_running_loop().time() + 16.0
        mq_stale = False
        while asyncio.get_running_loop().time() < deadline:
            latest = await _fetch_latest_map()
            mr = latest.get(sig_mq_run)
            mt = latest.get(sig_mq_temp)
            if mr and mt and mr["effective_status"] == "STALE" and mt["effective_status"] == "STALE":
                mq_stale = True
                assert mr["reason_code"] == "NO_FRESH_ACQUISITION"
                assert mr["source_health"] == "STALE"
                # Independent health dimensions: broker and storage remain HEALTHY while source is STALE!
                assert mr["broker_health"] == "HEALTHY"
                assert mr["storage_health"] == "HEALTHY"
                break
            await asyncio.sleep(0.4)
        assert mq_stale, f"MQTT signals did not become STALE after publisher silence: {latest}"

        # While MQTT is STALE, verify models_engine respects STALE / BAD fallback without labeling GOOD
        async with sa_maker() as session:
            samples, qualities = await models_engine.load_samples(
                session, tid, [sig_mq_run, sig_opc_temp], live_provider=api_provider
            )
        assert qualities[str(sig_mq_run).lower()] == "STALE"
        assert samples[str(sig_mq_run).lower()] is not None and samples[str(sig_mq_run).lower()].quality == "STALE"
        assert qualities[str(sig_opc_temp).lower()] == "BAD"
        assert samples[str(sig_opc_temp).lower()] is not None
        assert samples[str(sig_opc_temp).lower()].quality == "BAD"
        assert samples[str(sig_opc_temp).lower()].value is not None

        # Replay an older timestamped MQTT packet -> must be rejected and MUST NOT clear STALE
        stale_acq_before = latest[sig_mq_run]["last_acquired_at"]
        old_dt = datetime.fromisoformat(str(stale_acq_before).replace("Z", "+00:00")) - timedelta(seconds=10)
        fid_mq_run = seeded["signal_meta"][sig_mq_run]["field_id"]
        cid_mq = seeded["connections"]["mqtt"]["connection_id"]
        acked_before = worker.metrics.acked_total
        replay_obs = CanonicalObservation(
            event_uid=derive_event_uid(
                tenant_id=tid,
                connection_id=cid_mq,
                source_field_id=fid_mq_run,
                signal_id=sig_mq_run,
                acquired_at=old_dt,
                sequence_or_key="old-replay-01",
                data_epoch=1,
            ),
            tenant_id=tid,
            site_id=seeded["site_id"],
            connection_id=cid_mq,
            acquisition_job_id=seeded["connections"]["mqtt"]["job_id"],
            source_field_id=fid_mq_run,
            signal_id=sig_mq_run,
            resource_id=seeded["resource_id"],
            source_time=old_dt + timedelta(hours=1),  # even with skewed future source_time!
            acquired_at=old_dt,
            value_type="bool",
            value=False,
            quality=Quality.GOOD,
            origin=Origin.REPLAYED,
            data_epoch=1,
            config_revision=1,
            source_sequence=0,
            provenance=CanonicalProvenance(protocol="mqtt", connection_id=cid_mq, source_field_id=fid_mq_run, config_revision=1),
        )
        await broker_pub.publish_observation(replay_obs)
        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline and worker.metrics.acked_total <= acked_before:
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.1)

        after_replay = (await _fetch_latest_map([sig_mq_run]))[sig_mq_run]
        assert after_replay["effective_status"] == "STALE"
        assert after_replay["last_acquired_at"] == stale_acq_before

        # 4. Resume OPC UA Good + MQTT publisher -> automatic recovery to GOOD
        #    and steady `mq_run` keeps its original `last_value_changed_at`.
        suite.apply_fault("opcua", "status_mode", "Good")
        suite.apply_fault("mqtt", "pause_publisher", False)

        deadline = asyncio.get_running_loop().time() + 12.0
        recovered = False
        while asyncio.get_running_loop().time() < deadline:
            latest = await _fetch_latest_map([sig_opc_temp, sig_mq_run, sig_mq_temp])
            if all(r["effective_status"] == "GOOD" for r in latest.values()) and len(latest) == 3:
                recovered = True
                break
            await asyncio.sleep(0.2)
        assert recovered, f"Signals did not automatically recover to GOOD: {latest}"
        assert latest[sig_mq_run]["last_value_changed_at"] == mq_steady_changed_before
        assert latest[sig_mq_run]["last_acquired_at"] > mq_steady_changed_before

        # Zero rows written to PG observations when shadow_pg=False (TDengine is primary historian!)
        async with pg_pool.acquire() as conn:
            obs_count = await conn.fetchval("SELECT count(*) FROM observations WHERE tenant_id = $1", tid)
        assert int(obs_count or 0) == 0

        # 5. Cold Restart Recovery via TDengine LAST_ROW(*):
        #    Stop pipeline briefly, wipe PG latest_signal_state for this tenant, swap in a brand-new cold provider ->
        #    must restore from TDengine conservatively as UNCERTAIN / UNVERIFIED_AFTER_RESTART (`source_health == UNKNOWN`),
        #    then promote cleanly to GOOD as soon as fresh post-boot samples arrive.
        await stop_runtime(rt_task)
        rt_task = None
        await worker.stop(drain_timeout_s=5.0)
        await asyncio.sleep(0.1)

        async with pg_pool.acquire() as conn:
            await conn.execute("DELETE FROM latest_signal_state WHERE tenant_id = $1", tid)

        cold_provider = TDengineLiveStateProvider(td)
        configure_live_state_provider(cold_provider)
        cold_latest = await _fetch_latest_map([sig_http_status, sig_mq_temp])
        assert len(cold_latest) == 2
        for sid, row in cold_latest.items():
            assert row["effective_status"] == "UNCERTAIN", f"Cold restart row {sid} must be UNCERTAIN, got {row}"
            assert row["reason_code"] == "UNVERIFIED_AFTER_RESTART"
            assert row["source_health"] == "UNKNOWN"
            assert row["value"] is not None

        # Restart live acquisition & worker -> fresh post-boot samples promote restored signals to GOOD
        worker = IngestionWorker(
            pg_store=pg_store,
            tdengine=td,
            broker_cfg=broker_cfg,
            instance_id=f"test-s08-ing2-{suffix}",
            batch_size=32,
            flush_ms=20,
            shadow_pg=False,
            live_provider=cold_provider,
        )
        await worker.start()
        runtime_restarted, _lkg2, _spool2, _pub2 = make_runtime(
            pg_pool,
            asyncpg_dsn,
            broker_pub,
            tmp_path,
            data_key=data_key,
            instance_id=f"test-s08-acq2-{suffix}",
            use_leader_lock=False,
            heartbeat_s=0.5,
            config_s=3.0,
        )
        rt_task = await start_runtime(runtime_restarted)
        runtime = runtime_restarted

        deadline = asyncio.get_running_loop().time() + 15.0
        promoted = False
        while asyncio.get_running_loop().time() < deadline:
            cold_latest = await _fetch_latest_map([sig_http_status, sig_mq_temp])
            if len(cold_latest) == 2 and all(r["effective_status"] == "GOOD" for r in cold_latest.values()):
                promoted = True
                break
            await asyncio.sleep(0.2)
        assert promoted, f"Signals failed to promote from UNVERIFIED_AFTER_RESTART to GOOD: {cold_latest}"
    finally:
        configure_live_state_provider(None)
        if rt_task is not None:
            await stop_runtime(rt_task)
        if runtime is not None:
            try:
                await runtime.close()
            except Exception:
                pass
        if worker is not None:
            try:
                await worker.stop(drain_timeout_s=5.0)
            except Exception:
                pass
        await broker_pub.close()
        await suite.stop()
        await pg_store.close()
        await sa_engine.dispose()
        if tid is not None:
            await _cleanup_seeded_tenant(pg_pool, td, tid, instance_prefix="test-s08-")
        await td.close()
        await pg_pool.close()
        await cleanup_broker_topology(broker_cfg)
