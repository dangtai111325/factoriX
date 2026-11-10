"""PostgreSQL direct control-plane ConfigProvider, LeaderLock, NotifyListener, and SecretStore.

Replaces HTTP polling against Center /edge-sync/* with direct repeatable-read PostgreSQL
snapshots, PostgreSQL LISTEN/NOTIFY wakeups, session advisory leader locking (F-26),
encrypted secret decryption with in-RAM caching, and a stripped Last-Known-Good (LKG)
disk snapshot for transient PG restarts.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import UUID

import asyncpg

from factorix.domain.network import AllowedEndpoint, NetworkPolicyError, endpoint_from_url
from factorix.platform.security import decrypt_secret
from factorix_acquisition.connectors.errors import ConnectorError
from factorix_acquisition.jobs import build_specs
from factorix_acquisition.timeutil import now_iso

logger = logging.getLogger(__name__)

DEFAULT_LOCK_KEY = 4_103_928_172_635
SECRET_RETRY_DELAYS_S = (0.25, 0.5, 1.0)
SENSITIVE_LKG_KEYS = frozenset(
    {
        "ciphertext",
        "secret",
        "password",
        "passwd",
        "token",
        "api_key",
        "apikey",
        "private_key",
        "authorization",
        "auth_header",
        "data_key",
    }
)


def to_asyncpg_dsn(dsn: str) -> str:
    text = str(dsn or "").strip()
    if text.startswith("postgresql+asyncpg://"):
        return "postgresql://" + text[len("postgresql+asyncpg://") :]
    if text.startswith("postgres+asyncpg://"):
        return "postgresql://" + text[len("postgres+asyncpg://") :]
    return text


def json_val(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return {}
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return value
    return value


def strip_sensitive(value: Any) -> Any:
    """Recursively strip credential/secret fields before writing local LKG snapshots."""
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k)
            lower = key.lower()
            if lower in SENSITIVE_LKG_KEYS:
                continue
            cleaned[key] = strip_sensitive(v)
        return cleaned
    if isinstance(value, list):
        return [strip_sensitive(item) for item in value]
    return value


def checksum(snapshot: dict[str, Any]) -> str:
    body = {key: value for key, value in snapshot.items() if key not in {"checksum_sha256", "issued_at"}}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def structure_digest(snapshot: dict[str, Any]) -> str:
    body = {
        "connections": snapshot.get("connections") or [],
        "jobs": snapshot.get("jobs") or [],
        "source_fields": snapshot.get("source_fields") or [],
        "signal_bindings": snapshot.get("signal_bindings") or [],
        "formulas": snapshot.get("formulas") or [],
        "tenant_epochs": snapshot.get("tenant_epochs") or {},
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def validate_snapshot(snapshot: dict[str, Any]) -> None:
    if not isinstance(snapshot.get("connections"), list):
        raise ValueError("Snapshot is missing connections list.")
    build_specs(snapshot)


def endpoints_for(protocol: str, config: dict[str, Any]) -> list[AllowedEndpoint]:
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


async def _table_exists(conn: asyncpg.Connection, qualified_name: str) -> bool:
    res = await conn.fetchval("SELECT to_regclass($1) IS NOT NULL", qualified_name)
    return bool(res)


async def load_pg_snapshot(conn: asyncpg.Connection, *, prev_revision: int = 0, prev_digest: str = "") -> dict[str, Any]:
    """Read an atomic repeatable-read configuration snapshot directly from PostgreSQL."""
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        conn_rows = await conn.fetch(
            """
            SELECT c.id, c.tenant_id, c.site_id, c.edge_id, c.protocol, c.name, c.endpoint_redacted,
                   c.secret_ref, encode(sha256(s.ciphertext), 'hex') AS secret_hash,
                   c.config_json, c.status, c.version
            FROM connections c
            LEFT JOIN secret_store s ON s.id = c.secret_ref
            WHERE c.status <> 'ARCHIVED'
            ORDER BY c.id
            """
        )
        connections = [
            {
                "id": str(r["id"]),
                "tenant_id": str(r["tenant_id"]),
                "site_id": str(r["site_id"]) if r["site_id"] else None,
                "edge_id": str(r["edge_id"]) if r["edge_id"] else None,
                "protocol": str(r["protocol"]),
                "name": str(r["name"]),
                "endpoint_redacted": r["endpoint_redacted"],
                "secret_ref": str(r["secret_ref"]) if r["secret_ref"] else None,
                "secret_hash": str(r["secret_hash"]) if r["secret_hash"] else None,
                "config_json": strip_sensitive(json_val(r["config_json"]) or {}),
                "status": str(r["status"]),
                "version": int(r["version"] or 1),
            }
            for r in conn_rows
        ]

        job_rows = await conn.fetch(
            """
            SELECT j.id, j.connection_id, j.mode, j.interval_ms, j.timeout_ms, j.enabled,
                   j.schedule_json, j.concurrency_limit, j.config_revision, j.version
            FROM acquisition_jobs j
            JOIN connections c ON c.id = j.connection_id
            WHERE c.status <> 'ARCHIVED'
            ORDER BY j.id
            """
        )
        jobs = [
            {
                "id": str(r["id"]),
                "connection_id": str(r["connection_id"]),
                "mode": str(r["mode"]),
                "interval_ms": r["interval_ms"],
                "timeout_ms": int(r["timeout_ms"] or 3000),
                "enabled": bool(r["enabled"]),
                "schedule_json": json_val(r["schedule_json"]),
                "concurrency_limit": int(r["concurrency_limit"] or 1),
                "config_revision": int(r["config_revision"] or 1),
                "version": int(r["version"] or 1),
            }
            for r in job_rows
        ]

        field_rows = await conn.fetch(
            """
            SELECT f.id, f.acquisition_job_id, f.address_kind, f.address_json,
                   f.native_datatype, f.decode_json, f.ordinal
            FROM source_fields f
            JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
            JOIN connections c ON c.id = j.connection_id
            WHERE c.status <> 'ARCHIVED'
            ORDER BY f.acquisition_job_id, COALESCE(f.ordinal, 0), f.id
            """
        )
        source_fields = [
            {
                "id": str(r["id"]),
                "acquisition_job_id": str(r["acquisition_job_id"]),
                "address_kind": str(r["address_kind"]),
                "address_json": json_val(r["address_json"]) or {},
                "native_datatype": str(r["native_datatype"]),
                "decode_json": json_val(r["decode_json"]) or {},
                "ordinal": int(r["ordinal"] or 0),
            }
            for r in field_rows
        ]

        binding_rows = await conn.fetch(
            """
            SELECT b.id AS binding_id, b.signal_id, b.source_field_id, b.transform_chain_json,
                   b.revision, s.tenant_id, s.key, s.resource_id, s.data_type, s.unit
            FROM signal_bindings b
            JOIN signal_definitions s ON s.id = b.signal_id
            JOIN source_fields f ON f.id = b.source_field_id
            JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
            JOIN connections c ON c.id = j.connection_id
            WHERE b.enabled = TRUE AND b.valid_to IS NULL AND s.status = 'ACTIVE' AND c.status <> 'ARCHIVED'
            ORDER BY b.signal_id
            """
        )
        signal_bindings = [
            {
                "id": str(r["binding_id"]),
                "signal_id": str(r["signal_id"]),
                "source_field_id": str(r["source_field_id"]),
                "transform_chain_json": json_val(r["transform_chain_json"]) or [],
                "revision": int(r["revision"] or 1),
                "tenant_id": str(r["tenant_id"]),
                "key": str(r["key"]),
                "resource_id": str(r["resource_id"]),
                "data_type": str(r["data_type"]),
                "unit": r["unit"],
            }
            for r in binding_rows
        ]

        formula_rows = await conn.fetch(
            """
            SELECT f.signal_id, f.expression_source, f.revision, f.temporal_policy_json
            FROM formula_definitions f
            JOIN signal_definitions s ON s.id = f.signal_id
            WHERE f.status = 'PUBLISHED' AND s.status = 'ACTIVE'
            ORDER BY f.signal_id
            """
        )
        formulas = [
            {
                "signal_id": str(r["signal_id"]),
                "expression_source": str(r["expression_source"]),
                "revision": int(r["revision"] or 1),
                "temporal_policy_json": json_val(r["temporal_policy_json"]) or {},
            }
            for r in formula_rows
        ]

        tenant_epochs: dict[str, int] = {}
        for item in connections:
            tenant_epochs.setdefault(item["tenant_id"], 1)
        for item in signal_bindings:
            tenant_epochs.setdefault(item["tenant_id"], 1)
        if await _table_exists(conn, "public.telemetry_generations"):
            epoch_rows = await conn.fetch("SELECT tenant_id, active_epoch FROM telemetry_generations ORDER BY tenant_id")
            for r in epoch_rows:
                tenant_epochs[str(r["tenant_id"])] = max(1, int(r["active_epoch"] or 1))

        db_release_rev = 0
        if await _table_exists(conn, "public.configuration_releases"):
            db_release_rev = int(await conn.fetchval("SELECT COALESCE(MAX(revision), 0) FROM configuration_releases") or 0)

    payload: dict[str, Any] = {
        "schema_version": "fx.acquisition.config.v1",
        "revision": 0,
        "issued_at": now_iso(),
        "connections": connections,
        "jobs": jobs,
        "source_fields": source_fields,
        "signal_bindings": signal_bindings,
        "formulas": formulas,
        "tenant_epochs": tenant_epochs,
        "security_policy_revision": 1,
    }
    struct_hash = structure_digest(payload)
    max_entity_rev = max(
        [db_release_rev]
        + [int(c["version"]) for c in connections]
        + [int(j["config_revision"]) for j in jobs]
        + [int(b["revision"]) for b in signal_bindings],
        default=1,
    )
    if prev_digest and struct_hash == prev_digest and prev_revision > 0:
        revision = prev_revision
    elif prev_revision > 0 and max_entity_rev <= prev_revision and struct_hash != prev_digest:
        revision = prev_revision + 1
    else:
        revision = max(1, max_entity_rev)
    payload["revision"] = revision
    payload["structure_sha256"] = struct_hash
    payload["checksum_sha256"] = checksum(payload)
    return payload


class PgSecretStore:
    """Decrypts connection secrets directly from PG secret_store and caches in RAM only."""

    def __init__(
        self,
        data_key: str,
        pool: asyncpg.Pool | None = None,
        *,
        fetcher: Callable[[str], Awaitable[tuple[bytes, str] | None]] | None = None,
        retry_delays_s: tuple[float, ...] = SECRET_RETRY_DELAYS_S,
    ) -> None:
        self._data_key = data_key
        self._pool = pool
        self._fetcher = fetcher
        self._retry_delays = retry_delays_s
        self._cache: dict[str, tuple[str, str]] = {}  # secret_ref -> (cipher_hash, plaintext)
        self._stale: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}

    def set_pool(self, pool: asyncpg.Pool | None) -> None:
        self._pool = pool

    def cached_value(self, secret_ref: str) -> str | None:
        entry = self._cache.get(secret_ref)
        return entry[1] if entry else None

    def cached_hash(self, secret_ref: str) -> str | None:
        entry = self._cache.get(secret_ref)
        return entry[0] if entry else None

    def reconcile(self, referenced_refs: set[str], expected_hashes: dict[str, str] | None = None) -> set[str]:
        """Drop unreferenced refs; return refs whose hash changed in PostgreSQL."""
        for ref in [r for r in self._cache if r not in referenced_refs]:
            self._cache.pop(ref, None)
            self._stale.discard(ref)
        changed: set[str] = set()
        for ref in self._cache:
            if expected_hashes and ref in expected_hashes:
                if expected_hashes[ref] != self._cache[ref][0]:
                    self._stale.add(ref)
                    changed.add(ref)
            else:
                self._stale.add(ref)
        return changed

    async def get(self, secret_ref: str) -> str:
        ref = str(secret_ref)
        cached = self._cache.get(ref)
        if cached is not None and ref not in self._stale:
            return cached[1]
        lock = self._locks.setdefault(ref, asyncio.Lock())
        async with lock:
            cached = self._cache.get(ref)
            if cached is not None and ref not in self._stale:
                return cached[1]
            entry = await self._fetch_with_retry(ref, cached)
            self._cache[ref] = entry
            self._stale.discard(ref)
            return entry[1]

    async def _fetch_once(self, ref: str) -> tuple[bytes, str] | None:
        if self._fetcher is not None:
            return await self._fetcher(ref)
        if self._pool is None:
            raise ConnectorError("CENTER", "PostgreSQL pool is not ready for secret lookup.")
        try:
            uid = UUID(ref)
        except ValueError as exc:
            raise ConnectorError("AUTH", f"Invalid secret reference: {ref}") from exc
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT ciphertext, encode(sha256(ciphertext), 'hex') AS cipher_hash FROM secret_store WHERE id = $1",
                uid,
            )
        if row is None:
            return None
        return bytes(row["ciphertext"]), str(row["cipher_hash"])

    async def _fetch_with_retry(self, ref: str, cached: tuple[str, str] | None) -> tuple[str, str]:
        attempt = 0
        last_exc: BaseException | None = None
        while True:
            try:
                result = await self._fetch_once(ref)
            except ConnectorError:
                raise
            except Exception as exc:  # noqa: BLE001 - transient PG error retried with RAM fallback
                last_exc = exc
                if attempt >= len(self._retry_delays):
                    if cached is not None:
                        logger.warning("Cannot re-read secret %s from PostgreSQL (%r); using cached value", ref, exc)
                        return cached
                    raise ConnectorError("CENTER", "Cannot fetch the connection secret from PostgreSQL.") from exc
                await asyncio.sleep(self._retry_delays[attempt])
                attempt += 1
                continue
            if result is None:
                self._cache.pop(ref, None)
                self._stale.discard(ref)
                raise ConnectorError("AUTH", "The connection secret is not available in secret_store.")
            ciphertext, cipher_hash = result
            try:
                plaintext = decrypt_secret(self._data_key, ciphertext)
            except Exception as exc:  # noqa: BLE001
                raise ConnectorError("AUTH", "The connection secret could not be decrypted.") from exc
            return cipher_hash, plaintext


class LkgSnapshotStore:
    """Atomic, secret-stripped Last-Known-Good disk snapshot for transient PG restarts."""

    def __init__(self, path: Path | None) -> None:
        self.path = path

    def save(self, snapshot: dict[str, Any], revision: int, digest: str) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        clean_snap = strip_sensitive(snapshot)
        clean_snap["checksum_sha256"] = checksum(clean_snap)
        body = json.dumps(
            {
                "revision": int(revision),
                "checksum_sha256": clean_snap["checksum_sha256"],
                "structure_sha256": structure_digest(clean_snap),
                "snapshot": clean_snap,
            },
            default=str,
        ).encode("utf-8")
        temp = self.path.with_suffix(".tmp")
        with temp.open("wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, self.path)

    def load(self) -> tuple[dict[str, Any], int, str] | None:
        if self.path is None or not self.path.is_file():
            return None
        try:
            body = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("LKG configuration snapshot unreadable: %r", exc)
            return None
        snapshot = body.get("snapshot")
        if not isinstance(snapshot, dict):
            return None
        digest = str(body.get("checksum_sha256") or "")
        computed = checksum(snapshot)
        if digest and computed != digest:
            logger.warning("LKG configuration snapshot checksum mismatch; ignoring it")
            return None
        return snapshot, int(body.get("revision") or 0), digest or computed


class PgLeaderLock:
    """PostgreSQL session advisory lock gatekeeper (F-26 dual-worker active/standby)."""

    def __init__(self, dsn: str, lock_key: int = DEFAULT_LOCK_KEY) -> None:
        self.dsn = to_asyncpg_dsn(dsn)
        self.lock_key = int(lock_key)
        self._conn: asyncpg.Connection | None = None
        self._is_leader = False

    @property
    def is_leader(self) -> bool:
        return self._is_leader and self._conn is not None and not self._conn.is_closed()

    async def probe(self) -> bool:
        """Maintain or attempt acquisition of the session advisory lock. Never raises."""
        try:
            if self._conn is None or self._conn.is_closed():
                self._is_leader = False
                self._conn = await asyncpg.connect(self.dsn, timeout=5.0)
            if self._is_leader:
                held = await self._conn.fetchval(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted)"
                )
                self._is_leader = bool(held)
                if self._is_leader:
                    return True
            acquired = await self._conn.fetchval("SELECT pg_try_advisory_lock($1)", self.lock_key)
            self._is_leader = bool(acquired)
            return self._is_leader
        except Exception as exc:  # noqa: BLE001 - standby or transient PG hiccup demotes safely
            logger.warning("Advisory lock probe failed (%r); demoting to standby", exc)
            await self.release()
            return False

    async def release(self) -> None:
        self._is_leader = False
        conn = self._conn
        self._conn = None
        if conn is not None and not conn.is_closed():
            try:
                await conn.execute("SELECT pg_advisory_unlock_all()")
            except Exception:  # noqa: BLE001
                pass
            try:
                await conn.close()
            except Exception:  # noqa: BLE001
                pass


class PgNotifyListener:
    """Dedicated asyncpg LISTEN/NOTIFY subscriber waking config, commissioning, and epoch loops (<100ms)."""

    def __init__(self, dsn: str) -> None:
        self.dsn = to_asyncpg_dsn(dsn)
        self.config_event = asyncio.Event()
        self.commissioning_event = asyncio.Event()
        self.epoch_event = asyncio.Event()
        self._conn: asyncpg.Connection | None = None
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop.clear()
            self._task = asyncio.create_task(self._run(), name="pg-notify-listener")

    async def close(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._close_conn()

    async def _close_conn(self) -> None:
        conn = self._conn
        self._conn = None
        if conn is not None and not conn.is_closed():
            try:
                await conn.close()
            except Exception:  # noqa: BLE001
                pass

    def _on_config(self, *_args: Any) -> None:
        self.config_event.set()

    def _on_commissioning(self, *_args: Any) -> None:
        self.commissioning_event.set()

    def _on_epoch(self, *_args: Any) -> None:
        self.epoch_event.set()
        self.config_event.set()

    async def _run(self) -> None:
        backoff = 0.5
        while not self._stop.is_set():
            try:
                conn = await asyncpg.connect(self.dsn, timeout=5.0)
                self._conn = conn
                await conn.add_listener("factorix_config_changed", self._on_config)
                await conn.add_listener("factorix_commissioning", self._on_commissioning)
                await conn.add_listener("factorix_epoch_changed", self._on_epoch)
                # Wake immediately on connect/reconnect so changes during reconnect are picked up.
                self.config_event.set()
                self.commissioning_event.set()
                self.epoch_event.set()
                backoff = 0.5
                while not self._stop.is_set() and not conn.is_closed():
                    await asyncio.sleep(5.0)
                    await conn.execute("SELECT 1")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("PG LISTEN/NOTIFY connection lost (%r); reconnecting in %.1fs", exc, backoff)
                await self._close_conn()
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(10.0, backoff * 2)


@dataclass(slots=True)
class ConfigUpdate:
    changed: bool
    snapshot: dict[str, Any] | None = None
    revision: int = 0
    digest: str = ""
    struct_hash: str = ""
    source: str = "pg"


class ConfigProvider:
    """Loads snapshots from PostgreSQL with LKG fallback and secret-store integration."""

    def __init__(
        self,
        pool: asyncpg.Pool | None,
        secret_store: PgSecretStore,
        lkg: LkgSnapshotStore | None = None,
        *,
        loader: Callable[[asyncpg.Connection | None, int, str], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self.pool = pool
        self.secrets = secret_store
        self.lkg = lkg or LkgSnapshotStore(None)
        self._loader = loader
        self.revision = 0
        self.snapshot_checksum = ""
        self.structure_hash = ""
        self.last_error: str | None = None

    def set_pool(self, pool: asyncpg.Pool | None) -> None:
        self.pool = pool
        self.secrets.set_pool(pool)

    async def fetch_if_changed(self) -> ConfigUpdate:
        if self.pool is None and self._loader is None:
            raise RuntimeError("PostgreSQL pool is not connected.")
        if self.pool is not None:
            async with self.pool.acquire() as conn:
                if self._loader is not None:
                    snapshot = await self._loader(conn, self.revision, self.structure_hash)
                else:
                    snapshot = await load_pg_snapshot(conn, prev_revision=self.revision, prev_digest=self.structure_hash)
        else:
            assert self._loader is not None
            snapshot = await self._loader(None, self.revision, self.structure_hash)
        validate_snapshot(snapshot)
        struct_hash = str(snapshot.get("structure_sha256") or structure_digest(snapshot))
        digest = str(snapshot.get("checksum_sha256") or checksum(snapshot))
        rev = int(snapshot.get("revision") or 1)
        self.last_error = None
        if struct_hash == self.structure_hash and rev == self.revision and self.revision > 0:
            return ConfigUpdate(changed=False, revision=rev, digest=digest, struct_hash=struct_hash, source="pg")
        self.lkg.save(snapshot, rev, digest)
        return ConfigUpdate(changed=True, snapshot=snapshot, revision=rev, digest=digest, struct_hash=struct_hash, source="pg")

    def mark_applied(self, revision: int, digest: str, struct_hash: str) -> None:
        self.revision = revision
        self.snapshot_checksum = digest
        self.structure_hash = struct_hash

    def load_lkg(self) -> ConfigUpdate | None:
        loaded = self.lkg.load()
        if loaded is None:
            return None
        snapshot, rev, digest = loaded
        validate_snapshot(snapshot)
        struct_hash = str(snapshot.get("structure_sha256") or structure_digest(snapshot))
        return ConfigUpdate(changed=True, snapshot=snapshot, revision=rev, digest=digest, struct_hash=struct_hash, source="lkg")
