"""Run the RabbitMQ -> TDengine + PostgreSQL IngestionWorker as ``python -m factorix.ingestion``."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from dataclasses import replace

from factorix.modules.ingestion_worker import DEFAULT_INSTANCE_ID, IngestionWorker, PgIngestionStore
from factorix.modules.live_state import TDengineLiveStateProvider, configure_live_state_provider
from factorix.platform.broker import BrokerConfig
from factorix.platform.settings import get_settings
from factorix.platform.tdengine import TDEngineClient, TDEngineConfig

logger = logging.getLogger("factorix.ingestion")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


async def run_forever() -> None:
    logging.basicConfig(
        level=os.environ.get("FACTORIX_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings = get_settings()
    if not settings.tdengine_dsn:
        raise RuntimeError("FACTORIX_TDENGINE_DSN must be configured to run factorix.ingestion.")
    if not settings.rabbitmq_url:
        raise RuntimeError("FACTORIX_RABBITMQ_URL must be configured to run factorix.ingestion.")

    broker_cfg = BrokerConfig.from_settings(settings)
    # Prefetch counts are AMQP *messages*; with v2 envelopes one message carries up to ~500
    # observations. Keep the replay lane's in-flight window small (replay must not flood the
    # shared event loop) and the live window moderate.
    broker_cfg = replace(
        broker_cfg,
        prefetch_count=max(1, min(broker_cfg.prefetch_count, _env_int("FACTORIX_INGESTION_REPLAY_PREFETCH", 16))),
        live_prefetch_count=max(1, min(broker_cfg.live_prefetch_count, _env_int("FACTORIX_INGESTION_LIVE_PREFETCH", 64))),
    )
    td_client = TDEngineClient(
        TDEngineConfig(
            dsn=settings.tdengine_dsn,
            db_prefix=settings.tdengine_db_prefix,
            default_keep_days=settings.tdengine_default_keep_days,
            default_cache_mb=settings.tdengine_default_cache_mb,
            default_vgroups=settings.tdengine_vgroups,
            max_workers=settings.tdengine_pool_size,
            query_timeout_s=settings.tdengine_query_timeout_s,
            ddl_timeout_s=settings.tdengine_ddl_timeout_s,
        )
    )
    # Two lane batchers each hold at most one commit at a time, plus catalog/heartbeat/quarantine.
    pg_store = PgIngestionStore(
        settings.database_url,
        min_pool=2,
        max_pool=max(4, min(32, _env_int("FACTORIX_INGESTION_PG_POOL", 8))),
    )
    live_provider = TDengineLiveStateProvider(td_client)
    configure_live_state_provider(live_provider)
    worker = IngestionWorker(
        pg_store=pg_store,
        tdengine=td_client,
        broker_cfg=broker_cfg,
        instance_id=os.environ.get("FACTORIX_INGESTION_INSTANCE_ID", DEFAULT_INSTANCE_ID),
        # Observations per lane batch. v2 envelopes carry up to ~500 observations each, so the
        # legacy message-count setting (default 256) would split one envelope into several commits.
        batch_size=max(settings.ingestion_batch_size, _env_int("FACTORIX_INGESTION_BATCH_OBS", 2000)),
        flush_ms=settings.ingestion_flush_ms,
        shadow_pg=settings.ingestion_shadow_pg,
        live_provider=live_provider,
        db_dsn_for_notify=settings.database_url,
        # Acquisition owns source health through its direct connection reports.
        update_connection_liveness=settings.collector_mode != "acquisition",
        replay_batch_size=max(1, _env_int("FACTORIX_INGESTION_REPLAY_BATCH_OBS", 500)),
    )

    stop_ev = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            try:
                loop.add_signal_handler(sig, stop_ev.set)
            except (NotImplementedError, RuntimeError):
                pass

    await worker.start()
    logger.info(
        "IngestionWorker %s started (queue=%s, concurrency=%d, batch_size=%d, flush_ms=%d, shadow_pg=%s)",
        worker.instance_id,
        broker_cfg.queue_name,
        broker_cfg.consumer_concurrency,
        worker.batch_size,
        int(worker.flush_interval_s * 1000),
        worker.shadow_pg,
    )
    try:
        await stop_ev.wait()
    finally:
        logger.info("Stopping IngestionWorker cleanly...")
        await worker.stop(drain_timeout_s=15.0)
        await td_client.close()
        logger.info("IngestionWorker shutdown complete.")


def main() -> int:
    try:
        asyncio.run(run_forever())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        logger.exception("IngestionWorker exited with fatal error")
        return 1


if __name__ == "__main__":
    sys.exit(main())
