"""Live PostgreSQL LISTEN/NOTIFY config reload, secret rotation, commissioning, and F-26 leader lock tests."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from aio_pika.abc import AbstractIncomingMessage

from factorix.domain.canonical import CanonicalObservation
from factorix.platform.broker import ConsumeOutcome, RabbitMQConsumer, RabbitMQPublisher
from factorix.platform.security import encrypt_secret
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
async def test_pg_notify_reloads_pause_resume_secret_rotation_without_touching_other_jobs(
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
    # Slow poll fallback (60s) proves reload is triggered by PostgreSQL LISTEN/NOTIFY, not timer polling!
    runtime, _lkg, _spool, _pub = make_runtime(pool, asyncpg_dsn, broker, tmp_path, data_key=data_key, config_s=60.0)
    rt_task: asyncio.Task[None] | None = None
    try:
        await broker.start()
        await consumer.start()
        rt_task = await start_runtime(runtime)

        mb_job_id = str(seeded["connections"]["modbus_tcp"]["job_id"])
        http_sig_id = seeded["signals_by_protocol"]["http"][0]
        mb_sig_id = seeded["signals_by_protocol"]["modbus_tcp"][0]

        deadline = asyncio.get_running_loop().time() + 10.0
        while asyncio.get_running_loop().time() < deadline:
            if mb_job_id in runtime.job_tasks and any(o.signal_id == http_sig_id and o.quality.value == "GOOD" for o in received):
                break
            await asyncio.sleep(0.1)
        assert mb_job_id in runtime.job_tasks
        initial_mb_task = runtime.job_tasks[mb_job_id]

        # 1. Rotate HTTP bearer token in secret_store + bump connections.version + PG NOTIFY
        new_token = "rotated-secret-token-999"
        suite.http.expected_api_key = new_token
        rev_before = runtime.revision
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "UPDATE secret_store SET ciphertext = $1, rotated_at = $2 WHERE id = $3",
                    encrypt_secret(data_key, new_token),
                    datetime.now(timezone.utc),
                    seeded["http_secret_id"],
                )
                await conn.execute(
                    "UPDATE connections SET version = version + 1, updated_at = $1 WHERE id = $2",
                    datetime.now(timezone.utc),
                    seeded["connections"]["http"]["connection_id"],
                )
                await conn.execute("SELECT pg_notify('factorix_config_changed', $1)", json.dumps({"tenant_id": str(seeded["tenant_id"])}))

        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline and runtime.revision <= rev_before:
            await asyncio.sleep(0.05)
        assert runtime.revision > rev_before, "Config reload was not woken quickly by LISTEN/NOTIFY"
        assert runtime.job_tasks.get(mb_job_id) is initial_mb_task, "Unaffected Modbus task was needlessly restarted"

        idx_after_rot = len(received)
        http_ok = False
        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline:
            if any(o.signal_id == http_sig_id and o.quality.value == "GOOD" for o in received[idx_after_rot:]):
                http_ok = True
                break
            await asyncio.sleep(0.1)
        assert http_ok, "HTTP connector did not authenticate with rotated secret from secret_store"

        # 2. Pause Modbus via DB + PG NOTIFY -> stops Modbus polling cleanly without affecting other protocols
        mb_cid = seeded["connections"]["modbus_tcp"]["connection_id"]
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("UPDATE connections SET status = 'PAUSED', version = version + 1 WHERE id = $1", mb_cid)
                await conn.execute("SELECT pg_notify('factorix_config_changed', $1)", json.dumps({"tenant_id": str(seeded["tenant_id"])}))

        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline and mb_job_id in runtime.job_tasks:
            await asyncio.sleep(0.05)
        assert mb_job_id not in runtime.job_tasks

        # Drain any Modbus observations already submitted to the publisher or in-flight in AMQP before pause completed
        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline and runtime.publisher.has_pending():
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.35)

        pause_mark = len(received)
        await asyncio.sleep(0.6)
        assert not any(o.signal_id == mb_sig_id for o in received[pause_mark:]), "Paused Modbus connection still emitted observations"

        # 3. Resume Modbus -> resumes without restart
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("UPDATE connections SET status = 'ACTIVE', version = version + 1 WHERE id = $1", mb_cid)
                await conn.execute("SELECT pg_notify('factorix_config_changed', $1)", json.dumps({"tenant_id": str(seeded["tenant_id"])}))

        deadline = asyncio.get_running_loop().time() + 5.0
        resumed = False
        while asyncio.get_running_loop().time() < deadline:
            if any(o.signal_id == mb_sig_id and o.quality.value == "GOOD" for o in received[pause_mark:]):
                resumed = True
                break
            await asyncio.sleep(0.1)
        assert resumed
    finally:
        if rt_task is not None:
            await stop_runtime(rt_task)
        await consumer.stop(drain_timeout_s=5.0)
        await broker.close()
        await cleanup_broker_topology(broker_cfg)


@pytest.mark.asyncio
async def test_direct_pg_commissioning_full_and_capture(pg_pool, sim_suite, tmp_path: Path) -> None:
    pool, asyncpg_dsn = pg_pool
    suite, endpoints = sim_suite
    suite.http.expected_api_key = "sim-bearer-secret-01"
    opcua_ns = await suite.opcua.server.get_namespace_index("urn:factorix:sim:opcua")
    _, amqp_url, mgmt_url, data_key = assert_isolated_test_env()

    seeded = await seed_5_protocols(pool, endpoints, data_key=data_key, opcua_ns=opcua_ns)
    broker_cfg = isolated_broker_cfg(amqp_url, mgmt_url)
    broker = RabbitMQPublisher(broker_cfg)
    runtime, _lkg, _spool, _pub = make_runtime(pool, asyncpg_dsn, broker, tmp_path, data_key=data_key, commands_s=30.0)
    rt_task: asyncio.Task[None] | None = None
    try:
        await broker.start()
        rt_task = await start_runtime(runtime)
        await asyncio.sleep(0.5)

        full_job_id = uuid4()
        cap_job_id = uuid4()
        browse_job_id = uuid4()
        now = datetime.now(timezone.utc)
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO commissioning_jobs (id, tenant_id, connection_id, requested_by, stages_json, status, diagnostic, samples_json, started_at)
                    VALUES ($1, $2, $3, $4, '[]'::jsonb, 'PENDING', '', $5::jsonb, $6)
                    """,
                    full_job_id,
                    seeded["tenant_id"],
                    seeded["connections"]["modbus_tcp"]["connection_id"],
                    seeded["admin_id"],
                    json.dumps(
                        {
                            "meta": {
                                "command_type": "COMMISSION",
                                "mode": "FULL",
                                "fields": [
                                    {"key": "temp", "address": {"register_area": "holding", "offset": 110, "native_type": "float32", "word_order": "big"}},
                                    {"key": "status", "address": {"register_area": "holding", "offset": 100, "native_type": "uint16"}},
                                ],
                            }
                        }
                    ),
                    now,
                )
                await conn.execute(
                    """
                    INSERT INTO commissioning_jobs (id, tenant_id, connection_id, requested_by, stages_json, status, diagnostic, samples_json, started_at)
                    VALUES ($1, $2, $3, $4, '[]'::jsonb, 'PENDING', '', $5::jsonb, $6)
                    """,
                    cap_job_id,
                    seeded["tenant_id"],
                    seeded["connections"]["mqtt"]["connection_id"],
                    seeded["admin_id"],
                    json.dumps({"meta": {"command_type": "CAPTURE", "topic_filter": "factory/sim/#", "seconds": 2, "max_messages": 5}}),
                    now,
                )
                await conn.execute(
                    """
                    INSERT INTO commissioning_jobs (id, tenant_id, connection_id, requested_by, stages_json, status, diagnostic, samples_json, started_at)
                    VALUES ($1, $2, $3, $4, '[]'::jsonb, 'PENDING', '', $5::jsonb, $6)
                    """,
                    browse_job_id,
                    seeded["tenant_id"],
                    seeded["connections"]["opcua"]["connection_id"],
                    seeded["admin_id"],
                    json.dumps({"meta": {"command_type": "CAPTURE", "browse_node": "i=85"}}),
                    now,
                )
                await conn.execute("SELECT pg_notify('factorix_commissioning', $1)", json.dumps({"job_id": str(full_job_id)}))

        deadline = asyncio.get_running_loop().time() + 12.0
        rows_by_id: dict[str, dict] = {}
        while asyncio.get_running_loop().time() < deadline:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT id, status, stages_json, samples_json, diagnostic FROM commissioning_jobs WHERE id = ANY($1::uuid[])",
                    [full_job_id, cap_job_id, browse_job_id],
                )
            rows_by_id = {str(r["id"]): dict(r) for r in rows}
            if len(rows_by_id) == 3 and all(r["status"] in {"PASSED", "FAILED"} for r in rows_by_id.values()):
                break
            await asyncio.sleep(0.1)

        assert rows_by_id[str(full_job_id)]["status"] == "PASSED", rows_by_id[str(full_job_id)]
        full_samples = json.loads(rows_by_id[str(full_job_id)]["samples_json"])
        assert isinstance(full_samples["temp"], float)
        assert isinstance(full_samples["status"], int)

        assert rows_by_id[str(cap_job_id)]["status"] == "PASSED", rows_by_id[str(cap_job_id)]
        cap_samples = json.loads(rows_by_id[str(cap_job_id)]["samples_json"])
        assert any(item["topic"] == "factory/sim/M1/condition" for item in cap_samples["samples"])

        assert rows_by_id[str(browse_job_id)]["status"] == "PASSED", rows_by_id[str(browse_job_id)]
        browse_res = json.loads(rows_by_id[str(browse_job_id)]["samples_json"])
        assert len(browse_res["browse"]) >= 1
    finally:
        if rt_task is not None:
            await stop_runtime(rt_task)
        await broker.close()
        await cleanup_broker_topology(broker_cfg)


@pytest.mark.asyncio
async def test_f26_dual_worker_advisory_lock_prevents_double_poll_and_fails_over(
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
    broker_a = RabbitMQPublisher(broker_cfg)
    broker_b = RabbitMQPublisher(broker_cfg)
    lock_key = 910_000_777
    rt_a, _, _, _ = make_runtime(
        pool, asyncpg_dsn, broker_a, tmp_path / "a", data_key=data_key, instance_id="acq-a", lock_key=lock_key, leader_probe_s=0.15
    )
    rt_b, _, _, _ = make_runtime(
        pool, asyncpg_dsn, broker_b, tmp_path / "b", data_key=data_key, instance_id="acq-b", lock_key=lock_key, leader_probe_s=0.15
    )
    task_a: asyncio.Task[None] | None = None
    task_b: asyncio.Task[None] | None = None
    try:
        await broker_a.start()
        await broker_b.start()
        await consumer.start()
        task_a = await start_runtime(rt_a)
        task_b = await start_runtime(rt_b)

        deadline = asyncio.get_running_loop().time() + 8.0
        while asyncio.get_running_loop().time() < deadline:
            if (rt_a._is_leader != rt_b._is_leader) and len(received) >= 5:
                leader_candidate = rt_a if rt_a._is_leader else rt_b
                if len(leader_candidate.job_tasks) == 5:
                    break
            await asyncio.sleep(0.1)
        assert rt_a._is_leader != rt_b._is_leader, f"Expected exactly 1 leader (a={rt_a._is_leader}, b={rt_b._is_leader})"
        leader, leader_task, standby = (rt_a, task_a, rt_b) if rt_a._is_leader else (rt_b, task_b, rt_a)
        assert len(leader.job_tasks) == 5
        assert standby.job_tasks == {}
        assert standby.connectors == {}
        assert len(received) >= 5

        # Wait a short window to verify standby truly does not open connectors or duplicate leader jobs
        await asyncio.sleep(0.5)
        assert standby.job_tasks == {}
        assert standby.connectors == {}

        # Kill leader cleanly -> standby MUST acquire advisory lock & take over all 5 jobs
        await stop_runtime(leader_task)
        count_before_failover = len(received)
        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline and not standby._is_leader:
            await asyncio.sleep(0.05)
        assert standby._is_leader is True

        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline:
            if len(standby.job_tasks) == 5 and len(received) > count_before_failover + 4:
                break
            await asyncio.sleep(0.1)
        assert len(standby.job_tasks) == 5
        assert len(received) > count_before_failover + 4
        # Sanity check no duplicate event_uid emitted across failover
        uids = [o.event_uid for o in received]
        assert len(uids) == len(set(uids))
        _ = seeded
    finally:
        if task_a is not None:
            await stop_runtime(task_a)
        if task_b is not None:
            await stop_runtime(task_b)
        await consumer.stop(drain_timeout_s=5.0)
        await broker_a.close()
        await broker_b.close()
        await cleanup_broker_topology(broker_cfg)
