"""One Edge cycle: activate config, read OT, flush the outbox, run a pending test."""

from __future__ import annotations

import hashlib
import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from paho.mqtt.client import topic_matches_sub

from factorix.domain.jsonpath import MappingError, apply_cardinality, evaluate
from factorix.domain.modbus_decode import ModbusPlanError, SourceSpan, plan_reads
from factorix.domain.network import AllowedEndpoint, NetworkPolicyError, assert_allowed, parse_allowlist
from factorix.domain.observation import ObservationError, validate_value
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.connectors.http_pull import HttpPullConnector
from factorix_edge.connectors.modbus import ModbusConnector
from factorix_edge.connectors.mqtt import MqttConnector
from factorix_edge.connectors.opcua import OpcUaConnector, normalize_node_id
from factorix_edge.store.outbox import Outbox
from factorix_edge.samples import ReadSample, source_timestamp
from factorix_edge.topic_capture import TopicCaptureService

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
        self.topic_capture = TopicCaptureService(self._request, self.allowlist)

    async def cycle(self) -> dict[str, Any]:
        try:
            await self.topic_capture.tick()
        except httpx.HTTPError:
            pass
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

    async def close(self) -> None:
        await self.topic_capture.close()
        for connector in self._mqtt.values():
            await asyncio.to_thread(connector.close)
        for connector in self._modbus.values():
            await connector.close()

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
            for raw in samples:
                sample = raw if isinstance(raw, ReadSample) else ReadSample(*raw)
                field_id, value, quality = sample.field_id, sample.value, sample.quality
                binding = bindings[field_id]
                coerced, data_quality = _coerce(binding.get("data_type") or "float64", value, quality)
                event_uid = str(uuid4())
                payload = {
                    "event_uid": event_uid,
                    "resource_id": str(binding["resource_id"]),
                    "signal_id": str(binding["signal_id"]),
                    "connection_id": str(connection["id"]),
                    "event_time": sample.source_time or sample.received_time or now,
                    "received_time": sample.received_time or now,
                    "source_time": sample.source_time,
                    "value": coerced,
                    "data_type": str(binding.get("data_type") or "float64"),
                    "unit": binding.get("unit"),
                    "quality": data_quality,
                    "origin": "LIVE",
                    "config_revision": revision,
                    "provenance": {"protocol": protocol, "field_id": field_id,
                                   **({"topic": sample.topic} if sample.topic else {}),
                                   **({"quality_reason": sample.reason} if sample.reason else {})},
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
            return await self._read_modbus(config, fields, str(connection["id"]))
        if protocol == "opcua":
            return await self._read_opc(config, fields, mode)
        if protocol == "mqtt":
            return await self._read_mqtt(connection, config, fields)
        if protocol == "http":
            return await self._read_http(connection, config, fields)
        raise ConnectorError("PROTOCOL", "Giao thức không được hỗ trợ.")

    async def _read_modbus(self, config: dict[str, Any], fields: list[dict[str, Any]], cache_key: str) -> list[tuple[str, Any, str]]:
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
        connector = self._modbus.get(cache_key)
        if connector is None or not connector.client.connected:
            connector = ModbusConnector(host, port, timeout_s=max(int(config.get("timeout_ms") or 3000), 200) / 1000)
            await connector.connect()
            self._modbus[cache_key] = connector
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
            await connector.close()
        by_node = {normalize_node_id(item["node_id"]): item for item in values}
        rows = []
        for field, node_id in zip(fields, node_ids, strict=True):
            item = by_node.get(normalize_node_id(node_id))
            if item is None:
                rows.append(ReadSample(str(field["id"]), None, "BAD", reason="No sample for this OPC UA node.", error_stage="READ_OR_SUBSCRIBE"))
                continue
            source_time, invalid_clock = source_timestamp({"source_timestamp": item.get("source_time")})
            quality = str(item.get("quality") or "BAD")
            rows.append(ReadSample(str(field["id"]), item["value"], "UNCERTAIN" if invalid_clock and quality == "GOOD" else quality,
                                   source_time, _stamp(), reason="Source timestamp is invalid." if invalid_clock else None))
        return rows

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
                qos = address.get("qos")
                topics.append((topic, int(config.get("qos", 1) if qos is None else qos)))
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
                str(config.get("client_id") or f"fx-{key[:8]}"),
                username=str(config.get("username") or "") or None,
                password=password,
                timestamp_jsonpath=config.get("timestamp_jsonpath"),
                protocol_version=str(config.get("protocol_version", "3.1.1")),
                keepalive=int(config.get("keepalive", 60)),
                clean_session=bool(config.get("clean_session", True)),
                session_expiry=int(config.get("session_expiry", 0)),
                tls=bool(config.get("tls", False)),
                tls_ca_pem=config.get("tls_ca_pem"),
            )
            connector.start(topics)
            self._mqtt[key] = connector
        rows: list[ReadSample] = []
        for message in connector.drain_latest():
            timestamp, invalid_clock = source_timestamp(message.payload, config.get("timestamp_jsonpath"))
            for field in fields:
                address = field.get("address_json") or {}
                field_topic = str(address.get("topic") or (config.get("topics") or [""])[0])
                if not topic_matches_sub(field_topic, message.topic):
                    continue
                field_id = str(field["id"])
                if message.error:
                    rows.append(ReadSample(field_id, None, "BAD", received_time=message.received_time, topic=message.topic, reason="Payload is not valid JSON."))
                    continue
                try:
                    matches = evaluate(str(address.get("jsonpath") or "$"), message.payload)
                    mapped = apply_cardinality(matches, cardinality="REJECT_MULTI", missing="BAD" if address.get("missing") == "BAD" else "OMIT")
                except MappingError as exc:
                    rows.append(ReadSample(field_id, None, "BAD", timestamp, message.received_time, message.topic, str(exc)))
                    continue
                if not mapped.present:
                    if mapped.quality_override == "BAD":
                        rows.append(ReadSample(field_id, None, "BAD", timestamp, message.received_time, message.topic, "Mapped field is missing."))
                    continue
                rows.append(ReadSample(field_id, mapped.value, "UNCERTAIN" if invalid_clock else "GOOD", timestamp, message.received_time, message.topic, "Source timestamp is invalid." if invalid_clock else None))
        return rows

    async def _read_http(self, connection: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str]]:
        path = str((fields[0].get("address_json") or {}).get("path") or config.get("path") or "/")
        headers: dict[str, str] = dict(config.get("headers") or {})
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
        document = await connector.request_json(path, method=str(config.get("method") or "GET"), headers=headers,
                                               query=config.get("query") or {}, body=config.get("body_json"))
        return _project_json(fields, document, config.get("timestamp_jsonpath"))

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
            failed = next((stage for stage in stages if stage["status"] == "FAILED"), None)
            error_code = None if proven else str(failed["stage"]) if failed else "NOT_TESTED"
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
                "diagnostic": "" if status == "PASSED" else next((stage["detail"] for stage in stages if stage["status"] == "FAILED"), "The acquisition test did not prove every mapping."),
            },
        )

    async def _probe_stages(self, job: dict[str, Any], stages: list[dict[str, Any]]) -> bool:
        protocol = str(job["protocol"])
        config = dict(job.get("config_json") or {})
        by_name = {item["stage"]: item for item in stages}
        draft_fields = job.get("fields") or []
        if not draft_fields:
            by_name["MAPPING"].update(status="FAILED", detail="Add at least one mapping to test.")
            return False
        fields = [{"id": str(index), "address_json": field["address"], "decode_json": field.get("decode") or {}}
                  for index, field in enumerate(draft_fields)]
        test_id = f"test-{uuid4().hex}"
        # A test has its own client identity and cache entry; it cannot evict a live collector.
        if protocol == "mqtt":
            config.update(client_id=f"fx-test-{uuid4().hex[:16]}", clean_session=True, session_expiry=0)
        connection = {**job, "id": test_id, "config_json": config}
        latest: dict[str, ReadSample] = {}
        started = time.monotonic()
        try:
            async with asyncio.timeout(10):
                while True:
                    rows = await self._read(protocol, connection, fields)
                    for row in rows:
                        sample = row if isinstance(row, ReadSample) else ReadSample(*row)
                        latest[sample.field_id] = sample
                    if protocol != "mqtt" or len(latest) == len(fields):
                        break
                    await asyncio.sleep(0.05)
        except (ConnectorError, NetworkPolicyError, ModbusPlanError, OSError, TimeoutError) as exc:
            code = getattr(exc, "code", "TIMEOUT" if isinstance(exc, TimeoutError) else "NETWORK")
            name = {"AUTH": "AUTH", "DECODE": "DECODE", "ADDRESS": "READ_OR_SUBSCRIBE",
                    "SUBSCRIBE": "READ_OR_SUBSCRIBE", "TIMEOUT": "READ_OR_SUBSCRIBE",
                    "PROTOCOL": "PROTOCOL"}.get(code, "NETWORK")
            by_name[name].update(status="FAILED", detail=str(exc)[:240])
            return False
        finally:
            connector = self._mqtt.pop(test_id, None)
            if connector is not None:
                await asyncio.to_thread(connector.close)
            modbus = self._modbus.pop(test_id, None)
            if modbus is not None:
                await modbus.close()
        elapsed = int((time.monotonic() - started) * 1000)
        for name in ("NETWORK", "PROTOCOL", "READ_OR_SUBSCRIBE", "DECODE"):
            by_name[name].update(status="PASSED", duration_ms=elapsed if name == "READ_OR_SUBSCRIBE" else 0)
        authenticated = (protocol != "modbus_tcp" and (not config.get("anonymous", True) or config.get("auth", "none") != "none"))
        by_name["AUTH"]["status"] = "PASSED" if authenticated else "NOT_APPLICABLE"
        if len(latest) != len(fields):
            by_name["MAPPING"].update(status="FAILED", detail="Not every mapping produced a sample.")
            return False
        for sample in latest.values():
            if sample.quality != "GOOD":
                name = sample.error_stage or "MAPPING"
                by_name[name].update(status="FAILED", detail=sample.reason or "The source returned bad quality.")
                return False
        by_name["MAPPING"]["status"] = "PASSED"
        for index, field in enumerate(draft_fields):
            _, quality = _coerce(field["data_type"], latest[str(index)].value, "GOOD")
            if quality != "GOOD":
                by_name["VALIDATION"].update(status="FAILED", detail=f"Mapping {index + 1} does not match its declared type.")
                return False
        by_name["VALIDATION"]["status"] = "PASSED"
        return True

    async def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self.client.request(method, path, headers=self.headers, json=body)
        response.raise_for_status()
        if response.status_code == 204 or not response.content:
            return {}
        payload = response.json()
        return payload if isinstance(payload, dict) else {"items": payload}


def _project_json(fields: list[dict[str, Any]], document: Any, timestamp_jsonpath: str | None = None) -> list[ReadSample]:
    rows: list[ReadSample] = []
    source_time, invalid_clock = source_timestamp(document, timestamp_jsonpath)
    received_time = _stamp()
    for field in fields:
        address = field.get("address_json") or {}
        expression = str(address.get("jsonpath") or "$")
        try:
            matches = evaluate(expression, document)
            mapped = apply_cardinality(matches, cardinality="REJECT_MULTI", missing="BAD")
        except MappingError as exc:
            rows.append(ReadSample(str(field["id"]), None, "BAD", source_time, received_time, reason=str(exc), error_stage="MAPPING"))
            continue
        if mapped.quality_override == "BAD" or not mapped.present:
            rows.append(ReadSample(str(field["id"]), None, "BAD", source_time, received_time, reason="Mapped field is missing.", error_stage="MAPPING"))
            continue
        rows.append(ReadSample(str(field["id"]), mapped.value, "UNCERTAIN" if invalid_clock else "GOOD", source_time, received_time,
                               reason="Source timestamp is invalid." if invalid_clock else None,
                               error_stage="VALIDATION" if invalid_clock else None))
    return rows


def _coerce(data_type: str, value: Any, quality: str) -> tuple[Any, str]:
    if quality == "BAD":
        return None, "BAD"
    try:
        validate_value(data_type, value)
    except ObservationError:
        return None, "BAD"
    return value, quality


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
