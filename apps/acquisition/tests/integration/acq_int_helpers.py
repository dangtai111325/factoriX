"""Shared helpers for live PostgreSQL + RabbitMQ + 5-protocol OT Simulator acquisition integration tests."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import UUID, uuid4

import aio_pika
import asyncpg
import pytest

from factorix.platform.broker import BrokerConfig
from factorix.platform.security import encrypt_secret, hash_password
from factorix_acquisition.config_provider import (
    ConfigProvider,
    LkgSnapshotStore,
    PgLeaderLock,
    PgNotifyListener,
    PgSecretStore,
    to_asyncpg_dsn,
)
from factorix_acquisition.pg_control import PgControlPlane
from factorix_acquisition.publisher import ObservationPublisher
from factorix_acquisition.runtime import AcquisitionRuntime
from factorix_acquisition.spool import AcquisitionSpool
from tests.simulators.ot_simulators import SimulatorEndpoints


def assert_isolated_test_env() -> tuple[str, str, str, str]:
    env = os.environ.get("FACTORIX_ENVIRONMENT", "").strip().lower()
    destructive = os.environ.get("FACTORIX_ENABLE_DESTRUCTIVE_TESTS", "").strip()
    db_url = os.environ.get("FACTORIX_DATABASE_URL", "").strip()
    amqp_url = os.environ.get("FACTORIX_RABBITMQ_URL", "").strip()
    mgmt_url = os.environ.get("FACTORIX_RABBITMQ_MGMT_URL", "http://127.0.0.1:15672").strip()
    if env != "test":
        pytest.skip("Acquisition integration tests require FACTORIX_ENVIRONMENT=test.")
    if destructive != "YES_I_USE_EPHEMERAL_DB":
        pytest.skip("Acquisition integration tests require FACTORIX_ENABLE_DESTRUCTIVE_TESTS=YES_I_USE_EPHEMERAL_DB.")
    if "factorix_test" not in db_url:
        raise RuntimeError(f"Refusing to run destructive acquisition integration tests against non-test DB: {db_url}")
    parsed = urlparse(to_asyncpg_dsn(db_url))
    if (parsed.hostname or "") not in {"127.0.0.1", "localhost", "postgres-test"}:
        raise RuntimeError(f"Refusing destructive tests against non-local host: {parsed.hostname}")
    if not amqp_url:
        pytest.skip("FACTORIX_RABBITMQ_URL not configured.")
    return to_asyncpg_dsn(db_url), amqp_url, mgmt_url, os.environ["FACTORIX_DATA_KEY"]


def isolated_broker_cfg(amqp_url: str, mgmt_url: str) -> BrokerConfig:
    suffix = uuid4().hex[:10]
    return BrokerConfig(
        amqp_url=amqp_url,
        mgmt_url=mgmt_url,
        exchange_name=f"factorix.acq.test.ingress.{suffix}",
        queue_name=f"factorix.acq.test.ingest.q.{suffix}",
        dlx_name=f"factorix.acq.test.dlx.{suffix}",
        dlq_name=f"factorix.acq.test.dlq.{suffix}",
        delivery_limit=3,
        prefetch_count=32,
        max_inflight_publishes=32,
        confirm_timeout_s=5.0,
    )


async def cleanup_broker_topology(cfg: BrokerConfig) -> None:
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


async def reset_ephemeral_pg(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            TRUNCATE TABLE
                tenants,
                login_throttle,
                audit_events,
                observations,
                latest_signal_state,
                ingest_dedup,
                observation_quarantine
            CASCADE
            """
        )


async def seed_5_protocols(
    pool: asyncpg.Pool,
    endpoints: SimulatorEndpoints,
    *,
    data_key: str,
    http_token: str = "sim-bearer-secret-01",
    opcua_ns: int = 2,
) -> dict[str, Any]:
    """Seed tenant, site, admin, edge, resource, and all 5 protocol connections + jobs + signals."""
    now = datetime.now(timezone.utc)
    tenant_id = uuid4()
    site_id = uuid4()
    admin_id = uuid4()
    edge_id = uuid4()
    rtype_id = uuid4()
    resource_id = uuid4()
    http_secret_id = uuid4()

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO tenants (id, code, display_name, status, created_at) VALUES ($1, $2, $3, 'ACTIVE', $4)",
                tenant_id,
                f"sim-t-{tenant_id.hex[:6]}",
                "Sim Plant Tenant",
                now,
            )
            await conn.execute(
                "INSERT INTO sites (id, tenant_id, code, name, timezone, created_at) VALUES ($1, $2, 'SIM-S1', 'Sim Site 1', 'UTC', $3)",
                site_id,
                tenant_id,
                now,
            )
            await conn.execute("UPDATE admin_accounts SET disabled_at = $1 WHERE disabled_at IS NULL", now)
            await conn.execute(
                """
                INSERT INTO admin_accounts (id, tenant_id, login, email, password_hash, locale, timezone, created_at)
                VALUES ($1, $2, 'simadmin', 'sim@example.test', $3, 'en', 'UTC', $4)
                """,
                admin_id,
                tenant_id,
                hash_password("SimTest#2026"),
                now,
            )
            await conn.execute(
                """
                INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision)
                VALUES ($1, $2, 'machine', 'Machine', 'ASSET', '{}'::jsonb, TRUE, 1)
                """,
                rtype_id,
                tenant_id,
            )
            await conn.execute(
                """
                INSERT INTO resources (id, tenant_id, site_id, type_id, code, name, status, version, created_at, updated_at)
                VALUES ($1, $2, $3, $4, 'SIM-M1', 'Sim Machine 1', 'ACTIVE', 1, $5, $5)
                """,
                resource_id,
                tenant_id,
                site_id,
                rtype_id,
                now,
            )
            await conn.execute(
                """
                INSERT INTO edge_nodes (
                    id, tenant_id, site_id, name, enrollment_status, desired_revision, active_revision,
                    health, software_version, outbox_pending, created_at
                ) VALUES ($1, $2, $3, 'Local Collector', 'ENROLLED', 1, 1, 'CONFIG_VALIDATED', 'acq-v1', 0, $4)
                """,
                edge_id,
                tenant_id,
                site_id,
                now,
            )
            await conn.execute(
                "INSERT INTO secret_store (id, tenant_id, ciphertext, created_at) VALUES ($1, $2, $3, $4)",
                http_secret_id,
                tenant_id,
                encrypt_secret(data_key, http_token),
                now,
            )

            connections_meta: dict[str, dict[str, Any]] = {}
            signals_by_protocol: dict[str, list[UUID]] = {}
            signal_meta: dict[UUID, dict[str, Any]] = {}

            async def _add_source(
                proto: str,
                name: str,
                endpoint_redacted: str,
                cfg: dict[str, Any],
                *,
                mode: str,
                interval_ms: int | None,
                secret_ref: UUID | None,
                fields: list[dict[str, Any]],
            ) -> None:
                cid = uuid4()
                jid = uuid4()
                await conn.execute(
                    """
                    INSERT INTO connections (
                        id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted, secret_ref,
                        config_json, status, health, version, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'ACTIVE', 'UNKNOWN', 1, $10, $10)
                    """,
                    cid,
                    tenant_id,
                    site_id,
                    edge_id,
                    proto,
                    name,
                    endpoint_redacted,
                    secret_ref,
                    json.dumps(cfg),
                    now,
                )
                await conn.execute(
                    """
                    INSERT INTO acquisition_jobs (id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version)
                    VALUES ($1, $2, $3, $4, 3000, TRUE, 1, 1, 1)
                    """,
                    jid,
                    cid,
                    mode,
                    interval_ms,
                )
                proto_signals: list[UUID] = []
                for idx, f in enumerate(fields):
                    fid = uuid4()
                    sid = uuid4()
                    await conn.execute(
                        """
                        INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
                        VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
                        """,
                        fid,
                        jid,
                        f["kind"],
                        json.dumps(f["address"]),
                        f["native"],
                        json.dumps(f.get("decode") or {}),
                        idx,
                    )
                    await conn.execute(
                        """
                        INSERT INTO signal_definitions (
                            id, tenant_id, resource_id, key, display_name, data_type, unit, category,
                            expected_interval_ms, status, version, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'COLLECTED', $8, 'ACTIVE', 1, $9, $9)
                        """,
                        sid,
                        tenant_id,
                        resource_id,
                        f["signal_key"],
                        f["signal_key"],
                        f["data_type"],
                        f.get("unit"),
                        interval_ms or 1000,
                        now,
                    )
                    await conn.execute(
                        """
                        INSERT INTO signal_bindings (id, signal_id, source_field_id, transform_chain_json, enabled, revision, valid_from)
                        VALUES ($1, $2, $3, '[]'::jsonb, TRUE, 1, $4)
                        """,
                        uuid4(),
                        sid,
                        fid,
                        now,
                    )
                    proto_signals.append(sid)
                    signal_meta[sid] = {"protocol": proto, "key": f["signal_key"], "data_type": f["data_type"], "field_id": fid}
                connections_meta[proto] = {
                    "connection_id": cid,
                    "job_id": jid,
                    "secret_ref": secret_ref,
                    "config": cfg,
                    "field_ids": [signal_meta[s]["field_id"] for s in proto_signals],
                }
                signals_by_protocol[proto] = proto_signals

            await _add_source(
                "modbus_tcp",
                "Sim Modbus",
                f"modbus://{endpoints.modbus_host}:{endpoints.modbus_port}",
                {"host": endpoints.modbus_host, "port": endpoints.modbus_port, "unit_id": 1, "timeout_ms": 1500},
                mode="POLL",
                interval_ms=250,
                secret_ref=None,
                fields=[
                    {
                        "signal_key": "mb_temp",
                        "kind": "modbus_register",
                        "address": {"register_area": "holding", "offset": 110, "native_type": "float32", "word_order": "big"},
                        "native": "float32",
                        "data_type": "float64",
                        "unit": "°C",
                    },
                    {
                        "signal_key": "mb_status",
                        "kind": "modbus_register",
                        "address": {"register_area": "holding", "offset": 100, "native_type": "uint16"},
                        "native": "uint16",
                        "data_type": "int64",
                        "unit": None,
                    },
                ],
            )
            await _add_source(
                "opcua",
                "Sim OPC UA",
                endpoints.opcua_endpoint,
                {"endpoint": endpoints.opcua_endpoint, "anonymous": True, "timeout_ms": 2000},
                mode="POLL",
                interval_ms=250,
                secret_ref=None,
                fields=[
                    {
                        "signal_key": "opc_temp",
                        "kind": "opcua_node",
                        "address": {"node_id": f"ns={opcua_ns};s=MachineTemp1", "native_type": "double"},
                        "native": "double",
                        "data_type": "float64",
                        "unit": "°C",
                    },
                    {
                        "signal_key": "opc_state",
                        "kind": "opcua_node",
                        "address": {"node_id": f"ns={opcua_ns};s=MachineState", "native_type": "string"},
                        "native": "string",
                        "data_type": "string",
                        "unit": None,
                    },
                ],
            )
            await _add_source(
                "mqtt",
                "Sim MQTT",
                f"mqtt://{endpoints.mqtt_host}:{endpoints.mqtt_port}",
                {"host": endpoints.mqtt_host, "port": endpoints.mqtt_port, "topics": ["factory/sim/#"], "qos": 0, "anonymous": True},
                mode="SUBSCRIBE",
                interval_ms=200,
                secret_ref=None,
                fields=[
                    {
                        "signal_key": "mq_temp",
                        "kind": "mqtt_jsonpath",
                        "address": {"topic": "factory/sim/M1/condition", "jsonpath": "$.temperature", "native_type": "float64"},
                        "native": "float64",
                        "data_type": "float64",
                        "unit": "°C",
                    },
                    {
                        "signal_key": "mq_run",
                        "kind": "mqtt_jsonpath",
                        "address": {"topic": "factory/sim/M1/condition", "jsonpath": "$.running", "native_type": "bool"},
                        "native": "bool",
                        "data_type": "bool",
                        "unit": None,
                    },
                ],
            )
            await _add_source(
                "http",
                "Sim HTTP",
                endpoints.http_base_url,
                {"base_url": endpoints.http_base_url, "path": "/telemetry", "auth": "bearer", "timeout_ms": 2000},
                mode="POLL",
                interval_ms=1000,
                secret_ref=http_secret_id,
                fields=[
                    {
                        "signal_key": "http_power",
                        "kind": "http_jsonpath",
                        "address": {"path": "/telemetry", "jsonpath": "$.power_kw", "native_type": "float64"},
                        "native": "float64",
                        "data_type": "float64",
                        "unit": "kW",
                    },
                    {
                        "signal_key": "http_status",
                        "kind": "http_jsonpath",
                        "address": {"path": "/telemetry", "jsonpath": "$.status", "native_type": "string"},
                        "native": "string",
                        "data_type": "string",
                        "unit": None,
                    },
                ],
            )
            await _add_source(
                "websocket",
                "Sim WebSocket",
                endpoints.ws_url,
                {"url": endpoints.ws_url, "auth": "none", "timeout_ms": 3000},
                mode="SUBSCRIBE",
                interval_ms=200,
                secret_ref=None,
                fields=[
                    {
                        "signal_key": "ws_rpm",
                        "kind": "ws_jsonpath",
                        "address": {"jsonpath": '$.machines["SIM-01"].spindle_rpm', "native_type": "int64"},
                        "native": "int64",
                        "data_type": "int64",
                        "unit": "rpm",
                    },
                    {
                        "signal_key": "ws_run",
                        "kind": "ws_jsonpath",
                        "address": {"jsonpath": '$.machines["SIM-01"].running', "native_type": "bool"},
                        "native": "bool",
                        "data_type": "bool",
                        "unit": None,
                    },
                ],
            )

    return {
        "tenant_id": tenant_id,
        "site_id": site_id,
        "admin_id": admin_id,
        "edge_id": edge_id,
        "resource_id": resource_id,
        "http_secret_id": http_secret_id,
        "connections": connections_meta,
        "signals_by_protocol": signals_by_protocol,
        "signal_meta": signal_meta,
    }


def make_runtime(
    pool: asyncpg.Pool,
    asyncpg_dsn: str,
    broker: Any,
    tmp_path: Path,
    *,
    data_key: str,
    instance_id: str = "acq-test-1",
    lock_key: int | None = None,
    use_leader_lock: bool = True,
    use_notify: bool = True,
    heartbeat_s: float = 0.3,
    config_s: float = 5.0,
    commands_s: float = 2.0,
    leader_probe_s: float = 0.2,
) -> tuple[AcquisitionRuntime, LkgSnapshotStore, AcquisitionSpool, ObservationPublisher]:
    lkg_store = LkgSnapshotStore(tmp_path / f"{instance_id}-lkg.json")
    secrets = PgSecretStore(data_key, pool)
    cfg = ConfigProvider(pool, secrets, lkg_store)
    spool = AcquisitionSpool(tmp_path / f"{instance_id}-spool.sqlite")
    pub = ObservationPublisher(broker, spool)
    control = PgControlPlane(pool, instance_id=instance_id)
    lock = PgLeaderLock(asyncpg_dsn, lock_key=lock_key or 910_001_001) if use_leader_lock else None
    notify = PgNotifyListener(asyncpg_dsn) if use_notify else None
    runtime = AcquisitionRuntime(
        config_provider=cfg,
        control_plane=control,
        publisher=pub,
        allowlist=[],
        leader_lock=lock,
        notify_listener=notify,
        health_path=tmp_path / f"{instance_id}-health.json",
        heartbeat_s=heartbeat_s,
        config_s=config_s,
        commands_s=commands_s,
        leader_probe_s=leader_probe_s,
    )
    return runtime, lkg_store, spool, pub


async def start_runtime(runtime: AcquisitionRuntime) -> asyncio.Task[None]:
    return asyncio.create_task(runtime.run(), name="test-acq-runtime")


async def stop_runtime(task: asyncio.Task[None]) -> None:
    if not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
