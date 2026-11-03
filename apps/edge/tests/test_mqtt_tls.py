"""The TLS toggle must select verified TLS, never cleartext MQTT."""

import asyncio

import pytest

from factorix.domain.network import AllowedEndpoint
from factorix.modules.protocols import parse_config
from factorix_edge.connectors.errors import ConnectorError


@pytest.mark.asyncio
async def test_mqtt_tls_uses_the_configured_ca(probe_runtime, mqtt_broker, tls_broker):
    with mqtt_broker(tls_context=tls_broker["context"]) as broker:
        probe_runtime.allowlist = [AllowedEndpoint("127.0.0.1", broker["port"], "mqtts")]
        config = parse_config("mqtt", {"host": "127.0.0.1", "port": broker["port"], "anonymous": True,
                                      "tls": True, "tls_ca_pem": tls_broker["ca_pem"], "topics": ["factory/#"]})
        rows = []
        try:
            for _ in range(100):
                rows += await probe_runtime._read_mqtt({"id": "tls-test"}, config, [
                    {"id": "employee", "address_json": {"topic": "factory/#", "jsonpath": "$.employee"}},
                ])
                if rows:
                    break
                await asyncio.sleep(0.01)
        finally:
            for connector in probe_runtime._mqtt.values():
                connector.close()
        assert [(row[1], row[2]) for row in rows] == [("0021113185", "GOOD")]


@pytest.mark.asyncio
async def test_mqtt_tls_rejects_an_untrusted_broker(probe_runtime, mqtt_broker, tls_broker):
    with mqtt_broker(tls_context=tls_broker["context"], expect_tls_rejection=True) as broker:
        probe_runtime.allowlist = [AllowedEndpoint("127.0.0.1", broker["port"])]
        config = parse_config("mqtt", {"host": "127.0.0.1", "port": broker["port"], "anonymous": True, "tls": True, "topics": ["factory/#"]})
        try:
            with pytest.raises(ConnectorError) as error:
                await probe_runtime._read_mqtt({"id": "untrusted-test"}, config, [{"id": "value", "address_json": {"topic": "factory/#", "jsonpath": "$.qty"}}])
            assert error.value.code == "TLS"
        finally:
            for connector in probe_runtime._mqtt.values():
                connector.close()
