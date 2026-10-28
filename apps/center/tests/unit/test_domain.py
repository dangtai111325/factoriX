"""Domain invariants. These tests do not touch a database or a network."""

from __future__ import annotations

import ast
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from factorix.domain.csv_safe import csv_cell
from factorix.domain.formula import FormulaError, evaluate, parse_expression
from factorix.domain.jsonpath import MappingError, apply_cardinality, evaluate as eval_path
from factorix.domain.modbus_decode import ModbusPlanError, SourceSpan, decode_registers, plan_reads
from factorix.domain.network import AllowedEndpoint, NetworkPolicyError, assert_allowed
from factorix.domain.observation import Observation, ObservationError, Quality, should_replace_latest
from factorix.domain.passwords import PasswordPolicyError, validate_password
from factorix.domain.quality import Origin
from factorix.domain.resources import ResourceInvariantError, assert_no_cycle, validate_code
from factorix.domain.uns import TopicError, default_factory_topic, render_topic


def test_frm_001_ratio() -> None:
    program = parse_expression("uptime/(uptime+downtime)")
    assert evaluate(program, {"uptime": 450, "downtime": 30}) == 0.9375


def test_frm_002_zero_denominator_guard() -> None:
    program = parse_expression("uptime/(uptime+downtime) if uptime+downtime>0 else None")
    assert evaluate(program, {"uptime": 0, "downtime": 0}) is None


def test_frm_003_string_branch() -> None:
    program = parse_expression('"OVERHEAT" if temp > 80 else "NORMAL"')
    assert evaluate(program, {"temp": 81}) == "OVERHEAT"
    assert evaluate(program, {"temp": 80}) == "NORMAL"


def test_frm_004_rejects_import_and_attribute() -> None:
    with pytest.raises(FormulaError):
        parse_expression("__import__('os')")
    with pytest.raises(FormulaError):
        parse_expression("value.__class__")
    with pytest.raises(FormulaError):
        parse_expression("[item for item in values]")


def test_frm_005_trig_and_clamp() -> None:
    assert evaluate(parse_expression("sin(angle)"), {"angle": 0}) == 0
    assert evaluate(parse_expression("clamp(value, 0, 10)"), {"value": 12}) == 10


def test_frm_006_rename_does_not_rewrite_literal() -> None:
    source = '"uptime" if uptime > 0 else "down"'
    program = parse_expression(source)
    assert program.analysis.names == ("uptime",)
    assert "uptime_1" not in program.analysis.names


def test_frm_007_division_warning() -> None:
    program = parse_expression("uptime / downtime")
    assert program.analysis.warnings


def test_map_001_nested_and_index() -> None:
    document = {"factory": {"machine": {"name": "AA10-01"}}, "measurements": [{"value": 1}, {"value": 2}]}
    assert eval_path("$.factory.machine.name", document) == ["AA10-01"]
    assert eval_path("$.measurements[0].value", document) == [1]
    assert eval_path("$.measurements[*].value", document) == [1, 2]


def test_map_002_quoted_key_and_null() -> None:
    document = {"a.b": None, "stop_error": None}
    assert eval_path("$['a.b']", document) == [None]
    result = apply_cardinality(eval_path("$.stop_error", document), cardinality="REJECT_MULTI", missing="NULL")
    assert result.present is True
    assert result.value is None


def test_map_003_missing_is_not_zero() -> None:
    result = apply_cardinality(eval_path("$.absent", {}), cardinality="REJECT_MULTI", missing="NULL")
    assert result.present is False
    assert result.value is None


def test_map_004_reject_multi() -> None:
    with pytest.raises(MappingError):
        apply_cardinality([1, 2], cardinality="REJECT_MULTI", missing="NULL")


def test_mod_001_groups_contiguous_and_splits_gap() -> None:
    spans = [
        SourceSpan("a", "holding", 0, 1, 1, "fast"),
        SourceSpan("b", "holding", 1, 1, 1, "fast"),
        SourceSpan("c", "holding", 10, 2, 1, "fast"),
    ]
    blocks = plan_reads(spans, allow_gap=0)
    assert len(blocks) == 2
    assert blocks[0].count == 2
    assert blocks[0].function_code == 3
    assert blocks[1].start == 10


def test_mod_002_float32_big_endian() -> None:
    import struct

    raw = struct.pack(">f", 49.5)
    words = list(struct.unpack(">HH", raw))
    assert decode_registers(words, native_type="float32", word_order="big") == pytest.approx(49.5)


def test_mod_003_uint32_and_scale() -> None:
    assert decode_registers([0, 2], native_type="uint32", word_order="big") == 2
    assert decode_registers([1000], native_type="uint16", scale=0.1, offset=0) == pytest.approx(100.0)


def test_mod_004_rejects_non_finite() -> None:
    with pytest.raises(ModbusPlanError):
        decode_registers([0x7FC0, 0x0000], native_type="float32")


def test_mod_005_separate_units_are_not_one_session_block() -> None:
    spans = [
        SourceSpan("a", "holding", 0, 1, 1, "fast"),
        SourceSpan("b", "holding", 0, 1, 2, "fast"),
    ]
    blocks = plan_reads(spans)
    assert len(blocks) == 2
    assert {block.unit_id for block in blocks} == {1, 2}


def test_obs_001_zero_is_valid_null_is_valid() -> None:
    now = datetime.now(timezone.utc)
    Observation(
        event_uid="e1",
        tenant_id=uuid4(),
        resource_id=uuid4(),
        signal_id=uuid4(),
        event_time=now,
        received_time=now,
        value=0,
        data_type="float64",
        unit="Cel",
        quality=Quality.GOOD,
        origin=Origin.LIVE,
        config_revision=1,
    ).validate()
    Observation(
        event_uid="e2",
        tenant_id=uuid4(),
        resource_id=uuid4(),
        signal_id=uuid4(),
        event_time=now,
        received_time=now,
        value=None,
        data_type="string",
        unit=None,
        quality=Quality.GOOD,
        origin=Origin.LIVE,
        config_revision=1,
    ).validate()


def test_obs_002_rejects_naive_time_and_bool_as_int() -> None:
    now = datetime.now(timezone.utc)
    with pytest.raises(ObservationError):
        Observation(
            event_uid="e",
            tenant_id=uuid4(),
            resource_id=uuid4(),
            signal_id=uuid4(),
            event_time=datetime.now(),
            received_time=now,
            value=1,
            data_type="int64",
            unit=None,
            quality=Quality.GOOD,
            origin=Origin.LIVE,
            config_revision=1,
        ).validate()
    with pytest.raises(ObservationError):
        Observation(
            event_uid="e",
            tenant_id=uuid4(),
            resource_id=uuid4(),
            signal_id=uuid4(),
            event_time=now,
            received_time=now,
            value=True,
            data_type="int64",
            unit=None,
            quality=Quality.GOOD,
            origin=Origin.LIVE,
            config_revision=1,
        ).validate()


def test_obs_003_older_event_does_not_replace_latest() -> None:
    base = datetime.now(timezone.utc)
    assert should_replace_latest(
        current_event_time=base,
        current_received_time=base,
        current_uid="b",
        incoming_event_time=base - timedelta(seconds=5),
        incoming_received_time=base,
        incoming_uid="a",
    ) is False


def test_res_001_cycle_and_code() -> None:
    first, second = uuid4(), uuid4()
    with pytest.raises(ResourceInvariantError):
        assert_no_cycle([(second, first)], first, second)
    with pytest.raises(ResourceInvariantError):
        validate_code("bad code")
    assert validate_code("AA10-01") == "AA10-01"


def test_out_001_optional_segment_omitted_and_wildcard_rejected() -> None:
    topic = default_factory_topic(
        {"enterprise": "TIPA", "site": "DongNai", "plant": "Factory-1", "zone": None, "line": None, "resource": "AA10-01"},
        "state",
    )
    assert topic == "fx/v1/TIPA/DongNai/Factory-1/AA10-01/state"
    with pytest.raises(TopicError):
        render_topic("fx/v1/{resource}/#", {"resource": "AA10-01"})


def test_csv_001_formula_injection() -> None:
    assert csv_cell("=cmd").startswith("'")
    assert csv_cell(0) == "0"
    assert csv_cell(None) == ""


def test_sec_001_metadata_blocked_even_if_listed() -> None:
    allow = [AllowedEndpoint("169.254.169.254", 80)]
    with pytest.raises(NetworkPolicyError):
        assert_allowed("169.254.169.254", 80, allow)


def test_sec_002_password_policy() -> None:
    validate_password("Correct-Horse-9", "fxadmin")
    with pytest.raises(PasswordPolicyError):
        validate_password("admin", "fxadmin")
    with pytest.raises(PasswordPolicyError):
        validate_password("short", "fxadmin")


def test_arch_001_domain_modules_stay_pure() -> None:
    import factorix.domain.formula as formula
    import factorix.domain.modbus_decode as modbus
    import factorix.domain.observation as observation

    for module in (formula, modbus, observation):
        source = ast.parse(open(module.__file__, encoding="utf-8").read())
        imported: set[str] = set()
        for node in ast.walk(source):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        assert imported.isdisjoint({"fastapi", "sqlalchemy", "pymodbus", "asyncua", "paho"})


def test_development_first_run_does_not_require_a_setup_code() -> None:
    from factorix.modules.identity import require_bootstrap_token
    from factorix.platform.errors import AppError
    from factorix.platform.settings import Settings

    open_dev = Settings.model_construct(environment="development", bootstrap_token="")
    require_bootstrap_token(open_dev, None)

    locked = Settings.model_construct(environment="production", bootstrap_token="")
    with pytest.raises(AppError) as denied:
        require_bootstrap_token(locked, None)
    assert denied.value.code == "BOOTSTRAP_DISABLED"

    gated = Settings.model_construct(environment="development", bootstrap_token="one-time-code")
    with pytest.raises(AppError):
        require_bootstrap_token(gated, None)
    require_bootstrap_token(gated, "one-time-code")


def test_email_is_stored_as_lowercase_and_reset_mail_omits_the_smtp_secret() -> None:
    from factorix.domain.passwords import PasswordPolicyError, validate_email
    from factorix.platform.errors import AppError
    from factorix.platform.mail import SmtpMailer
    from factorix.platform.settings import Settings

    assert validate_email(" Plant.Lead@Avenue-Net.com ") == "plant.lead@avenue-net.com"
    with pytest.raises(PasswordPolicyError) as invalid:
        validate_email("not-an-email")
    assert invalid.value.code == "INVALID_EMAIL"

    configured = Settings.model_construct(
        smtp_host="smtp.gmail.com",
        smtp_port=587,
        smtp_user="tai.dang@avenue-net.com",
        smtp_password="not-the-real-secret",
        smtp_from="tai.dang@avenue-net.com",
    )
    mailer = SmtpMailer(configured)
    rendered = mailer.message("plant.lead@avenue-net.com", "123456").as_string()
    assert "123456" in rendered
    assert "not-the-real-secret" not in rendered
    empty = SmtpMailer(Settings.model_construct(smtp_password="", smtp_user="", smtp_from=""))
    with pytest.raises(AppError) as unavailable:
        empty.send_code("plant.lead@avenue-net.com", "123456")
    assert unavailable.value.code == "MAIL_UNAVAILABLE"


def test_unknown_protocol_and_bad_jsonpath_are_rejected() -> None:
    from factorix.domain.jsonpath import compile_path
    from factorix.modules.protocols import parse_config
    from factorix.platform.errors import AppError

    with pytest.raises(AppError) as protocol:
        parse_config("s7", {})
    assert protocol.value.code == "PROTOCOL"
    with pytest.raises(MappingError) as path:
        compile_path("machine_name")
    assert path.value.code == "INVALID_PATH"
