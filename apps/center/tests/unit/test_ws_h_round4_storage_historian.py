"""WS-H round 4 (v6): Storage / Historian backend fixes from R2-D user E2E and ARCH-B §10.5.

R2-03 recorded picker (server-side search/paging), R2-05 batched bulk create, R2-06/B-12 database
detail, R2-07 write-error objects, R2-09 machine tag check, R2-12 recording summary, R2-13 nullable,
R2-14 bulk inference, R2-15 inverted range, R2-17 recorded-in hint, R2-24 source time, B-09 route
order, B-10/B-11 identifiers from URLs, B-14 one missing-object matcher.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.modules import historian_recorded as HR
from factorix.modules import historian_service as HS
from factorix.modules import historian_sources as HSRC
from factorix.modules import storage_bindings as SB
from factorix.modules import storage_bulk as SBULK
from factorix.modules import storage_objects as SO
from factorix.modules import storage_revisions as SR
from factorix.modules import storage_topology as ST
from factorix.platform.errors import AppError
from factorix.platform.tdengine import is_missing_object_error
from factorix.transport.http.routers.storage import td_objects as TDO

TENANT = UUID("9ed2d4e8-1f0c-46f9-a9e0-d25a18492265")
DB = f"fx_t_{TENANT.hex}"
MODEL = uuid4()
MACHINE_A = str(uuid4())
MACHINE_B = str(uuid4())
LINE = str(uuid4())
SIG_STATUS = str(uuid4())

E1 = [
    {"name": "ts", "td_type": "TIMESTAMP"}, {"name": "event_key", "td_type": "VARCHAR", "length": 64, "primary_key": True},
    {"name": "quality", "td_type": "VARCHAR", "length": 16}, {"name": "value_i64", "td_type": "BIGINT"},
    {"name": "value_f64", "td_type": "DOUBLE"},
]
TAGS = [{"name": "machine_ref", "length": 36}, {"name": "line_ref", "length": 36}, {"name": "field_key", "length": 64}]
SPEC = {"version": 2, "root": {"type": "object", "children": [
    {"type": "field", "key": "status", "mode": "mapping", "ref": {"signal_id": SIG_STATUS}, "value_type": "int"},
    {"type": "field", "key": "mode", "mode": "mapping", "ref": {"signal_id": str(uuid4())}, "value_type": "int"},
    {"type": "field", "key": "speed", "mode": "calculated", "expr": "1", "value_type": "auto"},
]}}
RESOURCES = {
    MACHINE_A: {"id": MACHINE_A, "parent_id": LINE, "name": "AA10-01", "code": "AA10-01", "type_key": "machine"},
    MACHINE_B: {"id": MACHINE_B, "parent_id": LINE, "name": "ZZ test M", "code": "ZZ", "type_key": "machine"},
    LINE: {"id": LINE, "parent_id": None, "name": "Line A1", "code": "A1", "type_key": "line"},
}


class Session:
    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        pass

    def begin_nested(self) -> Any:
        class _Ctx:
            async def __aenter__(self_inner) -> None:
                return None

            async def __aexit__(self_inner, *exc: Any) -> bool:
                return False
        return _Ctx()


class Pg:
    """SQL fake shared by storage_revisions / storage_bindings / storage_bulk."""

    def __init__(self) -> None:
        self.executed: list[str] = []
        self.bindings: list[dict[str, Any]] = []
        self.ops: list[dict[str, Any]] = []
        self.model_resource: str | None = MACHINE_A

    async def fetch_one(self, _s: Any, sql: str, p: dict[str, Any]) -> dict[str, Any] | None:
        low = " ".join(sql.lower().split())
        if low.startswith("insert into storage_objects"):
            return {"id": p["id"]}
        return None

    async def fetch_all(self, _s: Any, sql: str, p: dict[str, Any]) -> list[dict[str, Any]]:
        low = " ".join(sql.lower().split())
        if "from output_groups" in low:
            return [{"id": MODEL, "display_name": "AA10-01 · State", "kind": "STATE", "version": 1,
                     "spec_json": SPEC, "resource_id": self.model_resource}]
        if "from storage_bindings" in low:
            return self.bindings
        if "from storage_operations" in low:
            return self.ops
        return []

    async def execute(self, _s: Any, sql: str, p: dict[str, Any]) -> None:
        self.executed.append(" ".join(sql.lower().split()))


class Td:
    """TDengine fake: DESCRIBE of the parent, IN-list existence/verification, multi-table CREATE."""

    def __init__(self, existing: set[str] | None = None, reject_multi: bool = False) -> None:
        self.tables: dict[str, dict[str, Any]] = {n: {"stable": "st_state", "tags": {}} for n in (existing or set())}
        self.reads: list[str] = []
        self.ddl: list[str] = []
        self.reject_multi = reject_multi

    async def query_rows(self, sql: str) -> list[dict[str, Any]]:
        self.reads.append(sql)
        if sql.startswith("DESCRIBE"):
            rows = [{"field": c["name"], "type": c["td_type"], "length": c.get("length") or 8,
                     "note": "COMPOSITE KEY" if c.get("primary_key") else ""} for c in E1]
            return rows + [{"field": t["name"], "type": "VARCHAR", "length": t["length"], "note": "TAG"} for t in TAGS]
        names = re.findall(r"'([A-Za-z0-9_]+)'", sql.split(" IN (")[1]) if " IN (" in sql else []
        if "ins_stables" in sql:
            return []
        if "ins_tags" in sql:
            return [{"table_name": n, "tag_name": k, "tag_value": v} for n in names if n in self.tables
                    for k, v in self.tables[n]["tags"].items()]
        if "ins_tables" in sql:
            return [{"table_name": n, "stable_name": self.tables[n]["stable"], "n": n} for n in names if n in self.tables]
        return []

    async def execute_sql(self, sql: str) -> int:
        self.ddl.append(sql)
        parts = re.findall(r"`[^`]+`\.`([^`]+)` USING `[^`]+`\.`([^`]+)` \(([^)]*)\) TAGS \(([^)]*)\)", sql)
        if len(parts) > 1 and self.reject_multi:
            raise RuntimeError("[0x2617] multi create rejected")
        for name, stable, tag_names, tag_vals in parts:
            keys = [k.strip(" `") for k in tag_names.split(",")]
            vals = [v.strip(" '") for v in tag_vals.split(",")]
            self.tables[name] = {"stable": stable, "tags": dict(zip(keys, vals, strict=True))}
        return 0


@pytest.fixture
def pg(monkeypatch: pytest.MonkeyPatch) -> Pg:
    db = Pg()
    for mod in (SR, SB, SBULK):
        monkeypatch.setattr(mod, "fetch_one", db.fetch_one, raising=False)
        monkeypatch.setattr(mod, "fetch_all", db.fetch_all, raising=False)
        monkeypatch.setattr(mod, "execute", db.execute, raising=False)

    async def resources(_s: Any, _t: Any) -> dict[str, dict[str, Any]]:
        return RESOURCES

    async def sig_map(_s: Any, _t: Any) -> dict[str, str]:
        return {SIG_STATUS.lower(): MACHINE_A}

    monkeypatch.setattr(SB, "load_resource_index", resources)
    monkeypatch.setattr(SB, "signal_resource_map", sig_map)
    return db


def _row(name: str, path: str = "status", machine: str = MACHINE_A, column: str = "value_i64") -> dict[str, Any]:
    return {"database": DB, "stable": "st_state", "name": name,
            "tag_values": {"machine_ref": machine, "line_ref": LINE, "field_key": path},
            "bindings": [{"source_kind": "model_field", "model_id": str(MODEL), "field_path": path, "column_name": column}],
            "recording": {"mode": "ON_CHANGE", "start_recording": True}}


async def _resolve(name: str | None) -> str:
    return name or DB


# ---------------------------------------------------------------------------------------------
# R2-05 / R2-04: batched bulk create
# ---------------------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bulk_creates_a_chunk_with_one_create_statement_and_reports_each_row(pg: Pg):
    td = Td(existing={"state_old"})
    session = Session()
    res = await SBULK.BulkSubtableCreator(SR.StorageRevisionService(td)).run(
        session, TENANT, None, [_row("state_a", "status"), _row("state_b", "mode"), _row("state_old", "status")],
        dry_run=False, resolve_db=_resolve)
    statuses = {i["name"]: i["status"] for i in res["items"]}
    assert statuses == {"state_a": "CREATED", "state_b": "CREATED", "state_old": "EXISTS"}
    assert len(td.ddl) == 1 and td.ddl[0].count(" USING ") == 2  # one multi-table CREATE
    assert "IF NOT EXISTS" not in td.ddl[0]
    assert all(i.get("operation_id") and i.get("object_id") for i in res["items"] if i["status"] == "CREATED")
    assert res["summary"] == {"CREATED": 2, "EXISTS": 1}
    # 1 DESCRIBE + 2 existence + 2 verification reads for the whole chunk (was ~8 per row)
    assert len(td.reads) <= 5
    assert session.commits == 2  # operations + registry (was 6 per row)
    assert sum(1 for s in pg.executed if s.startswith("insert into storage_bindings")) == 2
    assert set(res["timing_ms"]) >= {"resolve", "existence", "validate", "operations", "ddl", "verify", "register", "total"}


@pytest.mark.asyncio
async def test_bulk_one_owner_per_field_inside_the_chunk_and_dry_run(pg: Pg):
    svc = SR.StorageRevisionService(Td())
    res = await SBULK.BulkSubtableCreator(svc).run(
        Session(), TENANT, None, [_row("state_a", "status"), _row("state_dup", "status")], dry_run=True, resolve_db=_resolve)
    by = {i["name"]: i for i in res["items"]}
    assert by["state_a"]["status"] == "VALID" and by["state_a"]["ddl"][0].startswith("CREATE TABLE")
    assert by["state_dup"]["status"] == "INVALID" and by["state_dup"]["code"] == "FIELD_ALREADY_RECORDED"


@pytest.mark.asyncio
async def test_bulk_retries_row_by_row_when_the_multi_statement_is_rejected(pg: Pg):
    td = Td(reject_multi=True)
    res = await SBULK.BulkSubtableCreator(SR.StorageRevisionService(td)).run(
        Session(), TENANT, None, [_row("state_a", "status"), _row("state_b", "mode")], dry_run=False, resolve_db=_resolve)
    assert [i["status"] for i in res["items"]] == ["CREATED", "CREATED"]
    assert len(td.ddl) == 3  # rejected multi + 2 single


@pytest.mark.asyncio
async def test_bulk_tenant_check_failure_is_reported_per_row(pg: Pg):
    async def deny(_name: str | None) -> str:
        raise AppError(404, "NOT_FOUND", "Database not found")

    res = await SBULK.BulkSubtableCreator(SR.StorageRevisionService(Td())).run(
        Session(), TENANT, None, [_row("state_a")], dry_run=False, resolve_db=deny)
    assert res["items"][0]["status"] == "FAILED" and res["items"][0]["code"] == "NOT_FOUND"


# ---------------------------------------------------------------------------------------------
# R2-09: machine tag must be the bound source's machine
# ---------------------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_machine_tag_of_another_machine_is_rejected(pg: Pg):
    res = await SBULK.BulkSubtableCreator(SR.StorageRevisionService(Td())).run(
        Session(), TENANT, None, [_row("state_x", machine=MACHINE_B), _row("state_ok", "mode")], dry_run=True, resolve_db=_resolve)
    bad, ok = res["items"]
    assert bad["status"] == "INVALID" and bad["code"] == "TAG_MACHINE_MISMATCH"
    assert "ZZ test M" in bad["message"] and "AA10-01" in bad["message"] and bad["errors"][0]["expected"] == MACHINE_A
    assert ok["status"] == "VALID"  # the line tag is not a machine: not checked
    pg.model_resource = None  # machine unknown -> derived from the mapped signal's resource (AA10-01)
    again = await SR.StorageRevisionService(Td()).machine_tag_errors(
        Session(), TENANT, SR.subtable_spec_from(_row("s", machine=MACHINE_B)),
        [{"model_id": str(MODEL), "model_field_path": "status"}])
    assert again and again[0]["code"] == "TAG_MACHINE_MISMATCH"


# ---------------------------------------------------------------------------------------------
# B-09: the draft PATCH route is reachable (registered before the generic object PATCH)
# ---------------------------------------------------------------------------------------------

def test_patch_draft_route_wins_over_the_generic_object_patch():
    from starlette.routing import Match

    from factorix.transport.storage_api import build_router

    router = build_router(admin=lambda: {}, db_session=lambda: None, td_client=object())
    scope = {"type": "http", "method": "PATCH", "path": f"/api/v1/storage/td/objects/drafts/{uuid4()}", "root_path": ""}
    first = next(r for r in router.routes if r.matches(scope)[0] == Match.FULL)
    assert first.endpoint.__name__ == "patch_storage_draft"


# ---------------------------------------------------------------------------------------------
# R2-06 / B-12 / R2-13 / R2-12 / B-10 / B-11 / B-14
# ---------------------------------------------------------------------------------------------

def test_database_detail_uses_tdengine_values_and_retention_parsing(monkeypatch):
    async def reg(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {"display_name": "MES history", "description": "d", "status": "ACTIVE", "revision": 3}

    monkeypatch.setattr(TDO, "_registry", reg)
    d = ST.DatabaseInfo(name="mes_hist", precision="us", replica=1, quorum=None, keep="30d,30d,30d", vgroups=2,
                        ntables=10, cache_model="none", is_tenant=False, stable_count=2, subtable_count=8)
    import asyncio
    out = asyncio.run(TDO._database_payload(None, TENANT, d))
    assert (out["retention_days"], out["vgroups"], out["display_name"], out["owner"]) == (30, 2, "MES history", "user")
    assert out["object_id"] == "db:mes_hist" and "cache_mb" not in out and "drift_status" not in out
    assert TDO._retention_days("5256000m,5256000m,5256000m") == 3650 and TDO._retention_days("") is None


def test_object_id_db_prefix_is_the_database_not_none():
    assert ST.parse_canonical_object_id("db:fx_t_abc") == ("database", "fx_t_abc", None)


@pytest.mark.asyncio
async def test_describe_reports_real_nullable():
    class C:
        async def query_rows(self, _sql: str) -> list[dict[str, Any]]:
            return [{"field": "ts", "type": "TIMESTAMP", "length": 8, "note": ""},
                    {"field": "event_key", "type": "VARCHAR", "length": 64, "note": "COMPOSITE KEY"},
                    {"field": "stop_error", "type": "VARCHAR", "length": 64, "note": ""},
                    {"field": "machine_ref", "type": "VARCHAR", "length": 36, "note": "TAG"}]

    cols, tags = await ST.StorageTopologyInspector(td_client=C())._describe_stable("db1", "st1")
    assert [(c.name, c.nullable) for c in cols] == [("ts", False), ("event_key", False), ("stop_error", True)]
    assert [TDO._column_payload(c)["nullable"] for c in cols] == [False, False, True]


def test_paused_subtable_bindings_are_not_shown_active_and_drift_is_computed():
    eff = TDO._effective_bindings([{"status": "ACTIVE"}, {"status": "RETIRED"}], "PAUSED")
    assert [b["effective_status"] for b in eff] == ["PAUSED", "RETIRED"]
    col = ST.ColumnInfo("ts", "TIMESTAMP", 8, "time_key", False)
    assert TDO._drift({}, [col], False) == "UNMANAGED"
    assert TDO._drift({"schema_json": [{"name": "ts"}]}, [col], False) == "OK"
    assert TDO._drift({"schema_json": [{"name": "x"}]}, [col], False) == "SCHEMA_MISMATCH"
    assert TDO._drift({}, [col], True) == "SYSTEM"


def test_url_identifiers_are_validated_before_sql():
    with pytest.raises(AppError) as err:
        TDO._checked_name("x' OR '1'='1", "table name")
    assert err.value.status == 404
    assert TDO._checked_name("state_aa10_01_status", "table name") == "state_aa10_01_status"


def test_one_missing_object_matcher():
    from factorix.application.reset import inventory

    assert TDO._is_missing_td_error is is_missing_object_error and inventory._is_missing_td_error is is_missing_object_error
    assert is_missing_object_error(RuntimeError("[0x2603] Table does not exist"))
    assert not is_missing_object_error(RuntimeError("connection refused"))


# ---------------------------------------------------------------------------------------------
# R2-03 / R2-17: recorded tables, searched on the server
# ---------------------------------------------------------------------------------------------

def _rec_rows(n: int) -> list[dict[str, Any]]:
    rows = []
    for i in range(n):
        machine = MACHINE_A if i % 2 == 0 else MACHINE_B
        rows.append({"binding_id": uuid4(), "source_kind": "model_field", "model_id": MODEL,
                     "model_field_path": "status" if i == 0 else f"f{i}", "signal_id": None, "target_column": "value_i64",
                     "binding_status": "ACTIVE", "source_data_type": "int", "physical_db": DB,
                     "physical_name": f"state_{i:03d}", "parent_name": "st_state", "display_name": None,
                     "object_status": "ACTIVE", "tags_json": {"machine_ref": machine, "line_ref": LINE},
                     "model_name": "AA10-01 · State", "model_resource_id": None, "spec_json": SPEC,
                     "signal_key": None, "signal_resource_id": None, "unit": None})
    return rows


@pytest.mark.asyncio
async def test_recorded_search_pages_all_tables_and_finds_any_of_them(pg: Pg, monkeypatch):
    rows = _rec_rows(324)

    async def fa(_s: Any, sql: str, _p: Any) -> list[dict[str, Any]]:
        return rows

    monkeypatch.setattr(HR, "fetch_all", fa)
    first = await HR.search_recorded(None, TENANT, page_size=100)
    assert first["total"] == 324 and len(first["items"]) == 100 and first["has_more"]
    assert {m["name"]: m["count"] for m in first["machines"]} == {"AA10-01": 162, "ZZ test M": 162}
    hit = await HR.search_recorded(None, TENANT, q="state_323")
    assert hit["total"] == 1 and hit["items"][0]["token"] == f"subtable:{DB}.state_323:value_i64"
    only_a = await HR.search_recorded(None, TENANT, machine_id=MACHINE_A, page=2, page_size=100)
    assert only_a["total"] == 162 and len(only_a["items"]) == 62
    where = await HR.recorded_for_signals(None, TENANT, [SIG_STATUS])
    assert [w["token"] for w in where[SIG_STATUS.lower()]] == [f"subtable:{DB}.state_000:value_i64"]


# ---------------------------------------------------------------------------------------------
# R2-14 / R2-15 / R2-24
# ---------------------------------------------------------------------------------------------

def test_bulk_defaults_prefix_type_and_column():
    assert SBULK.suggested_subtable_prefix("st_production_order_change") == "order_"
    assert SBULK.suggested_subtable_prefix("st_machine_state_change") == "state_"
    assert SB.infer_value_type("auto", "int64", True, 2.0) == ("int", "signal")
    assert SB.infer_value_type("auto", None, True, "P-01") == ("string", "live_value")
    assert SB.infer_value_type("float", "int64", True, 1) == ("float", "declared")
    assert SB.infer_value_type("auto", None, False, None) == (None, None)
    assert SB.suggest_value_column("string", SB.TEMPLATE_VALUE_COLUMNS) == "value_text"
    assert SB.mapping_signals(SPEC) == {"status": SIG_STATUS.lower(), "mode": SPEC["root"]["children"][1]["ref"]["signal_id"].lower()}


def test_inverted_range_is_an_error_not_15_minutes():
    end = datetime(2026, 11, 18, 7, 0, tzinfo=timezone.utc)
    with pytest.raises(AppError) as err:
        HS._parse_time_bounds(end.isoformat(), (end - timedelta(hours=1)).isoformat())
    assert err.value.code == "INVALID_RANGE"


@pytest.mark.asyncio
async def test_raw_reads_carry_source_time():
    seen: list[str] = []
    ts = datetime(2026, 11, 18, 7, 0, tzinfo=timezone.utc)

    class C:
        async def query_rows(self, sql: str) -> list[dict[str, Any]]:
            seen.append(sql)
            return [{"ts": ts, "value": 1.5, "quality": "GOOD", "source_time": ts - timedelta(seconds=1)}]

    src = HSRC.SeriesSource(kind="signal", key="sig", value_type="float64")
    info = await HS._read_table_series(
        HSRC.TableSeriesReader(C()), src, db="db1", table="op_float64_x", value_col="val", start_dt=ts - timedelta(minutes=5),
        end_dt=ts + timedelta(seconds=1), epoch=1, resolution="auto", max_points=10, cursor=None, bucket_ms=None,
        record_kind="RAW_OPERATIONAL", schema=HSRC.operational_schema("float64"))
    assert "`source_time` AS `source_time`" in seen[0]
    assert info["points"][0]["source_time"] == "2026-11-18T06:59:59.000Z"


# ---------------------------------------------------------------------------------------------
# WS-P P6: no PostgreSQL transaction open while TDengine is written; bounded prune; bulk job
# ---------------------------------------------------------------------------------------------

class _Sessions:
    """Session factory that knows how many sessions are open (one session = one transaction)."""

    def __init__(self) -> None:
        self.open = 0
        self.commits = 0

    def __call__(self) -> Any:
        outer = self

        class _S:
            async def __aenter__(self) -> Any:
                outer.open += 1
                return self

            async def __aexit__(self, *exc: Any) -> bool:
                outer.open -= 1
                return False

            async def commit(self) -> None:
                outer.commits += 1

            async def rollback(self) -> None:
                pass

            def begin_nested(self) -> Any:
                return Session().begin_nested()
        return _S()


@pytest.mark.asyncio
async def test_dispatcher_writes_tdengine_with_no_transaction_open(monkeypatch):
    from factorix.modules import storage_model_recorder as REC

    sessions = _Sessions()
    sql_seen: list[str] = []

    async def fetch_all(_s: Any, sql: str, _p: Any) -> list[dict[str, Any]]:
        sql_seen.append(" ".join(sql.split()))
        return [{"id": 2, "tenant_id": TENANT, "physical_db": DB, "physical_subtable": "t", "event_key": "k",
                 "data_epoch": 1, "payload_json": {}, "attempts": 0, "active_epoch": 1}]

    async def execute(_s: Any, sql: str, _p: Any) -> None:
        sql_seen.append(" ".join(sql.split()))

    monkeypatch.setattr(REC, "fetch_all", fetch_all)
    monkeypatch.setattr(REC, "execute", execute)
    d = REC.RecordingDispatcher(session_factory=sessions)
    d.td = object()

    async def write(rows: list[Any]) -> tuple[list[Any], list[Any], list[Any]]:
        assert sessions.open == 0, "a PostgreSQL session/transaction is open during the TDengine write"
        return [r["id"] for r in rows], [], []

    monkeypatch.setattr(d, "_write", write)
    assert await d.run_once() == 1
    claim = sql_seen[0]
    assert "FOR UPDATE SKIP LOCKED" in claim and "next_attempt_at = now() + make_interval" in claim and "RETURNING" in claim
    assert any(s.startswith("UPDATE storage_record_outbox SET status = 'CONFIRMED'") for s in sql_seen)
    assert sessions.commits == 2  # claim, then mark


@pytest.mark.asyncio
async def test_prune_deletes_in_bounded_batches(monkeypatch):
    from factorix.modules import storage_model_recorder as REC

    sessions = _Sessions()
    counts = iter([REC.PRUNE_BATCH, REC.PRUNE_BATCH, 17])
    sqls: list[str] = []

    async def rowcount(_s: Any, sql: str, p: dict[str, Any]) -> int:
        sqls.append(" ".join(sql.split()))
        assert p["batch"] == REC.PRUNE_BATCH
        return next(counts)

    monkeypatch.setattr(REC, "execute_rowcount", rowcount)
    d = REC.RecordingDispatcher(session_factory=sessions)
    assert await d._prune() == 2 * REC.PRUNE_BATCH + 17
    assert len(sqls) == 3 and "ORDER BY confirmed_at LIMIT :batch" in sqls[0] and sessions.commits == 3
    assert await d._prune() == 0  # at most once per 5 minutes


@pytest.mark.asyncio
async def test_bulk_job_runs_in_background_with_its_own_tdengine_client(pg: Pg):
    import asyncio

    td = Td()
    closed: list[bool] = []

    async def close() -> None:
        closed.append(True)

    td.close = close  # type: ignore[attr-defined]
    rows = [_row(f"state_{i:03d}", "status" if i == 0 else "mode") for i in range(2)]
    job = SBULK.submit_job(TENANT, None, rows, resolve_factory=lambda _s: _resolve,
                           session_factory=_Sessions(), td_factory=lambda: td)
    assert job["status"] == "QUEUED" and job["total"] == 2
    for _ in range(100):
        await asyncio.sleep(0)
        cur = SBULK.get_job(TENANT, job["job_id"])
        if cur["status"] in ("DONE", "FAILED"):
            break
    assert cur["status"] == "DONE" and cur["done"] == 2 and cur["progress_pct"] == 100.0
    assert cur["summary"] == {"CREATED": 2} and [i["status"] for i in cur["items"]] == ["CREATED", "CREATED"]
    assert closed == [True]  # the dedicated client is closed after the job
    assert SBULK.get_job(uuid4(), job["job_id"]) is None  # other tenant: not visible
    assert any(j["job_id"] == job["job_id"] and "items" not in j for j in SBULK.list_jobs(TENANT))
