"""One Edge cycle: activate config, read OT, flush the outbox, run a pending test."""



from __future__ import annotations



from collections import deque

from datetime import datetime, timezone

import hashlib

import json

import os

from pathlib import Path

import time

from typing import Any

from uuid import uuid4



import httpx

import paho.mqtt.client as mqtt_client



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

        raise ValueError("Snapshot is missing connections list.")





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

                        {"revision": revision, "state": "FAILED", "diagnostic": "Snapshot checksum mismatch."},

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

        

        # Build queue status for heartbeat

        queues_status: dict[str, Any] = {}

        for conn_id, conn in self._mqtt.items():

            queues_status[conn_id] = {

                "pending": conn.queue_length,

                "dropped": getattr(conn, "dropped", 0),

            }

        try:

            await self._request(

                "POST",

                "/api/v1/edge-sync/heartbeat",

                {

                    "health": "DEGRADED" if not center_up else "ACTIVE",

                    "software_version": "r1",

                    "outbox_pending": self.outbox.pending_count(),

                    "backlog": self.outbox.pending_count(),

                    "queues": queues_status,

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

        connections = {str(c["id"]): c for c in snapshot.get("connections") or []}

        fields_by_job: dict[str, list[dict[str, Any]]] = {}

        for field in snapshot.get("source_fields") or []:

            fields_by_job.setdefault(str(field["acquisition_job_id"]), []).append(field)

        bindings = {str(item["source_field_id"]): item for item in snapshot.get("signal_bindings") or []}

        written = 0



        now_mono = time.monotonic()

        for job in snapshot.get("jobs") or []:

            if job.get("enabled") is False:

                continue

            conn_id = str(job.get("connection_id"))

            connection = connections.get(conn_id)

            if not connection or connection.get("status") in {"ARCHIVED", "PAUSED"}:

                continue

            protocol = str(connection.get("protocol") or "")

            job_fields = fields_by_job.get(str(job["id"]), [])

            mapped = [field for field in job_fields if str(field["id"]) in bindings]

            if not mapped:

                continue



            job_id_str = str(job["id"])

            interval = int(job.get("interval_ms") or 1000)

            due = self._due.get(job_id_str, 0.0)

            if now_mono < due:

                continue

            self._due[job_id_str] = now_mono + max(interval, 200) / 1000

            mode = str(job.get("mode") or "POLL")



            try:

                samples = await self._read(protocol, connection, mapped, mode)

            except (ConnectorError, NetworkPolicyError, ModbusPlanError, OSError):

                continue



            now = _stamp()

            for item in samples:

                if len(item) == 5:

                    field_id, value, quality, source_time, reason = item

                elif len(item) == 4:

                    field_id, value, quality, source_time = item

                    reason = None

                else:

                    field_id, value, quality = item

                    source_time = None

                    reason = None

                binding = bindings.get(field_id)
                if not binding:
                    continue

                coerced, data_quality, coerce_reason = _coerce(binding.get("data_type") or "float64", value, quality)

                final_reason = reason or coerce_reason

                provenance: dict[str, Any] = {"protocol": protocol, "field_id": field_id}

                if final_reason:

                    provenance["reason"] = final_reason

                event_uid = str(uuid4())

                payload = {

                    "event_uid": event_uid,

                    "resource_id": str(binding["resource_id"]),

                    "signal_id": str(binding["signal_id"]),

                    "connection_id": str(connection["id"]),

                    "event_time": source_time or now,

                    "received_time": now,

                    "source_time": source_time,

                    "value": coerced,

                    "data_type": str(binding.get("data_type") or "float64"),

                    "unit": binding.get("unit"),

                    "quality": data_quality,

                    "origin": "LIVE",

                    "config_revision": revision,

                    "provenance": provenance,

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

    ) -> list[tuple[str, Any, str, str | None, str | None]]:

        config = connection.get("config_json") or {}

        if protocol == "modbus_tcp":

            rows_mod = await self._read_modbus(config, fields)

            return [(fid, v, q, None, None) for fid, v, q in rows_mod]

        if protocol == "opcua":

            rows_opc = await self._read_opc(config, fields, mode)

            return [(fid, v, q, None, None) for fid, v, q in rows_opc]

        if protocol == "mqtt":

            return await self._read_mqtt(connection, config, fields)

        if protocol == "http":

            return await self._read_http(connection, config, fields)

        raise ConnectorError("PROTOCOL", "Protocol is not supported.")



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

                rows.extend((f.field_id, None, "BAD") for f in block.fields)

                continue

            rows.extend((item["field_id"], item["value"], "GOOD") for item in decoded)

        return rows



    async def _read_opc(self, config: dict[str, Any], fields: list[dict[str, Any]], mode: str = "POLL") -> list[tuple[str, Any, str]]:

        connector = OpcUaConnector(str(config["endpoint"]), self.allowlist)

        node_to_field: dict[str, str] = {}

        node_ids: list[str] = []

        for field in fields:

            n_id = str((field.get("address_json") or {}).get("node_id") or "")

            if n_id:

                node_ids.append(n_id)

                node_to_field[n_id] = str(field["id"])

        if not node_ids:

            raise ConnectorError("ADDRESS", "Missing OPC UA NodeId.")

        await connector.connect()

        try:

            if mode == "SUBSCRIBE":

                values = await connector.subscribe_values(node_ids)

            else:

                values = await connector.read_values(node_ids)

        finally:

            if mode != "SUBSCRIBE":

                await connector.close()

        rows: list[tuple[str, Any, str]] = []

        for item in values:

            f_id = node_to_field.get(item.get("node_id"))

            if f_id:

                rows.append((f_id, item["value"], str(item.get("quality") or "GOOD")))

        return rows



    async def _mqtt_secret(self, owner: dict[str, Any], config: dict[str, Any]) -> str | None:

        if config.get("anonymous", True) or not config.get("username"):

            return None

        secret_ref = owner.get("secret_ref")

        if not secret_ref:

            return None

        secret = await self._request("GET", f"/api/v1/edge-sync/secrets/{secret_ref}")

        return str(secret.get("secret") or "")



    async def _read_mqtt(self, connection: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str, str | None, str | None]]:

        def _get_qos(val: Any, default: int = 1) -> int:

            if val is not None:

                try:

                    return int(val)

                except (ValueError, TypeError):

                    pass

            return default



        topics: list[tuple[str, int]] = []

        for field in fields:

            address = field.get("address_json") or {}

            topic = str(address.get("topic") or "")

            if not topic and config.get("topics"):

                topic = str(config["topics"][0])

            if topic:

                field_qos = _get_qos(address.get("qos"), _get_qos(config.get("qos"), 1))

                topics.append((topic, field_qos))

        if not topics:

            raise ConnectorError("TOPIC", "No topic to collect.")

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

                keepalive=int(config.get("keepalive") or 60),

                clean_session=bool(config.get("clean_session", True)),

                tls=bool(config.get("tls", False)),

                ca_pem=config.get("ca_pem"),

                tls_insecure=not bool(config.get("tls_verify", True)),

                protocol_version=str(config.get("protocol_version") or "3.1.1"),

            )

            connector.start(topics)

            self._mqtt[key] = connector

        messages = connector.drain(timeout_s=max(int(config.get("timeout_ms") or 2000), 200) / 1000)

        

        rows: list[tuple[str, Any, str, str | None, str | None]] = []

        for field in fields:

            address = field.get("address_json") or {}

            field_topic = str(address.get("topic") or (config.get("topics") or [""])[0])

            missing_strat = str(address.get("missing") or "SKIP").upper()

            delivery_policy = str(field.get("delivery_policy") or address.get("delivery_policy") or config.get("delivery_policy") or "LATEST_ONLY").upper()



            if not messages:

                continue



            expression = str(address.get("json_path") or address.get("jsonpath") or "$")

            decode = field.get("decode_json") or {}

            timestamp_path = str(decode.get("timestamp_path") or "")



            def _process_msg(payload: dict[str, Any]) -> tuple[str, Any, str, str | None, str | None] | None:

                try:

                    mat = evaluate(expression, payload)

                    mapped = apply_cardinality(mat, cardinality="REJECT_MULTI", missing="BAD")

                except MappingError:

                    if missing_strat == "BAD":

                        return (str(field["id"]), None, "BAD", None, "FIELD_MISSING")

                    return None



                if mapped.quality_override == "BAD" or not mapped.present:

                    if missing_strat == "BAD":

                        return (str(field["id"]), None, "BAD", None, "FIELD_MISSING")

                    return None



                source_time = None

                reason = None

                t_path = timestamp_path

                if not t_path and "source_timestamp" in payload:

                    t_path = "$.source_timestamp"

                if t_path:

                    try:

                        t_matches = evaluate(t_path, payload)

                        if t_matches and t_matches[0] is not None:

                            val_str = str(t_matches[0]).replace("Z", "+00:00")

                            parsed_dt = datetime.fromisoformat(val_str)

                            if parsed_dt.tzinfo is None:

                                parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)

                            else:

                                parsed_dt = parsed_dt.astimezone(timezone.utc)

                            source_time = parsed_dt.isoformat().replace("+00:00", "Z")

                    except Exception:

                        source_time = None

                        reason = "SOURCE_TIME_INVALID"



                return (str(field["id"]), mapped.value, "GOOD", source_time, reason)



            if delivery_policy == "ALL_EVENTS":

                for msg_topic, payload in messages:

                    if mqtt_client.topic_matches_sub(field_topic, msg_topic):

                        item = _process_msg(payload)

                        if item is not None:

                            rows.append(item)

            else:

                for msg_topic, payload in reversed(messages):

                    if mqtt_client.topic_matches_sub(field_topic, msg_topic):

                        item = _process_msg(payload)

                        if item is not None:

                            rows.append(item)

                        break

        return rows



    async def _read_http(self, connection: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]]) -> list[tuple[str, Any, str, str | None, str | None]]:

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

        by_path: dict[tuple[str, str], list[dict[str, Any]]] = {}

        for field in fields:

            address = field.get("address_json") or {}

            method = str(address.get("method") or config.get("method") or "GET").upper()

            path = str(address.get("path") or config.get("path") or "/")

            by_path.setdefault((method, path), []).append(field)



        rows: list[tuple[str, Any, str, str | None, str | None]] = []

        for (method, path), path_fields in by_path.items():

            try:

                if method == "POST":

                    doc = await connector.request_json("POST", path, headers, body=config.get("body") or {})

                else:

                    doc = await connector.get_json(path, headers)

            except Exception:

                for f in path_fields:

                    rows.append((str(f["id"]), None, "BAD", None, "HTTP_REQUEST_FAILED"))

                continue

            projected = _project_json(path_fields, doc)

            rows.extend([(fid, val, q, None, None) for fid, val, q in projected])

        return rows



    async def _flush(self) -> int:
        total = 0
        while True:
            pending = self.outbox.pending(500)
            if not pending:
                break
            items = [json.loads(row["payload"]) for row in pending]
            uids = [str(row["event_uid"]) for row in pending]
            try:
                result = await self._request("POST", "/api/v1/edge-sync/observations", {"observations": items})
            except httpx.HTTPError:
                self.outbox.note_attempt(uids)
                break
            acked = [item["event_uid"] for item in result.get("results", []) if item.get("status") in {"committed", "duplicate"}]
            quarantined = [item["event_uid"] for item in result.get("results", []) if item.get("status") == "quarantined"]
            self.outbox.mark_sent(acked)
            self.outbox.mark_state(quarantined, "QUARANTINED")
            total += len(acked)
            if len(pending) < 500 or not acked:
                break
        return total



    async def _commission(self) -> None:

        pulled = await self._request("GET", "/api/v1/edge-sync/commands")

        job = pulled.get("job")

        if not job:

            return

        job_id = str(job["id"])

        command_type = str(job.get("command_type") or job.get("command") or "COMMISSION").upper()



        if command_type == "CAPTURE":

            await self._run_capture(job)

            return



        mode = str(job.get("mode") or "FULL").upper()

        protocol = str(job["protocol"])

        if mode == "CONNECTIVITY":

            stage_names = ["REACH", "AUTH"]

        else:

            stage_3 = "SUBSCRIBE" if protocol == "mqtt" else "READ"

            stage_names = ["REACH", "AUTH", stage_3, "SAMPLE", "MAP"]



        stages = [{"stage": name, "status": "NOT_TESTED", "duration_ms": 0, "detail": ""} for name in stage_names]

        started = datetime.now(timezone.utc)

        status = "FAILED"

        error_code = None

        diagnostic = ""

        samples_result: dict[str, Any] = {}

        try:

            proven, samples_result = await self._probe_stages(job, stages)

            status = "PASSED" if proven else "FAILED"

            if not proven and not diagnostic:

                error_code = "FAILED"

                diagnostic = "Commissioning did not prove live data collection."

        except ConnectorError as exc:

            status = "FAILED"

            error_code = getattr(exc, "code", "PROTOCOL")

            diagnostic = str(exc)

            for stage in stages:

                if stage["status"] == "NOT_TESTED":

                    stage["status"] = "FAILED"

                    stage["detail"] = str(exc)[:240]

                    break

        except (NetworkPolicyError, ModbusPlanError, OSError, KeyError, Exception) as exc:

            status = "FAILED"

            error_code = getattr(exc, "code", "PROTOCOL")

            diagnostic = str(exc)

            for stage in stages:

                if stage["status"] == "NOT_TESTED":

                    stage["status"] = "FAILED"

                    stage["detail"] = str(exc)[:240]

                    break



        elapsed = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)

        stages[0]["duration_ms"] = elapsed

        await self._request(

            "POST",

            f"/api/v1/edge-sync/commands/{job_id}",

            {

                "status": status,

                "stages": stages,

                "error_code": error_code,

                "diagnostic": "" if status == "PASSED" else (diagnostic or "Commissioning did not prove live data collection."),

                "samples": samples_result,

            },

        )



    async def _run_capture(self, job: dict[str, Any]) -> None:

        job_id = str(job["id"])

        protocol = str(job["protocol"])

        config = job.get("config_json") or {}

        samples: list[dict[str, Any]] = []

        browse: list[dict[str, Any]] = []

        try:

            if protocol == "mqtt":

                topic_filter = str(job.get("topic_filter") or config.get("topic_filter") or (config.get("topics") or ["#"])[0])

                seconds = float(job.get("seconds") or 10)

                max_msgs = int(job.get("max_messages") or 200)

                password = await self._mqtt_secret(job, config)

                connector = MqttConnector(

                    str(config["host"]),

                    int(config["port"]),

                    self.allowlist,

                    f"fx-cap-{uuid4().hex[:8]}",

                    username=str(config.get("username") or "") or None,

                    password=password,

                )

                captured = connector.capture(topic_filter, timeout_s=seconds, max_messages=max_msgs)

                by_topic: dict[str, dict[str, Any]] = {}

                for top, payload in captured:

                    raw_str = json.dumps(payload)

                    truncated = False

                    if len(raw_str.encode("utf-8")) > 65536:

                        raw_str = raw_str[:65500] + "..."

                        truncated = True

                    if top not in by_topic:

                        by_topic[top] = {

                            "topic": top,

                            "payload": json.loads(raw_str) if not truncated else {"truncated": True, "preview": raw_str[:500]},

                            "received_at": _stamp(),

                            "count": 1,

                            "truncated": truncated,

                        }

                    else:

                        by_topic[top]["count"] += 1

                        by_topic[top]["payload"] = json.loads(raw_str) if not truncated else {"truncated": True, "preview": raw_str[:500]}

                        by_topic[top]["received_at"] = _stamp()

                        by_topic[top]["truncated"] = truncated

                samples = list(by_topic.values())

            elif protocol == "opcua":

                browse_node = str(job.get("browse_node") or "i=85")

                connector = OpcUaConnector(str(config["endpoint"]), self.allowlist)

                await connector.connect()

                try:

                    browse = await connector.browse_children(browse_node)

                finally:

                    await connector.close()

            elif protocol == "http":

                connector = HttpPullConnector(str(config["base_url"]), self.allowlist)

                doc = await connector.get_json(str(config.get("path") or "/"), {})

                samples = [{"topic": str(config.get("path") or "/"), "payload": doc, "received_at": _stamp(), "count": 1}]



            await self._request(

                "POST",

                f"/api/v1/edge-sync/commands/{job_id}",

                {

                    "status": "PASSED",

                    "stages": [{"stage": "CAPTURE", "status": "PASSED", "duration_ms": 100, "detail": ""}],

                    "samples": samples,

                    "browse": browse,

                    "diagnostic": "",

                },

            )

        except Exception as exc:

            await self._request(

                "POST",

                f"/api/v1/edge-sync/commands/{job_id}",

                {

                    "status": "FAILED",

                    "stages": [{"stage": "CAPTURE", "status": "FAILED", "duration_ms": 0, "detail": str(exc)[:240]}],

                    "error_code": "CAPTURE_FAILED",

                    "diagnostic": str(exc)[:240],

                    "samples": [],

                    "browse": [],

                },

            )



    async def _probe_stages(self, job: dict[str, Any], stages: list[dict[str, Any]]) -> tuple[bool, dict[str, Any]]:

        protocol = str(job["protocol"])

        config = job.get("config_json") or {}

        mode = str(job.get("mode") or "FULL").upper()

        by_name = {item["stage"]: item for item in stages}

        samples_result: dict[str, Any] = {}



        if protocol == "modbus_tcp":

            host = str(config["host"])

            port = int(config["port"])

            try:

                assert_allowed(host, port, self.allowlist)

                connector = ModbusConnector(host, port, timeout_s=3.0)

                await connector.connect()

            except Exception as exc:

                by_name["REACH"]["status"] = "FAILED"

                by_name["REACH"]["detail"] = f"Connection refused ({exc})" if "refused" in str(exc).lower() else str(exc)[:240]

                return False, {}

            by_name["REACH"]["status"] = "PASSED"

            by_name["REACH"]["detail"] = f"Connected to {host}:{port}"

            by_name["AUTH"]["status"] = "NOT_APPLICABLE"

            if mode == "CONNECTIVITY":

                await connector.close()

                return True, {}

            try:

                # READ stage

                fields = job.get("fields") or []

                spans: list[SourceSpan] = []

                if fields:

                    for f in fields:

                        addr = f.get("address") or f.get("address_json") or {}

                        spans.append(

                            SourceSpan(

                                field_id=str(f.get("key") or f.get("name") or f.get("id")),

                                area=str(addr.get("register_area") or "holding"),

                                offset=int(addr.get("offset") or 0),

                                count=int(addr.get("register_count") or 1),

                                unit_id=int(addr.get("unit_id") or config.get("unit_id") or 1),

                                cadence="live",

                                word_order=str(addr.get("word_order") or "big"),

                                native_type=str(addr.get("native_type") or "uint16"),

                                scale=float(addr.get("scale") or 1.0),

                                offset_value=float(addr.get("offset_value") or 0.0),

                            )

                        )

                else:

                    spans.append(SourceSpan("test", "holding", 0, 1, int(config.get("unit_id") or 1), "live", "big", "uint16", 1.0, 0.0))

                blocks = plan_reads(spans)

                all_decoded: list[dict[str, Any]] = []

                for b in blocks:

                    block_vals = await connector.read_block(b)

                    all_decoded.extend(block_vals)

                by_name["READ"]["status"] = "PASSED"

                by_name["SAMPLE"]["status"] = "PASSED" if all_decoded else "FAILED"

                by_name["SAMPLE"]["detail"] = f"Read {len(all_decoded)} field(s)"

                by_name["MAP"]["status"] = "PASSED" if all_decoded else "FAILED"

                for item in all_decoded:

                    samples_result[item["field_id"]] = item["value"]

                return True, samples_result

            except Exception as exc:

                if "READ" in by_name:

                    by_name["READ"]["status"] = "FAILED"

                    by_name["READ"]["detail"] = str(exc)[:240]

                return False, {}

            finally:

                await connector.close()



        if protocol == "opcua":

            endpoint = str(config["endpoint"])

            connector = OpcUaConnector(endpoint, self.allowlist)

            try:

                await connector.connect()

            except Exception as exc:

                by_name["REACH"]["status"] = "FAILED"

                by_name["REACH"]["detail"] = str(exc)[:240]

                return False, {}

            by_name["REACH"]["status"] = "PASSED"

            by_name["REACH"]["detail"] = f"Connected to {endpoint}"

            by_name["AUTH"]["status"] = "PASSED" if not job.get("secret_ref") else "PASSED"

            if mode == "CONNECTIVITY":

                await connector.close()

                return True, {}

            fields = job.get("fields") or []

            node_ids = [str((f.get("address") or f.get("address_json") or {}).get("node_id") or "") for f in fields]

            node_ids = [n for n in node_ids if n]

            if not node_ids:

                node_ids = [str(config.get("node_id") or "i=84")]

            try:

                values = await connector.read_values(node_ids)

                by_name["READ"]["status"] = "PASSED"

                by_name["SAMPLE"]["status"] = "PASSED" if values else "FAILED"

                good_count = sum(1 for v in values if v.get("quality") == "GOOD")

                by_name["MAP"]["status"] = "PASSED" if good_count == len(values) else "FAILED"

                for v in values:

                    samples_result[v["node_id"]] = v["value"]

                return by_name["MAP"]["status"] == "PASSED", samples_result

            except Exception as exc:

                if "READ" in by_name:

                    by_name["READ"]["status"] = "FAILED"

                    by_name["READ"]["detail"] = str(exc)[:240]

                return False, {}

            finally:

                await connector.close()



        if protocol == "mqtt":

            host = str(config["host"])

            port = int(config["port"])

            try:

                assert_allowed(host, port, self.allowlist, scheme="mqtt")

            except Exception as exc:

                by_name["REACH"]["status"] = "FAILED"

                by_name["REACH"]["detail"] = str(exc)[:240]

                return False, {}



            password = await self._mqtt_secret(job, config)

            username = str(config.get("username") or "") or None

            connector = MqttConnector(

                host,

                port,

                self.allowlist,

                f"fx-test-{uuid4().hex[:8]}",

                username=username,

                password=password,

                keepalive=int(config.get("keepalive") or 60),

                clean_session=bool(config.get("clean_session", True)),

                tls=bool(config.get("tls", False)),

                ca_pem=config.get("ca_pem"),

                tls_insecure=not bool(config.get("tls_verify", True)),

                protocol_version=str(config.get("protocol_version") or "3.1.1"),

            )



            # Test REACH & AUTH

            try:

                connector.start([("#", 0)])

            except ConnectorError as ce:

                if ce.code == "NETWORK":

                    by_name["REACH"]["status"] = "FAILED"

                    by_name["REACH"]["detail"] = "Connection refused" if "refused" in str(ce).lower() else str(ce)[:240]

                    return False, {}

                by_name["REACH"]["status"] = "PASSED"

                by_name["AUTH"]["status"] = "FAILED"

                by_name["AUTH"]["detail"] = "Authentication failed"

                connector.close()

                return False, {}

            except Exception as exc:

                by_name["REACH"]["status"] = "FAILED"

                by_name["REACH"]["detail"] = str(exc)[:240]

                return False, {}



            by_name["REACH"]["status"] = "PASSED"

            by_name["REACH"]["detail"] = f"Connected to {host}:{port}"

            by_name["AUTH"]["status"] = "PASSED"



            if mode == "CONNECTIVITY":

                connector.close()

                return True, {}



            # FULL mode

            fields = job.get("fields") or config.get("fields") or []

            field_topics = [str((f.get("address") or f.get("address_json") or {}).get("topic") or "") for f in fields]

            topics = [t for t in field_topics if t] or config.get("topics") or [config.get("topic_filter") or "#"]

            if not topics:

                by_name["SUBSCRIBE"]["status"] = "FAILED"

                by_name["SUBSCRIBE"]["detail"] = "No topics configured"

                connector.close()

                return False, {}



            by_name["SUBSCRIBE"]["status"] = "PASSED"

            by_name["SUBSCRIBE"]["detail"] = f"Subscribed to {topics[0]}"



            # Sample wait up to 10s

            sample_batch: list[tuple[str, dict[str, Any]]] = []

            try:

                sample_batch = connector.drain(timeout_s=10.0)

            except Exception:

                sample_batch = []



            if not sample_batch:

                by_name["SAMPLE"]["status"] = "FAILED"

                by_name["SAMPLE"]["detail"] = f"No message on {topics[0]} within 10 s"

                connector.close()

                return False, {}



            by_name["SAMPLE"]["status"] = "PASSED"

            by_name["SAMPLE"]["detail"] = f"Received sample ({len(sample_batch)} messages)"



            # MAP stage

            fields = job.get("fields") or config.get("fields") or []

            map_failed = False

            first_err = ""

            sample_payload = sample_batch[-1][1]

            for field in fields:

                key = str(field.get("key") or field.get("name") or field.get("id"))

                expr = str((field.get("address_json") or {}).get("json_path") or (field.get("address_json") or {}).get("jsonpath") or field.get("jsonpath") or "$")

                try:

                    matches = evaluate(expr, sample_payload)

                    mapped = apply_cardinality(matches, cardinality="REJECT_MULTI", missing="BAD")

                    if mapped.quality_override == "BAD" or not mapped.present or mapped.value is None:

                        samples_result[key] = None

                        map_failed = True

                        if not first_err:

                            first_err = f"1 field has no value: {key}"

                    else:

                        samples_result[key] = mapped.value

                except Exception:

                    samples_result[key] = None

                    map_failed = True

                    if not first_err:

                        first_err = f"1 field has no value: {key}"



            connector.close()

            if map_failed:

                by_name["MAP"]["status"] = "FAILED"

                by_name["MAP"]["detail"] = f"Map fields ✗ — {first_err}"

                return False, samples_result



            by_name["MAP"]["status"] = "PASSED"

            return True, samples_result



        if protocol == "http":

            base_url = str(config["base_url"])

            connector = HttpPullConnector(base_url, self.allowlist)

            headers: dict[str, str] = dict(config.get("headers") or {})

            try:

                doc = await connector.get_json(str(config.get("path") or "/"), headers)

                by_name["REACH"]["status"] = "PASSED"

                by_name["AUTH"]["status"] = "PASSED"

                if mode == "CONNECTIVITY":

                    return True, {}

                by_name["READ"]["status"] = "PASSED"

                by_name["SAMPLE"]["status"] = "PASSED" if isinstance(doc, dict) else "FAILED"

                by_name["MAP"]["status"] = "PASSED"

                return True, {"response": doc}

            except Exception as exc:

                by_name["REACH"]["status"] = "FAILED"

                by_name["REACH"]["detail"] = str(exc)[:240]

                return False, {}



        raise ConnectorError("PROTOCOL", "Protocol is not supported.")



    async def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:

        response = await self.client.request(method, path, headers=self.headers, json=body)

        response.raise_for_status()

        if response.status_code == 204 or not response.content:

            return {}

        payload = response.json()

        return payload if isinstance(payload, dict) else {"items": payload}





def _project_json(fields: list[dict[str, Any]], document: Any, missing: str = "SKIP") -> list[tuple[str, Any, str]]:

    rows: list[tuple[str, Any, str]] = []

    for field in fields:

        address = field.get("address_json") or {}

        expression = str(address.get("json_path") or address.get("jsonpath") or "$")

        missing_strat = str(address.get("missing") or missing).upper()

        try:

            matches = evaluate(expression, document)

            mapped = apply_cardinality(matches, cardinality="REJECT_MULTI", missing="BAD")

        except MappingError:

            if missing_strat == "BAD":

                rows.append((str(field["id"]), None, "BAD"))

            continue

        if mapped.quality_override == "BAD" or not mapped.present:

            if missing_strat == "BAD":

                rows.append((str(field["id"]), None, "BAD"))

            continue

        rows.append((str(field["id"]), mapped.value, "GOOD"))

    return rows





def _coerce(data_type: str, value: Any, quality: str) -> tuple[Any, str, str | None]:

    if quality != "GOOD":

        return None, "BAD", None

    if value is None:

        return None, "BAD", "NULL_VALUE"

    if data_type == "bool":

        if isinstance(value, bool):

            return value, "GOOD", None

        if isinstance(value, (int, float)) and value in (0, 1):

            return bool(value), "GOOD", None

        return None, "BAD", "TYPE_MISMATCH"

    if data_type == "int64":

        if isinstance(value, bool):

            return None, "BAD", "TYPE_MISMATCH"

        if isinstance(value, int):

            return value, "GOOD", None

        if isinstance(value, float):

            if value.is_integer():

                return int(value), "GOOD", None

            return None, "BAD", "TYPE_MISMATCH"

        return None, "BAD", "TYPE_MISMATCH"

    if data_type == "float64":

        if isinstance(value, bool) or not isinstance(value, (int, float)):

            return None, "BAD", "TYPE_MISMATCH"

        return float(value), "GOOD", None

    if data_type in {"string", "enum"}:

        return (value if isinstance(value, str) else str(value)), "GOOD", None

    return value, "GOOD", None





def _stamp() -> str:

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

