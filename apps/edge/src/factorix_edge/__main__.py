"""Long-running Edge loop. Credential and allowlist come from the environment."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx

from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


async def _credential(client: httpx.AsyncClient, path: Path) -> str:
    if path.exists():
        stored = path.read_text(encoding="utf-8").strip()
        if stored:
            return stored
    token = os.environ.get("FACTORIX_ENROLLMENT_TOKEN", "").strip()
    if not token:
        raise SystemExit("Thiếu FACTORIX_ENROLLMENT_TOKEN hoặc file credential.")
    response = await client.post("/api/v1/edge-sync/enroll", json={"enrollment_token": token})
    response.raise_for_status()
    credential = str(response.json()["credential"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(credential, encoding="utf-8")
    return credential


async def _wait_for_enrollment(credential_path: Path) -> None:
    if os.environ.get("FACTORIX_EDGE_WAIT") != "1":
        return
    if credential_path.exists() and credential_path.read_text(encoding="utf-8").strip():
        return
    enroll_path = Path(os.environ.get("FACTORIX_ENROLLMENT_FILE", "/data/enrollment"))
    while True:
        if credential_path.exists() and credential_path.read_text(encoding="utf-8").strip():
            return
        token = enroll_path.read_text(encoding="utf-8").strip() if enroll_path.exists() else ""
        if token:
            os.environ["FACTORIX_ENROLLMENT_TOKEN"] = token
            return
        await asyncio.sleep(2)


async def main() -> None:
    center = os.environ.get("FACTORIX_CENTER_URL", "http://127.0.0.1:8000").rstrip("/")
    allow = [item.strip() for item in os.environ.get("FACTORIX_OT_ALLOWLIST", "").split(",") if item.strip()]
    outbox_path = Path(os.environ.get("FACTORIX_OUTBOX_PATH", "edge-data/outbox.sqlite"))
    credential_path = Path(os.environ.get("FACTORIX_CREDENTIAL_PATH", "edge-data/credential"))
    outbox_path.parent.mkdir(parents=True, exist_ok=True)
    await _wait_for_enrollment(credential_path)
    outbox = Outbox(outbox_path)
    async with httpx.AsyncClient(base_url=center, timeout=20) as client:
        while True:
            try:
                credential = await _credential(client, credential_path)
                break
            except (SystemExit, httpx.HTTPError, OSError):
                if os.environ.get("FACTORIX_EDGE_WAIT") != "1":
                    raise
                os.environ.pop("FACTORIX_ENROLLMENT_TOKEN", None)
                await asyncio.sleep(2)
                await _wait_for_enrollment(credential_path)
        enroll_path = Path(os.environ.get("FACTORIX_ENROLLMENT_FILE", "/data/enrollment"))
        if os.environ.get("FACTORIX_EDGE_WAIT") == "1" and enroll_path.exists():
            enroll_path.unlink()
        runtime = EdgeRuntime(
            client,
            credential,
            allow,
            outbox,
            snapshot_path=Path(os.environ.get("FACTORIX_CONFIG_PATH", str(outbox_path.parent / "active-config.json"))),
        )
        health_path = Path(os.environ.get("FACTORIX_EDGE_HEALTH", str(outbox_path.parent / "edge-health.json")))
        while True:
            ok = False
            try:
                await runtime.cycle()
                ok = True
            except Exception:
                ok = False
            try:
                health_path.write_text(json.dumps({"ok": ok, "pending": runtime.outbox.pending_count()}), encoding="utf-8")
            except OSError:
                pass
            await asyncio.sleep(float(os.environ.get("FACTORIX_EDGE_INTERVAL_S", "1")))


if __name__ == "__main__":
    asyncio.run(main())
