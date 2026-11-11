"""Comprehensive unit tests for S07 Managed Recording Policy Engine (§5.3)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from factorix.domain.canonical import CanonicalObservation, CanonicalProvenance
from factorix.domain.quality import Origin, Quality
from factorix.modules.providers import RecordingMode, SkipReason
from factorix.modules.recording_policy import (
    DefaultRecordingPolicyEvaluator,
    ManagedBindingTarget,
    PolicyMetricsCounter,
    build_managed_target_from_row,
    canonical_values_compare,
)
from factorix.modules.storage_dsl import validate_safe_transform


def _utc(sec: float = 0.0) -> datetime:
    return datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc) + timedelta(seconds=sec)


def _target(
    *,
    design_id: UUID | None = None,
    dataset_id: UUID | None = None,
    signal_id: UUID | None = None,
    field_key: str = "val_f",
    value_type: str = "float64",
    mode: RecordingMode = RecordingMode.ON_CHANGE,
    deadband_kind: str | None = None,
    deadband_value: float | None = None,
    max_checkpoint_ms: int | None = None,
    interval_ms: int | None = None,
    late_tolerance_ms: int | None = 300_000,
    missing_policy: str = "GAP_MARKER",
    transform_expr: str | None = None,
    nullable: bool = True,
    max_length: int | None = None,
    source_revision: int = 1,
    policy_version: int = 1,
    design_status: str = "RUNNING",
    dataset_status: str = "RUNNING",
    registry_status: str = "ACTIVE",
    policy_enabled: bool = True,
    time_axis: str = "acquired_at",
) -> ManagedBindingTarget:
    did = design_id or uuid4()
    dsid = dataset_id or uuid4()
    sid = signal_id or uuid4()
    ast_node, _issues = validate_safe_transform(transform_expr) if transform_expr else (None, [])
    return ManagedBindingTarget(
        design_id=did,
        design_version_id=uuid4(),
        dataset_id=dsid,
        tag_dataset_id=str(dsid),
        dataset_key="ds_test",
        design_status=design_status,
        dataset_status=dataset_status,
        registry_status=registry_status,
        semantics="state_series",
        time_axis=time_axis,  # type: ignore[arg-type]
        td_database=f"fx_t_{uuid4().hex}",
        td_stable=f"ds_{did.hex[:8]}_ds_test_v1",
        td_subtable=f"md_{dsid.hex[:8]}_0123456789abcdef",
        series_key=f"sig:{sid}",
        field_key=field_key,
        value_type=value_type,
        max_length=max_length,
        nullable=nullable,
        required=not nullable,
        signal_id=sid,
        model_id=None,
        model_field_path=None,
        resource_id=uuid4(),
        source_revision=source_revision,
        transform_expr=transform_expr,
        transform_ast=ast_node,
        mode=mode,
        deadband_kind=deadband_kind,  # type: ignore[arg-type]
        deadband_value=deadband_value,
        max_checkpoint_interval_ms=max_checkpoint_ms,
        interval_ms=interval_ms,
        late_tolerance_ms=late_tolerance_ms,
        missing_policy=missing_policy,  # type: ignore[arg-type]
        policy_version=policy_version,
        policy_enabled=policy_enabled,
    )


def _obs(
    *,
    tenant_id: UUID,
    signal_id: UUID,
    resource_id: UUID,
    value: Any,
    value_type: str = "float64",
    quality: Quality = Quality.GOOD,
    reason: str | None = None,
    origin: Origin = Origin.LIVE,
    sec: float = 0.0,
    source_sec: float | None = None,
    epoch: int = 1,
    uid: str | None = None,
) -> CanonicalObservation:
    acq = _utc(sec)
    src = _utc(source_sec) if source_sec is not None else acq - timedelta(milliseconds=5)
    return CanonicalObservation(
        event_uid=uid or f"uid-{uuid4().hex[:12]}",
        tenant_id=tenant_id,
        signal_id=signal_id,
        resource_id=resource_id,
        acquired_at=acq,
        source_time=src,
        value_type=value_type,
        value=value,
        quality=quality,
        quality_reason=reason,
        origin=origin,
        data_epoch=epoch,
        config_revision=1,
        provenance=CanonicalProvenance(protocol="opcua"),
    )


def test_canonical_values_compare_handles_all_types_and_edge_cases() -> None:
    # float64 signed zero & equality
    assert canonical_values_compare(-0.0, 0.0, value_type="float64") == (True, False)
    assert canonical_values_compare(float("nan"), 1.0, value_type="float64") == (False, False)
    assert canonical_values_compare(1.0, float("inf"), value_type="float64") == (False, False)

    # absolute & percent deadband incl. boundary tolerance and old=0 behavior
    assert canonical_values_compare(10.0, 10.5, value_type="float64", deadband_kind="absolute", deadband_value=0.5) == (True, True)
    assert canonical_values_compare(10.0, 10.6, value_type="float64", deadband_kind="absolute", deadband_value=0.5) == (False, False)
    assert canonical_values_compare(100.0, 104.9, value_type="float64", deadband_kind="percent", deadband_value=5.0) == (True, True)
    assert canonical_values_compare(100.0, 105.0, value_type="float64", deadband_kind="percent", deadband_value=5.0) == (True, True)
    assert canonical_values_compare(100.0, 105.1, value_type="float64", deadband_kind="percent", deadband_value=5.0) == (False, False)
    # Departure from 0 under percent deadband must trigger write cleanly (no division by zero)
    assert canonical_values_compare(0.0, 0.01, value_type="float64", deadband_kind="percent", deadband_value=5.0) == (False, False)

    # int64 deadband + big ints
    assert canonical_values_compare(2**62, 2**62 + 5, value_type="int64", deadband_kind="absolute", deadband_value=5) == (True, True)
    assert canonical_values_compare(2**62, 2**62 + 6, value_type="int64", deadband_kind="absolute", deadband_value=5) == (False, False)

    # bool strictness (never coerced softly)
    assert canonical_values_compare(True, True, value_type="bool") == (True, False)
    assert canonical_values_compare(True, False, value_type="bool") == (False, False)

    # Unicode NFKC normalization
    assert canonical_values_compare("e\u0301", "\u00e9", value_type="string") == (True, False)
    assert canonical_values_compare("OK", "ERR", value_type="enum") == (False, False)

    # JSON key ordering canonical equivalence
    assert canonical_values_compare({"b": 2, "a": 1}, '{"a":1,"b":2}', value_type="json") == (True, False)
    assert canonical_values_compare({"a": 1}, {"a": 2}, value_type="json") == (False, False)

    # UTC timestamp equivalence across tz offsets
    dt_utc = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
    dt_p7 = datetime(2026, 11, 10, 19, 0, 0, tzinfo=timezone(timedelta(hours=7)))
    assert canonical_values_compare(dt_utc, dt_p7, value_type="timestamp") == (True, False)


def test_on_change_baseline_deadband_anchor_quality_checkpoint_and_late() -> None:
    tid = uuid4()
    tgt = _target(
        mode=RecordingMode.ON_CHANGE,
        deadband_kind="absolute",
        deadband_value=1.0,
        max_checkpoint_ms=10_000,
        late_tolerance_ms=5_000,
    )
    rid = tgt.resource_id
    sid = tgt.signal_id
    assert rid is not None and sid is not None
    ev = DefaultRecordingPolicyEvaluator(targets_by_signal={sid: [tgt]})

    # 1. Baseline written
    r1 = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=10.0, sec=0),
        targets=[tgt],
    )
    assert len(r1.writes) == 1 and r1.writes[0].record_kind == "MANAGED_RECORDED" and r1.writes[0].value == 10.0

    # 2. Slow drift test: 10.4 (within 1.0 of 10.0 -> skip), 10.8 (within 1.0 of 10.0 -> skip),
    #    11.1 (> 1.0 from LAST RECORDED 10.0! If deadband wrongly anchored to 10.8 it would miss!)
    r2 = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=10.4, sec=2), targets=[tgt])
    assert len(r2.writes) == 0 and r2.decision.managed_directives[0].skip_reason == SkipReason.WITHIN_DEADBAND

    r3 = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=10.8, sec=4), targets=[tgt])
    assert len(r3.writes) == 0 and r3.decision.managed_directives[0].skip_reason == SkipReason.WITHIN_DEADBAND

    # 3. Same quality + identical at t=11 -> >= 10s checkpoint triggers checkpoint with anchored 10.0!
    r_cp = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=10.4, sec=11), targets=[tgt])
    assert len(r_cp.writes) == 1
    assert r_cp.writes[0].record_kind == "checkpoint"
    assert r_cp.writes[0].value == 10.0
    assert r_cp.decision.managed_directives[0].keepalive_triggered is True

    # Now 11.1 > 1.0 from anchored 10.0 -> writes recorded change!
    r4 = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=11.1, sec=12), targets=[tgt])
    assert len(r4.writes) == 1 and r4.writes[0].value == 11.1

    # 4. Unchanged value with quality change GOOD -> BAD (plus reason_code) MUST write!
    r_bad = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=11.1, quality=Quality.BAD, reason="TIMEOUT", sec=13),
        targets=[tgt],
    )
    assert len(r_bad.writes) == 1 and r_bad.writes[0].raw_quality == "BAD" and r_bad.writes[0].reason_code == "TIMEOUT"

    # 5. Late backfill inside lateTolerance (sec=9, frontier at sec=13, 4s <= 5s) writes without moving frontier;
    #    late beyond tolerance (sec=1, 12s > 5s) is skipped.
    r_late_ok = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=99.0, sec=9), targets=[tgt])
    assert len(r_late_ok.writes) == 1
    r_late_drop = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=98.0, sec=1), targets=[tgt])
    assert len(r_late_drop.writes) == 0

    # Verify late write did not rewind baseline from sec=13 (BAD, 11.1): recovery BAD -> GOOD (11.1) writes!
    r_rec = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=11.1, quality=Quality.GOOD, sec=15),
        targets=[tgt],
    )
    assert len(r_rec.writes) == 1 and r_rec.writes[0].raw_quality == "GOOD"


def test_every_acquisition_keeps_distinct_identical_events_and_test_origin_dropped() -> None:
    tid = uuid4()
    tgt = _target(mode=RecordingMode.EVERY_ACQUISITION, value_type="string")
    rid, sid = tgt.resource_id, tgt.signal_id
    assert rid is not None and sid is not None
    ev = DefaultRecordingPolicyEvaluator()

    res1 = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value="ALARM_ON", value_type="string", sec=1, uid="ev-a"),
        targets=[tgt],
    )
    res2 = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value="ALARM_ON", value_type="string", sec=2, uid="ev-b"),
        targets=[tgt],
    )
    assert len(res1.writes) == 1 and len(res2.writes) == 1
    assert res1.writes[0].event_uid != res2.writes[0].event_uid

    res_test = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value="NOOP", value_type="string", origin=Origin.TEST, sec=3),
        targets=[tgt],
    )
    assert res_test.decision.write_operational is False and len(res_test.writes) == 0


def test_interval_buckets_intra_bucket_quality_and_gap_markers_across_missing_policies() -> None:
    tid = uuid4()
    tgt_gap = _target(
        mode=RecordingMode.INTERVAL,
        interval_ms=5_000,
        late_tolerance_ms=5_000,
        max_checkpoint_ms=15_000,
        missing_policy="GAP_MARKER",
    )
    tgt_hold = _target(
        dataset_id=uuid4(),
        mode=RecordingMode.INTERVAL,
        interval_ms=5_000,
        late_tolerance_ms=5_000,
        max_checkpoint_ms=15_000,
        missing_policy="HOLD_LAST_WITH_QUALITY",
    )
    tgt_null = _target(
        dataset_id=uuid4(),
        mode=RecordingMode.INTERVAL,
        interval_ms=5_000,
        late_tolerance_ms=5_000,
        missing_policy="NULL",
    )
    rid, sid = tgt_gap.resource_id, tgt_gap.signal_id
    assert rid is not None and sid is not None
    ev = DefaultRecordingPolicyEvaluator()

    # Bucket 0 at sec=1 -> writes bucket_ts = t+0
    r0 = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=50.0, sec=1), targets=[tgt_gap, tgt_hold, tgt_null])
    assert len(r0.writes) == 3

    # Same bucket sec=3 with SAME quality -> suppressed
    r0_dup = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=55.0, sec=3), targets=[tgt_gap])
    assert len(r0_dup.writes) == 0 and r0_dup.decision.managed_directives[0].skip_reason == SkipReason.INTERVAL_NOT_ELAPSED

    # Same bucket sec=4 with BAD quality transition -> MUST record quality transition inside bucket!
    r0_bad = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=55.0, quality=Quality.BAD, reason="COMM_LOST", sec=4),
        targets=[tgt_gap],
    )
    assert len(r0_bad.writes) == 1 and r0_bad.writes[0].raw_quality == "BAD"

    # Jump to bucket 5 (sec=26 -> buckets 1, 2, 3, 4 missed -> 4 empty intervals before bucket 5!)
    # Check max_checkpoint_ms=15s on HOLD_LAST_WITH_QUALITY: bucket 1 (t+5), 2 (t+10), 3 (t+15) within 15s hold -> interval_held; bucket 4 (t+20 > t+1+15=t+16) -> gap_marker!
    r5 = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=60.0, sec=26), targets=[tgt_gap, tgt_hold, tgt_null])
    gap_rows = [w for w in r5.writes if w.target.dataset_id == tgt_gap.dataset_id and w.record_kind == "gap_marker"]
    hold_rows = [w for w in r5.writes if w.target.dataset_id == tgt_hold.dataset_id]
    null_rows = [w for w in r5.writes if w.target.dataset_id == tgt_null.dataset_id and w.record_kind == "interval_null"]
    assert len(gap_rows) == 4 and all(w.raw_quality == "BAD" and w.value is None for w in gap_rows)
    assert [w.record_kind for w in hold_rows[:4]] == ["interval_held", "interval_held", "interval_held", "gap_marker"]
    assert hold_rows[0].raw_quality == "UNCERTAIN" and hold_rows[0].value == 50.0
    assert len(null_rows) == 4 and all(w.raw_quality == "BAD" and w.reason_code == "INTERVAL_MISSING" for w in null_rows)

    # Sweep quiet stream after another 15s without new arrival (now = sec=45, lateTolerance=5s -> closed up to bucket 7)
    swept = ev.sweep_interval_gaps(tid, targets=[tgt_gap], active_epoch=1, now=_utc(46))
    assert len(swept) == 2  # buckets 6 and 7 closed!


def test_paused_epoch_fence_safe_transform_lineage_reset_and_timestamp_item() -> None:
    tid = uuid4()
    tgt_paused = _target(dataset_status="PAUSED")
    tgt_tx = _target(transform_expr="value / (value - 10)", nullable=True)
    tgt_ts = _target(value_type="timestamp")
    rid = tgt_paused.resource_id
    sid = tgt_paused.signal_id
    assert rid is not None and sid is not None
    ev = DefaultRecordingPolicyEvaluator()

    # 1. Paused policy emits Operational only (no Managed rows)
    rp = ev.evaluate_for_targets(_obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=12.0, sec=1), targets=[tgt_paused])
    assert rp.decision.write_operational is True
    assert rp.writes == () and rp.decision.managed_directives[0].skip_reason == SkipReason.POLICY_PAUSED

    # 2. Epoch fenced
    re_f = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=12.0, epoch=1, sec=1),
        targets=[tgt_tx],
        active_epoch=2,
    )
    assert re_f.decision.write_operational is False
    assert re_f.decision.managed_directives[0].skip_reason == SkipReason.EPOCH_FENCED

    # 3. Transform div0 -> BAD / TRANSFORM_ERROR (no exception escape)
    rt = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value=10.0, epoch=2, sec=2),
        targets=[tgt_tx],
        active_epoch=2,
    )
    assert len(rt.writes) == 1 and rt.writes[0].raw_quality == "BAD" and rt.writes[0].reason_code == "TRANSFORM_ERROR"

    # 4. Epoch bump & policy_version bump write fresh baseline even for identical value
    ev2 = DefaultRecordingPolicyEvaluator()
    tgt_v1 = _target(policy_version=1, source_revision=1)
    assert tgt_v1.signal_id is not None and tgt_v1.resource_id is not None
    ev2.evaluate_for_targets(_obs(tenant_id=tid, signal_id=tgt_v1.signal_id, resource_id=tgt_v1.resource_id, value=7.0, sec=1), targets=[tgt_v1])
    tgt_v2 = _target(
        design_id=tgt_v1.design_id,
        dataset_id=tgt_v1.dataset_id,
        signal_id=tgt_v1.signal_id,
        policy_version=2,
        source_revision=1,
    )
    rv2 = ev2.evaluate_for_targets(_obs(tenant_id=tid, signal_id=tgt_v1.signal_id, resource_id=tgt_v1.resource_id, value=7.0, sec=2), targets=[tgt_v2])
    assert len(rv2.writes) == 1

    # 5. Timestamp SubtableWriteItem keeps datetime object cleanly for sql_literal!
    r_ts = ev.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=sid, resource_id=rid, value="2026-11-10T12:00:05Z", value_type="string", sec=5),
        targets=[tgt_ts],
    )
    item = r_ts.writes[0].to_subtable_item()
    assert isinstance(item.values[-1], datetime) and item.value_types[-1] == "timestamp"

    # 6. Catalog row construction & seed_series_state_from_row cold recovery
    ds_id = uuid4()
    row_target = build_managed_target_from_row(
        {
            "design_id": tgt_v1.design_id,
            "dataset_id": ds_id,
            "dataset_key": "k1",
            "td_database": "fx_t_abc",
            "td_stable": "ds_x_k1_v1",
            "td_subtable": "md_x_1",
            "registry_series_key": f"{tgt_v1.design_id}:sig:{tgt_v1.signal_id}",
            "field_key": "temp",
            "value_type": "float64",
            "signal_id": tgt_v1.signal_id,
            "recording_mode": "ON_CHANGE",
            "policy_json": {"deadband": {"kind": "absolute", "value": 0.5}, "maxCheckpointInterval": "30s"},
            "source_revision": 1,
            "policy_version": 1,
        }
    )
    ev3 = DefaultRecordingPolicyEvaluator()
    ev3.seed_series_state_from_row(
        tid,
        row_target,
        {"ts": _utc(0), "acquired_at": _utc(0), "raw_quality": "GOOD", "data_epoch": 1, "event_uid": "u0", "temp": 20.0},
        active_epoch=1,
    )
    after_seed = ev3.evaluate_for_targets(
        _obs(tenant_id=tid, signal_id=tgt_v1.signal_id, resource_id=row_target.resource_id or rid, value=20.2, sec=2),
        targets=[row_target],
    )
    assert len(after_seed.writes) == 0 and after_seed.decision.managed_directives[0].skip_reason == SkipReason.WITHIN_DEADBAND
    assert ev3.metrics.managed_skipped_by_reason[SkipReason.WITHIN_DEADBAND.value] == 1
    assert isinstance(ev3.metrics, PolicyMetricsCounter)

    row_ds_prefixed = build_managed_target_from_row(
        {
            "design_id": tgt_v1.design_id,
            "dataset_id": ds_id,
            "dataset_key": "k2",
            "td_database": "fx_t_abc",
            "td_stable": "ds_x_k2_v1",
            "td_subtable": "md_x_2",
            "registry_series_key": f"{ds_id}:sig:{tgt_v1.signal_id}",
            "field_key": "temp",
            "value_type": "float64",
            "signal_id": tgt_v1.signal_id,
            "recording_mode": "ON_CHANGE",
        }
    )
    assert row_ds_prefixed.series_key == f"sig:{tgt_v1.signal_id}"
