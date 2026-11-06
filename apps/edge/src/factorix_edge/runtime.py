"""Edge supervisor: independent asyncio tasks for config, heartbeat, commands, jobs and the flusher.

* config   — every 5 s; activates a new revision (checksum, save, ack) and restarts only
             the job tasks and connectors whose definition changed.
* heartbeat — fixed 5 s, independent of source health; carries per-connection state.
* commands — every 2 s; each test or capture runs in its own task.
* jobs     — one task per acquisition job (see ``jobs.py``).
* flusher  — wakes when samples are written; micro-batches (≤100 ms or 500 rows),
             sends the newest row of each signal first, then history, within a time budget.
* maintenance — every 60 s; prunes delivered rows and enforces the pending cap.

A Center answer 401 means the credential was revoked: ``run()`` stops and raises
``CredentialRevoked`` so the entry point can re-enroll.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Coroutine
from uuid import uuid4

import httpx

from factorix.domain.network import AllowedEndpoint, NetworkPolicyError, assert_allowed, endpoint_from_url, parse_allowlist
from factorix_edge.aio import bounded
from factorix_edge.commissioning import Commissioner
from factorix_edge.connectors.errors import STATE_BY_CODE, ConnectorError
from factorix_edge.connectors.http_pull import HttpPullConnector
from factorix_edge.connectors.modbus import ModbusConnector
from factorix_edge.connectors.mqtt import MqttConnector
from factorix_edge.connectors.opcua import OpcUaConnector
from factorix_edge.connectors.ws import WebSocketConnector
from factorix_edge.jobs import JobRunner, JobSpec, as_connector_error, build_specs, http_headers, read_budget_s
from factorix_edge.mapping import Sample, coerce
from factorix_edge.store.outbox import Outbox
from factorix_edge.timeutil import iso_ms, now_iso

logger = logging.getLogger(__name__)

SOFTWARE_VERSION = os.environ.get("FACTORIX_EDGE_VERSION", "r2")
BATCH_ROWS = 500
LINGER_S = 0.1
FLUSH_BUDGET_S = 1.0
ACKED_RETENTION = timedelta(minutes=10)


class CredentialRevoked(Exception):
    """Center rejected the edge credential (HTTP 401)."""


def checksum(snapshot: dict[str, Any]) -> str:
    body = {key: value for key, value in snapshot.items() if key != "checksum_sha256"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(canonical).hexdigest()


def _prepare(snapshot: dict[str, Any]) -> None:
    if not isinstance(snapshot.get("connections"), list):
        raise ValueError("Snapshot is missing connections list.")
    build_specs(snapshot)  # raises on malformed rows before the revision is acknowledged


def endpoints_for(protocol: str, config: dict[str, Any]) -> list[AllowedEndpoint]:
    """The network endpoint a connection config points at (for the effective allowlist)."""
    try:
        if protocol == "modbus_tcp":
            return [AllowedEndpoint(str(config["host"]), int(config.get("port") or 502), None)]
        if protocol == "mqtt":
            port = int(config.get("port") or (8883 if config.get("tls") else 1883))
            return [AllowedEndpoint(str(config["host"]), port, "mqtt")]
        if protocol == "opcua":
            return [endpoint_from_url(str(config["endpoint"]))]
        if protocol == "http":
            return [endpoint_from_url(str(config.get("base_url") or config.get("url") or ""))]
        if protocol == "websocket":
            return [endpoint_from_url(str(config["url"]))]
    except (KeyError, TypeError, ValueError, NetworkPolicyError) as exc:
        logger.info("No allowlist endpoint for %s config: %s", protocol, exc)
    return []


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


class EdgeRuntime:
    def __init__(
        self,
        client: httpx.AsyncClient,
        credential: str,
        allowlist: list[str],
        outbox: Outbox,
        snapshot_path: Path | None = None,
        *,
        health_path: Path | None = None,
        heartbeat_s: float = 5.0,
        config_s: float = 5.0,
        commands_s: float = 2.0,
    ) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {credential}"}
        self.env_allowlist: list[AllowedEndpoint] = parse_allowlist(allowlist)
        self.allowlist: list[AllowedEndpoint] = list(self.env_allowlist)
        self.outbox = outbox
        self.snapshot_path = snapshot_path
        self.health_path = health_path
        self.heartbeat_s = heartbeat_s
        self.config_s = config_s
        self.commands_s = commands_s
        self.max_attempts = int(_env_float("FACTORIX_OUTBOX_MAX_ATTEMPTS", 10))
        self.max_pending = int(_env_float("FACTORIX_OUTBOX_MAX_PENDING", 1_000_000))

        self.revision = 0
        self.snapshot_checksum = ""
        self.snapshot: dict[str, Any] | None = None
        self.specs: dict[str, JobSpec] = {}
        self.job_tasks: dict[str, asyncio.Task[None]] = {}
        self.connectors: dict[str, tuple[str, Any]] = {}
        self._connector_locks: dict[str, asyncio.Lock] = {}
        self.conn_states: dict[str, dict[str, Any]] = {}
        self._secrets: dict[str, str] = {}
        self.config_ok = True
        self.activation_error: str | None = None
        self.storage_error: str | None = None
        self._rejected: tuple[int, str] | None = None
        self._baked_secrets: dict[str, tuple[str, str]] = {}
        self._flush_event = asyncio.Event()
        self._unflushed = 0
        self._revoked = asyncio.Event()
        self._commands: set[asyncio.Task[None]] = set()
        self.commissioner = Commissioner(self._request, self.allowlist_for, self.secret)

    # ------------------------------------------------------------------ Center

    async def _request(self, method: str, path: str, body: dict[str, Any] | None = None, *, params: dict[str, Any] | None = None, timeout: float | None = None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"headers": self.headers, "json": body, "params": params}
        if timeout is not None:
            kwargs["timeout"] = timeout
        response = await self.client.request(method, path, **kwargs)
        if response.status_code == 401:
            self._revoked.set()
            raise CredentialRevoked("Center rejected the edge credential.")
        response.raise_for_status()
        if response.status_code == 204 or not response.content:
            return {}
        payload = response.json()
        return payload if isinstance(payload, dict) else {"items": payload}

    async def secret(self, secret_ref: str) -> str:
        """Connection secret, fetched once per configuration revision."""
        if secret_ref in self._secrets:
            return self._secrets[secret_ref]
        try:
            body = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")
        except httpx.HTTPStatusError as exc:
            raise ConnectorError("AUTH", f"The connection secret is not available (Center answered {exc.response.status_code}).") from exc
        except httpx.HTTPError as exc:
            raise ConnectorError("CENTER", "Cannot fetch the connection secret from Center.") from exc
        value = str(body.get("secret") or "")
        self._secrets[secret_ref] = value
        return value

    # ------------------------------------------------------------------ allowlist and connectors

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
            return HttpPullConnector(
                str(config.get("base_url") or config.get("url") or ""),
                self.allowlist,
                timeout_s=max(timeout_ms or 5000, 200) / 1000,
                query=config.get("query") or None,
                rate_limit_per_min=config.get("rate_limit_per_min"),
            )
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
        except Exception as exc:  # noqa: BLE001 - closing a broken connector must not stop reconfiguration
            logger.warning("Closing connector of connection %s failed: %r", connection_id, exc)

    # ------------------------------------------------------------------ samples

    def emit(self, spec: JobSpec, samples: list[Sample]) -> int:
        """Bind, coerce and store the samples of one read in one transaction."""
        rows = []
        created = now_iso()
        revision = self.revision
        for sample in samples:
            binding = spec.bindings.get(sample.field_id)
            if not binding:
                continue
            data_type = str(binding.get("data_type") or "float64")
            value, quality, coerce_reason = coerce(data_type, sample.value, sample.quality, spec.coerce_address.get(sample.field_id))
            reason = sample.reason or coerce_reason
            received = sample.received_time or created
            provenance: dict[str, Any] = {"protocol": spec.protocol, "field_id": sample.field_id, "job_id": spec.job_id}
            if reason:
                provenance["reason"] = reason
            event_uid = str(uuid4())
            payload = {
                "event_uid": event_uid,
                "resource_id": str(binding["resource_id"]),
                "signal_id": str(binding["signal_id"]),
                "connection_id": spec.connection_id,
                "event_time": received,
                "received_time": received,
                "source_time": sample.source_time,
                "value": value,
                "data_type": data_type,
                "unit": binding.get("unit"),
                "quality": quality,
                "origin": "LIVE",
                "config_revision": revision,
                "provenance": provenance,
            }
            rows.append((event_uid, received, json.dumps(payload, separators=(",", ":")).encode(), revision, created, str(binding["signal_id"])))
        try:
            written = self.outbox.add_many(rows)
        except sqlite3.Error as exc:
            if self.storage_error is None:
                logger.error("Cannot write samples to the outbox: %r", exc)
            self.storage_error = f"Outbox write failed: {exc}"[:240]
            return 0
        self.storage_error = None
        if written:
            self._unflushed += written
            self._flush_event.set()
        return written

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
                continue  # first read still in progress; nothing to report yet
            report[cid] = state
            if reset:
                self._state(cid)["samples"] = 0
        return report

    # ------------------------------------------------------------------ config

    def _save_snapshot(self, snapshot: dict[str, Any], revision: int, digest: str) -> None:
        if self.snapshot_path is None:
            return
        self.snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({"revision": revision, "checksum_sha256": digest, "snapshot": snapshot}, default=str).encode()
        temporary = self.snapshot_path.with_suffix(".tmp")
        with temporary.open("wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.snapshot_path)

    def _load_snapshot(self) -> tuple[dict[str, Any], int, str] | None:
        if self.snapshot_path is None or not self.snapshot_path.is_file():
            return None
        try:
            body = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Local configuration snapshot is unreadable: %r", exc)
            return None
        snapshot = body.get("snapshot")
        if not isinstance(snapshot, dict):
            return None
        digest = str(body.get("checksum_sha256") or "")
        if digest and checksum(snapshot) != digest:
            logger.warning("Local configuration snapshot failed its checksum; ignoring it")
            return None
        return snapshot, int(body.get("revision") or 0), digest or checksum(snapshot)

    async def load_local(self, *, start_jobs: bool = True) -> bool:
        local = self._load_snapshot()
        if local is None:
            return False
        snapshot, revision, digest = local
        await self.apply_snapshot(snapshot, revision, digest, start_jobs=start_jobs)
        logger.info("Started from local configuration revision %s", revision)
        return True

    async def sync_config(self, *, start_jobs: bool = True) -> bool:
        """Fetch the desired config; activate it when it differs. Returns True on activation."""
        params = {"known_revision": self.revision, "known_checksum": self.snapshot_checksum} if self.revision else None
        config = await self._request("GET", "/api/v1/edge-sync/config", params=params)
        self.config_ok = True
        if config.get("unchanged"):
            return False
        incoming = config.get("snapshot") if isinstance(config.get("snapshot"), dict) else None
        if incoming is None:
            return False
        revision = int(config.get("revision") or 0)
        active = int(config.get("active_revision") or 0)
        expected = str(config.get("checksum_sha256") or incoming.get("checksum_sha256") or "")
        if revision == self.revision and (not expected or expected == self.snapshot_checksum):
            if revision != active:
                # Applied earlier but the ACTIVE ack never reached Center.
                await self._ack(revision, "ACTIVE", "")
            return False
        if (revision, expected) == self._rejected:
            return False  # already reported FAILED for this exact release
        if expected and checksum(incoming) != expected:
            await self._reject(revision, expected, active, "Snapshot checksum mismatch.")
            return False
        digest = expected or checksum(incoming)
        try:
            _prepare(incoming)
            self._save_snapshot(incoming, revision, digest)
        except (ValueError, KeyError, TypeError, OSError) as exc:
            await self._reject(revision, expected, active, str(exc)[:240])
            return False
        await self.apply_snapshot(incoming, revision, digest, start_jobs=start_jobs)
        self.activation_error = None
        if revision != active:
            await self._ack(revision, "ACTIVE", "")
            logger.info("Activated configuration revision %s (%d job(s))", revision, len(self.specs))
            return True
        return False

    async def _reject(self, revision: int, expected: str, active: int, diagnostic: str) -> None:
        self.activation_error = diagnostic
        self._rejected = (revision, expected)
        logger.error("Configuration revision %s rejected: %s", revision, diagnostic)
        if revision != active:
            await self._ack(revision, "FAILED", diagnostic)

    async def _ack(self, revision: int, state: str, diagnostic: str) -> None:
        await self._request("POST", "/api/v1/edge-sync/ack", {"revision": revision, "state": state, "diagnostic": diagnostic})

    async def apply_snapshot(self, snapshot: dict[str, Any], revision: int, digest: str, *, start_jobs: bool = True) -> None:
        specs = build_specs(snapshot)
        rotated: set[str] = set()
        if revision != self.revision:
            self._secrets.clear()
            rotated = await self._rotated_secrets()
        allow = list(self.env_allowlist)
        for connection in snapshot.get("connections") or []:
            if connection.get("status") != "ARCHIVED":
                allow.extend(endpoints_for(str(connection.get("protocol") or ""), connection.get("config_json") or {}))
        self.allowlist[:] = allow  # keep the list object shared with the commissioner

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
        if start_jobs:
            for job_id, spec in specs.items():
                restart = job_id not in self.job_tasks or job_id not in old or old[job_id].fingerprint != spec.fingerprint
                if restart or spec.connection_id in rotated:
                    self._start_job(spec)

    async def _rotated_secrets(self) -> set[str]:
        """Connections whose connector holds a secret that changed in Center."""
        rotated: set[str] = set()
        for connection_id, (secret_ref, used) in list(self._baked_secrets.items()):
            if connection_id not in self.connectors:
                continue
            try:
                current = await self.secret(secret_ref)
            except ConnectorError as exc:
                logger.warning("Cannot re-check the secret of connection %s: %s", connection_id, exc)
                continue
            if current != used:
                logger.info("Secret of connection %s changed; reconnecting", connection_id)
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
            except Exception:  # noqa: BLE001 - a job bug must not stop other jobs
                logger.exception("Job %s crashed; restarting in 5 s", runner.spec.job_id)
                self.record_failure(runner.spec.connection_id, ConnectorError("INTERNAL", "Acquisition task crashed; restarting."))
                await asyncio.sleep(5)

    async def _stop_job(self, job_id: str) -> None:
        task = self.job_tasks.pop(job_id, None)
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # noqa: BLE001 - the task is gone either way
            logger.warning("Job %s ended with %r while stopping", job_id, exc)

    # ------------------------------------------------------------------ flush

    async def flush_once(self, budget_s: float = FLUSH_BUDGET_S) -> tuple[int, bool]:
        """Send pending rows: newest per signal first, then oldest history. Returns (acked, failed)."""
        deadline = time.monotonic() + budget_s
        acked = 0
        rows = self.outbox.latest_pending(BATCH_ROWS)
        if rows:
            count, ok = await self._send(rows, deadline)
            acked += count
            if not ok:
                return acked, True
        while time.monotonic() < deadline:
            rows = self.outbox.pending(BATCH_ROWS)
            if not rows:
                break
            count, ok = await self._send(rows, deadline)
            acked += count
            if not ok:
                return acked, True
            if len(rows) < BATCH_ROWS:
                break
        return acked, False

    async def _send(self, rows: list[Any], deadline: float) -> tuple[int, bool]:
        """POST one batch. Returns (acked, delivered_without_retryable_error)."""
        uids = [str(row["event_uid"]) for row in rows]
        items = [json.loads(row["payload"]) for row in rows]
        try:
            result = await self._request("POST", "/api/v1/edge-sync/observations", {"observations": items}, timeout=15.0)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            attempts = max(int(row["attempts"]) for row in rows) + 1
            poison = status in {400, 404, 409, 413, 422} or (status >= 500 and attempts >= self.max_attempts)
            if not poison:
                self.outbox.note_attempt(uids, self.max_attempts)
                logger.warning("Center rejected an observation batch with HTTP %s; will retry", status)
                return 0, False
            if len(rows) > 1 and time.monotonic() < deadline:
                middle = len(rows) // 2
                first, ok_first = await self._send(rows[:middle], deadline)
                second, ok_second = await self._send(rows[middle:], deadline)
                return first + second, ok_first and ok_second
            if len(rows) == 1:
                self.outbox.mark_state(uids, "DEAD")
                logger.error("Observation %s dead-lettered after HTTP %s", uids[0], status)
                return 0, True
            self.outbox.note_attempt(uids, self.max_attempts)
            return 0, False
        except httpx.HTTPError as exc:
            # Transport failure: Center unreachable. Not the rows' fault, so no attempt counting.
            logger.info("Observation flush failed: %r", exc)
            return 0, False
        results = {str(item.get("event_uid")): str(item.get("status") or "") for item in result.get("results", []) if isinstance(item, dict)}
        acked = [uid for uid in uids if results.get(uid) in {"committed", "duplicate"}]
        final = [uid for uid in uids if results.get(uid) and results[uid] not in {"committed", "duplicate"}]
        missing = [uid for uid in uids if uid not in results]
        self.outbox.mark_sent(acked)
        if final:
            self.outbox.mark_state(final, "QUARANTINED")
        if missing:
            self.outbox.note_attempt(missing, self.max_attempts)
        return len(acked), not missing

    # ------------------------------------------------------------------ heartbeat

    async def send_heartbeat(self) -> None:
        pending = self.outbox.pending_count()
        queues = {
            cid: {"pending": connector.queue_length, "dropped": connector.dropped}
            for cid, (_, connector) in self.connectors.items()
            if isinstance(connector, MqttConnector)
        }
        degraded = not self.config_ok or self.activation_error is not None or self.storage_error is not None
        await self._request(
            "POST",
            "/api/v1/edge-sync/heartbeat",
            {
                "health": "DEGRADED" if degraded else "ACTIVE",
                "software_version": SOFTWARE_VERSION,
                "outbox_pending": pending,
                "backlog": pending,
                "queues": queues,
                "connections": self.connection_report(reset=True),
                "config_revision": self.revision,
                "diagnostic": self.activation_error or self.storage_error,
            },
            timeout=10.0,
        )

    def _write_health(self, ok: bool) -> None:
        if self.health_path is None:
            return
        try:
            self.health_path.write_text(
                json.dumps({"ok": ok, "pending": self.outbox.pending_count(), "revision": self.revision, "at": now_iso()}),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning("Cannot write edge health file: %r", exc)

    # ------------------------------------------------------------------ loops

    async def _config_loop(self) -> None:
        while True:
            try:
                await self.sync_config()
            except httpx.HTTPError as exc:
                if self.config_ok:
                    logger.warning("Configuration fetch failed: %r", exc)
                self.config_ok = False
            await asyncio.sleep(self.config_s)

    async def _heartbeat_loop(self) -> None:
        next_due = time.monotonic()
        while True:
            ok = False
            try:
                await self.send_heartbeat()
                ok = True
            except httpx.HTTPError as exc:
                logger.info("Heartbeat failed: %r", exc)
            self._write_health(ok)
            next_due += self.heartbeat_s
            now = time.monotonic()
            if next_due < now:
                next_due = now
            await asyncio.sleep(next_due - now)

    async def _commands_loop(self) -> None:
        while True:
            if len(self._commands) < 4:
                try:
                    pulled = await self._request("GET", "/api/v1/edge-sync/commands")
                except httpx.HTTPError as exc:
                    logger.info("Command poll failed: %r", exc)
                    pulled = {}
                job = pulled.get("job")
                if job:
                    task = asyncio.create_task(self._run_command(job), name=f"command:{job.get('id')}")
                    self._commands.add(task)
                    task.add_done_callback(self._commands.discard)
                    continue  # another command may be queued
            await asyncio.sleep(self.commands_s)

    async def _run_command(self, job: dict[str, Any]) -> None:
        try:
            await self.commissioner.run(job)
        except CredentialRevoked:
            return
        except httpx.HTTPError as exc:
            logger.warning("Could not report commissioning result %s: %r", job.get("id"), exc)
        except Exception:  # noqa: BLE001 - one broken command must not stop the command loop
            logger.exception("Commissioning command %s failed", job.get("id"))

    async def _flusher_loop(self) -> None:
        backoff = 0.0
        while True:
            if backoff:
                await asyncio.sleep(backoff)
            else:
                await self._flush_event.wait()
            self._flush_event.clear()
            linger_end = time.monotonic() + LINGER_S
            while self._unflushed < BATCH_ROWS and time.monotonic() < linger_end:
                await asyncio.sleep(0.02)
            self._unflushed = 0
            _acked, failed = await self.flush_once()
            if failed:
                backoff = min(30.0, max(1.0, backoff * 2))
                continue
            backoff = 0.0
            if self.outbox.pending_count():
                self._flush_event.set()
                await asyncio.sleep(0)

    async def _maintenance_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            cutoff = iso_ms(datetime.now(timezone.utc) - ACKED_RETENTION)
            removed = self.outbox.prune(cutoff)
            dropped = self.outbox.enforce_cap(self.max_pending)
            if dropped:
                logger.error("Outbox above %d pending rows: %d oldest rows dropped", self.max_pending, dropped)
            if removed:
                logger.debug("Pruned %d delivered outbox rows", removed)

    async def _revocation_watch(self) -> None:
        await self._revoked.wait()
        raise CredentialRevoked("Center rejected the edge credential.")

    async def _supervise(self, name: str, factory: Callable[[], Coroutine[Any, Any, None]]) -> None:
        while True:
            try:
                await factory()
                return
            except (asyncio.CancelledError, CredentialRevoked):
                raise
            except Exception:  # noqa: BLE001 - restart the loop; never leave the edge without it
                logger.exception("Edge task %s crashed; restarting in 2 s", name)
                await asyncio.sleep(2)

    async def run(self) -> None:
        """Run until cancelled. Raises CredentialRevoked when Center rejects the credential."""
        await self.load_local()
        loops: dict[str, Callable[[], Coroutine[Any, Any, None]]] = {
            "config": self._config_loop,
            "heartbeat": self._heartbeat_loop,
            "commands": self._commands_loop,
            "flusher": self._flusher_loop,
            "maintenance": self._maintenance_loop,
        }
        tasks = [asyncio.create_task(self._supervise(name, fn), name=name) for name, fn in loops.items()]
        tasks.append(asyncio.create_task(self._revocation_watch(), name="revocation"))
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in done:
                if task.exception() is not None:
                    raise task.exception()  # type: ignore[misc]
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.close()

    async def close(self) -> None:
        for job_id in list(self.job_tasks):
            await self._stop_job(job_id)
        for task in list(self._commands):
            task.cancel()
        await asyncio.gather(*self._commands, return_exceptions=True)
        for connection_id in list(self.connectors):
            await self._close_connector(connection_id)

    # ------------------------------------------------------------------ one-shot diagnostic

    async def cycle(self) -> dict[str, Any]:
        """One pass without background tasks: config, one read of every POLL job, flush, heartbeat.

        Production uses ``run()``. This is for diagnostics and integration tests.
        """
        activated = False
        center_up = True
        try:
            activated = await self.sync_config(start_jobs=False)
        except httpx.HTTPError as exc:
            center_up = False
            logger.warning("Configuration fetch failed: %r", exc)
        if not self.specs:
            await self.load_local(start_jobs=False)
        reads = 0
        for spec in self.specs.values():
            if spec.subscribe:
                continue
            runner = JobRunner(spec, self)
            started = time.monotonic()
            try:
                samples = await bounded(runner.read_once(), timeout=read_budget_s(spec))
            except Exception as exc:  # noqa: BLE001 - recorded per connection like the job loop
                self.record_failure(spec.connection_id, as_connector_error(exc))
                continue
            written = self.emit(spec, samples)
            self.record_ok(spec.connection_id, int((time.monotonic() - started) * 1000), written)
            reads += written
        flushed = 0
        try:
            flushed, _ = await self.flush_once(budget_s=30.0)
        except httpx.HTTPError as exc:
            logger.warning("Flush failed: %r", exc)
        try:
            await self.send_heartbeat()
        except httpx.HTTPError as exc:
            center_up = False
            logger.warning("Heartbeat failed: %r", exc)
        return {"activated": activated, "reads": reads, "flushed": flushed, "pending": self.outbox.pending_count(), "center_up": center_up}
