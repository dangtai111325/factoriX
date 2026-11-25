"""Phase A4 safety guards (R2-E §4): acquisition-mode defaults, edge-sync gone, revert_to_zero unreachable."""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from factorix.platform.errors import AppError

REPO = Path(__file__).resolve().parents[4]

EDGE_SYNC_CALLS = [
    ("POST", "/api/v1/edge-sync/enroll", {}),  # invalid body: the guard must answer before validation
    ("POST", "/api/v1/edge-sync/heartbeat", {"x": 1}),
    ("GET", "/api/v1/edge-sync/config", None),
    ("POST", "/api/v1/edge-sync/ack", {"revision": 1, "state": "ACTIVE"}),
    ("GET", "/api/v1/edge-sync/secrets/00000000-0000-0000-0000-000000000001", None),
    ("POST", "/api/v1/edge-sync/observations", {"observations": []}),
    ("GET", "/api/v1/edge-sync/commands", None),
    ("POST", "/api/v1/edge-sync/commands/00000000-0000-0000-0000-000000000001", {"status": "PASSED"}),
]


@pytest.fixture()
def app_in_mode(monkeypatch: pytest.MonkeyPatch):
    from factorix.transport import app as A

    touched: list[str] = []

    async def no_db():
        touched.append("db_session")
        yield SimpleNamespace()

    async def edge_principal(_session: Any, _token: Any) -> Any:
        raise AppError(401, "EDGE_UNAUTHORIZED", "No edge credential.")

    def set_mode(mode: str):
        monkeypatch.setattr(A, "settings", SimpleNamespace(collector_mode=mode, appliance=True, data_key="x" * 44, web_origin="http://localhost"))
        return A

    monkeypatch.setitem(A.app.dependency_overrides, A.db_session, no_db)
    monkeypatch.setattr(A.edge_sync, "edge_principal", edge_principal)
    monkeypatch.setattr(A.edge_sync, "enroll", edge_principal)
    yield set_mode, touched


@pytest.mark.parametrize(("method", "path", "body"), EDGE_SYNC_CALLS, ids=[c[1] for c in EDGE_SYNC_CALLS])
async def test_edge_sync_is_gone_in_acquisition_mode(app_in_mode, method: str, path: str, body: Any) -> None:
    set_mode, touched = app_in_mode
    A = set_mode("acquisition")
    async with AsyncClient(transport=ASGITransport(app=A.app), base_url="http://test") as client:
        response = await client.request(method, path, json=body, headers={"authorization": "Bearer stolen"})
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "EDGE_SYNC_DISABLED"
    assert touched == [], "the guard must answer before a database session is opened"


@pytest.mark.parametrize(("method", "path", "body"), EDGE_SYNC_CALLS[1:], ids=[c[1] for c in EDGE_SYNC_CALLS[1:]])
async def test_edge_sync_still_served_in_edge_mode(app_in_mode, method: str, path: str, body: Any) -> None:
    set_mode, _touched = app_in_mode
    A = set_mode("edge")
    async with AsyncClient(transport=ASGITransport(app=A.app), base_url="http://test") as client:
        response = await client.request(method, path, json=body)
    assert response.status_code == 401  # reached the handler: normal Edge authentication applies


async def test_revert_to_zero_raises_before_touching_the_database() -> None:
    from factorix.modules import identity

    class Untouchable:
        def __getattr__(self, name: str) -> Any:
            raise AssertionError(f"revert_to_zero touched session.{name}")

    with pytest.raises(AppError) as exc:
        await identity.revert_to_zero(Untouchable())  # type: ignore[arg-type]
    assert exc.value.status == 410 and exc.value.code == "ENDPOINT_GONE"


def test_no_truncate_cascade_left_in_identity() -> None:
    src = (REPO / "apps" / "center" / "src" / "factorix" / "modules" / "identity.py").read_text(encoding="utf-8")
    # Executable SQL only (the docstring explains what the former body did).
    assert 'f"TRUNCATE' not in src and "TRUNCATE TABLE {" not in src


def test_image_and_compose_default_to_acquisition_mode() -> None:
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r"^\s*FACTORIX_COLLECTOR_MODE=acquisition\s*\\?\s*$", dockerfile, re.M)
    compose = (REPO / "docker-compose.yml").read_text(encoding="utf-8")
    # Default acquisition; edge stays selectable through the project .env / shell for a deliberate rollback.
    assert "FACTORIX_COLLECTOR_MODE=${FACTORIX_COLLECTOR_MODE:-acquisition}" in compose


def test_settings_carry_no_personal_mail_defaults() -> None:
    from factorix.platform.settings import Settings

    for name in ("smtp_user", "smtp_from", "smtp_password"):
        assert Settings.model_fields[name].default == "", name
