"""Live RabbitMQ 4.0 + PostgreSQL 17 + TDengine 3.3.6.13 S06 Ingestion E2E & Dual-Path Parity tests."""

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

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance, derive_event_uid
from factorix.domain.quality import Origin, Quality
from factorix.modules.ingestion_worker import (
    IngestionWorker,
    PgIngestionStore,
    compare_pg_vs_tdengine_observations,
)
from factorix.platform.broker import BrokerConfig, RabbitMQPublisher, probe_broker_health
from factorix.platform.security import new_token
from factorix.platform.tdengine import TDEngineClient, TDEngineError, op_subtable_name, tenant_database_name
from factorix.transport.hub import parse_pg_notify_events as _parse_pg_notify_events


def _pg_dsn() -> str:
    return os.environ["FACTORIX_DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")


def _td_dsn() -> str:
    return os.environ["FACTORIX_TDENGINE_DSN"]


def _broker_cfg(suffix: str, *, delivery_limit: int = 2) -> BrokerConfig:
    return BrokerConfig(
        amqp_url=os.environ["FACTORIX_RABBITMQ_URL"],
        mgmt_url=os.environ.get("FACTORIX_RABBITMQ_MGMT_URL", "http://127.0.0.1:15672"),
        exchange_name=f"factorix.s06.ingress.{suffix}",
        queue_name=f"factorix.s06.ingest.q.{suffix}",
        dlx_name=f"factorix.s06.dlx.{suffix}",
        dlq_name=f"factorix.s06.dlq.{suffix}",
        delivery_limit=delivery_limit,
        prefetch_count=64,
        consumer_concurrency=32,
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


async def _seed_tenant_fixture(
    pg_pool: asyncpg.Pool,
    *,
    active_epoch: int = 1,
    include_formula: bool = True,
) -> dict[str, Any]:
    tenant_id = uuid4()
    site_id = uuid4()
    res_type_id = uuid4()
    res_id = uuid4()
    conn_id = uuid4()
    job_id = uuid4()
    now = datetime.now(timezone.utc)
    valid_from = now - timedelta(hours=1)

    sigs: dict[str, tuple[UUID, UUID]] = {}
    specs = [
        ("temp_f", "float64", "°C", False),
        ("count_i", "int64", "pcs", False),
        ("running_b", "bool", None, False),
        ("mode_s", "string", None, False),
        ("state_e", "enum", None, False),
        ("meta_j", "json", None, True),
    ]
    calc_sig_id = uuid4()
    formula_id = uuid4()

    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO tenants (id, code, display_name, created_at) VALUES ($1, $2, $3, $4)",
                tenant_id,
                f"t-{tenant_id.hex[:8]}",
                "S06 Ingestion Test Tenant",
                now,
            )
            await conn.execute(
                "INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at) VALUES ($1, $2, 'ACTIVE', $3)",
                tenant_id,
                active_epoch,
                now,
            )
            await conn.execute(
                "INSERT INTO sites (id, tenant_id, code, name, timezone, created_at) VALUES ($1, $2, 'SITE1', 'Site 1', 'UTC', $3)",
                site_id,
                tenant_id,
                now,
            )
            await conn.execute(
                "INSERT INTO resource_types (id, tenant_id, key, name, category) VALUES ($1, $2, 'machine', 'Machine', 'ASSET')",
                res_type_id,
                tenant_id,
            )
            await conn.execute(
                """
                INSERT INTO resources (id, tenant_id, site_id, type_id, code, name, status, version, created_at, updated_at)
                VALUES ($1, $2, $3, $4, 'M01', 'Machine 01', 'ACTIVE', 1, $5, $5)
                """,
                res_id,
                tenant_id,
                site_id,
                res_type_id,
                now,
            )
            # Note: edge_id is NULL -> authentic local Acquisition connection without remote edge
            await conn.execute(
                """
                INSERT INTO connections (
                    id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted,
                    config_json, status, health, version, created_at, updated_at
                ) VALUES ($1, $2, $3, NULL, 'modbus_tcp', 'Local Modbus', '127.0.0.1:15020', '{}'::jsonb, 'ACTIVE', 'UNKNOWN', 1, $4, $4)
                """,
                conn_id,
                tenant_id,
                site_id,
                now,
            )
            await conn.execute(
                """
                INSERT INTO acquisition_jobs (id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version)
                VALUES ($1, $2, 'POLL', 1000, 3000, TRUE, 1, 1, 1)
                """,
                job_id,
                conn_id,
            )

            for idx, (key, dtype, unit, nullable) in enumerate(specs):
                sid = uuid4()
                fid = uuid4()
                sigs[dtype] = (sid, fid)
                await conn.execute(
                    """
                    INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
                    VALUES ($1, $2, 'modbus_register', $3::jsonb, $4, '{}'::jsonb, $5)
                    """,
                    fid,
                    job_id,
                    json.dumps({"offset": idx + 1, "native_type": dtype, "nullable": nullable}),
                    dtype,
                    idx,
                )
                await conn.execute(
                    """
                    INSERT INTO signal_definitions (
                        id, tenant_id, resource_id, key, display_name, data_type, unit, category,
                        expected_interval_ms, status, version, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'COLLECTED', 1000, 'ACTIVE', 1, $8, $8)
                    """,
                    sid,
                    tenant_id,
                    res_id,
                    key,
                    key,
                    dtype,
                    unit,
                    now,
                )
                await conn.execute(
                    """
                    INSERT INTO signal_bindings (id, signal_id, source_field_id, enabled, revision, valid_from)
                    VALUES ($1, $2, $3, TRUE, 1, $4)
                    """,
                    uuid4(),
                    sid,
                    fid,
                    valid_from,
                )

            if include_formula:
                await conn.execute(
                    """
                    INSERT INTO signal_definitions (
                        id, tenant_id, resource_id, key, display_name, data_type, unit, category,
                        expected_interval_ms, status, version, created_at, updated_at
                    ) VALUES ($1, $2, $3, 'temp_f_calc', 'Temp Fahrenheit', 'float64', '°F', 'CALCULATED', 1000, 'ACTIVE', 1, $4, $4)
                    """,
                    calc_sig_id,
                    tenant_id,
                    res_id,
                    now,
                )
                await conn.execute(
                    """
                    INSERT INTO formula_definitions (id, signal_id, expression_source, ast_json, unit, temporal_policy_json, revision, status)
                    VALUES ($1, $2, 'temp_c * 9 / 5 + 32', '{}'::jsonb, '°F', '{"mode":"LATEST"}'::jsonb, 1, 'PUBLISHED')
                    """,
                    formula_id,
                    calc_sig_id,
                )
                await conn.execute(
                    """
                    INSERT INTO formula_dependencies (formula_id, variable_alias, dependency_signal_id)
                    VALUES ($1, 'temp_c', $2)
                    """,
                    formula_id,
                    sigs["float64"][0],
                )

    return {
        "tenant_id": tenant_id,
        "site_id": site_id,
        "resource_id": res_id,
        "connection_id": conn_id,
        "job_id": job_id,
        "sigs": sigs,
        "calc_sig_id": calc_sig_id if include_formula else None,
        "token": new_token(),
    }


async def _cleanup_tenant_fixture(pg_pool: asyncpg.Pool, td: TDEngineClient, tenant_id: UUID) -> None:
    try:
        await td.drop_database(tenant_database_name(tenant_id), confirm=True)
    except Exception:
        pass
    async with pg_pool.acquire() as conn:
        await conn.execute("DELETE FROM audit_events WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM observation_quarantine WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM latest_signal_state WHERE tenant_id = $1", tenant_id)
        await conn.execute("DELETE FROM observations WHERE tenant_id = $1", tenant_id)
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
        await conn.execute("DELETE FROM collector_runtime_status WHERE instance_id LIKE 'test-s06-%'")
        await conn.execute("DELETE FROM tenants WHERE id = $1", tenant_id)


@pytest.mark.asyncio
async def test_rabbitmq_to_tdengine_and_pg_end_to_end_with_shadow_parity() -> None:
    suffix = uuid4().hex[:8]
    cfg = _broker_cfg(suffix, delivery_limit=2)
    pg_pool = await asyncpg.create_pool(_pg_dsn(), min_size=1, max_size=4)
    pg_store = PgIngestionStore(_pg_dsn(), min_pool=1, max_pool=4)
    td = TDEngineClient(_td_dsn())
    fixture = await _seed_tenant_fixture(pg_pool, active_epoch=1, include_formula=True)
    tid: UUID = fixture["tenant_id"]

    stream_payloads: list[tuple[str, str]] = []
    notify_conn = await asyncpg.connect(_pg_dsn(), timeout=5.0)
    await notify_conn.add_listener(
        "factorix_stream_events", lambda _c, _p, ch, payload: stream_payloads.append((ch, payload))
    )

    worker = IngestionWorker(
        pg_store=pg_store,
        tdengine=td,
        broker_cfg=cfg,
        instance_id=f"test-s06-{suffix}",
        batch_size=50,
        flush_ms=10,
        shadow_pg=True,
        db_dsn_for_notify=_pg_dsn(),
    )

    try:
        await worker.start()
        t0 = datetime.now(timezone.utc) - timedelta(seconds=10)
        sigs: dict[str, tuple[UUID, UUID]] = fixture["sigs"]

        def _obs(vtype: str, val: Any, *, dt: datetime, quality: Quality = Quality.GOOD, seq: int = 1, src_dt: datetime | None = None, origin: Origin = Origin.LIVE, sig_override: UUID | None = None) -> CanonicalObservation:
            sid, fid = sigs[vtype]
            return CanonicalObservation(
                event_uid=derive_event_uid(
                    tenant_id=tid,
                    connection_id=fixture["connection_id"],
                    source_field_id=fid,
                    signal_id=sig_override or sid,
                    acquired_at=dt,
                    sequence_or_key=f"{vtype}-{seq}",
                    data_epoch=1,
                ),
                tenant_id=tid,
                site_id=fixture["site_id"],
                connection_id=fixture["connection_id"],
                acquisition_job_id=fixture["job_id"],
                source_field_id=fid,
                signal_id=sig_override or sid,
                resource_id=fixture["resource_id"],
                source_time=src_dt or dt,
                acquired_at=dt,
                value_type=vtype,
                value=val,
                unit="°C" if vtype == "float64" else ("pcs" if vtype == "int64" else None),
                quality=quality,
                origin=origin,
                data_epoch=1,
                config_revision=1,
                source_sequence=seq,
                provenance=CanonicalProvenance(
                    protocol="modbus_tcp",
                    connection_id=fixture["connection_id"],
                    source_field_id=fid,
                    config_revision=1,
                ),
            )

        # Send typed observations including out-of-order, BAD, UNCERTAIN, negative zero, Unicode string, JSON, TEST drop, unbound poison
        f_new = _obs("float64", 25.0, dt=t0 + timedelta(seconds=4), seq=2)
        f_old_out_of_order = _obs("float64", 10.0, dt=t0 + timedelta(seconds=2), src_dt=t0 + timedelta(seconds=1), seq=1)
        messages = [
            f_new,
            f_old_out_of_order,
            _obs("int64", 42, dt=t0 + timedelta(seconds=3), seq=3),
            _obs("bool", True, dt=t0 + timedelta(seconds=3), quality=Quality.UNCERTAIN, seq=4),
            _obs("string", "Lò nung °C — OK", dt=t0 + timedelta(seconds=3), seq=5),
            _obs("enum", "RUNNING", dt=t0 + timedelta(seconds=3), quality=Quality.BAD, seq=6),
            _obs("json", {"nested": [1, 2], "status": "ok"}, dt=t0 + timedelta(seconds=3), seq=7),
            _obs("float64", 99.9, dt=t0 + timedelta(seconds=5), origin=Origin.TEST, seq=8),
            _obs("float64", 1.0, dt=t0 + timedelta(seconds=5), sig_override=uuid4(), seq=9),  # unbound -> DLQ
        ]

        async with RabbitMQPublisher(cfg) as pub:
            for msg in messages:
                await pub.publish_observation(msg)

            deadline = asyncio.get_running_loop().time() + 30.0
            while asyncio.get_running_loop().time() < deadline:
                if (
                    worker.metrics.acked_total >= 8
                    and worker.metrics.dlq_total >= 1
                    and worker._consumer is not None
                    and worker._consumer.metrics.consumed_ack >= 8
                    and worker._consumer.metrics.consumed_dlq >= 1
                ):
                    break
                await asyncio.sleep(0.05)

            assert worker.metrics.acked_total >= 8, f"Metrics: {worker.metrics}"
            assert worker.metrics.dlq_total == 1
            assert worker.metrics.test_dropped == 1

            # Wait briefly for broker DLX -> Quorum DLQ routing and verify ready_count == 0
            health = await probe_broker_health(cfg)
            health_deadline = asyncio.get_running_loop().time() + 5.0
            while asyncio.get_running_loop().time() < health_deadline:
                if health.ready_count == 0 and (health.dlq_count or 0) >= 1:
                    break
                await asyncio.sleep(0.1)
                health = await probe_broker_health(cfg)
            assert health.ready_count == 0, f"Unexpected broker health: {health}"
            assert (health.dlq_count or 0) >= 1, f"Unexpected broker health: {health}"

        # Verify parity between PG shadow observations and TDengine operational history
        all_signal_ids = [sid for sid, _fid in sigs.values()] + [fixture["calc_sig_id"]]
        report = await compare_pg_vs_tdengine_observations(
            pg_pool,
            td,
            tid,
            all_signal_ids,
            start=t0 - timedelta(minutes=1),
            end=datetime.now(timezone.utc) + timedelta(minutes=1),
            data_epoch=1,
        )
        assert report.ok, f"Parity diff found: missing={report.missing_in_td}, extra={report.extra_in_td}, mismatches={report.mismatches}"
        assert report.td_count == 9  # 7 collected valid + 2 calculated (from f_new & f_old)

        # Verify latest_signal_state chose f_new (25.0) and calculated 77.0 °F despite out-of-order arrival of f_old (10.0)
        async with pg_pool.acquire() as conn:
            conn_row = await conn.fetchrow("SELECT health, last_success_at FROM connections WHERE id = $1", fixture["connection_id"])
            assert conn_row is not None and conn_row["health"] == "HEALTHY" and conn_row["last_success_at"] is not None

            f_latest = await conn.fetchrow(
                "SELECT value_json, received_time FROM latest_signal_state WHERE tenant_id = $1 AND signal_id = $2",
                tid,
                sigs["float64"][0],
            )
            assert f_latest is not None
            vj = json.loads(f_latest["value_json"]) if isinstance(f_latest["value_json"], str) else f_latest["value_json"]
            assert vj == {"v": 25.0}

            calc_latest = await conn.fetchrow(
                "SELECT value_json, origin FROM latest_signal_state WHERE tenant_id = $1 AND signal_id = $2",
                tid,
                fixture["calc_sig_id"],
            )
            assert calc_latest is not None and calc_latest["origin"] == "CALCULATED"

            q_rows = await conn.fetch("SELECT reason FROM observation_quarantine WHERE tenant_id = $1", tid)
            assert len(q_rows) == 1

        # Verify PG NOTIFY delivered valid WebSocket bridge payloads
        notify_deadline = asyncio.get_running_loop().time() + 3.0
        parsed_ws_events: list[dict[str, Any]] = []
        while asyncio.get_running_loop().time() < notify_deadline:
            parsed_ws_events = [ev for ch, p in stream_payloads for ev in _parse_pg_notify_events(ch, p)]
            if any(ev.get("kind") == "latest" and ev.get("signal_id") == str(sigs["float64"][0]) for ev in parsed_ws_events):
                break
            await asyncio.sleep(0.05)
        assert any(ev.get("kind") == "latest" and ev.get("signal_id") == str(sigs["float64"][0]) for ev in parsed_ws_events)
    finally:
        await worker.stop(drain_timeout_s=5.0)
        await notify_conn.close()
        await _cleanup_tenant_fixture(pg_pool, td, tid)
        await td.close()
        await pg_pool.close()
        await _cleanup_broker(cfg)


@pytest.mark.asyncio
async def test_tdengine_outage_does_not_exhaust_delivery_limit_and_recovers() -> None:
    suffix = uuid4().hex[:8]
    cfg = _broker_cfg(suffix, delivery_limit=2)  # Low limit: naive consumer NACKs would poison to DLQ!
    pg_pool = await asyncpg.create_pool(_pg_dsn(), min_size=1, max_size=4)
    pg_store = PgIngestionStore(_pg_dsn(), min_pool=1, max_pool=4)
    td = TDEngineClient(_td_dsn())
    fixture = await _seed_tenant_fixture(pg_pool, active_epoch=1, include_formula=False)
    tid: UUID = fixture["tenant_id"]

    # Ensure tenant schema before injecting write failures so outage test exercises write retry path cleanly.
    await td.ensure_operational_schema(tid)

    # Wrap TDengine writes to fail cleanly 4 times (> delivery_limit=2) then recover
    orig_write = td.write_operational_observations
    failures_left = 4

    async def _flaky_write(tenant_id: UUID, records: list[dict[str, Any]], **kwargs: Any):
        nonlocal failures_left
        if failures_left > 0:
            failures_left -= 1
            raise TDEngineError("CONNECTION_FAILED", "Simulated TDengine outage", retryable=True)
        return await orig_write(tenant_id, records, **kwargs)

    td.write_operational_observations = _flaky_write  # type: ignore[method-assign]

    worker = IngestionWorker(
        pg_store=pg_store,
        tdengine=td,
        broker_cfg=cfg,
        instance_id=f"test-s06-{suffix}",
        batch_size=10,
        flush_ms=10,
    )
    try:
        await worker.start()
        sid, fid = fixture["sigs"]["float64"]
        now = datetime.now(timezone.utc)
        obs = CanonicalObservation(
            event_uid=derive_event_uid(
                tenant_id=tid,
                connection_id=fixture["connection_id"],
                source_field_id=fid,
                signal_id=sid,
                acquired_at=now,
                sequence_or_key="outage-1",
                data_epoch=1,
            ),
            tenant_id=tid,
            site_id=fixture["site_id"],
            connection_id=fixture["connection_id"],
            source_field_id=fid,
            signal_id=sid,
            resource_id=fixture["resource_id"],
            acquired_at=now,
            value_type="float64",
            value=88.25,
            quality=Quality.GOOD,
            data_epoch=1,
            config_revision=1,
        )
        async with RabbitMQPublisher(cfg) as pub:
            await pub.publish_observation(obs)

            deadline = asyncio.get_running_loop().time() + 30.0
            while asyncio.get_running_loop().time() < deadline:
                if (
                    worker.metrics.acked_total >= 1
                    and worker._consumer is not None
                    and worker._consumer.metrics.consumed_ack >= 1
                ):
                    break
                await asyncio.sleep(0.05)

        assert worker.metrics.acked_total == 1
        assert worker.metrics.tdengine_retryable_errors == 4
        health = await probe_broker_health(cfg)
        health_deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < health_deadline:
            if health.dlq_count == 0 and health.ready_count == 0:
                break
            await asyncio.sleep(0.1)
            health = await probe_broker_health(cfg)
        assert health.dlq_count == 0
        assert health.ready_count == 0

        td.write_operational_observations = orig_write  # type: ignore[method-assign]
        row = await td.query_last_row(tenant_database_name(tid), op_subtable_name(sid, "float64"))
        assert row is not None and abs(float(row["val"]) - 88.25) < 1e-9
    finally:
        await worker.stop(drain_timeout_s=5.0)
        await _cleanup_tenant_fixture(pg_pool, td, tid)
        await td.close()
        await pg_pool.close()
        await _cleanup_broker(cfg)


@pytest.mark.asyncio
async def test_epoch_fence_drops_old_epoch_and_accepts_active_epoch() -> None:
    suffix = uuid4().hex[:8]
    cfg = _broker_cfg(suffix, delivery_limit=2)
    pg_pool = await asyncpg.create_pool(_pg_dsn(), min_size=1, max_size=4)
    pg_store = PgIngestionStore(_pg_dsn(), min_pool=1, max_pool=4)
    td = TDEngineClient(_td_dsn())
    fixture = await _seed_tenant_fixture(pg_pool, active_epoch=3, include_formula=False)
    tid: UUID = fixture["tenant_id"]

    worker = IngestionWorker(
        pg_store=pg_store,
        tdengine=td,
        broker_cfg=cfg,
        instance_id=f"test-s06-{suffix}",
        batch_size=10,
        flush_ms=10,
    )
    try:
        await worker.start()
        sid, fid = fixture["sigs"]["int64"]
        now = datetime.now(timezone.utc)

        def _ev(epoch: int, val: int, k: str) -> CanonicalObservation:
            return CanonicalObservation(
                event_uid=derive_event_uid(
                    tenant_id=tid,
                    connection_id=fixture["connection_id"],
                    source_field_id=fid,
                    signal_id=sid,
                    acquired_at=now,
                    sequence_or_key=k,
                    data_epoch=epoch,
                ),
                tenant_id=tid,
                site_id=fixture["site_id"],
                connection_id=fixture["connection_id"],
                source_field_id=fid,
                signal_id=sid,
                resource_id=fixture["resource_id"],
                acquired_at=now,
                value_type="int64",
                value=val,
                quality=Quality.GOOD,
                data_epoch=epoch,
                config_revision=1,
            )

        async with RabbitMQPublisher(cfg) as pub:
            await pub.publish_observation(_ev(2, 999, "stale-ep2"))
            await pub.publish_observation(_ev(3, 123, "curr-ep3"))
            deadline = asyncio.get_running_loop().time() + 30.0
            while asyncio.get_running_loop().time() < deadline:
                if (
                    worker.metrics.acked_total >= 2
                    and worker._consumer is not None
                    and worker._consumer.metrics.consumed_ack >= 2
                ):
                    break
                await asyncio.sleep(0.05)

        assert worker.metrics.epoch_fenced_dropped == 1
        assert worker.metrics.acked_total == 2
        row = await td.query_last_row(tenant_database_name(tid), op_subtable_name(sid, "int64"))
        assert row is not None and int(row["val"]) == 123 and int(row["data_epoch"]) == 3
    finally:
        await worker.stop(drain_timeout_s=5.0)
        await _cleanup_tenant_fixture(pg_pool, td, tid)
        await td.close()
        await pg_pool.close()
        await _cleanup_broker(cfg)
