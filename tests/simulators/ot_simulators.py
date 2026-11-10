"""Unified 5-protocol async OT simulator suite for FactoriX integration & E2E testing.

Exposes isolated local endpoints for:
1. Modbus TCP (`modbus_tcp`)
2. OPC UA (`opcua`)
3. MQTT 3.1.1 (`mqtt`)
4. HTTP REST (`http`)
5. WebSocket (`websocket`)

Each protocol supports runtime fault injection via `.fault(protocol, mode, value)` or HTTP
control endpoints (`/sim/state`, `/sim/fault/{protocol}/{mode}`) without touching any live
factory hardware (such as PC03).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import socket
import struct
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, urlparse

from asyncua import Server as OpcUaServer, ua
from pymodbus.server import ModbusTcpServer
from pymodbus.simulator import DataType, SimData, SimDevice
from websockets.asyncio.server import serve as ws_serve

from tests.simulators.mqtt_broker import MiniMqttBroker


def _free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def _iso_utc(dt: datetime | None = None) -> str:
    now = dt or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


@dataclass
class SimulatorEndpoints:
    modbus_host: str
    modbus_port: int
    opcua_endpoint: str
    mqtt_host: str
    mqtt_port: int
    http_base_url: str
    ws_url: str
    control_url: str | None = None


class ModbusSimulator:
    """Modbus TCP simulator supporting units 1 & 11 plus delay/fault toggles."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self.host = host
        self.port = port or _free_port(host)
        self.delay_s: float = 0.0
        self.drop_requests: bool = False
        self.tick = 0

        # Holding registers 0..299 initialized deterministically
        # Offset 100: uint16 status=2
        # Offset 101: uint16 mode=1
        # Offset 102..109: ascii 8 regs = b"OK\x00..." or all-zero
        # Offset 110..111: float32 (big endian) = 42.5
        # Offset 118..121: uint64 ms epoch
        hr = [0] * 300
        hr[100] = 2
        hr[101] = 1
        bfloat = struct.pack(">f", 42.5)
        hr[110], hr[111] = struct.unpack(">HH", bfloat)
        ts_ms = int(time.time() * 1000)
        hr[118], hr[119], hr[120], hr[121] = struct.unpack(">HHHH", struct.pack(">Q", ts_ms))

        def _make_dev(dev_id: int) -> SimDevice:
            return SimDevice(
                id=dev_id,
                simdata=(
                    [SimData(0, values=[True, False] * 50, datatype=DataType.BITS)],
                    [SimData(0, values=[True, True] * 50, datatype=DataType.BITS)],
                    [SimData(0, values=list(hr), datatype=DataType.REGISTERS)],
                    [SimData(0, values=list(hr), datatype=DataType.REGISTERS)],
                ),
            )

        self.devices = [_make_dev(1), _make_dev(11)]
        self.server: ModbusTcpServer | None = None
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> int:
        self.server = ModbusTcpServer(self.devices, address=(self.host, self.port))
        await self.server.serve_forever(background=True)
        return self.port

    async def step_values(self, temp: float | None = None, status: int | None = None) -> None:
        self.tick += 1
        if self.server is None:
            return
        tval = temp if temp is not None else round(40.0 + 5.0 * math.sin(self.tick / 5.0), 2)
        sval = status if status is not None else (2 if self.tick % 10 != 0 else 3)
        bfloat = struct.pack(">f", float(tval))
        w0, w1 = struct.unpack(">HH", bfloat)
        ts_ms = int(time.time() * 1000)
        t0, t1, t2, t3 = struct.unpack(">HHHH", struct.pack(">Q", ts_ms))
        for dev_id in (1, 11):
            await self.server.async_setValues(dev_id, 3, 100, [sval, 1])
            await self.server.async_setValues(dev_id, 3, 110, [w0, w1])
            await self.server.async_setValues(dev_id, 3, 118, [t0, t1, t2, t3])

    async def stop(self) -> None:
        if self.server is not None:
            with contextlib.suppress(Exception):
                await self.server.shutdown()
            self.server = None
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None


class OpcUaSimulator:
    """OPC UA server simulator exposing ns=2 test tags and controllable StatusCodes."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self.host = host
        self.port = port or _free_port(host)
        self.endpoint = f"opc.tcp://{self.host}:{self.port}/freeopcua/server/"
        self.server: OpcUaServer | None = None
        self.nodes: dict[str, Any] = {}
        self.status_mode: str = "Good"  # Good | Uncertain | Bad
        self.source_clock_offset_s: float = 0.0
        self.running = False
        self._tick = 0

    async def start(self) -> str:
        srv = OpcUaServer()
        await srv.init()
        srv.set_endpoint(self.endpoint)
        srv.set_server_name("FactoriX Sim OPC UA")
        idx = await srv.register_namespace("urn:factorix:sim:opcua")
        objects = srv.nodes.objects
        machine = await objects.add_object(idx, "SimMachine")
        self.nodes["temp"] = await machine.add_variable(ua.NodeId("MachineTemp1", idx), "MachineTemp1", 55.2, ua.VariantType.Double)
        self.nodes["count"] = await machine.add_variable(ua.NodeId("CycleCount", idx), "CycleCount", 10, ua.VariantType.Int64)
        self.nodes["state"] = await machine.add_variable(ua.NodeId("MachineState", idx), "MachineState", "RUN", ua.VariantType.String)
        self.nodes["alarm"] = await machine.add_variable(ua.NodeId("AlarmActive", idx), "AlarmActive", False, ua.VariantType.Boolean)
        await srv.start()
        self.server = srv
        self.running = True
        return self.endpoint

    async def step_values(self, *, temp: float | None = None, state: str | None = None) -> None:
        if not self.server or not self.running:
            return
        self._tick += 1
        sc = ua.StatusCode(ua.StatusCodes.Good)
        if self.status_mode == "Uncertain":
            sc = ua.StatusCode(ua.StatusCodes.UncertainLastUsableValue)
        elif self.status_mode == "Bad":
            sc = ua.StatusCode(ua.StatusCodes.BadSensorFailure)
        ts = datetime.now(timezone.utc) + timedelta(seconds=self.source_clock_offset_s)

        async def _write(node: Any, val: Any, vtype: ua.VariantType) -> None:
            dv = ua.DataValue(ua.Variant(val, vtype), StatusCode=sc, SourceTimestamp=ts, ServerTimestamp=datetime.now(timezone.utc))
            await node.write_value(dv)

        await _write(self.nodes["temp"], round(temp if temp is not None else 55.0 + (self._tick % 7) * 0.5, 2), ua.VariantType.Double)
        await _write(self.nodes["count"], 10 + self._tick, ua.VariantType.Int64)
        await _write(self.nodes["state"], state if state is not None else ("RUN" if self._tick % 5 else "IDLE"), ua.VariantType.String)
        await _write(self.nodes["alarm"], False, ua.VariantType.Boolean)

    async def stop(self) -> None:
        self.running = False
        if self.server is not None:
            with contextlib.suppress(Exception):
                await self.server.stop()
            self.server = None


class HttpSimulator:
    """Configurable asyncio HTTP/1.1 REST endpoint simulator."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self.host = host
        self.port = port or _free_port(host)
        self.status_override: int | None = None
        self.delay_s: float = 0.0
        self.missing_field: bool = False
        self.expected_api_key: str | None = None
        self.tick = 0
        self._server: asyncio.AbstractServer | None = None

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    async def start(self) -> str:
        self._server = await asyncio.start_server(self._handle, self.host, self.port)
        self.port = int(self._server.sockets[0].getsockname()[1])
        return self.base_url

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw_head = await reader.readuntil(b"\r\n\r\n")
            lines = raw_head.decode("latin1").split("\r\n")
            req_line = lines[0].split(" ")
            method = req_line[0].upper() if len(req_line) >= 1 else "GET"
            target = req_line[1] if len(req_line) >= 2 else "/"
            headers: dict[str, str] = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            clen = int(headers.get("content-length") or 0)
            if clen > 0:
                await reader.readexactly(clen)

            if self.delay_s > 0:
                await asyncio.sleep(self.delay_s)

            if self.expected_api_key and headers.get("x-api-key") != self.expected_api_key and headers.get("authorization") != f"Bearer {self.expected_api_key}":
                self._write_json(writer, 401, {"error": "Unauthorized"})
            elif self.status_override is not None:
                extra = {"Retry-After": "2"} if self.status_override == 429 else None
                self._write_json(writer, self.status_override, {"error": f"Simulated HTTP {self.status_override}"}, extra_headers=extra)
            else:
                parsed = urlparse(target)
                self.tick += 1
                if "operator-program" in parsed.path:
                    payload: dict[str, Any] = {
                        "program_name": "PART-A-REV2",
                        "batch_id": f"B-{100 + self.tick}",
                        "source_timestamp": _iso_utc(),
                    }
                    if self.missing_field:
                        payload.pop("program_name", None)
                else:
                    payload = {
                        "machine_id": "SIM-01",
                        "power_kw": round(18.5 + (self.tick % 5) * 0.4, 2),
                        "cycle_ms": 1200 + (self.tick % 4) * 50,
                        "status": "RUNNING",
                        "source_timestamp": _iso_utc(),
                    }
                    if self.missing_field:
                        payload.pop("power_kw", None)
                self._write_json(writer, 200, payload)
            await writer.drain()
        except Exception:
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()

    def _write_json(self, writer: asyncio.StreamWriter, code: int, body: dict[str, Any], *, extra_headers: dict[str, str] | None = None) -> None:
        raw = json.dumps(body).encode("utf-8")
        reasons = {200: "OK", 401: "Unauthorized", 429: "Too Many Requests", 500: "Internal Server Error"}
        hdrs = [
            f"HTTP/1.1 {code} {reasons.get(code, 'Error')}",
            "Content-Type: application/json",
            f"Content-Length: {len(raw)}",
            "Connection: close",
        ]
        if extra_headers:
            for k, v in extra_headers.items():
                hdrs.append(f"{k}: {v}")
        writer.write(("\r\n".join(hdrs) + "\r\n\r\n").encode("ascii") + raw)


class WsSimulator:
    """WebSocket streaming frame simulator with fault toggles."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self.host = host
        self.port = port or _free_port(host)
        self.pause_frames = False
        self.send_bad_json = False
        self.interval_s = 0.25
        self.tick = 0
        self._server: Any = None
        self._clients: set[Any] = set()
        self._loop_task: asyncio.Task[None] | None = None

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}/ws/live"

    async def start(self) -> str:
        async def handler(sock: Any) -> None:
            self._clients.add(sock)
            try:
                await sock.wait_closed()
            finally:
                self._clients.discard(sock)

        self._server = await ws_serve(handler, self.host, self.port)
        self.port = int(self._server.sockets[0].getsockname()[1])
        self._loop_task = asyncio.create_task(self._pump(), name="sim-ws-pump")
        return self.url

    async def emit_once(self, frame: dict[str, Any] | str | None = None) -> None:
        self.tick += 1
        if frame is None:
            doc: Any = {
                "machines": {
                    "SIM-01": {
                        "order": {"source_timestamp": _iso_utc(), "so": 50000 + self.tick, "item": "SIM-PART"},
                        "spindle_rpm": 3200 + (self.tick % 4) * 10,
                        "running": True,
                    }
                }
            }
        else:
            doc = frame
        raw = doc if isinstance(doc, str) else json.dumps(doc)
        for c in list(self._clients):
            with contextlib.suppress(Exception):
                await c.send(raw)

    async def _pump(self) -> None:
        while True:
            await asyncio.sleep(self.interval_s)
            if not self._clients or self.pause_frames:
                continue
            await self.emit_once("{not-valid-json" if self.send_bad_json else None)

    async def close_clients(self, code: int = 1011) -> None:
        for c in list(self._clients):
            with contextlib.suppress(Exception):
                await c.close(code=code, reason="Simulated disconnect")

    async def stop(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
            self._loop_task = None
        await self.close_clients()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None


class SimulatorSuite:
    """Coordinated 5-protocol simulator stack with periodic emission and fault injection."""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        modbus_port: int = 0,
        opcua_port: int = 0,
        mqtt_port: int = 0,
        http_port: int = 0,
        ws_port: int = 0,
        control_port: int | None = None,
        tick_interval_s: float = 0.5,
    ) -> None:
        self.host = host
        self.modbus = ModbusSimulator(host, modbus_port)
        self.opcua = OpcUaSimulator(host, opcua_port)
        self.mqtt = MiniMqttBroker(host, mqtt_port)
        self.http = HttpSimulator(host, http_port)
        self.ws = WsSimulator(host, ws_port)
        self.control_port = control_port
        self.tick_interval_s = tick_interval_s
        self.mqtt_pause_publisher = False
        self.mqtt_bad_json = False
        self._tick = 0
        self._driver_task: asyncio.Task[None] | None = None
        self._control_server: asyncio.AbstractServer | None = None

    async def start(self) -> SimulatorEndpoints:
        m_port = await self.modbus.start()
        o_url = await self.opcua.start()
        mq_port = await self.mqtt.start()
        h_url = await self.http.start()
        w_url = await self.ws.start()
        ctrl_url: str | None = None
        if self.control_port is not None:
            self._control_server = await asyncio.start_server(self._handle_control, self.host, self.control_port)
            actual_ctrl = int(self._control_server.sockets[0].getsockname()[1])
            ctrl_url = f"http://{self.host}:{actual_ctrl}"
        self._driver_task = asyncio.create_task(self._driver(), name="sim-suite-driver")
        return SimulatorEndpoints(
            modbus_host=self.host,
            modbus_port=m_port,
            opcua_endpoint=o_url,
            mqtt_host=self.host,
            mqtt_port=mq_port,
            http_base_url=h_url,
            ws_url=w_url,
            control_url=ctrl_url,
        )

    async def stop(self) -> None:
        if self._driver_task is not None:
            self._driver_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._driver_task
            self._driver_task = None
        if self._control_server is not None:
            self._control_server.close()
            await self._control_server.wait_closed()
            self._control_server = None
        await self.ws.stop()
        await self.http.stop()
        await self.mqtt.stop()
        await self.opcua.stop()
        await self.modbus.stop()

    async def _driver(self) -> None:
        while True:
            self._tick += 1
            await self.modbus.step_values()
            await self.opcua.step_values()
            if not self.mqtt_pause_publisher:
                payload = b"{invalid-json" if self.mqtt_bad_json else json.dumps({
                    "temperature": round(28.0 + (self._tick % 6) * 0.25, 2),
                    "vibration": round(1.2 + (self._tick % 3) * 0.1, 2),
                    "running": True,
                    "source_timestamp": _iso_utc(),
                }).encode("utf-8")
                await self.mqtt.publish_local("factory/sim/M1/condition", payload, qos=0)
            await asyncio.sleep(self.tick_interval_s)

    def apply_fault(self, protocol: str, mode: str, value: Any = True) -> dict[str, Any]:
        p = protocol.lower()
        m = mode.lower()
        if p == "mqtt":
            if m == "pause_publisher":
                self.mqtt_pause_publisher = bool(value)
            elif m == "bad_json":
                self.mqtt_bad_json = bool(value)
            elif m == "reject_auth":
                self.mqtt.reject_all_auth = bool(value)
        elif p == "opcua":
            if m == "status_mode":
                self.opcua.status_mode = str(value)
            elif m == "clock_offset_s":
                self.opcua.source_clock_offset_s = float(value)
        elif p == "http":
            if m == "status_override":
                self.http.status_override = int(value) if value is not None else None
            elif m == "delay_s":
                self.http.delay_s = float(value)
            elif m == "missing_field":
                self.http.missing_field = bool(value)
        elif p in {"ws", "websocket"}:
            if m == "pause_frames":
                self.ws.pause_frames = bool(value)
            elif m == "send_bad_json":
                self.ws.send_bad_json = bool(value)
        elif p in {"modbus", "modbus_tcp"}:
            if m == "delay_s":
                self.modbus.delay_s = float(value)
        return self.status_snapshot()

    def status_snapshot(self) -> dict[str, Any]:
        return {
            "tick": self._tick,
            "mqtt": {"port": self.mqtt.port, "pause_publisher": self.mqtt_pause_publisher, "bad_json": self.mqtt_bad_json},
            "opcua": {"endpoint": self.opcua.endpoint, "status_mode": self.opcua.status_mode, "clock_offset_s": self.opcua.source_clock_offset_s},
            "http": {"base_url": self.http.base_url, "status_override": self.http.status_override, "delay_s": self.http.delay_s},
            "ws": {"url": self.ws.url, "pause_frames": self.ws.pause_frames, "send_bad_json": self.ws.send_bad_json},
            "modbus": {"port": self.modbus.port},
        }

    async def _handle_control(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw_head = await reader.readuntil(b"\r\n\r\n")
            lines = raw_head.decode("latin1").split("\r\n")
            parts = lines[0].split(" ")
            method = parts[0].upper() if len(parts) >= 1 else "GET"
            path = urlparse(parts[1] if len(parts) >= 2 else "/").path
            clen = 0
            for ln in lines[1:]:
                if ln.lower().startswith("content-length:"):
                    clen = int(ln.split(":", 1)[1].strip())
            body_bytes = await reader.readexactly(clen) if clen else b"{}"
            body = json.loads(body_bytes.decode("utf-8") or "{}")
            if method == "POST" and path.startswith("/sim/fault/"):
                segs = [s for s in path.split("/") if s]
                if len(segs) == 4:
                    result = self.apply_fault(segs[2], segs[3], body.get("value", True))
                else:
                    result = {"error": "Invalid path"}
            else:
                result = self.status_snapshot()
            raw = json.dumps(result).encode("utf-8")
            hdr = f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\nConnection: close\r\n\r\n".encode("ascii")
            writer.write(hdr + raw)
            await writer.drain()
        except Exception:
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()
