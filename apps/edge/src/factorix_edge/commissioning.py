"""Commissioning commands (connection test and capture).

Each command runs in its own task with fresh connectors, so a slow or silent source
never blocks acquisition. Field samples are reported by field key, the name the wizard
uses. Stage durations are measured per stage.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse
from uuid import uuid4

from factorix.domain.network import AllowedEndpoint, NetworkPolicyError, assert_allowed
from factorix_edge.aio import bounded
from factorix_edge.connectors import mqtt as mqtt_mod
from factorix_edge.connectors import ws as ws_mod
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.connectors.http_pull import HttpPullConnector
from factorix_edge.connectors.modbus import ModbusConnector
from factorix_edge.connectors.mqtt import MqttConnector
from factorix_edge.connectors.opcua import OpcUaConnector
from factorix_edge.connectors.ws import WebSocketConnector
from factorix_edge.jobs import (
    DEFAULT_MODBUS_MERGE_GAP,
    as_connector_error,
    http_headers,
    map_mqtt_messages,
    modbus_fields,
    mqtt_qos,
    mqtt_topic,
    opc_nodes,
    read_modbus,
    read_opc,
)
from factorix_edge.mapping import Sample, field_address, field_key, project_json
from factorix_edge.timeutil import now_iso

logger = logging.getLogger(__name__)

COMMAND_TIMEOUT_S = 28.0  # the wizard gives up after 30 s
SAMPLE_WAIT_S = 10.0
MAX_CAPTURE_BYTES = 65536


class Stages:
    """Stage results. Statuses: PASSED, FAILED, NOT_APPLICABLE, NOT_TESTED and SKIPPED (the stage
    could not be verified with the given input, e.g. HTTP authentication without a data path;
    the detail says why). Only FAILED fails a test."""

    def __init__(self, names: list[str]) -> None:
        self.items = [{"stage": name, "status": "NOT_TESTED", "duration_ms": 0, "detail": ""} for name in names]
        self.by_name = {item["stage"]: item for item in self.items}
        self._mark = time.monotonic()

    def set(self, name: str, status: str, detail: str = "") -> None:
        item = self.by_name.get(name)
        now = time.monotonic()
        if item is None and status == "FAILED":
            # A failure in a stage the requested mode does not list (e.g. READ in a CONNECTIVITY
            # test) is still shown, so the overall result never contradicts the stage list.
            item = {"stage": name, "status": "NOT_TESTED", "duration_ms": 0, "detail": ""}
            self.items.append(item)
            self.by_name[name] = item
        if item is not None:
            item["status"] = status
            item["detail"] = detail[:240]
            item["duration_ms"] = int((now - self._mark) * 1000)
        self._mark = now

    def fail_next(self, detail: str) -> None:
        for item in self.items:
            if item["status"] == "NOT_TESTED":
                self.set(item["stage"], "FAILED", detail)
                return

    @property
    def failed(self) -> dict[str, Any] | None:
        return next((item for item in self.items if item["status"] == "FAILED"), None)


def overall_status(passed: bool, stages: Stages, diagnostic: str) -> tuple[bool, str]:
    """The overall result is derived from the stages (R2-CN-03).

    PASSED needs the probe to succeed and no FAILED stage. A probe that failed without marking a
    stage marks the first stage it did not reach, so the stage list always shows the cause.
    Returns ``(passed, diagnostic)``.
    """
    failed = stages.failed
    if passed and failed is None:
        return True, ""
    if failed is None:
        stages.fail_next(diagnostic or "The test stopped before this stage.")
        failed = stages.failed
        if failed is None:
            logger.error("Commissioning probe failed without a failing stage: %s", diagnostic)
            stages.items.append({"stage": "RESULT", "status": "FAILED", "duration_ms": 0, "detail": (diagnostic or "Test failed.")[:240]})
            failed = stages.items[-1]
    return False, diagnostic or str(failed.get("detail") or "") or "Test failed."


def _key(item: dict[str, Any]) -> str:
    return field_key(item)


def _with_ids(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Commission fields carry key/name; give them an id so projection reports by key."""
    return [{**item, "id": _key(item)} for item in fields]


def _json_safe(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _map_stage(stages: Stages, fields: list[dict[str, Any]], samples: list[Sample]) -> tuple[bool, dict[str, Any]]:
    """MAP passes when every field produced a usable value (null only when nullable)."""
    result: dict[str, Any] = {}
    problems: list[str] = []
    by_id = {sample.field_id: sample for sample in samples}
    for item in fields:
        key = _key(item)
        sample = by_id.get(key)
        nullable = bool(field_address(item).get("nullable"))
        if sample is None:
            result[key] = None
            problems.append(f"{key}: no value")
        elif sample.quality == "BAD":
            result[key] = None
            problems.append(f"{key}: {sample.reason or 'BAD'}")
        else:
            result[key] = _json_safe(sample.value)
            if sample.value is None and not nullable and str(field_address(item).get("native_type") or "").lower() not in {"ascii", "string"}:
                problems.append(f"{key}: null (mark the field nullable if that is expected)")
    if problems:
        stages.set("MAP", "FAILED", f"{len(problems)} of {len(fields)} field(s) not mapped: " + "; ".join(problems[:5]))
        return False, result
    stages.set("MAP", "PASSED", f"{len(fields)} field(s) mapped")
    return True, result


class Commissioner:
    def __init__(
        self,
        request: Callable[..., Awaitable[dict[str, Any]]],
        allowlist_for: Callable[[str, dict[str, Any]], list[AllowedEndpoint]],
        secret: Callable[[str], Awaitable[str]],
    ) -> None:
        self.request = request
        self.allowlist_for = allowlist_for
        self.secret = secret

    async def run(self, job: dict[str, Any]) -> None:
        command = str(job.get("command_type") or job.get("command") or "COMMISSION").upper()
        if command == "CAPTURE":
            await self._capture(job)
        else:
            await self._test(job)

    async def _report(self, job_id: str, body: dict[str, Any]) -> None:
        await self.request("POST", f"/api/v1/edge-sync/commands/{job_id}", body)

    # ------------------------------------------------------------------ test

    async def _test(self, job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        protocol = str(job.get("protocol") or "")
        mode = str(job.get("mode") or "FULL").upper()
        if mode == "CONNECTIVITY":
            names = ["REACH", "AUTH"]
        else:
            names = ["REACH", "AUTH", "SUBSCRIBE" if protocol in {"mqtt", "websocket"} else "READ", "SAMPLE", "MAP"]
        stages = Stages(names)
        samples: dict[str, Any] = {}
        error_code: str | None = None
        diagnostic = ""
        try:
            passed, samples = await bounded(self._probe(job, stages, mode), timeout=COMMAND_TIMEOUT_S)
        except asyncio.TimeoutError:
            passed = False
            error_code = "TIMEOUT"
            diagnostic = f"The test did not finish within {COMMAND_TIMEOUT_S:.0f} s."
            stages.fail_next(diagnostic)
        except Exception as exc:  # noqa: BLE001 - reported to the operator as a failed stage
            error = as_connector_error(exc)
            passed = False
            error_code = error.code
            diagnostic = str(error)
            stages.fail_next(diagnostic)
        passed, diagnostic = overall_status(passed, stages, diagnostic)
        if not passed:
            error_code = error_code or "FAILED"
        await self._report(
            job_id,
            {
                "status": "PASSED" if passed else "FAILED",
                "stages": stages.items,
                "error_code": None if passed else error_code,
                "diagnostic": "" if passed else diagnostic,
                "samples": samples,
            },
        )

    async def _probe(self, job: dict[str, Any], stages: Stages, mode: str) -> tuple[bool, dict[str, Any]]:
        protocol = str(job.get("protocol") or "")
        config = job.get("config_json") or {}
        fields = _with_ids(list(job.get("fields") or []))
        allow = self.allowlist_for(protocol, config)
        if protocol == "modbus_tcp":
            return await self._probe_modbus(config, fields, stages, mode, allow)
        if protocol == "opcua":
            return await self._probe_opc(job, config, fields, stages, mode, allow)
        if protocol == "mqtt":
            return await self._probe_mqtt(job, config, fields, stages, mode, allow)
        if protocol == "http":
            return await self._probe_http(job, config, fields, stages, mode, allow)
        if protocol == "websocket":
            return await self._probe_ws(job, config, fields, stages, mode, allow)
        raise ConnectorError("PROTOCOL", "Protocol is not supported.")

    async def _probe_modbus(self, config: dict[str, Any], fields: list[dict[str, Any]], stages: Stages, mode: str, allow: list[AllowedEndpoint]) -> tuple[bool, dict[str, Any]]:
        host = str(config["host"])
        port = int(config.get("port") or 502)
        timeout_s = max(int(config.get("timeout_ms") or 3000), 200) / 1000
        try:
            assert_allowed(host, port, allow)
        except NetworkPolicyError as exc:
            stages.set("REACH", "FAILED", str(exc))
            return False, {}
        connector = ModbusConnector(host, port, timeout_s=timeout_s)
        try:
            try:
                await connector.connect()
            except ConnectorError as exc:
                stages.set("REACH", "FAILED", str(exc))
                return False, {}
            stages.set("REACH", "PASSED", f"Connected to {host}:{port}")
            stages.set("AUTH", "NOT_APPLICABLE", "Modbus TCP has no authentication")
            if mode == "CONNECTIVITY":
                return True, {}
            if not fields:
                stages.set("READ", "FAILED", "No fields to read. Add at least one register.")
                return False, {}
            items, bad = modbus_fields(fields, config, key_by=_key)
            try:
                gap = int(config.get("merge_gap_registers", DEFAULT_MODBUS_MERGE_GAP))
                samples = await read_modbus(connector, items, merge_gap=gap) if items else []
            except ConnectorError as exc:
                stages.set("READ", "FAILED", str(exc))
                return False, {}
            samples = bad + samples
            units = sorted({item.span.unit_id for item in items})
            stages.set("READ", "PASSED", f"FC03 read on unit(s) {', '.join(map(str, units)) or '-'}")
            good = [s for s in samples if s.quality != "BAD"]
            stages.set("SAMPLE", "PASSED" if good else "FAILED", f"Decoded {len(good)} of {len(fields)} field(s)")
            return _map_stage(stages, fields, samples)
        finally:
            await connector.close()

    async def _probe_opc(self, job: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]], stages: Stages, mode: str, allow: list[AllowedEndpoint]) -> tuple[bool, dict[str, Any]]:
        endpoint = str(config["endpoint"])
        try:
            connector = await self._opc_connector(job, config, allow)
        except (ConnectorError, NetworkPolicyError) as exc:
            stages.set("REACH", "FAILED", str(exc))
            return False, {}
        try:
            await connector.ensure_connected()
        except ConnectorError as exc:
            if exc.code in {"AUTH", "SECURITY"}:
                stages.set("REACH", "PASSED", f"Reached {endpoint}")
                stages.set("AUTH", "FAILED", str(exc))
            else:
                stages.set("REACH", "FAILED", str(exc))
            await connector.close()
            return False, {}
        try:
            stages.set("REACH", "PASSED", f"Connected to {endpoint}")
            stages.set("AUTH", "PASSED", "Session activated as " + ("anonymous" if not config.get("username") else str(config["username"])))
            if mode == "CONNECTIVITY":
                return True, {}
            nodes, bad = opc_nodes(fields, key_by=_key)
            if not nodes:
                stages.set("READ", "FAILED", "No NodeId to read. Enter the node_id of each field.")
                return False, {}
            try:
                samples = bad + await read_opc(connector, nodes)
            except ConnectorError as exc:
                stages.set("READ", "FAILED", str(exc))
                return False, {}
            stages.set("READ", "PASSED", f"Read {len(nodes)} node(s) in one request")
            good = [s for s in samples if s.quality != "BAD"]
            stages.set("SAMPLE", "PASSED" if good else "FAILED", f"{len(good)} of {len(fields)} node(s) returned a value")
            return _map_stage(stages, fields, samples)
        finally:
            await connector.close()

    async def _opc_connector(self, job: dict[str, Any], config: dict[str, Any], allow: list[AllowedEndpoint]) -> OpcUaConnector:
        username = str(config.get("username") or "") or None
        password = None
        if username and not config.get("anonymous") and job.get("secret_ref"):
            password = await self.secret(str(job["secret_ref"]))
        return OpcUaConnector(
            str(config["endpoint"]),
            allow,
            timeout_s=max(int(config.get("timeout_ms") or 4000), 200) / 1000,
            security_mode=config.get("security_mode"),
            security_policy=config.get("security_policy"),
            username=username,
            password=password,
        )

    async def _mqtt_connector(self, job: dict[str, Any], config: dict[str, Any], allow: list[AllowedEndpoint], prefix: str) -> MqttConnector:
        password = None
        if not config.get("anonymous", True) and config.get("username") and job.get("secret_ref"):
            password = await self.secret(str(job["secret_ref"]))
        return MqttConnector(
            str(config["host"]),
            int(config.get("port") or 1883),
            allow,
            f"{prefix}-{uuid4().hex[:8]}",
            username=str(config.get("username") or "") or None,
            password=password,
            keepalive=int(config.get("keepalive") or 60),
            clean_session=True,
            tls=bool(config.get("tls", False)),
            ca_pem=config.get("ca_pem"),
            tls_insecure=not bool(config.get("tls_verify", True)),
            protocol_version=str(config.get("protocol_version") or "3.1.1"),
        )

    async def _probe_mqtt(self, job: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]], stages: Stages, mode: str, allow: list[AllowedEndpoint]) -> tuple[bool, dict[str, Any]]:
        host = str(config["host"])
        port = int(config.get("port") or 1883)
        try:
            connector = await self._mqtt_connector(job, config, allow, "fx-test")
        except NetworkPolicyError as exc:
            stages.set("REACH", "FAILED", str(exc))
            return False, {}
        try:
            try:
                await connector.start()
                await connector.wait_connected(10.0)
            except ConnectorError as exc:
                if exc.code == "AUTH":
                    stages.set("REACH", "PASSED", f"Reached {host}:{port}")
                    stages.set("AUTH", "FAILED", str(exc))
                else:
                    stages.set("REACH", "FAILED", str(exc))
                return False, {}
            stages.set("REACH", "PASSED", f"Connected to {host}:{port}")
            stages.set("AUTH", "PASSED", "Anonymous" if not config.get("username") else f"Accepted user {config['username']}")
            if mode == "CONNECTIVITY":
                return True, {}
            topics: dict[str, int] = {}
            for item in fields:
                topic = mqtt_topic(item, config)
                if topic:
                    topics[topic] = max(topics.get(topic, 0), mqtt_qos(item, config))
            if not topics:
                for topic in config.get("topics") or ([config["topic_filter"]] if config.get("topic_filter") else []):
                    topics[str(topic)] = int(config.get("qos") or 1)
            if not topics:
                stages.set("SUBSCRIBE", "FAILED", "No topics configured")
                return False, {}
            listener = connector.add_listener(topics=list(topics))
            connector.set_topics("test", list(topics.items()))
            stages.set("SUBSCRIBE", "PASSED", f"Subscribed to {', '.join(list(topics)[:3])}")
            messages: list[mqtt_mod.Message] = []
            seen: set[str] = set()
            deadline = time.monotonic() + SAMPLE_WAIT_S
            while len(seen) < len(topics):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    message = await bounded(listener.queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                messages.append(message)
                seen.update(t for t in topics if mqtt_mod.mqtt.topic_matches_sub(t, message[0]))
            if not messages:
                stages.set("SAMPLE", "FAILED", f"No message on {next(iter(topics))} within {SAMPLE_WAIT_S:.0f} s")
                return False, {}
            stages.set("SAMPLE", "PASSED", f"Received {len(messages)} message(s) on {len(seen)} of {len(topics)} topic(s)")
            if not fields:
                stages.set("MAP", "NOT_APPLICABLE", "No fields to map")
                return True, {"payload": _json_safe(messages[-1][1])}
            events, latest = map_mqtt_messages(fields, config, messages)
            newest: dict[str, Sample] = {sample.field_id: sample for sample in events}
            newest.update(latest)
            return _map_stage(stages, fields, list(newest.values()))
        finally:
            await connector.close()

    async def _probe_http(self, job: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]], stages: Stages, mode: str, allow: list[AllowedEndpoint]) -> tuple[bool, dict[str, Any]]:
        """REACH and AUTH use a real data path: the first field's path, else the connection's
        ``path``, else the test's ``test_path``. Without any path the host is only reached and
        AUTH is SKIPPED ("Not verified"), never PASSED: a public root URL proves nothing about
        the credential (R2-CN-01). A 401/403 always fails AUTH.
        """
        base_url = str(config.get("base_url") or config.get("url") or "")
        auth = str(config.get("auth") or "none").lower()
        try:
            connector = HttpPullConnector(
                base_url,
                allow,
                timeout_s=max(int(config.get("timeout_ms") or 5000), 200) / 1000,
                query=config.get("query") or None,
                rate_limit_per_min=config.get("rate_limit_per_min"),
            )
            headers = await http_headers(config, job.get("secret_ref"), self.secret)
        except (ConnectorError, NetworkPolicyError) as exc:
            stages.set("REACH", "FAILED", str(exc))
            return False, {}
        paths: dict[str, list[dict[str, Any]]] = {}
        for item in fields:
            paths.setdefault(str(field_address(item).get("path") or config.get("path") or "/"), []).append(item)
        if not paths:
            probe = str(config.get("path") or job.get("test_path") or "").strip()
            if probe:
                paths[probe] = []
        try:
            if not paths:
                return await self._http_reach_only(connector, base_url, headers, auth, stages, mode)
            samples: list[Sample] = []
            documents: dict[str, Any] = {}
            for index, (path, path_fields) in enumerate(list(paths.items())[:6]):
                try:
                    documents[path] = await connector.get_json(path, headers, max_wait_s=8.0)
                except ConnectorError as exc:
                    if index == 0:
                        if exc.code in {"NETWORK", "TIMEOUT", "REDIRECT", "RATE_LIMITED"}:
                            stages.set("REACH", "FAILED", str(exc))
                            return False, {}
                        stages.set("REACH", "PASSED", f"Reached {base_url}")
                        if exc.code == "AUTH":
                            stages.set("AUTH", "FAILED", f"The source rejected the credential on GET {path}: {exc} Check the {auth_label(auth)}.")
                            return False, {}
                        if auth == "none":
                            stages.set("AUTH", "NOT_APPLICABLE", "No authentication configured")
                        else:
                            stages.set("AUTH", "SKIPPED", f"Not verified: GET {path} did not answer with data ({exc})")
                        stages.set("READ", "FAILED", f"GET {path}: {exc}")
                        return False, {}
                    samples.extend(Sample(_key(f), None, "BAD", None, exc.code) for f in path_fields)
                    continue
                if index == 0:
                    stages.set("REACH", "PASSED", f"Reached {base_url}")
                    if auth == "none":
                        stages.set("AUTH", "NOT_APPLICABLE", "No authentication configured")
                    else:
                        stages.set("AUTH", "PASSED", f"Accepted {auth_label(auth)} on GET {path}")
                    if mode == "CONNECTIVITY":
                        return True, {}
                samples.extend(project_json(path_fields, documents[path], now_iso()))
            stages.set("READ", "PASSED", f"GET {len(documents)} path(s)")
            stages.set("SAMPLE", "PASSED" if documents else "FAILED", "JSON body received" if documents else "No JSON body")
            if not fields:
                stages.set("MAP", "NOT_APPLICABLE", "No fields to map")
                return bool(documents), {"response": _json_safe(next(iter(documents.values()), None))}
            return _map_stage(stages, fields, samples)
        finally:
            await connector.close()

    async def _http_reach_only(
        self, connector: HttpPullConnector, base_url: str, headers: dict[str, str], auth: str, stages: Stages, mode: str
    ) -> tuple[bool, dict[str, Any]]:
        """No data path: prove the host answers; authentication stays unverified."""
        try:
            await connector.get_json("", headers, max_wait_s=8.0)
        except ConnectorError as exc:
            if exc.code in {"NETWORK", "TIMEOUT", "REDIRECT", "RATE_LIMITED"}:
                stages.set("REACH", "FAILED", str(exc))
                return False, {}
            if exc.code == "AUTH":
                stages.set("REACH", "PASSED", f"Reached {base_url}")
                stages.set("AUTH", "FAILED", f"The source rejected the credential at {base_url}: {exc} Check the {auth_label(auth)}.")
                return False, {}
        stages.set("REACH", "PASSED", f"Reached {base_url}")
        if auth == "none":
            stages.set("AUTH", "NOT_APPLICABLE", "No authentication configured")
        else:
            stages.set("AUTH", "SKIPPED", "Not verified — add a data path")
        if mode != "CONNECTIVITY":
            stages.set("READ", "NOT_APPLICABLE", "No data path to read. Add a field or a test path.")
            stages.set("SAMPLE", "NOT_APPLICABLE", "No data path to read")
            stages.set("MAP", "NOT_APPLICABLE", "No fields to map")
        return True, {}

    async def _ws_connector(self, job: dict[str, Any], config: dict[str, Any], allow: list[AllowedEndpoint]) -> WebSocketConnector:
        headers = await http_headers(config, job.get("secret_ref"), self.secret)
        return WebSocketConnector(str(config.get("url") or ""), allow, headers=headers, timeout_s=max(int(config.get("timeout_ms") or 10000), 200) / 1000)

    async def _probe_ws(self, job: dict[str, Any], config: dict[str, Any], fields: list[dict[str, Any]], stages: Stages, mode: str, allow: list[AllowedEndpoint]) -> tuple[bool, dict[str, Any]]:
        url = str(config.get("url") or "")
        try:
            connector = await self._ws_connector(job, config, allow)
        except (ConnectorError, NetworkPolicyError) as exc:
            stages.set("REACH", "FAILED", str(exc))
            return False, {}
        try:
            await connector.start()
            try:
                await connector.wait_connected(connector.timeout_s + 1)
            except ConnectorError as exc:
                if exc.code == "AUTH":
                    stages.set("REACH", "PASSED", f"Reached {url}")
                    stages.set("AUTH", "FAILED", str(exc))
                else:
                    stages.set("REACH", "FAILED", str(exc))
                return False, {}
            stages.set("REACH", "PASSED", f"Connected to {url}")
            stages.set("AUTH", "NOT_APPLICABLE" if str(config.get("auth") or "none") == "none" else "PASSED", "")
            if mode == "CONNECTIVITY":
                return True, {}
            stages.set("SUBSCRIBE", "PASSED", "WebSocket open")
            frame = await connector.next_frame(0, SAMPLE_WAIT_S)
            if frame is None:
                stages.set("SAMPLE", "FAILED", f"No JSON frame within {SAMPLE_WAIT_S:.0f} s")
                return False, {}
            stages.set("SAMPLE", "PASSED", f"Received a {frame.size}-byte frame")
            if not fields:
                stages.set("MAP", "NOT_APPLICABLE", "No fields to map")
                return True, {}
            return _map_stage(stages, fields, project_json(fields, frame.document, frame.received_time))
        finally:
            await connector.close()

    # ------------------------------------------------------------------ capture

    async def _capture(self, job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        started = time.monotonic()
        try:
            samples, browse = await bounded(self._capture_inner(job), timeout=float(job.get("seconds") or 10) + 15)
        except Exception as exc:  # noqa: BLE001 - reported to the operator
            error = as_connector_error(exc) if not isinstance(exc, asyncio.TimeoutError) else ConnectorError("TIMEOUT", "Capture did not finish in time.")
            await self._report(
                job_id,
                {
                    "status": "FAILED",
                    "stages": [{"stage": "CAPTURE", "status": "FAILED", "duration_ms": int((time.monotonic() - started) * 1000), "detail": str(error)[:240]}],
                    "error_code": "CAPTURE_FAILED",
                    "diagnostic": str(error)[:240],
                    "samples": [],
                    "browse": [],
                },
            )
            return
        await self._report(
            job_id,
            {
                "status": "PASSED",
                "stages": [{"stage": "CAPTURE", "status": "PASSED", "duration_ms": int((time.monotonic() - started) * 1000), "detail": f"{len(samples)} sample group(s)"}],
                "samples": samples,
                "browse": browse,
                "diagnostic": "",
            },
        )

    async def _capture_inner(self, job: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        protocol = str(job.get("protocol") or "")
        config = job.get("config_json") or {}
        allow = self.allowlist_for(protocol, config)
        seconds = float(job.get("seconds") or 10)
        max_messages = int(job.get("max_messages") or 200)
        if protocol == "mqtt":
            topic = str(job.get("topic_filter") or config.get("topic_filter") or (config.get("topics") or ["#"])[0])
            connector = await self._mqtt_connector(job, config, allow, "fx-cap")
            try:
                messages = await mqtt_mod.capture(connector, topic, seconds, max_messages)
            finally:
                await connector.close()
            return group_samples(messages), []
        if protocol == "opcua":
            connector = await self._opc_connector(job, config, allow)
            try:
                return [], await connector.browse_children(str(job.get("browse_node") or "i=85"))
            finally:
                await connector.close()
        if protocol == "http":
            connector = HttpPullConnector(
                str(config.get("base_url") or config.get("url") or ""),
                allow,
                timeout_s=max(int(config.get("timeout_ms") or 5000), 200) / 1000,
                query=config.get("query") or None,
                rate_limit_per_min=config.get("rate_limit_per_min"),
            )
            try:
                headers = await http_headers(config, job.get("secret_ref"), self.secret)
                path = str(job.get("path") or config.get("path") or "/")
                document, text = await connector.request_json_text("GET", path, headers, max_wait_s=8.0)
            finally:
                await connector.close()
            return group_samples([(path, document, now_iso(), text)]), []
        if protocol == "websocket":
            connector = await self._ws_connector(job, config, allow)
            try:
                frames = await ws_mod.capture(connector, min(seconds, 10.0), max(1, min(max_messages, 20)))
            finally:
                await connector.close()
            channel = urlparse(connector.url).path or "/"
            return group_samples([(channel, frame.document, frame.received_time, frame.raw) for frame in frames]), []
        raise ConnectorError("PROTOCOL", "Capture is not supported for this protocol.")


def auth_label(auth: str) -> str:
    return {"api_key": "API key", "bearer": "bearer token", "basic": "user name and password"}.get(auth, "credential")


def group_samples(messages: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    """One entry per topic/channel with its newest payload.

    ``raw`` is the payload text exactly as received: Center stores ``payload`` as jsonb,
    which reorders keys and turns 0.0 into 0, so the wizard reads key order and number
    kinds from ``raw``. Items are ``(topic, payload, received_at[, raw_text])``.
    """
    by_topic: dict[str, dict[str, Any]] = {}
    for item in messages:
        topic, payload, received = item[0], item[1], item[2]
        raw = item[3] if len(item) > 3 and item[3] else json.dumps(payload, ensure_ascii=False)
        truncated = len(raw.encode("utf-8")) > MAX_CAPTURE_BYTES
        body = {"truncated": True, "preview": raw[:500]} if truncated else payload
        fields = {"payload": body, "raw": raw[:500] if truncated else raw, "received_at": received, "truncated": truncated}
        entry = by_topic.get(topic)
        if entry is None:
            by_topic[topic] = {"topic": topic, **fields, "count": 1}
        else:
            entry["count"] += 1
            entry.update(fields)
    return list(by_topic.values())
