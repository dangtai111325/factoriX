"""Unit tests for IngestionWorker, chunked PG NOTIFY bridge, and local-acquisition app helpers (S06)."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance, derive_event_uid
from factorix.domain.quality import Origin, Quality
from factorix.modules.ingestion_worker import (
    MAX_MESSAGE_BYTES,
    IngestionWorker,
    TenantCatalog,
    _emit_chunked_notify,
)
from factorix.platform.broker import ConsumeOutcome
from factorix.platform.tdengine import BatchWriteFailure, BatchWriteResult, TDEngineError, TDEngineHealth
from factorix.transport.app import _parse_pg_notify_events


def _now() -> datetime:
    return datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)


def _make_obs(
    *,
    tenant_id: UUID,
    signal_id: UUID,
    resource_id: UUID,
    connection_id: UUID,
    source_field_id: UUID,
    site_id: UUID | None = None,
    value: Any = 42.5,
    value_type: str = "float64",
    quality: Quality = Quality.GOOD,
    origin: Origin = Origin.LIVE,
    data_epoch: int = 1,
    event_uid: str | None = None,
    acquired_at: datetime | None = None,
    seq: int = 1,
) -> CanonicalObservation:
    acq = acquired_at or _now()
    uid = event_uid or derive_event_uid(
        tenant_id=tenant_id,
        connection_id=connection_id,
        source_field_id=source_field_id,
        signal_id=signal_id,
        acquired_at=acq,
        sequence_or_key=f"seq-{seq}-{uuid4().hex[:6]}",
        data_epoch=data_epoch,
    )
    return CanonicalObservation(
        event_uid=uid,
        tenant_id=tenant_id,
        site_id=site_id,
        connection_id=connection_id,
        acquisition_job_id=uuid4(),
        source_field_id=source_field_id,
        signal_id=signal_id,
        resource_id=resource_id,
        source_time=acq - timedelta(milliseconds=10),
        acquired_at=acq,
        value_type=value_type,
        value=value,
        unit="°C" if value_type == "float64" else None,
        quality=quality,
        origin=origin,
        data_epoch=data_epoch,
        config_revision=1,
        source_sequence=seq,
        provenance=CanonicalProvenance(
            protocol="modbus_tcp",
            connection_id=connection_id,
            source_field_id=source_field_id,
            config_revision=1,
        ),
    )


class _FakePgStore:
    def __init__(self, catalog: TenantCatalog) -> None:
        self.catalog = catalog
        self.quarantined: list[dict[str, Any]] = []
        self.audits: list[dict[str, Any]] = []
        self.commits: list[dict[str, Any]] = []
        self.latest_values: dict[UUID, dict[str, Any]] = {}
        self.load_calls = 0

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None

    @staticmethod
    def is_retryable_pg_error(exc: BaseException) -> bool:
        return isinstance(exc, TimeoutError)

    async def fetch_tenant_epoch(self, _tenant_id: UUID) -> tuple[int, str]:
        return self.catalog.active_epoch, self.catalog.lifecycle_state

    async def load_tenant_catalog(self, _tenant_id: UUID) -> TenantCatalog:
        self.load_calls += 1
        return self.catalog

    async def write_quarantine(self, **kwargs: Any) -> None:
        self.quarantined.append(kwargs)

    async def write_audit(self, **kwargs: Any) -> None:
        self.audits.append(kwargs)

    async def fetch_latest_values(self, _tenant_id: UUID, signal_ids: list[UUID]) -> dict[UUID, dict[str, Any]]:
        return {sid: self.latest_values[sid] for sid in signal_ids if sid in self.latest_values}

    async def commit_batch_metadata(self, **kwargs: Any) -> tuple[set[UUID], list[dict[str, Any]]]:
        self.commits.append(kwargs)
        replaced = {r["signal_id"] for r in kwargs["latest_rows"]}
        return replaced, []


class _FakeTDEngine:
    def __init__(self) -> None:
        self.ensured: list[UUID] = []
        self.writes: list[list[dict[str, Any]]] = []
        self.scripted: list[Any] = []

    async def ensure_operational_schema(self, tenant_id: UUID, **_kw: Any) -> str:
        self.ensured.append(tenant_id)
        return f"fx_t_{tenant_id.hex}"

    async def write_operational_observations(
        self, _tenant_id: UUID, records: list[dict[str, Any]], **_kw: Any
    ) -> BatchWriteResult:
        if self.scripted:
            action = self.scripted.pop(0)
            if callable(action):
                return action(records)
            if isinstance(action, Exception):
                raise action
            return action
        self.writes.append(list(records))
        return BatchWriteResult(succeeded_ids=tuple(str(r["event_uid"]) for r in records), failures=())

    async def health_probe(self) -> TDEngineHealth:
        return TDEngineHealth(reachable=True, server_version="3.3.6.13", edition="community")


def _catalog_with_signal(
    *,
    tenant_id: UUID | None = None,
    sig_id: UUID | None = None,
    res_id: UUID | None = None,
    conn_id: UUID | None = None,
    field_id: UUID | None = None,
    site_id: UUID | None = None,
    active_epoch: int = 1,
    lifecycle_state: str = "ACTIVE",
) -> tuple[TenantCatalog, dict[str, UUID]]:
    tid = tenant_id or uuid4()
    sid = sig_id or uuid4()
    rid = res_id or uuid4()
    cid = conn_id or uuid4()
    fid = field_id or uuid4()
    stid = site_id or uuid4()
    cat = TenantCatalog(
        tenant_id=tid,
        active_epoch=active_epoch,
        lifecycle_state=lifecycle_state,
        bindings={
            sid: [
                {
                    "signal_id": sid,
                    "valid_from": datetime(2026, 1, 1, tzinfo=timezone.utc),
                    "valid_to": None,
                    "resource_id": rid,
                    "expected_interval_ms": 1000,
                    "site_id": stid,
                    "connection_id": cid,
                    "source_field_id": fid,
                    "nullable": False,
                }
            ]
        },
    )
    return cat, {"tenant_id": tid, "signal_id": sid, "resource_id": rid, "connection_id": cid, "field_id": fid, "site_id": stid}


def test_parse_pg_notify_events_supports_batch_and_single_formats() -> None:
    tid = str(uuid4())
    sid = str(uuid4())
    batch_payload = json.dumps(
        {"events": [{"kind": "latest", "tenant_id": tid, "signal_id": sid, "payload": {"type": "latest", "value": 1}}]}
    )
    parsed = _parse_pg_notify_events("factorix_stream_events", batch_payload)
    assert len(parsed) == 1 and parsed[0]["kind"] == "latest" and parsed[0]["signal_id"] == sid

    single_payload = json.dumps({"tenant_id": tid, "event": {"type": "health", "entity": "connection", "id": sid}})
    parsed_single = _parse_pg_notify_events("factorix_health_changed", single_payload)
    assert len(parsed_single) == 1 and parsed_single[0]["kind"] == "health" and parsed_single[0]["tenant_id"] == tid

    assert _parse_pg_notify_events("factorix_stream_events", "{bad json") == []
    assert _parse_pg_notify_events("factorix_stream_events", "") == []


@pytest.mark.asyncio
async def test_oversize_malformed_test_and_calculated_handling() -> None:
    cat, ids = _catalog_with_signal()
    pg = _FakePgStore(cat)
    td = _FakeTDEngine()
    w = IngestionWorker(pg_store=pg, tdengine=td)  # type: ignore[arg-type]

    test_obs = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        origin=Origin.TEST,
    )
    calc_obs = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        origin=Origin.CALCULATED,
    )

    outcomes = await w.ingest_direct_bytes(
        [
            (b"x" * (MAX_MESSAGE_BYTES + 1), {"x-tenant-id": str(ids["tenant_id"])}, "big-1", False),
            (b"{not valid json", {"x-tenant-id": str(ids["tenant_id"])}, "bad-json", False),
            (test_obs.to_json_bytes(), {}, test_obs.event_uid, False),
            (calc_obs.to_json_bytes(), {}, calc_obs.event_uid, False),
        ]
    )

    assert outcomes == [
        ConsumeOutcome.DEAD_LETTER,
        ConsumeOutcome.DEAD_LETTER,
        ConsumeOutcome.ACK,
        ConsumeOutcome.DEAD_LETTER,
    ]
    assert len(pg.quarantined) == 3
    assert td.writes == []
    assert w.metrics.test_dropped == 1
    assert w.metrics.dlq_total == 3


@pytest.mark.asyncio
async def test_epoch_fencing_and_resetting_lifecycle_hold() -> None:
    cat, ids = _catalog_with_signal(active_epoch=5, lifecycle_state="RESETTING")
    pg = _FakePgStore(cat)
    td = _FakeTDEngine()
    w = IngestionWorker(pg_store=pg, tdengine=td)  # type: ignore[arg-type]

    # 1. Old epoch drops immediately even while RESETTING
    stale_obs = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        data_epoch=4,
    )
    ahead_obs = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        data_epoch=6,
    )
    out = await w.ingest_direct_bytes(
        [
            (stale_obs.to_json_bytes(), {}, stale_obs.event_uid, False),
            (ahead_obs.to_json_bytes(), {}, ahead_obs.event_uid, False),
        ]
    )
    assert out == [ConsumeOutcome.ACK, ConsumeOutcome.DEAD_LETTER]
    assert w.metrics.epoch_fenced_dropped == 1
    assert td.writes == []

    # 2. Active epoch holds cleanly while RESETTING, then commits as soon as lifecycle returns to ACTIVE
    cur_obs = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        data_epoch=5,
    )

    async def _release_reset() -> None:
        await asyncio.sleep(0.15)
        cat.lifecycle_state = "ACTIVE"

    rel_task = asyncio.create_task(_release_reset())
    out2 = await w.ingest_direct_bytes([(cur_obs.to_json_bytes(), {}, cur_obs.event_uid, False)])
    await rel_task
    assert out2 == [ConsumeOutcome.ACK]
    assert len(td.writes) == 1 and len(td.writes[0]) == 1

    # 3. Worker stopping while RESETTING returns RETRY cleanly (requeue, not DLQ)
    cat.lifecycle_state = "RESETTING"
    w._stopping = True
    w._stop_event.set()
    out3 = await w.ingest_direct_bytes([(cur_obs.to_json_bytes(), {}, cur_obs.event_uid, False)])
    assert out3 == [ConsumeOutcome.RETRY]


@pytest.mark.asyncio
async def test_unbound_and_scope_mismatch_quarantined_and_dead_lettered() -> None:
    cat, ids = _catalog_with_signal()
    pg = _FakePgStore(cat)
    td = _FakeTDEngine()
    w = IngestionWorker(pg_store=pg, tdengine=td)  # type: ignore[arg-type]

    wrong_signal = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=uuid4(),
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
    )
    wrong_resource = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=uuid4(),
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
    )
    wrong_conn = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=uuid4(),
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
    )

    outcomes = await w.ingest_direct_bytes(
        [
            (wrong_signal.to_json_bytes(), {}, wrong_signal.event_uid, False),
            (wrong_resource.to_json_bytes(), {}, wrong_resource.event_uid, False),
            (wrong_conn.to_json_bytes(), {}, wrong_conn.event_uid, False),
        ]
    )
    assert outcomes == [ConsumeOutcome.DEAD_LETTER] * 3
    assert len(pg.quarantined) == 3
    assert td.writes == []


@pytest.mark.asyncio
async def test_tdengine_schema_missing_retryable_hold_and_partial_isolation() -> None:
    cat, ids = _catalog_with_signal()
    pg = _FakePgStore(cat)
    td = _FakeTDEngine()
    w = IngestionWorker(pg_store=pg, tdengine=td)  # type: ignore[arg-type]

    # Case A: Schema missing (retryable=False in driver) triggers ensure_operational_schema retry & succeeds
    o1 = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        value=11.5,
    )
    td.scripted.append(TDEngineError("QUERY_FAILED", "Table does not exist", retryable=False))
    res = await w.ingest_direct_bytes([(o1.to_json_bytes(), {}, o1.event_uid, False)])
    assert res == [ConsumeOutcome.ACK]
    assert len(td.ensured) == 2

    # Case B: Retryable outage (6 failures) is absorbed in-worker without returning RETRY to RMQ
    o2 = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        value=12.5,
    )
    for _ in range(3):
        td.scripted.append(TDEngineError("CONN", "ws down", retryable=True))
    res2 = await w.ingest_direct_bytes([(o2.to_json_bytes(), {}, o2.event_uid, False)])
    assert res2 == [ConsumeOutcome.ACK]
    assert w.metrics.tdengine_retryable_errors == 3

    # Case C: Partial batch failure isolates ONLY permanent bad item while good sibling commits
    good = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        value=13.5,
        seq=10,
    )
    bad = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
        value=14.5,
        seq=11,
    )

    def _partial(recs: list[dict[str, Any]]) -> BatchWriteResult:
        td.writes.append(list(recs))
        return BatchWriteResult(
            succeeded_ids=(good.event_uid,),
            failures=(BatchWriteFailure(bad.event_uid, "sub_1", "BAD_TYPE", "Permanent type error", retryable=False),),
        )

    td.scripted.append(_partial)
    res3 = await w.ingest_direct_bytes(
        [
            (good.to_json_bytes(), {}, good.event_uid, False),
            (bad.to_json_bytes(), {}, bad.event_uid, False),
        ]
    )
    assert res3 == [ConsumeOutcome.ACK, ConsumeOutcome.DEAD_LETTER]
    assert len(pg.quarantined) == 1 and pg.quarantined[0]["event_uid"] == bad.event_uid
    assert pg.commits[-1]["latest_rows"][0]["event_uid"] == good.event_uid


@pytest.mark.asyncio
async def test_in_batch_and_lru_dedup_and_redelivery_replay() -> None:
    cat, ids = _catalog_with_signal()
    pg = _FakePgStore(cat)
    td = _FakeTDEngine()
    w = IngestionWorker(pg_store=pg, tdengine=td)  # type: ignore[arg-type]

    obs = _make_obs(
        tenant_id=ids["tenant_id"],
        signal_id=ids["signal_id"],
        resource_id=ids["resource_id"],
        connection_id=ids["connection_id"],
        source_field_id=ids["field_id"],
        site_id=ids["site_id"],
    )
    # Same batch duplicate -> processed once, dedup_hits += 1
    res = await w.ingest_direct_bytes(
        [
            (obs.to_json_bytes(), {}, obs.event_uid, False),
            (obs.to_json_bytes(), {}, obs.event_uid, False),
        ]
    )
    assert res == [ConsumeOutcome.ACK, ConsumeOutcome.ACK]
    assert len(td.writes[-1]) == 1
    assert w.metrics.dedup_hits == 1

    # Fresh non-redelivered message with same UID hits LRU
    res2 = await w.ingest_direct_bytes([(obs.to_json_bytes(), {}, obs.event_uid, False)])
    assert res2 == [ConsumeOutcome.ACK]
    assert w.metrics.dedup_hits == 2

    # Broker redelivered=True bypasses LRU so unACKed crash recovery still commits cleanly
    writes_before = len(td.writes)
    res3 = await w.ingest_direct_bytes([(obs.to_json_bytes(), {}, obs.event_uid, True)])
    assert res3 == [ConsumeOutcome.ACK]
    assert len(td.writes) == writes_before + 1


@pytest.mark.asyncio
async def test_synchronous_formula_cascade_bounded_to_depth_4() -> None:
    tid = uuid4()
    rid = uuid4()
    cid = uuid4()
    fid = uuid4()
    stid = uuid4()
    s = [uuid4() for _ in range(6)]  # s0 -> s1 (d0) -> s2 (d1) -> s3 (d2) -> s4 (d3) -> s5 (d4 skipped!)
    formulas = [uuid4() for _ in range(5)]

    formulas_by_dep: dict[UUID, list[dict[str, Any]]] = {}
    formula_aliases: dict[UUID, list[dict[str, Any]]] = {}
    for idx in range(5):
        f_id = formulas[idx]
        dep = s[idx]
        out = s[idx + 1]
        formulas_by_dep[dep] = [
            {
                "dependency_signal_id": dep,
                "formula_id": f_id,
                "output_id": out,
                "expression_source": "x + 1",
                "revision": 1,
                "resource_id": rid,
                "data_type": "float64",
                "unit": "°C",
                "expected_interval_ms": 1000,
                "site_id": stid,
            }
        ]
        formula_aliases[f_id] = [{"formula_id": f_id, "variable_alias": "x", "dependency_signal_id": dep}]

    cat = TenantCatalog(
        tenant_id=tid,
        active_epoch=1,
        lifecycle_state="ACTIVE",
        bindings={
            s[0]: [
                {
                    "signal_id": s[0],
                    "valid_from": datetime(2026, 1, 1, tzinfo=timezone.utc),
                    "valid_to": None,
                    "resource_id": rid,
                    "expected_interval_ms": 1000,
                    "site_id": stid,
                    "connection_id": cid,
                    "source_field_id": fid,
                    "nullable": False,
                }
            ]
        },
        formula_inputs={s[0], s[1], s[2], s[3], s[4]},
        formulas_by_dep=formulas_by_dep,
        formula_aliases=formula_aliases,
    )
    pg = _FakePgStore(cat)
    td = _FakeTDEngine()
    w = IngestionWorker(pg_store=pg, tdengine=td)  # type: ignore[arg-type]

    obs = _make_obs(
        tenant_id=tid,
        signal_id=s[0],
        resource_id=rid,
        connection_id=cid,
        source_field_id=fid,
        site_id=stid,
        value=10.0,
    )
    out = await w.ingest_direct_bytes([(obs.to_json_bytes(), {}, obs.event_uid, False)])
    assert out == [ConsumeOutcome.ACK]

    # td.writes[0] = raw s[0], td.writes[1] = 4 calculated hops (s[1]..s[4]), depth 4 (s[5]) skipped!
    assert len(td.writes) == 2
    calc_records = td.writes[1]
    assert [r["signal_id"] for r in calc_records] == [s[1], s[2], s[3], s[4]]
    assert [r["val"] if "val" in r else r["value"] for r in calc_records] == [11.0, 12.0, 13.0, 14.0]
    assert all(r["event_uid"].startswith("calc:") for r in calc_records)
    latest_by_sig = {r["signal_id"]: r["value"] for r in pg.commits[-1]["latest_rows"]}
    assert s[5] not in latest_by_sig
    assert latest_by_sig == {s[0]: 10.0, s[1]: 11.0, s[2]: 12.0, s[3]: 13.0, s[4]: 14.0}


@pytest.mark.asyncio
async def test_emit_chunked_notify_respects_count_and_8kb_limit() -> None:
    calls: list[tuple[str, str]] = []

    class _Conn:
        async def execute(self, _sql: str, channel: str, payload: str) -> None:
            calls.append((channel, payload))

    conn = _Conn()
    events = [
        {"kind": "latest", "tenant_id": "t1", "signal_id": f"s{i}", "payload": {"value": i}}
        for i in range(45)
    ]
    await _emit_chunked_notify(conn, "factorix_stream_events", events)  # type: ignore[arg-type]
    assert len(calls) == 3
    counts = [len(json.loads(p)["events"]) for _, p in calls]
    assert counts == [20, 20, 5]
    assert all(len(p.encode("utf-8")) < 8000 for _, p in calls)

    # Wide single event shrinks payload value field automatically if > 7900 bytes
    calls.clear()
    huge_event = {
        "kind": "latest",
        "tenant_id": "t1",
        "signal_id": "s-big",
        "payload": {"type": "latest", "signal_id": "s-big", "value": "A" * 9000},
    }
    await _emit_chunked_notify(conn, "factorix_stream_events", [huge_event])  # type: ignore[arg-type]
    assert len(calls) == 1
    assert len(calls[0][1].encode("utf-8")) < 8000
    assert "value" not in json.loads(calls[0][1])["events"][0]["payload"]


@pytest.mark.asyncio
async def test_overview_and_ready_report_degraded_or_503_when_ingestion_missing_under_tdengine(monkeypatch: pytest.MonkeyPatch) -> None:
    from factorix.platform.errors import AppError
    from factorix.transport import app as transport_app

    now = datetime.now(timezone.utc)
    fake_settings = MagicMock()
    fake_settings.appliance = True
    fake_settings.collector_mode = "acquisition"
    fake_settings.tdengine_dsn = "ws://root:taosdata@127.0.0.1:6041"
    monkeypatch.setattr(transport_app, "settings", fake_settings)

    class _FakeNested:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *_args: Any) -> bool:
            return False

    class _FakeSession:
        def begin_nested(self) -> _FakeNested:
            return _FakeNested()

    # Case 1: /health/ready fails with INGESTION_DOWN when acquisition is fresh but ingestion row is missing
    acq_only_rows = [{"role": "acquisition", "health": "HEALTHY", "broker_ok": True, "last_heartbeat": now}]
    monkeypatch.setattr(transport_app, "fetch_one", AsyncMock(return_value={"ok": 1}))
    monkeypatch.setattr(transport_app, "fetch_all", AsyncMock(return_value=acq_only_rows))
    with pytest.raises(AppError) as exc:
        await transport_app.ready(session=_FakeSession())  # type: ignore[arg-type]
    assert exc.value.code == "INGESTION_DOWN"

    # Case 2: /health/ready succeeds when both acquisition & ingestion heartbeats are fresh
    both_rows = [
        {"role": "acquisition", "health": "HEALTHY", "broker_ok": True, "last_heartbeat": now},
        {"role": "ingestion", "health": "HEALTHY", "broker_ok": True, "last_heartbeat": now},
    ]
    monkeypatch.setattr(transport_app, "fetch_all", AsyncMock(return_value=both_rows))
    assert await transport_app.ready(session=_FakeSession()) == {"status": "ready"}  # type: ignore[arg-type]

    # Case 3: /api/v1/overview marks collector_status='DEGRADED' when tdengine_dsn is set and ingestion row is missing
    async def _fake_fetch_one(_s: Any, sql: str, _p: dict[str, Any]) -> dict[str, Any]:
        if "FROM resources r" in sql or "FROM resources WHERE" in sql:
            return {"count": 1}
        if "latest_signal_state" in sql:
            return {"last_at": now}
        return {}

    async def _fake_fetch_all(_s: Any, sql: str, _p: dict[str, Any]) -> list[dict[str, Any]]:
        if "collector_runtime_status" in sql:
            return [{"instance_id": "acq-1", "role": "acquisition", "health": "HEALTHY", "broker_ok": True, "last_heartbeat": now}]
        return []

    monkeypatch.setattr(transport_app, "fetch_one", _fake_fetch_one)
    monkeypatch.setattr(transport_app, "fetch_all", _fake_fetch_all)
    monkeypatch.setattr(transport_app.collect, "list_connections", AsyncMock(return_value=[]))
    monkeypatch.setattr(transport_app.telemetry, "storage_overview", AsyncMock(return_value={"ingest_per_minute": 12}))

    ov = await transport_app.overview(principal={"tenant_id": str(uuid4()), "admin_id": str(uuid4())}, session=_FakeSession())  # type: ignore[arg-type]
    assert ov["collector_status"] == "DEGRADED"

