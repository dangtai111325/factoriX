"""Read-only MQTT subscriber with a bounded latest-per-topic inbox."""

from __future__ import annotations

import json
import ssl
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import paho.mqtt.client as mqtt
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

from factorix.domain.network import AllowedEndpoint, assert_allowed
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.samples import source_timestamp


@dataclass(frozen=True, slots=True)
class MqttMessage:
    topic: str
    payload: Any
    received_time: str
    size: int
    source_time: str | None = None
    error: str | None = None


class MqttConnector:
    can_write = False

    def __init__(self, host: str, port: int, allowlist: list[AllowedEndpoint], client_id: str,
                 username: str | None = None, password: str | None = None, *,
                 max_inbox: int = 10_000, max_bytes: int = 64 * 1024 * 1024,
                 timestamp_jsonpath: str | None = None, protocol_version: str = "3.1.1",
                 keepalive: int = 60, clean_session: bool = True,
                 session_expiry: int = 0, tls: bool = False, tls_ca_pem: str | None = None,
                 max_payload_bytes: int | None = None) -> None:
        assert_allowed(host, port, allowlist, scheme="mqtts" if tls else "mqtt")
        self.host, self.port = host, port
        self._mqtt5 = protocol_version in {"5", "5.0"}
        self._keepalive, self._clean_session = keepalive, clean_session
        self._connect_properties = None
        if self._mqtt5:
            self._connect_properties = Properties(PacketTypes.CONNECT)
            self._connect_properties.SessionExpiryInterval = session_expiry
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id,
                                  protocol=mqtt.MQTTv5 if self._mqtt5 else mqtt.MQTTv311,
                                  clean_session=None if self._mqtt5 else clean_session)
        if tls:
            try:
                context = ssl.create_default_context(cadata=tls_ca_pem or None)
                self.client.tls_set_context(context)
            except (ssl.SSLError, ValueError) as exc:
                raise ConnectorError("TLS", "The MQTT CA certificate is invalid.") from exc
        if username:
            self.client.username_pw_set(username, password or None)
        self._inbox: OrderedDict[str, MqttMessage] = OrderedDict()
        self._max_inbox, self._max_bytes = max(1, max_inbox), max(1, max_bytes)
        self._pending_bytes = self._received = self._coalesced = self._dropped = self._decode_errors = 0
        self._connection_error: str | None = None
        self._connected = self._started = False
        self._timestamp_jsonpath = timestamp_jsonpath
        self._max_payload_bytes = max_payload_bytes
        self._lock = threading.Lock()
        self._available = threading.Event()

    def start(self, topics: list[tuple[str, int]]) -> None:
        if self._started:
            return
        if not topics:
            raise ConnectorError("TOPIC", "Choose at least one MQTT topic filter.")
        subscriptions = list(dict.fromkeys(topics))

        def on_connect(client, userdata, flags, reason_code, properties=None):
            del userdata, flags, properties
            code = int(getattr(reason_code, "value", reason_code))
            with self._lock:
                self._connected = code == 0
                self._connection_error = None if code == 0 else "AUTH"
            if code:
                self._available.set()
                return
            for topic, qos in subscriptions:
                client.subscribe(topic, qos=max(0, min(int(qos), 2)))

        def on_subscribe(client, userdata, mid, reason_codes, properties=None):
            del client, userdata, mid, properties
            if any(int(getattr(code, "value", code)) >= 128 for code in reason_codes):
                with self._lock:
                    self._connection_error = "SUBSCRIBE"
                self._available.set()

        def on_disconnect(client, userdata, flags, reason_code, properties=None):
            del client, userdata, flags, reason_code, properties
            with self._lock:
                self._connected = False

        self.client.on_connect, self.client.on_subscribe = on_connect, on_subscribe
        self.client.on_disconnect, self.client.on_message = on_disconnect, self._receive
        try:
            if self._mqtt5:
                self.client.connect(self.host, self.port, self._keepalive,
                                    clean_start=self._clean_session, properties=self._connect_properties)
            else:
                self.client.connect(self.host, self.port, self._keepalive)
        except ssl.SSLError as exc:
            raise ConnectorError("TLS", "MQTT TLS negotiation or certificate verification failed.") from exc
        except OSError as exc:
            raise ConnectorError("NETWORK", "Could not reach the MQTT broker.") from exc
        self.client.loop_start()
        self._started = True

    def _receive(self, client, userdata, message: mqtt.MQTTMessage) -> None:
        del client, userdata
        stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        size = len(message.payload) + len(message.topic.encode("utf-8"))
        payload: Any = None
        error = None
        if self._max_payload_bytes is not None and len(message.payload) > self._max_payload_bytes:
            # Discovery retains the concrete topic, never an oversized payload.
            error = 'SAMPLE_TOO_LARGE'
            size = len(message.topic.encode('utf-8')) + 64
        elif size <= self._max_bytes:
            try:
                payload = json.loads(message.payload.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError, RecursionError):
                error = "DECODE"
        source_time, _ = source_timestamp(payload, self._timestamp_jsonpath)
        item = MqttMessage(str(message.topic), payload, stamp, size, source_time, error)
        with self._lock:
            self._received += 1
            if size > self._max_bytes:
                self._dropped += 1
                return
            if error:
                self._decode_errors += 1
            previous = self._inbox.get(item.topic)
            if previous is not None:
                self._coalesced += 1
                if (previous.source_time and item.source_time
                        and datetime.fromisoformat(previous.source_time.replace("Z", "+00:00"))
                        > datetime.fromisoformat(item.source_time.replace("Z", "+00:00"))):
                    return
                self._pending_bytes -= previous.size
                del self._inbox[item.topic]
            while self._inbox and (len(self._inbox) >= self._max_inbox or self._pending_bytes + size > self._max_bytes):
                _, dropped = self._inbox.popitem(last=False)
                self._pending_bytes -= dropped.size
                self._dropped += 1
            self._inbox[item.topic] = item
            self._pending_bytes += size
            self._available.set()

    def metrics(self) -> dict[str, Any]:
        with self._lock:
            return {"received": self._received, "coalesced": self._coalesced,
                    "dropped": self._dropped, "decode_errors": self._decode_errors,
                    "pending_topics": len(self._inbox), "pending_bytes": self._pending_bytes,
                    "connected": self._connected, "last_error": self._connection_error}

    def drain_latest(self) -> list[MqttMessage]:
        with self._lock:
            if self._connection_error and not self._inbox:
                raise ConnectorError(self._connection_error, "The broker rejected the connection or subscription.")
            items = list(self._inbox.values())
            self._inbox.clear()
            self._pending_bytes = 0
            self._available.clear()
            return items

    def next_json(self, timeout_s: float = 2.0) -> dict[str, Any]:
        """Compatibility for protocol checks; collection uses drain_latest."""
        if not self._available.wait(timeout_s):
            raise ConnectorError("TIMEOUT", "No MQTT message arrived before the timeout.")
        items = self.drain_latest()
        if not items:
            raise ConnectorError("TIMEOUT", "No MQTT message arrived before the timeout.")
        if items[-1].error or not isinstance(items[-1].payload, dict):
            raise ConnectorError("DECODE", "The MQTT payload is not a JSON object.")
        return items[-1].payload

    def close(self) -> None:
        self.client.disconnect()
        if self._started:
            self.client.loop_stop()
        self._started = self._connected = False

    def capture_samples(self, topics: list[tuple[str, int]], timeout_s: float = 10.0) -> list[MqttMessage]:
        """Short-lived subscriber; must not reuse a running collector."""
        if self._started:
            raise ConnectorError("IN_USE", "Capture requires a separate MQTT subscriber.")
        self.start(topics)
        deadline = time.monotonic() + timeout_s
        latest: dict[str, MqttMessage] = {}
        try:
            while time.monotonic() < deadline:
                self._available.wait(min(0.1, max(0, deadline - time.monotonic())))
                for item in self.drain_latest():
                    latest[item.topic] = item
        finally:
            self.close()
        if not latest:
            raise ConnectorError("TIMEOUT", "No messages arrived on the selected topics before the timeout.")
        return list(latest.values())

    def capture(self, topic: str, timeout_s: float = 8.0) -> dict[str, Any]:
        samples = self.capture_samples([(topic, 1)], timeout_s)
        if samples[0].error or not isinstance(samples[0].payload, dict):
            raise ConnectorError("DECODE", "The MQTT payload is not a JSON object.")
        return samples[0].payload
