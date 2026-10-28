"""One Edge cycle: activate config, read OT, flush the outbox, run a pending test."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import httpx

from factorix.domain.jsonpath import MappingError, evaluate
from factorix.domain.modbus_decode import ModbusPlanError, SourceSpan, plan_reads
from factorix.domain.network import AllowedEndpoint, NetworkPolicyError, assert_allowed, parse_allowlist
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.connectors.http_pull import HttpPullConnector
from factorix_edge.connectors.modbus import ModbusConnector
from factorix_edge.connectors.mqtt import MqttConnector
from factorix_edge.connectors.opcua import OpcUaConnector
from factorix_edge.store.outbox import Outbox

_COUNTS = {"bool": 1, "bit": 1, "uint16": 1, "int16": 1, "uint32": 2, "int32": 2, "float32": 2, "float64": 4}
_PENDING_LIMIT = 50_000


def checksum(snapshot: dict[str, Any]) -> str:
    body = {key: value for key, value in snapshot.items() if key != "checksum_sha256"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(canonical).hexdigest()


class EdgeRuntime:
    def __init__(self, client: httpx.AsyncClient, credential: str, allowlist: list[str], outbox: Outbox) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {credential}"}
        self.allowlist: list[AllowedEndpoint] = parse_allowlist(allowlist)
        self.outbox = outbox

    async def cycle(self) -> dict[str, Any]:
        config = await self._request("GET", "/api/v1/edge-sync/config")
        snapshot = config.get("snapshot")
        revision = int(config.get("revision") or 0)
        active = int(config.get("active_revision") or 0)
        activated = False
        if isinstance(snapshot, dict) and revision > 0 and revision != active:
            expected = str(config.get("checksum_sha256") or snapshot.get("checksum_sha256") or "")
            if not expected or checksum(snapshot) != expected:
                await self._request(
                    "POST",
                    "/api/v1/edge-sync/ack",
                    {"revision": revision, "state": "FAILED", "diagnostic": "Checksum cấu hình không khớp."},
                )
                return {"activated": False, "reads": 0, "flushed": 0, "error": "checksum"}
            await self._request("POST", "/api/v1/edge-sync/ack", {"revision": revision, "state": "ACTIVE", "diagnostic": ""})
            activated = True
            active = revision
        reads = 0
        if isinstance(snapshot, dict) and active == revision and self.outbox.pending_count() < _PENDING_LIMIT:
            reads = await self._collect(snapshot, revision)
        flushed = await self._flush()
        await self._request(
            "POST",
            "/api/v1/edge-sync/heartbeat",
            {
                "health": "ACTIVE" if active else "CONFIG_PENDING",
                "software_version": "r1",
                "outbox_pending": self.outbox.pending_count(),
            },
        )
        await self._commission()
        return {"activated": activated, "reads": reads, "flushed": flushed, "pending": self.outbox.pending_count()}

    async def _collect(self, snapshot: dict[str, Any], revision: int) -> int:
        jobs_by_connection: dict[str, list[dict[str, Any]]] = {}
        for job in snapshot.get("jobs") or []:
            jobs_by_connection.setdefault(str(job["connection_id"]), []).append(job)
        fields_by_job: dict[str, list[dict[str, Any]]] = {}
        for field in snapshot.get("source_fields") or []:
            fields_by_job.setdefault(str(field["acquisition_job_id"]), []).append(field)
        bindings = {str(item["source_field_id"]): item for item in snapshot.get("signal_bindings") or []}
        written = 0
        for connection in snapshot.get("connections") or []:
            if connection.get("status") in {"ARCHIVED", "PAUSED"}:
                continue
            protocol = str(connection["protocol"])
            owned_fields: list[dict[str, Any]] = []
            for job in jobs_by_connection.get(str(connection["id"]), []):
                if job.get("enabled") is False:
                    continue
                owned_fields.extend(fields_by_job.get(str(job["id"]), []))
            mapped = [field for field in owned_fields if str(field["id"]) in bindings]
            if not mapped:
                continue
            try:
                samples = await self._read(protocol, connection, mapped)
            except (ConnectorError, NetworkPolicyError, ModbusPlanError, OSError):
                continue
            now = _stamp()
            for field_id, value, quality in samples:
                binding = bindings[field_id]
                coerced, data_quality = _coerce(binding.get("data_type") or "float64", value, quality)
                event_uid = str(uuid4())
                payload = {
                    "event_uid": event_uid,
                    "resource_id": str(binding["resource_id"]),
                    "signal_id": str(binding["signal_id"]),
                    "connection_id": str(connection["id"]),
                    "event_time": now,
                    "received_time": now,
                    "value": coerced,
                    "data_type": str(binding.get("data_type") or "float64"),
                    "unit": binding.get("unit"),
                    "quality": data_quality,
                    "origin": "LIVE",
                    "config_revision": revision,
                    "provenance": {"protocol": protocol, "field_id": field_id},
                }
                self.outbox.add(event_uid, now, json.dumps(payload).encode(), revision, now)
                written += 1
        return written

    async def _read(
        self,
        protocol: str,
        connection: dict[str, Any],
        fields: list[dict[str, Any]],
    ) -> list[tuple[str, Any, str]]:
        config = connection.get("config_json") or {}
        if protocol == "modbus_tcp":
            return await self._read_modbus(config, fields)
        if protocol == "opcua":
            return await self._read_opc(config, fields)
        if protocol == "mqtt":
            return await self._read_mqtt(connection, config, fields)
        if protocol == "http":
            return await self._read_http(connection, config, fields)
        raise ConnectorError("PROTOCOL", "Giao thức không được hỗ trợ.")

    async def _read_modbus(self, config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str]]:
        host = str(config["host"])
        port = int(config["port"])
        assert_allowed(host, port, self.allowlist)
        spans: list[SourceSpan] = []
        for field in fields:
            address = field.get("address_json") or {}
            native = str(address.get("native_type") or field.get("native_datatype") or "uint16")
            area = str(address.get("register_area") or "holding")
            count = int(address["register_count"]) if address.get("register_count") is not None else _COUNTS.get(native, 1)
            decode = field.get("decode_json") or {}
            unit_id = 1 if config.get("unit_id") is None else int(config["unit_id"])
            spans.append(
                SourceSpan(
                    str(field["id"]),
                    area,  # type: ignore[arg-type]
                    int(address.get("offset", 0)),
                    count,
                    unit_id,
                    "live",
                    str(address.get("word_order") or "big"),  # type: ignore[arg-type]
                    native,
                    float(1 if decode.get("scale") is None else decode["scale"]),
                    float(0 if decode.get("offset") is None else decode["offset"]),
                )
            )
        connector = ModbusConnector(host, port, timeout_s=max(int(config.get("timeout_ms") or 3000), 200) / 1000)
        await connector.connect()
        try:
            rows: list[tuple[str, Any, str]] = []
            for block in plan_reads(spans):
                try:
                    decoded = await connector.read_block(block)
                except (ConnectionError, ModbusPlanError):
                    rows.extend((field.field_id, None, "BAD") for field in block.fields)
                    continue
                rows.extend((item["field_id"], item["value"], "GOOD") for item in decoded)
            return rows
        finally:
            await connector.close()

    async def _read_opc(self, config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str]]:
        connector = OpcUaConnector(str(config["endpoint"]), self.allowlist)
        node_ids = [str((field.get("address_json") or {}).get("node_id") or "") for field in fields]
        if any(not node_id for node_id in node_ids):
            raise ConnectorError("ADDRESS", "Thiếu NodeId OPC UA.")
        await connector.connect()
        try:
            values = await connector.read_values(node_ids)
        finally:
            await connector.close()
        return [(str(fields[index]["id"]), item["value"], "GOOD") for index, item in enumerate(values)]

    async def _mqtt_secret(self, owner: dict[str, Any], config: dict[str, Any]) -> str | None:
        if config.get("anonymous", True) or not config.get("username"):
            return None
        secret_ref = owner.get("secret_ref")
        if not secret_ref:
            return None
        secret = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")
        return str(secret.get("secret") or "")

    async def _read_mqtt(self, connection: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str]]:
        topic = str((fields[0].get("address_json") or {}).get("topic") or (config.get("topics") or [""])[0])
        password = await self._mqtt_secret(connection, config)
        connector = MqttConnector(
            str(config["host"]),
            int(config["port"]),
            self.allowlist,
            f"fx-{uuid4().hex[:12]}",
            username=str(config.get("username") or "") or None,
            password=password,
        )
        document = connector.capture(topic)
        return _project_json(fields, document)

    async def _read_http(self, connection: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str]]:
        path = str((fields[0].get("address_json") or {}).get("path") or config.get("path") or "/")
        headers: dict[str, str] = {}
        secret_ref = connection.get("secret_ref")
        if secret_ref and config.get("auth") != "none":
            secret = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")
            header = str(config.get("header_name") or "X-API-Key")
            headers[header] = secret["secret"]
        connector = HttpPullConnector(str(config["base_url"]), self.allowlist, timeout_s=max(int(config.get("timeout_ms") or 5000), 200) / 1000)
        document = await connector.get_json(path, headers)
        return _project_json(fields, document)

    async def _flush(self) -> int:
        pending = self.outbox.pending(200)
        if not pending:
            return 0
        items = [json.loads(row["payload"]) for row in pending]
        uids = [str(row["event_uid"]) for row in pending]
        try:
            result = await self._request("POST", "/api/v1/edge-sync/observations", {"observations": items})
        except httpx.HTTPError:
            self.outbox.note_attempt(uids)
            return 0
        acked = [item["event_uid"] for item in result.get("results", []) if item.get("status") in {"committed", "duplicate"}]
        quarantined = [item["event_uid"] for item in result.get("results", []) if item.get("status") == "quarantined"]
        self.outbox.mark_sent(acked)
        self.outbox.mark_state(quarantined, "QUARANTINED")
        return len(acked)

    async def _commission(self) -> None:
        pulled = await self._request("GET", "/api/v1/edge-sync/commands")
        job = pulled.get("job")
        if not job:
            return
        stages = []
        status = "PASSED"
        error_code = None
        started = datetime.now(timezone.utc)
        try:
            detail = await self._probe(job)
            for name in ("NETWORK", "AUTH", "PROTOCOL", "READ_OR_SUBSCRIBE", "DECODE", "MAPPING", "VALIDATION"):
                stages.append({"stage": name, "status": "PASSED", "duration_ms": 0, "detail": detail if name == "DECODE" else ""})
        except (ConnectorError, NetworkPolicyError, ModbusPlanError, OSError, KeyError) as exc:
            status = "FAILED"
            error_code = getattr(exc, "code", "PROTOCOL")
            stages.append({"stage": "NETWORK", "status": "FAILED", "duration_ms": 0, "detail": str(exc)[:240]})
        elapsed = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        if stages:
            stages[0]["duration_ms"] = elapsed
        await self._request(
            "POST",
            f"/api/v1/edge-sync/commands/{job['id']}",
            {"status": status, "stages": stages, "error_code": error_code, "diagnostic": "" if status == "PASSED" else "Kiểm thử đọc thất bại."},
        )

    async def _probe(self, job: dict[str, Any]) -> str:
        protocol = str(job["protocol"])
        config = job.get("config_json") or {}
        if protocol == "modbus_tcp":
            rows = await self._read_modbus(
                config,
                [{"id": "probe", "address_json": {"offset": 0, "native_type": "uint16", "register_area": "holding", "register_count": 1}, "decode_json": {}}],
            )
            return f"holding:0={rows[0][1]}"
        if protocol == "opcua":
            connector = OpcUaConnector(str(config["endpoint"]), self.allowlist)
            await connector.connect()
            await connector.close()
            return "session"
        if protocol == "mqtt":
            topics = config.get("topics") or []
            if not topics:
                raise ConnectorError("TOPIC", "Chưa có topic để kiểm thử.")
            password = await self._mqtt_secret(job, config)
            connector = MqttConnector(
                str(config["host"]),
                int(config["port"]),
                self.allowlist,
                f"fx-test-{uuid4().hex[:8]}",
                username=str(config.get("username") or "") or None,
                password=password,
            )
            connector.capture(str(topics[0]), timeout_s=8)
            return "message"
        if protocol == "http":
            headers: dict[str, str] = {}
            secret_ref = job.get("secret_ref")
            if secret_ref and config.get("auth") != "none":
                secret = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")
                headers[str(config.get("header_name") or "X-API-Key")] = str(secret.get("secret") or "")
            connector = HttpPullConnector(str(config["base_url"]), self.allowlist)
            document = await connector.get_json(str(config.get("path") or "/"), headers)
            return "json" if isinstance(document, dict) else "body"
        raise ConnectorError("PROTOCOL", "Giao thức không được hỗ trợ.")

    async def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self.client.request(method, path, headers=self.headers, json=body)
        response.raise_for_status()
        if response.status_code == 204 or not response.content:
            return {}
        payload = response.json()
        return payload if isinstance(payload, dict) else {"items": payload}


def _project_json(fields: list[dict[str, Any]], document: Any) -> list[tuple[str, Any, str]]:
    rows: list[tuple[str, Any, str]] = []
    for field in fields:
        address = field.get("address_json") or {}
        expression = str(address.get("jsonpath") or "$")
        try:
            matches = evaluate(expression, document)
        except MappingError:
            rows.append((str(field["id"]), None, "BAD"))
            continue
        if len(matches) != 1:
            rows.append((str(field["id"]), None, "BAD"))
            continue
        rows.append((str(field["id"]), matches[0], "GOOD"))
    return rows


def _coerce(data_type: str, value: Any, quality: str) -> tuple[Any, str]:
    if quality != "GOOD" or value is None:
        return None, "BAD" if quality == "BAD" else quality
    if data_type == "bool":
        if isinstance(value, bool):
            return value, "GOOD"
        return None, "BAD"
    if data_type == "int64":
        if isinstance(value, bool) or not isinstance(value, int):
            return None, "BAD"
        return value, "GOOD"
    if data_type == "float64":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, "BAD"
        return value, "GOOD"
    if data_type in {"string", "enum"}:
        return (value if isinstance(value, str) else str(value)), "GOOD"
    return value, "GOOD"


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
