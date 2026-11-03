"""A successful test must read and validate every draft field, for all protocols."""

import httpx
import pytest
import pytest_asyncio
from asyncua import Server, ua

from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


@pytest_asyncio.fixture
async def opc_source(unused_loopback_port):
    server = Server()
    await server.init()
    server.set_endpoint(f"opc.tcp://127.0.0.1:{unused_loopback_port}/test/")
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    index = await server.register_namespace("urn:factorix:protocol-tests")
    await server.nodes.objects.add_variable(ua.NodeId("speed", index), "Speed", 42.5)
    async with server:
        yield unused_loopback_port, f"ns={index};s=speed"


async def probe(runtime, protocol, config, fields):
    endpoint_port = config.get("port") or int(config.get("endpoint", config.get("base_url", "")).split(":")[2].split("/")[0])
    from factorix.domain.network import AllowedEndpoint
    runtime.allowlist = [AllowedEndpoint("127.0.0.1", endpoint_port)]
    stages = [{"stage": name, "status": "NOT_TESTED", "duration_ms": 0, "detail": ""} for name in
              ("NETWORK", "AUTH", "PROTOCOL", "READ_OR_SUBSCRIBE", "DECODE", "MAPPING", "VALIDATION")]
    result = await runtime._probe_stages({"id": "protocol-probe", "protocol": protocol, "config_json": config, "fields": fields}, stages)
    return result, {item["stage"]: item["status"] for item in stages}


@pytest.mark.asyncio
async def test_mqtt_probe_proves_wildcard_mapping_and_preserves_string_type(probe_runtime, mqtt_broker):
    with mqtt_broker() as broker:
        result, stages = await probe(probe_runtime, "mqtt", {
            "host": "127.0.0.1", "port": broker["port"], "anonymous": True, "topics": ["factory/#"], "qos": 0,
        }, [{"name": "Employee", "data_type": "string", "address": {"topic": "factory/+/state", "jsonpath": "$.employee"}}])
    assert result is True
    assert stages["MAPPING"] == stages["VALIDATION"] == "PASSED"


@pytest.mark.asyncio
async def test_modbus_probe_reads_the_requested_registers(probe_runtime, modbus_source):
    result, stages = await probe(probe_runtime, "modbus_tcp", {"host": "127.0.0.1", "port": modbus_source, "unit_id": 1}, [
        {"name": "Speed", "data_type": "float64", "address": {"offset": 0, "native_type": "float32", "register_area": "holding"}},
    ])
    assert result is True
    assert stages["READ_OR_SUBSCRIBE"] == stages["VALIDATION"] == "PASSED"


@pytest.mark.asyncio
async def test_opc_probe_reads_the_draft_node_instead_of_a_config_placeholder(probe_runtime, opc_source):
    port, node = opc_source
    result, stages = await probe(probe_runtime, "opcua", {"endpoint": f"opc.tcp://127.0.0.1:{port}/test/", "anonymous": True}, [
        {"name": "Speed", "data_type": "float64", "address": {"node_id": node}},
    ])
    assert result is True
    assert stages["READ_OR_SUBSCRIBE"] == stages["VALIDATION"] == "PASSED"


@pytest.mark.asyncio
@pytest.mark.parametrize("path,data_type,expected", [("$.employee", "string", True), ("$.absent", "float64", False), ("$.speed", "int64", False)])
async def test_http_probe_requires_mapping_and_declared_type(probe_runtime, http_source, path, data_type, expected):
    result, stages = await probe(probe_runtime, "http", {"base_url": f"http://127.0.0.1:{http_source}", "path": "/sample", "auth": "none"}, [
        {"name": "Field", "data_type": data_type, "address": {"jsonpath": path}},
    ])
    assert result is expected
    assert stages["VALIDATION"] == ("PASSED" if expected else "FAILED") or (not expected and stages["MAPPING"] == "FAILED")


@pytest.mark.asyncio
async def test_failed_commission_reports_the_failed_stage_to_center(http_source, tmp_path):
    import json
    from factorix.domain.network import AllowedEndpoint

    results = []

    def center(request):
        if request.method == "GET":
            return httpx.Response(200, json={"job": {
                "id": "failed-http", "protocol": "http", "config_json": {"base_url": f"http://127.0.0.1:{http_source}", "auth": "none"},
                "fields": [{"name": "Speed", "data_type": "int64", "address": {"jsonpath": "$.speed"}}],
            }})
        results.append(json.loads(request.content))
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(center), base_url="http://center.test") as client:
        outbox = Outbox(tmp_path / "outbox.sqlite")
        runtime = EdgeRuntime(client, "test-only", [], outbox)
        runtime.allowlist = [AllowedEndpoint("127.0.0.1", http_source)]
        try:
            await runtime._commission()
        finally:
            outbox.close()
    assert results[0]["status"] == "FAILED"
    assert results[0]["error_code"] == "VALIDATION"
    assert "declared type" in results[0]["diagnostic"]
