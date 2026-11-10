# Target State Architecture — Acquisition + RabbitMQ + TDengine + Historian & Storage

## 1. Logical & Runtime Architecture

```mermaid
flowchart TD
  OT["External / OT Sources<br/>Modbus TCP · OPC UA · MQTT · HTTP · WebSocket"]
  ACQ["FactoriX Acquisition Runtime (apps/acquisition)<br/>Protocol adapters · Decoders · Commissioning · SSRF guards<br/>Local versioned ConfigProvider + LKG snapshot"]
  RQ["RabbitMQ 4.0 Quorum Queues<br/>Exchange: factorix.telemetry.ingress<br/>Queue: telemetry.ingest.q (reject-publish, at-least-once DLX/DLQ)"]
  ING["Center Ingestion Worker<br/>Validate · Epoch Fence · UID Dedup · Recording Policy Engine"]
  TDE["TDengine 3.3.6.13 Data Plane (Port 6041 WS)<br/>Operational History Tier (full-fidelity 15m/value_at/exact avg)<br/>Managed Storage Datasets (ON_CHANGE / EVERY_ACQUISITION / INTERVAL)"]
  PG["PostgreSQL 17.11 Control Plane<br/>Identity · Factory Model · Connections · Signals · Data Models<br/>Storage Designs / Versions / PhysicalRegistry · telemetry_generations"]
  LIVE["LiveStateProvider + HistoryRepository + TelemetryResetService"]
  API["FastAPI REST + WebSocket /stream"]
  UI["React SPA: Overview · Factory Model · Data Collector · Data Models<br/>Historian & Storage (Designer · Catalog · Historian) · Safe Reset Modal"]

  OT -->|"Read-only OT"| ACQ
  PG -->|"Config snapshot + LISTEN/NOTIFY + LKG cache"| ACQ
  ACQ -->|"Persistent publish + confirm"| RQ
  RQ -->|"At-least-once delivery + Manual ACK AFTER durable TDengine commit"| ING
  PG -->|"Bindings, active_epoch, recording policies"| ING
  ING -->|"Subtable writes (tenant/series isolated)"| TDE
  ING -->|"Committed live/quality updates"| LIVE
  TDE -->|"Historical queries / ASOF / last_row"| LIVE
  PG -->|"Metadata & policies"| LIVE
  LIVE --> API --> UI
```

## 2. Clean Separation of Concerns

| Plane | Responsibility | Store / Broker |
|---|---|---|
| **Control Plane** | Auth/RBAC, Factory hierarchy, Connections (`secret_store` encrypted), 336+ Signals, 36+ Data Models (`spec_json`), Storage DSL ASTs/versions/registry, `telemetry_generations` epochs, operation/reset audit | **PostgreSQL 17.11** |
| **Acquisition Plane** | Local site worker owning 5 OT protocol clients/timers, block reading, commissioning probes, SSRF/DNS validation; zero Edge enrollment or loopback HTTP outbox | **Site Process (`factorix-acquisition`)** |
| **Reliable Transport** | Decoupled ingress buffering, durable publish confirms, bounded quorum queues (`reject-publish`), retry delivery limit -> DLQ quarantine | **RabbitMQ 4.0 Management Alpine** |
| **Time-Series Data Plane** | Canonical high-compression TSDB holding both automatic **Operational History** (guaranteeing 15m sparklines, sample-weighted aggregates, and `value_at` parity) and published user **Storage Designs** | **TDengine 3.3.6.13 (`taos-ws-py`)** |

## 3. Navigation & Safe Reset Contract

- **Sidebar `Historian & Storage` (Main Nav, right after `Data Models`):** strictly 3 child items:
  1. `Designer` (`/historian/designer`, `/historian/designer/:designId`)
  2. `Catalog` (`/historian/catalog`, `/historian/catalog/:designId`) — includes `Operations` & `Retention` drawers/tabs internally
  3. `Historian` (`/historian/historian`) — includes `Trend`, `Query Workspace`, `Saved Views`, `Exports & Jobs` tabs internally
- **Legacy URL Compatibility:** `/historian/explorer`, `/historian/policies`, `/historian/retention`, `/storage` redirect safely into the new workspace while preserving query params.
- **Safe `Revert To Zero` (`CLEAR_TELEMETRY_ONLY`):** Orchestrated multi-stage saga (`R0`–`R5` in `TelemetryResetService`) that fences writes via `telemetry_generations.active_epoch += 1`, purges tenant-scoped TDengine data, RabbitMQ old-epoch backlog, exports, and PG runtime state while keeping **100% of configuration entities, accounts, Factory Model, 5 Connections, 336 Signals, and 36 Data Models intact**, keeping the admin logged in without ever routing to `/register`.
