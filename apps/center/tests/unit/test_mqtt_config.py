"""MQTT configuration must survive normalization and reject malformed filters."""

import pytest

from factorix.modules.protocols import accept_connection, parse_config
from factorix.platform.errors import AppError


def test_mqtt5_console_alias_and_session_parameters_survive_storage():
    protocol, raw, _ = accept_connection("mqtt_client", {
        "host": "127.0.0.1", "protocol_version": "5.0", "anonymous": True,
        "topics": ["factory/#"], "qos": 0, "keepalive": 17,
        "clean_session": False, "client_id": "reader-1", "session_expiry": 120,
    })
    config = parse_config(protocol, raw)
    assert config["protocol_version"] == "5"
    assert config["qos"] == 0
    assert config["keepalive"] == 17
    assert config["clean_session"] is False
    assert config["session_expiry"] == 120


@pytest.mark.parametrize("topic", ["factory/x#", "factory/+x", "factory/#/state", "", "factory/\x00"])
def test_invalid_mqtt_filter_is_reported_before_edge_activation(topic):
    with pytest.raises(AppError) as error:
        parse_config("mqtt", {"host": "127.0.0.1", "anonymous": True, "topics": [topic]})
    assert error.value.code == "TOPIC"


@pytest.mark.parametrize("topic", ["factory/+/state", "factory/#", "$SYS/#", "factory//state"])
def test_valid_mqtt_filter_is_preserved(topic):
    assert parse_config("mqtt", {"host": "127.0.0.1", "anonymous": True, "topics": [topic]})["topics"] == [topic]


def test_authenticated_mqtt_does_not_silently_switch_to_anonymous():
    protocol, raw, _ = accept_connection("mqtt", {"host": "127.0.0.1", "anonymous": False})
    with pytest.raises(AppError) as error:
        parse_config(protocol, raw)
    assert error.value.code == "AUTH"
