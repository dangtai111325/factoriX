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
from factorix_core.contracts.runtime_status import QUEUES_SCHEMA_VERSION

logger = logging.getLogger(__name__)

SOFTWARE_VERSION = os.environ.get("FACTORIX_ACQUISITION_VERSION", "acq-v1")
LINGER_S = 0.05
PRUNE_CHUNK = 500
PRUNE_PAUSE_S = 0.05
PRUNE_INTERVAL_S = 15.0
MAX_PRUNE_STEPS_PER_PASS = 40
ACKED_RETENTION = timedelta(minutes=2)
# Connection health hysteresis: a job is "failing" only when it has had no successful read for
# max(DEGRADE_INTERVALS x interval, MIN_DEGRADE_S). One failed read never reports DOWN.
DEGRADE_INTERVALS = 3
MIN_DEGRADE_S = 10.0
HEARTBEAT_WRITE_TIMEOUT_S = 4.0
COMMISSION_BUDGET_S = 25.0
REPORT_WRITE_TIMEOUT_S = 6.0


def degrade_window_s(interval_s: float, min_degrade_s: float) -> float:
    """Seconds without a successful read before a job counts as failing (0 disables the hysteresis)."""
    if min_degrade_s <= 0:
        return 0.0
    return max(DEGRADE_INTERVALS * max(0.0, float(interval_s)), float(min_degrade_s))


class JobHealth:
    """Per-job acquisition evidence. Connection health is aggregated from these, never last-writer-wins."""

    __slots__ = (
        "job_id",
        "connection_id",
        "interval_s",
        "push",
        "started_mono",
        "last_ok_mono",
        "last_ok_at",
        "consecutive_failures",
        "last_error_code",
        "last_error",
        "last_error_mono",
        "reads_ok",
        "reads_failed",
        "read_ms",
        "samples",
        "stall_s",
    )

    def __init__(self, job_id: str, connection_id: str, interval_s: float, push: bool, stall_s: float = 0.0) -> None:
        self.job_id = job_id
        self.connection_id = connection_id
        self.interval_s = interval_s
        self.push = push
        self.started_mono = time.monotonic()
        self.last_ok_mono: float | None = None
        self.last_ok_at: str | None = None
        self.consecutive_failures = 0
        self.last_error_code: str | None = None
        self.last_error: str | None = None
        self.last_error_mono: float | None = None
        self.reads_ok = 0
        self.reads_failed = 0
        self.read_ms: int | None = None
        self.samples = 0
        self.stall_s = stall_s


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
        min_degrade_s: float = MIN_DEGRADE_S,
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
        self.min_degrade_s = float(min_degrade_s)
        self.started_at = now_iso()
        self.leader_since: str | None = None
        # Time of the last successful connection-report flush (P6: Center tells "report late" apart).
        self.last_report_at: str | None = None
        self.job_health: dict[str, JobHealth] = {}

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
                # Persistent session by default (QoS 1 messages are queued by the broker while the
                # client reconnects). An explicit clean_session=true in the connection keeps the old way.
                clean_session=bool(config.get("clean_session", False)),
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

    async def emit(self, spec: JobSpec, samples: list[Sample]) -> int:
        return await self.publisher.emit(spec, samples, revision=self.revision)

    def _state(self, connection_id: str) -> dict[str, Any]:
        return self.conn_states.setdefault(
            connection_id,
            {"state": None, "last_ok_at": None, "last_error_code": None, "last_error": None, "read_ms": None, "samples": 0},
        )

    def _job_health(self, connection_id: str, job_id: str | None) -> JobHealth:
        key = job_id or f"{connection_id}:*"
        health = self.job_health.get(key)
        if health is None or health.connection_id != connection_id:
            spec = self.specs.get(job_id) if job_id else None
            interval_s = (spec.interval_ms / 1000) if spec else 1.0
            push = bool(spec.subscribe) if spec else False
            stall_s = 0.0
            if spec is not None and not push:
                from factorix_acquisition.jobs import poll_watchdog_s

                stall_s = poll_watchdog_s(spec) + 2 * interval_s
            health = self.job_health[key] = JobHealth(key, connection_id, interval_s, push, stall_s)
        return health

    def record_ok(self, connection_id: str, read_ms: int | None, samples: int, at: str | None = None, *, job_id: str | None = None) -> None:
        state = self._state(connection_id)
        ok_at = at or now_iso()
        if (state["last_ok_at"] or "") < ok_at:
            state["last_ok_at"] = ok_at
        state.update(state="UP", last_error_code=None, last_error=None)
        if read_ms is not None:
            state["read_ms"] = read_ms
        state["samples"] += samples
        health = self._job_health(connection_id, job_id)
        health.last_ok_mono = time.monotonic()
        if (health.last_ok_at or "") < ok_at:
            health.last_ok_at = ok_at
        health.consecutive_failures = 0
        health.reads_ok += 1
        health.samples += samples
        if read_ms is not None:
            health.read_ms = read_ms

    def record_failure(self, connection_id: str, error: ConnectorError, *, job_id: str | None = None) -> None:
        state = self._state(connection_id)
        state.update(state=STATE_BY_CODE.get(error.code, "DOWN"), last_error_code=error.code, last_error=str(error)[:500])
        health = self._job_health(connection_id, job_id)
        health.consecutive_failures += 1
        health.reads_failed += 1
        health.last_error_code = error.code
        health.last_error = str(error)[:500]
        health.last_error_mono = time.monotonic()

    def _job_verdict(self, health: JobHealth, connector: Any, now: float) -> tuple[str | None, str | None, str | None]:
        """(state, error_code, error) for one job with hysteresis.

        state None = no evidence yet; UP = acquiring; RATE_LIMITED = acquiring slowly; DOWN /
        AUTH_FAILED = no successful read for the degrade window and the reads fail; SILENT = the
        transport is up but the source sent nothing for the window (push) or no read completed (poll).
        """
        window = degrade_window_s(health.interval_s, self.min_degrade_s)
        silent_window = window or max(5.0, 2 * health.interval_s)
        reference = health.last_ok_mono if health.last_ok_mono is not None else health.started_mono
        quiet_s = now - reference
        if health.push and connector is not None and hasattr(connector, "state"):
            transport = str(getattr(connector, "state", "UP") or "UP")
            if transport != "UP":
                down_since = getattr(connector, "down_since", None)
                if down_since is None or now - float(down_since) >= window:
                    code = getattr(connector, "last_error_code", None) or "NETWORK"
                    text = getattr(connector, "last_error", None) or "Disconnected."
                    return STATE_BY_CODE.get(code, "DOWN"), code, text
            elif quiet_s >= silent_window and health.consecutive_failures == 0:
                return "SILENT", "NO_DATA", f"Connected, but the source sent no data for {int(quiet_s)} s."
        if health.consecutive_failures > 0 and quiet_s >= window:
            code = health.last_error_code or "INTERNAL"
            state = STATE_BY_CODE.get(code, "DOWN")
            return state, code, health.last_error
        if health.consecutive_failures == 0 and not health.push and health.stall_s > 0 and quiet_s >= max(silent_window, health.stall_s):
            return "SILENT", "STALLED", f"No read completed for {int(quiet_s)} s."
        if health.last_error_code == "RATE_LIMITED" and health.last_error_mono is not None and now - health.last_error_mono <= max(window, 2 * health.interval_s, 5.0):
            # The source answered (429): reachable, only slowed down.
            return "RATE_LIMITED", "RATE_LIMITED", health.last_error
        if health.last_ok_mono is None:
            return None, None, None
        return "UP", None, None

    def connection_report(self, *, reset: bool = False) -> dict[str, dict[str, Any]]:
        report: dict[str, dict[str, Any]] = {}
        if not self.snapshot:
            return report
        jobs_by_conn: dict[str, list[JobSpec]] = {}
        for spec in self.specs.values():
            jobs_by_conn.setdefault(spec.connection_id, []).append(spec)
        now = time.monotonic()
        severity = {"AUTH_FAILED": 4, "DOWN": 3, "SILENT": 2, "RATE_LIMITED": 1, "UP": 0}
        for connection in self.snapshot.get("connections") or []:
            cid = str(connection["id"])
            specs = jobs_by_conn.get(cid)
            if not specs:
                report[cid] = {"state": "IDLE", "last_ok_at": None, "last_error_code": None, "last_error": None, "read_ms": None, "samples": 0}
                continue
            connector = self.connectors.get(cid, (None, None))[1]
            verdicts: list[tuple[str, str | None, str | None]] = []
            healths: list[JobHealth] = []
            for spec in specs:
                health = self._job_health(cid, spec.job_id)
                healths.append(health)
                state, code, text = self._job_verdict(health, connector, now)
                if state is not None:
                    verdicts.append((state, code, text))
            legacy = self.job_health.get(f"{cid}:*")
            if legacy is not None and legacy.last_error_mono is not None and legacy.consecutive_failures:
                healths.append(legacy)
            last_ok_at = max((h.last_ok_at for h in healths if h.last_ok_at), default=None)
            last_message_at = getattr(connector, "last_message_at", None) if connector is not None else None
            if last_message_at and (last_ok_at or "") < last_message_at:
                last_ok_at = last_message_at
            failing = [v for v in verdicts if v[0] in {"DOWN", "AUTH_FAILED", "SILENT"}]
            if not verdicts:
                continue
            worst = max(verdicts, key=lambda item: severity.get(item[0], 3))
            entry: dict[str, Any] = {
                "state": worst[0],
                "last_ok_at": last_ok_at,
                "last_error_code": worst[1],
                "last_error": worst[2],
                "read_ms": max((h.read_ms for h in healths if h.read_ms is not None), default=None),
                "samples": sum(h.samples for h in healths),
                "window_s": max(degrade_window_s(h.interval_s, self.min_degrade_s) for h in healths),
                "reads_ok": sum(h.reads_ok for h in healths),
                "reads_failed": sum(h.reads_failed for h in healths),
                "jobs_total": len(specs),
                "jobs_failing": len(failing),
            }
            if failing and len(specs) > 1:
                entry["last_error"] = f"{len(failing)} of {len(specs)} jobs failing: {worst[2] or worst[1]}"[:500]
            recent = [h for h in healths if h.last_error_mono is not None and now - h.last_error_mono <= entry["window_s"]]
            if not failing and recent:
                last = max(recent, key=lambda h: h.last_error_mono or 0.0)
                entry["warning"] = f"Intermittent errors: {last.last_error_code}: {last.last_error}"[:500]
            report[cid] = entry
            if reset:
                self._state(cid)["samples"] = 0
                for health in healths:
                    health.samples = 0
                    health.reads_ok = 0
                    health.reads_failed = 0
        return report

    def runtime_info(self) -> dict[str, Any]:
        """Facts Center needs to judge evidence: when acquisition started / became leader, which connections run jobs."""
        running = {spec.connection_id for spec in self.specs.values() if (task := self.job_tasks.get(spec.job_id)) is not None and not task.done()}
        return {
            "started_at": self.started_at,
            "leader_since": self.leader_since,
            "jobs_expected": len(self.specs),
            "jobs_running": sum(1 for task in self.job_tasks.values() if not task.done()),
            "connections_running": sorted(running),
            "last_report_at": self.last_report_at,
        }

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
            await self.publisher.set_tenant_epochs({str(k): int(v) for k, v in raw_epochs.items()})

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
        for key in list(self.job_health):
            health = self.job_health[key]
            if health.connection_id not in wanted_connections or (not key.endswith(":*") and key not in specs):
                del self.job_health[key]

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
        old = self.job_tasks.get(spec.job_id)
        if old is not None and not old.done():
            old.cancel()
        # A (re)started job gets a fresh evidence window: its new configuration has not failed yet.
        self.job_health.pop(spec.job_id, None)
        self._job_health(spec.connection_id, spec.job_id)
        runner = JobRunner(spec, self)
        self.job_tasks[spec.job_id] = asyncio.create_task(self._job_main(runner), name=f"job:{spec.job_id}")

    def ensure_jobs_running(self) -> int:
        """Start every configured job whose task is missing or has ended. Leader only. Returns jobs started.

        Called on promotion and on every config tick, so the running set always converges to the
        configured set no matter how a task was lost (demotion, crash, cancellation).
        """
        if not self._is_leader:
            return 0
        started = 0
        for job_id, spec in self.specs.items():
            task = self.job_tasks.get(job_id)
            if task is None or task.done():
                if task is not None and not task.cancelled() and task.exception() is not None:
                    logger.warning("Job %s ended with %r; restarting", job_id, task.exception())
                self._start_job(spec)
                started += 1
        return started

    async def _job_main(self, runner: JobRunner) -> None:
        while True:
            try:
                await runner.run()
                logger.warning("Job %s returned unexpectedly; restarting in 1 s", runner.spec.job_id)
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Job %s crashed; restarting in 5 s", runner.spec.job_id)
                self.record_failure(
                    runner.spec.connection_id,
                    ConnectorError("INTERNAL", "Acquisition task crashed; restarting."),
                    job_id=runner.spec.job_id,
                )
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
        # queues_json v1 (runtime-status.md, CT-18): MQTT counters live under "connectors" (they used to be
        # top-level keys named by connection UUID); readers accept both (factorix_core.contracts.runtime_status).
        queues: dict[str, Any] = {}
        queues["schema_version"] = QUEUES_SCHEMA_VERSION
        queues["connectors"] = {
            cid: {
                "pending": connector.queue_length,
                "dropped": connector.dropped,
                "connects": connector.connects,
                "disconnects": connector.disconnects,
                "session_present": connector.session_present,
            }
            for cid, (_, connector) in self.connectors.items()
            if isinstance(connector, MqttConnector)
        }
        queues["publisher"] = self.publisher.publish_metrics()
        runtime = self.runtime_info()
        queues["runtime"] = runtime
        missing_jobs = runtime["jobs_expected"] - runtime["jobs_running"]
        degraded = (
            not self.config_ok
            or self.activation_error is not None
            or self.publisher.storage_error is not None
            or not self.publisher.broker_ok
            or missing_jobs > 0
        )
        diag = (
            self.activation_error
            or self.publisher.storage_error
            or ("RabbitMQ broker unavailable." if not self.publisher.broker_ok else None)
            or (f"{missing_jobs} of {runtime['jobs_expected']} acquisition jobs are not running." if missing_jobs > 0 else None)
        )
        reports = self.connection_report(reset=True)
        # The liveness heartbeat goes first and is bounded on its own: a slow or failing health flush
        # (row locks, PG hiccup) must never make Center believe the collector is offline.
        heartbeat_error: BaseException | None = None
        try:
            await bounded(
                self.control_plane.record_heartbeat(
                    health="DEGRADED" if degraded else "HEALTHY",
                    software_version=SOFTWARE_VERSION,
                    spool_pending=pending,
                    fast_buffered=self.publisher.fast_buffered,
                    queues=queues,
                    revision=self.revision,
                    broker_ok=self.publisher.broker_ok,
                    config_in_sync=self.config_ok and self.activation_error is None,
                    diagnostic=diag,
                ),
                timeout=HEARTBEAT_WRITE_TIMEOUT_S,
            )
        except Exception as exc:  # noqa: BLE001 - still try to flush connection evidence
            heartbeat_error = exc
        if reports:
            await bounded(self.control_plane.flush_connection_reports(reports), timeout=REPORT_WRITE_TIMEOUT_S)
        self.last_report_at = now_iso()
        if heartbeat_error is not None:
            raise heartbeat_error

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
            # Center reaps a RUNNING command after 30 s with a bare "timed out". Finish earlier with
            # a real diagnostic so the operator sees what was slow.
            await bounded(self.commissioner.run(job), timeout=COMMISSION_BUDGET_S)
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            logger.warning("Commissioning command %s did not finish within %.0f s", job.get("id"), COMMISSION_BUDGET_S)
            try:
                await bounded(
                    self.control_plane.finish_commissioning(
                        str(job.get("id")),
                        {
                            "status": "FAILED",
                            "error_code": "TIMEOUT",
                            "diagnostic": (
                                f"The source did not answer within {int(COMMISSION_BUDGET_S)} s. "
                                "Check that the device is reachable and the address is correct, then test again."
                            ),
                            "stages": [],
                        },
                    ),
                    timeout=5.0,
                )
            except Exception as exc:  # noqa: BLE001
                logger.info("Could not report commissioning timeout for %s: %r", job.get("id"), exc)
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
                await self._promote()
            elif not acquired and self._is_leader:
                logger.warning("Lost PostgreSQL advisory leader lock; demoting to standby and stopping jobs")
                await self._demote()
            if not self._is_leader:
                self._write_health(True)
            await asyncio.sleep(self.leader_probe_s)

    async def _promote(self) -> None:
        """Become leader and run every configured job now (P0: never sit as leader with zero jobs).

        The last applied snapshot is still in memory, and ``fetch_if_changed`` reports "unchanged" for
        it, so jobs are started from that snapshot directly; a config sync is also requested so a
        revision published while this instance was standby is applied right after.
        """
        self._is_leader = True
        self.leader_since = now_iso()
        self.conn_states.clear()
        self.job_health.clear()
        if self.snapshot is not None:
            started = self.ensure_jobs_running()
            logger.info("Leader promotion started %d acquisition job(s) from revision %s", started, self.revision)
        if self.notify_listener is not None:
            self.notify_listener.config_event.set()
            self.notify_listener.commissioning_event.set()

    async def _demote(self) -> None:
        self._is_leader = False
        self.leader_since = None
        await self._stop_all_jobs_and_connectors()
        # Evidence gathered as leader must not be reported after a later promotion.
        self.conn_states.clear()
        self.job_health.clear()

    async def _config_loop(self) -> None:
        while not self._stopping:
            if self._is_leader:
                await self.sync_config()
                self.ensure_jobs_running()
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
            self.leader_since = now_iso()
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
