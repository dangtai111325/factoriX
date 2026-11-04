from __future__ import annotations

import pytest
from factorix.modules.protocols import accept_connection, parse_config
from factorix.platform.errors import AppError


def test_con01_mqtt_minimal():
    cfg = parse_config("mqtt", {"host": "127.0.0.1", "port": 18883})
    assert cfg["host"] == "127.0.0.1"
    assert cfg["port"] == 18883
    assert cfg["topics"] == []


def test_con02_mqtt_5_mapping():
    # protocol_version "5.0" mapped to "5"
    _, stored, _ = accept_connection("mqtt", {"host": "127.0.0.1", "port": 18883, "protocol_version": "5.0"})
    assert stored["protocol_version"] == "5"


def test_con03_qos_0():
    cfg = parse_config("mqtt", {"host": "127.0.0.1", "port": 18883, "qos": 0})
    assert cfg["qos"] == 0


def test_con09_keepalive_clean_session():
    cfg = parse_config("mqtt", {"host": "127.0.0.1", "port": 18883, "keepalive": 30, "clean_session": False})
    assert cfg["keepalive"] == 30
    assert cfg["clean_session"] is False


def test_con11_con12_opcua_modes():
    # Sign mode
    cfg_sign = parse_config("opcua", {
        "endpoint": "opc.tcp://127.0.0.1:4840",
        "security_mode": "Sign",
        "security_policy": "Basic256Sha256",
    })
    assert cfg_sign["security_mode"] == "Sign"
    assert cfg_sign["security_policy"] == "Basic256Sha256"

    # None mode with allow_insecure
    cfg_none = parse_config("opcua", {
        "endpoint": "opc.tcp://127.0.0.1:4840",
        "security_mode": "None",
        "allow_insecure": True,
    })
    assert cfg_none["security_mode"] == "None"
    assert cfg_none.get("allow_insecure") is True


def test_con13_http_method_headers():
    _, stored, _ = accept_connection("http", {
        "base_url": "http://127.0.0.1:8000",
        "method": "POST",
        "headers": {"X-A": "1"},
        "path": "/v1/data",
    })
    assert stored["method"] == "POST"
    assert stored["headers"] == {"X-A": "1"}
    assert stored["path"] == "/v1/data"


def test_con14_modbus_validation():
    # unit_id out of range
    with pytest.raises(AppError) as exc:
        parse_config("modbus_tcp", {"host": "127.0.0.1", "port": 502, "unit_id": 300})
    assert exc.value.code == "CONFIG"
    assert any(fe["path"] == "unit_id" for fe in exc.value.field_errors)

    # port 0
    with pytest.raises(AppError) as exc:
        parse_config("modbus_tcp", {"host": "127.0.0.1", "port": 0})
    assert exc.value.code == "CONFIG"

    # timeout_ms too small (<200)
    with pytest.raises(AppError) as exc:
        parse_config("modbus_tcp", {"host": "127.0.0.1", "port": 502, "timeout_ms": 100})
    assert exc.value.code == "CONFIG"
