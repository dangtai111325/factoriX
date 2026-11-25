"""Appliance auto-enrollment of the built-in collector (legacy Edge identity) and its initial release. Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import collect
from factorix.domain.health import appliance_needs_enrollment
from factorix.modules.common import as_uuid, fetch_one, utcnow
from factorix.platform.security import hash_token

from factorix.transport.http.deps import _run_step, _settings, logger


def _appliance_paths() -> tuple[Path, Path]:
    cfg = _settings()
    data_dir = Path(cfg.data_dir)
    token_path = Path(os.environ.get("FACTORIX_ENROLLMENT_FILE") or (data_dir / "enrollment"))
    credential_path = Path(os.environ.get("FACTORIX_CREDENTIAL_PATH") or (data_dir / "edge-credential"))
    return token_path, credential_path


def _file_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip() if path.is_file() else ""
    except OSError:
        logger.warning("Cannot read %s", path, exc_info=True)
        return ""


def _write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid4().hex[:8]}.tmp")
    temp.write_text(content, encoding="utf-8")
    try:
        temp.chmod(0o600)
    except OSError:
        logger.debug("chmod not supported for %s", temp)
    os.replace(temp, path)


async def _ensure_appliance_enrollment(session: AsyncSession) -> None:
    """Appliance mode: keep an unused enrollment token in the shared data directory while the local
    edge is not genuinely enrolled (for example right after Revert-To-Zero, or after the edge
    discarded a credential that Center rejected)."""
    cfg = _settings()
    if not cfg.appliance or not cfg.data_dir:
        return
    edge = await fetch_one(
        session,
        """
        SELECT id, tenant_id, enrollment_status, credential_hash IS NOT NULL AS has_credential, last_heartbeat
        FROM edge_nodes WHERE enrollment_status <> 'REVOKED'
        ORDER BY created_at ASC LIMIT 1
        """,
        {},
    )
    if edge is None:
        return
    token_path, credential_path = _appliance_paths()
    token = _file_text(token_path)
    token_state = "MISSING"
    if token:
        valid = await fetch_one(
            session,
            """
            SELECT 1 AS ok FROM edge_enrollment_tokens
            WHERE token_hash = :hash AND edge_id = :edge_id AND used_at IS NULL AND expires_at > :soon
            """,
            {"hash": hash_token(token), "edge_id": edge["id"], "soon": utcnow() + timedelta(seconds=60)},
        )
        token_state = "VALID" if valid else "INVALID"
    if not appliance_needs_enrollment(
        edge=edge,
        credential_file_present=bool(_file_text(credential_path)),
        token_file_state=token_state,
        now=utcnow(),
    ):
        return
    tenant_id = as_uuid(edge["tenant_id"])
    admin_row = await fetch_one(session, "SELECT id FROM admin_accounts WHERE tenant_id = :tenant_id ORDER BY created_at ASC LIMIT 1", {"tenant_id": tenant_id})
    actor = as_uuid(admin_row["id"]) if admin_row else None
    issued = await collect.issue_enrollment(session, tenant_id, as_uuid(edge["id"]), actor, "appliance-enrollment")  # type: ignore[arg-type]
    await session.commit()  # the token must exist before the edge can read the file
    _write_private(token_path, str(issued["enrollment_token"]))
    logger.info("Wrote a new enrollment token for the local edge %s (previous token file: %s)", edge["id"], token_state)


async def _ensure_initial_release(session: AsyncSession) -> None:
    """Appliance boot: an edge with active connections but no published release gets one."""
    if not _settings().appliance:
        return
    edge = await fetch_one(session, "SELECT id, tenant_id FROM edge_nodes WHERE enrollment_status <> 'REVOKED' ORDER BY created_at ASC LIMIT 1", {})
    if edge is None:
        return
    edge_id = as_uuid(edge["id"])
    tenant_id = as_uuid(edge["tenant_id"])
    active_conns = await fetch_one(session, "SELECT count(*) AS cnt FROM connections WHERE edge_id = :edge_id AND status = 'ACTIVE'", {"edge_id": edge_id})
    has_release = await fetch_one(session, "SELECT count(*) AS cnt FROM configuration_releases WHERE edge_id = :edge_id AND status = 'PUBLISHED'", {"edge_id": edge_id})
    if int((active_conns or {}).get("cnt") or 0) > 0 and int((has_release or {}).get("cnt") or 0) == 0:
        admin_row = await fetch_one(session, "SELECT id FROM admin_accounts WHERE tenant_id = :tenant_id ORDER BY created_at ASC LIMIT 1", {"tenant_id": tenant_id})
        actor = as_uuid(admin_row["id"]) if admin_row else None
        await collect.publish_release(session, tenant_id, actor, collect.ReleaseIn(edge_id=str(edge_id)), "appliance-boot-release")  # type: ignore[arg-type]


async def _appliance_auto_enroll() -> None:
    cfg = _settings()
    if not cfg.appliance or not cfg.data_dir or cfg.collector_mode == "acquisition":
        return
    await _run_step("appliance_initial_release", _ensure_initial_release)
    await _run_step("appliance_enrollment", _ensure_appliance_enrollment)
