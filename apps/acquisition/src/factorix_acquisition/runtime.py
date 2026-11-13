"""Local Acquisition runtime supervisor.

Coordinates PostgreSQL advisory leadership, LISTEN/NOTIFY + poll config synchronization,
one isolated asyncio task per OT acquisition job, direct RabbitMQ publishing with
bounded SQLite outage spooling, direct PG commissioning worker pool, and health reporting.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Coroutine, Protocol

import asyncpg

from factorix.domain.network import AllowedEndpoint, assert_allowed, parse_allowlist
from factorix_acquisition.aio import bounded
from factorix_acquisition.commissioning import Commissioner
from factorix_acquisition.config_provider import (
    ConfigProvider,
    ConfigUpdate,
    LkgSnapshotStore,
    PgLeaderLock,
    PgNotifyListener,
    PgSecretStore,
    checksum,
    endpoints_for,
)
from factorix_acquisition.connectors.errors import STATE_BY_CODE, ConnectorError
from factorix_acquisition.connectors.http_pull import HttpPullConnector
from factorix_acquisition.connectors.modbus import ModbusConnector
from factorix_acquisition.connectors.mqtt import MqttConnector
from factorix_acquisition.connectors.opcua import OpcUaConnector
from factorix_acquisition.connectors.ws import WebSocketConnector
from factorix_acquisition.jobs import JobRunner, JobSpec, build_specs, http_headers
from factorix_acquisition.mapping import Sample
from factorix_acquisition.pg_control import PgControlPlane
from factorix_acquisition.publisher import BATCH_ROWS, FLUSH_BUDGET_S, HISTORY_SLICE_S, ObservationPublisher
from factorix_acquisition.spool import AcquisitionSpool
from factorix_acquisition.timeutil import iso_ms, now_iso

logger = logging.getLogger(__name__)

SOFTWARE_VERSION = os.environ.get("FACTORIX_ACQUISITION_VERSION", "acq-v1")
LINGER_S = 0.05
PRUNE_CHUNK = 500
PRUNE_PAUSE_S = 0.05
PRUNE_INTERVAL_S = 15.0
MAX_PRUNE_STEPS_PER_PASS = 40
ACKED_RETENTION = timedelta(minutes=2)


class LeaderLockProtocol(Protocol):
    @property
    def is_leader(self) -> bool: ...

    async def probe(self) -> bool: ...

    async def release(self) -> None: ...


class AcquisitionRuntime:
    def __init__(
        self,
        *,
        config_provider: ConfigProvider,
        control_plane: PgControlPlane,
        publisher: ObservationPublisher,
        allowlist: list[str] | None = None,
        leader_lock: LeaderLockProtocol | None = None,
        notify_listener: PgNotifyListener | None = None,
        health_path: Path | None = None,
        heartbeat_s: float = 5.0,
        config_s: float = 10.0,
        commands_s: float = 2.0,
        leader_probe_s: float = 2.0,
    ) -> None:
        self.config_provider = config_provider
        self.control_plane = control_plane
        self.publisher = publisher
        self.env_allowlist: list[AllowedEndpoint] = parse_allowlist(allowlist or [])
        self.allowlist: list[AllowedEndpoint] = list(self.env_allowlist)
        self.leader_lock = leader_lock
        self.notify_listener = notify_listener
        self.health_path = health_path
        self.heartbeat_s = heartbeat_s
        self.config_s = config_s
        self.commands_s = commands_s
        self.leader_probe_s = leader_probe_s

        self.revision = 0
        self.snapshot_checksum = ""
        self.snapshot: dict[str, Any] | None = None
        self.specs: dict[str, JobSpec] = {}
        self.job_tasks: dict[str, asyncio.Task[None]] = {}
        self.connectors: dict[str, tuple[str, Any]] = {}
        self._connector_locks: dict[str, asyncio.Lock] = {}
        self.conn_states: dict[str, dict[str, Any]] = {}
        self._baked_secrets: dict[str, tuple[str, str]] = {}
        self._commands: set[asyncio.Task[None]] = set()
        self._flush_event = asyncio.Event()
        self._backoff_reset_event = asyncio.Event()
        self._unflushed = 0
        self._is_leader = leader_lock is None
        self._stopping = False

        self.config_ok = True
        self.activation_error: str | None = None
        self.commissioner = Commissioner(self.control_plane.finish_commissioning, self.allowlist_for, self.secret)
        self.publisher._on_wake = self._wake_flusher
        self.publisher._on_broker_restored = self._on_broker_restored

    def _wake_flusher(self) -> None:
        self._unflushed += 1
        self._flush_event.set()

    def _on_broker_restored(self) -> None:
        self._backoff_reset_event.set()
        self._flush_event.set()

    # ------------------------------------------------------------------ secrets & connectors

    async def secret(self, secret_ref: str) -> str:
        return await self.config_provider.secrets.get(secret_ref)

    def allowlist_for(self, protocol: str, config: dict[str, Any]) -> list[AllowedEndpoint]:
        return [*self.allowlist, *endpoints_for(protocol, config)]

    async def connector(self, spec: JobSpec) -> Any:
        lock = self._connector_locks.setdefault(spec.connection_id, asyncio.Lock())
        async with lock:
            current = self.connectors.get(spec.connection_id)
            if current is not None and current[0] == spec.connection_fingerprint:
                return current[1]
            if current is not None:
                await self._close_connector(spec.connection_id)
            connector = await self._create_connector(spec)
            self.connectors[spec.connection_id] = (spec.connection_fingerprint, connector)
            return connector

    async def _create_connector(self, spec: JobSpec) -> Any:
        config = spec.config
        connection = spec.connection
        timeout_ms = int(config.get("timeout_ms") or 0)
        if spec.protocol == "modbus_tcp":
            host = str(config["host"])
            port = int(config.get("port") or 502)
            assert_allowed(host, port, self.allowlist)
            return ModbusConnector(host, port, timeout_s=max(timeout_ms or 3000, 200) / 1000, retries=int(config.get("retries") or 0))
        if spec.protocol == "opcua":
            username = str(config.get("username") or "") or None
            password = None
            if username and not config.get("anonymous") and connection.get("secret_ref"):
                password = await self.secret(str(connection["secret_ref"]))
                self._baked_secrets[spec.connection_id] = (str(connection["secret_ref"]), password)
            return OpcUaConnector(
                str(config["endpoint"]),
                self.allowlist,
                timeout_s=max(timeout_ms or 4000, 200) / 1000,
                security_mode=config.get("security_mode"),
                security_policy=config.get("security_policy"),
                username=username,
                password=password,
            )
        if spec.protocol == "mqtt":
            password = None
            if not config.get("anonymous", True) and config.get("username") and connection.get("secret_ref"):
                password = await self.secret(str(connection["secret_ref"]))
                self._baked_secrets[spec.connection_id] = (str(connection["secret_ref"]), password)
            mqtt = MqttConnector(
                str(config["host"]),
                int(config.get("port") or 1883),
                self.allowlist,
                str(config.get("client_id") or f"fx-{spec.connection_id[:8]}"),
                username=str(config.get("username") or "") or None,
                password=password,
                keepalive=int(config.get("keepalive") or 60),
                clean_session=bool(config.get("clean_session", True)),
                tls=bool(config.get("tls", False)),
                ca_pem=config.get("ca_pem"),
                tls_insecure=not bool(config.get("tls_verify", True)),
                protocol_version=str(config.get("protocol_version") or "3.1.1"),
            )
            await mqtt.start()
            return mqtt
        if spec.protocol == "http":
            http_conn = HttpPullConnector(
                str(config.get("base_url") or config.get("url") or ""),
                self.allowlist,
                timeout_s=max(timeout_ms or 5000, 200) / 1000,
                query=config.get("query") or None,
                rate_limit_per_min=config.get("rate_limit_per_min"),
            )
            await http_conn.prewarm(ssl_always=False)
            return http_conn
        if spec.protocol == "websocket":
            headers = await http_headers(config, connection.get("secret_ref"), self.secret)
            if connection.get("secret_ref") and str(config.get("auth") or "none") != "none":
                ref = str(connection["secret_ref"])
                self._baked_secrets[spec.connection_id] = (ref, await self.secret(ref))
            ws = WebSocketConnector(str(config.get("url") or ""), self.allowlist, headers=headers, timeout_s=max(timeout_ms or 10000, 200) / 1000)
            await ws.start()
            return ws
        raise ConnectorError("PROTOCOL", f"Protocol '{spec.protocol}' is not supported.")

    async def _close_connector(self, connection_id: str) -> None:
        current = self.connectors.pop(connection_id, None)
        self._baked_secrets.pop(connection_id, None)
        if current is None:
            return
        try:
            await current[1].close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Closing connector %s failed: %r", connection_id, exc)

    # ------------------------------------------------------------------ samples & states

    def emit(self, spec: JobSpec, samples: list[Sample]) -> int:
        return self.publisher.emit(spec, samples, revision=self.revision)

    def _state(self, connection_id: str) -> dict[str, Any]:
        return self.conn_states.setdefault(
            connection_id,
            {"state": None, "last_ok_at": None, "last_error_code": None, "last_error": None, "read_ms": None, "samples": 0},
        )

    def record_ok(self, connection_id: str, read_ms: int | None, samples: int, at: str | None = None) -> None:
        state = self._state(connection_id)
        state.update(state="UP", last_ok_at=at or now_iso(), last_error_code=None, last_error=None)
        if read_ms is not None:
            state["read_ms"] = read_ms
        state["samples"] += samples

    def record_failure(self, connection_id: str, error: ConnectorError) -> None:
        state = self._state(connection_id)
        state.update(state=STATE_BY_CODE.get(error.code, "DOWN"), last_error_code=error.code, last_error=str(error)[:500])

    def connection_report(self, *, reset: bool = False) -> dict[str, dict[str, Any]]:
        report: dict[str, dict[str, Any]] = {}
        if not self.snapshot:
            return report
        active = {spec.connection_id for spec in self.specs.values()}
        for connection in self.snapshot.get("connections") or []:
            cid = str(connection["id"])
            if cid not in active:
                report[cid] = {"state": "IDLE", "last_ok_at": None, "last_error_code": None, "last_error": None, "read_ms": None, "samples": 0}
                continue
            state = dict(self._state(cid))
            connector = self.connectors.get(cid, (None, None))[1]
            if isinstance(connector, (MqttConnector, WebSocketConnector)):
                if connector.state != "UP":
                    state.update(state=connector.state, last_error_code=connector.last_error_code, last_error=connector.last_error)
                elif state["state"] in {None, "DOWN"}:
                    state.update(state="UP", last_error_code=None, last_error=None)
                if connector.last_message_at and (state["last_ok_at"] or "") < connector.last_message_at:
                    state["last_ok_at"] = connector.last_message_at
            if state["state"] is None:
                continue
            report[cid] = state
            if reset:
                self._state(cid)["samples"] = 0
        return report

    # ------------------------------------------------------------------ config sync

    async def sync_config(self, *, start_jobs: bool = True) -> bool:
        if not self._is_leader:
            return False
        try:
            update = await self.config_provider.fetch_if_changed()
            self.config_ok = True
            self.activation_error = None
        except (ValueError, KeyError, TypeError) as exc:
            self.activation_error = str(exc)[:240]
            logger.error("Configuration snapshot invalid: %s", self.activation_error)
            return False
        except Exception as exc:  # noqa: BLE001 - PG transient outage fallback to LKG on cold start
            if self.config_ok:
                logger.warning("PostgreSQL config fetch failed: %r", exc)
            self.config_ok = False
            if self.snapshot is None:
                lkg = await asyncio.to_thread(self.config_provider.load_lkg)
                if lkg is not None and lkg.snapshot is not None:
                    await self.apply_snapshot(lkg.snapshot, lkg.revision, lkg.digest, start_jobs=start_jobs)
                    self.config_provider.mark_applied(lkg.revision, lkg.digest, lkg.struct_hash)
                    logger.info("Started from LKG snapshot revision %s while PostgreSQL is unavailable", lkg.revision)
                    return True
            return False

        if not update.changed or update.snapshot is None:
            return False
        await self.apply_snapshot(update.snapshot, update.revision, update.digest, start_jobs=start_jobs)
        self.config_provider.mark_applied(update.revision, update.digest, update.struct_hash)
        logger.info("Activated acquisition config revision %s (%d job(s))", update.revision, len(self.specs))
        return True

    async def apply_snapshot(self, snapshot: dict[str, Any], revision: int, digest: str, *, start_jobs: bool = True) -> None:
        specs = build_specs(snapshot)

        # Update tenant epochs immediately (fences/purges old-epoch spool rows after reset)
        raw_epochs = snapshot.get("tenant_epochs") or {}
        if isinstance(raw_epochs, dict):
            self.publisher.set_tenant_epochs({str(k): int(v) for k, v in raw_epochs.items()})

        # Reconcile secrets in RAM & detect rotated credentials
        rotated: set[str] = set()
        referenced: set[str] = set()
        expected_hashes: dict[str, str] = {}
        for conn in snapshot.get("connections") or []:
            if conn.get("secret_ref"):
                ref = str(conn["secret_ref"])
                referenced.add(ref)
                if conn.get("secret_hash"):
                    expected_hashes[ref] = str(conn["secret_hash"])
        if revision != self.revision or digest != self.snapshot_checksum:
            self.config_provider.secrets.reconcile(referenced, expected_hashes or None)
            rotated = await self._rotated_secrets()

        allow = list(self.env_allowlist)
        for connection in snapshot.get("connections") or []:
            if connection.get("status") != "ARCHIVED":
                allow.extend(endpoints_for(str(connection.get("protocol") or ""), connection.get("config_json") or {}))
        self.allowlist[:] = allow

        changed = [
            job_id
            for job_id, spec in self.specs.items()
            if job_id not in specs or specs[job_id].fingerprint != spec.fingerprint or spec.connection_id in rotated
        ]
        for job_id in changed:
            await self._stop_job(job_id)

        wanted_connections = {spec.connection_id: spec.connection_fingerprint for spec in specs.values()}
        for connection_id in list(self.connectors):
            if connection_id in rotated or wanted_connections.get(connection_id) != self.connectors[connection_id][0]:
                await self._close_connector(connection_id)
        for connection_id in list(self.conn_states):
            if connection_id not in wanted_connections:
                del self.conn_states[connection_id]

        old = self.specs
        self.specs = specs
        self.snapshot = snapshot
        self.revision = revision
        self.snapshot_checksum = digest

        if start_jobs and self._is_leader:
            for job_id, spec in specs.items():
                restart = job_id not in self.job_tasks or job_id not in old or old[job_id].fingerprint != spec.fingerprint
                if restart or spec.connection_id in rotated:
                    self._start_job(spec)

    async def _rotated_secrets(self) -> set[str]:
        rotated: set[str] = set()
        for connection_id, (secret_ref, used) in list(self._baked_secrets.items()):
            if connection_id not in self.connectors:
                continue
            try:
                current = await self.secret(secret_ref)
            except ConnectorError as exc:
                logger.warning("Cannot re-check secret for connection %s: %s", connection_id, exc)
                continue
            if current != used:
                logger.info("Secret for connection %s rotated; reconnecting", connection_id)
                rotated.add(connection_id)
        return rotated

    def _start_job(self, spec: JobSpec) -> None:
        runner = JobRunner(spec, self)
        self.job_tasks[spec.job_id] = asyncio.create_task(self._job_main(runner), name=f"job:{spec.job_id}")

    async def _job_main(self, runner: JobRunner) -> None:
        while True:
            try:
                await runner.run()
                return
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Job %s crashed; restarting in 5 s", runner.spec.job_id)
                self.record_failure(runner.spec.connection_id, ConnectorError("INTERNAL", "Acquisition task crashed; restarting."))
                await asyncio.sleep(5)

    async def _stop_job(self, job_id: str) -> None:
        task = self.job_tasks.get(job_id)
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("Job %s ended with %r while stopping", job_id, exc)
        finally:
            if self.job_tasks.get(job_id) is task:
                self.job_tasks.pop(job_id, None)

    async def _stop_all_jobs_and_connectors(self) -> None:
        for job_id in list(self.job_tasks):
            await self._stop_job(job_id)
        for cid in list(self.connectors):
            await self._close_connector(cid)
        for task in list(self._commands):
            task.cancel()
        if self._commands:
            await asyncio.gather(*list(self._commands), return_exceptions=True)

    # ------------------------------------------------------------------ health & heartbeat

    async def send_heartbeat(self) -> None:
        if not self._is_leader:
            return
        pending = self.publisher.spool.pending_count()
        queues = {
            cid: {"pending": connector.queue_length, "dropped": connector.dropped}
            for cid, (_, connector) in self.connectors.items()
            if isinstance(connector, MqttConnector)
        }
        degraded = not self.config_ok or self.activation_error is not None or self.publisher.storage_error is not None or not self.publisher.broker_ok
        diag = self.activation_error or self.publisher.storage_error or ("RabbitMQ broker unavailable." if not self.publisher.broker_ok else None)
        reports = self.connection_report(reset=True)
        if reports:
            await self.control_plane.flush_connection_reports(reports)
        await self.control_plane.record_heartbeat(
            health="DEGRADED" if degraded else "HEALTHY",
            software_version=SOFTWARE_VERSION,
            spool_pending=pending,
            fast_buffered=self.publisher.fast_buffered,
            queues=queues,
            revision=self.revision,
            broker_ok=self.publisher.broker_ok,
            config_in_sync=self.config_ok and self.activation_error is None,
            diagnostic=diag,
        )

    def _write_health(self, ok: bool) -> None:
        if self.health_path is None:
            return
        try:
            self.health_path.parent.mkdir(parents=True, exist_ok=True)
            self.health_path.write_text(
                json.dumps(
                    {
                        "ok": ok,
                        "leader": self._is_leader,
                        "pending": self.publisher.spool.pending_count(),
                        "fast_buffered": self.publisher.fast_buffered,
                        "revision": self.revision,
                        "config_ok": self.config_ok,
                        "broker_ok": self.publisher.broker_ok,
                        "jobs": len(self.job_tasks),
                        "at": now_iso(),
                    }
                ),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning("Cannot write acquisition health file: %r", exc)

    # ------------------------------------------------------------------ commissioning

    async def _run_command(self, job: dict[str, Any]) -> None:
        try:
            await self.commissioner.run(job)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Commissioning command %s failed", job.get("id"))

    async def poll_commissioning_once(self) -> int:
        if not self._is_leader:
            return 0
        available = max(0, 4 - len(self._commands))
        if available <= 0:
            return 0
        jobs = await self.control_plane.claim_commissioning_jobs(limit=available)
        for job in jobs:
            task = asyncio.create_task(self._run_command(job), name=f"command:{job.get('id')}")
            self._commands.add(task)
            task.add_done_callback(self._commands.discard)
        return len(jobs)

    # ------------------------------------------------------------------ loops

    async def _leader_loop(self) -> None:
        if self.leader_lock is None:
            self._is_leader = True
            return
        while not self._stopping:
            acquired = await self.leader_lock.probe()
            if acquired and not self._is_leader:
                logger.info("Acquired PostgreSQL advisory leader lock; starting acquisition jobs")
                self._is_leader = True
                if self.notify_listener is not None:
                    self.notify_listener.config_event.set()
                    self.notify_listener.commissioning_event.set()
            elif not acquired and self._is_leader:
                logger.warning("Lost PostgreSQL advisory leader lock; demoting to standby and stopping jobs")
                self._is_leader = False
                await self._stop_all_jobs_and_connectors()
            if not self._is_leader:
                self._write_health(True)
            await asyncio.sleep(self.leader_probe_s)

    async def _config_loop(self) -> None:
        while not self._stopping:
            if self._is_leader:
                await self.sync_config()
            if self.notify_listener is not None:
                try:
                    await bounded(self.notify_listener.config_event.wait(), timeout=self.config_s)
                    self.notify_listener.config_event.clear()
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(self.config_s)

    async def _heartbeat_loop(self) -> None:
        next_due = time.monotonic()
        while not self._stopping:
            ok = True
            if self._is_leader:
                ok = False
                try:
                    await self.send_heartbeat()
                    ok = True
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Heartbeat report failed: %r", exc, exc_info=True)
            self._write_health(ok)
            next_due += self.heartbeat_s
            now = time.monotonic()
            if next_due < now:
                next_due = now
            await asyncio.sleep(next_due - now)

    async def _commands_loop(self) -> None:
        while not self._stopping:
            if self._is_leader:
                try:
                    claimed = await self.poll_commissioning_once()
                    if claimed and len(self._commands) < 4:
                        continue
                except Exception as exc:  # noqa: BLE001
                    logger.info("Commissioning claim failed: %r", exc)
            if self.notify_listener is not None:
                try:
                    await bounded(self.notify_listener.commissioning_event.wait(), timeout=self.commands_s)
                    self.notify_listener.commissioning_event.clear()
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(self.commands_s)

    async def _publisher_loop(self) -> None:
        backoff = 0.0
        while not self._stopping:
            if backoff:
                if not self._stopping and not self.publisher.broker_ok:
                    try:
                        await asyncio.wait_for(self._backoff_reset_event.wait(), timeout=backoff)
                    except asyncio.TimeoutError:
                        pass
                self._backoff_reset_event.clear()
                if self._stopping:
                    break
                if self.publisher.broker_ok:
                    backoff = 0.0
            if not backoff:
                try:
                    await bounded(self._flush_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    if not self.publisher.has_pending():
                        continue
            if self._stopping:
                break
            self._flush_event.clear()
            if self.publisher.spool.pending_count() == 0 and self.publisher.fast_buffered < BATCH_ROWS:
                linger_end = time.monotonic() + LINGER_S
                while (
                    self._unflushed < BATCH_ROWS
                    and self.publisher.fast_buffered < BATCH_ROWS
                    and time.monotonic() < linger_end
                ):
                    await asyncio.sleep(0.01)
            self._unflushed = 0
            _sent, failed = await self.publisher.flush_once(budget_s=HISTORY_SLICE_S)
            if failed:
                if self.publisher.broker_ok:
                    backoff = 0.0
                    if self.publisher.has_pending():
                        self._flush_event.set()
                        await asyncio.sleep(0)
                else:
                    backoff = min(30.0, max(1.0, backoff * 2))
                continue
            backoff = 0.0
            if self.publisher.has_pending():
                self._flush_event.set()
                await asyncio.sleep(0)

    async def _maintenance_loop(self) -> None:
        while not self._stopping:
            await asyncio.sleep(PRUNE_INTERVAL_S)
            cutoff = iso_ms(datetime.now(timezone.utc) - ACKED_RETENTION)
            steps = 0
            while steps < MAX_PRUNE_STEPS_PER_PASS:
                chunk, more = await asyncio.to_thread(self.publisher.spool.prune_step, cutoff, PRUNE_CHUNK)
                steps += 1
                if not more:
                    break
                await asyncio.sleep(PRUNE_PAUSE_S)
            dropped = await asyncio.to_thread(self.publisher.spool.enforce_cap, self.publisher.max_pending)
            if dropped:
                logger.error("Spool exceeded %d pending rows: %d oldest rows marked DEAD", self.publisher.max_pending, dropped)
            if self.publisher.max_spool_bytes > 0:
                bytes_dropped = await asyncio.to_thread(self.publisher.spool.enforce_byte_cap, self.publisher.max_spool_bytes)
                if bytes_dropped:
                    logger.error("Spool exceeded %d byte cap: %d rows pruned/dropped", self.publisher.max_spool_bytes, bytes_dropped)

    async def _supervise(self, name: str, factory: Callable[[], Coroutine[Any, Any, None]]) -> None:
        while not self._stopping:
            try:
                await factory()
                return
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Acquisition loop '%s' crashed; restarting in 1 s", name)
                await asyncio.sleep(1.0)

    async def run(self) -> None:
        if self.notify_listener is not None:
            self.notify_listener.start()
        if self.leader_lock is not None:
            await self.leader_lock.probe()
            self._is_leader = self.leader_lock.is_leader
        if self._is_leader:
            await self.sync_config(start_jobs=False)
        try:
            async with asyncio.TaskGroup() as group:
                if self.leader_lock is not None:
                    group.create_task(self._supervise("leader", self._leader_loop), name="leader-loop")
                group.create_task(self._supervise("config", self._config_loop), name="config-loop")
                group.create_task(self._supervise("heartbeat", self._heartbeat_loop), name="heartbeat-loop")
                group.create_task(self._supervise("commands", self._commands_loop), name="commands-loop")
                group.create_task(self._supervise("publisher", self._publisher_loop), name="publisher-loop")
                group.create_task(self._supervise("maintenance", self._maintenance_loop), name="maintenance-loop")
                if self._is_leader:
                    for spec in self.specs.values():
                        if spec.job_id not in self.job_tasks:
                            self._start_job(spec)
        finally:
            await self.close()

    async def close(self) -> None:
        self._stopping = True
        self._backoff_reset_event.set()
        self._flush_event.set()
        await self._stop_all_jobs_and_connectors()
        if self._is_leader:
            reports = self.connection_report(reset=True)
            if reports:
                try:
                    await self.control_plane.flush_connection_reports(reports)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Final connection report flush failed: %r", exc)
        if self.notify_listener is not None:
            await self.notify_listener.close()
        if self.leader_lock is not None:
            await self.leader_lock.release()
        await self.publisher.drain_and_close()
