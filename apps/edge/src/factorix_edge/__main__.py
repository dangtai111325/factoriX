"""Long-running Edge process. Credential and allowlist come from the environment.

Enrollment: the credential file is used when present; otherwise the token from
``FACTORIX_ENROLLMENT_TOKEN`` or (appliance, ``FACTORIX_EDGE_WAIT=1``) the token file
``/data/enrollment`` is exchanged for a credential. When Center later answers 401 the
credential is deleted and the edge waits for a new enrollment token.
"""

from __future__ import annotations

import asyncio
import logging
import os
import stat
from pathlib import Path

import httpx

from factorix_edge.runtime import CredentialRevoked, EdgeRuntime
from factorix_edge.store.outbox import Outbox

logger = logging.getLogger("factorix_edge")

ENROLL_RETRY_S = 5.0
# Center writes the token right after the first connection creates the local edge; polling at
# 0.5 s lets the collector enroll within about a second, so the first "Save & test" runs (R2-CN-02).
TOKEN_POLL_S = 0.5


def _waiting() -> bool:
    return os.environ.get("FACTORIX_EDGE_WAIT") == "1"


def _enrollment_path() -> Path:
    return Path(os.environ.get("FACTORIX_ENROLLMENT_FILE", "/data/enrollment"))


def _read_credential(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except OSError as exc:
        logger.warning("Cannot read edge credential file: %r", exc)
        return ""


def _write_credential(path: Path, credential: str) -> None:
    """Write the credential readable by the owner only (0600), atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, credential.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, path)


def _secure_existing(path: Path) -> None:
    try:
        if path.exists() and stat.S_IMODE(path.stat().st_mode) & 0o077:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError as exc:
        logger.warning("Cannot restrict edge credential file permissions: %r", exc)


def _delete_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.error("Cannot delete %s: %r", path, exc)


async def _wait_for_token(credential_path: Path) -> str | None:
    """Return an enrollment token, or None when a credential file appeared meanwhile."""
    token = os.environ.get("FACTORIX_ENROLLMENT_TOKEN", "").strip()
    if token:
        return token
    if not _waiting():
        raise SystemExit("Missing FACTORIX_ENROLLMENT_TOKEN or credential file.")
    enroll_path = _enrollment_path()
    logged = False
    while True:
        if _read_credential(credential_path):
            return None
        try:
            token = enroll_path.read_text(encoding="utf-8").strip() if enroll_path.exists() else ""
        except OSError as exc:
            logger.warning("Cannot read enrollment token file: %r", exc)
            token = ""
        if token:
            return token
        if not logged:
            logger.info("Waiting for an enrollment token at %s", enroll_path)
            logged = True
        await asyncio.sleep(TOKEN_POLL_S)


async def obtain_credential(client: httpx.AsyncClient, credential_path: Path) -> str:
    while True:
        stored = _read_credential(credential_path)
        if stored:
            _secure_existing(credential_path)
            return stored
        token = await _wait_for_token(credential_path)
        if token is None:
            continue
        try:
            response = await client.post("/api/v1/edge-sync/enroll", json={"enrollment_token": token})
            response.raise_for_status()
            credential = str(response.json()["credential"])
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            if not _waiting():
                raise
            logger.warning("Enrollment failed (%r); retrying in %.0f s", exc, ENROLL_RETRY_S)
            os.environ.pop("FACTORIX_ENROLLMENT_TOKEN", None)
            await asyncio.sleep(ENROLL_RETRY_S)
            continue
        _write_credential(credential_path, credential)
        os.environ.pop("FACTORIX_ENROLLMENT_TOKEN", None)
        enroll_path = _enrollment_path()
        if _waiting() and enroll_path.exists():
            try:
                enroll_path.unlink()
            except OSError as exc:
                logger.warning("Cannot remove used enrollment token file: %r", exc)
        logger.info("Edge enrolled")
        return credential


async def main() -> None:
    center = os.environ.get("FACTORIX_CENTER_URL", "http://127.0.0.1:8000").rstrip("/")
    allow = [item.strip() for item in os.environ.get("FACTORIX_OT_ALLOWLIST", "").split(",") if item.strip()]
    outbox_path = Path(os.environ.get("FACTORIX_OUTBOX_PATH", "edge-data/outbox.sqlite"))
    credential_path = Path(os.environ.get("FACTORIX_CREDENTIAL_PATH", "edge-data/credential"))
    snapshot_path = Path(os.environ.get("FACTORIX_CONFIG_PATH", str(outbox_path.parent / "active-config.json")))
    health_path = Path(os.environ.get("FACTORIX_EDGE_HEALTH", str(outbox_path.parent / "edge-health.json")))
    outbox_path.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(base_url=center, timeout=20) as client:
        while True:
            credential = await obtain_credential(client, credential_path)
            # Reopen per enrollment: a reset may have removed the files under /data.
            outbox_path.parent.mkdir(parents=True, exist_ok=True)
            outbox = Outbox(outbox_path)
            runtime = EdgeRuntime(client, credential, allow, outbox, snapshot_path=snapshot_path, health_path=health_path)
            try:
                await runtime.run()
            except CredentialRevoked:
                logger.warning("Center rejected the edge credential; deleting it and waiting for a new enrollment")
                _delete_file(credential_path)
                # The active configuration belonged to the revoked identity.
                _delete_file(snapshot_path)
            finally:
                outbox.close()


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("FACTORIX_EDGE_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Per-request client logs would write several lines per second to the appliance log.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    asyncio.run(main())
