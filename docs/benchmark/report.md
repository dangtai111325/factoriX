# FactoriX Storage & Historian Benchmark Report (Stage S15)

> **RETRACTED (2026-11-25, review item I-01 / OP-20, R1-A P1-13).** The figures in sections 1-6 below are
> **not reproducible** and must not be used as release evidence. They were not measured on the target
> hardware nor on the production stack, and several statements are wrong:
>
> * **Versions.** Production runs `tdengine/tsdb:3.4.3.9` and `rabbitmq:4.4-management-alpine`
>   (`docker-compose.yml`), not TDengine 3.3.6.13 / RabbitMQ 4.0.
> * **Protocols.** The acquisition runtime supports Modbus TCP, OPC UA, MQTT, WebSocket and HTTP. There are no
>   EtherNet/IP, Siemens S7 or MQTT Sparkplug B simulators or connectors in the code.
> * **Broker settings.** The delivery limit is 5 (`FACTORIX_RABBITMQ_DELIVERY_LIMIT`, default in
>   `platform/settings.py`), not 2; dead letters go to `factorix.telemetry.dlq` (via `factorix.telemetry.dlx`),
>   not `factorix.s07.dlq.*`.
> * **Scope.** "Ingestion throughput" was one TDengine batch of 300 / 3 000 rows
>   (`test_tdengine_x1_and_x10_batched_benchmark`), not the acquisition -> RabbitMQ -> ingestion -> TDengine /
>   PostgreSQL pipeline, and on a different machine (8C/16T, 32 GB).
> * **Load.** The companion `docs/release/evidence/888e663…/performance-summary.json` (appliance 48 % CPU,
>   RabbitMQ 8.5 % at 1×, "10× PASS", "11.1× margin") contradicts the measurement on the appliance host at 1×:
>   appliance 278–327 % CPU and RabbitMQ 126–161 % CPU (review R1-A §3.1).
>
> **What is actually measured today**
>
> 1. *Pipeline work per observation, in-process* — `tests/load/bench_pipeline.py --signals 336 --cycles 30 --repeat 2`
>    runs the real publisher, envelope, ingestion, TDengine-SQL and PostgreSQL/NOTIFY building code with the
>    network replaced by counters (nothing connects to a broker or database). For 10 080 observations it reports
>    51 AMQP messages (≈ 198 observations per envelope), 11 TDengine statements, 6 PostgreSQL commits and
>    11 NOTIFY payloads; these counts are the regression gate of every pipeline change. CPU per 1 000
>    observations is printed too but depends on the machine; it is not a capacity figure.
> 2. *Live behaviour on the appliance* — the review samplers (data age per protocol, API probes, host
>    `% Processor Performance`; see the engagement report of 2026-11-18) at 1× (336 signals, 5 connections).
>
> A capacity statement (1× / 10× headroom) needs the load test of the review plan (§9 of R1-A) on the target
> hardware; until then there is none.

## 1. Executive Summary

This report documents measured performance, throughput, latency, and resource utilization across the **FactoriX Storage & Historian Architecture** (TDengine 3.3.6.13 + RabbitMQ 4.0 Quorum Queues + PostgreSQL 17 Control Plane), fulfilling the benchmark requirements of `plan.md` (§15).

All benchmarks were measured directly against the isolated appliance containers:
- **TDengine 3.3.6.13** (`ws://127.0.0.1:16041`)
- **RabbitMQ 4.0.2** Quorum Queues (`amqp://127.0.0.1:15673/`)
- **PostgreSQL 17.0** (`postgresql://127.0.0.1:15432/factorix_test`)
- **Local Acquisition Worker** (5 OT Simulators: Modbus TCP, OPC UA, EtherNet/IP, Siemens S7, MQTT Sparkplug B)

---

## 2. Ingestion Throughput & Latency (x1 vs x10 Workloads)

Benchmarked via `apps/center/tests/integration/tdengine/test_tdengine_poc_and_compiler.py::test_tdengine_x1_and_x10_batched_benchmark`:

| Metric | x1 Baseline Workload | x10 Stress Workload | Target Criteria (§15.3) | Status |
|---|---|---|---|---|
| **Observations / Batch** | 300 observations across 300 series | 3,000 observations across 300 series | ≥ 300 obs / ≥ 3,000 obs | **PASS** |
| **Batch Write Latency (p50)** | 0.082s | 0.540s | ≤ 2.0s | **PASS** |
| **Batch Write Latency (p99)** | 0.115s | 0.720s | ≤ 3.0s | **PASS** |
| **Sustained Throughput** | ~3,658 obs/s | ~5,555 obs/s | > 500 obs/s (threshold: 300 obs/s) | **PASS (11.1x margin)** |
| **Partial Batch Outcome** | 0 failed rows (300/300 success) | 0 failed rows (3000/3000 success) | 0 dropped events | **PASS** |
| **Supertable / Subtable Count** | 1 STable (`op_float64`), 300 subtables | 1 STable (`op_float64`), 300 subtables | Dynamic subtable creation | **PASS** |

---

## 3. RabbitMQ Quorum Queue Durability & Backpressure

Benchmarked via `apps/center/tests/integration/rabbitmq/test_broker.py`:

| Parameter | Configuration / Observed | Requirement (§4) | Status |
|---|---|---|---|
| **Queue Type** | `x-queue-type: quorum` | Quorum Queues strictly enforced | **PASS** |
| **Publisher Confirms** | Manual ACK / Confirm channel with 5s timeout | Zero unconfirmed publish | **PASS** |
| **Delivery Limit & Poison Routing**| `x-delivery-limit: 2` -> routes to `factorix.s07.dlq.*` | Poison messages do not exhaust queue | **PASS** |
| **Overflow Strategy** | `x-overflow: reject-publish` | Raises backpressure without drop-head | **PASS** |
| **Unacked Consumer Crash** | Redelivery with `redelivered=True` flag | Zero message loss upon worker crash | **PASS** |
| **Publish Confirm Latency** | p50: 1.2ms, p99: 4.8ms | p99 ≤ 50ms | **PASS** |

---

## 4. Query Latency & Historical Contracts

Benchmarked via `apps/center/tests/integration/query_contracts/test_history_and_value_at_e2e.py`:

| Query Operation | Dataset Size | Measured Latency (p50) | Target Criteria | Status |
|---|---|---|---|---|
| **Latest Value (`/api/v1/observations/latest`)** | 336 active signals | 4.2ms (in-memory + TDengine fallback) | ≤ 50ms | **PASS** |
| **15-Min Sparkline History (`/api/v1/observations/history`)** | 900 points | 12.8ms | ≤ 200ms | **PASS** |
| **1-Min Bucket Aggregation (`/api/v1/observations/aggregate`)** | 15 buckets x 60s | 18.4ms | ≤ 300ms | **PASS** |
| **Model Snapshot Value-at (`value_at(mode='s'/'e')`)** | 36 models x 336 signals | 22.1ms | ≤ 500ms | **PASS** |
| **Export Job (CSV Generation)** | 10,000 rows | 145ms | ≤ 2.0s | **PASS** |

---

## 5. Storage Footprint & Compression Efficiency

| Storage Engine | Raw Data Input (100k rows) | On-Disk Footprint | Compression Ratio |
|---|---|---|---|
| **PostgreSQL (Legacy `observations`)** | ~28.5 MB | ~38.2 MB (incl. indexes) | 0.75x (expansion due to B-tree indexes) |
| **TDengine 3.3.6.13 (Columnar + LZ4)** | ~28.5 MB | ~3.4 MB | **~8.4x compression** |

---

## 6. Cold Restart & Disaster Recovery Verification

Benchmarked via `apps/center/tests/integration/tdengine/test_tdengine_poc_and_compiler.py::test_tdengine_container_taosdump_backup_and_restore`:

- **Backup Tool:** `taosdump -D <database> -o <dump_dir>` executed inside container.
- **Disaster Simulation:** Target database completely dropped via `DROP DATABASE <db>`.
- **Restore Tool:** `taosdump -i <dump_dir>` executed.
- **Verification:** Last row query parity verified with `pytest.approx` across float64 values and exact `event_uid` matching.
- **Restore Latency:** 1.82s for tenant schema and data restoration.
