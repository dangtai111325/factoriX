"""HTTP configuration must control the actual request and retain source time."""

import json

import httpx
import pytest

from factorix.domain.network import AllowedEndpoint
from factorix.modules.protocols import accept_connection, parse_config
from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


@pytest.mark.asyncio
@pytest.mark.parametrize("auth,method,header,value", [
    ("none", "POST", None, None),
    ("basic", "GET", "Authorization", "Basic cmVhZGVyOnRlc3QtcGFzcw=="),
    ("bearer", "POST", "Authorization", "Bearer test-pass"),
    ("api_key", "GET", "X-Read-Key", "test-pass"),
])
async def test_http_stored_settings_reach_the_endpoint(http_capture, tmp_path, auth, method, header, value):
    protocol, raw, _ = accept_connection("http_pull", {
        "url": f"http://127.0.0.1:{http_capture['port']}/read?line=A",
        "method": method, "headers": {"X-Plant": "DN"}, "auth": auth,
        "username": "reader", "header_name": "X-Read-Key", "body_json": {"operation": "read"},
    })
    config = parse_config(protocol, raw)

    def secret_service(request):
        assert request.url.path == "/api/v1/edge-sync/secrets/read-secret"
        return httpx.Response(200, json={"secret": "test-pass"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(secret_service), base_url="http://center.test") as client:
        outbox = Outbox(tmp_path / "outbox.sqlite")
        runtime = EdgeRuntime(client, "test-only", [], outbox)
        runtime.allowlist = [AllowedEndpoint("127.0.0.1", http_capture["port"])]
        try:
            rows = await runtime._read_http({"id": "http-read", "secret_ref": "read-secret"}, config, [
                {"id": "speed", "address_json": {"jsonpath": "$.speed"}},
            ])
        finally:
            outbox.close()
    request = http_capture["requests"][0]
    assert request["method"] == method
    assert request["path"] == "/read?line=A"
    assert request["headers"]["X-Plant"] == "DN"
    if header:
        assert request["headers"][header] == value
    if method == "POST":
        assert json.loads(request["body"]) == {"operation": "read"}
    assert [(row[0], row[1], row[2]) for row in rows] == [("speed", 42.5, "GOOD")]
    assert rows[0].source_time == "2026-11-02T01:45:12Z"


@pytest.mark.asyncio
async def test_http_path_query_and_configured_query_are_both_preserved(http_capture, probe_runtime):
    probe_runtime.allowlist = [AllowedEndpoint("127.0.0.1", http_capture["port"])]
    await probe_runtime._read_http({"id": "query-read"}, {
        "base_url": f"http://127.0.0.1:{http_capture['port']}", "path": "/read?line=A", "query": {"machine": "M1"},
    }, [{"id": "speed", "address_json": {"jsonpath": "$.speed"}}])
    assert http_capture["requests"][0]["path"] == "/read?line=A&machine=M1"
