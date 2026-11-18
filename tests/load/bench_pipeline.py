"""In-process throughput benchmark of the telemetry pipeline (Acquisition publisher -> AMQP -> Ingestion).

It pushes synthetic observations through the REAL code paths:

* ``ObservationPublisher.emit`` (canonicalisation) and ``flush_once`` with the real
  ``RabbitMQPublisher`` (envelope building, ``aio_pika.Message`` construction, sliding confirm
  window). Only the exchange is fake: it records each message and simulates a confirm latency.
* ``IngestionWorker`` lane batchers fed through ``handle_live_message`` exactly as the AMQP
  consumer would (one handler task per delivery, bounded by a prefetch window), with the real
  ``PgIngestionStore.commit_batch_metadata`` SQL/array/NOTIFY building on a fake asyncpg
  connection and the real ``TDEngineClient.write_operational_observations`` SQL building with
  ``execute_sql`` replaced by a counter that simulates statement latency.

Nothing connects to RabbitMQ, PostgreSQL or TDengine; never point this at the live appliance.
It reports obs/s (wall) and CPU ms per 1000 observations for each stage, plus the number of
AMQP messages, TDengine statements, PostgreSQL commits and NOTIFY payloads.

Usage (repo root; PYTHONPATH as in pytest.ini)::

    python tests/load/bench_pipeline.py --signals 336 --cycles 30
    python tests/load/bench_pipeline.py --signals 3360 --cycles 10 --mode single   # legacy wire format
    python tests/load/bench_pipeline.py --json result.json

The same script also runs against an older checkout (it only uses long-standing public entry
points), which is how the before/after numbers in the fix log were produced.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

ROOT = Path(__file__).resolve().parents[2]
for rel in ("apps/center/src", "apps/acquisition/src"):
    path = str(ROOT / rel)
    if os.environ.get("FX_BENCH_SRC_ROOT"):
        path = str(Path(os.environ["FX_BENCH_SRC_ROOT"]) / rel)
    if path not in sys.path:
        sys.path.insert(0, path)
os.environ.setdefault("FACTORIX_DATABASE_URL", "postgresql+asyncpg://bench:bench@localhost:1/bench")
os.environ.setdefault("FACTORIX_DATA_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
os.environ.setdefault("FACTORIX_ENVIRONMENT", "test")

import logging  # noqa: E402

logging.basicConfig(level=logging.ERROR)

from factorix.domain.quality import Origin  # noqa: E402,F401  (import order: domain first)
from factorix.modules.ingestion_worker import IngestionWorker, PgIngestionStore, TenantCatalog  # noqa: E402
from factorix.platform.broker import BrokerConfig, ConsumeOutcome, RabbitMQPublisher  # noqa: E402
from factorix.platform.tdengine import TDEngineClient, TDEngineConfig  # noqa: E402
from factorix_acquisition.jobs import build_specs  # noqa: E402
from factorix_acquisition.mapping import Sample  # noqa: E402
from factorix_acquisition.publisher import ObservationPublisher  # noqa: E402
from factorix_acquisition.spool import AcquisitionSpool  # noqa: E402

TENANT = uuid5(NAMESPACE_URL, "bench:tenant")


# --------------------------------------------------------------------------- synthetic config


def build_snapshot(signals: int, per_job: int = 150) -> dict[str, Any]:
    connections, jobs, fields, bindings = [], [], [], []
    n_jobs = max(1, (signals + per_job - 1) // per_job)
    sig = 0
    for j in range(n_jobs):
        conn_id = str(uuid5(NAMESPACE_URL, f"bench:conn:{j}"))
        job_id = str(uuid5(NAMESPACE_URL, f"bench:job:{j}"))
        connections.append(
            {
                "id": conn_id,
                "tenant_id": str(TENANT),
                "protocol": "modbus_tcp",
                "status": "ACTIVE",
                "endpoint_redacted": f"modbus://10.0.0.{j % 250}:502",
                "config_json": {"host": f"10.0.0.{j % 250}", "port": 502, "unit_id": 1},
            }
        )
        jobs.append({"id": job_id, "connection_id": conn_id, "mode": "POLL", "interval_ms": 1000, "enabled": True, "config_revision": 1})
        for k in range(min(per_job, signals - sig)):
            field_id = str(uuid5(NAMESPACE_URL, f"bench:field:{sig}"))
            fields.append(
                {"id": field_id, "acquisition_job_id": job_id, "ordinal": k, "address_json": {"register_area": "holding", "offset": k * 2, "unit_id": 1}}
            )
            bindings.append(
                {
                    "source_field_id": field_id,
                    "signal_id": str(uuid5(NAMESPACE_URL, f"bench:sig:{sig}")),
                    "resource_id": str(uuid5(NAMESPACE_URL, f"bench:res:{sig % 6}")),
                    "tenant_id": str(TENANT),
                    "key": f"sig_{sig}",
                    "data_type": "float64",
                    "unit": "C",
                }
            )
            sig += 1
    return {"revision": 1, "connections": connections, "jobs": jobs, "source_fields": fields, "signal_bindings": bindings}


def build_catalog(snapshot: dict[str, Any]) -> TenantCatalog:
    job_conn = {j["id"]: j["connection_id"] for j in snapshot["jobs"]}
    field_job = {f["id"]: f["acquisition_job_id"] for f in snapshot["source_fields"]}
    bindings: dict[UUID, list[dict[str, Any]]] = {}
    for b in snapshot["signal_bindings"]:
        sid = UUID(b["signal_id"])
        bindings[sid] = [
            {
                "signal_id": sid,
                "valid_from": datetime(2026, 1, 1, tzinfo=timezone.utc),
                "valid_to": None,
                "resource_id": UUID(b["resource_id"]),
                "expected_interval_ms": 1000,
                "site_id": None,
                "connection_id": UUID(job_conn[field_job[b["source_field_id"]]]),
                "source_field_id": UUID(b["source_field_id"]),
                "nullable": False,
            }
        ]
    return TenantCatalog(tenant_id=TENANT, bindings=bindings)


# --------------------------------------------------------------------------- fakes (I/O only)


class FakeExchange:
    """Records published AMQP messages and simulates the publisher-confirm round trip."""

    def __init__(self, confirm_latency_s: float) -> None:
        self.latency = confirm_latency_s
        self.messages: list[Any] = []
        self.bytes = 0

    async def publish(self, message: Any, routing_key: str, mandatory: bool = True, timeout: float | None = None) -> None:
        self.messages.append((message, routing_key))
        self.bytes += len(message.body)
        if self.latency:
            await asyncio.sleep(self.latency)


class FakeConn:
    def __init__(self, stats: dict[str, int]) -> None:
        self.stats = stats

    def transaction(self) -> "FakeConn":
        return self

    async def __aenter__(self) -> "FakeConn":
        return self

    async def __aexit__(self, *_: Any) -> None:
        self.stats["pg_commits"] += 1

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        if "INSERT INTO latest_signal_state" in sql:
            self.stats["pg_latest_rows"] += len(args[2])
            return [
                {"signal_id": sid, "last_acquired_at": acq, "last_value_changed_at": ev, "data_epoch": ep}
                for sid, acq, ev, ep in zip(args[2], args[11], args[9], args[15])
            ]
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        if "pg_notify" in sql:
            self.stats["notify_payloads"] += len(args[1])
            self.stats["notify_bytes"] += sum(len(p) for p in args[1])
        return "OK"

    async def fetchval(self, *_: Any) -> Any:
        return True


class _Acquire:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    async def __aenter__(self) -> FakeConn:
        return self.conn

    async def __aexit__(self, *_: Any) -> None:
        return None


class FakePool:
    def __init__(self, stats: dict[str, int]) -> None:
        self.conn = FakeConn(stats)

    def acquire(self) -> _Acquire:
        return _Acquire(self.conn)


class BenchPgStore(PgIngestionStore):
    def __init__(self, catalog: TenantCatalog, stats: dict[str, int]) -> None:
        super().__init__("postgresql://bench:bench@localhost:1/bench")
        self._pool = FakePool(stats)  # type: ignore[assignment]
        self.catalog = catalog
        self.has_ingested_at = True

    async def start(self) -> None:  # no network
        return None

    async def close(self) -> None:
        return None

    async def fetch_tenant_epoch(self, _tenant_id: UUID) -> tuple[int, str]:
        return 1, "ACTIVE"

    async def load_tenant_catalog(self, _tenant_id: UUID) -> TenantCatalog:
        self.catalog.loaded_at = time.monotonic()
        self.catalog.epoch_loaded_at = time.monotonic()
        return self.catalog

    async def write_quarantine(self, **_kw: Any) -> None:
        return None

    async def write_audit(self, **_kw: Any) -> None:
        return None

    async def write_heartbeat(self, **_kw: Any) -> None:
        return None


def bench_tdengine(stats: dict[str, int], statement_latency_s: float) -> TDEngineClient:
    client = TDEngineClient(TDEngineConfig(dsn="ws://bench:bench@localhost:1"))

    async def execute_sql(sql: str, **_kw: Any) -> int:
        stats["td_statements"] += 1
        stats["td_sql_bytes"] += len(sql)
        if statement_latency_s:
            await asyncio.sleep(statement_latency_s)
        return 0

    async def ensure_operational_schema(tenant_id: Any, **_kw: Any) -> str:
        return "fx_bench"

    client.execute_sql = execute_sql  # type: ignore[method-assign]
    client.ensure_operational_schema = ensure_operational_schema  # type: ignore[method-assign]
    return client


# --------------------------------------------------------------------------- stages


async def run(
    *,
    signals: int = 336,
    cycles: int = 30,
    mode: str = "batch",
    confirm_latency_ms: float = 2.0,
    td_latency_ms: float = 5.0,
    prefetch: int = 256,
    batch_obs: int = 2000,
) -> dict[str, Any]:
    snapshot = build_snapshot(signals)
    specs = list(build_specs(snapshot).values())
    stats = {k: 0 for k in ("pg_commits", "pg_latest_rows", "notify_payloads", "notify_bytes", "td_statements", "td_sql_bytes")}

    # ---- Stage A: acquisition canonicalise + publish (real publisher + real broker adapter)
    try:
        cfg = BrokerConfig(amqp_url="amqp://bench@localhost/", envelope_mode=mode)  # type: ignore[call-arg]
    except TypeError:  # older checkout without envelopes
        cfg = BrokerConfig(amqp_url="amqp://bench@localhost/")
    exchange = FakeExchange(confirm_latency_ms / 1000.0)
    broker = RabbitMQPublisher(cfg)
    broker._exchange = exchange  # type: ignore[assignment]
    broker._channel = SimpleNamespace(is_closed=False)  # type: ignore[assignment]
    tmp = tempfile.mkdtemp(prefix="fx-bench-")
    spool = AcquisitionSpool(Path(tmp) / "spool.sqlite")
    total = signals * cycles
    publisher = ObservationPublisher(broker, spool, max_memory_queue=max(100, total + 10))

    base = datetime.now(timezone.utc)
    cpu0, wall0 = time.process_time(), time.perf_counter()
    for c in range(cycles):
        received = (base + timedelta(milliseconds=c)).isoformat()
        for spec in specs:
            samples = [Sample(str(f["id"]), 20.0 + (c % 7) + i * 0.001, "GOOD", None, None, received) for i, f in enumerate(spec.fields)]
            await publisher.emit(spec, samples)
    cpu1, wall1 = time.process_time(), time.perf_counter()
    published = 0
    while publisher.fast_buffered or publisher.has_pending():
        sent, failed = await publisher.flush_once(budget_s=1.0)
        published += sent
        if failed and not sent:
            raise RuntimeError("bench publish failed")
    cpu2, wall2 = time.process_time(), time.perf_counter()
    spool.close()

    # ---- Stage B: ingestion (real worker lanes, real SQL/array building, fake I/O)
    catalog = build_catalog(snapshot)
    worker = IngestionWorker(
        pg_store=BenchPgStore(catalog, stats),
        tdengine=bench_tdengine(stats, td_latency_ms / 1000.0),
        broker_cfg=BrokerConfig(amqp_url="amqp://bench@localhost/", live_prefetch_count=prefetch, live_consumer_concurrency=prefetch, prefetch_count=prefetch, consumer_concurrency=prefetch),
        batch_size=batch_obs,
        flush_ms=20,
        enable_gap_sweep=False,
    )
    messages = [
        SimpleNamespace(
            body=msg.body,
            message_id=msg.message_id,
            headers=dict(msg.headers or {}),
            redelivered=False,
            content_type=msg.content_type,
            routing_key=rkey,
        )
        for msg, rkey in exchange.messages
    ]
    batcher = asyncio.create_task(worker._batcher_loop())
    window = asyncio.Semaphore(prefetch)
    outcomes: list[Any] = []

    async def deliver(message: Any) -> None:
        async with window:
            outcomes.append(await worker.handle_live_message(message))

    cpu3, wall3 = time.process_time(), time.perf_counter()
    await asyncio.gather(*(deliver(m) for m in messages))
    cpu4, wall4 = time.process_time(), time.perf_counter()
    worker._stop_event.set()
    worker._wake_batcher.set()
    await batcher
    acked = sum(1 for o in outcomes if o == ConsumeOutcome.ACK)
    if acked != len(messages):
        raise RuntimeError(f"bench ingestion did not ACK every message ({acked}/{len(messages)})")

    def per_k(cpu: float) -> float:
        return round(cpu * 1000.0 / max(1, total) * 1000.0, 3)

    return {
        "mode": mode if hasattr(cfg, "envelope_mode") else "legacy-head",
        "signals": signals,
        "cycles": cycles,
        "observations": total,
        "published": published,
        "amqp_messages": len(exchange.messages),
        "amqp_bytes": exchange.bytes,
        "obs_per_message": round(total / max(1, len(exchange.messages)), 1),
        "confirm_latency_ms": confirm_latency_ms,
        "td_statement_latency_ms": td_latency_ms,
        "canonicalize": {"obs_per_s": round(total / max(1e-9, wall1 - wall0)), "cpu_ms_per_1k_obs": per_k(cpu1 - cpu0)},
        "publish": {"obs_per_s": round(total / max(1e-9, wall2 - wall1)), "cpu_ms_per_1k_obs": per_k(cpu2 - cpu1)},
        "ingest": {"obs_per_s": round(total / max(1e-9, wall4 - wall3)), "cpu_ms_per_1k_obs": per_k(cpu4 - cpu3)},
        "acquisition_total_cpu_ms_per_1k_obs": per_k(cpu2 - cpu0),
        "ingest_messages_acked": acked,
        "ingest_batch_stage_ms": worker.hist.snapshot().get("batch_stage_timings_ms"),
        "publisher_stage_seconds": publisher.publish_metrics().get("stage_seconds"),
        **stats,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--signals", type=int, default=336)
    parser.add_argument("--cycles", type=int, default=30)
    parser.add_argument("--mode", choices=("batch", "single"), default="batch")
    parser.add_argument("--confirm-latency-ms", type=float, default=2.0)
    parser.add_argument("--td-latency-ms", type=float, default=5.0)
    parser.add_argument("--prefetch", type=int, default=256)
    parser.add_argument("--batch-obs", type=int, default=2000)
    parser.add_argument("--repeat", type=int, default=3, help="run N times, report the run with the least CPU")
    parser.add_argument("--json", type=str, default="")
    args = parser.parse_args()
    runs = []
    for _ in range(max(1, args.repeat)):
        runs.append(
            asyncio.run(
                run(
                    signals=args.signals,
                    cycles=args.cycles,
                    mode=args.mode,
                    confirm_latency_ms=args.confirm_latency_ms,
                    td_latency_ms=args.td_latency_ms,
                    prefetch=args.prefetch,
                    batch_obs=args.batch_obs,
                )
            )
        )

    def total_cpu(r: dict[str, Any]) -> float:
        return r["acquisition_total_cpu_ms_per_1k_obs"] + r["ingest"]["cpu_ms_per_1k_obs"]

    result = min(runs, key=total_cpu)
    result["repeat"] = len(runs)
    result["all_runs_cpu_ms_per_1k_obs"] = [
        {"acquisition": r["acquisition_total_cpu_ms_per_1k_obs"], "ingest": r["ingest"]["cpu_ms_per_1k_obs"]} for r in runs
    ]
    text = json.dumps(result, indent=2)
    print(text)
    if args.json:
        Path(args.json).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
