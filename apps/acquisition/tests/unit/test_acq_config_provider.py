"""ConfigProvider, LkgSnapshotStore redaction/integrity, and PgSecretStore hash rotation."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from factorix.platform.security import encrypt_secret
from factorix_acquisition.config_provider import (
    ConfigProvider,
    LkgSnapshotStore,
    PgSecretStore,
    checksum,
    strip_sensitive,
    structure_digest,
)

DATA_KEY = os.environ["FACTORIX_DATA_KEY"]


def test_strip_sensitive_scrubs_credentials_recursively_before_lkg_save(tmp_path: Path) -> None:
    lkg_path = tmp_path / "lkg.json"
    store = LkgSnapshotStore(lkg_path)
    secret_ref = str(uuid4())
    snapshot: dict[str, Any] = {
        "schema_version": "fx.acquisition.config.v1",
        "revision": 3,
        "connections": [
            {
                "id": str(uuid4()),
                "tenant_id": str(uuid4()),
                "protocol": "http",
                "status": "ACTIVE",
                "secret_ref": secret_ref,
                "secret_hash": "abc123",
                "ciphertext": b"raw-bytes",
                "password": "SUPER_SECRET_PASSWORD",
                "config_json": {
                    "base_url": "http://127.0.0.1:8443",
                    "token": "SUPER_SECRET_TOKEN",
                    "headers": {"Authorization": "Bearer TOP_SECRET"},
                },
            }
        ],
        "jobs": [],
        "source_fields": [],
        "signal_bindings": [],
    }
    cleaned = strip_sensitive(snapshot)
    assert cleaned["connections"][0]["secret_ref"] == secret_ref
    assert "password" not in cleaned["connections"][0]
    assert "token" not in cleaned["connections"][0]["config_json"]
    assert "Authorization" not in cleaned["connections"][0]["config_json"]["headers"]

    store.save(snapshot, 3, "ignored")
    raw_text = lkg_path.read_text(encoding="utf-8")
    assert "SUPER_SECRET_PASSWORD" not in raw_text
    assert "SUPER_SECRET_TOKEN" not in raw_text
    assert "TOP_SECRET" not in raw_text

    loaded = store.load()
    assert loaded is not None
    loaded_snap, rev, _ = loaded
    assert rev == 3
    assert loaded_snap["connections"][0]["secret_ref"] == secret_ref


def test_lkg_rejects_corrupted_or_tampered_checksum(tmp_path: Path) -> None:
    lkg_path = tmp_path / "lkg.json"
    store = LkgSnapshotStore(lkg_path)
    snap = {"revision": 1, "connections": [], "jobs": [], "source_fields": [], "signal_bindings": []}
    store.save(snap, 1, checksum(snap))
    assert store.load() is not None

    lkg_path.write_text(lkg_path.read_text(encoding="utf-8").replace('"revision": 1', '"revision": 99'), encoding="utf-8")
    assert store.load() is None


def test_structure_digest_is_deterministic_across_issued_at() -> None:
    s1 = {"issued_at": "2026-11-10T00:00:00Z", "connections": [{"id": "c1"}], "jobs": [], "source_fields": [], "signal_bindings": []}
    s2 = {"issued_at": "2026-11-10T01:00:00Z", "connections": [{"id": "c1"}], "jobs": [], "source_fields": [], "signal_bindings": []}
    assert structure_digest(s1) == structure_digest(s2)


@pytest.mark.asyncio
async def test_config_provider_tracks_changes_and_saves_lkg(tmp_path: Path) -> None:
    box = {"rev": 1, "connections": []}

    async def loader(_conn: Any, prev_rev: int, prev_digest: str) -> dict[str, Any]:
        snap = {
            "revision": box["rev"],
            "connections": box["connections"],
            "jobs": [],
            "source_fields": [],
            "signal_bindings": [],
        }
        snap["structure_sha256"] = structure_digest(snap)
        snap["checksum_sha256"] = checksum(snap)
        return snap

    lkg = LkgSnapshotStore(tmp_path / "lkg.json")
    cfg = ConfigProvider(None, PgSecretStore(DATA_KEY), lkg, loader=loader)
    first = await cfg.fetch_if_changed()
    assert first.changed is True and first.revision == 1
    cfg.mark_applied(first.revision, first.digest, first.struct_hash)
    assert lkg.load() is not None

    unchanged = await cfg.fetch_if_changed()
    assert unchanged.changed is False

    box["rev"] = 2
    box["connections"] = [{"id": str(uuid4()), "protocol": "mqtt", "status": "ACTIVE", "config_json": {"host": "127.0.0.1"}}]
    second = await cfg.fetch_if_changed()
    assert second.changed is True and second.revision == 2


@pytest.mark.asyncio
async def test_secret_store_reconcile_detects_cipher_hash_rotation() -> None:
    values = {"s1": "first-secret"}

    async def fetcher(ref: str) -> tuple[bytes, str] | None:
        ct = encrypt_secret(DATA_KEY, values[ref])
        return ct, hashlib.sha256(ct).hexdigest()

    store = PgSecretStore(DATA_KEY, fetcher=fetcher, retry_delays_s=(0.0,))
    assert await store.get("s1") == "first-secret"
    h1 = store.cached_hash("s1")
    assert h1 is not None

    # Unchanged hash -> not flagged changed
    assert store.reconcile({"s1"}, {"s1": h1}) == set()
    # Rotated ciphertext hash in PG -> flagged changed and refreshed on next get()
    values["s1"] = "rotated-secret"
    assert store.reconcile({"s1"}, {"s1": "different-sha256"}) == {"s1"}
    assert await store.get("s1") == "rotated-secret"
