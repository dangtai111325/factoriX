"""Explicit assignment of this local appliance; no implicit Site/Edge replacement."""

from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect
from factorix.modules.common import audit, execute, fetch_one, utcnow
from factorix.platform.after_commit import defer
from factorix.platform.errors import AppError
from factorix.platform.security import decrypt_secret, encrypt_secret, hash_token
from factorix.platform.settings import Settings


class ApplianceState(StrEnum):
    DISABLED = "DISABLED"
    AVAILABLE = "AVAILABLE"
    BOUND = "BOUND"
    QUEUED = "QUEUED"
    DELIVERY_PENDING = "DELIVERY_PENDING"
    EXPIRED = "EXPIRED"
    CREDENTIAL_MISSING = "CREDENTIAL_MISSING"
    CONFLICT = "CONFLICT"


class LocalApplianceFiles:
    def __init__(self, settings: Settings):
        directory = Path(settings.data_dir)
        self.credential_path = Path(settings.credential_path) if settings.credential_path else directory / "edge-credential"
        self.enrollment_path = Path(settings.enrollment_file) if settings.enrollment_file else directory / "enrollment"

    @staticmethod
    def _read(path: Path) -> str:
        try:
            with path.open("rb") as stream:
                raw = stream.read(8193)
            if len(raw) > 8192:
                raise ValueError("Oversized local identity file")
            return raw.decode("utf-8").strip()
        except FileNotFoundError:
            return ""
        except (OSError, ValueError) as exc:
            raise AppError(503, "APPLIANCE_STORAGE", "The local appliance identity files could not be read.") from exc

    def read(self) -> tuple[str, str]:
        return self._read(self.credential_path), self._read(self.enrollment_path)

    def publish(self, token: str, expected_hash: str | None) -> None:
        # An agent may have finished enrollment after the request committed.
        if self._read(self.credential_path):
            return
        current = self._read(self.enrollment_path)
        if current == token:
            return
        if (hash_token(current) if current else None) != expected_hash:
            raise OSError("The pending local enrollment changed before delivery.")
        self.enrollment_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".enrollment-", dir=self.enrollment_path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(token.encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.enrollment_path)
        finally:
            Path(temporary).unlink(missing_ok=True)


@dataclass
class _LocalState:
    state: ApplianceState
    edge: dict[str, Any] | None = None
    binding: dict[str, Any] | None = None
    legacy_token: str | None = field(default=None, repr=False)
    legacy_expires: datetime | None = None
    file_hash: str | None = None


class LocalAppliance:
    def __init__(self, session: AsyncSession, settings: Settings):
        self.session, self.settings = session, settings
        self.files = LocalApplianceFiles(settings)

    async def status(self, tenant_id: UUID) -> dict[str, Any]:
        if not self.settings.appliance or not self.settings.data_dir:
            return {"enabled": False, "available": False, "state": ApplianceState.DISABLED, "edge_id": None, "site_id": None}
        current = await self._inspect()
        own = current.edge is not None and current.edge["tenant_id"] == tenant_id
        return {
            "enabled": True, "available": current.state == ApplianceState.AVAILABLE, "state": current.state,
            "edge_id": str(current.edge["id"]) if own else None,
            "site_id": str(current.edge["site_id"]) if own else None,
        }

    async def request(self, tenant_id: UUID, actor: UUID, edge_id: UUID, correlation_id: str) -> dict[str, str]:
        if not self.settings.appliance or not self.settings.data_dir:
            raise AppError(404, "NOT_FOUND", "Local appliance enrollment is not enabled.")
        # One physical appliance per installation, across tenants and Site scopes.
        await execute(self.session, "SELECT pg_advisory_xact_lock(hashtextextended('factorix:local-appliance', 0))", {})
        target = await collect._owned_edge(self.session, tenant_id, edge_id)
        current = await self._inspect()
        if current.edge and current.edge["id"] != edge_id:
            raise AppError(409, "APPLIANCE_ASSIGNED", "This appliance is already assigned to another Edge or Site. Reassign it explicitly before enrolling here.")
        if current.state == ApplianceState.CONFLICT:
            raise AppError(409, "APPLIANCE_STATE_CONFLICT", "The local appliance identity is inconsistent. Resolve its assignment before enrolling.")
        if current.state == ApplianceState.BOUND:
            await self._reserve(edge_id, actor, None, None)
            return {"status": "already_enrolled"}
        if target["enrollment_status"] == "ENROLLED":
            raise AppError(409, "EDGE_ALREADY_ENROLLED", "This Edge is already enrolled. Its credential cannot be replaced by local appliance enrollment.")
        inactive = await fetch_one(self.session, """
            SELECT r.archived_at FROM sites s JOIN resources r ON r.id = s.resource_id
            WHERE s.id = :id AND s.tenant_id = :tenant_id
        """, {"id": target["site_id"], "tenant_id": tenant_id})
        if inactive and inactive["archived_at"] is not None:
            raise AppError(409, "ARCHIVED_SITE", "Restore this Site before enrolling its Edge.")
        if current.legacy_token:
            token, expires = current.legacy_token, current.legacy_expires
        elif current.binding and current.binding["token_expires_at"] and current.binding["token_expires_at"] > utcnow():
            token = decrypt_secret(self.settings.data_key, bytes(current.binding["token_ciphertext"]))
            expires = current.binding["token_expires_at"]
        else:
            issued = await collect.issue_enrollment(self.session, tenant_id, edge_id, actor, correlation_id)
            token = issued["enrollment_token"]
            expires = datetime.fromisoformat(issued["expires_at"].replace("Z", "+00:00"))
        await self._reserve(edge_id, actor, token, expires)
        await audit(self.session, tenant_id=tenant_id, actor_id=actor, event_type="APPLIANCE_ENROLL_REQUEST",
                    entity_type="edge", entity_id=edge_id, before=None, after={"status": "pending"}, correlation_id=correlation_id)

        async def deliver() -> None:
            await asyncio.to_thread(self.files.publish, token, current.file_hash)

        defer(self.session, deliver)
        # A durable request is acknowledged; status/heartbeat establish delivery/enrollment.
        return {"status": "pending"}

    async def _reserve(self, edge_id: UUID, actor: UUID, token: str | None, expires: datetime | None) -> None:
        await execute(self.session, """
            INSERT INTO appliance_bindings (slot, edge_id, token_ciphertext, token_hash, token_expires_at, requested_by, created_at, updated_at)
            VALUES ('local', :edge_id, :ciphertext, :hash, :expires, :actor, :now, :now)
            ON CONFLICT (slot) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext,
                token_hash = EXCLUDED.token_hash, token_expires_at = EXCLUDED.token_expires_at,
                requested_by = EXCLUDED.requested_by, updated_at = EXCLUDED.updated_at
            WHERE appliance_bindings.edge_id = EXCLUDED.edge_id
        """, {"edge_id": edge_id, "ciphertext": encrypt_secret(self.settings.data_key, token) if token else None,
              "hash": hash_token(token) if token else None, "expires": expires, "actor": actor, "now": utcnow()})

    async def _inspect(self) -> _LocalState:
        binding = await fetch_one(self.session, """
            SELECT e.id, e.tenant_id, e.site_id, e.enrollment_status,
                   b.token_ciphertext, b.token_hash, b.token_expires_at
            FROM appliance_bindings b JOIN edge_nodes e ON e.id = b.edge_id WHERE b.slot = 'local'
        """, {})
        credential, pending = await asyncio.to_thread(self.files.read)
        file_hash = hash_token(pending) if pending else None
        if credential:
            edge = await fetch_one(self.session, """
                SELECT id, tenant_id, site_id, enrollment_status FROM edge_nodes
                WHERE credential_hash = :hash AND enrollment_status = 'ENROLLED'
            """, {"hash": hash_token(credential)})
            if edge is None or (binding and binding["id"] != edge["id"]):
                return _LocalState(ApplianceState.CONFLICT, edge or binding, binding, file_hash=file_hash)
            return _LocalState(ApplianceState.BOUND, edge, binding, file_hash=file_hash)
        if pending:
            legacy = await fetch_one(self.session, """
                SELECT e.id, e.tenant_id, e.site_id, e.enrollment_status, t.used_at, t.expires_at
                FROM edge_enrollment_tokens t JOIN edge_nodes e ON e.id = t.edge_id WHERE t.token_hash = :hash
            """, {"hash": file_hash})
            if legacy is None or (binding and binding["id"] != legacy["id"]):
                return _LocalState(ApplianceState.CONFLICT, binding or legacy, binding, file_hash=file_hash)
            if legacy["used_at"] is not None and binding is None:
                return _LocalState(ApplianceState.CONFLICT, legacy, file_hash=file_hash)
            if legacy["used_at"] is None and legacy["expires_at"] > utcnow():
                return _LocalState(ApplianceState.QUEUED, legacy, binding, pending, legacy["expires_at"], file_hash)
        if binding:
            if binding["enrollment_status"] == "ENROLLED":
                state = ApplianceState.CREDENTIAL_MISSING
            elif binding["token_expires_at"] and binding["token_expires_at"] > utcnow():
                state = ApplianceState.DELIVERY_PENDING
            else:
                state = ApplianceState.EXPIRED
            return _LocalState(state, binding, binding, file_hash=file_hash)
        return _LocalState(ApplianceState.AVAILABLE, file_hash=file_hash)
