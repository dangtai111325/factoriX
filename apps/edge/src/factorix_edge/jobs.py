"""Acquisition jobs: one asyncio task per job.

A job reads (POLL) or consumes (SUBSCRIBE) one connection and turns the result into
``Sample`` rows. A failure stays inside its job: it is translated to a
``ConnectorError``, recorded as the connection state and retried with backoff. Other
jobs, the heartbeat and the flusher are not affected.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Awaitable, Callable, Protocol

import paho.mqtt.client as mqtt_client

from factorix.domain.modbus_decode import ModbusPlanError, ReadBlock, SourceSpan, plan_reads, register_count_for, split_contiguous
from factorix.domain.network import NetworkPolicyError
from factorix_edge.aio import bounded
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.connectors.http_pull import HttpPullConnector
from factorix_edge.connectors.modbus import ModbusConnector, decode_block
from factorix_edge.connectors.mqtt import Message, MqttConnector
from factorix_edge.connectors.opcua import OpcUaConnector
from factorix_edge.connectors.ws import WebSocketConnector
from factorix_edge.mapping import Sample, field_address, project_field, project_json
from factorix_edge.timeutil import from_epoch_ms, normalize_time, now_iso

logger = logging.getLogger(__name__)

PUSH_PROTOCOLS = frozenset({"mqtt", "websocket"})
MIN_INTERVAL_MS = {"http": 1000}
DEFAULT_MIN_INTERVAL_MS = 200
DEFAULT_MODBUS_MERGE_GAP = 16
MAX_BACKOFF_S = 30.0


# --------------------------------------------------------------------------- specs


@dataclass(slots=True)
class JobSpec:
    job_id: str
    connection_id: str
    protocol: str
    mode: str
    interval_ms: int
    timeout_ms: int
    connection: dict[str, Any]
    fields: list[dict[str, Any]]
    bindings: dict[str, dict[str, Any]]
    coerce_address: dict[str, dict[str, Any]]
    fingerprint: str
    connection_fingerprint: str

    @property
    def config(self) -> dict[str, Any]:
        config = self.connection.get("config_json")
        return config if isinstance(config, dict) else {}

    @property
    def subscribe(self) -> bool:
        if self.protocol in PUSH_PROTOCOLS:
            return True
        return self.protocol == "opcua" and self.mode == "SUBSCRIBE"


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def connection_fingerprint(connection: dict[str, Any]) -> str:
    return _digest(
        {
            "protocol": connection.get("protocol"),
            "config": connection.get("config_json"),
            "secret_ref": connection.get("secret_ref"),
            "status": connection.get("status"),
        }
    )


def build_specs(snapshot: dict[str, Any]) -> dict[str, JobSpec]:
    connections = {str(item["id"]): item for item in snapshot.get("connections") or []}
    fields_by_job: dict[str, list[dict[str, Any]]] = {}
    for item in snapshot.get("source_fields") or []:
        fields_by_job.setdefault(str(item["acquisition_job_id"]), []).append(item)
    bindings = {str(item["source_field_id"]): item for item in snapshot.get("signal_bindings") or []}
    specs: dict[str, JobSpec] = {}
    for job in snapshot.get("jobs") or []:
        if job.get("enabled") is False:
            continue
        connection = connections.get(str(job.get("connection_id")))
        if not connection or connection.get("status") in {"ARCHIVED", "PAUSED"}:
            continue
        protocol = str(connection.get("protocol") or "")
        mapped = sorted(
            (item for item in fields_by_job.get(str(job["id"]), []) if str(item["id"]) in bindings),
            key=lambda item: (int(item.get("ordinal") or 0), str(item["id"])),
        )
        if not mapped:
            continue
        floor = MIN_INTERVAL_MS.get(protocol, DEFAULT_MIN_INTERVAL_MS)
        interval = max(int(job.get("interval_ms") or 1000), floor)
        job_bindings = {str(item["id"]): bindings[str(item["id"])] for item in mapped}
        coerce_address: dict[str, dict[str, Any]] = {}
        for item in mapped:
            address = dict(field_address(item))
            native = str(address.get("native_type") or item.get("native_datatype") or "").lower()
            if protocol == "modbus_tcp" and native in {"ascii", "string"}:
                address.setdefault("nullable", True)  # all-zero text registers mean "no value"
            coerce_address[str(item["id"])] = address
        conn_fp = connection_fingerprint(connection)
        spec = JobSpec(
            job_id=str(job["id"]),
            connection_id=str(connection["id"]),
            protocol=protocol,
            mode=str(job.get("mode") or "POLL").upper(),
            interval_ms=interval,
            timeout_ms=int(job.get("timeout_ms") or 3000),
            connection=connection,
            fields=mapped,
            bindings=job_bindings,
            coerce_address=coerce_address,
            fingerprint="",
            connection_fingerprint=conn_fp,
        )
        spec.fingerprint = _digest(
            {
                "job": {k: job.get(k) for k in ("id", "mode", "interval_ms", "timeout_ms", "enabled", "schedule_json")},
                "connection": conn_fp,
                "fields": mapped,
                "bindings": job_bindings,
            }
        )
        specs[spec.job_id] = spec
    return specs


# --------------------------------------------------------------------------- host


class Host(Protocol):
    async def connector(self, spec: JobSpec) -> Any: ...

    async def secret(self, secret_ref: str) -> str: ...

    def emit(self, spec: JobSpec, samples: list[Sample]) -> int: ...

    def record_ok(self, connection_id: str, read_ms: int | None, samples: int, at: str | None = None) -> None: ...

    def record_failure(self, connection_id: str, error: ConnectorError) -> None: ...


def as_connector_error(exc: BaseException) -> ConnectorError:
    if isinstance(exc, ConnectorError):
        return exc
    if isinstance(exc, NetworkPolicyError):
        return ConnectorError(exc.code, str(exc))
    if isinstance(exc, ModbusPlanError):
        return ConnectorError(exc.code, str(exc))
    if isinstance(exc, asyncio.TimeoutError):
        return ConnectorError("TIMEOUT", "The read did not finish within its time budget.")
    if isinstance(exc, (KeyError, TypeError, ValueError)):
        return ConnectorError("CONFIG", f"Connection or field configuration is incomplete ({type(exc).__name__}: {exc}).")
    logger.error("Unexpected acquisition failure", exc_info=exc)
    return ConnectorError("INTERNAL", f"Unexpected edge error ({type(exc).__name__}).")


def backoff_delay(failures: int, interval_s: float, retry_after: float | None = None) -> float:
    delay = min(MAX_BACKOFF_S, max(1.0, interval_s) * (2 ** max(0, failures - 1)))
    if retry_after:
        delay = max(delay, float(retry_after))
    return delay


def read_budget_s(spec: JobSpec) -> float:
    timeout_s = max(int(spec.config.get("timeout_ms") or spec.timeout_ms or 3000), 200) / 1000
    if spec.protocol == "http":
        paths = {(str(field_address(f).get("method") or "GET"), str(field_address(f).get("path") or spec.config.get("path") or "/")) for f in spec.fields}
        rate = float(spec.config.get("rate_limit_per_min") or 60)
        return min(120.0, len(paths) * (timeout_s + 60.0 / rate) + 1.0)
    if spec.protocol == "modbus_tcp":
        return modbus_cycle_budget_s(spec.fields, spec.config, timeout_s)
    return min(30.0, max(2.0, timeout_s * 2 + 1.0))


MODBUS_MAX_CYCLE_S = 120.0


def modbus_cycle_budget_s(fields: list[dict[str, Any]], config: dict[str, Any], timeout_s: float) -> float:
    """Time one Modbus read cycle may take: every block read one after the other, each up to
    ``timeout_s × (retries + 1)``. The former flat ``2 × timeout + 1`` (7 s) let one slow unit
    (3 s × 2 tries) cancel the whole 6-unit cycle mid-request, marking all 48 signals BAD and
    leaving a late reply on the session (R3 Modbus P1)."""
    retries = max(0, int(config.get("retries") or 0))
    try:
        items, _bad = modbus_fields(fields, config, key_by=lambda f: str(f.get("id")))
        gap = int(config.get("merge_gap_registers", DEFAULT_MODBUS_MERGE_GAP))
        blocks = len(plan_reads([item.span for item in items], allow_gap=max(0, gap))) if items else 1
    except (ModbusPlanError, KeyError, TypeError, ValueError):
        blocks = max(1, len(fields))
    per_request = timeout_s * (retries + 1)
    return min(MODBUS_MAX_CYCLE_S, max(2.0, blocks * per_request + 1.0))


# --------------------------------------------------------------------------- auth helpers


async def http_headers(config: dict[str, Any], secret_ref: Any, fetch_secret: Callable[[str], Awaitable[str]]) -> dict[str, str]:
    """Static headers plus the configured credential (api_key / bearer / basic)."""
    headers = {str(k): str(v) for k, v in (config.get("headers") or {}).items()}
    auth = str(config.get("auth") or "none").lower()
    if auth == "none":
        return headers
    if not secret_ref:
        raise ConnectorError("AUTH", f"Authentication '{auth}' is configured but no secret is stored for this connection.")
    token = await fetch_secret(str(secret_ref))
    if auth == "bearer":
        headers["Authorization"] = f"Bearer {token}"
    elif auth == "basic":
        user = str(config.get("username") or "")
        headers["Authorization"] = "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode()
    elif auth == "api_key":
        headers[str(config.get("header_name") or "X-API-Key")] = token
    else:
        raise ConnectorError("CONFIG", f"Unsupported authentication '{auth}'.")
    return headers


# --------------------------------------------------------------------------- Modbus


@dataclass(slots=True)
class ModbusField:
    field: dict[str, Any]
    span: SourceSpan
    role: str | None


def modbus_fields(fields: list[dict[str, Any]], config: dict[str, Any], *, key_by: Callable[[dict[str, Any]], str]) -> tuple[list[ModbusField], list[Sample]]:
    """Build read spans. A field with an invalid address becomes a BAD sample, not a job failure."""
    default_unit = int(config.get("unit_id") if config.get("unit_id") is not None else 1)
    out: list[ModbusField] = []
    bad: list[Sample] = []
    for item in fields:
        address = field_address(item)
        decode = item.get("decode_json") if isinstance(item.get("decode_json"), dict) else {}
        field_id = key_by(item)
        try:
            native = str(address.get("native_type") or item.get("native_datatype") or "uint16").lower()
            area = str(address.get("register_area") or "holding").lower()
            if area in {"coil", "discrete"}:
                count = 1
            else:
                count = register_count_for(native, address.get("register_count"))
            unit = int(address["unit_id"]) if address.get("unit_id") is not None else default_unit
            span = SourceSpan(
                field_id=field_id,
                area=area,  # type: ignore[arg-type]
                offset=int(address.get("offset") or 0),
                count=count,
                unit_id=unit,
                poll_group="job",
                word_order=str(address.get("word_order") or "big").lower(),  # type: ignore[arg-type]
                native_type=native,
                scale=float(1 if decode.get("scale") is None else decode["scale"]),
                value_offset=float(0 if decode.get("offset") is None else decode["offset"]),
            )
            plan_reads([span])  # validates area, offset, unit and size
        except ModbusPlanError as exc:
            bad.append(Sample(field_id, None, "BAD", None, exc.code))
            continue
        except (TypeError, ValueError) as exc:
            bad.append(Sample(field_id, None, "BAD", None, "ADDRESS"))
            logger.info("Modbus field %s has an invalid address: %s", field_id, exc)
            continue
        role = str(address.get("role") or "") or None
        out.append(ModbusField(item, span, role))
    return out, bad


async def read_modbus(
    connector: ModbusConnector,
    fields: list[ModbusField],
    *,
    merge_gap: int,
    split_cache: set[tuple[int, str, int, int]] | None = None,
) -> list[Sample]:
    """Read every unit block, decode per field, and apply the per-unit ``source_timestamp`` role.

    Blocks merge spans of one unit when the gap is at most ``merge_gap`` registers. If the
    device rejects a merged block (Modbus exception), only the configured spans are read
    and that decision is remembered in ``split_cache``. A Modbus exception or timeout on
    one block marks only that block's fields BAD; a lost TCP session fails the job.
    """
    by_id = {item.span.field_id: item for item in fields}
    blocks = plan_reads([item.span for item in fields], allow_gap=max(0, merge_gap))
    cache = split_cache if split_cache is not None else set()
    decoded: list[dict[str, Any]] = []
    block_errors: list[ConnectorError] = []
    succeeded = 0
    pending: list[ReadBlock] = []
    for block in blocks:
        key = (block.unit_id, block.area, block.start, block.count)
        pending.extend(split_contiguous(block) if key in cache else [block])
    queue = list(pending)
    while queue:
        block = queue.pop(0)
        try:
            data = await connector.read_raw(block)
        except ConnectorError as exc:
            if exc.code == "NETWORK":
                raise
            parts = split_contiguous(block)
            if exc.code == "MODBUS_EXCEPTION" and len(parts) > 1:
                cache.add((block.unit_id, block.area, block.start, block.count))
                logger.info("Modbus unit %s rejected merged block %s/%s; reading configured spans only", block.unit_id, block.start, block.count)
                queue[0:0] = parts
                continue
            block_errors.append(exc)
            decoded.extend({"field_id": f.field_id, "value": None, "error_code": exc.code, "error": str(exc)} for f in block.fields)
            continue
        succeeded += 1
        decoded.extend(decode_block(block, data))
    if block_errors and not succeeded:
        raise block_errors[0]
    received = now_iso()
    # Per-unit group timestamp from the field whose role is source_timestamp.
    unit_time: dict[int, str] = {}
    for item in decoded:
        spec = by_id[item["field_id"]]
        if spec.role == "source_timestamp" and item["error_code"] is None and isinstance(item["value"], int):
            try:
                item["value"] = from_epoch_ms(item["value"])
                unit_time[spec.span.unit_id] = item["value"]
            except (OverflowError, OSError, ValueError):
                item["error_code"] = "SOURCE_TIME_INVALID"
                item["error"] = "Timestamp register is not a valid epoch in milliseconds."
    samples: list[Sample] = []
    for item in decoded:
        spec = by_id[item["field_id"]]
        source_time = unit_time.get(spec.span.unit_id)
        if item["error_code"]:
            samples.append(Sample(item["field_id"], None, "BAD", source_time, item["error_code"], received))
        else:
            samples.append(Sample(item["field_id"], item["value"], "GOOD", source_time, None, received))
    return samples


# --------------------------------------------------------------------------- OPC UA


def opc_nodes(fields: list[dict[str, Any]], *, key_by: Callable[[dict[str, Any]], str]) -> tuple[list[tuple[str, str, str | None]], list[Sample]]:
    """(field_id, node_id, timestamp_node_id) per field; fields without node_id are BAD."""
    rows: list[tuple[str, str, str | None]] = []
    bad: list[Sample] = []
    for item in fields:
        address = field_address(item)
        node_id = str(address.get("node_id") or "").strip()
        if not node_id:
            bad.append(Sample(key_by(item), None, "BAD", None, "ADDRESS"))
            continue
        ts_node = str(address.get("timestamp_node_id") or "").strip() or None
        rows.append((key_by(item), node_id, ts_node))
    return rows, bad


def opc_sample(field_id: str, row: dict[str, Any], ts_row: dict[str, Any] | None, received: str) -> Sample:
    source_time = row.get("source_time")
    reason = None
    if ts_row is not None:
        if ts_row.get("error_code") is None and ts_row.get("value") is not None:
            try:
                source_time = normalize_time(ts_row["value"])
            except (TypeError, ValueError, OverflowError):
                reason = "SOURCE_TIME_INVALID"
        else:
            reason = "SOURCE_TIME_UNAVAILABLE"
    if row.get("error_code"):
        return Sample(field_id, None, "BAD", source_time, row["error_code"], received)
    return Sample(field_id, row.get("value"), str(row.get("quality") or "GOOD"), source_time, reason, received)


async def read_opc(connector: OpcUaConnector, nodes: list[tuple[str, str, str | None]]) -> list[Sample]:
    wanted: list[str] = []
    for _, node_id, ts_node in nodes:
        for item in (node_id, ts_node):
            if item and item not in wanted:
                wanted.append(item)
    rows = await connector.read_values(wanted)
    received = now_iso()
    by_node = {row["node_id"]: row for row in rows}
    return [opc_sample(field_id, by_node[node_id], by_node.get(ts_node) if ts_node else None, received) for field_id, node_id, ts_node in nodes]


# --------------------------------------------------------------------------- MQTT


def mqtt_topic(item: dict[str, Any], config: dict[str, Any]) -> str:
    topic = str(field_address(item).get("topic") or "")
    if not topic and config.get("topics"):
        topic = str(config["topics"][0])
    return topic


def mqtt_qos(item: dict[str, Any], config: dict[str, Any]) -> int:
    for raw in (field_address(item).get("qos"), config.get("qos"), 1):
        try:
            if raw is not None:
                return max(0, min(int(raw), 2))
        except (TypeError, ValueError):
            continue
    return 1


def delivery_policy(item: dict[str, Any], config: dict[str, Any]) -> str:
    return str(item.get("delivery_policy") or field_address(item).get("delivery_policy") or config.get("delivery_policy") or "LATEST_ONLY").upper()


def map_mqtt_messages(fields: list[dict[str, Any]], config: dict[str, Any], messages: list[Message]) -> tuple[list[Sample], dict[str, Sample]]:
    """Map messages (arrival order) to fields by topic.

    Returns ``(events, latest)``: ``events`` holds every sample of ALL_EVENTS fields in
    arrival order; ``latest`` holds the newest sample per LATEST_ONLY field.
    """
    events: list[Sample] = []
    latest: dict[str, Sample] = {}
    routes = [(item, mqtt_topic(item, config), delivery_policy(item, config)) for item in fields]
    for topic, payload, arrival, *_raw in messages:
        for item, field_topic, policy in routes:
            if not field_topic or not mqtt_client.topic_matches_sub(field_topic, topic):
                continue
            sample = project_field(item, payload, arrival)
            if sample is None:
                continue
            if policy == "ALL_EVENTS":
                events.append(sample)
            else:
                latest[sample.field_id] = sample
    return events, latest


class FieldThrottle:
    """LATEST_ONLY delivery: the newest sample per field, released at most once per interval *per field*.

    The interval caps the rate of each signal. It is not a shared job clock: one MQTT job usually
    carries several machines whose messages arrive at different phases, and a job-wide emit slot
    held each later machine back for up to one interval (~0.5 s on average, R2-SG-01).
    """

    def __init__(self, interval_s: float) -> None:
        self.interval_s = max(0.0, interval_s)
        self.pending: dict[str, Sample] = {}
        self.last: dict[str, float] = {}

    def offer(self, samples: dict[str, Sample]) -> None:
        self.pending.update(samples)

    def due(self, now: float) -> list[Sample]:
        ready = [sample for fid, sample in self.pending.items() if self.last.get(fid, float("-inf")) + self.interval_s <= now]
        for sample in ready:
            self.last[sample.field_id] = now
            del self.pending[sample.field_id]
        return ready

    def wait(self, now: float) -> float | None:
        """Seconds until the next held sample may be released; None when nothing is held."""
        if not self.pending:
            return None
        due_at = min(self.last.get(fid, float("-inf")) + self.interval_s for fid in self.pending)
        return max(0.0, due_at - now)


# --------------------------------------------------------------------------- runner


@dataclass(slots=True)
class JobStats:
    failures: int = 0
    reads: int = 0
    last_ok: float = 0.0
    split_cache: set[tuple[int, str, int, int]] = dc_field(default_factory=set)


class JobRunner:
    """Runs one job until cancelled."""

    def __init__(self, spec: JobSpec, host: Host) -> None:
        self.spec = spec
        self.host = host
        self.stats = JobStats()
        self.partial_error: ConnectorError | None = None

    @property
    def interval_s(self) -> float:
        return self.spec.interval_ms / 1000

    async def run(self) -> None:
        protocol = self.spec.protocol
        if protocol == "mqtt":
            await self._run_push(self._consume_mqtt)
        elif protocol == "websocket":
            await self._run_push(self._consume_ws)
        elif protocol == "opcua" and self.spec.subscribe:
            await self._run_push(self._consume_opc)
        else:
            await self._run_poll()

    # ---- poll

    async def read_once(self) -> list[Sample]:
        spec = self.spec
        connector = await self.host.connector(spec)
        if spec.protocol == "modbus_tcp":
            items, bad = modbus_fields(spec.fields, spec.config, key_by=lambda f: str(f["id"]))
            gap = int(spec.config.get("merge_gap_registers", DEFAULT_MODBUS_MERGE_GAP))
            samples = await read_modbus(connector, items, merge_gap=gap, split_cache=self.stats.split_cache) if items else []
            return bad + samples
        if spec.protocol == "opcua":
            nodes, bad = opc_nodes(spec.fields, key_by=lambda f: str(f["id"]))
            return bad + (await read_opc(connector, nodes) if nodes else [])
        if spec.protocol == "http":
            return await self._read_http(connector)
        raise ConnectorError("PROTOCOL", f"Protocol '{spec.protocol}' does not support polling.")

    async def _read_http(self, connector: HttpPullConnector) -> list[Sample]:
        spec = self.spec
        headers = await http_headers(spec.config, spec.connection.get("secret_ref"), self.host.secret)
        by_path: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for item in spec.fields:
            address = field_address(item)
            method = str(address.get("method") or spec.config.get("method") or "GET").upper()
            path = str(address.get("path") or spec.config.get("path") or "/")
            by_path.setdefault((method, path), []).append(item)
        samples: list[Sample] = []
        errors: list[ConnectorError] = []
        deadline = time.monotonic() + read_budget_s(spec) - 0.5
        for (method, path), path_fields in by_path.items():
            try:
                document = await connector.request_json(
                    method, path, headers, body=spec.config.get("body") if method == "POST" else None, max_wait_s=max(0.0, deadline - time.monotonic())
                )
            except ConnectorError as exc:
                errors.append(exc)
                if exc.code != "RATE_LIMITED":
                    samples.extend(Sample(str(f["id"]), None, "BAD", None, exc.code, now_iso()) for f in path_fields)
                continue
            samples.extend(project_json(path_fields, document, now_iso()))
        if errors and len(errors) == len(by_path):
            raise errors[0]
        self.partial_error = next((exc for exc in errors if exc.code == "RATE_LIMITED"), None)
        return samples

    async def _run_poll(self) -> None:
        spec = self.spec
        budget = read_budget_s(spec)
        next_due = time.monotonic()
        while True:
            started = time.monotonic()
            try:
                samples = await bounded(self.read_once(), timeout=budget)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolated per job; translated and recorded
                error = as_connector_error(exc)
                await self._failed(error)
                await asyncio.sleep(backoff_delay(self.stats.failures, self.interval_s, error.retry_after))
                next_due = time.monotonic()
                continue
            elapsed_ms = int((time.monotonic() - started) * 1000)
            self.stats.failures = 0
            self.stats.reads += 1
            emitted = self.host.emit(spec, samples)
            self.host.record_ok(spec.connection_id, elapsed_ms, emitted)
            if self.partial_error is not None:
                self.host.record_failure(spec.connection_id, self.partial_error)
                self.partial_error = None
            next_due += self.interval_s
            now = time.monotonic()
            if next_due < now:
                next_due = now  # overran: run again now, do not burst to catch up
            await asyncio.sleep(next_due - now)

    async def _failed(self, error: ConnectorError) -> None:
        self.stats.failures += 1
        self.host.record_failure(self.spec.connection_id, error)
        if self.stats.failures == 1:
            logger.warning("Job %s (%s) failed: %s %s", self.spec.job_id, self.spec.protocol, error.code, error)
        if self.stats.failures == 1 and error.code != "RATE_LIMITED":
            # One BAD sample per field on the transition, so the reason is visible on the signal.
            received = now_iso()
            self.host.emit(self.spec, [Sample(str(f["id"]), None, "BAD", None, error.code, received) for f in self.spec.fields])

    # ---- push

    async def _run_push(self, consume: Callable[[Any], Awaitable[None]]) -> None:
        while True:
            try:
                connector = await self.host.connector(self.spec)
                await consume(connector)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolated per job; translated and recorded
                error = as_connector_error(exc)
                await self._failed(error)
                await asyncio.sleep(backoff_delay(self.stats.failures, 1.0, error.retry_after))

    def _push_state(self, connector: Any) -> None:
        if connector.state != "UP" and connector.last_error_code:
            self.host.record_failure(self.spec.connection_id, ConnectorError(connector.last_error_code, connector.last_error or "Disconnected."))

    async def _consume_mqtt(self, connector: MqttConnector) -> None:
        spec = self.spec
        topics: dict[str, int] = {}
        for item in spec.fields:
            topic = mqtt_topic(item, spec.config)
            if topic:
                topics[topic] = max(topics.get(topic, 0), mqtt_qos(item, spec.config))
        if not topics:
            raise ConnectorError("TOPIC", "No topic to collect.")
        listener = connector.add_listener(topics=list(topics))
        connector.set_topics(spec.job_id, list(topics.items()))
        throttle = FieldThrottle(self.interval_s)
        try:
            while True:
                held = throttle.wait(time.monotonic())
                batch: list[Message] = []
                try:
                    batch.append(await bounded(listener.queue.get(), timeout=5.0 if held is None else held))
                except asyncio.TimeoutError:
                    pass
                batch.extend(listener.drain_nowait())
                if batch:
                    events, latest = map_mqtt_messages(spec.fields, spec.config, batch)
                    throttle.offer(latest)
                    if events:
                        self._emit_push(events)
                elif held is None:
                    self._push_state(connector)
                ready = throttle.due(time.monotonic())
                if ready:
                    self._emit_push(ready)
        finally:
            connector.set_topics(spec.job_id, [])
            connector.remove_listener(listener)

    def _emit_push(self, samples: list[Sample]) -> None:
        self.stats.failures = 0
        emitted = self.host.emit(self.spec, samples)
        self.host.record_ok(self.spec.connection_id, None, emitted, samples[-1].received_time if samples else None)

    async def _consume_ws(self, connector: WebSocketConnector) -> None:
        spec = self.spec
        last_seq = connector.latest.seq if connector.latest else 0
        last_emit = 0.0
        while True:
            frame = await connector.next_frame(last_seq, timeout_s=5.0)
            if frame is None:
                self._push_state(connector)
                continue
            wait = last_emit + self.interval_s - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
                frame = connector.latest or frame
            last_seq = frame.seq
            last_emit = time.monotonic()
            self._emit_push(project_json(spec.fields, frame.document, frame.received_time))

    async def _consume_opc(self, connector: OpcUaConnector) -> None:
        """Persistent subscription; re-created when the session reconnects.

        Changes are emitted as they arrive. Every interval the latest value of every field
        is emitted again (received_time = now) while the subscription is alive, so values
        that do not change still prove the source is being read.
        """
        spec = self.spec
        nodes, bad = opc_nodes(spec.fields, key_by=lambda f: str(f["id"]))
        if bad:
            self.host.emit(spec, bad)
        if not nodes:
            raise ConnectorError("ADDRESS", "No OPC UA NodeId to subscribe.")
        fields_by_node: dict[str, list[tuple[str, str | None]]] = {}
        ts_nodes: set[str] = set()
        for field_id, node_id, ts_node in nodes:
            fields_by_node.setdefault(node_id, []).append((field_id, ts_node))
            if ts_node:
                ts_nodes.add(ts_node)
        all_nodes = list(dict.fromkeys([*fields_by_node, *ts_nodes]))
        latest_rows: dict[str, dict[str, Any]] = {}
        changed: asyncio.Queue[str] = asyncio.Queue()

        def on_change(node_id: str, row: dict[str, Any]) -> None:
            latest_rows[node_id] = row
            changed.put_nowait(node_id)

        await connector.ensure_connected()
        generation = connector.generation
        subscription, refused = await connector.subscribe(all_nodes, on_change, period_ms=min(spec.interval_ms, 1000))
        try:
            refused_fields = [Sample(fid, None, "BAD", None, "OPC_MONITOR_FAILED", now_iso()) for node in refused for fid, _ in fields_by_node.get(node, [])]
            if refused_fields:
                self.host.emit(spec, refused_fields)
            next_tick = time.monotonic() + self.interval_s
            while connector.connected and connector.generation == generation:
                nodes_changed: set[str] = set()
                try:
                    nodes_changed.add(await bounded(changed.get(), timeout=max(0.0, next_tick - time.monotonic())))
                except asyncio.TimeoutError:
                    pass
                while not changed.empty():
                    nodes_changed.add(changed.get_nowait())
                emit_nodes = set(fields_by_node) if time.monotonic() >= next_tick else {n for n in nodes_changed if n in fields_by_node}
                if time.monotonic() >= next_tick:
                    next_tick = time.monotonic() + self.interval_s
                samples: list[Sample] = []
                for node_id in emit_nodes:
                    row = latest_rows.get(node_id)
                    if row is None:
                        continue
                    received = row.get("received_time") if node_id in nodes_changed else now_iso()
                    for field_id, ts_node in fields_by_node[node_id]:
                        samples.append(opc_sample(field_id, row, latest_rows.get(ts_node) if ts_node else None, received or now_iso()))
                if samples:
                    self._emit_push(samples)
            raise ConnectorError("NETWORK", "OPC UA session lost; re-subscribing.")
        finally:
            await connector.unsubscribe(subscription)

