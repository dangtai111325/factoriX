"""Built-in model templates must match the six body shapes of data_clean.md exactly."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from factorix.domain.body import BUILTIN_TEMPLATES, compose_body, normalize_members

HEAD_MACHINE = ["zone_name", "line_name", "machine_name", "source_timestamp", "publish_timestamp"]
HEAD = ["zone_name", "line_name", "source_timestamp", "publish_timestamp"]

# Key lists copied from data_clean.md ("Sáu dạng body").
EXPECTED = {
    "state": HEAD_MACHINE + ["status", "mode", "stop_error", "employee"],
    "process": HEAD_MACHINE + ["speed_1", "speed_2", "program_name", "program_no", "uptime_1", "uptime_2", "status", "employee"],
    "energy": HEAD_MACHINE
    + ["voltage_1", "voltage_2", "voltage_3", "voltage_4", "current_1", "current_2", "current_3", "current_4",
       "power", "frequency", "energy_1", "energy_2", "harmonic", "status"],
    "condition": HEAD_MACHINE
    + ["machine_temp_1", "machine_temp_2", "machine_temp_3", "machine_temp_4", "machine_temp_5", "machine_temp_6",
       "machine_temp_7", "ambient_temp", "pressure_1", "pressure_2", "pressure_3", "pressure_4", "pressure_5",
       "pressure_6", "pressure_7", "liquid_level", "vibration_1", "vibration_2", "vibration_3", "vibration_4",
       "vibration_5", "vibration_6", "noise", "humidity", "status"],
    "order": HEAD + ["so", "wo", "item", "order_qty", "cycle_time", "motor_no", "employee"],
    "order_progress": HEAD + ["so", "wo", "qty", "lot_serial"],
}


def _by_key():
    return {t["key"]: t for t in BUILTIN_TEMPLATES}


def test_six_builtin_templates():
    assert list(_by_key()) == ["state", "process", "energy", "condition", "order", "order_progress"]


def test_template_aliases_match_data_clean_key_order():
    for key, template in _by_key().items():
        assert [f["alias"] for f in template["fields"]] == EXPECTED[key], key


def test_signal_keys_are_raw_field_names_and_context_refs():
    for key, template in _by_key().items():
        for field in template["fields"]:
            if field["kind"] in ("signal", "snapshot"):
                assert field["signal_key"] == field["alias"]
        contexts = {f["alias"]: f["context_ref"] for f in template["fields"] if f["kind"] == "context"}
        expected = {"zone_name": "zone.name", "line_name": "line.name"}
        if key not in ("order", "order_progress"):
            expected["machine_name"] = "machine.name"
        assert contexts == expected, key


def test_order_progress_is_event_with_snapshot_and_triggers():
    template = _by_key()["order_progress"]
    assert template["kind"] == "EVENT"
    kinds = {f["alias"]: (f["kind"], f.get("is_trigger", False), f.get("contributes_ts", False)) for f in template["fields"]}
    assert kinds["so"] == ("snapshot", False, False)
    assert kinds["wo"] == ("snapshot", False, False)
    assert kinds["qty"] == ("signal", True, True)
    assert kinds["lot_serial"] == ("signal", True, True)
    assert all(t["kind"] == "STATE" for k, t in _by_key().items() if k != "order_progress")


def test_templates_pass_member_rules_and_compose_in_order():
    now = datetime(2026, 6, 20, 9, 0, tzinfo=timezone.utc)
    context = {"zone.name": "Z", "line.name": "L", "machine.name": "M"}
    for key, template in _by_key().items():
        members = normalize_members(template["kind"], template["fields"], require_signal_ids=False)
        bound = [m.as_dict() | ({"signal_id": f"id-{m.signal_key}"} if m.signal_key else {}) for m in members]
        latest = {f"id-{m.signal_key}": {"value": 1, "source_time": now, "received_time": now} for m in members if m.signal_key}
        text, body, _ts, _alias, _hash = compose_body(bound, latest, context, now)
        assert list(json.loads(text)) == EXPECTED[key], key
        assert list(body) == EXPECTED[key], key
