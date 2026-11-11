"""Unit tests for S13 Safe Selective Reset (``telemetry_reset.py``) and S14 Migrator (``telemetry_migrator.py``)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.quality import Quality
from factorix.modules.live_state import TDengineLiveStateProvider
from factorix.modules.telemetry_migrator import (
    MIGRATION_KIND,
    TelemetryMigrator,
    ensure_deterministic_event_uid,
)
from factorix.modules.telemetry_reset import (
    AUDIT_ACTION,
    CONFIRM_PHRASE,
    OPERATION_KIND,
    PROTECTED_CONTROL_PLANE_TABLES,
    STATE_MACHINE_ORDER,
    TelemetryResetService,
    build_router,
)
from factorix.platform.errors import AppError
from factorix.platform.http import json_error
from factorix.platform.security import hash_password
from factorix.platform.tdengine import (
    BatchWriteResult,
    TDEngineConfig,
    TDEngineError,
    model_snapshot_subtable_name,
    op_subtable_name,
)

T0 = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
TENANT_ID = uuid4()
ACTOR_ID = uuid4()
SIG_1 = uuid4()
SIG_2 = uuid4()
RES_1 = uuid4()
CONN_1 = uuid4()
GROUP_1 = uuid4()
ADMIN_PASSWORD = "Correct-Horse-Battery-9!"
ADMIN_HASH = hash_password(ADMIN_PASSWORD)


class _FakeResult:
    def __init__(self, rows: list[dict[str, Any]] | None = None, rowcount: int = 0) -> None:
        self._rows = rows or []
        self.rowcount = rowcount

    def mappings(self) -> "_FakeResult":
        return self

    def first(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[dict[str, Any]]:
        return list(self._rows)


class FakeResetAndMigrationSession:
    """In-memory SQLAlchemy AsyncSession double tracking SQL statements, state, and table invariants."""

    def __init__(self) -> None:
        self.executed_sql: list[tuple[str, dict[str, Any]]] = []
        self.info: dict[str, Any] = {}
        self.advisory_lock_ok: bool = True
        self.active_epoch: int = 1
        self.lifecycle_state: str = "ACTIVE"
        self.reset_operation_id: UUID | None = None
        self.password_hash: str = ADMIN_HASH
        self.admin_disabled_at: datetime | None = None

        self.preserved_counts: dict[str, int] = {
            "connections": 5,
            "signals_active": 336,
            "signals_archived": 8,
            "data_models": 36,
            "storage_designs": 4,
            "resources": 42,
            "admin_accounts": 1,
            "sessions": 2,
            "secret_store": 5,
            "formulas": 12,
        }
        self.runtime_counts: dict[str, int] = {
            "observations": 14500,
            "latest_signal_state": 336,
            "model_snapshots": 720,
            "model_state": 36,
            "ingest_dedup": 4200,
            "observation_quarantine": 19,
            "commissioning_jobs": 5,
            "export_jobs": 3,
        }
        self.registry_rows: list[dict[str, Any]] = [
            {"td_subtable": f"op_float64_{SIG_1.hex}", "tier": "OPERATIONAL"},
            {"td_subtable": "ds_line1_sub", "tier": "MANAGED"},
        ]
        self.operations: dict[UUID, dict[str, Any]] = {}
        self.audit_events: list[dict[str, Any]] = []

        # Historical data for S14 TelemetryMigrator
        self.pg_observations: list[dict[str, Any]] = []
        self.pg_model_snapshots: list[dict[str, Any]] = []

    async def execute(self, clause: Any, params: dict[str, Any] | None = None) -> _FakeResult:
        sql = " ".join(str(clause).split())
        p = dict(params or {})
        self.executed_sql.append((sql, p))
        low = sql.lower()

        if "from admin_accounts" in low and "password_hash" in low:
            if str(p.get("actor_id")) == str(ACTOR_ID) and str(p.get("tenant_id")) == str(TENANT_ID):
                return _FakeResult(
                    [
                        {
                            "id": ACTOR_ID,
                            "tenant_id": TENANT_ID,
                            "login": "admin",
                            "password_hash": self.password_hash,
                            "disabled_at": self.admin_disabled_at,
                        }
                    ]
                )
            return _FakeResult([])

        if "pg_try_advisory_xact_lock" in low:
            return _FakeResult([{"acquired": self.advisory_lock_ok}])

        if "insert into telemetry_generations" in low:
            return _FakeResult([], rowcount=1)

        if "select active_epoch" in low and "from telemetry_generations" in low:
            return _FakeResult(
                [
                    {
                        "active_epoch": self.active_epoch,
                        "lifecycle_state": self.lifecycle_state,
                        "updated_at": T0,
                        "updated_by": ACTOR_ID,
                        "reset_operation_id": self.reset_operation_id,
                    }
                ]
            )

        if "update telemetry_generations" in low:
            if "new_epoch" in p:
                self.active_epoch = int(p["new_epoch"])
            if "'resetting'" in low:
                self.lifecycle_state = "RESETTING"
            elif "'active'" in low:
                self.lifecycle_state = "ACTIVE"
            elif "'failed_fenced'" in low:
                self.lifecycle_state = "FAILED_FENCED"
            if "op_id" in p:
                self.reset_operation_id = UUID(str(p["op_id"]))
            return _FakeResult([], rowcount=1)

        if "select count(*) as cnt from observations" in low:
            return _FakeResult([{"cnt": self.runtime_counts["observations"]}])
        if "select count(*) as cnt from latest_signal_state" in low:
            return _FakeResult([{"cnt": self.runtime_counts["latest_signal_state"]}])
        if "select count(*) as cnt from model_snapshots" in low:
            return _FakeResult([{"cnt": self.runtime_counts["model_snapshots"]}])
        if "select count(*) as cnt from model_state" in low:
            return _FakeResult([{"cnt": self.runtime_counts["model_state"]}])
        if "select count(*) as cnt from ingest_dedup" in low:
            return _FakeResult([{"cnt": self.runtime_counts["ingest_dedup"]}])
        if "select count(*) as cnt from observation_quarantine" in low:
            return _FakeResult([{"cnt": self.runtime_counts["observation_quarantine"]}])
        if "select count(*) as cnt from commissioning_jobs" in low:
            return _FakeResult([{"cnt": self.runtime_counts["commissioning_jobs"]}])
        if "select count(*) as cnt from export_jobs" in low:
            return _FakeResult([{"cnt": self.runtime_counts["export_jobs"]}])

        if "select count(*) as cnt from connections" in low:
            return _FakeResult([{"cnt": self.preserved_counts["connections"]}])
        if "from signal_definitions" in low and "status = 'active'" in low:
            return _FakeResult([{"cnt": self.preserved_counts["signals_active"]}])
        if "from signal_definitions" in low and "status = 'archived'" in low:
            return _FakeResult([{"cnt": self.preserved_counts["signals_archived"]}])
        if "select count(*) as cnt from output_groups" in low:
            return _FakeResult([{"cnt": self.preserved_counts["data_models"]}])
        if "select count(*) as cnt from storage_designs" in low:
            return _FakeResult([{"cnt": self.preserved_counts["storage_designs"]}])
        if "select count(*) as cnt from resources" in low:
            return _FakeResult([{"cnt": self.preserved_counts["resources"]}])
        if "select count(*) as cnt from admin_accounts" in low:
            return _FakeResult([{"cnt": self.preserved_counts["admin_accounts"]}])
        if "from sessions s" in low:
            return _FakeResult([{"cnt": self.preserved_counts["sessions"]}])
        if "select count(*) as cnt from secret_store" in low:
            return _FakeResult([{"cnt": self.preserved_counts["secret_store"]}])
        if "from formula_definitions f" in low:
            return _FakeResult([{"cnt": self.preserved_counts["formulas"]}])

        if "from storage_physical_registry" in low:
            return _FakeResult(self.registry_rows)

        if "insert into storage_operations" in low:
            op_id = UUID(str(p["id"]))
            self.operations[op_id] = {
                "id": op_id,
                "tenant_id": p["tenant_id"],
                "operation_type": p["op_type"],
                "status": "RUNNING",
                "requested_at": p["now"],
                "started_at": p["now"],
                "completed_at": None,
                "step_state_json": p["step_state"],
                "error_code": None,
                "error_message": None,
                "actor_id": p.get("actor_id"),
                "idempotency_key": p.get("idemp_key"),
            }
            return _FakeResult([], rowcount=1)

        if "update storage_operations" in low:
            op_id = UUID(str(p["id"]))
            if op_id in self.operations:
                if "status" in p:
                    self.operations[op_id]["status"] = p["status"]
                elif "'completed'" in low:
                    self.operations[op_id]["status"] = "COMPLETED"
                elif "'failed'" in low:
                    self.operations[op_id]["status"] = "FAILED"
                self.operations[op_id]["completed_at"] = p.get("completed_at") or p.get("now")
                self.operations[op_id]["step_state_json"] = p.get("step_state")
                self.operations[op_id]["error_code"] = p.get("error_code") or p.get("err_code")
                self.operations[op_id]["error_message"] = p.get("error_message") or p.get("err_msg")
            return _FakeResult([], rowcount=1)

        if "from storage_operations" in low:
            if "op_id" in p or "id = cast(:id" in low:
                lookup_id = UUID(str(p.get("op_id") or p.get("id")))
                found = self.operations.get(lookup_id)
                return _FakeResult([found] if found else [])
            if "idempotency_key = cast(:idemp_key" in low or "idempotency_key = :idemp_key" in low:
                for op in self.operations.values():
                    if op.get("operation_type") == p.get("op_type") and op.get("idempotency_key") == p.get("idemp_key"):
                        return _FakeResult([op])
                return _FakeResult([])
            matching = [
                op for op in self.operations.values() if op.get("operation_type") == p.get("op_type")
            ]
            return _FakeResult([matching[-1]] if matching else [])

        if low.startswith("delete from "):
            for tbl in list(self.runtime_counts):
                if f"delete from {tbl}" in low:
                    removed = self.runtime_counts[tbl]
                    self.runtime_counts[tbl] = 0
                    return _FakeResult([], rowcount=removed)

        if "update edge_nodes set outbox_pending = 0" in low:
            return _FakeResult([], rowcount=1)

        if "insert into audit_events" in low:
            self.audit_events.append(p)
            return _FakeResult([], rowcount=1)

        if "pg_notify(" in low:
            return _FakeResult([{"pg_notify": None}])

        # TelemetryMigrator queries
        if "from observations" in low and "group by signal_id, value_type" in low:
            grouped: dict[tuple[UUID, str], int] = {}
            for r in self.pg_observations:
                key = (UUID(str(r["signal_id"])), str(r["value_type"]))
                grouped[key] = grouped.get(key, 0) + 1
            return _FakeResult(
                [{"signal_id": k[0], "value_type": k[1], "cnt": cnt} for k, cnt in sorted(grouped.items(), key=lambda x: str(x[0][0]))]
            )

        if "from observations" in low and "order by event_time desc, id desc" in low:
            sig = UUID(str(p["signal_id"]))
            lim = int(p["limit"])
            filtered = [r for r in self.pg_observations if UUID(str(r["signal_id"])) == sig]
            filtered.sort(key=lambda r: (r["event_time"], str(r["id"])), reverse=True)
            return _FakeResult(filtered[:lim])

        if "from observations" in low and "order by event_time asc, id asc" in low:
            lim = int(p["limit"])
            ordered = sorted(self.pg_observations, key=lambda r: (r["event_time"], str(r["id"])))
            if "cursor_event_time" in p and "cursor_id" in p:
                c_ts = p["cursor_event_time"]
                c_id = str(p["cursor_id"])
                ordered = [
                    r for r in ordered if (r["event_time"], str(r["id"])) > (c_ts, c_id)
                ]
            return _FakeResult(ordered[:lim])

        if "from model_snapshots" in low and "group by group_id" in low:
            grouped_m: dict[UUID, int] = {}
            for r in self.pg_model_snapshots:
                gid = UUID(str(r["group_id"]))
                grouped_m[gid] = grouped_m.get(gid, 0) + 1
            return _FakeResult(
                [{"group_id": gid, "cnt": cnt} for gid, cnt in sorted(grouped_m.items(), key=lambda x: str(x[0]))]
            )

        if "from model_snapshots" in low and "order by sampled_at desc, id desc" in low:
            gid = UUID(str(p["group_id"]))
            lim = int(p["limit"])
            filtered = [r for r in self.pg_model_snapshots if UUID(str(r["group_id"])) == gid]
            filtered.sort(key=lambda r: (r["sampled_at"], int(r["id"])), reverse=True)
            return _FakeResult(filtered[:lim])

        if "from model_snapshots" in low and "order by sampled_at asc, id asc" in low:
            lim = int(p["limit"])
            ordered = sorted(self.pg_model_snapshots, key=lambda r: (r["sampled_at"], int(r["id"])))
            if "cursor_sampled_at" in p and "cursor_id" in p:
                c_ts = p["cursor_sampled_at"]
                c_id = int(p["cursor_id"])
                ordered = [
                    r for r in ordered if (r["sampled_at"], int(r["id"])) > (c_ts, c_id)
                ]
            return _FakeResult(ordered[:lim])

        return _FakeResult([])


def _fake_tdengine() -> Any:
    cfg = TDEngineConfig(dsn="ws://tdengine.test:6041", db_prefix="fx_t_")
    client = AsyncMock()
    client.config = cfg
    client.list_subtables = AsyncMock(
        return_value=[
            f"op_float64_{SIG_1.hex}",
            f"op_int64_{SIG_2.hex}",
            f"ms_{GROUP_1.hex}",
            "ds_line1_sub",
        ]
    )
    client.execute_sql = AsyncMock(return_value=0)
    client.ensure_operational_schema = AsyncMock(return_value=f"fx_t_{TENANT_ID.hex}")
    client.write_operational_observations = AsyncMock(
        side_effect=lambda _tid, recs, **_: BatchWriteResult(
            succeeded_ids=tuple(str(r["event_uid"]) for r in recs),
            failures=(),
        )
    )
    client.write_batch = AsyncMock(
        side_effect=lambda _db, items: BatchWriteResult(
            succeeded_ids=tuple(it.item_id for it in items),
            failures=(),
        )
    )
    client.query_rows = AsyncMock(return_value=[])
    return client


async def test_preview_returns_exact_cleared_and_preserved_inventories() -> None:
    session = FakeResetAndMigrationSession()
    td = _fake_tdengine()
    service = TelemetryResetService(tdengine=td)

    preview = await service.preview(session, TENANT_ID, tdengine=td)

    assert preview["mode"] == "CLEAR_TELEMETRY_ONLY"
    assert preview["active_epoch"] == 1
    assert preview["next_epoch"] == 2
    assert preview["confirm_phrase_required"] == CONFIRM_PHRASE
    assert preview["cleared"]["observations"] == 14500
    assert preview["cleared"]["latest_signal_state"] == 336
    assert preview["cleared"]["model_snapshots"] == 720
    assert preview["cleared"]["model_state"] == 36
    assert preview["cleared"]["ingest_dedup"] == 4200
    assert preview["cleared"]["observation_quarantine"] == 19
    assert preview["cleared"]["commissioning_jobs"] == 5
    assert preview["cleared"]["export_jobs"] == 3
    assert preview["cleared"]["tdengine_operational_subtables"] == 3
    assert preview["cleared"]["tdengine_managed_subtables"] == 1
    assert preview["cleared"]["tdengine_subtables_total"] == 4

    assert preview["preserved"] == {
        "connections": 5,
        "signals_active": 336,
        "signals_archived": 8,
        "data_models": 36,
        "storage_designs": 4,
        "resources": 42,
        "admin_accounts": 1,
        "sessions": 2,
        "secret_store": 5,
        "formulas": 12,
    }


async def test_execute_rejects_invalid_confirm_phrase_and_wrong_password_and_concurrent_reset() -> None:
    session = FakeResetAndMigrationSession()
    service = TelemetryResetService(tdengine=_fake_tdengine())

    # 1. Reject legacy "REVERT TO ZERO" and "REVERT" with HTTP 400 INVALID_CONFIRM_PHRASE
    for bad_phrase in ("REVERT TO ZERO", "REVERT", "clear telemetry", ""):
        with pytest.raises(AppError) as err_phrase:
            await service.execute(
                session,
                TENANT_ID,
                ACTOR_ID,
                confirm_phrase=bad_phrase,
                password=ADMIN_PASSWORD,
            )
        assert err_phrase.value.status == 400
        assert err_phrase.value.code == "INVALID_CONFIRM_PHRASE"

    # 2. Reject invalid admin password with HTTP 401 INVALID_CREDENTIALS
    with pytest.raises(AppError) as err_pwd:
        await service.execute(
            session,
            TENANT_ID,
            ACTOR_ID,
            confirm_phrase=CONFIRM_PHRASE,
            password="WrongPassword123!",
        )
    assert err_pwd.value.status == 401
    assert err_pwd.value.code == "INVALID_CREDENTIALS"

    # 3. Reject concurrent reset when advisory lock is held (HTTP 409 RESET_IN_PROGRESS)
    session.advisory_lock_ok = False
    with pytest.raises(AppError) as err_lock:
        await service.execute(
            session,
            TENANT_ID,
            ACTOR_ID,
            confirm_phrase=CONFIRM_PHRASE,
            password=ADMIN_PASSWORD,
        )
    assert err_lock.value.status == 409
    assert err_lock.value.code == "RESET_IN_PROGRESS"

    # 4. Reject concurrent reset when lifecycle_state is already RESETTING
    session.advisory_lock_ok = True
    session.lifecycle_state = "RESETTING"
    with pytest.raises(AppError) as err_state:
        await service.execute(
            session,
            TENANT_ID,
            ACTOR_ID,
            confirm_phrase=CONFIRM_PHRASE,
            password=ADMIN_PASSWORD,
        )
    assert err_state.value.status == 409
    assert err_state.value.code == "RESET_IN_PROGRESS"


async def test_execute_runs_r0_through_r5_fences_epoch_and_strictly_preserves_control_plane() -> None:
    session = FakeResetAndMigrationSession()
    td = _fake_tdengine()
    broker = AsyncMock()
    broker.purge_queue = AsyncMock(return_value={"messages_purged": 27})

    live_provider = TDengineLiveStateProvider(td)
    # Seed an epoch-1 observation into LiveStateProvider before reset
    obs_e1 = CanonicalObservation(
        event_uid="ev-epoch-1",
        tenant_id=TENANT_ID,
        signal_id=SIG_1,
        resource_id=RES_1,
        acquired_at=T0,
        value_type="float64",
        value=88.4,
        quality=Quality.GOOD,
        data_epoch=1,
    )
    await live_provider.apply_observation(obs_e1)
    assert live_provider.get_entry(TENANT_ID, SIG_1) is not None

    service = TelemetryResetService(tdengine=td, broker=broker, live_provider=live_provider)
    result = await service.execute(
        session,
        TENANT_ID,
        ACTOR_ID,
        confirm_phrase=CONFIRM_PHRASE,
        password=ADMIN_PASSWORD,
    )

    assert result["status"] == "SUCCEEDED"
    assert result["previous_epoch"] == 1
    assert result["active_epoch"] == 2
    assert result["new_epoch"] == 2
    assert result["lifecycle_state"] == "ACTIVE"
    assert result["stay_authenticated"] is True
    assert tuple(result["state_machine"]) == STATE_MACHINE_ORDER
    assert result["stages_completed"] == ["R0", "R1", "R2", "R3", "R4", "R5"]

    # Verify all runtime PG counts were cleared to 0
    for runtime_tbl, count_after in session.runtime_counts.items():
        assert count_after == 0, f"Expected {runtime_tbl} to be cleared"
    assert result["cleared"]["observations"] == 14500
    assert result["cleared"]["latest_signal_state"] == 336
    assert result["cleared"]["broker_messages_purged"] == 27
    assert result["cleared"]["tdengine_subtables_total"] == 4

    # Verify TDengine subtables were dropped and operational STable schema was re-ensured
    dropped_sqls = [call.args[0] for call in td.execute_sql.call_args_list]
    assert len(dropped_sqls) == 4
    assert all(s.startswith("DROP TABLE IF EXISTS `fx_t_") for s in dropped_sqls)
    td.ensure_operational_schema.assert_awaited_once_with(TENANT_ID)

    # Verify LiveStateProvider cache for TENANT_ID was invalidated and fenced to epoch 2
    assert live_provider.get_entry(TENANT_ID, SIG_1) is None
    accepted_old, _ = await live_provider.apply_observation(obs_e1)
    assert accepted_old is False

    # Verify zero SQL DELETE or TRUNCATE ever targeted any protected control-plane table
    for sql, _params in session.executed_sql:
        low = sql.lower()
        assert "truncate" not in low, f"Forbidden TRUNCATE executed: {sql}"
        if low.startswith("delete from "):
            for protected in PROTECTED_CONTROL_PLANE_TABLES:
                assert f"delete from {protected}" not in low, f"Protected table {protected} was touched by {sql}"

    # Verify audit event and storage_operations records
    assert len(session.audit_events) == 1
    audit_row = session.audit_events[0]
    assert audit_row["event_type"] == AUDIT_ACTION
    after_payload = json.loads(audit_row["after_json"])
    assert after_payload["previous_epoch"] == 1
    assert after_payload["new_epoch"] == 2
    assert after_payload["preserved"]["connections"] == 5
    assert after_payload["preserved"]["signals_active"] == 336
    assert after_payload["preserved"]["data_models"] == 36

    op_id = UUID(result["operation_id"])
    assert session.operations[op_id]["operation_type"] == OPERATION_KIND
    assert session.operations[op_id]["status"] == "COMPLETED"


async def test_execute_soft_skips_offline_broker_and_fences_on_tdengine_failure() -> None:
    session = FakeResetAndMigrationSession()
    td = _fake_tdengine()
    offline_broker = AsyncMock()
    offline_broker.purge_queue = AsyncMock(side_effect=RuntimeError("AMQP connection refused"))

    service = TelemetryResetService(tdengine=td, broker=offline_broker)
    res = await service.execute(
        session,
        TENANT_ID,
        ACTOR_ID,
        confirm_phrase=CONFIRM_PHRASE,
        password=ADMIN_PASSWORD,
    )
    assert res["status"] == "SUCCEEDED"
    assert res["active_epoch"] == 2

    # Now simulate a hard TDengine error during R3 on the next reset
    td.list_subtables = AsyncMock(side_effect=TDEngineError("TDENGINE_TIMEOUT", "Cluster timed out", retryable=True))
    with pytest.raises(AppError) as err_td:
        await service.execute(
            session,
            TENANT_ID,
            ACTOR_ID,
            confirm_phrase=CONFIRM_PHRASE,
            password=ADMIN_PASSWORD,
        )
    assert err_td.value.status == 503
    assert session.lifecycle_state == "FAILED_FENCED"


async def test_telemetry_reset_fastapi_router_endpoints() -> None:
    session = FakeResetAndMigrationSession()
    td = _fake_tdengine()

    app = FastAPI()
    app.state.td_client = td

    @app.exception_handler(AppError)
    async def _on_app_err(_req: Any, exc: AppError) -> Any:
        return json_error(exc.status, exc.code, exc.message, correlation_id="test-corr")

    async def _fake_admin() -> dict[str, Any]:
        return {"tenant_id": str(TENANT_ID), "admin_id": str(ACTOR_ID), "login": "admin"}

    async def _fake_session() -> Any:
        yield session

    app.include_router(build_router(admin_dep=_fake_admin, session_dep=_fake_session))

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        prev_resp = await client.get("/api/v1/admin/telemetry-reset/preview")
        assert prev_resp.status_code == 200
        prev_body = prev_resp.json()
        assert prev_body["active_epoch"] == 1
        assert prev_body["preserved"]["signals_active"] == 336

        bad_resp = await client.post(
            "/api/v1/admin/telemetry-reset/execute",
            json={"confirm_phrase": "REVERT TO ZERO", "password": ADMIN_PASSWORD},
        )
        assert bad_resp.status_code == 400
        assert bad_resp.json()["error"]["code"] == "INVALID_CONFIRM_PHRASE"

        exec_resp = await client.post(
            "/api/v1/admin/telemetry-reset/execute",
            json={"confirm_phrase": "CLEAR TELEMETRY", "password": ADMIN_PASSWORD},
        )
        assert exec_resp.status_code == 200
        exec_body = exec_resp.json()
        assert exec_body["active_epoch"] == 2
        assert exec_body["stay_authenticated"] is True

        status_resp = await client.get("/api/v1/admin/telemetry-reset/status")
        assert status_resp.status_code == 200
        status_body = status_resp.json()
        assert status_body["active_epoch"] == 2
        assert status_body["status"] == "SUCCEEDED"


async def test_migrator_keyset_pagination_deterministic_uid_and_parity_verification() -> None:
    session = FakeResetAndMigrationSession()
    td = _fake_tdengine()

    # Seed 5 PG observations across 2 signals (one with missing event_uid) and 3 model snapshots
    obs_rows = [
        {
            "id": uuid4(),
            "tenant_id": TENANT_ID,
            "site_id": None,
            "resource_id": RES_1,
            "signal_id": SIG_1,
            "edge_id": None,
            "connection_id": CONN_1,
            "event_uid": "" if idx == 0 else f"pg-uid-{idx}",
            "event_time": T0 + timedelta(seconds=idx),
            "received_time": T0 + timedelta(seconds=idx, milliseconds=25),
            "source_time": T0 + timedelta(seconds=idx),
            "value_type": "float64",
            "value_json": json.dumps({"v": 10.5 + idx}),
            "unit": "Bar",
            "quality": "GOOD",
            "origin": "LIVE",
            "config_revision": 1,
            "provenance_json": json.dumps({"protocol": "modbus_tcp", "data_epoch": 1}),
        }
        for idx in range(3)
    ] + [
        {
            "id": uuid4(),
            "tenant_id": TENANT_ID,
            "site_id": None,
            "resource_id": RES_1,
            "signal_id": SIG_2,
            "edge_id": None,
            "connection_id": CONN_1,
            "event_uid": f"pg-int-{idx}",
            "event_time": T0 + timedelta(seconds=10 + idx),
            "received_time": T0 + timedelta(seconds=10 + idx),
            "source_time": None,
            "value_type": "int64",
            "value_json": json.dumps({"v": 100 + idx}),
            "unit": "rpm",
            "quality": "GOOD",
            "origin": "LIVE",
            "config_revision": 2,
            "provenance_json": "{}",
        }
        for idx in range(2)
    ]
    session.pg_observations = list(obs_rows)

    snap_rows = [
        {
            "id": idx + 1,
            "group_id": GROUP_1,
            "tenant_id": TENANT_ID,
            "sampled_at": T0 + timedelta(seconds=idx * 5),
            "body_text": json.dumps({"pressure": 10.5 + idx}),
            "errors_json": "[]",
            "error_count": 0,
        }
        for idx in range(3)
    ]
    session.pg_model_snapshots = list(snap_rows)

    # Deterministic UID derivation when missing is repeatable
    uid_a = ensure_deterministic_event_uid(obs_rows[0], tenant_id=TENANT_ID, data_epoch=1)
    uid_b = ensure_deterministic_event_uid(obs_rows[0], tenant_id=TENANT_ID, data_epoch=1)
    assert uid_a == uid_b
    assert uid_a.startswith("fx-1-")

    # Capture written TDengine rows so verify_parity can inspect them
    td_written_obs: dict[str, list[dict[str, Any]]] = {}
    td_written_snaps: dict[str, list[dict[str, Any]]] = {}

    async def _capture_obs(_tid: UUID, records: list[dict[str, Any]], **_: Any) -> BatchWriteResult:
        for r in records:
            sub = op_subtable_name(r["signal_id"], r["value_type"])
            td_written_obs.setdefault(sub, []).append(
                {
                    "ts": r["event_time"],
                    "val": r["value"],
                    "acquired_at": r["acquired_at"],
                    "source_time": r["source_time"],
                    "raw_quality": r["raw_quality"],
                    "event_uid": r["event_uid"],
                    "data_epoch": r["data_epoch"],
                }
            )
        return BatchWriteResult(succeeded_ids=tuple(str(r["event_uid"]) for r in records), failures=())

    async def _capture_batch(_db: str, items: list[Any]) -> BatchWriteResult:
        for it in items:
            td_written_snaps.setdefault(it.subtable, []).append(
                {
                    "ts": it.values[0],
                    "body_text": it.values[1],
                    "errors_json": it.values[2],
                    "error_count": it.values[3],
                    "data_epoch": it.values[4],
                }
            )
        return BatchWriteResult(succeeded_ids=tuple(it.item_id for it in items), failures=())

    async def _query_td(sql: str, **_: Any) -> list[dict[str, Any]]:
        for sub, rows in {**td_written_obs, **td_written_snaps}.items():
            if f"`{sub}`" in sql:
                if "SELECT COUNT(*)" in sql:
                    return [{"cnt": len(rows)}]
                return sorted(rows, key=lambda r: r["ts"], reverse=True)
        return []

    td.write_operational_observations = AsyncMock(side_effect=_capture_obs)
    td.write_batch = AsyncMock(side_effect=_capture_batch)
    td.query_rows = AsyncMock(side_effect=_query_td)

    migrator = TelemetryMigrator(td, chunk_size=2)
    result = await migrator.migrate_tenant(
        session,
        TENANT_ID,
        actor_id=ACTOR_ID,
        idempotency_key="mig-run-1",
        verify=True,
    )

    assert result.kind == MIGRATION_KIND
    assert result.status == "SUCCEEDED"
    assert result.observations_migrated == 5
    assert result.observations_chunks == 3  # 2 + 2 + 1 with chunk_size=2
    assert result.model_snapshots_migrated == 3
    assert result.model_snapshots_chunks == 2  # 2 + 1 with chunk_size=2
    assert result.parity is not None
    assert result.parity.parity_ok is True
    assert result.parity.signals_checked == 2
    assert result.parity.models_checked == 1
    assert result.parity.mismatches == []

    # Verify PG observations and model_snapshots were NOT deleted during migration
    assert len(session.pg_observations) == 5
    assert len(session.pg_model_snapshots) == 3

    # Verify checkpoint recorded in storage_operations
    op_row = session.operations[result.operation_id]
    assert op_row["operation_type"] == MIGRATION_KIND
    assert op_row["status"] == "COMPLETED"
    saved_state = json.loads(op_row["step_state_json"])
    assert saved_state["kind"] == MIGRATION_KIND
    assert saved_state["observations_migrated"] == 5
    assert saved_state["model_snapshots_migrated"] == 3

    # Verify parity failure detection when a TDengine row value is tampered with
    sig1_sub = op_subtable_name(SIG_1, "float64")
    td_written_obs[sig1_sub][0]["val"] = 99999.0
    mismatch_parity = await migrator.verify_parity(session, TENANT_ID)
    assert mismatch_parity.parity_ok is False
    assert any(m["reason"] == "SAMPLE_VALUE_OR_QUALITY_MISMATCH" for m in mismatch_parity.mismatches)


async def test_migrator_checkpoint_resume_from_paused_retryable() -> None:
    session = FakeResetAndMigrationSession()
    td = _fake_tdengine()

    obs_rows = [
        {
            "id": uuid4(),
            "tenant_id": TENANT_ID,
            "site_id": None,
            "resource_id": RES_1,
            "signal_id": SIG_1,
            "edge_id": None,
            "connection_id": CONN_1,
            "event_uid": f"resume-uid-{idx}",
            "event_time": T0 + timedelta(seconds=idx),
            "received_time": T0 + timedelta(seconds=idx),
            "source_time": T0 + timedelta(seconds=idx),
            "value_type": "float64",
            "value_json": json.dumps({"v": 20.0 + idx}),
            "unit": "C",
            "quality": "GOOD",
            "origin": "LIVE",
            "config_revision": 1,
            "provenance_json": "{}",
        }
        for idx in range(4)
    ]
    session.pg_observations = list(obs_rows)

    call_count = 0

    async def _fail_on_second_chunk(_tid: UUID, records: list[dict[str, Any]], **_: Any) -> BatchWriteResult:
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            raise TDEngineError("TDENGINE_TEMP_ERROR", "Temporary network hiccup", retryable=True)
        return BatchWriteResult(succeeded_ids=tuple(str(r["event_uid"]) for r in records), failures=())

    td.write_operational_observations = AsyncMock(side_effect=_fail_on_second_chunk)

    migrator = TelemetryMigrator(td, chunk_size=2)
    with pytest.raises(TDEngineError):
        await migrator.migrate_tenant(
            session,
            TENANT_ID,
            actor_id=ACTOR_ID,
            idempotency_key="mig-resume-key",
            verify=False,
        )

    # First chunk (2 rows) succeeded and checkpointed before second chunk failed
    assert len(session.operations) == 1
    op_row = next(iter(session.operations.values()))
    assert op_row["status"] == "PAUSED_RETRYABLE"
    paused_state = json.loads(op_row["step_state_json"])
    assert paused_state["observations_migrated"] == 2
    assert paused_state["observations_chunks"] == 1

    # Resume using the same idempotency_key: only the remaining 2 rows should be migrated
    resumed = await migrator.migrate_tenant(
        session,
        TENANT_ID,
        actor_id=ACTOR_ID,
        idempotency_key="mig-resume-key",
        verify=False,
    )
    assert resumed.status == "SUCCEEDED"
    assert resumed.observations_migrated == 4
    assert resumed.observations_chunks == 2
    assert session.operations[resumed.operation_id]["status"] == "COMPLETED"
