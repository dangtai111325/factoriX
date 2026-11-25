"""R2-E C2: ``application.health.health_service`` is the only writer of ``connections.health``.

Every other module submits evidence (acquisition report, Edge report, samples, sweep, operator
status) to it. The windowed semantics themselves are covered by ``test_connection_health_windowed.py``
and ``apps/acquisition/tests/unit/test_acq_leadership_and_health.py``.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

APPS = Path(__file__).resolve().parents[3]
SOURCES = [APPS / "center" / "src", APPS / "acquisition" / "src"]
OWNER = APPS / "center" / "src" / "factorix" / "application" / "health" / "health_service.py"

_UPDATE_RE = re.compile(r"UPDATE\s+connections\b(?:\s+c)?\s+SET\s+(.*?)(?:\bWHERE\b|\bFROM\b|$)", re.S | re.I)
_HEALTH_COLUMNS = re.compile(r"(?<![a-z_.])(health|last_error|last_success_at)\s*=", re.I)


def _health_writers() -> dict[Path, int]:
    found: dict[Path, int] = {}
    for root in SOURCES:
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for match in _UPDATE_RE.finditer(text):
                if _HEALTH_COLUMNS.search(match.group(1)):
                    found[path] = found.get(path, 0) + 1
    return found


def test_only_health_service_writes_connection_health() -> None:
    writers = _health_writers()
    assert set(writers) == {OWNER}, {str(p.relative_to(APPS)): n for p, n in writers.items()}
    assert writers[OWNER] >= 5  # report (asyncpg), samples (asyncpg + SQL), Edge report, sweep, operator, Edge drafts


def test_operator_status_updates_no_longer_touch_health() -> None:
    src = (APPS / "center" / "src" / "factorix" / "application" / "collector" / "connections.py").read_text(encoding="utf-8")
    assert src.count("await set_operator_state(session, connection_id,") == 3


class _Session:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []


@pytest.mark.parametrize(
    ("status", "health", "clears_error"),
    [("PAUSED", "PAUSED", False), ("ACTIVE", "UNKNOWN", True), ("ARCHIVED", "UNKNOWN", False)],
)
async def test_operator_state_health(monkeypatch: pytest.MonkeyPatch, status: str, health: str, clears_error: bool) -> None:
    from factorix.application.health import health_service as HS
    from factorix.modules import common

    session = _Session()

    async def execute(sess: _Session, sql: str, params: dict[str, Any]) -> None:
        sess.calls.append((sql, params))

    monkeypatch.setattr(common, "execute", execute)
    cid = uuid4()
    await HS.set_operator_state(session, cid, status)
    ((sql, params),) = session.calls
    assert params == {"health": health, "id": cid}
    assert ("last_error = NULL" in sql) is clears_error
