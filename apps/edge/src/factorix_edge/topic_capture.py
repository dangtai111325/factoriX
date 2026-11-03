"""One temporary, read-only MQTT subscriber, independent of normal collection."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime
import json
import threading
import time
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from factorix.domain.mqtt_topics import filter_covers
from factorix.domain.network import AllowedEndpoint, NetworkPolicyError
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.connectors.mqtt import MqttConnector, MqttMessage


class CaptureBuffer:
    """Bound both distinct topics and encoded output; keep only each topic's latest sample."""

    def __init__(self, *, max_topics: int = 2000, max_result_bytes: int = 1_000_000, max_sample_bytes: int = 65_536):
        self.max_topics, self.max_result_bytes, self.max_sample_bytes = max_topics, max_result_bytes, max_sample_bytes
        self.samples: OrderedDict[str, tuple[dict[str, Any], int]] = OrderedDict()
        self.pending_bytes = self.dropped = 0
        self.truncated = False

    def add(self, message: MqttMessage) -> None:
        payload, error = message.payload, message.error
        try:
            payload_bytes = len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode())
        except (ValueError, TypeError, RecursionError):
            payload_bytes, payload, error = 0, None, 'DECODE'
        if payload_bytes > self.max_sample_bytes:
            payload, error = None, 'SAMPLE_TOO_LARGE'
        if error:
            payload = None
            self.truncated = True
        sample = {'topic': message.topic, 'payload': payload, 'received_time': message.received_time,
                  'source_time': message.source_time, 'error': error}
        size = len(json.dumps(sample, ensure_ascii=False).encode()) + 2
        previous = self.samples.get(message.topic)
        if previous:
            old_time, new_time = previous[0]['source_time'], message.source_time
            if old_time and new_time and datetime.fromisoformat(old_time.replace('Z', '+00:00')) > datetime.fromisoformat(new_time.replace('Z', '+00:00')):
                return
            self.pending_bytes -= previous[1]
            del self.samples[message.topic]
        budget = self.max_result_bytes - 512  # Envelope, commas and bounded integer counters.
        if size > budget:
            self.dropped += 1
            self.truncated = True
            return
        while self.samples and (len(self.samples) >= self.max_topics or self.pending_bytes + size > budget):
            _, (_, removed) = self.samples.popitem(last=False)
            self.pending_bytes -= removed
            self.dropped += 1
            self.truncated = True
        self.samples[message.topic] = sample, size
        self.pending_bytes += size

    def result(self, *, received: int, dropped: int) -> dict[str, Any]:
        return {'status': 'COMPLETED', 'samples': [s[0] for s in self.samples.values()], 'received': received,
                'dropped': dropped + self.dropped, 'truncated': self.truncated or bool(dropped), 'error_code': None}


def failed(code: str) -> dict[str, Any]:
    return {'status': 'FAILED', 'samples': [], 'received': 0, 'dropped': 0, 'truncated': False, 'error_code': code}


def capture_topics(config: dict[str, Any], topic_filter: str, allowlist: list[AllowedEndpoint], password: str | None,
                   stop: threading.Event, duration_s: float) -> dict[str, Any]:
    """Blocking worker; called in its own thread, with cooperative cancellation and cleanup."""
    connector = None
    buffer = CaptureBuffer()
    try:
        if stop.is_set():
            return failed('CANCELLED')
        connector = MqttConnector(str(config['host']), int(config.get('port') or (8883 if config.get('tls') else 1883)),
            allowlist, f'fx-capture-{uuid4().hex[:16]}', username=config.get('username') or None, password=password,
            protocol_version=str(config.get('protocol_version') or '3.1.1'), clean_session=True, session_expiry=0,
            keepalive=int(config.get('keepalive') or 60), tls=bool(config.get('tls')), tls_ca_pem=config.get('tls_ca_pem'),
            timestamp_jsonpath=config.get('timestamp_jsonpath'), max_inbox=2000, max_bytes=1_000_000,
            max_payload_bytes=65_536)
        connector.start([(topic_filter, int(config.get('qos', 1)))])
        deadline = time.monotonic() + min(max(duration_s, .05), 30)
        while not stop.is_set() and time.monotonic() < deadline:
            for message in connector.drain_latest():
                if filter_covers(topic_filter, message.topic):
                    buffer.add(message)
            stop.wait(min(.05, max(0, deadline - time.monotonic())))
        if stop.is_set():
            return failed('CANCELLED')
        for message in connector.drain_latest():
            if filter_covers(topic_filter, message.topic):
                buffer.add(message)
        if not buffer.samples:
            return failed('TIMEOUT')
        metrics = connector.metrics()
        return buffer.result(received=metrics['received'], dropped=metrics['dropped'])
    except ConnectorError as exc:
        code = exc.code if exc.code in {'AUTH', 'SUBSCRIBE', 'NETWORK', 'TLS', 'TIMEOUT'} else 'PROTOCOL'
        return failed(code)
    except (NetworkPolicyError, OSError):
        return failed('NETWORK')
    except (ValueError, KeyError, TypeError):
        return failed('PROTOCOL')
    finally:
        if connector is not None:
            connector.close()


Request = Callable[..., Awaitable[dict[str, Any]]]


class TopicCaptureService:
    """At most one worker/result awaiting acknowledgment; a lost ack never opens another socket."""

    def __init__(self, request: Request, allowlist: list[AllowedEndpoint]):
        self.request, self.allowlist = request, allowlist
        self._job: dict[str, Any] | None = None
        self._task: asyncio.Task | None = None
        self._stop = threading.Event()

    @property
    def active(self) -> bool:
        return self._task is not None

    async def tick(self) -> None:
        if self._task is not None:
            assert self._job is not None
            path = f"/api/v1/edge-sync/topic-captures/{self._job['id']}"
            try:
                status = await self.request('GET', path)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 404:
                    raise
                status = {'status': 'EXPIRED'}
            if status.get('status') != 'RUNNING':
                self._stop.set()
                if self._task.done():
                    await self._clear()
                return
            if self._task.done():
                result = self._task.result()
                await self.request('POST', path, result)
                await self._clear()
            return
        pulled = await self.request('GET', '/api/v1/edge-sync/topic-captures')
        if job := pulled.get('job'):
            self._stop = threading.Event()
            self._job = job
            self._task = asyncio.create_task(self._run(job), name=f"mqtt-capture-{job['id']}")

    async def _run(self, job: dict[str, Any]) -> dict[str, Any]:
        config = job.get('config_json') or {}
        password = None
        if not config.get('anonymous', True) and config.get('username') and job.get('secret_ref'):
            try:
                secret = await self.request('GET', f"/api/v1/edge-sync/secrets/{job['secret_ref']}")
                password = str(secret.get('secret') or '')
            except httpx.HTTPError:
                return failed('AUTH')
        thread = asyncio.create_task(asyncio.to_thread(capture_topics, config, job['topic_filter'],
                                    self.allowlist, password, self._stop, float(job['duration_s'])))
        try:
            return await asyncio.shield(thread)
        except asyncio.CancelledError:
            self._stop.set()
            await asyncio.shield(thread)
            raise
        except Exception:
            # Isolate discovery failure from normal acquisition. Never return exception
            # text, which may include endpoint credentials or source payloads.
            return failed('INTERNAL')

    async def _clear(self) -> None:
        if self._task:
            await self._task
        self._task, self._job = None, None

    async def close(self) -> None:
        self._stop.set()
        await self._clear()
