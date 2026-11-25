"""B-12 / OP-14: bulk jobs survive an API restart (reported INTERRUPTED with their progress) and the FAILED-outbox
queries behind "N with write errors" are served by a partial index instead of scanning the outbox."""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.modules import storage_bulk as SBULK

TENANT = UUID("00000000-0000-0000-0000-000000000001")
REPO = Path(__file__).resolve().parents[4]
MIGRATION = REPO / "apps" / "center" / "migrations" / "versions" / "0014_bulk_jobs_failed_idx.py"


class _Session:
    def __init__(self, log: list[tuple[str, dict[str, Any]]]) -> None:
        self.log = log
        self.commits = 0

    async def __aenter__(self) -> "_Session":
        return self

    async def __aexit__(self, *_a: Any) -> None:
        return None

    async def execute(self, statement: Any, params: dict[str, Any] | None = None, *_a: Any, **_kw: Any) -> Any:
        self.log.append((" ".join(str(statement).split()), dict(params or {})))

    async def commit(self) -> None:
        self.commits += 1


def _job(status: str = "RUNNING") -> dict[str, Any]:
    return {"job_id": str(uuid4()), "tenant_id": str(TENANT), "status": status, "total": 120, "done": 50,
            "summary": {"CREATED": 50}, "items": [{"name": "state_001", "status": "CREATED"}], "timing_ms": {"total": 9.5},
            "error": None, "created_at": "2026-11-25T08:00:00.000Z", "started_at": "2026-11-25T08:00:01.000Z",
            "finished_at": None, "_finished_mono": None}


async def test_persist_job_upserts_progress_and_never_raises() -> None:
    log: list[tuple[str, dict[str, Any]]] = []
    sessions = lambda: _Session(log)  # noqa: E731
    job = _job()
    await SBULK._persist_job(sessions, job)
    sql, params = log[0]
    assert sql.startswith("INSERT INTO storage_bulk_jobs") and "ON CONFLICT (id) DO UPDATE" in sql
    assert params["status"] == "RUNNING" and params["done"] == 50 and params["total"] == 120
    assert json.loads(params["items"]) == job["items"] and params["process_id"] == SBULK.PROCESS_ID
    assert params["started_at"] == datetime(2026, 11, 25, 8, 0, 1, tzinfo=timezone.utc)

    class _Broken:
        async def __aenter__(self) -> Any:
            raise RuntimeError('relation "storage_bulk_jobs" does not exist')

        async def __aexit__(self, *_a: Any) -> None:
            return None

    await SBULK._persist_job(lambda: _Broken(), job)  # before migration 0014: logged, the job goes on


def _row(status: str, **kw: Any) -> dict[str, Any]:
    base = {"id": uuid4(), "tenant_id": TENANT, "status": status, "total": 120, "done": 50,
            "summary_json": {"CREATED": 50}, "items_json": json.dumps([{"name": "state_001", "status": "CREATED"}]),
            "timing_json": {}, "error": None, "created_at": datetime(2026, 11, 25, 8, 0, tzinfo=timezone.utc),
            "started_at": None, "finished_at": None}
    base.update(kw)
    return base


@pytest.mark.parametrize("status", ["QUEUED", "RUNNING"])
async def test_job_of_a_dead_process_is_reported_interrupted(monkeypatch: pytest.MonkeyPatch, status: str) -> None:
    row = _row(status)

    async def fetch_one(_s: Any, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        assert "FROM storage_bulk_jobs" in sql and params["tenant_id"] == TENANT
        return row if params["id"] == row["id"] else None

    monkeypatch.setattr(SBULK, "fetch_one", fetch_one)
    job = await SBULK.load_job(object(), TENANT, str(row["id"]))
    assert job is not None and job["status"] == "INTERRUPTED" and job["interrupted"] is True
    assert job["error"].startswith("The Center restarted while this job was running; 50 of 120 rows were processed.")
    assert job["items"] == [{"name": "state_001", "status": "CREATED"}] and job["progress_pct"] == pytest.approx(41.7)
    assert await SBULK.load_job(object(), TENANT, str(uuid4())) is None
    assert await SBULK.load_job(object(), TENANT, "not-a-uuid") is None


async def test_finished_stored_job_keeps_its_status_and_missing_table_is_a_404(monkeypatch: pytest.MonkeyPatch) -> None:
    done = _row("DONE", done=120, finished_at=datetime(2026, 11, 25, 8, 1, tzinfo=timezone.utc))

    async def fetch_one(_s: Any, _sql: str, _p: dict[str, Any]) -> dict[str, Any]:
        return done

    monkeypatch.setattr(SBULK, "fetch_one", fetch_one)
    job = await SBULK.load_job(object(), TENANT, str(done["id"]))
    assert job["status"] == "DONE" and job["error"] is None and job["finished_at"] == "2026-11-25T08:01:00.000Z"

    async def no_table(*_a: Any) -> Any:
        raise RuntimeError("relation does not exist")

    monkeypatch.setattr(SBULK, "fetch_one", no_table)
    assert await SBULK.load_job(object(), TENANT, str(done["id"])) is None


async def test_list_merges_live_and_stored_jobs(monkeypatch: pytest.MonkeyPatch) -> None:
    stored = _row("RUNNING")

    async def fetch_all(_s: Any, sql: str, _p: dict[str, Any]) -> list[dict[str, Any]]:
        assert "ORDER BY created_at DESC" in sql
        return [stored]

    monkeypatch.setattr(SBULK, "fetch_all", fetch_all)
    jobs = await SBULK.load_jobs(object(), TENANT)
    mine = [j for j in jobs if j["job_id"] == str(stored["id"])]
    assert mine and mine[0]["status"] == "INTERRUPTED" and "items" not in mine[0]


def test_migration_0014_creates_the_job_table_and_a_partial_failed_index() -> None:
    spec = importlib.util.spec_from_file_location("m0014", MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    assert (mod.revision, mod.down_revision) == ("0014_bulk_jobs_failed_idx", "0013_dashboard_studio")
    src = MIGRATION.read_text(encoding="utf-8")
    assert "CREATE TABLE IF NOT EXISTS storage_bulk_jobs" in src and "'INTERRUPTED'" in src
    assert mod.FAILED_INDEX == "idx_storage_record_outbox_failed"
    assert "CREATE INDEX CONCURRENTLY IF NOT EXISTS {FAILED_INDEX}" in src
    assert "WHERE status = 'FAILED'" in src and "autocommit_block" in src


def test_failed_outbox_queries_match_the_partial_index_predicate() -> None:
    """The KPI / Error filter / failures list all filter ``tenant_id = … AND status = 'FAILED'`` (index-servable)."""
    for rel in ("modules/storage_topology.py", "transport/http/routers/storage/bindings_recording.py"):
        src = (REPO / "apps" / "center" / "src" / "factorix" / rel).read_text(encoding="utf-8")
        assert "x.tenant_id = :tenant_id AND x.status = 'FAILED'" in src, rel
