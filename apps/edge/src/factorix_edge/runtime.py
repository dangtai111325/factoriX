"""One Edge cycle: activate config, read OT, flush the outbox, run a pending test."""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from factorix.domain.jsonpath import MappingError, apply_cardinality, evaluate
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


def _prepare(snapshot: dict[str, Any]) -> None:
    if not isinstance(snapshot.get("connections"), list):
        raise ValueError("Snapshot thiếu danh sách kết nối.")


class EdgeRuntime:
    def __init__(
        self,
        client: httpx.AsyncClient,
        credential: str,
        allowlist: list[str],
        outbox: Outbox,
        snapshot_path: Path | None = None,
    ) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {credential}"}
        self.allowlist: list[AllowedEndpoint] = parse_allowlist(allowlist)
        self.outbox = outbox
        self.snapshot_path = snapshot_path
        self._modbus: dict[str, ModbusConnector] = {}
        self._mqtt: dict[str, MqttConnector] = {}
        self._due: dict[str, float] = {}

    async def cycle(self) -> dict[str, Any]:
        activated = False
        center_up = True
        try:
            config = await self._request("GET", "/api/v1/edge-sync/config")
        except httpx.HTTPError:
            config = None
            center_up = False
        snapshot: dict[str, Any] | None = None
        revision = 0
        if isinstance(config, dict):
            incoming = config.get("snapshot") if isinstance(config.get("snapshot"), dict) else None
            revision = int(config.get("revision") or 0)
            active = int(config.get("active_revision") or 0)
            expected = str(config.get("checksum_sha256") or (incoming or {}).get("checksum_sha256") or "")
            if isinstance(incoming, dict) and revision > 0 and revision != active:
                if not expected or checksum(incoming) != expected:
                    await self._request(
                        "POST",
                        "/api/v1/edge-sync/ack",
                        {"revision": revision, "state": "FAILED", "diagnostic": "Checksum cấu hình không khớp."},
                    )
                    local = self._load_snapshot()
                    snapshot = local[0] if local else None
                    revision = local[1] if local else 0
                else:
                    try:
                        _prepare(incoming)
                        self._save_snapshot(incoming, revision, expected)
                        await self._request("POST", "/api/v1/edge-sync/ack", {"revision": revision, "state": "ACTIVE", "diagnostic": ""})
                        activated = True
                        snapshot = incoming
                    except (ValueError, OSError) as exc:
                        await self._request(
                            "POST",
                            "/api/v1/edge-sync/ack",
                            {"revision": revision, "state": "FAILED", "diagnostic": str(exc)[:240]},
                        )
                        local = self._load_snapshot()
                        snapshot = local[0] if local else None
                        revision = local[1] if local else 0
            elif isinstance(incoming, dict):
                if not expected or checksum(incoming) == expected:
                    self._save_snapshot(incoming, revision, expected or checksum(incoming))
                snapshot = incoming
        if snapshot is None:
            local = self._load_snapshot()
            if local:
                snapshot, revision = local
        reads = 0
        if isinstance(snapshot, dict) and self.outbox.pending_count() < _PENDING_LIMIT:
            reads = await self._collect(snapshot, revision)
        flushed = 0
        try:
            flushed = await self._flush()
        except httpx.HTTPError:
            flushed = 0
        try:
            await self._request(
                "POST",
                "/api/v1/edge-sync/heartbeat",
                {
                    "health": "DEGRADED" if not center_up else "ACTIVE",
                    "software_version": "r1",
                    "outbox_pending": self.outbox.pending_count(),
                    "backlog": self.outbox.pending_count(),
                },
            )
        except httpx.HTTPError:
            pass
        try:
            await self._commission()
        except httpx.HTTPError:
            pass
        return {"activated": activated, "reads": reads, "flushed": flushed, "pending": self.outbox.pending_count(), "center_up": center_up}

    def _save_snapshot(self, snapshot: dict[str, Any], revision: int, digest: str) -> None:
        if self.snapshot_path is None:
            return
        self.snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({"revision": revision, "checksum_sha256": digest, "snapshot": snapshot}, default=str).encode()
        temporary = self.snapshot_path.with_suffix(".tmp")
        with temporary.open("wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.snapshot_path)

    def _load_snapshot(self) -> tuple[dict[str, Any], int] | None:
        if self.snapshot_path is None or not self.snapshot_path.is_file():
            return None
        try:
            body = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        snapshot = body.get("snapshot")
        if not isinstance(snapshot, dict):
            return None
        digest = str(body.get("checksum_sha256") or "")
        if digest and checksum(snapshot) != digest:
            return None
        return snapshot, int(body.get("revision") or 0)

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
            interval = min(int(job.get("interval_ms") or 1000) for job in jobs_by_connection.get(str(connection["id"]), []))
            due = self._due.get(str(connection["id"]), 0.0)
            now_mono = time.monotonic()
            if now_mono < due:
                continue
            self._due[str(connection["id"])] = now_mono + max(interval, 200) / 1000
            mode = "SUBSCRIBE" if any(job.get("mode") == "SUBSCRIBE" for job in jobs_by_connection.get(str(connection["id"]), [])) else "POLL"
            try:
                samples = await self._read(protocol, connection, mapped, mode)
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
        mode: str = "POLL",
    ) -> list[tuple[str, Any, str]]:
        config = connection.get("config_json") or {}
        if protocol == "modbus_tcp":
            return await self._read_modbus(config, fields)
        if protocol == "opcua":
            return await self._read_opc(config, fields, mode)
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
        connector = self._modbus.get(f"{host}:{port}")
        if connector is None or not connector.client.connected:
            connector = ModbusConnector(host, port, timeout_s=max(int(config.get("timeout_ms") or 3000), 200) / 1000)
            await connector.connect()
            self._modbus[f"{host}:{port}"] = connector
        rows: list[tuple[str, Any, str]] = []
        for block in plan_reads(spans):
            try:
                decoded = await connector.read_block(block)
            except (ConnectionError, ModbusPlanError):
                rows.extend((field.field_id, None, "BAD") for field in block.fields)
                continue
            rows.extend((item["field_id"], item["value"], "GOOD") for item in decoded)
        return rows

    async def _read_opc(self, config: dict[str, Any], fields: list[dict[str, Any]], mode: str = "POLL") -> list[tuple[str, Any, str]]:
        connector = OpcUaConnector(str(config["endpoint"]), self.allowlist)
        node_ids = [str((field.get("address_json") or {}).get("node_id") or "") for field in fields]
        if any(not node_id for node_id in node_ids):
            raise ConnectorError("ADDRESS", "Thiếu NodeId OPC UA.")
        await connector.connect()
        try:
            if mode == "SUBSCRIBE":
                values = await connector.subscribe_values(node_ids)
            else:
                values = await connector.read_values(node_ids)
        finally:
            if mode != "SUBSCRIBE":
                await connector.close()
        return [(str(fields[index]["id"]), item["value"], str(item.get("quality") or "GOOD")) for index, item in enumerate(values)]

    async def _mqtt_secret(self, owner: dict[str, Any], config: dict[str, Any]) -> str | None:
        if config.get("anonymous", True) or not config.get("username"):
            return None
        secret_ref = owner.get("secret_ref")
        if not secret_ref:
            return None
        secret = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")
        return str(secret.get("secret") or "")

    async def _read_mqtt(self, connection: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str]]:
        topics: list[tuple[str, int]] = []
        for field in fields:
            address = field.get("address_json") or {}
            topic = str(address.get("topic") or "")
            if not topic and config.get("topics"):
                topic = str(config["topics"][0])
            if topic:
                topics.append((topic, int(address.get("qos") or config.get("qos") or 1)))
        if not topics:
            raise ConnectorError("TOPIC", "Chưa có topic để thu thập.")
        key = str(connection["id"])
        connector = self._mqtt.get(key)
        if connector is None:
            password = await self._mqtt_secret(connection, config)
            connector = MqttConnector(
                str(config["host"]),
                int(config["port"]),
                self.allowlist,
                f"fx-{key[:8]}",
                username=str(config.get("username") or "") or None,
                password=password,
            )
            connector.start(topics)
            self._mqtt[key] = connector
        document = connector.next_json(timeout_s=max(int(config.get("timeout_ms") or 2000), 200) / 1000)
        return _project_json(fields, document)

    async def _read_http(self, connection: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str]]:
        path = str((fields[0].get("address_json") or {}).get("path") or config.get("path") or "/")
        headers: dict[str, str] = {}
        secret_ref = connection.get("secret_ref")
        auth = str(config.get("auth") or "none")
        if secret_ref and auth != "none":
            secret = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")
            token = str(secret.get("secret") or "")
            if auth == "bearer":
                headers["Authorization"] = f"Bearer {token}"
            elif auth == "basic":
                import base64

                user = str(config.get("username") or "")
                headers["Authorization"] = "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode()
            else:
                headers[str(config.get("header_name") or "X-API-Key")] = token
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
        names = ("NETWORK", "AUTH", "PROTOCOL", "READ_OR_SUBSCRIBE", "DECODE", "MAPPING", "VALIDATION")
        stages = [{"stage": name, "status": "NOT_TESTED", "duration_ms": 0, "detail": ""} for name in names]
        started = datetime.now(timezone.utc)
        status = "FAILED"
        error_code = "NOT_TESTED"
        try:
            proven = await self._probe_stages(job, stages)
            status = "PASSED" if proven else "FAILED"
            error_code = None if proven else "NOT_TESTED"
        except (ConnectorError, NetworkPolicyError, ModbusPlanError, OSError, KeyError) as exc:
            status = "FAILED"
            error_code = getattr(exc, "code", "PROTOCOL")
            for stage in stages:
                if stage["status"] == "NOT_TESTED":
                    stage["status"] = "NOT_TESTED"
                    break
            if stages[0]["status"] == "NOT_TESTED":
                stages[0]["status"] = "FAILED"
                stages[0]["detail"] = str(exc)[:240]
        elapsed = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        stages[0]["duration_ms"] = elapsed
        await self._request(
            "POST",
            f"/api/v1/edge-sync/commands/{job['id']}",
            {
                "status": status,
                "stages": stages,
                "error_code": error_code,
                "diagnostic": "" if status == "PASSED" else "Kiểm thử chưa chứng minh được đọc dữ liệu.",
            },
        )

    async def _probe_stages(self, job: dict[str, Any], stages: list[dict[str, Any]]) -> bool:
        protocol = str(job["protocol"])
        config = job.get("config_json") or {}
        by_name = {item["stage"]: item for item in stages}
        if protocol == "modbus_tcp":
            assert_allowed(str(config["host"]), int(config["port"]), self.allowlist)
            by_name["NETWORK"]["status"] = "PASSED"
            by_name["AUTH"]["status"] = "NOT_APPLICABLE"
            connector = ModbusConnector(str(config["host"]), int(config["port"]))
            await connector.connect()
            await connector.close()
            by_name["PROTOCOL"]["status"] = "PASSED"
            return False
        if protocol == "opcua":
            connector = OpcUaConnector(str(config["endpoint"]), self.allowlist)
            by_name["NETWORK"]["status"] = "PASSED"
            by_name["AUTH"]["status"] = "NOT_APPLICABLE" if not job.get("secret_ref") else "NOT_TESTED"
            await connector.connect()
            by_name["PROTOCOL"]["status"] = "PASSED"
            node_id = str(config.get("node_id") or "")
            try:
                if not node_id:
                    return False
                values = await connector.read_values([node_id])
            finally:
                await connector.close()
            by_name["READ_OR_SUBSCRIBE"]["status"] = "PASSED"
            by_name["DECODE"]["status"] = "PASSED" if values and values[0].get("quality") == "GOOD" else "FAILED"
            by_name["MAPPING"]["status"] = "NOT_APPLICABLE"
            by_name["VALIDATION"]["status"] = by_name["DECODE"]["status"]
            return by_name["DECODE"]["status"] == "PASSED"
        if protocol == "mqtt":
            topics = config.get("topics") or []
            if not topics:
                raise ConnectorError("TOPIC", "Chưa có topic để kiểm thử.")
            by_name["NETWORK"]["status"] = "PASSED"
            password = await self._mqtt_secret(job, config)
            by_name["AUTH"]["status"] = "PASSED" if config.get("username") else "NOT_APPLICABLE"
            connector = MqttConnector(
                str(config["host"]),
                int(config["port"]),
                self.allowlist,
                f"fx-test-{uuid4().hex[:8]}",
                username=str(config.get("username") or "") or None,
                password=password,
            )
            connector.capture(str(topics[0]), timeout_s=8)
            by_name["PROTOCOL"]["status"] = "PASSED"
            by_name["READ_OR_SUBSCRIBE"]["status"] = "PASSED"
            by_name["DECODE"]["status"] = "PASSED"
            by_name["MAPPING"]["status"] = "NOT_TESTED"
            by_name["VALIDATION"]["status"] = "NOT_TESTED"
            return False
        if protocol == "http":
            by_name["NETWORK"]["status"] = "PASSED"
            headers: dict[str, str] = {}
            secret_ref = job.get("secret_ref")
            if secret_ref and config.get("auth") != "none":
                secret = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")
                headers[str(config.get("header_name") or "X-API-Key")] = str(secret.get("secret") or "")
                by_name["AUTH"]["status"] = "PASSED"
            else:
                by_name["AUTH"]["status"] = "NOT_APPLICABLE"
            connector = HttpPullConnector(str(config["base_url"]), self.allowlist)
            document = await connector.get_json(str(config.get("path") or "/"), headers)
            by_name["PROTOCOL"]["status"] = "PASSED"
            by_name["READ_OR_SUBSCRIBE"]["status"] = "PASSED"
            by_name["DECODE"]["status"] = "PASSED" if isinstance(document, dict) else "FAILED"
            by_name["MAPPING"]["status"] = "NOT_TESTED"
            by_name["VALIDATION"]["status"] = "NOT_TESTED"
            return by_name["DECODE"]["status"] == "PASSED"
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
            mapped = apply_cardinality(matches, cardinality="REJECT_MULTI", missing="BAD")
        except MappingError:
            rows.append((str(field["id"]), None, "BAD"))
            continue
        if mapped.quality_override == "BAD" or not mapped.present:
            rows.append((str(field["id"]), None, "BAD"))
            continue
        rows.append((str(field["id"]), mapped.value, "GOOD"))
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
