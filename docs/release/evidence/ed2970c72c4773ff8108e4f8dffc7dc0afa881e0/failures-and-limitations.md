# Verification Failures, Limitations & Operational Boundaries

**Branch:** `TDengine-RabbitMQ-Stoorage-Historian`  
**Commit SHA:** `ed2970c72c4773ff8108e4f8dffc7dc0afa881e0`  
**Date (UTC):** 2026-11-13  
**Integrity Rule:** No optimistic cover-up; all limitations and test boundaries must be explicitly declared.

---

## 1. Test Environment Boundaries vs Physical Plant Reality

| Domain | Automated Verification Boundary | Real Physical Hardware Gap | Mitigation & Operational Recommendation |
|---|---|---|---|
| **Industrial Protocols** | Tested against protocol emulator fixtures and virtual socket servers (Modbus TCP, simulated OPC UA nodes, local Mosquitto MQTT broker). | Not connected to physical Siemens S7-1500, Allen-Bradley ControlLogix, or hardware RS-485 serial buses. | Run on-site acceptance testing (SAT) with hardware signal generators before connecting to live factory machinery. |
| **TDengine Cluster** | Single-node Docker container running TDengine 3.4.3.9 with vgroups=1. | Multi-node dnode clustering, multi-node vgroup rebalancing, and raft consensus across physical network switches not tested. | Configure enterprise TDengine multi-node cluster with dedicated vnode allocations in production compose files. |
| **RabbitMQ Quorum** | Single-broker quorum queue mode (`x-queue-type: quorum`) in Docker test network. | Multi-broker cluster network partitioning (split-brain network partitions) not tested in CI. | Monitor Erlang VM distribution memory and set `cluster_partition_handling = pause_minority` in production rabbitmq.conf. |
| **Network Latency** | Localhost / bridge docker network (0.1ms ping). | Factory floor Wi-Fi / LTE industrial gateways (50ms–500ms jitter, packet loss). | Local spooling mechanism in Acquisition connector (`spool.sqlite`) buffers up to 500,000 points during link outages. |

---

## 2. In-Flight Failure Mode Triage

- **Engine Version Introspection (`test_api_physical_storage_flow`):**
  - **Status:** TRIAGED / FIX COORDINATED WITH BACKEND.
  - **Symptom:** `test_storage_physical_backend.py:353` expects `"tdengine": {"version": "3.4.3.9"}` while synthetic fake test client without active version parser returns `"unknown"`.
  - **Real World Impact:** None in production; live TDengine containers return `3.4.3.9` via `SELECT server_version()`. Fake test double alignment dispatched to `@backend-dev`.

---

## 3. Production Cutover Waivers & Preconditions

- **Owner Signoff Required:** Live `:8080` appliance switch and telemetry reset require formal signoff per Stage S16.
- **Backup Verification:** Full PostgreSQL `pg_dump` and TDengine backup must be completed before applying production migrations.
