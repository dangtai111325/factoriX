"""Broker outage spooling, LKG PG-outage cold start, replay delivery, and epoch fencing integration tests."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from aio_pika.abc import AbstractIncomingMessage

from factorix.domain.canonical import CanonicalObservation
from factorix.platform.broker import ConsumeOutcome, RabbitMQConsumer, RabbitMQPublisher
from factorix_acquisition.config_provider import ConfigProvider, LkgSnapshotStore, PgSecretStore
from factorix_acquisition.pg_control import PgControlPlane
from factorix_acquisition.publisher import ObservationPublisher
from factorix_acquisition.runtime import AcquisitionRuntime
from factorix_acquisition.spool import AcquisitionSpool
from acq_int_helpers import (
    assert_isolated_test_env,
    cleanup_broker_topology,
    isolated_broker_cfg,
    make_runtime,
    seed_5_protocols,
    start_runtime,
    stop_runtime,
)


@pytest.mark.asyncio
async def test_broker_outage_spills_and_replays_to_rabbitmq_and_lkg_cold_start_survives_pg_outage(
    pg_pool, sim_suite, tmp_path: Path
) -> None:
    pool, asyncpg_dsn = pg_pool
    suite, endpoints = sim_suite
    suite.http.expected_api_key = "sim-bearer-secret-01"
    opcua_ns = await suite.opcua.server.get_namespace_index("urn:factorix:sim:opcua")
    _, amqp_url, mgmt_url, data_key = assert_isolated_test_env()

    seeded = await seed_5_protocols(pool, endpoints, data_key=data_key, opcua_ns=opcua_ns)
    broker_cfg = isolated_broker_cfg(amqp_url, mgmt_url)
    received: list[CanonicalObservation] = []

    async def handle(msg: AbstractIncomingMessage) -> ConsumeOutcome:
        received.append(CanonicalObservation.from_json_bytes(msg.body))
        return ConsumeOutcome.ACK

    consumer = RabbitMQConsumer(broker_cfg, handle)
    broker = RabbitMQPublisher(broker_cfg)
    runtime, lkg_store, spool, pub = make_runtime(pool, asyncpg_dsn, broker, tmp_path, data_key=data_key, use_leader_lock=False)
    rt_task: asyncio.Task[None] | None = None
    try:
        await broker.start()
        await consumer.start()
        rt_task = await start_runtime(runtime)

        # Wait until live fast path delivers observations and LKG file is written
        deadline = asyncio.get_running_loop().time() + 10.0
        while asyncio.get_running_loop().time() < deadline and len(received) < 6:
            await asyncio.sleep(0.1)
        assert len(received) >= 6
        assert lkg_store.path is not None and lkg_store.path.is_file()

        # Simulate mid-stream RabbitMQ outage -> observations spill to SQLite WAL spool
        pub.set_broker(None)
        await asyncio.sleep(1.2)
        pending_during_outage = spool.pending_count()
        assert pending_during_outage >= 6
        assert pub.spilled >= 6

        # Restore RabbitMQ -> newest-per-signal then history replay drains spool cleanly
        pub.set_broker(broker)
        deadline = asyncio.get_running_loop().time() + 10.0
        while asyncio.get_running_loop().time() < deadline and (spool.pending_count() > 0 or pub.published_replay == 0):
            await asyncio.sleep(0.1)
        assert spool.pending_count() == 0
        assert pub.published_replay >= pending_during_outage
        # Give consumer a moment to ACK replayed items
        await asyncio.sleep(0.5)
        assert len(received) >= pub.published_fast + pub.published_replay
        await stop_runtime(rt_task)
        rt_task = None

        # Verify LKG cold-start when PostgreSQL is completely unreachable on startup:
        # LKG restores all 5 job specs cleanly without plaintext secrets on disk, and non-secret
        # protocols (Modbus, OPC UA, MQTT, WebSocket) emit GOOD observations while HTTP isolates
        # its missing PG secret without impacting the rest of the runtime.
        async def failing_loader(_conn, _rev, _digest):
            raise ConnectionRefusedError("PG offline during cold start test")

        cold_cfg = ConfigProvider(None, PgSecretStore(data_key), lkg_store, loader=failing_loader)
        cold_spool = AcquisitionSpool(tmp_path / "cold-spool.sqlite")
        cold_pub = ObservationPublisher(broker, cold_spool)
        cold_rt = AcquisitionRuntime(
            config_provider=cold_cfg,
            control_plane=PgControlPlane(None, instance_id="cold-1"),
            publisher=cold_pub,
            allowlist=[],
        )
        ok = await cold_rt.sync_config(start_jobs=True)
        assert ok is True
        assert cold_rt.config_ok is False
        assert cold_rt.revision >= 1
        assert len(cold_rt.job_tasks) == 5

        count_before_cold = len(received)
        deadline = asyncio.get_running_loop().time() + 6.0
        while asyncio.get_running_loop().time() < deadline:
            if cold_pub.fast_buffered + cold_pub.spool.pending_count() >= 4:
                break
            await asyncio.sleep(0.1)
        assert cold_pub.fast_buffered + cold_pub.spool.pending_count() >= 4
        published_cold, failed_cold = await cold_pub.flush_once()
        assert failed_cold is False and published_cold >= 4
        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline and len(received) < count_before_cold + 4:
            await asyncio.sleep(0.1)
        assert len(received) >= count_before_cold + 4
        # HTTP did not authenticate cleanly because PG pool was offline & LKG stripped secrets:
        http_id = str(seeded["connections"]["http"]["connection_id"])
        assert cold_rt.conn_states.get(http_id, {}).get("last_ok_at") is None
        await cold_rt.close()
        _ = seeded
    finally:
        if rt_task is not None:
            await stop_runtime(rt_task)
        await consumer.stop(drain_timeout_s=5.0)
        await broker.close()
        await cleanup_broker_topology(broker_cfg)


@pytest.mark.asyncio
async def test_epoch_bump_fences_spooled_observations_against_replay_after_outage(
    pg_pool, sim_suite, tmp_path: Path
) -> None:
    pool, asyncpg_dsn = pg_pool
    suite, endpoints = sim_suite
    suite.http.expected_api_key = "sim-bearer-secret-01"
    opcua_ns = await suite.opcua.server.get_namespace_index("urn:factorix:sim:opcua")
    _, amqp_url, mgmt_url, data_key = assert_isolated_test_env()

    seeded = await seed_5_protocols(pool, endpoints, data_key=data_key, opcua_ns=opcua_ns)
    broker_cfg = isolated_broker_cfg(amqp_url, mgmt_url)
    received: list[CanonicalObservation] = []

    async def handle(msg: AbstractIncomingMessage) -> ConsumeOutcome:
        received.append(CanonicalObservation.from_json_bytes(msg.body))
        return ConsumeOutcome.ACK

    consumer = RabbitMQConsumer(broker_cfg, handle)
    broker = RabbitMQPublisher(broker_cfg)
    # Start with broker=None so all epoch=1 samples spill into SQLite spool
    runtime, _lkg, spool, pub = make_runtime(pool, asyncpg_dsn, None, tmp_path, data_key=data_key, use_leader_lock=False)
    try:
        await broker.start()
        await consumer.start()
        await runtime.sync_config(start_jobs=True)
        deadline = asyncio.get_running_loop().time() + 8.0
        while asyncio.get_running_loop().time() < deadline and spool.pending_count() < 5:
            await asyncio.sleep(0.1)
        assert spool.pending_count() >= 5

        # Pause acquisition tasks (reset stage R1) and fence epoch=1 via active_epoch=2 before restoring broker!
        await runtime._stop_all_jobs_and_connectors()
        tid = str(seeded["tenant_id"])
        assert runtime.snapshot is not None
        bumped_snapshot = dict(runtime.snapshot)
        bumped_snapshot["tenant_epochs"] = {tid: 2}
        await runtime.apply_snapshot(bumped_snapshot, runtime.revision + 1, "epoch-2", start_jobs=False)
        assert spool.pending_count() == 0

        # Restore broker and flush -> ZERO epoch=1 observations may reach RabbitMQ!
        pub.set_broker(broker)
        await pub.flush_once()
        await asyncio.sleep(0.4)
        assert len(received) == 0, f"Leaked fenced epoch-1 observations: {received}"

        # Resume under epoch=2 -> fresh observations carry data_epoch=2 cleanly
        await runtime.apply_snapshot(bumped_snapshot, runtime.revision + 2, "epoch-2-resume", start_jobs=True)
        deadline = asyncio.get_running_loop().time() + 8.0
        while asyncio.get_running_loop().time() < deadline and len(received) < 3:
            await pub.flush_once()
            await asyncio.sleep(0.1)
        assert len(received) >= 3
        assert all(obs.data_epoch == 2 for obs in received), f"Expected only epoch=2 observations, got: {received}"
    finally:
        await runtime.close()
        await consumer.stop(drain_timeout_s=5.0)
        await broker.close()
        await cleanup_broker_topology(broker_cfg)
