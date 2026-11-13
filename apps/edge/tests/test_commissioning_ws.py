"""Commissioning paths (Modbus test, WebSocket test/capture) and the WebSocket connector."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from websockets.asyncio.server import serve

import factorix_edge.commissioning as commissioning
from factorix.domain.network import parse_allowlist
from factorix_edge.commissioning import Commissioner
from factorix_edge.connectors.ws import WebSocketConnector
from factorix_edge.jobs import JobSpec, build_specs
from factorix_edge.mapping import project_json
from factorix_edge.runtime import EdgeRuntime, checksum, endpoints_for
from factorix_edge.store.outbox import Outbox

FRAME = {"machines": {"M-01": {"order": {"source_timestamp": "2026-11-05T01:25:53.783Z", "so": 52280, "item": "N3"}}}}


class Reports:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
        self.items[path.rsplit("/", 1)[-1]] = body or {}
        return {}


async def _no_secret(ref: str) -> str:
    raise AssertionError("no secret expected")


@pytest.mark.asyncio
async def test_modbus_test_command_builds_valid_spans(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: the probe used SourceSpan(cadence=..., offset_value=...) and always failed."""

    class FakeModbus:
        def __init__(self, host: str, port: int, timeout_s: float = 3.0) -> None:
            self.requests: list[tuple[int, int, int]] = []

        async def connect(self) -> None:
            return None

        async def read_raw(self, block):  # noqa: ANN001
            self.requests.append((block.unit_id, block.start, block.count))
            words = {100: 2, 101: 0, 118: 0, 119: 417, 120: 44777, 121: 37416}
            return [words.get(block.start + i, 0) for i in range(block.count)]

        async def close(self) -> None:
            return None

    monkeypatch.setattr(commissioning, "ModbusConnector", FakeModbus)
    reports = Reports()
    commissioner = Commissioner(reports.request, lambda p, c: endpoints_for(p, c), _no_secret)
    await commissioner.run(
        {
            "id": "t1",
            "protocol": "modbus_tcp",
            "config_json": {"host": "127.0.0.1", "port": 502, "unit_id": 1},
            "fields": [
                {"key": "status", "address": {"unit_id": 11, "offset": 100, "native_type": "uint16"}},
                {"key": "mode", "address": {"unit_id": 11, "offset": 101, "native_type": "uint16"}},
                {"key": "stop_error", "address": {"unit_id": 11, "offset": 102, "native_type": "ascii", "register_count": 8}},
                {"key": "source_timestamp", "address": {"unit_id": 11, "offset": 118, "native_type": "uint64", "role": "source_timestamp"}},
            ],
        }
    )
    report = reports.items["t1"]
    assert report["status"] == "PASSED", report
    assert report["samples"]["status"] == 2
    assert report["samples"]["stop_error"] is None  # all-zero ASCII is a legitimate null
    assert report["samples"]["source_timestamp"].endswith("Z")
    assert [s["stage"] for s in report["stages"]] == ["REACH", "AUTH", "READ", "SAMPLE", "MAP"]


async def _serve_frames(frames: list[Any], interval: float = 0.05):  # noqa: ANN202
    async def handler(socket) -> None:  # noqa: ANN001
        try:
            for frame in frames:
                await socket.send(frame if isinstance(frame, str) else json.dumps(frame))
                await asyncio.sleep(interval)
            await socket.wait_closed()
        except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
            pass

    return await serve(handler, "127.0.0.1", 0)


@pytest.mark.asyncio
async def test_ws_connector_keeps_latest_frame_and_skips_non_json() -> None:
    frames = ["not json", FRAME, {**FRAME, "n": 2}]
    async with await _serve_frames(frames) as server:
        port = server.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}/ws/live"
        connector = WebSocketConnector(url, parse_allowlist([f"127.0.0.1:{port}"]), timeout_s=2)
        await connector.start()
        await connector.wait_connected(3)
        first = await connector.next_frame(0, 3)
        assert first is not None and first.document == FRAME
        assert first.received_time.endswith("Z") and len(first.received_time) == 24
        second = await connector.next_frame(first.seq, 3)
        assert second is not None and second.document.get("n") == 2
        assert connector.decode_errors == 1
        samples = project_json([{"id": "so", "address_json": {"jsonpath": '$.machines["M-01"].order.so'}}], second.document, second.received_time)
        assert samples[0].value == 52280 and samples[0].source_time == "2026-11-05T01:25:53.783Z"
        await connector.close()


@pytest.mark.asyncio
async def test_ws_connector_reports_unreachable() -> None:
    connector = WebSocketConnector("ws://127.0.0.1:9/ws", parse_allowlist(["127.0.0.1:9"]), timeout_s=1)
    await connector.start()
    with pytest.raises(Exception) as raised:
        await connector.wait_connected(3)
    assert getattr(raised.value, "code", "") in {"NETWORK", "TIMEOUT"}
    assert connector.state == "DOWN"
    await connector.close()


@pytest.mark.asyncio
async def test_ws_test_and_capture_commands() -> None:
    async with await _serve_frames([FRAME] * 50) as server:
        port = server.sockets[0].getsockname()[1]
        config = {"url": f"ws://127.0.0.1:{port}/ws/live"}
        reports = Reports()
        commissioner = Commissioner(reports.request, lambda p, c: endpoints_for(p, c), _no_secret)
        await asyncio.gather(
            commissioner.run({"id": "test", "protocol": "websocket", "config_json": config, "fields": [{"key": "so", "address": {"jsonpath": '$.machines["M-01"].order.so'}}]}),
            commissioner.run({"id": "cap", "command_type": "CAPTURE", "protocol": "websocket", "config_json": config, "seconds": 1.5, "max_messages": 3}),
        )
    test = reports.items["test"]
    assert test["status"] == "PASSED", test
    assert test["samples"] == {"so": 52280}
    assert [s["stage"] for s in test["stages"]] == ["REACH", "AUTH", "SUBSCRIBE", "SAMPLE", "MAP"]
    capture = reports.items["cap"]
    assert capture["status"] == "PASSED"
    assert capture["samples"][0]["topic"] == "/ws/live"
    assert capture["samples"][0]["payload"] == FRAME
    assert capture["samples"][0]["count"] >= 1
    assert capture["samples"][0]["raw"] == json.dumps(FRAME)


def test_capture_raw_keeps_text_as_received() -> None:
    from factorix_edge.commissioning import group_samples

    text = '{"z": 1, "speed": 0.0, "a": null}'
    [entry] = group_samples([("t/1", json.loads(text), "2026-11-06T00:00:00.000Z", text), ("t/1", json.loads(text), "2026-11-06T00:00:01.000Z", text)])
    assert entry["raw"] == text and entry["count"] == 2 and entry["payload"] == {"z": 1, "speed": 0.0, "a": None}
    [derived] = group_samples([("t/2", {"b": "\u00e9", "a": 1}, "r")])
    assert derived["raw"] == '{"b": "\u00e9", "a": 1}'


def _ws_spec(url: str) -> JobSpec:
    snapshot = {
        "connections": [{"id": "c-ws", "protocol": "websocket", "status": "ACTIVE", "config_json": {"url": url}}],
        "jobs": [{"id": "j-ws", "connection_id": "c-ws", "mode": "POLL", "interval_ms": 100}],
        "source_fields": [{"id": "f-so", "acquisition_job_id": "j-ws", "address_json": {"jsonpath": '$.machines["M-01"].order.so'}}],
        "signal_bindings": [{"source_field_id": "f-so", "signal_id": "s-so", "resource_id": "r", "data_type": "int64"}],
    }
    return build_specs(snapshot)["j-ws"]


def test_websocket_job_is_subscribe_only() -> None:
    assert _ws_spec("ws://127.0.0.1:1/x").subscribe is True


@pytest.mark.asyncio
async def test_rejected_revision_is_acked_failed_once_and_applied_revision_is_reacked(tmp_path: Path) -> None:
    acks: list[dict[str, Any]] = []
    snapshot = {"revision": 3, "connections": []}
    state = {"checksum": "0" * 64, "active": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/config"):
            return httpx.Response(200, json={"revision": 3, "active_revision": state["active"], "checksum_sha256": state["checksum"], "snapshot": snapshot})
        acks.append(json.loads(request.content))
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://center") as client:
        runtime = EdgeRuntime(client, "cred", [], Outbox(tmp_path / "o.sqlite"))
        for _ in range(3):
            await runtime.sync_config()
        assert [a["state"] for a in acks] == ["FAILED"]  # once, not every poll
        state["checksum"] = checksum(snapshot)
        assert await runtime.sync_config() is True
        assert acks[-1]["state"] == "ACTIVE"
        await runtime.sync_config()  # Center still shows active 0: the ack was lost
        assert [a["state"] for a in acks] == ["FAILED", "ACTIVE", "ACTIVE"]
        state["active"] = 3
        await runtime.sync_config()
        assert len(acks) == 3
        runtime.outbox.close()
