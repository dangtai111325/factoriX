"""End-to-end 5-protocol integration test for standalone AcquisitionRuntime -> RabbitMQ Quorum Queue."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from aio_pika.abc import AbstractIncomingMessage

from factorix.domain.canonical import CanonicalObservation
from factorix.platform.broker import ConsumeOutcome, RabbitMQConsumer, RabbitMQPublisher
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
async def test_acquisition_runtime_collects_all_5_protocols_to_rabbitmq(pg_pool, sim_suite, tmp_path: Path) -> None:
    pool, asyncpg_dsn = pg_pool
    suite, endpoints = sim_suite
    suite.http.expected_api_key = "sim-bearer-secret-01"
    opcua_ns = await suite.opcua.server.get_namespace_index("urn:factorix:sim:opcua")

    seeded = await seed_5_protocols(pool, endpoints, data_key=assert_isolated_test_env()[3], opcua_ns=opcua_ns)
    _, amqp_url, mgmt_url, data_key = assert_isolated_test_env()
    broker_cfg = isolated_broker_cfg(amqp_url, mgmt_url)

    received: list[CanonicalObservation] = []
    good_signals_seen: set[str] = set()
    expected_signal_ids = {str(s) for slist in seeded["signals_by_protocol"].values() for s in slist}
    all_seen = asyncio.Event()

    async def handle(msg: AbstractIncomingMessage) -> ConsumeOutcome:
        obs = CanonicalObservation.from_json_bytes(msg.body)
        received.append(obs)
        if obs.quality.value == "GOOD" and obs.value is not None:
            good_signals_seen.add(str(obs.signal_id))
        if expected_signal_ids <= good_signals_seen:
            all_seen.set()
        return ConsumeOutcome.ACK

    consumer = RabbitMQConsumer(broker_cfg, handle)
    broker = RabbitMQPublisher(broker_cfg)
    runtime, lkg_store, _spool, _pub = make_runtime(pool, asyncpg_dsn, broker, tmp_path, data_key=data_key)
    rt_task: asyncio.Task[None] | None = None
    try:
        await broker.start()
        await consumer.start()
        rt_task = await start_runtime(runtime)
        await asyncio.wait_for(all_seen.wait(), timeout=20.0)

        # 1. Verify authentic values and strict typing across all 5 protocols
        by_key: dict[str, list[CanonicalObservation]] = {}
        for obs in received:
            key = seeded["signal_meta"][obs.signal_id]["key"]
            by_key.setdefault(key, []).append(obs)

        assert set(by_key) == {
            "mb_temp",
            "mb_status",
            "opc_temp",
            "opc_state",
            "mq_temp",
            "mq_run",
            "http_power",
            "http_status",
            "ws_rpm",
            "ws_run",
        }
        assert all(obs.schema_version == 1 for obs in received)
        assert all(isinstance(obs.value, float) for obs in by_key["mb_temp"] if obs.quality.value == "GOOD")
        assert all(type(obs.value) is int for obs in by_key["mb_status"] if obs.quality.value == "GOOD")
        assert all(isinstance(obs.value, str) for obs in by_key["opc_state"] if obs.quality.value == "GOOD")
        assert all(isinstance(obs.value, bool) for obs in by_key["mq_run"] if obs.quality.value == "GOOD")
        assert all(isinstance(obs.value, bool) for obs in by_key["ws_run"] if obs.quality.value == "GOOD")

        # Monotonic source_sequence per signal & zero secret leakage in provenance or LKG disk cache
        for key, items in by_key.items():
            seqs = [item.source_sequence for item in items if item.source_sequence is not None]
            assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), f"Non-monotonic sequence for {key}: {seqs}"
        raw_json = json.dumps([o.to_dict() for o in received])
        assert "sim-bearer-secret-01" not in raw_json
        assert lkg_store.path is not None and lkg_store.path.is_file()
        assert "sim-bearer-secret-01" not in lkg_store.path.read_text(encoding="utf-8")

        # 2. Verify PG direct health updates & NO /edge-sync dependency (poll up to 3.0s for heartbeat flush)
        deadline = asyncio.get_running_loop().time() + 3.0
        conn_rows: list[Any] = []
        edge_row: Any = None
        while asyncio.get_running_loop().time() < deadline:
            async with pool.acquire() as conn:
                conn_rows = await conn.fetch(
                    "SELECT protocol, health, last_success_at, last_error FROM connections WHERE tenant_id = $1",
                    seeded["tenant_id"],
                )
                edge_row = await conn.fetchrow(
                    "SELECT health, last_heartbeat, software_version FROM edge_nodes WHERE id = $1",
                    seeded["edge_id"],
                )
            if (
                len(conn_rows) == 5
                and all(r["health"] == "HEALTHY" and r["last_success_at"] is not None and r["last_error"] is None for r in conn_rows)
                and edge_row is not None
                and edge_row["last_heartbeat"] is not None
            ):
                break
            await asyncio.sleep(0.15)

        assert len(conn_rows) == 5
        diag = {
            "conn_rows": [dict(row) for row in conn_rows],
            "edge_row": dict(edge_row) if edge_row else None,
            "conn_states": runtime.conn_states,
            "config_ok": runtime.config_ok,
            "activation_error": runtime.activation_error,
        }
        for r in conn_rows:
            assert r["health"] == "HEALTHY", f"Protocol {r['protocol']} not HEALTHY: {dict(r)} | diag={diag}"
            assert r["last_success_at"] is not None, f"Protocol {r['protocol']} missing last_success_at | diag={diag}"
            assert r["last_error"] is None, f"Protocol {r['protocol']} unexpected error | diag={diag}"
        assert edge_row is not None
        assert edge_row["health"] == "CONFIG_VALIDATED"
        assert edge_row["last_heartbeat"] is not None

        # 3. Inject OPC UA Bad StatusCode fault -> BAD arrives cleanly, recovers when cleared -> GOOD
        bad_seen = asyncio.Event()
        opc_temp_id = seeded["signals_by_protocol"]["opcua"][0]
        start_idx = len(received)
        suite.apply_fault("opcua", "status_mode", "Bad")
        deadline = asyncio.get_running_loop().time() + 8.0
        while asyncio.get_running_loop().time() < deadline:
            if any(o.signal_id == opc_temp_id and o.quality.value == "BAD" for o in received[start_idx:]):
                bad_seen.set()
                break
            await asyncio.sleep(0.1)
        assert bad_seen.is_set(), "OPC UA BAD StatusCode did not transition signal quality to BAD"

        rec_start = len(received)
        suite.apply_fault("opcua", "status_mode", "Good")
        recovered = False
        deadline = asyncio.get_running_loop().time() + 8.0
        while asyncio.get_running_loop().time() < deadline:
            if any(o.signal_id == opc_temp_id and o.quality.value == "GOOD" for o in received[rec_start:]):
                recovered = True
                break
            await asyncio.sleep(0.1)
        assert recovered, "OPC UA signal did not auto-recover to GOOD after fault cleared"
    finally:
        if rt_task is not None:
            await stop_runtime(rt_task)
        await consumer.stop(drain_timeout_s=5.0)
        await broker.close()
        await cleanup_broker_topology(broker_cfg)
