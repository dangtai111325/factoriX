# CPU Profiling and Optimization Runbook

**Branch:** TDengine-RabbitMQ-Stoorage-Historian  
**Source baseline:** 400dba192eb13be30806dbacb1568ffff23ae26b  
**Last updated:** 2026-11-12

---

## 1. Executive Summary & Observed Baselines

During baseline capture on the active Docker appliance stack (`docker stats --no-stream`), the following steady-state resource consumption was recorded across the 4 primary containers:

| Container Name | CPU % | Memory Usage / Limit | Active PIDs | Primary Workload |
|---|---|---|---|---|
| `factorix-appliance` | **390.83%** | 418.5 MiB / 7.75 GiB | 41 | Python FastAPI, Ingestion Worker, Model Engine, Acquisition Runtime |
| `factorix-rabbitmq` | **190.05%** | 385.1 MiB / 7.75 GiB | 71 | RabbitMQ 4.4 Quorum Queues, Erlang Beam VM |
| `factorix-postgres` | **53.46%** | 166.6 MiB / 7.75 GiB | 24 | PostgreSQL 17 Control Plane, latest_signal_state, NOTIFY |
| `factorix-tdengine` | **43.76%** | 760.7 MiB / 7.75 GiB | 227 | TDengine 3.4.3.9 TSDB, Vnode threads, WAL sync |

The data confirms that `factorix-appliance` and `factorix-rabbitmq` are the primary CPU consumers in steady state. This runbook details how to isolate hotspots, profile processes, apply verified optimizations, and compare before/after measurements without breaking data integrity or golden contracts.

---

## 2. Profiling Methodology

### 2.1 Container-Level Continuous Monitoring
To capture steady-state utilization during test runs:
```powershell
# Measure continuous CPU stats into a log
docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}"
```

### 2.2 Process-Level Breakdown Inside `factorix-appliance`
Inside the appliance container, multiple Python workloads run concurrently:
```bash
docker exec -it factorix-appliance ps aux --sort=-%cpu
```
Typical processes:
1. `factorix.ingestion`: RabbitMQ consumer, policy routing, TDengine batch assembly
2. `factorix_acquisition.runtime`: Protocol pollers, local SQLite spool, publisher
3. `uvicorn factorix.main:app`: FastAPI web and REST API server
4. `factorix.modules.models_engine`: Periodic model rule evaluation

### 2.3 Python Hotspot Profiling (cProfile / Py-Spy)
To record a 30-second flamegraph of the ingestion worker without stopping the container:
```bash
# Using py-spy (installed in container or via host)
py-spy record -o /tmp/ingestion_flamegraph.svg --pid <INGESTION_PID> --duration 30 --rate 100
```

---

## 3. High-Priority Optimization Targets (From Code Audit)

### Target 1: Formula Expression Compilation Caching (FX-S08)
- **File:** `apps/center/src/factorix/modules/ingestion_worker.py:~2235–2425`
- **Issue:** `parse_expression` and AST `bind` are called on every event in the trigger loop for active model formulas.
- **Optimization:** Introduce an LRU cache keyed by `(formula_id, formula_revision)`. Compile AST once, evaluate against observation context in memory.
- **Expected Impact:** 15–25% reduction in appliance Python CPU.

### Target 2: RabbitMQ Prefetch & Ingestion Concurrency Tuning (FX-S07)
- **File:** `settings.py:43,53`, `apps/center/src/factorix/ingestion/__main__.py`
- **Issue:** `ingestion_consumer_concurrency=128` with RabbitMQ `prefetch_count=128` creates excessive thread context switching and lock contention against TDengine executor pool (`workers=4`).
- **Optimization:** Align consumer prefetch to batch size (e.g., prefetch=32, concurrency=16–32). Match TDengine thread pool.
- **Expected Impact:** 30–40% reduction in `factorix-rabbitmq` Erlang scheduler CPU and appliance context switching.

### Target 3: PostgreSQL `latest_signal_state` Write Coalescing (FX-S09)
- **File:** `apps/center/src/factorix/modules/ingestion_worker.py:634–868`
- **Issue:** Every observation batch performs synchronous PostgreSQL `UPDATE` / `INSERT` on `latest_signal_state` and triggers `PG NOTIFY`.
- **Optimization:** Coalesce latest state updates in a 100ms in-memory buffer before flushing to PostgreSQL, or use batched `ON CONFLICT DO UPDATE`.
- **Expected Impact:** Reduces `factorix-postgres` CPU by 20–30% and lowers write amplification.

### Target 4: TDengine SQL Batch String Construction (FX-S10)
- **File:** `apps/center/src/factorix/platform/tdengine.py:503–635`
- **Issue:** Multi-row SQL strings are constructed via repeated string concatenations in Python loops, with expensive per-item error fallbacks.
- **Optimization:** Pre-format column templates and use optimized list joins. Differentiate syntax errors from network/timeout errors before invoking fallback.

### Target 5: Frontend Polling and Sparkline Concurrency (FX-S12, FX-S13)
- **Files:** `AppContext.tsx:43–50`, `SignalSparkline.tsx:1–73`
- **Issue:** Multiple mounted sparklines each fire independent `GET /history` queries, and metadata polls every 10–30s regardless of tab visibility.
- **Optimization:** Page visibility API gates polling (`document.visibilityState === 'visible'`). Viewport virtualization ensures only visible sparklines fetch history.

---

## 4. Verification and Safety Rules

1. **No Silent Data Loss:** Optimization must never drop RabbitMQ messages or bypass consumer ACK before durable write.
2. **Regression Parity:** All 5 existing navigations (Overview, Factory Model, Data Collector, Data Models, Coming Soon) must pass contract tests after each optimization.
3. **Operational History Invariant:** Never reduce CPU by disabling operational history or dropping `ON_CHANGE` fidelity unless explicitly commanded.
4. **Before/After Metrics:** Every optimization must be committed independently with documented before/after CPU, memory, and p99 latency recorded in `reports/cpu-before-after.csv`.
