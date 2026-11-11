"""Long-running standalone Acquisition entrypoint.

Connects directly to PostgreSQL (asyncpg pool + LISTEN/NOTIFY + advisory lock) and
RabbitMQ Quorum Queue (persistent publisher confirms), with a bounded SQLite WAL outage
spool and stripped LKG snapshot fallback.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path

import asyncpg

from factorix.platform.broker import BrokerConfig, RabbitMQPublisher
from factorix_acquisition.config_provider import (
    DEFAULT_LOCK_KEY,
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

logger = logging.getLogger("factorix_acquisition")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


async def build_and_run() -> None:
    dsn = os.environ.get("FACTORIX_DATABASE_URL", "").strip()
    if not dsn:
        raise SystemExit("Missing FACTORIX_DATABASE_URL.")
    data_key = os.environ.get("FACTORIX_DATA_KEY", "").strip()
    if not data_key:
        raise SystemExit("Missing FACTORIX_DATA_KEY.")
    amqp_url = os.environ.get("FACTORIX_RABBITMQ_URL", "").strip()
    if not amqp_url:
        raise SystemExit("Missing FACTORIX_RABBITMQ_URL.")

    allow = [item.strip() for item in os.environ.get("FACTORIX_OT_ALLOWLIST", "").split(",") if item.strip()]
    data_dir = Path(os.environ.get("FACTORIX_ACQUISITION_DIR", os.environ.get("FACTORIX_DATA_DIR", "acq-data")))
    spool_path = Path(os.environ.get("FACTORIX_SPOOL_PATH", str(data_dir / "spool.sqlite")))
    lkg_path = Path(os.environ.get("FACTORIX_LKG_CONFIG_PATH", str(data_dir / "lkg-config.json")))
    health_path = Path(os.environ.get("FACTORIX_ACQUISITION_HEALTH", os.environ.get("FACTORIX_EDGE_HEALTH", str(data_dir / "acquisition-health.json"))))
    instance_id = os.environ.get("FACTORIX_ACQUISITION_INSTANCE_ID", "local-acquisition-1")
    lock_key = _env_int("FACTORIX_ACQUISITION_LOCK_KEY", DEFAULT_LOCK_KEY)

    asyncpg_dsn = to_asyncpg_dsn(dsn)
    pool = await asyncpg.create_pool(asyncpg_dsn, min_size=2, max_size=8)

    broker_cfg = BrokerConfig(
        amqp_url=amqp_url,
        mgmt_url=os.environ.get("FACTORIX_RABBITMQ_MGMT_URL", "").strip(),
        exchange_name=os.environ.get("FACTORIX_RABBITMQ_EXCHANGE", "factorix.telemetry.ingress"),
        queue_name=os.environ.get("FACTORIX_RABBITMQ_QUEUE", "factorix.telemetry.ingest.q"),
        dlx_name=os.environ.get("FACTORIX_RABBITMQ_DLX", "factorix.telemetry.dlx"),
        dlq_name=os.environ.get("FACTORIX_RABBITMQ_DLQ", "factorix.telemetry.dlq"),
        confirm_timeout_s=float(os.environ.get("FACTORIX_RABBITMQ_CONFIRM_TIMEOUT_S", "10.0")),
        max_inflight_publishes=_env_int("FACTORIX_RABBITMQ_PUBLISHER_MAX_INFLIGHT", 64),
    )
    broker = RabbitMQPublisher(broker_cfg)
    try:
        await broker.start()
    except Exception as exc:  # noqa: BLE001 - runtime reconnects & spills to spool during startup outages
        logger.warning("Initial RabbitMQ connection unavailable (%r); will retry and buffer in spool", exc)

    spool = AcquisitionSpool(spool_path)
    publisher = ObservationPublisher(
        broker,
        spool,
        max_attempts=_env_int("FACTORIX_SPOOL_MAX_ATTEMPTS", 10),
        max_pending=_env_int("FACTORIX_SPOOL_MAX_PENDING", 1_000_000),
        max_spool_bytes=_env_int("FACTORIX_SPOOL_MAX_BYTES", 512 * 1024 * 1024),
    )
    secrets = PgSecretStore(data_key, pool)
    config_provider = ConfigProvider(pool, secrets, LkgSnapshotStore(lkg_path))
    control_plane = PgControlPlane(pool, instance_id=instance_id)
    leader_lock = PgLeaderLock(asyncpg_dsn, lock_key=lock_key)
    notify_listener = PgNotifyListener(asyncpg_dsn)

    runtime = AcquisitionRuntime(
        config_provider=config_provider,
        control_plane=control_plane,
        publisher=publisher,
        allowlist=allow,
        leader_lock=leader_lock,
        notify_listener=notify_listener,
        health_path=health_path,
    )

    loop = asyncio.get_running_loop()
    main_task = asyncio.current_task()
    for sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None)):
        if sig is not None:
            try:
                loop.add_signal_handler(sig, lambda: main_task.cancel() if main_task else None)
            except NotImplementedError:
                pass

    try:
        await runtime.run()
    finally:
        await broker.close()
        await pool.close()


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("FACTORIX_ACQUISITION_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("aio_pika").setLevel(logging.WARNING)
    try:
        asyncio.run(build_and_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
