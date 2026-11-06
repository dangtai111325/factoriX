"""Clean body composition (data_clean.md): timestamp rule, key order, formats, events."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from factorix.domain.body import (
    BUILTIN_TEMPLATES,
    BodyError,
    compose_body,
    content_hash,
    event_dedupe_key,
    fmt_ms,
    new_trigger_times,
    normalize_emit_policy,
    normalize_members,
    publish_aliases_of,
    republish_body,
    resolve_context,
    row_at,
    snapshot_value_at,
)

T0 = datetime(2026, 6, 20, 8, 0, 0, tzinfo=timezone.utc)
NOW = datetime(2026, 6, 20, 9, 30, 15, 123456, tzinfo=timezone.utc)

CONTEXT = {
    "zone.name": "ASSY",
    "line.name": "Assembly - L1 (A1)",
    "machine.name": "M-01",
}


def _head(machine: bool = True) -> list[dict]:
    head = [
        {"kind": "context", "alias": "zone_name", "context_ref": "zone.name"},
        {"kind": "context", "alias": "line_name", "context_ref": "line.name"},
    ]
    if machine:
        head.append({"kind": "context", "alias": "machine_name", "context_ref": "machine.name"})
    return head + [
        {"kind": "system", "alias": "source_timestamp", "field": "source_timestamp"},
        {"kind": "system", "alias": "publish_timestamp", "field": "publish_timestamp"},
    ]


def _state_members() -> list[dict]:
    return _head() + [
        {"kind": "signal", "alias": "status", "signal_id": "s-status"},
        {"kind": "signal", "alias": "mode", "signal_id": "s-mode"},
        {"kind": "signal", "alias": "stop_error", "signal_id": "s-stop"},
        {"kind": "signal", "alias": "employee", "signal_id": "s-emp"},
    ]


def _row(value, source_time=None, received_time=None):
    return {"value": value, "source_time": source_time, "received_time": received_time or T0}


def _state_latest(t1, t2):
    # machine-state group stamped t1, operator group stamped t2
    return {
        "s-status": _row(1, t1),
        "s-mode": _row(2, t1),
        "s-stop": _row(None, t1),
        "s-emp": _row("E-7", t2),
    }


# ---- source_timestamp rule ----------------------------------------------------------------


def test_source_ts_takes_later_group_t2_after_t1():
    t1, t2 = T0, T0 + timedelta(minutes=5)
    _text, body, ts, alias, _h = compose_body(_state_members(), _state_latest(t1, t2), CONTEXT, NOW)
    assert ts == t2
    assert body["source_timestamp"] == fmt_ms(t2)
    assert alias == "employee"


def test_source_ts_takes_later_group_t1_after_t2():
    t1, t2 = T0 + timedelta(minutes=5), T0
    _text, body, ts, alias, _h = compose_body(_state_members(), _state_latest(t1, t2), CONTEXT, NOW)
    assert ts == t1
    assert body["source_timestamp"] == fmt_ms(t1)
    assert alias == "status"


def test_source_ts_equal_groups():
    _text, body, ts, alias, _h = compose_body(_state_members(), _state_latest(T0, T0), CONTEXT, NOW)
    assert ts == T0
    assert body["source_timestamp"] == "2026-06-20T08:00:00.000Z"
    assert alias == "status"  # first contributor in member order wins a tie


def test_single_group_body_takes_that_group_ts():
    members = _head() + [{"kind": "signal", "alias": "power", "signal_id": "p"}]
    latest = {"p": _row(12.5, T0 + timedelta(seconds=3))}
    _text, body, ts, _alias, _h = compose_body(members, latest, CONTEXT, NOW)
    assert body["source_timestamp"] == fmt_ms(T0 + timedelta(seconds=3))
    assert ts == T0 + timedelta(seconds=3)


def test_null_value_still_contributes_ts():
    members = _head() + [
        {"kind": "signal", "alias": "status", "signal_id": "a"},
        {"kind": "signal", "alias": "stop_error", "signal_id": "b"},
    ]
    later = T0 + timedelta(minutes=1)
    latest = {"a": _row(3, T0), "b": _row(None, later)}
    _text, body, ts, alias, _h = compose_body(members, latest, CONTEXT, NOW)
    assert body["stop_error"] is None
    assert ts == later and alias == "stop_error"


def test_signal_without_latest_row_does_not_contribute():
    members = _head() + [
        {"kind": "signal", "alias": "status", "signal_id": "a"},
        {"kind": "signal", "alias": "employee", "signal_id": "missing"},
    ]
    _text, body, ts, _alias, _h = compose_body(members, {"a": _row(1, T0)}, CONTEXT, NOW)
    assert body["employee"] is None
    assert ts == T0


def test_no_contributor_gives_null_source_timestamp():
    _text, body, ts, alias, _h = compose_body(_head(), {}, CONTEXT, NOW)
    assert body["source_timestamp"] is None and ts is None and alias is None


def test_received_time_fallback_when_source_reports_none():
    members = _head() + [{"kind": "signal", "alias": "status", "signal_id": "a"}]
    received = T0 + timedelta(seconds=9)
    _text, body, _ts, _alias, _h = compose_body(members, {"a": _row(1, None, received)}, CONTEXT, NOW)
    assert body["source_timestamp"] == fmt_ms(received)


def test_contributes_false_and_context_never_count():
    members = _head() + [
        {"kind": "signal", "alias": "status", "signal_id": "a"},
        {"kind": "signal", "alias": "employee", "signal_id": "b", "contributes_ts": False},
        {"kind": "constant", "alias": "plant", "value": "P1"},
    ]
    latest = {"a": _row(1, T0), "b": _row("E", T0 + timedelta(hours=1))}
    _text, body, ts, _alias, _h = compose_body(members, latest, CONTEXT, NOW)
    assert ts == T0
    assert body["plant"] == "P1"


def test_publish_timestamp_is_platform_clock_not_source():
    _text, body, _ts, _alias, _h = compose_body(_state_members(), _state_latest(T0, T0), CONTEXT, NOW)
    assert body["publish_timestamp"] == "2026-06-20T09:30:15.123Z"
    assert body["publish_timestamp"] != body["source_timestamp"]


# ---- formats ------------------------------------------------------------------------------


def test_fmt_ms_exactly_three_digits_utc():
    assert fmt_ms(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)) == "2026-01-02T03:04:05.000Z"
    assert fmt_ms(datetime(2026, 1, 2, 3, 4, 5, 999999, tzinfo=timezone.utc)) == "2026-01-02T03:04:05.999Z"
    plus7 = timezone(timedelta(hours=7))
    assert fmt_ms(datetime(2026, 1, 2, 10, 4, 5, 120000, tzinfo=plus7)) == "2026-01-02T03:04:05.120Z"
    assert fmt_ms("2026-01-02T03:04:05.1Z") == "2026-01-02T03:04:05.100Z"
    assert fmt_ms(None) is None


def test_body_text_is_compact_ordered_and_unicode():
    members = _head() + [{"kind": "signal", "alias": "employee", "signal_id": "e"}]
    text, _body, _ts, _alias, _h = compose_body(members, {"e": _row("Nguyễn", T0)}, CONTEXT, NOW)
    assert text.startswith('{"zone_name":"ASSY","line_name":"Assembly - L1 (A1)","machine_name":"M-01","source_timestamp":')
    assert "Nguyễn" in text and ", " not in text.replace("Assembly - L1 (A1)", "")
    assert list(json.loads(text)) == ["zone_name", "line_name", "machine_name", "source_timestamp", "publish_timestamp", "employee"]


def test_missing_omit_policy_drops_signal_without_row():
    members = _head() + [{"kind": "signal", "alias": "a", "signal_id": "x"}]
    _text, body, _ts, _alias, _h = compose_body(members, {}, CONTEXT, NOW, projection={"mode": "compact", "missing": "omit"})
    assert "a" not in body


# ---- hash / republish ---------------------------------------------------------------------


def test_content_hash_ignores_publish_timestamp():
    latest = _state_latest(T0, T0)
    _t1, _b1, _s1, _a1, h1 = compose_body(_state_members(), latest, CONTEXT, NOW)
    _t2, _b2, _s2, _a2, h2 = compose_body(_state_members(), latest, CONTEXT, NOW + timedelta(seconds=30))
    assert h1 == h2
    changed = dict(latest, **{"s-status": _row(2, T0)})
    _t3, _b3, _s3, _a3, h3 = compose_body(_state_members(), changed, CONTEXT, NOW)
    assert h3 != h1


def test_republish_keeps_source_ts_and_order():
    members = _state_members()
    text, body, _ts, _alias, digest = compose_body(members, _state_latest(T0, T0), CONTEXT, NOW)
    later = NOW + timedelta(seconds=10)
    again = republish_body(text, publish_aliases_of(members), later)
    parsed = json.loads(again)
    assert list(parsed) == list(body)
    assert parsed["source_timestamp"] == body["source_timestamp"]
    assert parsed["publish_timestamp"] == fmt_ms(later)
    assert content_hash(parsed, ["publish_timestamp"]) == digest


# ---- context ------------------------------------------------------------------------------


def test_resolve_context_nearest_type_key():
    chain = [
        {"type_key": "machine", "name": "M-01", "code": "M01"},
        {"type_key": "line", "name": "Assembly - L1 (A1)", "code": "L1"},
        {"type_key": "zone", "name": "ASSY", "code": "ASSY"},
        {"type_key": "area", "name": "Area", "code": "AR"},
        {"type_key": "site", "name": "Site", "code": "S"},
        {"type_key": "enterprise", "name": "Ent", "code": "E"},
    ]
    ctx = resolve_context(chain)
    assert ctx["zone.name"] == "ASSY"
    assert ctx["line.name"] == "Assembly - L1 (A1)"
    assert ctx["machine.name"] == "M-01"
    assert ctx["self.code"] == "M01"
    assert ctx["enterprise.name"] == "Ent"
    assert ctx["cell.name"] is None


# ---- events -------------------------------------------------------------------------------


def test_snapshot_picks_order_active_at_completion_even_if_order_changed_after():
    completion = T0 + timedelta(minutes=10)
    wo_history = [
        {"value": "WO-1", "source_time": T0, "received_time": T0 + timedelta(seconds=1)},
        {"value": "WO-2", "source_time": completion + timedelta(seconds=5), "received_time": completion + timedelta(seconds=6)},
    ]
    found, value = snapshot_value_at(wo_history, completion)
    assert found and value == "WO-1"
    # order changed exactly at the completion instant: that order is the active one
    found, value = snapshot_value_at(wo_history + [{"value": "WO-3", "source_time": completion, "received_time": completion}], completion)
    assert value == "WO-3"
    assert snapshot_value_at(wo_history, T0 - timedelta(seconds=1)) == (False, None)
    assert row_at([], completion) is None


def test_event_body_uses_snapshot_values_and_completion_ts():
    template = next(t for t in BUILTIN_TEMPLATES if t["key"] == "order_progress")
    ids = {"so": "s-so", "wo": "s-wo", "qty": "s-qty", "lot_serial": "s-lot"}
    members = [dict(f, signal_id=ids[f["signal_key"]]) if f.get("signal_key") else f for f in template["fields"]]
    completion = T0 + timedelta(minutes=10)
    rows_at_completion = {"s-qty": _row(5, completion), "s-lot": _row("LOT-9", completion)}
    text, body, ts, _alias, _h = compose_body(members, rows_at_completion, CONTEXT, NOW, snapshot={"s-so": "SO-1", "s-wo": "WO-1"})
    assert list(body) == ["zone_name", "line_name", "source_timestamp", "publish_timestamp", "so", "wo", "qty", "lot_serial"]
    assert body["so"] == "SO-1" and body["wo"] == "WO-1"
    assert ts == completion and body["source_timestamp"] == fmt_ms(completion)
    assert "machine_name" not in text


def test_dedupe_key_idempotent():
    a = event_dedupe_key(T0)
    assert a == event_dedupe_key(T0.astimezone(timezone(timedelta(hours=7))))
    assert a == "ts:2026-06-20T08:00:00.000Z"
    assert event_dedupe_key(None, [5, "LOT"]) == event_dedupe_key(None, [5, "LOT"])
    assert event_dedupe_key(None, [5, "LOT"]) != event_dedupe_key(None, [6, "LOT"])


def test_new_trigger_times_after_last_event_only():
    t = [T0, T0 + timedelta(seconds=1), T0 + timedelta(seconds=2)]
    assert new_trigger_times(t + t, None) == [t[2]]  # first publish: newest completion only
    assert new_trigger_times(t, t[0]) == [t[1], t[2]]
    assert new_trigger_times(t, t[2]) == []  # repeated polls of the same completion: nothing new
    assert new_trigger_times([None, t[1]], t[0]) == [t[1]]


# ---- member rules -------------------------------------------------------------------------


def test_rules_exactly_one_source_timestamp():
    with pytest.raises(BodyError) as exc:
        normalize_members("STATE", [{"kind": "signal", "alias": "a", "signal_id": "x"}])
    assert exc.value.code == "SOURCE_TIMESTAMP_REQUIRED"
    members = _head() + [{"kind": "system", "alias": "ts2", "field": "source_timestamp"}]
    with pytest.raises(BodyError) as exc:
        normalize_members("STATE", members)
    assert exc.value.code == "SOURCE_TIMESTAMP_REQUIRED"


def test_rules_publish_timestamp_at_most_one():
    members = _head() + [{"kind": "system", "alias": "p2", "field": "publish_timestamp"}]
    with pytest.raises(BodyError) as exc:
        normalize_members("STATE", members)
    assert exc.value.code == "PUBLISH_TIMESTAMP_DUPLICATE"


def test_rules_event_needs_trigger_and_snapshot_only_on_event():
    snap = {"kind": "snapshot", "alias": "so", "signal_id": "x"}
    with pytest.raises(BodyError) as exc:
        normalize_members("EVENT", _head(False) + [snap])
    assert exc.value.code == "TRIGGER_REQUIRED"
    with pytest.raises(BodyError) as exc:
        normalize_members("STATE", _head(False) + [snap])
    assert exc.value.code == "SNAPSHOT_STATE"
    with pytest.raises(BodyError) as exc:
        normalize_members("EVENT", _head(False) + [dict(snap, contributes_ts=True), {"kind": "signal", "alias": "q", "signal_id": "y", "is_trigger": True}])
    assert exc.value.code == "SNAPSHOT_TS"
    with pytest.raises(BodyError) as exc:
        normalize_members("STATE", _head() + [{"kind": "signal", "alias": "q", "signal_id": "y", "is_trigger": True}])
    assert exc.value.code == "TRIGGER_STATE"


def test_rules_alias_case_insensitive_and_context_ref():
    with pytest.raises(BodyError) as exc:
        normalize_members("STATE", _head() + [{"kind": "signal", "alias": "Zone_Name", "signal_id": "x"}])
    assert exc.value.code == "ALIAS_DUPLICATE"
    with pytest.raises(BodyError) as exc:
        normalize_members("STATE", _head() + [{"kind": "context", "alias": "x", "context_ref": "planet.name"}])
    assert exc.value.code == "CONTEXT_REF"


def test_legacy_member_without_kind_is_signal_with_ts_default():
    members = normalize_members("STATE", _head() + [{"signal_id": "x", "alias": "temp"}])
    legacy = members[-1]
    assert legacy.kind == "signal" and legacy.contributes_ts is True
    assert all(not m.contributes_ts for m in members[:-1])


def test_emit_policy_validation():
    assert normalize_emit_policy(None)["max_events"] == 1000
    assert normalize_emit_policy({"republish_ms": 5000})["republish_ms"] == 5000
    for bad in ({"republish_ms": 10}, {"max_events": 0}, {"snapshot_grace_ms": -1}, {"bogus": 1}):
        with pytest.raises(BodyError):
            normalize_emit_policy(bad)
