"""Unit tests for BrokerConfig, URL redaction, routing keys, and Settings validators (S03)."""

from __future__ import annotations

from uuid import UUID

import pytest

from factorix.platform.broker import BrokerConfig, BrokerUnavailableError, redact_amqp_url, tenant_routing_key
from factorix.platform.settings import Settings


def test_broker_config_and_redaction() -> None:
    url = "amqp://mq_admin:supersecretpw@broker.internal:5672/factorix"
    assert redact_amqp_url(url) == "amqp://***:***@broker.internal:5672/factorix"
    tid = UUID("11111111-2222-3333-4444-555555555555")
    assert tenant_routing_key(tid) == "telemetry.v1.11111111222233334444555555555555"


def test_settings_validates_rabbitmq_and_tdengine_schemes() -> None:
    base_kwargs = {
        "environment": "test",
        "database_url": "postgresql+asyncpg://u:p@localhost:5432/factorix_test",
        "data_key": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "rabbitmq_url": "amqp://user:pw@127.0.0.1:15673/",
        "tdengine_dsn": "ws://root:pw@127.0.0.1:16041",
    }
    s = Settings(**base_kwargs)
    cfg = BrokerConfig.from_settings(s)
    assert cfg.queue_name == "factorix.telemetry.ingest.q"
    assert cfg.exchange_name == "factorix.telemetry.ingress"
    assert cfg.dlx_name == "factorix.telemetry.dlx"

    with pytest.raises(ValueError, match="amqp://"):
        Settings(**{**base_kwargs, "rabbitmq_url": "http://localhost:5672"})
    with pytest.raises(ValueError, match="ws://"):
        Settings(**{**base_kwargs, "tdengine_dsn": "mysql://localhost:6041"})

    s_empty = Settings(**{**base_kwargs, "rabbitmq_url": ""})
    with pytest.raises(BrokerUnavailableError):
        BrokerConfig.from_settings(s_empty)
